#!/usr/bin/env node
'use strict';
const { findLogs, readEvents, skipped } = require('../src/logs');
const { scan } = require('../src/scan');
const report = require('../src/report');
const pkg = require('../package.json');

const HELP = `agent-leftovers ${pkg.version}
See every cloud resource your AI coding agent spun up, and the command to turn each off.

Reads the session logs Claude Code (~/.claude/projects) and Codex CLI (~/.codex/sessions)
already keep on your machine. Read-only: runs nothing, sends nothing anywhere.

Usage: npx agent-leftovers [options]

  --days N        how far back to look (default 30)
  --project TEXT  only sessions whose folder contains TEXT
  --logs PATH     read this log file or folder instead (repeatable)
  --all           also show things the agent cleaned up and failed creates
  --script        print a teardown script with every line commented out
  --json          machine-readable output
  --no-color      plain text
  -v, --version
  -h, --help
`;

function parseArgs(argv) {
  const o = { days: 30, project: null, logs: [], all: false, json: false, script: false, color: !!process.env.FORCE_COLOR || (process.stdout.isTTY && !process.env.NO_COLOR) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) die(`${a} needs a value`); return v; };
    if (a === '-h' || a === '--help') { process.stdout.write(HELP); process.exit(0); }
    else if (a === '-v' || a === '--version') { console.log(pkg.version); process.exit(0); }
    else if (a === '--days') { o.days = Number(val()); if (!(o.days > 0)) die('--days must be a positive number'); }
    else if (a.startsWith('--days=')) o.days = Number(a.slice(7));
    else if (a === '--project') o.project = val();
    else if (a === '--logs') o.logs.push(val());
    else if (a === '--all') o.all = true;
    else if (a === '--json') o.json = true;
    else if (a === '--script') o.script = true;
    else if (a === '--no-color') o.color = false;
    else die(`unknown option ${a}\n\n${HELP}`);
  }
  return o;
}

function die(msg) { process.stderr.write(`agent-leftovers: ${msg}\n`); process.exit(2); }

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sinceMs = Date.now() - opts.days * 86400000;
  const files = findLogs({ sinceMs, extra: opts.logs });
  if (!files.length) {
    die(opts.logs.length
      ? 'no Claude Code or Codex session logs found at the path you gave.'
      : `no Claude Code or Codex session logs from the last ${opts.days} days.\nLooked in ~/.claude/projects and ~/.codex/sessions. Use --logs PATH to point somewhere else.`);
  }
  const sinceIso = new Date(sinceMs).toISOString();
  const events = readEvents(files).filter((e) => !e.time || String(e.time) >= sinceIso);
  const result = scan(events, { project: opts.project });
  result.files = files.length;
  result.cmdCount = events.filter((e) => e.kind === 'cmd').length;
  result.sessionCount = new Set(events.map((e) => e.session)).size;

  if (opts.json) { console.log(JSON.stringify({ version: pkg.version, days: opts.days, ...result }, null, 2)); return; }
  if (opts.script) { console.log(report.script(result)); return; }
  console.log(report.text(result, opts));
  if (skipped.zst) console.log(`(${skipped.zst} older compressed Codex logs skipped: needs Node 22.15 or newer)`);
  const open = result.resources.filter((r) => r.status === 'left').length + result.spend.length;
  process.exitCode = open > 0 ? 1 : 0;
}

main();
