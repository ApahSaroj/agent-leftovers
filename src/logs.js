'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// Find session log files that Claude Code and Codex CLI already keep on disk.
function defaultRoots() {
  const home = os.homedir();
  const roots = [];
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  roots.push({ tool: 'claude', dir: path.join(claudeDir, 'projects') });
  const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
  roots.push({ tool: 'codex', dir: path.join(codexHome, 'sessions') });
  roots.push({ tool: 'codex', dir: path.join(codexHome, 'archived_sessions') });
  return roots;
}

function walk(dir, out, sinceMs) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, sinceMs);
    else if (e.isFile() && (e.name.endsWith('.jsonl') || e.name.endsWith('.jsonl.zst'))) {
      try { if (fs.statSync(p).mtimeMs >= sinceMs) out.push(p); } catch { /* skip */ }
    }
  }
  return out;
}

// Guess which tool wrote a file we were pointed at directly (--logs).
function sniff(file) {
  let head = '';
  if (file.endsWith('.zst')) return 'codex';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.slice(0, n).toString('utf8');
  } catch { return null; }
  if (/"session_meta"|"response_item"|"function_call"|"local_shell_call"/.test(head)) return 'codex';
  if (/"sessionId"|"tool_use"|"parentUuid"/.test(head)) return 'claude';
  return null;
}

function findLogs({ sinceMs, extra = [] }) {
  const files = [];
  if (extra.length) {
    for (const p of extra) {
      let st; try { st = fs.statSync(p); } catch { continue; }
      const list = st.isDirectory() ? walk(p, [], sinceMs) : [p];
      for (const f of list) { const tool = sniff(f); if (tool) files.push({ tool, file: f }); }
    }
    return files;
  }
  for (const r of defaultRoots()) for (const f of walk(r.dir, [], sinceMs)) files.push({ tool: r.tool, file: f });
  return files;
}

const zlib = require('zlib');
const skipped = { zst: 0 };
function readText(file) {
  if (file.endsWith('.zst')) {
    // Codex compresses rollouts it hasn't touched for a week. Node 22.15+ can read them.
    if (typeof zlib.zstdDecompressSync !== 'function') { skipped.zst++; return ''; }
    try { return zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8'); } catch { skipped.zst++; return ''; }
  }
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function readLines(file) {
  const txt = readText(file);
  const out = [];
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  return out;
}

// ---------- Claude Code ----------
// Events: { kind: 'cmd', command, time, cwd, session, id, failed }
//         { kind: 'write', file, content, time, cwd, session }
function parseClaude(file) {
  const events = [];
  const byId = new Map();
  let session = path.basename(file, '.jsonl');
  for (const o of readLines(file)) {
    if (o.sessionId) session = o.sessionId;
    const content = o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const c of content) {
      if (c && c.type === 'tool_use' && c.input) {
        const base = { time: o.timestamp || null, cwd: o.cwd || null, session, tool: 'claude' };
        const name = String(c.name || '');
        if (/^(Bash|bash|BashOutput|shell)$/.test(name) && typeof c.input.command === 'string') {
          const ev = { kind: 'cmd', command: c.input.command, id: c.id, failed: false, ...base };
          events.push(ev); if (c.id) byId.set(c.id, ev);
        } else if (name === 'Write' && c.input.file_path) {
          events.push({ kind: 'write', file: c.input.file_path, content: String(c.input.content || ''), ...base });
        } else if (name === 'Edit' && c.input.file_path) {
          events.push({ kind: 'write', file: c.input.file_path, content: String(c.input.new_string || ''), ...base });
        } else if (name === 'MultiEdit' && c.input.file_path && Array.isArray(c.input.edits)) {
          events.push({ kind: 'write', file: c.input.file_path, content: c.input.edits.map((e) => e.new_string || '').join('\n'), ...base });
        } else if (name.startsWith('mcp__')) {
          const ev = { kind: 'mcp', tool_name: name, input: c.input, id: c.id, failed: false, result: null, ...base };
          events.push(ev); if (c.id) byId.set(c.id, ev);
        }
      }
      if (c && c.type === 'tool_result' && c.tool_use_id && byId.has(c.tool_use_id)) {
        const ev = byId.get(c.tool_use_id);
        if (ev.kind === 'mcp') { ev.result = c.content; if (c.is_error === true) ev.failed = true; continue; }
        const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
        if (c.is_error === true || /^Exit code [1-9]/m.test(text)) ev.failed = true;
      }
    }
  }
  return events;
}

// ---------- Codex CLI ----------
function cmdFromArgs(a) {
  if (!a) return null;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return null; } }
  let c = a.command !== undefined ? a.command : a.cmd;
  if (Array.isArray(c)) {
    // ["bash","-lc","..."] -> the script; otherwise join argv
    const i = c.findIndex((x) => x === '-lc' || x === '-c');
    c = i >= 0 && c[i + 1] ? c[i + 1] : c.join(' ');
  }
  return typeof c === 'string' ? { command: c, cwd: a.workdir || a.cwd || null } : null;
}

function patchWrites(text) {
  // apply_patch format: *** Add File: path / *** Update File: path, then +lines
  const out = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\*\*\* (?:Add|Update) File: (.+)$/);
    if (m) { cur = { file: m[1].trim(), lines: [] }; out.push(cur); continue; }
    if (/^\*\*\* (End Patch|Delete File)/.test(line)) { cur = null; continue; }
    if (cur && line.startsWith('+')) cur.lines.push(line.slice(1));
  }
  return out.map((w) => ({ file: w.file, content: w.lines.join('\n') }));
}

