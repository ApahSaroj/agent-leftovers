'use strict';
// Every teardown the tests produced (macOS/Linux form) must parse with `bash -n`, and must be one
// plain command: no '#' comment and no '&&' (those live in teardownHint / runIn since round 2), and
// no command substitution, backtick or expansion that a name from a log could have brought in.
// <NAME>-style placeholders (<NAME>, <ID>, <PID>, <CONTEXT>, <ID from: ...>) are substituted first,
// since they are meant to be filled in by hand.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sq } = require('../src/shell');

const PH = /<[A-Z][A-Z0-9_]*(?:[ :][^<>]*)?>/g;
const fill = (s) => String(s).replace(PH, 'PLACEHOLDER');
// Text outside single quotes (bash never expands inside them).
const unquoted = (s) => s.replace(/'[^']*'/g, "''");

module.exports = function (t, corpus) {
  const uniq = [...new Map(corpus.filter((c) => typeof c.td === 'string' && c.td).map((c) => [`${c.runIn || ''}\u0000${c.td}`, c])).values()];
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  t(`corpus: ${uniq.length} distinct teardowns collected from the tests`, () => assert.ok(uniq.length >= 300, `only ${uniq.length}`));
  if (bash.status !== 0) { t('bash -n (skipped: no bash on this machine)', () => {}); return; }
  const scripts = uniq.map((c) => `${c.runIn ? `cd ${sq(c.runIn)} || exit\n` : ''}${fill(c.td)}`);
  // One bash -n over all of them, each in its own function; if that fails, find the bad ones one by one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-bashn-'));
  const all = path.join(dir, 'all.sh');
  fs.writeFileSync(all, scripts.map((s, i) => `f_${i}() {\n${s}\n}\n`).join(''));
  let bad = [];
  if (spawnSync('bash', ['-n', all], { encoding: 'utf8' }).status !== 0) {
    scripts.forEach((s, i) => { const r = spawnSync('bash', ['-n'], { input: s, encoding: 'utf8' }); if (r.status !== 0) bad.push(`${uniq[i].from}: ${uniq[i].td}  -> ${r.stderr.trim()}`); });
    if (!bad.length) bad = ['bash -n failed on the combined file only'];
  }
  t(`bash -n passes for all ${uniq.length} teardowns (placeholders substituted)`, () => assert.deepStrictEqual(bad, []));
  t('no teardown carries a # comment or && (hint and folder are separate fields)', () => {
    const off = uniq.filter((c) => /&&/.test(unquoted(c.td)) || /(^|\s)#/.test(unquoted(c.td).replace(/"[^"]*"/g, '""'))).map((c) => `${c.from}: ${c.td}`);
    assert.deepStrictEqual(off, []);
  });
  t('no teardown has $( ), backticks, ${ } or a $VAR outside single quotes', () => {
    const off = uniq.filter((c) => /\$[({A-Za-z_]|`/.test(unquoted(fill(c.td)))).map((c) => `${c.from}: ${c.td}`);
    assert.deepStrictEqual(off, []);
  });
  fs.rmSync(dir, { recursive: true, force: true });
};
