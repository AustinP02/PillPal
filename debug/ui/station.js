// Debug Station UI for PillPal. No framework, no build step, no network beyond this server.
// Every dynamic value is escaped with esc(). Data arrives already redacted by the server.
import { LEVELS, levelNum, compileRules, validateRule, parseLine, fingerprint, DEFAULT_REDACTIONS } from '/__debug/lib/core.js';
import { FEATURES } from '/debug-features.js';

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const H = { 'Content-Type': 'application/json', 'X-Debug-Station': '1' };
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/__debug/api' + path, { method, headers: method === 'GET' ? {} : H, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
const LS = {
  get(k, d) { try { const v = localStorage.getItem('pp.debug.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pp.debug.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const pad = (n, w = 2) => String(n).padStart(w, '0');
const fmtClock = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
const fmtHM = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtFull = ts => new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
function ago(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 5 ? 'just now' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}
const dur = ms => ms == null ? '—' : ms < 1000 ? `${Math.round(ms)}ms` : ms < 60e3 ? `${(ms / 1000).toFixed(ms < 10e3 ? 2 : 1)}s` : ms < 3600e3 ? `${Math.floor(ms / 60e3)}m ${Math.round(ms % 60e3 / 1000)}s` : `${Math.floor(ms / 3600e3)}h ${Math.floor(ms % 3600e3 / 60e3)}m`;
const bytes = b => b == null ? '—' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`;
const num = n => n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(n);
const featLabel = id => FEATURES[id]?.label || id || '—';
const srcKey = s => (s || '').split(':')[0];
const srcColor = s => `var(--s-${['server', 'http', 'outbound', 'db', 'mongod', 'client', 'os', 'task', 'file', 'feed'].includes(srcKey(s)) ? srcKey(s) : 'os'})`;
const LVC = { trace: 'var(--l-trace)', debug: 'var(--l-debug)', info: 'var(--l-info)', warn: 'var(--l-warn)', error: 'var(--l-error)', fatal: 'var(--l-fatal)' };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.setAttribute('role', err ? 'alert' : 'status');
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), err ? 6000 : 3000);
}
async function copy(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(what); } catch { toast('Clipboard is blocked in this browser', true); }
}
function download(name, text, type = 'application/json') {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const IC = {
  overview: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', logs: 'M4 6h16M4 12h16M4 18h11', errors: 'M12 3 2 20h20L12 3zM12 10v4M12 17h.01',
  correlate: 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  processes: 'M5 5h14v14H5zM9 9h6v6H9zM9 2v3M15 2v3M9 19v3M15 19v3M19 9h3M19 15h3M2 9h3M2 15h3', sources: 'M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16M5 20h.01',
  privacy: 'M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6l8-3zM9 12l2 2 4-4', bookmarks: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3z',
  runtime: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7h.01', pause: 'M9 5v14M15 5v14', play: 'M7 4l13 8-13 8z', x: 'M6 6l12 12M18 6 6 18',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4', download: 'M12 4v11M7 10l5 5 5-5M5 20h14', copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3', refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7', pin: 'M9 4h6l-1 6 4 4H6l4-4-1-6zM12 14v7',
  filter: 'M3 5h18l-7 8v6l-4 2v-8L3 5z', play2: 'M7 4l13 8-13 8z', stop: 'M6 6h12v12H6z', link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  plus: 'M12 5v14M5 12h14', back: 'M15 6l-6 6 6 6',
};
const icon = n => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${IC[n]}"/></svg>`;

// ---------- state ----------
const ROW = 26;
const DEFAULT_FILTER = { q: '', regex: false, cs: false, levels: ['debug', 'info', 'warn', 'error', 'fatal'], sources: [], feature: '', proc: '', window: 'all', flags: [], fp: null, fpLabel: '' };
const S = {
  events: [], byId: new Map(), lastId: 0, max: 20000,
  paused: false, held: [], conn: 'connecting',
  summary: null, metrics: [], settings: null, bookmarks: new Map(),
  view: 'overview', sel: new Set(), anchor: null, cur: null, follow: true, filtered: [], newWhileScrolled: 0,
  filter: { ...DEFAULT_FILTER, ...LS.get('filter', {}) },
  cols: LS.get('cols', { time: true, level: true, source: true, feature: true, proc: true, meta: true }),
  corrField: LS.get('corrField', 'traceId'), corrSel: null, corrQ: '',
  procs: null, procAll: LS.get('procAll', false), procSort: LS.get('procSort', { k: 'cpu', dir: -1 }), procQ: '', procGroup: LS.get('procGroup', 'none'),
  pinnedPids: new Set(LS.get('pinnedPids', [])), procSel: null,
  errQ: '', errWarn: LS.get('errWarn', false), errSort: 'last',
  draft: null, dirty: false, runtime: null, metricWin: LS.get('metricWin', 15),
};

// ---------- data ----------
function addEvents(list) {
  let unordered = false;
  for (const e of list) {
    if (S.byId.has(e.id)) continue;
    if (e.id < S.lastId) unordered = true;
    S.events.push(e); S.byId.set(e.id, e);
    if (e.id > S.lastId) S.lastId = e.id;
  }
  if (unordered) { S.events.sort((a, b) => a.id - b.id); if (S.view === 'logs') setTimeout(() => refreshLogs(true)); }
  if (S.events.length > S.max * 1.1) {
    const drop = S.events.splice(0, S.events.length - S.max);
    for (const e of drop) S.byId.delete(e.id);
  }
}
async function loadAll() {
  const [settings, events, summary, metrics, bms] = await Promise.all([api('/settings'), api('/events?limit=50000'), api('/summary'), api('/metrics'), api('/bookmarks')]);
  S.settings = settings; S.max = settings.maxEvents;
  S.events = []; S.byId.clear(); S.lastId = 0;
  addEvents(events);
  S.summary = summary; S.metrics = metrics;
  S.bookmarks = new Map(bms.map(b => [b.id, b]));
}

let es;
function connect() {
  es?.close();
  es = new EventSource('/__debug/api/stream');
  es.addEventListener('hello', async e => {
    const { seq } = JSON.parse(e.data);
    if (seq < S.lastId) { await loadAll(); render(); } // server restarted with fresh data or was cleared
    else { addEvents(await api(`/events?since=${S.lastId}&limit=50000`)); onNewEvents([]); } // fill any gap
    setConn('live');
  });
  es.addEventListener('logs', e => {
    const list = JSON.parse(e.data);
    if (S.paused) { S.held.push(...list); if (S.held.length > 50000) S.held.splice(0, S.held.length - 50000); setConn('paused'); return; }
    const before = S.lastId;
    addEvents(list);
    onNewEvents(list.filter(x => x.id > before || S.byId.get(x.id) === x));
  });
  es.addEventListener('summary', e => { S.summary = JSON.parse(e.data); onSummary(); });
  es.addEventListener('metrics', e => { S.metrics.push(JSON.parse(e.data)); if (S.metrics.length > 1800) S.metrics.shift(); onMetrics(); });
  es.addEventListener('cleared', async () => { await loadAll(); S.sel.clear(); closeDrawer(); render(); toast('Debug data was cleared'); });
  es.onerror = () => setConn('down');
}
function setConn(state) {
  S.conn = state;
  const c = $('#conn');
  c.className = 'conn ' + (S.paused ? 'paused' : state);
  c.querySelector('span').textContent = S.paused ? `Paused · ${num(S.held.length)} waiting` : state === 'live' ? 'Live' : state === 'down' ? 'Reconnecting…' : 'Connecting…';
}
function togglePause(force) {
  S.paused = force ?? !S.paused;
  const b = $('#pauseBtn');
  b.setAttribute('aria-pressed', S.paused);
  b.innerHTML = S.paused ? `${icon('play')}<span class="lbl">Resume</span>` : `${icon('pause')}<span class="lbl">Pause</span>`;
  if (!S.paused && S.held.length) {
    const list = S.held.splice(0);
    addEvents(list);
    onNewEvents(list);
  }
  setConn(S.conn === 'paused' ? 'live' : S.conn);
}

// ---------- filtering ----------
const FIELD = {
  level: e => e.level, source: e => e.source, feature: e => e.feature, proc: e => e.proc, pid: e => e.pid, kind: e => e.kind, id: e => e.id,
  request: e => e.requestId, requestid: e => e.requestId, trace: e => e.traceId, traceid: e => e.traceId, session: e => e.sessionId, sessionid: e => e.sessionId,
  user: e => e.userHash, userhash: e => e.userHash, tag: e => e.tags, flag: e => e.flags, status: e => e.meta?.status, ms: e => e.meta?.durationMs,
  service: e => e.meta?.service, model: e => e.meta?.model, route: e => e.meta?.route, outcome: e => e.meta?.outcome,
};
const getPath = (e, key) => {
  const k = key.toLowerCase();
  if (FIELD[k]) return FIELD[k](e);
  if (k.startsWith('meta.')) return key.slice(5).split('.').reduce((o, p) => o?.[p], e.meta);
  return undefined;
};
function valueTest(raw) {
  const m = /^(>=|<=|>|<)(-?[\d.]+)$/.exec(raw);
  if (m) { const n = +m[2]; return v => v != null && ({ '>': +v > n, '<': +v < n, '>=': +v >= n, '<=': +v <= n })[m[1]]; }
  if (raw.startsWith('>=') && LEVELS.includes(raw.slice(2))) { const n = levelNum(raw.slice(2)); return v => levelNum(v) >= n; }
  const want = raw.toLowerCase();
  const wild = want.endsWith('*') ? want.slice(0, -1) : null;
  const one = v => { const s = String(v).toLowerCase(); return wild != null ? s.startsWith(wild) : s === want; };
  return v => v != null && (Array.isArray(v) ? v.some(one) : one(v));
}
const hay = e => (e._h ||= `${e.msg}\n${e.stack || ''}\n${e.requestId || ''} ${e.traceId || ''} ${e.sessionId || ''} ${e.userHash || ''} ${e.proc} ${e.source} ${e.meta ? JSON.stringify(e.meta) : ''}`);
let filterError = '';
function compileFilter(f) {
  filterError = '';
  const tests = [];
  const levels = new Set(f.levels);
  tests.push(e => levels.has(e.level));
  if (f.sources.length) { const s = new Set(f.sources); tests.push(e => s.has(e.source) || s.has(srcKey(e.source))); }
  if (f.feature) tests.push(e => e.feature === f.feature || (f.feature.endsWith('*') && e.feature?.startsWith(f.feature.slice(0, -1))));
  if (f.proc) tests.push(e => e.proc === f.proc);
  if (f.window !== 'all') { const ms = +f.window * 60e3; tests.push(e => e.ts >= Date.now() - ms); }
  for (const fl of f.flags) {
    if (fl === 'bookmarked') tests.push(e => S.bookmarks.has(e.id));
    else if (fl === 'redacted') tests.push(e => e.redacted);
    else tests.push(e => e.flags?.includes(fl));
  }
  if (f.fp) tests.push(e => levelNum(e.level) >= 3 || e.flags?.includes('exception') ? fingerprint(e) === f.fp : false);
  const q = f.q.trim();
  if (q) {
    if (f.regex) {
      try { const re = new RegExp(q, f.cs ? '' : 'i'); tests.push(e => re.test(hay(e))); }
      catch (x) { filterError = x.message; }
    } else {
      for (let tok of q.match(/-?[\w.]+:"[^"]*"|-?[\w.]+:\S+|-?"[^"]*"|\S+/g) || []) {
        const neg = tok.startsWith('-') && tok.length > 1;
        if (neg) tok = tok.slice(1);
        const m = /^([\w.]+):(.+)$/.exec(tok);
        let t;
        if (m && (FIELD[m[1].toLowerCase()] || m[1].toLowerCase().startsWith('meta.'))) {
          const vt = valueTest(m[2].replace(/^"|"$/g, '')), key = m[1];
          t = e => vt(getPath(e, key));
        } else {
          const needle = tok.replace(/^"|"$/g, '');
          if (f.cs) t = e => hay(e).includes(needle);
          else { const n = needle.toLowerCase(); t = e => (e._hl ||= hay(e).toLowerCase()).includes(n); }
        }
        tests.push(neg ? e => !t(e) : t);
      }
    }
  }
  return e => tests.every(t => t(e));
}
let match = compileFilter(S.filter);
function setFilter(patch, { save = true } = {}) {
  Object.assign(S.filter, patch);
  if (save) LS.set('filter', { ...S.filter, fp: null, fpLabel: '' });
  match = compileFilter(S.filter);
  if (S.view === 'logs') { S.follow = true; refreshLogs(true); }
}
const highlightTerms = () => S.filter.regex || !S.filter.q.trim() ? [] :
  (S.filter.q.match(/-?[\w.]+:"[^"]*"|-?[\w.]+:\S+|-?"[^"]*"|\S+/g) || []).filter(t => !t.startsWith('-') && !/^[\w.]+:/.test(t)).map(t => t.replace(/^"|"$/g, '')).filter(t => t.length > 1);
function mark(text, terms) {
  let h = esc(text);
  for (const t of terms) {
    const re = new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), S.filter.cs ? 'g' : 'gi');
    h = h.replace(re, m => `<mark>${m}</mark>`);
  }
  return h;
}

// ---------- shell ----------
const VIEWS = [['overview', 'Overview'], ['logs', 'Logs'], ['errors', 'Errors'], ['correlate', 'Correlate'], ['processes', 'Processes'], ['sources', 'Sources'], ['privacy', 'Privacy & rules'], ['bookmarks', 'Bookmarks'], ['runtime', 'Runtime']];
function renderRail() {
  $('.rail').innerHTML = VIEWS.map(([id, label], i) => `${i === 4 ? '<div class="sep"></div>' : ''}<a href="#${id}" data-view="${id}" title="${label} (${i + 1})">${icon(id)}<span>${label}</span>${id === 'errors' ? '<em class="count" id="errCount" hidden></em>' : id === 'bookmarks' ? '<em class="count neutral" id="bmCount" hidden></em>' : ''}</a>`).join('')
    + `<div class="foot">Local only. Nothing leaves this computer.<br>Secrets are redacted before storage.</div>`;
}
function route() {
  const [v, qs] = location.hash.slice(1).split('?');
  const view = VIEWS.some(([id]) => id === v) ? v : 'overview';
  const params = new URLSearchParams(qs);
  if (view !== S.view || !$('#view').firstChild) { S.view = view; render(); }
  if (params.get('ev')) openDrawer(+params.get('ev'));
}
function render() {
  $$('.rail a').forEach(a => a.dataset.view === S.view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  document.title = `${VIEWS.find(v => v[0] === S.view)[1]} · Debug Station · PillPal`;
  clearInterval(procTimer); procTimer = null;
  $('#view').onclick = null;
  VIEW[S.view]();
  renderKpis();
  renderBadges();
}
function go(view, filterPatch) {
  if (filterPatch) setFilter({ ...DEFAULT_FILTER, levels: S.filter.levels, ...filterPatch });
  if (S.view === view) render(); else location.hash = view;
}

function renderKpis() {
  const m = S.metrics.at(-1), errs5 = recentCount(e => levelNum(e.level) >= 4, 5), warns5 = recentCount(e => e.level === 'warn', 5);
  const tabs = S.summary?.sources?.find(s => s.id === 'client');
  $('#kpis').innerHTML = [
    ['events', num(S.events.length)], ['errors · 5m', errs5, errs5 ? 'bad' : ''], ['warnings · 5m', warns5, warns5 ? 'warn' : ''],
    ['events/s', m ? m.eps.toFixed(1) : '—'], ['server CPU', m ? m.cpu + '%' : '—'], ['server RSS', m ? bytes(m.rss) : '—'], ['loop lag p99', m ? m.lag + 'ms' : '—', m?.lag > 100 ? 'warn' : ''],
    ['browser', tabs?.status === 'live' ? 'connected' : 'no tab'],
  ].map(([k, v, c]) => `<div class="kpi ${c || ''}"><b>${esc(v)}</b><small>${esc(k)}</small></div>`).join('');
}
function recentCount(pred, minutes) {
  const since = Date.now() - minutes * 60e3;
  let n = 0;
  for (let i = S.events.length - 1; i >= 0 && S.events[i].ts >= since - 60e3; i--) if (S.events[i].ts >= since && pred(S.events[i])) n++;
  return n;
}
function renderBadges() {
  const e = $('#errCount'), n = (S.summary?.errors || []).filter(g => levelNum(g.level) >= 4 && g.last5m).length;
  e.hidden = !n; e.textContent = n;
  const b = $('#bmCount'); b.hidden = !S.bookmarks.size; b.textContent = S.bookmarks.size;
}
const throttle = (fn, ms) => { let t = 0, timer; return () => { const now = Date.now(); if (now - t > ms) { t = now; fn(); } else { clearTimeout(timer); timer = setTimeout(() => { t = Date.now(); fn(); }, ms - (now - t)); } }; };
const onNewEvents = throttle(() => {
  if (S.view === 'logs') refreshLogs(false);
  else if (S.view === 'correlate') renderCorrGroups();
  renderKpis();
}, 250);
function onSummary() {
  renderBadges(); renderKpis();
  if (S.view === 'overview') renderOverviewLive();
  else if (S.view === 'errors') renderErrorRows();
  else if (S.view === 'sources' && !document.activeElement?.closest('#view form')) renderSourceTable();
}
const onMetrics = throttle(() => { renderKpis(); if (S.view === 'overview') renderMetricCharts(); }, 2000);

// ---------- charts ----------
function chart({ xs, series, h = 130, fmt = v => v, stacked = false, bars = false, yMin = 0, label = '' }) {
  const W = 640, L = 44, R = 6, T = 8, B = 18, iw = W - L - R, ih = h - T - B, n = xs.length;
  if (!n) return `<svg class="chart" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(label)}: no data yet"><text x="${W / 2}" y="${h / 2}" text-anchor="middle">No data yet</text></svg>`;
  const tot = i => stacked ? series.reduce((a, s) => a + (s.values[i] || 0), 0) : Math.max(...series.map(s => s.values[i] ?? 0));
  let max = Math.max(1e-9, ...xs.map((_, i) => tot(i)));
  const mag = 10 ** Math.floor(Math.log10(max)), step = [1, 2, 2.5, 5, 10].find(s => s * mag * 3 >= max) * mag;
  max = step * 3;
  const y = v => T + ih - ((v - yMin) / (max - yMin)) * ih, x = i => L + (n === 1 ? iw / 2 : (i / (n - 1)) * iw), bw = Math.max(1, iw / n - 1);
  let g = '<g class="grid">';
  for (let k = 0; k <= 3; k++) { const v = yMin + step * k; g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${esc(fmt(v))}</text>`; }
  g += '</g>';
  const ticks = [0, Math.floor(n / 2), n - 1].map(i => `<text x="${bars ? L + i * (iw / n) + bw / 2 : x(i)}" y="${h - 4}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${fmtHM(xs[i])}</text>`).join('');
  let marks = '';
  if (bars) {
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (const s of series) { const v = s.values[i] || 0; if (!v) continue; const y0 = y(acc), y1 = y(acc + v); marks += `<rect x="${(L + i * (iw / n)).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(.5, y0 - y1).toFixed(1)}" fill="${s.color}"/>`; acc += v; }
    }
  } else {
    for (const s of series) {
      const pts = s.values.map((v, i) => v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      let d = '', pen = false;
      for (const p of pts) { if (!p) { pen = false; continue; } d += (pen ? 'L' : 'M') + p; pen = true; }
      marks += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.6" stroke-linejoin="round"/>`;
    }
  }
  const hov = xs.map((t, i) => `<rect class="hov" x="${(bars ? L + i * (iw / n) : x(i) - iw / n / 2).toFixed(1)}" y="${T}" width="${(iw / n).toFixed(1)}" height="${ih}" fill="transparent"><title>${esc(fmtHM(t))}\n${series.map(s => `${s.name}: ${s.values[i] == null ? '—' : fmt(s.values[i])}`).join('\n')}</title></rect>`).join('');
  const summaryText = `${label}. ${series.map(s => { const vals = s.values.filter(v => v != null); return `${s.name}: latest ${vals.length ? fmt(vals.at(-1)) : 'none'}, peak ${vals.length ? fmt(Math.max(...vals)) : 'none'}`; }).join('; ')}`;
  return `<svg class="chart" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(summaryText)}">${g}${marks}${ticks}${hov}</svg>`;
}
const legend = series => `<div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`;
function spark(series) {
  const max = Math.max(1, ...series.map(([o, e]) => o + e)), w = 100 / series.length;
  return `<svg class="spark" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">${series.map(([o, e], i) => {
    const ho = (o / max) * 24, he = (e / max) * 24;
    return (ho ? `<rect x="${(i * w + .3).toFixed(2)}" y="${(26 - ho).toFixed(2)}" width="${(w - .6).toFixed(2)}" height="${ho.toFixed(2)}" fill="var(--brand)" opacity=".55"/>` : '')
      + (he ? `<rect x="${(i * w + .3).toFixed(2)}" y="${(26 - Math.max(he, 2)).toFixed(2)}" width="${(w - .6).toFixed(2)}" height="${Math.max(he, 2).toFixed(2)}" fill="var(--l-error)"/>` : '');
  }).join('')}</svg>`;
}

// ---------- views ----------
const VIEW = {};
const page = (title, sub, actions = '', body = '') => { $('#view').innerHTML = `<div class="page" id="page"><header class="page-head"><div><h1 tabindex="-1">${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="row">${actions}</div></header>${body}</div>`; };

// ===== Overview =====
VIEW.overview = () => {
  page('PillPal at a glance', 'Health of every PillPal feature over the last 30 minutes, built from server requests, browser telemetry, database and outbound calls. Select a feature to see its logs.',
    `<label class="check"><span class="muted">Charts:</span><select id="metricWin" aria-label="Chart time window">${[5, 15, 30, 60].map(m => `<option value="${m}" ${S.metricWin === m ? 'selected' : ''}>last ${m} min</option>`).join('')}</select></label>`,
    `<div class="kpi-grid" id="ovStats"></div><div id="features"></div>
     <div class="charts">
       <section class="card"><div class="chart-title"><h2>Log volume</h2><small>events per minute by level</small></div><div id="chVolume"></div></section>
       <section class="card"><div class="chart-title"><h2>Error rate</h2><small>errors + fatal per minute</small></div><div id="chErrors"></div></section>
       <section class="card"><div class="chart-title"><h2>CPU</h2><small>% of all cores</small></div><div id="chCpu"></div></section>
       <section class="card"><div class="chart-title"><h2>Memory</h2><small>resident set</small></div><div id="chMem"></div></section>
       <section class="card"><div class="chart-title"><h2>Event loop</h2><small>lag p99 (ms) · utilization %</small></div><div id="chLoop"></div></section>
       <section class="card wide"><div class="chart-title"><h2>Latency by feature</h2><small>p50 / p95, server-side</small></div><div id="latTable"></div></section>
     </div>`);
  $('#metricWin').onchange = e => { S.metricWin = +e.target.value; LS.set('metricWin', S.metricWin); renderMetricCharts(); };
  renderOverviewLive();
  renderMetricCharts();
};
function renderOverviewLive() {
  const sm = S.summary;
  if (!sm || !$('#features')) return;
  const f = sm.features, active = f.filter(x => x.status !== 'idle');
  const bad = f.filter(x => x.status === 'failing'), deg = f.filter(x => x.status === 'degraded');
  const errs5 = recentCount(e => levelNum(e.level) >= 4, 5);
  $('#ovStats').innerHTML = [
    ['Features active', `${active.length}/${f.length}`], ['Failing', bad.length, bad.length ? 'bad' : ''], ['Degraded', deg.length, deg.length ? 'warn' : ''],
    ['Errors · 5 min', errs5, errs5 ? 'bad' : ''], ['Error groups', sm.errors.filter(g => levelNum(g.level) >= 4).length],
    ['Requests · 5 min', recentCount(e => e.kind === 'request', 5)], ['Stored events', num(sm.totals.events)], ['Retention', `${sm.totals.retentionHours}h`],
  ].map(([k, v, c]) => `<div class="stat ${c || ''}"><small>${esc(k)}</small><b>${esc(v)}</b></div>`).join('');
  const groups = [...new Set(f.map(x => x.group))];
  $('#features').innerHTML = groups.map(g => `<section class="fgroup"><h2>${esc(g)}</h2><div class="fgrid">${f.filter(x => x.group === g).map(featureCard).join('')}</div></section>`).join('');
  const lat = f.filter(x => x.p50 != null).sort((a, b) => b.p95 - a.p95);
  $('#latTable').innerHTML = lat.length ? `<table class="t"><thead><tr><th>Feature</th><th style="text-align:right">p50</th><th style="text-align:right">p95</th><th style="text-align:right">Budget</th></tr></thead><tbody>${lat.map(x =>
    `<tr class="click" data-feature="${esc(x.id)}"><td>${esc(x.label)}</td><td class="num">${dur(x.p50)}</td><td class="num" style="${x.p95 > x.slowMs ? 'color:var(--l-warn)' : ''}">${dur(x.p95)}</td><td class="num faint">${dur(x.slowMs)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">No timed requests yet. Use PillPal in another tab.</p>';
  const vol = sm.volume;
  const volSeries = LEVELS.map((l, i) => ({ name: l, color: LVC[l], values: vol.map(v => v.c[i]) })).filter(s => s.values.some(Boolean));
  $('#chVolume').innerHTML = chart({ xs: vol.map(v => v.t), series: volSeries.length ? volSeries : [{ name: 'events', color: LVC.info, values: vol.map(() => 0) }], stacked: true, bars: true, label: 'Log volume per minute' }) + legend(volSeries);
  $('#chErrors').innerHTML = chart({ xs: vol.map(v => v.t), series: [{ name: 'errors', color: LVC.error, values: vol.map(v => v.c[4] + v.c[5]) }, { name: 'warnings', color: LVC.warn, values: vol.map(v => v.c[3]) }], label: 'Errors per minute' })
    + legend([{ name: 'errors + fatal', color: LVC.error }, { name: 'warnings', color: LVC.warn }]);
}
function featureCard(x) {
  const ok = x.outcomes?.success || 0, miss = x.outcomes?.miss || 0, failO = x.outcomes?.fail || 0, tot = ok + miss + failO;
  const errRate = x.ops ? Math.round((x.errors / x.ops) * 100) : null;
  const deps = Object.entries(x.deps || {}).map(([k, d]) => `${k}: ${d.calls} call${d.calls === 1 ? '' : 's'}${d.calls ? ` · avg ${dur(d.ms / d.calls)}` : ''}${d.errors ? ` · ${d.errors} failed` : ''}${d.cached ? ` · ${Math.round(d.cached / (d.cached + d.calls) * 100)}% cached` : ''}`);
  const tags = Object.entries(x.tags || {}).filter(([t]) => !['audit'].includes(t)).map(([t, n]) => `<span class="tag ${/fail|denied|rate|locked|down|fallback|retry|offline|429/.test(t) ? 'warn' : t === 'safety-message' ? 'err' : ''}">${esc(t)} ×${n}</span>`).join('');
  return `<button class="fcard ${x.status}" data-feature="${esc(x.id)}" title="${esc(x.hint || '')}">
    <div class="fh"><b>${esc(x.label)}</b><span class="status ${x.status}">${x.status}</span></div>
    <div class="nums"><span><b>${num(x.ops)}</b> ops</span><span><b>${x.errors}</b> err${errRate != null && x.ops ? ` (${errRate}%)` : ''}</span>${x.p50 != null ? `<span>p50 <b>${dur(x.p50)}</b></span><span>p95 <b>${dur(x.p95)}</b></span>` : ''}${x.client ? '<span class="faint">browser</span>' : ''}</div>
    ${tot ? `<div class="nums"><span>${x.id.startsWith('scan') || x.id === 'drug-info' ? 'Match rate' : 'Success'} <b>${Math.round(ok / tot * 100)}%</b> (${ok}/${tot})</span>${miss ? `<span>${miss} no match</span>` : ''}${failO ? `<span style="color:var(--l-error)">${failO} failed</span>` : ''}</div>` : ''}
    ${deps.length ? `<div class="deps">${deps.map(esc).join('<br>')}</div>` : ''}
    ${tags ? `<div class="chips">${tags}</div>` : ''}
    ${x.series?.length ? spark(x.series) : ''}
    ${x.lastError ? `<div class="lasterr" title="${esc(x.lastError.msg)}">${ago(x.lastError.ts)} · ${esc(x.lastError.msg)}</div>` : `<div class="hint">${x.last ? `Last activity ${ago(x.last)}` : esc(x.hint || 'No activity yet')}</div>`}
  </button>`;
}
function bucketMetrics() {
  const since = Date.now() - S.metricWin * 60e3, pts = S.metrics.filter(p => p.ts >= since);
  const per = Math.max(1, Math.ceil(pts.length / 120)), out = [];
  for (let i = 0; i < pts.length; i += per) {
    const chunk = pts.slice(i, i + per), avg = k => chunk.reduce((a, p) => a + (p[k] || 0), 0) / chunk.length;
    const child = {};
    for (const p of chunk) for (const [k, v] of Object.entries(p.procs || {})) { (child[k] ||= { cpu: [], mem: [] }); if (v.cpu != null) child[k].cpu.push(v.cpu); if (v.mem) child[k].mem.push(v.mem); }
    out.push({ ts: chunk.at(-1).ts, cpu: avg('cpu'), rss: avg('rss'), heap: avg('heap'), lag: Math.max(...chunk.map(p => p.lag)), elu: avg('elu'),
      procs: Object.fromEntries(Object.entries(child).map(([k, v]) => [k, { cpu: v.cpu.length ? v.cpu.reduce((a, b) => a + b, 0) / v.cpu.length : null, mem: v.mem.length ? v.mem.at(-1) : null }])) });
  }
  return out;
}
function renderMetricCharts() {
  if (!$('#chCpu')) return;
  const pts = bucketMetrics(), xs = pts.map(p => p.ts);
  const kids = [...new Set(pts.flatMap(p => Object.keys(p.procs)))];
  const palette = ['var(--s-db)', 'var(--s-task)', 'var(--s-outbound)', 'var(--s-feed)'];
  const label = k => k === 'mongod' ? 'mongod' : k.replace(/^task:/, 'npm ');
  const cpu = [{ name: 'PillPal server', color: 'var(--brand)', values: pts.map(p => +p.cpu.toFixed(1)) }, ...kids.map((k, i) => ({ name: label(k), color: palette[i % 4], values: pts.map(p => p.procs[k]?.cpu ?? null) }))];
  const mem = [{ name: 'server RSS', color: 'var(--brand)', values: pts.map(p => p.rss) }, { name: 'server JS heap', color: 'var(--l-debug)', values: pts.map(p => p.heap) }, ...kids.map((k, i) => ({ name: label(k), color: palette[i % 4], values: pts.map(p => p.procs[k]?.mem ?? null) }))];
  const loop = [{ name: 'lag p99 (ms)', color: 'var(--sun)', values: pts.map(p => p.lag) }, { name: 'utilization %', color: 'var(--l-debug)', values: pts.map(p => +p.elu.toFixed(1)) }];
  $('#chCpu').innerHTML = chart({ xs, series: cpu, fmt: v => `${(+v).toFixed(v < 10 ? 1 : 0)}%`, label: 'CPU' }) + legend(cpu) + (kids.length ? '' : '<p class="faint" style="margin-top:4px;font-size:11.5px">mongod and task CPU are sampled every 6 s while this page is open.</p>');
  $('#chMem').innerHTML = chart({ xs, series: mem, fmt: v => bytes(v), label: 'Memory' }) + legend(mem);
  $('#chLoop').innerHTML = chart({ xs, series: loop, fmt: v => (+v).toFixed(v < 10 ? 1 : 0), label: 'Event loop' }) + legend(loop);
}

// ===== Logs =====
const COLDEF = [['time', 'Time', '96px'], ['level', 'Level', '50px'], ['source', 'Source', '112px'], ['feature', 'Feature', '128px'], ['proc', 'Process · PID', '150px'], ['msg', 'Message', 'minmax(240px, 1fr)'], ['meta', 'Metadata', 'minmax(120px, .45fr)']];
VIEW.logs = () => {
  const f = S.filter;
  const sources = [...new Set(S.events.map(e => e.source))].sort();
  const procs = [...new Set(S.events.map(e => e.proc))].sort();
  const featureOpts = [...new Set(Object.values(FEATURES).map(x => x.group))].map(g => `<optgroup label="${esc(g)}">${Object.entries(FEATURES).filter(([, x]) => x.group === g).map(([id, x]) => `<option value="${id}" ${f.feature === id ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</optgroup>`).join('');
  const counts = Object.fromEntries(LEVELS.map(l => [l, 0]));
  for (const e of S.events) counts[e.level]++;
  $('#view').innerHTML = `
  <div class="filters" role="search">
    <div class="row">
      <div class="search grow ${filterError ? 'bad' : ''}" id="searchBox">
        <span class="mag">${icon('search')}</span>
        <input type="search" id="q" value="${esc(f.q)}" placeholder='Search… e.g. timeout  status:>=500  feature:ai.*  trace:abc123  -static' aria-label="Search logs" autocomplete="off" spellcheck="false">
        <div class="opts"><button class="btn ghost" id="optRegex" aria-pressed="${f.regex}" title="Regular expression">.*</button><button class="btn ghost" id="optCase" aria-pressed="${f.cs}" title="Match case">Aa</button></div>
      </div>
      <select id="fWindow" aria-label="Time window">${[['all', 'All time'], ['5', 'Last 5 min'], ['15', 'Last 15 min'], ['60', 'Last hour'], ['360', 'Last 6 hours'], ['1440', 'Last 24 hours']].map(([v, l]) => `<option value="${v}" ${f.window === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="fFeature" aria-label="Feature"><option value="">All features</option><option value="ai.*" ${f.feature === 'ai.*' ? 'selected' : ''}>All Pal AI</option><option value="scan*" ${f.feature === 'scan*' ? 'selected' : ''}>All scanning</option><option value="auth.*" ${f.feature === 'auth.*' ? 'selected' : ''}>All sign-in</option>${featureOpts}</select>
      <select id="fSource" aria-label="Source"><option value="">All sources</option>${[...new Set(sources.map(srcKey))].map(s => `<option value="${esc(s)}" ${f.sources[0] === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}${sources.filter(s => s.includes(':')).map(s => `<option value="${esc(s)}" ${f.sources[0] === s ? 'selected' : ''}>  ${esc(s)}</option>`).join('')}</select>
      <select id="fProc" aria-label="Process"><option value="">All processes</option>${procs.map(p => `<option ${f.proc === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
    </div>
    <div class="row">
      <div class="chips" role="group" aria-label="Levels">${LEVELS.map(l => `<button class="chip" data-level="${l}" aria-pressed="${f.levels.includes(l)}"><span class="dot" style="background:${LVC[l]}"></span>${l}<small>${num(counts[l])}</small></button>`).join('')}</div>
      <span class="faint">|</span>
      <div class="chips" role="group" aria-label="Detected">${[['stack', 'Stack traces'], ['exception', 'Exceptions'], ['http-error', 'HTTP errors'], ['repeated', 'Repeated'], ['slow', 'Slow'], ['redacted', 'Redacted'], ['bookmarked', 'Bookmarked']].map(([k, l]) => `<button class="chip" data-flag="${k}" aria-pressed="${f.flags.includes(k)}">${l}</button>`).join('')}</div>
      <div class="active-filters" id="activeFilters"></div>
    </div>
  </div>
  <div class="logbar">
    <span id="logCount"></span><span id="selInfo"></span>
    <span class="grow"></span>
    <span id="pinStrip" class="row"></span>
    <button class="btn sm" id="followBtn" aria-pressed="${S.follow}" title="Keep the newest event in view">Follow</button>
    <div class="menu"><button class="btn sm" id="colsBtn" aria-haspopup="true">Columns</button><div class="menu-pop" id="colsPop" hidden>${COLDEF.filter(([k]) => k !== 'msg').map(([k, l]) => `<label><input type="checkbox" data-col="${k}" ${S.cols[k] !== false ? 'checked' : ''}> ${l}</label>`).join('')}</div></div>
    <div class="menu"><button class="btn sm" id="exportBtn" aria-haspopup="true">${icon('download')} Export</button><div class="menu-pop" id="exportPop" hidden></div></div>
    <button class="btn sm ghost" id="resetFilters" title="Reset all filters">Reset</button>
  </div>
  <div class="table-wrap" id="tw" tabindex="0" aria-label="Log events. Use J and K to move, Enter to open.">
    <div class="thead" id="thead"></div>
    <div id="rows" style="position:relative"></div>
    <div id="logEmpty" hidden></div>
  </div>`;
  const wrap = $('#tw');
  wrap.onscroll = () => {
    const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - ROW * 1.5;
    if (S.follow !== atBottom) { S.follow = atBottom; $('#followBtn').setAttribute('aria-pressed', atBottom); }
    if (atBottom) S.newWhileScrolled = 0;
    renderRows();
  };
  const q = $('#q');
  q.oninput = debounce(() => setFilter({ q: q.value }), 200);
  $('#optRegex').onclick = e => { setFilter({ regex: !S.filter.regex }); e.currentTarget.setAttribute('aria-pressed', S.filter.regex); };
  $('#optCase').onclick = e => { setFilter({ cs: !S.filter.cs }); e.currentTarget.setAttribute('aria-pressed', S.filter.cs); };
  $('#fWindow').onchange = e => setFilter({ window: e.target.value });
  $('#fFeature').onchange = e => setFilter({ feature: e.target.value });
  $('#fSource').onchange = e => setFilter({ sources: e.target.value ? [e.target.value] : [] });
  $('#fProc').onchange = e => setFilter({ proc: e.target.value });
  $$('[data-level]').forEach(b => b.onclick = ev => {
    const l = b.dataset.level;
    let levels = ev.shiftKey || ev.altKey ? [l] : S.filter.levels.includes(l) ? S.filter.levels.filter(x => x !== l) : [...S.filter.levels, l];
    if (!levels.length) levels = [l];
    setFilter({ levels });
    $$('[data-level]').forEach(x => x.setAttribute('aria-pressed', S.filter.levels.includes(x.dataset.level)));
  });
  $$('[data-flag]').forEach(b => b.onclick = () => {
    const k = b.dataset.flag, flags = S.filter.flags.includes(k) ? S.filter.flags.filter(x => x !== k) : [...S.filter.flags, k];
    setFilter({ flags }); b.setAttribute('aria-pressed', flags.includes(k));
  });
  $('#followBtn').onclick = () => { S.follow = true; scrollToEnd(); };
  $('#resetFilters').onclick = () => { setFilter({ ...DEFAULT_FILTER }); VIEW.logs(); };
  $('#colsBtn').onclick = () => { $('#colsPop').hidden = !$('#colsPop').hidden; };
  $$('[data-col]').forEach(c => c.onchange = () => { S.cols[c.dataset.col] = c.checked; LS.set('cols', S.cols); refreshLogs(true); });
  $('#exportBtn').onclick = () => { const p = $('#exportPop'); p.hidden = !p.hidden; if (!p.hidden) renderExportMenu(); };
  $('#rows').onclick = e => {
    const r = e.target.closest('.trow'); if (!r) return;
    const id = +r.dataset.id;
    if (e.target.closest('.selbox') || e.metaKey || e.ctrlKey) { toggleSel(id); return; }
    if (e.shiftKey && S.anchor != null) { selectRange(S.anchor, id); return; }
    S.anchor = id; openDrawer(id);
  };
  refreshLogs(true);
  if (!matchMedia('(pointer: coarse)').matches) q.focus();
};
// Columns the user turned on, minus the least important ones when the table is narrow (e.g. detail panel open).
function visibleCols() {
  const w = $('#tw')?.clientWidth || 1200;
  const drop = new Set(w < 600 ? ['meta', 'feature', 'proc', 'source'] : w < 820 ? ['meta', 'proc', 'feature'] : w < 1000 ? ['meta', 'proc'] : w < 1150 ? ['meta'] : []);
  return COLDEF.filter(([k]) => k === 'msg' || (S.cols[k] !== false && !drop.has(k)));
}
function gridCols() { return visibleCols().map(c => c[2]); }
function refreshLogs(full) {
  if (!$('#rows')) return;
  // One merged timeline ordered by event time (browser batches and file/OS logs arrive late), ties by arrival.
  const byTime = (a, b) => a.ts - b.ts || a.id - b.id;
  if (full) {
    S.filtered = S.events.filter(match).sort(byTime);
    S.filteredUpTo = S.lastId;
  } else {
    const last = S.filteredUpTo || 0;
    let added = 0;
    for (let i = S.events.length - 1; i >= 0 && S.events[i].id > last; i--) added++;
    const fresh = S.events.slice(S.events.length - added).filter(match);
    S.filteredUpTo = S.lastId;
    for (const e of fresh) {
      const f = S.filtered;
      if (!f.length || byTime(e, f.at(-1)) >= 0) { f.push(e); continue; }
      let lo = 0, hi = f.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (byTime(f[mid], e) <= 0) lo = mid + 1; else hi = mid; }
      f.splice(lo, 0, e);
    }
    if (S.filtered.length > S.max) S.filtered.splice(0, S.filtered.length - S.max);
    if (S.filter.window !== 'all') { const cut = Date.now() - +S.filter.window * 60e3; while (S.filtered.length && S.filtered[0].ts < cut) S.filtered.shift(); }
    if (!S.follow) S.newWhileScrolled += fresh.length;
  }
  const cols = gridCols();
  $('#tw').style.setProperty('--cols', `22px ${cols.join(' ')}`);
  $('#thead').innerHTML = `<span></span>${visibleCols().map(([, l]) => `<span>${l}</span>`).join('')}`;
  $('#rows').style.height = S.filtered.length * ROW + 'px';
  const total = S.events.length;
  $('#logCount').innerHTML = `<b>${num(S.filtered.length)}</b> of ${num(total)} events${S.paused ? ` · <span style="color:var(--sun)">paused, ${num(S.held.length)} waiting</span>` : ''}${!S.follow && S.newWhileScrolled ? ` · <button class="btn sm" id="jumpNew">${S.newWhileScrolled} new ↓</button>` : ''}`;
  $('#jumpNew')?.addEventListener('click', () => { S.follow = true; scrollToEnd(); });
  $('#searchBox').classList.toggle('bad', !!filterError);
  $('#searchBox').title = filterError;
  renderActiveFilters();
  renderPinStrip();
  renderSelInfo();
  const empty = $('#logEmpty');
  empty.hidden = !!S.filtered.length;
  if (!S.filtered.length) empty.innerHTML = `<div class="empty"><img src="/icon.svg" width="42" height="42" alt=""><h2>${total ? 'Nothing matches these filters' : 'No events yet'}</h2><p>${filterError ? `Regex error: ${esc(filterError)}` : total ? 'Loosen a filter, or press Reset.' : 'Use PillPal in another tab and its activity will stream in here.'}</p></div>`;
  if (S.follow) scrollToEnd(); else renderRows();
}
function scrollToEnd() { const w = $('#tw'); if (!w) return; w.scrollTop = w.scrollHeight; S.newWhileScrolled = 0; renderRows(); }
function metaText(e) {
  const m = e.meta;
  if (!m) return '';
  const pick = e.kind === 'request' ? ['status', 'durationMs', 'db', 'outbound', 'outcome'] : e.kind === 'outbound' ? ['service', 'status', 'durationMs', 'model'] : e.kind === 'db' ? ['collection', 'durationMs', 'n', 'returned'] : Object.keys(m);
  return pick.filter(k => m[k] != null && typeof m[k] !== 'object').slice(0, 5).map(k => `${k === 'durationMs' ? 'ms' : k}=${m[k]}`).join(' ');
}
let lastRowsKey = '';
function renderRows() {
  const w = $('#tw'), rows = $('#rows');
  if (!w || !rows) return;
  const top = Math.max(0, w.scrollTop - 28), h = w.clientHeight;
  const start = Math.max(0, Math.floor(top / ROW) - 15), end = Math.min(S.filtered.length, Math.ceil((top + h) / ROW) + 15);
  const vis = new Set(visibleCols().map(c => c[0]));
  if ($('#tw').style.getPropertyValue('--cols') !== `22px ${gridCols().join(' ')}`) { $('#tw').style.setProperty('--cols', `22px ${gridCols().join(' ')}`); $('#thead').innerHTML = `<span></span>${visibleCols().map(([, l]) => `<span>${l}</span>`).join('')}`; lastRowsKey = ''; }
  const terms = highlightTerms(), show = k => vis.has(k);
  const key = `${start}|${end}|${S.filtered.length}|${S.filtered[start]?.id}|${S.cur}|${S.sel.size}|${S.filter.q}|${[...vis].join()}|${S.bookmarks.size}`;
  if (key === lastRowsKey) return;
  lastRowsKey = key;
  let html = '';
  for (let i = start; i < end; i++) {
    const e = S.filtered[i];
    const fl = (e.flags || []);
    const flags = `${S.bookmarks.has(e.id) ? '<span class="fl bm" title="Bookmarked">★</span>' : ''}${fl.includes('stack') ? '<span class="fl stack">stack</span>' : fl.includes('exception') ? '<span class="fl stack">exc</span>' : ''}${fl.includes('http-error') ? '<span class="fl http">http</span>' : ''}${fl.includes('repeated') ? '<span class="fl rep">repeat</span>' : ''}${fl.includes('slow') ? '<span class="fl slow">slow</span>' : ''}${e.redacted ? `<span class="fl red" title="${e.redacted} value(s) redacted">redacted</span>` : ''}`;
    html += `<div class="trow l-${e.level}${S.sel.has(e.id) ? ' sel' : ''}${S.cur === e.id ? ' cur' : ''}" data-id="${e.id}" style="top:${i * ROW}px" role="row" aria-selected="${S.cur === e.id}">
      <span class="selbox faint" title="Select (Ctrl/Cmd-click)">${S.sel.has(e.id) ? '☑' : '☐'}</span>
      ${show('time') ? `<span class="t" title="${esc(fmtFull(e.ts))}">${fmtClock(e.ts)}</span>` : ''}
      ${show('level') ? `<span class="lv ${e.level}">${e.level}</span>` : ''}
      ${show('source') ? `<span class="src"><i class="srcdot" style="background:${srcColor(e.source)}"></i>${esc(e.source)}</span>` : ''}
      ${show('feature') ? `<span class="feat" title="${esc(featLabel(e.feature))}">${esc(e.feature || '')}</span>` : ''}
      ${show('proc') ? `<span class="src">${esc(e.proc)}${e.pid != null ? ` <span class="faint">${e.pid}</span>` : ''}</span>` : ''}
      <span class="msg">${flags ? `<span class="flags">${flags}</span>` : ''}${mark(e.msg.split('\n')[0].slice(0, 400), terms)}</span>
      ${show('meta') ? `<span class="meta">${esc(metaText(e))}</span>` : ''}
    </div>`;
  }
  rows.innerHTML = html;
}
function renderActiveFilters() {
  const f = S.filter, chips = [];
  if (f.fp) chips.push(['fp', `error group: ${f.fpLabel.slice(0, 50)}`]);
  if (f.feature) chips.push(['feature', `feature: ${featLabel(f.feature)}`]);
  if (f.sources.length) chips.push(['sources', `source: ${f.sources.join(', ')}`]);
  if (f.proc) chips.push(['proc', `process: ${f.proc}`]);
  if (f.window !== 'all') chips.push(['window', `last ${f.window < 60 ? f.window + ' min' : f.window / 60 + 'h'}`]);
  $('#activeFilters').innerHTML = chips.map(([k, l]) => `<span class="tag brand" data-clear="${k}" title="Remove filter" role="button" tabindex="0">${esc(l)} ✕</span>`).join('');
  $$('[data-clear]').forEach(c => c.onclick = () => {
    const k = c.dataset.clear;
    setFilter(k === 'fp' ? { fp: null, fpLabel: '' } : k === 'sources' ? { sources: [] } : k === 'window' ? { window: 'all' } : { [k]: '' });
    VIEW.logs();
  });
}
function renderPinStrip() {
  const pins = [...S.bookmarks.values()].filter(b => b.pinned);
  $('#pinStrip').innerHTML = pins.length ? `<span class="faint">Pinned:</span>${pins.slice(0, 5).map(b => `<button class="btn sm" data-pin="${b.id}" title="${esc(b.event.msg.slice(0, 200))}">${icon('pin')} ${esc((b.note || b.event.msg).slice(0, 24))}</button>`).join('')}` : '';
  $$('[data-pin]').forEach(b => b.onclick = () => openDrawer(+b.dataset.pin));
}
function toggleSel(id) { S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); S.anchor = id; lastRowsKey = ''; renderRows(); renderSelInfo(); }
function selectRange(a, b) {
  const ia = S.filtered.findIndex(e => e.id === a), ib = S.filtered.findIndex(e => e.id === b);
  if (ia < 0 || ib < 0) return;
  for (let i = Math.min(ia, ib); i <= Math.max(ia, ib); i++) S.sel.add(S.filtered[i].id);
  lastRowsKey = ''; renderRows(); renderSelInfo();
}
function renderSelInfo() {
  const el = $('#selInfo'); if (!el) return;
  el.innerHTML = S.sel.size ? ` · <b>${S.sel.size}</b> selected <button class="btn sm ghost" id="clearSel">clear</button>` : '';
  $('#clearSel')?.addEventListener('click', () => { S.sel.clear(); lastRowsKey = ''; renderRows(); renderSelInfo(); });
}
function renderExportMenu() {
  const sel = S.events.filter(e => S.sel.has(e.id)), list = S.filtered;
  const opt = (label, act, n) => `<button data-exp="${act}" ${n ? '' : 'disabled style="opacity:.4"'}>${label} <span class="faint">${num(n)}</span></button>`;
  $('#exportPop').innerHTML = `${opt('Filtered → JSON', 'f:json', list.length)}${opt('Filtered → NDJSON', 'f:ndjson', list.length)}${opt('Filtered → CSV', 'f:csv', list.length)}<hr>
    ${opt('Selected → JSON', 's:json', sel.length)}${opt('Selected → CSV', 's:csv', sel.length)}${opt('Copy selected as Markdown', 's:md', sel.length)}${opt('Bookmark selected', 's:bm', sel.length)}
    <hr><p class="faint" style="padding:4px 10px;font-size:11.5px;max-width:240px">Exports contain only redacted data. Review before sharing outside your team.</p>`;
  $$('[data-exp]').forEach(b => b.onclick = async () => {
    const [scope, fmt] = b.dataset.exp.split(':');
    const items = scope === 'f' ? list : sel;
    if (!items.length) return;
    $('#exportPop').hidden = true;
    if (fmt === 'bm') { for (const e of items) await saveBookmark(e, { note: '', pinned: false }, true); toast(`Bookmarked ${items.length} events`); return; }
    if (fmt === 'md') return copy(toMarkdown(items), `Copied ${items.length} events as Markdown`);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
    const clean = items.map(({ _h, _hl, ...e }) => e);
    if (fmt === 'json') download(`pillpal-debug-${stamp}.json`, JSON.stringify(clean, null, 2));
    if (fmt === 'ndjson') download(`pillpal-debug-${stamp}.ndjson`, clean.map(e => JSON.stringify(e)).join('\n'), 'application/x-ndjson');
    if (fmt === 'csv') download(`pillpal-debug-${stamp}.csv`, toCsv(clean), 'text/csv');
  });
}
function toCsv(list) {
  const cols = ['id', 'time', 'level', 'source', 'feature', 'proc', 'pid', 'requestId', 'traceId', 'sessionId', 'msg', 'meta'];
  const q = v => { const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...list.map(e => cols.map(c => q(c === 'time' ? new Date(e.ts).toISOString() : e[c])).join(','))].join('\n');
}
function toMarkdown(list) {
  return `**PillPal debug events** (${list.length}, redacted)\n\n| Time | Level | Feature | Source | Message |\n|---|---|---|---|---|\n${list.map(e => `| ${new Date(e.ts).toISOString()} | ${e.level} | ${e.feature || ''} | ${e.source} | ${e.msg.split('\n')[0].replace(/\|/g, '\\|').slice(0, 200)} |`).join('\n')}\n`;
}

// ===== Drawer (event detail) =====
function closeDrawer() { const d = $('#drawer'); d.hidden = true; d.innerHTML = ''; S.cur = null; lastRowsKey = ''; renderRows(); if (location.hash.includes('?ev=')) history.replaceState(null, '', '#' + S.view); }
async function openDrawer(id) {
  let e = S.byId.get(id) || S.bookmarks.get(id)?.event;
  if (!e) { try { e = await api('/events/' + id); } catch { return toast('That event is no longer in memory', true); } }
  S.cur = id; lastRowsKey = ''; renderRows();
  const d = $('#drawer');
  d.hidden = false;
  const bm = S.bookmarks.get(id);
  const related = relatedOf(e);
  const kv = [['Time', `${fmtFull(e.ts)} <span class="faint">(${ago(e.ts)})</span>`], ['Level', `<span class="lv ${e.level}">${e.level}</span>`], ['Source', link('source', e.source)], ['Feature', e.feature ? link('feature', e.feature, featLabel(e.feature)) : '—'],
    ['Process', `${link('proc', e.proc)}${e.pid != null ? ` · pid ${e.pid}` : ''}`], ['Kind', esc(e.kind || '—')], ['Request ID', e.requestId ? link('requestId', e.requestId) : '—'], ['Trace ID', e.traceId ? link('traceId', e.traceId) : '—'],
    ['Session', e.sessionId ? link('sessionId', e.sessionId) : '—'], ['User (hashed)', e.userHash ? link('userHash', e.userHash) : '—'], ['Tags', (e.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join(' ') || '—'],
    ['Detected', (e.flags || []).map(t => `<span class="tag ${t === 'repeated' || t === 'stack' || t === 'exception' ? 'err' : 'warn'}">${esc(t)}</span>`).join(' ') || '—'], ['Redacted', e.redacted ? `<span class="tag lock">${e.redacted} value${e.redacted > 1 ? 's' : ''}</span>` : 'nothing'], ['Event ID', e.id]];
  d.innerHTML = `<div class="dh"><span class="lv ${e.level}">${e.level}</span><h2 id="drawerTitle" class="grow" style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.msg.split('\n')[0].slice(0, 120))}</h2>
      <button class="btn sm ghost" data-d="prev" title="Previous (K)">↑</button><button class="btn sm ghost" data-d="next" title="Next (J)">↓</button><button class="btn sm ghost" data-d="close" aria-label="Close (Esc)">${icon('x')}</button></div>
    <div class="db">
      <section><h3>Message</h3><div class="msgbox"><pre>${mark(e.msg, highlightTerms())}</pre></div></section>
      ${e.stack ? `<section><h3>Stack trace</h3><div class="stacktrace"><pre>${stackHtml(e.stack)}</pre></div></section>` : ''}
      <section><h3>Fields</h3><dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></section>
      ${e.meta ? `<section><h3>Metadata</h3><div class="json"><pre>${jsonHtml(e.meta)}</pre></div></section>` : ''}
      ${related.length > 1 ? `<section><h3>Correlated by ${related.field}${related.field === 'sessionId' ? ' (±20 s)' : ''} · ${related.length} events</h3>${waterfall(related, e.id)}<div class="row" style="margin-top:8px"><button class="btn sm" data-d="corr">Open in Correlate</button><button class="btn sm" data-d="corrlogs">Show in Logs</button></div></section>` : ''}
      <section><h3>Bookmark &amp; note</h3>
        <textarea id="bmNote" rows="3" placeholder="What did you find? (saved locally)" style="width:100%">${esc(bm?.note || '')}</textarea>
        <div class="row" style="margin-top:6px"><button class="btn sm primary" data-d="bm">${icon('bookmarks')} ${bm ? 'Update bookmark' : 'Bookmark'}</button>
          <label class="check"><input type="checkbox" id="bmPin" ${bm?.pinned ? 'checked' : ''}> Pin to Logs</label>
          ${bm ? `<button class="btn sm danger" data-d="unbm">Remove</button>` : ''}</div></section>
      <section><h3>Actions</h3><div class="row">
        <button class="btn sm" data-d="json">${icon('copy')} Copy JSON</button><button class="btn sm" data-d="md">${icon('copy')} Copy Markdown</button><button class="btn sm" data-d="link">${icon('link')} Copy link</button>
        <button class="btn sm" data-d="src">Open log source</button>${levelNum(e.level) >= 3 ? '<button class="btn sm" data-d="similar">Find similar</button>' : ''}
        <button class="btn sm" data-d="around">±30 s around this</button></div></section>
    </div>`;
  lastRowsKey = ''; renderRows(); // the table just got narrower
  d.onclick = async ev => {
    const b = ev.target.closest('[data-d],[data-link]');
    if (!b) { const w = ev.target.closest('.wf-row'); if (w) openDrawer(+w.dataset.id); return; }
    if (b.dataset.link) { const [k, v] = [b.dataset.link, b.dataset.v]; return k === 'source' ? go('logs', { sources: [v] }) : k === 'feature' ? go('logs', { feature: v }) : k === 'proc' ? go('logs', { proc: v }) : go('logs', { q: `${k}:${v}` }); }
    const a = b.dataset.d;
    if (a === 'close') closeDrawer();
    else if (a === 'next' || a === 'prev') step(a === 'next' ? 1 : -1);
    else if (a === 'json') copy(JSON.stringify((({ _h, _hl, ...x }) => x)(e), null, 2), 'Event copied as JSON');
    else if (a === 'md') copy(toMarkdown([e]) + (e.stack ? `\n\`\`\`\n${e.stack}\n\`\`\`\n` : '') + (e.meta ? `\n\`\`\`json\n${JSON.stringify(e.meta, null, 2)}\n\`\`\`\n` : ''), 'Event copied as Markdown');
    else if (a === 'link') copy(`${location.origin}/debug#logs?ev=${e.id}`, 'Link copied (works on this computer only)');
    else if (a === 'src') go('logs', { sources: [e.source] });
    else if (a === 'similar') go('logs', { fp: fingerprint(e), fpLabel: e.msg.split('\n')[0], levels: ['warn', 'error', 'fatal'] });
    else if (a === 'around') { setFilter({ ...DEFAULT_FILTER, levels: [...LEVELS], q: '' }); go('logs'); setTimeout(() => scrollToEvent(e.id), 50); }
    else if (a === 'corr') { S.corrField = related.field; S.corrSel = String(related.value); LS.set('corrField', S.corrField); go('correlate'); }
    else if (a === 'corrlogs') go('logs', { q: `${related.field.replace('Id', '')}:${related.value}`, levels: [...LEVELS] });
    else if (a === 'bm') { await saveBookmark(e, { note: $('#bmNote').value, pinned: $('#bmPin').checked }); openDrawer(e.id); }
    else if (a === 'unbm') { await api('/bookmarks/' + e.id, { method: 'DELETE' }); S.bookmarks.delete(e.id); renderBadges(); toast('Bookmark removed'); openDrawer(e.id); if (S.view === 'bookmarks') VIEW.bookmarks(); }
  };
}
const link = (k, v, label) => `<button class="linkish" data-link="${esc(k)}" data-v="${esc(v)}" title="Filter by ${esc(k)}">${esc(label || v)}</button>`;
function step(dir) {
  const list = S.view === 'logs' ? S.filtered : S.events;
  const i = list.findIndex(x => x.id === S.cur);
  const n = list[i + dir] || (i < 0 ? list.at(-1) : null);
  if (n) { openDrawer(n.id); if (S.view === 'logs') scrollToEvent(n.id, true); }
}
function scrollToEvent(id, soft) {
  const i = S.filtered.findIndex(x => x.id === id), w = $('#tw');
  if (i < 0 || !w) return;
  const y = i * ROW;
  if (soft && y > w.scrollTop && y < w.scrollTop + w.clientHeight - ROW * 3) return;
  S.follow = false;
  w.scrollTop = Math.max(0, y - w.clientHeight / 2);
  renderRows();
}
async function saveBookmark(e, { note, pinned }, quiet) {
  const clean = (({ _h, _hl, ...x }) => x)(e);
  const b = await api('/bookmarks/' + e.id, { method: 'PUT', body: { note, pinned, event: clean } });
  S.bookmarks.set(e.id, b);
  renderBadges(); lastRowsKey = ''; renderRows(); if ($('#pinStrip')) renderPinStrip();
  if (!quiet) toast(pinned ? 'Bookmarked and pinned' : 'Bookmarked');
}
function stackHtml(stack) {
  return stack.split('\n').map((l, i) => {
    const app = /\bat\b/.test(l) && !/node_modules|node:internal|\(node:|<anonymous>/.test(l);
    return `<span class="${i === 0 ? 'head' : app ? 'app' : ''}">${esc(l)}</span>`;
  }).join('\n');
}
function jsonHtml(v, ind = 0) {
  const pad2 = '  '.repeat(ind + 1), end = '  '.repeat(ind);
  if (v === null) return '<span class="b">null</span>';
  if (typeof v === 'string') return v === '[REDACTED]' || v.startsWith('[REDACTED') ? `<span class="r">"${esc(v)}"</span>` : `<span class="s">"${esc(v)}"</span>`;
  if (typeof v === 'number') return `<span class="n">${v}</span>`;
  if (typeof v === 'boolean') return `<span class="b">${v}</span>`;
  if (Array.isArray(v)) return v.length ? `[\n${v.map(x => pad2 + jsonHtml(x, ind + 1)).join(',\n')}\n${end}]` : '[]';
  const ks = Object.keys(v);
  return ks.length ? `{\n${ks.map(k => `${pad2}<span class="k">"${esc(k)}"</span>: ${jsonHtml(v[k], ind + 1)}`).join(',\n')}\n${end}}` : '{}';
}
function relatedOf(e) {
  for (const field of ['traceId', 'requestId', 'sessionId']) {
    const v = e[field];
    if (!v) continue;
    // A browser session can span hours; show only what happened within 20 s of this event.
    const near = field === 'sessionId' ? x => Math.abs(x.ts - e.ts) <= 20e3 : () => true;
    const list = S.events.filter(x => x[field] === v && near(x));
    if (list.length > 1) return Object.assign(list.slice(-300), { field, value: v });
  }
  return Object.assign([], { field: '', value: '' });
}
function waterfall(list, curId) {
  const items = list.map(e => ({ e, end: e.ts, start: e.ts - (+e.meta?.durationMs || 0) })).sort((a, b) => a.start - b.start || a.e.id - b.e.id);
  const t0 = Math.min(...items.map(i => i.start)), t1 = Math.max(...items.map(i => i.end)), span = Math.max(1, t1 - t0);
  return `<div class="wf" role="list">${items.map(({ e, start, end }) => {
    const l = ((start - t0) / span) * 100, w = ((end - start) / span) * 100;
    return `<div class="wf-row" data-id="${e.id}" role="listitem" title="${esc(e.msg.slice(0, 300))}" style="${e.id === curId ? 'background:var(--brand-soft)' : ''}">
      <span class="lab"><i class="srcdot" style="background:${srcColor(e.source)}"></i>${esc(e.source)} · ${esc(e.msg.split('\n')[0].slice(0, 60))}</span>
      <span class="track">${end > start ? `<span class="bar" style="left:${l.toFixed(2)}%;width:${Math.max(.6, w).toFixed(2)}%;background:${levelNum(e.level) >= 4 ? LVC.error : srcColor(e.source)}"></span>` : `<span class="pt" style="left:${l.toFixed(2)}%;background:${levelNum(e.level) >= 4 ? LVC.error : srcColor(e.source)}"></span>`}</span>
      <span class="ms">${end > start ? dur(end - start) : '+' + dur(start - t0)}</span></div>`;
  }).join('')}</div><p class="faint" style="font-size:11px;margin-top:4px">Total span ${dur(span)} · bars are timed operations (request, DB, outbound, browser API), dots are instant events.</p>`;
}

// ===== Errors =====
VIEW.errors = () => {
  page('Error summary', 'Problems grouped by fingerprint (ids, numbers and quoted values stripped), with counts, first and last seen, frequency and what they touched. Select one to see every occurrence.',
    `<input type="search" id="errQ" placeholder="Filter groups" value="${esc(S.errQ)}" aria-label="Filter error groups">
     <select id="errSort" aria-label="Sort">${[['last', 'Most recent'], ['count', 'Most frequent'], ['rate', 'Highest rate'], ['first', 'Oldest first']].map(([v, l]) => `<option value="${v}" ${S.errSort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
     <label class="check"><input type="checkbox" id="errWarn" ${S.errWarn ? 'checked' : ''}> Include warnings</label>`,
    `<div class="card" style="padding:0"><div class="scroll-box" style="border:0;max-height:none"><table class="t"><thead><tr><th>Level</th><th>Problem</th><th style="text-align:right">Count</th><th style="text-align:right">Last 5 min</th><th style="text-align:right">Per min</th><th>First seen</th><th>Last seen</th><th>Affected</th></tr></thead><tbody id="errRows"></tbody></table></div></div>`);
  $('#errQ').oninput = e => { S.errQ = e.target.value; renderErrorRows(); };
  $('#errSort').onchange = e => { S.errSort = e.target.value; renderErrorRows(); };
  $('#errWarn').onchange = e => { S.errWarn = e.target.checked; LS.set('errWarn', S.errWarn); renderErrorRows(); };
  $('#errRows').onclick = e => {
    const r = e.target.closest('tr[data-fp]'); if (!r) return;
    if (e.target.closest('[data-sample]')) return openDrawer(+e.target.closest('[data-sample]').dataset.sample);
    const g = S.summary.errors.find(x => x.fp === r.dataset.fp);
    go('logs', { fp: g.fp, fpLabel: g.msg, levels: ['warn', 'error', 'fatal'] });
  };
  renderErrorRows();
};
function renderErrorRows() {
  const tb = $('#errRows'); if (!tb || !S.summary) return;
  const q = S.errQ.toLowerCase();
  let list = S.summary.errors.filter(g => (S.errWarn || levelNum(g.level) >= 4) && (!q || `${g.msg} ${g.feature} ${g.source}`.toLowerCase().includes(q)));
  const sorters = { last: (a, b) => b.last - a.last, count: (a, b) => b.count - a.count, rate: (a, b) => b.perMin - a.perMin, first: (a, b) => a.first - b.first };
  list = list.sort(sorters[S.errSort]);
  tb.innerHTML = list.length ? list.map(g => `<tr class="click" data-fp="${esc(g.fp)}">
    <td><span class="lv ${g.level}">${g.level}</span></td>
    <td style="max-width:520px"><div class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(g.msg)}">${esc(g.msg)}</div>
      <div class="row" style="margin-top:3px;gap:4px">${g.repeating ? '<span class="tag err">repeating</span>' : ''}<span class="tag">${esc(g.source)}</span>${g.feature ? `<span class="tag brand">${esc(featLabel(g.feature))}</span>` : ''}<button class="btn sm ghost" data-sample="${g.lastId}">latest ›</button></div></td>
    <td class="num"><b>${num(g.count)}</b></td><td class="num" style="${g.last5m ? 'color:var(--l-error)' : ''}">${g.last5m}</td><td class="num">${g.perMin}</td>
    <td class="mono faint" title="${esc(fmtFull(g.first))}">${ago(g.first)}</td><td class="mono" title="${esc(fmtFull(g.last))}">${ago(g.last)}</td>
    <td style="font-size:12px">${Object.entries(g.procs).map(([p, n]) => `<span class="tag">${esc(p)} ×${n}</span>`).join(' ')}</td></tr>`).join('')
    : `<tr><td colspan="8"><div class="empty"><img src="/icon.svg" width="42" height="42" alt=""><h2>No ${S.errWarn ? 'errors or warnings' : 'errors'} recorded</h2><p>Nice. Problems from the server, database, outbound calls and browser tabs will group here.</p></div></td></tr>`;
}

// ===== Correlate =====
VIEW.correlate = () => {
  const fields = [...new Set([...(S.settings?.correlationFields || []), S.corrField])];
  page('Correlation', 'Group related events by a shared field. A trace ID follows one action from the browser through the API, MongoDB and outbound calls, so you can see where the time went.',
    `<label class="check"><span class="muted">Group by</span><select id="corrField">${fields.map(f => `<option ${f === S.corrField ? 'selected' : ''}>${esc(f)}</option>`).join('')}<option value="__custom">Custom field…</option></select></label>`,
    `<div class="split"><div class="col" style="display:flex;flex-direction:column;gap:8px"><input type="search" id="corrQ" placeholder="Filter values" value="${esc(S.corrQ)}" aria-label="Filter groups"><div class="glist" id="glist"></div></div><section class="card" id="corrDetail" style="min-width:0"></section></div>`);
  $('#corrField').onchange = e => {
    let v = e.target.value;
    if (v === '__custom') { v = prompt('Field to group by (for example meta.service or meta.route):', 'meta.route'); if (!v || !/^[\w.]{1,60}$/.test(v)) return VIEW.correlate(); }
    S.corrField = v; S.corrSel = null; LS.set('corrField', v); VIEW.correlate();
  };
  $('#corrQ').oninput = e => { S.corrQ = e.target.value; renderCorrGroups(); };
  $('#glist').onclick = e => { const b = e.target.closest('[data-g]'); if (b) { S.corrSel = b.dataset.g; renderCorrGroups(); } };
  $('#corrDetail').onclick = e => { const r = e.target.closest('.wf-row'); if (r) openDrawer(+r.dataset.id); const b = e.target.closest('[data-corrlogs]'); if (b) go('logs', { q: `${S.corrField}:"${S.corrSel}"`, levels: [...LEVELS] }); };
  renderCorrGroups();
};
function corrValue(e, f) { const v = f.startsWith('meta.') ? f.slice(5).split('.').reduce((o, k) => o?.[k], e.meta) : e[f]; return v == null || v === '' || typeof v === 'object' ? null : String(v); }
function renderCorrGroups() {
  const gl = $('#glist'); if (!gl) return;
  const f = S.corrField, groups = new Map();
  for (const e of S.events) {
    const v = corrValue(e, f); if (v == null) continue;
    let g = groups.get(v);
    if (!g) groups.set(v, (g = { v, n: 0, err: 0, warn: 0, first: e.ts, last: e.ts, feats: new Set(), srcs: new Set(), dur: 0 }));
    g.n++; g.last = Math.max(g.last, e.ts); g.first = Math.min(g.first, e.ts - (+e.meta?.durationMs || 0));
    if (levelNum(e.level) >= 4) g.err++; else if (e.level === 'warn') g.warn++;
    if (e.feature) g.feats.add(e.feature); g.srcs.add(srcKey(e.source));
  }
  const q = S.corrQ.toLowerCase();
  const list = [...groups.values()].filter(g => !q || g.v.toLowerCase().includes(q) || [...g.feats].some(x => x.includes(q))).sort((a, b) => b.last - a.last);
  gl.innerHTML = list.length ? list.slice(0, 300).map(g => `<button class="gitem" data-g="${esc(g.v)}" aria-current="${g.v === S.corrSel}">
      <div class="gv">${g.err ? '<span style="color:var(--l-error)">●</span> ' : g.warn ? '<span style="color:var(--l-warn)">●</span> ' : ''}${esc(f === 'feature' ? featLabel(g.v) : g.v)}</div>
      <div class="gm"><span>${g.n} events</span><span>${dur(g.last - g.first)}</span>${g.err ? `<span style="color:var(--l-error)">${g.err} errors</span>` : ''}<span>${esc([...g.feats].slice(0, 3).join(', '))}</span><span>${ago(g.last)}</span></div></button>`).join('')
    + (list.length > 300 ? `<p class="faint" style="padding:6px">${list.length - 300} more. Narrow with the filter.</p>` : '')
    : `<div class="empty">No events carry <code>${esc(f)}</code> yet.</div>`;
  if (!S.corrSel && list[0]) S.corrSel = list[0].v;
  const det = $('#corrDetail'), sel = groups.get(S.corrSel);
  if (!sel) { det.innerHTML = '<p class="muted">Pick a group on the left.</p>'; return; }
  const evs = S.events.filter(e => corrValue(e, f) === S.corrSel).slice(-400);
  det.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:10px"><div><h2 class="mono" style="word-break:break-all">${esc(f)} = ${esc(S.corrSel)}</h2>
    <p class="muted" style="font-size:12px">${sel.n} events · ${dur(sel.last - sel.first)} · sources: ${esc([...sel.srcs].join(', '))} · features: ${esc([...sel.feats].map(featLabel).join(', ') || '—')}</p></div>
    <button class="btn sm" data-corrlogs>Show in Logs</button></div>${waterfall(evs)}`;
}

// ===== Processes =====
let procTimer;
VIEW.processes = () => {
  page('Processes', 'PillPal\'s own processes (server, embedded MongoDB, browser tabs, tasks launched here) and, if you turn it on, everything the OS lets this user see. Read-only by default; nothing is elevated.',
    `<label class="check"><input type="checkbox" id="procAll" ${S.procAll ? 'checked' : ''}> Show all processes</label><button class="btn sm" id="procRefresh">${icon('refresh')} Refresh</button>`,
    `<section class="card"><h2>PillPal</h2><div id="appProcs"><p class="muted">Loading…</p></div></section>
     <section class="card"><div class="row" style="justify-content:space-between"><h2>Tasks</h2><span class="faint" style="font-size:12px">npm scripts from package.json. Output streams into Logs. Debug Station only starts what is listed here.</span></div><div id="tasks"></div></section>
     <section class="card" id="sysCard" ${S.procAll ? '' : 'hidden'}>
       <div class="row" style="justify-content:space-between;margin-bottom:8px"><h2>All processes</h2>
         <div class="row"><input type="search" id="procQ" placeholder="Name, PID or command" value="${esc(S.procQ)}" aria-label="Filter processes">
           <select id="procGroup" aria-label="Group">${[['none', 'No grouping'], ['name', 'Group by name'], ['tree', 'Tree (parent → child)']].map(([v, l]) => `<option value="${v}" ${S.procGroup === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
           <select id="procStatus" aria-label="Status"><option value="">Any status</option>${['running', 'stopped', 'crashed', 'inaccessible'].map(s => `<option>${s}</option>`).join('')}</select></div></div>
       <div id="sysProcs" class="scroll-box"></div>
     </section>`);
  $('#procAll').onchange = e => { S.procAll = e.target.checked; LS.set('procAll', S.procAll); $('#sysCard').hidden = !S.procAll; loadProcs(); };
  $('#procRefresh').onclick = loadProcs;
  $('#procQ').oninput = e => { S.procQ = e.target.value; renderSys(); };
  $('#procGroup').onchange = e => { S.procGroup = e.target.value; LS.set('procGroup', S.procGroup); renderSys(); };
  $('#procStatus').onchange = renderSys;
  $('#view').onclick = procClick;
  loadProcs();
  procTimer = setInterval(() => { if (!document.hidden) loadProcs(); }, 5000);
};
async function loadProcs() {
  try { S.procs = await api('/processes' + (S.procAll ? '?all=1' : '')); }
  catch (e) { if ($('#appProcs')) $('#appProcs').innerHTML = `<p class="error-text">${esc(e.message)}</p>`; return; }
  if (S.view !== 'processes') return;
  renderAppProcs(); renderTasks(); if (S.procAll) renderSys();
}
const STATUS_WORD = { running: 'active', stopped: 'stopped', crashed: 'crashed', inaccessible: 'limited access' };
function renderAppProcs() {
  const list = S.procs.app.sort((a, b) => (a.kind === 'browser') - (b.kind === 'browser') || (a.status !== 'running') - (b.status !== 'running'));
  $('#appProcs').innerHTML = `<table class="t"><thead><tr><th>Name</th><th>Status</th><th style="text-align:right">PID</th><th style="text-align:right">Parent</th><th style="text-align:right">CPU</th><th style="text-align:right">Memory</th><th style="text-align:right">Uptime</th><th style="text-align:right">Errors</th><th>Details</th><th></th></tr></thead><tbody>${list.map(p => `
    <tr class="pp"><td><b>${esc(p.name)}</b><div class="faint" style="font-size:11.5px">${esc(p.kind === 'browser' ? `${p.page || ''} · session ${p.sessionId}` : p.role || '')}</div></td>
    <td><span class="status ${p.status}">${STATUS_WORD[p.status] || p.status}</span>${p.exitCode != null && p.status !== 'running' ? `<div class="faint mono" style="font-size:11px">exit ${esc(p.signal || p.exitCode)}</div>` : ''}</td>
    <td class="num">${p.pid ?? '—'}</td><td class="num">${p.ppid ?? '—'}</td><td class="num">${p.cpu != null ? p.cpu + '%' : '—'}</td><td class="num">${bytes(p.mem)}</td>
    <td class="num">${p.kind === 'browser' ? (p.status === 'running' ? `seen ${ago(p.lastSeen)}` : `closed ${ago(p.endedAt || p.lastSeen)}`) : dur(p.uptime)}</td>
    <td class="num" style="${p.errors ? 'color:var(--l-error)' : ''}">${p.errors}</td>
    <td class="cmd" title="${esc(p.kind === 'browser' ? p.role : p.cmd)}">${esc(p.kind === 'browser' ? p.role : p.cmd || '')}</td>
    <td><div class="row" style="flex-wrap:nowrap">${p.logSource ? `<button class="btn sm" data-logs="${esc(p.kind === 'browser' ? 'session:' + p.sessionId : p.logSource)}">Logs</button>` : ''}${p.pid ? `<button class="btn sm ghost" data-copy="${p.pid}" title="Copy PID">${icon('copy')}</button>` : ''}</div></td></tr>`).join('')}</tbody></table>`;
}
function renderTasks() {
  const t = S.procs.tasks;
  $('#tasks').innerHTML = t.length ? `<table class="t"><tbody>${t.map(x => {
    const p = S.procs.app.find(a => a.key === 'task:' + x.name);
    return `<tr><td class="mono"><b>${esc(x.cmd)}</b><div class="faint">${esc(x.script)}</div></td><td>${p ? `<span class="status ${p.status}">${STATUS_WORD[p.status] || p.status}</span>` : '<span class="status idle">not run</span>'}</td>
      <td style="text-align:right"><div class="row" style="justify-content:flex-end">${x.running ? `<button class="btn sm" data-task="stop" data-name="${esc(x.name)}">${icon('stop')} Stop</button><button class="btn sm" data-task="restart" data-name="${esc(x.name)}">${icon('refresh')} Restart</button>` : `<button class="btn sm primary" data-task="run" data-name="${esc(x.name)}">${icon('play2')} Run</button>`}
      ${p ? `<button class="btn sm" data-logs="task:${esc(x.name)}">Logs</button>` : ''}</div></td></tr>`;
  }).join('')}</tbody></table>` : '<p class="muted">No npm scripts besides start. Add one to package.json and it appears here.</p>';
}
function renderSys() {
  const box = $('#sysProcs'); if (!box) return;
  if (!S.procs?.system) { box.innerHTML = `<p class="${S.procs?.systemError ? 'error-text' : 'muted'}" style="padding:12px">${esc(S.procs?.systemError || 'Loading the process list (first load can take a few seconds on Windows)…')}</p>`; return; }
  const q = S.procQ.toLowerCase(), st = $('#procStatus')?.value;
  let list = S.procs.system.filter(p => (!q || `${p.name} ${p.pid} ${p.cmd || ''}`.toLowerCase().includes(q)) && (!st || p.status === st));
  const { k, dir } = S.procSort, val = p => k === 'started' ? p.started || 0 : k === 'name' ? p.name.toLowerCase() : p[k] ?? -1;
  list.sort((a, b) => (S.pinnedPids.has(b.pid) - S.pinnedPids.has(a.pid)) || (!!b.app - !!a.app) || (val(a) > val(b) ? dir : val(a) < val(b) ? -dir : 0));
  if (S.procGroup === 'name') {
    const g = new Map();
    for (const p of list) { const x = g.get(p.name) || { ...p, n: 0, cpu: 0, mem: 0, pids: [] }; x.n++; x.cpu += p.cpu || 0; x.mem += p.mem || 0; x.pids.push(p.pid); g.set(p.name, x); }
    list = [...g.values()].sort((a, b) => (val(a) > val(b) ? dir : -dir));
  } else if (S.procGroup === 'tree') {
    const kids = new Map(), byPid = new Map(list.map(p => [p.pid, p]));
    for (const p of list) { const par = byPid.has(p.ppid) && p.ppid !== p.pid ? p.ppid : 0; (kids.get(par) || kids.set(par, []).get(par)).push(p); }
    const out = [], walk = (pid, depth) => { for (const c of kids.get(pid) || []) { if (out.length > 3000) return; out.push({ ...c, depth }); walk(c.pid, depth + 1); } };
    walk(0, 0); list = out;
  }
  const th = (key, label, right) => `<th style="${right ? 'text-align:right' : ''}"><button data-sort="${key}">${label}${S.procSort.k === key ? (S.procSort.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`;
  const shown = list.slice(0, 1500);
  box.innerHTML = `<table class="t"><thead><tr><th></th>${th('name', 'Name')}${th('pid', 'PID', 1)}${th('ppid', 'Parent', 1)}${th('cpu', 'CPU', 1)}${th('mem', 'Memory', 1)}<th>Status</th>${th('started', 'Started')}<th>Command line</th><th></th></tr></thead><tbody>${shown.map(p => `
    <tr class="click ${p.app ? 'pp' : ''} ${S.pinnedPids.has(p.pid) ? 'pinned' : ''}" data-pid="${p.pid}">
      <td><button class="btn sm ghost" data-pinpid="${p.pid}" title="${S.pinnedPids.has(p.pid) ? 'Unpin' : 'Pin to top'}" style="color:${S.pinnedPids.has(p.pid) ? 'var(--sun)' : 'var(--ink-3)'}">${icon('pin')}</button></td>
      <td style="padding-left:${8 + (p.depth || 0) * 14}px"><b>${esc(p.name)}</b>${p.n > 1 ? ` <span class="tag">×${p.n}</span>` : ''}${p.app ? ` <span class="tag brand">${esc(p.app === 'child' ? 'PillPal child' : 'PillPal')}</span>` : ''}</td>
      <td class="num">${p.n > 1 ? '—' : p.pid}</td><td class="num">${p.n > 1 ? '—' : p.ppid ?? '—'}</td><td class="num">${p.cpu != null ? (+p.cpu).toFixed(1) + '%' : '…'}</td><td class="num">${bytes(p.mem)}</td>
      <td><span class="status ${p.status}">${STATUS_WORD[p.status] || p.status}</span></td><td class="mono faint" style="font-size:11.5px">${p.started ? ago(p.started) : '—'}</td>
      <td class="cmd" title="${esc(p.cmd || 'Not visible to this user')}">${p.cmd ? esc(p.cmd) : '<span class="faint">not visible to this user</span>'}</td>
      <td><button class="btn sm ghost" data-copy="${p.pid}" title="Copy PID">${icon('copy')}</button></td></tr>`).join('')}</tbody></table>
    ${list.length > shown.length ? `<p class="faint" style="padding:8px">${list.length - shown.length} more. Narrow with the filter.</p>` : ''}
    <p class="faint" style="padding:8px 10px;font-size:11.5px">${list.length} processes · CPU is averaged between refreshes · ${S.procs.platform === 'win32' ? 'from Windows CIM (Win32_Process)' : 'from ps'}. "Limited access" means the OS hides details from this user; Debug Station does not try to get around that.</p>`;
}
async function procClick(e) {
  const b = e.target.closest('button');
  if (b?.dataset.sort) { const k = b.dataset.sort; S.procSort = { k, dir: S.procSort.k === k ? -S.procSort.dir : k === 'name' ? 1 : -1 }; LS.set('procSort', S.procSort); return renderSys(); }
  if (b?.dataset.copy) return copy(b.dataset.copy, `PID ${b.dataset.copy} copied`);
  if (b?.dataset.pinpid) { const p = +b.dataset.pinpid; S.pinnedPids.has(p) ? S.pinnedPids.delete(p) : S.pinnedPids.add(p); LS.set('pinnedPids', [...S.pinnedPids]); return renderSys(); }
  if (b?.dataset.logs) { const v = b.dataset.logs; return v.startsWith('session:') ? go('logs', { q: `session:${v.slice(8)}`, levels: [...LEVELS] }) : go('logs', { sources: [v] }); }
  if (b?.dataset.task) {
    try { await api(`/tasks/${encodeURIComponent(b.dataset.name)}/${b.dataset.task}`, { method: 'POST', body: {} }); toast(`${b.dataset.task === 'run' ? 'Started' : b.dataset.task === 'stop' ? 'Stopping' : 'Restarting'} npm run ${b.dataset.name}`); setTimeout(loadProcs, 400); }
    catch (x) { toast(x.message, true); }
    return;
  }
  const r = e.target.closest('tr[data-pid]');
  if (r && !b) procDetail(+r.dataset.pid);
}
function procDetail(pid) {
  const p = S.procs.system?.find(x => x.pid === pid);
  if (!p) return;
  const dlg = $('#dlg');
  const errs = S.events.filter(e => e.pid === pid).length;
  dlg.innerHTML = `<div class="dlg"><h2>${esc(p.name)} <span class="faint mono">pid ${p.pid}</span></h2>
    <dl class="kv"><dt>Status</dt><dd><span class="status ${p.status}">${STATUS_WORD[p.status] || p.status}</span>${p.rawStat ? ` (${esc(p.rawStat)})` : ''}</dd><dt>Parent PID</dt><dd>${p.ppid ?? '—'}</dd><dt>CPU</dt><dd>${p.cpu != null ? p.cpu + '%' : '—'}</dd><dt>Memory</dt><dd>${bytes(p.mem)}</dd>
      <dt>Started</dt><dd>${p.started ? esc(fmtFull(p.started)) : '—'}</dd>${p.user ? `<dt>User</dt><dd>${esc(p.user)}</dd>` : ''}${p.path ? `<dt>Executable</dt><dd>${esc(p.path)}</dd>` : ''}<dt>Command line</dt><dd>${esc(p.cmd || 'Not visible to this user')}</dd><dt>Log events</dt><dd>${errs} in Debug Station</dd></dl>
    <div class="actions"><button class="btn" data-x="copy">Copy PID</button>${errs ? '<button class="btn" data-x="logs">Show logs</button>' : ''}
      ${S.procs.canKill && !p.app ? '<button class="btn danger" data-x="kill">End process…</button>' : ''}<button class="btn primary" data-x="close">Close</button></div>
    ${!S.procs.canKill ? '<p class="faint" style="font-size:11.5px">Ending processes is turned off. You can turn it on under Privacy &amp; rules → Safety.</p>' : p.app ? '<p class="faint" style="font-size:11.5px">PillPal\'s own server and database can\'t be ended from here.</p>' : ''}</div>`;
  dlg.onclick = async ev => {
    const x = ev.target.closest('[data-x]')?.dataset.x;
    if (x === 'close') dlg.close();
    if (x === 'copy') copy(String(p.pid), 'PID copied');
    if (x === 'logs') { dlg.close(); go('logs', { q: `pid:${p.pid}`, levels: [...LEVELS] }); }
    if (x === 'kill') killDialog(p);
  };
  dlg.showModal();
}
function killDialog(p) {
  const dlg = $('#dlg');
  dlg.innerHTML = `<form method="dialog" class="dlg"><h2>End ${esc(p.name)}?</h2>
    <p class="note danger">This ends process <b>${p.pid}</b> immediately. Unsaved work in it is lost. Debug Station uses this user's permissions only.</p>
    <label class="field"><span>Type <code>${esc(p.name)}</code> to confirm</span><input id="killConfirm" autocomplete="off" spellcheck="false"></label>
    <p class="error-text" id="killErr" hidden></p>
    <div class="actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn danger" id="killGo" disabled type="button">End process</button></div></form>`;
  const inp = $('#killConfirm'), go2 = $('#killGo');
  inp.oninput = () => { go2.disabled = inp.value !== p.name; };
  go2.onclick = async () => {
    try { await api('/processes/kill', { method: 'POST', body: { pid: p.pid, confirm: inp.value } }); dlg.close(); toast(`Ended ${p.name} (${p.pid})`); loadProcs(); }
    catch (x) { const el = $('#killErr'); el.hidden = false; el.textContent = x.message; }
  };
  dlg.onclick = null;
  if (!dlg.open) dlg.showModal();
  inp.focus();
}

// ===== Sources =====
VIEW.sources = () => {
  const s = S.settings;
  page('Log sources', 'Everything feeding the unified timeline. PillPal\'s own sources are always on; add files, HTTP feeds or the OS log as needed.', '',
    `<section class="card" style="padding:0"><div id="srcTable"></div></section>
     <div class="grid cols-2" style="margin-top:12px">
      <section class="card"><h2>Watched log files</h2><p class="muted" style="margin-bottom:10px">Follows a file like <code>tail -f</code>, starting with its last 32 KB. Handles truncation and rotation. Relative paths start at the PillPal folder.</p>
        <div id="fileList"></div>
        <form class="row" id="addFile" style="margin-top:8px"><input class="grow" name="path" placeholder="C:\\path\\to\\app.log  or  logs/app.log" aria-label="File path" required><button class="btn primary">${icon('plus')} Watch</button></form></section>
      <section class="card"><h2>HTTP log feeds</h2><p class="muted" style="margin-bottom:10px">Polls a URL that returns a JSON array, <code>{"logs": [...]}</code>, NDJSON or plain lines. New lines only.</p>
        <div id="feedList"></div>
        <form class="row" id="addFeed" style="margin-top:8px"><input name="name" placeholder="Name" style="width:110px" required aria-label="Feed name"><input class="grow" name="url" placeholder="http://localhost:4000/logs" required aria-label="Feed URL" type="url"><input name="interval" type="number" min="5" value="15" style="width:70px" aria-label="Interval seconds" title="Seconds between polls"><button class="btn primary">${icon('plus')} Add</button></form></section>
      <section class="card"><h2>${esc(s.osLogLabel)}</h2><p class="muted" style="margin-bottom:10px">${s.platform === 'win32' ? 'Reads a Windows Event Log channel (Application by default) with Get-WinEvent. Some channels, like Security, need admin rights and will show as unavailable.' : s.platform === 'darwin' ? 'Reads errors and faults from the unified log with <code>log show</code>. Use the filter box for a custom predicate.' : 'Reads the systemd journal with <code>journalctl</code>. You may need to be in the systemd-journal group.'}</p>
        <form id="osForm" style="display:flex;flex-direction:column;gap:8px">
          <label class="check"><input type="checkbox" name="enabled" ${s.osLog.enabled ? 'checked' : ''}> Collect ${esc(s.osLogLabel)}</label>
          <div class="row"><label class="field grow"><span>${s.platform === 'win32' ? 'Channel' : s.platform === 'darwin' ? 'Predicate' : 'Unit'} (optional)</span><input name="channel" value="${esc(s.osLog.channel)}" placeholder="${s.platform === 'win32' ? 'Application' : s.platform === 'darwin' ? 'process == "node"' : 'all units'}"></label>
          <label class="field"><span>Every (s)</span><input name="intervalSec" type="number" min="10" value="${s.osLog.intervalSec}" style="width:80px"></label></div>
          <div><button class="btn primary">Save</button></div></form></section>
      <section class="card"><h2>Capture options</h2>
        <form id="capForm" style="display:flex;flex-direction:column;gap:10px">
          <label class="check"><input type="checkbox" name="captureDb" ${s.captureDb ? 'checked' : ''}> Log every MongoDB command <span class="faint">(debug level; slow and failed ones are always logged)</span></label>
          <label class="check"><input type="checkbox" name="captureStatic" ${s.captureStatic ? 'checked' : ''}> Log static file requests <span class="faint">(trace level, noisy)</span></label>
          <div><button class="btn primary">Save</button></div></form></section>
     </div>`);
  renderSourceTable(); renderFileFeedLists();
  $('#addFile').onsubmit = async e => { e.preventDefault(); const p = new FormData(e.target).get('path').trim(); await saveSettings({ files: [...S.settings.files, { path: p, enabled: true }] }, 'Watching file'); VIEW.sources(); };
  $('#addFeed').onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target); await saveSettings({ feeds: [...S.settings.feeds, { name: f.get('name'), url: f.get('url'), intervalSec: +f.get('interval'), enabled: true }] }, 'Feed added'); VIEW.sources(); };
  $('#osForm').onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target); await saveSettings({ osLog: { enabled: !!f.get('enabled'), channel: f.get('channel'), intervalSec: +f.get('intervalSec') } }, 'OS log settings saved'); setTimeout(renderSourceTable, 1500); };
  $('#capForm').onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target); await saveSettings({ captureDb: !!f.get('captureDb'), captureStatic: !!f.get('captureStatic') }, 'Capture options saved'); };
  $('#view').onclick = async e => {
    const b = e.target.closest('[data-rm],[data-src]');
    if (!b) return;
    if (b.dataset.src) return go('logs', { sources: [b.dataset.src] });
    const [kind, i] = b.dataset.rm.split(':');
    const list = [...S.settings[kind]]; list.splice(+i, 1);
    await saveSettings({ [kind]: list }, 'Removed'); VIEW.sources();
  };
};
function renderSourceTable() {
  const el = $('#srcTable'); if (!el || !S.summary) return;
  el.innerHTML = `<table class="t"><thead><tr><th>Source</th><th>Type</th><th>Status</th><th style="text-align:right">Events</th><th style="text-align:right">Errors</th><th>Last event</th><th></th></tr></thead><tbody>${S.summary.sources.map(s => `
    <tr><td><i class="srcdot" style="background:${srcColor(s.id)}"></i><b>${esc(s.label)}</b><div class="faint mono" style="font-size:11px">${esc(s.id)}</div></td><td class="faint">${esc(s.kind)}</td>
    <td><span class="status ${esc(s.status.split(' ')[0])}">${esc(s.status)}</span>${s.error ? `<div class="error-text" style="font-size:11.5px">${esc(s.error)}</div>` : ''}</td>
    <td class="num">${num(s.count)}</td><td class="num" style="${s.errors ? 'color:var(--l-error)' : ''}">${num(s.errors)}</td><td class="mono faint">${ago(s.last)}</td>
    <td><button class="btn sm" data-src="${esc(s.id)}" ${s.count ? '' : 'disabled'}>View logs</button></td></tr>`).join('')}</tbody></table>`;
}
function renderFileFeedLists() {
  const s = S.settings;
  $('#fileList').innerHTML = s.files.length ? s.files.map((f, i) => `<div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)"><code style="word-break:break-all">${esc(f.path)}</code><button class="btn sm ghost" data-rm="files:${i}" aria-label="Stop watching">${icon('trash')}</button></div>`).join('') : '<p class="faint">No files watched.</p>';
  $('#feedList').innerHTML = s.feeds.length ? s.feeds.map((f, i) => `<div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)"><span><b>${esc(f.name)}</b> <code>${esc(f.url)}</code> <span class="faint">every ${f.intervalSec}s</span></span><button class="btn sm ghost" data-rm="feeds:${i}" aria-label="Remove feed">${icon('trash')}</button></div>`).join('') : '<p class="faint">No feeds.</p>';
}
async function saveSettings(patch, msg) {
  try { S.settings = await api('/settings', { method: 'PUT', body: patch }); S.max = S.settings.maxEvents; if (msg) toast(msg); return true; }
  catch (e) { toast(e.message, true); return false; }
}

// ===== Privacy & rules =====
const SAMPLE = `POST /api/login password=hunter2 email=pat@example.com
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U
Cookie: pp_session=Zm9vYmFyYmF6cXV4; theme=dark
GEMINI_API_KEY=AIzaSyA-1234567890abcdefghijklmnopqrstu
MONGODB_URI=mongodb+srv://pillpal:s3cretPass@cluster0.example.mongodb.net/pillpal
https://api.example.com/v1?key=abc123def456&q=ok
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASC
-----END PRIVATE KEY-----`;
const PARSE_SAMPLE = `2026-10-10T18:42:11.204Z ERROR payment worker crashed: ECONNRESET
{"level":"warn","msg":"cache miss storm","time":"2026-10-10T18:42:12Z","requestId":"r-981"}
{"t":{"$date":"2026-10-10T18:42:13.000+00:00"},"s":"W","c":"NETWORK","msg":"Slow connection","attr":{"durationMillis":812}}
[2026-10-10 18:42:14] INFO server listening on 3000
just a plain line that mentions a timeout`;
VIEW.privacy = () => {
  S.draft ||= structuredClone({ redactions: S.settings.redactions, redactKeys: S.settings.redactKeys, parsers: S.settings.parsers, retentionHours: S.settings.retentionHours, maxEvents: S.settings.maxEvents, healthGuard: S.settings.healthGuard, allowKill: S.settings.allowKill });
  const d = S.draft;
  page('Privacy & rules', 'Redaction runs on the server before anything is stored, streamed or exported, so secrets never reach disk. Changes apply to new events; events already stored keep the redaction they got.', '',
    `<div class="grid" style="gap:12px">
     <section class="card"><h2>Health data guard</h2>
       <label class="check"><input type="checkbox" id="hg" ${d.healthGuard ? 'checked' : ''}> Hide query values and record ids in logged URLs</label>
       <p class="muted" style="margin-top:6px">PillPal URLs can carry medication names (<code>/api/drug?q=…</code>, openFDA searches). With this on, logs show <code>/api/drug?[q]</code> and <code>/api/meds/:id</code>. Request bodies are never logged, only their field names; check-in notes, chat messages and photos never reach Debug Station. Users appear as an 8-character hash.</p></section>
     <section class="card"><div class="row" style="justify-content:space-between"><h2>Redaction rules</h2><div class="row"><button class="btn sm" id="addRule">${icon('plus')} Add rule</button><button class="btn sm ghost" id="resetRules">Reset to defaults</button></div></div>
       <div class="rules" id="rules"></div>
       <h3 style="margin:14px 0 6px">Always-redacted field names <span class="faint" style="font-weight:400">(metadata keys, any depth, case-insensitive)</span></h3>
       <textarea id="rkeys" rows="2" style="width:100%">${esc(d.redactKeys.join(', '))}</textarea>
       <div class="grid cols-2" style="margin-top:12px"><div><h3 style="margin-bottom:6px">Try it</h3><textarea id="sample" rows="10" style="width:100%" spellcheck="false">${esc(SAMPLE)}</textarea></div>
       <div><h3 style="margin-bottom:6px">Result <span class="faint" id="sampleHits" style="font-weight:400"></span></h3><div class="preview"><pre id="sampleOut"></pre></div></div></div></section>
     <section class="card"><div class="row" style="justify-content:space-between"><h2>Parser rules</h2><button class="btn sm" id="addParser">${icon('plus')} Add parser</button></div>
       <p class="muted" style="margin:4px 0 10px">JSON lines are parsed automatically (level, msg/message, time/timestamp, mongod and journald formats). For plain text, a regex with named groups: <code>(?&lt;msg&gt;…)</code> required, <code>(?&lt;level&gt;…)</code> and <code>(?&lt;time&gt;…)</code> optional; other named groups become metadata. Source limits a rule to e.g. <code>file:</code> or <code>feed:api</code>.</p>
       <div class="rules" id="parsers"></div>
       <div class="grid cols-2" style="margin-top:12px"><div><h3 style="margin-bottom:6px">Sample lines</h3><textarea id="psample" rows="7" style="width:100%" spellcheck="false">${esc(PARSE_SAMPLE)}</textarea></div>
       <div><h3 style="margin-bottom:6px">Parsed</h3><div class="preview" id="pout" style="overflow:auto"></div></div></div></section>
     <div class="grid cols-2">
     <section class="card"><h2>Retention &amp; storage</h2>
       <p class="muted" style="margin-bottom:10px">Stored under <code>.data/debug</code> in the PillPal folder (gitignored), one file per hour. Older files are deleted automatically.</p>
       <div class="row"><label class="field"><span>Keep events for (hours)</span><input type="number" id="ret" min="1" max="2160" value="${d.retentionHours}" style="width:120px"></label>
       <label class="field"><span>Max events in memory</span><input type="number" id="maxev" min="1000" max="200000" step="1000" value="${d.maxEvents}" style="width:140px"></label></div>
       <p class="faint" id="diskInfo" style="margin-top:8px"></p>
       <div class="row" style="margin-top:12px"><button class="btn danger" id="clearAll">${icon('trash')} Clear all debug data…</button></div></section>
     <section class="card"><h2>Safety</h2>
       <label class="check"><input type="checkbox" id="allowKill" ${d.allowKill ? 'checked' : ''}> Allow ending processes from the Processes view</label>
       <p class="muted" style="margin-top:6px">Off by default. When on, ending a process still needs you to type its name, uses only this user's OS permissions, and is written to the log as an audit event. PillPal's own server and database are always protected.</p>
       <p class="note" style="margin-top:10px">Debug Station answers only on localhost, refuses cross-site requests and is off when <code>NODE_ENV=production</code> unless <code>DEBUG_STATION=1</code>.</p></section>
     </div></div>
     <div class="savebar" id="savebar" hidden><b>Unsaved changes</b><span class="muted grow" id="saveErr"></span><button class="btn ghost" id="discard">Discard</button><button class="btn primary" id="saveRules">Save changes</button></div>`);
  renderRules(); renderParsers(); runSample(); runParseSample();
  api('/runtime').then(r => { if ($('#diskInfo')) $('#diskInfo').textContent = `${num(r.debug.inMemory)} events in memory · ${bytes(r.debug.onDisk)} on disk`; }).catch(() => {});
  const dirty = () => { S.dirty = true; $('#savebar').hidden = false; };
  $('#hg').onchange = e => { d.healthGuard = e.target.checked; dirty(); };
  $('#allowKill').onchange = e => { d.allowKill = e.target.checked; dirty(); };
  $('#ret').oninput = e => { d.retentionHours = +e.target.value; dirty(); };
  $('#maxev').oninput = e => { d.maxEvents = +e.target.value; dirty(); };
  $('#rkeys').oninput = e => { d.redactKeys = e.target.value.split(/[,\n]/).map(s => s.trim()).filter(Boolean); dirty(); };
  $('#sample').oninput = runSample;
  $('#psample').oninput = runParseSample;
  $('#addRule').onclick = () => { d.redactions.push({ id: 'custom-' + Date.now().toString(36), name: 'Custom rule', pattern: '', flags: 'g', replace: '[REDACTED]', enabled: true }); renderRules(); dirty(); $$('#rules .pat').at(-1)?.focus(); };
  $('#resetRules').onclick = () => { d.redactions = structuredClone(S.settings.defaults.redactions); d.redactKeys = [...S.settings.defaults.redactKeys]; $('#rkeys').value = d.redactKeys.join(', '); renderRules(); runSample(); dirty(); };
  $('#addParser').onclick = () => { d.parsers.push({ id: 'parser-' + Date.now().toString(36), name: 'My log format', pattern: '^(?<level>\\w+): (?<msg>.*)$', flags: '', source: '*', enabled: true }); renderParsers(); runParseSample(); dirty(); };
  $('#discard').onclick = () => { S.draft = null; S.dirty = false; VIEW.privacy(); };
  $('#saveRules').onclick = async () => {
    $('#saveErr').textContent = '';
    try { S.settings = await api('/settings', { method: 'PUT', body: d }); S.max = S.settings.maxEvents; S.draft = null; S.dirty = false; toast('Rules saved. New events use them now.'); VIEW.privacy(); }
    catch (e) { $('#saveErr').innerHTML = `<span class="error-text">${esc(e.message)}</span>`; }
  };
  $('#clearAll').onclick = clearAllDialog;
  const onRuleInput = (listName, rerun) => e => {
    const row = e.target.closest('[data-i]'); if (!row) return;
    const r = d[listName][+row.dataset.i], k = e.target.dataset.k;
    if (k === 'del') { d[listName].splice(+row.dataset.i, 1); listName === 'redactions' ? renderRules() : renderParsers(); rerun(); dirty(); return; }
    if (!k) return;
    r[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    row.classList.toggle('invalid', !!(r.pattern && validateRule(r)));
    row.querySelector('.pat').title = r.pattern ? validateRule(r) || '' : '';
    rerun(); dirty();
  };
  $('#rules').oninput = onRuleInput('redactions', runSample); $('#rules').onclick = e => e.target.closest('[data-k="del"]') && onRuleInput('redactions', runSample)({ target: e.target.closest('[data-k="del"]') });
  $('#parsers').oninput = onRuleInput('parsers', runParseSample); $('#parsers').onclick = e => e.target.closest('[data-k="del"]') && onRuleInput('parsers', runParseSample)({ target: e.target.closest('[data-k="del"]') });
};
function renderRules() {
  $('#rules').innerHTML = `<div class="rule head"><span></span><span>Name</span><span>Pattern (regex)</span><span>Flags</span><span>Replace with</span><span style="text-align:right">In sample</span><span></span></div>` +
    S.draft.redactions.map((r, i) => `<div class="rule ${r.pattern && validateRule(r) ? 'invalid' : ''}" data-i="${i}">
      <input type="checkbox" data-k="enabled" ${r.enabled ? 'checked' : ''} aria-label="Enable ${esc(r.name)}">
      <input class="name" data-k="name" value="${esc(r.name)}" aria-label="Rule name" ${r.builtin ? 'title="Built-in rule"' : ''}>
      <input class="pat" data-k="pattern" value="${esc(r.pattern)}" aria-label="Pattern" spellcheck="false" placeholder="regex">
      <input data-k="flags" value="${esc(r.flags)}" aria-label="Flags">
      <input data-k="replace" value="${esc(r.replace)}" aria-label="Replacement">
      <span class="hits" data-hits="${esc(r.id)}">—</span>
      ${r.builtin ? '<span class="faint" title="Built-in rules can be turned off, not deleted" style="text-align:center">●</span>' : `<button class="btn sm ghost" data-k="del" aria-label="Delete rule">${icon('trash')}</button>`}</div>`).join('');
}
function renderParsers() {
  $('#parsers').innerHTML = `<div class="rule parser head"><span></span><span>Name</span><span>Pattern (named groups)</span><span>Flags</span><span>Source</span><span></span></div>` +
    S.draft.parsers.map((r, i) => `<div class="rule parser ${r.pattern && validateRule(r) ? 'invalid' : ''}" data-i="${i}">
      <input type="checkbox" data-k="enabled" ${r.enabled ? 'checked' : ''} aria-label="Enable ${esc(r.name)}">
      <input class="name" data-k="name" value="${esc(r.name)}" aria-label="Parser name">
      <input class="pat" data-k="pattern" value="${esc(r.pattern)}" aria-label="Pattern" spellcheck="false">
      <input data-k="flags" value="${esc(r.flags)}" aria-label="Flags">
      <input data-k="source" value="${esc(r.source)}" aria-label="Source prefix">
      <button class="btn sm ghost" data-k="del" aria-label="Delete parser">${icon('trash')}</button></div>`).join('');
}
function runSample() {
  const text = $('#sample')?.value ?? '';
  const compiled = compileRules(S.draft.redactions.filter(r => !validateRule(r)));
  const hits = {};
  // Same algorithm as the server, with markers around replacements so they can be highlighted.
  let out = text;
  for (const { id, re, replace } of compiled) {
    re.lastIndex = 0;
    out = out.replace(re, (...m) => { hits[id] = (hits[id] || 0) + 1; return '\u0001' + replace.replace(/\$(\d)/g, (_, n) => m[+n] ?? '') + '\u0002'; });
  }
  $('#sampleOut').innerHTML = esc(out).replace(/\u0001/g, '<span class="red">').replace(/\u0002/g, '</span>');
  const total = Object.values(hits).reduce((a, b) => a + b, 0);
  $('#sampleHits').textContent = `${total} replacement${total === 1 ? '' : 's'}`;
  $$('[data-hits]').forEach(el => { const n = hits[el.dataset.hits] || 0; el.textContent = n ? `${n} hit${n > 1 ? 's' : ''}` : '—'; el.classList.toggle('on', !!n); });
}
function runParseSample() {
  const lines = ($('#psample')?.value || '').split('\n').filter(l => l.trim());
  const parsers = S.draft.parsers.filter(p => !validateRule(p));
  $('#pout').innerHTML = `<table class="t"><thead><tr><th>Level</th><th>Time</th><th>Message</th><th>Fields</th></tr></thead><tbody>${lines.map(l => {
    const p = parseLine(l, parsers, 'file:sample');
    return `<tr><td><span class="lv ${p.level}">${p.level}</span></td><td class="mono faint" style="font-size:11px">${p.ts ? fmtClock(p.ts) : 'now'}</td><td class="mono" style="font-size:12px">${esc(p.msg.slice(0, 120))}</td><td class="mono faint" style="font-size:11px">${esc(Object.entries(p.meta).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ').slice(0, 140))}</td></tr>`;
  }).join('')}</tbody></table>`;
}
function clearAllDialog() {
  const dlg = $('#dlg');
  dlg.innerHTML = `<form method="dialog" class="dlg"><h2>Clear all debug data?</h2><p>This deletes every stored event, error group, metric and bookmark in <code>.data/debug</code>. Your rules and source settings stay. PillPal's own data (users, meds, doses) is not touched.</p>
    <label class="check"><input type="checkbox" id="keepBm"> Keep bookmarks</label>
    <div class="actions"><button class="btn" value="cancel">Cancel</button><button class="btn danger" type="button" id="doClear">Clear debug data</button></div></form>`;
  dlg.onclick = null;
  dlg.showModal();
  $('#doClear').onclick = async () => {
    try { await api('/clear', { method: 'POST', body: { bookmarks: !$('#keepBm').checked } }); dlg.close(); await loadAll(); render(); toast('Debug data cleared'); }
    catch (e) { toast(e.message, true); }
  };
}

// ===== Bookmarks =====
VIEW.bookmarks = () => {
  const list = [...S.bookmarks.values()].sort((a, b) => b.pinned - a.pinned || b.createdAt - a.createdAt);
  page('Bookmarks', 'Events you saved, with your notes. Bookmarks keep a redacted copy of the event, so they survive after the live buffer rolls over.',
    list.length ? `<button class="btn sm" id="bmExport">${icon('download')} Export</button><button class="btn sm" id="bmCopy">${icon('copy')} Copy as Markdown</button>` : '',
    list.length ? `<div class="grid" style="gap:8px">${list.map(b => `<article class="card" style="padding:10px 12px"><div class="row" style="justify-content:space-between;flex-wrap:nowrap">
      <div style="min-width:0"><div class="row" style="gap:6px">${b.pinned ? `<span class="tag warn">${icon('pin')} pinned</span>` : ''}<span class="lv ${b.event.level}">${b.event.level}</span><span class="faint mono" style="font-size:11.5px">${esc(fmtFull(b.event.ts))}</span><span class="tag">${esc(b.event.source)}</span>${b.event.feature ? `<span class="tag brand">${esc(featLabel(b.event.feature))}</span>` : ''}</div>
        <div class="mono" style="margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b.event.msg.split('\n')[0])}</div>
        ${b.note ? `<p style="margin-top:6px;white-space:pre-wrap">${esc(b.note)}</p>` : '<p class="faint" style="margin-top:6px">No note.</p>'}</div>
      <div class="row" style="flex-wrap:nowrap"><button class="btn sm" data-open="${b.id}">Open</button><button class="btn sm ghost" data-del="${b.id}" aria-label="Remove bookmark">${icon('trash')}</button></div></div></article>`).join('')}</div>`
      : `<div class="empty"><img src="/icon.svg" width="42" height="42" alt=""><h2>No bookmarks yet</h2><p>Open any event and press Bookmark (or B) to save it with a note.</p></div>`);
  $('#view').onclick = async e => {
    const o = e.target.closest('[data-open]'), d = e.target.closest('[data-del]');
    if (o) openDrawer(+o.dataset.open);
    if (d) { await api('/bookmarks/' + d.dataset.del, { method: 'DELETE' }); S.bookmarks.delete(+d.dataset.del); renderBadges(); VIEW.bookmarks(); }
  };
  $('#bmExport')?.addEventListener('click', () => download('pillpal-debug-bookmarks.json', JSON.stringify(list, null, 2)));
  $('#bmCopy')?.addEventListener('click', () => copy(list.map(b => `- **${b.event.level}** ${new Date(b.event.ts).toISOString()} \`${b.event.source}\` ${b.event.msg.split('\n')[0]}${b.note ? `\n  > ${b.note.replace(/\n/g, '\n  > ')}` : ''}`).join('\n'), 'Bookmarks copied'));
};

// ===== Runtime =====
VIEW.runtime = async () => {
  page('Runtime', 'Read-only view of the PillPal server: configuration, in-memory state and database counts. Values pass through redaction.', `<button class="btn sm" id="rtRefresh">${icon('refresh')} Refresh</button>`, '<div id="rt"><p class="muted">Loading…</p></div>');
  $('#rtRefresh').onclick = VIEW.runtime;
  try {
    const r = await api('/runtime');
    if (S.view !== 'runtime') return;
    const kvs = o => `<dl class="kv">${Object.entries(o).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'object' && v ? (v.error ? '⚠ ' + v.error : JSON.stringify(v)) : v)}</dd>`).join('')}</dl>`;
    $('#rt').innerHTML = `<div class="grid cols-2">
      <section class="card"><h2>Process</h2>${kvs({ Node: r.node, Platform: r.platform, PID: r.pid, 'Parent PID': r.ppid, Cores: r.cores, Uptime: dur(r.uptimeSec * 1000), Folder: r.cwd, 'RSS': bytes(r.memory.rss), 'JS heap': `${bytes(r.memory.heapUsed)} of ${bytes(r.memory.heapTotal)}`, External: bytes(r.memory.external) })}</section>
      ${Object.entries(r.probes).map(([name, v]) => `<section class="card"><h2>${esc({ config: 'Configuration', inMemory: 'In-memory state', collections: 'MongoDB collections' }[name] || name)}</h2>${v?.error ? `<p class="error-text">${esc(v.error)}</p>` : kvs(v)}</section>`).join('')}
      <section class="card"><h2>Debug Station storage</h2>${kvs({ 'In memory': `${num(r.debug.inMemory)} events (max ${num(r.debug.maxEvents)})`, 'On disk': bytes(r.debug.onDisk), Retention: `${r.debug.retentionHours} hours`, Folder: r.dataDir })}</section></div>`;
  } catch (e) { $('#rt').innerHTML = `<p class="error-text">${esc(e.message)}</p>`; }
};

// ---------- keyboard ----------
function helpDialog() {
  const dlg = $('#dlg');
  dlg.innerHTML = `<form method="dialog" class="dlg"><h2>Keyboard &amp; search</h2>
    <dl class="kv" style="grid-template-columns:110px 1fr"><dt><span class="kbd">/</span></dt><dd>Search logs</dd><dt><span class="kbd">P</span></dt><dd>Pause / resume the live stream</dd><dt><span class="kbd">J</span> <span class="kbd">K</span></dt><dd>Next / previous event</dd>
    <dt><span class="kbd">B</span></dt><dd>Bookmark the open event</dd><dt><span class="kbd">Esc</span></dt><dd>Close the detail panel</dd><dt><span class="kbd">1</span>–<span class="kbd">9</span></dt><dd>Switch view</dd>
    <dt>Click</dt><dd>Open an event · Ctrl/Cmd-click to select · Shift-click to select a range</dd><dt>Shift-click a level</dt><dd>Show only that level</dd></dl>
    <h3>Search syntax</h3>
    <dl class="kv help-syntax" style="grid-template-columns:170px 1fr"><dt>timeout</dt><dd>text anywhere (message, stack, ids, metadata)</dd><dt>-static</dt><dd>exclude</dd><dt>"exact phrase"</dt><dd>phrase</dd>
    <dt>level:&gt;=warn</dt><dd>warn, error, fatal</dd><dt>status:&gt;=500 · ms:&gt;1000</dt><dd>numeric compare</dd><dt>feature:ai.*</dt><dd>prefix wildcard</dd>
    <dt>trace: request: session: user:</dt><dd>correlation ids</dd><dt>service:Gemini model: route: outcome:miss tag:fallback-model</dt><dd>PillPal fields</dd><dt>meta.collection:meds</dt><dd>any metadata path</dd></dl>
    <div class="actions"><button class="btn primary">Close</button></div></form>`;
  dlg.onclick = null;
  dlg.showModal();
}
document.addEventListener('keydown', e => {
  const typing = e.target.closest('input, textarea, select, [contenteditable]');
  if (e.key === 'Escape' && !$('#dlg').open) { if (!$('#drawer').hidden) closeDrawer(); $$('.menu-pop').forEach(p => p.hidden = true); if (typing && e.target.id === 'q') e.target.blur(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || $('#dlg').open) return;
  if (e.key === '/') { e.preventDefault(); if (S.view !== 'logs') { go('logs'); setTimeout(() => $('#q')?.focus(), 30); } else $('#q').focus(); }
  else if (e.key === 'p' || e.key === 'P') togglePause();
  else if (e.key === 'j' || e.key === 'k') { if (S.cur == null && S.view === 'logs' && S.filtered.length) openDrawer(S.filtered.at(-1).id); else step(e.key === 'j' ? 1 : -1); }
  else if ((e.key === 'b' || e.key === 'B') && S.cur != null) { const ev = S.byId.get(S.cur); if (ev) saveBookmark(ev, { note: S.bookmarks.get(ev.id)?.note || '', pinned: !!S.bookmarks.get(ev.id)?.pinned }).then(() => openDrawer(ev.id)); }
  else if (e.key === '?') helpDialog();
  else if (/^[1-9]$/.test(e.key)) location.hash = VIEWS[+e.key - 1][0];
});
document.addEventListener('click', e => {
  if (!e.target.closest('.menu')) $$('.menu-pop').forEach(p => p.hidden = true);
  const a = e.target.closest('[data-act]');
  if (a?.dataset.act === 'pause') togglePause();
  if (a?.dataset.act === 'help') helpDialog();
  const f = e.target.closest('[data-feature]');
  if (f && S.view === 'overview') go('logs', { feature: f.dataset.feature });
});
addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ---------- boot ----------
(async () => {
  renderRail();
  togglePause(false);
  try { await loadAll(); }
  catch (e) {
    $('#view').innerHTML = `<div class="page"><div class="empty"><img src="/icon.svg" width="48" height="48" alt=""><h2>Debug Station could not load</h2><p>${esc(e.message)}</p><p class="muted">Open it from the same computer as the PillPal server, at http://localhost.</p></div></div>`;
    return;
  }
  addEventListener('hashchange', route);
  addEventListener('resize', () => { lastRowsKey = ''; renderRows(); });
  route();
  connect();
  setInterval(() => { if (S.view === 'logs' && S.filter.window !== 'all') refreshLogs(true); renderKpis(); }, 10000);
})();
