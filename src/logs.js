'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// Find session log files that Claude Code and Codex CLI already keep on disk.
function defaultRoots() {
  const roots = [];
  const homes = [os.homedir()];
  // Windows: agents run inside WSL keep their logs in the Linux home folders.
  if (process.platform === 'win32') {
    for (const base of ['\\\\wsl.localhost\\', '\\\\wsl$\\']) {
      let distros = [];
      try { distros = fs.readdirSync(base); } catch { continue; }
      for (const d of distros) {
        try { for (const u of fs.readdirSync(path.join(base, d, 'home'))) homes.push(path.join(base, d, 'home', u)); } catch { /* none */ }
      }
      break;
    }
  }
  for (const home of homes) {
    const main = home === os.homedir();
    const claudeDir = (main && process.env.CLAUDE_CONFIG_DIR) || path.join(home, '.claude');
    roots.push({ tool: 'claude', dir: path.join(claudeDir, 'projects') });
    const codexHome = (main && process.env.CODEX_HOME) || path.join(home, '.codex');
    roots.push({ tool: 'codex', dir: path.join(codexHome, 'sessions') });
    roots.push({ tool: 'codex', dir: path.join(codexHome, 'archived_sessions') });
    const geminiHome = (main && process.env.GEMINI_CLI_HOME) ? path.join(process.env.GEMINI_CLI_HOME, '.gemini') : path.join(home, '.gemini');
    roots.push({ tool: 'gemini', dir: path.join(geminiHome, 'tmp'), match: /[\\/]chats[\\/][^\\/]+\.jsonl?$/ });
    const copilotHome = (main && process.env.COPILOT_HOME) || path.join(home, '.copilot');
    roots.push({ tool: 'copilot', dir: path.join(copilotHome, 'session-state'), match: /\.jsonl$/ });
  }
  return roots;
}

function walk(dir, out, sinceMs, match, depth = 0) {
  let ents;
  if (depth > 12) return out;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, sinceMs, match, depth + 1);
    else if (e.isFile() && (match ? match.test(p) : (e.name.endsWith('.jsonl') || e.name.endsWith('.jsonl.zst')))) {
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
  if (/"type"\s*:\s*"session\.start"|"tool\.execution_start"|"copilotVersion"/.test(head)) return 'copilot';
  if (/"projectHash"|"type"\s*:\s*"gemini"|"toolCalls"/.test(head)) return 'gemini';
  if (/"sessionId"|"tool_use"|"parentUuid"/.test(head)) return 'claude';
  return null;
}

function findLogs({ sinceMs, extra = [] }) {
  const files = [];
  if (extra.length) {
    for (const p of extra) {
      let st; try { st = fs.statSync(p); } catch { continue; }
      const list = st.isDirectory() ? walk(p, [], sinceMs, /\.jsonl(\.zst)?$|[\\/]chats[\\/][^\\/]+\.json$/) : [p];
      for (const f of list) { const tool = sniff(f); if (tool) files.push({ tool, file: f }); }
    }
    return files;
  }
  for (const r of defaultRoots()) for (const f of walk(r.dir, [], sinceMs, r.match)) files.push({ tool: r.tool, file: f });
  return files;
}

const zlib = require('zlib');
const skipped = { zst: 0, unreadable: [] };

// Read a JSONL file line by line in 1 MB chunks, so a 2 GB log never has to fit
// in one string. Calls fn(obj) for each JSON line.
function eachLine(file, fn) {
  if (file.endsWith('.zst')) {
    // Codex compresses rollouts it hasn't touched for a week. Node 22.15+ can read them.
    if (typeof zlib.zstdDecompressSync !== 'function') { skipped.zst++; return; }
    let buf;
    try { buf = zlib.zstdDecompressSync(fs.readFileSync(file)); } catch { skipped.zst++; return; }
    return eachLineOfBuffer(buf, fn);
  }
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { skipped.unreadable.push(`${file}: ${e.code || e.message}`); return; }
  const CH = 1 << 20;
  const buf = Buffer.alloc(CH);
  let rest = Buffer.alloc(0);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CH, null);
      if (n <= 0) break;
      let chunk = Buffer.concat([rest, buf.subarray(0, n)]);
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 10) { parseLine(chunk.subarray(start, i), fn); start = i + 1; }
      }
      rest = Buffer.from(chunk.subarray(start));
      if (rest.length > 256 * CH) { skipped.unreadable.push(`${file}: a single line over 256 MB was skipped`); rest = Buffer.alloc(0); }
    }
    if (rest.length) parseLine(rest, fn);
  } catch (e) { skipped.unreadable.push(`${file}: ${e.code || e.message}`); }
  finally { try { fs.closeSync(fd); } catch { /* closed */ } }
}
function eachLineOfBuffer(buf, fn) {
  let start = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) { parseLine(buf.subarray(start, i), fn); start = i + 1; }
  if (start < buf.length) parseLine(buf.subarray(start), fn);
}
function parseLine(b, fn) {
  if (!b.length) return;
  const line = b.toString('utf8');
  if (!line.trim()) return;
  let o;
  try { o = JSON.parse(line); } catch { return; }
  fn(o);
}
function readLines(file) { const out = []; eachLine(file, (o) => out.push(o)); return out; }

