'use strict';
// v0.4.2 round 2: split a teardown line into the part you run and the part you read.
//
// Rules, MCP, Kubernetes, orphan and sweep teardowns are written as one line:
//   <command>   # <hint>
// and folder-bound ones as
//   cd <dir> && <command>   # <hint>
// A '#' is not a comment in cmd.exe and '&&' does not exist in Windows PowerShell 5.1, so the
// finding keeps three fields instead:
//   teardown      the command alone, safe to paste
//   teardownHint  the text that followed '#': what to check, what to run next
//   runIn         the folder to run it in (was the 'cd X &&' part)
// On Windows an env-var prefix (TF_WORKSPACE=x cmd, AWS_REGION=x cdk ...) also moves to the hint.
const { getPlatform } = require('./shell');

// Index of the first '#' that starts a comment: preceded by 2+ spaces, outside quotes.
function commentAt(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"') i++; continue; }
    if (c === '\\') { i++; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#' && i >= 2 && /\s\s$/.test(s.slice(0, i))) return i;
  }
  return -1;
}

// cd <dir> && rest   (dir plain, '...' with '\'' escapes, or "...")
function splitCd(cmd) {
  const m = cmd.match(/^cd\s+('(?:[^']|'\\'')*'(?:'\\''(?:[^']|'\\'')*')*|"[^"]*"|\S+)\s*(?:&&\s*([\s\S]+))?$/);
  if (!m) return null;
  let dir = m[1];
  if (dir.startsWith("'")) dir = dir.slice(1, -1).replace(/'\\''/g, "'");
  else if (dir.startsWith('"')) dir = dir.slice(1, -1);
  return { dir, rest: m[2] ? m[2].trim() : '' };
}

function splitTeardown(td, platform = getPlatform()) {
  const out = { teardown: String(td == null ? '' : td) };
  let s = out.teardown;
  const hints = [];
  const at = commentAt(s);
  if (at >= 0) { const h = s.slice(at + 1).trim(); if (h) hints.push(h); s = s.slice(0, at).trim(); }
  const cd = splitCd(s);
  if (cd && cd.rest && cd.dir !== '<NAME>') { out.runIn = cd.dir; s = cd.rest; }
  if (platform === 'win32') {
    const env = [];
    let m;
    while ((m = s.match(/^([A-Z_][A-Z0-9_]*)=(\S+)\s+/))) { env.push([m[1], m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')]); s = s.slice(m[0].length); }
    if (env.length) hints.unshift(`first set ${env.map(([k, v]) => `${k}=${v}`).join(' and ')} (cmd: set ${env.map(([k, v]) => `${k}=${v}`).join(' & set ')}; PowerShell: ${env.map(([k, v]) => `$env:${k}='${v}'`).join('; ')})`);
  }
  out.teardown = s;
  if (hints.length) out.teardownHint = hints.join('. ');
  return out;
}

// Apply to a finding in place (idempotent: a finding that already has a hint is left alone).
function applySplit(f, platform) {
  if (!f || typeof f.teardown !== 'string' || f.teardownHint !== undefined || f.runIn !== undefined) return f;
  const s = splitTeardown(f.teardown, platform);
  f.teardown = s.teardown;
  if (s.teardownHint) f.teardownHint = s.teardownHint;
  if (s.runIn) f.runIn = s.runIn;
  return f;
}

// The old one-line form, for anyone who wants it (posix shells only).
function oneLine(f) {
  const { sq } = require('./shell');
  return `${f.runIn ? `cd ${sq(f.runIn)} && ` : ''}${f.teardown}${f.teardownHint ? `   # ${f.teardownHint}` : ''}`;
}

module.exports = { splitTeardown, applySplit, commentAt, oneLine };
