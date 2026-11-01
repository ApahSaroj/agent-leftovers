'use strict';
// v0.4.2 fresh-eyes review (agent-leftovers-review/v042-fresh.md): every repro from the reviewer's
// case files (test/fixtures/fresh/cases1..6.json) is replayed through a real Claude Code log and the
// result compared with test/fixtures/fresh/expected.json, plus one targeted test per fix.
//
//   node test/fresh-test.js --update   rewrites expected.json from the current code (review the diff!)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readEvents } = require('../src/logs');
const { scan } = require('../src/scan');
const { tokenize, isNoop, procFind, setPlatform } = require('../src/shell');

const FIX = path.join(__dirname, 'fixtures', 'fresh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-fresh-'));
const iso = (m) => new Date(Date.UTC(2026, 9, 31, 12, 0, 0) - m * 60000).toISOString();

// A Claude Code session log from a list of steps: 'cmd', { cmd, bg, fail, out }, { write, content }, { mcp, input, out, fail }.
function claudeLog(file, steps, cwd = '/w/p', sid = 'p') {
  const L = []; let t = 2000; let n = 0;
  for (const s0 of steps) {
    const s = typeof s0 === 'string' ? { cmd: s0 } : s0;
    t -= 3; const id = `toolu_${++n}`;
    if (s.write) { L.push({ sessionId: sid, cwd, timestamp: iso(t), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: s.write, content: s.content } }] } }); continue; }
    const use = s.mcp ? { type: 'tool_use', id, name: s.mcp, input: s.input } : { type: 'tool_use', id, name: 'Bash', input: { command: s.cmd, description: 'x', ...(s.bg ? { run_in_background: true } : {}) } };
    L.push({ sessionId: sid, cwd, timestamp: iso(t), type: 'assistant', message: { role: 'assistant', content: [use] } });
    L.push({ sessionId: sid, cwd, timestamp: iso(t - 1), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: s.out || (s.mcp ? '{}' : 'ok'), is_error: !!s.fail }] } });
  }
  fs.writeFileSync(file, L.map((o) => JSON.stringify(o)).join('\n') + '\n');
  return file;
}
let fileN = 0;
const scanSteps = (steps, platform = 'linux') => scan(readEvents([{ tool: 'claude', file: claudeLog(path.join(tmp, `s${++fileN}.jsonl`), steps) }]), { platform });
const rowsOf = (r) => [
  ...r.resources.map((x) => `${x.status}:${x.rule}:${x.name} => ${x.runIn ? `[in ${x.runIn}] ` : ''}${x.teardown}`),
  ...r.spend.map((s) => `spend:${s.file} => ${s.teardown}`),
];
const rows = (steps) => rowsOf(scanSteps(steps));

const CASES = {};
for (let k = 1; k <= 6; k++) for (const [label, steps] of Object.entries(JSON.parse(fs.readFileSync(path.join(FIX, `cases${k}.json`), 'utf8')))) CASES[`cases${k}/${label}`] = steps;