function parseCodex(file) {
  const events = [];
  const byId = new Map();
  let session = path.basename(file, '.jsonl');
  let cwd = null;
  for (const raw of readLines(file)) {
    const o = raw.payload && raw.type ? { ...raw.payload, _wrapType: raw.type } : raw;
    const time = raw.timestamp || o.timestamp || null;
    if (raw.type === 'session_meta' || o._wrapType === 'session_meta') { session = o.id || o.session_id || session; cwd = o.cwd || cwd; continue; }
    if (raw.type === 'turn_context' && o.cwd) { cwd = o.cwd; continue; }
    const base = { time, session, tool: 'codex' };
    // MCP calls as Codex logs them: event_msg mcp_tool_call_begin/end with an invocation.
    if (o.type === 'mcp_tool_call_begin' || o.type === 'mcp_tool_call_end') {
      const inv = o.invocation || {};
      let ev = o.call_id && byId.get(o.call_id);
      if (!ev && inv.server && inv.tool) {
        let input = inv.arguments;
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
        ev = { kind: 'mcp', tool_name: `mcp__${inv.server}__${inv.tool}`, input: input || {}, id: o.call_id, failed: false, result: null, cwd, ...base };
        events.push(ev); if (o.call_id) byId.set(o.call_id, ev);
      }
      if (ev && o.type === 'mcp_tool_call_end' && o.result) {
        if (o.result.Err !== undefined) ev.failed = true;
        else { ev.result = o.result.Ok !== undefined ? o.result.Ok : o.result; if (ev.result && ev.result.isError === true) ev.failed = true; }
      }
      continue;
    }
    if (o.type === 'function_call' && /__/.test(String(o.name || '')) && !/^(shell|exec_command|apply_patch|local_shell)$/.test(String(o.name))) {
      let input = o.arguments;
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
      const nm = String(o.name);
      const ev = { kind: 'mcp', tool_name: nm.startsWith('mcp__') ? nm : `mcp__${nm}`, input: input || {}, id: o.call_id, failed: false, result: null, cwd, ...base };
      events.push(ev); if (o.call_id) byId.set(o.call_id, ev);
      continue;
    }
    if (o.type === 'function_call' || o.type === 'custom_tool_call') {
      const name = String(o.name || '');
      if (name === 'apply_patch' || /apply_patch/.test(String(o.input || o.arguments || '').slice(0, 40))) {
        let body = o.input || o.arguments;
        try { const j = JSON.parse(body); body = j.input || j.patch || (j.command && j.command.join && j.command.join('\n')) || body; } catch { /* raw */ }
        for (const w of patchWrites(body)) events.push({ kind: 'write', ...w, cwd, ...base });
        continue;
      }
      const c = cmdFromArgs(o.arguments || o.input);
      if (c) {
        if (/^\s*apply_patch\b/.test(c.command)) { for (const w of patchWrites(c.command)) events.push({ kind: 'write', ...w, cwd, ...base }); continue; }
        const ev = { kind: 'cmd', command: c.command, cwd: c.cwd || cwd, id: o.call_id, failed: false, ...base };
        events.push(ev); if (o.call_id) byId.set(o.call_id, ev);
      }
    } else if (o.type === 'local_shell_call' && o.action) {
      const c = cmdFromArgs({ command: o.action.command, workdir: o.action.working_directory });
      if (c) { const ev = { kind: 'cmd', command: c.command, cwd: c.cwd || cwd, id: o.call_id, failed: false, ...base }; events.push(ev); if (o.call_id) byId.set(o.call_id, ev); }
    } else if ((o.type === 'function_call_output' || o.type === 'local_shell_call_output' || o.type === 'custom_tool_call_output') && byId.has(o.call_id)) {
      const ev = byId.get(o.call_id);
      if (ev.kind === 'mcp') {
        let out = o.output;
        if (typeof out === 'string') { try { out = JSON.parse(out); } catch { /* text */ } }
        if (!ev.result) ev.result = out && out.content !== undefined ? out.content : out;
        if (out && (out.success === false || out.isError === true || out.is_error === true)) ev.failed = true;
        continue;
      }
      let out = o.output;
      let code = null;
      if (typeof out === 'string') {
        try { const j = JSON.parse(out); if (j && j.metadata && typeof j.metadata.exit_code === 'number') code = j.metadata.exit_code; } catch { /* text */ }
        const m = out.match(/(?:Exit code|exit_code|exited with code)["':\s]+(\d+)/i);
        if (code === null && m) code = Number(m[1]);
      } else if (out && out.metadata) code = out.metadata.exit_code;
      if (typeof code === 'number' && code !== 0) ev.failed = true;
    }
  }
  return events;
}

function readEvents(files) {
  const all = [];
  for (const { tool, file } of files) {
    const evs = tool === 'codex' ? parseCodex(file) : parseClaude(file);
    for (const e of evs) { e.logFile = file; all.push(e); }
  }
  all.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
  return all;
}

module.exports = { skipped, findLogs, readEvents, parseClaude, parseCodex, defaultRoots };
