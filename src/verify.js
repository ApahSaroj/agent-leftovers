'use strict';
// --verify: ask the user's own cloud CLIs whether each leftover still exists.
// Opt-in only. Every command here is a read-only describe/list/get call, checked
// against an allow-list before it runs. Names from the logs must look like real
// resource names (never starting with "-"), the CLI is found on PATH ourselves
// (never in the current folder), and it runs from the temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { k8sCheck } = require('./k8s');

const READ_VERBS = new Set(['describe', 'list', 'get', 'info', 'head-bucket', 'inspect', 'status', 'exists', 'show', 'get-function', 'describe-instances', 'describe-db-instances', 'describe-db-clusters', 'describe-table', 'apps:info', 'ps', 'describe-volumes', 'get-resources']);
const WRITE_WORDS = /^(delete|destroy|remove|rm|rb|terminate|create|deploy|stop|start|update|put|enable|disable|apply|kill|scale|launch|mb|undeploy|exec|patch|edit|login|logout)$|^(delete|terminate|create|put|update|remove|stop|start)-/;
// A value we pass as an argument: no shell or cmd.exe metacharacters, never a flag.
const SAFE_ARG = /^[A-Za-z0-9._:/=,@+\-[\]()^${}]+$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,250}$/;

// What "it's gone" looks like for each CLI. Anything else that fails is "couldn't check",
// never "gone": offline, signed out, wrong context and permission errors all land here.
const GONE = {
  gcloud: /was not found|\bNOT_FOUND\b|HTTPError 404|Cannot find service|\bNotFoundError\b|instance does not exist|The requested resource was not found/i,
  aws: /\((404|NoSuchBucket|NotFound|ResourceNotFoundException|DBInstanceNotFound(?:Fault)?|DBClusterNotFoundFault|InvalidInstanceID\.NotFound|InvalidVolume\.NotFound|NoSuchEntity)\)/,
  kubectl: /Error from server \(NotFound\)/,
  helm: /release: not found/i,
  fly: /Could not find App|app not found/i,
  heroku: /Couldn't find that app/i,
  wrangler: /Couldn't find DB|does not exist \[code: 10006\]|The specified bucket does not exist|\[code: 7404\]/i,
  neonctl: /\bnot found\b.*\b(404|project)\b|\b404\b.*not found/i,
  doctl: /could not be found|\b404\b/i,
  vercel: /Can't find the deployment|deployment not found|\b404\b/i,
  docker: /$^/, // docker ps answers "exists" through its output
};
const NOT_GONE = /no such host|could not connect|connection refused|timed? ?out|unable to connect|network|credentials|not logged in|login|unauthori[sz]ed|forbidden|permission|access denied|expired|context .* does not exist|current-context|kubeconfig|ENOTFOUND|EAI_AGAIN|certificate/i;

function opt(args, name, v) { if (v) args.push(name, v); return args; }
function strip(n, pre) { return n && n.startsWith(pre) ? n.slice(pre.length) : n; }

function argsFrom(f) {
  // Region / zone from the original command; project, profile and region from the scope.
  const t = String(f.command || '').split(/\s+/);
  const val = (names) => { for (let i = 0; i < t.length; i++) for (const n of names) { if (t[i] === n && t[i + 1] && !t[i + 1].startsWith('-')) return t[i + 1]; if (t[i].startsWith(n + '=')) return t[i].slice(n.length + 1); } return null; };
  const sc = f.scope || {};
  return { zone: val(['--zone']), region: val(['--region', '--location']) || sc.region || null, project: sc.project || val(['--project']), profile: sc.profile || null, global: t.includes('--global') };
}

