// Debug Station pure logic: levels, redaction, parsing, detection, fingerprints.
// Isomorphic (no Node imports): the server uses it on ingest, the /debug UI uses it to preview rules.

export const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
export const levelNum = l => Math.max(0, LEVELS.indexOf(l));

// ---------- redaction ----------
// Applied on the server BEFORE an event is stored, streamed or written to disk.
export const DEFAULT_REDACTIONS = [
  { id: 'private-key', name: 'Private keys (PEM)', pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)', flags: 'g', replace: '[REDACTED PRIVATE KEY]' },
  { id: 'conn-string', name: 'Connection-string passwords', pattern: '\\b((?:mongodb(?:\\+srv)?|postgres(?:ql)?|mysql|redis|amqps?)://[^:\\s/@]+):[^@\\s]+@', flags: 'gi', replace: '$1:[REDACTED]@' },
  { id: 'bearer', name: 'Bearer / Basic auth tokens', pattern: '\\b(Bearer|Basic)\\s+[A-Za-z0-9._~+/=-]{8,}', flags: 'g', replace: '$1 [REDACTED]' },
  { id: 'google-key', name: 'Google / Gemini API keys', pattern: '\\bAIza[0-9A-Za-z_-]{35}\\b', flags: 'g', replace: '[REDACTED GOOGLE KEY]' },
  { id: 'jwt', name: 'JSON Web Tokens', pattern: '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}', flags: 'g', replace: '[REDACTED JWT]' },
  { id: 'vendor-keys', name: 'Common vendor keys (AWS, Stripe, GitHub)', pattern: '\\b(?:AKIA[0-9A-Z]{16}|(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{30,})\\b', flags: 'g', replace: '[REDACTED KEY]' },
  { id: 'cookie', name: 'Cookie headers', pattern: '\\b(set-cookie|cookie)(\\s*[:=]\\s*)[^\\n]+', flags: 'gi', replace: '$1$2[REDACTED]' },
  { id: 'session', name: 'PillPal session cookie', pattern: '\\bpp_session=[^;\\s"]+', flags: 'g', replace: 'pp_session=[REDACTED]' },
  { id: 'kv-secret', name: 'password= / token= / api_key= values', pattern: '\\b(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)("?\\s*[:=]\\s*"?)(?!\\[REDACTED)([^"\'\\s&,;}]{3,})', flags: 'gi', replace: '$1$2[REDACTED]' },
  { id: 'email', name: 'Email addresses', pattern: '\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b', flags: 'g', replace: '[email]' },
].map(r => ({ ...r, enabled: true, builtin: true }));

// Metadata keys whose values are always replaced, whatever they contain. Health fields included on purpose:
// PillPal stores mood, notes and chat text, and none of that belongs in a debug log.
export const DEFAULT_REDACT_KEYS = ['password', 'passHash', 'token', 'secret', 'cookie', 'authorization', 'apiKey', 'api_key',
  'x-goog-api-key', 'pp_session', 'notes', 'questions', 'messages', 'image', 'text', 'reply', 'sideEffects', 'mood'];

export function compileRules(rules = []) {
  const out = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    try { out.push({ id: r.id, re: new RegExp(r.pattern, r.flags?.includes('g') ? r.flags : (r.flags || '') + 'g'), replace: r.replace ?? '[REDACTED]' }); }
    catch { /* invalid rules are rejected on save; ignore here */ }
  }
  return out;
}
export function validateRule(r) {
  if (!r || typeof r.pattern !== 'string' || !r.pattern) return 'Pattern is required';
  if (r.pattern.length > 2000) return 'Pattern is too long';
  if (r.flags && !/^[gimsuy]*$/.test(r.flags)) return 'Flags may only contain g i m s u y';
  try { new RegExp(r.pattern, r.flags || ''); } catch (e) { return e.message; }
  if (new RegExp(r.pattern, r.flags || '').test('')) return 'Pattern matches an empty string';
  return null;
}

export function redactString(s, compiled, hits) {
  if (typeof s !== 'string' || !s) return s;
  for (const { id, re, replace } of compiled) {
    re.lastIndex = 0;
    s = s.replace(re, (...m) => {
      if (hits) hits[id] = (hits[id] || 0) + 1;
      // Support $1..$9 in the replacement.
      return replace.replace(/\$(\d)/g, (_, n) => m[+n] ?? '');
    });
  }
  return s;
}

export function redactValue(v, compiled, keySet, hits, depth = 0) {
  if (depth > 6) return '[…]';
  if (typeof v === 'string') return redactString(v.length > 8000 ? v.slice(0, 8000) + '…' : v, compiled, hits);
  if (Array.isArray(v)) return v.slice(0, 100).map(x => redactValue(x, compiled, keySet, hits, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v).slice(0, 80)) {
      if (keySet.has(k.toLowerCase()) && x != null && x !== '') {
        if (hits) hits['key:' + k] = (hits['key:' + k] || 0) + 1;
        o[k] = '[REDACTED]';
      } else o[k] = redactValue(x, compiled, keySet, hits, depth + 1);
    }
    return o;
  }
  return v;
}

