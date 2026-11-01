'use strict';
// v0.4.2 round 2: deferred fixes from the v0.4.1 teardown review (#20 cost, #9 gcloud config zone,
// #19 sibling bucket undo) and the costliest missing create rules (review C part B), each with its
// teardown and its undo.
const assert = require('assert');
const { scan } = require('../src/scan');
const { gbOf, specFrom, estimate } = require('../src/cost');
const { flag } = require('../src/shell');
const report = require('../src/report');

let n = 0;
const ev = (command, o = {}) => ({ kind: 'cmd', command, time: `2026-11-01T03:${String(n++ % 60).padStart(2, '0')}:00Z`, cwd: '/home/u/proj', session: 'r2', tool: 'claude', ...o });
const run = (...cmds) => scan(cmds.map((c) => ev(c)), { platform: 'linux' }).resources;
const one = (rule, ...cmds) => { const f = run(...cmds).find((x) => x.rule === rule); assert.ok(f, `no ${rule} finding for: ${cmds.join(' ; ')}`); return f; };
const status = (rule, ...cmds) => one(rule, ...cmds).status;
const spec = (rule, cmd) => specFrom(rule, flag, require('../src/shell').tokenize(cmd));

// [rule, create, expected teardown, expected hint (regex or null), undo command, extra checks]
const COVER = [
  ['gcp-tpu', 'gcloud compute tpus tpu-vm create tpu1 --zone us-central2-b --accelerator-type v4-8 --version tpu-ubuntu2204-base',
    'gcloud compute tpus tpu-vm delete tpu1 --zone us-central2-b', null, 'gcloud compute tpus tpu-vm delete tpu1 --zone us-central2-b', { accel: true, cost: 'hourly' }],
  ['gcp-workbench', 'gcloud workbench instances create nb1 --location us-central1-a --machine-type n1-standard-4',
    'gcloud workbench instances delete nb1 --location us-central1-a', /instances stop/, 'gcloud workbench instances delete nb1 --location us-central1-a', { cost: 'hourly' }],
  ['gcp-workbench', 'gcloud notebooks instances create nb2 --location us-central1-b --vm-image-project deeplearning-platform-release',
    'gcloud notebooks instances delete nb2 --location us-central1-b', null, 'gcloud notebooks instances delete nb2 --location us-central1-b', {}],
  ['aws-sagemaker-notebook', 'aws sagemaker create-notebook-instance --notebook-instance-name nb --instance-type ml.g4dn.xlarge --role-arn arn:aws:iam::1:role/x',
    'aws sagemaker stop-notebook-instance --notebook-instance-name nb', /once it shows Stopped: aws sagemaker delete-notebook-instance --notebook-instance-name nb/, 'aws sagemaker delete-notebook-instance --notebook-instance-name nb', { gpu: true }],
  ['aws-sagemaker', 'aws sagemaker create-endpoint --endpoint-name ep1 --endpoint-config-name cfg1',
    'aws sagemaker delete-endpoint --endpoint-name ep1', null, 'aws sagemaker delete-endpoint --endpoint-name ep1', {}],
  ['gcp-vertex-endpoint', 'gcloud ai endpoints deploy-model 123 --region us-central1 --model 456 --display-name m',
    'gcloud ai endpoints undeploy-model 123 --region us-central1 --deployed-model-id <ID from: gcloud ai endpoints describe 123>', null, 'gcloud ai endpoints undeploy-model 123 --region us-central1 --deployed-model-id 9', {}],
  ['az-ml-compute', 'az ml compute create --name gpu-cl --type AmlCompute --size Standard_NC6s_v3 -g rg1 -w ws1',
    'az ml compute delete --name gpu-cl -g rg1 -w ws1', /az ml compute stop/, 'az ml compute delete --name gpu-cl -g rg1 -w ws1', { gpu: true }],
  ['aws-bedrock-pt', 'aws bedrock create-provisioned-model-throughput --model-units 1 --provisioned-model-name pt1 --model-id anthropic.claude-3-haiku --commitment-duration OneMonth',
    'aws bedrock delete-provisioned-model-throughput --provisioned-model-id pt1', /OneMonth commitment/, 'aws bedrock delete-provisioned-model-throughput --provisioned-model-id pt1', { accel: true }],
  ['az-openai-deployment', 'az cognitiveservices account deployment create -g rg -n acct --deployment-name gpt4o --model-name gpt-4o --model-version 2024-08-06 --model-format OpenAI --sku-name ProvisionedManaged --sku-capacity 50',
    'az cognitiveservices account deployment delete -g rg -n acct --deployment-name gpt4o', null, 'az cognitiveservices account deployment delete -g rg -n acct --deployment-name gpt4o', { accel: true, cost: 'hourly' }],
  ['az-cognitive-account', 'az cognitiveservices account create -n acct -g rg --kind OpenAI --sku S0 -l eastus',
    'az cognitiveservices account show -g rg -n acct', /purge -g rg -n acct -l eastus/, 'az cognitiveservices account delete -n acct -g rg', { cost: 'usage' }],
  ['aws-elbv2', 'aws elbv2 create-load-balancer --name my-alb --subnets subnet-1 subnet-2 --type application',
    'aws elbv2 describe-load-balancers --names my-alb --query LoadBalancers[].LoadBalancerArn', /delete-load-balancer --load-balancer-arn <ARN>/,
    'aws elbv2 delete-load-balancer --load-balancer-arn arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/50dc6c495c0c9188', { estimate: true }],
  ['aws-vpce', 'aws ec2 create-vpc-endpoint --vpc-id vpc-1 --vpc-endpoint-type Interface --service-name com.amazonaws.us-east-1.ssm --subnet-ids s1',
    'aws ec2 describe-vpc-endpoints --filters Name=service-name,Values=com.amazonaws.us-east-1.ssm', /delete-vpc-endpoints --vpc-endpoint-ids <ID>/, null, { estimate: true }],
  ['aws-elasticache', 'aws elasticache create-cache-cluster --cache-cluster-id c1 --cache-node-type cache.t3.micro --engine redis --num-cache-nodes 1',
    'aws elasticache delete-cache-cluster --cache-cluster-id c1', null, 'aws elasticache delete-cache-cluster --cache-cluster-id c1', { estimate: true }],
  ['aws-elasticache-rg', 'aws elasticache create-replication-group --replication-group-id rg1 --replication-group-description d --engine redis',
    'aws elasticache delete-replication-group --replication-group-id rg1', /--final-snapshot-identifier rg1-final/, 'aws elasticache delete-replication-group --replication-group-id rg1', {}],
  ['aws-elasticache-serverless', 'aws elasticache create-serverless-cache --serverless-cache-name sc1 --engine valkey',
    'aws elasticache delete-serverless-cache --serverless-cache-name sc1', null, 'aws elasticache delete-serverless-cache --serverless-cache-name sc1', {}],
  ['aws-opensearch', 'aws opensearch create-domain --domain-name search1 --engine-version OpenSearch_2.13',
    'aws opensearch delete-domain --domain-name search1', null, 'aws opensearch delete-domain --domain-name search1', {}],
  ['aws-opensearch', 'aws es create-elasticsearch-domain --domain-name legacy1',
    'aws es delete-elasticsearch-domain --domain-name legacy1', null, 'aws es delete-elasticsearch-domain --domain-name legacy1', {}],
  ['aws-opensearch-serverless', 'aws opensearchserverless create-collection --name logs --type SEARCH',
    'aws opensearchserverless batch-get-collection --names logs', /delete-collection --id <ID>/, null, {}],
  ['aws-redshift', 'aws redshift create-cluster --cluster-identifier wh1 --node-type ra3.xlplus --master-username a --master-user-password b',
    'aws redshift delete-cluster --cluster-identifier wh1 --final-cluster-snapshot-identifier wh1-final', /skip-final-cluster-snapshot/, 'aws redshift delete-cluster --cluster-identifier wh1 --skip-final-cluster-snapshot', {}],
  ['aws-redshift-serverless', 'aws redshift-serverless create-workgroup --workgroup-name wg1 --namespace-name ns1',
    'aws redshift-serverless delete-workgroup --workgroup-name wg1', /delete-namespace --namespace-name ns1/, 'aws redshift-serverless delete-workgroup --workgroup-name wg1', { cost: 'usage' }],
  ['aws-lightsail', 'aws lightsail create-instances --instance-names box1 --availability-zone us-east-1a --blueprint-id ubuntu_22_04 --bundle-id nano_3_0',
    'aws lightsail delete-instance --instance-name box1', null, 'aws lightsail delete-instance --instance-name box1', {}],
  ['do-droplet', 'doctl compute droplet create web-1 --size s-1vcpu-1gb --image ubuntu-24-04-x64 --region nyc1 --wait',
    'doctl compute droplet delete web-1', /asks before deleting/, 'doctl compute droplet delete web-1', {}],
  ['do-database', 'doctl databases create pg1 --engine pg --region nyc1 --size db-s-1vcpu-1gb',
    'doctl databases list', /doctl databases delete <DATABASE_ID>/, null, {}],
  ['do-k8s', 'doctl kubernetes cluster create k1 --region nyc1 --node-pool "name=p;size=s-2vcpu-4gb;count=2"',
    'doctl kubernetes cluster delete k1', /--dangerous/, 'doctl kubernetes cluster delete k1', {}],
  ['az-container', 'az container create -g rg -n aci1 --image nginx --ports 80',
    'az container delete -g rg -n aci1', null, 'az container delete -g rg -n aci1', {}],
  ['az-vmss', 'az vmss create -g rg -n ss1 --image Ubuntu2204 --instance-count 2',
    'az vmss delete -g rg -n ss1', /load balancer/, 'az vmss delete -g rg -n ss1', {}],
  ['az-redis', 'az redis create -g rg -n cache1 -l eastus --sku Basic --vm-size c0',
    'az redis delete -g rg -n cache1', null, 'az redis delete -g rg -n cache1', {}],
  ['az-cosmosdb', 'az cosmosdb create -g rg -n cosmos1',
    'az cosmosdb delete -g rg -n cosmos1', /every database/, 'az cosmosdb delete -g rg -n cosmos1', {}],
  ['az-sql-server', 'az sql server create -g rg -n srv1 -l eastus -u admin1 -p x',
    'az sql db list -g rg -s srv1 -o table', /az sql server delete -g rg -n srv1/, 'az sql server delete -g rg -n srv1', { cost: 'usage' }],
  ['az-sql-db', 'az sql db create -g rg -s srv1 -n db1 --service-objective S0',
    'az sql db delete -g rg -s srv1 -n db1', null, 'az sql db delete -g rg -s srv1 -n db1', {}],
  ['ssh-tunnel', 'ssh -fN -R 80:localhost:3000 serveo.net', 'pgrep -af serveo.net', /reverse tunnel.*kill <PID>/, null, { cost: 'local' }],
  ['tailscale-funnel', 'tailscale funnel --bg 3000', 'tailscale funnel status', /tailscale funnel reset/, 'tailscale funnel reset', { cost: 'local' }],
  ['podman-run', 'podman run -d --name pg -p 5432:5432 postgres:16', 'podman ps -a --filter name=pg', /podman stop pg, then: podman rm pg/, 'podman rm -f pg', { cost: 'local' }],
];

