'use strict';
const path = require('path');
const { splitCommands, stripHeredocs, tokenize, flag, hasFlag, isNoop, quoteToks, procFind, setPlatform } = require('./shell');
const { applySplit } = require('./teardown');
const { rules, matchPrefix } = require('./rules');
const mcp = require('./mcp');
const { k8sFindings } = require('./k8s');
const { specFrom, estimate } = require('./cost');
const { redact, redactArgs } = require('./redact');
const { tagsFromCommand, annotate } = require('./tags');
const { makeOrphans } = require('./orphans');

const LABEL = { supabase: 'Supabase', neon: 'Neon', vercel: 'Vercel', cloudflare: 'Cloudflare', aws: 'AWS', gcloud: 'Google Cloud', azure: 'Azure', railway: 'Railway', render: 'Render', netlify: 'Netlify', fly: 'Fly.io', digitalocean: 'DigitalOcean', heroku: 'Heroku', planetscale: 'PlanetScale', upstash: 'Upstash', pinecone: 'Pinecone', mongodb: 'MongoDB Atlas', turso: 'Turso', firebase: 'Firebase', modal: 'Modal', runpod: 'RunPod', e2b: 'E2B', koyeb: 'Koyeb', convex: 'Convex' };

// Every string value in an MCP call's arguments (one level of nesting), to match deletes.
function idsIn(input) {
  const out = new Set();
  const add = (v) => { if (typeof v === 'string' && v.trim()) out.add(v.trim()); else if (typeof v === 'number') out.add(String(v)); };
  if (input && typeof input === 'object') {
    for (const v of Object.values(input)) {
      add(v);
      if (Array.isArray(v)) v.forEach(add);
      else if (v && typeof v === 'object') Object.values(v).forEach(add);
    }
  }
  return out;
}

// Findings indexed by rule, by rule+name and by provider, so a delete never scans everything.
function makeIndex() {
  const found = new Map();
  const order = [];
  const byRule = new Map();
  const byRuleName = new Map();
  const byProv = new Map();
  const push = (m, k, f) => { let s = m.get(k); if (!s) m.set(k, (s = [])); s.push(f); };
  return {
    found, order,
    add(key, f) { found.set(key, f); order.push(key); push(byRule, f.rule, f); push(byRuleName, `${f.rule}|${f.name}`, f); push(byProv, f.provider, f); },
    rule: (r) => byRule.get(r) || [],
    named: (r, n) => byRuleName.get(`${r}|${n}`) || [],
    prov: (p) => byProv.get(p) || [],
  };
}

function mcpFindings(evs, addFinding, idx) {
  const mcpInputs = new WeakMap(); // finding -> create arguments (kept off the finding so they never reach the JSON output)
  for (const ev of evs) {
    if (ev.kind !== 'mcp') continue;
    const sp = mcp.splitName(ev.tool_name);
    if (!sp) continue;
    const c = mcp.classify(sp.server, sp.tool);
    if (!c) continue;
    const res = mcp.resultObj(ev.result);
    const resText = mcp.resultText(ev.result);
    const resErr = (res && typeof res === 'object' && (res.error || res.isError === true) && !mcp.pick(res, mcp.ID_KEYS)) || /^\s*(error|failed)\b/i.test(resText);
    const failed = ev.failed || !!resErr;
    if (c.kind === 'delete' || c.kind === 'stop') {
      if (failed) continue;
      const ids = idsIn(ev.input);
      for (const f of idx.prov(c.provider)) {
        if (f.via !== 'mcp' || f.status !== 'left' || f.noun !== c.noun) continue;
        if ((f.id && ids.has(f.id)) || (f.name && ids.has(f.name)) || (f.rawName && ids.has(f.rawName))) {
          // Same argument, different value (projectId p1 vs p2, name app vs other): a different resource.
          const fi = mcpInputs.get(f) || {}; const di = ev.input || {};
          if (Object.keys(fi).some((k) => typeof fi[k] === 'string' && typeof di[k] === 'string' && fi[k] !== di[k])) continue;
          // Another server of the same provider may be another account: only a maybe.
          if (c.kind === 'stop' || f.server !== sp.server) { f.status = 'maybe-cleaned'; if (c.kind === 'stop') f.stopNote = 'stopped, not deleted: disks and IPs may still bill'; } else f.status = 'cleaned';
        }
      }
      continue;
    }
    const name = mcp.pick(ev.input, mcp.NAME_KEYS) || (res && mcp.pick(res, mcp.NAME_KEYS)) || null;
    const id = (res && mcp.pick(res, mcp.ID_KEYS)) || null;
    const handle = id || name;
    const label = LABEL[c.provider] || sp.server;
    const args = JSON.stringify(redactArgs(ev.input || {}));
    const mkey = `mcp|${c.provider}|${c.noun}|${handle || ev.time}`;
    addFinding(mkey, {
      rule: `mcp-${c.provider}-${c.noun.replace(/\s+/g, '-').toLowerCase()}`, provider: c.provider, what: `${label} ${c.noun}`, gpu: c.noun === 'GPU pod', cost: c.cost, noun: c.noun,
      name: name && id && name !== id ? `${name} (${id})` : handle || '(name not in the log)', rawName: name, id, nameUnknown: !handle,
      teardown: mcp.teardownFor(c, { name, id, server: sp.server, input: ev.input }), command: redact(`${ev.tool_name} ${args.length > 160 ? args.slice(0, 157) + '...' : args}`),
      time: ev.time, cwd: ev.cwd, session: ev.session, agent: ev.tool, via: 'mcp', server: sp.server, url: c.url, deploy: c.noun === 'deployment',
      status: failed ? 'failed' : 'left', failed, times: 1,
    });
    if (ev.input && typeof ev.input === 'object' && !failed) mcpInputs.set(idx.found.get(mkey), ev.input);
  }
}

