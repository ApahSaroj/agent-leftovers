'use strict';
// --verify: ask the user's own cloud CLIs whether each leftover still exists.
// Opt-in only. Every command here is a read-only describe/list/get call, checked
// against an allow-list before it runs, and run without a shell so a strange
// resource name can never become a command.
const { spawnSync } = require('child_process');
const { tokenize, flag, hasFlag } = require('./shell');

const READ_VERBS = new Set(['describe', 'list', 'get', 'info', 'head-bucket', 'inspect', 'status', 'exists', 'show', 'get-function', 'describe-instances', 'describe-db-instances', 'describe-table', 'apps:info']);
const WRITE_WORDS = /^(delete|destroy|remove|rm|rb|terminate|create|deploy|stop|start|update|put|enable|disable|apply|kill|scale|launch|mb|undeploy)$|^(delete|terminate|create|put|update|remove|stop|start)-/;
const SAFE_ARG = /^[A-Za-z0-9._:/=,@+\-[\]()]+$/;
const NOT_FOUND = /not\s*found|notfound|does not exist|doesn't exist|could not find|couldn't find|can't find|cannot find|no such|\b404\b|nosuchbucket|invalidinstanceid/i;

function opt(args, name, v) { if (v) args.push(name, v); return args; }
function strip(n, pre) { return n && n.startsWith(pre) ? n.slice(pre.length) : n; }

