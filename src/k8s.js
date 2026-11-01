'use strict';
// Kubernetes leftovers (v0.3, from @markfenner's feedback on X):
// a Service of type LoadBalancer, an Ingress or a Gateway makes the cloud spin up a
// real load balancer that bills by the hour, and a PersistentVolumeClaim makes a
// real disk. These hide behind `kubectl apply -f`, so we read the manifests the agent
// wrote (or piped in a heredoc) and follow `kubectl expose`, `kubectl create service`,
// `kubectl patch` and `helm install`. Work in local clusters (kind, minikube, k3d,
// Docker Desktop...) is skipped because it costs nothing.
const path = require('path');
const { splitCommands, tokenize, flag, hasFlag, positional } = require('./shell');

const K8S_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const CTX_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,250}$/;
const LOCAL_CTX = /^(kind-|k3d-|minikube$|docker-desktop$|docker-for-desktop$|rancher-desktop$|orbstack$|colima|microk8s$|k3s$|default$)/;
const LB_CHARTS = /ingress-nginx|nginx-ingress|traefik|kong|istio|gateway|haproxy|contour|emissary|ambassador|envoy|apisix/i;
const KFLAGS = ['-n', '--namespace', '--context', '--kubeconfig', '-f', '--filename', '-o', '--output', '-l', '--selector', '--port', '--target-port', '--type', '--name', '--protocol', '-p', '--patch', '--type', '--tcp', '--cluster', '--user', '-k', '--kustomize'];

