'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { splitCommands, tokenize } = require('../src/shell');
const { make } = require('./make-fixtures');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('shell parsing');
t('splits && ; | and newlines', () => assert.deepStrictEqual(splitCommands('a && b; c | d\ne || f'), ['a', 'b', 'c', 'd', 'e', 'f']));
t('keeps quoted separators', () => assert.deepStrictEqual(splitCommands('echo "a && b"; x'), ['echo "a && b"', 'x']));
t('strips env, sudo, npx@version', () => assert.deepStrictEqual(tokenize('FOO=1 sudo npx wrangler@3.2.1 d1 create db'), ['wrangler', 'd1', 'create', 'db']));
t('strips quotes', () => assert.deepStrictEqual(tokenize(`gcloud run deploy 'my svc' --region="us-east1"`), ['gcloud', 'run', 'deploy', 'my svc', '--region=us-east1']));

// Run the CLI against a fake HOME with realistic logs.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-home-'));
make(home);
const bin = path.join(__dirname, '..', 'bin', 'agent-leftovers.js');
const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', NO_COLOR: '1' };
delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
const run = (args) => spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });

const j = JSON.parse(run(['--json']).stdout);
const left = j.resources.filter((r) => r.status === 'left');
const by = (rule, name) => j.resources.find((r) => r.rule === rule && (!name || r.name === name));

console.log('detection');
t('finds the GPU VM with zone in teardown', () => {
  const r = by('gcp-vm', 'llm-worker-1');
  assert.ok(r && r.status === 'left');
  assert.strictEqual(r.teardown, 'gcloud compute instances delete llm-worker-1 --zone us-central1-a --quiet');
});
t('finds the 250 GB disk (--zone=)', () => assert.ok(by('gcp-disk', 'scratch-250').teardown.includes('--zone us-central1-a')));
t('gcloud beta run deploy after cd', () => assert.ok(by('gcp-run', 'pdf-api').teardown.includes('--region us-central1')));
t('both enabled APIs listed', () => { assert.ok(by('gcp-api', 'aiplatform.googleapis.com')); assert.ok(by('gcp-api', 'run.googleapis.com')); });
t('failed Cloud SQL create marked failed', () => assert.strictEqual(by('gcp-sql', 'pdf-db').status, 'failed'));
t('bucket made and removed in one line is cleaned', () => assert.strictEqual(by('aws-s3', 's3://tmp-test-bucket-123').status, 'cleaned'));
t('$RANDOM name flagged as unknown with <NAME>', () => { const r = j.resources.find((x) => x.rule === 'gcp-vm' && x.nameUnknown); assert.ok(r && r.teardown.includes('<NAME>')); });
t('codex: d1 via npx', () => assert.strictEqual(by('cf-d1', 'site-db').teardown, 'wrangler d1 delete site-db'));
t('codex: r2 created then deleted = cleaned', () => assert.strictEqual(by('cf-r2', 'site-assets').status, 'cleaned'));
t('codex: worker deploy via npx wrangler@latest', () => assert.ok(by('cf-worker')));
t('codex: fly app named', () => assert.strictEqual(by('fly-app', 'site-preview').teardown, 'fly apps destroy site-preview --yes'));
t('codex exec_command style parsed', () => assert.ok(by('supabase-fn', 'notify')));
t('codex: non-zero exit = failed', () => assert.strictEqual(by('aws-rds', 'site-pg').status, 'failed'));
t('ec2 named from tag spec', () => assert.strictEqual(by('aws-ec2').name, 'load-tester'));
t('ssh / echo noise ignored', () => assert.ok(!j.resources.some((r) => /ssh|echo/.test(r.command))));