const AI_APIS = [
  { re: /api\.openai\.com|from openai import|import openai|require\(['"]openai['"]\)|from ['"]openai['"]|new OpenAI\(|OpenAI\(\)/, name: 'OpenAI', usage: 'https://platform.openai.com/usage' },
  { re: /api\.anthropic\.com|from anthropic import|import anthropic|['"]@anthropic-ai\/sdk['"]|new Anthropic\(|Anthropic\(\)/, name: 'Anthropic', usage: 'https://console.anthropic.com/settings/usage' },
  { re: /generativelanguage\.googleapis\.com|google\.generativeai|from google import genai|['"]@google\/genai['"]|['"]@google\/generative-ai['"]|aiplatform\.googleapis\.com|vertexai/, name: 'Google Gemini / Vertex', usage: 'https://console.cloud.google.com/billing' },
  { re: /api\.mistral\.ai|from mistralai/, name: 'Mistral', usage: 'https://console.mistral.ai/usage' },
  { re: /openrouter\.ai\/api/, name: 'OpenRouter', usage: 'https://openrouter.ai/activity' },
  { re: /api\.replicate\.com|import replicate/, name: 'Replicate', usage: 'https://replicate.com/account/billing' },
  { re: /api\.elevenlabs\.io|from elevenlabs/, name: 'ElevenLabs', usage: 'https://elevenlabs.io/app/usage' },
];
const KEY_RE = /(OPENAI|ANTHROPIC|GEMINI|GOOGLE|MISTRAL|OPENROUTER|REPLICATE|ELEVENLABS)[A-Z_]*_(API_)?(KEY|TOKEN)|load_dotenv|dotenv|process\.env|os\.environ|os\.getenv/;
const LOOP_RE = /\bfor\s*\(|\bfor\s+\w+\s+in\b|\bwhile\b|\.map\(|\.forEach\(|Promise\.all|asyncio\.gather|ThreadPool|concurrent\.futures|range\(\s*\d{2,}/;
const BG_RE = /(^|\s)(nohup|setsid|disown)\b|&\s*$/;

// A create whose result says the agent stopped waiting (timeout, interrupt): the cloud side may have finished.
const UNCERTAIN_NOTE = 'the agent stopped waiting (timeout or interrupt); the cloud operation may still have finished';

// A name that can go into a teardown as is (anything else becomes <NAME>).
const TD_NAME = /^[A-Za-z0-9][A-Za-z0-9._:\/@=+-]*$/;

const isVar = (s) => !s || /[$`<>{}]/.test(s);

function short(p) {
  if (!p) return '';
  const home = require('os').homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

// Per platform (pgrep on macOS/Linux, Get-CimInstance through powershell.exe on Windows, which
// also works when pasted into cmd.exe).
const findProcess = (word) => procFind(word);

// Account, project and region a command ran under: flags, env vars, and what the
// session set earlier (gcloud config set project, export AWS_PROFILE=...).
function scopeOf(t, sess) {
  const env = t.env || {};
  const sc = {};
  if (t[0] === 'gcloud' || t[0] === 'gsutil') {
    sc.project = flag(t, ['--project']) || env.CLOUDSDK_CORE_PROJECT || sess.project || null;
    sc.account = flag(t, ['--account']) || env.CLOUDSDK_CORE_ACCOUNT || sess.account || null;
    sc.configuration = flag(t, ['--configuration']) || env.CLOUDSDK_ACTIVE_CONFIG_NAME || sess.configuration || null;
    // --location takes a zone (us-central1-a) or a region (us-central1).
    const loc = flag(t, ['--location']);
    const zoneLike = loc && /^[a-z]+-[a-z]+\d+-[a-z]$/.test(loc);
    sc.zone = flag(t, ['--zone']) || (zoneLike ? loc : null);
    sc.region = flag(t, ['--region']) || (loc && !zoneLike ? loc : null);
    // gcloud config set compute/zone|compute/region (or CLOUDSDK_COMPUTE_ZONE/REGION) is the default
    // location for zonal Compute Engine, TPU and GKE commands that give none.
    const g = t[1] === 'beta' || t[1] === 'alpha' ? t.slice(1) : t;
    const zonal = (g[1] === 'compute' && ['instances', 'disks', 'tpus'].includes(g[2])) || (g[1] === 'container' && ['clusters', 'node-pools'].includes(g[2]));
    const noLoc = !loc && !sc.zone && !sc.region && !hasFlag(t, ['--global']);
    if (zonal && noLoc) sc.zone = env.CLOUDSDK_COMPUTE_ZONE || sess.zone || null;
    if (g[1] === 'compute' && g[2] === 'addresses' && noLoc) sc.region = env.CLOUDSDK_COMPUTE_REGION || sess.region || null;
    if (t[1] === 'container' && t[2] === 'node-pools') sc.cluster = flag(t, ['--cluster']) || null;
  }
  if (t[0] === 'aws' || t[0] === 'eksctl' || t[0] === 'sam' || t[0] === 'cdk') {
    sc.profile = flag(t, ['--profile']) || env.AWS_PROFILE || sess.profile || null;
    sc.region = flag(t, ['--region']) || env.AWS_REGION || env.AWS_DEFAULT_REGION || sess.region || null;
    if (t[1] === 'ecs' && /-service$/.test(t[2] || '')) sc.cluster = flag(t, ['--cluster']) || 'default';
    if (t[0] === 'eksctl' && ['nodegroup', 'ng'].includes(t[2])) sc.cluster = flag(t, ['--cluster']) || null;
  }
  if (t[0] === 'serverless') {
    // A remove without --stage targets the default stage, so an unknown stage still matches (as before).
    sc.stage = flag(t, ['--stage', '-s']) || null;
    sc.region = flag(t, ['--region', '-r']) || null;
    sc.profile = flag(t, ['--aws-profile']) || env.AWS_PROFILE || sess.profile || null;
  }
  if (t[0] === 'sst') sc.stage = flag(t, ['--stage']) || env.SST_STAGE || null;
  if (t[0] === 'terraform' || t[0] === 'tofu') sc.workspace = env.TF_WORKSPACE || null;
  if (t[0] === 'docker' || t[0] === 'docker-compose') sc.project = flag(t, ['-p', '--project-name']) || env.COMPOSE_PROJECT_NAME || null;
  if (t[0] === 'az') {
    sc.subscription = (flag(t, ['--subscription']) || sess.subscription || '').toLowerCase() || null;
    const ids = flag(t, ['--ids']); const m = ids && ids.match(/\/resourceGroups\/([^/]+)/i);
    if (t[1] !== 'group') sc.resourceGroup = (flag(t, ['--resource-group', '-g']) || (m && m[1]) || '').toLowerCase() || null;
    if (t[1] === 'aks' && t[2] === 'nodepool') sc.cluster = (flag(t, ['--cluster-name']) || '').toLowerCase() || null;
    // Parents that delete their children: an Azure OpenAI account its deployments, a SQL server its databases.
    if (t[1] === 'cognitiveservices' && t[2] === 'account' && t[3] === 'deployment') sc.cluster = (flag(t, ['--name', '-n']) || '').toLowerCase() || null;
    if (t[1] === 'sql' && t[2] === 'db') sc.cluster = (flag(t, ['--server', '-s']) || '').toLowerCase() || null;
    if (t[1] === 'ml') sc.workspace = (flag(t, ['--workspace-name', '-w']) || '').toLowerCase() || null;
  }
  if (t[0] === 'heroku' && /^addons:/.test(t[1] || '')) sc.app = flag(t, ['--app', '-a']) || null;
  if (t[0] === 'doctl') sc.configuration = flag(t, ['--context']) || null;
  for (const k of Object.keys(sc)) if (!sc[k]) delete sc[k];
  return sc;
}
// Two scopes clash only when both name a value for the same key and the values differ;
// an unknown side (no flag, no session setting) still matches, as before.
const SCOPE_KEYS = ['project', 'account', 'configuration', 'profile', 'region', 'zone', 'subscription', 'resourceGroup', 'cluster', 'app', 'stage', 'workspace'];
const scopeKey = (sc) => SCOPE_KEYS.map((k) => sc[k] || '').join('/');
function sameScope(a, b) {
  a = a || {}; b = b || {};
  for (const k of SCOPE_KEYS) if (a[k] && b[k] && a[k] !== b[k]) return false;
  return true;
}
const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
function addScope(teardown, prov, sc) {
  if (!sc) return teardown;
  const extra = (m) => {
    let x = '';
    if (/^gcloud /.test(m) && sc.project && SAFE_SCOPE.test(sc.project) && !/--project/.test(m)) x += ` --project ${sc.project}`;
    if (/^gcloud /.test(m) && sc.account && SAFE_SCOPE.test(sc.account) && !/--account/.test(m)) x += ` --account ${sc.account}`;
    if (/^gcloud /.test(m) && sc.configuration && SAFE_SCOPE.test(sc.configuration) && !/--configuration/.test(m)) x += ` --configuration ${sc.configuration}`;
    // A zone or region that came from gcloud config set compute/zone|region: say it on the delete.
    const noLoc = !/--(zone|region|location|global)\b/.test(m);
    if (/^gcloud (compute (instances|disks|tpus tpu-vm)|container (clusters|node-pools)) /.test(m) && noLoc && sc.zone && SAFE_SCOPE.test(sc.zone)) x += ` --zone ${sc.zone}`;
    else if (/^gcloud compute addresses /.test(m) && noLoc && sc.region && SAFE_SCOPE.test(sc.region)) x += ` --region ${sc.region}`;
    if (/^aws /.test(m)) {
      if (sc.profile && SAFE_SCOPE.test(sc.profile) && !/--profile/.test(m)) x += ` --profile ${sc.profile}`;
      if (sc.region && SAFE_SCOPE.test(sc.region) && !/--region/.test(m)) x += ` --region ${sc.region}`;
    }
    if (/^(eksctl|sam|cdk) /.test(m) && sc.profile && SAFE_SCOPE.test(sc.profile) && !/--profile/.test(m)) x += ` --profile ${sc.profile}`;
    if (/^(eksctl|sam) /.test(m) && sc.region && SAFE_SCOPE.test(sc.region) && !/--region/.test(m)) x += ` --region ${sc.region}`;
    // cdk has no --region flag: it reads AWS_REGION.
    if (/^cdk /.test(m) && sc.region && SAFE_SCOPE.test(sc.region) && !/AWS_REGION=/.test(m)) return `AWS_REGION=${sc.region} ${m}${x}`;
    if (/^az /.test(m) && sc.subscription && SAFE_SCOPE.test(sc.subscription) && !/--subscription/.test(m)) x += ` --subscription ${sc.subscription}`;
    return m + x;
  };
  // A comma ends a command only before a space ("..., or"): Name=x,Values=running is one argument
  // (a --region put after the comma split the EC2 --filters value in two).
  return teardown.replace(/(?<![\w./'-])(gcloud|aws|eksctl|az|sam|cdk) [^#;(]*?(?=\s{2,}#|\s{2,}\(|;|,\s|,$|$)/g, extra);
}

// The word that names a background process in pgrep: the script it runs, the module of
// python -m MODULE, else the program.
const BG_SKIP = new Set(['sleep', 'echo', 'printf', 'wait', 'true', 'false', 'tail', 'cat', 'grep', 'egrep', 'fgrep', 'rg', 'ps', 'pgrep', 'pkill', 'kill', 'killall', 'man', 'which', 'type', 'test', '[', 'cd', 'ls']);
function bgWord(toks0) {
  const t = toks0.filter((x) => !['nohup', 'setsid', 'disown', '&'].includes(x));
  const script = t.find((x, i) => i > 0 && !x.startsWith('-') && /[^\\/]\.(py|js|ts|mjs|cjs|sh|rb|go|php|pl)$/.test(x));
  if (script) return script.replace(/^.*[\\/]/, '');
  const prog = (t[0] || '').replace(/^.*[\\/]/, '');
  if (/^(python[\d.]*|py|pypy[\d.]*|uv|uvx)$/.test(prog)) {
    const m = t.indexOf('-m');
    if (m > 0 && t[m + 1] && !t[m + 1].startsWith('-')) return t[m + 1];
  }
  return (t.filter((x) => !x.startsWith('-'))[0] || '').replace(/^.*[\\/]/, '');
}
// The first word of a command as written (after VAR=x prefixes and wrapper words), with its folder.
function rawFirstWord(simple) {
  const w = String(simple).trim().replace(/^[({]\s*/, '').split(/\s+/);
  let i = 0;
  while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || ['then', 'do', 'else', '!', 'sudo', 'nohup', 'exec', 'time', 'command'].includes(w[i]))) i++;
  return (w[i] || '').replace(/[;)}]+$/, '');
}
// Did a later kill stop this background process? pkill -f PAT matches its command line, pkill/killall NAME
// its program name, kill $(pgrep -f X) / kill $(lsof ...) names it in the text; a bare kill %1 / $! / PID
// in the same session may have.
function killVerdict(b, kills) {
  let verdict = null;
  const prog = (tokenize(b.simple).filter((x) => !['nohup', 'setsid'].includes(x))[0] || '').replace(/^.*[\\/]/, '');
  const cmdline = tokenize(b.simple).filter((x) => !['nohup', 'setsid', '&'].includes(x)).join(' ');
  for (const k of kills) {
    if (k.seq <= b.seq) continue;
    const same = k.session === b.ev.session;
    let hit = false;
    let sure = true;
    const pats = k.args.filter((x) => !x.startsWith('-'));
    if (k.cmd === 'pkill' || k.cmd === 'killall') {
      const full = k.cmd === 'pkill' && k.args.some((x) => /^-[a-zA-Z]*f/.test(x));
      for (const p of pats) {
        let re = null;
        try { re = new RegExp(p); } catch { re = null; }
        if (full ? (re ? re.test(cmdline) : cmdline.includes(p)) : (k.cmd === 'killall' ? p === prog : (re ? re.test(prog) : p === prog))) hit = true;
      }
    } else {
      // kill: by a lookup that names it, or by job/PID (which we can't map to a command)
      if (k.simple.includes(b.word)) hit = true;
      else if (same && pats.some((x) => /^(%\d*|%[+-]|\$!|\$\w+|\d+)$/.test(x))) { hit = true; sure = false; }
    }
    if (!hit) continue;
    const v = sure && same && !k.uncertain ? 'cleaned' : 'maybe-cleaned';
    if (v === 'cleaned') return v;
    verdict = v;
  }
  return verdict;
}

function scan(events, opts = {}) {
  const prev = setPlatform(opts.platform);
  try { return scanIn(events, opts); } finally { setPlatform(prev); }
}

function scanIn(events, { project } = {}) {
  const evs = project ? events.filter((e) => (e.cwd || '').toLowerCase().includes(project.toLowerCase())) : events;
  const idx = makeIndex();
  const { found } = idx;
  const sessScope = new Map();
  const written = new Map(); // abs path -> content the agent wrote (to follow scripts it then runs)
  const bg = [];
  const kills = []; // pkill / killall / kill commands, to clear background processes started earlier
  let seq = 0;

  const addFinding = (key, f) => {
    if (found.has(key)) {
      const old = found.get(key);
      old.times += 1;
      // a later successful create re-opens something that was cleaned or failed
      if (!f.failed) { old.status = 'left'; old.time = f.time; old.command = f.command; old.session = f.session; old.teardown = f.teardown; old.scope = f.scope || old.scope; old.spec = f.spec || old.spec; if (f.instanceIds) old.instanceIds = f.instanceIds; if (f.uncertain) old.uncertain = f.uncertain; else delete old.uncertain; if (f.tags) { delete old.expires; delete old.expired; delete old.expiresRaw; delete old.sessionTag; annotate(old, f.tags, f.time); } }
      return;
    }
    idx.add(key, f);
  };
  const orphanSimple = makeOrphans(idx, addFinding, addScope);

  // uncertain: this part sat in a command line (or script) that failed, so a delete in it may not have run.
  const handleSimple = (simple, ev, failed, sess, origin, uncertain = false) => {
    const toks0 = tokenize(simple);
    if (!toks0.length) return;
    // session state that later commands inherit
    if (toks0[0] === 'export' || toks0[0] === 'set') {
      for (const kv of toks0.slice(1)) {
        const m = kv.match(/^(AWS_PROFILE|AWS_REGION|AWS_DEFAULT_REGION|CLOUDSDK_CORE_PROJECT|CLOUDSDK_CORE_ACCOUNT|CLOUDSDK_ACTIVE_CONFIG_NAME|CLOUDSDK_COMPUTE_ZONE|CLOUDSDK_COMPUTE_REGION)=(.*)$/);
        if (!m) continue;
        if (m[1] === 'AWS_PROFILE') sess.profile = m[2];
        else if (m[1] === 'CLOUDSDK_COMPUTE_ZONE') sess.zone = m[2];
        else if (m[1] === 'CLOUDSDK_COMPUTE_REGION') sess.region = m[2];
        else if (m[1] === 'CLOUDSDK_CORE_PROJECT') sess.project = m[2];
        else if (m[1] === 'CLOUDSDK_CORE_ACCOUNT') sess.account = m[2];
        else if (m[1] === 'CLOUDSDK_ACTIVE_CONFIG_NAME') sess.configuration = m[2];
        else sess.region = m[2];
      }
      return;
    }
    if (toks0[0] === 'gcloud' && toks0[1] === 'config' && toks0[2] === 'set' && (toks0[3] === 'project' || toks0[3] === 'core/project') && toks0[4] && !failed) { sess.project = toks0[4]; return; }
    if (toks0[0] === 'gcloud' && toks0[1] === 'config' && toks0[2] === 'set' && (toks0[3] === 'account' || toks0[3] === 'core/account') && toks0[4] && !failed) { sess.account = toks0[4]; return; }
    if (toks0[0] === 'gcloud' && toks0[1] === 'config' && toks0[2] === 'set' && (toks0[3] === 'compute/zone' || toks0[3] === 'compute/region') && toks0[4] && !failed) { sess[toks0[3] === 'compute/zone' ? 'zone' : 'region'] = toks0[4]; return; }
    if (toks0[0] === 'gcloud' && toks0[1] === 'config' && toks0[2] === 'unset' && ['compute/zone', 'compute/region', 'project', 'core/project'].includes(toks0[3]) && !failed) { delete sess[{ 'compute/zone': 'zone', 'compute/region': 'region' }[toks0[3]] || 'project']; return; }
    if (toks0[0] === 'gcloud' && toks0[1] === 'config' && toks0[2] === 'configurations' && toks0[3] === 'activate' && toks0[4] && !failed) { sess.configuration = toks0[4]; delete sess.project; delete sess.account; delete sess.zone; delete sess.region; return; }
    if (toks0[0] === 'aws' && toks0[1] === 'configure' && toks0[2] === 'set' && toks0[3] === 'region' && toks0[4] && !failed) { sess.region = toks0[4]; return; }
    if (toks0[0] === 'az' && toks0[1] === 'account' && toks0[2] === 'set') { if (failed) return; const s = flag(toks0, ['--subscription', '-s']); if (s) sess.subscription = s; return; }
    if (isNoop(toks0)) return;
    // background process the agent left running
    const order = ++seq;
    let bgItem = null;
    if (!failed && (BG_RE.test(simple) || ev.background) && !/\b(docker|podman|ngrok|cloudflared|tailscale)\b/.test(simple)) {
      const word = bgWord(toks0);
      if (word && !BG_SKIP.has(word)) bgItem = { word, simple, ev, origin, seq: order };
    }
    // pkill -f PAT / killall NAME / kill ...: may stop a background process started earlier.
    if (!failed && ['pkill', 'killall', 'kill'].includes(toks0[0])) kills.push({ cmd: toks0[0], args: toks0.slice(1), simple, session: ev.session, seq: order, uncertain });
    // docker run / docker compose up without -d, sent to the background (& or the tool's background flag), keep running too.
    if (!ev.detached && (/&\s*$/.test(simple) || ev.background)) ev = { ...ev, detached: true };
    let ruleHit = false;
    for (const r of rules) {
      // A rule may list several undos (gsutil rb and gcloud storage buckets delete both remove a bucket).
      if (r.undo && !failed) for (const u of (Array.isArray(r.undo) ? r.undo : [r.undo])) {
        const ut = matchPrefix(toks0, u.when);
        if (ut && !(u.skipIf && u.skipIf(ut))) {
          const names = u.multi ? u.multi(ut) : u.any ? null : [u.name(ut, ev)];
          // Only clean findings in the same project/account/region: a delete in project A must not clear "web" in project B.
          const usc = scopeOf(ut, sess);
          const same = (f) => sameScope(f.scope, usc);
          const done = uncertain ? 'maybe-cleaned' : 'cleaned';
          const named = (n) => (r.provider === 'az' ? idx.rule(r.id).filter((f) => String(f.name).toLowerCase() === String(n).toLowerCase()) : idx.named(r.id, n));
          if (names === null) {
            for (const f of idx.rule(r.id)) {
              if (f.status !== 'left' || !same(f)) continue;
              const v = u.pick ? u.pick(f, ut) : 'maybe';
              if (v === 'yes') f.status = done; else if (v === 'maybe') f.status = 'maybe-cleaned';
            }
          } else for (const n of names) if (n !== undefined && n !== null) for (const f of named(n)) if (f.status === 'left' && same(f)) f.status = isVar(n) && f.session !== ev.session ? 'maybe-cleaned' : done;
        }
      }
      const t = matchPrefix(toks0, r.when);
      if (!t) continue;
      const names = r.multi ? r.multi(t) : [r.name(t, ev)];
      if (names.some((n) => n === undefined)) continue; // rule matched the verb but not a create
      ruleHit = true;
      const sc = scopeOf(t, sess);
      const tags = tagsFromCommand(toks0, simple);
      for (let n of names) {
        const unknown = isVar(n);
        if (unknown) n = n ? n : '(name not in the command)';
        const key = `${r.id}|${r.provider === 'az' ? n.toLowerCase() : n}|${unknown ? ev.time : ''}|${scopeKey(sc)}`;
        // Names and flag values go into a command the user may copy: a name with shell characters
        // becomes <NAME> (folder paths are single-quoted by the rule), odd flag values are quoted.
        const plain = !unknown && (r.pathName || TD_NAME.test(n));
        let unsafeName = !unknown && !plain && !/^\(.*\)$/.test(n);
        let teardown;
        try { teardown = r.teardown(plain ? n : '<NAME>', quoteToks(t), ev); } catch { teardown = '(see provider console)'; }
        // Only warn about the name when the teardown actually uses it (EC2's "1 x t3.large" label does not).
        if (unsafeName && !String(teardown).includes('<NAME>')) unsafeName = false;
        teardown = addScope(teardown, r.provider, sc);
        // cost may depend on the command (an Azure OpenAI deployment is hourly only when provisioned).
        const cost = typeof r.cost === 'function' ? r.cost(t) : r.cost;
        const accel = typeof r.accel === 'function' ? !!r.accel(t) : !!r.accel;
        const gpu = !accel && /--accelerator|--gpu|nvidia|\b(g2|a2|a3|a4)-|\b(p3|p4d?|p5e?|g4dn|g5|g6e?)\.|\bml\.(p|g)\d|\bstandard_n[cdv]\d|gpu/i.test(simple) && cost === 'hourly';
        addFinding(key, annotate({
          rule: r.id, provider: r.provider, what: gpu ? r.what + ' (GPU)' : r.what, gpu, ...(accel ? { accel: true } : {}), cost, deploy: !!r.deploy, name: n,
          nameUnknown: unknown, teardown, command: redact(simple), time: ev.time, cwd: ev.cwd, scope: sc, spec: specFrom(r.id, flag, t),
          session: ev.session, agent: ev.tool, status: failed ? 'failed' : 'left', failed, times: 1, ...(origin ? { viaScript: origin } : {}),
          ...(ev.uncertain && !failed ? { uncertain: UNCERTAIN_NOTE } : {}),
          ...(unsafeName || toks0.via ? { note: [unsafeName ? 'the name has characters a shell would run as code, so the command shows <NAME>: copy the real name from the provider console' : null, toks0.via ? `created through "${toks0.via}": run the teardown the same way, so it uses the same credentials` : null].filter(Boolean).join('; ') } : {}),
          ...(r.id === 'aws-ec2' && ev.instanceIds && ev.instanceIds.length ? { instanceIds: ev.instanceIds } : {}),
        }, redactArgs(tags), ev.time));
      }
    }
    // A cloud create sent to the background (gcloud ... create vm &) is listed once, as the VM,
    // not again as a background process called "gcloud".
    if (bgItem && !ruleHit) bg.push(bgItem);
    // Orphans: what a delete leaves behind (kept disks, EIPs, Azure VM parts).
    if (!failed) orphanSimple(toks0, simple, ev, scopeOf(toks0, sess), sameScope, uncertain);
  };

  for (const ev of evs) {
    if (ev.kind === 'write' && ev.file) {
      const abs = path.normalize(path.isAbsolute(ev.file) ? ev.file : path.join(ev.cwd || '', ev.file));
      written.set(abs, String(ev.content || ''));
      continue;
    }
    if (ev.kind !== 'cmd') continue;
    let sess = sessScope.get(ev.session);
    if (!sess) sessScope.set(ev.session, (sess = {}));
    const parts = splitCommands(ev.command);
    let cwd = ev.cwd || '';
    let subCwd = null; // the folder before a ( subshell: a cd inside it ends at its )
    parts.forEach((simple, i) => {
      // A failed command line: blame the last command, not the deploy before it.
      const failed = ev.failed && i === parts.length - 1;
      // A timed-out or interrupted line (ev.uncertain) may have finished too: its deletes are only a maybe.
      const uncertain = (!!ev.failed && !failed) || !!ev.uncertain;
      const t = tokenize(simple);
      if (/^\(/.test(simple) && subCwd === null) subCwd = cwd;
      const closes = subCwd !== null && /\)\s*(?:[<>&|0-9][^)]*)?$/.test(simple) && !/\$\([^)]*\)\s*$/.test(simple);
      const endSub = () => { if (closes) { cwd = subCwd; subCwd = null; } };
      if (t[0] === 'cd' && t[1]) { cwd = path.isAbsolute(t[1]) ? t[1] : path.join(cwd, t[1]); endSub(); return; }
      // A background flag on the tool call (run_in_background, is_background, detach) applies to the last command.
      const bgFlag = !!ev.background && i === parts.length - 1;
      // bash -c, and also -lc / -ec / -xc / -euc ...
      const ci = ['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(t[0]) ? t.findIndex((x, j) => j > 0 && /^-[a-z]*c[a-z]*$/.test(x)) : -1;
      const outerBg = bgFlag && !(ci > 0 && t[ci + 1]);
      const ctx = cwd === (ev.cwd || '') && outerBg === !!ev.background ? ev : { ...ev, cwd, background: outerBg };
      handleSimple(simple, ctx, failed, sess, null, uncertain);
      // bash -c "...": the string is the command line.
      if (ci > 0 && t[ci + 1]) {
        const inner = splitCommands(t[ci + 1]);
        inner.forEach((line, j) => handleSimple(line, { ...ctx, background: bgFlag && j === inner.length - 1 }, false, sess, null, !!ev.failed || !!ev.uncertain));
      }
      // A shell script the agent wrote and then ran: read its commands too.
      // tokenize() drops the folder from the first word (./scripts/up.sh -> up.sh), so take it from the raw text.
      const raw0 = rawFirstWord(simple);
      const script = (['bash', 'sh', 'zsh', 'dash', 'ksh', 'source', '.'].includes(t[0])) ? t.find((x, j) => j > 0 && !x.startsWith('-')) : /\.sh$/.test(raw0) && /^[\w./~-]+$/.test(raw0) ? raw0 : /^\.?\.?[\\/].*\.sh$|^[\w.-]+\.sh$/.test(t[0]) ? t[0] : null;
      if (script && ci < 0) {
        const abs = path.normalize(path.isAbsolute(script) ? script : path.join(cwd, script));
        const body = written.get(abs);
        // A failed script still ran its first commands: count its creates, but its deletes only as maybe.
        let scwd = cwd;
        if (body) for (const line of splitCommands(body)) {
          if (line.startsWith('#')) continue;
          const lt = tokenize(line);
          if (lt[0] === 'cd' && lt[1]) { scwd = path.isAbsolute(lt[1]) ? lt[1] : path.join(scwd, lt[1]); continue; }
          handleSimple(line, { ...ev, cwd: scwd, background: false }, false, sess, path.basename(abs), !!ev.failed || !!ev.uncertain);
        }
      }
      endSub();
    });
  }

  mcpFindings(evs, addFinding, idx);
  const k8s = k8sFindings(evs, addFinding, { values: () => idx.prov('k8s') });

  // Scripts the agent wrote that call a paid AI API with your key.
  const scripts = new Map();
  for (const ev of evs) {
    if (ev.kind !== 'write' || !ev.content) continue;
    const api = AI_APIS.find((a) => a.re.test(ev.content));
    if (!api || !KEY_RE.test(ev.content)) continue;
    const abs = path.isAbsolute(ev.file) ? ev.file : path.join(ev.cwd || '', ev.file);
    scripts.set(abs, { file: abs, api: api.name, usage: api.usage, loop: LOOP_RE.test(ev.content), time: ev.time, session: ev.session, agent: ev.tool, cwd: ev.cwd, ran: 0, background: false });
  }
  for (const ev of evs) {
    if (ev.kind !== 'cmd' || ev.failed) continue;
    for (const s of scripts.values()) {
      const base = path.basename(s.file);
      if (base.length < 3 || !ev.command.includes(base)) continue;
      if (!/\b(python3?|node|bun|deno|tsx|ts-node|bash|sh|uv run|npx)\b|\.\//.test(ev.command)) continue;
      if (String(ev.time || '') < String(s.time || '')) continue;
      s.ran += 1;
      if (/(^|\s)(nohup|setsid|screen|tmux)\b|&\s*$|&\s*(disown)?\s*$/.test(ev.command)) s.background = true;
    }
  }
  // Direct curl loops against paid AI endpoints.
  for (const ev of evs) {
    if (ev.kind !== 'cmd' || ev.failed) continue;
    const cmd = stripHeredocs(ev.command);
    const api = AI_APIS.find((a) => a.re.test(cmd));
    if (api && /\b(for|while)\b/.test(cmd)) {
      scripts.set('cmd:' + ev.time + cmd.slice(0, 40), { file: '(shell loop)', command: redact(cmd.slice(0, 120)), api: api.name, usage: api.usage, loop: true, time: ev.time, session: ev.session, agent: ev.tool, cwd: ev.cwd, ran: 1, background: /&\s*$/.test(cmd) });
    }
  }
  const spendFiles = new Set([...scripts.values()].map((s) => path.basename(s.file)));

  // Background processes (nohup / setsid / trailing &) that may still be running.
  for (const b of bg) {
    if (spendFiles.has(b.word)) continue;
    const key = `bg|${b.ev.session}|${b.word}`;
    addFinding(key, {
      rule: 'bg-process', provider: 'local', what: 'Background process', gpu: false, cost: 'local', name: b.word, nameUnknown: false,
      teardown: findProcess(b.word), command: redact(b.simple), time: b.ev.time, cwd: b.ev.cwd, session: b.ev.session, agent: b.ev.tool,
      status: 'left', failed: false, times: 1, ...(b.origin ? { viaScript: b.origin } : {}),
    });
    // A later pkill / killall / kill in the logs may have stopped it.
    const f = found.get(key);
    const v = killVerdict(b, kills);
    if (v && f.status === 'left') f.status = v;
  }

  const resources = idx.order.map((k) => found.get(k));
  for (const f of resources) { const e = estimate(f); if (e) f.estimate = e; applySplit(f); }
  const spend = [...scripts.values()].filter((s) => s.ran > 0).map((s) => applySplit({
    ...s,
    teardown: s.background ? `${findProcess(path.basename(s.file))}. Usage: ${s.usage}` : `check usage at ${s.usage}`,
  }));
  return { resources, spend, scannedEvents: evs.length, mcpCalls: evs.filter((e) => e.kind === 'mcp').length, k8sLocalSkipped: k8s.skippedLocal };
}

module.exports = { scan, short, addScope };
