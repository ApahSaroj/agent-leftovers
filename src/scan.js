'use strict';
const path = require('path');
const { splitCommands, stripHeredocs, tokenize, flag, isNoop } = require('./shell');
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
          if (c.kind === 'stop') { f.status = 'maybe-cleaned'; f.stopNote = 'stopped, not deleted: disks and IPs may still bill'; } else f.status = 'cleaned';
        }
      }
      continue;
    }
    const name = mcp.pick(ev.input, mcp.NAME_KEYS) || (res && mcp.pick(res, mcp.NAME_KEYS)) || null;
    const id = (res && mcp.pick(res, mcp.ID_KEYS)) || null;
    const handle = id || name;
    const label = LABEL[c.provider] || sp.server;
    const args = JSON.stringify(redactArgs(ev.input || {}));
    addFinding(`mcp|${c.provider}|${c.noun}|${handle || ev.time}`, {
      rule: `mcp-${c.provider}-${c.noun.replace(/\s+/g, '-').toLowerCase()}`, provider: c.provider, what: `${label} ${c.noun}`, gpu: c.noun === 'GPU pod', cost: c.cost, noun: c.noun,
      name: name && id && name !== id ? `${name} (${id})` : handle || '(name not in the log)', rawName: name, id, nameUnknown: !handle,
      teardown: mcp.teardownFor(c, { name, id, server: sp.server, input: ev.input }), command: redact(`${ev.tool_name} ${args.length > 160 ? args.slice(0, 157) + '...' : args}`),
      time: ev.time, cwd: ev.cwd, session: ev.session, agent: ev.tool, via: 'mcp', server: sp.server, url: c.url,
      status: failed ? 'failed' : 'left', failed, times: 1,
    });
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

const isVar = (s) => !s || /[$`<>{}]/.test(s);

function short(p) {
  if (!p) return '';
  const home = require('os').homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function findProcess(word) {
  return process.platform === 'win32'
    ? `Get-CimInstance Win32_Process | ? CommandLine -match "${word}" | select ProcessId,CommandLine   # then: Stop-Process -Id <PID>`
    : `pgrep -af "${word}"   # check it is the right one, then: kill <PID>`;
}

