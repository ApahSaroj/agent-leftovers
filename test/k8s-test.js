'use strict';
// v0.3 Kubernetes tests: LoadBalancer Services, Ingress, Gateway, PVCs and Helm releases.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function iso(minsAgo) { return new Date(Date.now() - minsAgo * 60000).toISOString(); }

function claudeLog(file, sid, cwd, steps) {
  const L = [];
  let n = 0; let t = 900;
  for (const s of steps) {
    t -= 3;
    const id = `toolu_${sid}_${++n}`;
    if (s.write) {
      L.push({ sessionId: sid, cwd, timestamp: iso(t), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: s.write, content: s.content } }] } });
      continue;
    }
    L.push({ sessionId: sid, cwd, timestamp: iso(t), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: s.cmd } }] } });
    L.push({ sessionId: sid, cwd, timestamp: iso(t - 1), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: s.error ? 'error: failed' : 'ok', is_error: !!s.error }] } });
  }
  fs.writeFileSync(file, L.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

const WEB = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
spec:
  replicas: 2
---
apiVersion: v1
kind: Service
metadata:
  name: web-lb
  namespace: shop
spec:
  type: LoadBalancer
  ports:
    - port: 80
---
apiVersion: v1
kind: Service
metadata:
  name: web-internal
  namespace: shop
spec:
  type: ClusterIP
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: web-data
  namespace: shop
spec:
  resources:
    requests:
      storage: 100Gi
`;
const TMP = `apiVersion: v1
kind: Service
metadata:
  name: tmp-lb
spec:
  type: "LoadBalancer"
`;
const GW = `apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: public-gw
spec:
  gatewayClassName: gke-l7-global-external-managed
`;

function makeK8s(root) {
  const cwd = '/home/dev/code/shop';
  const dir = path.join(root, '.claude', 'projects', '-home-dev-code-shop');
  fs.mkdirSync(dir, { recursive: true });
  claudeLog(path.join(dir, 'k8s-cloud.jsonl'), 'k8s-cloud', cwd, [
    { cmd: 'gcloud container clusters get-credentials shop-prod --zone us-central1-a' },
    { write: `${cwd}/k8s/web.yaml`, content: WEB },
    { cmd: 'kubectl apply -f k8s/web.yaml' },
    { cmd: 'kubectl expose deployment api --type=LoadBalancer --port 80 -n shop' },
    { cmd: 'kubectl apply -f - <<EOF\napiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: site-ing\n  namespace: shop\nspec:\n  rules: []\nEOF' },
    { cmd: 'helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx --create-namespace' },
    { cmd: 'helm install cache bitnami/redis -n shop' },
    { cmd: 'helm uninstall cache -n shop' },
    { cmd: 'kubectl create service loadbalancer quick-lb --tcp=80:8080' },
    { cmd: 'kubectl delete svc quick-lb' },
    { write: `${cwd}/tmp.yaml`, content: TMP },
    { cmd: 'kubectl apply -f tmp.yaml && kubectl delete -f tmp.yaml' },
    { cmd: 'kubectl expose deploy scratch-app --type LoadBalancer -n scratch' },
    { cmd: 'kubectl delete namespace scratch' },
    { write: `${cwd}/deploy/gw/gateway.yaml`, content: GW },
    { cmd: 'cd deploy && kubectl apply -f gw/' },
    { cmd: 'kubectl expose deployment broken --type=LoadBalancer', error: true },
    { cmd: 'kubectl get svc -A && kubectl describe svc web-lb -n shop' },
  ]);
  claudeLog(path.join(dir, 'k8s-local.jsonl'), 'k8s-local', cwd, [
    { cmd: 'kind create cluster --name dev' },
    { cmd: 'kubectl expose deployment local-api --type=LoadBalancer' },
    { cmd: 'kubectl --context minikube expose deployment mk-api --type=LoadBalancer' },
  ]);
}

const FAKE = (log) => `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, require('path').basename(process.argv[1]) + ' ' + a.join(' ') + '\\n');
const name = require('path').basename(process.argv[1]);
if (name === 'kubectl') {
  if (a.includes('web-lb')) { process.stdout.write('service/web-lb\\n'); process.exit(0); }
  process.stderr.write('Error from server (NotFound): services "' + a[2] + '" not found\\n'); process.exit(1);
}
if (name === 'helm') { process.stdout.write('NAME: ingress-nginx\\nSTATUS: deployed\\n'); process.exit(0); }
process.exit(1);
`;

module.exports = function k8sTests(t, bin, baseEnv) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-k8s-'));
  makeK8s(home);
  const env = { ...baseEnv, HOME: home, USERPROFILE: home };
  const run = (args, extra = {}) => spawnSync(process.execPath, [bin, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  const j = JSON.parse(run(['--json']).stdout);
  const k = j.resources.filter((r) => r.provider === 'k8s');
  const by = (rule, name) => k.find((r) => r.rule === rule && r.k8sName === name);

  console.log('kubernetes (v0.3)');
  t('LoadBalancer Service read from the manifest the agent wrote', () => {
    const r = by('k8s-lb-service', 'web-lb');
    assert.ok(r && r.status === 'left' && r.cost === 'hourly');
    assert.strictEqual(r.teardown, 'kubectl delete service web-lb -n shop   # releases the cloud load balancer');
  });
  t('ClusterIP Service and Deployment ignored', () => { assert.ok(!by('k8s-lb-service', 'web-internal')); assert.ok(!k.some((r) => r.k8sName === 'web')); });
  t('PVC from the same file flagged as a disk', () => { const r = by('k8s-pvc', 'web-data'); assert.ok(r && r.status === 'left' && /Retain/.test(r.teardown)); });
  t('kubectl expose --type=LoadBalancer', () => assert.ok(by('k8s-lb-service', 'api').teardown.includes('-n shop')));
  t('heredoc Ingress via apply -f -', () => assert.strictEqual(by('k8s-ingress', 'site-ing').status, 'left'));
  t('helm ingress-nginx = hourly load balancer', () => { const r = by('helm-release', 'ingress-nginx'); assert.ok(r && r.cost === 'hourly' && r.what === 'Helm release + LB'); assert.ok(r.teardown.startsWith('helm uninstall ingress-nginx -n ingress-nginx')); });
  t('helm install then uninstall = cleaned', () => assert.strictEqual(by('helm-release', 'cache').status, 'cleaned'));
  t('create service loadbalancer then delete svc = cleaned', () => assert.strictEqual(by('k8s-lb-service', 'quick-lb').status, 'cleaned'));
  t('apply -f then delete -f = cleaned', () => assert.strictEqual(by('k8s-lb-service', 'tmp-lb').status, 'cleaned'));
  t('delete namespace cleans what was in it', () => assert.strictEqual(by('k8s-lb-service', 'scratch-app').status, 'cleaned'));
  t('apply -f of a directory, after cd', () => assert.strictEqual(by('k8s-gateway', 'public-gw').status, 'left'));
  t('failed expose is not a leftover', () => { const r = by('k8s-lb-service', 'broken'); assert.ok(!r || r.status !== 'left'); });
  t('get/describe noise ignored', () => assert.ok(!k.some((r) => /describe|get svc/.test(r.command))));
  t('kind and minikube clusters skipped (free)', () => { assert.ok(!by('k8s-lb-service', 'local-api')); assert.ok(!by('k8s-lb-service', 'mk-api')); assert.strictEqual(j.k8sLocalSkipped, 2); });
  const left = k.filter((r) => r.status === 'left').map((r) => r.k8sName).sort();
  t('k8s left = 6', () => assert.deepStrictEqual(left, ['api', 'ingress-nginx', 'public-gw', 'site-ing', 'web-data', 'web-lb']));
  const txt = run([]).stdout;
  t('text output shows the k8s rows', () => { assert.ok(/K8s LoadBalancer Service/.test(txt)); assert.ok(/kubectl delete service web-lb -n shop/.test(txt)); });

  // --verify with fake kubectl/helm
  const fb = path.join(home, 'fakebin');
  fs.mkdirSync(fb);
  const log = path.join(fb, 'calls.log');
  fs.writeFileSync(log, '');
  for (const n of ['kubectl', 'helm']) { fs.writeFileSync(path.join(fb, n), FAKE(log)); fs.chmodSync(path.join(fb, n), 0o755); }
  const v = JSON.parse(run(['--json', '--verify'], { PATH: fb + path.delimiter + process.env.PATH }).stdout);
  const vb = (rule, name) => v.resources.find((r) => r.rule === rule && r.k8sName === name);
  t('--verify: web-lb still exists', () => assert.strictEqual(vb('k8s-lb-service', 'web-lb').live, 'exists'));
  t('--verify: NotFound ingress marked gone', () => assert.strictEqual(vb('k8s-ingress', 'site-ing').status, 'gone'));
  t('--verify: helm status used for releases', () => assert.strictEqual(vb('helm-release', 'ingress-nginx').live, 'exists'));
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  t('--verify: only kubectl get / helm status ran', () => assert.ok(calls.length >= 5 && calls.every((c) => /^kubectl get |^helm status /.test(c)), calls.join(' | ')));
};

module.exports.makeK8s = makeK8s;
