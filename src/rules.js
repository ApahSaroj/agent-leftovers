'use strict';
const { flag, hasFlag, positional, positionals, sq, qflag, procFind } = require('./shell');

// Each rule: a create command an agent might run, how to name what it made,
// the teardown command, and (optionally) the matching delete so we can tell
// when the agent already cleaned up.
//
// cost: 'hourly'  = bills while it exists (VMs, databases, clusters, GPUs)
//       'usage'   = bills mostly by use/storage (buckets, functions, deploys)
//       'enabler' = turns on a paid API or service
//
// Teardown safety (v0.4.2): scan.js hands teardown() a name that is either plain
// ([A-Za-z0-9._:/@=+-]) or the placeholder <NAME>, and tokens whose odd values are already
// single-quoted. Rules marked pathName get the raw folder path instead and must quote every
// use of it with sq().

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
// Both bucket rules of a provider share their deletes (gsutil mb + gcloud storage buckets delete, s3 mb + s3api delete-bucket).
const gsUrls = (t) => t.filter((x) => x.startsWith('gs://')).map((x) => x.replace(/\/$/, ''));
const GCS_UNDO = [
  // Only "storage rm" and "storage buckets delete": describe/update/list are reads, never a delete.
  { when: ['gcloud', 'storage', ['rm', 'buckets']], skipIf: (t) => t[2] === 'buckets' && t[3] !== 'delete', multi: gsUrls },
  { when: ['gsutil', ['rb', 'rm']], multi: gsUrls },
];
const S3_UNDO = [
  { when: ['aws', 's3', 'rb'], multi: (t) => t.filter((x) => x.startsWith('s3://')).map((x) => x.replace(/\/$/, '')) },
  { when: ['aws', 's3api', 'delete-bucket'], name: (t) => flag(t, ['--bucket']) && `s3://${flag(t, ['--bucket'])}` },
];

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
    teardown: (n, t) => `gcloud container clusters delete ${n}${opt('--zone', gz(t))}${opt('--region', flag(t, ['--region']))}${opt('--location', flag(t, ['--location']))}`,
    undo: { when: ['gcloud', 'container', 'clusters', 'delete'], multi: (t) => gnames(t, 4) } },
  { id: 'gcp-gke-pool', provider: 'gcloud', what: 'GKE node pool', cost: 'hourly',
    when: ['gcloud', 'container', 'node-pools', 'create'], name: (t) => gname(t, 4),
    teardown: (n, t) => `gcloud container node-pools delete ${n} --cluster ${flag(t, ['--cluster']) || '<CLUSTER>'}${opt('--zone', gz(t))}${opt('--region', flag(t, ['--region']))}${opt('--location', flag(t, ['--location']))}`,
    undo: { when: ['gcloud', 'container', ['node-pools', 'clusters'], 'delete'], any: true,
      pick: (f, t) => (t[2] === 'clusters' ? poolPick(f, t, null, gnames(t, 4)) : poolPick(f, t, gnames(t, 4), null)) } },
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
    // Only "storage rm" and "storage buckets delete": describe/update/list are reads, never a delete.
    undo: GCS_UNDO },
  { id: 'gcp-gsutil-mb', provider: 'gcloud', what: 'Cloud Storage bucket', cost: 'usage',
    when: ['gsutil', 'mb'], name: (t) => urlArg(t, 'gs://'),
    teardown: (n) => `gcloud storage buckets delete ${n}   # fails if not empty; 'storage rm -r' also deletes the contents`,
    undo: GCS_UNDO },
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
    undo: { when: ['aws', 'ec2', 'terminate-instances'], any: true, pick: (f, t) => {
      if (!f.instanceIds || !f.instanceIds.length) return 'maybe';
      const ids = listIds(t, '--instance-ids');
      if (ids.some((x) => /[$`<>{}]/.test(x))) return 'maybe';
      return f.instanceIds.some((id) => ids.includes(id)) ? 'yes' : null;
    } } },
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
    teardown: (n, t) => (flag(t, ['--db-cluster-identifier'])
      ? `aws rds delete-db-instance --db-instance-identifier ${n}   # an Aurora cluster member: snapshots are taken at the cluster level; delete the cluster after its instances: aws rds delete-db-cluster --db-cluster-identifier ${flag(t, ['--db-cluster-identifier'])} --final-db-snapshot-identifier <SNAPSHOT>`
      : `aws rds delete-db-instance --db-instance-identifier ${n} --final-db-snapshot-identifier ${n}-final   # keeps a final snapshot`),
    undo: { when: ['aws', 'rds', 'delete-db-instance'], name: (t) => flag(t, ['--db-instance-identifier']) } },
  { id: 'aws-rds-cluster', provider: 'aws', what: 'RDS / Aurora cluster', cost: 'hourly',
    when: ['aws', 'rds', 'create-db-cluster'], name: (t) => flag(t, ['--db-cluster-identifier']),
    teardown: (n) => `aws rds delete-db-cluster --db-cluster-identifier ${n} --final-db-snapshot-identifier ${n}-final   # delete its instances first`,
    undo: { when: ['aws', 'rds', 'delete-db-cluster'], name: (t) => flag(t, ['--db-cluster-identifier']) } },
  { id: 'aws-s3', provider: 'aws', what: 'S3 bucket', cost: 'usage',
    when: ['aws', 's3', 'mb'], name: (t) => urlArg(t, 's3://'),
    teardown: (n) => `aws s3 rb ${n}   # fails if not empty; add --force to also delete its contents`,
    undo: S3_UNDO },
  { id: 'aws-s3api', provider: 'aws', what: 'S3 bucket', cost: 'usage',
    when: ['aws', 's3api', 'create-bucket'], name: (t) => flag(t, ['--bucket']) && `s3://${flag(t, ['--bucket'])}`,
    teardown: (n) => `aws s3 rb ${n}   # fails if not empty; add --force to also delete its contents`,
    undo: S3_UNDO },
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
  { id: 'aws-eksctl-ng', provider: 'aws', what: 'EKS node group (eksctl)', cost: 'hourly',
    when: ['eksctl', 'create', ['nodegroup', 'ng']], name: (t) => flag(t, ['--name', '-n']) || P(t, 3, ['--cluster', '--region', '--nodes', '--node-type', '-f', '--profile', '--nodes-min', '--nodes-max']),
    teardown: (n, t) => `eksctl delete nodegroup --cluster ${flag(t, ['--cluster']) || '<CLUSTER>'} --name ${n}${opt('--region', flag(t, ['--region']))}`,
    undo: { when: ['eksctl', 'delete', ['nodegroup', 'ng', 'cluster']], any: true,
      pick: (f, t) => (t[2] === 'cluster'
        ? poolPick(f, t, null, [flag(t, ['--name', '-n']) || P(t, 3, ['--region', '--profile'])])
        : poolPick(f, t, [flag(t, ['--name', '-n']) || P(t, 3, ['--cluster', '--region', '--profile'])], null)) } },
  { id: 'aws-cfn', provider: 'aws', what: 'CloudFormation stack (may pre-exist)', cost: 'hourly', deploy: true,
    when: ['aws', 'cloudformation', ['deploy', 'create-stack']], name: (t) => flag(t, ['--stack-name']),
    teardown: (n) => `aws cloudformation describe-stacks --stack-name ${n}   # if the agent made this stack: aws cloudformation delete-stack --stack-name ${n}  (deletes everything in it)`,
    undo: { when: ['aws', 'cloudformation', 'delete-stack'], name: (t) => flag(t, ['--stack-name']) } },
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
    pathName: true,
    // -chdir instead of 'cd DIR &&' (Windows PowerShell 5.1 has no &&).
    teardown: (n, t) => { const c = /^\(/.test(n) ? t[0] : `${t[0]} ${qflag('-chdir=', n)}`; return `${ws(t)}${c} state list   # review what the agent added, then: ${ws(t)}${c} destroy -target=<ADDRESS>. A plain destroy removes the WHOLE stack, including what existed before`; },
    undo: { when: [['terraform', 'tofu'], 'destroy'], name: (t, ctx) => tfDir(t, ctx), skipIf: (t) => hasFlag(t, ['-target']) } },
  { id: 'iac-cdk', provider: 'aws', what: 'CDK deploy (stack may pre-exist)', cost: 'hourly', deploy: true,
    when: ['cdk', 'deploy'], name: (t, ctx) => cdkStack(t) || ctx.cwd || '(all stacks)',
    pathName: true,
    teardown: (n, t) => cdkStack(t) ? `aws cloudformation describe-stacks --stack-name ${sq(n)}   # if the agent made this stack: cdk destroy ${sq(n)}` : `cd ${sq(n)} && cdk list   # if the agent made a stack: cdk destroy <STACK>`,
    undo: { when: ['cdk', 'destroy'], name: (t, ctx) => cdkStack(t) || ctx.cwd || '(all stacks)' } },
  { id: 'iac-sam', provider: 'aws', what: 'SAM deploy (stack may pre-exist)', cost: 'usage', deploy: true,
    when: ['sam', 'deploy'], name: (t, ctx) => flag(t, ['--stack-name']) || ctx.cwd || '(stack)',
    pathName: true,
    teardown: (n, t) => flag(t, ['--stack-name']) ? `aws cloudformation describe-stacks --stack-name ${sq(n)}   # if the agent made this stack: sam delete --stack-name ${sq(n)}` : `cd ${sq(n)} && sam list stack-outputs   # if the agent made the stack: sam delete`,
    undo: { when: ['sam', 'delete'], name: (t, ctx) => flag(t, ['--stack-name']) || ctx.cwd || '(stack)' } },
  { id: 'iac-pulumi', provider: 'pulumi', what: 'Pulumi up (stack may pre-exist)', cost: 'hourly', deploy: true,
    when: ['pulumi', 'up'], name: (t, ctx) => flag(t, ['--stack', '-s']) || pulumiDir(t, ctx) || '(stack)',
    pathName: true,
    teardown: (n, t, ctx) => flag(t, ['--stack', '-s'])
      ? `pulumi stack --stack ${sq(n)}${pulumiC(t, ctx)}   # review; a destroy removes the WHOLE stack: pulumi destroy --stack ${sq(n)}${pulumiC(t, ctx)}, or one resource: pulumi destroy --target <URN>`
      : `pulumi stack${/^\(/.test(n) ? '' : ` --cwd ${sq(n)}`}   # review; a destroy removes the WHOLE stack: pulumi destroy${/^\(/.test(n) ? '' : ` --cwd ${sq(n)}`}, or one resource: pulumi destroy --target <URN>`,
    undo: { when: ['pulumi', 'destroy'], name: (t, ctx) => flag(t, ['--stack', '-s']) || pulumiDir(t, ctx) || '(stack)', skipIf: (t) => hasFlag(t, ['--target']) } },
  { id: 'iac-serverless', provider: 'serverless', what: 'Serverless deploy (may pre-exist)', cost: 'usage', deploy: true,
    when: ['serverless', 'deploy'], name: (t, ctx) => ctx.cwd || '(service)',
    pathName: true,
    // Same stage, region and profile as the deploy: a bare remove targets the default stage (dev).
    teardown: (n, t) => `cd ${sq(n)} && serverless info${slsOpts(t)}   # if the agent made this service: serverless remove${slsOpts(t)}`,
    undo: { when: ['serverless', 'remove'], name: (t, ctx) => ctx.cwd || '(service)' } },

  { id: 'iac-sst', provider: 'sst', what: 'SST deploy (stage may pre-exist)', cost: 'hourly', deploy: true, pathName: true,
    // No --stage means the personal stage; sst remove without --stage removes that one.
    when: ['sst', 'deploy'], name: (t, ctx) => ctx.cwd || '(app in this folder)',
    teardown: (n, t) => `cd ${sq(n)}   # check the stage in the SST Console first; if the agent made it just for this: sst remove${opt('--stage', flag(t, ['--stage']))}${flag(t, ['--stage']) ? '' : '  (no --stage: your personal stage)'}. Never remove a shared or production stage`,
    undo: { when: ['sst', 'remove'], name: (t, ctx) => ctx.cwd || '(app in this folder)' } },

  // ---------------- Azure ----------------
  // az group create succeeds on a group that already exists, so look before deleting.
  { id: 'az-group', provider: 'az', what: 'Resource group (may pre-exist)', cost: 'hourly',
    when: ['az', 'group', 'create'], name: (t) => flag(t, ['--name', '-n', '--resource-group', '-g']),
    teardown: (n) => `az resource list -g ${n} -o table   # if the agent made this group just for this: az group delete --name ${n}  (deletes EVERYTHING inside it)`,
    undo: { when: ['az', 'group', 'delete'], name: (t) => flag(t, ['--name', '-n', '--resource-group', '-g']) } },
  { id: 'az-vm', provider: 'az', what: 'Azure VM', cost: 'hourly',
    when: ['az', 'vm', 'create'], name: (t) => flag(t, ['--name', '-n']),
    teardown: (n, t) => `az vm delete -g ${flag(t, ['--resource-group', '-g']) || '<GROUP>'} -n ${n}   # its disk, IP and NIC may need deleting too`,
    undo: { when: ['az', 'vm', 'delete'], name: (t) => flag(t, ['--name', '-n']) || ((flag(t, ['--ids']) || '').match(/virtualMachines\/([^/\s]+)/i) || [])[1] } },
  { id: 'az-aks', provider: 'az', what: 'AKS cluster', cost: 'hourly',
    when: ['az', 'aks', 'create'], name: (t) => flag(t, ['--name', '-n']),
    teardown: (n, t) => `az aks delete -g ${flag(t, ['--resource-group', '-g']) || '<GROUP>'} -n ${n}`,
    undo: { when: ['az', 'aks', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },
  { id: 'az-aks-nodepool', provider: 'az', what: 'AKS node pool', cost: 'hourly',
    when: ['az', 'aks', 'nodepool', 'add'], name: (t) => flag(t, ['--name', '-n', '--nodepool-name']),
    teardown: (n, t) => `az aks nodepool delete -g ${azg(t)} --cluster-name ${flag(t, ['--cluster-name']) || '<CLUSTER>'} -n ${n}`,
    // A node pool goes with its cluster: az aks delete -n CLUSTER clears it too.
    undo: { when: ['az', 'aks', ['nodepool', 'delete']], any: true, pick: (f, t) => {
      if (t[2] === 'delete') { const c = flag(t, ['--name', '-n']); return c && f.scope && f.scope.cluster && c.toLowerCase() === f.scope.cluster ? 'yes' : null; }
      if (t[3] !== 'delete') return null;
      const n = flag(t, ['--name', '-n', '--nodepool-name']);
      return n && n.toLowerCase() === String(f.name).toLowerCase() ? 'yes' : null;
    } } },
  { id: 'az-webapp', provider: 'az', what: 'App Service web app', cost: 'hourly', deploy: true,
    when: ['az', 'webapp', ['up', 'create']], name: (t) => flag(t, ['--name', '-n']) || '(web app)',
    teardown: (n, t) => (n === '<NAME>'
      ? `az webapp list${flag(t, ['--resource-group', '-g']) ? ` -g ${azg(t)}` : ''} -o table   # find the app the agent made, then: az webapp delete -g <GROUP> -n <APP_NAME>, and check: az appservice plan list`
      : `az webapp show -g ${azg(t)} -n ${n}   # if the agent made it: az webapp delete -g ${azg(t)} -n ${n}, and check: az appservice plan list`),
    undo: { when: ['az', 'webapp', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },
  { id: 'az-containerapp', provider: 'az', what: 'Container App', cost: 'usage', deploy: true,
    when: ['az', 'containerapp', ['up', 'create']], name: (t) => flag(t, ['--name', '-n']),
    teardown: (n, t) => `az containerapp show -g ${azg(t)} -n ${n}   # if the agent made it: az containerapp delete -g ${azg(t)} -n ${n}`,
    undo: { when: ['az', 'containerapp', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },
  { id: 'az-pg', provider: 'az', what: 'Azure Postgres server', cost: 'hourly',
    when: ['az', ['postgres', 'mysql'], 'flexible-server', 'create'], name: (t) => flag(t, ['--name', '-n']),
    teardown: (n, t) => `az ${t[1]} flexible-server delete -g ${flag(t, ['--resource-group', '-g']) || '<GROUP>'} -n ${n}`,
    undo: { when: ['az', ['postgres', 'mysql'], 'flexible-server', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },

  // ---------------- Cloudflare ----------------
  { id: 'cf-worker', provider: 'wrangler', what: 'Cloudflare Worker deploy (may pre-exist)', cost: 'usage', deploy: true,
    when: ['wrangler', ['deploy', 'publish']], name: (t, ctx) => flag(t, ['--name']) || ctx.cwd || '(worker in this folder)',
    pathName: true,
    teardown: (n, t) => flag(t, ['--name']) ? `wrangler deployments list --name ${sq(n)}   # roll back: wrangler rollback; if the agent made this worker: wrangler delete --name ${sq(n)}` : `cd ${sq(n)} && wrangler deployments list   # roll back: wrangler rollback; if the agent made this worker: wrangler delete`,
    undo: { when: ['wrangler', 'delete'], name: (t, ctx) => flag(t, ['--name']) || ctx.cwd || '(worker in this folder)' } },
  { id: 'cf-d1', provider: 'wrangler', what: 'D1 database', cost: 'usage',
    when: ['wrangler', 'd1', 'create'], name: (t) => P(t, 3, ['--location']),
    teardown: (n) => `wrangler d1 delete ${n}`,
    undo: { when: ['wrangler', 'd1', 'delete'], name: (t) => P(t, 3, []) } },
  { id: 'cf-r2', provider: 'wrangler', what: 'R2 bucket', cost: 'usage',
    when: ['wrangler', 'r2', 'bucket', 'create'], name: (t) => P(t, 4, ['--location', '--storage-class', '--jurisdiction', '-J']),
    teardown: (n, t) => `wrangler r2 bucket delete ${n}${opt('--jurisdiction', flag(t, ['--jurisdiction', '-J']))}`,
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
    pathName: true,
    teardown: (n) => `vercel ls   # remove a test deployment: vercel remove <DEPLOYMENT_URL> --safe. Only if the agent made the project: vercel project rm <PROJECT>  (from ${sq(n)})`,
    undo: { when: ['vercel', ['remove', 'rm']], any: true } },
  { id: 'netlify-site', provider: 'netlify', what: 'Netlify site', cost: 'usage',
    when: ['netlify', 'sites:create'], name: (t, ctx) => flag(t, ['--name', '-n']) || ctx.cwd || '(site)', pathName: true,
    teardown: () => 'netlify sites:list   # then: netlify sites:delete <SITE_ID>',
    undo: { when: ['netlify', 'sites:delete'], any: true } },
  { id: 'netlify-deploy', provider: 'netlify', what: 'Netlify deploy (site may pre-exist)', cost: 'usage', deploy: true,
    when: ['netlify', 'deploy'], name: (t, ctx) => flag(t, ['--site', '--name']) || ctx.cwd || '(site)',
    pathName: true,
    teardown: (n) => `netlify status   # roll back in the Netlify UI if needed. Only if the agent made the site: netlify sites:delete <SITE_ID>  (from ${sq(n)})`,
    undo: { when: ['netlify', 'sites:delete'], any: true } },
  { id: 'railway-up', provider: 'railway', what: 'Railway deploy (service may pre-exist)', cost: 'hourly', deploy: true,
    when: ['railway', 'up'], name: (t, ctx) => ctx.cwd || '(linked project)',
    pathName: true,
    // railway down only removes the latest deployment; the service, its volumes and databases stay.
    teardown: (n) => `cd ${sq(n)} && railway status   # if the agent made the whole project: railway delete; a single service, database or volume: delete it in the Railway dashboard. 'railway down' only removes the latest deployment`,
    undo: { when: ['railway', 'down'], name: (t, ctx) => ctx.cwd || '(linked project)' } },
  { id: 'heroku-create', provider: 'heroku', what: 'Heroku app', cost: 'hourly',
    when: ['heroku', ['create', 'apps:create']], name: (t) => P(t, 2, ['--region', '--team', '-t', '--stack', '-s', '--buildpack', '-b', '--remote', '-r', '--addons']) || '(new app)',
    teardown: (n) => (n === '<NAME>' ? 'heroku apps   # find the app the agent made, then: heroku apps:destroy <APP_NAME>' : `heroku apps:destroy ${n}`),
    undo: { when: ['heroku', ['apps:destroy', 'destroy']], name: (t) => flag(t, ['--app', '-a']) || P(t, 2, ['--confirm']) } },
  { id: 'heroku-addon', provider: 'heroku', what: 'Heroku add-on', cost: 'hourly',
    when: ['heroku', 'addons:create'], name: (t) => flag(t, ['--name']) || P(t, 2, ['--app', '-a', '--name', '--as', '--plan', '--confirm', '--wait']),
    // addons:destroy wants the add-on name, not the service:plan the create was given.
    teardown: (n, t) => (flag(t, ['--name'])
      ? `heroku addons:destroy ${n}${opt('--app', flag(t, ['--app', '-a']))}`
      : `heroku addons${opt('--app', flag(t, ['--app', '-a']))}   # then: heroku addons:destroy <ADDON_NAME>${opt('--app', flag(t, ['--app', '-a']))}  (the ${n} add-on)`),
    undo: { when: ['heroku', 'addons:destroy'], name: (t) => P(t, 2, ['--app', '-a']) } },

  // ---------------- Supabase ----------------
  { id: 'supabase-project', provider: 'supabase', what: 'Supabase project', cost: 'hourly',
    when: ['supabase', 'projects', 'create'], name: (t) => P(t, 3, ['--org-id', '--db-password', '--region', '--plan', '--size']),
    teardown: () => 'supabase projects list   # then: supabase projects delete <REF>' },
  { id: 'supabase-fn', provider: 'supabase', what: 'Edge Function deploy (may pre-exist)', cost: 'usage', deploy: true,
    when: ['supabase', 'functions', 'deploy'], name: (t) => P(t, 3, ['--project-ref', '--import-map']) || '(all functions)',
    teardown: (n, t) => (n.startsWith('(') || n === '<NAME>') ? `supabase functions list${opt('--project-ref', flag(t, ['--project-ref']))}   # then, for one the agent made: supabase functions delete <NAME>${opt('--project-ref', flag(t, ['--project-ref']))}` : `supabase functions list${opt('--project-ref', flag(t, ['--project-ref']))}   # if the agent made it: supabase functions delete ${n}${opt('--project-ref', flag(t, ['--project-ref']))}`,
    undo: { when: ['supabase', 'functions', 'delete'], name: (t) => P(t, 3, ['--project-ref']) } },

  // ---------------- Fly.io ----------------
  { id: 'fly-app', provider: 'fly', what: 'Fly.io app', cost: 'hourly',
    when: ['fly', 'launch'], name: (t, ctx) => flag(t, ['--app', '-a', '--name']) || ctx.cwd || '(app in this folder)', pathName: true,
    teardown: (n, t) => flag(t, ['--app', '-a', '--name']) ? `fly apps destroy ${sq(n)}` : `fly apps list   # then: fly apps destroy <APP>  (from ${sq(n)})`,
    undo: { when: ['fly', ['apps', 'destroy']], any: true, pick: flyPick } },
  { id: 'fly-deploy', provider: 'fly', what: 'Fly.io deploy (app may pre-exist)', cost: 'hourly', deploy: true,
    when: ['fly', 'deploy'], name: (t, ctx) => flag(t, ['--app', '-a']) || ctx.cwd || '(app in this folder)',
    pathName: true,
    teardown: (n, t) => flag(t, ['--app', '-a']) ? `fly status -a ${sq(n)}   # if the agent made this app: fly apps destroy ${sq(n)}` : `cd ${sq(n)} && fly status   # if the agent made this app: fly apps destroy <APP>`,
    undo: { when: ['fly', ['apps', 'destroy']], any: true, pick: flyPick } },
  { id: 'fly-pg', provider: 'fly', what: 'Fly Postgres', cost: 'hourly',
    when: ['fly', 'postgres', 'create'], name: (t) => flag(t, ['--name']),
    teardown: (n) => `fly apps destroy ${n}` },
  { id: 'fly-volume', provider: 'fly', what: 'Fly volume', cost: 'hourly',
    when: ['fly', ['volumes', 'volume', 'vol'], 'create'], name: (t) => P(t, 3, ['--app', '-a', '--region', '-r', '--size', '-s']),
    teardown: (n, t) => `fly volumes list${opt('-a', flag(t, ['--app', '-a']))}   # then: fly volumes destroy <VOL_ID>  (${n})` },
  { id: 'fly-machine', provider: 'fly', what: 'Fly machine', cost: 'hourly',
    when: ['fly', ['machine', 'machines', 'm'], 'run'], name: (t) => flag(t, ['--name']) || P(t, 3, ['--app', '-a', '--region', '-r', '--vm-size', '--name']),
    // A running machine needs --force (or a stop first) to be destroyed.
    teardown: (n, t) => `fly machine list${opt('-a', flag(t, ['--app', '-a']))}   # then: fly machine destroy <ID> --force${opt('-a', flag(t, ['--app', '-a']))}  (${n})` },

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

  // ---------------- v0.4.2 round 2: costly services agents create (each checked against the CLI reference) ----------------
  // Google Cloud
  { id: 'gcp-tpu', provider: 'gcloud', what: 'Cloud TPU VM', cost: 'hourly', accel: true,
    when: ['gcloud', 'compute', 'tpus', 'tpu-vm', 'create'], multi: (t) => gnames(t, 5),
    teardown: (n, t) => `gcloud compute tpus tpu-vm delete ${n}${opt('--zone', gz(t))}`,
    undo: { when: ['gcloud', 'compute', 'tpus', 'tpu-vm', 'delete'], multi: (t) => gnames(t, 5) } },
  { id: 'gcp-workbench', provider: 'gcloud', what: 'Vertex AI Workbench instance', cost: 'hourly',
    when: ['gcloud', ['workbench', 'notebooks'], 'instances', 'create'], name: (t) => gname(t, 4),
    teardown: (n, t) => `gcloud ${t[1]} instances delete ${n}${opt('--location', flag(t, ['--location']))}   # stopping it (gcloud ${t[1]} instances stop) ends the VM charge but keeps the disk billing`,
    undo: { when: ['gcloud', ['workbench', 'notebooks'], 'instances', 'delete'], multi: (t) => gnames(t, 4) } },

  // AWS
  { id: 'aws-sagemaker-notebook', provider: 'aws', what: 'SageMaker notebook instance', cost: 'hourly',
    when: ['aws', 'sagemaker', 'create-notebook-instance'], name: (t) => flag(t, ['--notebook-instance-name']),
    // DeleteNotebookInstance needs the instance stopped first.
    teardown: (n) => `aws sagemaker stop-notebook-instance --notebook-instance-name ${n}   # once it shows Stopped: aws sagemaker delete-notebook-instance --notebook-instance-name ${n}  (deletes its storage volume)`,
    undo: [
      { when: ['aws', 'sagemaker', 'delete-notebook-instance'], name: (t) => flag(t, ['--notebook-instance-name']) },
      // Stopped: no instance charge, the ML storage volume still bills.
      { when: ['aws', 'sagemaker', 'stop-notebook-instance'], any: true, pick: (f, t) => (flag(t, ['--notebook-instance-name']) === f.name ? 'maybe' : null) },
    ] },
  { id: 'aws-bedrock-pt', provider: 'aws', what: 'Bedrock provisioned throughput', cost: 'hourly', accel: true,
    when: ['aws', 'bedrock', 'create-provisioned-model-throughput'], name: (t) => flag(t, ['--provisioned-model-name']),
    teardown: (n, t) => `aws bedrock delete-provisioned-model-throughput --provisioned-model-id ${n}   # ${flag(t, ['--commitment-duration']) ? `bought with a ${flag(t, ['--commitment-duration'])} commitment: that term is billed to its end even after deleting` : 'no commitment term: billing stops when it is deleted'}`,
    undo: { when: ['aws', 'bedrock', 'delete-provisioned-model-throughput'], any: true, pick: (f, t) => {
      const id = flag(t, ['--provisioned-model-id']);
      if (!id) return null;
      return id === f.name ? 'yes' : /^arn:/.test(id) ? 'maybe' : null;
    } } },
  { id: 'aws-elbv2', provider: 'aws', what: 'Load balancer (ALB/NLB)', cost: 'hourly',
    when: ['aws', 'elbv2', 'create-load-balancer'], name: (t) => flag(t, ['--name']),
    teardown: (n) => `aws elbv2 describe-load-balancers --names ${n} --query LoadBalancers[].LoadBalancerArn   # then: aws elbv2 delete-load-balancer --load-balancer-arn <ARN>`,
    // The delete takes an ARN: arn:aws:elasticloadbalancing:REGION:ACCT:loadbalancer/app|net|gwy/NAME/ID
    undo: { when: ['aws', 'elbv2', 'delete-load-balancer'], any: true, pick: (f, t) => {
      const arn = flag(t, ['--load-balancer-arn']) || '';
      const m = arn.match(/:loadbalancer\/(?:app|net|gwy)\/([^/]+)\//);
      return m ? (m[1] === f.name ? 'yes' : null) : 'maybe';
    } } },
  { id: 'aws-vpce', provider: 'aws', what: 'Interface VPC endpoint', cost: 'hourly',
    // Gateway endpoints (the default type) are free; only Interface / GatewayLoadBalancer bill by the hour.
    when: ['aws', 'ec2', 'create-vpc-endpoint'], name: (t) => (/^(interface|gatewayloadbalancer)$/i.test(flag(t, ['--vpc-endpoint-type']) || '') ? flag(t, ['--service-name']) || '(endpoint)' : undefined),
    teardown: (n) => `aws ec2 describe-vpc-endpoints --filters Name=service-name,Values=${n}   # then: aws ec2 delete-vpc-endpoints --vpc-endpoint-ids <ID>`,
    undo: { when: ['aws', 'ec2', 'delete-vpc-endpoints'], any: true } },
  { id: 'aws-elasticache-rg', provider: 'aws', what: 'ElastiCache replication group', cost: 'hourly',
    when: ['aws', 'elasticache', 'create-replication-group'], name: (t) => flag(t, ['--replication-group-id']),
    teardown: (n) => `aws elasticache delete-replication-group --replication-group-id ${n}   # add --final-snapshot-identifier ${n}-final to keep a backup`,
    undo: { when: ['aws', 'elasticache', 'delete-replication-group'], name: (t) => flag(t, ['--replication-group-id']) } },
  { id: 'aws-elasticache-serverless', provider: 'aws', what: 'ElastiCache serverless cache', cost: 'hourly',
    when: ['aws', 'elasticache', 'create-serverless-cache'], name: (t) => flag(t, ['--serverless-cache-name']),
    teardown: (n) => `aws elasticache delete-serverless-cache --serverless-cache-name ${n}`,
    undo: { when: ['aws', 'elasticache', 'delete-serverless-cache'], name: (t) => flag(t, ['--serverless-cache-name']) } },
  { id: 'aws-opensearch', provider: 'aws', what: 'OpenSearch domain', cost: 'hourly',
    when: ['aws', ['opensearch', 'es'], ['create-domain', 'create-elasticsearch-domain']], name: (t) => flag(t, ['--domain-name']),
    teardown: (n, t) => (t[1] === 'es' ? `aws es delete-elasticsearch-domain --domain-name ${n}` : `aws opensearch delete-domain --domain-name ${n}`),
    undo: { when: ['aws', ['opensearch', 'es'], ['delete-domain', 'delete-elasticsearch-domain']], name: (t) => flag(t, ['--domain-name']) } },
  { id: 'aws-opensearch-serverless', provider: 'aws', what: 'OpenSearch Serverless collection', cost: 'hourly',
    when: ['aws', 'opensearchserverless', 'create-collection'], name: (t) => flag(t, ['--name']),
    teardown: (n) => `aws opensearchserverless batch-get-collection --names ${n}   # then: aws opensearchserverless delete-collection --id <ID>`,
    undo: { when: ['aws', 'opensearchserverless', 'delete-collection'], any: true } },
  { id: 'aws-redshift', provider: 'aws', what: 'Redshift cluster', cost: 'hourly',
    when: ['aws', 'redshift', 'create-cluster'], name: (t) => flag(t, ['--cluster-identifier']),
    teardown: (n) => `aws redshift delete-cluster --cluster-identifier ${n} --final-cluster-snapshot-identifier ${n}-final   # keeps a final snapshot; --skip-final-cluster-snapshot instead to keep nothing`,
    undo: { when: ['aws', 'redshift', 'delete-cluster'], name: (t) => flag(t, ['--cluster-identifier']) } },
  { id: 'aws-redshift-serverless', provider: 'aws', what: 'Redshift Serverless workgroup', cost: 'usage',
    when: ['aws', 'redshift-serverless', 'create-workgroup'], name: (t) => flag(t, ['--workgroup-name']),
    teardown: (n, t) => `aws redshift-serverless delete-workgroup --workgroup-name ${n}   # then, if the agent made its namespace: aws redshift-serverless delete-namespace --namespace-name ${flag(t, ['--namespace-name']) || '<NAMESPACE>'}`,
    undo: { when: ['aws', 'redshift-serverless', 'delete-workgroup'], name: (t) => flag(t, ['--workgroup-name']) } },
  { id: 'aws-lightsail', provider: 'aws', what: 'Lightsail instance', cost: 'hourly',
    when: ['aws', 'lightsail', 'create-instances'], multi: (t) => { const l = listIds(t, '--instance-names'); return l.length ? l : [null]; },
    teardown: (n) => `aws lightsail delete-instance --instance-name ${n}`,
    undo: { when: ['aws', 'lightsail', 'delete-instance'], name: (t) => flag(t, ['--instance-name']) } },

  // Azure
  { id: 'az-ml-compute', provider: 'az', what: 'Azure ML compute', cost: 'hourly',
    when: ['az', 'ml', 'compute', 'create'], name: (t) => flag(t, ['--name', '-n']) || (flag(t, ['--file', '-f']) ? '(name in the YAML file)' : null),
    teardown: (n, t) => `az ml compute delete --name ${n} -g ${azg(t)} -w ${flag(t, ['--workspace-name', '-w']) || '<WORKSPACE>'}   # a compute instance can be stopped instead (az ml compute stop); a cluster with min nodes 0 costs nothing idle`,
    undo: { when: ['az', 'ml', 'compute', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },
  { id: 'az-openai-deployment', provider: 'az', what: 'Azure OpenAI / AI Services deployment',
    // Provisioned deployments (ProvisionedManaged, GlobalProvisionedManaged, DataZoneProvisionedManaged) bill per hour; Standard bills per token.
    cost: (t) => (/provisioned/i.test(flag(t, ['--sku-name', '--sku']) || '') ? 'hourly' : 'usage'),
    accel: (t) => /provisioned/i.test(flag(t, ['--sku-name', '--sku']) || ''),
    when: ['az', 'cognitiveservices', 'account', 'deployment', 'create'], name: (t) => flag(t, ['--deployment-name']),
    teardown: (n, t) => `az cognitiveservices account deployment delete -g ${azg(t)} -n ${flag(t, ['--name', '-n']) || '<ACCOUNT>'} --deployment-name ${n}`,
    // Deleting the account deletes its deployments too (the account is kept as the 'cluster' scope key).
    undo: [
      { when: ['az', 'cognitiveservices', 'account', 'deployment', 'delete'], name: (t) => flag(t, ['--deployment-name']) },
      { when: ['az', 'cognitiveservices', 'account', 'delete'], any: true, pick: (f, t) => { const a = (flag(t, ['--name', '-n']) || '').toLowerCase(); return a && f.scope && f.scope.cluster === a ? 'yes' : null; } },
    ] },
  { id: 'az-cognitive-account', provider: 'az', what: 'Azure AI Services / OpenAI account', cost: 'usage',
    when: ['az', 'cognitiveservices', 'account', 'create'], name: (t) => flag(t, ['--name', '-n']),
    teardown: (n, t) => `az cognitiveservices account show -g ${azg(t)} -n ${n}   # if the agent made it: az cognitiveservices account delete -g ${azg(t)} -n ${n}; it is soft-deleted, so to free the name: az cognitiveservices account purge -g ${azg(t)} -n ${n} -l ${flag(t, ['--location', '-l']) || '<LOCATION>'}`,
    undo: { when: ['az', 'cognitiveservices', 'account', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },
  { id: 'az-container', provider: 'az', what: 'Azure Container Instances group', cost: 'hourly',
    when: ['az', 'container', 'create'], name: (t) => flag(t, ['--name', '-n']),
    teardown: (n, t) => `az container delete -g ${azg(t)} -n ${n}`,
    undo: { when: ['az', 'container', 'delete'], name: (t) => flag(t, ['--name', '-n']) || ((flag(t, ['--ids']) || '').match(/containerGroups\/([^/\s]+)/i) || [])[1] } },
  { id: 'az-vmss', provider: 'az', what: 'Azure VM scale set', cost: 'hourly',
    when: ['az', 'vmss', 'create'], name: (t) => flag(t, ['--name', '-n']),
    teardown: (n, t) => `az vmss delete -g ${azg(t)} -n ${n}   # its load balancer and public IP may need deleting too`,
    undo: { when: ['az', 'vmss', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },
  { id: 'az-redis', provider: 'az', what: 'Azure Cache for Redis', cost: 'hourly',
    when: ['az', 'redis', 'create'], name: (t) => flag(t, ['--name', '-n']),
    teardown: (n, t) => `az redis delete -g ${azg(t)} -n ${n}`,
    undo: { when: ['az', 'redis', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },
  { id: 'az-cosmosdb', provider: 'az', what: 'Azure Cosmos DB account', cost: 'hourly',
    when: ['az', 'cosmosdb', 'create'], name: (t) => flag(t, ['--name', '-n']),
    teardown: (n, t) => `az cosmosdb delete -g ${azg(t)} -n ${n}   # deletes every database in the account`,
    undo: { when: ['az', 'cosmosdb', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },
  { id: 'az-sql-server', provider: 'az', what: 'Azure SQL logical server', cost: 'usage',
    when: ['az', 'sql', 'server', 'create'], name: (t) => flag(t, ['--name', '-n']),
    teardown: (n, t) => `az sql db list -g ${azg(t)} -s ${n} -o table   # the server is free, its databases bill; if the agent made it: az sql server delete -g ${azg(t)} -n ${n}  (deletes every database on it)`,
    undo: { when: ['az', 'sql', 'server', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },
  { id: 'az-sql-db', provider: 'az', what: 'Azure SQL database', cost: 'hourly',
    when: ['az', 'sql', 'db', 'create'], name: (t) => flag(t, ['--name', '-n']),
    teardown: (n, t) => `az sql db delete -g ${azg(t)} -s ${flag(t, ['--server', '-s']) || '<SERVER>'} -n ${n}`,
    // A database goes with its server (kept as the 'cluster' scope key).
    undo: [
      { when: ['az', 'sql', 'db', 'delete'], name: (t) => flag(t, ['--name', '-n']) },
      { when: ['az', 'sql', 'server', 'delete'], any: true, pick: (f, t) => { const sv = (flag(t, ['--name', '-n']) || '').toLowerCase(); return sv && f.scope && f.scope.cluster === sv ? 'yes' : null; } },
    ] },

  // DigitalOcean CLI (the MCP server is covered in mcp.js)
  { id: 'do-droplet', provider: 'doctl', what: 'DigitalOcean Droplet', cost: 'hourly',
    when: ['doctl', 'compute', 'droplet', ['create', 'c']], multi: (t) => { const p = positionals(t, 4, [], DOBOOL); return p.length ? p : [null]; },
    teardown: (n, t) => `doctl compute droplet delete ${n}${opt('--context', flag(t, ['--context']))}   # asks before deleting`,
    undo: { when: ['doctl', 'compute', 'droplet', ['delete', 'd', 'del', 'rm']], multi: (t) => positionals(t, 4, [], DOBOOL) } },
  { id: 'do-database', provider: 'doctl', what: 'DigitalOcean managed database', cost: 'hourly',
    when: ['doctl', ['databases', 'database', 'db', 'dbs'], ['create', 'c']], name: (t) => positionals(t, 3, [], DOBOOL)[0] || null,
    // The delete takes the cluster ID, not the name.
    teardown: (n, t) => `doctl databases list${opt('--context', flag(t, ['--context']))}   # then: doctl databases delete <DATABASE_ID>${opt('--context', flag(t, ['--context']))}  (${n})`,
    undo: { when: ['doctl', ['databases', 'database', 'db', 'dbs'], ['delete', 'rm', 'd']], any: true } },
  { id: 'do-k8s', provider: 'doctl', what: 'DigitalOcean Kubernetes cluster', cost: 'hourly',
    when: ['doctl', ['kubernetes', 'k8s', 'kube'], ['cluster', 'clusters', 'c'], ['create', 'c']], name: (t) => positionals(t, 4, [], DOBOOL)[0] || null,
    teardown: (n, t) => `doctl kubernetes cluster delete ${n}${opt('--context', flag(t, ['--context']))}   # its load balancers and volumes stay unless you add --dangerous; check: doctl compute load-balancer list, doctl compute volume list`,
    undo: { when: ['doctl', ['kubernetes', 'k8s', 'kube'], ['cluster', 'clusters', 'c'], ['delete', 'd', 'rm']], multi: (t) => positionals(t, 4, [], DOBOOL) } },

  // Local and public exposure that keeps running
  { id: 'ssh-tunnel', provider: 'ssh', what: 'SSH tunnel (background)', cost: 'local',
    when: ['ssh'], name: (t) => sshTunnel(t),
    teardown: (n, t) => procFind(n, hasSshOpt(t, 'R') ? 'a reverse tunnel: the remote side reaches your local port while it runs; check it is the ssh -f one' : 'check it is the ssh -f one') },
  { id: 'tailscale-funnel', provider: 'tailscale', what: 'Public URL (tailscale funnel)', cost: 'local',
    when: ['tailscale', 'funnel'], name: (t) => funnelTarget(t),
    teardown: () => 'tailscale funnel status   # anyone on the internet can reach it; turn it off: tailscale funnel reset (clears every funnel setting), or rerun the same command with off at the end',
    undo: { when: ['tailscale', 'funnel'], any: true, pick: (f, t) => (t[2] === 'reset' ? 'yes' : t[t.length - 1] === 'off' ? (funnelTargetOff(t) === f.name ? 'yes' : 'maybe') : null) } },
  { id: 'podman-run', provider: 'podman', what: 'Podman container (detached)', cost: 'local',
    when: ['podman', ['run', 'container']], name: (t, ctx) => dockerRun(t, ctx),
    teardown: (n) => `podman ps -a --filter name=${n}   # then: podman stop ${n}, then: podman rm ${n}`,
    undo: { when: ['podman', ['rm', 'stop', 'kill', 'container']], multi: (t) => (['rm', 'stop', 'kill'].includes(t[1]) ? t.slice(2) : ['rm', 'stop', 'kill'].includes(t[2]) ? t.slice(3) : []).filter((x) => !x.startsWith('-')) } },

  // ---------------- Local: containers and tunnels that keep running ----------------
  { id: 'docker-run', provider: 'docker', what: 'Docker container (detached)', cost: 'local',
    when: ['docker', ['run', 'container']], name: (t, ctx) => dockerRun(t, ctx),
    teardown: (n) => `docker ps -a --filter name=${n}   # then: docker stop ${n}, then: docker rm ${n}`,
    undo: { when: ['docker', ['rm', 'stop', 'kill', 'container']], multi: (t) => (['rm', 'stop', 'kill'].includes(t[1]) ? t.slice(2) : ['rm', 'stop', 'kill'].includes(t[2]) ? t.slice(3) : []).filter((x) => !x.startsWith('-')) } },
  { id: 'docker-compose', provider: 'docker', what: 'Docker Compose stack (detached)', cost: 'local', pathName: true,
    // docker compose [-p P] [-f F]... up -d, and docker-compose -f F up -d. ps/down keep -p and every -f.
    when: [['docker', 'docker-compose']], name: (t, ctx) => composeUp(t, ctx),
    // --project-directory and absolute -f paths instead of 'cd DIR &&'.
    teardown: (n, t, ctx) => { const c = composeCmd(t, n, ctx); return `${c} ps   # then: ${c} down`; },
    undo: { when: [['docker', 'docker-compose']], name: (t, ctx) => composeDown(t, ctx) } },
  { id: 'tunnel-ngrok', provider: 'ngrok', what: 'Public tunnel (ngrok)', cost: 'local',
    when: ['ngrok', ['http', 'tcp', 'tls', 'start']], name: (t) => P(t, 2, ['--domain', '--url', '--region', '--authtoken', '--config']) || '(tunnel)',
    teardown: () => procFind('ngrok', 'anyone with the URL can reach your machine while it runs; check it is the right one') },
  { id: 'tunnel-cloudflared', provider: 'cloudflared', what: 'Public tunnel (cloudflared)', cost: 'local',
    when: ['cloudflared', 'tunnel'], name: (t) => flag(t, ['--url']) || P(t, 3, ['--url', '--config', '--name']) || '(tunnel)',
    teardown: () => `${procFind('cloudflared', 'named tunnels: cloudflared tunnel list')}` },
];

// doctl flags that take no value (every other --flag is read as taking one).
const DOBOOL = ['--wait', '--enable-backups', '--enable-ipv6', '--enable-monitoring', '--enable-private-networking', '--droplet-agent', '--no-header',
  '--force', '-f', '--dangerous', '--trace', '--verbose', '-v', '--interactive', '--update-kubeconfig', '--set-current-context', '--auto-upgrade', '--surge-upgrade', '--ha'];
// ssh -f (background) with a port forward (-R reverse, -L local, -D dynamic): the host is the name.
const SSH_VAL = 'BbcDEeFIiJLlmOoPpQRSWw';
function sshOpts(t) {
  const o = new Set(); let host = null;
  for (let i = 1; i < t.length; i++) {
    const x = t[i];
    if (/^-[A-Za-z0-9]+$/.test(x)) {
      for (let j = 1; j < x.length; j++) { o.add(x[j]); if (SSH_VAL.includes(x[j])) { if (j === x.length - 1) i++; break; } }
      continue;
    }
    if (x.startsWith('-')) continue;
    host = x; break;
  }
  return { o, host };
}
const hasSshOpt = (t, c) => sshOpts(t).o.has(c);
function sshTunnel(t) {
  const { o, host } = sshOpts(t);
  if (!o.has('f') || !(o.has('R') || o.has('L') || o.has('D'))) return undefined;
  return host || null;
}
// tailscale funnel [--bg] [--https=443] <target> | status | reset | ... off
function funnelTarget(t) {
  if (['status', 'reset', 'get-config', 'set-config', 'help'].includes(t[2]) || t[t.length - 1] === 'off') return undefined;
  const p = positionals(t, 2, [], ['--bg', '--yes', '-y', '--verbose']);
  return p.length ? p[p.length - 1] : undefined;
}
function funnelTargetOff(t) { const p = positionals(t.slice(0, -1), 2, [], ['--bg', '--yes', '-y']); return p.length ? p[p.length - 1] : null; }
function listIds(t, name) {
  const out = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === name) for (let j = i + 1; j < t.length && !t[j].startsWith('-'); j++) out.push(...t[j].split(','));
    else if (t[i].startsWith(name + '=')) out.push(...t[i].slice(name.length + 1).split(','));
  }
  return out.filter(Boolean);
}
// fly apps destroy NAME / fly destroy NAME: exact when the app was named, maybe for a folder-named one.
function flyPick(f, t) {
  const n = t[1] === 'apps' ? (t[2] === 'destroy' ? P(t, 3, []) : undefined) : P(t, 2, []);
  if (n === undefined) return null;
  if (!n || /^[/(]|[$`]/.test(n) || /^[/(~]|^[A-Za-z]:/.test(f.name)) return 'maybe';
  return n === f.name ? 'yes' : null;
}
const azg = (t) => flag(t, ['--resource-group', '-g']) || '<GROUP>';
function slsOpts(t) {
  return `${opt('--stage', flag(t, ['--stage', '-s']))}${opt('--region', flag(t, ['--region', '-r']))}${opt('--aws-profile', flag(t, ['--aws-profile']))}`;
}
// pulumi up -C infra / --cwd infra: the project folder.
function pulumiDir(t, ctx) {
  const d = flag(t, ['-C', '--cwd']);
  const base = ctx.cwd || '';
  if (!d) return base || null;
  if (/^([A-Za-z]:)?[\\/]/.test(d)) return d;
  return base ? require('path').join(base, d) : d;
}
const pulumiC = (t, ctx) => (flag(t, ['-C', '--cwd']) ? ` --cwd ${sq(pulumiDir(t, ctx))}` : '');
// A node pool named on delete, or its whole cluster deleted.
function poolPick(f, t, poolNames, clusterNames) {
  if (clusterNames) return f.scope && f.scope.cluster && clusterNames.includes(f.scope.cluster) ? 'yes' : null;
  return poolNames && poolNames.includes(f.name) ? 'yes' : null;
}
function tfDir(t, ctx) {
  const d = flag(t, ['-chdir']);
  const base = ctx.cwd || '';
  if (!d) return base || '(this folder)';
  if (/^([A-Za-z]:)?[\\/]/.test(d)) return d;
  return base ? require('path').join(base, d) : d;
}
// TF_WORKSPACE=staging terraform apply: the teardown must run in the same workspace.
function ws(t) { const w = t.env && t.env.TF_WORKSPACE; return w ? `TF_WORKSPACE=${sq(w)} ` : ''; }
function cdkStack(t) { const p = P(t, 2, ['--profile', '-c', '--context', '--app', '-a', '--require-approval', '--parameters', '--outputs-file', '--role-arn', '-r']); return p && !p.includes('/') ? p : null; }
// ctx.detached: the run was sent to the background (a trailing & or the agent's background flag),
// so it keeps running like -d.
function dockerRun(t, ctx) {
  const i = t[1] === 'container' ? 3 : 2;
  if (t[1] === 'container' && t[2] !== 'run') return undefined;
  if (!(ctx && ctx.detached) && !hasFlag(t, ['-d', '--detach']) && !t.slice(i).some((x) => /^-[a-zA-Z]*d[a-zA-Z]*$/.test(x) && !x.startsWith('--'))) return undefined;
  return flag(t, ['--name']) || null;
}
// Compose: global flags (-f, -p, --project-directory, --env-file, --profile) come before the
// subcommand, in both the `docker compose` and the `docker-compose` form.
const COMPOSE_VAL = ['-f', '--file', '-p', '--project-name', '--project-directory', '--env-file', '--profile', '--ansi', '--progress', '--parallel', '-c', '--context', '-H', '--host', '--log-level'];
function composeSub(t) {
  let i = t[0] === 'docker' ? 1 : 0;
  if (t[0] === 'docker') {
    while (i < t.length && t[i].startsWith('-')) i += t[i].includes('=') || !['-c', '--context', '-H', '--host', '--log-level', '--config'].includes(t[i]) ? 1 : 2;
    if (t[i] !== 'compose') return null;
  }
  for (i += 1; i < t.length; i++) {
    if (!t[i].startsWith('-')) return { sub: t[i], at: i };
    if (!t[i].includes('=') && COMPOSE_VAL.includes(t[i])) i++;
  }
  return null;
}
function composeDir(t, ctx) {
  const pth = require('path');
  const pd = flag(t, ['--project-directory']);
  const f = flag(t, ['-f', '--file']);
  const base = ctx.cwd || '(this folder)';
  const abs = (x) => (pth.isAbsolute(x) || /^[A-Za-z]:[\\/]/.test(x) ? x : pth.join(base, x));
  if (pd) return abs(pd);
  return f && /[\\/]/.test(f) ? pth.dirname(abs(f)) : base;
}
function composeUp(t, ctx) {
  const s = composeSub(t);
  if (!s || s.sub !== 'up') return undefined;
  const rest = t.slice(s.at + 1);
  if (!(ctx && ctx.detached) && !hasFlag(rest, ['-d', '--detach', '--wait']) && !rest.some((x) => /^-[a-zA-Z]*d[a-zA-Z]*$/.test(x))) return undefined;
  return composeDir(t, ctx);
}
function composeDown(t, ctx) {
  const s = composeSub(t);
  if (!s || s.sub !== 'down') return undefined;
  return composeDir(t, ctx);
}
// The compose command with the flags that pick the stack: -p, every -f, --project-directory, --env-file, --profile.
function composeCmd(t, dir, ctx) {
  const pth = require('path');
  const s = composeSub(t);
  const head = t[0] === 'docker-compose' ? 'docker-compose' : 'docker compose';
  const keep = [];
  const base = (ctx && ctx.cwd) || '';
  const absF = (x) => { if (!base || /^'|^"/.test(x) && false) return x; const raw = x.replace(/^'(.*)'$/s, '$1').replace(/'\\''/g, "'"); return pth.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) ? x : sq(pth.join(base, raw)); };
  if (dir && !/^\(/.test(dir) && !hasFlag(t, ['--project-directory'])) keep.push('--project-directory', sq(dir));
  const g = s ? t.slice(t[0] === 'docker' ? t.indexOf('compose') + 1 : 1, s.at) : [];
  for (let i = 0; i < g.length; i++) {
    const m = g[i].match(/^(-f|--file|-p|--project-name|--project-directory|--env-file|--profile)(=.*)?$/);
    if (!m) continue;
    const isFile = m[1] === '-f' || m[1] === '--file';
    if (m[2]) keep.push(isFile ? `${m[1]}=${absF(m[2].slice(1))}` : g[i]); else if (g[i + 1] !== undefined) { keep.push(g[i], isFile ? absF(g[i + 1]) : g[i + 1]); i++; }
  }
  return [head, ...keep].join(' ');
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
  if (t[0] === 'gcloud' && (t[1] === 'beta' || t[1] === 'alpha')) { const env = toks.env; t = [t[0], ...t.slice(2)]; if (env) Object.defineProperty(t, 'env', { value: env, enumerable: false }); }
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
