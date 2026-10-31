'use strict';
const { flag, hasFlag, positional } = require('./shell');

// Each rule: a create command an agent might run, how to name what it made,
// the teardown command, and (optionally) the matching delete so we can tell
// when the agent already cleaned up.
//
// cost: 'hourly'  = bills while it exists (VMs, databases, clusters, GPUs)
//       'usage'   = bills mostly by use/storage (buckets, functions, deploys)
//       'enabler' = turns on a paid API or service

const P = (toks, n, vf) => positional(toks, n, vf);
const GV = ['--zone', '--region', '--project', '--format', '--machine-type', '--image', '--image-family', '--image-project', '--tier', '--database-version', '--memory', '--cpu', '--source', '--runtime', '--trigger-http', '--entry-point', '--location', '--num-nodes', '--size', '--type', '--platform', '--port', '--accelerator', '--network', '--subnet', '--service-account'];
const gz = (t) => flag(t, ['--zone']);
const gr = (t) => flag(t, ['--region', '--location']);
const opt = (name, v) => (v ? ` ${name} ${v}` : '');

const rules = [
  // ---------------- Google Cloud ----------------
  { id: 'gcp-vm', provider: 'gcloud', what: 'Compute Engine VM', cost: 'hourly',
    when: ['gcloud', 'compute', 'instances', 'create'], name: (t) => P(t, 4, GV),
    teardown: (n, t) => `gcloud compute instances delete ${n}${opt('--zone', gz(t))} --quiet`,
    undo: { when: ['gcloud', 'compute', 'instances', 'delete'], name: (t) => P(t, 4, GV) } },
  { id: 'gcp-disk', provider: 'gcloud', what: 'Persistent disk', cost: 'hourly',
    when: ['gcloud', 'compute', 'disks', 'create'], name: (t) => P(t, 4, GV),
    teardown: (n, t) => `gcloud compute disks delete ${n}${opt('--zone', gz(t))} --quiet`,
    undo: { when: ['gcloud', 'compute', 'disks', 'delete'], name: (t) => P(t, 4, GV) } },
  { id: 'gcp-ip', provider: 'gcloud', what: 'Static IP address', cost: 'hourly',
    when: ['gcloud', 'compute', 'addresses', 'create'], name: (t) => P(t, 4, GV),
    teardown: (n, t) => `gcloud compute addresses delete ${n}${hasFlag(t, ['--global']) ? ' --global' : opt('--region', gr(t))} --quiet`,
    undo: { when: ['gcloud', 'compute', 'addresses', 'delete'], name: (t) => P(t, 4, GV) } },
  { id: 'gcp-sql', provider: 'gcloud', what: 'Cloud SQL instance', cost: 'hourly',
    when: ['gcloud', 'sql', 'instances', 'create'], name: (t) => P(t, 4, GV),
    teardown: (n) => `gcloud sql instances delete ${n} --quiet`,
    undo: { when: ['gcloud', 'sql', 'instances', 'delete'], name: (t) => P(t, 4, GV) } },
  { id: 'gcp-gke', provider: 'gcloud', what: 'GKE cluster', cost: 'hourly',
    when: ['gcloud', 'container', 'clusters', ['create', 'create-auto']], name: (t) => P(t, 4, GV),
    teardown: (n, t) => `gcloud container clusters delete ${n}${opt('--zone', gz(t))}${opt('--region', flag(t, ['--region']))} --quiet`,
    undo: { when: ['gcloud', 'container', 'clusters', 'delete'], name: (t) => P(t, 4, GV) } },
  { id: 'gcp-redis', provider: 'gcloud', what: 'Memorystore Redis', cost: 'hourly',
    when: ['gcloud', 'redis', 'instances', 'create'], name: (t) => P(t, 4, GV),
    teardown: (n, t) => `gcloud redis instances delete ${n}${opt('--region', gr(t))} --quiet`,
    undo: { when: ['gcloud', 'redis', 'instances', 'delete'], name: (t) => P(t, 4, GV) } },
  { id: 'gcp-vertex-endpoint', provider: 'gcloud', what: 'Vertex AI model deployment', cost: 'hourly',
    when: ['gcloud', 'ai', 'endpoints', 'deploy-model'], name: (t) => P(t, 4, GV),
    teardown: (n, t) => `gcloud ai endpoints undeploy-model ${n}${opt('--region', gr(t))} --deployed-model-id <ID from: gcloud ai endpoints describe ${n}>`,
    undo: { when: ['gcloud', 'ai', 'endpoints', ['undeploy-model', 'delete']], name: (t) => P(t, 4, GV) } },
  { id: 'gcp-run', provider: 'gcloud', what: 'Cloud Run service', cost: 'usage',
    when: ['gcloud', 'run', 'deploy'], name: (t) => P(t, 3, GV),
    teardown: (n, t) => `gcloud run services delete ${n}${opt('--region', gr(t))} --quiet`,
    undo: { when: ['gcloud', 'run', 'services', 'delete'], name: (t) => P(t, 4, GV) } },
  { id: 'gcp-fn', provider: 'gcloud', what: 'Cloud Function', cost: 'usage',
    when: ['gcloud', 'functions', 'deploy'], name: (t) => P(t, 3, GV),
    teardown: (n, t) => `gcloud functions delete ${n}${opt('--region', gr(t))} --quiet`,
    undo: { when: ['gcloud', 'functions', 'delete'], name: (t) => P(t, 3, GV) } },
  { id: 'gcp-bucket', provider: 'gcloud', what: 'Cloud Storage bucket', cost: 'usage',
    when: ['gcloud', 'storage', 'buckets', 'create'], name: (t) => P(t, 4, GV),
    teardown: (n) => `gcloud storage rm -r ${n}   # deletes the bucket AND its contents`,
    undo: { when: ['gcloud', 'storage', 'rm'], name: (t) => P(t, 3, GV) } },
  { id: 'gcp-gsutil-mb', provider: 'gcloud', what: 'Cloud Storage bucket', cost: 'usage',
    when: ['gsutil', 'mb'], name: (t) => P(t, 2, ['-l', '-c', '-p']),
    teardown: (n) => `gcloud storage rm -r ${n}   # deletes the bucket AND its contents`,
    undo: { when: ['gsutil', 'rb'], name: (t) => P(t, 2, []) } },
  { id: 'gcp-app', provider: 'gcloud', what: 'App Engine version', cost: 'usage',
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
    when: ['aws', 'rds', ['create-db-instance', 'create-db-cluster']], name: (t) => flag(t, ['--db-instance-identifier', '--db-cluster-identifier']),
    teardown: (n, t) => t.includes('create-db-cluster')
      ? `aws rds delete-db-cluster --db-cluster-identifier ${n} --skip-final-snapshot`
      : `aws rds delete-db-instance --db-instance-identifier ${n} --skip-final-snapshot`,
    undo: { when: ['aws', 'rds', ['delete-db-instance', 'delete-db-cluster']], name: (t) => flag(t, ['--db-instance-identifier', '--db-cluster-identifier']) } },
  { id: 'aws-s3', provider: 'aws', what: 'S3 bucket', cost: 'usage',
    when: ['aws', 's3', 'mb'], name: (t) => P(t, 3, ['--region']),
    teardown: (n) => `aws s3 rb ${n} --force   # deletes the bucket AND its contents`,
    undo: { when: ['aws', 's3', 'rb'], name: (t) => P(t, 3, []) } },
  { id: 'aws-s3api', provider: 'aws', what: 'S3 bucket', cost: 'usage',
    when: ['aws', 's3api', 'create-bucket'], name: (t) => flag(t, ['--bucket']) && `s3://${flag(t, ['--bucket'])}`,
    teardown: (n) => `aws s3 rb ${n} --force   # deletes the bucket AND its contents`,
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
    when: ['eksctl', 'create', 'cluster'], name: (t) => flag(t, ['--name', '-n']) || P(t, 3, ['--region', '--nodes', '--node-type', '--version', '-f']),
    teardown: (n) => `eksctl delete cluster --name ${n}`,
    undo: { when: ['eksctl', 'delete', 'cluster'], name: (t) => flag(t, ['--name', '-n']) || P(t, 3, ['--region']) } },
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
    teardown: (n, t) => `aws ecs delete-service --cluster ${flag(t, ['--cluster']) || 'default'} --service ${n} --force`,
    undo: { when: ['aws', 'ecs', 'delete-service'], name: (t) => flag(t, ['--service']) } },
  { id: 'aws-dynamo', provider: 'aws', what: 'DynamoDB table', cost: 'usage',
    when: ['aws', 'dynamodb', 'create-table'], name: (t) => flag(t, ['--table-name']),
    teardown: (n) => `aws dynamodb delete-table --table-name ${n}`,
    undo: { when: ['aws', 'dynamodb', 'delete-table'], name: (t) => flag(t, ['--table-name']) } },

  // ---------------- Infra-as-code (whole stacks) ----------------
  { id: 'iac-terraform', provider: 'terraform', what: 'Terraform stack', cost: 'hourly',
    when: [['terraform', 'tofu'], 'apply'], name: (t, ctx) => ctx.cwd || '(this folder)',
    teardown: (n, t) => `cd "${n}" && ${t[0]} destroy`,
    undo: { when: [['terraform', 'tofu'], 'destroy'], name: (t, ctx) => ctx.cwd || '(this folder)' } },
  { id: 'iac-cdk', provider: 'aws', what: 'CDK stack', cost: 'hourly',
    when: ['cdk', 'deploy'], name: (t, ctx) => P(t, 2, ['--profile', '-c', '--context']) || ctx.cwd || '(all stacks)',
    teardown: (n) => `cdk destroy ${n.startsWith('/') || n.includes(':\\') ? '' : n}`.trim(),
    undo: { when: ['cdk', 'destroy'], name: (t, ctx) => P(t, 2, ['--profile']) || ctx.cwd || '(all stacks)' } },
  { id: 'iac-sam', provider: 'aws', what: 'SAM stack', cost: 'usage',
    when: ['sam', 'deploy'], name: (t, ctx) => flag(t, ['--stack-name']) || ctx.cwd || '(stack)',
    teardown: (n) => `sam delete --stack-name ${n}`,
    undo: { when: ['sam', 'delete'], name: (t, ctx) => flag(t, ['--stack-name']) || ctx.cwd || '(stack)' } },
  { id: 'iac-pulumi', provider: 'pulumi', what: 'Pulumi stack', cost: 'hourly',
    when: ['pulumi', 'up'], name: (t, ctx) => flag(t, ['--stack', '-s']) || ctx.cwd || '(stack)',
    teardown: (n) => `pulumi destroy --stack ${n}`,
    undo: { when: ['pulumi', 'destroy'], name: (t, ctx) => flag(t, ['--stack', '-s']) || ctx.cwd || '(stack)' } },
  { id: 'iac-serverless', provider: 'serverless', what: 'Serverless Framework service', cost: 'usage',
    when: ['serverless', 'deploy'], name: (t, ctx) => ctx.cwd || '(service)',
    teardown: (n) => `cd "${n}" && serverless remove`,
    undo: { when: ['serverless', 'remove'], name: (t, ctx) => ctx.cwd || '(service)' } },

  // ---------------- Azure ----------------
  { id: 'az-group', provider: 'az', what: 'Resource group (and everything in it)', cost: 'hourly',
    when: ['az', 'group', 'create'], name: (t) => flag(t, ['--name', '-n', '--resource-group', '-g']),
    teardown: (n) => `az group delete --name ${n} --yes --no-wait   # deletes EVERYTHING inside it`,
    undo: { when: ['az', 'group', 'delete'], name: (t) => flag(t, ['--name', '-n', '--resource-group', '-g']) } },
  { id: 'az-vm', provider: 'az', what: 'Azure VM', cost: 'hourly',
    when: ['az', 'vm', 'create'], name: (t) => flag(t, ['--name', '-n']),
    teardown: (n, t) => `az vm delete -g ${flag(t, ['--resource-group', '-g']) || '<GROUP>'} -n ${n} --yes`,
    undo: { when: ['az', 'vm', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },
  { id: 'az-aks', provider: 'az', what: 'AKS cluster', cost: 'hourly',
    when: ['az', 'aks', 'create'], name: (t) => flag(t, ['--name', '-n']),
    teardown: (n, t) => `az aks delete -g ${flag(t, ['--resource-group', '-g']) || '<GROUP>'} -n ${n} --yes --no-wait`,
    undo: { when: ['az', 'aks', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },
  { id: 'az-webapp', provider: 'az', what: 'App Service web app', cost: 'hourly',
    when: ['az', 'webapp', ['up', 'create']], name: (t) => flag(t, ['--name', '-n']) || '(web app)',
    teardown: (n, t) => `az webapp delete -g ${flag(t, ['--resource-group', '-g']) || '<GROUP>'} -n ${n}   # also check: az appservice plan list`,
    undo: { when: ['az', 'webapp', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },
  { id: 'az-containerapp', provider: 'az', what: 'Container App', cost: 'usage',
    when: ['az', 'containerapp', ['up', 'create']], name: (t) => flag(t, ['--name', '-n']),
    teardown: (n, t) => `az containerapp delete -g ${flag(t, ['--resource-group', '-g']) || '<GROUP>'} -n ${n} --yes`,
    undo: { when: ['az', 'containerapp', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },
  { id: 'az-pg', provider: 'az', what: 'Azure Postgres server', cost: 'hourly',
    when: ['az', ['postgres', 'mysql'], 'flexible-server', 'create'], name: (t) => flag(t, ['--name', '-n']),
    teardown: (n, t) => `az ${t[1]} flexible-server delete -g ${flag(t, ['--resource-group', '-g']) || '<GROUP>'} -n ${n} --yes`,
    undo: { when: ['az', ['postgres', 'mysql'], 'flexible-server', 'delete'], name: (t) => flag(t, ['--name', '-n']) } },

  // ---------------- Cloudflare ----------------
  { id: 'cf-worker', provider: 'wrangler', what: 'Cloudflare Worker', cost: 'usage',
    when: ['wrangler', ['deploy', 'publish']], name: (t, ctx) => flag(t, ['--name']) || ctx.cwd || '(worker in this folder)',
    teardown: (n, t) => flag(t, ['--name']) ? `wrangler delete --name ${n}` : `cd "${n}" && wrangler delete`,
    undo: { when: ['wrangler', 'delete'], name: (t, ctx) => flag(t, ['--name']) || ctx.cwd || '(worker in this folder)' } },
  { id: 'cf-d1', provider: 'wrangler', what: 'D1 database', cost: 'usage',
    when: ['wrangler', 'd1', 'create'], name: (t) => P(t, 3, []),
    teardown: (n) => `wrangler d1 delete ${n}`,
    undo: { when: ['wrangler', 'd1', 'delete'], name: (t) => P(t, 3, []) } },
  { id: 'cf-r2', provider: 'wrangler', what: 'R2 bucket', cost: 'usage',
    when: ['wrangler', 'r2', 'bucket', 'create'], name: (t) => P(t, 4, []),
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
  { id: 'cf-pages', provider: 'wrangler', what: 'Pages project', cost: 'usage',
    when: ['wrangler', 'pages', ['deploy', 'publish']], name: (t) => flag(t, ['--project-name']) || '(pages project)',
    teardown: (n) => `wrangler pages project delete ${n}`,
    undo: { when: ['wrangler', 'pages', 'project', 'delete'], name: (t) => P(t, 4, []) } },

  // ---------------- Vercel / Netlify / Railway / Heroku ----------------
  { id: 'vercel-deploy', provider: 'vercel', what: 'Vercel deployment', cost: 'usage',
    when: ['vercel', ['deploy', '--prod', '--yes', '-y', null]], name: (t, ctx) => flag(t, ['--name']) || ctx.cwd || '(project in this folder)',
    teardown: (n) => `vercel project ls   # then: vercel project rm <PROJECT>  (from ${n})`,
    undo: { when: ['vercel', ['remove', 'rm']], any: true } },
  { id: 'netlify-deploy', provider: 'netlify', what: 'Netlify site', cost: 'usage',
    when: ['netlify', ['deploy', 'sites:create']], name: (t, ctx) => flag(t, ['--site', '--name']) || ctx.cwd || '(site)',
    teardown: () => 'netlify sites:list   # then: netlify sites:delete <SITE_ID>',
    undo: { when: ['netlify', 'sites:delete'], any: true } },
  { id: 'railway-up', provider: 'railway', what: 'Railway service', cost: 'hourly',
    when: ['railway', 'up'], name: (t, ctx) => ctx.cwd || '(linked project)',
    teardown: (n) => `cd "${n}" && railway down`,
    undo: { when: ['railway', 'down'], name: (t, ctx) => ctx.cwd || '(linked project)' } },
  { id: 'heroku-create', provider: 'heroku', what: 'Heroku app', cost: 'hourly',
    when: ['heroku', ['create', 'apps:create']], name: (t) => P(t, 2, ['--region', '--team', '-t', '--stack', '-s', '--buildpack', '-b']) || '(new app)',
    teardown: (n) => `heroku apps:destroy ${n} --confirm ${n}`,
    undo: { when: ['heroku', ['apps:destroy', 'destroy']], name: (t) => flag(t, ['--app', '-a']) || P(t, 2, ['--confirm']) } },
  { id: 'heroku-addon', provider: 'heroku', what: 'Heroku add-on', cost: 'hourly',
    when: ['heroku', 'addons:create'], name: (t) => P(t, 2, ['--app', '-a', '--name', '--as']),
    teardown: (n, t) => `heroku addons:destroy ${n}${opt('--app', flag(t, ['--app', '-a']))}`,
    undo: { when: ['heroku', 'addons:destroy'], name: (t) => P(t, 2, ['--app', '-a']) } },

  // ---------------- Supabase ----------------
  { id: 'supabase-project', provider: 'supabase', what: 'Supabase project', cost: 'hourly',
    when: ['supabase', 'projects', 'create'], name: (t) => P(t, 3, ['--org-id', '--db-password', '--region', '--plan', '--size']),
    teardown: () => 'supabase projects list   # then: supabase projects delete <REF>' },
  { id: 'supabase-fn', provider: 'supabase', what: 'Edge Function', cost: 'usage',
    when: ['supabase', 'functions', 'deploy'], name: (t) => P(t, 3, ['--project-ref', '--import-map']) || '(all functions)',
    teardown: (n) => `supabase functions delete ${n}`,
    undo: { when: ['supabase', 'functions', 'delete'], name: (t) => P(t, 3, ['--project-ref']) } },

  // ---------------- Fly.io ----------------
  { id: 'fly-app', provider: 'fly', what: 'Fly.io app', cost: 'hourly',
    when: ['fly', ['launch', 'deploy']], name: (t, ctx) => flag(t, ['--app', '-a', '--name']) || ctx.cwd || '(app in this folder)',
    teardown: (n, t) => flag(t, ['--app', '-a', '--name']) ? `fly apps destroy ${n} --yes` : `fly apps list   # then: fly apps destroy <APP> --yes  (from ${n})`,
    undo: { when: ['fly', ['apps', 'destroy']], any: true } },
  { id: 'fly-pg', provider: 'fly', what: 'Fly Postgres', cost: 'hourly',
    when: ['fly', 'postgres', 'create'], name: (t) => flag(t, ['--name']),
    teardown: (n) => `fly apps destroy ${n} --yes` },
  { id: 'fly-volume', provider: 'fly', what: 'Fly volume', cost: 'hourly',
    when: ['fly', ['volumes', 'volume', 'vol'], 'create'], name: (t) => P(t, 3, ['--app', '-a', '--region', '-r', '--size', '-s']),
    teardown: (n, t) => `fly volumes list${opt('-a', flag(t, ['--app', '-a']))}   # then: fly volumes destroy <VOL_ID>  (${n})` },
  { id: 'fly-machine', provider: 'fly', what: 'Fly machine', cost: 'hourly',
    when: ['fly', ['machine', 'machines', 'm'], 'run'], name: (t) => flag(t, ['--name']) || P(t, 3, ['--app', '-a', '--region', '-r', '--vm-size', '--name']),
    teardown: (n, t) => `fly machine list${opt('-a', flag(t, ['--app', '-a']))}   # then: fly machine destroy <ID> --force  (${n})` },

  // ---------------- Firebase ----------------
  { id: 'firebase-deploy', provider: 'firebase', what: 'Firebase deploy (hosting/functions)', cost: 'usage',
    when: ['firebase', 'deploy'], name: (t, ctx) => flag(t, ['--project', '-P']) || ctx.cwd || '(default project)',
    teardown: () => 'firebase functions:list   # then: firebase functions:delete <NAME>; for hosting: firebase hosting:disable' },

  // ---------------- GPU / serverless compute ----------------
  { id: 'modal-deploy', provider: 'modal', what: 'Modal app', cost: 'usage',
    when: ['modal', 'deploy'], name: (t) => flag(t, ['--name']) || P(t, 2, ['--env', '-e', '--tag']),
    teardown: () => 'modal app list   # then: modal app stop <APP>' },
  { id: 'runpod-pod', provider: 'runpod', what: 'RunPod GPU pod', cost: 'hourly',
    when: ['runpodctl', 'create', ['pod', 'pods']], name: (t) => flag(t, ['--name']) || '(pod)',
    teardown: () => 'runpodctl get pod   # then: runpodctl remove pod <POD_ID>',
    undo: { when: ['runpodctl', 'remove', ['pod', 'pods']], any: true } },
];

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

module.exports = { rules, matchPrefix };
