'use strict';
// .agent-leftovers-ignore: things you meant to keep (a real deploy, your dev database).
// One pattern per line; # starts a comment. A pattern matches the name, rule:name,
// provider:name or the provider alone, and * is a wildcard. Examples:
//   my-prod-api            gcp-run:my-prod-api      vercel:*      docker-run:postgres-dev
// Read from your home folder and from the folder you run the command in.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = '.agent-leftovers-ignore';

function files(cwd = process.cwd()) {
  const out = [path.join(os.homedir(), FILE)];
  const local = path.join(cwd, FILE);
  if (path.resolve(local) !== path.resolve(out[0])) out.push(local);
  return out;
}

function load(cwd) {
  const pats = [];
  for (const f of files(cwd)) {
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (let line of txt.split(/\r?\n/)) {
      line = line.replace(/\s+#.*$/, '').replace(/^#.*$/, '').trim();
      if (line) pats.push(line);
    }
  }
  return pats;
}

const toRe = (p) => new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');

function apply(resources, pats) {
  if (!pats.length) return 0;
  const res = pats.map(toRe);
  let n = 0;
  for (const f of resources) {
    if (f.status !== 'left' && f.status !== 'maybe-cleaned') continue;
    const name = f.k8sName || f.id || f.name;
    const keys = [f.name, name, `${f.rule}:${f.name}`, `${f.rule}:${name}`, `${f.provider}:${f.name}`, `${f.provider}:${name}`, `${f.provider}:*`, f.provider];
    if (res.some((re) => keys.some((k) => k && re.test(k)))) { f.status = 'ignored'; n++; }
  }
  return n;
}

// --baseline: add everything that is open right now to ~/.agent-leftovers-ignore.
function baseline(resources) {
  const f = files()[0];
  const open = resources.filter((r) => (r.status === 'left' || r.status === 'maybe-cleaned') && !r.nameUnknown);
  const lines = open.map((r) => `${r.rule}:${r.k8sName || r.id || r.name}`.replace(/\s+/g, '*'));
  const uniq = [...new Set(lines)];
  if (uniq.length) {
    const head = fs.existsSync(f) ? '' : '# agent-leftovers: things you meant to keep. One pattern per line, * is a wildcard.\n';
    fs.appendFileSync(f, `${head}# baseline ${new Date().toISOString().slice(0, 10)}\n${uniq.join('\n')}\n`);
  }
  return { file: f, added: uniq.length };
}

module.exports = { load, apply, baseline, FILE };