// Returns { cmd, args, exists?(stdout) } or null when we don't know how to check it.
function checkFor(f) {
  const t = tokenize(f.command || '');
  const zone = flag(t, ['--zone']);
  const region = flag(t, ['--region', '--location']);
  const project = flag(t, ['--project']);
  const n = f.id || f.name;
  const g = (...a) => ({ cmd: 'gcloud', args: opt([...a, '--quiet'], '--project', project) });
  switch (f.rule) {
    case 'gcp-vm': return g('compute', 'instances', 'describe', n, ...(zone ? ['--zone', zone] : []), '--format=value(name)');
    case 'gcp-disk': return g('compute', 'disks', 'describe', n, ...(zone ? ['--zone', zone] : []), '--format=value(name)');
    case 'gcp-ip': return g('compute', 'addresses', 'describe', n, ...(hasFlag(t, ['--global']) ? ['--global'] : region ? ['--region', region] : []), '--format=value(name)');
    case 'gcp-sql': return g('sql', 'instances', 'describe', n, '--format=value(name)');
    case 'gcp-gke': return g('container', 'clusters', 'describe', n, ...(zone ? ['--zone', zone] : region ? ['--region', region] : []), '--format=value(name)');
    case 'gcp-redis': return g('redis', 'instances', 'describe', n, ...(region ? ['--region', region] : []), '--format=value(name)');
    case 'gcp-run': return g('run', 'services', 'describe', n, ...(region ? ['--region', region] : []), '--format=value(metadata.name)');
    case 'gcp-fn': return g('functions', 'describe', n, ...(region ? ['--region', region] : []), '--format=value(name)');
    case 'gcp-bucket': case 'gcp-gsutil-mb': return g('storage', 'buckets', 'describe', n.startsWith('gs://') ? n : `gs://${n}`, '--format=value(name)');
    case 'gcp-api': return { ...g('services', 'list', '--enabled', `--filter=config.name:${n}`, '--format=value(config.name)'), exists: (out) => out.includes(n) };
    case 'aws-s3': case 'aws-s3api': return { cmd: 'aws', args: ['s3api', 'head-bucket', '--bucket', strip(n, 's3://')] };
    case 'aws-ec2':
      if (/ x /.test(n)) return null; // no name tag, only "2 x t3.large"
      return { cmd: 'aws', args: ['ec2', 'describe-instances', '--filters', `Name=tag:Name,Values=${n}`, 'Name=instance-state-name,Values=pending,running,stopping,stopped', '--query', 'Reservations[].Instances[].InstanceId', '--output', 'text'], exists: (out) => /\bi-[0-9a-f]+/.test(out) };
    case 'aws-rds': return { cmd: 'aws', args: ['rds', 'describe-db-instances', '--db-instance-identifier', n] };
    case 'aws-lambda': return { cmd: 'aws', args: ['lambda', 'get-function', '--function-name', n] };
    case 'aws-dynamo': return { cmd: 'aws', args: ['dynamodb', 'describe-table', '--table-name', n] };
    case 'az-group': return { cmd: 'az', args: ['group', 'exists', '--name', n], exists: (out) => /true/i.test(out), gone: (out) => /false/i.test(out) };
    case 'fly-app': return { cmd: 'fly', args: ['status', '-a', n] };
    case 'heroku-create': return { cmd: 'heroku', args: ['apps:info', '-a', n] };
    case 'cf-d1': case 'mcp-cloudflare-database': return { cmd: 'wrangler', args: ['d1', 'info', n] };
    case 'cf-r2': case 'mcp-cloudflare-bucket': return { cmd: 'wrangler', args: ['r2', 'bucket', 'info', n] };
    case 'mcp-supabase-project': return f.id ? { cmd: 'supabase', args: ['projects', 'list', '-o', 'json'], exists: (out) => out.includes(f.id), gone: (out) => /^\s*\[/.test(out) && !out.includes(f.id) } : null;
    case 'mcp-neon-project': return f.id ? { cmd: 'neonctl', args: ['projects', 'get', f.id] } : null;
    case 'mcp-digitalocean-instance': return { cmd: 'doctl', args: ['compute', 'droplet', 'get', n] };
    case 'mcp-vercel-deployment': return f.id ? { cmd: 'vercel', args: ['inspect', f.id] } : null;
    default: return null;
  }
}

function assertReadOnly(cmd, args, names = []) {
  const words = args.filter((a) => !a.startsWith('-') && !names.some((n) => n && a.includes(n)));
  if (!words.some((w) => READ_VERBS.has(w))) throw new Error(`refusing non-read command: ${cmd} ${args.join(' ')}`);
  if (words.some((w) => WRITE_WORDS.test(w) && !READ_VERBS.has(w))) throw new Error(`refusing write verb: ${cmd} ${args.join(' ')}`);
}

function runCheck(chk, timeoutMs, names) {
  assertReadOnly(chk.cmd, chk.args, names);
  const win = process.platform === 'win32';
  // On Windows the cloud CLIs are .cmd files; quote every arg ourselves.
  const r = win
    ? spawnSync(`${chk.cmd} ${chk.args.map((a) => `"${a}"`).join(' ')}`, { shell: true, encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
    : spawnSync(chk.cmd, chk.args, { encoding: 'utf8', timeout: timeoutMs });
  const out = (r.stdout || '') + '';
  const err = (r.stderr || '') + '';
  if (r.error && r.error.code === 'ENOENT') return { live: 'unknown', note: `${chk.cmd} CLI not installed` };
  if (win && r.status !== 0 && /is not recognized as an internal or external command/i.test(err)) return { live: 'unknown', note: `${chk.cmd} CLI not installed` };
  if (r.error && r.error.code === 'ETIMEDOUT') return { live: 'unknown', note: `${chk.cmd} timed out` };
  if (r.status === 0) {
    if (chk.gone && chk.gone(out)) return { live: 'gone' };
    if (chk.exists && !chk.exists(out)) return { live: 'gone' };
    return { live: 'exists' };
  }
  if (NOT_FOUND.test(err) || NOT_FOUND.test(out)) return { live: 'gone' };
  const first = (err || out).split('\n').map((s) => s.trim()).find(Boolean) || `exit ${r.status}`;
  return { live: 'unknown', note: `${chk.cmd}: ${first.slice(0, 80)}` };
}

function verify(resources, { timeoutMs = 20000, max = 50 } = {}) {
  const stats = { checked: 0, gone: 0, exists: 0, unknown: 0, skipped: 0 };
  for (const f of resources) {
    if (f.status !== 'left' && f.status !== 'maybe-cleaned') continue;
    if (f.nameUnknown) { f.live = 'unknown'; f.liveNote = 'name not in the log'; stats.skipped++; continue; }
    const chk = checkFor(f);
    if (!chk) { f.live = 'unknown'; f.liveNote = 'no read-only check for this type yet'; stats.skipped++; continue; }
    if (!chk.args.every((a) => SAFE_ARG.test(a))) { f.live = 'unknown'; f.liveNote = 'name has unusual characters, not checked'; stats.skipped++; continue; }
    if (stats.checked >= max) { f.live = 'unknown'; f.liveNote = `over the ${max}-check limit`; stats.skipped++; continue; }
    stats.checked++;
    const r = runCheck(chk, timeoutMs, [f.id, f.name]);
    f.live = r.live; f.liveNote = r.note || null; f.liveCommand = `${chk.cmd} ${chk.args.join(' ')}`;
    stats[r.live]++;
    if (r.live === 'gone') f.status = 'gone';
  }
  return stats;
}

module.exports = { verify, checkFor, assertReadOnly, READ_VERBS };