// ---------- Claude Code ----------
// Events: { kind: 'cmd', command, time, cwd, session, id, failed }
//         { kind: 'write', file, content, time, cwd, session }
function parseClaude(file) {
  const events = [];
  const byId = new Map();
  let session = path.basename(file, '.jsonl');
  eachLine(file, (o) => {
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
        noteIds(ev, text);
      }
    }
  });
  return events;
}

// Instance IDs printed by `aws ec2 run-instances`, so a later terminate can be matched exactly.
function noteIds(ev, text) {
  if (!ev || ev.kind !== 'cmd' || !/\brun-instances\b/.test(ev.command) || !text) return;
  const ids = [...new Set(String(text).slice(0, 200000).match(/\bi-[0-9a-f]{8,17}\b/g) || [])];
  if (ids.length) ev.instanceIds = ids;
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
  eachLine(file, (raw) => {
    const o = raw.payload && raw.type ? { ...raw.payload, _wrapType: raw.type } : raw;
    const time = raw.timestamp || o.timestamp || null;
    if (raw.type === 'session_meta' || o._wrapType === 'session_meta') { session = o.id || o.session_id || session; cwd = o.cwd || cwd; return; }
    if (raw.type === 'turn_context' && o.cwd) { cwd = o.cwd; return; }
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
      return;
    }
    if (o.type === 'function_call' && /__/.test(String(o.name || '')) && !/^(shell|exec_command|apply_patch|local_shell)$/.test(String(o.name))) {
      let input = o.arguments;
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
      const nm = String(o.name);
      const ev = { kind: 'mcp', tool_name: nm.startsWith('mcp__') ? nm : `mcp__${nm}`, input: input || {}, id: o.call_id, failed: false, result: null, cwd, ...base };
      events.push(ev); if (o.call_id) byId.set(o.call_id, ev);
      return;
    }
    if (o.type === 'function_call' || o.type === 'custom_tool_call') {
      const name = String(o.name || '');
      if (name === 'apply_patch' || /apply_patch/.test(String(o.input || o.arguments || '').slice(0, 40))) {
        let body = o.input || o.arguments;
        try { const j = JSON.parse(body); body = j.input || j.patch || (j.command && j.command.join && j.command.join('\n')) || body; } catch { /* raw */ }
        for (const w of patchWrites(body)) events.push({ kind: 'write', ...w, cwd, ...base });
        return;
      }
      const c = cmdFromArgs(o.arguments || o.input);
      if (c) {
        if (/^\s*apply_patch\b/.test(c.command)) { for (const w of patchWrites(c.command)) events.push({ kind: 'write', ...w, cwd, ...base }); return; }
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
        return;
      }
      let out = o.output;
      let code = null;
      if (typeof out === 'string') {
        try { const j = JSON.parse(out); if (j && j.metadata && typeof j.metadata.exit_code === 'number') code = j.metadata.exit_code; } catch { /* text */ }
        const m = out.match(/(?:Exit code|exit_code|exited with code)["':\s]+(\d+)/i);
        if (code === null && m) code = Number(m[1]);
      } else if (out && out.metadata) code = out.metadata.exit_code;
      if (typeof code === 'number' && code !== 0) ev.failed = true;
      noteIds(ev, typeof out === 'string' ? out : JSON.stringify(out || ''));
    }
  });
  return events;
}

// ---------- Gemini CLI ----------
// ~/.gemini/tmp/<project>/chats/session-*.json (whole session) or *.jsonl (one record
// per line). Gemini messages carry toolCalls: { id, name, args, status, result }.
function parseGemini(file) {
  const events = [];
  const seen = new Set();
  let session = path.basename(file).replace(/\.jsonl?$/, '');
  let cwd = null;
  try { cwd = fs.readFileSync(path.join(path.dirname(path.dirname(file)), '.project_root'), 'utf8').trim() || null; } catch { /* unknown */ }
  const onMsg = (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.sessionId) session = m.sessionId;
    const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    for (const c of calls) {
      if (!c || !c.name) continue;
      const key = c.id || JSON.stringify([c.name, c.args, m.timestamp]);
      if (seen.has(key)) continue;
      seen.add(key);
      const args = c.args || {};
      const base = { time: c.timestamp || m.timestamp || null, cwd: args.directory || args.dir_path || cwd, session, tool: 'gemini' };
      const resText = JSON.stringify(c.result || c.resultDisplay || '');
      const failed = c.status === 'error' || c.status === 'cancelled' || /Exit Code: [1-9]/.test(resText);
      if (c.name === 'run_shell_command' && typeof args.command === 'string') { const ev = { kind: 'cmd', command: args.command, id: c.id, failed, ...base }; noteIds(ev, resText); events.push(ev); }
      else if ((c.name === 'write_file' || c.name === 'create_file') && (args.file_path || args.path)) events.push({ kind: 'write', file: args.file_path || args.path, content: String(args.content || ''), ...base });
      else if (c.name === 'replace' && args.file_path) events.push({ kind: 'write', file: args.file_path, content: String(args.new_string || ''), ...base });
      else if (/__/.test(c.name) || c.name.startsWith('mcp_')) events.push({ kind: 'mcp', tool_name: c.name.startsWith('mcp__') ? c.name : `mcp__${c.name.replace(/^mcp_/, '').replace(/^([^_]+)_/, '$1__')}`, input: args, id: c.id, failed, result: c.result || null, ...base });
    }
  };
  if (file.endsWith('.jsonl')) eachLine(file, (o) => { if (o.$set || o.$rewindTo) return; onMsg(o); });
  else {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { skipped.unreadable.push(`${file}: ${e.code || 'not JSON'}`); }
    if (j && j.sessionId) session = j.sessionId;
    if (j && Array.isArray(j.messages)) j.messages.forEach(onMsg);
  }
  return events;
}

