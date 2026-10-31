'use strict';
// Stress + garbage input: 200 sessions, 60k tool calls, broken lines. Must finish fast and not crash.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-stress-'));
const dir = path.join(home, '.claude', 'projects', 'big');
fs.mkdirSync(dir, { recursive: true });
const now = Date.now();
for (let s = 0; s < 200; s++) {
  const L = [];
  for (let i = 0; i < 300; i++) {
    const id = `t${s}_${i}`;
    const ts = new Date(now - (s * 300 + i) * 1000).toISOString();
    const r = i % 5;
    const tu = r === 0 ? { name: 'Bash', input: { command: `gcloud compute instances create vm-${s}-${i} --zone us-east1-b` } }
      : r === 1 ? { name: 'mcp__supabase__create_project', input: { name: `p-${s}-${i}` } }
      : r === 2 ? { name: 'Bash', input: { command: `ls -la && git status && npm test` } }
      : r === 3 ? { name: 'mcp__github__create_issue', input: { title: 'x' } }
      : { name: 'Read', input: { file_path: '/x' } };
    L.push(JSON.stringify({ sessionId: `s${s}`, cwd: '/w', timestamp: ts, message: { content: [{ type: 'tool_use', id, ...tu }] } }));
    L.push(JSON.stringify({ sessionId: `s${s}`, cwd: '/w', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify({ id: `ref${s}x${i}` }) }] }] } }));
    if (i % 50 === 0) L.push('{"broken": ');
    if (i % 70 === 0) L.push('not json at all');
  }
  fs.writeFileSync(path.join(dir, `s${s}.jsonl`), L.join('\n'));
}
const t0 = Date.now();
const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'agent-leftovers.js'), '--json'], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', maxBuffer: 1 << 30 });
const ms = Date.now() - t0;
const j = JSON.parse(r.stdout);
const left = j.resources.filter((x) => x.status === 'left').length;
const ok = left === 24000 && ms < 30000;
console.log(`${ok ? 'PASS' : 'FAIL'} stress: ${j.resources.length} findings (${left} left) from 60000 tool calls in ${ms} ms`);
process.exit(ok ? 0 : 1);
