'use strict';
// --sweep: ask your own cloud CLIs for resources whose expiry tag has passed,
// including ones no agent log mentions (made by a script, a teammate, the console).
// Opt-in. Only allow-listed read-only list calls, run the same safe way as --verify:
// the CLI is resolved on PATH by us (never the current folder), runs from the temp
// folder, without a shell (cmd.exe only for a .cmd shim, with checked arguments).
// Teardowns never skip a prompt, keep a final snapshot and never force-delete a bucket.
const { runRead } = require('./verify');
const { annotate, matchesTags } = require('./tags');
const { redact, redactArgs } = require('./redact');

const CALLS = [
  { cli: 'gcloud', kind: 'Compute Engine VM', args: ['compute', 'instances', 'list', '--format=json', '--quiet'] },
  { cli: 'gcloud', kind: 'Persistent disk', args: ['compute', 'disks', 'list', '--format=json', '--quiet'] },
  { cli: 'gcloud', kind: 'Static IP address', args: ['compute', 'addresses', 'list', '--format=json', '--quiet'] },
  { cli: 'aws', kind: 'aws', args: ['resourcegroupstaggingapi', 'get-resources', '--output', 'json'] },
  { cli: 'az', kind: 'az', args: ['resource', 'list', '--output', 'json'] },
];

const base = (u) => (u ? String(u).split('/').pop() : null);
const lower = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
// Names and IDs come from the cloud: quote anything that isn't plainly safe for a shell.
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._/:@=+-]*$/;
const sq = (s) => (PLAIN.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, "'\\''")}'`);

function gcpItem(kind, r) {
  const zone = base(r.zone);
  const region = base(r.region);
  const where = zone ? ` --zone ${sq(zone)}` : region ? ` --region ${sq(region)}` : ' --global';
  const noun = kind === 'Compute Engine VM' ? 'instances' : kind === 'Persistent disk' ? 'disks' : 'addresses';
  return { provider: 'gcloud', what: kind, name: r.name, tags: lower(r.labels), created: r.creationTimestamp, where: zone || region || 'global',
    teardown: `gcloud compute ${noun} delete ${sq(r.name)}${where}   # asks before deleting` };
}

function awsTeardown(arn) {
  const m = String(arn).match(/^arn:[^:]+:([^:]+):([^:]*):[^:]*:(.+)$/);
  if (!m) return `# delete in the AWS console: ${arn}`;
  const [, svc, region, res] = m;
  const id = res.split(/[/:]/).pop();
  const r = region ? ` --region ${sq(region)}` : '';
  if (svc === 'ec2' && res.startsWith('instance/')) return `aws ec2 terminate-instances --instance-ids ${sq(id)}${r}   # check who owns it first`;
  if (svc === 'ec2' && res.startsWith('volume/')) return `aws ec2 delete-volume --volume-id ${sq(id)}${r}`;
  if (svc === 'ec2' && res.startsWith('elastic-ip/')) return `aws ec2 release-address --allocation-id ${sq(id)}${r}`;
  if (svc === 'ec2' && res.startsWith('natgateway/')) return `aws ec2 delete-nat-gateway --nat-gateway-id ${sq(id)}${r}`;
  if (svc === 's3') return `aws s3 rb s3://${sq(res)}   # refuses a non-empty bucket: check what's inside first (versioned buckets: delete all object versions first)`;
  if (svc === 'rds' && res.startsWith('db:')) return `aws rds delete-db-instance --db-instance-identifier ${sq(id)} --final-db-snapshot-identifier ${sq(id + '-final')}${r}   # keeps a final snapshot`;
  // function:NAME or function:NAME:ALIAS -> the function name, never the alias
  if (svc === 'lambda' && res.startsWith('function:')) return `aws lambda delete-function --function-name ${sq(res.split(':')[1])}${r}`;
  return `# delete in the AWS console: ${arn}`;
}