// Returns { cmd, args, exists?(stdout), gone?(stdout) } or null when we don't know how to check it.
function checkFor(f) {
  const a = argsFrom(f);
  const n = f.id || f.name;
  const g = (...x) => ({ cmd: 'gcloud', args: opt([...x, '--quiet'], '--project', a.project) });
  const aw = (...x) => ({ cmd: 'aws', args: opt(opt([...x], '--profile', a.profile), '--region', a.region) });
  switch (f.rule) {
    case 'gcp-vm': return g('compute', 'instances', 'describe', n, ...(a.zone ? ['--zone', a.zone] : []), '--format=value(name)');
    case 'gcp-disk': return g('compute', 'disks', 'describe', n, ...(a.zone ? ['--zone', a.zone] : []), '--format=value(name)');
    case 'gcp-ip': return g('compute', 'addresses', 'describe', n, ...(a.global ? ['--global'] : a.region ? ['--region', a.region] : []), '--format=value(name)');
    case 'gcp-kept-disk': return f.diskName ? g('compute', 'disks', 'describe', f.diskName, ...(a.zone ? ['--zone', a.zone] : []), '--format=value(name)') : null;
    case 'aws-kept-ebs': return f.volumeId ? aw('ec2', 'describe-volumes', '--volume-ids', f.volumeId, '--query', 'Volumes[].State', '--output', 'text') : null;
    case 'gcp-sql': return g('sql', 'instances', 'describe', n, '--format=value(name)');
    case 'gcp-gke': return g('container', 'clusters', 'describe', n, ...(a.zone ? ['--zone', a.zone] : a.region ? ['--region', a.region] : []), '--format=value(name)');
    case 'gcp-redis': return g('redis', 'instances', 'describe', n, ...(a.region ? ['--region', a.region] : []), '--format=value(name)');
    case 'gcp-run': return g('run', 'services', 'describe', n, ...(a.region ? ['--region', a.region] : []), '--format=value(metadata.name)');
    case 'gcp-fn': return g('functions', 'describe', n, ...(a.region ? ['--region', a.region] : []), '--format=value(name)');
    case 'gcp-bucket': case 'gcp-gsutil-mb': return g('storage', 'buckets', 'describe', n.startsWith('gs://') ? n : `gs://${n}`, '--format=value(name)');
    case 'gcp-api': return { ...g('services', 'list', '--enabled', `--filter=config.name:${n}`, '--format=value(config.name)'), exists: (out) => out.includes(n), gone: (out) => !out.includes(n) };
    case 'aws-s3': case 'aws-s3api': return aw('s3api', 'head-bucket', '--bucket', strip(n, 's3://'));
    case 'aws-ec2':
      if (/ x /.test(n)) return null; // no name tag, only "2 x t3.large"
      return { ...aw('ec2', 'describe-instances', '--filters', `Name=tag:Name,Values=${n}`, 'Name=instance-state-name,Values=pending,running,stopping,stopped', '--query', 'Reservations[].Instances[].InstanceId', '--output', 'text'), exists: (out) => /\bi-[0-9a-f]+/.test(out), gone: (out) => !/\bi-[0-9a-f]+/.test(out) && /^\s*(None)?\s*$/.test(out) };
    case 'aws-rds': return aw('rds', 'describe-db-instances', '--db-instance-identifier', n);
    case 'aws-rds-cluster': return aw('rds', 'describe-db-clusters', '--db-cluster-identifier', n);
    case 'aws-lambda': return aw('lambda', 'get-function', '--function-name', n);
    case 'aws-dynamo': return aw('dynamodb', 'describe-table', '--table-name', n);
    case 'az-group': return { cmd: 'az', args: ['group', 'exists', '--name', n], exists: (out) => /true/i.test(out), gone: (out) => /^\s*false\s*$/i.test(out) };
    case 'fly-app': case 'fly-deploy': return { cmd: 'fly', args: ['status', '-a', n] };
    case 'heroku-create': return { cmd: 'heroku', args: ['apps:info', '-a', n] };
    case 'cf-d1': case 'mcp-cloudflare-database': return { cmd: 'wrangler', args: ['d1', 'info', n] };
    case 'cf-r2': case 'mcp-cloudflare-bucket': return { cmd: 'wrangler', args: ['r2', 'bucket', 'info', n] };
    case 'mcp-supabase-project': return f.id ? { cmd: 'supabase', args: ['projects', 'list', '-o', 'json'], exists: (out) => out.includes(f.id), gone: (out) => /^\s*\[/.test(out) && !out.includes(f.id) } : null;
    case 'mcp-neon-project': return f.id ? { cmd: 'neonctl', args: ['projects', 'get', f.id] } : null;
    case 'mcp-digitalocean-instance': return { cmd: 'doctl', args: ['compute', 'droplet', 'get', n] };
    case 'mcp-vercel-deployment': return f.id ? { cmd: 'vercel', args: ['inspect', f.id] } : null;
    case 'docker-run': return { cmd: 'docker', args: ['ps', '-a', '--filter', `name=^/${n}$`, '--format', '{{.Names}}'], exists: (out) => out.split(/\r?\n/).includes(n), gone: (out) => !out.split(/\r?\n/).includes(n) };
    default: return k8sCheck(f);
  }
}

function assertReadOnly(cmd, args, names = []) {
  const words = args.filter((a) => !a.startsWith('-') && !names.some((n) => n && a.includes(n)));
  if (!words.some((w) => READ_VERBS.has(w))) throw new Error(`refusing non-read command: ${cmd} ${args.join(' ')}`);
  if (words.some((w) => WRITE_WORDS.test(w) && !READ_VERBS.has(w))) throw new Error(`refusing write verb: ${cmd} ${args.join(' ')}`);
}

// Find the CLI on PATH ourselves. Skips empty, "." and relative PATH entries, so a
// gcloud.cmd sitting in a cloned repo can never be the one that runs.
function resolveBin(cmd, env = process.env) {
  const win = process.platform === 'win32';
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter((d) => d && d !== '.' && path.isAbsolute(d));
  const exts = win ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, cmd + e);
      try { const st = fs.statSync(p); if (st.isFile()) return p; } catch { /* next */ }
    }
  }
  return null;
}

