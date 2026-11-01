'use strict';
const { flag, hasFlag, positional, positionals } = require('./shell');

// Each rule: a create command an agent might run, how to name what it made,
// the teardown command, and (optionally) the matching delete so we can tell
// when the agent already cleaned up.
//
// cost: 'hourly'  = bills while it exists (VMs, databases, clusters, GPUs)
//       'usage'   = bills mostly by use/storage (buckets, functions, deploys)
//       'enabler' = turns on a paid API or service

const P = (toks, n, vf) => positional(toks, n, vf);
const GV = ['--zone', '--region', '--project', '--format', '--machine-type', '--image', '--image-family', '--image-project', '--tier', '--database-version', '--memory', '--cpu', '--source', '--runtime', '--trigger-http', '--entry-point', '--location', '--num-nodes', '--size', '--type', '--platform', '--port', '--accelerator', '--network', '--subnet', '--service-account'];
// gcloud flags that take no value; every other --flag is assumed to take one.
const GBOOL = ['--quiet', '-q', '--async', '--global', '--preemptible', '--spot', '--no-address', '--allow-unauthenticated', '--no-allow-unauthenticated',
  '--enable-autoscaling', '--trigger-http', '--gen2', '--no-gen2', '--enable-ip-alias', '--shielded-secure-boot', '--shielded-vtpm', '--can-ip-forward',
  '--no-restart-on-failure', '--uniform-bucket-level-access', '--enable-autorepair', '--enable-autoupgrade', '--no-traffic',
  '--enable-stackdriver-kubernetes', '--no-enable-basic-auth', '--enable-private-nodes', '--no-shielded-secure-boot', '--require-ssl', '--no-backup',
  '--assign-ip', '--no-assign-ip', '--enable-bin-log', '--public-access-prevention', '--source', '--clear-labels'];
// Names right after the verb (create vm1 vm2 --zone z), else the first positional.
function gnames(t, i) {
  const out = [];
  while (i < t.length && !t[i].startsWith('-')) out.push(t[i++]);
  if (out.length) return out;
  const p = positionals(t, i, [], GBOOL.filter((x) => x !== '--source'));
  return p.length ? [p[0]] : [null];
}
const gname = (t, i) => gnames(t, i)[0];
const urlArg = (t, scheme) => t.find((x) => x.startsWith(scheme)) || null;
const gz = (t) => flag(t, ['--zone']);
const gr = (t) => flag(t, ['--region', '--location']);
const opt = (name, v) => (v ? ` ${name} ${v}` : '');