function parse(call, out) {
  let data;
  try { data = JSON.parse(out || 'null'); } catch { return null; }
  if (call.cli === 'gcloud') return Array.isArray(data) ? data.map((r) => gcpItem(call.kind, r)) : null;
  if (call.cli === 'aws') {
    if (!data || !Array.isArray(data.ResourceTagMappingList)) return null;
    return data.ResourceTagMappingList.map((r) => {
      const tags = lower(Object.fromEntries((r.Tags || []).map((x) => [x.Key, x.Value])));
      const arn = String(r.ResourceARN);
      const svc = arn.split(':')[2] || 'aws';
      return { provider: 'aws', what: `${svc} ${arn.split(':').slice(5).join(':').split('/')[0]}`.trim(), name: tags.name || arn.split(/[/:]/).pop(), arn, tags, where: arn.split(':')[3] || '', teardown: awsTeardown(arn) };
    });
  }
  if (call.cli === 'az') {
    if (!Array.isArray(data)) return null;
    return data.map((r) => ({ provider: 'az', what: String(r.type || 'resource').split('/').pop(), name: r.name, id: r.id, tags: lower(r.tags), created: r.createdTime, where: r.resourceGroup || '',
      teardown: `az resource show --ids ${sq(r.id)}   # check it, then: az resource delete --ids ${sq(r.id)}` }));
  }
  return null;
}

function sweep({ timeoutMs = 30000, wantTags = [], nowMs = Date.now(), env = process.env } = {}) {
  const ran = [];
  const items = [];
  const skip = new Map(); // cli -> why the rest of its calls are skipped
  for (const call of CALLS) {
    if (skip.has(call.cli)) continue;
    let r;
    try { r = runRead({ cmd: call.cli, args: call.args }, timeoutMs, [], env); } catch (e) { ran.push({ cli: call.cli, ok: false, note: `${call.cli}: ${e.message}`.slice(0, 100) }); continue; }
    if (r.missing) { skip.set(call.cli, 1); ran.push({ cli: call.cli, ok: false, note: `${call.cli} CLI not installed` }); continue; }
    if (r.error && r.error.code === 'ETIMEDOUT') { skip.set(call.cli, 1); ran.push({ cli: call.cli, ok: false, note: `${call.cli} timed out (its other list calls were skipped)` }); continue; }
    if (r.error && r.error.code === 'ENOBUFS') { ran.push({ cli: call.cli, ok: false, note: `${call.cli}: too many tagged resources to list in one go (over 64 MB), nothing from aws was checked` }); continue; }
    if (r.error) { ran.push({ cli: call.cli, ok: false, note: `${call.cli}: ${r.error.code || r.error.message}`.slice(0, 100) }); continue; }
    if (r.status !== 0) { ran.push({ cli: call.cli, ok: false, note: `${call.cli}: ${String(r.stderr || r.stdout || '').split('\n').map((s) => s.trim()).find(Boolean) || 'failed'}`.slice(0, 100) }); continue; }
    const list = parse(call, r.stdout);
    if (!list) { ran.push({ cli: call.cli, ok: false, note: `${call.cli}: output was not the JSON list expected` }); continue; }
    ran.push({ cli: call.cli, ok: true, count: list.length, command: `${call.cli} ${call.args.join(' ')}` });
    for (const it of list) {
      annotate(it, it.tags, it.created, nowMs);
      if (!it.expires && !it.expiresRaw) continue;
      if (!matchesTags(it, wantTags)) continue;
      // Same masking as the rest of the output (tags and names can hold secrets).
      it.tags = redactArgs(it.tags);
      if (typeof it.name === 'string') it.name = redact(it.name);
      items.push(it);
    }
  }
  const expired = items.filter((i) => i.expired);
  return { ran, items, expired: expired.length, notYet: items.filter((i) => i.expires && !i.expired).length, unreadable: items.filter((i) => !i.expires).length };
}

module.exports = { sweep, awsTeardown, sq, CALLS };