// Tiny YAML reader: enough for kind, metadata.name, metadata.namespace and spec.type.
function parseManifests(text) {
  const out = [];
  if (!text || !/\bkind\s*:/.test(text)) return out;
  for (const doc of String(text).split(/^---.*$/m)) {
    const kind = (doc.match(/^kind\s*:\s*["']?([A-Za-z]+)/m) || [])[1];
    if (!kind) continue;
    if (kind === 'List') continue;
    const meta = doc.match(/^metadata\s*:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/m);
    const block = meta ? meta[1] : '';
    const ind = (block.match(/^([ \t]+)\S/m) || [, '  '])[1];
    const pick = (k) => { const m = block.match(new RegExp(`^${ind}${k}\\s*:\\s*["']?([^"'\\s#]+)`, 'm')); return m ? m[1] : null; };
    const name = pick('name') || (pick('generateName') ? pick('generateName') + '*' : null);
    const namespace = pick('namespace');
    const lb = /^\s+type\s*:\s*["']?LoadBalancer\b/m.test(doc);
    out.push({ kind, name, namespace, lb });
  }
  return out;
}

function billable(m) {
  if (m.kind === 'Service' && m.lb) return { rule: 'k8s-lb-service', what: 'K8s LoadBalancer Service', noun: 'service', cost: 'hourly' };
  if (m.kind === 'Ingress') return { rule: 'k8s-ingress', what: 'K8s Ingress (cloud LB)', noun: 'ingress', cost: 'hourly' };
  if (m.kind === 'Gateway') return { rule: 'k8s-gateway', what: 'K8s Gateway (cloud LB)', noun: 'gateway', cost: 'hourly' };
  if (m.kind === 'PersistentVolumeClaim') return { rule: 'k8s-pvc', what: 'K8s volume claim (disk)', noun: 'pvc', cost: 'hourly' };
  if (m.kind === 'StatefulSet' && /volumeClaimTemplates\s*:/.test(m.raw || '')) return null;
  return null;
}

const KNOUN = { svc: 'service', service: 'service', services: 'service', ing: 'ingress', ingress: 'ingress', ingresses: 'ingress', pvc: 'pvc', persistentvolumeclaim: 'pvc', persistentvolumeclaims: 'pvc', gateway: 'gateway', gateways: 'gateway', gtw: 'gateway' };
const tail = (s) => String(s || '').replace(/^.*\//, '');

function teardownFor(noun, name, ns, ctx) {
  const where = `${ns ? ` -n ${ns}` : ''}${ctx ? ` --context ${ctx}` : ''}`;
  if (noun === 'service') return `kubectl delete service ${name}${where}   # releases the cloud load balancer`;
  if (noun === 'ingress') return `kubectl delete ingress ${name}${where}   # releases the cloud load balancer`;
  if (noun === 'gateway') return `kubectl delete gateway ${name}${where}   # releases the cloud load balancer`;
  if (noun === 'pvc') return `kubectl delete pvc ${name}${where}   # if its PV says reclaimPolicy: Retain, delete the disk too`;
  if (noun === 'helm') return `helm uninstall ${name}${ns ? ` -n ${ns}` : ''}${ctx ? ` --kube-context ${ctx}` : ''}`;
  return '(see your cluster)';
}

function checkCtx(td, unknown) {
  if (!unknown) return td;
  const [cmd, note] = td.split(/\s{2,}#\s*/);
  return `kubectl config current-context   # make sure it is ${unknown} first, then: ${cmd}${note ? `  (${note})` : ''}`;
}

// The kubeconfig context a get-credentials / update-kubeconfig creates, when the log shows enough to name it.
function cloudContext(t, sessProject) {
  if (t[0] === 'gcloud') {
    const i = t.indexOf('get-credentials');
    const name = positional(t, i + 1, ['--zone', '--region', '--location', '--project', '--account', '--configuration']);
    const loc = flag(t, ['--zone', '--region', '--location']);
    const proj = flag(t, ['--project']) || (t.env && t.env.CLOUDSDK_CORE_PROJECT) || sessProject;
    return { cluster: name, ctx: name && loc && proj ? `gke_${proj}_${loc}_${name}` : null };
  }
  if (t[0] === 'az') {
    const name = flag(t, ['--name', '-n']);
    const own = flag(t, ['--context']);
    return { cluster: name, ctx: own || (name ? (hasFlag(t, ['--admin', '-a']) ? `${name}-admin` : name) : null) };
  }
  if (t[0] === 'aws') return { cluster: flag(t, ['--name']), ctx: flag(t, ['--alias']) || null };
  if (t[0] === 'eksctl') return { cluster: flag(t, ['--name', '-n']) || positional(t, 3, ['--region', '--nodes', '--node-type', '--version', '-f', '--profile']), ctx: null };
  return { cluster: positional(t, 4, ['--context', '-t', '--access-token']), ctx: null };
}

// kubectl --context x -n y apply ... -> kubectl apply ... --context x -n y
function hoistGlobals(t) {
  if (!t.length || !['kubectl', 'oc', 'helm'].includes(t[0])) return t;
  const head = []; let i = 1;
  while (i < t.length && t[i].startsWith('-')) {
    head.push(t[i]);
    if (!t[i].includes('=') && i + 1 < t.length && !t[i + 1].startsWith('-') && /^(-n|--namespace|--context|--kube-context|--kubeconfig|--cluster|--user|-s|--server)$/.test(t[i])) head.push(t[++i]);
    i++;
  }
  return [t[0], ...t.slice(i), ...head];
}

// Heredoc bodies in a command: kubectl apply -f - <<EOF ... EOF
function heredocs(command) {
  const out = [];
  const re = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\s*\1\s*(?:\n|$)/g;
  let m;
  while ((m = re.exec(command))) out.push(m[2]);
  // echo '...' | kubectl apply -f -   /  printf
  const em = command.match(/(?:echo|printf)\s+(['"])([\s\S]*?)\1\s*\|\s*kubectl\s+(apply|create)/);
  if (em) out.push(em[2].replace(/\\n/g, '\n'));
  return out;
}

function k8sFindings(evs, addFinding, found) {
  const files = new Map(); // abs path -> latest content written by the agent
  const ctxBySession = new Map();
  const hintBySession = new Map(); // session -> cluster name when its context name is unknown
  const projBySession = new Map();
  let skippedLocal = 0;

  const isLocal = (ctx) => !!ctx && LOCAL_CTX.test(ctx);

  for (const ev of evs) {
    if (ev.kind === 'write' && ev.file && ev.content != null) {
      const abs = path.isAbsolute(ev.file) ? ev.file : path.join(ev.cwd || '', ev.file);
      files.set(path.normalize(abs), String(ev.content));
      continue;
    }
    if (ev.kind !== 'cmd') continue;
    const docsInCmd = heredocs(ev.command || '');
    let cwd = ev.cwd || '';
    for (const simple of splitCommands(ev.command || '')) {
      const t0 = hoistGlobals(tokenize(simple));
      if (!t0.length) continue;
      if (t0[0] === 'cd' && t0[1]) { cwd = path.isAbsolute(t0[1]) ? t0[1] : path.join(cwd, t0[1]); continue; }
      if (ev.failed) continue;
      // Which cluster is current in this session?
      if (t0[0] === 'kubectl' && t0[1] === 'config' && t0[2] === 'use-context' && t0[3]) { ctxBySession.set(ev.session, CTX_NAME.test(t0[3]) ? t0[3] : '(cloud)'); continue; }
      if (t0[0] === 'kind' && t0[1] === 'create' && t0[2] === 'cluster') { ctxBySession.set(ev.session, 'kind-' + (flag(t0, ['--name']) || 'kind')); continue; }
      if (t0[0] === 'minikube' && t0[1] === 'start') { ctxBySession.set(ev.session, 'minikube'); continue; }
      if (t0[0] === 'k3d' && t0[1] === 'cluster' && t0[2] === 'create') { ctxBySession.set(ev.session, 'k3d-' + (positional(t0, 3, ['--servers', '--agents', '-a', '-s', '--image', '-i']) || 'k3s-default')); continue; }
      // gcloud's project, so a later get-credentials can name its context.
      if (t0[0] === 'gcloud' && t0[1] === 'config' && t0[2] === 'set' && (t0[3] === 'project' || t0[3] === 'core/project') && t0[4]) { projBySession.set(ev.session, t0[4]); continue; }
      if (t0[0] === 'export') { for (const kv of t0.slice(1)) { const m = kv.match(/^CLOUDSDK_CORE_PROJECT=(.+)$/); if (m) projBySession.set(ev.session, m[1]); } continue; }
      if ((t0[0] === 'gcloud' && t0.includes('get-credentials')) || (t0[0] === 'aws' && t0[1] === 'eks' && t0[2] === 'update-kubeconfig') || (t0[0] === 'az' && t0[1] === 'aks' && t0[2] === 'get-credentials') || (t0[0] === 'eksctl' && t0[1] === 'create' && t0[2] === 'cluster') || (t0[0] === 'doctl' && t0.includes('kubeconfig'))) {
        // The context these commands make is predictable for GKE, AKS and an aliased EKS; otherwise
        // remember the cluster's name so the teardown says which cluster to check first.
        const c = cloudContext(t0, projBySession.get(ev.session));
        if (c.ctx && CTX_NAME.test(c.ctx)) { ctxBySession.set(ev.session, c.ctx); hintBySession.delete(ev.session); } else { ctxBySession.set(ev.session, '(cloud)'); hintBySession.set(ev.session, c.cluster && CTX_NAME.test(c.cluster) ? c.cluster : null); }
        continue;
      }

      if (t0.some((x) => x === '--dry-run' || x.startsWith('--dry-run=') || x === '--help') || (t0[0] === 'helm' && (t0.includes('template') || t0[1] === 'template'))) continue;
      const isK = t0[0] === 'kubectl' || t0[0] === 'oc';
      const isH = t0[0] === 'helm';
      if (!isK && !isH) continue;
      const ns0 = flag(t0, ['-n', '--namespace']);
      const ns = ns0 && K8S_NAME.test(ns0) ? ns0 : null;
      const ctx0 = isH ? flag(t0, ['--kube-context']) : flag(t0, ['--context']);
      const explicitCtx = ctx0 && CTX_NAME.test(ctx0) ? ctx0 : null;
      // An odd -n / --context value (shell characters) is never dropped, which would point the
      // teardown at the current namespace or context: it becomes <NAMESPACE> / <CONTEXT>.
      const nsOdd = !!ns0 && !ns;
      const ctxOdd = !!ctx0 && !explicitCtx;
      const sessCtx = ctxOdd ? undefined : ctxBySession.get(ev.session);
      const ctx = ctxOdd ? '<CONTEXT>' : explicitCtx || (sessCtx && sessCtx !== '(cloud)' ? sessCtx : null);
      const local = !ctxOdd && isLocal(explicitCtx || (sessCtx === '(cloud)' ? null : sessCtx));
      // A delete only clears what it can reach: same cluster (when both are known) and the same namespace,
      // where no -n means the current one (as kubectl does), never "any".
      const here = (f) => !nsOdd && !ctxOdd && (!ctx || !f.ctx || f.ctx === ctx) && (ns || null) === (f.ns || null);
      // After get-credentials with a context we can't name: the teardown says which cluster to check, and --verify skips it.
      const ctxUnknown = !ctx && sessCtx === '(cloud)' ? (hintBySession.get(ev.session) || 'the cluster the agent connected to') : null;
      const base = { provider: 'k8s', time: ev.time, cwd: ev.cwd, session: ev.session, agent: ev.tool, status: 'left', failed: false, times: 1, ns: ns || null, ctx: ctx || null, command: simple, ...(ctxUnknown ? { ctxUnknown } : {}) };

      const add = (noun, rule, what, cost, name0, nsx0) => {
        if (local) { skippedLocal++; return; }
        // Names, namespaces and contexts end up in --verify calls: only accept what
        // Kubernetes itself allows, so a crafted name can never become a flag.
        const name = name0 && K8S_NAME.test(String(name0).replace(/\*$/, '')) ? name0 : null;
        const nsx = nsx0 && K8S_NAME.test(nsx0) ? nsx0 : null;
        const n = name || '(name not in the log)';
        const odd = nsOdd || ctxOdd || (!!nsx0 && !nsx);
        const nsv = nsx || (nsx0 ? '<NAMESPACE>' : ns || (nsOdd ? '<NAMESPACE>' : null));
        addFinding(`k8s|${noun}|${nsv || 'default'}|${n}|${ctx || ''}${name && !odd ? '' : '|' + ev.time + '|' + rule}`, {
          ...base, rule, what, cost, gpu: false, name: nsv ? `${n} (ns ${nsv})` : n, k8sName: n, ns: nsv, nameUnknown: !name || /\*$/.test(n),
          ...(odd ? { oddScope: true, note: 'the namespace or context has characters a shell would run as code, so the command shows <NAMESPACE> / <CONTEXT>: fill in the real one' } : {}),
          teardown: checkCtx(teardownFor(noun, name && !/\*$/.test(name) ? name : '<NAME>', nsv, ctx), ctxUnknown),
        });
      };

      if (isH) {
        // helm install NAME CHART | helm upgrade --install NAME CHART
        const verb = t0[1];
        if (verb === 'install' || (verb === 'upgrade' && hasFlag(t0, ['--install', '-i']))) {
          const HV = ['-n', '--namespace', '--kube-context', '-f', '--values', '--set', '--set-string', '--version', '--repo', '--timeout', '--kubeconfig'];
          const name = hasFlag(t0, ['--generate-name', '-g']) ? null : positional(t0, 2, HV);
          let i = t0.indexOf(name); const chart = name ? positional(t0, i + 1, HV) || '' : positional(t0, 2, HV) || '';
          const lb = LB_CHARTS.test(chart) || /service\.type=LoadBalancer|type=LoadBalancer/i.test(simple);
          add('helm', 'helm-release', lb ? 'Helm release + LB' : 'Helm release', lb ? 'hourly' : 'usage', name, ns);
        }
        if (verb === 'uninstall' || verb === 'delete' || verb === 'del' || verb === 'un') {
          const names = t0.slice(2).filter((x, j, a) => !x.startsWith('-') && !['-n', '--namespace', '--kube-context'].includes(a[j - 1]));
          for (const f of found.values()) if (f.rule === 'helm-release' && f.status === 'left' && names.includes(f.k8sName) && here(f)) f.status = 'cleaned';
        }
        continue;
      }

      const verb = t0[1];
      // kubectl expose deployment web --type=LoadBalancer [--name web-lb]
      if (verb === 'expose' && /LoadBalancer/.test(flag(t0, ['--type']) || '')) {
        const target = positional(t0, 2, KFLAGS);
        const second = target && !target.includes('/') ? positional(t0, t0.indexOf(target) + 1, KFLAGS) : null;
        const name = flag(t0, ['--name']) || (target && target.includes('/') ? tail(target) : second || target);
        add('service', 'k8s-lb-service', 'K8s LoadBalancer Service', 'hourly', name);
        continue;
      }
      // kubectl create service loadbalancer NAME
      if (verb === 'create' && t0[2] === 'service' && t0[3] === 'loadbalancer') {
        add('service', 'k8s-lb-service', 'K8s LoadBalancer Service', 'hourly', positional(t0, 4, KFLAGS));
        continue;
      }
      // kubectl create ingress NAME --rule=...
      if (verb === 'create' && (t0[2] === 'ingress' || t0[2] === 'ing')) {
        add('ingress', 'k8s-ingress', 'K8s Ingress (cloud LB)', 'hourly', positional(t0, 3, [...KFLAGS, '--rule', '--class', '--default-backend', '--annotation']));
        continue;
      }
      // kubectl patch svc NAME -p '{"spec":{"type":"LoadBalancer"}}'
      if (verb === 'patch' && /LoadBalancer/.test(simple) && KNOUN[(t0[2] || '').split('/')[0]] === 'service') {
        const name = t0[2].includes('/') ? tail(t0[2]) : positional(t0, 3, KFLAGS);
        add('service', 'k8s-lb-service', 'K8s LoadBalancer Service', 'hourly', name);
        continue;
      }
      // kubectl apply/create/replace -f FILE|DIR|-
      if (verb === 'apply' || verb === 'create' || verb === 'replace') {
        const targets = [];
        for (let i = 0; i < t0.length; i++) {
          if ((t0[i] === '-f' || t0[i] === '--filename') && t0[i + 1]) targets.push(t0[i + 1]);
          else if (t0[i].startsWith('--filename=')) targets.push(t0[i].slice(11));
          else if (/^-f.+/.test(t0[i])) targets.push(t0[i].slice(2));
        }
        const texts = [];
        for (const tg of targets) {
          if (tg === '-') { texts.push(...docsInCmd); continue; }
          if (/^https?:/.test(tg)) continue;
          const abs = path.normalize(path.isAbsolute(tg) ? tg : path.join(cwd, tg)).replace(/[\\/]+$/, '');
          if (files.has(abs)) { texts.push(files.get(abs)); continue; }
          for (const [p, c] of files) if (p.startsWith(abs + path.sep) && /\.ya?ml$|\.json$/i.test(p)) texts.push(c);
        }
        for (const text of texts) {
          for (const m of parseManifests(text)) {
            const b = billable(m);
            if (b) add(b.noun, b.rule, b.what, b.cost, m.name, m.namespace);
          }
        }
        continue;
      }
      // Cleanup
      if (verb === 'delete') {
        const rest = t0.slice(2);
        // kubectl delete namespace X
        if (['namespace', 'namespaces', 'ns'].includes(rest[0])) {
          const gone = rest.slice(1).filter((x) => !x.startsWith('-'));
          for (const f of found.values()) if (f.provider === 'k8s' && f.status === 'left' && !ctxOdd && f.ns && gone.includes(f.ns) && (!ctx || !f.ctx || f.ctx === ctx)) f.status = 'cleaned';
          continue;
        }
        // kubectl delete -f FILE  -> everything that file made
        const fIdx = rest.findIndex((x) => x === '-f' || x === '--filename');
        if (fIdx >= 0) {
          const tg = rest[fIdx + 1];
          const abs = tg && tg !== '-' ? path.normalize(path.isAbsolute(tg) ? tg : path.join(cwd, tg)).replace(/[\\/]+$/, '') : null;
          const texts = tg === '-' ? docsInCmd : abs && files.has(abs) ? [files.get(abs)] : [...files].filter(([p]) => abs && p.startsWith(abs + path.sep)).map(([, c]) => c);
          // Match kind and name: deleting Deployment "web" must not clear Service "web".
          const keys = new Set(texts.flatMap((x) => parseManifests(x).map((m) => { const b = billable(m); return b ? `${b.rule}|${m.name}|${m.namespace || ns || ''}` : null; }).filter(Boolean)));
          for (const f of found.values()) if (f.provider === 'k8s' && f.status === 'left' && !nsOdd && !ctxOdd && keys.has(`${f.rule}|${f.k8sName}|${f.ns || ''}`) && (!ctx || !f.ctx || f.ctx === ctx)) f.status = 'cleaned';
          continue;
        }
        // kubectl delete svc a b | svc/a ing/b
        let noun = null;
        for (const x of rest) {
          if (x.startsWith('-')) continue;
          if (x.includes('/')) {
            const [k, n] = x.split('/');
            const nn = KNOUN[k.toLowerCase()];
            if (nn) for (const f of found.values()) if (f.provider === 'k8s' && f.status === 'left' && f.k8sName === n && (f.rule.endsWith(nn) || (nn === 'service' && f.rule === 'k8s-lb-service')) && here(f)) f.status = 'cleaned';
            continue;
          }
          if (!noun) {
            const kinds = x.split(',').map((k) => KNOUN[k.toLowerCase()]).filter(Boolean);
            if (kinds.length) { noun = kinds; continue; }
            if (x === 'all') { noun = ['service']; continue; }
            break;
          }
          for (const f of found.values()) {
            if (f.provider !== 'k8s' || f.status !== 'left' || f.k8sName !== x) continue;
            const fn = f.rule === 'k8s-lb-service' ? 'service' : f.rule.replace('k8s-', '');
            if (noun.includes(fn) && here(f)) f.status = 'cleaned';
          }
        }
        if (noun && hasFlag(rest, ['--all'])) {
          for (const f of found.values()) {
            if (f.provider !== 'k8s' || f.status !== 'left') continue;
            const fn = f.rule === 'k8s-lb-service' ? 'service' : f.rule.replace('k8s-', '');
            if (noun.includes(fn) && !nsOdd && !ctxOdd && (!ctx || !f.ctx || f.ctx === ctx) && (hasFlag(rest, ['-A', '--all-namespaces']) || (ns || null) === (f.ns || null))) f.status = 'cleaned';
          }
        }
      }
    }
  }
  return { skippedLocal };
}

// Read-only check for --verify.
function k8sCheck(f) {
  if (f.provider !== 'k8s' || !f.k8sName || f.nameUnknown || f.ctxUnknown || f.oddScope) return null;
  if (f.rule === 'helm-release') {
    const args = ['status', f.k8sName];
    if (f.ns) args.push('-n', f.ns);
    if (f.ctx) args.push('--kube-context', f.ctx);
    return { cmd: 'helm', args };
  }
  const kind = { 'k8s-lb-service': 'service', 'k8s-ingress': 'ingress', 'k8s-gateway': 'gateway', 'k8s-pvc': 'pvc' }[f.rule];
  if (!kind) return null;
  const args = ['get', kind, f.k8sName, '-o', 'name'];
  if (f.ns) args.push('-n', f.ns);
  if (f.ctx) args.push('--context', f.ctx);
  return { cmd: 'kubectl', args };
}

module.exports = { k8sFindings, k8sCheck, parseManifests, LOCAL_CTX };
