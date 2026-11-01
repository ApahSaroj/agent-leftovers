'use strict';
// v0.4.2 round 2 (review C #14): teardowns that paste into cmd.exe and Windows PowerShell 5.1.
// The '# hint' moves to its own field (teardownHint), 'cd X &&' becomes a tool flag
// (terraform -chdir, docker compose --project-directory, pulumi --cwd) or a separate runIn field,
// pgrep becomes a per-platform process lookup. scan({ platform: 'win32' }) renders the Windows form.
const assert = require('assert');
const { spawnSync } = require('child_process');
const { scan } = require('../src/scan');
const { splitTeardown, oneLine } = require('../src/teardown');
const report = require('../src/report');

let n = 0;
const ev = (command, o = {}) => ({ kind: 'cmd', command, time: `2026-11-01T02:${String(n++ % 60).padStart(2, '0')}:00Z`, cwd: '/home/u/proj', session: 'w1', tool: 'claude', ...o });
const run = (cmds, platform, cwd) => scan(cmds.map((c) => ev(c, cwd ? { cwd } : {})), { platform }).resources;
const hasBash = process.platform !== 'win32' && spawnSync('bash', ['-c', 'true']).status === 0;
const bashOk = (s) => spawnSync('bash', ['-n', '-c', s]).status === 0;

// Every create the suite knows about, for the "no # and no && in any command" sweep.
const CORPUS = [
  'gcloud compute instances create vm1 --zone us-central1-a', 'gcloud sql instances create db1', 'gcloud run deploy api --region us-central1',
  'gcloud storage buckets create gs://b1', 'gcloud services enable aiplatform.googleapis.com', 'aws ec2 run-instances --instance-type t3.micro',
  'aws ec2 create-volume --size 10 --availability-zone us-east-1a', 'aws ec2 allocate-address', 'aws ec2 create-nat-gateway --subnet-id s1',
  'aws rds create-db-instance --db-instance-identifier pg1 --db-instance-class db.t3.micro', 'aws s3 mb s3://b2', 'aws ecs create-service --service-name s --cluster c',
  'aws cloudformation deploy --stack-name st --template-file t.yml', 'terraform apply -auto-approve', 'TF_WORKSPACE=staging terraform apply', 'cdk deploy', 'cdk deploy ApiStack',
  'sam deploy', 'pulumi up', 'serverless deploy --stage prod', 'sst deploy', 'az group create -n rg1 -l eastus', 'az vm create -n v1 -g rg1 --image Ubuntu2204',
  'az webapp up', 'wrangler deploy', 'wrangler d1 create db', 'wrangler kv namespace create kv', 'vercel --prod', 'netlify deploy --prod', 'railway up', 'heroku create',
  'heroku addons:create heroku-postgresql:essential-0 -a app', 'supabase projects create p1', 'supabase functions deploy', 'fly launch', 'fly deploy', 'fly volumes create v -a app',
  'fly machine run nginx -a app', 'firebase deploy', 'modal deploy app.py', 'runpodctl create pod --name p', 'docker run -d --name web nginx', 'docker compose -p x up -d',
  'ngrok http 3000', 'cloudflared tunnel --url http://localhost:3000', 'nohup python worker.py &', 'gcloud compute tpus tpu-vm create t1 --zone us-central2-b --version v2',
  'aws sagemaker create-notebook-instance --notebook-instance-name nb --instance-type ml.t3.medium --role-arn r', 'aws elbv2 create-load-balancer --name alb',
  'aws ec2 create-vpc-endpoint --vpc-id v --vpc-endpoint-type Interface --service-name com.amazonaws.us-east-1.ssm', 'doctl databases create pg --engine pg',
  'az cognitiveservices account create -n a -g rg --kind OpenAI --sku S0 -l eastus', 'ssh -fN -R 80:localhost:3000 serveo.net', 'tailscale funnel --bg 3000',
  'podman run -d --name pg postgres', 'gcloud container clusters get-credentials c1 --zone z1', 'kubectl expose deployment web --type=LoadBalancer --port 80',
];

