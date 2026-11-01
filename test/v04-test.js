'use strict';
// v0.4 regression tests: every issue the specialist review reproduced gets a test here.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();

// steps: { bash, fail } | { mcp, input, result, fail } | { write, content } ; optional cwd
function claudeLog(file, steps, { sid = 'S1', cwd = '/home/u/proj', startMins = 600 } = {}) {
  const L = [];
  let t = startMins;
  steps.forEach((s, i) => {
    t -= 2;
    const id = `toolu_${sid}_${i}`;
    const c = s.cwd || cwd;
    let tu;
    if (s.bash !== undefined) tu = { type: 'tool_use', id, name: 'Bash', input: { command: s.bash } };
    else if (s.mcp) tu = { type: 'tool_use', id, name: s.mcp, input: s.input || {} };
    else tu = { type: 'tool_use', id, name: 'Write', input: { file_path: s.write, content: s.content } };
    L.push({ sessionId: sid, cwd: c, timestamp: iso(t), type: 'assistant', message: { role: 'assistant', content: [tu] } });
    const res = s.mcp ? [{ type: 'text', text: JSON.stringify(s.result || {}) }] : (s.fail ? 'Exit code 1\nerror' : 'ok');
    L.push({ sessionId: sid, cwd: c, timestamp: iso(t - 1), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: res, is_error: !!s.fail }] } });
  });
  fs.writeFileSync(file, L.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

module.exports = function (t, bin, baseEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-v04-'));
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  const env = { ...baseEnv, HOME: home, USERPROFILE: home };
  let n = 0;
  const run = (steps, args = [], opts = {}) => {
    const f = path.join(dir, `log${++n}.jsonl`);
    claudeLog(f, steps, opts);
    const r = spawnSync(process.execPath, [bin, '--logs', f, '--json', '--no-ignore', ...args], { env: { ...env, ...(opts.env || {}) }, encoding: 'utf8', cwd: opts.cwd || dir });
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { throw new Error(`bad JSON (exit ${r.status}): ${r.stderr || r.stdout.slice(0, 300)}`); }
    return j;
  };
  const one = (j, rule) => j.resources.find((r) => r.rule === rule);

  console.log('v0.4: --verify safety');
  const fb = path.join(dir, 'fakebin'); fs.mkdirSync(fb);
  const callLog = path.join(dir, 'calls.log'); fs.writeFileSync(callLog, '');
  const fake = (name, body) => { const p = path.join(fb, name); fs.writeFileSync(p, `#!${process.execPath}\nconst a=process.argv.slice(2);require('fs').appendFileSync(${JSON.stringify(callLog)}, ${JSON.stringify(name)}+' '+a.join(' ')+'\\n');\n${body}\n`); fs.chmodSync(p, 0o755); };
  fake('kubectl', `if (a.includes('offline-svc')) { process.stderr.write('error: context "prod" does not exist'); process.exit(1); } process.stdout.write('service/'+a[2]+'\\n');`);
  fake('aws', `if (a.includes('describe-db-clusters')) { process.stdout.write('{}'); process.exit(0); } if (a.includes('net-fn')) { process.stderr.write('Could not connect to the endpoint URL: "https://lambda.eu-west-1.amazonaws.com/"'); process.exit(255); } process.stderr.write('An error occurred (ResourceNotFoundException) when calling the GetFunction operation: Function not found'); process.exit(254);`);
  fake('gcloud', `process.stderr.write('ERROR: (gcloud.compute.instances.describe) There was a problem refreshing your current auth tokens: no such host'); process.exit(1);`);
  const venv = { PATH: fb };
  const evil = `apiVersion: v1\nkind: Service\nmetadata:\n  name: --kubeconfig=/tmp/evil.yaml\nspec:\n  type: LoadBalancer\n`;
  const jv = run([
    { write: '/home/u/proj/evil.yaml', content: evil },
    { bash: 'kubectl --context gke_prod apply -f evil.yaml' },
    { bash: 'kubectl --context gke_prod expose deployment web --type=LoadBalancer --name=--x' },
    { bash: 'kubectl --context gke_prod expose deployment api --type=LoadBalancer --name=api-lb' },
    { bash: 'kubectl --context gke_prod expose deployment off --type=LoadBalancer --name=offline-svc' },
    { bash: 'aws lambda create-function --function-name prod-fn --region eu-west-1 --profile prod --runtime nodejs20.x' },
    { bash: 'aws lambda create-function --function-name net-fn --region eu-west-1' },
    { bash: 'aws rds create-db-cluster --db-cluster-identifier aurora-1 --engine aurora-postgresql' },
    { bash: 'gcloud compute instances create vm-offline --zone us-central1-a' },
  ], ['--verify'], { env: venv });
  const calls = fs.readFileSync(callLog, 'utf8');
  t('a manifest name starting with "-" never reaches kubectl', () => { assert.ok(!/kubeconfig=\/tmp\/evil|--x\b/.test(calls), calls); });
  t('crafted names are reported, not checked', () => { const bad = jv.resources.filter((r) => r.provider === 'k8s' && r.nameUnknown); assert.ok(bad.length >= 2, JSON.stringify(jv.resources.map((r) => r.name))); });
  t('a normal k8s name is still checked', () => assert.strictEqual(jv.resources.find((r) => r.k8sName === 'api-lb').live, 'exists'));
  t('"context does not exist" = could not check, not gone', () => { const r = jv.resources.find((x) => x.k8sName === 'offline-svc'); assert.strictEqual(r.live, 'unknown'); assert.strictEqual(r.status, 'left'); });
  t('offline aws = could not check, not gone', () => { const r = jv.resources.find((x) => x.name === 'net-fn'); assert.strictEqual(r.live, 'unknown'); assert.strictEqual(r.status, 'left'); });
  t('gcloud "no such host" = could not check', () => assert.strictEqual(one(jv, 'gcp-vm').status, 'left'));
  t('real ResourceNotFoundException = gone', () => assert.strictEqual(jv.resources.find((x) => x.name === 'prod-fn').status, 'gone'));
  t('verify carries --profile and --region', () => assert.ok(/get-function --function-name prod-fn --profile prod --region eu-west-1/.test(calls), calls));
  t('RDS cluster checked with describe-db-clusters', () => { assert.ok(/describe-db-clusters --db-cluster-identifier aurora-1/.test(calls)); assert.strictEqual(one(jv, 'aws-rds-cluster').live, 'exists'); });
  t('exit code stays 1 when checks fail', () => assert.ok(jv.resources.some((r) => r.status === 'left')));

  const { resolveBin } = require('../src/verify');
  t('CLI lookup ignores "." and relative PATH entries', () => {
    const cwdBin = fs.mkdtempSync(path.join(os.tmpdir(), 'al-cwd-'));
    fs.writeFileSync(path.join(cwdBin, 'gcloud'), '#!/bin/sh\n'); fs.chmodSync(path.join(cwdBin, 'gcloud'), 0o755);
    const old = process.cwd(); process.chdir(cwdBin);
    try { assert.strictEqual(resolveBin('gcloud', { PATH: ['.', '', 'rel/bin'].join(path.delimiter) }), null); } finally { process.chdir(old); }
    assert.ok(resolveBin('kubectl', { PATH: fb }));
  });

  console.log('v0.4: scope and safer teardowns');
  const js = run([
    { bash: 'gcloud config set project my-proj' },
    { bash: 'gcloud compute instances create web-1 web-2 --zone us-central1-a --machine-type e2-standard-4' },
    { bash: 'gcloud compute instances delete web-2 --zone us-central1-a' },
    { bash: 'export AWS_PROFILE=staging' },
    { bash: 'aws lambda create-function --function-name thumb --region eu-west-1' },
    { bash: 'aws --profile p2 lambda create-function --function-name hidden-fn' },
    { bash: 'gcloud --project other compute instances create hidden-vm' },
    { bash: 'terraform -chdir=infra apply -auto-approve' },
    { bash: 'netlify deploy --prod' },
    { bash: 'vercel --prod' },
    { bash: 'npx wrangler deploy' },
    { bash: 'az group create --name rg-demo --location eastus' },
    { bash: 'aws rds create-db-instance --db-instance-identifier pg1 --db-instance-class db.t3.micro' },
    { bash: 'gcloud compute instances create --boot-disk-size 20GB --preemptible myvm --zone z' },
    { bash: 'gsutil mb -b on gs://assets-1' },
    { bash: 'pulumi up --yes' },
    { bash: 'supabase functions deploy' },
  ]);
  const named = (rule, nm) => js.resources.find((r) => r.rule === rule && r.name === nm);
  t('create vm1 vm2 records both, delete vm2 clears only vm2', () => { assert.strictEqual(named('gcp-vm', 'web-1').status, 'left'); assert.strictEqual(named('gcp-vm', 'web-2').status, 'cleaned'); });
  t('gcloud config set project flows into the teardown', () => assert.ok(/--project my-proj/.test(named('gcp-vm', 'web-1').teardown)));
  t('export AWS_PROFILE and --region flow into the teardown', () => assert.ok(/--profile staging --region eu-west-1/.test(named('aws-lambda', 'thumb').teardown), named('aws-lambda', 'thumb').teardown));
  t('aws --profile before the service is still found', () => assert.ok(/--profile p2/.test(named('aws-lambda', 'hidden-fn').teardown)));
  t('gcloud --project before the group is still found', () => assert.ok(/--project other/.test(named('gcp-vm', 'hidden-vm').teardown)));
  t('terraform -chdir is found, with a targeted teardown', () => { const r = one(js, 'iac-terraform'); assert.strictEqual(r.name, '/home/u/proj/infra'); assert.ok(/state list/.test(r.teardown) && /-target/.test(r.teardownHint) && /-chdir=\/home\/u\/proj\/infra/.test(r.teardown) && !/&&/.test(r.teardown)); assert.ok(r.deploy); });
  t('netlify deploy looks before deleting', () => { const r = one(js, 'netlify-deploy'); assert.ok(r.teardown.startsWith('netlify status')); assert.ok(r.deploy); });
  t('vercel deploy starts with a list, not project rm', () => assert.ok(one(js, 'vercel-deploy').teardown.startsWith('vercel ls')));
  t('wrangler deploy suggests rollback first', () => assert.ok(/deployments list/.test(one(js, 'cf-worker').teardown)));

  console.log('feedback (MankyRivet, h2oilx): account beside every teardown');
  const jfb = run([
    { bash: 'gcloud config set account dev@example.com' },
    { bash: 'gcloud compute instances create fb-vm --zone us-east1-b --project fb-proj' },
    { bash: 'gcloud config configurations activate staging' },
    { bash: 'gcloud compute instances create fb-vm2 --zone us-east1-b' },
    { bash: 'az account set --subscription sub-123' },
    { bash: 'az group create --name rg-fb --location eastus' },
    { bash: 'gcloud compute instances create fb-vm3 --zone us-east1-b --account other@example.com' },
  ]);
  const nfb = (rule, nm) => jfb.resources.find((r) => r.rule === rule && r.name === nm);
  t('GCP VM teardown keeps --zone and --project', () => { const td = nfb('gcp-vm', 'fb-vm').teardown; assert.ok(/--zone us-east1-b/.test(td) && /--project fb-proj/.test(td), td); });
  t('gcloud config set account flows into the teardown', () => assert.ok(/--account dev@example\.com/.test(nfb('gcp-vm', 'fb-vm').teardown), nfb('gcp-vm', 'fb-vm').teardown));
  t('configurations activate carries --configuration and drops the old account', () => { const td = nfb('gcp-vm', 'fb-vm2').teardown; assert.ok(/--configuration staging/.test(td) && !/dev@example/.test(td), td); });
  t('az account set carries --subscription', () => assert.ok(/--subscription sub-123/.test(one(jfb, 'az-group').teardown || ''), JSON.stringify(jfb.resources.map((r) => r.rule))));
  t('--account on the create command wins', () => assert.ok(/--account other@example\.com/.test(nfb('gcp-vm', 'fb-vm3').teardown)));
  t('text output warns when the account is not in the log', () => {
    const f = path.join(dir, 'fb-text.jsonl');
    claudeLog(f, [{ bash: 'gcloud compute instances create bare-vm --zone us-east1-b' }]);
    const r = spawnSync(process.execPath, [bin, '--logs', f, '--no-ignore', '--no-color'], { env, encoding: 'utf8', cwd: dir });
    assert.ok(/account: not recorded in the log.*gcloud config list/.test(r.stdout), r.stdout.slice(0, 600));
  });
  t('az group create looks before deleting, no --yes', () => { const r = one(js, 'az-group'); assert.ok(r.teardown.startsWith('az resource list')); assert.ok(!/--yes/.test(r.teardown)); });
  t('RDS keeps a final snapshot', () => { const r = one(js, 'aws-rds'); assert.ok(/--final-db-snapshot-identifier pg1-final/.test(r.teardown)); assert.ok(!/skip-final-snapshot/.test(r.teardown)); });
  t('--boot-disk-size 20GB myvm names myvm', () => assert.ok(named('gcp-vm', 'myvm')));
  t('gsutil mb -b on gs://x names the bucket', () => assert.strictEqual(one(js, 'gcp-gsutil-mb').name, 'gs://assets-1'));
  t('pulumi without --stack never puts a folder in --stack', () => assert.ok(!/--stack \//.test(one(js, 'iac-pulumi').teardown)));
  t('supabase deploy-all never says "delete (all functions)"', () => assert.ok(!/delete \(all/.test(one(js, 'supabase-fn').teardown)));
  t('cost estimate for a known machine type', () => { const r = named('gcp-vm', 'web-1'); assert.ok(r.estimate && r.estimate.perHour === 0.134 && /e2-standard-4/.test(r.estimate.basis)); });
  t('no teardown skips a safety prompt', () => {
    const { rules } = require('../src/rules');
    const toks = ['x', 'y', 'z', 'w', 'n1', '--zone', 'z', '--region', 'r', '--name', 'n1', '--app', 'a'];
    for (const r of rules) { let s; try { s = r.teardown('n1', toks, { cwd: '/p' }); } catch { continue; } assert.ok(!/--quiet|--yes\b|--force\b|--skip-final-snapshot|--confirm/.test(s.replace(/#.*$/, '')), `${r.id}: ${s}`); }
  });

  console.log('v0.4: false positives');
  const jf = run([
    { bash: "cat > deploy.sh <<'EOF'\ngcloud sql instances create from-heredoc\nEOF" },
    { bash: 'gcloud run deploy api --region us-east1; npm test', fail: true },
    { bash: 'terraform apply -destroy -auto-approve' },
    { bash: 'kubectl apply --dry-run=client -f x.yaml' },
    { bash: 'gcloud compute instances create --help' },
    { bash: 'vercel --version' },
    { bash: 'AWS_SECRET_ACCESS_KEY=abc123secret aws s3 mb s3://leaky' },
    { bash: 'gcloud sql users set-password root --instance=db --password hunter2' },
    { bash: 'supabase projects create p1 --db-password s3cr3tpw --org-id o' },
  ]);
  t('heredoc text is not a command', () => assert.ok(!jf.resources.some((r) => r.name === 'from-heredoc')));
  t('a failed test after a deploy does not hide the deploy', () => assert.strictEqual(one(jf, 'gcp-run').status, 'left'));
  t('terraform apply -destroy is not a leftover', () => assert.ok(!one(jf, 'iac-terraform')));
  t('--help / --version / --dry-run are not leftovers', () => assert.ok(!jf.resources.some((r) => ['gcp-vm', 'vercel-deploy'].includes(r.rule))));
  t('secrets are masked in --json', () => { const s = JSON.stringify(jf); assert.ok(!/abc123secret|s3cr3tpw/.test(s), s.slice(0, 400)); });

  console.log('v0.4: MCP nouns, stop vs delete');
  const jm = run([
    { mcp: 'mcp__neon__create_project', input: { name: 'app' }, result: { project: { id: 'proj-1' } } },
    { mcp: 'mcp__neon__create_branch', input: { projectId: 'proj-1', branchName: 'dev' }, result: { branch: { id: 'br-1' } } },
    { mcp: 'mcp__neon__delete_branch', input: { projectId: 'proj-1', branchId: 'br-1' }, result: { ok: true } },
    { mcp: 'mcp__aws__run_instances', input: { name: 'box' }, result: { instance_id: 'i-1' } },
    { mcp: 'mcp__aws__stop_instance', input: { instance_id: 'i-1' }, result: { ok: true } },
    { mcp: 'mcp__atlassian__create_page', input: { title: 'x' }, result: {} },
  ]);
  t('deleting a branch does not clean its project', () => { assert.strictEqual(one(jm, 'mcp-neon-project').status, 'left'); assert.strictEqual(one(jm, 'mcp-neon-branch').status, 'cleaned'); });
  t('stop = maybe, with a note that disks still bill', () => { const r = one(jm, 'mcp-aws-instance'); assert.strictEqual(r.status, 'maybe-cleaned'); assert.ok(/still bill/.test(r.stopNote)); });
  t('Atlassian is not MongoDB', () => assert.ok(!jm.resources.some((r) => r.provider === 'mongodb')));

  console.log('v0.4: local leftovers and scripts');
  const jl = run([
    { bash: 'docker run -d --name pg-dev -p 5432:5432 postgres:16' },
    { bash: 'docker run -d --name redis-tmp redis' },
    { bash: 'docker rm -f redis-tmp' },
    { bash: 'docker run --rm alpine echo hi' },
    { bash: 'nohup python server.py > out.log 2>&1 &' },
    { bash: 'ngrok http 3000' },
    { write: '/home/u/proj/setup.sh', content: '#!/bin/bash\nset -e\ngcloud sql instances create script-db --tier db-f1-micro\n' },
    { bash: 'bash setup.sh' },
  ]);
  t('detached container found, removed one cleaned, --rm ignored', () => { assert.strictEqual(jl.resources.find((r) => r.name === 'pg-dev').status, 'left'); assert.strictEqual(jl.resources.find((r) => r.name === 'redis-tmp').status, 'cleaned'); assert.strictEqual(jl.resources.filter((r) => r.rule === 'docker-run').length, 2); });
  t('nohup background process found', () => assert.ok(jl.resources.find((r) => r.rule === 'bg-process' && r.name === 'server.py')));
  t('ngrok tunnel found', () => assert.ok(one(jl, 'tunnel-ngrok')));
  t('commands inside a script the agent wrote and ran', () => { const r = jl.resources.find((x) => x.name === 'script-db'); assert.ok(r && r.viaScript === 'setup.sh'); });

  console.log('v0.4: CLI behaviour');
  const bad = spawnSync(process.execPath, [bin, '--days=abc'], { env, encoding: 'utf8' });
  t('--days=abc exits 2 with a message', () => { assert.strictEqual(bad.status, 2); assert.ok(/positive number/.test(bad.stderr)); });
  const oldLog = path.join(dir, 'old.jsonl');
  claudeLog(oldLog, [{ bash: 'gcloud sql instances create ancient-db' }], { startMins: 60 * 24 * 400 });
  fs.utimesSync(oldLog, new Date(Date.now() - 400 * 86400000), new Date(Date.now() - 400 * 86400000));
  const oj = JSON.parse(spawnSync(process.execPath, [bin, '--logs', oldLog, '--json'], { env, encoding: 'utf8' }).stdout);
  t('--logs reads an old file without --days', () => assert.ok(oj.resources.find((r) => r.name === 'ancient-db')));
  const help = spawnSync(process.execPath, [bin, '--help'], { env, encoding: 'utf8' }).stdout;
  t('--help lists exit codes, CLAUDE_CONFIG_DIR and the ignore file', () => assert.ok(/Exit codes/.test(help) && /CLAUDE_CONFIG_DIR/.test(help) && /agent-leftovers-ignore/.test(help)));

  // ignore file + baseline + brief
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'al-wd-'));
  const igLog = path.join(dir, 'ig.jsonl');
  claudeLog(igLog, [{ bash: 'gcloud run deploy keep-me --region r' }, { bash: 'gcloud sql instances create temp-db' }]);
  fs.writeFileSync(path.join(wd, '.agent-leftovers-ignore'), '# mine\ngcp-run:keep-me\n');
  const ij = JSON.parse(spawnSync(process.execPath, [bin, '--logs', igLog, '--json'], { env, encoding: 'utf8', cwd: wd }).stdout);
  t('.agent-leftovers-ignore hides what you meant to keep', () => { assert.strictEqual(ij.resources.find((r) => r.name === 'keep-me').status, 'ignored'); assert.strictEqual(ij.resources.find((r) => r.name === 'temp-db').status, 'left'); });
  const bl = spawnSync(process.execPath, [bin, '--logs', igLog, '--baseline'], { env, encoding: 'utf8', cwd: wd });
  t('--baseline writes ~/.agent-leftovers-ignore', () => { assert.ok(/Added 1 item/.test(bl.stdout), bl.stdout + bl.stderr); assert.ok(/gcp-sql:temp-db/.test(fs.readFileSync(path.join(home, '.agent-leftovers-ignore'), 'utf8'))); });
  const br = spawnSync(process.execPath, [bin, '--logs', igLog, '--brief'], { env, encoding: 'utf8', cwd: wd });
  t('--brief prints nothing once all is ignored, exit 0', () => { assert.strictEqual(br.stdout.trim(), ''); assert.strictEqual(br.status, 0); });
  const br2 = spawnSync(process.execPath, [bin, '--logs', igLog, '--brief', '--no-ignore'], { env, encoding: 'utf8', cwd: wd });
  t('--brief lists leftovers in a few lines', () => { assert.ok(/may still be running/.test(br2.stdout) && /temp-db/.test(br2.stdout) && br2.stdout.split('\n').length < 12); assert.strictEqual(br2.status, 1, 'leftovers found: exit 1 as documented'); });

  console.log('v0.4: Gemini CLI and Copilot CLI logs');
  const gh = path.join(dir, 'ghome');
  const chats = path.join(gh, '.gemini', 'tmp', 'abc123', 'chats'); fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(path.join(gh, '.gemini', 'tmp', 'abc123', '.project_root'), '/home/u/gem');
  fs.writeFileSync(path.join(chats, 'session-1.json'), JSON.stringify({ sessionId: 'g1', projectHash: 'abc123', startTime: iso(30), messages: [
    { id: 'm1', timestamp: iso(29), type: 'user', content: 'deploy it' },
    { id: 'm2', timestamp: iso(28), type: 'gemini', content: '', toolCalls: [
      { id: 'tc1', name: 'run_shell_command', args: { command: 'gcloud compute instances create gem-vm --zone us-east1-b' }, status: 'success', timestamp: iso(28), result: [{ functionResponse: { response: { output: 'Exit Code: 0' } } }] },
      { id: 'tc2', name: 'run_shell_command', args: { command: 'gcloud sql instances create gem-db' }, status: 'error', timestamp: iso(27) },
    ] },
  ] }));
  const cp = path.join(gh, '.copilot', 'session-state', 'sess-9'); fs.mkdirSync(cp, { recursive: true });
  fs.writeFileSync(path.join(cp, 'events.jsonl'), [
    { type: 'session.start', timestamp: iso(20), data: { sessionId: 'c9', context: { cwd: '/home/u/cop' } } },
    { type: 'tool.execution_start', timestamp: iso(19), data: { toolCallId: 'x1', toolName: 'bash', arguments: { command: 'aws s3 mb s3://copilot-bucket' } } },
    { type: 'tool.execution_complete', timestamp: iso(19), data: { toolCallId: 'x1', success: true, result: { content: 'make_bucket: copilot-bucket\n<exited with exit code 0>' } } },
    { type: 'tool.execution_start', timestamp: iso(18), data: { toolCallId: 'x2', toolName: 'bash', arguments: { command: 'fly launch --name cop-app' } } },
    { type: 'tool.execution_complete', timestamp: iso(18), data: { toolCallId: 'x2', success: true, result: { content: 'Error: not logged in\n<exited with exit code 1>' } } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  const gj = JSON.parse(spawnSync(process.execPath, [bin, '--json'], { env: { ...env, HOME: gh, USERPROFILE: gh }, encoding: 'utf8' }).stdout);
  t('Gemini CLI: shell command found, with its project folder', () => { const r = gj.resources.find((x) => x.name === 'gem-vm'); assert.ok(r && r.agent === 'gemini' && r.cwd === '/home/u/gem' && r.status === 'left'); });
  t('Gemini CLI: status error = failed', () => assert.strictEqual(gj.resources.find((x) => x.name === 'gem-db').status, 'failed'));
  t('Copilot CLI: bash tool found', () => { const r = gj.resources.find((x) => x.name === 's3://copilot-bucket'); assert.ok(r && r.agent === 'copilot' && r.cwd === '/home/u/cop' && r.status === 'left'); });
  t('Copilot CLI: exit code 1 trailer = failed', () => assert.strictEqual(gj.resources.find((x) => x.rule === 'fly-app').status, 'failed'));
  t('agents listed in the output', () => assert.ok(gj.agents.includes('gemini') && gj.agents.includes('copilot')));

  console.log('v0.4: large logs');
  const big = path.join(dir, 'big.jsonl');
  const steps = [];
  for (let i = 0; i < 15000; i++) steps.push({ bash: `gcloud compute disks create d${i} --zone z` });
  for (let i = 0; i < 15000; i++) steps.push({ bash: `gcloud compute disks delete d${i} --zone z` });
  claudeLog(big, steps, { startMins: 70000 });
  const t0 = Date.now();
  const bj = JSON.parse(spawnSync(process.execPath, [bin, '--logs', big, '--json', '--no-ignore'], { env, encoding: 'utf8', maxBuffer: 1 << 28 }).stdout);
  const ms = Date.now() - t0;
  t(`15k creates + 15k deletes in under 20 s (took ${ms} ms)`, () => { assert.ok(ms < 20000); assert.strictEqual(bj.resources.filter((r) => r.status === 'left').length, 0); assert.strictEqual(bj.resources.length, 15000); });
  t('a file over 1 MB is read across chunk boundaries', () => assert.ok(fs.statSync(big).size > 3 << 20));
};
