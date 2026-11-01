'use strict';
const { short } = require('./scan');
const { money } = require('./cost');
const { ago } = require('./tags');

function colors(on) {
  const w = (c) => (s) => (on ? `\x1b[${c}m${s}\x1b[0m` : String(s));
  return { bold: w('1'), dim: w('2'), red: w('31'), green: w('32'), yellow: w('33'), cyan: w('36'), mag: w('35') };
}

const COST = { hourly: 'BILLS HOURLY', usage: 'BILLS BY USE', enabler: 'PAID API ON', local: 'RUNS LOCALLY' };
const day = (t) => (t ? String(t).slice(0, 10) : '          ');

// Pad to a column; a longer value keeps every character and pushes the row instead.
function pad(s, n) { s = String(s); return s.length >= n ? s + '  ' : s + ' '.repeat(n - s.length); }
const rank = (r) => (r.expired ? -1 : r.gpu ? 0 : r.cost === 'hourly' ? 1 : r.cost === 'usage' ? 2 : r.cost === 'local' ? 3 : 4);

function totals(list) {
  const est = list.filter((r) => r.estimate);
  return { n: est.length, soFar: est.reduce((a, r) => a + r.estimate.soFar, 0), perMonth: est.reduce((a, r) => a + r.estimate.perMonth, 0) };
}

function text(result, opts) {
  const c = colors(opts.color);
  const { resources, spend } = result;
  const by = (s) => resources.filter((r) => r.status === s);
  const left = by('left'); const maybe = by('maybe-cleaned'); const cleaned = by('cleaned'); const failed = by('failed'); const gone = by('gone'); const ignored = by('ignored');
  const L = [];
  const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const mcpPart = result.mcpCalls ? ` and ${pl(result.mcpCalls, 'MCP call')}` : '';
  const agents = result.agents && result.agents.length ? ` (${result.agents.join(', ')})` : '';
  L.push(c.bold('agent-leftovers') + c.dim(`  read ${pl(result.cmdCount, 'agent command')}${mcpPart} in ${pl(result.sessionCount, 'session')}${agents} from the last ${opts.days} days`));
  if (result.filter) L.push(c.dim(`  showing only: ${result.filter}`));
  const exp = left.filter((r) => r.expired).length;
  if (exp) L.push(c.red(c.bold(`  ${exp} of these ${exp === 1 ? 'is' : 'are'} past ${exp === 1 ? 'its' : 'their'} own expiry tag.`)));
  L.push('');

  const show = (list, head, colour) => {
    if (!list.length) return;
    L.push(colour(c.bold(head)));
    list.sort((a, b) => rank(a) - rank(b) || String(b.time).localeCompare(String(a.time)));
    for (const r of list) {
      const tag = r.gpu ? 'GPU, HOURLY' : COST[r.cost] || '';
      const costTag = r.gpu ? c.red(c.bold(pad(tag, 13))) : r.cost === 'hourly' ? c.red(pad(tag, 13)) : r.cost === 'local' ? c.cyan(pad(tag, 13)) : c.yellow(pad(tag, 13));
      L.push(`  ${costTag}${pad(r.provider, 11)}${c.bold(pad(r.what, 28))}${pad(short(r.name), 28)}${c.dim(day(r.time))}`);
      const via = r.via === 'mcp' ? `, via MCP: ${r.server}` : r.viaScript ? `, inside ${r.viaScript}` : '';
      const scope = r.scope ? [r.scope.project && `project ${r.scope.project}`, r.scope.account && `account ${r.scope.account}`, r.scope.configuration && `gcloud config ${r.scope.configuration}`, r.scope.subscription && `subscription ${r.scope.subscription}`, r.scope.profile && `profile ${r.scope.profile}`, r.scope.region && `region ${r.scope.region}`].filter(Boolean).join(', ') : '';
      const live = r.live === 'exists' ? c.red('  [checked: still exists]') : r.live === 'unknown' ? c.dim(`  [could not check: ${r.liveNote}]`) : '';
      L.push(c.dim(`      where: ${short(r.cwd) || '?'}  (${r.agent}${via}${r.times > 1 ? `, created ${r.times}x` : ''}${scope ? `; ${scope}` : ''})`) + live);
      if (r.estimate) L.push(c.yellow(`      cost: ~${money(r.estimate.soFar)} so far, ~${money(r.estimate.perMonth)}/month if left on  (estimate: ${r.estimate.basis} at list price)`));
      const unk = scopeCheck(r);
      if (unk) L.push(c.yellow(`      account: not recorded in the log. Confirm you are in the right one first: ${unk}`));
      if (r.deploy) L.push(c.dim('      note: a deploy often updates something that already existed. Check before you delete.'));
      if (r.stopNote) L.push(c.dim(`      note: ${r.stopNote}`));
      const tl = tagLine(r, c);
      if (tl) L.push(tl);
      if (r.note) L.push(c.yellow(`      note: ${r.note}`));
      L.push(`      ${c.cyan('turn off:')} ${r.teardown}`);
    }
    L.push('');
  };

  const n = left.length + spend.length;
  if (n === 0 && maybe.length === 0) {
    L.push(c.green(c.bold(result.sweep && result.sweep.expired ? 'Nothing left running in your agent logs.' : 'Nothing left running that I can see.')));
    L.push('');
  } else {
    show(left, `${left.length} thing${left.length === 1 ? '' : 's'} your agent created and never turned off`, c.red);
    show(maybe, `${maybe.length} the agent may have cleaned up (it ran a delete or stop, but I can't match the exact one)`, c.yellow);
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
    const t = totals(left);
    if (t.n) { L.push(c.yellow(c.bold(`Estimated so far: ~${money(t.soFar)} across ${pl(t.n, 'item')} (~${money(t.perMonth)}/month if left on). List prices, us regions; your bill may differ.`))); L.push(''); }
  }
  if (opts.all) {
    show(cleaned, `${cleaned.length} the agent already cleaned up`, c.green);
    show(gone, `${gone.length} already gone (checked with --verify)`, c.green);
    show(ignored, `${ignored.length} ignored (in .agent-leftovers-ignore)`, c.dim);
    show(failed, `${failed.length} create commands that failed (probably nothing was made)`, c.dim);
  } else if (cleaned.length || failed.length || gone.length || ignored.length) {
    const parts = [cleaned.length && `${cleaned.length} already cleaned up`, gone.length && `${gone.length} already gone`, ignored.length && `${ignored.length} ignored`, failed.length && pl(failed.length, 'failed create')].filter(Boolean);
    L.push(c.dim(`  + ${parts.join(', ')} hidden. Use --all to see them.`));
    L.push('');
  }
  if (result.sweep) sweepText(result.sweep, L, c);
  L.push(c.dim(result.verified || result.sweep ? 'Read-only: only describe/list calls were run, nothing was changed. Check each command before you run it.' : 'Read-only: nothing was run or changed. Check each command before you run it.'));
  if (result.verified) { const v = result.verified; L.push(c.dim(`--verify: ran ${v.checked} read-only check${v.checked === 1 ? '' : 's'}: ${v.exists} still exist, ${v.gone} already gone, ${v.unknown} couldn't be confirmed. ${v.skipped} had no check (no name in the log, or no check for that type yet).`)); }
  else L.push(c.dim('Read from logs only. Add --verify to ask your cloud CLIs which of these still exist.'));
  if (result.k8sLocalSkipped) L.push(c.dim(`Skipped ${result.k8sLocalSkipped} Kubernetes object${result.k8sLocalSkipped === 1 ? '' : 's'} in local clusters (kind, minikube, k3d, Docker Desktop): they cost nothing.`));
  L.push(c.dim('Blind spots: things made in web consoles, by programs (not shell scripts) the agent wrote, or by MCP servers we don\'t recognise.'));
  if (left.length) L.push(c.dim('Tip: agent-leftovers --script > teardown.sh  (every command commented out, you choose). Meant to keep one? agent-leftovers --baseline'));
  return L.join('\n');
}

