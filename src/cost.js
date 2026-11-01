'use strict';
// Rough cost so far for things that bill by the hour. On-demand list prices in
// us-central1 / us-east-1 (USD per hour), checked Oct 2026. Always shown as an
// estimate: real bills depend on region, discounts, free tiers and when it was stopped.

const GCE = {
  'e2-micro': 0.0084, 'e2-small': 0.0168, 'e2-medium': 0.0335, 'e2-standard-2': 0.067, 'e2-standard-4': 0.134, 'e2-standard-8': 0.268,
  'e2-highmem-2': 0.0904, 'e2-highcpu-2': 0.0495, 'n1-standard-1': 0.0475, 'n1-standard-2': 0.095, 'n1-standard-4': 0.19, 'n1-standard-8': 0.38,
  'n2-standard-2': 0.0971, 'n2-standard-4': 0.1942, 'n2-standard-8': 0.3885, 'n2d-standard-2': 0.0845, 'c3-standard-4': 0.2014,
  'g2-standard-4': 0.7068, 'g2-standard-8': 0.8536, 'a2-highgpu-1g': 3.6730, 'a2-highgpu-2g': 7.3460, 'a2-ultragpu-1g': 5.0688,
};
const GPU = { 'nvidia-tesla-t4': 0.35, 'nvidia-l4': 0.56, 'nvidia-tesla-v100': 2.48, 'nvidia-tesla-p100': 1.46, 'nvidia-tesla-a100': 2.93, 'nvidia-a100-80gb': 3.93 };
const EC2 = {
  't2.micro': 0.0116, 't2.small': 0.023, 't2.medium': 0.0464, 't3.nano': 0.0052, 't3.micro': 0.0104, 't3.small': 0.0208, 't3.medium': 0.0416, 't3.large': 0.0832,
  't3.xlarge': 0.1664, 't4g.micro': 0.0084, 't4g.small': 0.0168, 't4g.medium': 0.0336, 'm5.large': 0.096, 'm5.xlarge': 0.192, 'm6i.large': 0.096,
  'm7i.large': 0.1008, 'c5.large': 0.085, 'c6i.large': 0.085, 'r5.large': 0.126, 'g4dn.xlarge': 0.526, 'g4dn.2xlarge': 0.752, 'g5.xlarge': 1.006,
  'g5.2xlarge': 1.212, 'g6.xlarge': 0.8048, 'p3.2xlarge': 3.06, 'p4d.24xlarge': 32.7726,
};
const RDS = { 'db.t3.micro': 0.017, 'db.t3.small': 0.034, 'db.t3.medium': 0.068, 'db.t4g.micro': 0.016, 'db.t4g.small': 0.032, 'db.t4g.medium': 0.065, 'db.m5.large': 0.171 };
const SQL = { 'db-f1-micro': 0.0105, 'db-g1-small': 0.035 };
const CACHE = { 'cache.t3.micro': 0.017, 'cache.t3.small': 0.034, 'cache.t4g.micro': 0.016 };
const AZVM = { standard_ds1_v2: 0.073, standard_d2s_v5: 0.096, standard_b1s: 0.0104, standard_b1ms: 0.0207, standard_b2s: 0.0416, standard_b2ms: 0.0832, standard_d2s_v3: 0.096, standard_d4s_v3: 0.192, standard_nc4as_t4_v3: 0.526 };
const FIXED = {
  'aws-nat': [0.045, 'NAT gateway hourly fee, data extra'], 'aws-eip': [0.005, 'public IPv4'], 'gcp-ip': [0.01, 'reserved static IP'],
  'aws-eks': [0.10, 'EKS control plane, nodes extra'], 'aws-eksctl': [0.10, 'EKS control plane, nodes extra'], 'gcp-gke': [0.10, 'GKE management fee, nodes extra'],
  'aws-elbv2': [0.0225, 'load balancer hourly fee, LCUs extra'], 'aws-vpce': [0.01, 'interface endpoint, per AZ, data extra'],
  'k8s-lb-service': [0.025, 'cloud load balancer'], 'k8s-ingress': [0.025, 'cloud load balancer'], 'k8s-gateway': [0.025, 'cloud load balancer'],
};

