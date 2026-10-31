'use strict';
const path = require('path');
const { splitCommands, tokenize } = require('./shell');
const { rules, matchPrefix } = require('./rules');
const mcp = require('./mcp');
const { k8sFindings } = require('./k8s');

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

function mcpFindings(evs, addFinding, found) {
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
    if (c.kind === 'delete') {
      if (failed) continue;
      const ids = idsIn(ev.input);
      for (const f of found.values()) {
        if (f.via !== 'mcp' || f.provider !== c.provider || f.status !== 'left') continue;
        if ((f.id && ids.has(f.id)) || (f.name && ids.has(f.name))) f.status = 'cleaned';
      }
      continue;
    }
    const name = mcp.pick(ev.input, mcp.NAME_KEYS) || (res && mcp.pick(res, mcp.NAME_KEYS)) || null;
    const id = (res && mcp.pick(res, mcp.ID_KEYS)) || null;
    const handle = id || name;
    const label = LABEL[c.provider] || sp.server;
    const args = JSON.stringify(ev.input || {});
    addFinding(`mcp|${c.provider}|${c.noun}|${handle || ev.time}`, {
      rule: `mcp-${c.provider}-${c.noun.replace(/\s+/g, '-').toLowerCase()}`, provider: c.provider, what: `${label} ${c.noun}`, gpu: c.noun === 'GPU pod', cost: c.cost,
      name: name && id && name !== id ? `${name} (${id})` : handle || '(name not in the log)', id, nameUnknown: !handle,
      teardown: mcp.teardownFor(c, { name, id, server: sp.server, input: ev.input }), command: `${ev.tool_name} ${args.length > 160 ? args.slice(0, 157) + '...' : args}`,
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

const isVar = (s) => !s || /[$`<>{}]/.test(s);

function short(p) {
  if (!p) return '';
  const home = require('os').homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function scan(events, { project } = {}) {
  const evs = project ? events.filter((e) => (e.cwd || '').toLowerCase().includes(project.toLowerCase())) : events;
  const found = new Map(); // key -> finding
  const order = [];

  const addFinding = (key, f) => {
    if (found.has(key)) {
      const old = found.get(key);
      old.times += 1;
      // a later successful create re-opens something that was cleaned or failed
      if (!f.failed) { old.status = 'left'; old.time = f.time; old.command = f.command; old.session = f.session; }
      return;
    }
    found.set(key, f); order.push(key);
  };

  for (const ev of evs) {
    if (ev.kind !== 'cmd') continue;
    for (const simple of splitCommands(ev.command)) {
      const toks0 = tokenize(simple);
      if (!toks0.length) continue;
      for (const r of rules) {
        // undo (cleanup) first
        if (r.undo) {
          const ut = matchPrefix(toks0, r.undo.when);
          if (ut && !ev.failed) {
            const names = r.undo.multi ? r.undo.multi(ut) : r.undo.any ? null : [r.undo.name(ut, ev)];
            for (const [k, f] of found) {
              if (f.rule !== r.id || f.status !== 'left') continue;
              if (names === null) f.status = 'maybe-cleaned';
              else if (names.includes(f.name)) f.status = 'cleaned';
            }
          }
        }
        const t = matchPrefix(toks0, r.when);
        if (!t) continue;
        const names = r.multi ? r.multi(t) : [r.name(t, ev)];
        for (let n of names) {
          const unknown = isVar(n);
          if (unknown) n = n ? n : '(name not in the command)';
          const key = `${r.id}|${n}|${unknown ? ev.time : ''}`;
          let teardown;
          try { teardown = r.teardown(unknown ? '<NAME>' : n, t, ev); } catch { teardown = '(see provider console)'; }
          const gpu = /--accelerator|--gpu|nvidia|\b(g2|a2|a3|a4)-|\b(p3|p4d?|p5e?|g4dn|g5|g6e?)\.|gpu/i.test(simple) && r.cost === 'hourly';
          addFinding(key, {
            rule: r.id, provider: r.provider, what: gpu ? r.what + ' (GPU)' : r.what, gpu, cost: r.cost, name: n,
            nameUnknown: unknown, teardown, command: simple, time: ev.time, cwd: ev.cwd,
            session: ev.session, agent: ev.tool, status: ev.failed ? 'failed' : 'left', failed: ev.failed, times: 1,
          });
        }
      }
    }
  }

  mcpFindings(evs, addFinding, found);
  const k8s = k8sFindings(evs, addFinding, found);

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
    const api = AI_APIS.find((a) => a.re.test(ev.command));
    if (api && /\b(for|while)\b/.test(ev.command)) {
      scripts.set('cmd:' + ev.time + ev.command.slice(0, 40), { file: '(shell loop)', command: ev.command.slice(0, 120), api: api.name, usage: api.usage, loop: true, time: ev.time, session: ev.session, agent: ev.tool, cwd: ev.cwd, ran: 1, background: /&\s*$/.test(ev.command) });
    }
  }

  const resources = order.map((k) => found.get(k));
  const spend = [...scripts.values()].filter((s) => s.ran > 0).map((s) => ({
    ...s,
    teardown: s.background
      ? `pkill -f "${path.basename(s.file)}"   # stop it, then check ${s.usage}`
      : `open ${s.usage}`,
  }));
  return { resources, spend, scannedEvents: evs.length, mcpCalls: evs.filter((e) => e.kind === 'mcp').length, k8sLocalSkipped: k8s.skippedLocal };
}

module.exports = { scan, short };
