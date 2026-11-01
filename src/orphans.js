'use strict';
// The sneaky ones: things that keep billing after the agent deleted the VM they
// belonged to. Disks kept on delete, Elastic IPs left allocated after a terminate,
// volumes attached after launch, and the OS disk / NIC / public IP an Azure VM
// leaves behind by default.
//
// Runs inside scan's per-command loop, so it sees commands in order, inside scripts
// the agent ran, with the same failed / --help / --dry-run handling as the rules.
// Deletes only clear an orphan when the exact name or ID matches.
const { flag, tokenize } = require('./shell');
const { matchPrefix, gnames } = require('./rules');
const { annotate } = require('./tags');

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const isVar = (s) => !s || /[$`<>{}]/.test(s);

// gcloud --create-disk / --disk specs: "name=d1,size=100GB,auto-delete=no,boot=yes"
function diskSpecs(cmd) {
  const t = tokenize(String(cmd || ''));
  const out = [];
  for (let i = 0; i < t.length; i++) {
    let v = null;
    if (t[i] === '--create-disk' || t[i] === '--disk') v = t[i + 1];
    else if (t[i].startsWith('--create-disk=')) v = t[i].slice(14);
    else if (t[i].startsWith('--disk=')) v = t[i].slice(7);
    if (!v) continue;
    const kv = {};
    for (const p of v.split(',')) { const j = p.indexOf('='); if (j > 0) kv[p.slice(0, j).trim().toLowerCase()] = p.slice(j + 1).trim(); }
    out.push(kv);
  }
  return out;
}
const off = (v) => /^(no|false)$/i.test(v || '');
const on = (v) => /^(yes|true)$/i.test(v || '');

// Boot disk kept: --no-boot-disk-auto-delete, or a boot=yes disk spec with auto-delete=no.
function bootKept(cmd) {
  if (/--no-boot-disk-auto-delete\b/.test(cmd)) return { name: null };
  const d = diskSpecs(cmd).find((s) => on(s.boot) && off(s['auto-delete']));
  return d ? { name: d.name || null } : null;
}
// Data disks kept: any non-boot disk spec with auto-delete=no (that is a data disk, never the boot disk).
const dataKept = (cmd) => diskSpecs(cmd).filter((s) => !on(s.boot) && off(s['auto-delete']));

const azDel = (cmd, o) => new RegExp(`--${o}-delete-option[= ]+["']?delete\\b`, 'i').test(cmd);
const awsKeepsVolume = (cmd) => /DeleteOnTermination[=":\s]+false/i.test(cmd);

// Every value after a list flag: --instance-ids i-1 i-2  /  --instance-ids=i-1,i-2
function listFlag(t, name) {
  const out = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === name) for (let j = i + 1; j < t.length && !t[j].startsWith('-'); j++) out.push(...t[j].split(','));
    else if (t[i].startsWith(name + '=')) out.push(...t[i].slice(name.length + 1).split(','));
  }
  return out.filter(Boolean);
}

function makeOrphans(idx, addFinding, addScope) {
  const attached = new Map(); // volume id -> { instance, time }
  const last = (rule, name) => { const l = idx.named(rule, name); return l.length ? l[l.length - 1] : null; };

  return function orphanSimple(t0, simple, ev) {
    const base = { time: ev.time, cwd: ev.cwd, session: ev.session, agent: ev.tool, status: 'left', failed: false, times: 1, command: simple, orphan: true };
    const add = (key, parent, f) => {
      const scope = (parent && parent.scope) || {};
      const o = { ...base, ...f, scope, teardown: addScope ? addScope(f.teardown, f.provider, scope) : f.teardown };
      // A kept disk carries its VM's session and expiry tags, so --tag / --expired find it too.
      if (parent && parent.tags) annotate(o, parent.tags, parent.time);
      addFinding(key, o);
    };

    // ---- Google Cloud: VM deleted, disks kept, static IP left unattached ----
    let t = matchPrefix(t0, ['gcloud', 'compute', 'instances', 'delete']);
    if (t) {
      const zone = flag(t, ['--zone']);
      const keep = flag(t, ['--keep-disks']);
      for (const vm of gnames(t, 4)) {
        if (isVar(vm)) continue;
        const parent = last('gcp-vm', vm);
        const pc = parent ? parent.command : '';
        const z = zone || (parent && flag(tokenize(pc), ['--zone']));
        const zf = z ? ` --zone ${z}` : '';
        const list = `gcloud compute disks list --filter="-users:*"${z ? ` --zones ${z}` : ''}`;
        if (keep) {
          add(`gcp-kept-disk|${vm}|${keep}`, parent, { rule: 'gcp-kept-disk', provider: 'gcloud', what: 'Kept disk (VM deleted)', cost: 'hourly', name: `${vm} (${keep} disk${keep === 'all' ? 's' : ''})`, nameUnknown: false,
            diskName: keep === 'boot' ? vm : null, vm,
            teardown: `${list}   # unattached disks; then: gcloud compute disks delete <DISK>${zf}`,
            note: `the delete ran with --keep-disks=${keep}, so the ${keep === 'all' ? 'disks' : keep + ' disk'} kept billing after ${vm} was gone` });
        }
        const boot = parent && keep !== 'boot' && keep !== 'all' ? bootKept(pc) : null;
        if (boot) {
          const dn = boot.name && SAFE.test(boot.name) ? boot.name : vm;
          add(`gcp-kept-disk|${vm}|boot`, parent, { rule: 'gcp-kept-disk', provider: 'gcloud', what: 'Kept boot disk', cost: 'hourly', name: vm, nameUnknown: false, diskName: dn, vm,
            teardown: `gcloud compute disks delete ${dn}${zf}   # asks before deleting; check the name first: ${list}`,
            note: `${vm} was created with auto-delete off for its boot disk, so deleting the VM left the disk` });
        }
        const data = parent && keep !== 'data' && keep !== 'all' ? dataKept(pc) : [];
        if (data.length) {
          const named = data.map((d) => d.name).filter((n) => n && SAFE.test(n));
          const one = data.length === 1 && named.length === 1 ? named[0] : null;
          add(`gcp-kept-disk|${vm}|data`, parent, { rule: 'gcp-kept-disk', provider: 'gcloud', what: 'Kept data disk', cost: 'hourly', name: `${vm} (data disk${data.length > 1 ? 's' : ''})`, nameUnknown: false,
            diskName: one, diskNames: named, vm,
            teardown: one ? `gcloud compute disks delete ${one}${zf}   # asks before deleting` : `${list}   # unattached disks; then: gcloud compute disks delete <DISK>${zf}`,
            note: `${vm} had ${data.length > 1 ? 'disks' : 'a disk'} with auto-delete=no${named.length ? ` (${named.join(', ')})` : ''}, so deleting the VM left ${data.length > 1 ? 'them' : 'it'}` });
        }
        const addr = parent && flag(tokenize(pc), ['--address']);
        if (addr) for (const f of idx.named('gcp-ip', addr)) {
          if (f.status === 'left') f.note = `its VM ${vm} was deleted, so this IP is reserved but unattached; an unused static IP bills at double the in-use rate`;
        }
      }
      return;
    }
    t = matchPrefix(t0, ['gcloud', 'compute', 'disks', 'delete']);
    if (t) {
      const names = gnames(t, 4).filter((n) => n && !isVar(n));
      for (const f of idx.rule('gcp-kept-disk')) {
        if (f.status !== 'left') continue;
        if (f.diskNames && f.diskNames.length > 1) {
          f.diskNames = f.diskNames.filter((n) => !names.includes(n));
          if (!f.diskNames.length) f.status = 'cleaned';
        } else if (f.diskName && names.includes(f.diskName)) f.status = 'cleaned';
        else if (!f.diskName && names.length && !/disks delete ran/.test(f.note || '')) {
          f.note = `${f.note || ''}. A disks delete ran later (${names.join(', ')}); if that was this disk it is gone, so check before deleting`;
        }
      }
      return;
    }

    // ---- AWS: instance terminated, EIP and kept volumes stay ----
    t = matchPrefix(t0, ['aws', 'ec2', 'terminate-instances']);
    if (t) {
      const ids = listFlag(t, '--instance-ids').filter((x) => !isVar(x));
      const anyVar = listFlag(t, '--instance-ids').some(isVar) || !ids.length;
      for (const f of idx.rule('aws-eip')) {
        if (f.status === 'left') f.note = 'an instance was terminated after this was allocated; the Elastic IP stays allocated and keeps billing ($0.005/h, the same rate as while attached) until you release it';
      }
      // Instances the log can tie to an ID (from the run-instances output).
      const known = new Set();
      for (const f of idx.rule('aws-ec2')) for (const id of f.instanceIds || []) known.add(id);
      const unmatched = anyVar || ids.some((id) => !known.has(id));
      for (const f of idx.rule('aws-ec2')) {
        if (!awsKeepsVolume(f.command || '')) continue;
        const hit = f.instanceIds && f.instanceIds.length ? f.instanceIds.some((id) => ids.includes(id)) : unmatched;
        if (!hit) continue;
        const sure = !!(f.instanceIds && f.instanceIds.length);
        add(`aws-kept-ebs|${f.name}`, f, { rule: 'aws-kept-ebs', provider: 'aws', what: 'Kept EBS volume', cost: 'hourly', name: f.name, nameUnknown: false,
          teardown: 'aws ec2 describe-volumes --filters Name=status,Values=available   # then: aws ec2 delete-volume --volume-id <ID>',
          note: sure ? `${f.name} was launched with DeleteOnTermination=false and was terminated, so its volume is still there`
            : `${f.name} was launched with DeleteOnTermination=false; the log doesn't show its instance ID, so if it is the instance terminated here (${ids.join(', ') || 'unknown ID'}), its volume is still there` });
      }
      for (const [vol, a] of attached) {
        const hit = a.instance && !isVar(a.instance) ? ids.includes(a.instance) : true;
        if (!hit) continue;
        attached.delete(vol);
        add(`aws-kept-ebs|${vol}`, a.parent, { rule: 'aws-kept-ebs', provider: 'aws', what: 'Kept EBS volume', cost: 'hourly', name: vol, nameUnknown: false, volumeId: vol,
          teardown: `aws ec2 describe-volumes --volume-ids ${vol}   # if State is available: aws ec2 delete-volume --volume-id ${vol}`,
          note: 'volumes attached after launch are kept when the instance is terminated (DeleteOnTermination defaults to false for them)' });
      }
      return;
    }
    t = matchPrefix(t0, ['aws', 'ec2', 'attach-volume']);
    if (t) {
      const vol = flag(t, ['--volume-id']);
      if (vol && !isVar(vol) && SAFE.test(vol)) attached.set(vol, { instance: flag(t, ['--instance-id']), time: ev.time, parent: { scope: scopeOfAws(t) } });
      return;
    }
    t = matchPrefix(t0, ['aws', 'ec2', 'detach-volume']) || matchPrefix(t0, ['aws', 'ec2', 'delete-volume']);
    if (t) {
      const vol = flag(t, ['--volume-id']);
      if (vol) attached.delete(vol);
      if (vol && t[2] === 'delete-volume') for (const f of idx.named('aws-kept-ebs', vol)) if (f.status === 'left') f.status = 'cleaned';
      return;
    }

    // ---- Azure: VM deleted, its disk, NIC and public IP stay by default ----
    t = matchPrefix(t0, ['az', 'vm', 'delete']);
    if (t) {
      const vm = flag(t, ['--name', '-n']);
      const parent = vm && last('az-vm', vm);
      if (!parent) return;
      const pc = parent.command;
      const noIp = /--public-ip-address(=|\s+)(""|''|\s|$)/.test(pc + ' ');
      const hasData = /--data-disk-sizes-gb|--attach-data-disks/.test(pc);
      const parts = [!azDel(pc, 'os-disk') && 'OS disk', !azDel(pc, 'nic') && 'NIC', !noIp && 'public IP', hasData && !azDel(pc, 'data-disk') && 'data disks'].filter(Boolean);
      if (!parts.length) return;
      const rg = flag(t, ['--resource-group', '-g']) || flag(tokenize(pc), ['--resource-group', '-g']) || '<GROUP>';
      const g = rg === '<GROUP>' || SAFE.test(rg) ? rg : `'${rg.replace(/'/g, "'\\''")}'`;
      const q = SAFE.test(vm) ? vm : '<VM>';
      add(`az-vm-orphans|${rg}|${vm}`, parent, { rule: 'az-vm-orphans', provider: 'az', what: 'Azure VM leftovers', cost: 'hourly', name: vm, nameUnknown: false, resourceGroup: rg, azParts: parts,
        teardown: `az resource list -g ${g} --query "[?contains(name, '${q}')].{name:name, type:type, id:id}" -o table   # check each, then: az resource delete --ids <ID>`,
        note: azNote(parts) });
      return;
    }
    t = matchPrefix(t0, ['az', 'group', 'delete']);
    if (t) {
      const rg = flag(t, ['--name', '-n', '--resource-group', '-g']);
      if (rg) for (const f of idx.rule('az-vm-orphans')) if (f.status === 'left' && f.resourceGroup === rg) f.status = 'cleaned';
      return;
    }
    // Deleting the default-named parts one by one (exact names only).
    const azPart = [[['az', 'network', 'nic', 'delete'], 'NIC', (vm, n) => n === `${vm}VMNic`],
      [['az', 'network', 'public-ip', 'delete'], 'public IP', (vm, n) => n === `${vm}PublicIP`],
      [['az', 'disk', 'delete'], 'OS disk', (vm, n) => n.startsWith(`${vm}_OsDisk_`)]];
    for (const [pre, part, match] of azPart) {
      t = matchPrefix(t0, pre);
      if (!t) continue;
      const n = flag(t, ['--name', '-n']);
      const rg = flag(t, ['--resource-group', '-g']);
      if (!n) return;
      for (const f of idx.rule('az-vm-orphans')) {
        if (f.status !== 'left' || !f.azParts.includes(part) || !match(f.name, n) || (rg && f.resourceGroup !== '<GROUP>' && rg !== f.resourceGroup)) continue;
        f.azParts = f.azParts.filter((p) => p !== part);
        if (!f.azParts.length) f.status = 'cleaned'; else f.note = azNote(f.azParts);
      }
      return;
    }
  };
}

function azNote(parts) {
  return `az vm delete left: ${parts.join(', ')}. The public IP always stays (az vm create has no delete option for it); disks and NIC only go if the VM was created with --os-disk-delete-option Delete, --data-disk-delete-option Delete and --nic-delete-option Delete`;
}

function scopeOfAws(t) {
  const sc = {};
  const p = flag(t, ['--profile']); const r = flag(t, ['--region']);
  if (p) sc.profile = p; if (r) sc.region = r;
  return sc;
}

module.exports = { makeOrphans, bootKept, dataKept };
