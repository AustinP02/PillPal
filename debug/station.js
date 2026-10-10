// Debug Station: PillPal's local debug & log console (server side).
// Collects console output, HTTP requests, outbound calls (openFDA, ClinicalTrials.gov, Gemini), MongoDB commands,
// the embedded mongod's own log, browser telemetry, watched files, HTTP feeds, OS logs and tasks it launches,
// redacts them on ingest, keeps them on disk under .data/debug, and streams them to /debug.
//
// Safety: off in production unless DEBUG_STATION=1; answers only to loopback clients with a localhost Host header;
// state-changing calls need the X-Debug-Station header (blocks cross-site requests); killing processes is off by default.
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import util from 'node:util';
import express from 'express';
import {
  LEVELS, levelNum, DEFAULT_REDACTIONS, DEFAULT_REDACT_KEYS, compileRules, validateRule, redactString, redactValue,
  parseLine, fromObject, detect, fingerprint,
} from './core.js';
import { FEATURES, featureOf, routeOf } from '../public/debug-features.js';
import { listProcesses, statPids } from './processes.js';
import { readOsLogs, osLogLabel } from './oslogs.js';

const CORES = os.availableParallelism?.() || os.cpus().length || 1;
const MIN = 60e3;
const SLOW_MS = id => (id.startsWith('ai.') || id === 'scan.ai' ? 15000 : id === 'trials' || id === 'drug-info' || id === 'scan.ocr' ? 5000 : 1500);
const sha8 = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
const rid = () => crypto.randomBytes(5).toString('hex');
const cleanId = v => (typeof v === 'string' && /^[\w.-]{1,64}$/.test(v) ? v : undefined);

const DEFAULTS = () => ({
  retentionHours: 72,
  maxEvents: 20000,
  redactions: structuredClone(DEFAULT_REDACTIONS.concat([
    { id: 'url-key', name: 'API keys in URLs (?key=)', pattern: '([?&](?:key|apikey|api_key|access_token)=)[^&\\s"]+', flags: 'gi', replace: '$1[REDACTED]', enabled: true, builtin: true },
  ])),
  redactKeys: [...DEFAULT_REDACT_KEYS],
  healthGuard: true,   // hide query values (they can contain medication names) and record ids in URLs
  captureDb: true,     // log every MongoDB command (debug level); slow/failed ones are always logged
  captureStatic: false,
  allowKill: false,
  parsers: [
    { id: 'level-line', name: '"2026-10-10T12:00:00Z ERROR message" lines', pattern: '^\\[?(?<time>\\d{4}-\\d\\d-\\d\\d[T ][\\d:.]+(?:Z|[+-]\\d\\d:?\\d\\d)?)\\]?\\s+\\[?(?<level>TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)\\]?\\s+(?<msg>.*)$', flags: 'i', source: '*', enabled: true },
  ],
  correlationFields: ['traceId', 'requestId', 'sessionId', 'userHash', 'pid', 'feature', 'meta.model'],
  files: [],
  feeds: [],
  osLog: { enabled: false, channel: '', intervalSec: 30 },
});

const noop = () => {};
const disabled = {
  enabled: false, http: (req, res, next) => next(), router: (req, res, next) => next(), mongoOptions: {},
  attachMongo: noop, attachChild: noop, event: noop, note: noop, cacheHit: noop, probe: noop,
};