module.exports = (t) => {
  // ---- A2: cost estimates ----
  t('cost: gcloud disk --size reads TB and GB (2TB = 2048 GB, not 2)', () => {
    assert.strictEqual(gbOf('2TB'), 2048); assert.strictEqual(gbOf('10GB'), 10); assert.strictEqual(gbOf('200'), 200); assert.strictEqual(gbOf('1.5TB'), 1536); assert.strictEqual(gbOf('lots'), 0);
    assert.strictEqual(spec('gcp-disk', 'gcloud compute disks create d --size 2TB --zone z').gb, 2048);
    assert.strictEqual(spec('gcp-disk', 'gcloud compute disks create d --size=500GB --zone z').gb, 500);
  });
  t('cost: pd-balanced is $0.10/GB-month, pd-ssd $0.17, pd-standard $0.04', () => {
    const at = (type) => { const f = one('gcp-disk', `gcloud compute disks create d-${type} --size 100GB --type ${type} --zone us-central1-a`); return f.estimate; };
    assert.strictEqual(at('pd-balanced').perMonth, 10); assert.ok(/balanced/.test(at('pd-balanced').basis));
    assert.strictEqual(at('pd-ssd').perMonth, 17); assert.strictEqual(at('pd-standard').perMonth, 4);
    // Default sizes: 500 GB for pd-standard, 100 GB for the other types.
    assert.strictEqual(spec('gcp-disk', 'gcloud compute disks create d --type pd-balanced').gb, 100);
    assert.strictEqual(spec('gcp-disk', 'gcloud compute disks create d').gb, 500);
  });
  t('cost: the 2 TB balanced disk from the review is ~$205/month', () => {
    const f = one('gcp-disk', 'gcloud compute disks create big --size 2TB --type pd-balanced --zone us-central1-a');
    assert.strictEqual(f.estimate.perMonth, 204.8); assert.strictEqual(f.estimate.basis, '2048 GB balanced');
  });
  t('cost: az vm create without --size is Standard_D2s_v5 (the Azure CLI default) and is priced', () => {
    const f = one('az-vm', 'az vm create -n v1 -g rg --image Ubuntu2204');
    assert.strictEqual(f.spec.type, 'standard_d2s_v5'); assert.ok(f.estimate && /az default/.test(f.estimate.basis), JSON.stringify(f.estimate));
    assert.ok(one('az-vm', 'az vm create -n v2 -g rg --image Ubuntu2204 --size Standard_DS1_v2').estimate);
  });
  t('cost: EBS defaults to gp2 ($0.10) and reads --volume-type', () => {
    assert.strictEqual(one('aws-ebs', 'aws ec2 create-volume --size 100 --availability-zone us-east-1a').estimate.basis, '100 GB gp2');
    assert.strictEqual(one('aws-ebs', 'aws ec2 create-volume --size 100 --volume-type gp3 --availability-zone us-east-1a').estimate.perMonth, 8);
  });
  t('cost: old findings without diskType still estimate; unknown hyperdisk types give no guess', () => {
    assert.ok(estimate({ rule: 'gcp-disk', status: 'left', time: '2026-11-01T00:00:00Z', spec: { gb: 10, ssd: true } }));
    assert.strictEqual(one('gcp-disk', 'gcloud compute disks create h --type hyperdisk-balanced --zone z').estimate, undefined);
  });

  // ---- A3: gcloud config set compute/zone|region ----
  t('zone: gcloud config set compute/zone is the VM zone (scope and teardown)', () => {
    const f = one('gcp-vm', 'gcloud config set compute/zone us-west1-b', 'gcloud compute instances create vm-z');
    assert.strictEqual(f.scope.zone, 'us-west1-b'); assert.strictEqual(f.teardown, 'gcloud compute instances delete vm-z --zone us-west1-b');
  });
  t('zone: a delete in another zone does not clean it; the same session zone does', () => {
    assert.strictEqual(status('gcp-vm', 'gcloud config set compute/zone us-west1-b', 'gcloud compute instances create vm-z', 'gcloud compute instances delete vm-z --zone us-east1-b'), 'left');
    assert.strictEqual(status('gcp-vm', 'gcloud config set compute/zone us-west1-b', 'gcloud compute instances create vm-z', 'gcloud compute instances delete vm-z'), 'cleaned');
    // Two same-named VMs in two session zones are two rows.
    const r = run('gcloud config set compute/zone us-west1-b', 'gcloud compute instances create vm-z', 'gcloud config set compute/zone europe-west1-c', 'gcloud compute instances create vm-z');
    assert.strictEqual(r.filter((f) => f.rule === 'gcp-vm').length, 2);
  });
  t('zone: an explicit --zone wins over the session zone; disks, TPUs and GKE use it too', () => {
    assert.strictEqual(one('gcp-vm', 'gcloud config set compute/zone us-west1-b', 'gcloud compute instances create vm-y --zone asia-east1-a').teardown, 'gcloud compute instances delete vm-y --zone asia-east1-a');
    assert.strictEqual(one('gcp-disk', 'gcloud config set compute/zone us-west1-b', 'gcloud compute disks create d1 --size 10GB').teardown, 'gcloud compute disks delete d1 --zone us-west1-b');
    assert.strictEqual(one('gcp-tpu', 'gcloud config set compute/zone us-central2-b', 'gcloud compute tpus tpu-vm create t1 --accelerator-type v4-8 --version v2').teardown, 'gcloud compute tpus tpu-vm delete t1 --zone us-central2-b');
    assert.strictEqual(one('gcp-gke', 'gcloud config set compute/zone us-west1-b', 'gcloud container clusters create c1').teardown, 'gcloud container clusters delete c1 --zone us-west1-b');
  });
  t('zone: compute/region is the static IP region (not for --global)', () => {
    assert.strictEqual(one('gcp-ip', 'gcloud config set compute/region us-west1', 'gcloud compute addresses create ip1').teardown, 'gcloud compute addresses delete ip1 --region us-west1');
    assert.strictEqual(one('gcp-ip', 'gcloud config set compute/region us-west1', 'gcloud compute addresses create ip2 --global').teardown, 'gcloud compute addresses delete ip2 --global');
  });
  t('zone: export CLOUDSDK_COMPUTE_ZONE, config unset and configurations activate', () => {
    assert.strictEqual(one('gcp-vm', 'export CLOUDSDK_COMPUTE_ZONE=us-east4-a', 'gcloud compute instances create e1').scope.zone, 'us-east4-a');
    assert.strictEqual(one('gcp-vm', 'gcloud config set compute/zone us-west1-b', 'gcloud config unset compute/zone', 'gcloud compute instances create u1').scope.zone, undefined);
    assert.strictEqual(one('gcp-vm', 'gcloud config set compute/zone us-west1-b', 'gcloud config configurations activate other', 'gcloud compute instances create a1').scope.zone, undefined);
    // A failed config set changes nothing.
    const f = scan([ev('gcloud config set compute/zone us-west1-b', { failed: true }), ev('gcloud compute instances create f1')]).resources[0];
    assert.strictEqual(f.scope.zone, undefined);
  });
  t('zone: Cloud Run is not given the compute zone', () => {
    const f = one('gcp-run', 'gcloud config set compute/zone us-west1-b', 'gcloud run deploy api --region us-central1');
    assert.ok(!/--zone/.test(f.teardown + (f.teardownHint || '')), f.teardown);
  });

  // ---- A4: sibling bucket undo ----
  t('buckets: gsutil mb then gcloud storage buckets delete = cleaned (and the reverse)', () => {
    assert.strictEqual(status('gcp-gsutil-mb', 'gsutil mb gs://b1', 'gcloud storage buckets delete gs://b1'), 'cleaned');
    assert.strictEqual(status('gcp-gsutil-mb', 'gsutil mb gs://b1', 'gcloud storage rm -r gs://b1'), 'cleaned');
    assert.strictEqual(status('gcp-bucket', 'gcloud storage buckets create gs://b2', 'gsutil rb gs://b2'), 'cleaned');
    assert.strictEqual(status('gcp-bucket', 'gcloud storage buckets create gs://b2', 'gsutil rm -r gs://b2'), 'cleaned');
    // Reads still never clean, and another bucket stays left.
    assert.strictEqual(status('gcp-gsutil-mb', 'gsutil mb gs://b1', 'gcloud storage buckets describe gs://b1'), 'left');
    assert.strictEqual(status('gcp-gsutil-mb', 'gsutil mb gs://b1', 'gcloud storage buckets delete gs://b9'), 'left');
  });
  t('buckets: aws s3 mb then s3api delete-bucket = cleaned (and the reverse)', () => {
    assert.strictEqual(status('aws-s3', 'aws s3 mb s3://b3', 'aws s3api delete-bucket --bucket b3'), 'cleaned');
    assert.strictEqual(status('aws-s3api', 'aws s3api create-bucket --bucket b4', 'aws s3 rb s3://b4'), 'cleaned');
    assert.strictEqual(status('aws-s3', 'aws s3 mb s3://b3', 'aws s3api delete-bucket --bucket b5'), 'left');
    assert.strictEqual(status('aws-s3', 'aws s3 mb s3://b3 --profile a', 'aws s3api delete-bucket --bucket b3 --profile b'), 'left');
  });

  // ---- isNoop fix found on the way: --version followed by a value is a real create ----
  t('noop: "--version <value>" does not hide a create (tpu-vm runtime, helm chart version)', () => {
    assert.ok(one('gcp-tpu', 'gcloud compute tpus tpu-vm create t9 --zone z --accelerator-type v4-8 --version tpu-ubuntu2204-base'));
    assert.strictEqual(run('gcloud --version').length, 0);
    assert.strictEqual(run('terraform apply --version').length, 0);
  });

  // ---- B: coverage ----
  for (const [rule, create, td, hint, undo, extra] of COVER) {
    t(`coverage: ${rule}: ${create.split(' ').slice(0, 4).join(' ')}`, () => {
      const f = one(rule, create);
      assert.strictEqual(f.status, 'left');
      assert.strictEqual(f.teardown, td);
      if (hint) assert.ok(hint.test(f.teardownHint || ''), f.teardownHint);
      if (extra.cost) assert.strictEqual(f.cost, extra.cost);
      if (extra.accel) assert.ok(f.accel && !f.gpu, JSON.stringify(f));
      if (extra.gpu) assert.ok(f.gpu, JSON.stringify(f));
      if (extra.estimate) assert.ok(f.estimate, 'no estimate');
      if (undo) assert.strictEqual(status(rule, create, undo), 'cleaned', undo);
      else assert.strictEqual(status(rule, create, 'true'), 'left');
    });
  }
  t('coverage: hourly AI accelerators rank with GPUs at the top of the report', () => {
    const res = scan([ev('aws s3 mb s3://x'), ev('aws bedrock create-provisioned-model-throughput --model-units 1 --provisioned-model-name pt --model-id m'), ev('gcloud compute tpus tpu-vm create tp --zone z --version v')]);
    const txt = report.text({ ...res, cmdCount: 3, sessionCount: 1 }, { days: 30, color: false });
    const iB = txt.indexOf('Bedrock'); const iT = txt.indexOf('Cloud TPU'); const iS = txt.indexOf('S3 bucket');
    assert.ok(iB > 0 && iT > 0 && iS > iB && iS > iT, txt);
    assert.ok(/ACCEL, HOURLY/.test(txt));
  });
  t('coverage: scope flags reach the new teardowns (aws profile/region, az subscription, doctl context)', () => {
    assert.strictEqual(one('aws-redshift', 'export AWS_PROFILE=client', 'aws redshift create-cluster --cluster-identifier w --region eu-west-1').teardown, 'aws redshift delete-cluster --cluster-identifier w --final-cluster-snapshot-identifier w-final --profile client --region eu-west-1');
    assert.ok(/--subscription sub1$/.test(one('az-redis', 'az account set --subscription sub1', 'az redis create -g rg -n c -l eastus --sku Basic --vm-size c0').teardown));
    assert.strictEqual(one('do-droplet', 'doctl compute droplet create d --size s --image i --region r --context work').teardown, 'doctl compute droplet delete d --context work');
    assert.strictEqual(status('do-droplet', 'doctl compute droplet create d --size s --image i --context work', 'doctl compute droplet delete d --context personal'), 'left');
  });
  t('coverage: multi-name creates (droplets, Lightsail, TPUs) are one row each', () => {
    assert.strictEqual(run('doctl compute droplet create a b c --size s --image i --region r').length, 3);
    assert.strictEqual(run('aws lightsail create-instances --instance-names x y --availability-zone z --blueprint-id b --bundle-id n').length, 2);
    const r = run('doctl compute droplet create a b --size s --image i', 'doctl compute droplet rm a');
    assert.deepStrictEqual(r.map((f) => f.status), ['cleaned', 'left']);
  });
  t('coverage: parent deletes clear children (OpenAI account → deployment, SQL server → database, ARN of another LB does not)', () => {
    const dep = 'az cognitiveservices account deployment create -g rg -n acct --deployment-name d1 --model-name gpt-4o --model-format OpenAI --sku-name Standard --sku-capacity 1';
    assert.strictEqual(status('az-openai-deployment', dep, 'az cognitiveservices account delete -g rg -n acct'), 'cleaned');
    assert.strictEqual(status('az-openai-deployment', dep, 'az cognitiveservices account delete -g rg -n other'), 'left');
    assert.strictEqual(one('az-openai-deployment', dep).cost, 'usage');
    assert.strictEqual(status('az-sql-db', 'az sql db create -g rg -s srv1 -n db1', 'az sql server delete -g rg -n srv1'), 'cleaned');
    assert.strictEqual(status('az-sql-db', 'az sql db create -g rg -s srv1 -n db1', 'az sql db delete -g rg -s srv2 -n db1'), 'left');
    assert.strictEqual(status('aws-elbv2', 'aws elbv2 create-load-balancer --name a1', 'aws elbv2 delete-load-balancer --load-balancer-arn arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/net/b2/abc'), 'left');
    assert.strictEqual(status('aws-elbv2', 'aws elbv2 create-load-balancer --name a1', 'aws elbv2 delete-load-balancer --load-balancer-arn $ARN'), 'maybe-cleaned');
    assert.strictEqual(status('az-ml-compute', 'az ml compute create -n c1 -g rg -w ws1 --type ComputeInstance --size Standard_DS3_v2', 'az ml compute delete -n c1 -g rg -w ws2'), 'left');
  });
  t('coverage: what is NOT a leftover (gateway endpoints, plain ssh, funnel status/off, attached podman, standard Azure OpenAI is usage)', () => {
    assert.strictEqual(run('aws ec2 create-vpc-endpoint --vpc-id v --service-name com.amazonaws.us-east-1.s3').length, 0);
    assert.strictEqual(run('aws ec2 create-vpc-endpoint --vpc-id v --vpc-endpoint-type Gateway --service-name com.amazonaws.us-east-1.s3').length, 0);
    assert.strictEqual(run('ssh bastion uptime', 'ssh -N -L 5432:db:5432 bastion', 'ssh -f bastion "sleep 1"').length, 0);
    assert.strictEqual(run('tailscale funnel status', 'tailscale funnel reset', 'tailscale funnel --https=443 off').length, 0);
    assert.strictEqual(run('podman run --rm alpine echo hi').length, 0);
    assert.strictEqual(status('tailscale-funnel', 'tailscale funnel --bg 3000', 'tailscale funnel --bg 3000 off'), 'cleaned');
    assert.strictEqual(status('tailscale-funnel', 'tailscale funnel --bg 3000', 'tailscale funnel --bg 4000 off'), 'maybe-cleaned');
    assert.strictEqual(status('aws-sagemaker-notebook', 'aws sagemaker create-notebook-instance --notebook-instance-name nb --instance-type ml.t3.medium --role-arn r', 'aws sagemaker stop-notebook-instance --notebook-instance-name nb'), 'maybe-cleaned');
  });
};
