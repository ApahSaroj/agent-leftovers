'use strict';
// Claude Code and Codex sessions where the agent used MCP servers instead of the shell.
const fs = require('fs');
const path = require('path');

function iso(minsAgo) { return new Date(Date.now() - minsAgo * 60000).toISOString(); }
const text = (o) => [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }];

function claudeMcp(dir) {
  const cwd = '/home/dev/code/saas';
  const sid = 'claude-mcp-demo';
  const L = [];
  let n = 0;
  let t = 2000;
  const call = (name, input, result, isError = false) => {
    const id = `toolu_m${++n}`;
    t -= 5;
    L.push({ sessionId: sid, cwd, timestamp: iso(t), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    L.push({ sessionId: sid, cwd, timestamp: iso(t - 1), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: isError }] } });
  };
  call('mcp__supabase__list_projects', {}, text([]));
  call('mcp__supabase__create_project', { name: 'saas-staging', organization_id: 'org_1', region: 'us-east-1', confirm_cost_id: 'c1' }, text({ id: 'qwertyref123', name: 'saas-staging', status: 'COMING_UP' }));
  call('mcp__supabase__apply_migration', { project_id: 'qwertyref123', name: 'init', query: 'create table leads(id int)' }, text({ success: true }));
  call('mcp__supabase__deploy_edge_function', { project_id: 'qwertyref123', name: 'send-email', files: [] }, text({ id: 'fn_77', slug: 'send-email', status: 'ACTIVE' }));
  call('mcp__neon__create_branch', { projectId: 'np-1', branchName: 'preview-42' }, text('Branch created: ' + JSON.stringify({ branch: { id: 'br-cool-1', name: 'preview-42' } })));
  call('mcp__neon__delete_branch', { projectId: 'np-1', branchId: 'br-cool-1' }, text({ ok: true }));
  call('mcp__github__create_branch', { owner: 'me', repo: 'saas', branch: 'feature-x' }, text({ ref: 'refs/heads/feature-x' }));
  call('mcp__github__create_issue', { owner: 'me', repo: 'saas', title: 'bug' }, text({ id: 9 }));
  call('mcp__cloudflare__d1_database_create', { name: 'leads-db' }, 'Error: account limit', true);
  call('mcp__vercel__deploy_to_vercel', {}, text('Deployed. ' + JSON.stringify({ id: 'dpl_abc', url: 'saas-git-main.vercel.app' })));
  call('mcp__supabase__create_project', { name: 'saas-prod', organization_id: 'org_1' }, text('Error: free plan project limit reached'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), L.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

function codexMcp(dir) {
  const cwd = '/home/dev/code/scraper';
  const L = [];
  let t = 900;
  L.push({ timestamp: iso(t), type: 'session_meta', payload: { id: 'codex-mcp-demo', cwd } });
  // Codex event_msg form
  t -= 3;
  L.push({ timestamp: iso(t), type: 'event_msg', payload: { type: 'mcp_tool_call_begin', call_id: 'm1', invocation: { server: 'e2b', tool: 'create_sandbox', arguments: { template: 'base' } } } });
  L.push({ timestamp: iso(t - 1), type: 'event_msg', payload: { type: 'mcp_tool_call_end', call_id: 'm1', invocation: { server: 'e2b', tool: 'create_sandbox', arguments: { template: 'base' } }, result: { Ok: { content: text({ sandboxId: 'sbx_99' }) } } } });
  // Codex function_call form (server__tool)
  t -= 3;
  L.push({ timestamp: iso(t), type: 'response_item', payload: { type: 'function_call', name: 'digitalocean__create_droplet', arguments: JSON.stringify({ name: 'scraper-1', size: 's-2vcpu-4gb', region: 'blr1' }), call_id: 'm2' } });
  L.push({ timestamp: iso(t - 1), type: 'response_item', payload: { type: 'function_call_output', call_id: 'm2', output: JSON.stringify({ content: text({ droplet: { id: 4455, name: 'scraper-1' } }) }) } });
  // a failed one
  t -= 3;
  L.push({ timestamp: iso(t), type: 'event_msg', payload: { type: 'mcp_tool_call_end', call_id: 'm3', invocation: { server: 'e2b', tool: 'create_sandbox', arguments: '{"template":"gpu"}' }, result: { Err: 'quota exceeded' } } });
  const d = path.join(dir, '2026', '10', '31');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'rollout-2026-10-31T10-00-00-codex-mcp-demo.jsonl'), L.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

function makeMcp(root) {
  claudeMcp(path.join(root, '.claude', 'projects', '-home-dev-code-saas'));
  codexMcp(path.join(root, '.codex', 'sessions'));
  return root;
}

module.exports = { makeMcp };