export async function createStation({ dir, prod }) {
  const flag = (process.env.DEBUG_STATION || '').toLowerCase();
  if (flag === '0' || flag === 'false' || (prod && !['1', 'true'].includes(flag))) return disabled;

  const dataDir = path.join(dir, '.data', 'debug');
  fs.mkdirSync(dataDir, { recursive: true });
  const settingsFile = path.join(dataDir, 'settings.json'), bookmarksFile = path.join(dataDir, 'bookmarks.json');
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

  let settings = { ...DEFAULTS(), ...readJson(settingsFile, {}) };
  let compiled, keySet;
  const compile = () => { compiled = compileRules(settings.redactions); keySet = new Set(settings.redactKeys.map(k => k.toLowerCase())); };
  compile();
  let bookmarks = readJson(bookmarksFile, {});

  const als = new AsyncLocalStorage();
  let seq = 0;
  let ring = [];
  const outbox = [];
  let pending = [];
  const clients = new Set();
  const groups = new Map();      // error fingerprint → summary
  const fstats = new Map();      // feature id → stats
  const sources = new Map();     // source id → { count, last, errors, status, error }
  const volume = new Map();      // minute → counts per level
  const metrics = [];            // { ts, cpu, rss, heap, lag, elu, eps, procs }
  const probes = new Map();
  const procs = new Map();       // tracked app processes: server, mongod, browser tabs, tasks
  let lastEventCount = 0;

  // ---------- event pipeline ----------
  function emit(e, ctx = als.getStore()) {
    const hits = {};
    const ev = {
      id: ++seq,
      ts: Number.isFinite(e.ts) ? e.ts : Date.now(),
      level: LEVELS.includes(e.level) ? e.level : 'info',
      source: e.source || 'server',
      proc: e.proc || 'pillpal-server',
      pid: e.pid === undefined ? process.pid : e.pid,
      feature: e.feature || ctx?.feature,
      kind: e.kind,
      msg: redactString(String(e.msg ?? '').slice(0, 20000), compiled, hits),
      stack: e.stack ? redactString(String(e.stack).slice(0, 20000), compiled, hits) : undefined,
      requestId: e.requestId ?? ctx?.requestId,
      traceId: e.traceId ?? ctx?.traceId,
      sessionId: e.sessionId ?? ctx?.sessionId,
      userHash: e.userHash ?? ctx?.userHash,
      tags: e.tags?.length ? [...new Set(e.tags)] : undefined,
      meta: e.meta && Object.keys(e.meta).length ? redactValue(e.meta, compiled, keySet, hits) : undefined,
    };
    const n = Object.values(hits).reduce((a, b) => a + b, 0);
    if (n) ev.redacted = n;
    ev.flags = detect(ev);
    for (const k of Object.keys(ev)) if (ev[k] === undefined || ev[k] === null && k !== 'pid') delete ev[k];
    index(ev);
    outbox.push(ev);
    pending.push(ev);
    return ev;
  }

  function bump(map, key, init) { let v = map.get(key); if (!v) map.set(key, (v = init())); return v; }

  function index(ev, replay = false) {
    ring.push(ev);
    if (ring.length > settings.maxEvents * 1.1) ring = ring.slice(-settings.maxEvents);
    const minute = Math.floor(ev.ts / MIN) * MIN, lv = levelNum(ev.level);
    bump(volume, minute, () => [0, 0, 0, 0, 0, 0])[lv]++;
    if (volume.size > 1500) volume.delete(volume.keys().next().value);

    const sid = ev.source.split(':')[0] === 'file' || ev.source.startsWith('feed:') || ev.source.startsWith('task:') ? ev.source : ev.source.split(':')[0];
    const src = bump(sources, sid, () => ({ count: 0, errors: 0 }));
    src.count++; src.last = ev.ts; if (lv >= 4) src.errors++;

    if (lv >= 3 || ev.flags?.includes('exception')) {
      const fp = fingerprint(ev);
      const g = bump(groups, fp, () => ({ fp, msg: ev.msg.split('\n')[0].slice(0, 240), level: ev.level, source: ev.source, feature: ev.feature, count: 0, first: ev.ts, recent: [], procs: {}, features: {} }));
      g.count++; g.last = ev.ts; g.lastId = ev.id;
      if (lv > levelNum(g.level)) g.level = ev.level;
      g.recent.push(ev.ts); if (g.recent.length > 60) g.recent.shift();
      g.procs[ev.proc] = (g.procs[ev.proc] || 0) + 1;
      if (ev.feature) g.features[ev.feature] = (g.features[ev.feature] || 0) + 1;
      if (g.recent.filter(t => ev.ts - t < MIN).length >= 3) { g.repeating = true; if (!replay && !ev.flags.includes('repeated')) ev.flags.push('repeated'); }
      if (groups.size > 2000) groups.delete(groups.keys().next().value);
    }

    if (ev.feature && FEATURES[ev.feature]) {
      const f = bump(fstats, ev.feature, () => ({ ops: 0, errors: 0, warns: 0, lat: [], buckets: new Map(), outcomes: {}, deps: {}, tags: {} }));
      const op = ev.kind === 'request' || ev.kind === 'op';
      const isErr = lv >= 4;
      if (op) f.ops++;
      if (isErr) { f.errors++; f.lastError = { msg: ev.msg.split('\n')[0].slice(0, 200), ts: ev.ts, id: ev.id }; }
      else if (lv === 3) f.warns++;
      f.last = ev.ts;
      if (op && ev.meta?.durationMs != null) { f.lat.push(+ev.meta.durationMs); if (f.lat.length > 300) f.lat.shift(); }
      if (ev.meta?.outcome) f.outcomes[ev.meta.outcome] = (f.outcomes[ev.meta.outcome] || 0) + 1;
      if (op) for (const t of ev.tags || []) f.tags[t] = (f.tags[t] || 0) + 1; // request/op events only, so nothing counts twice
      if (ev.kind === 'outbound' && ev.meta?.service) {
        const d = (f.deps[ev.meta.service] ||= { calls: 0, errors: 0, ms: 0, cached: 0 });
        if (ev.meta.cache === 'hit') d.cached++; else { d.calls++; d.ms += +ev.meta.durationMs || 0; if (lv >= 3) d.errors++; }
      }
      const b = bump(f.buckets, minute, () => [0, 0]);
      if (op) b[0]++; if (isErr) b[1]++;
      if (f.buckets.size > 90) f.buckets.delete(f.buckets.keys().next().value);
    }
  }

  const event = e => emit({ kind: 'op', ...e });
  // Merge facts about the current request into its request event (outcome, tags, extra meta).
  function note({ outcome, tags, meta } = {}) {
    const s = als.getStore();
    if (!s) return;
    if (outcome) s.outcome = outcome;
    if (tags) s.tags.push(...tags);
    if (meta) Object.assign(s.meta, meta);
  }

  // ---------- persistence ----------
  const hourFile = ts => path.join(dataDir, `events-${new Date(ts).toISOString().slice(0, 13).replace(/[:T]/g, '-')}.ndjson`);
  function flushSync() {
    if (!pending.length) return;
    const by = new Map();
    for (const ev of pending.splice(0)) bump(by, hourFile(ev.ts), () => []).push(JSON.stringify(ev));
    for (const [f, lines] of by) try { fs.appendFileSync(f, lines.join('\n') + '\n'); } catch { /* disk full etc. */ }
  }
  async function flush() {
    if (!pending.length) return;
    const by = new Map();
    for (const ev of pending.splice(0)) bump(by, hourFile(ev.ts), () => []).push(JSON.stringify(ev));
    for (const [f, lines] of by) await fsp.appendFile(f, lines.join('\n') + '\n').catch(() => {});
  }
  const eventFiles = () => fs.readdirSync(dataDir).filter(f => /^events-[\d-]+\.ndjson$/.test(f)).sort();
  const fileHour = f => Date.parse(f.slice(7, 17) + 'T' + f.slice(18, 20) + ':00:00Z');
  function prune() {
    const cutoff = Date.now() - settings.retentionHours * 3600e3;
    for (const f of eventFiles()) if (fileHour(f) + 3600e3 < cutoff) fs.rmSync(path.join(dataDir, f), { force: true });
    if (ring.length && ring[0].ts < cutoff) ring = ring.filter(e => e.ts >= cutoff);
  }
  function load() {
    prune();
    const files = eventFiles().reverse(), loaded = [];
    for (const f of files) {
      const lines = fs.readFileSync(path.join(dataDir, f), 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && loaded.length < settings.maxEvents; i--) {
        try { loaded.push(JSON.parse(lines[i])); } catch { /* partial line */ }
      }
      if (loaded.length >= settings.maxEvents) break;
    }
    loaded.sort((a, b) => a.id - b.id);
    for (const ev of loaded) index(ev, true);
    seq = loaded.at(-1)?.id || 0;
  }
  load();

  // ---------- console, process warnings, crashes ----------
  let inConsole = false;
  for (const [fn, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error'], ['debug', 'debug'], ['trace', 'trace']]) {
    const orig = console[fn].bind(console);
    console[fn] = (...args) => {
      orig(...args);
      if (inConsole) return;
      inConsole = true;
      try {
        const err = args.find(a => a instanceof Error);
        emit({ source: 'server', kind: 'console', level: err && err.status && err.status < 500 ? 'warn' : level,
          msg: util.format(...args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : a))),
          stack: err?.stack || (fn === 'trace' ? new Error().stack : undefined), meta: err ? { name: err.name, code: err.code, status: err.status } : undefined });
      } finally { inConsole = false; }
    };
  }
  process.on('warning', w => emit({ source: 'server', level: 'warn', feature: 'system', msg: `${w.name}: ${w.message}`, stack: w.stack }));
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    emit({ source: 'server', level: 'fatal', feature: 'system', msg: `${origin === 'unhandledRejection' ? 'Unhandled rejection' : 'Uncaught exception'}: ${err?.message ?? err}`, stack: err?.stack });
    flushSync();
  });
  process.on('exit', flushSync);

  // ---------- tracked app processes ----------
  procs.set('pillpal-server', { key: 'pillpal-server', name: 'PillPal server', kind: 'app', role: 'Node.js · Express API + static files', pid: process.pid, ppid: process.ppid,
    status: 'running', startedAt: Date.now() - process.uptime() * 1000, cmd: redactString(process.argv.join(' '), compiled), logSource: 'server' });

  function pipeLines(stream, onLine) {
    let buf = '';
    stream?.setEncoding?.('utf8');
    stream?.on('data', chunk => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      if (buf.length > 64e3) { lines.push(buf); buf = ''; }
      for (const l of lines) if (l.trim()) onLine(l);
    });
    stream?.on('end', () => { if (buf.trim()) onLine(buf); buf = ''; });
  }

  function ingestLine(line, base, more = []) {
    const p = parseLine(line, settings.parsers, base.source);
    emit({ ...base, level: base.forceLevel || p.level, msg: p.msg, stack: more.length ? [p.msg, ...more].join('\n') : undefined,
      ts: p.ts && Math.abs(p.ts - Date.now()) < 864e5 * 30 ? p.ts : Date.now(), meta: { ...base.meta, ...p.meta } }, null);
  }
  // Joins stack-trace continuation lines ("    at …", "Caused by: …", "  File …" in Python tracebacks) onto the line before,
  // so one exception is one event. Flushes after a short pause so the last event isn't held back.
  const CONT = /^(\s+at\s|\s+\.\.\.\s*\d+ more|Caused by:|\s+File "|\s{4,}\S)/;
  function assembler(base) {
    let head = null, more = [], timer;
    const flush = () => { clearTimeout(timer); if (head != null) ingestLine(head, base, more); head = null; more = []; };
    return line => {
      if (head != null && CONT.test(line) && more.length < 200) more.push(line);
      else { flush(); head = line; }
      clearTimeout(timer); timer = setTimeout(flush, 300);
    };
  }

  // A child process PillPal itself started (the embedded mongod).
  function attachChild(key, child, { name, role } = {}) {
    if (!child?.pid) return;
    const p = { key, name: name || key, kind: 'app', role, pid: child.pid, ppid: process.pid, status: 'running', startedAt: Date.now(),
      cmd: redactString([child.spawnfile, ...(child.spawnargs || []).slice(1)].join(' '), compiled), logSource: key };
    procs.set(key, p);
    const base = { source: key, proc: key, pid: child.pid, feature: 'system' };
    pipeLines(child.stdout, assembler(base));
    pipeLines(child.stderr, assembler({ ...base, forceLevel: 'warn' }));
    child.on('exit', (code, signal) => {
      p.exitCode = code; p.signal = signal; p.endedAt = Date.now();
      p.status = shuttingDown || code === 0 ? 'stopped' : 'crashed';
      emit({ ...base, level: p.status === 'crashed' ? 'fatal' : 'info', msg: `${p.name} exited (${signal || 'code ' + code})${p.status === 'crashed' ? '. PillPal cannot reach its database until it restarts.' : ''}` }, null);
    });
  }
  let shuttingDown = false;
  // server.js owns shutdown (it stops mongod cleanly); here we only mark it so mongod's exit isn't reported as a crash.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { shuttingDown = true; flushSync(); });

  // ---------- MongoDB command monitoring ----------
  const IGNORE = new Set(['hello', 'isMaster', 'ismaster', 'ping', 'endSessions', 'saslStart', 'saslContinue', 'buildInfo', 'getParameter', 'killCursors', 'getMore']);
  const started = new Map();
  function attachMongo(client) {
    const dbProc = () => (procs.get('mongod') ? ['mongod', procs.get('mongod').pid] : ['mongodb', null]);
    client.on('commandStarted', e => {
      if (IGNORE.has(e.commandName) || als.getStore()?.internal) return;
      const coll = typeof e.command?.[e.commandName] === 'string' ? e.command[e.commandName] : undefined;
      started.set(e.requestId, { ctx: als.getStore(), coll });
      if (started.size > 5000) started.delete(started.keys().next().value);
    });
    const done = (e, failed) => {
      const s = started.get(e.requestId);
      if (!s) return;
      started.delete(e.requestId);
      const ms = Math.round(e.duration), r = e.reply || {}, ctx = s.ctx;
      if (ctx) { ctx.db++; ctx.dbMs += ms; }
      const writeErr = r.writeErrors?.[0];
      const slow = ms >= 200;
      if (!failed && !writeErr && !slow && !settings.captureDb) return;
      const [proc, pid] = dbProc();
      emit({
        source: 'db', kind: 'db', proc, pid, feature: ctx?.feature || 'system',
        level: failed ? 'error' : writeErr ? 'warn' : slow ? 'warn' : 'debug',
        msg: failed ? `${e.commandName} ${s.coll || ''} failed: ${e.failure?.message || e.failure}`
          : writeErr ? `${e.commandName} ${s.coll || ''}: ${writeErr.code === 11000 ? 'duplicate key (E11000)' : writeErr.errmsg}`
          : `${e.commandName} ${s.coll || ''} · ${ms}ms`,
        tags: slow ? ['slow-query'] : undefined,
        meta: { command: e.commandName, collection: s.coll, durationMs: ms, n: r.n, nModified: r.nModified, returned: r.cursor?.firstBatch?.length, code: writeErr?.code || e.failure?.code },
        requestId: ctx?.requestId ?? null, traceId: ctx?.traceId ?? null, sessionId: ctx?.sessionId ?? null, userHash: ctx?.userHash ?? null,
      }, null);
    };
    client.on('commandSucceeded', e => done(e, false));
    client.on('commandFailed', e => done(e, true));
    client.on('serverHeartbeatFailed', e => emit({ source: 'db', proc: dbProc()[0], pid: dbProc()[1], feature: 'system', level: 'error', msg: `MongoDB heartbeat failed: ${e.failure?.message || e.failure}` }, null));
    client.on('connectionPoolCleared', () => emit({ source: 'db', proc: dbProc()[0], pid: dbProc()[1], feature: 'system', level: 'warn', msg: 'MongoDB connection pool cleared' }, null));
  }

  // ---------- outbound HTTP (openFDA, ClinicalTrials.gov, Gemini) ----------
  const origFetch = globalThis.fetch;
  const SERVICES = [[/(^|\.)fda\.gov$/, 'openFDA'], [/clinicaltrials\.gov$/, 'ClinicalTrials.gov'], [/generativelanguage\.googleapis\.com$/, 'Gemini']];
  const primaryModel = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const shownUrl = u => settings.healthGuard
    ? routeOf(u.pathname) + (u.search ? `?[${[...new Set(u.searchParams.keys())].join(',')}]` : '')
    : u.pathname + u.search;
  globalThis.fetch = async function debugFetch(input, init = {}) {
    let u;
    try { u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); } catch { return origFetch(input, init); }
    const ctx = als.getStore(), t0 = performance.now(), method = (init.method || input.method || 'GET').toUpperCase();
    if (ctx?.internal) return origFetch(input, init);
    const service = (SERVICES.find(([re]) => re.test(u.hostname)) || [, u.hostname])[1];
    const model = /\/models\/([^/:]+):/.exec(u.pathname)?.[1];
    const attempt = ctx ? (ctx.attempts[service] = (ctx.attempts[service] || 0) + 1) : 1;
    const tags = [];
    if (model && model !== primaryModel) tags.push('fallback-model');
    if (service === 'Gemini' && attempt > 1) tags.push('retry');
    if (ctx) { ctx.out++; if (tags.length) ctx.tags.push(...tags); }
    const base = { source: 'outbound', kind: 'outbound', feature: ctx?.feature || 'system', meta: { service, method, host: u.hostname, path: shownUrl(u), model, attempt: attempt > 1 ? attempt : undefined } };
    try {
      const r = await origFetch(input, init);
      const ms = Math.round(performance.now() - t0);
      if (ctx) ctx.outMs += ms;
      const ok = r.ok || (r.status === 404 && service === 'openFDA'); // openFDA answers 404 for "no match"
      if (ctx && r.status === 429) ctx.tags.push('upstream-429');
      emit({ ...base, level: ok ? 'info' : r.status === 429 || r.status >= 500 ? 'warn' : 'error', tags: [...tags, ...(r.status === 429 ? ['upstream-429'] : [])],
        msg: `${service} ${method} ${base.meta.path} → ${r.status} · ${ms}ms`, meta: { ...base.meta, status: r.status, durationMs: ms } });
      return r;
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      emit({ ...base, level: 'error', tags, msg: `${service} request failed after ${ms}ms: ${err.name === 'TimeoutError' ? 'timed out' : err.cause?.code || err.message}`, meta: { ...base.meta, durationMs: ms, error: err.name } });
      throw err;
    }
  };
  function cacheHit(url) {
    const u = new URL(url);
    const service = (SERVICES.find(([re]) => re.test(u.hostname)) || [, u.hostname])[1];
    const s = als.getStore(); if (s) s.cacheHits++;
    emit({ source: 'outbound', kind: 'outbound', level: 'debug', tags: ['cache-hit'], msg: `${service} cache hit ${shownUrl(u)}`, meta: { service, path: shownUrl(u), cache: 'hit' } });
  }

  // ---------- HTTP request middleware ----------
  function http(req, res, next) {
    if (req.path === '/debug' || req.path.startsWith('/__debug')) return next();
    const feature = featureOf(req.path);
    if (feature === 'static' && !settings.captureStatic) return next();
    const t0 = performance.now();
    const store = {
      requestId: rid(), traceId: cleanId(req.get('x-trace-id')), sessionId: cleanId(req.get('x-client-session')), feature,
      db: 0, dbMs: 0, out: 0, outMs: 0, cacheHits: 0, attempts: {}, tags: [], meta: {}, outcome: undefined,
      get userHash() { return req.userId ? sha8(req.userId) : undefined; },
    };
    store.traceId ||= store.requestId;
    res.setHeader('X-Request-Id', store.requestId);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const ms = Math.round(performance.now() - t0), status = res.headersSent ? res.statusCode : 0;
      const aborted = !res.writableFinished;
      const expected401 = status === 401 && req.path === '/api/me' && req.method === 'GET'; // signed-out boot check
      const level = feature === 'static' ? (status >= 400 ? 'warn' : 'trace')
        : aborted ? 'warn' : status >= 500 ? 'error' : status >= 400 && !expected401 ? 'warn' : 'info';
      const route = settings.healthGuard ? routeOf(req.path) : req.originalUrl.split('?')[0];
      const err = res.locals.debugError;
      emit({
        source: 'http', kind: 'request', level, tags: [...new Set(store.tags)].concat(status === 429 ? ['rate-limited'] : [], aborted ? ['aborted'] : []),
        msg: `${req.method} ${route} → ${aborted ? 'aborted' : status} · ${ms}ms${err ? ` · ${err}` : ''}`,
        meta: {
          method: req.method, route, status, durationMs: ms, outcome: store.outcome || (status >= 500 ? 'fail' : undefined),
          db: store.db || undefined, dbMs: store.db ? store.dbMs : undefined, outbound: store.out || undefined, outMs: store.out ? store.outMs : undefined,
          cacheHits: store.cacheHits || undefined, bytes: +res.get('content-length') || undefined,
          query: Object.keys(req.query || {}).length ? (settings.healthGuard ? Object.keys(req.query) : req.query) : undefined,
          body: req.body && typeof req.body === 'object' && Object.keys(req.body).length ? Object.keys(req.body) : undefined, // keys only, never values
          ...store.meta,
        },
      }, store);
    };
    res.on('finish', finish);
    res.on('close', finish);
    als.run(store, next);
  }

  // ---------- launched tasks (npm scripts) ----------
  const tasks = new Map();
  function loadTasks() {
    const pkg = readJson(path.join(dir, 'package.json'), {});
    for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
      if (!/^[\w:.-]+$/.test(name) || /^(start|dev|serve)$/.test(name)) continue; // a second server would fight for the port
      if (!tasks.has(name)) tasks.set(name, { name, cmd: `npm run ${name}`, script: cmd });
    }
  }
  loadTasks();
  function runTask(name) {
    const t = tasks.get(name);
    if (!t) throw Object.assign(new Error('Unknown task'), { status: 404 });
    if (t.child) throw Object.assign(new Error('Task is already running'), { status: 409 });
    const win = process.platform === 'win32';
    const opts = { cwd: dir, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0' } };
    // Windows needs a shell for npm.cmd; the script name was validated against package.json and /^[\w:.-]+$/.
    const child = win ? spawn(`npm run ${name}`, { ...opts, shell: true }) : spawn('npm', ['run', name], opts);
    t.child = child;
    const key = 'task:' + name;
    const p = { key, name: `npm run ${name}`, kind: 'task', role: `Launched by Debug Station · ${t.script}`, pid: child.pid, ppid: process.pid,
      status: 'running', startedAt: Date.now(), cmd: `npm run ${name}`, restartable: true, logSource: key };
    procs.set(key, p);
    const base = { source: key, proc: key, pid: child.pid, feature: 'system' };
    emit({ ...base, level: 'info', msg: `Started npm run ${name} (pid ${child.pid})` }, null);
    pipeLines(child.stdout, assembler(base));
    const errOut = assembler({ ...base, forceLevel: 'error' }), warnOut = assembler({ ...base, forceLevel: 'warn' });
    pipeLines(child.stderr, l => (/warn/i.test(l) ? warnOut : errOut)(l));
    child.on('error', err => { p.status = 'crashed'; emit({ ...base, level: 'error', msg: `Could not start npm run ${name}: ${err.message}` }, null); t.child = null; });
    child.on('exit', (code, signal) => {
      t.child = null; p.exitCode = code; p.signal = signal; p.endedAt = Date.now();
      p.status = p.stopping || code === 0 ? 'stopped' : 'crashed';
      emit({ ...base, level: p.status === 'crashed' ? 'error' : 'info', msg: `npm run ${name} ${p.stopping ? 'stopped' : `exited with ${signal || 'code ' + code}`} after ${((p.endedAt - p.startedAt) / 1000).toFixed(1)}s` }, null);
    });
    return p;
  }
  function stopTask(name) {
    const t = tasks.get(name);
    if (!t?.child) return;
    procs.get('task:' + name).stopping = true;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(t.child.pid), '/T', '/F'], { windowsHide: true });
    else t.child.kill('SIGTERM');
  }

  // ---------- watched files ----------
  const watchers = new Map();
  // Remember how far each file was read, so a server restart resumes instead of re-reading the tail.
  const offsetsFile = path.join(dataDir, 'file-offsets.json');
  const offsets = readJson(offsetsFile, {});
  const saveOffsets = (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => fs.writeFile(offsetsFile, JSON.stringify(offsets), () => {}), 1000); }; })();
  function startWatch(f) {
    const abs = path.resolve(dir, f.path);
    const w = { path: abs, offset: 0, status: 'starting', error: null, lines: 0 };
    watchers.set(f.path, w);
    const src = 'file:' + path.basename(abs);
    const base = { source: src, proc: path.basename(abs), pid: null, meta: { file: abs } };
    const feed = assembler(base);
    const read = (from, to) => {
      if (to <= from) return;
      const len = Math.min(to - from, 1 << 20), buf = Buffer.alloc(len);
      let fd;
      try { fd = fs.openSync(abs, 'r'); fs.readSync(fd, buf, 0, len, from); } finally { if (fd != null) fs.closeSync(fd); }
      w.offset = from + len;
      const text = buf.toString('utf8');
      const lines = text.split(/\r?\n/);
      if (w.offset < to || !text.endsWith('\n')) { const last = lines.pop(); w.offset -= Buffer.byteLength(last); }
      offsets[abs] = w.offset; saveOffsets();
      for (const l of lines) if (l.trim()) { feed(l); w.lines++; }
    };
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) throw new Error('Not a file');
      // Resume where we left off; otherwise start with the last ~32 KB so there is context, then follow.
      const saved = offsets[abs];
      w.offset = saved != null && saved <= st.size ? saved : Math.max(0, st.size - 32768);
      if (w.offset && w.offset !== saved) { const head = Buffer.alloc(Math.min(512, st.size - w.offset)); const fd = fs.openSync(abs, 'r'); fs.readSync(fd, head, 0, head.length, w.offset); fs.closeSync(fd); w.offset += head.indexOf(10) + 1; }
      read(w.offset, st.size);
      w.status = 'watching';
    } catch (e) { w.status = 'error'; w.error = e.code === 'ENOENT' ? 'File not found' : e.code === 'EACCES' || e.code === 'EPERM' ? 'Permission denied' : e.message; return; }
    w.listener = (cur) => {
      try {
        if (cur.size < w.offset) { w.offset = 0; emit({ ...base, level: 'info', msg: `${path.basename(abs)} was truncated or rotated; reading from the start` }, null); }
        read(w.offset, cur.size);
        w.status = 'watching'; w.error = null;
      } catch (e) { w.status = 'error'; w.error = e.message; }
    };
    fs.watchFile(abs, { interval: 1000 }, w.listener);
  }

  // ---------- HTTP log feeds ----------
  const feeds = new Map();
  function startFeed(f) {
    const st = { ...f, status: 'starting', error: null, seen: new Set(), polls: 0 };
    feeds.set(f.url, st);
    const src = 'feed:' + f.name;
    const poll = async () => {
      try {
        const r = await origFetch(f.url, { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json, text/plain' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();
        let items;
        const t = text.trim();
        if (t.startsWith('[') || t.startsWith('{"logs"') || t.startsWith('{"events"') || t.startsWith('{"entries"')) {
          try { const j = JSON.parse(t); items = Array.isArray(j) ? j : j.logs || j.events || j.entries || [j]; } catch { items = t.split('\n'); }
        } else items = t.split('\n');
        const first = st.polls++ === 0;
        items = items.slice(-2000);
        items.forEach((it, i) => {
          const key = typeof it === 'string' ? it : JSON.stringify(it);
          if (!key.trim() || st.seen.has(key)) return;
          st.seen.add(key);
          if (first && i < items.length - 200) return; // first poll: remember everything, show only the tail
          const p = typeof it === 'string' ? parseLine(it, settings.parsers, src) : fromObject(it);
          emit({ source: src, proc: f.name, pid: null, level: p.level, msg: p.msg, ts: p.ts || Date.now(), meta: { ...p.meta, feed: f.name } }, null);
        });
        if (st.seen.size > 6000) st.seen = new Set([...st.seen].slice(-3000));
        if (st.status === 'error') emit({ source: src, proc: f.name, pid: null, level: 'info', msg: `Feed ${f.name} recovered` }, null);
        st.status = 'polling'; st.error = null; st.last = Date.now();
      } catch (e) {
        const msg = e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || e.message;
        if (st.error !== msg) emit({ source: src, proc: f.name, pid: null, level: 'warn', msg: `Feed ${f.name} failed: ${msg}` }, null);
        st.status = 'error'; st.error = msg;
      }
    };
    poll();
    st.timer = setInterval(poll, Math.max(5, +f.intervalSec || 15) * 1000);
  }

  // ---------- OS logs ----------
  const osState = { status: 'off', error: null, last: null };
  let osTimer, osSince = Date.now() - 5 * MIN;
  function startOs() {
    clearInterval(osTimer);
    if (!settings.osLog.enabled) { osState.status = 'off'; return; }
    const poll = async () => {
      try {
        const items = await readOsLogs({ since: osSince, channel: settings.osLog.channel });
        for (const it of items.sort((a, b) => a.ts - b.ts)) {
          if (it.ts < osSince) continue;
          emit({ source: 'os', proc: it.meta.process || it.meta.provider || it.meta.unit || 'system', pid: it.meta.pid ?? null, level: it.level, msg: it.msg, ts: it.ts, meta: it.meta }, null);
          osSince = Math.max(osSince, it.ts + 1);
        }
        osState.status = 'polling'; osState.error = null; osState.last = Date.now();
      } catch (e) {
        if (osState.error !== e.message) emit({ source: 'os', proc: 'system', pid: null, level: 'warn', msg: `${osLogLabel()} unavailable: ${e.message}` }, null);
        osState.status = 'error'; osState.error = e.message;
      }
    };
    poll();
    osTimer = setInterval(poll, Math.max(10, +settings.osLog.intervalSec || 30) * 1000);
  }

  // Only (re)start what changed, so adding one source doesn't re-read files that are already being followed.
  function applySources() {
    const wantFiles = new Set(settings.files.filter(f => f.enabled !== false).map(f => f.path));
    for (const [p, w] of watchers) if (!wantFiles.has(p)) { if (w.listener) fs.unwatchFile(w.path, w.listener); watchers.delete(p); }
    for (const f of settings.files) if (f.enabled !== false && !watchers.has(f.path)) startWatch(f);
    const feedKey = f => `${f.name}|${f.url}|${f.intervalSec}`;
    const wantFeeds = new Map(settings.feeds.filter(f => f.enabled !== false).map(f => [f.url, f]));
    for (const [u, f] of feeds) if (!wantFeeds.has(u) || feedKey(wantFeeds.get(u)) !== feedKey(f)) { clearInterval(f.timer); feeds.delete(u); }
    for (const [u, f] of wantFeeds) if (!feeds.has(u)) startFeed(f);
    const osKey = JSON.stringify(settings.osLog);
    if (osKey !== lastOsKey) { lastOsKey = osKey; startOs(); }
  }
  let lastOsKey = '';
  applySources();

  // ---------- metrics ----------
  const eld = monitorEventLoopDelay({ resolution: 20 });
  eld.enable();
  let lastCpu = process.cpuUsage(), lastT = performance.now(), lastElu = performance.eventLoopUtilization(), childStats = {}, statTick = 0;
  setInterval(async () => {
    const now = performance.now(), cpu = process.cpuUsage(lastCpu), elu = performance.eventLoopUtilization(lastElu);
    const pct = ((cpu.user + cpu.system) / ((now - lastT) * 1000)) * 100 / CORES;
    lastCpu = process.cpuUsage(); lastT = now; lastElu = performance.eventLoopUtilization();
    const m = process.memoryUsage();
    const eps = (seq - lastEventCount) / 2; lastEventCount = seq;
    // Child process stats cost a process spawn on Windows; only sample while someone is watching.
    if (clients.size && statTick++ % 3 === 0) {
      const live = [...procs.values()].filter(p => p.kind !== 'browser' && p.pid !== process.pid && p.status === 'running');
      statPids(live.map(p => p.pid)).then(s => { childStats = Object.fromEntries(live.filter(p => s[p.pid]).map(p => [p.key, s[p.pid]])); }).catch(() => {});
    }
    const point = { ts: Date.now(), cpu: +pct.toFixed(1), rss: m.rss, heap: m.heapUsed, lag: +(eld.percentile(99) / 1e6).toFixed(1), elu: +(elu.utilization * 100).toFixed(1), eps, procs: childStats };
    eld.reset();
    metrics.push(point);
    if (metrics.length > 1800) metrics.shift();
    if (clients.size) broadcast('metrics', point);
  }, 2000).unref();

  // ---------- summaries ----------
  function featureSummary() {
    const now = Date.now(), m0 = Math.floor(now / MIN) * MIN;
    return Object.entries(FEATURES).map(([id, def]) => {
      const f = fstats.get(id);
      if (!f) return { id, ...def, status: 'idle', ops: 0, errors: 0, warns: 0, series: [] };
      const lat = [...f.lat].sort((a, b) => a - b), q = p => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null);
      const series = Array.from({ length: 30 }, (_, i) => f.buckets.get(m0 - (29 - i) * MIN) || [0, 0]);
      const last5 = series.slice(-5).reduce((a, [o, e]) => [a[0] + o, a[1] + e], [0, 0]);
      const p95 = q(0.95);
      const status = last5[1] && last5[1] / Math.max(1, last5[0]) >= 0.25 ? 'failing'
        : last5[1] || (p95 != null && p95 > SLOW_MS(id) && now - f.last < 15 * MIN) ? 'degraded'
        : f.last && now - f.last > 30 * MIN && !f.ops ? 'idle' : 'healthy';
      return { id, ...def, status, ops: f.ops, errors: f.errors, warns: f.warns, p50: q(0.5), p95, last: f.last, lastError: f.lastError,
        outcomes: f.outcomes, deps: f.deps, tags: f.tags, series, slowMs: SLOW_MS(id) };
    });
  }
  function errorSummary() {
    const now = Date.now();
    return [...groups.values()].sort((a, b) => b.last - a.last).slice(0, 150).map(g => ({
      fp: g.fp, msg: g.msg, level: g.level, source: g.source, feature: g.feature, count: g.count, first: g.first, last: g.last, lastId: g.lastId,
      perMin: +(g.count / Math.max(1, (g.last - g.first) / MIN)).toFixed(2), last5m: g.recent.filter(t => now - t < 5 * MIN).length,
      repeating: g.repeating && g.recent.filter(t => now - t < 5 * MIN).length >= 3, procs: g.procs, features: g.features,
    }));
  }
  function sourceSummary() {
    const s = id => sources.get(id) || { count: 0, errors: 0 };
    const out = [
      { id: 'server', label: 'PillPal server console', kind: 'stdout/stderr', status: 'live', ...s('server') },
      { id: 'http', label: 'HTTP requests', kind: 'middleware', status: 'live', ...s('http') },
      { id: 'outbound', label: 'Outbound calls (openFDA, ClinicalTrials.gov, Gemini)', kind: 'fetch', status: 'live', ...s('outbound') },
      { id: 'db', label: 'MongoDB commands', kind: 'driver monitoring', status: settings.captureDb ? 'live' : 'slow & failed only', ...s('db') },
      ...(procs.has('mongod') ? [{ id: 'mongod', label: 'Embedded mongod log', kind: 'child stdout (JSON)', status: procs.get('mongod').status === 'running' ? 'live' : procs.get('mongod').status, ...s('mongod') }] : []),
      { id: 'client', label: 'Browser telemetry (PillPal tabs)', kind: 'beacon', status: [...procs.values()].some(p => p.kind === 'browser' && p.status === 'running') ? 'live' : 'waiting', ...s('client') },
      { id: 'os', label: osLogLabel(), kind: 'OS log', status: osState.status, error: osState.error, ...s('os') },
    ];
    for (const [name] of tasks) out.push({ id: 'task:' + name, label: `npm run ${name}`, kind: 'launched task', status: procs.get('task:' + name)?.status || 'idle', ...s('task:' + name) });
    for (const [p, w] of watchers) out.push({ id: 'file:' + path.basename(w.path), label: p, kind: 'watched file', status: w.status, error: w.error, ...s('file:' + path.basename(w.path)) });
    for (const f of feeds.values()) out.push({ id: 'feed:' + f.name, label: `${f.name} (${f.url})`, kind: 'HTTP feed', status: f.status, error: f.error, ...s('feed:' + f.name) });
    return out;
  }
  const summary = () => {
    const now = Date.now(), m0 = Math.floor(now / MIN) * MIN;
    return {
      features: featureSummary(), errors: errorSummary(), sources: sourceSummary(),
      volume: Array.from({ length: 60 }, (_, i) => ({ t: m0 - (59 - i) * MIN, c: volume.get(m0 - (59 - i) * MIN) || [0, 0, 0, 0, 0, 0] })),
      totals: { events: ring.length, seq, retentionHours: settings.retentionHours, clients: clients.size },
    };
  };

  // ---------- SSE ----------
  function broadcast(type, data) {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  }
  setInterval(() => { if (outbox.length) { const batch = outbox.splice(0); if (clients.size) broadcast('logs', batch); } }, 300).unref();
  setInterval(() => { if (clients.size) broadcast('summary', summary()); }, 3000).unref();
  setInterval(() => { flush(); }, 1000).unref();
  setInterval(() => { prune(); for (const p of procs.values()) if (p.kind === 'browser' && p.status === 'running' && Date.now() - p.lastSeen > 75e3) p.status = 'stopped'; }, 30e3).unref();

  // ---------- processes ----------
  let sysCache = { at: 0, list: null, error: null }, sysPending = null;
  async function systemProcesses() {
    if (Date.now() - sysCache.at < 4000) return sysCache; // listing all processes costs a PowerShell spawn on Windows
    sysPending ||= listProcesses().then(list => (sysCache = { at: Date.now(), list, error: null }))
      .catch(e => (sysCache = { at: Date.now(), list: null, error: e.code === 'ENOENT' ? 'Process listing tool not found on this system' : e.message }))
      .finally(() => { sysPending = null; });
    return sysPending;
  }
  function appProcesses() {
    const now = Date.now();
    const last = metrics.at(-1);
    return [...procs.values()].map(p => {
      const live = p.key === 'pillpal-server' ? { cpu: last?.cpu ?? null, mem: process.memoryUsage().rss } : childStats[p.key] || {};
      const errs = ring.reduce((a, e) => a + (e.proc === p.key || (p.key === 'pillpal-server' && e.pid === process.pid) ? (levelNum(e.level) >= 4 ? 1 : 0) : 0), 0);
      return { ...p, cpu: p.status === 'running' ? live.cpu ?? null : null, mem: p.status === 'running' ? live.mem ?? p.mem ?? null : null,
        uptime: p.status === 'running' ? now - p.startedAt : (p.endedAt || now) - p.startedAt, errors: errs };
    });
  }

  // ---------- routes ----------
  const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
  const router = express.Router();
  const json = express.json({ limit: '512kb' });
  const fail = (res, status, error) => res.status(status).json({ error });

  router.use(['/debug', '/__debug'], (req, res, next) => {
    if (!LOOPBACK.has(req.socket.remoteAddress)) return res.status(404).end();
    const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!LOCAL_HOSTS.has(host)) return fail(res, 403, 'Debug Station only answers on localhost');
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.get('x-debug-station') !== '1') return fail(res, 403, 'Missing X-Debug-Station header');
      const o = req.get('origin');
      if (o) { try { if (new URL(o).host !== req.headers.host) return fail(res, 403, 'Cross-origin request blocked'); } catch { return fail(res, 403, 'Bad origin'); } }
    }
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    next();
  });
  const ui = path.join(import.meta.dirname, 'ui');
  router.get('/debug', (req, res) => res.sendFile(path.join(ui, 'index.html')));
  router.get('/__debug/lib/core.js', (req, res) => res.type('js').sendFile(path.join(import.meta.dirname, 'core.js')));
  router.use('/__debug/ui', express.static(ui, { maxAge: 0 }));

  const api = express.Router();
  router.use('/__debug/api', api);
  api.get('/hello', (req, res) => res.json({ ok: true }));

  api.get('/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ seq })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  });
  api.get('/events', (req, res) => {
    const since = +req.query.since || 0, limit = Math.min(+req.query.limit || 5000, settings.maxEvents);
    const list = since ? ring.filter(e => e.id > since) : ring;
    res.json(list.slice(-limit));
  });
  api.get('/events/:id', (req, res) => { const e = ring.find(x => x.id === +req.params.id); e ? res.json(e) : fail(res, 404, 'Event is no longer in memory'); });
  api.get('/summary', (req, res) => res.json(summary()));
  api.get('/metrics', (req, res) => res.json(metrics));

  api.get('/runtime', async (req, res) => {
    const out = {};
    await Promise.all([...probes].map(async ([name, fn]) => {
      try { out[name] = redactValue(await Promise.race([als.run({ internal: true, tags: [], attempts: {}, meta: {} }, fn), new Promise((_, no) => setTimeout(() => no(new Error('probe timed out')), 3000))]), compiled, keySet); }
      catch (e) { out[name] = { error: e.message }; }
    }));
    res.json({
      node: process.version, platform: `${os.type()} ${os.release()} (${process.arch})`, pid: process.pid, ppid: process.ppid, cores: CORES,
      uptimeSec: Math.round(process.uptime()), cwd: dir, dataDir, memory: process.memoryUsage(), probes: out,
      debug: { retentionHours: settings.retentionHours, maxEvents: settings.maxEvents, inMemory: ring.length, onDisk: eventFiles().reduce((a, f) => a + fs.statSync(path.join(dataDir, f)).size, 0) },
    });
  });

  api.get('/processes', async (req, res) => {
    const sys = req.query.all === '1' ? await systemProcesses() : null;
    const tracked = new Map([...procs.values()].filter(p => p.status === 'running' && p.pid).map(p => [p.pid, p.key]));
    res.json({
      app: appProcesses(), canKill: settings.allowKill, platform: process.platform,
      system: sys?.list?.map(p => ({ ...p, cmd: p.cmd ? redactString(p.cmd, compiled) : null, app: tracked.get(p.pid) || (p.ppid === process.pid ? 'child' : undefined) })) ?? null,
      systemError: sys?.error ?? null,
      tasks: [...tasks.values()].map(t => ({ name: t.name, cmd: t.cmd, script: t.script, running: !!t.child })),
    });
  });
  api.post('/processes/kill', json, async (req, res) => {
    const pid = +req.body.pid;
    if (!settings.allowKill) return fail(res, 403, 'Ending processes is turned off. Turn it on under Privacy & rules → Safety.');
    if (!Number.isInteger(pid) || pid <= 4) return fail(res, 400, 'Invalid PID');
    if (pid === process.pid) return fail(res, 400, 'Debug Station will not end the PillPal server it runs in. Stop it from your terminal.');
    if (procs.get('mongod')?.pid === pid && procs.get('mongod').status === 'running') return fail(res, 400, 'Ending the embedded MongoDB would break PillPal. Stop the server instead.');
    sysCache.at = 0;
    const p = (await systemProcesses()).list?.find(x => x.pid === pid);
    if (!p) return fail(res, 404, 'That process is no longer running');
    if (req.body.confirm !== p.name) return fail(res, 400, `Type the process name (${p.name}) to confirm`);
    try {
      process.kill(pid);
      emit({ source: 'server', feature: 'system', level: 'warn', tags: ['audit'], msg: `Process ${p.name} (pid ${pid}) ended from Debug Station` });
      res.json({ ok: true });
    } catch (e) { fail(res, e.code === 'EPERM' ? 403 : 500, e.code === 'EPERM' ? 'Permission denied. Debug Station does not elevate.' : e.message); }
  });
  api.post('/tasks/:name/:op', json, (req, res) => {
    const { name, op } = req.params;
    try {
      if (op === 'run') runTask(name);
      else if (op === 'stop') stopTask(name);
      else if (op === 'restart') {
        const t = tasks.get(name);
        if (t?.child) { stopTask(name); t.child.once('exit', () => setTimeout(() => { try { runTask(name); } catch { /* raced */ } }, 200)); }
        else runTask(name);
      } else return fail(res, 404, 'Unknown action');
      res.json({ ok: true });
    } catch (e) { fail(res, e.status || 500, e.message); }
  });

  // Browser telemetry from PillPal tabs (public/debug-client.js).
  api.post('/client', json, (req, res) => {
    const b = req.body || {};
    const sessionId = cleanId(b.sessionId);
    if (!sessionId) return fail(res, 400, 'sessionId required');
    const key = 'browser:' + sessionId;
    const p = procs.get(key) || { key, name: 'PillPal tab', kind: 'browser', pid: null, ppid: null, startedAt: Date.now(), logSource: 'client', sessionId };
    p.lastSeen = Date.now(); p.status = 'running';
    if (typeof b.ua === 'string') p.role = b.ua.slice(0, 120);
    procs.set(key, p);
    if (procs.size > 300) for (const [k, v] of procs) if (v.kind === 'browser' && v.status !== 'running') { procs.delete(k); break; }
    for (const e of (Array.isArray(b.events) ? b.events : []).slice(0, 200)) {
      if (e.kind === 'heartbeat') { Object.assign(p, { page: String(e.meta?.page || '').slice(0, 40), mem: +e.meta?.heap || null, visible: !!e.meta?.visible }); continue; }
      if (e.kind === 'pagehide') { p.status = 'stopped'; p.endedAt = Date.now(); continue; }
      const now = Date.now(), ts = +e.ts;
      emit({
        source: 'client', proc: 'browser', pid: null, sessionId, traceId: cleanId(e.traceId) ?? null, requestId: null, userHash: null,
        feature: FEATURES[e.feature] ? e.feature : 'ui', kind: ['op', 'client-api', 'page'].includes(e.kind) ? e.kind : 'op',
        level: LEVELS.includes(e.level) ? e.level : 'info', ts: Math.abs(ts - now) < 864e5 ? ts : now,
        msg: String(e.msg || '').slice(0, 2000), stack: typeof e.stack === 'string' ? e.stack.slice(0, 8000) : undefined,
        tags: Array.isArray(e.tags) ? e.tags.filter(t => typeof t === 'string').slice(0, 8).map(t => t.slice(0, 30)) : undefined,
        meta: e.meta && typeof e.meta === 'object' ? e.meta : undefined,
      }, null);
    }
    res.json({ ok: true });
  });

  // Settings: redaction & parser rules, retention, sources, safety.
  const publicSettings = () => ({ ...settings, platform: process.platform, osLogLabel: osLogLabel(), defaults: { redactions: DEFAULTS().redactions, redactKeys: DEFAULTS().redactKeys, parsers: DEFAULTS().parsers } });
  api.get('/settings', (req, res) => res.json(publicSettings()));
  api.put('/settings', json, (req, res) => {
    const b = req.body || {}, next = structuredClone(settings), errors = [];
    if (b.retentionHours != null) next.retentionHours = Math.min(24 * 90, Math.max(1, Math.round(+b.retentionHours) || 72));
    if (b.maxEvents != null) next.maxEvents = Math.min(200000, Math.max(1000, Math.round(+b.maxEvents) || 20000));
    for (const k of ['healthGuard', 'captureDb', 'captureStatic', 'allowKill']) if (b[k] != null) next[k] = !!b[k];
    if (Array.isArray(b.redactions)) {
      next.redactions = b.redactions.slice(0, 100).map((r, i) => ({ id: cleanId(r.id) || 'rule-' + i, name: String(r.name || 'Custom rule').slice(0, 80),
        pattern: String(r.pattern || ''), flags: String(r.flags || 'g'), replace: String(r.replace ?? '[REDACTED]').slice(0, 80), enabled: r.enabled !== false, builtin: !!r.builtin }));
      next.redactions.forEach(r => { const e = validateRule(r); if (e) errors.push(`Redaction "${r.name}": ${e}`); });
    }
    if (Array.isArray(b.redactKeys)) next.redactKeys = [...new Set(b.redactKeys.map(k => String(k).trim()).filter(Boolean))].slice(0, 100);
    if (Array.isArray(b.parsers)) {
      next.parsers = b.parsers.slice(0, 50).map((p, i) => ({ id: cleanId(p.id) || 'parser-' + i, name: String(p.name || 'Parser').slice(0, 80),
        pattern: String(p.pattern || ''), flags: String(p.flags || ''), source: String(p.source || '*').slice(0, 80), enabled: p.enabled !== false }));
      next.parsers.forEach(p => { const e = validateRule(p); if (e) errors.push(`Parser "${p.name}": ${e}`); else if (!/\(\?<(msg|message)>/.test(p.pattern)) errors.push(`Parser "${p.name}": needs a named group (?<msg>…)`); });
    }
    if (Array.isArray(b.correlationFields)) next.correlationFields = b.correlationFields.map(String).filter(f => /^[\w.]{1,60}$/.test(f)).slice(0, 20);
    if (Array.isArray(b.files)) next.files = b.files.slice(0, 20).map(f => ({ path: String(f.path || '').trim(), enabled: f.enabled !== false })).filter(f => f.path);
    if (Array.isArray(b.feeds)) {
      next.feeds = b.feeds.slice(0, 20).map(f => ({ name: String(f.name || '').trim().replace(/[^\w .-]/g, '').slice(0, 40) || 'feed', url: String(f.url || '').trim(), intervalSec: Math.max(5, +f.intervalSec || 15), enabled: f.enabled !== false }));
      next.feeds.forEach(f => { if (!/^https?:\/\//i.test(f.url)) errors.push(`Feed "${f.name}": URL must start with http:// or https://`); });
    }
    if (b.osLog) next.osLog = { enabled: !!b.osLog.enabled, channel: String(b.osLog.channel || '').slice(0, 120), intervalSec: Math.max(10, +b.osLog.intervalSec || 30) };
    if (errors.length) return fail(res, 400, errors.join('\n'));
    const sourcesChanged = JSON.stringify([settings.files, settings.feeds, settings.osLog]) !== JSON.stringify([next.files, next.feeds, next.osLog]);
    settings = next;
    compile();
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    if (sourcesChanged) applySources();
    prune();
    emit({ source: 'server', feature: 'system', level: 'info', tags: ['audit'], msg: 'Debug Station settings updated' });
    res.json(publicSettings());
  });

  api.get('/bookmarks', (req, res) => res.json(Object.values(bookmarks).sort((a, b) => b.createdAt - a.createdAt)));
  api.put('/bookmarks/:id', json, (req, res) => {
    const id = +req.params.id, e = req.body.event || ring.find(x => x.id === id);
    if (!e) return fail(res, 404, 'Event not found');
    bookmarks[id] = { id, note: String(req.body.note || '').slice(0, 2000), pinned: !!req.body.pinned, createdAt: bookmarks[id]?.createdAt || Date.now(),
      event: redactValue(e, compiled, new Set()) };
    fs.writeFileSync(bookmarksFile, JSON.stringify(bookmarks));
    res.json(bookmarks[id]);
  });
  api.delete('/bookmarks/:id', (req, res) => { delete bookmarks[+req.params.id]; fs.writeFileSync(bookmarksFile, JSON.stringify(bookmarks)); res.json({ ok: true }); });

  api.post('/clear', json, (req, res) => {
    pending = []; outbox.length = 0; ring = [];
    groups.clear(); fstats.clear(); sources.clear(); volume.clear(); metrics.length = 0;
    for (const f of eventFiles()) fs.rmSync(path.join(dataDir, f), { force: true });
    if (req.body?.bookmarks !== false) { bookmarks = {}; fs.rmSync(bookmarksFile, { force: true }); }
    for (const [k, p] of procs) if (p.kind === 'browser' && p.status !== 'running') procs.delete(k);
    broadcast('cleared', { at: Date.now() });
    emit({ source: 'server', feature: 'system', level: 'info', tags: ['audit'], msg: 'Debug data cleared' });
    res.json({ ok: true });
  });

  emit({ source: 'server', feature: 'system', level: 'info', msg: `Debug Station on: open http://localhost:${process.env.PORT || 3000}/debug (loaded ${ring.length} stored events)` });

  return {
    enabled: true, http, router, attachMongo, attachChild, event, note, cacheHit,
    mongoOptions: { monitorCommands: true },
    probe: (name, fn) => probes.set(name, fn),
  };
}