function classify(cmd, r, chk) {
  const out = (r.stdout || '') + '';
  const err = (r.stderr || '') + '';
  if (r.error && r.error.code === 'ETIMEDOUT') return { live: 'unknown', note: `${cmd} timed out` };
  if (r.error) return { live: 'unknown', note: `${cmd}: ${r.error.code || r.error.message}` };
  if (r.status === 0) {
    if (chk.exists && chk.exists(out)) return { live: 'exists' };
    if (chk.gone && chk.gone(out)) return { live: 'gone' };
    if (chk.exists) return { live: 'unknown', note: `${cmd}: unexpected answer` };
    return { live: 'exists' };
  }
  const text = `${err}\n${out}`;
  const re = GONE[cmd];
  if (re && re.test(text) && !NOT_GONE.test(text.replace(re, ''))) return { live: 'gone' };
  const first = (err || out).split('\n').map((s) => s.trim()).find(Boolean) || `exit ${r.status}`;
  return { live: 'unknown', note: `${cmd}: ${first.slice(0, 80)}` };
}

// Runs one allow-listed read-only call the safe way: CLI resolved on PATH by us (never the
// current folder), run from the temp folder, every argument within SAFE_ARG.
// Returns the spawnSync result, or { missing: true } when the CLI isn't installed.
function runRead(chk, timeoutMs, names = [], env = process.env, maxBuffer = 64 * 1024 * 1024) {
  assertReadOnly(chk.cmd, chk.args, names);
  if (!chk.args.every((a) => SAFE_ARG.test(a))) throw new Error(`refusing unusual argument: ${chk.cmd} ${chk.args.join(' ')}`);
  const bin = resolveBin(chk.cmd, env);
  if (!bin) return { missing: true };
  const win = process.platform === 'win32';
  const opts = { encoding: 'utf8', timeout: timeoutMs, cwd: os.tmpdir(), windowsHide: true, maxBuffer, env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' } };
  // .cmd/.bat need cmd.exe; args are already limited to SAFE_ARG (no quotes, %, &, |, <, >).
  return win && /\.(cmd|bat)$/i.test(bin)
    ? spawnSync(`"${bin}" ${chk.args.map((a) => `"${a}"`).join(' ')}`, { ...opts, shell: true })
    : spawnSync(bin, chk.args, opts);
}

function runCheck(chk, timeoutMs, names, env = process.env) {
  const r = runRead(chk, timeoutMs, names, env);
  if (r.missing) return { live: 'unknown', note: `${chk.cmd} CLI not installed` };
  return classify(chk.cmd, r, chk);
}

function namesOk(f) {
  const main = f.id || f.k8sName || f.name;
  const vals = [main, f.ns, f.ctx, f.scope && f.scope.project, f.scope && f.scope.profile, f.scope && f.scope.region].filter((v) => v != null && v !== '');
  return vals.every((v) => SAFE_NAME.test(String(v).replace(/^(gs|s3):\/\//, '')) ) && !String(main).startsWith('-');
}

function verify(resources, { timeoutMs = 20000, max = 50, env = process.env } = {}) {
  const stats = { checked: 0, gone: 0, exists: 0, unknown: 0, skipped: 0 };
  for (const f of resources) {
    if (f.status !== 'left' && f.status !== 'maybe-cleaned') continue;
    if (f.nameUnknown) { f.live = 'unknown'; f.liveNote = 'name not in the log'; stats.skipped++; continue; }
    if (!namesOk(f)) { f.live = 'unknown'; f.liveNote = 'name has unusual characters, not checked'; stats.skipped++; continue; }
    const chk = checkFor(f);
    if (!chk) { f.live = 'unknown'; f.liveNote = 'no read-only check for this type yet'; stats.skipped++; continue; }
    if (!chk.args.every((a) => SAFE_ARG.test(a))) { f.live = 'unknown'; f.liveNote = 'name has unusual characters, not checked'; stats.skipped++; continue; }
    if (stats.checked >= max) { f.live = 'unknown'; f.liveNote = `over the ${max}-check limit`; stats.skipped++; continue; }
    stats.checked++;
    let r;
    try { r = runCheck(chk, timeoutMs, [f.id, f.name, f.k8sName], env); } catch (e) { r = { live: 'unknown', note: e.message.slice(0, 80) }; }
    f.live = r.live; f.liveNote = r.note || null; f.liveCommand = `${chk.cmd} ${chk.args.join(' ')}`;
    stats[r.live]++;
    if (r.live === 'gone') f.status = 'gone';
  }
  return stats;
}

module.exports = { verify, checkFor, assertReadOnly, resolveBin, classify, runRead, READ_VERBS, SAFE_ARG };