module.exports = (t) => {
  t('windows: splitTeardown moves "# hint" out of the command', () => {
    assert.deepStrictEqual(splitTeardown('gcloud sql instances delete db1   # take a backup first'), { teardown: 'gcloud sql instances delete db1', teardownHint: 'take a backup first' });
    assert.deepStrictEqual(splitTeardown('aws lambda delete-function --function-name f'), { teardown: 'aws lambda delete-function --function-name f' });
    // A '#' inside quotes or without two spaces before it is part of the command.
    assert.deepStrictEqual(splitTeardown(`az resource list --query "[?name=='a  #b']"`), { teardown: `az resource list --query "[?name=='a  #b']"` });
    assert.strictEqual(splitTeardown("terraform '-chdir=/a'\\''b' state list   # x").teardownHint, 'x');
  });
  t('windows: "cd X && cmd" becomes runIn + cmd (quoted and plain folders)', () => {
    assert.deepStrictEqual(splitTeardown("cd '/tmp/a b' && serverless info   # then: serverless remove"), { teardown: 'serverless info', teardownHint: 'then: serverless remove', runIn: '/tmp/a b' });
    assert.deepStrictEqual(splitTeardown("cd '/tmp/it'\\''s' && railway status"), { teardown: 'railway status', runIn: "/tmp/it's" });
    assert.deepStrictEqual(splitTeardown('cd /home/u/p && fly status'), { teardown: 'fly status', runIn: '/home/u/p' });
  });
  t('windows: no finding has "#" comments or "&&" in its command, on linux and win32', () => {
    for (const platform of ['linux', 'win32']) {
      const r = run(CORPUS, platform);
      assert.ok(r.length >= 50, `${platform}: ${r.length} findings`);
      for (const f of r) {
        assert.ok(!/\s#/.test(f.teardown.replace(/"[^"]*"|'[^']*'/g, '')), `${platform} ${f.rule}: ${f.teardown}`);
        assert.ok(!/&&/.test(f.teardown), `${platform} ${f.rule}: ${f.teardown}`);
        assert.ok(!/^cd .* && /.test(f.teardown), `${platform} ${f.rule}: ${f.teardown}`);
      }
    }
  });
  t('windows: win32 commands use no single quotes, no pgrep, no VAR=value prefix', () => {
    const r = run(CORPUS, 'win32', 'C:\\Users\\me\\my proj');
    for (const f of r) {
      assert.ok(!/^[A-Z_]+=/.test(f.teardown), `${f.rule}: ${f.teardown}`);
      assert.ok(!/\bpgrep\b/.test(f.teardown) && !/\bkill <PID>/.test(f.teardownHint || ''), `${f.rule}: ${f.teardown}`);
      // single quotes only inside a double-quoted powershell -Command string
      assert.ok(!/'/.test(f.teardown.replace(/"[^"]*"/g, '')), `${f.rule}: ${f.teardown}`);
    }
  });
  t('windows: terraform uses -chdir (quoted with " on win32) and TF_WORKSPACE moves to the hint', () => {
    const [l] = run(['TF_WORKSPACE=staging terraform apply'], 'linux', '/home/u/my proj');
    assert.strictEqual(l.teardown, "TF_WORKSPACE=staging terraform '-chdir=/home/u/my proj' state list");
    assert.ok(/destroy -target=<ADDRESS>/.test(l.teardownHint) && !l.runIn);
    if (hasBash) assert.ok(bashOk(oneLine(l)), oneLine(l));
    const [w] = run(['TF_WORKSPACE=staging terraform apply'], 'win32', 'C:\\Users\\me\\my proj');
    assert.strictEqual(w.teardown, 'terraform "-chdir=C:\\Users\\me\\my proj" state list');
    assert.ok(w.teardownHint.startsWith("first set TF_WORKSPACE=staging (cmd: set TF_WORKSPACE=staging; PowerShell: $env:TF_WORKSPACE='staging')"), w.teardownHint);
  });
  t('windows: compose uses --project-directory and absolute -f; pulumi uses --cwd', () => {
    const r = run(['docker compose -p demo -f deploy/prod.yml up -d', 'pulumi up'], 'linux');
    assert.strictEqual(r[0].teardown, 'docker compose --project-directory /home/u/proj/deploy -p demo -f /home/u/proj/deploy/prod.yml ps');
    assert.strictEqual(r[0].teardownHint, 'then: docker compose --project-directory /home/u/proj/deploy -p demo -f /home/u/proj/deploy/prod.yml down');
    assert.strictEqual(r[1].teardown, 'pulumi stack --cwd /home/u/proj');
  });
  t('windows: tools without a folder flag get runIn (serverless, railway, wrangler, fly, sam, cdk)', () => {
    const r = run(['serverless deploy', 'railway up', 'wrangler deploy', 'fly deploy', 'sam deploy', 'cdk deploy'], 'win32', 'C:\\work\\api');
    assert.strictEqual(r.length, 6);
    for (const f of r) { assert.strictEqual(f.runIn, 'C:\\work\\api', f.rule); assert.ok(!/^cd /.test(f.teardown), f.teardown); }
  });
  t('windows: process lookups are per platform (ngrok, cloudflared, background, ssh -f)', () => {
    const cmds = ['ngrok http 3000', 'cloudflared tunnel --url http://localhost:8080', 'nohup node server.js &', 'ssh -fN -R 80:localhost:3000 serveo.net'];
    for (const f of run(cmds, 'linux')) { assert.ok(/^pgrep -af \S+$/.test(f.teardown), f.teardown); assert.ok(/kill <PID>/.test(f.teardownHint), f.teardownHint); }
    for (const f of run(cmds, 'win32')) {
      assert.ok(f.teardown.startsWith('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object CommandLine -match '), f.teardown);
      assert.ok(/taskkill \/PID <PID>/.test(f.teardownHint), f.teardownHint);
    }
  });
  t('windows: docker run teardown has no && (docker stop / docker rm in the hint)', () => {
    const [f] = run(['docker run -d --name web nginx'], 'win32');
    assert.strictEqual(f.teardown, 'docker ps -a --filter name=web');
    assert.strictEqual(f.teardownHint, 'then: docker stop web, then: docker rm web');
  });
  t('windows: a name with % or $ becomes <NAME> on win32 (cmd and PowerShell would expand it)', () => {
    const [f] = run(["gcloud compute instances create vm1 --zone 'us%PATH%'"], 'win32');
    assert.ok(f.teardown.endsWith('--zone <NAME>'), f.teardown);
    const [g] = run(["gcloud compute instances create vm1 --zone 'us central'"], 'win32');
    assert.ok(g.teardown.endsWith('--zone "us central"'), g.teardown);
  });
  t('windows: report prints run in / turn off / hint on separate lines; --script keeps hints as ## comments', () => {
    const res = scan([ev('serverless deploy --stage prod', { cwd: '/tmp/a b' }), ev('gcloud sql instances create db1')], { platform: 'linux' });
    const txt = report.text({ ...res, cmdCount: 2, sessionCount: 1 }, { days: 30, color: false });
    assert.ok(/\n {6}run in: {3}\/tmp\/a b\n {6}turn off: serverless info --stage prod\n {6}hint: {5}if the agent made this service: serverless remove --stage prod/.test(txt), txt);
    assert.ok(/turn off: gcloud sql instances delete db1\n {6}hint: {5}take a backup first/.test(txt), txt);
    const sc = report.script(res);
    assert.ok(/## hint: if the agent made this service: serverless remove --stage prod\n# cd '\/tmp\/a b'\n# serverless info --stage prod/.test(sc), sc);
    // Removing the leading "# " from every line leaves the hints as comments and runs nothing else.
    const uncommented = sc.split('\n').map((l) => l.replace(/^# /, '')).join('\n');
    assert.ok(/^## hint: take a backup first/m.test(uncommented) && /^gcloud sql instances delete db1$/m.test(uncommented), uncommented);
  });
  t('windows: JSON keeps teardown, teardownHint and runIn as separate fields', () => {
    const [f] = run(['railway up'], 'linux');
    const j = JSON.parse(JSON.stringify(f));
    assert.strictEqual(j.teardown, 'railway status');
    assert.strictEqual(j.runIn, '/home/u/proj');
    assert.ok(/railway delete/.test(j.teardownHint));
  });
};