if (require.main === module && process.argv.includes('--update')) {
  const out = {};
  for (const [k, steps] of Object.entries(CASES)) out[k] = rows(steps);
  fs.writeFileSync(path.join(FIX, 'expected.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(`wrote ${Object.keys(out).length} cases to ${path.join(FIX, 'expected.json')}`);
  process.exit(0);
}

module.exports = function (t, bin, env) {
  const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
  const R = {};
  for (const [k, steps] of Object.entries(CASES)) R[k] = rows(steps);
  const has = (k, re) => assert.ok(R[k].some((x) => re.test(x)), `${k}: no row matching ${re}\n         got: ${JSON.stringify(R[k])}`);
  const none = (k, re) => assert.ok(!R[k].some((x) => re.test(x)), `${k}: unexpected row matching ${re}\n         got: ${JSON.stringify(R[k])}`);

  // ---- the reviewer's repros, as fixed: every case has a reviewed expected result ----
  t(`fresh review: all ${Object.keys(CASES).length} reviewer repros are covered by expected.json`, () => assert.deepStrictEqual(Object.keys(CASES).sort(), Object.keys(expected).sort()));
  for (const k of Object.keys(CASES)) t(`fresh repro ${k}`, () => assert.deepStrictEqual(R[k], expected[k]));

  // ---- A1 wrappers ----
  t('A1 timeout 900 gcloud sql instances create is found', () => has('cases1/timeout-prefix', /^left:gcp-sql:ml-db => gcloud sql instances delete ml-db$/));
  t('A1 nohup ngrok http 8080 & is a tunnel', () => has('cases1/nohup-ngrok', /^left:tunnel-ngrok:/));
  t('A1 nohup gcloud compute instances create ... & is the VM, not a "gcloud" process', () => { has('cases1/nohup-gcloud', /^left:gcp-vm:nh-vm/); none('cases1/nohup-gcloud', /bg-process/); });
  t('A1 aws-vault exec P -- aws ec2 run-instances', () => has('cases1/aws-vault', /^left:aws-ec2:1 x p4d\.24xlarge/));
  t('A1 doppler run -- fly launch', () => has('cases1/doppler', /^left:fly-app:dop-app/));
  t('A1 op run -- terraform apply', () => has('cases1/op-run', /^left:iac-terraform:/));
  t('A1 pnpm exec / npm exec -- / bun x wrangler d1 create', () => { has('cases1/pnpm-exec', /cf-d1:pe-db/); has('cases1/npm-exec', /cf-d1:ne-db/); has('cases1/bun-x', /cf-d1:bx-db/); });
  t('A1 a create through aws-vault / doppler / op notes that the teardown needs the same wrapper', () => {
    const f = scanSteps(['aws-vault exec prod -- gcloud compute instances create av-vm --zone us-central1-a']).resources[0];
    assert.ok(f && /created through "aws-vault exec prod --": run the teardown the same way/.test(f.note || ''), JSON.stringify(f));
  });
  t('A1 tokenize strips nice -n, timeout -s SIG -k T DUR, env -u X, sudo -u U -E, setsid, stdbuf', () => {
    for (const c of ['nice -n 10 gcloud x', 'timeout -s KILL -k 5 10m gcloud x', 'env -u FOO A=1 gcloud x', 'sudo -u bob -E gcloud x', 'setsid gcloud x', 'stdbuf -oL gcloud x', 'nohup nice timeout 5 gcloud x', 'time -p gcloud x']) assert.deepStrictEqual([...tokenize(c)], ['gcloud', 'x'], c);
  });
  // ---- A2 shell keywords and grouping ----
  t('A2 ( ... ), { ...; }, if/then, for/do hide nothing', () => { has('cases1/subshell2', /^left:gcp-vm:sub-vm/); has('cases1/brace', /^left:gcp-vm:br-vm/); has('cases1/if-then', /^left:gcp-vm:it-vm/); has('cases1/for-do', /^left:gcp-vm:vm-\$z => gcloud compute instances delete <NAME> --zone '\$z'$/); });
  t('A2 (cd infra && terraform apply) names infra, and the cd ends at the )', () => {
    has('cases1/subshell', /^left:iac-terraform:\/w\/p\/infra => terraform -chdir=\/w\/p\/infra state list$/);
    const r = rows(['(cd infra && terraform apply -auto-approve) && docker compose up -d']);
    assert.ok(r.some((x) => /^left:docker-compose:\/w\/p =>/.test(x)), JSON.stringify(r));
  });
  // ---- A3 bash -lc ----
  t('A3 bash -lc / sh -ec unwrap the command string', () => {
    has('cases1/bash-lc', /^left:gcp-vm:lc-vm/);
    assert.ok(rows(["sh -ec 'gcloud compute instances create ec-vm --zone us-central1-a'"]).some((x) => /gcp-vm:ec-vm/.test(x)));
  });
  // ---- A4 docker -h ----
  t('A4 docker run -h HOST is --hostname, not help (but gcloud -h still is)', () => {
    has('cases1/docker-run-h', /^left:docker-run:pg/);
    assert.ok(isNoop(tokenize('gcloud compute instances create x -h')));
  });
  // ---- A5 foreground docker sent to the background ----
  t('A5 docker compose up with the background flag or & is listed', () => { has('cases2/compose-up-bgflag', /^left:docker-compose:\/w\/p/); has('cases2/compose-up-amp', /^left:docker-compose:\/w\/p/); });
  t('A5 docker run (no -d) with the background flag is listed', () => has('cases2/docker-run-bgflag', /^left:docker-run:pgfg/));
  t('A5 docker run / compose up in the foreground is still not listed', () => assert.deepStrictEqual(rows(['docker compose up', 'docker run --name fg postgres:16']), []));
  // ---- A6 ./scripts/up.sh ----
  t('A6 ./scripts/up.sh is read from scripts/, not <cwd>/up.sh', () => {
    has('cases1/write-then-run-dotslash-sub', /gcp-vm:ws2-vm/);
    const r = rows([{ write: '/w/p/up.sh', content: 'gcloud compute instances create wrong-vm --zone us-central1-a' }, { write: '/w/p/scripts/up.sh', content: 'gcloud compute instances create right-vm --zone us-central1-a' }, './scripts/up.sh']);
    assert.ok(r.some((x) => /right-vm/.test(x)) && !r.some((x) => /wrong-vm/.test(x)), JSON.stringify(r));
  });
  // ---- B1 process lookups never carry log text in double quotes ----
  t('B1 background-process teardowns are plain words (no $( ) ` " or quotes from the log)', () => {
    for (const k of ['cases3/bg-cmdsub', 'cases3/bg-backtick', 'cases3/bg-quote-dq', 'cases3/bg-flag-cmdsub', 'cases3/bg-script-weird', 'cases3/spend-weird-file', 'cases2/bg-word-injection', 'cases2/bg-word-quote']) {
      for (const x of R[k]) { const td = x.split(' => ')[1]; if (/^pgrep /.test(td)) assert.ok(/^pgrep -af [A-Za-z0-9._:@\/-]+$/.test(td), `${k}: ${td}`); }
    }
  });
  t('B1 Windows lookup: the PowerShell -match word is plain too (no $ ` \' ")', () => {
    const prev = setPlatform('win32');
    try {
      for (const w of ['$(id)', '`id`', "a'b", 'a"b', '$env:X', '-x']) {
        const td = procFind(w);
        const m = td.match(/-match '([^']*)'/);
        assert.ok(m && /^[A-Za-z0-9._:@\/-]+$/.test(m[1]) && !m[1].startsWith('-'), td);
      }
    } finally { setPlatform(prev); }
    const r = rowsOf(scanSteps([{ cmd: '"$(id)" serve', bg: true }, 'nohup "`id`" --x &'], 'win32'));
    for (const x of r) assert.ok(!/[$`]/.test(x.split(' => ')[1]), x);
  });
  t('B1 a word starting with - can never become a pgrep flag', () => { const prev = setPlatform('linux'); try { assert.ok(/^pgrep -af \.x/.test(procFind('-x'))); } finally { setPlatform(prev); } });
  // ---- B2 EC2 --filters ----
  t('B2 --region goes after the EC2 --filters value, not inside it', () => {
    has('cases3/aws-tag-region-filter', /--filters Name=instance-state-name,Values=running --query "Reservations\[\]\.Instances\[\]\.InstanceId" --region us-east-2$/);
    has('cases2/region-then-delete-noregion', /Values=running --query .* --region eu-west-1$/);
  });
  // ---- B3 odd --context / -n values ----
  t('B3 kubectl --context with shell characters becomes --context <CONTEXT>', () => has('cases3/k8s-ctx-flag', /kubectl delete service web --context <CONTEXT>$/));
  t('B3 kubectl -n / helm -n with shell characters become -n <NAMESPACE>', () => { has('cases3/k8s-ns-weird', /kubectl delete service web -n <NAMESPACE>$/); has('cases3/helm-ns-weird', /helm uninstall rel -n <NAMESPACE>$/); });
  t('B3 normal contexts, namespaces and EKS ARNs are kept as is', () => { has('cases4/k8s-ctx-before', /--context prod-east$/); has('cases4/helm-ns-before', /-n db$/); has('cases5/eks-arn-ctx', /--context arn:aws:eks:us-east-1:123456789012:cluster\/prod$/); });
  t('B3 a delete with an odd namespace does not clear anything', () => {
    const r = rows(["kubectl expose deployment web --type=LoadBalancer --port 80 -n shop", "kubectl delete service web -n 'x;id'"]);
    assert.ok(r.some((x) => /^left:k8s-lb-service:web \(ns shop\)/.test(x)), JSON.stringify(r));
  });
  // ---- C1 grep / ps ----
  t('C1 grep -rn nohup and ps aux | grep nohup are not background processes', () => { assert.deepStrictEqual(R['cases1/grep-nohup'], []); assert.deepStrictEqual(R['cases1/ps-grep'], []); });
  // ---- C2 -refresh-only ----
  t('C2 terraform apply -refresh-only is not a create', () => assert.deepStrictEqual(R['cases1/tf-refresh-only'], []));
  // ---- C3 pkill / kill ----
  t('C3 pkill -f server.js after node server.js & clears it', () => has('cases1/pkill-bg', /^cleaned:bg-process:server\.js/));
  t('C3 kill %1 after nohup python3 worker.py & is a maybe', () => has('cases1/kill-bg', /^maybe-cleaned:bg-process:worker\.py/));
  t('C3 killall NAME and kill $(pgrep -f X) clear; pkill of something else does not; a pkill before the start does not', () => {
    assert.ok(rows(['nohup uvicorn app:app &', 'killall uvicorn']).some((x) => /^cleaned:bg-process:uvicorn/.test(x)));
    assert.ok(rows(['node api.js &', 'kill $(pgrep -f api.js)']).some((x) => /^cleaned:bg-process:api\.js/.test(x)));
    assert.ok(rows(['node api.js &', 'pkill -f worker.js']).some((x) => /^left:bg-process:api\.js/.test(x)));
    assert.ok(rows(['pkill -f api.js', 'node api.js &']).some((x) => /^left:bg-process:api\.js/.test(x)));
  });
  t('C3 a failed pkill (nothing matched) clears nothing', () => assert.ok(rows(['node api.js &', { cmd: 'pkill -f api.js', fail: true }]).some((x) => /^left:bg-process:api\.js/.test(x))));
  // ---- C4 duplicate and broad rows ----
  t('C4 gcloud ... create & gives one row (the VM), no bg-process "gcloud"', () => assert.deepStrictEqual(R['cases1/gcloud-bg'], ['left:gcp-vm:bgvm => gcloud compute instances delete bgvm --zone us-central1-a']));
  t('C4 python3 -m http.server & looks up the module, not every python3', () => { has('cases6/redirect-amp', /^left:bg-process:http\.server => pgrep -af http\.server$/); none('cases6/redirect-amp', /pgrep -af python3$/); });
  // ---- D1 long lines ----
  t('D1 a 24 MB log line is copied once, not once per 1 MB chunk, and the next line is still read', () => {
    const f = path.join(tmp, 'long.jsonl');
    const head = JSON.stringify({ sessionId: 'L', cwd: '/w', timestamp: iso(5), type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'PLACEHOLDER' }] } });
    const [a, b] = head.split('PLACEHOLDER');
    const fd = fs.openSync(f, 'w');
    fs.writeSync(fd, a); fs.writeSync(fd, 'x'.repeat(24 << 20)); fs.writeSync(fd, b + '\n');
    fs.writeSync(fd, JSON.stringify({ sessionId: 'L', cwd: '/w', timestamp: iso(4), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tl', name: 'Bash', input: { command: 'gcloud compute instances create after-long --zone us-central1-a' } }] } }) + '\n');
    fs.closeSync(fd);
    // Count the bytes Buffer.concat copies while reading: linear is about one line's worth
    // (the old reader copied the growing line on every chunk: ~300 MB for this file).
    const realConcat = Buffer.concat;
    let copied = 0;
    Buffer.concat = function (list, len) { const r = realConcat.call(Buffer, list, len); copied += r.length; return r; };
    let evs;
    try { evs = readEvents([{ tool: 'claude', file: f }]); } finally { Buffer.concat = realConcat; fs.unlinkSync(f); }
    assert.ok(evs.some((e) => /after-long/.test(e.command || '')), 'line after the long one was lost');
    assert.ok(copied < 3 * (24 << 20), `copied ${Math.round(copied / 1048576)} MB for a 24 MB line`);
  });
  // ---- D2 README --force ----
  t('D2 README says where --force is used (fly machine destroy) instead of "never"', () => {
    const md = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    assert.ok(!/No `--quiet`, `--yes`, `--force`/.test(md));
    assert.ok(/fly machine destroy <ID> --force/.test(md));
  });
  // ---- D3 exit codes, D4 filtered views (through the CLI) ----
  const lf = claudeLog(path.join(tmp, 'cli.jsonl'), ['gcloud compute instances create exit-vm --zone us-central1-a']);
  const cli = (args) => spawnSync(process.execPath, [bin, '--logs', lf, '--no-ignore', ...args], { env, encoding: 'utf8' });
  t('D3 --brief and --script exit 1 when leftovers are found, as documented', () => { assert.strictEqual(cli(['--brief']).status, 1); assert.strictEqual(cli(['--script']).status, 1); assert.strictEqual(cli(['--json']).status, 1); });
  t('D3 --exit-zero exits 0 with the same output (the SessionStart hook uses it)', () => {
    const r = cli(['--brief', '--exit-zero']);
    assert.strictEqual(r.status, 0); assert.ok(/exit-vm/.test(r.stdout));
    assert.ok(/--exit-zero/.test(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')));
  });
  t('D3 --brief exits 0 and prints nothing when all is clear', () => {
    const clean = claudeLog(path.join(tmp, 'clean.jsonl'), ['ls -la']);
    const r = spawnSync(process.execPath, [bin, '--logs', clean, '--brief'], { env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout.trim(), '');
  });
  t('D4 --expired / --tag with no match say so, and how many items the filter hid', () => {
    const e = cli(['--expired']);
    assert.ok(/Nothing matches the filter \(expired\)\. 1 other item is still listed without it/.test(e.stdout), e.stdout);
    assert.ok(!/Nothing left running/.test(e.stdout));
    const g = cli(['--tag', 'team=x']);
    assert.ok(/Nothing matches the filter \(tag team=x\)/.test(g.stdout) && /--tag/.test(g.stdout), g.stdout);
    assert.strictEqual(e.status, 0);
  });
};

if (require.main === module) {
  let pass = 0; let fail = 0;
  const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };
  const bin = path.join(__dirname, '..', 'bin', 'agent-leftovers.js');
  module.exports(t, bin, { ...process.env, NO_COLOR: '1' });
  console.log(`${fail ? 'FAIL' : 'PASS'} ${pass}/${pass + fail}`);
  process.exit(fail ? 1 : 0);
}