console.log('paid AI spend');
const py = j.spend.find((s) => s.file.endsWith('batch_summarize.py'));
t('python OpenAI loop script, run in background', () => { assert.ok(py); assert.strictEqual(py.api, 'OpenAI'); assert.ok(py.loop && py.background); assert.ok(py.teardown.startsWith('pkill -f "batch_summarize.py"')); });
const js = j.spend.find((s) => s.file.endsWith('gen-alt-text.js'));
t('codex apply_patch Anthropic script detected', () => { assert.ok(js); assert.strictEqual(js.api, 'Anthropic'); assert.ok(js.loop); });
t('curl loop to OpenAI detected', () => assert.ok(j.spend.find((s) => s.file === '(shell loop)')));

console.log('output');
t('counts', () => assert.strictEqual(left.length, 11, 'left=' + left.map((r) => r.rule + ':' + r.name).join(',')));
const txt = run([]);
t('text output headline', () => assert.ok(/11 things your agent created and never turned off/.test(txt.stdout), txt.stdout.slice(0, 400)));
t('exit code 1 when leftovers', () => assert.strictEqual(txt.status, 1));
const sc = run(['--script']).stdout;
t('--script lines all commented', () => assert.ok(sc.split('\n').filter((l) => l.trim() && !l.startsWith('#!')).every((l) => l.startsWith('#'))));
t('--project filter', () => { const k = JSON.parse(run(['--json', '--project', 'site']).stdout); assert.ok(k.resources.every((r) => r.agent === 'codex')); });
t('--logs path works', () => { const k = JSON.parse(run(['--json', '--logs', path.join(home, '.codex')]).stdout); assert.ok(k.resources.length > 0 && k.resources.every((r) => r.agent === 'codex')); });
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'al-empty-'));
t('friendly message when no logs', () => { const r = spawnSync(process.execPath, [bin], { env: { ...env, HOME: empty, USERPROFILE: empty }, encoding: 'utf8' }); assert.strictEqual(r.status, 2); assert.ok(/no Claude Code or Codex session logs/.test(r.stderr)); });

console.log('codex variants');
const zh = fs.mkdtempSync(path.join(os.tmpdir(), 'al-zst-'));
const zd = path.join(zh, '.codex', 'sessions', '2026', '10', '20');
fs.mkdirSync(zd, { recursive: true });
const now = new Date().toISOString();
const lines = [
  { timestamp: now, type: 'session_meta', payload: { session_id: 's-zst', cwd: '/w/old' } },
  { timestamp: now, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'gcloud sql instances create old-db --tier db-f1-micro', workdir: '/w/old' }), call_id: 'c1' } },
  { timestamp: now, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Command: gcloud sql ...\nProcess exited with code 0\nOutput: done' } },
  { timestamp: now, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'heroku create broken-app' }), call_id: 'c2' } },
  { timestamp: now, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: 'Command: heroku create\nProcess exited with code 1\nOutput: auth error' } },
].map((o) => JSON.stringify(o)).join('\n');
const zlib = require('zlib');
if (zlib.zstdCompressSync) {
  fs.writeFileSync(path.join(zd, 'rollout-old.jsonl.zst'), zlib.zstdCompressSync(Buffer.from(lines)));
  const k = JSON.parse(spawnSync(process.execPath, [bin, '--json'], { env: { ...env, HOME: zh, USERPROFILE: zh }, encoding: 'utf8' }).stdout);
  t('reads compressed .jsonl.zst rollouts', () => assert.ok(k.resources.find((r) => r.name === 'old-db' && r.status === 'left')));
  t('"Process exited with code 1" = failed', () => assert.strictEqual(k.resources.find((r) => r.rule === 'heroku-create').status, 'failed'));
} else console.log('  skip zst (old Node)');

// ---------------- v0.2: MCP ----------------
console.log('mcp tool names');
const mcp = require('../src/mcp');
for (const [full, kind, noun] of require('./mcp-classify')) {
  t(`${full} -> ${kind ? kind + ' ' + noun : 'ignored'}`, () => {
    const sp = mcp.splitName(full);
    const c = sp && mcp.classify(sp.server, sp.tool);
    assert.strictEqual(c ? c.kind : null, kind);
    if (kind) assert.strictEqual(c.noun, noun);
  });
}