// ---------- GitHub Copilot CLI ----------
// ~/.copilot/session-state/<id>/events.jsonl: { type, data, timestamp } per line.
function parseCopilot(file) {
  const events = [];
  const byId = new Map();
  let session = path.basename(path.dirname(file));
  let cwd = null;
  eachLine(file, (o) => {
    const d = o.data || {};
    if (o.type === 'session.start') { session = d.sessionId || session; cwd = (d.context && d.context.cwd) || cwd; return; }
    const base = { time: o.timestamp || null, cwd, session, tool: 'copilot' };
    if (o.type === 'tool.execution_start') {
      const name = String(d.toolName || '');
      let args = d.arguments;
      if (typeof args === 'string' && name !== 'apply_patch') { try { args = JSON.parse(args); } catch { /* raw */ } }
      let ev = null;
      if ((name === 'bash' || name === 'powershell' || name === 'shell') && args && typeof args.command === 'string') ev = { kind: 'cmd', command: args.command, id: d.toolCallId, failed: false, ...base };
      else if (name === 'create' && args && args.path) ev = { kind: 'write', file: args.path, content: String(args.file_text || ''), ...base };
      else if (name === 'edit' && args && args.path) ev = { kind: 'write', file: args.path, content: String(args.new_str || ''), ...base };
      else if (name === 'apply_patch') { for (const w of patchWrites(typeof args === 'string' ? args : (args && args.input) || '')) events.push({ kind: 'write', ...w, ...base }); return; }
      else if (/__/.test(name) || (d.mcpServerName && d.mcpToolName)) ev = { kind: 'mcp', tool_name: d.mcpServerName ? `mcp__${d.mcpServerName}__${d.mcpToolName}` : (name.startsWith('mcp__') ? name : `mcp__${name}`), input: args || {}, id: d.toolCallId, failed: false, result: null, ...base };
      if (ev) { events.push(ev); if (d.toolCallId) byId.set(d.toolCallId, ev); }
      return;
    }
    if (o.type === 'tool.execution_complete' && byId.has(d.toolCallId)) {
      const ev = byId.get(d.toolCallId);
      const res = d.result || {};
      const text = typeof res === 'string' ? res : String(res.content || res.detailedContent || '');
      if (ev.kind === 'mcp') { ev.result = res.content !== undefined ? res.content : res; if (d.success === false) ev.failed = true; return; }
      const tel = d.toolTelemetry || {};
      const code = (tel.properties && Number(tel.properties.exitCode)) || (tel.metrics && Number(tel.metrics.exitCode));
      const m = text.match(/exit(?:ed with)? code[:\s]+(\d+)/i);
      if (d.success === false || (Number.isFinite(code) && code !== 0) || (m && Number(m[1]) !== 0)) ev.failed = true;
      noteIds(ev, text);
    }
  });
  return events;
}

function readEvents(files) {
  const all = [];
  for (const { tool, file } of files) {
    const evs = tool === 'codex' ? parseCodex(file) : tool === 'gemini' ? parseGemini(file) : tool === 'copilot' ? parseCopilot(file) : parseClaude(file);
    for (const e of evs) { e.logFile = file; all.push(e); }
  }
  all.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
  return all;
}

module.exports = { skipped, findLogs, readEvents, parseClaude, parseCodex, parseGemini, parseCopilot, defaultRoots, readLines };
