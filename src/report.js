'use strict';
const { short } = require('./scan');

function colors(on) {
  const w = (c) => (s) => (on ? `\x1b[${c}m${s}\x1b[0m` : String(s));
  return { bold: w('1'), dim: w('2'), red: w('31'), green: w('32'), yellow: w('33'), cyan: w('36'), mag: w('35') };
}

const COST = { hourly: 'BILLS HOURLY', usage: 'BILLS BY USE', enabler: 'PAID API ON' };
const day = (t) => (t ? String(t).slice(0, 10) : '          ');

function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n - 1) + ' ' : s + ' '.repeat(n - s.length); }

function text(result, opts) {
  const c = colors(opts.color);
  const { resources, spend } = result;
  const left = resources.filter((r) => r.status === 'left');
  const maybe = resources.filter((r) => r.status === 'maybe-cleaned');
  const cleaned = resources.filter((r) => r.status === 'cleaned');
  const failed = resources.filter((r) => r.status === 'failed');
  const L = [];
  const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const mcpPart = result.mcpCalls ? ` and ${pl(result.mcpCalls, 'MCP call')}` : '';
  L.push(c.bold('agent-leftovers') + c.dim(`  read ${pl(result.cmdCount, 'agent command')}${mcpPart} in ${pl(result.sessionCount, 'session')} from the last ${opts.days} days`));
  L.push('');

  const show = (list, head, colour) => {
    if (!list.length) return;
    L.push(colour(c.bold(head)));
    const rank = (r) => (r.gpu ? 0 : r.cost === 'hourly' ? 1 : r.cost === 'usage' ? 2 : 3);
    list.sort((a, b) => rank(a) - rank(b) || String(b.time).localeCompare(String(a.time)));
    for (const r of list) {
      const costTag = r.gpu ? c.red(c.bold(pad('GPU, HOURLY', 13))) : r.cost === 'hourly' ? c.red(pad(COST[r.cost], 13)) : c.yellow(pad(COST[r.cost], 13));
      L.push(`  ${costTag}${pad(r.provider, 10)}${c.bold(pad(r.what, 26))}${pad(short(r.name), 30)}${c.dim(day(r.time))}`);
      const via = r.via === 'mcp' ? `, via MCP: ${r.server}` : '';
      const live = r.live === 'exists' ? c.red('  [checked: still exists]') : r.live === 'unknown' ? c.dim(`  [could not check: ${r.liveNote}]`) : '';
      L.push(c.dim(`      where: ${short(r.cwd) || '?'}  (${r.agent}${via}${r.times > 1 ? `, created ${r.times}x` : ''})`) + live);
      L.push(`      ${c.cyan('turn off:')} ${r.teardown}`);
    }
    L.push('');
  };

  const n = left.length + spend.length;
  if (n === 0 && maybe.length === 0) {
    L.push(c.green(c.bold('Nothing left running that I can see.')));
    L.push('');
  } else {
    show(left, `${left.length} thing${left.length === 1 ? '' : 's'} your agent created and never turned off`, c.red);
    show(maybe, `${maybe.length} the agent may have cleaned up (it ran a delete, but I can't match the exact one)`, c.yellow);
    if (spend.length) {
      L.push(c.mag(c.bold(`${spend.length} script${spend.length === 1 ? '' : 's'} your agent wrote and ran that call${spend.length === 1 ? 's' : ''} a paid AI API with your key`)));
      for (const s of spend) {
        const tags = [s.loop ? 'in a loop' : null, s.background ? 'ran in the background' : null, `ran ${s.ran}x`].filter(Boolean).join(', ');
        L.push(`  ${c.mag(pad(s.api, 24))}${c.bold(pad(short(s.file), 50))}${c.dim(day(s.time))}`);
        L.push(c.dim(`      ${tags}  (${s.agent})`));
        L.push(`      ${c.cyan('check:')} ${s.teardown}`);
      }
      L.push('');
    }
  }
  if (opts.all) {
    show(cleaned, `${cleaned.length} the agent already cleaned up`, c.green);
    show(resources.filter((r) => r.status === 'gone'), `${resources.filter((r) => r.status === 'gone').length} already gone (checked with --verify)`, c.green);
    show(failed, `${failed.length} create commands that failed (probably nothing was made)`, c.dim);
  } else if (cleaned.length || failed.length || resources.some((r) => r.status === 'gone')) {
    const gone = resources.filter((r) => r.status === 'gone').length;
    L.push(c.dim(`  + ${cleaned.length} already cleaned up, ${gone ? `${gone} already gone, ` : ''}${failed.length} failed create${failed.length === 1 ? '' : 's'} hidden. Use --all to see them.`));
    L.push('');
  }
  L.push(c.dim(result.verified ? 'Read-only: only describe/list calls were run, nothing was changed. Check each command before you run it.' : 'Read-only: nothing was run or changed. Check each command before you run it.'));
  if (result.verified) { const v = result.verified; L.push(c.dim(`--verify: ran ${v.checked} read-only check${v.checked === 1 ? '' : 's'}: ${v.exists} still exist, ${v.gone} already gone, ${v.unknown} couldn't be confirmed. ${v.skipped} had no check (no name in the log, or no check for that type yet).`)); }
  else L.push(c.dim('Read from logs only. Add --verify to ask your cloud CLIs which of these still exist.'));
  if (result.k8sLocalSkipped) L.push(c.dim(`Skipped ${result.k8sLocalSkipped} Kubernetes object${result.k8sLocalSkipped === 1 ? '' : 's'} in local clusters (kind, minikube, k3d, Docker Desktop): they cost nothing.`));
  L.push(c.dim('Blind spots: things made in web consoles, by scripts the agent wrote, or by MCP servers we don\'t recognise.'));
  if (left.length) L.push(c.dim('Tip: agent-leftovers --script > teardown.sh  (every command commented out, you choose)'));
  return L.join('\n');
}

function script(result) {
  const L = ['#!/usr/bin/env bash', '# Teardown commands from agent-leftovers.', '# Every line is commented out. Read each one, then remove the leading "# " to run it.', ''];
  for (const r of result.resources.filter((x) => x.status === 'left' || x.status === 'maybe-cleaned')) {
    L.push(`# ${r.what}: ${r.name}  (${r.provider}, created ${day(r.time)} in ${short(r.cwd) || '?'})`);
    L.push(`# ${r.teardown}`);
    L.push('');
  }
  for (const s of result.spend) {
    L.push(`# ${s.api} script: ${short(s.file)}`);
    L.push(`# ${s.teardown}`);
    L.push('');
  }
  return L.join('\n');
}

module.exports = { text, script };