// deploy: true marks commands that usually update something that already existed
// (a redeploy). The teardown then starts with a look, never a delete.
const rules = [
  // ---------------- Google Cloud ----------------
  { id: 'gcp-vm', provider: 'gcloud', what: 'Compute Engine VM', cost: 'hourly',
    when: ['gcloud', 'compute', 'instances', 'create'], multi: (t) => gnames(t, 4),
    teardown: (n, t) => `gcloud compute instances delete ${n}${opt('--zone', gz(t))}`,
    undo: { when: ['gcloud', 'compute', 'instances', 'delete'], multi: (t) => gnames(t, 4) } },
  { id: 'gcp-disk', provider: 'gcloud', what: 'Persistent disk', cost: 'hourly',
    when: ['gcloud', 'compute', 'disks', 'create'], multi: (t) => gnames(t, 4),
    teardown: (n, t) => `gcloud compute disks delete ${n}${opt('--zone', gz(t))}`,
    undo: { when: ['gcloud', 'compute', 'disks', 'delete'], multi: (t) => gnames(t, 4) } },
  { id: 'gcp-ip', provider: 'gcloud', what: 'Static IP address', cost: 'hourly',
    when: ['gcloud', 'compute', 'addresses', 'create'], multi: (t) => gnames(t, 4),
    teardown: (n, t) => `gcloud compute addresses delete ${n}${hasFlag(t, ['--global']) ? ' --global' : opt('--region', gr(t))}`,
    undo: { when: ['gcloud', 'compute', 'addresses', 'delete'], multi: (t) => gnames(t, 4) } },
  { id: 'gcp-sql', provider: 'gcloud', what: 'Cloud SQL instance', cost: 'hourly',
    when: ['gcloud', 'sql', 'instances', 'create'], name: (t) => gname(t, 4),
    teardown: (n) => `gcloud sql instances delete ${n}   # take a backup first if it holds data`,
    undo: { when: ['gcloud', 'sql', 'instances', 'delete'], multi: (t) => gnames(t, 4) } },
  { id: 'gcp-gke', provider: 'gcloud', what: 'GKE cluster', cost: 'hourly',
    when: ['gcloud', 'container', 'clusters', ['create', 'create-auto']], name: (t) => gname(t, 4),
    teardown: (n, t) => `gcloud container clusters delete ${n}${opt('--zone', gz(t))}${opt('--region', flag(t, ['--region']))}`,
    undo: { when: ['gcloud', 'container', 'clusters', 'delete'], multi: (t) => gnames(t, 4) } },
  { id: 'gcp-redis', provider: 'gcloud', what: 'Memorystore Redis', cost: 'hourly',
    when: ['gcloud', 'redis', 'instances', 'create'], name: (t) => gname(t, 4),
    teardown: (n, t) => `gcloud redis instances delete ${n}${opt('--region', gr(t))}`,
    undo: { when: ['gcloud', 'redis', 'instances', 'delete'], multi: (t) => gnames(t, 4) } },
  { id: 'gcp-vertex-endpoint', provider: 'gcloud', what: 'Vertex AI model deployment', cost: 'hourly',
    when: ['gcloud', 'ai', 'endpoints', 'deploy-model'], name: (t) => gname(t, 4),
    teardown: (n, t) => `gcloud ai endpoints undeploy-model ${n}${opt('--region', gr(t))} --deployed-model-id <ID from: gcloud ai endpoints describe ${n}>`,
    undo: { when: ['gcloud', 'ai', 'endpoints', ['undeploy-model', 'delete']], name: (t) => gname(t, 4) } },
  { id: 'gcp-run', provider: 'gcloud', what: 'Cloud Run service', cost: 'usage', deploy: true,
    when: ['gcloud', 'run', 'deploy'], name: (t) => gname(t, 3),
    teardown: (n, t) => `gcloud run services describe ${n}${opt('--region', gr(t))}   # if the agent made it just for this: gcloud run services delete ${n}${opt('--region', gr(t))}`,
    undo: { when: ['gcloud', 'run', 'services', 'delete'], multi: (t) => gnames(t, 4) } },
  { id: 'gcp-fn', provider: 'gcloud', what: 'Cloud Function', cost: 'usage', deploy: true,
    when: ['gcloud', 'functions', 'deploy'], name: (t) => gname(t, 3),
    teardown: (n, t) => `gcloud functions describe ${n}${opt('--region', gr(t))}   # if the agent made it just for this: gcloud functions delete ${n}${opt('--region', gr(t))}`,
    undo: { when: ['gcloud', 'functions', 'delete'], multi: (t) => gnames(t, 3) } },
  { id: 'gcp-bucket', provider: 'gcloud', what: 'Cloud Storage bucket', cost: 'usage',
    when: ['gcloud', 'storage', 'buckets', 'create'], name: (t) => urlArg(t, 'gs://') || gname(t, 4),
    teardown: (n) => `gcloud storage buckets delete ${n.startsWith('gs://') ? n : 'gs://' + n}   # fails if not empty; 'storage rm -r' also deletes the contents`,
    undo: { when: ['gcloud', 'storage', ['rm', 'buckets']], multi: (t) => t.filter((x) => x.startsWith('gs://')).map((x) => x.replace(/\/$/, '')) } },
  { id: 'gcp-gsutil-mb', provider: 'gcloud', what: 'Cloud Storage bucket', cost: 'usage',
    when: ['gsutil', 'mb'], name: (t) => urlArg(t, 'gs://'),
    teardown: (n) => `gcloud storage buckets delete ${n}   # fails if not empty; 'storage rm -r' also deletes the contents`,
    undo: { when: ['gsutil', ['rb', 'rm']], multi: (t) => t.filter((x) => x.startsWith('gs://')).map((x) => x.replace(/\/$/, '')) } },
  { id: 'gcp-app', provider: 'gcloud', what: 'App Engine version', cost: 'usage', deploy: true,
    when: ['gcloud', 'app', 'deploy'], name: () => '(default service)',
    teardown: () => 'gcloud app versions list   # then: gcloud app versions stop <VERSION>' },
  { id: 'gcp-api', provider: 'gcloud', what: 'Paid API enabled', cost: 'enabler',
    when: ['gcloud', 'services', 'enable'], multi: (t) => t.slice(3).filter((x) => !x.startsWith('-') && x.includes('.')),
    teardown: (n) => `gcloud services disable ${n}   # only if nothing else needs it`,
    undo: { when: ['gcloud', 'services', 'disable'], multi: (t) => t.slice(3).filter((x) => !x.startsWith('-')) } },

  // ---------------- AWS ----------------
  { id: 'aws-ec2', provider: 'aws', what: 'EC2 instance(s)', cost: 'hourly',
    when: ['aws', 'ec2', 'run-instances'], name: (t) => tagName(t) || flag(t, ['--instance-type']) && `${flag(t, ['--count']) || 1} x ${flag(t, ['--instance-type'])}`,
    teardown: () => 'aws ec2 describe-instances --filters Name=instance-state-name,Values=running --query "Reservations[].Instances[].InstanceId"   # then: aws ec2 terminate-instances --instance-ids <ID>',
    undo: { when: ['aws', 'ec2', 'terminate-instances'], any: true } },
  { id: 'aws-ebs', provider: 'aws', what: 'EBS volume', cost: 'hourly',
    when: ['aws', 'ec2', 'create-volume'], name: (t) => `${flag(t, ['--size']) || '?'} GB in ${flag(t, ['--availability-zone']) || '?'}`,
    teardown: () => 'aws ec2 describe-volumes --filters Name=status,Values=available   # then: aws ec2 delete-volume --volume-id <ID>' },
  { id: 'aws-eip', provider: 'aws', what: 'Elastic IP', cost: 'hourly',
    when: ['aws', 'ec2', 'allocate-address'], name: () => '(new address)',
    teardown: () => 'aws ec2 describe-addresses   # then: aws ec2 release-address --allocation-id <ID>',
    undo: { when: ['aws', 'ec2', 'release-address'], any: true } },
  { id: 'aws-nat', provider: 'aws', what: 'NAT gateway', cost: 'hourly',
    when: ['aws', 'ec2', 'create-nat-gateway'], name: (t) => flag(t, ['--subnet-id']) || '(new)',
    teardown: () => 'aws ec2 describe-nat-gateways   # then: aws ec2 delete-nat-gateway --nat-gateway-id <ID>',
    undo: { when: ['aws', 'ec2', 'delete-nat-gateway'], any: true } },
  { id: 'aws-rds', provider: 'aws', what: 'RDS database', cost: 'hourly',
    when: ['aws', 'rds', 'create-db-instance'], name: (t) => flag(t, ['--db-instance-identifier']),
    teardown: (n) => `aws rds delete-db-instance --db-instance-identifier ${n} --final-db-snapshot-identifier ${n}-final   # keeps a final snapshot`,
    undo: { when: ['aws', 'rds', 'delete-db-instance'], name: (t) => flag(t, ['--db-instance-identifier']) } },
  { id: 'aws-rds-cluster', provider: 'aws', what: 'RDS / Aurora cluster', cost: 'hourly',
    when: ['aws', 'rds', 'create-db-cluster'], name: (t) => flag(t, ['--db-cluster-identifier']),
    teardown: (n) => `aws rds delete-db-cluster --db-cluster-identifier ${n} --final-db-snapshot-identifier ${n}-final   # delete its instances first`,
    undo: { when: ['aws', 'rds', 'delete-db-cluster'], name: (t) => flag(t, ['--db-cluster-identifier']) } },
  { id: 'aws-s3', provider: 'aws', what: 'S3 bucket', cost: 'usage',
    when: ['aws', 's3', 'mb'], name: (t) => urlArg(t, 's3://'),
    teardown: (n) => `aws s3 rb ${n}   # fails if not empty; add --force to also delete its contents`,
    undo: { when: ['aws', 's3', 'rb'], multi: (t) => t.filter((x) => x.startsWith('s3://')).map((x) => x.replace(/\/$/, '')) } },
  { id: 'aws-s3api', provider: 'aws', what: 'S3 bucket', cost: 'usage',
    when: ['aws', 's3api', 'create-bucket'], name: (t) => flag(t, ['--bucket']) && `s3://${flag(t, ['--bucket'])}`,
    teardown: (n) => `aws s3 rb ${n}   # fails if not empty; add --force to also delete its contents`,
    undo: { when: ['aws', 's3api', 'delete-bucket'], name: (t) => flag(t, ['--bucket']) && `s3://${flag(t, ['--bucket'])}` } },
  { id: 'aws-lambda', provider: 'aws', what: 'Lambda function', cost: 'usage',
    when: ['aws', 'lambda', 'create-function'], name: (t) => flag(t, ['--function-name']),
    teardown: (n) => `aws lambda delete-function --function-name ${n}`,
    undo: { when: ['aws', 'lambda', 'delete-function'], name: (t) => flag(t, ['--function-name']) } },
  { id: 'aws-eks', provider: 'aws', what: 'EKS cluster', cost: 'hourly',
    when: ['aws', 'eks', 'create-cluster'], name: (t) => flag(t, ['--name']),
    teardown: (n) => `aws eks delete-cluster --name ${n}   # delete its node groups first`,
    undo: { when: ['aws', 'eks', 'delete-cluster'], name: (t) => flag(t, ['--name']) } },
  { id: 'aws-eksctl', provider: 'aws', what: 'EKS cluster (eksctl)', cost: 'hourly',
    when: ['eksctl', 'create', 'cluster'], name: (t) => flag(t, ['--name', '-n']) || P(t, 3, ['--region', '--nodes', '--node-type', '--version', '-f', '--profile']),
    teardown: (n, t) => `eksctl delete cluster --name ${n}${opt('--region', flag(t, ['--region']))}`,
    undo: { when: ['eksctl', 'delete', 'cluster'], name: (t) => flag(t, ['--name', '-n']) || P(t, 3, ['--region', '--profile']) } },
  { id: 'aws-elasticache', provider: 'aws', what: 'ElastiCache cluster', cost: 'hourly',
    when: ['aws', 'elasticache', 'create-cache-cluster'], name: (t) => flag(t, ['--cache-cluster-id']),
    teardown: (n) => `aws elasticache delete-cache-cluster --cache-cluster-id ${n}`,
    undo: { when: ['aws', 'elasticache', 'delete-cache-cluster'], name: (t) => flag(t, ['--cache-cluster-id']) } },
  { id: 'aws-sagemaker', provider: 'aws', what: 'SageMaker endpoint', cost: 'hourly',
    when: ['aws', 'sagemaker', 'create-endpoint'], name: (t) => flag(t, ['--endpoint-name']),
    teardown: (n) => `aws sagemaker delete-endpoint --endpoint-name ${n}`,
    undo: { when: ['aws', 'sagemaker', 'delete-endpoint'], name: (t) => flag(t, ['--endpoint-name']) } },
  { id: 'aws-ecs', provider: 'aws', what: 'ECS service', cost: 'hourly',
    when: ['aws', 'ecs', 'create-service'], name: (t) => flag(t, ['--service-name']),
    teardown: (n, t) => `aws ecs update-service --cluster ${flag(t, ['--cluster']) || 'default'} --service ${n} --desired-count 0   # then: aws ecs delete-service --cluster ${flag(t, ['--cluster']) || 'default'} --service ${n}`,
    undo: { when: ['aws', 'ecs', 'delete-service'], name: (t) => flag(t, ['--service']) } },
  { id: 'aws-dynamo', provider: 'aws', what: 'DynamoDB table', cost: 'usage',
    when: ['aws', 'dynamodb', 'create-table'], name: (t) => flag(t, ['--table-name']),
    teardown: (n) => `aws dynamodb delete-table --table-name ${n}`,
    undo: { when: ['aws', 'dynamodb', 'delete-table'], name: (t) => flag(t, ['--table-name']) } },

  // ---------------- Infra-as-code (whole stacks) ----------------
  // An apply often updates a stack that existed long before the agent. Never suggest a
  // blind destroy: show the plan, then remove only what the agent added.
  { id: 'iac-terraform', provider: 'terraform', what: 'Terraform apply (stack may pre-exist)', cost: 'hourly', deploy: true,
    when: [['terraform', 'tofu'], 'apply'], name: (t, ctx) => tfDir(t, ctx),
    teardown: (n, t) => `cd "${n}" && ${t[0]} state list${ws(t)}   # review what the agent added, then: ${t[0]} destroy -target=<ADDRESS>. A plain destroy removes the WHOLE stack, including what existed before`,
    undo: { when: [['terraform', 'tofu'], 'destroy'], name: (t, ctx) => tfDir(t, ctx), skipIf: (t) => hasFlag(t, ['-target']) } },
  { id: 'iac-cdk', provider: 'aws', what: 'CDK deploy (stack may pre-exist)', cost: 'hourly', deploy: true,
    when: ['cdk', 'deploy'], name: (t, ctx) => cdkStack(t) || ctx.cwd || '(all stacks)',
    teardown: (n, t) => cdkStack(t) ? `aws cloudformation describe-stacks --stack-name ${n}   # if the agent made this stack: cdk destroy ${n}` : `cd "${n}" && cdk list   # if the agent made a stack: cdk destroy <STACK>`,
    undo: { when: ['cdk', 'destroy'], name: (t, ctx) => cdkStack(t) || ctx.cwd || '(all stacks)' } },
  { id: 'iac-sam', provider: 'aws', what: 'SAM deploy (stack may pre-exist)', cost: 'usage', deploy: true,
    when: ['sam', 'deploy'], name: (t, ctx) => flag(t, ['--stack-name']) || ctx.cwd || '(stack)',
    teardown: (n, t) => flag(t, ['--stack-name']) ? `aws cloudformation describe-stacks --stack-name ${n}   # if the agent made this stack: sam delete --stack-name ${n}` : `cd "${n}" && sam list stack-outputs   # if the agent made the stack: sam delete`,
    undo: { when: ['sam', 'delete'], name: (t, ctx) => flag(t, ['--stack-name']) || ctx.cwd || '(stack)' } },
  { id: 'iac-pulumi', provider: 'pulumi', what: 'Pulumi up (stack may pre-exist)', cost: 'hourly', deploy: true,
    when: ['pulumi', 'up'], name: (t, ctx) => flag(t, ['--stack', '-s']) || ctx.cwd || '(stack)',
    teardown: (n, t) => flag(t, ['--stack', '-s'])
      ? `pulumi stack --stack ${n}   # review; a destroy removes the WHOLE stack: pulumi destroy --stack ${n}, or one resource: pulumi destroy --target <URN>`
      : `cd "${n}" && pulumi stack   # review; a destroy removes the WHOLE stack: pulumi destroy, or one resource: pulumi destroy --target <URN>`,
    undo: { when: ['pulumi', 'destroy'], name: (t, ctx) => flag(t, ['--stack', '-s']) || ctx.cwd || '(stack)', skipIf: (t) => hasFlag(t, ['--target']) } },
  { id: 'iac-serverless', provider: 'serverless', what: 'Serverless deploy (may pre-exist)', cost: 'usage', deploy: true,
    when: ['serverless', 'deploy'], name: (t, ctx) => ctx.cwd || '(service)',
    teardown: (n) => `cd "${n}" && serverless info   # if the agent made this service: serverless remove`,
    undo: { when: ['serverless', 'remove'], name: (t, ctx) => ctx.cwd || '(service)' } },

  // ---------------- Azure ----------------
  // az group create succeeds on a group that already exists, so look before deleting.
  { id: 'az-group', provider: 'az', what: 'Resource group (may pre-exist)', cost: 'hourly',
    when: ['az', 'group', 'create'], name: (t) => flag(t, ['--name', '-n', '--resource-group', '-g']),
    teardown: (n) => `az resource list -g ${n} -o table   # if the agent made this group just for this: az group delete --name ${n}  (deletes EVERYTHING inside it)`,
    undo: { when: ['az', 'group', 'delete'], name: (t) => flag(t, ['--name', '-n', '--resource-group', '-g']) } },
  { id: 'az-vm', provider: 'az', what: 'Azure VM', cost: 'hourly',
    when: ['az', 'vm', 'create'], name: (t) => flag(t, ['--name', '-n']),
    teardown: (n, t) => `az vm delete -g ${flag(t, ['--resource-group', '-g']) || '<GROUP>'} -n ${n}   # its disk, IP and NIC may need deleting too`,
    undo: { when: ['az', 'vm', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },
  { id: 'az-aks', provider: 'az', what: 'AKS cluster', cost: 'hourly',
    when: ['az', 'aks', 'create'], name: (t) => flag(t, ['--name', '-n']),
    teardown: (n, t) => `az aks delete -g ${flag(t, ['--resource-group', '-g']) || '<GROUP>'} -n ${n}`,
    undo: { when: ['az', 'aks', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },
  { id: 'az-webapp', provider: 'az', what: 'App Service web app', cost: 'hourly', deploy: true,
    when: ['az', 'webapp', ['up', 'create']], name: (t) => flag(t, ['--name', '-n']) || '(web app)',
    teardown: (n, t) => `az webapp show -g ${flag(t, ['--resource-group', '-g']) || '<GROUP>'} -n ${n}   # if the agent made it: az webapp delete -g <GROUP> -n ${n}, and check: az appservice plan list`,
    undo: { when: ['az', 'webapp', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },
  { id: 'az-containerapp', provider: 'az', what: 'Container App', cost: 'usage', deploy: true,
    when: ['az', 'containerapp', ['up', 'create']], name: (t) => flag(t, ['--name', '-n']),
    teardown: (n, t) => `az containerapp show -g ${flag(t, ['--resource-group', '-g']) || '<GROUP>'} -n ${n}   # if the agent made it: az containerapp delete -g <GROUP> -n ${n}`,
    undo: { when: ['az', 'containerapp', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },
  { id: 'az-pg', provider: 'az', what: 'Azure Postgres server', cost: 'hourly',
    when: ['az', ['postgres', 'mysql'], 'flexible-server', 'create'], name: (t) => flag(t, ['--name', '-n']),
    teardown: (n, t) => `az ${t[1]} flexible-server delete -g ${flag(t, ['--resource-group', '-g']) || '<GROUP>'} -n ${n}`,
    undo: { when: ['az', ['postgres', 'mysql'], 'flexible-server', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },

  // ---------------- Cloudflare ----------------
  { id: 'cf-worker', provider: 'wrangler', what: 'Cloudflare Worker deploy (may pre-exist)', cost: 'usage', deploy: true,
    when: ['wrangler', ['deploy', 'publish']], name: (t, ctx) => flag(t, ['--name']) || ctx.cwd || '(worker in this folder)',
    teardown: (n, t) => flag(t, ['--name']) ? `wrangler deployments list --name ${n}   # roll back: wrangler rollback; if the agent made this worker: wrangler delete --name ${n}` : `cd "${n}" && wrangler deployments list   # roll back: wrangler rollback; if the agent made this worker: wrangler delete`,
    undo: { when: ['wrangler', 'delete'], name: (t, ctx) => flag(t, ['--name']) || ctx.cwd || '(worker in this folder)' } },
  { id: 'cf-d1', provider: 'wrangler', what: 'D1 database', cost: 'usage',
    when: ['wrangler', 'd1', 'create'], name: (t) => P(t, 3, ['--location']),
    teardown: (n) => `wrangler d1 delete ${n}`,
    undo: { when: ['wrangler', 'd1', 'delete'], name: (t) => P(t, 3, []) } },
  { id: 'cf-r2', provider: 'wrangler', what: 'R2 bucket', cost: 'usage',
    when: ['wrangler', 'r2', 'bucket', 'create'], name: (t) => P(t, 4, ['--location', '--storage-class']),
    teardown: (n) => `wrangler r2 bucket delete ${n}`,
    undo: { when: ['wrangler', 'r2', 'bucket', 'delete'], name: (t) => P(t, 4, []) } },
  { id: 'cf-kv', provider: 'wrangler', what: 'KV namespace', cost: 'usage',
    when: ['wrangler', 'kv', 'namespace', 'create'], name: (t) => P(t, 4, []),
    teardown: () => 'wrangler kv namespace list   # then: wrangler kv namespace delete --namespace-id <ID>' },
  { id: 'cf-kv-legacy', provider: 'wrangler', what: 'KV namespace', cost: 'usage',
    when: ['wrangler', 'kv:namespace', 'create'], name: (t) => P(t, 3, []),
    teardown: () => 'wrangler kv namespace list   # then: wrangler kv namespace delete --namespace-id <ID>' },
  { id: 'cf-queue', provider: 'wrangler', what: 'Queue', cost: 'usage',
    when: ['wrangler', 'queues', 'create'], name: (t) => P(t, 3, []),
    teardown: (n) => `wrangler queues delete ${n}`,
    undo: { when: ['wrangler', 'queues', 'delete'], name: (t) => P(t, 3, []) } },
  { id: 'cf-pages', provider: 'wrangler', what: 'Pages deploy (project may pre-exist)', cost: 'usage', deploy: true,
    when: ['wrangler', 'pages', ['deploy', 'publish']], name: (t) => flag(t, ['--project-name']) || '(pages project)',
    teardown: (n) => `wrangler pages deployment list --project-name ${n}   # if the agent made this project: wrangler pages project delete ${n}`,
    undo: { when: ['wrangler', 'pages', 'project', 'delete'], name: (t) => P(t, 4, []) } },

  // ---------------- Vercel / Netlify / Railway / Heroku ----------------
  { id: 'vercel-deploy', provider: 'vercel', what: 'Vercel deploy (project may pre-exist)', cost: 'usage', deploy: true,
    when: ['vercel', ['deploy', '--prod', '--yes', '-y', null]], name: (t, ctx) => flag(t, ['--name']) || ctx.cwd || '(project in this folder)',
    teardown: (n) => `vercel ls   # remove a test deployment: vercel remove <DEPLOYMENT_URL>. Only if the agent made the project: vercel project rm <PROJECT>  (from ${n})`,
    undo: { when: ['vercel', ['remove', 'rm']], any: true } },
  { id: 'netlify-site', provider: 'netlify', what: 'Netlify site', cost: 'usage',
    when: ['netlify', 'sites:create'], name: (t, ctx) => flag(t, ['--name', '-n']) || ctx.cwd || '(site)',
    teardown: () => 'netlify sites:list   # then: netlify sites:delete <SITE_ID>',
    undo: { when: ['netlify', 'sites:delete'], any: true } },
  { id: 'netlify-deploy', provider: 'netlify', what: 'Netlify deploy (site may pre-exist)', cost: 'usage', deploy: true,
    when: ['netlify', 'deploy'], name: (t, ctx) => flag(t, ['--site', '--name']) || ctx.cwd || '(site)',
    teardown: (n) => `netlify status   # roll back in the Netlify UI if needed. Only if the agent made the site: netlify sites:delete <SITE_ID>  (from ${n})`,
    undo: { when: ['netlify', 'sites:delete'], any: true } },
  { id: 'railway-up', provider: 'railway', what: 'Railway deploy (service may pre-exist)', cost: 'hourly', deploy: true,
    when: ['railway', 'up'], name: (t, ctx) => ctx.cwd || '(linked project)',
    teardown: (n) => `cd "${n}" && railway status   # if the agent made this service: railway down`,
    undo: { when: ['railway', 'down'], name: (t, ctx) => ctx.cwd || '(linked project)' } },
  { id: 'heroku-create', provider: 'heroku', what: 'Heroku app', cost: 'hourly',
    when: ['heroku', ['create', 'apps:create']], name: (t) => P(t, 2, ['--region', '--team', '-t', '--stack', '-s', '--buildpack', '-b', '--remote', '-r', '--addons']) || '(new app)',
    teardown: (n) => `heroku apps:destroy ${n}`,
    undo: { when: ['heroku', ['apps:destroy', 'destroy']], name: (t) => flag(t, ['--app', '-a']) || P(t, 2, ['--confirm']) } },
  { id: 'heroku-addon', provider: 'heroku', what: 'Heroku add-on', cost: 'hourly',
    when: ['heroku', 'addons:create'], name: (t) => P(t, 2, ['--app', '-a', '--name', '--as']),
    teardown: (n, t) => `heroku addons:destroy ${n}${opt('--app', flag(t, ['--app', '-a']))}`,
    undo: { when: ['heroku', 'addons:destroy'], name: (t) => P(t, 2, ['--app', '-a']) } },

  // ---------------- Supabase ----------------
  { id: 'supabase-project', provider: 'supabase', what: 'Supabase project', cost: 'hourly',
    when: ['supabase', 'projects', 'create'], name: (t) => P(t, 3, ['--org-id', '--db-password', '--region', '--plan', '--size']),
    teardown: () => 'supabase projects list   # then: supabase projects delete <REF>' },
  { id: 'supabase-fn', provider: 'supabase', what: 'Edge Function deploy (may pre-exist)', cost: 'usage', deploy: true,
    when: ['supabase', 'functions', 'deploy'], name: (t) => P(t, 3, ['--project-ref', '--import-map']) || '(all functions)',
    teardown: (n, t) => n.startsWith('(') ? `supabase functions list${opt('--project-ref', flag(t, ['--project-ref']))}   # then, for one the agent made: supabase functions delete <NAME>` : `supabase functions list${opt('--project-ref', flag(t, ['--project-ref']))}   # if the agent made it: supabase functions delete ${n}`,
    undo: { when: ['supabase', 'functions', 'delete'], name: (t) => P(t, 3, ['--project-ref']) } },

  // ---------------- Fly.io ----------------
  { id: 'fly-app', provider: 'fly', what: 'Fly.io app', cost: 'hourly',
    when: ['fly', 'launch'], name: (t, ctx) => flag(t, ['--app', '-a', '--name']) || ctx.cwd || '(app in this folder)',
    teardown: (n, t) => flag(t, ['--app', '-a', '--name']) ? `fly apps destroy ${n}` : `fly apps list   # then: fly apps destroy <APP>  (from ${n})`,
    undo: { when: ['fly', ['apps', 'destroy']], any: true } },
  { id: 'fly-deploy', provider: 'fly', what: 'Fly.io deploy (app may pre-exist)', cost: 'hourly', deploy: true,
    when: ['fly', 'deploy'], name: (t, ctx) => flag(t, ['--app', '-a']) || ctx.cwd || '(app in this folder)',
    teardown: (n, t) => flag(t, ['--app', '-a']) ? `fly status -a ${n}   # if the agent made this app: fly apps destroy ${n}` : `cd "${n}" && fly status   # if the agent made this app: fly apps destroy <APP>`,
    undo: { when: ['fly', ['apps', 'destroy']], any: true } },
  { id: 'fly-pg', provider: 'fly', what: 'Fly Postgres', cost: 'hourly',
    when: ['fly', 'postgres', 'create'], name: (t) => flag(t, ['--name']),
    teardown: (n) => `fly apps destroy ${n}` },
  { id: 'fly-volume', provider: 'fly', what: 'Fly volume', cost: 'hourly',
    when: ['fly', ['volumes', 'volume', 'vol'], 'create'], name: (t) => P(t, 3, ['--app', '-a', '--region', '-r', '--size', '-s']),
    teardown: (n, t) => `fly volumes list${opt('-a', flag(t, ['--app', '-a']))}   # then: fly volumes destroy <VOL_ID>  (${n})` },
  { id: 'fly-machine', provider: 'fly', what: 'Fly machine', cost: 'hourly',
    when: ['fly', ['machine', 'machines', 'm'], 'run'], name: (t) => flag(t, ['--name']) || P(t, 3, ['--app', '-a', '--region', '-r', '--vm-size', '--name']),
    teardown: (n, t) => `fly machine list${opt('-a', flag(t, ['--app', '-a']))}   # then: fly machine destroy <ID>  (${n})` },

  // ---------------- Firebase ----------------
  { id: 'firebase-deploy', provider: 'firebase', what: 'Firebase deploy (may pre-exist)', cost: 'usage', deploy: true,
    when: ['firebase', 'deploy'], name: (t, ctx) => flag(t, ['--project', '-P']) || ctx.cwd || '(default project)',
    teardown: () => 'firebase functions:list   # for a function the agent added: firebase functions:delete <NAME>; hosting rollback: Firebase console' },

  // ---------------- GPU / serverless compute ----------------
  { id: 'modal-deploy', provider: 'modal', what: 'Modal app', cost: 'usage', deploy: true,
    when: ['modal', 'deploy'], name: (t) => flag(t, ['--name']) || P(t, 2, ['--env', '-e', '--tag']),
    teardown: () => 'modal app list   # then: modal app stop <APP>' },
  { id: 'runpod-pod', provider: 'runpod', what: 'RunPod GPU pod', cost: 'hourly',
    when: ['runpodctl', 'create', ['pod', 'pods']], name: (t) => flag(t, ['--name']) || '(pod)',
    teardown: () => 'runpodctl get pod   # then: runpodctl remove pod <POD_ID>',
    undo: { when: ['runpodctl', 'remove', ['pod', 'pods']], any: true } },

  // ---------------- Local: containers and tunnels that keep running ----------------
  { id: 'docker-run', provider: 'docker', what: 'Docker container (detached)', cost: 'local',
    when: ['docker', ['run', 'container']], name: (t) => dockerRun(t),
    teardown: (n) => `docker ps -a --filter name=${n}   # then: docker stop ${n} && docker rm ${n}`,
    undo: { when: ['docker', ['rm', 'stop', 'kill', 'container']], multi: (t) => (['rm', 'stop', 'kill'].includes(t[1]) ? t.slice(2) : ['rm', 'stop', 'kill'].includes(t[2]) ? t.slice(3) : []).filter((x) => !x.startsWith('-')) } },
  { id: 'docker-compose', provider: 'docker', what: 'Docker Compose stack (detached)', cost: 'local',
    when: [['docker', 'docker-compose'], ['compose', 'up']], name: (t, ctx) => composeUp(t, ctx),
    teardown: (n) => `cd "${n}" && docker compose ps   # then: docker compose down`,
    undo: { when: [['docker', 'docker-compose'], ['compose', 'down']], name: (t, ctx) => composeDown(t, ctx) } },
  { id: 'tunnel-ngrok', provider: 'ngrok', what: 'Public tunnel (ngrok)', cost: 'local',
    when: ['ngrok', ['http', 'tcp', 'tls', 'start']], name: (t) => P(t, 2, ['--domain', '--url', '--region', '--authtoken', '--config']) || '(tunnel)',
    teardown: () => 'pgrep -af ngrok   # then: kill <PID>. Anyone with the URL can reach your machine while it runs' },
  { id: 'tunnel-cloudflared', provider: 'cloudflared', what: 'Public tunnel (cloudflared)', cost: 'local',
    when: ['cloudflared', 'tunnel'], name: (t) => flag(t, ['--url']) || P(t, 3, ['--url', '--config', '--name']) || '(tunnel)',
    teardown: () => 'pgrep -af cloudflared   # then: kill <PID>; named tunnels: cloudflared tunnel list' },
];

function tfDir(t, ctx) {
  const d = flag(t, ['-chdir']);
  const base = ctx.cwd || '';
  if (!d) return base || '(this folder)';
  if (/^([A-Za-z]:)?[\\/]/.test(d)) return d;
  return base ? require('path').join(base, d) : d;
}
function ws(t) { const w = t.env && t.env.TF_WORKSPACE; return w ? `   (workspace ${w})` : ''; }
function cdkStack(t) { const p = P(t, 2, ['--profile', '-c', '--context', '--app', '-a', '--require-approval', '--parameters', '--outputs-file', '--role-arn', '-r']); return p && !p.includes('/') ? p : null; }
function dockerRun(t) {
  const i = t[1] === 'container' ? 3 : 2;
  if (t[1] === 'container' && t[2] !== 'run') return undefined;
  if (!hasFlag(t, ['-d', '--detach']) && !t.slice(i).some((x) => /^-[a-zA-Z]*d[a-zA-Z]*$/.test(x) && !x.startsWith('--'))) return undefined;
  return flag(t, ['--name']) || null;
}
function composeUp(t, ctx) {
  if (!t.includes('up')) return undefined;
  if (!hasFlag(t, ['-d', '--detach'])) return undefined;
  const f = flag(t, ['-f', '--file']);
  const base = ctx.cwd || '(this folder)';
  return f && f.includes('/') ? require('path').dirname(require('path').isAbsolute(f) ? f : require('path').join(base, f)) : base;
}
function composeDown(t, ctx) {
  if (!t.includes('down')) return undefined;
  const f = flag(t, ['-f', '--file']);
  const base = ctx.cwd || '(this folder)';
  return f && f.includes('/') ? require('path').dirname(require('path').isAbsolute(f) ? f : require('path').join(base, f)) : base;
}

function tagName(t) {
  const spec = flag(t, ['--tag-specifications']);
  if (!spec) return null;
  const m = spec.match(/Key=Name,Value=([^},\]]+)/);
  return m ? m[1] : null;
}

// Does the token list start with the pattern? Pattern items may be arrays (any of),
// and null inside an array means "nothing / end of command".
function matchPrefix(toks, pattern) {
  let t = toks;
  // gcloud beta / alpha
  if (t[0] === 'gcloud' && (t[1] === 'beta' || t[1] === 'alpha')) t = [t[0], ...t.slice(2)];
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    const v = t[i];
    if (Array.isArray(p)) {
      if (!p.some((x) => (x === null ? v === undefined || (v && v.startsWith('-') && !p.includes(v)) : x === v))) return null;
    } else if (p !== v) return null;
  }
  return t;
}

module.exports = { rules, matchPrefix, gnames };
