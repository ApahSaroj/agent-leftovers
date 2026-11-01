'use strict';
// Tags and labels on the create commands: a session id and an expiry turn
// cleanup into a filter. Reads gcloud --labels, aws --tag-specifications / --tags,
// az --tags, and the same keys on resources found with --sweep.
const { flag } = require('./shell');

const EXPIRY_KEYS = ['expires', 'expiry', 'expires-at', 'expires_at', 'expire', 'expiration', 'expires-on', 'expireson', 'delete-after', 'delete_after', 'deleteafter', 'ttl'];
const SESSION_KEYS = ['session', 'session-id', 'session_id', 'sessionid', 'agent-session', 'agent_session', 'agent-session-id', 'agent_session_id'];

function addPairs(out, text) {
  for (const part of String(text).split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
}

// toks: tokenized simple command; raw: the simple command as written.
function tagsFromCommand(toks, raw) {
  const out = {};
  const cli = toks[0];
  if (cli === 'gcloud') {
    for (const f of ['--labels', '--update-labels']) { const v = flag(toks, [f]); if (v) addPairs(out, v); }
  } else if (cli === 'aws') {
    const s = String(raw || '');
    for (const m of s.matchAll(/Key=([^,}\]\s"']+),Value=([^,}\]\s"']*)/g)) out[m[1].toLowerCase()] = m[2];
    for (const m of s.matchAll(/"Key"\s*:\s*"([^"]+)"\s*,\s*"Value"\s*:\s*"([^"]*)"/g)) out[m[1].toLowerCase()] = m[2];
    if (!Object.keys(out).length) { const v = flag(toks, ['--tags']); if (v && !v.startsWith('{') && !v.startsWith('[')) addPairs(out, v); }
  } else if (cli === 'az') {
    const i = toks.indexOf('--tags');
    if (i >= 0) for (let j = i + 1; j < toks.length && !toks[j].startsWith('-'); j++) addPairs(out, toks[j]);
    for (const t of toks) if (t.startsWith('--tags=')) addPairs(out, t.slice(7));
  } else {
    for (const f of ['--labels', '--label', '--tags', '--tag']) { const v = flag(toks, [f]); if (v && v.includes('=')) addPairs(out, v); }
  }
  return out;
}

const UNIT = { m: 60e3, min: 60e3, mins: 60e3, h: 3600e3, hr: 3600e3, hrs: 3600e3, hour: 3600e3, hours: 3600e3, d: 86400e3, day: 86400e3, days: 86400e3, w: 604800e3, week: 604800e3, weeks: 604800e3 };

// Returns an ISO time, or null when the value can't be read.
function parseExpiry(value, createdIso) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (/^\d{10}$/.test(v)) return new Date(Number(v) * 1000).toISOString();
  if (/^\d{13}$/.test(v)) return new Date(Number(v)).toISOString();
  const d = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[tT_ ](\d{2})[-:](\d{2})(?:[-:](\d{2}))?)?(z|Z)?$/);
  if (d) {
    if (+d[2] < 1 || +d[2] > 12 || +d[3] < 1 || +d[3] > 31 || (d[4] && +d[4] > 23) || (d[5] && +d[5] > 59)) return null;
    const ms = Date.UTC(+d[1], +d[2] - 1, +d[3], d[4] ? +d[4] : 23, d[5] ? +d[5] : 59, d[6] ? +d[6] : d[4] ? 0 : 59);
    if (Number.isNaN(ms) || new Date(ms).getUTCDate() !== +d[3]) return null;
    return new Date(ms).toISOString();
  }
  const r = v.match(/^(\d+)\s*([a-zA-Z]+)$/);
  if (r && UNIT[r[2].toLowerCase()] && createdIso) {
    const base = Date.parse(createdIso);
    if (!Number.isNaN(base)) return new Date(base + Number(r[1]) * UNIT[r[2].toLowerCase()]).toISOString();
  }
  const any = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? Date.parse(v) : NaN;
  return Number.isNaN(any) ? null : new Date(any).toISOString();
}

// Adds tags, session, expires, expired (and expiresRaw when unreadable) to a finding.
function annotate(f, tags, createdIso, nowMs = Date.now()) {
  if (!tags || !Object.keys(tags).length) return f;
  f.tags = tags;
  const sk = SESSION_KEYS.find((k) => tags[k]);
  if (sk) f.sessionTag = tags[sk];
  const ek = EXPIRY_KEYS.find((k) => tags[k] !== undefined);
  if (ek) {
    const at = parseExpiry(tags[ek], createdIso);
    if (at) { f.expires = at; f.expired = Date.parse(at) < nowMs; }
    else f.expiresRaw = tags[ek];
  }
  return f;
}

// --tag key or key=value filters (all must match).
function matchesTags(f, wanted) {
  if (!wanted || !wanted.length) return true;
  const tags = f.tags || {};
  return wanted.every((w) => {
    const i = w.indexOf('=');
    const k = (i < 0 ? w : w.slice(0, i)).toLowerCase();
    return i < 0 ? tags[k] !== undefined : tags[k] === w.slice(i + 1);
  });
}

function ago(iso, nowMs = Date.now()) {
  const ms = Math.abs(nowMs - Date.parse(iso));
  const h = ms / 3600e3;
  const s = h < 1 ? `${Math.max(1, Math.round(ms / 60e3))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`;
  return s;
}

module.exports = { tagsFromCommand, parseExpiry, annotate, matchesTags, ago, EXPIRY_KEYS, SESSION_KEYS };
