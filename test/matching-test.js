'use strict';
// v0.4.2: the 36 matching/scope bugs from the v0.4.1 review (same name in two zones, resource
// groups, clusters, apps, k8s context/namespace, MCP parents, failed lines, cd, bash -c, $VAR).
// Each case is the reviewer's repro, kept as written; the predicate is what must hold now.
const assert = require('assert');
const { scan } = require('../src/scan');

module.exports = (t) => {
  let n = 0;
  const stamp = () => `2026-10-01T00:${String(n++).padStart(2, '0')}:00Z`;
  const ev = (command, o = {}) => ({ kind: 'cmd', command, time: stamp(), cwd: '/repo', session: 's1', tool: 'claude', ...o });
  const mcp = (tool_name, input, result, o = {}) => ({ kind: 'mcp', tool_name, input, result, time: stamp(), cwd: '/repo', session: 's1', tool: 'claude', ...o });
  const wr = (file, content, o = {}) => ({ kind: 'write', file, content, time: stamp(), cwd: '/repo', session: 's1', tool: 'claude', ...o });
  const check = (id, title, evs, pred, expected) => t(`matching ${id}: ${title}`, () => {
    const r = scan(evs).resources;
    assert.ok(pred(r), `expected ${expected}; got ${JSON.stringify(r.map((f) => `${f.rule}:${f.name}:${f.status}`))}`);
  });
    const has = (r, rule, status) => r.some((f) => f.rule === rule && f.status === status);
    const count = (r, rule) => r.filter((f) => f.rule === rule).length;
    // B1 GCP zone collision
    check('B1', 'gcloud: same VM name in two zones merges; deleting one marks the other cleaned', [
      ev('gcloud compute instances create web --zone us-central1-a --project p'),
      ev('gcloud compute instances create web --zone europe-west1-b --project p'),
      ev('gcloud compute instances delete web --zone us-central1-a --project p --quiet'),
    ], (r) => has(r, 'gcp-vm', 'left'), 'web@europe-west1-b still left');

    // B2 Azure resource group collision
    check('B2', 'az: deleting VM web in rg-a marks web in rg-b cleaned', [
      ev('az vm create -g rg-a -n web --image Ubuntu2204'),
      ev('az vm create -g rg-b -n web --image Ubuntu2204'),
      ev('az vm delete -g rg-a -n web --yes'),
    ], (r) => has(r, 'az-vm', 'left'), 'web in rg-b left');

    // B4 gcloud config set core/project not tracked -> stale scope
    check('B4', 'gcloud config set core/project B not tracked; delete in B cleans VM in A', [
      ev('gcloud config set project proj-a'),
      ev('gcloud compute instances create web --zone z'),
      ev('gcloud config set core/project proj-b'),
      ev('gcloud compute instances delete web --zone z --quiet'),
    ], (r) => has(r, 'gcp-vm', 'left'), 'web in proj-a left');

    // B5 gcloud beta drops inline env
    check('B5', 'gcloud beta/alpha loses inline env (CLOUDSDK_CORE_PROJECT=...) scope', [
      ev('gcloud compute instances create web --zone z --project proj-a'),
      ev('CLOUDSDK_CORE_PROJECT=proj-b gcloud beta compute instances delete web --zone z --quiet'),
    ], (r) => has(r, 'gcp-vm', 'left'), 'web in proj-a left');

    // B6 failed line: delete is not the last part
    check('B6', 'failed "delete && echo" line counts the delete as successful', [
      ev('gcloud compute instances create web --zone z'),
      ev('gcloud compute instances delete web --zone z --quiet && echo deleted', { failed: true }),
    ], (r) => !has(r, 'gcp-vm', 'cleaned'), 'web left or maybe-cleaned, not cleaned');

    // B7 cd before terraform: names use ev.cwd
    check('B7', 'terraform destroy in a different folder (after cd) marks the apply cleaned', [
      ev('cd infra && terraform apply -auto-approve'),
      ev('cd scratch && terraform destroy -auto-approve'),
    ], (r) => has(r, 'iac-terraform', 'left'), 'apply in /repo/infra left');

    // B8 failed script -> its creates are skipped
    check('B8', 'script that created a VM then failed later: VM never listed', [
      wr('deploy.sh', 'gcloud compute instances create web --zone z\ngcloud compute scp app web:~ --zone z\n'),
      ev('bash deploy.sh', { failed: true }),
    ], (r) => count(r, 'gcp-vm') === 1, 'gcp-vm web listed (left)');

    // B9 bash -c not followed
    check('B9', 'bash -c "..." commands are ignored', [
      ev(`bash -c "gcloud compute instances create web --zone z"`),
    ], (r) => count(r, 'gcp-vm') === 1, 'gcp-vm web left');

    // B10 EC2 terminate any: known instance IDs ignored
    check('B10', 'terminate-instances of instance B marks instance A (ID known) maybe-cleaned', [
      ev('aws ec2 run-instances --instance-type t3.micro --tag-specifications ResourceType=instance,Tags=[{Key=Name,Value=a}] --region us-east-1', { instanceIds: ['i-aaa'] }),
      ev('aws ec2 terminate-instances --instance-ids i-bbb --region us-east-1'),
    ], (r) => has(r, 'aws-ec2', 'left'), 'a left (i-aaa not terminated)');

    // B11 ECS cluster ignored
    check('B11', 'aws ecs delete-service in cluster B cleans service in cluster A', [
      ev('aws ecs create-service --cluster a --service-name api --task-definition td --desired-count 2'),
      ev('aws ecs delete-service --cluster b --service api --force'),
    ], (r) => has(r, 'aws-ecs', 'left'), 'api in cluster a left');

    // B12 heroku addon delete across apps
    check('B12', 'heroku addons:destroy on app B cleans add-on on app A', [
      ev('heroku addons:create heroku-postgresql:standard-0 --app app-a'),
      ev('heroku addons:destroy heroku-postgresql:standard-0 --app app-b --confirm app-b'),
    ], (r) => has(r, 'heroku-addon', 'left'), 'addon on app-a left');

    // B13 fly apps destroy any
    check('B13', 'fly apps destroy other-app marks named fly app web maybe-cleaned', [
      ev('fly launch --name web --region iad'),
      ev('fly apps destroy other-app --yes'),
    ], (r) => has(r, 'fly-app', 'left'), 'web left');

    // B14 k8s: delete in another context cleans
    check('B14', 'kubectl delete svc web --context b cleans LB service created in context a', [
      ev('kubectl expose deployment web --type=LoadBalancer --port 80 --context gke_a'),
      ev('kubectl delete svc web --context gke_b'),
    ], (r) => has(r, 'k8s-lb-service', 'left'), 'web@gke_a left');

    // B15 k8s: delete without -n (default ns) cleans svc in ns prod
    check('B15', 'kubectl delete svc web (default ns) cleans web in namespace prod', [
      ev('kubectl expose deployment web --type=LoadBalancer --port 80 -n prod --context gke_a'),
      ev('kubectl delete svc web --context gke_a'),
    ], (r) => has(r, 'k8s-lb-service', 'left'), 'web (ns prod) left');

    // B16 k8s: delete -n other cleans svc in default ns (f.ns null)
    check('B16', 'kubectl delete svc web -n staging cleans web created in default namespace', [
      ev('kubectl expose deployment web --type=LoadBalancer --port 80'),
      ev('kubectl delete svc web -n staging'),
    ], (r) => has(r, 'k8s-lb-service', 'left'), 'web (default ns) left');

    // B17 k8s: delete -f matches by name only (any kind)
    check('B17', 'kubectl delete -f deploy.yaml (Deployment "web") cleans LB Service "web"', [
      wr('svc.yaml', 'apiVersion: v1\nkind: Service\nmetadata:\n  name: web\nspec:\n  type: LoadBalancer\n'),
      wr('deploy.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec: {}\n'),
      ev('kubectl apply -f svc.yaml --context gke_a'),
      ev('kubectl delete -f deploy.yaml --context gke_a'),
    ], (r) => has(r, 'k8s-lb-service', 'left'), 'Service web left');

    // B18 k8s namespace delete ignores context
    check('B18', 'kubectl delete ns prod in context b cleans everything in ns prod on context a', [
      ev('kubectl expose deployment web --type=LoadBalancer --port 80 -n prod --context gke_a'),
      ev('kubectl delete namespace prod --context gke_b'),
    ], (r) => has(r, 'k8s-lb-service', 'left'), 'web left');

    // B19 helm uninstall ignores context
    check('B19', 'helm uninstall in another kube-context cleans the release', [
      ev('helm install ing ingress-nginx/ingress-nginx --kube-context gke_a'),
      ev('helm uninstall ing --kube-context gke_b'),
    ], (r) => has(r, 'helm-release', 'left'), 'release on gke_a left');

    // B20 MCP: delete via another server/account of same provider
    check('B20', 'MCP: delete_project on supabase-personal server cleans project created on supabase-work', [
      mcp('mcp__supabase-work__create_project', { name: 'demo', region: 'us-east-1' }, '{"status":"creating"}'),
      mcp('mcp__supabase-personal__delete_project', { name: 'demo' }, '{"ok":true}'),
    ], (r) => !r.some((f) => f.via === 'mcp' && f.status === 'cleaned'), 'demo on supabase-work not cleaned (left or maybe)');

    // B21 MCP: branch name across parent projects
    check('B21', 'MCP neon: delete_branch "dev" in project p2 cleans branch "dev" in project p1', [
      mcp('mcp__neon__create_branch', { projectId: 'p1', branchName: 'dev' }, '{"status":"ok"}'),
      mcp('mcp__neon__delete_branch', { projectId: 'p2', branchName: 'dev' }, '{"ok":true}'),
    ], (r) => r.some((f) => f.via === 'mcp' && f.status === 'left'), 'p1/dev left');

    // B22 MCP: any string value in delete input matches (parent project id == child name)
    check('B22', 'MCP: delete_database {project_id:"app"} cleans an unrelated database named "app"', [
      mcp('mcp__neon__create_database', { projectId: 'p1', name: 'app' }, '{"status":"ok"}'),
      mcp('mcp__neon__delete_database', { projectId: 'app', name: 'other' }, '{"ok":true}'),
    ], (r) => r.some((f) => f.via === 'mcp' && f.status === 'left'), 'p1/app left');

    // B23 Orphans: kept disk keyed without scope, parent picked by name only
    check('B23c', 'gcp kept-disk: VM web --keep-disks=all in proj-b is attributed to (and merged with) proj-a', [
      ev('gcloud compute instances create web --zone z --project proj-a'),
      ev('gcloud compute instances create web --zone z --project proj-b'),
      ev('gcloud compute instances delete web --zone z --project proj-a --keep-disks=all --quiet'),
      ev('gcloud compute instances delete web --zone z --project proj-b --keep-disks=all --quiet'),
    ], (r) => r.filter((f) => f.rule === 'gcp-kept-disk').length === 2, 'two kept-disk findings (proj-a, proj-b)');

    // B24 az group delete case-insensitive + doesn't clean contents
    check('B24', 'az group delete -n myrg does not clean group MyRG (Azure names are case-insensitive)', [
      ev('az group create -n MyRG -l eastus'),
      ev('az group delete -n myrg --yes'),
    ], (r) => has(r, 'az-group', 'cleaned'), 'group cleaned');

    check('B25', 'az group delete leaves VMs/DBs in that group listed as left', [
      ev('az group create -n rg1 -l eastus'),
      ev('az vm create -g rg1 -n web --image Ubuntu2204'),
      ev('az postgres flexible-server create -g rg1 -n db1'),
      ev('az group delete -n rg1 --yes'),
    ], (r) => !r.some((f) => f.status === 'left' && f.rule !== 'az-vm-orphans'), 'everything in rg1 cleaned');

    // B26 az orphans: group delete in another subscription
    check('B26', 'az group delete in subscription B cleans VM leftovers in subscription A', [
      ev('az vm create -g rg1 -n web --subscription sub-a'),
      ev('az vm delete -g rg1 -n web --subscription sub-a --yes'),
      ev('az group delete -n rg1 --subscription sub-b --yes'),
    ], (r) => has(r, 'az-vm-orphans', 'left'), 'orphans in sub-a left');

    // B27 az vm delete --ids not recognised (false alarm)
    check('B27', 'az vm delete --ids <resource id> is not matched', [
      ev('az vm create -g rg1 -n web --image Ubuntu2204'),
      ev('az vm delete --ids /subscriptions/s/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/web --yes'),
    ], (r) => !has(r, 'az-vm', 'left'), 'web cleaned');

    // B30 export with multiple + set -x ; "export AWS_REGION" then flag form handled. az account set failed
    check('B30', 'failed "az account set" still switches the session subscription', [
      ev('az account set --subscription sub-a'),
      ev('az vm create -g rg -n web'),
      ev('az account set --subscription sub-typo', { failed: true }),
      ev('az vm delete -g rg -n web --yes'),
    ], (r) => has(r, 'az-vm', 'cleaned'), 'web cleaned (still in sub-a)');

    // B33 GKE region vs zone collision
    check('B33', 'GKE cluster same name in two regions: delete one cleans both', [
      ev('gcloud container clusters create c1 --region us-central1'),
      ev('gcloud container clusters create c1 --region europe-west1'),
      ev('gcloud container clusters delete c1 --region us-central1 --quiet'),
    ], (r) => has(r, 'gcp-gke', 'left'), 'europe c1 left');

    // B34 Cloud Run region
    check('B34', 'Cloud Run service same name two regions: delete one cleans both', [
      ev('gcloud run deploy api --region us-central1 --image x'),
      ev('gcloud run deploy api --region europe-west1 --image x'),
      ev('gcloud run services delete api --region us-central1 --quiet'),
    ], (r) => has(r, 'gcp-run', 'left'), 'europe api left');

    // B37 terraform -chdir relative vs cd
    check('B37', 'terraform -chdir=infra apply then cd infra && terraform destroy: same dir but not matched? (consistency)', [
      ev('terraform -chdir=infra apply -auto-approve'),
      ev('cd infra && terraform destroy -auto-approve'),
    ], (r) => has(r, 'iac-terraform', 'cleaned'), 'cleaned');

    // B38 docker compose -f after cd
    check('B38', 'cd app && docker compose up -d; later docker compose down in /repo marks it cleaned', [
      ev('cd app && docker compose up -d'),
      ev('docker compose down'),
    ], (r) => has(r, 'docker-compose', 'left'), 'app stack left');

    check('B3', 'az: same VM name in two subscriptions merges into one finding; deleting the sub-b one hides sub-a', [
      ev('az vm create -g rg -n web --subscription sub-a'),
      ev('az vm create -g rg -n web --subscription sub-b'),
      ev('az vm delete -g rg -n web --subscription sub-b --yes'),
    ], (r) => has(r, 'az-vm', 'left'), 'web in sub-a left');

    check('B3b', 'gcloud: same VM name under two --account / --configuration merges (key omits account/configuration)', [
      ev('gcloud compute instances create web --zone z --configuration work'),
      ev('gcloud compute instances create web --zone z --configuration personal'),
      ev('gcloud compute instances delete web --zone z --configuration personal --quiet'),
    ], (r) => has(r, 'gcp-vm', 'left'), 'web under "work" left');

    check('B23', 'gcp orphans: parent VM looked up by name only; kept boot disk in proj-a missed because proj-b VM is used', [
      ev('gcloud compute instances create web --zone z --project proj-a --create-disk=boot=yes,auto-delete=no,image-family=debian-12,image-project=debian-cloud'),
      ev('gcloud compute instances create web --zone z --project proj-b'),
      ev('gcloud compute instances delete web --zone z --project proj-a --quiet'),
    ], (r) => r.some((f) => f.rule === 'gcp-kept-disk' && f.status === 'left'), 'kept boot disk (proj-a) listed');

    check('B23b', 'gcp orphans: disks delete in proj-b cleans kept disk from proj-a', [
      ev('gcloud compute instances create web --zone z --project proj-a --create-disk=name=data1,auto-delete=no,size=100GB'),
      ev('gcloud compute instances delete web --zone z --project proj-a --quiet'),
      ev('gcloud compute disks delete data1 --zone z --project proj-b --quiet'),
    ], (r) => r.some((f) => f.rule === 'gcp-kept-disk' && f.status === 'left'), 'proj-a data1 left');

    check('B41', 'variable names match literally across sessions: create $VM (s1) cleaned by delete $VM (s2)', [
      ev('gcloud compute instances create $VM --zone z', { session: 's1' }),
      ev('gcloud compute instances delete $VM --zone z --quiet', { session: 's2' }),
    ], (r) => !has(r, 'gcp-vm', 'cleaned'), 'left or maybe-cleaned (value of $VM unknown)');
};