console.log('mcp in session logs');
const { makeMcp } = require('./mcp-fixtures');
const mh = fs.mkdtempSync(path.join(os.tmpdir(), 'al-mcp-'));
makeMcp(mh);
const menv = { ...env, HOME: mh, USERPROFILE: mh };
const mrun = (args, extra = {}) => spawnSync(process.execPath, [bin, ...args], { env: { ...menv, ...extra }, encoding: 'utf8' });
const m = JSON.parse(mrun(['--json']).stdout);
const mf = (pred) => m.resources.find(pred);
t('supabase project from MCP, named with its ref', () => {
  const r = mf((x) => x.rule === 'mcp-supabase-project' && x.id === 'qwertyref123');
  assert.ok(r && r.status === 'left' && r.via === 'mcp' && r.server === 'supabase');
  assert.ok(r.teardown.startsWith('supabase projects delete qwertyref123'));
  assert.strictEqual(r.cost, 'hourly');
});
t('supabase edge function found', () => assert.ok(mf((x) => x.rule === 'mcp-supabase-function' && x.status === 'left')));
t('migration / list / sql calls ignored', () => assert.ok(!m.resources.some((x) => /apply_migration|list_projects/.test(x.command))));
t('neon branch created then deleted = cleaned', () => assert.strictEqual(mf((x) => x.rule === 'mcp-neon-branch').status, 'cleaned'));
t('github branch and issue ignored', () => assert.ok(!m.resources.some((x) => /github/.test(x.command))));
t('is_error MCP create = failed', () => assert.strictEqual(mf((x) => x.rule === 'mcp-cloudflare-database').status, 'failed'));
t('"Error:" text result = failed', () => assert.strictEqual(mf((x) => x.rule === 'mcp-supabase-project' && /saas-prod/.test(x.name)).status, 'failed'));
t('vercel deploy id pulled from prose result', () => assert.strictEqual(mf((x) => x.rule === 'mcp-vercel-deployment').id, 'dpl_abc'));
t('codex event_msg MCP call (e2b sandbox)', () => { const r = mf((x) => x.rule === 'mcp-e2b-sandbox' && x.status === 'left'); assert.ok(r && r.id === 'sbx_99' && r.agent === 'codex'); });
t('codex server__tool function call (droplet)', () => { const r = mf((x) => x.rule === 'mcp-digitalocean-instance'); assert.ok(r && r.status === 'left' && r.teardown.startsWith('doctl compute droplet delete 4455')); });
t('codex MCP Err = failed', () => assert.ok(m.resources.some((x) => x.rule === 'mcp-e2b-sandbox' && x.status === 'failed')));
const mleft = m.resources.filter((x) => x.status === 'left');
t('mcp left count = 5', () => assert.strictEqual(mleft.length, 5, mleft.map((x) => x.rule + ':' + x.name).join(', ')));
const mtxt = mrun([]).stdout;
t('text output says via MCP', () => assert.ok(/via MCP: supabase/.test(mtxt)));
t('text output suggests --verify', () => assert.ok(/Add --verify/.test(mtxt)));