// ---------- levels & parsing ----------
const WORD_LEVEL = {
  trace: 'trace', verbose: 'trace', debug: 'debug', dbg: 'debug', d: 'debug', info: 'info', information: 'info', informational: 'info',
  notice: 'info', i: 'info', log: 'info', warn: 'warn', warning: 'warn', w: 'warn', error: 'error', err: 'error', e: 'error',
  critical: 'fatal', crit: 'fatal', fatal: 'fatal', f: 'fatal', panic: 'fatal', emerg: 'fatal', alert: 'fatal',
};
export function normLevel(x) {
  if (x == null || x === '') return null;
  if (typeof x === 'number') {
    if (x >= 10 && x <= 60) return LEVELS[Math.min(5, Math.max(0, Math.round(x / 10) - 1))]; // pino/bunyan
    return ['fatal', 'fatal', 'fatal', 'error', 'warn', 'info', 'info', 'debug'][Math.min(7, Math.max(0, x))]; // syslog / journald
  }
  const s = String(x).trim().toLowerCase();
  if (/^d[1-5]$/.test(s)) return 'debug'; // mongod D1..D5
  if (/^\d$/.test(s)) return normLevel(+s);
  return WORD_LEVEL[s] || null;
}
export function guessLevel(text = '') {
  if (/\b(fatal|panic|crash(ed)?)\b/i.test(text)) return 'fatal';
  if (/\b(error|exception|failed|failure|unhandled|ECONNREFUSED|EADDRINUSE)\b/i.test(text)) return 'error';
  if (/\b(warn(ing)?|deprecat\w*|retry(ing)?|timeout)\b/i.test(text)) return 'warn';
  if (/\b(debug|trace)\b/i.test(text)) return 'debug';
  return 'info';
}

const pick = (o, keys) => { for (const k of keys) if (o[k] != null && o[k] !== '') return [k, o[k]]; return [null, undefined]; };
function parseTime(v) {
  if (v == null) return null;
  if (typeof v === 'object' && v.$date) v = v.$date;
  const n = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

// Turn one raw line into { level, msg, ts, meta }. JSON first, then custom regex parsers, then plain text.
export function parseLine(line, parsers = [], source = '') {
  const raw = String(line).replace(/\r$/, '');
  const t = raw.trim();
  if (t.startsWith('{') && t.endsWith('}')) {
    try { return fromObject(JSON.parse(t)); } catch { /* not JSON */ }
  }
  for (const p of parsers) {
    if (!p.enabled || (p.source && p.source !== '*' && !source.startsWith(p.source))) continue;
    let m;
    try { m = new RegExp(p.pattern, p.flags || '').exec(raw); } catch { continue; }
    if (!m?.groups) continue;
    const { level, msg, message, time, ...rest } = m.groups;
    return { level: normLevel(level) || guessLevel(raw), msg: msg ?? message ?? raw, ts: parseTime(time), meta: { ...rest, parser: p.name } };
  }
  return { level: guessLevel(raw), msg: raw, ts: null, meta: {} };
}
export function fromObject(o) {
  if (!o || typeof o !== 'object') return { level: 'info', msg: String(o), ts: null, meta: {} };
  const [lk, lv] = pick(o, ['level', 'lvl', 'severity', 'levelname', 's', 'PRIORITY', 'LevelDisplayName']);
  const [mk, mv] = pick(o, ['msg', 'message', 'MESSAGE', 'Message', 'text', 'event']);
  const [tk, tv] = pick(o, ['time', 'timestamp', 'ts', '@timestamp', 't', 'date', 'TimeCreated', '__REALTIME_TIMESTAMP']);
  const meta = { ...o };
  for (const k of [lk, mk, tk]) if (k) delete meta[k];
  const msgText = typeof mv === 'string' ? mv : mv != null ? JSON.stringify(mv) : JSON.stringify(o).slice(0, 300);
  let ts = parseTime(tv);
  if (tk === '__REALTIME_TIMESTAMP') ts = Math.round(+tv / 1000);
  return { level: normLevel(lv) || guessLevel(msgText), msg: msgText, ts, meta };
}

// ---------- detection ----------
const STACK = /(\n\s+at\s+\S.*(:\d+:\d+|\(native\)|<anonymous>))|Traceback \(most recent call last\)|\n\s+at [\w$.<>]+ \(/;
const EXC = /\b([A-Z][\w$]*(?:Error|Exception))\b|\b(uncaught|unhandled)\b/i;
export function detect(ev) {
  const f = [];
  const text = `${ev.msg || ''}\n${ev.stack || ''}`;
  if (ev.stack || STACK.test(text)) f.push('stack');
  if (EXC.test(text)) f.push('exception');
  const st = +ev.meta?.status;
  if (st >= 400 || /\b(?:HTTP\/\d(?:\.\d)?"?\s+|status[ =:]+|→ )([45]\d\d)\b/.test(ev.msg || '')) f.push('http-error');
  if (ev.meta?.durationMs > 3000) f.push('slow');
  return f;
}

// Group "the same problem" across occurrences: strip ids, numbers, quoted values.
export function fingerprint(ev) {
  const m = String(ev.msg || '').split('\n')[0]
    .replace(/\b[0-9a-f]{24}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/(["'“]).*?(["'”])/g, '<str>')
    .replace(/\b\d+(\.\d+)?(ms|s|kb|mb|%)?\b/gi, '<n>')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
  return `${ev.source?.split(':')[0]}|${ev.feature || '-'}|${m}`;
}
