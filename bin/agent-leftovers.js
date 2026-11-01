#!/usr/bin/env node
'use strict';
const { findLogs, readEvents, skipped } = require('../src/logs');
const { scan } = require('../src/scan');
const report = require('../src/report');
const ignore = require('../src/ignore');
const pkg = require('../package.json');

const HELP = `agent-leftovers ${pkg.version}
See every cloud resource your AI coding agent spun up, and the command to turn each off.

Reads the session logs your agents already keep on this machine:
  Claude Code  ~/.claude/projects     (or $CLAUDE_CONFIG_DIR/projects)
  Codex CLI    ~/.codex/sessions      (or $CODEX_HOME)
  Gemini CLI   ~/.gemini/tmp/*/chats  (or $GEMINI_CLI_HOME)
  Copilot CLI  ~/.copilot/session-state (or $COPILOT_HOME)
including MCP tool calls, kubectl/helm, Docker and tunnels. On Windows it also reads
WSL home folders. Read-only: by default it runs nothing and sends nothing anywhere.

Usage: agent-leftovers [options]     (or: npx github:ApahSaroj/agent-leftovers [options])

  --days N        how far back to look (default 30; no limit with --logs)
  --project TEXT  only sessions whose folder contains TEXT
  --logs PATH     read this log file or folder instead (repeatable)
  --all           also show cleaned-up, ignored and failed items
  --verify        ask your installed CLIs (gcloud, aws, az, kubectl, helm, docker,
                  wrangler, fly, heroku, supabase, neonctl, vercel, doctl) whether each
                  leftover still exists. Read-only describe/list calls, off by default.
  --sweep         ask gcloud, aws and az (read-only list calls) for anything whose
                  expiry tag has passed, even if no agent log mentions it. Off by
                  default. Scope: gcloud's active project, aws's default region
                  (tagged resources only), az's current subscription.
  --expired       only show things whose expires / ttl tag has passed
  --tag KEY[=VAL] only show things carrying this tag or label (repeatable),
                  e.g. --tag session=abc123
  --script        print a teardown script with every line commented out
  --json          machine-readable output (secrets in commands are masked)
  --brief         a few lines, or nothing when all is clear (for hooks and cron)
  --baseline      add everything listed now to ~/.agent-leftovers-ignore
  --no-ignore     don't apply .agent-leftovers-ignore
  --no-color      plain text
  -v, --version
  -h, --help

Ignore file: ~/.agent-leftovers-ignore and ./.agent-leftovers-ignore, one pattern per
line: a name, rule:name, or provider:* (* is a wildcard).

Tags it reads: gcloud --labels, aws --tag-specifications / --tags, az --tags.
Expiry keys: expires, expiry, expires-at, delete-after, ttl (a date like 2026-11-07,
2026-11-07t18-00, a unix time, or a ttl like 4h / 3d counted from creation).
Session keys: session, session-id, agent-session.

Exit codes: 0 nothing left running, 1 leftovers found, 2 error or bad option.
`;

function die(msg) { process.stderr.write(`agent-leftovers: ${msg}\n`); process.exit(2); }

function parseArgs(argv) {
  const o = { days: 30, daysSet: false, project: null, logs: [], all: false, json: false, script: false, verify: false, sweep: false, expired: false, tags: [], brief: false, baseline: false, ignore: true, color: !!process.env.FORCE_COLOR || (process.stdout.isTTY && !process.env.NO_COLOR) };
  const days = (v, a) => { const n = Number(v); if (!(n > 0) || !Number.isFinite(n)) die(`${a} must be a positive number`); o.days = n; o.daysSet = true; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) die(`${a} needs a value`); return v; };
    if (a === '-h' || a === '--help') { process.stdout.write(HELP); process.exit(0); }
    else if (a === '-v' || a === '--version') { console.log(pkg.version); process.exit(0); }
    else if (a === '--days') days(val(), a);
    else if (a.startsWith('--days=')) days(a.slice(7), '--days');
    else if (a === '--project') o.project = val();
    else if (a.startsWith('--project=')) o.project = a.slice(10);
    else if (a === '--logs') o.logs.push(val());
    else if (a.startsWith('--logs=')) o.logs.push(a.slice(7));
    else if (a === '--all') o.all = true;
    else if (a === '--json') o.json = true;
    else if (a === '--script') o.script = true;
    else if (a === '--verify') o.verify = true;
    else if (a === '--brief') o.brief = true;
    else if (a === '--sweep') o.sweep = true;
    else if (a === '--expired') o.expired = true;
    else if (a === '--tag') o.tags.push(val());
    else if (a.startsWith('--tag=')) o.tags.push(a.slice(6));
    else if (a === '--baseline') o.baseline = true;
    else if (a === '--no-ignore') o.ignore = false;
    else if (a === '--no-color') o.color = false;
    else die(`unknown option ${a}\n\n${HELP}`);
  }
  return o;
}

