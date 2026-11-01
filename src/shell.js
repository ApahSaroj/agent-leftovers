'use strict';

// Remove heredoc bodies (cat > deploy.sh <<EOF ... EOF): that text is data written
// to a file or piped somewhere, not commands that ran. k8s.js reads the bodies itself.
function stripHeredocs(cmd) {
  return String(cmd || '').replace(/(<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '$1');
}

// Split a shell command line into simple commands (on && || ; | and newlines),
// respecting quotes. Good enough for agent-written commands; not a full shell parser.
function splitCommands(line) {
  line = stripHeredocs(line);
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
  const env = {};
  let changed = true;
  while (changed && t.length) {
    changed = false;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) { const i = t[0].indexOf('='); env[t[0].slice(0, i)] = t[0].slice(i + 1); t.shift(); changed = true; continue; }
    if (t[0] === 'env') { t.shift(); while (t[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) { const i = t[0].indexOf('='); env[t[0].slice(0, i)] = t[0].slice(i + 1); t.shift(); } changed = true; continue; }
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
  t = hoistCliGlobals(t);
  // terraform apply -destroy is a destroy
  if ((t[0] === 'terraform' || t[0] === 'tofu') && t[1] === 'apply' && t.includes('-destroy')) t[1] = 'destroy';
  Object.defineProperty(t, 'env', { value: env, enumerable: false });
  return t;
}

// Global flags written before the subcommand hide it from the rules:
//   aws --profile p lambda create-function ...   gcloud --project p compute instances create ...
//   terraform -chdir=infra apply
// Move them to the end, always as --flag=value so they can't be read as names.
const GLOBALS = {
  aws: { val: ['--profile', '--region', '--output', '--endpoint-url', '--query', '--cli-read-timeout', '--cli-connect-timeout', '--color', '--ca-bundle'], bool: ['--no-cli-pager', '--debug', '--no-verify-ssl', '--no-paginate', '--no-sign-request'] },
  gcloud: { val: ['--project', '--account', '--configuration', '--format', '--verbosity', '--impersonate-service-account', '--billing-project', '--flags-file', '--trace-token'], bool: ['--quiet', '-q', '--log-http', '--no-user-output-enabled', '--user-output-enabled'] },
  az: { val: ['--subscription', '--output', '-o', '--query'], bool: ['--debug', '--verbose', '--only-show-errors'] },
  terraform: { val: [], bool: [], prefix: /^-chdir=/ },
  tofu: { val: [], bool: [], prefix: /^-chdir=/ },
};
function hoistCliGlobals(t) {
  const g = GLOBALS[t[0]];
  if (!g) return t;
  const moved = [];
  let i = 1;
  while (i < t.length && t[i].startsWith('-')) {
    const x = t[i];
    if (g.prefix && g.prefix.test(x)) { moved.push(x); i++; continue; }
    if (x.includes('=')) { moved.push(x); i++; continue; }
    if (g.val.includes(x) && i + 1 < t.length) { moved.push(`${x}=${t[i + 1]}`); i += 2; continue; }
    if (g.bool.includes(x)) { moved.push(x); i++; continue; }
    break;
  }
  if (!moved.length) return t;
  return [t[0], ...t.slice(i), ...moved];
}

// Commands that only print help, a version, or a plan: nothing is created.
function isNoop(t) {
  if (!t.length) return true;
  if (t.some((x) => x === '--help' || x === '--version' || x === '--dry-run' || x.startsWith('--dry-run='))) return true;
  if (t[1] === 'help' || t[t.length - 1] === 'help') return true;
  if (t.includes('-h') && !['heroku'].includes(t[0])) return true;
  if ((t[0] === 'terraform' || t[0] === 'tofu' || t[0] === 'pulumi') && (t[1] === 'plan' || t[1] === 'preview')) return true;
  if (t[0] === 'cdk' && (t[1] === 'diff' || t[1] === 'synth')) return true;
  return false;
}

// Every positional token from `from` on (for "create vm1 vm2").
function positionals(toks, from, valueFlags = [], boolFlags = null) {
  const out = [];
  for (let i = from; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith('-')) {
      if (t.includes('=')) continue;
      if (boolFlags ? !boolFlags.includes(t) && i + 1 < toks.length && !toks[i + 1].startsWith('-') : valueFlags.includes(t)) i++;
      continue;
    }
    out.push(t);
  }
  return out;
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

module.exports = { splitCommands, stripHeredocs, tokenize, flag, hasFlag, positional, positionals, isNoop, hoistCliGlobals };