// Pull the size hints a create command carries. Called with the command's tokens.
function specFrom(rule, flag, t) {
  const s = {};
  const v = (names) => flag(t, names);
  if (rule === 'gcp-vm') { s.type = v(['--machine-type']) || 'e2-medium'; s.defaulted = !v(['--machine-type']); const acc = v(['--accelerator']); if (acc) { s.gpu = (acc.match(/type=([\w-]+)/) || [])[1]; s.gpuCount = Number((acc.match(/count=(\d+)/) || [])[1] || 1); } }
  if (rule === 'aws-ec2') { s.type = v(['--instance-type']); s.count = Number(v(['--count']) || 1) || 1; }
  if (rule === 'aws-rds') s.type = v(['--db-instance-class']);
  if (rule === 'gcp-sql') s.type = v(['--tier']);
  if (rule === 'aws-elasticache') { s.type = v(['--cache-node-type']); s.count = Number(v(['--num-cache-nodes']) || 1) || 1; }
  // az vm create's default size is Standard_D2s_v5 (Azure CLI reference, --size "Default value").
  if (rule === 'az-vm') { s.type = (v(['--size']) || 'Standard_D2s_v5').toLowerCase(); s.defaulted = !v(['--size']); }
  if (rule === 'gcp-disk') {
    // --size takes GB or TB ("10GB", "2TB"; no unit = GB). Default 500 GB for pd-standard, 100 GB otherwise.
    s.diskType = (v(['--type']) || 'pd-standard').replace(/^.*\//, '');
    s.gb = gbOf(v(['--size'])) || (s.diskType === 'pd-standard' ? 500 : 100); s.defaulted = !v(['--size']);
  }
  // create-volume --size is GiB; --volume-type defaults to gp2 (AWS CLI reference).
  if (rule === 'aws-ebs') { s.gb = parseInt(v(['--size']) || '0', 10) || 0; s.volType = v(['--volume-type']) || 'gp2'; }
  if (rule === 'aws-elbv2') s.lbType = v(['--type']) || 'application';
  return s;
}

// "2TB" -> 2048, "10GB" / "10" -> 10, "500GiB" -> 500. Unknown units -> 0 (no estimate).
function gbOf(x) {
  if (!x) return 0;
  const m = String(x).trim().match(/^(\d+(?:\.\d+)?)\s*(GB|GiB|G|TB|TiB|T)?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return Math.round(/^t/i.test(m[2] || '') ? n * 1024 : n);
}
// USD per GB-month, us-central1 (Compute Engine disk pricing): balanced $0.000136986/GiB-hour = $0.10/month.
const GCE_DISK = { 'pd-standard': [0.04, 'standard'], 'pd-balanced': [0.10, 'balanced'], 'pd-ssd': [0.17, 'SSD'], 'pd-extreme': [0.125, 'extreme'] };
// USD per GB-month, us-east-1 (Amazon EBS pricing).
const EBS = { gp2: 0.10, gp3: 0.08, io1: 0.125, io2: 0.125, st1: 0.045, sc1: 0.015, standard: 0.05 };

function rate(f) {
  const s = f.spec || {};
  if (FIXED[f.rule]) return { perHour: FIXED[f.rule][0], basis: FIXED[f.rule][1] };
  if (f.rule === 'gcp-vm' && GCE[s.type] != null) {
    let r = GCE[s.type]; let b = `${s.type}${s.defaulted ? ' (gcloud default)' : ''}`;
    if (s.gpu && GPU[s.gpu]) { r += GPU[s.gpu] * (s.gpuCount || 1); b += ` + ${s.gpuCount || 1} x ${s.gpu}`; }
    return { perHour: r, basis: b };
  }
  if (f.rule === 'aws-ec2' && EC2[s.type] != null) return { perHour: EC2[s.type] * (s.count || 1), basis: `${s.count || 1} x ${s.type}` };
  if (f.rule === 'aws-rds' && RDS[s.type] != null) return { perHour: RDS[s.type], basis: s.type };
  if (f.rule === 'gcp-sql' && SQL[s.type] != null) return { perHour: SQL[s.type], basis: s.type };
  if (f.rule === 'aws-elasticache' && CACHE[s.type] != null) return { perHour: CACHE[s.type] * (s.count || 1), basis: s.type };
  if (f.rule === 'az-vm' && AZVM[s.type] != null) return { perHour: AZVM[s.type], basis: `${s.type}${s.defaulted ? ' (az default)' : ''}` };
  if (f.rule === 'gcp-disk' && s.gb > 0) {
    // Older findings (or hyperdisk types) without a known diskType: no guess at a rate.
    const d = GCE_DISK[s.diskType || (s.ssd ? 'pd-ssd' : 'pd-standard')];
    if (!d) return null;
    return { perHour: (s.gb * d[0]) / 730, basis: `${s.gb} GB ${d[1]}${s.defaulted ? ' (default size)' : ''}` };
  }
  if (f.rule === 'aws-ebs' && s.gb > 0 && EBS[s.volType || 'gp2'] != null) return { perHour: (s.gb * EBS[s.volType || 'gp2']) / 730, basis: `${s.gb} GB ${s.volType || 'gp2'}` };
  return null;
}

function estimate(f, nowMs = Date.now()) {
  if (f.status !== 'left' || !f.time) return null;
  const r = rate(f);
  if (!r) return null;
  const start = Date.parse(f.time);
  if (!Number.isFinite(start)) return null;
  const hours = Math.max(0, (nowMs - start) / 3600000);
  return { perHour: Math.round(r.perHour * 10000) / 10000, hours: Math.round(hours), soFar: Math.round(r.perHour * hours * 100) / 100, perMonth: Math.round(r.perHour * 730 * 100) / 100, basis: r.basis };
}

const money = (n) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);

module.exports = { specFrom, estimate, money, gbOf, rate };
