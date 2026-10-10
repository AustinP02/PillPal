// Browser telemetry for Debug Station. Silent no-op unless the server answers /__debug/api/hello
// (dev on localhost, or DEBUG_STATION=1). Never sends medication names, notes, chat text or images:
// callers pass feature ids, outcomes, timings and counts only.
import { featureOf } from './debug-features.js';

const H = { 'Content-Type': 'application/json', 'X-Debug-Station': '1' };
let enabled = null; // null = still checking
let queue = [];
const sessionId = (() => {
  try { return sessionStorage.pp_dbg_sid ||= Math.random().toString(36).slice(2, 12); }
  catch { return Math.random().toString(36).slice(2, 12); }
})();
const newTrace = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const ready = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  ? fetch('/__debug/api/hello', { headers: { 'X-Debug-Station': '1' } }).then(r => r.ok).catch(() => false)
  : Promise.resolve(false);
ready.then(on => { enabled = on; if (!on) queue = []; else flush(); });

function send(events, keepalive = false) {
  return fetch('/__debug/api/client', { method: 'POST', headers: H, keepalive, body: JSON.stringify({ sessionId, ua: navigator.userAgent, events }) }).catch(() => {});
}
function flush(keepalive = false) {
  if (!enabled || !queue.length) return;
  send(queue.splice(0, 200), keepalive);
}
setInterval(flush, 1500);

export function track(feature, msg, { level = 'info', meta, tags, stack, traceId, kind = 'op' } = {}) {
  if (enabled === false) return;
  queue.push({ ts: Date.now(), feature, msg, level, meta, tags, stack, traceId, kind });
  if (queue.length > 500) queue.splice(0, queue.length - 500);
  if (level === 'error' || level === 'fatal') flush();
}

// Headers that let the server tie its request, DB and outbound logs to this browser action.
export function traceHeaders() {
  if (!enabled) return { traceId: null, headers: {} };
  const traceId = newTrace();
  return { traceId, headers: { 'X-Trace-Id': traceId, 'X-Client-Session': sessionId } };
}

// Called by app.js api() for every call: end-to-end latency, network failures, server errors.
export function apiDone({ method, path, status, ms, traceId, error }) {
  const p = path.split('?')[0].replace(/\/[0-9a-f]{24}(?=\/|$)/gi, '/:id');
  const feature = featureOf('/api' + p);
  if (!status) return track(feature, `${method} /api${p} → network error after ${ms}ms: ${error}`, { level: 'error', kind: 'client-api', traceId, meta: { method, route: '/api' + p, durationMs: ms }, tags: ['offline'] });
  const level = status >= 500 ? 'error' : status >= 400 && !(status === 401 && p === '/me') ? 'warn' : 'debug';
  track(feature, `${method} /api${p} → ${status} · ${ms}ms (browser)`, { level, kind: 'client-api', traceId, meta: { method, route: '/api' + p, status, durationMs: ms } });
}

// Simple timer helper: const t = timer(); ... t() → ms
export const timer = () => { const t0 = performance.now(); return () => Math.round(performance.now() - t0); };

// ---------- automatic capture ----------
addEventListener('error', e => {
  if (e.target && e.target !== window && (e.target.src || e.target.href)) {
    return track('ui', `Failed to load ${e.target.tagName.toLowerCase()} ${new URL(e.target.src || e.target.href, location).pathname}`, { level: 'error' });
  }
  track('ui', `${e.message || 'Script error'}${e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno}:${e.colno})` : ''}`, { level: 'error', stack: e.error?.stack, tags: ['uncaught'] });
}, true);
addEventListener('unhandledrejection', e => {
  const r = e.reason;
  track('ui', `Unhandled promise rejection: ${r?.message || String(r)}`, { level: 'error', stack: r?.stack, tags: ['uncaught'] });
});
for (const [fn, level] of [['error', 'error'], ['warn', 'warn']]) {
  const orig = console[fn].bind(console);
  console[fn] = (...a) => {
    orig(...a);
    try { track('ui', a.map(x => (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ').slice(0, 1000), { level, stack: a.find(x => x instanceof Error)?.stack }); } catch { /* ignore */ }
  };
}
addEventListener('load', () => setTimeout(() => {
  const n = performance.getEntriesByType('navigation')[0];
  if (n) track('ui', `Page loaded in ${Math.round(n.loadEventEnd || n.duration)}ms`, { kind: 'page', meta: { durationMs: Math.round(n.loadEventEnd || n.duration), domReady: Math.round(n.domContentLoadedEventEnd), transferKB: Math.round((n.transferSize || 0) / 1024), standalone: matchMedia('(display-mode: standalone)').matches } });
}, 0));
addEventListener('appinstalled', () => track('ui', 'PillPal installed as an app', { tags: ['pwa'] }));
document.addEventListener('visibilitychange', () => heartbeat());
addEventListener('pagehide', () => { if (!enabled) return; queue.push({ kind: 'pagehide', ts: Date.now() }); flush(true); });

function heartbeat() {
  if (!enabled) return;
  queue.push({ kind: 'heartbeat', ts: Date.now(), meta: { page: location.hash.split('?')[0] || '#/', visible: document.visibilityState === 'visible', heap: performance.memory?.usedJSHeapSize } });
}
ready.then(on => on && (heartbeat(), setInterval(heartbeat, 20000)));
