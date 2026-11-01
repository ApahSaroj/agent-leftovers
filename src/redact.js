'use strict';
// Keep secrets out of what we print: the logs often hold keys and passwords that
// were typed into commands. Applied to every command and MCP argument we show.
const SECRET_NAME = /(password|passwd|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credentials?|auth[-_]?key|connection[-_]?string)/i;
const KEY_SHAPES = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, /\bAKIA[0-9A-Z]{16}\b/g, /\bASIA[0-9A-Z]{16}\b/g, /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, /\bAIza[0-9A-Za-z_-]{30,}/g, /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g, /\b(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}/g, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

function redact(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  // FOO_SECRET=value  /  export DB_PASSWORD="x"
  out = out.replace(/\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g, (m, k, v) => (SECRET_NAME.test(k) ? `${k}=***` : m));
  // --db-password x  /  --api-key=x  /  -p is left alone (too many meanings)
  out = out.replace(/(--?[A-Za-z0-9][\w-]*)(=|\s+)("[^"]*"|'[^']*'|[^\s;&|]+)/g, (m, k, sep, v) => (SECRET_NAME.test(k) && !/^-/.test(v) ? `${k}${sep}***` : m));
  // Authorization headers and user:pass@ in URLs
  out = out.replace(/(Authorization:\s*(?:Bearer|Basic|Token)\s+)[^\s"']+/gi, '$1***');
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/g, '$1***');
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1***@');
  for (const re of KEY_SHAPES) out = out.replace(re, '***');
  return out;
}

function redactArgs(obj, depth = 0) {
  if (depth > 4 || obj == null) return obj;
  if (typeof obj === 'string') return redact(obj);
  if (Array.isArray(obj)) return obj.map((v) => redactArgs(v, depth + 1));
  if (typeof obj === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(obj)) o[k] = SECRET_NAME.test(k) && (typeof v === 'string' || typeof v === 'number') ? '***' : redactArgs(v, depth + 1);
    return o;
  }
  return obj;
}

module.exports = { redact, redactArgs };