// Short form for a Claude Code SessionStart hook or a cron job. Empty when all is clear.
function tagLine(r, c) {
  if (!r.tags) return null;
  const parts = [];
  if (r.sessionTag) parts.push(`session ${r.sessionTag}`);
  if (r.expires) parts.push(r.expired ? c.red(c.bold(`EXPIRED ${ago(r.expires)} ago`)) + c.dim(` (${r.expires.slice(0, 16).replace('T', ' ')} UTC)`) : c.green(`expires in ${ago(r.expires)}`));
  else if (r.expiresRaw) parts.push(c.yellow(`expiry tag "${r.expiresRaw}" (could not read it)`));
  if (!parts.length) return null;
  return `      ${c.dim('tags:')} ${parts.join(c.dim(', '))}`;
}

function sweepText(sw, L, c) {
  const shown = sw.items.filter((i) => i.expired);
  if (shown.length) {
    L.push(c.red(c.bold(`${shown.length} resource${shown.length === 1 ? '' : 's'} in your cloud past ${shown.length === 1 ? 'its' : 'their'} expiry tag (--sweep, may not be in any agent log)`)));
    L.push(c.yellow('  Not necessarily made by your agent: a teammate, a script or the console may own these. Check who owns each one before you delete it.'));
    for (const i of shown.sort((a, b) => String(a.expires).localeCompare(String(b.expires)))) {
      L.push(`  ${c.red(pad('EXPIRED', 13))}${pad(i.provider, 11)}${c.bold(pad(i.what, 28))}${pad(i.name, 28)}${c.dim(i.where || '')}`);
      const tl = tagLine(i, c);
      if (tl) L.push(tl);
      L.push(`      ${c.cyan('turn off:')} ${i.teardown}`);
    }
    L.push('');
  }
  const ok = sw.ran.filter((r) => r.ok);
  const bad = sw.ran.filter((r) => !r.ok);
  L.push(c.dim(`--sweep: ${ok.length ? `listed ${ok.reduce((n, r) => n + r.count, 0)} resources with ${[...new Set(ok.map((r) => r.cli))].join(', ')}; ` : ''}${sw.expired} past expiry, ${sw.notYet} not yet${sw.unreadable ? `, ${sw.unreadable} with an expiry tag I couldn't read` : ''}.${bad.length ? ` Skipped: ${bad.map((b) => b.note).join('; ')}.` : ''}`));
  if (ok.some((r) => r.cli === 'aws')) L.push(c.dim('--sweep: aws lists tagged resources in one region only (your default; set AWS_REGION for another) and has no creation time, so a ttl tag like 4h needs an absolute date there.'));
  if (ok.some((r) => r.cli === 'gcloud' || r.cli === 'az')) L.push(c.dim('--sweep: gcloud reads the active project only; az reads the current subscription only.'));
  L.push('');
}

function brief(result) {
  const left = result.resources.filter((r) => r.status === 'left');
  if (!left.length && !result.spend.length) return '';
  left.sort((a, b) => rank(a) - rank(b) || String(b.time).localeCompare(String(a.time)));
  const t = totals(left);
  const head = `agent-leftovers: ${left.length + result.spend.length} thing${left.length + result.spend.length === 1 ? '' : 's'} from earlier agent sessions may still be running${t.n ? ` (~${money(t.soFar)} so far, estimate)` : ''}:`;
  const lines = left.slice(0, 8).map((r) => `- ${r.what}: ${short(r.name)} (${r.provider}${r.live === 'exists' ? ', checked: still exists' : ''})`);
  if (left.length > 8) lines.push(`- and ${left.length - 8} more`);
  for (const s of result.spend.slice(0, 3)) lines.push(`- ${s.api} script ${short(s.file)}${s.background ? ' (ran in the background)' : ''}`);
  lines.push('Run /agent-leftovers:leftovers (or `npx github:ApahSaroj/agent-leftovers`) for the teardown commands. Mention this to the user; do not delete anything without asking.');
  return [head, ...lines].join('\n');
}

// Every line is commented out, and stays that way even if a name holds a newline:
// the raw script is split on line breaks and each non-comment line gets "# ".
function script(result) {
  return scriptRaw(result).split(/\r\n|\r|\n|\u2028|\u2029/).map((l) => (l === '' || l.startsWith('#') ? l : '# ' + l)).join('\n');
}

function scriptRaw(result) {
  const L = ['#!/usr/bin/env bash', '# Teardown commands from agent-leftovers.', '# Every line is commented out. Read each one, then remove the leading "# " to run it.', ''];
  for (const r of result.resources.filter((x) => x.status === 'left' || x.status === 'maybe-cleaned')) {
    L.push(`# ${r.expired ? 'EXPIRED ' : ''}${r.what}: ${r.name}  (${r.provider}, created ${day(r.time)} in ${short(r.cwd) || '?'}${r.sessionTag ? `, session ${r.sessionTag}` : ''})`);
    if (r.deploy) L.push('# NOTE: this was a deploy; the thing may have existed before the agent. Check first.');
    if (r.note) L.push(`# note: ${r.note}`);
    L.push(`# ${r.teardown}`);
    L.push('');
  }
  if (result.sweep) {
    const exp = result.sweep.items.filter((x) => x.expired);
    if (exp.length) L.push('# Found with --sweep: past their expiry tag, but NOT necessarily made by your agent. Check who owns each one first.', '');
    for (const i of exp) {
      L.push(`# EXPIRED ${i.what}: ${i.name}  (${i.provider}${i.where ? ', ' + i.where : ''}, expired ${i.expires.slice(0, 10)}, found with --sweep)`);
      L.push(`# ${i.teardown}`);
      L.push('');
    }
  }
  for (const s of result.spend) {
    L.push(`# ${s.api} script: ${short(s.file)}`);
    L.push(`# ${s.teardown}`);
    L.push('');
  }
  return L.join('\n');
}


// Cloud CLIs whose teardown depends on the active account. When the log never said
// which account/project the agent used, say how to check before deleting.
function scopeCheck(r) {
  const td = String(r.teardown || '');
  const sc = r.scope || {};
  if (/^\s*gcloud |[;&|]\s*gcloud /.test(td) && !sc.project && !/--project/.test(td)) return 'gcloud config list';
  if (/^\s*aws |[;&|]\s*aws /.test(td) && !sc.profile && !/--profile/.test(td)) return 'aws sts get-caller-identity';
  if (/^\s*az |[;&|]\s*az /.test(td) && !sc.subscription && !/--subscription/.test(td)) return 'az account show';
  return '';
}

module.exports = { text, script, brief };
