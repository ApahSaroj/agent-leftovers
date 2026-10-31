'use strict';

// Split a shell command line into simple commands (on && || ; | and newlines),
// respecting quotes. Good enough for agent-written commands; not a full shell parser.
function splitCommands(line) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      cur += c;
      if (c === '\\' && q === '"' && i + 1 < line.length) { cur += line[++i]; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '\\' && line[i + 1] === '\n') { i++; cur += ' '; continue; }
    if (c === '\n' || c === ';') { out.push(cur); cur = ''; continue; }
    if ((c === '&' && line[i + 1] === '&') || (c === '|' && line[i + 1] === '|')) { out.push(cur); cur = ''; i++; continue; }
    if (c === '|') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Tokenize one simple command, removing quotes.
function tokenize(cmd) {
  const toks = [];
  let cur = '';
  let q = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (c === '\\' && q === '"' && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
      cur += c; continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) toks.push(cur); cur = ''; has = false; continue; }
    cur += c;
  }
  if (cur || has) toks.push(cur);
  return stripPrefixes(toks);
}

// Drop env assignments, sudo, npx/bunx/pnpm dlx wrappers so rules see the real CLI.
function stripPrefixes(toks) {
  let t = toks.slice();
  let changed = true;
  while (changed && t.length) {
    changed = false;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) { t.shift(); changed = true; continue; }
    if (['sudo', 'time', 'exec', 'command', 'env'].includes(t[0])) { t.shift(); changed = true; continue; }
    if (['npx', 'bunx'].includes(t[0])) {
      t.shift();
      while (t[0] && t[0].startsWith('-')) t.shift();
      if (t[0]) t[0] = t[0].replace(/@[^/]*$/, '').replace(/^@[^/]+\//, '');
      changed = true; continue;
    }
    if ((t[0] === 'pnpm' || t[0] === 'yarn') && t[1] === 'dlx') { t.splice(0, 2); changed = true; continue; }
  }
  if (t[0]) t[0] = t[0].replace(/^.*[\\/]/, ''); // /usr/bin/gcloud -> gcloud
  if (t[0] === 'flyctl') t[0] = 'fly';
  if (t[0] === 'sls') t[0] = 'serverless';
  return t;
}

// Value of a flag: --zone us-east1 or --zone=us-east1 (any of the given names).
function flag(toks, names) {
  for (let i = 0; i < toks.length; i++) {
    for (const n of names) {
      if (toks[i] === n && i + 1 < toks.length && !toks[i + 1].startsWith('-')) return toks[i + 1];
      if (toks[i].startsWith(n + '=')) return toks[i].slice(n.length + 1);
    }
  }
  return null;
}

function hasFlag(toks, names) {
  return toks.some((t) => names.some((n) => t === n || t.startsWith(n + '=')));
}

// First positional token at or after index `from`, skipping flags and their values.
// `valueFlags` lists flags known to take a value.
function positional(toks, from, valueFlags = []) {
  for (let i = from; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith('-')) {
      if (!t.includes('=') && valueFlags.includes(t)) i++;
      continue;
    }
    return t;
  }
  return null;
}

module.exports = { splitCommands, tokenize, flag, hasFlag, positional };