// Account, project and region a command ran under: flags, env vars, and what the
// session set earlier (gcloud config set project, export AWS_PROFILE=...).
function scopeOf(t, sess) {
  const env = t.env || {};
  const sc = {};
  if (t[0] === 'gcloud' || t[0] === 'gsutil') {
    sc.project = flag(t, ['--project']) || env.CLOUDSDK_CORE_PROJECT || sess.project || null;
    sc.account = flag(t, ['--account']) || env.CLOUDSDK_CORE_ACCOUNT || sess.account || null;
    sc.configuration = flag(t, ['--configuration']) || env.CLOUDSDK_ACTIVE_CONFIG_NAME || sess.configuration || null;
  }
  if (t[0] === 'aws' || t[0] === 'eksctl' || t[0] === 'sam' || t[0] === 'cdk') {
    sc.profile = flag(t, ['--profile']) || env.AWS_PROFILE || sess.profile || null;
    sc.region = flag(t, ['--region']) || env.AWS_REGION || env.AWS_DEFAULT_REGION || sess.region || null;
  }
  if (t[0] === 'az') sc.subscription = flag(t, ['--subscription']) || sess.subscription || null;
  for (const k of Object.keys(sc)) if (!sc[k]) delete sc[k];
  return sc;
}
const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
function addScope(teardown, prov, sc) {
  if (!sc) return teardown;
  const extra = (m) => {
    let x = '';
    if (/^gcloud /.test(m) && sc.project && SAFE_SCOPE.test(sc.project) && !/--project/.test(m)) x += ` --project ${sc.project}`;
    if (/^gcloud /.test(m) && sc.account && SAFE_SCOPE.test(sc.account) && !/--account/.test(m)) x += ` --account ${sc.account}`;
    if (/^gcloud /.test(m) && sc.configuration && SAFE_SCOPE.test(sc.configuration) && !/--configuration/.test(m)) x += ` --configuration ${sc.configuration}`;
    if (/^aws /.test(m)) {
      if (sc.profile && SAFE_SCOPE.test(sc.profile) && !/--profile/.test(m)) x += ` --profile ${sc.profile}`;
      if (sc.region && SAFE_SCOPE.test(sc.region) && !/--region/.test(m)) x += ` --region ${sc.region}`;
    }
    if (/^eksctl /.test(m) && sc.profile && SAFE_SCOPE.test(sc.profile) && !/--profile/.test(m)) x += ` --profile ${sc.profile}`;
    if (/^az /.test(m) && sc.subscription && SAFE_SCOPE.test(sc.subscription) && !/--subscription/.test(m)) x += ` --subscription ${sc.subscription}`;
    return m + x;
  };
  return teardown.replace(/(?<![\w-])(gcloud|aws|eksctl|az) [^#;(]*?(?=\s{2,}#|\s{2,}\(|;|,|$)/g, extra);
}

function scan(events, { project } = {}) {
  const evs = project ? events.filter((e) => (e.cwd || '').toLowerCase().includes(project.toLowerCase())) : events;
  const idx = makeIndex();
  const { found } = idx;
  const sessScope = new Map();
  const written = new Map(); // abs path -> content the agent wrote (to follow scripts it then runs)
  const bg = [];

  const addFinding = (key, f) => {
    if (found.has(key)) {
      const old = found.get(key);
      old.times += 1;
      // a later successful create re-opens something that was cleaned or failed
      if (!f.failed) { old.status = 'left'; old.time = f.time; old.command = f.command; old.session = f.session; old.teardown = f.teardown; old.scope = f.scope || old.scope; old.spec = f.spec || old.spec; if (f.instanceIds) old.instanceIds = f.instanceIds; if (f.tags) { delete old.expires; delete old.expired; delete old.expiresRaw; delete old.sessionTag; annotate(old, f.tags, f.time); } }
      return;
    }
    idx.add(key, f);
  };
  const orphanSimple = makeOrphans(idx, addFinding, addScope);

  const handleSimple = (simple, ev, failed, sess, origin) => {
    const toks0 = tokenize(simple);
    if (!toks0.length) return;
    // session state that later commands inherit
    if (toks0[0] === 'export' || toks0[0] === 'set') {
      for (const kv of toks0.slice(1)) {
        const m = kv.match(/^(AWS_PROFILE|AWS_REGION|AWS_DEFAULT_REGION|CLOUDSDK_CORE_PROJECT|CLOUDSDK_CORE_ACCOUNT|CLOUDSDK_ACTIVE_CONFIG_NAME)=(.*)$/);
        if (!m) continue;
        if (m[1] === 'AWS_PROFILE') sess.profile = m[2];
        else if (m[1] === 'CLOUDSDK_CORE_PROJECT') sess.project = m[2];
        else if (m[1] === 'CLOUDSDK_CORE_ACCOUNT') sess.account = m[2];
        else if (m[1] === 'CLOUDSDK_ACTIVE_CONFIG_NAME') sess.configuration = m[2];
        else sess.region = m[2];
      }
      return;
    }
    if (toks0[0] === 'gcloud' && toks0[1] === 'config' && toks0[2] === 'set' && toks0[3] === 'project' && toks0[4] && !failed) { sess.project = toks0[4]; return; }
    if (toks0[0] === 'gcloud' && toks0[1] === 'config' && toks0[2] === 'set' && toks0[3] === 'account' && toks0[4] && !failed) { sess.account = toks0[4]; return; }
    if (toks0[0] === 'gcloud' && toks0[1] === 'config' && toks0[2] === 'configurations' && toks0[3] === 'activate' && toks0[4] && !failed) { sess.configuration = toks0[4]; delete sess.project; delete sess.account; return; }
    if (toks0[0] === 'aws' && toks0[1] === 'configure' && toks0[2] === 'set' && toks0[3] === 'region' && toks0[4] && !failed) { sess.region = toks0[4]; return; }
    if (toks0[0] === 'az' && toks0[1] === 'account' && toks0[2] === 'set') { const s = flag(toks0, ['--subscription', '-s']); if (s) sess.subscription = s; return; }
    if (isNoop(toks0)) return;
    // background process the agent left running
    if (!failed && BG_RE.test(simple) && !/\b(docker|ngrok|cloudflared)\b/.test(simple)) {
      const word = (toks0.find((x, i) => i > 0 && /[\w.-]+\.(py|js|ts|mjs|sh|rb|go)$/.test(x)) || toks0.filter((x) => !['nohup', 'setsid', 'disown'].includes(x) && !x.startsWith('-'))[0] || '').replace(/^.*[\\/]/, '');
      if (word && !['sleep', 'echo', 'wait', 'true', 'tail', 'cat'].includes(word)) bg.push({ word, simple, ev, origin });
    }
    for (const r of rules) {
      if (r.undo && !failed) {
        const ut = matchPrefix(toks0, r.undo.when);
        if (ut && !(r.undo.skipIf && r.undo.skipIf(ut))) {
          const names = r.undo.multi ? r.undo.multi(ut) : r.undo.any ? null : [r.undo.name(ut, ev)];
          if (names === null) { for (const f of idx.rule(r.id)) if (f.status === 'left') f.status = 'maybe-cleaned'; }
          else for (const n of names) if (n !== undefined && n !== null) for (const f of idx.named(r.id, n)) if (f.status === 'left') f.status = 'cleaned';
        }
      }
      const t = matchPrefix(toks0, r.when);
      if (!t) continue;
      const names = r.multi ? r.multi(t) : [r.name(t, ev)];
      if (names.some((n) => n === undefined)) continue; // rule matched the verb but not a create
      const sc = scopeOf(t, sess);
      const tags = tagsFromCommand(toks0, simple);
      for (let n of names) {
        const unknown = isVar(n);
        if (unknown) n = n ? n : '(name not in the command)';
        const key = `${r.id}|${n}|${unknown ? ev.time : ''}|${sc.project || ''}${sc.profile || ''}${sc.region || ''}`;
        let teardown;
        try { teardown = r.teardown(unknown ? '<NAME>' : n, t, ev); } catch { teardown = '(see provider console)'; }
        teardown = addScope(teardown, r.provider, sc);
        const gpu = /--accelerator|--gpu|nvidia|\b(g2|a2|a3|a4)-|\b(p3|p4d?|p5e?|g4dn|g5|g6e?)\.|gpu/i.test(simple) && r.cost === 'hourly';
        addFinding(key, annotate({
          rule: r.id, provider: r.provider, what: gpu ? r.what + ' (GPU)' : r.what, gpu, cost: r.cost, deploy: !!r.deploy, name: n,
          nameUnknown: unknown, teardown, command: redact(simple), time: ev.time, cwd: ev.cwd, scope: sc, spec: specFrom(r.id, flag, t),
          session: ev.session, agent: ev.tool, status: failed ? 'failed' : 'left', failed, times: 1, ...(origin ? { viaScript: origin } : {}),
          ...(r.id === 'aws-ec2' && ev.instanceIds && ev.instanceIds.length ? { instanceIds: ev.instanceIds } : {}),
        }, redactArgs(tags), ev.time));
      }
    }
    // Orphans: what a delete leaves behind (kept disks, EIPs, Azure VM parts).
    if (!failed) orphanSimple(toks0, simple, ev);
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
    parts.forEach((simple, i) => {
      // A failed command line: blame the last command, not the deploy before it.
      const failed = ev.failed && i === parts.length - 1;
      const t = tokenize(simple);
      if (t[0] === 'cd' && t[1]) { cwd = path.isAbsolute(t[1]) ? t[1] : path.join(cwd, t[1]); return; }
      handleSimple(simple, ev, failed, sess, null);
      // A shell script the agent wrote and then ran: read its commands too.
      const script = (t[0] === 'bash' || t[0] === 'sh' || t[0] === 'zsh' || t[0] === 'source' || t[0] === '.') ? t.find((x, j) => j > 0 && !x.startsWith('-')) : /^\.?\.?[\\/].*\.sh$|^[\w.-]+\.sh$/.test(t[0]) ? t[0] : null;
      if (script && !ev.failed) {
        const abs = path.normalize(path.isAbsolute(script) ? script : path.join(cwd, script));
        const body = written.get(abs);
        if (body) for (const line of splitCommands(body)) if (!line.startsWith('#')) handleSimple(line, ev, false, sess, path.basename(abs));
      }
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
    addFinding(`bg|${b.ev.session}|${b.word}`, {
      rule: 'bg-process', provider: 'local', what: 'Background process', gpu: false, cost: 'local', name: b.word, nameUnknown: false,
      teardown: findProcess(b.word), command: redact(b.simple), time: b.ev.time, cwd: b.ev.cwd, session: b.ev.session, agent: b.ev.tool,
      status: 'left', failed: false, times: 1, ...(b.origin ? { viaScript: b.origin } : {}),
    });
  }

  const resources = idx.order.map((k) => found.get(k));
  for (const f of resources) { const e = estimate(f); if (e) f.estimate = e; }
  const spend = [...scripts.values()].filter((s) => s.ran > 0).map((s) => ({
    ...s,
    teardown: s.background ? `${findProcess(path.basename(s.file))}. Usage: ${s.usage}` : `check usage at ${s.usage}`,
  }));
  return { resources, spend, scannedEvents: evs.length, mcpCalls: evs.filter((e) => e.kind === 'mcp').length, k8sLocalSkipped: k8s.skippedLocal };
}

module.exports = { scan, short, addScope };