// ---------------- v0.2: --verify ----------------
console.log('--verify');
const vh = fs.mkdtempSync(path.join(os.tmpdir(), 'al-ver-'));
make(vh); makeMcp(vh);
const fb = path.join(vh, 'fakebin');
const { makeFakeBin } = require('./fake-cli');
const calls = makeFakeBin(fb);
const venv = { ...env, HOME: vh, USERPROFILE: vh, PATH: fb };
const vrun = (args) => spawnSync(process.execPath, [bin, ...args], { env: venv, encoding: 'utf8' });
vrun(['--json']);
t('without --verify nothing is executed', () => assert.strictEqual(fs.readFileSync(calls, 'utf8'), ''));
const v = JSON.parse(vrun(['--json', '--verify']).stdout);
const vf = (rule, name) => v.resources.find((r) => r.rule === rule && (!name || r.name === name || r.id === name));
t('existing VM confirmed', () => { const r = vf('gcp-vm', 'llm-worker-1'); assert.strictEqual(r.live, 'exists'); assert.strictEqual(r.status, 'left'); });
t('deleted disk marked gone', () => { const r = vf('gcp-disk', 'scratch-250'); assert.strictEqual(r.live, 'gone'); assert.strictEqual(r.status, 'gone'); });
t('permission error = unknown, stays left', () => { const r = vf('gcp-run', 'pdf-api'); assert.strictEqual(r.live, 'unknown'); assert.strictEqual(r.status, 'left'); assert.ok(/PERMISSION_DENIED/.test(r.liveNote)); });
t('enabled API confirmed, other API gone', () => { assert.strictEqual(vf('gcp-api', 'aiplatform.googleapis.com').live, 'exists'); assert.strictEqual(vf('gcp-api', 'run.googleapis.com').live, 'gone'); });
t('EC2 by Name tag confirmed', () => assert.strictEqual(vf('aws-ec2').live, 'exists'));
t('missing CLI = unknown, not gone', () => { const r = vf('fly-app', 'site-preview'); assert.strictEqual(r.live, 'unknown'); assert.ok(/not installed/.test(r.liveNote)); });
t('MCP supabase project confirmed via supabase CLI', () => assert.strictEqual(vf('mcp-supabase-project', 'qwertyref123').live, 'exists'));
t('MCP vercel deployment gone', () => assert.strictEqual(vf('mcp-vercel-deployment').status, 'gone'));
t('$RANDOM name is not checked', () => assert.strictEqual(v.resources.find((r) => r.rule === 'gcp-vm' && r.nameUnknown).liveNote, 'name not in the log'));
const logged = fs.readFileSync(calls, 'utf8').trim().split('\n');
t('every call made was read-only', () => {
  assert.ok(logged.length >= 6, 'calls: ' + logged.length);
  for (const l of logged) assert.ok(/\b(describe|list|inspect|describe-instances)\b/.test(l) && !/\b(delete|create|rm|terminate|destroy)\b/.test(l), l);
});
t('summary counts in JSON', () => { assert.ok(v.verified.checked >= 6); assert.ok(v.verified.gone >= 3); });
const vtxt = vrun(['--verify']);
t('text shows checked status and summary', () => { assert.ok(/\[checked: still exists\]/.test(vtxt.stdout)); assert.ok(/--verify: ran [0-9]+ read-only check/.test(vtxt.stdout)); });
t('gone items do not count toward exit code', () => assert.strictEqual(vtxt.status, 1));

console.log('verify safety');
const ver = require('../src/verify');
const { rules } = require('../src/rules');
t('every check for every rule is read-only', () => {
  const ids = [...rules.map((r) => r.id), 'mcp-supabase-project', 'mcp-neon-project', 'mcp-vercel-deployment', 'mcp-cloudflare-database', 'mcp-cloudflare-bucket'];
  let n = 0;
  for (const id of ids) {
    const chk = ver.checkFor({ rule: id, name: 'thing-1', id: 'thing-1', command: 'x --zone z --region r --project p' });
    if (!chk) continue;
    n++;
    ver.assertReadOnly(chk.cmd, chk.args, ['thing-1']);
  }
  assert.ok(n >= 20, 'checks: ' + n);
});
t('write commands are refused', () => assert.throws(() => ver.assertReadOnly('gcloud', ['compute', 'instances', 'delete', 'x'])));
t('odd characters in a name are never run', () => {
  const f = { rule: 'gcp-vm', name: "vm'; rm -rf ~", command: 'gcloud compute instances create x', status: 'left' };
  ver.verify([f]);
  assert.strictEqual(f.live, 'unknown'); assert.ok(/unusual characters/.test(f.liveNote));
});

require('./k8s-test')(t, bin, env);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
