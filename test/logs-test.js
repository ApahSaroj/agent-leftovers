'use strict';
// v0.4.2: log-reader gaps from the v0.4.1 review (PowerShell tool, timeouts/interrupts,
// Codex Windows argv, Gemini subagent chats, background flags, duplicate files, BOM, XDG path).
// Each case builds a temp HOME with realistic logs and runs the real CLI.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

module.exports = (t, BIN) => {
  const iso = (m) => new Date(Date.now() - m * 60000).toISOString();
  const J = (L) => L.map((o) => JSON.stringify(o)).join('\n') + '\n';
  function mk(files) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alrev-'));
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(home, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
    return home;
  }
  function run(home, args = [], env = {}) {
    let out;
    try {
      out = execFileSync('node', [BIN, '--json', '--all', '--no-ignore', ...args], { env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', GEMINI_CLI_HOME: '', COPILOT_HOME: '', XDG_CONFIG_HOME: '', APPDATA: '', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { out = e.stdout || ''; if (!out) return { error: String(e.stderr || e.message).slice(0, 300) }; }
    try { return JSON.parse(out); } catch { return { error: out.slice(0, 300) }; }
  }
  const find = (r, name) => (r.resources || []).find((x) => x.name === name);
  // Each case passes `bug` = the v0.4.1 symptom; the test asserts it no longer happens.
  const check = (id, title, bug, detail) => t(`logs ${id}: ${title} (fixed)`, () => assert.ok(!bug, detail));

  // Claude helpers
  function claudeLines({ sid = 'c-sess-1', cwd = '/home/dev/proj', tool = 'Bash', command, result = 'ok', isError = false, extraInput = {}, t = 30 }) {
    return [
      { type: 'user', sessionId: sid, cwd, timestamp: iso(t + 1), message: { role: 'user', content: 'go' } },
      { parentUuid: 'u1', sessionId: sid, cwd, timestamp: iso(t), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_A', name: tool, input: { command, ...extraInput } }] } },
      { parentUuid: 'a1', sessionId: sid, cwd, timestamp: iso(t - 1), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: result, is_error: isError }] } },
    ];
  }
  const PROJ = '.claude/projects/-home-dev-proj/';

  // 1. Claude PowerShell tool (native Windows shell tool, v2.1.84+)
  {
    const home = mk({ [PROJ + 'c-sess-1.jsonl']: J(claudeLines({ tool: 'PowerShell', cwd: 'C:\\Users\\dev\\proj', command: 'gcloud compute instances create ps-vm --zone us-central1-a --machine-type e2-standard-4' })) });
    const r = run(home);
    check('C1', 'Claude PowerShell tool commands are ignored', !find(r, 'ps-vm'), `cmdCount=${r.cmdCount}, ps-vm found=${!!find(r, 'ps-vm')}`);
  }
  // 2. Claude timed-out create (Exit code 143 / Command timed out) is hidden as "failed"
  {
    const home = mk({ [PROJ + 'c-sess-1.jsonl']: J(claudeLines({ command: 'gcloud container clusters create big-gke --zone us-central1-a --num-nodes 3 --machine-type n2-standard-8', result: 'Exit code 143\nCommand timed out after 2m 0s\nCreating cluster big-gke in us-central1-a...', isError: true })) });
    const r = run(home);
    const f = find(r, 'big-gke');
    check('C2', 'Claude timed-out create (server-side op continues) is marked failed, hidden without --all', !!f && f.status === 'failed', `status=${f && f.status}`);
  }
  // 2b. Claude user-interrupted mid-run
  {
    const home = mk({ [PROJ + 'c-sess-1.jsonl']: J(claudeLines({ command: 'gcloud sql instances create pg-main --tier db-custom-2-7680 --region us-central1', result: '[Request interrupted by user for tool use]', isError: true })) });
    const r = run(home);
    const f = find(r, 'pg-main');
    check('C2b', 'Claude create interrupted mid-run is marked failed', !!f && f.status === 'failed', `status=${f && f.status}`);
  }
  // 3. Claude run_in_background dev tunnel / worker
  {
    const home = mk({ [PROJ + 'c-sess-1.jsonl']: J(claudeLines({ command: 'python3 batch_worker.py --all', extraInput: { run_in_background: true }, result: 'Command running in background with ID: bash_1' })) });
    const r = run(home);
    const bg = (r.resources || []).filter((x) => x.rule === 'bg-process');
    check('C3', 'Claude run_in_background:true process not reported as background process', bg.length === 0, `bg findings=${bg.length}`);
  }
  // 4. Claude Desktop agent-mode sessions (Linux path)
  if (process.platform === 'linux') {
    const home = mk({ ['.config/Claude/local-agent-mode-sessions/abc/def/projects/-home-dev-proj/s.jsonl']: J(claudeLines({ command: 'gcloud compute instances create desk-vm --zone us-central1-a' })) });
    const r = run(home);
    check('C4', 'Claude Desktop local-agent-mode-sessions transcripts not discovered', !find(r, 'desk-vm'), `files=${r.files}, error=${r.error ? 'no logs' : '-'}`);
  }
  // 5. Claude orphaned copy + live file: duplicate counting
  {
    const L = J(claudeLines({ command: 'gcloud compute instances create dup-vm --zone us-central1-a' }));
    const home = mk({ [PROJ + 'c-sess-1.jsonl']: L, [PROJ + 'c-sess-1.orphaned-1761900000-ab12.jsonl']: L });
    const r = run(home);
    const f = find(r, 'dup-vm');
    check('C5', 'Claude .orphaned-*.jsonl copy re-read: same create counted twice', !!f && f.times > 1, `files=${r.files}, times=${f && f.times}`);
  }
  // 6. BOM on first line (file saved by a Windows editor / PowerShell Out-File)
  {
    const home = mk({ [PROJ + 'c-sess-1.jsonl']: '\uFEFF' + JSON.stringify(claudeLines({ command: 'x' })[0]).replace('"go"', '"go"') + '\n' + J([
      { parentUuid: 'u1', sessionId: 'c-sess-1', cwd: '/home/dev/proj', timestamp: iso(5), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_B', name: 'Bash', input: { command: 'echo hi' } }] } },
    ]) });
    // Put the create on line 1 instead so the BOM swallows it.
    const first = { parentUuid: null, sessionId: 'c-sess-1', cwd: '/home/dev/proj', timestamp: iso(6), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_Z', name: 'Bash', input: { command: 'gcloud compute instances create bom-vm --zone us-central1-a' } }] } };
    fs.writeFileSync(path.join(home, PROJ, 'c-sess-1.jsonl'), '\uFEFF' + JSON.stringify(first) + '\r\n');
    const r = run(home);
    check('X1', 'UTF-8 BOM drops the first JSONL line', !find(r, 'bom-vm'), `bom-vm found=${!!find(r, 'bom-vm')}, cmdCount=${r.cmdCount}`);
  }
  // Codex helpers
  function codexFile(calls, { id = 'codex-1', cwd = '/home/dev/site' } = {}) {
    const L = [{ timestamp: iso(40), type: 'session_meta', payload: { id, cwd, originator: 'codex_cli_rs', cli_version: '0.150.0' } }];
    let n = 0;
    for (const c of calls) {
      const call_id = `call_${++n}`;
      L.push({ timestamp: iso(30 - n), type: 'response_item', payload: { type: 'function_call', name: c.name, arguments: JSON.stringify(c.args), call_id } });
      L.push({ timestamp: iso(30 - n), type: 'response_item', payload: { type: 'function_call_output', call_id, output: c.output } });
    }
    return J(L);
  }
  const CDX = '.codex/sessions/2026/10/31/rollout-2026-10-31T10-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001.jsonl';
  // 7. Codex timeout (exit 124) on a long create
  {
    const home = mk({ [CDX]: codexFile([{ name: 'shell_command', args: { command: 'gcloud sql instances create cdx-pg --tier db-custom-2-7680 --region us-central1', workdir: '/home/dev/site' }, output: 'Exit code: 124\nWall time: 10.0 seconds\nOutput:\ncommand timed out after 10000 milliseconds\nCreating Cloud SQL instance...' }]) });
    const r = run(home);
    const f = find(r, 'cdx-pg');
    check('X2', 'Codex timed-out create (exit 124) is marked failed', !!f && f.status === 'failed', `status=${f && f.status}`);
  }
  // 8. Codex on Windows: shell argv ["powershell.exe","-Command", ...]
  {
    const home = mk({ [CDX]: codexFile([
      { name: 'shell', args: { command: ['powershell.exe', '-Command', 'gcloud compute instances create win-vm --zone us-central1-a'], workdir: 'C:\\dev\\site' }, output: JSON.stringify({ output: 'done', metadata: { exit_code: 0 } }) },
      { name: 'shell', args: { command: ['pwsh', '-NoProfile', '-Command', 'aws s3 mb s3://win-bucket-77'], workdir: 'C:\\dev\\site' }, output: JSON.stringify({ output: 'done', metadata: { exit_code: 0 } }) },
      { name: 'shell', args: { command: ['cmd.exe', '/c', 'npx wrangler r2 bucket create win-r2'], workdir: 'C:\\dev\\site' }, output: JSON.stringify({ output: 'done', metadata: { exit_code: 0 } }) },
    ]) });
    const r = run(home);
    const miss = ['win-vm', 's3://win-bucket-77', 'win-bucket-77', 'win-r2'].filter((n) => find(r, n));
    check('X3', 'Codex Windows argv (powershell.exe/pwsh -Command, cmd.exe /c) not unwrapped', miss.length < 3, `cmdCount=${r.cmdCount}, found=${JSON.stringify((r.resources || []).map((x) => x.name))}`);
  }
  // 9. Codex compressed + plain copy coexisting
  {
    const zlib = require('zlib');
    const body = codexFile([{ name: 'exec_command', args: { cmd: 'gcloud compute instances create zst-vm --zone us-central1-a' }, output: 'Chunk ID: 1\nWall time: 3.1 seconds\nProcess exited with code 0\nOutput:\nCreated' }]);
    const files = { [CDX]: body };
    const home = mk(files);
    if (typeof zlib.zstdCompressSync === 'function') fs.writeFileSync(path.join(home, CDX + '.zst'), zlib.zstdCompressSync(Buffer.from(body)));
    const r = run(home);
    const f = find(r, 'zst-vm');
    check('X4', 'Codex .jsonl and .jsonl.zst of the same rollout both read (double count)', !!f && f.times > 1, `files=${r.files}, times=${f && f.times}`);
  }
  // Gemini helpers
  function gemMsg(id, calls, t = 20) { return { id, timestamp: iso(t), type: 'gemini', content: '', toolCalls: calls }; }
  function gemCall(id, command, { status = 'success', out = 'Exit Code: 0' } = {}) { return { id, name: 'run_shell_command', args: { command }, status, timestamp: iso(19), result: [{ functionResponse: { id, name: 'run_shell_command', response: { output: out } } }] }; }
  const GEM = '.gemini/tmp/7d1f00aa/';
  // 10. Gemini subagent chat (chats/<parentSessionId>/<id>.jsonl)
  {
    const home = mk({
      [GEM + '.project_root']: '/home/dev/app',
      [GEM + 'chats/session-2026-10-31T10-00-1a2b3c4d.jsonl']: J([{ sessionId: '1a2b3c4d-main', projectHash: '7d1f00aa', startTime: iso(30), lastUpdated: iso(10), kind: 'main' }, gemMsg('m1', [gemCall('t1', 'echo hi')])]),
      [GEM + 'chats/1a2b3c4d-main/sub-abc.jsonl']: J([{ sessionId: 'sub-abc', projectHash: '7d1f00aa', startTime: iso(25), lastUpdated: iso(10), kind: 'subagent' }, gemMsg('s1', [gemCall('t2', 'gcloud run deploy sub-svc --source . --region us-central1')])]),
    });
    const r = run(home);
    check('G1', 'Gemini subagent transcripts (chats/<parent>/<id>.jsonl) not discovered', !find(r, 'sub-svc'), `files=${r.files}, sub-svc found=${!!find(r, 'sub-svc')}`);
  }
  // 11. Gemini cancelled shell call (user hit Esc mid-create)
  {
    const home = mk({ [GEM + 'chats/session-2026-10-31T10-00-1a2b3c4d.jsonl']: J([{ sessionId: 's', projectHash: '7d1f00aa', startTime: iso(30), kind: 'main' }, gemMsg('m1', [gemCall('t1', 'gcloud container clusters create gem-gke --zone us-central1-a', { status: 'cancelled', out: 'Command was cancelled by user before it could complete.' })])]) });
    const r = run(home);
    const f = find(r, 'gem-gke');
    check('G2', 'Gemini cancelled run_shell_command create is marked failed', !!f && f.status === 'failed', `status=${f && f.status}`);
  }
  // 12. Gemini legacy .json + migrated .jsonl both present
  {
    const msg = gemMsg('m1', [gemCall('t1', 'gcloud compute instances create mig-vm --zone us-central1-a')]);
    const home = mk({
      [GEM + 'chats/session-2026-09-01T10-00-1a2b3c4d.json']: JSON.stringify({ sessionId: 's1', projectHash: '7d1f00aa', startTime: iso(30), lastUpdated: iso(10), messages: [msg] }),
      [GEM + 'chats/session-2026-09-01T10-00-1a2b3c4d.jsonl']: J([{ sessionId: 's1', projectHash: '7d1f00aa', startTime: iso(30) }, msg]),
    });
    const r = run(home);
    const f = find(r, 'mig-vm');
    check('G3', 'Gemini legacy .json left beside its migrated .jsonl: double count', !!f && f.times > 1, `files=${r.files}, times=${f && f.times}`);
  }
  // 13. Gemini background shell (is_background) not reported
  {
    const home = mk({ [GEM + 'chats/session-2026-10-31T10-00-1a2b3c4d.jsonl']: J([{ sessionId: 's', projectHash: '7d1f00aa', startTime: iso(30) }, gemMsg('m1', [{ ...gemCall('t1', 'python3 scraper.py'), args: { command: 'python3 scraper.py', is_background: true } }])]) });
    const r = run(home);
    const bg = (r.resources || []).filter((x) => x.rule === 'bg-process');
    check('G4', 'Gemini is_background:true shell not reported as background process', bg.length === 0, `bg findings=${bg.length}`);
  }
  // 14. Gemini .json with BOM -> whole file unreadable
  {
    const home = mk({ [GEM + 'chats/session-2026-09-01T10-00-1a2b3c4d.json']: '\uFEFF' + JSON.stringify({ sessionId: 's1', messages: [gemMsg('m1', [gemCall('t1', 'gcloud compute instances create gbom-vm --zone us-central1-a')])] }) });
    const r = run(home);
    check('X5', 'BOM makes a whole Gemini .json session unreadable', !find(r, 'gbom-vm'), `unreadable=${JSON.stringify(r.unreadable)}`);
  }
  // Copilot
  const CP = '.copilot/session-state/5f0e-sess/events.jsonl';
  function cpFile(evts) { return J([{ type: 'session.start', data: { sessionId: '5f0e-sess', copilotVersion: '1.0.40', context: { cwd: '/home/dev/api' } }, timestamp: iso(40) }, ...evts]); }
  // 15. Copilot async/detached shell
  {
    const home = mk({ [CP]: cpFile([
      { type: 'tool.execution_start', data: { toolCallId: 'tc1', toolName: 'bash', arguments: { command: 'npm run dev', description: 'dev server', mode: 'async', detach: true } }, timestamp: iso(20) },
      { type: 'tool.execution_complete', data: { toolCallId: 'tc1', success: true, result: { content: '<command started in background with shellId: 1>' } }, timestamp: iso(19) },
    ]) });
    const r = run(home);
    const bg = (r.resources || []).filter((x) => x.rule === 'bg-process');
    check('P1', 'Copilot bash mode:"async"/detach:true not reported as background process', bg.length === 0, `bg findings=${bg.length}`);
  }
  // 16. Copilot timeout / interrupted create
  {
    const home = mk({ [CP]: cpFile([
      { type: 'tool.execution_start', data: { toolCallId: 'tc1', toolName: 'bash', arguments: { command: 'az aks create -g rg1 -n cp-aks --node-count 3' } }, timestamp: iso(20) },
      { type: 'tool.execution_complete', data: { toolCallId: 'tc1', success: false, result: { content: 'The operation was aborted.' } }, timestamp: iso(19) },
    ]) });
    const r = run(home);
    const f = find(r, 'cp-aks');
    check('P2', 'Copilot aborted create (success:false) is marked failed', !!f && f.status === 'failed', `status=${f && f.status}`);
  }
  // 18. XDG ~/.config/claude/projects
  {
    const home = mk({ ['.config/claude/projects/-p/s.jsonl']: J(claudeLines({ command: 'gcloud compute instances create xdg-vm --zone us-central1-a' })) });
    const r = run(home);
    check('C7', '~/.config/claude/projects (XDG location some installs/tools use) not scanned', !find(r, 'xdg-vm'), `files=${r.files || 0}`);
  }
  // 19. Codex output as content-item array (FunctionCallOutputPayload with content_items)
  {
    const home = mk({ [CDX]: (() => {
      const L = [{ timestamp: iso(40), type: 'session_meta', payload: { id: 'c', cwd: '/x' } },
        { timestamp: iso(30), type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: JSON.stringify({ command: 'gcloud compute instances create arr-vm --zone us-central1-a' }), call_id: 'k1' } },
        { timestamp: iso(29), type: 'response_item', payload: { type: 'function_call_output', call_id: 'k1', output: [{ type: 'input_text', text: 'Exit code: 1\nWall time: 2 seconds\nOutput:\nERROR: (gcloud.compute.instances.create) Could not fetch resource: quota' }] } }];
      return J(L);
    })() });
    const r = run(home);
    const f = find(r, 'arr-vm');
    check('X6', 'Codex output given as content-item array: non-zero exit missed (false "left")', !!f && f.status === 'left', `status=${f && f.status}`);
  }
  // 20. Claude subagent sidechain file (control: should work)
  {
    const home = mk({ [PROJ + 'c-sess-1.jsonl']: J(claudeLines({ command: 'echo main' })), [PROJ + 'c-sess-1/subagents/agent-a1b2.jsonl']: J(claudeLines({ command: 'gcloud compute instances create side-vm --zone us-central1-a' }).map((o) => ({ ...o, isSidechain: true, agentId: 'a1b2' }))) });
    const r = run(home);
    check('C8', 'Claude subagent transcripts under <session>/subagents/ still found (control)', !find(r, 'side-vm'), `side-vm found=${!!find(r, 'side-vm')}`);
  }
  // A timed-out create stays "left", carries the uncertain note, and the text report prints it.
  {
    const home = mk({ [PROJ + 'c-sess-1.jsonl']: J(claudeLines({ command: 'gcloud container clusters create slow-gke --zone us-central1-a', result: 'Exit code 143\nCommand timed out after 2m 0s', isError: true })) });
    t('logs: timed-out create is left with an uncertain note', () => {
      const f = find(run(home), 'slow-gke');
      assert.ok(f && f.status === 'left' && /stopped waiting/.test(f.uncertain || ''), JSON.stringify(f));
    });
    t('logs: text report prints the uncertain note', () => {
      const out = spawnSync(process.execPath, [BIN, '--no-ignore'], { env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', GEMINI_CLI_HOME: '', COPILOT_HOME: '', XDG_CONFIG_HOME: '', NO_COLOR: '1' }, encoding: 'utf8' }).stdout;
      assert.ok(/uncertain: the agent stopped waiting/.test(out), out);
    });
    t('logs: --script prints the uncertain note as a comment', () => {
      const out = spawnSync(process.execPath, [BIN, '--no-ignore', '--script'], { env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', GEMINI_CLI_HOME: '', COPILOT_HOME: '', XDG_CONFIG_HOME: '', NO_COLOR: '1' }, encoding: 'utf8' }).stdout;
      assert.ok(/^# uncertain: /m.test(out), out);
    });
  }
  // A delete that timed out may also have finished: maybe-cleaned, never cleaned.
  t('logs: timed-out delete is maybe-cleaned, not cleaned', () => {
    const { scan } = require('../src/scan');
    const r = scan([
      { kind: 'cmd', command: 'gcloud compute instances create web --zone z', time: '2026-10-01T00:00:00Z', cwd: '/r', session: 's', tool: 'claude' },
      { kind: 'cmd', command: 'gcloud compute instances delete web --zone z --quiet', time: '2026-10-01T00:01:00Z', cwd: '/r', session: 's', tool: 'claude', uncertain: true },
    ]).resources;
    assert.deepStrictEqual(r.map((f) => f.status), ['maybe-cleaned']);
  });
  // run_in_background on "cd x && node server.js" flags the server, not the cd.
  t('logs: background flag applies to the last command of the line', () => {
    const { scan } = require('../src/scan');
    const r = scan([{ kind: 'cmd', command: 'npm install && node server.js', time: '2026-10-01T00:00:00Z', cwd: '/r', session: 's', tool: 'claude', background: true }]).resources;
    assert.deepStrictEqual(r.filter((f) => f.rule === 'bg-process').map((f) => f.name), ['server.js']);
  });
};
