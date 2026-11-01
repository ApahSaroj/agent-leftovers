'use strict';
// Cross-platform smoke test (runs on Windows in CI): the CLI starts, reads a log,
// finds the leftovers and exits with the documented codes.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const bin = path.join(__dirname, '..', 'bin', 'agent-leftovers.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-smoke-'));
const out = spawnSync(process.execPath, [path.join(__dirname, '..', 'demo', 'make-demo.js'), home], { encoding: 'utf8' });
assert.strictEqual(out.status, 0, out.stderr);
const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, NO_COLOR: '1' });
delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME; delete env.GEMINI_CLI_HOME; delete env.COPILOT_HOME;
const run = (args) => spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });

const h = run(['--help']);
assert.strictEqual(h.status, 0); assert.ok(/Exit codes/.test(h.stdout));
const j = run(['--json']);
assert.strictEqual(j.status, 1, j.stderr);
const r = JSON.parse(j.stdout);
assert.ok(r.resources.find((x) => x.name === 'llm-worker-1' && x.status === 'left'));
assert.ok(r.resources.find((x) => x.name === 'pg-dev'));
const txt = run([]);
assert.strictEqual(txt.status, 1);
assert.ok(/never turned off/.test(txt.stdout));
assert.strictEqual(run(['--days=abc']).status, 2);
const b = run(['--brief']);
assert.strictEqual(b.status, 1); assert.ok(/may still be running/.test(b.stdout));
const bz = run(['--brief', '--exit-zero']);
assert.strictEqual(bz.status, 0); assert.ok(/may still be running/.test(bz.stdout));
assert.strictEqual(run(['--script']).status, 1);
const v = run(['--verify', '--json']);
assert.ok([0, 1].includes(v.status), v.stderr);
console.log('PASS smoke (' + process.platform + ', node ' + process.version + ')');