const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
function stripControl(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 6) return;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === 'string') o[k] = v.replace(CTRL, ' ');
    else if (v && typeof v === 'object') stripControl(v, depth + 1);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  // Logs you point at directly are read whatever their age, unless you ask for --days.
  const sinceMs = opts.logs.length && !opts.daysSet ? 0 : Date.now() - opts.days * 86400000;
  const files = findLogs({ sinceMs, extra: opts.logs });
  if (!files.length) {
    if (opts.brief) return;
    die(opts.logs.length
      ? `no Claude Code, Codex, Gemini or Copilot session logs found at the path you gave${opts.daysSet ? ` from the last ${opts.days} days` : ''}.`
      : `no agent session logs from the last ${opts.days} days.\nLooked in ~/.claude/projects, ~/.codex/sessions, ~/.gemini/tmp and ~/.copilot/session-state.\nUse --logs PATH to point somewhere else, or --days N to look further back.`);
  }
  const sinceIso = new Date(sinceMs).toISOString();
  const events = readEvents(files).filter((e) => !sinceMs || !e.time || String(e.time) >= sinceIso);
  const result = scan(events, { project: opts.project });
  result.files = files.length;
  result.cmdCount = events.filter((e) => e.kind === 'cmd').length;
  result.sessionCount = new Set(events.map((e) => e.session)).size;
  result.agents = [...new Set(files.map((f) => f.tool))];
  if (opts.ignore) result.ignored = ignore.apply(result.resources, ignore.load());
  if (opts.verify) {
    if (!opts.json && !opts.script && !opts.brief) process.stderr.write('Checking with your cloud CLIs (read-only)...\n');
    result.verified = require('../src/verify').verify(result.resources);
  }
  if (opts.expired || opts.tags.length) {
    const { matchesTags } = require('../src/tags');
    result.filter = [opts.expired ? 'expired' : null, ...opts.tags.map((x) => `tag ${x}`)].filter(Boolean).join(', ');
    result.resources = result.resources.filter((r) => (!opts.expired || r.expired) && matchesTags(r, opts.tags));
    result.spend = [];
  }
  if (opts.sweep) {
    if (!opts.json && !opts.script && !opts.brief) process.stderr.write('Sweeping gcloud, aws and az for expired tags (read-only list calls)...\n');
    result.sweep = require('../src/sweep').sweep({ wantTags: opts.tags });
    if (opts.expired) result.sweep.items = result.sweep.items.filter((i) => i.expired);
  }
  // Names come from logs and cloud output: never let control characters (newlines,
  // ANSI/OSC escapes) reach a terminal, a script or the ignore file.
  stripControl(result);
  const open = result.resources.filter((r) => r.status === 'left').length + result.spend.length + (result.sweep ? result.sweep.expired : 0);
  if (skipped.unreadable.length && !opts.json && !opts.brief) process.stderr.write(`agent-leftovers: could not read ${skipped.unreadable.length} log file(s):\n  ${skipped.unreadable.slice(0, 5).join('\n  ')}\n`);

  if (opts.baseline) {
    const b = ignore.baseline(result.resources);
    console.log(b.added ? `Added ${b.added} item${b.added === 1 ? '' : 's'} to ${b.file}. They won't be listed again.` : 'Nothing open to add.');
    return;
  }
  if (opts.brief) { const s = report.brief(result); if (s) console.log(s); return; }
  if (opts.json) {
    console.log(JSON.stringify({ version: pkg.version, days: opts.days, ...result, unreadable: skipped.unreadable }, null, 2));
    process.exitCode = open > 0 ? 1 : 0;
    return;
  }
  if (opts.script) { console.log(report.script(result)); return; }
  console.log(report.text(result, opts));
  if (skipped.zst) console.log(`(${skipped.zst} older compressed Codex logs skipped: needs Node 22.15 or newer)`);
  process.exitCode = open > 0 ? 1 : 0;
}

try { main(); } catch (e) {
  process.stderr.write(`agent-leftovers: unexpected error: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n') : e}\nPlease report it: https://github.com/ApahSaroj/agent-leftovers/issues\n`);
  process.exit(2);
}
