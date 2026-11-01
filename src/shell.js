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
  let via = null; // a credentials wrapper (aws-vault exec P --): the teardown needs it too
  let changed = true;
  while (changed && t.length) {
    changed = false;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) { const i = t[0].indexOf('='); env[t[0].slice(0, i)] = t[0].slice(i + 1); t.shift(); changed = true; continue; }
    if (t[0] === 'env') {
      t.shift();
      for (;;) {
        if (t[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) { const i = t[0].indexOf('='); env[t[0].slice(0, i)] = t[0].slice(i + 1); t.shift(); continue; }
        if (t[0] === '-u' || t[0] === '--unset' || t[0] === '-C' || t[0] === '--chdir' || t[0] === '-S') { t.splice(0, 2); continue; }
        if (t[0] && /^-/.test(t[0])) { t.shift(); continue; }
        break;
      }
      changed = true; continue;
    }
    // sudo [-u USER] [-E] cmd: flags with a value (-u -g -C -h -p -U -r -t -D) take the next word.
    if (t[0] === 'sudo' || t[0] === 'doas') {
      t.shift();
      while (t[0] && t[0].startsWith('-') && t[0] !== '--') t.splice(0, /^-[ugCphUrtD]$/.test(t[0]) || /^--(user|group|close-from|host|prompt|other-user|role|type|chdir)$/.test(t[0]) ? 2 : 1);
      if (t[0] === '--') t.shift();
      changed = true; continue;
    }
    if (t[0] === 'time') { t.shift(); while (t[0] && /^-[pv]+$/.test(t[0])) t.shift(); changed = true; continue; }
    if (['exec', 'command', 'builtin'].includes(t[0])) { t.shift(); while (t[0] && /^-[a-z]+$/.test(t[0])) t.shift(); changed = true; continue; }
    if (['npx', 'bunx'].includes(t[0])) {
      t.shift();
      while (t[0] && t[0].startsWith('-')) t.shift();
      if (t[0]) t[0] = t[0].replace(/@[^/]*$/, '').replace(/^@[^/]+\//, '');
      changed = true; continue;
    }
    if ((t[0] === 'pnpm' || t[0] === 'yarn') && t[1] === 'dlx') { t.splice(0, 2); changed = true; continue; }
    // Wrappers that run the real CLI. They hid creates: timeout 900 gcloud sql ..., nohup ngrok ...
    if (['nohup', 'setsid', 'caffeinate', 'stdbuf', 'unbuffer', 'chronic'].includes(t[0])) { t.shift(); while (t[0] && t[0].startsWith('-')) t.shift(); changed = true; continue; }
    if (t[0] === 'nice' || t[0] === 'ionice') { t.shift(); while (t[0] && /^-/.test(t[0])) t.splice(0, /^-[nct]$/.test(t[0]) ? 2 : 1); changed = true; continue; }
    if (t[0] === 'timeout' || t[0] === 'gtimeout') {
      t.shift();
      while (t[0] && t[0].startsWith('-')) t.splice(0, /^-[sk]$|^--(signal|kill-after)$/.test(t[0]) ? 2 : 1);
      if (t[0] && /^\d+(\.\d+)?[smhd]?$/.test(t[0])) t.shift();
      changed = true; continue;
    }
    if ((t[0] === 'pnpm' || t[0] === 'yarn' || t[0] === 'npm') && t[1] === 'exec') { t.splice(0, 2); while (t[0] && t[0].startsWith('-') && t[0] !== '--') t.shift(); if (t[0] === '--') t.shift(); changed = true; continue; }
    if (t[0] === 'bun' && t[1] === 'x') { t.splice(0, 2); while (t[0] && t[0].startsWith('-')) t.shift(); changed = true; continue; }
    // aws-vault exec PROFILE -- cmd, doppler run -- cmd, op run -- cmd, dotenv -- cmd, infisical run -- cmd
    if (['aws-vault', 'doppler', 'op', 'dotenv', 'infisical', 'dotenvx', 'with-env'].includes(t[0]) && t.includes('--')) { via = t.slice(0, t.indexOf('--') + 1).join(' '); t = t.slice(t.indexOf('--') + 1); changed = true; continue; }
    // Shell keywords and grouping in front of a command still run it: then gcloud ..., do ..., ( ... ), { ...; }, ! cmd
    if (['then', 'do', 'else', 'if', 'elif', 'while', 'until', '!', '{', '('].includes(t[0])) { t.shift(); changed = true; continue; }
    if (t[0] && /^[({]./.test(t[0]) && !/^\(\(/.test(t[0]) && !/^\{[^}]*,/.test(t[0])) { t[0] = t[0].slice(1); changed = true; continue; }
  }
  // the closing ) or } of a group, on its own or stuck to the last word
  while (t.length && (t[t.length - 1] === ')' || t[t.length - 1] === '}')) t.pop();
  if (t.length > 1 && /[^()]\)$/.test(t[t.length - 1]) && !t[t.length - 1].includes('(')) t[t.length - 1] = t[t.length - 1].slice(0, -1);
  if (t[0]) t[0] = t[0].replace(/^.*[\\/]/, ''); // /usr/bin/gcloud -> gcloud
  if (t[0] === 'flyctl') t[0] = 'fly';
  if (t[0] === 'sls') t[0] = 'serverless';
  t = hoistCliGlobals(t);
  // terraform apply -destroy is a destroy
  if ((t[0] === 'terraform' || t[0] === 'tofu') && t[1] === 'apply' && t.includes('-destroy')) t[1] = 'destroy';
  Object.defineProperty(t, 'env', { value: env, enumerable: false });
  if (via) Object.defineProperty(t, 'via', { value: via, enumerable: false });
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
  // --version prints a version only on its own: gcloud tpu-vm create --version <RUNTIME> and helm install --version <CHART>
  // create real things.
  if (t.some((x, i) => x === '--help' || x === '--dry-run' || x.startsWith('--dry-run=') || (x === '--version' && (i === t.length - 1 || t[i + 1].startsWith('-'))))) return true;
  if (t[1] === 'help' || t[t.length - 1] === 'help') return true;
  // -h is --hostname for docker run, --host for psql/mysql/redis-cli: not help there.
  if (t.includes('-h') && !['heroku', 'docker', 'docker-compose', 'podman', 'psql', 'mysql', 'redis-cli', 'ssh', 'pg_dump', 'pg_restore'].includes(t[0])) return true;
  // terraform apply -refresh-only changes state, not infrastructure
  if ((t[0] === 'terraform' || t[0] === 'tofu') && t[1] === 'apply' && t.some((x) => x === '-refresh-only' || x === '--refresh-only' || x === '-refresh-only=true')) return true;
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

// Quote a word for a POSIX shell when it holds anything beyond plain characters, so a name or
// path from a log can never run as code when the user copies a teardown.
const PLAIN = /^[A-Za-z0-9_@%+=:,./^-]+$/;
// v0.4.2 round 2: teardowns are rendered for the platform the scan runs on. On Windows a
// teardown must paste into both cmd.exe and Windows PowerShell 5.1: no single quotes (cmd keeps
// them), no '&&' (PS 5.1), no '#' comments (cmd). setPlatform() is called by scan().
let PLATFORM = process.platform;
function setPlatform(p) { const old = PLATFORM; PLATFORM = p || process.platform; return old; }
const getPlatform = () => PLATFORM;
// cmd.exe and PowerShell both accept "..." around a word with spaces; inside it, % ! (cmd) and
// $ ` (PowerShell) would still expand, so such a word becomes <NAME>.
function wq(s) { s = String(s); if ((PLAIN.test(s) && !/[%^]/.test(s) && !s.startsWith('-')) || /^<[A-Z_]+>$/.test(s)) return s; return /["%!$`\r\n]/.test(s) ? '<NAME>' : `"${s}"`; }
function sq(s) {
  s = String(s);
  if (PLATFORM === 'win32') return wq(s);
  return (PLAIN.test(s) && !s.startsWith('-')) || /^<[A-Z_]+>$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}
// A --flag=value (or -chdir=DIR) token whose value may need quoting: the whole token is quoted,
// which bash, PowerShell and cmd all read as one argument.
function qflag(prefix, v) { v = String(v); return PLAIN.test(v) ? prefix + v : /^<[A-Z_]+>$/.test(v) ? prefix + v : sq(prefix + v); }
// Find a process by a word of its command line, then kill it: per platform.
function procFind(word, what = 'check it is the right one') {
  // Only plain characters reach the command (anything else becomes '.', a regex wildcard), so log
  // text can never run as code, inside quotes or out, in sh, cmd.exe or PowerShell.
  const w = String(word || '').replace(/[^A-Za-z0-9._:@\/-]/g, '.').replace(/^-/, '.') || '<NAME>';
  return PLATFORM === 'win32'
    ? `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object CommandLine -match '${w}' | Select-Object ProcessId,CommandLine"   # ${what}, then: taskkill /PID <PID>`
    : `pgrep -af ${sq(w)}   # ${what}, then: kill <PID>`;
}
// Same, for every token of a command (a --flag=value token keeps its flag and quotes its value).
function quoteToks(t) {
  const out = t.map((x) => {
    if (PLAIN.test(x) && !(PLATFORM === 'win32' && /[%^]/.test(x))) return x;
    const m = x.match(/^(--?[A-Za-z][\w-]*=)([\s\S]*)$/);
    return m ? m[1] + sq(m[2]) : sq(x);
  });
  if (t.env) Object.defineProperty(out, 'env', { value: t.env, enumerable: false });
  return out;
}

module.exports = { sq, wq, qflag, procFind, setPlatform, getPlatform, quoteToks, PLAIN, splitCommands, stripHeredocs, tokenize, flag, hasFlag, positional, positionals, isNoop, hoistCliGlobals };
