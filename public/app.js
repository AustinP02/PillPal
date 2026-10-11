// PillPal front end, built on the PillPal design system (/ds). No framework: hash routes render template strings,
// every dynamic value goes through esc(), and clicks are handled by one delegated [data-action] listener.
import { esc, icon, btn, iconBtn, badge, tag, pill, pillBox, medPill, mascot, logo, ring, input, select, textarea, toggle, checkbox, tabs } from './ui.js';
import { mapStudy, quickFit, VITALS } from '/logic.js';
import { grabFrame, imageToCanvas, frameQuality, judge, frameDiff, GATE, prepForOcr, barcodeReader, readBarcodes, ndcFromBarcode } from './scanner.js';

const S = { user: null, meds: [], doses: [], period: 30, notified: new Set(), stream: null, busy: false, install: null, chat: [], chatBusy: false, scanState: 'idle' };
const app = document.getElementById('app');
const $ = (sel, root = document) => root.querySelector(sel);
const today = () => new Date().toLocaleDateString('en-CA');
const nowHM = () => new Date().toTimeString().slice(0, 5);
const fmtTime = t => `${+t.slice(0, 2)}:${t.slice(3, 5)}`; // 24h-friendly: 8:00, 21:30
const fmtDate = (d, o = { weekday: 'short', month: 'short', day: 'numeric' }) => new Date(d + 'T12:00').toLocaleDateString([], d.slice(0, 4) === today().slice(0, 4) || o.year ? o : { month: 'short', day: 'numeric', year: 'numeric' });
const title = s => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const initial = () => esc((S.user?.name || '?').trim().charAt(0).toUpperCase());
const aiOn = () => !!S.user?.ai && !S.user.prefs?.noAi;
const reduceMotion = () => !!S.user?.prefs?.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
const pip = (mood, size) => mascot(mood, size, { animate: !reduceMotion() });

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: r.status });
  return data;
}
const announce = msg => { const l = $('#live'); l.textContent = ''; setTimeout(() => (l.textContent = msg), 50); };

const PILL_COLORS = [['#F1F4F4', 'White'], ['#F2B8A0', 'Peach'], ['#F4C430', 'Yellow'], ['#A9DEDE', 'Aqua'], ['#127479', 'Teal'], ['#EE6F33', 'Orange']];
const EFFECTS = ['Nausea', 'Headache', 'Dizziness', 'Fatigue', 'Upset stomach', 'Rash or itching', 'Trouble sleeping', 'Dry mouth', 'Anxiety', 'Muscle pain', 'Low appetite', 'Other'];
const MOODS = [['frown', 'Awful'], ['annoyed', 'Not great'], ['meh', 'Okay'], ['smile', 'Good'], ['laugh', 'Great']];
const MOOD_COL = ['var(--status-missed-text)', 'var(--status-due-text)', 'var(--text-muted)', 'var(--brand-text)', 'var(--status-taken-text)'];
const PIP_PILL = { shape: 'capsule', colors: ['#1B8E93', '#FFA877'] };

// ---------- feedback: toasts and sound ----------
const TOAST_ICON = { info: 'bell', taken: 'circle-check', due: 'clock', missed: 'circle-alert' };
function toast({ tone = 'info', title: t, message = '', actions = '', sticky = false, reminder = false, ms = 5000 }) {
  const el = document.createElement('div');
  el.className = `pp-toast pp-toast--${reminder ? 'due' : tone}${reminder ? ' pp-toast--reminder' : ''}`;
  el.setAttribute('role', reminder ? 'alert' : 'status');
  el.innerHTML = `<span class="pp-toast__icon">${icon(reminder ? 'bell' : TOAST_ICON[tone] || 'bell', { size: 18 })}</span>
    <div style="flex:1;min-width:0">${t ? `<div class="pp-toast__title">${esc(t)}</div>` : ''}${message ? `<div class="pp-toast__msg">${esc(message)}</div>` : ''}${actions ? `<div class="pp-toast__action">${actions}</div>` : ''}</div>
    ${iconBtn('x', 'Dismiss', { size: 'sm', a: { 'data-toast-close': '' }, cls: 'pp-toast__x' })}`;
  $('#toasts').append(el);
  if (!sticky) setTimeout(() => el.remove(), ms);
  return el;
}
document.addEventListener('click', e => { const x = e.target.closest('[data-toast-close]'); if (x) x.closest('.pp-toast')?.remove(); });
function chime() {
  try {
    const ac = (S.ac ||= new AudioContext()), t0 = ac.currentTime;
    [660, 880].forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain(), t = t0 + i * 0.12;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g).connect(ac.destination);
      o.start(t); o.stop(t + 0.55);
    });
  } catch { /* audio is a nicety */ }
}
const speak = text => { if ('speechSynthesis' in window) { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } };

// ---------- dialogs ----------
function openDialog({ title: t, body, width = 440, label }) {
  const back = document.activeElement;
  const ov = document.createElement('div');
  ov.className = 'pp-dialog__overlay';
  ov.innerHTML = `<div class="pp-dialog" role="dialog" aria-modal="true" aria-label="${esc(label || t)}" style="max-width:${width}px">
    ${iconBtn('x', 'Close', { size: 'sm', cls: 'pp-dialog__close', a: { 'data-close': '' } })}
    <h2 class="pp-dialog__title">${esc(t)}</h2><div class="pp-dialog__body">${body}</div></div>`;
  const close = () => { ov.remove(); removeEventListener('keydown', onKey, true); back?.focus?.(); };
  const onKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab') { // keep focus inside the dialog
      const f = [...ov.querySelectorAll('button,input,select,textarea,a[href]')].filter(x => !x.disabled && x.offsetParent);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
    }
  };
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
  ov.addEventListener('click', e => { if (e.target.closest('[data-close]')) close(); });
  addEventListener('keydown', onKey, true);
  document.body.append(ov);
  (ov.querySelector('input,textarea,select') || ov.querySelector('[data-close]')).focus();
  return { el: ov.firstElementChild, close };
}
function confirmDialog({ title: t, text, ok, onOk, variant = 'danger' }) {
  const d = openDialog({ title: t, body: `<p>${esc(text)}</p><div class="pp-dialog__actions">${btn('Cancel', { variant: 'ghost', a: { 'data-close': '' } })}${btn(esc(ok), { variant, a: { 'data-ok': '' } })}</div>` });
  $('[data-ok]', d.el).onclick = async () => { d.close(); await onOk(); };
  $('[data-ok]', d.el).focus();
}

// ---------- auth ----------
function renderAuth(mode = 'login', err = '', email = '') {
  stopCamera();
  clearInterval(S.timer);
  app.removeAttribute('aria-busy');
  document.title = 'Sign in · PillPal';
  const signup = mode === 'signup';
  const feats = [['bell', 'Gentle reminders, read out loud if you like'], ['camera', 'Scan a bottle, get the FDA label facts'], ['file-text', 'Doctor-ready reports you can print or share'], ['flask-conical', 'Find clinical trials that are recruiting near you']];
  app.innerHTML = `<div class="auth" data-screen-label="Sign in">
    <section class="auth__hero">
      ${logo(26)}
      ${pip('happy', 128)}
      <div class="stack" style="gap:14px;max-width:520px">
        <h1 class="pp-display-l" style="max-width:14ch">Your pills, remembered.</h1>
        <p class="pp-body-l" style="max-width:40ch">PillPal reminds you on time, scans your bottles, and turns daily check-ins into a one-page summary your doctor can read in a minute.</p>
      </div>
      <ul class="auth__feats">${feats.map(([ic, l]) => `<li><span class="tile tile--card">${icon(ic, { size: 22 })}</span><span>${l}</span></li>`).join('')}</ul>
    </section>
    <main class="auth__main" id="main">
      <form id="authForm" class="auth__card" novalidate>
        ${tabs([{ value: 'login', label: 'Sign in' }, { value: 'signup', label: 'Create account' }], mode, { action: 'authMode', block: true, label: 'Account' })}
        <h2 class="pp-h2">${signup ? 'Nice to meet you' : 'Welcome back'}</h2>
        ${signup ? input({ label: 'Your first name', a: { name: 'name', autocomplete: 'given-name', required: true, id: 'aName' } }) : ''}
        ${input({ label: 'Email', ic: 'mail', a: { name: 'email', type: 'email', autocomplete: 'email', required: true, id: 'aEmail', value: email } })}
        ${input({ label: 'Password', ic: 'lock', hint: signup ? '8 or more characters' : '', a: { name: 'password', type: 'password', id: 'aPass', minlength: 8, required: true, autocomplete: signup ? 'new-password' : 'current-password' } })}
        ${checkbox({ label: 'Show password', a: { id: 'aShow' } })}
        <div class="alert" role="alert" ${err ? '' : 'hidden'}>${esc(err)}</div>
        ${btn(signup ? 'Create my account' : 'Sign in', { size: 'lg', block: true, a: { type: 'submit' } })}
        <p class="pp-caption">PillPal supports your care team. It doesn’t replace them. In an emergency, call 911.</p>
        <div class="auth__demo"><span class="pp-caption">Just looking around?</span>${btn('Try the demo', { variant: 'secondary', block: true, left: 'sparkles', a: { id: 'aDemo' } })}</div>
      </form>
    </main></div>`;
  app.querySelectorAll('[data-action="authMode"]').forEach(b => (b.onclick = e => { e.stopPropagation(); renderAuth(b.dataset.value, '', $('#aEmail').value); }));
  $('#aShow').onchange = e => ($('#aPass').type = e.target.checked ? 'text' : 'password');
  $('#aDemo').onclick = e => { e.preventDefault(); startDemo(e.currentTarget); };
  $('#authForm').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const fail = m => { const el = $('.alert', e.target); el.hidden = false; el.textContent = m; };
    if (!/\S+@\S+/.test(f.email)) return fail(signup ? 'Enter your email address.' : 'Enter the email you signed up with.');
    if ((f.password || '').length < 8) return fail('Passwords are 8 or more characters.');
    const b = e.submitter || $('button[type=submit]', e.target); b.disabled = true;
    try {
      S.user = await api(signup ? '/signup' : '/login', { method: 'POST', body: f });
      await enter();
      if (signup) toast({ title: `Hi ${S.user.name}, I’m Pip`, message: 'Let’s add your first medication.' });
    } catch (x) { renderAuth(mode, x.message, f.email); }
  };
  $(signup ? '#aName' : '#aEmail').focus();
}

// ---------- demo mode ----------
// A separate account filled with 60 days of sample data; Pip's answers there are pre-written.
const demoBody = () => ({ today: today(), now: nowHM(), tz: new Date().getTimezoneOffset() });
async function startDemo(b) {
  if (b) { b.disabled = true; b.lastChild.textContent = 'Setting up the demo…'; }
  try {
    S.user = await api('/demo/start', { method: 'POST', body: demoBody() });
    Object.assign(S, { chat: [], prep: null, aiNote: null, mix: null, notified: new Set() });
    history.replaceState(null, '', '#/today');
    await enter();
    toast({ title: 'Welcome to the PillPal demo', message: '60 days of sample data. Look around, tap Take, open My cabinet and the Doctor report.', ms: 8000 });
  } catch (x) { if (b) b.disabled = false; toast({ tone: 'missed', title: 'Couldn’t start the demo', message: x.message }); }
}
const demoBar = () => (S.user?.demo ? `<div class="demo-bar no-print" role="note">${icon('sparkles', { size: 16 })}<span><strong>Demo mode</strong> · sample data, and Pip’s answers are pre-written.</span>
  <span class="demo-bar__acts">${btn('Reset demo', { variant: 'ghost', size: 'sm', left: 'rotate-ccw', a: { 'data-action': 'resetDemo' } })}${btn('Exit demo', { variant: 'secondary', size: 'sm', left: 'log-out', a: { 'data-action': 'logout' } })}</span></div>` : '');

// ---------- shell & routing ----------
const NAV = [['today', 'Today', 'house'], ['meds', 'My cabinet', 'pill'], ['scan', 'Scan bottle', 'scan-line'], ['checkin', 'Check-in', 'heart-pulse'],
  ['health', 'Health log', 'activity'], ['chat', 'Ask Pip', 'messages-square'], ['report', 'Doctor report', 'file-text'], ['trials', 'Trials & help', 'flask-conical'], ['settings', 'Settings', 'settings']];
const TABS = [['today', 'Today', 'house'], ['meds', 'Cabinet', 'pill'], ['scan', 'Scan', 'scan-line'], ['checkin', 'Check-in', 'heart-pulse']];
const MORE = ['health', 'chat', 'report', 'trials', 'settings'];

const darkNow = () => document.documentElement.dataset.theme === 'dark';
function applyPrefs() {
  const p = S.user?.prefs || {}, r = document.documentElement;
  r.classList.toggle('large-text', !!p.largeText);
  r.classList.toggle('high-contrast', !!p.highContrast);
  r.classList.toggle('reduce-motion', !!p.reduceMotion);
  const t = THEMES.some(([k]) => k === p.theme) ? p.theme : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  r.dataset.theme = t;
  $('meta[name=theme-color]')?.setAttribute('content', { dark: '#0A1112', warm: '#FBF3E8', light: '#127479' }[t]);
  document.querySelectorAll('[data-action="theme"]').forEach(b => b.outerHTML = themeBtn());
  const fab = $('#fab'); if (fab) fab.hidden = !aiOn() || route() === 'chat';
  document.querySelectorAll('[data-nav="chat"]').forEach(a => (a.closest('li') || a).hidden = !aiOn());
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => S.user && applyPrefs());
// Themes: Light, Warm (cream and apricot), Dark. The header button opens a small picker; Settings has the same choice.
const THEMES = [['light', 'Light', 'sun', ['#F7F9F8', '#127479']], ['warm', 'Warm', 'coffee', ['#FBF3E8', '#EE6F33']], ['dark', 'Dark', 'moon', ['#0A1112', '#4DB9BB']]];
const curTheme = () => document.documentElement.dataset.theme || 'light';
const themeBtn = () => { const t = THEMES.find(x => x[0] === curTheme()) || THEMES[0];
  return iconBtn(t[2], `Theme: ${t[1]}. Change theme`, { variant: 'secondary', a: { 'data-action': 'theme', 'aria-haspopup': 'menu', 'aria-expanded': 'false' } }); };
function themeMenu(b) {
  $('#themeMenu')?.remove();
  const r = b.getBoundingClientRect(), el = document.createElement('div');
  el.id = 'themeMenu'; el.className = 'theme-menu'; el.setAttribute('role', 'menu'); el.setAttribute('aria-label', 'Theme');
  el.style.top = `${r.bottom + 8}px`; el.style.right = `${Math.max(8, innerWidth - r.right)}px`;
  el.innerHTML = THEMES.map(([k, l, ic, [bg, fg]]) => `<button type="button" role="menuitemradio" aria-checked="${k === curTheme()}" class="theme-menu__item" data-action="setTheme" data-value="${k}">
    <span class="theme-menu__swatch" style="background:${bg}"><i style="background:${fg}"></i></span>${icon(ic, { size: 16 })}<span style="flex:1">${l}</span>${k === curTheme() ? icon('check', { size: 16 }) : ''}</button>`).join('');
  document.body.append(el);
  b.setAttribute('aria-expanded', 'true');
  const close = e => { if (e.type === 'keydown' ? e.key === 'Escape' : !el.contains(e.target) && !b.contains(e.target)) { el.remove(); b.setAttribute('aria-expanded', 'false'); off(); if (e.type === 'keydown') b.focus(); } };
  const off = () => { removeEventListener('mousedown', close, true); removeEventListener('keydown', close, true); };
  addEventListener('mousedown', close, true); addEventListener('keydown', close, true);
  el.querySelector('[aria-checked="true"]').focus();
  el.addEventListener('keydown', e => { if (!/Arrow(Up|Down)/.test(e.key)) return; e.preventDefault(); const i = [...el.children], k = i.indexOf(document.activeElement); i[(k + (e.key === 'ArrowDown' ? 1 : -1) + i.length) % i.length].focus(); });
}
const avatar = () => `<a class="avatar" href="#/settings" aria-label="Account and settings">${initial()}</a>`;
const loadMeds = async () => (S.meds = await api('/meds'));
const route = () => location.hash.slice(2).split('?')[0];

async function enter() {
  applyPrefs();
  await loadMeds();
  app.removeAttribute('aria-busy');
  app.innerHTML = `<div class="shell">
    <aside class="side no-print" aria-label="Sidebar">
      <a class="side__logo" href="#/today">${logo(24)}</a>
      <nav aria-label="Main"><ul class="side__nav">${NAV.map(([id, label, ic]) => `<li><a class="nav-item" href="#/${id}" data-nav="${id}">${icon(ic, { size: 20 })}<span>${label}</span>${id === 'today' ? '<span class="pp-badge pp-badge--sm pp-badge--due nav-item__badge" data-due-badge hidden></span>' : ''}</a></li>`).join('')}</ul></nav>
      <div style="flex:1;min-height:16px"></div>
      <div class="pp-card pp-card--warm pp-card--pad-sm side__streak">
        <span class="tile tile--card" style="color:var(--accent-text)">${icon('flame', { size: 22 })}</span>
        <div><div class="side__streak-n" id="sideStreak">–</div><div class="pp-caption" style="margin-top:4px">Current streak</div></div>
      </div>
      <p class="pp-caption" style="padding:12px 8px 0"><strong style="color:var(--text-strong)">Not medical advice.</strong> Always follow your prescription label and your care team.</p>
    </aside>
    <div class="main-col">
      ${demoBar()}
      <div class="topbar no-print">${logo(20)}<div style="flex:1"></div>${themeBtn()}${avatar()}</div>
      <main id="main" tabindex="-1"></main>
    </div>
  </div>
  <nav class="tabbar no-print" aria-label="Main">${TABS.map(([id, l, ic]) => `<a class="tabbar__tab" href="#/${id}" data-nav="${id}">${icon(ic, { size: 22 })}<span>${l}</span>${id === 'today' ? '<span class="tabbar__badge" data-due-badge hidden></span>' : ''}</a>`).join('')}
    <button type="button" class="tabbar__tab" data-action="more" data-nav-more>${icon('menu', { size: 22 })}<span>More</span></button></nav>
  <div class="fab no-print" id="fab" hidden>${btn('Ask Pip', { size: 'lg', left: 'messages-square', a: { href: '#/chat' } })}</div>`;
  applyPrefs();
  if (!location.hash || location.hash === '#') location.hash = '#/today'; else render(true);
  startReminders();
  refreshStreak();
}

const PAGES = {};
async function render(focus = false) {
  const [page, qs] = location.hash.slice(2).split('?');
  let id = PAGES[page] ? page : 'today';
  if (id === 'chat' && !aiOn()) id = 'today';
  if (id !== 'scan') stopCamera();
  clearInterval(S.tick);
  $('#moreSheet')?.remove();
  document.querySelectorAll('[data-nav]').forEach(a => a.dataset.nav === id ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  $('[data-nav-more]')?.toggleAttribute('aria-current', MORE.includes(id));
  document.title = `${NAV.find(n => n[0] === id)[1]} · PillPal`;
  $('#fab').hidden = !aiOn() || id === 'chat';
  document.body.dataset.route = id;
  const main = $('#main');
  try {
    await PAGES[id](new URLSearchParams(qs));
  } catch (e) {
    if (e.status === 401) return renderAuth();
    main.innerHTML = `${head({ title: 'That didn’t load' })}<div class="pp-card pp-card--pad-lg empty">${pip('alert', 96)}<p class="pp-body">${esc(e.message)}</p>${btn('Try again', { left: 'rotate-ccw', a: { 'data-action': 'reload' } })}</div>`;
  }
  if (focus) { $('#main h1')?.focus({ preventScroll: true }); scrollTo(0, 0); }
}
addEventListener('hashchange', () => S.user && render(true));

// Page header: optional overline, title, sub, actions. Theme toggle and avatar sit here on desktop (top bar on phones).
const head = ({ over, title: t, sub, actions = '' }) => `<header class="page-head">
  <div class="page-head__text">${over ? `<div class="pp-caption" style="font-weight:600">${over}</div>` : ''}<h1 class="pp-h1" tabindex="-1">${t}</h1>${sub ? `<p class="pp-body">${sub}</p>` : ''}</div>
  <div class="page-head__actions no-print">${actions}<span class="desk-only">${themeBtn()}${avatar()}</span></div></header>`;
const medActions = () => btn('Scan a bottle', { variant: 'secondary', left: 'camera', a: { href: '#/scan' } }) + btn('Add medication', { left: 'plus', a: { 'data-action': 'addMed' } });
const emptyMeds = (big) => `<div class="empty">${big ? pip('happy', 104) : pillBox({ shape: 'capsule', colors: ['#A9DEDE', '#FFE6D5'] }, 64, 40)}
  <div><h3 class="${big ? 'pp-h3' : 'pp-h4'}">${big ? 'Let’s add your first medication' : 'No medications yet'}</h3><p class="pp-body-s pp-muted" style="margin-top:4px">Scan the bottle with your camera, or type the name.</p></div>
  <div class="row" style="justify-content:center">${btn('Scan a bottle', { variant: 'secondary', left: 'camera', a: { href: '#/scan' } })}${btn('Add by hand', { left: 'plus', a: { 'data-action': 'addMed' } })}</div></div>`;

// ---------- refills ----------
// Run-out date = fill date + pills ÷ (pills per dose × doses per day). Discard-after comes off the label.
const addDaysLocal = (d, n) => { const t = new Date(d + 'T12:00'); t.setDate(t.getDate() + n); return t.toLocaleDateString('en-CA'); };
const daysUntil = d => Math.round((new Date(d + 'T12:00') - new Date(today() + 'T12:00')) / 864e5);
const runOut = m => (m.fillDate && m.quantity > 0 && m.times?.length ? addDaysLocal(m.fillDate, Math.floor(m.quantity / ((m.unitsPerDose || 1) * m.times.length))) : null);
const refillWord = m => (m.refills > 0 ? `${plural(m.refills, 'refill')} left` : m.refills === 0 ? 'no refills left' : '');
function refillNotes() {
  const out = [];
  for (const m of S.meds) {
    const r = runOut(m);
    if (r && daysUntil(r) <= 7) out.push({ tone: daysUntil(r) <= 2 ? 'missed' : 'due', text: `${m.name} ${daysUntil(r) < 0 ? 'may have run out' : `runs out around ${fmtDate(r)}`}.`,
      next: m.refills === 0 ? 'No refills left. Contact your prescriber.' : m.refills > 0 ? `${plural(m.refills, 'refill')} left. Ask your pharmacy to refill it.` : 'Ask your pharmacy about a refill.' });
    if (m.discardAfter && daysUntil(m.discardAfter) <= 14) out.push({ tone: daysUntil(m.discardAfter) < 0 ? 'missed' : 'due', text: `${m.name}: the bottle says discard after ${fmtDate(m.discardAfter)}.`, next: 'Ask your pharmacy about a fresh fill.' });
  }
  return out;
}

// ---------- dose timers ----------
// Each med has a timer as long as the gap between its doses (worked out by Pip from the directions and FDA label).
// Take starts it. Undo resets it to full until the next Take. When it runs out: Take, Skip, or "Remind me in X minutes".
const hm = d => new Date(d).toTimeString().slice(0, 5);
const lastTaken = m => (S.recent || []).filter(x => x.medId === m._id).sort((a, b) => new Date(a.at) - new Date(b.at)).at(-1);
const intervalHours = m => m.timer?.hours || m.interval?.hours || Math.round(24 / Math.max(1, m.times.length) * 10) / 10;
// Today's schedule slots for this med that aren't logged yet, closest to now first.
function openSlots(m) {
  const mins = t => +t.slice(0, 2) * 60 + +t.slice(3, 5), now = mins(nowHM());
  const logged = new Set((S.doses || []).filter(d => d.medId === m._id).map(d => d.time));
  return m.times.filter(t => !logged.has(t)).sort((a, b) => Math.abs(mins(a) - now) - Math.abs(mins(b) - now));
}
// Which slot a Take logs: the closest open one (any open one for a due timer), else the current time
// (a dose taken from the cabinet that isn't on today's schedule).
const pickSlot = (m, { near = false } = {}) => {
  const mins = t => +t.slice(0, 2) * 60 + +t.slice(3, 5), slot = openSlots(m)[0];
  return slot && (!near || Math.abs(mins(slot) - mins(nowHM())) <= 180) ? slot : nowHM();
};
// Timers show only for meds that were taken: counting down, or run out with a dose still left to take or skip today.
function doseTimers() {
  const now = Date.now(), rank = { due: 0, snoozed: 1, counting: 2 };
  return S.meds.map(m => {
    const hours = intervalHours(m), tm = m.timer;
    if (!tm) return null;
    const z = m.snooze && +new Date(m.snooze.until) > now ? m.snooze : null, end = +new Date(tm.endsAt);
    const state = end > now ? 'counting' : z ? 'snoozed' : 'due';
    if (state !== 'counting' && !openSlots(m).length) return null; // nothing left to take today
    return { m, hours, tm, state, start: state === 'snoozed' ? +new Date(z.from || now) : +new Date(tm.startedAt), end: state === 'snoozed' ? +new Date(z.until) : end };
  }).filter(Boolean).sort((a, b) => rank[a.state] - rank[b.state] || a.end - b.end || a.m.name.localeCompare(b.m.name));
}
const pad2 = n => String(n).padStart(2, '0');
function clock(ms) {
  const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600);
  return h ? `${h}:${pad2(Math.floor(s % 3600 / 60))}:${pad2(s % 60)}` : `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}
const inWords = ms => { const m = Math.max(1, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`; };
const hoursWord = h => (h >= 48 && h % 24 === 0 ? `${h / 24} days` : h === 24 ? '24 hours' : `${+h.toFixed(2)} h`);
const atWords = ms => { const d = new Date(ms), day = d.toLocaleDateString('en-CA'); return `${fmtTime(hm(ms))}${day === today() ? '' : day === addDaysLocal(today(), 1) ? ' tomorrow' : ` ${fmtDate(day)}`}`; };
const left = t => (t.state === 'ready' || t.state === 'due' ? 1 : Math.max(0, Math.min(1, (t.end - Date.now()) / Math.max(1, t.end - t.start))));
// Pill or liquid, in the med's colour: used in timers, the schedule and Ask Pip.
const medIcon = (m, box, size) => (m.form === 'liquid'
  ? `<span class="pp-pill-icon" style="width:${box}px;height:${box}px">${icon('droplet', { size: Math.round(size * 0.9), color: liquidColor(m), stroke: 2.2 })}</span>` : pillBox(medPill(m), box, size));
const liquidColor = m => (/^#(f1f4f4|ffffff|f7f9f8)$/i.test(m.color || '') || !m.color ? '#D9772B' : m.color);
function timerRing(t, size = 104) {
  const stroke = 8, r = (size - stroke) / 2, c = 2 * Math.PI * r, f = left(t);
  return `<span class="tring" style="width:${size}px;height:${size}px" aria-hidden="true"><svg width="${size}" height="${size}">
    <circle class="tring__track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"/>
    <circle class="tring__bar" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" data-c="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - f)).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>
    <span class="tring__pill">${medIcon(t.m, Math.round(size * 0.62), Math.round(size * 0.4))}</span></span>`;
}
const snoozeForm = (m, slot) => `<form class="snooze" data-snooze data-med="${esc(m._id)}" data-date="${esc(slot.date)}" data-time="${esc(slot.time)}">
  <label class="snooze__field">Remind me in <input type="number" name="min" min="1" max="240" step="1" value="10" inputmode="numeric" required aria-label="Remind me in how many minutes"> min</label>
  ${btn('Set', { variant: 'secondary', size: 'sm', left: 'alarm-clock', a: { type: 'submit', 'aria-label': `Set a reminder for ${m.name}` } })}</form>`;
const feltSince = (m, at) => (S.mc || []).some(c => c.medId === m._id && new Date(c.at) > new Date(at));
const basisLine = m => {
  const iv = m.interval;
  if (!iv) return `<span class="timer__why">${icon('sparkles', { size: 12 })}Pip is working out the timing…</span>`;
  const who = iv.by === 'pip' ? 'Pip' : iv.by === 'you' ? 'You' : 'From';
  return `<span class="timer__why" title="${esc(iv.basis)}">${icon(iv.by === 'pip' ? 'sparkles' : iv.by === 'you' ? 'pencil' : 'file-text', { size: 12 })}Every ${hoursWord(iv.hours)} · ${esc(who === 'From' ? iv.basis : `${who}: ${iv.basis}`)}</span>`;
};
function timerCard(t) {
  const { m, tm, state, hours } = t, slot = pickSlot(m);
  const act = (label, status, variant, ic, time = slot, date = today()) => btn(label, { variant, size: 'sm', left: ic,
    a: { 'data-action': 'dose', 'data-med': m._id, 'data-time': time, 'data-date': date, 'data-status': status, 'aria-label': `${label} ${m.name}` } });
  const since = tm ? `${tm.status === 'skipped' ? 'Skipped' : 'Taken'} at ${atWords(+new Date(tm.startedAt))}` : '';
  const feel = tm?.status === 'taken' && !feltSince(m, tm.startedAt) && Date.now() - new Date(tm.startedAt) < 12 * 3600e3
    ? btn('How do you feel?', { variant: 'ghost', size: 'sm', left: 'heart-pulse', a: { 'data-action': 'medCheckin', 'data-med': m._id, 'data-time': tm.time } }) : '';
  const undo = tm ? act('Undo', '', 'ghost', 'undo-2', tm.time, tm.date) : '';
  let body;
  if (state === 'due') body = `<div class="timer__big timer__big--due">Time for your next dose</div>
      <div class="pp-caption">${hoursWord(hours)} since your last dose (${esc(since.toLowerCase())})</div>
      <div class="timer__acts">${act('Take', 'taken', 'primary', 'check')}${act('Skip', 'skipped', 'secondary', 'skip-forward')}${snoozeForm(m, { date: today(), time: slot })}</div>`;
  else body = `<div class="timer__big pp-mono" data-left aria-hidden="true">${clock(t.end - Date.now())}</div>
      <div class="pp-caption">${state === 'snoozed' ? `until I remind you (${fmtTime(hm(t.end))})` : `until your next dose at ${atWords(t.end)}`}</div>
      <span class="sr-only">${state === 'snoozed' ? `Reminder at ${fmtTime(hm(t.end))}` : `Next dose at ${atWords(t.end)}`}</span>
      <div class="pp-caption">${esc(since)}</div>${basisLine(m)}
      <div class="timer__acts">${state === 'snoozed' ? act('Take', 'taken', 'primary', 'check') + act('Skip', 'skipped', 'secondary', 'skip-forward') : undo + feel}</div>`;
  return `<article class="timer timer--${state}" data-timer data-start="${t.start}" data-end="${t.end}" data-state="${state}" aria-label="${esc(m.name)}">
    ${timerRing(t)}<div class="timer__text"><div class="timer__name">${esc(m.name)}${m.dose ? `<span> · ${esc(m.dose)}</span>` : ''}</div>${body}</div></article>`;
}
// Ticks the countdowns every second without re-rendering; re-renders once when one runs out.
function startTick() {
  clearInterval(S.tick);
  S.tick = setInterval(() => {
    const els = document.querySelectorAll('[data-timer]');
    if (!els.length) return clearInterval(S.tick);
    const now = Date.now();
    let flip = false;
    els.forEach(el => {
      const st = el.dataset.state;
      if (st === 'due' || st === 'ready') return;
      const t = { start: +el.dataset.start, end: +el.dataset.end, state: st };
      if (t.end <= now) { flip = true; return; }
      el.querySelector('[data-left]').textContent = clock(t.end - now);
      const bar = el.querySelector('.tring__bar');
      bar.setAttribute('stroke-dashoffset', (+bar.dataset.c * (1 - left(t))).toFixed(2));
    });
    const busy = document.querySelector('.pp-dialog__overlay') || document.activeElement?.closest('form');
    if (flip && route() === 'today' && !busy) render();
  }, 1000);
}
// Intervals Pip hasn't worked out yet (new or edited meds): ask once, then refresh the timers.
async function ensureIntervals() {
  if (!S.meds.some(m => !m.interval?.hours) || S.intervalBusy) return;
  S.intervalBusy = true;
  try {
    const list = await api('/meds/intervals', { method: 'POST' });
    for (const x of list) { const m = S.meds.find(y => y._id === x.id); if (m) m.interval = x.interval; }
    if (route() === 'today' && !document.querySelector('.pp-dialog__overlay') && !document.activeElement?.closest('form')) {
      const box = $('#timers'); if (box) box.innerHTML = doseTimers().map(timerCard).join('');
    }
  } catch { /* timers fall back to the reminder times */ } finally { S.intervalBusy = false; }
}

// ---------- Pip's mix check ----------
const mixKey = () => S.meds.map(m => m._id + m.name).join('|');
async function loadMixes() {
  const key = mixKey();
  if (S.mix?.key === key) return S.mix.data;
  const data = await api('/meds/mixes');
  S.mix = { key, data };
  return data;
}
function mixCard(d, { always = false } = {}) {
  if (!d.pairs.length) return always && d.checked > 1 ? `<section class="pp-card pp-card--pad-md mix mix--ok" aria-labelledby="mixH">${pip('happy', 64)}<div class="stack" style="gap:4px">
    <h2 id="mixH" class="pp-h4">Pip’s mix check</h2><p class="pp-body-s pp-muted">None of your meds’ FDA labels warn about each other. Still mention vitamins and over-the-counter pills to your pharmacist.</p></div></section>` : '';
  const ai = d.pairs.some(p => p.plain);
  return `<section class="pp-card pp-card--pad-md stack mix" style="gap:14px" aria-labelledby="mixH">
    <div class="row" style="gap:14px;flex-wrap:nowrap">${pip('alert', 64)}<div class="stack" style="gap:4px"><h2 id="mixH" class="pp-h4">Pills to be careful mixing</h2>
      <p class="pp-body-s pp-muted">Pip checked your meds’ FDA labels. ${d.pairs.length === 1 ? 'One pair comes' : `${d.pairs.length} pairs come`} with a warning.</p></div></div>
    <ul class="mix__list">${d.pairs.map(p => `<li class="mix__item mix__item--${p.level}">
      ${badge(p.level === 'avoid' ? 'Label says avoid' : 'Take care together', { tone: p.level === 'avoid' ? 'missed' : 'due', size: 'sm', ic: 'triangle-alert' })}
      <strong class="mix__pair">${esc(p.a.name)} + ${esc(p.b.name)}</strong>
      ${p.plain ? `<p class="pp-body-s" style="color:var(--text-strong)">${esc(p.plain)}</p>` : ''}
      <p class="pp-caption">The ${esc(p.labelOf)} label: “${esc(p.snippet)}”</p></li>`).join('')}</ul>
    <p class="pp-caption">Don’t stop or change a medicine on your own. Your pharmacist can tell you whether this matters at your doses.${ai ? ' Plain-language lines are written by Pip (AI) from the label quotes.' : ''}</p></section>`;
}

// ---------- Today ----------
function todayItems() {
  const st = new Map(S.doses.map(d => [`${d.medId}|${d.time}`, d]));
  return S.meds.flatMap(m => m.times.map(time => {
    const d = st.get(`${m._id}|${time}`);
    return { m, time, status: d?.status || (time <= nowHM() ? 'due' : 'upcoming'), at: d?.at };
  })).sort((a, b) => a.time.localeCompare(b.time) || a.m.name.localeCompare(b.m.name));
}
function updateBadge(items = todayItems()) {
  const n = items.filter(i => i.status === 'due').length;
  document.querySelectorAll('[data-due-badge]').forEach(b => { b.hidden = !n; b.textContent = b.classList.contains('pp-badge') ? `${n} due` : n; });
}
async function refreshStreak(r) {
  try { r ||= await api(`/report?days=90&today=${today()}&now=${nowHM()}`); } catch { return; }
  const el = $('#sideStreak'); if (el) el.textContent = plural(r.streak, 'day');
}
function doseRow({ m, time, status, at }) {
  const when = fmtTime(time), data = { 'data-med': m._id, 'data-time': time };
  const act = (label, variant, st, aria, left) => btn(label, { variant, size: 'sm', left, a: { 'data-action': 'dose', ...data, 'data-status': st, 'aria-label': `${aria} ${m.name} at ${when}` } });
  const right = {
    due: act('Skip', 'ghost', 'skipped', 'Skip') + act('Take', 'primary', 'taken', 'Take', 'check'),
    upcoming: badge('Upcoming') + act('Take early', 'ghost', 'taken', 'Take'),
    taken: badge(`Taken${at ? ' ' + fmtTime(new Date(at).toTimeString()) : ''}`, { tone: 'taken', ic: 'check' }) + act('Undo', 'ghost', '', 'Undo'),
    skipped: badge('Skipped', { ic: 'x' }) + act('Undo', 'ghost', '', 'Undo'),
  }[status];
  return `<div class="pp-dose${status === 'taken' ? ' pp-dose--taken' : status === 'due' ? ' pp-dose--due' : status === 'skipped' ? ' pp-dose--skipped' : ''}">
    <span class="pp-dose__time">${when}</span>${medIcon(m, 44, 30)}
    <div class="pp-dose__main"><div class="pp-dose__name">${esc(m.name)}${m.dose ? `<span class="pp-dose__dose"> · ${esc(m.dose)}</span>` : ''}</div>
      <div class="pp-dose__meta">${m.instructions ? `<span>${esc(m.instructions)}</span>` : ''}${m.trialId ? badge(esc(m.trialId), { tone: 'accent', size: 'sm', ic: 'flask-conical' }) : ''}</div></div>
    <div class="pp-dose__actions">${right}</div></div>`;
}

PAGES.today = async () => {
  const [doses, , rep, checks, recent, mc, prof] = await Promise.all([
    api(`/doses?date=${today()}`), loadMeds(),  api(`/report?days=90&today=${today()}&now=${nowHM()}`), api(`/checkins?days=1&today=${today()}`),
    api(`/doses/recent?today=${today()}`), api('/medcheckins?limit=30'), api('/profile').catch(() => ({ studies: [] }))]);
  S.doses = doses; S.recent = recent; S.mc = mc; S.prof = prof;
  const visit = (prof.studies || []).flatMap(st => (st.visits || []).map(v => ({ ...v, st }))).filter(v => v.date >= today() && daysUntil(v.date) <= 7).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))[0];
  const timers = doseTimers();
  refreshStreak(rep);
  const items = todayItems();
  const due = items.filter(i => i.status === 'due'), done = items.filter(i => i.status === 'taken' || i.status === 'skipped');
  const taken = items.filter(i => i.status === 'taken'), next = items.find(i => i.status === 'upcoming');
  updateBadge(items);
  const h = new Date().getHours(), hi = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';

  let hero;
  if (!S.meds.length) hero = ['happy', 'Hi, I’m Pip. Let’s set up your first medication.', 'Scan the bottle or type it in. It takes about 30 seconds.'];
  else if (!due.length && !next) hero = ['celebrate', 'All done for today. Nice work.', `${plural(taken.length, 'dose')} taken. See you tomorrow.`];
  else if (due.length) hero = ['alert', `${plural(due.length, 'dose')} waiting for you`, `Since ${fmtTime(due[0].time)}. Tap “Take” once you’ve had it.`];
  else hero = ['happy', `Next up: ${next.m.name} at ${fmtTime(next.time)}`, 'I’ll remind you when it’s time.'];

  const slots = [...new Set(items.map(i => i.time))].map(t => {
    const its = items.filter(i => i.time === t), hh = +t.slice(0, 2);
    const [part, ic] = hh < 12 ? ['Morning', 'sunrise'] : hh < 17 ? ['Afternoon', 'sun'] : ['Evening', 'moon'];
    return `<div class="slot"><div class="slot__head">${icon(ic, { size: 18, color: 'var(--text-muted)' })}<span class="pp-overline pp-muted">${part}</span><span class="pp-mono pp-muted" style="font-weight:600">${fmtTime(t)}</span>
      ${its.some(i => i.status === 'due') ? badge('Due now', { tone: 'due', size: 'sm', dot: true }) : ''}</div>${its.map(doseRow).join('')}</div>`;
  }).join('');

  const d14 = rep.daily.slice(-14), sched14 = d14.reduce((a, d) => a + d.scheduled, 0), took14 = d14.reduce((a, d) => a + d.taken, 0);
  const adh14 = sched14 ? Math.round(took14 / sched14 * 100) : null;
  const dot = d => {
    const kind = !d.scheduled ? 'none' : d.taken === d.scheduled ? 'full' : d.date === today() ? 'none' : d.taken ? 'part' : 'miss';
    return `<span class="dots__d dots__d--${kind}${d.date === today() ? ' dots__d--today' : ''}" title="${esc(fmtDate(d.date))}: ${d.taken}/${d.scheduled}"></span>`;
  };
  const ci = checks[0];

  $('#main').innerHTML = `${head({ over: fmtDate(today(), { weekday: 'long', month: 'long', day: 'numeric' }), title: `${hi}, ${esc(S.user.name)}`, actions: medActions() })}
  <div class="cols" data-screen-label="Today">
    <div class="col col--main">
      <section class="pp-card pp-card--pad-lg hero" aria-label="Today’s summary">
        ${pip(hero[0], 104)}
        <div role="status" class="hero__text"><h2 class="pp-h3">${esc(hero[1])}</h2><p class="pp-body pp-muted">${esc(hero[2])}</p></div>
        ${items.length ? ring(done.length / items.length * 100, { size: 120, stroke: 11, label: `${done.length}/${items.length}`, sub: 'logged', aria: `${done.length} of ${items.length} doses logged today` }) : ''}
      </section>
      ${timers.length ? `<section class="pp-card pp-card--pad-md stack" style="gap:16px" aria-labelledby="tmH">
        <div class="row" style="justify-content:space-between"><h2 id="tmH" class="pp-h3">Until your next dose</h2>${timers.some(t => t.state === 'due') ? badge('Dose due', { tone: 'due', size: 'sm', dot: true }) : ''}</div>
        <div class="timers" id="timers">${timers.map(timerCard).join('')}</div>
      </section>` : ''}
      <section class="pp-card pp-card--pad-md stack" style="gap:20px" aria-labelledby="schedH">
        <h2 id="schedH" class="pp-h3">Today’s schedule</h2>
        ${items.length ? slots : emptyMeds(false)}
        ${S.meds.length ? `<p class="pp-body-s pp-muted row" style="gap:8px;flex-wrap:nowrap">${icon('pill', { size: 16, color: 'var(--brand-text)' })}<span>Taking something that isn’t on today’s list? <a href="#/meds">Pick it from your cabinet</a> and tap “Take a dose now”.</span></p>` : ''}
      </section>
    </div>
    <div class="col">
      ${visit ? `<section class="pp-card pp-card--tinted pp-card--pad-md stack" style="gap:10px" aria-labelledby="svH">
        <h2 id="svH" class="pp-h4 row" style="gap:8px">${icon('calendar', { size: 20, color: 'var(--brand-text)' })}Study visit ${daysUntil(visit.date) === 0 ? 'today' : daysUntil(visit.date) === 1 ? 'tomorrow' : `in ${daysUntil(visit.date)} days`}</h2>
        <p class="pp-body-s"><strong style="color:var(--text-strong)">${esc(fmtDate(visit.date))}${visit.time ? ` · ${fmtTime(visit.time)}` : ''}</strong> · ${esc(visit.label)}${visit.st.site ? `<br>${esc(visit.st.site)}` : ''}</p>
        <div class="row" style="gap:8px">${visit.st.coordinatorPhone ? btn('Call study team', { variant: 'secondary', size: 'sm', left: 'phone', a: { href: `tel:${visit.st.coordinatorPhone.replace(/[^\d+]/g, '')}` } }) : ''}${btn('Send an update', { variant: 'ghost', size: 'sm', left: 'send', a: { 'data-action': 'studySummary', 'data-id': visit.st.nctId } })}</div></section>` : ''}
      <div id="mixToday">${S.mix?.key === mixKey() ? mixCard(S.mix.data) : ''}</div>
      <section class="pp-card pp-card--pad-md stack" style="gap:16px" aria-label="Streak">
        <div class="row" style="gap:14px;flex-wrap:nowrap"><span class="tile tile--accent tile--lg">${icon('flame', { size: 26 })}</span>
          <div><div class="row" style="gap:8px;align-items:baseline"><span class="big-num">${rep.streak}</span><span class="pp-muted" style="font-weight:650">day streak</span></div>
          <p class="pp-caption" style="margin-top:4px">${adh14 == null ? 'Your streak starts with your first dose.' : `${adh14}% of doses taken in the last 2 weeks`}</p></div></div>
        <div class="dots" role="img" aria-label="Last 14 days: ${d14.filter(d => d.scheduled && d.taken === d.scheduled).length} complete days">${d14.map(dot).join('')}</div>
        <div class="legend" aria-hidden="true"><span><i style="background:var(--status-taken)"></i>All taken</span><span><i style="background:var(--status-due)"></i>Some</span><span><i style="background:var(--status-missed)"></i>Missed</span></div>
      </section>
      ${(() => { const n = refillNotes(); return n.length ? `<section class="pp-card pp-card--pad-md stack" style="gap:12px" aria-labelledby="rfH">
        <h2 id="rfH" class="pp-h4 row" style="gap:8px">${icon('package', { size: 20, color: 'var(--accent-text)' })}Refills</h2>
        ${n.map(x => `<div class="note note--${x.tone}"><strong>${esc(x.text)}</strong><span>${esc(x.next)}</span></div>`).join('')}</section>` : ''; })()}
      <section class="pp-card pp-card--pad-md stack" style="gap:14px" aria-labelledby="ciH">
        <h2 id="ciH" class="pp-h4">How are you feeling?</h2>
        ${ci ? `<div class="row" style="gap:12px;flex-wrap:nowrap"><span style="color:${MOOD_COL[ci.mood - 1]}">${icon(MOODS[ci.mood - 1][0], { size: 32, stroke: 1.75 })}</span>
            <p class="pp-body-s">You felt <strong style="color:var(--text-strong)">${MOODS[ci.mood - 1][1].toLowerCase()}</strong> today. <a href="#/checkin">Update check-in</a></p></div>`
          : `<p class="pp-body-s pp-muted">A 20-second check-in helps your doctor spot patterns.</p>
            <div class="faces">${MOODS.map(([ic, l], i) => `<a class="face" href="#/checkin?m=${i + 1}" style="color:${MOOD_COL[i]}">${icon(ic, { size: 28, stroke: 1.75 })}<span>${l}</span></a>`).join('')}</div>`}
      </section>
      <section class="pp-card pp-card--tinted pp-card--pad-md stack" style="gap:12px;align-items:flex-start">
        <span class="tile tile--brand">${icon('file-text', { size: 22 })}</span>
        <h2 class="pp-h4">Ready for your next visit?</h2>
        <p class="pp-body-s">Your doctor report updates itself as you log doses and check in.</p>
        ${btn('Open doctor report', { variant: 'secondary', left: 'file-text', a: { href: '#/report' } })}
      </section>
    </div>
  </div>`;
  startTick();
  ensureIntervals();
  if (S.meds.length > 1) loadMixes().then(d => { const el = $('#mixToday'); if (el) el.innerHTML = mixCard(d); }).catch(() => {});
};

// ---------- Meds: the medicine cabinet ----------
// Each med is a prescription bottle on a shelf. Tap one for details, Ask Pip, Edit, Stop tracking and Remove.
const warned = () => new Set(S.mix?.key === mixKey() ? S.mix.data.pairs.flatMap(p => [p.a.id, p.b.id]) : []);
// Long names get smaller type so they fit the label without breaking mid-word.
// Sized from the longest word and the label's inner width (uppercase Bricolage is about 0.7em per letter).
const nameSize = (n, width = 76) => { const w = Math.max(...String(n).split(/\s+/).map(x => x.length)); return Math.max(8, Math.min(15, Math.floor(width / (w * 0.7) * 2) / 2)); };
// Flat bottles drawn in Pip's style: bright amber pill bottle with a ridged white cap (pills showing at the bottom),
// or an amber syrup bottle with a dosing cup for liquids. The pharmacy label is HTML on top so it stays crisp.
const isLiquidMed = m => m.form === 'liquid';
function pillsSvg(m, n) {
  const spots = [[34, 183, -25], [52, 176, 30], [68, 185, -10], [84, 177, 40], [44, 166, -50], [76, 166, 15], [92, 189, 0]].slice(0, n);
  const c1 = esc(m.color || '#F1F4F4'), c2 = m.shape === 'capsule' ? '#F7F9F8' : c1, line = 'rgba(0,0,0,.14)';
  return spots.map(([x, y, r]) => `<g transform="translate(${x} ${y}) rotate(${r})">${m.shape === 'capsule'
    ? `<rect x="-10" y="-4.5" width="20" height="9" rx="4.5" fill="${c2}"/><path d="M0 -4.5 H-5.5 A4.5 4.5 0 0 0 -5.5 4.5 H0 Z" fill="${c1}"/><rect x="-10" y="-4.5" width="20" height="9" rx="4.5" fill="none" stroke="${line}"/>`
    : m.shape === 'oval' ? `<ellipse rx="9" ry="5.5" fill="${c1}" stroke="${line}"/><line x1="-5" x2="5" y1="0" y2="0" stroke="${line}"/>`
    : `<circle r="6" fill="${c1}" stroke="${line}"/><line x1="-3.5" x2="3.5" y1="0" y2="0" stroke="${line}"/>`}</g>`).join('');
}
let artN = 0;
function bottleArt(m) {
  const id = 'rxc' + (++artN), n = Math.max(3, Math.min(7, Math.round((m.quantity || 60) / 10)));
  const ridges = (x0, x1, y, h) => Array.from({ length: Math.floor((x1 - x0) / 8) }, (_, i) => `<rect x="${x0 + 4 + i * 8}" y="${y}" width="3" height="${h}" rx="1.5" fill="#DCE4E4"/>`).join('');
  if (isLiquidMed(m)) {
    const body = 'M22 86 C22 68 32 60 46 58 L74 58 C88 60 98 68 98 86 L98 182 Q98 194 86 194 L34 194 Q22 194 22 182 Z';
    return `<svg viewBox="0 0 120 200" class="rx__art" aria-hidden="true">
      <ellipse cx="60" cy="195" rx="44" ry="4" class="rx__shadow"/>
      <clipPath id="${id}"><path d="${body}"/></clipPath>
      <g clip-path="url(#${id})"><path d="${body}" fill="#C8651F"/><rect x="80" y="40" width="20" height="160" fill="#B4581A"/>
        <path d="M18 152 Q40 146 60 152 T102 152 L102 200 L18 200 Z" fill="${esc(liquidColor(m))}"/><path d="M18 152 Q40 146 60 152 T102 152" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="2"/>
        <rect x="29" y="72" width="6" height="58" rx="3" fill="#fff" opacity=".32"/><rect x="29" y="134" width="6" height="6" rx="3" fill="#fff" opacity=".32"/></g>
      <rect x="44" y="44" width="32" height="16" rx="3" fill="#A9511A"/>
      <rect x="38" y="24" width="44" height="24" rx="5" fill="#F5F8F8"/>${ridges(38, 82, 28, 14)}<rect x="38" y="42" width="44" height="6" rx="3" fill="#E1E8E8"/>
      <path d="M44 4 L76 4 L82 28 L38 28 Z" fill="#CFEAEA"/><path d="M76 4 L82 28 L70 28 L66 4 Z" fill="#B9DEDF"/><path d="M48 11 h8 M47 17 h10 M46 23 h12" stroke="#5FA9AC" stroke-width="1.6" stroke-linecap="round"/></svg>`;
  }
  return `<svg viewBox="0 0 120 200" class="rx__art" aria-hidden="true">
    <ellipse cx="60" cy="195" rx="46" ry="4" class="rx__shadow"/>
    <clipPath id="${id}"><rect x="20" y="52" width="80" height="142" rx="10"/></clipPath>
    <g clip-path="url(#${id})"><rect x="20" y="52" width="80" height="142" fill="#F9A63A"/><rect x="80" y="52" width="20" height="142" fill="#EF9227"/>
      <rect x="20" y="150" width="80" height="44" fill="#FCC27A"/><rect x="80" y="150" width="20" height="44" fill="#F7B163"/>${pillsSvg(m, n)}
      <rect x="27" y="58" width="6" height="6" rx="3" fill="#fff" opacity=".35"/></g>
    <rect x="16" y="38" width="88" height="18" rx="4" fill="#EE8A1E"/><rect x="16" y="45" width="88" height="3" fill="rgba(0,0,0,.08)"/>
    <rect x="12" y="6" width="96" height="34" rx="7" fill="#F5F8F8"/>${ridges(12, 108, 12, 18)}<rect x="12" y="32" width="96" height="8" rx="3" fill="#E1E8E8"/>
    <rect x="20" y="6" width="10" height="26" rx="4" fill="#fff" opacity=".7"/></svg>`;
}
function bottle(m, { warn = false, still = false } = {}) {
  const sched = m.times.map(fmtTime).join(' · '), liquid = isLiquidMed(m);
  const inner = `${bottleArt(m)}
    <span class="rx__label" aria-hidden="true">
      <span class="rx__pharm">PillPal Pharmacy</span>
      <span class="rx__name" style="font-size:${nameSize(m.name, liquid ? 64 : 76)}px">${esc(m.name)}</span>
      ${m.dose ? `<span class="rx__dose">${esc(m.dose)}</span>` : ''}
      <span class="rx__sig">Take at ${esc(sched)}</span>
      ${liquid ? '' : `<span class="rx__for">For ${esc(S.user.name)}</span>`}
    </span>
    <span class="rx__stickers" aria-hidden="true">${warn ? '<span class="rx__sticker rx__sticker--warn">Check mixing</span>' : ''}${m.trialId ? '<span class="rx__sticker rx__sticker--study">Study</span>' : ''}</span>`;
  const cls = `rx rx--${liquid ? 'liquid' : 'pill'}`;
  return still ? `<span class="${cls} rx--still">${inner}</span>`
    : `<button type="button" class="${cls}" data-action="openMed" data-id="${esc(m._id)}" aria-label="${esc(`${m.name}${m.dose ? ', ' + m.dose : ''}${liquid ? ', liquid' : ''}. Doses at ${sched}.${warn ? ' Has a mixing warning.' : ''} Open details`)}">${inner}</button>`;
}
const cabinet = () => {
  const w = warned();
  return `<div class="cabinet" role="group" aria-label="Medicine cabinet"><div class="cabinet__back"><div class="shelves">
    ${S.meds.map(m => `<div class="shelf-slot">${bottle(m, { warn: w.has(m._id) })}</div>`).join('')}
    <div class="shelf-slot"><button type="button" class="rx-add" data-action="addMed">${icon('plus', { size: 22 })}<span>Add a bottle</span></button></div>
  </div></div></div>`;
};
PAGES.meds = async () => {
  await loadMeds();
  S.doses = await api(`/doses?date=${today()}`).catch(() => S.doses || []);
  api(`/doses/recent?today=${today()}`).then(r => (S.recent = r)).catch(() => {});
  const fresh = S.mix?.key === mixKey();
  $('#main').innerHTML = `${head({ title: 'My medicine cabinet', sub: 'Tap a bottle for details, Ask Pip, edit or remove it.', actions: medActions() })}
  <div class="stack" style="gap:20px" data-screen-label="My cabinet">
    ${S.meds.length > 1 ? `<div id="mixMeds">${fresh ? mixCard(S.mix.data, { always: true }) : `<p class="pp-caption row" style="gap:8px">${icon('shield-check', { size: 14 })}Pip is checking which of your pills shouldn’t be mixed…</p>`}</div>` : ''}
    ${S.meds.length ? '' : `<div class="pp-card pp-card--pad-md row" style="gap:16px;flex-wrap:nowrap">${pip('happy', 72)}<div><h2 class="pp-h4">Your cabinet is empty</h2><p class="pp-body-s pp-muted">Scan a bottle with your camera, or add one by hand.</p></div></div>`}
    <div id="cabinet">${cabinet()}</div>
  </div>`;
  if (S.meds.length > 1 && !fresh) loadMixes().then(d => {
    if (route() !== 'meds') return;
    const el = $('#mixMeds'); if (el) el.innerHTML = mixCard(d, { always: true });
    const c = $('#cabinet'); if (c && !c.contains(document.activeElement)) c.innerHTML = cabinet();
  }).catch(() => { const el = $('#mixMeds'); if (el) el.innerHTML = ''; });
};

// Bottle details: the label in full, how it's been feeling, mixing notes, and every action.
async function medDetail(m) {
  const pairs = (S.mix?.key === mixKey() ? S.mix.data.pairs : []).filter(p => p.a.id === m._id || p.b.id === m._id);
  const last = lastTaken(m);
  const facts = [runOut(m) && `Runs out around ${fmtDate(runOut(m))}`, refillWord(m), m.discardAfter && `Discard after ${fmtDate(m.discardAfter)}`].filter(Boolean);
  const d = openDialog({ title: m.name, label: `${m.name} details`, width: 560, body: `<div class="med-detail">
    <div class="med-detail__top"><span class="med-detail__bottle">${bottle(m, { warn: pairs.length > 0, still: true })}</span>
      <div class="stack" style="gap:10px;min-width:0">
        <p class="pp-body" style="color:var(--text-strong);font-weight:650">${esc([m.dose, m.reason && 'for ' + m.reason].filter(Boolean).join(' · ') || 'No dose added')}</p>
        <div class="row" style="gap:6px">${m.times.map(t => tag(fmtTime(t), { ic: 'bell' })).join('')}</div>
        ${m.instructions ? `<p class="pp-body-s">${esc(m.instructions)}</p>` : ''}
        ${last ? `<p class="pp-caption row" style="gap:6px">${icon('check', { size: 14 })}Last taken ${fmtTime(hm(last.at))}${last.date === today() ? ' today' : ' yesterday'}</p>` : ''}
        ${facts.length ? `<p class="pp-caption row" style="gap:6px;flex-wrap:nowrap;align-items:flex-start">${icon('package', { size: 14, style: 'margin-top:2px' })}<span>${esc(facts.join(' · '))}</span></p>` : ''}
        ${m.trialId ? `<div>${badge(`Study medication · ${esc(m.trialId)}`, { tone: 'accent', ic: 'flask-conical' })}</div>` : ''}
      </div></div>
    ${pairs.length ? `<div class="note note--due"><strong class="row" style="gap:6px">${icon('triangle-alert', { size: 16 })}Careful mixing</strong>
      <ul class="list list--s">${pairs.map(p => `<li><strong>${esc(p.a.id === m._id ? p.b.name : p.a.name)}</strong>: ${esc(p.plain || `the ${p.labelOf} label says “${p.snippet}”`)}</li>`).join('')}</ul>
      <span>Ask your pharmacist before changing anything.</span></div>` : ''}
    <div class="stack" style="gap:8px"><h3 class="pp-h4">How it’s been feeling</h3><div id="mdFeel"><p class="pp-caption">Loading…</p></div></div>
    <div class="med-detail__acts">
      ${btn('Take a dose now', { size: 'sm', left: 'check', a: { 'data-action': 'dose', 'data-status': 'taken', 'data-med': m._id, 'data-time': pickSlot(m, { near: true }), 'data-date': today(), 'data-close': '', 'aria-label': `Take a dose of ${m.name} now` } })}
      ${btn('How do you feel?', { variant: 'secondary', size: 'sm', left: 'heart-pulse', a: { 'data-action': 'medCheckin', 'data-med': m._id, 'data-close': '' } })}
      ${aiOn() ? btn('Ask Pip', { variant: 'soft', size: 'sm', left: 'messages-square', a: { 'data-action': 'askMed', 'data-id': m._id, 'data-close': '' } }) : ''}
      ${btn('Edit', { variant: 'secondary', size: 'sm', left: 'pencil', a: { 'data-action': 'editMed', 'data-id': m._id, 'data-close': '' } })}
      ${btn('Stop tracking', { variant: 'ghost', size: 'sm', left: 'circle-pause', a: { 'data-action': 'delMed', 'data-id': m._id, 'data-close': '' } })}
      ${btn('Remove', { variant: 'danger', size: 'sm', left: 'trash-2', a: { 'data-action': 'removeMed', 'data-id': m._id, 'data-close': '' } })}
    </div></div>` });
  const list = await api(`/medcheckins?medId=${m._id}&limit=5`).catch(() => []);
  const box = $('#mdFeel', d.el); if (!box) return;
  box.innerHTML = list.length ? `<div class="stack" style="gap:6px">${list.map(c => `<div class="hist"><span class="hist__date">${c.date === today() ? 'Today' : esc(fmtDate(c.date))}</span>
      <span style="color:${MOOD_COL[c.mood - 1]}">${icon(MOODS[c.mood - 1][0], { size: 22, title: MOODS[c.mood - 1][1] })}</span>
      <span class="pp-caption hist__fx">${esc([c.sideEffects.join(', '), c.notes].filter(Boolean).join(' · ') || 'No side effects')}</span></div>`).join('')}</div>`
    : '<p class="pp-body-s pp-muted">No check-ins for this one yet. After you take it, tap “How do you feel?”</p>';
}

// "How do you feel on this one?" Offered right after a dose; saved per medication and shown on the doctor report.
function medCheckinDialog(m, time = '') {
  const d = openDialog({ title: `How do you feel on ${m.name}?`, width: 560, body: `<form class="stack" style="gap:20px;margin-top:8px" novalidate>
    <p class="pp-body-s pp-muted">A quick note about this medicine. It goes on your doctor report.</p>
    <fieldset><legend class="pp-field__label" style="margin-bottom:10px">Right now I feel</legend>
      <div class="moods">${MOODS.map(([ic, l], i) => `<label class="mood" style="--mood:${MOOD_COL[i]}"><input type="radio" name="mood" value="${i + 1}" required>
        <span class="mood__box">${icon(ic, { size: 30, stroke: 1.75 })}<span class="mood__label">${l}</span></span></label>`).join('')}</div></fieldset>
    <fieldset><legend class="pp-field__label" style="margin-bottom:10px">Noticing anything? <span class="pp-caption" style="font-weight:500">Pick any</span></legend>
      <div class="row" style="gap:8px">${EFFECTS.map(e => `<label class="chip"><input type="checkbox" name="sideEffects" value="${e}"><span class="pp-tag pp-tag--interactive">${icon('check', { size: 14, stroke: 2.6, cls: 'chip__check' })}${e}</span></label>`).join('')}</div></fieldset>
    ${textarea({ label: 'Anything else?', hint: '(optional)', a: { name: 'notes', maxlength: 1000, rows: 3, placeholder: `How’s ${m.name} treating you?` } })}
    <div class="alert" role="alert" hidden></div>
    <div class="row" style="justify-content:flex-end;gap:10px">${btn('Not now', { variant: 'ghost', a: { 'data-close': '' } })}${btn('Save', { left: 'check', a: { type: 'submit' } })}</div></form>` });
  const form = $('form', d.el);
  form.onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(form), err = $('.alert', form);
    if (!f.get('mood')) { err.hidden = false; err.textContent = 'Pick how you’re feeling first.'; return $('input[name=mood]', form).focus(); }
    const sb = e.submitter || $('button[type=submit]', form); sb.disabled = true;
    try {
      const c = await api('/medcheckins', { method: 'POST', body: { medId: m._id, date: today(), time, mood: +f.get('mood'), sideEffects: f.getAll('sideEffects'), notes: f.get('notes') } });
      (S.mc ||= []).unshift(c);
      d.close(); chime();
      toast({ tone: 'taken', title: 'Thanks for checking in', message: `Saved for ${m.name}. It’s on your doctor report.` });
      if (route() === 'today') render();
    } catch (x) { err.hidden = false; err.textContent = x.message; sb.disabled = false; }
  };
}

const timeRow = t => `<div class="pp-input time-row">${icon('bell', { size: 18 })}<input type="time" name="times" value="${esc(t)}" aria-label="Reminder time" required>
  ${iconBtn('trash-2', 'Remove this time', { size: 'sm', a: { 'data-rm': '' } })}</div>`;
const lookupHtml = info => info
  ? `<strong style="color:var(--text-strong)">${esc(title(info.brand || info.generic))}${info.generic ? ` (${esc(info.generic.toLowerCase())})` : ''}</strong>
     <span>${esc(info.uses || 'No usage summary on the label.')}</span>${info.boxedWarning ? `<span class="boxed-mini">Boxed warning: ${esc(info.boxedWarning)}</span>` : ''}`
  : '<strong style="color:var(--text-strong)">No match</strong><span>I couldn’t find that name. Check the spelling, or keep it as typed.</span>';

function medDialog(m = {}) {
  const st = { shape: m.shape || 'round', color: m.color || PILL_COLORS[S.meds.length % PILL_COLORS.length][0], form: m.form || (/\b(ml|tsp|teaspoon|syrup|solution|suspension|liquid|drops?)\b/i.test(`${m.dose || ''} ${m.name || ''}`) ? 'liquid' : 'pill') };
  const preview = () => (st.form === 'liquid' ? icon('droplet', { size: 40, color: liquidColor(st), stroke: 2.2 }) : pill(medPill(st), 44));
  const swatches = () => PILL_COLORS.map(([c, n]) => `<button type="button" class="swatch" role="radio" aria-checked="${c === st.color}" aria-label="${n}" title="${n}" data-color="${c}" style="background:${c}"></button>`).join('');
  const d = openDialog({ title: `${m._id ? 'Edit' : 'Add'} medication`, width: 560, body: `<form class="stack" style="gap:18px;margin-top:12px" novalidate>
    <div class="row" style="gap:10px;align-items:flex-end;flex-wrap:nowrap"><div style="flex:1;min-width:0">${input({ label: 'Medication name', a: { id: 'mName', name: 'name', required: true, autocomplete: 'off', value: m.name, placeholder: 'e.g. Lipitor or atorvastatin' } })}</div>
      ${btn('Look up', { variant: 'secondary', left: 'search', a: { id: 'mLookup' } })}</div>
    <div id="mInfo" class="lookup" aria-live="polite" hidden></div>
    <div class="grid-2">${input({ label: 'Dose', a: { name: 'dose', value: m.dose, placeholder: '10 mg, 1 tablet' } })}${input({ label: 'What it’s for (optional)', a: { name: 'reason', value: m.reason, placeholder: 'Cholesterol' } })}</div>
    ${input({ label: 'Instructions (optional)', a: { name: 'instructions', value: m.instructions, placeholder: 'Take with food' } })}
    <fieldset class="stack" style="gap:8px"><legend class="pp-field__label" style="margin-bottom:8px">Reminder times</legend>
      <div id="mTimes" class="stack" style="gap:8px">${(m.times?.length ? m.times : ['08:00']).map(timeRow).join('')}</div>
      <div>${btn('Add another time', { variant: 'ghost', size: 'sm', left: 'plus', a: { id: 'mAddTime' } })}</div>
      ${m.sig?.times?.length ? `<p class="pp-caption">${icon('sparkles', { size: 12, style: 'display:inline;vertical-align:-1px' })} Suggested from your label${m.sig.directions ? ` (“${esc(m.sig.directions)}”)` : ''}. Change them if your care team told you otherwise.</p>`
        : m.sig?.asNeeded ? '<p class="pp-caption">Your label says “as needed”. Keep one time as a gentle check-in; skip it on days you don’t need it.</p>' : ''}</fieldset>
    <fieldset><legend class="pp-field__label" style="margin-bottom:10px">What it looks like <span class="pp-caption" style="font-weight:500">so you can spot it fast</span></legend>
      <div class="row" style="gap:16px"><span class="pp-pill-icon" id="mPreview" style="width:64px;height:64px">${preview()}</span>
        <div class="stack" style="gap:10px"><div id="mForm">${tabs([{ value: 'pill', label: 'Pills' }, { value: 'liquid', label: 'Liquid' }], st.form, { action: 'form', label: 'Pills or liquid' })}</div>
          <div id="mShape" ${st.form === 'liquid' ? 'hidden' : ''}>${tabs([{ value: 'round', label: 'Round' }, { value: 'oval', label: 'Oval' }, { value: 'capsule', label: 'Capsule' }], st.shape, { action: 'shape', label: 'Pill shape' })}</div>
          <div role="radiogroup" aria-label="Pill color" class="row" style="gap:8px" id="mColors">${swatches()}</div></div></div></fieldset>
    ${input({ label: 'Hours between doses (optional)', hint: `${m.interval?.by === 'pip' ? `Pip worked out ${hoursWord(m.interval.hours)} (${esc(m.interval.basis)}). ` : ''}Leave blank and Pip works it out from your directions and the FDA label. Your timer uses this.`,
      a: { name: 'intervalHours', type: 'number', min: 0.5, max: 168, step: 0.5, value: m.intervalHours ?? '', placeholder: 'Pip decides', inputmode: 'decimal' } })}
    ${input({ label: 'Clinical trial ID (only if this is a study medication)', a: { name: 'trialId', value: m.trialId, placeholder: 'NCT12345678' } })}
    <details class="refill" ${[m.quantity, m.refills, m.fillDate, m.discardAfter].some(v => v !== '' && v != null) ? 'open' : ''}>
      <summary><span class="pp-field__label">Refill details</span> <span class="pp-caption">(optional) for run-out and discard-after reminders</span></summary>
      <div class="grid-2" style="margin-top:12px">
        ${input({ label: 'Pills in the bottle', a: { name: 'quantity', type: 'number', min: 0, max: 10000, step: 1, value: m.quantity ?? '', placeholder: '60' } })}
        ${input({ label: 'Pills per dose', a: { name: 'unitsPerDose', type: 'number', min: 0.25, max: 20, step: 0.25, value: m.unitsPerDose ?? '', placeholder: '1' } })}
        ${input({ label: 'Filled on', a: { name: 'fillDate', type: 'date', value: m.fillDate || '' } })}
        ${input({ label: 'Refills left', a: { name: 'refills', type: 'number', min: 0, max: 99, step: 1, value: m.refills ?? '', placeholder: '2' } })}
        ${input({ label: 'Discard after', a: { name: 'discardAfter', type: 'date', value: m.discardAfter || '' } })}
      </div></details>
    <div class="note note--info" id="mDup" hidden></div>
    <div class="alert" role="alert" id="mErr" hidden></div>
    <div class="row" style="justify-content:flex-end;gap:10px;padding-top:4px">${btn('Cancel', { variant: 'ghost', a: { 'data-close': '' } })}${btn('Save', { left: 'check', a: { type: 'submit' } })}</div>
  </form>` });
  const form = $('form', d.el), timesBox = $('#mTimes', d.el);
  d.el.addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (rm && timesBox.children.length > 1) rm.closest('.time-row').remove();
    const fm = e.target.closest('[data-action="form"]');
    if (fm) { st.form = fm.dataset.value; d.el.querySelectorAll('[data-action="form"]').forEach(b => b.setAttribute('aria-selected', b === fm)); $('#mShape', d.el).hidden = st.form === 'liquid'; $('#mPreview', d.el).innerHTML = preview(); }
    const sh = e.target.closest('[data-action="shape"]');
    if (sh) { st.shape = sh.dataset.value; d.el.querySelectorAll('[data-action="shape"]').forEach(b => b.setAttribute('aria-selected', b === sh)); $('#mPreview', d.el).innerHTML = preview(); }
    const sw = e.target.closest('[data-color]');
    if (sw) { st.color = sw.dataset.color; $('#mColors', d.el).innerHTML = swatches(); $('#mPreview', d.el).innerHTML = preview(); $(`[data-color="${st.color}"]`, d.el).focus(); }
  });
  $('#mAddTime', d.el).onclick = () => { timesBox.insertAdjacentHTML('beforeend', timeRow('20:00')); timesBox.lastElementChild.querySelector('input').focus(); };
  $('#mLookup', d.el).onclick = async () => {
    const box = $('#mInfo', d.el), q = $('#mName', d.el).value.trim();
    if (!q) return $('#mName', d.el).focus();
    box.hidden = false; box.textContent = 'Checking the FDA database…';
    try { const { info } = await api(`/drug?q=${encodeURIComponent(q)}`); box.innerHTML = lookupHtml(info); }
    catch (x) { box.textContent = x.message; }
  };
  form.onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(form), err = $('#mErr', d.el);
    const body = { ...Object.fromEntries(['name', 'dose', 'reason', 'instructions', 'trialId', 'quantity', 'unitsPerDose', 'refills', 'fillDate', 'discardAfter', 'intervalHours'].map(k => [k, (f.get(k) || '').trim()])), ...st, times: f.getAll('times').filter(Boolean), today: today() };
    if (!body.name) { err.hidden = false; err.textContent = 'Add the medication name.'; return $('#mName', d.el).focus(); }
    const sb = e.submitter || $('button[type=submit]', form); if (sb) sb.disabled = true;
    // New med: same ingredient already tracked (Lipitor vs atorvastatin)? Offer to edit that one instead.
    if (!m._id && !form.dataset.dupOk) {
      const { duplicate } = await api('/meds/check', { method: 'POST', body: { name: body.name, dose: body.dose } }).catch(() => ({}));
      if (duplicate) {
        const box = $('#mDup', d.el), existing = S.meds.find(x => x._id === duplicate.id);
        box.hidden = false;
        box.innerHTML = `<strong>You already track ${esc(duplicate.name)}${duplicate.dose ? ` · ${esc(duplicate.dose)}` : ''}.</strong>
          <span>${duplicate.sameStrength ? 'Adding it again would double your reminders.' : 'Different strength? If your dose changed, update the old entry instead.'}</span>
          <div class="row" style="gap:8px">${existing ? btn(`Edit ${esc(duplicate.name)} instead`, { size: 'sm', a: { 'data-dup': 'edit' } }) : ''}${btn('Add anyway', { variant: 'ghost', size: 'sm', a: { 'data-dup': 'add' } })}</div>`;
        $('[data-dup="add"]', box).onclick = () => { form.dataset.dupOk = '1'; form.requestSubmit(); };
        if (existing) $('[data-dup="edit"]', box).onclick = () => { d.close(); medDialog(existing); };
        if (sb) sb.disabled = false;
        return $('button', box).focus();
      }
    }
    try {
      await (m._id ? api(`/meds/${m._id}`, { method: 'PUT', body }) : api('/meds', { method: 'POST', body }));
      d.close();
      await loadMeds();
      if (route() === 'scan') location.hash = '#/meds'; else await render();
      chime();
      toast({ tone: 'taken', title: `${body.name} saved`, message: `I’ll remind you at ${[...new Set(body.times)].sort().map(fmtTime).join(', ')}.` });
    } catch (x) { err.hidden = false; err.textContent = x.message; if (sb) sb.disabled = false; }
  };
}

// ---------- Scan ----------
// Flow: live camera → quality gate on every frame (light, blur, glare) with spoken hints → barcode check → auto-capture
// when the frame is clear (or the button) → Pip (Gemini) reads only what's inside the frame → basic reader fallback with
// a second look when unsure → server matches through RxNorm → result + recall / duplicate / interaction checks.
let worker;
const loadScript = src => new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => fail(new Error('Could not load the label reader. Check your connection.')); document.head.append(s); });
const SCAN_TIPS = [['sun', 'Face a window or lamp, or turn on the light'], ['maximize', 'Fill the frame with the label'], ['hand', 'Hold still. I scan as soon as it’s clear'],
  ['scan-line', 'A barcode on a box or stock bottle works too'], ['volume-2', 'Low vision? Ask your pharmacy about free talking labels']];
const pref = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v === 'on'; } catch { return d; } };
const savePref = (k, on) => { try { localStorage.setItem(k, on ? 'on' : 'off'); } catch { /* per-device nicety */ } };
const camPref = () => pref('pp-cam', true), autoPref = () => pref('pp-auto', true);
const scanDebug = () => { try { return localStorage.getItem('pp-scandebug') === '1'; } catch { return false; } };
const idleMsg = () => S.stream ? (autoPref() ? 'Hold the label inside the frame. I’ll scan when it’s clear' : 'Fit the label inside the frame, then press scan') : 'Webcam off. Type the name, use a photo, or turn it on';

function scanStatus(text, state = S.scanState) {
  const ic = state === 'matched' ? icon('circle-check', { size: 16, color: '#6FE3AE' }) : state === 'error' ? icon('circle-alert', { size: 16, color: '#FF9C9C' }) : '<span class="pp-scan__pulse"></span>';
  const el = $('#scanStatus'); if (el) el.innerHTML = `${ic}<span>${esc(text)}</span>`;
}
function setScan(state, text) {
  const f = $('#scanner'); if (!f) return;
  S.scanState = state;
  f.className = `pp-scan pp-scan--${state}${S.stream ? ' pp-scan--live' : ''}${S.photo ? ' pp-scan--photo' : ''}`;
  scanStatus(text, state);
  const b = $('#scanBtn');
  b.disabled = state === 'scanning';
  b.lastChild.textContent = state === 'scanning' ? 'Scanning…' : state === 'idle' ? 'Start scan' : 'Scan again';
  if (state === 'idle' || state === 'scanning') { if (!$('#scanSide .tips')) $('#scanSide').innerHTML = tipsCard(); }
  S.hintKey = null;
}
const tipsCard = () => `<div class="pp-card pp-card--pad-lg stack tips" style="gap:16px"><h3 class="pp-h4">For a clean scan</h3>
  ${SCAN_TIPS.map(([ic, l]) => `<div class="row" style="gap:12px;flex-wrap:nowrap"><span class="tile tile--brand-soft tile--sm">${icon(ic, { size: 18 })}</span><span style="color:var(--text-strong);font-weight:550">${l}</span></div>`).join('')}</div>`;
function stopCamera() {
  clearInterval(S.scanTimer); S.scanTimer = null;
  S.stream?.getTracks().forEach(t => t.stop()); S.stream = null;
  $('#scanner')?.classList.remove('pp-scan--live', 'pp-scan--ready');
  S.light = false; lightUI();
}
// Spoken hints for people who use read-aloud: only when the hint changes, at most every 4 seconds.
function speakHint(text) {
  if (!S.user?.prefs?.voice || !text || (text === S.spokeText && Date.now() - S.spokeAt < 15000) || Date.now() - (S.spokeAt || 0) < 4000) return;
  S.spokeText = text; S.spokeAt = Date.now(); speak(text);
}

// Light for dark rooms: the camera's own flashlight (torch) when it has one, which is most phone back cameras.
// Laptop webcams have none and face the user, so the screen turns white around the preview to light the label.
const torchTrack = () => { const t = S.stream?.getVideoTracks()[0]; return t?.getCapabilities?.().torch ? t : null; };
function lightUI() {
  const on = !!S.light, torch = !!torchTrack();
  document.body.classList.toggle('scan-light', on && !torch);
  const b = $('#lightBtn'); if (!b) return;
  b.disabled = !S.stream;
  b.setAttribute('aria-pressed', on);
  b.lastChild.textContent = on ? 'Light on' : torch ? 'Flashlight' : 'Screen light';
  b.title = torch ? 'Turn your camera’s flashlight on or off' : 'This camera has no flashlight, so the screen lights the label instead (Esc turns it off)';
}
async function setLight(on) {
  const t = torchTrack();
  if (t) {
    try { await t.applyConstraints({ advanced: [{ torch: on }] }); }
    catch { on = false; toast({ tone: 'missed', title: 'Flashlight unavailable', message: 'Your browser blocked the flashlight. Try a lamp or a window instead.' }); }
  }
  S.light = on;
  lightUI();
  if (on) announce(t ? 'Flashlight on' : 'Screen light on');
}
addEventListener('keydown', e => { if (e.key === 'Escape' && S.light && !torchTrack()) setLight(false); });

PAGES.scan = async () => {
  S.scanState = 'idle'; S.photo = null; S.autoFails = 0; S.autoTries = []; S.lastAutoThumb = null;
  $('#main').innerHTML = `${head({ title: 'Scan a pill bottle', sub: 'Hold the label up to your camera. Pip reads it and checks the FDA label for you.' })}
  <div class="cols" data-screen-label="Scan bottle">
    <div class="col col--main" style="gap:16px">
      <div class="pp-scan pp-scan--idle" id="scanner">
        <video id="cam" playsinline muted aria-label="Camera preview"></video>
        <img id="scanPhoto" class="pp-scan__photo" alt="Your photo of the label" hidden>
        <div class="pp-scan__reticle" aria-hidden="true"><span class="pp-scan__corner pp-scan__corner--tl"></span><span class="pp-scan__corner pp-scan__corner--tr"></span>
          <span class="pp-scan__corner pp-scan__corner--bl"></span><span class="pp-scan__corner pp-scan__corner--br"></span><span class="pp-scan__line"></span>
          <div class="pp-scan__pill" id="scanPill"></div></div>
        <div class="pp-scan__status" id="scanStatus" role="status"><span class="pp-scan__pulse"></span><span>${esc(idleMsg())}</span></div>
      </div>
      <div class="row scan-controls" style="gap:12px;justify-content:space-between">
        <div class="row" style="gap:16px">${toggle({ label: 'Use webcam', checked: camPref(), a: { id: 'camToggle' } })}${toggle({ label: 'Auto-scan', checked: autoPref(), a: { id: 'autoToggle' } })}</div>
        <div class="row" style="gap:10px;margin-left:auto">${btn('Flashlight', { variant: 'secondary', left: 'flashlight', a: { 'data-action': 'light', id: 'lightBtn', 'aria-pressed': 'false', disabled: true } })}
          ${btn('Start scan', { size: 'lg', left: 'scan-line', a: { 'data-action': 'capture', id: 'scanBtn' } })}</div></div>
      <div class="pp-card pp-card--pad-md stack" style="gap:14px">
        <form class="row" id="manual" style="gap:12px;align-items:flex-end">
          <div style="flex:1 1 240px;min-width:0">${input({ label: 'No camera? Type the name on the label', ic: 'keyboard', a: { id: 'manualQ', type: 'search', placeholder: 'e.g. metformin', autocomplete: 'off' } })}</div>
          ${btn('Look it up', { variant: 'secondary', left: 'search', a: { type: 'submit' } })}</form>
        <div class="row" style="gap:10px"><span class="pp-body-s pp-muted">Or</span>
          <label class="pp-btn pp-btn--ghost pp-btn--sm" for="photoIn">${icon('image', { size: 16 })}Use a photo of the label</label>
          <input id="photoIn" type="file" accept="image/*" capture="environment" class="sr-only"></div>
      </div>
      <p class="pp-caption">Only the area inside the frame is sent to Pip (Google Gemini) to read; the basic reader works on this device. Drug facts come from FDA labels (openFDA) and names are checked against RxNorm. Your own prescription label and pharmacist come first.</p>
    </div>
    <div class="col" id="scanSide" aria-live="polite">${tipsCard()}</div>
  </div>`;
  $('#manual').onsubmit = async e => {
    e.preventDefault();
    const q = $('#manualQ').value.trim();
    if (!q) return $('#manualQ').focus();
    setScan('scanning', 'Looking it up…');
    try { showResult(await api(`/drug?q=${encodeURIComponent(q)}`), q); } catch (x) { if (x.status === 401) throw x; setScan('error', x.message); scanError(x.message); }
  };
  $('#camToggle').onchange = e => {
    savePref('pp-cam', e.target.checked);
    if (e.target.checked) startCamera(); else { stopCamera(); setScan('idle', idleMsg()); }
  };
  $('#autoToggle').onchange = e => { savePref('pp-auto', e.target.checked); if (S.scanState === 'idle') scanStatus(idleMsg()); };
  $('#photoIn').onchange = e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) scanPhoto(f); };
  if (camPref()) startCamera(); else setScan('idle', idleMsg());
  if (!aiOn()) setTimeout(() => ocrWorker().catch(() => {}), 300); // warm up the on-device reader while the user lines up the bottle
};

async function startCamera() {
  try {
    stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no camera'), { name: 'NotFoundError' });
    setScan('idle', 'Starting camera…');
    S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    if (!$('#cam')) return stopCamera(); // navigated away while the permission prompt was open
    const track = S.stream.getVideoTracks()[0];
    // Phones: keep refocusing as the bottle moves (where the camera supports it).
    if (track.getCapabilities?.().focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    $('#cam').srcObject = S.stream;
    await $('#cam').play();
    clearPhoto();
    lightUI();
    setScan('idle', idleMsg());
    barcodeReader(); // warm up the barcode reader in the background
    S.scanTimer = setInterval(scanTick, 250);
  } catch (e) {
    stopCamera();
    if (!$('#camToggle')) return;
    $('#camToggle').checked = false;
    savePref('pp-cam', false); // don't nag on every visit; the switch turns it back on
    setScan('idle', 'Camera off. Type the name or use a photo');
    toast({ tone: 'missed', title: 'Camera unavailable', message: e.name === 'NotAllowedError' ? 'Allow camera access from the icon in your browser’s address bar, or type the name below.' : 'No camera found. Type the medication name or use a photo instead.' });
  }
}

// Runs 4 times a second while the camera is live and nothing else is happening.
function scanTick() {
  const v = $('#cam'), f = $('#scanner');
  if (!v || !f || !S.stream || !v.videoWidth || S.scanState !== 'idle' || S.busy || document.hidden) return;
  const q = frameQuality(grabFrame(v, f, { maxSide: 320 })), j = judge(q), blocks = j && j.key !== 'glare'; // glare is a hint, not a stop
  S.steadyRun = frameDiff(q.thumb, S.prevThumb) < 5 ? (S.steadyRun || 0) + 1 : 0;
  S.prevThumb = q.thumb;
  f.classList.toggle('pp-scan--ready', !blocks);
  const key = j?.key || 'ok';
  if (scanDebug()) scanStatus(`${j ? j.text : 'Clear'} · light ${q.brightness | 0} · sharp ${q.sharpness | 0} · glare ${Math.round(q.glare * 100)}%`);
  else if (key !== S.hintKey) scanStatus(j ? j.text : autoPref() ? 'Looks clear. Hold still…' : 'Looks clear. Press scan');
  if (key !== S.hintKey && j) speakHint(j.speak);
  S.hintKey = key;
  // Barcodes: every other tick, on a slightly bigger area than the frame.
  if ((S.tick = (S.tick || 0) + 1) % 2 === 0 && !S.barcodeBusy) {
    S.barcodeBusy = true;
    readBarcodes(grabFrame(v, f, { margin: 0.15, maxSide: 1000 })).then(found => {
      S.barcodeBusy = false;
      const hit = found.map(b => ({ ...b, ...ndcFromBarcode(b.raw) })).find(b => b.ndc10);
      if (hit && S.scanState === 'idle' && !S.busy) scanBarcode(hit);
    });
  }
  // Auto-scan: clear for ~0.75 s, sharp enough to hold text, a different view from the last try, and at most 3 tries a minute.
  S.okRun = blocks ? 0 : (S.okRun || 0) + 1;
  // Fire when the frame has been clear for ~0.75 s, or (if the limits don't suit this webcam) after ~2 s of a steady, lit view.
  const clear = S.okRun >= 3 && q.sharpness >= GATE.autoSharp, steady = S.steadyRun >= 8 && q.brightness >= GATE.dark && q.sharpness >= 15;
  if (!autoPref() || !(clear || steady) || Date.now() - (S.lastAutoAt || 0) < 4000 || frameDiff(q.thumb, S.lastAutoThumb) < 12) return;
  S.autoTries = (S.autoTries || []).filter(t => Date.now() - t < 60e3);
  if (S.autoTries.length >= 3) return;
  S.autoTries.push(Date.now()); S.lastAutoAt = Date.now(); S.lastAutoThumb = q.thumb; S.okRun = 0;
  capture('auto');
}

async function scanBarcode(hit) {
  if (S.busy) return;
  S.busy = true;
  setScan('scanning', 'Barcode found. Looking it up…');
  speakHint('Barcode found.');
  try { showResult({ ...(await api(`/drug/ndc?ndc=${hit.ndc10}`)), barcode: hit }); }
  catch (x) { if (x.status === 401) return renderAuth(); setScan('error', 'Couldn’t look up that barcode'); scanError(x.message); }
  finally { S.busy = false; }
}
async function scanPhoto(file) {
  try {
    const url = URL.createObjectURL(file), img = $('#scanPhoto');
    img.src = url; await img.decode();
    S.photo = imageToCanvas(img, 1600);
    img.hidden = false;
    $('#scanPill').innerHTML = '';
    capture('photo');
  } catch { toast({ tone: 'missed', title: 'Couldn’t open that photo', message: 'Try a JPEG or PNG photo of the label.' }); }
}
function clearPhoto() { S.photo = null; const img = $('#scanPhoto'); if (img) { img.hidden = true; if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src); img.removeAttribute('src'); } }

async function capture(source = 'button') {
  const v = $('#cam'), f = $('#scanner'), photo = source === 'photo' ? S.photo : null;
  if (source === 'button' && (S.scanState === 'matched' || S.scanState === 'error')) { resetScan(); if (!S.stream) return; }
  if (!photo && (!S.stream || !v?.videoWidth)) {
    if (source === 'auto') return;
    if (!$('#camToggle').checked) { $('#camToggle').checked = true; savePref('pp-cam', true); return startCamera(); }
    return toast({ tone: 'info', title: 'Camera is still starting', message: 'Give it a second, or type the name below.' });
  }
  if (!photo && S.photo) clearPhoto();
  if (S.busy) return;
  S.busy = true;
  setScan('scanning', source === 'auto' ? 'Clear shot. Reading…' : 'Hold still…');
  const grab = (margin, o) => photo || grabFrame(v, f, { margin, ...o });
  try {
    const t0 = performance.now(), T = {};
    const bc = (await readBarcodes(photo ? imageToCanvas(photo, 1000) : grabFrame(v, f, { margin: 0.15, maxSide: 1000 }))).map(b => ({ ...b, ...ndcFromBarcode(b.raw) })).find(b => b.ndc10);
    T.barcode = performance.now() - t0;
    if (bc) { S.busy = false; return scanBarcode(bc); }
    if (aiOn()) {
      setScan('scanning', 'Pip is reading the label…');
      // Only what's inside the frame (plus a little room) leaves the device.
      const a = performance.now();
      try {
        const res = await api('/ai/scan', { method: 'POST', body: { image: grab(0.12, { maxSide: 1280 }).toDataURL('image/jpeg', 0.85) } });
        T.pip = performance.now() - a; logScan(T, t0);
        return showResult(res, null, source);
      } catch (x) { if (x.status === 401) throw x; ocrWorker(); setScan('scanning', 'Pip is busy, using the basic reader…'); }
    }
    const o = performance.now();
    let r = await ocrRead(grab(0.04, { maxSide: 1400, minSide: 900 }));
    T.reader = performance.now() - o;
    // Agreement rule: an unsure camera match gets a second look at a fresh frame, and only counts as sure if both agree.
    if (r.info && !r.info.confident && !photo && S.stream) {
      setScan('scanning', 'Taking a second look…');
      await new Promise(ok => setTimeout(ok, 350));
      const r2 = await ocrRead(grabFrame(v, f, { margin: 0.04, maxSide: 1400, minSide: 900 }));
      const id = x => x?.info?.rx?.rxcui || x?.info?.generic;
      if (r2.info && id(r2) === id(r)) r.info.confident = true;
      else if (r2.info?.confident) r = r2;
      else r.unsure = true;
      T.secondLook = performance.now() - o - T.reader;
    }
    logScan(T, t0);
    showResult(r, null, source);
  } catch (x) {
    if (x.status === 401) return renderAuth();
    setScan('error', 'Couldn’t read that. Try a bit more light');
    scanError(x.message);
  } finally { S.busy = false; }
}
// The basic reader's engine (~1–2 s to start, plus a few MB to download the first time) is started in the background
// as soon as it might be needed, not when the user presses scan.
function ocrWorker() {
  return (worker ||= (async () => {
    if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
    // Drug names aren't dictionary words, so Tesseract's English word lists are switched off.
    return Tesseract.createWorker('eng', 1, {
      logger: m => m.status === 'recognizing text' && S.scanState === 'scanning' && scanStatus(`Reading label… ${Math.round(m.progress * 100)}%`),
    }, { load_system_dawg: '0', load_freq_dawg: '0' });
  })().catch(e => { worker = null; throw e; }));
}
const logScan = (T, t0) => console.info('[scan] ' + Object.entries(T).map(([k, v]) => `${k} ${Math.round(v)} ms`).join(' · ') + ` · total ${Math.round(performance.now() - t0)} ms`);
async function ocrRead(canvas) {
  if (!worker) setScan('scanning', 'Loading the label reader…');
  const w = await ocrWorker();
  scanStatus('Reading label…');
  const { data: { text } } = await w.recognize(prepForOcr(canvas));
  if (!/[a-z]{4}/i.test(text)) return { info: null };
  scanStatus('Checking the national drug list…');
  return api('/drug/scan', { method: 'POST', body: { text: text.slice(0, 5000) } });
}
function resetScan() { $('#scanPill').innerHTML = ''; clearPhoto(); setScan('idle', idleMsg()); }

// Nothing matched: say what to try, and let the user tap the right word or a near match (tap-to-pick).
function scanError(msg, candidates = [], alternatives = []) {
  const picks = [...alternatives.map(a => a.name), ...candidates.map(title)].filter((x, i, a) => x && a.indexOf(x) === i).slice(0, 8);
  $('#scanSide').innerHTML = `<div class="pp-card pp-card--elevated pp-card--pad-lg stack pop" style="gap:14px" role="status">
    <div>${badge('No match', { tone: 'missed', ic: 'circle-alert' })}</div>
    <h2 class="pp-h3" tabindex="-1" id="srH">Couldn’t read that one</h2><p class="pp-body-s">${esc(msg)}</p>
    ${picks.length ? `<div class="stack" style="gap:8px"><p class="pp-body-s" style="font-weight:650;color:var(--text-strong)">See the medicine name here? Tap it.</p>
      <div class="row" style="gap:8px">${picks.map(p => tag(esc(p), { a: { 'data-action': 'pickDrug', 'data-name': p } })).join('')}</div></div>` : ''}
    <div class="row">${btn('Scan again', { left: 'scan-line', a: { 'data-action': 'closeResult' } })}${btn('Add by hand', { variant: 'secondary', a: { 'data-action': 'addMed' } })}</div></div>`;
  $('#srH').focus({ preventScroll: true });
}

const fmtShort = d => fmtDate(d, { month: 'short', day: 'numeric', year: 'numeric' });
function showResult(r, typed, source) {
  const { info, strength, candidates = [], label, alternatives = [], sig, look, barcode, unsure } = r;
  const read = label?.found ? label : null;
  S.lastWords = candidates;
  if (!info && !read) {
    if (source === 'auto' && (S.autoFails = (S.autoFails || 0) + 1) < 3) return setScan('idle', 'Couldn’t read that yet. Fill the frame with the label');
    S.autoFails = 0;
    setScan('error', 'Couldn’t read that. Try a bit more light');
    return scanError(typed ? `No FDA label matched “${typed}”. Check the spelling?` : r.conflicts?.[0] || 'Try brighter light, move closer so the label fills the frame, and hold still.', candidates, alternatives);
  }
  S.autoFails = 0;
  const name = info ? title(info.brand || info.generic) : title(read.drugName || read.genericName);
  const generic = info?.generic || read?.genericName || name;
  const strengthTxt = strength || read?.strength || '';
  const look2 = { shape: look?.shape || 'oval', colors: [look?.color || '#F1F4F4'] };
  setScan('matched', `${name}${strengthTxt ? ' ' + strengthTxt : ''} · ${barcode ? 'barcode read' : read ? 'label read' : 'found'}`);
  if (!S.stream && !S.photo) $('#scanPill').innerHTML = pill(look2, 110);
  chime();
  speakHint(`Found ${name}${strengthTxt ? ', ' + strengthTxt.replace(/\bmg\b/i, 'milligrams').replace(/\bmcg\b/i, 'micrograms') : ''}.`);
  const lot = barcode?.lot || read?.lot || '';
  S.prefill = { name, dose: strengthTxt, reason: '', instructions: read?.directions || sig?.directions || '', shape: look2.shape, color: look2.colors[0],
    form: /solution|suspension|syrup|liquid|elixir|drops/i.test(`${read?.dosageForm || ''} ${info?.route || ''} ${strengthTxt}`) || /\bml\b/i.test(strengthTxt) ? 'liquid' : 'pill',
    times: sig?.times?.length ? sig.times : undefined, sig, quantity: read?.quantity ?? '', refills: read?.refills ?? '', fillDate: read?.fillDate || '',
    discardAfter: read?.discardAfter || '', unitsPerDose: sig?.unitsPerDose ?? '' };
  const facts = [read?.quantity && `Qty ${read.quantity}`, read?.refills != null && read?.refills !== '' && `Refills: ${read.refills}`, read?.pharmacy, read?.fillDate && `Filled ${fmtShort(read.fillDate)}`,
    read?.discardAfter && `Discard after ${fmtShort(read.discardAfter)}`, lot && `Lot ${lot}`, (barcode?.expiry || read?.expiration) && `Expires ${fmtShort(barcode?.expiry || read.expiration)}`].filter(Boolean);
  const checks = [...(info?.conflicts || r.conflicts || []), ...(unsure ? ['I’m not fully sure about this one. Compare the name with your bottle.'] : [])].filter((x, i, a) => a.indexOf(x) === i);
  const sub = [generic !== name ? title(generic) : '', info?.route && title(info.route), strengthTxt].filter(Boolean).join(' · ');
  const tagLine = barcode ? badge('Read from barcode', { tone: 'taken', ic: 'scan-line' }) : read ? badge('Read by Pip', { tone: 'taken', ic: 'sparkles' })
    : badge(`Matched ${esc(info.matched ? title(info.matched) : typed || '')}`, { tone: 'taken', ic: 'check' });
  $('#scanSide').innerHTML = `<section class="pp-card pp-card--elevated pp-card--pad-lg stack pop" style="gap:16px" aria-labelledby="srH">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap">${tagLine}${iconBtn('x', 'Close', { size: 'sm', a: { 'data-action': 'closeResult' } })}</div>
    <div class="row" style="gap:14px;flex-wrap:nowrap">${pillBox(look2, 56, 40)}<div><h2 class="pp-h3" id="srH" tabindex="-1">${esc(name)}</h2>${sub ? `<div class="pp-body-s pp-muted">${esc(sub)}</div>` : ''}</div></div>
    ${checks.length ? `<div class="note note--due" role="alert"><strong class="row" style="gap:6px">${icon('triangle-alert', { size: 16 })}Check this</strong><ul class="list list--s">${checks.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
    ${alternatives.length ? `<div class="stack" style="gap:6px"><span class="pp-body-s pp-muted">Not right? Did you mean</span><div class="row" style="gap:6px">${alternatives.map(a => tag(esc(a.name), { a: { 'data-action': 'pickDrug', 'data-name': a.name } })).join('')}</div></div>` : ''}
    ${read?.directions || facts.length ? `<div class="pp-card pp-card--tinted pp-card--pad-sm stack" style="gap:6px"><span class="pp-overline">Your label says</span>
      ${read?.directions ? `<p style="font-weight:700;color:var(--text-strong)">${esc(read.directions)}</p>` : ''}${facts.length ? `<p class="pp-caption">${esc(facts.join(' · '))}</p>` : ''}
      ${read?.warnings?.length ? `<div class="row" style="gap:6px;margin-top:4px">${read.warnings.map(w => badge(esc(w), { tone: 'due', ic: 'triangle-alert' })).join('')}</div>` : ''}</div>` : ''}
    ${sig?.times?.length ? `<p class="pp-body-s row" style="gap:8px;flex-wrap:nowrap;align-items:flex-start">${icon('bell', { size: 16, color: 'var(--brand-text)', style: 'margin-top:3px' })}<span>Suggested reminders: <strong class="pp-mono">${sig.times.map(fmtTime).join(' · ')}</strong>. You can change them when you add it.</span></p>`
      : sig?.asNeeded ? `<p class="pp-body-s pp-muted">This one is “as needed”, so I won’t suggest reminder times.</p>` : ''}
    ${info?.boxedWarning ? `<div class="boxed"><strong class="row" style="gap:6px">${icon('triangle-alert', { size: 16 })}Boxed warning</strong><span>${esc(info.boxedWarning)}</span></div>` : ''}
    ${info?.uses ? `<div><div class="pp-overline pp-muted" style="margin-bottom:4px">Used for</div><p class="pp-body-s">${esc(info.uses)}</p></div>` : ''}
    ${info?.sideEffects ? `<div><div class="pp-overline pp-muted" style="margin-bottom:4px">Common side effects</div><p class="pp-body-s">${esc(info.sideEffects)}</p></div>`
      : info?.warnings ? `<div><div class="pp-overline pp-muted" style="margin-bottom:4px">Warnings</div><p class="pp-body-s">${esc(info.warnings)}</p></div>` : ''}
    ${!info ? '<p class="pp-caption">I read the label but could not find a matching FDA record. Double-check the name with your pharmacist.</p>' : ''}
    <div id="scanChecks" aria-live="polite">${info ? `<p class="pp-caption row" style="gap:8px">${icon('shield-check', { size: 14 })}Checking recalls and your other meds…</p>` : ''}</div>
    <div id="explainScan" aria-live="polite"></div>
    <div class="stack" style="gap:8px">${btn('Add to my cabinet', { size: 'lg', block: true, left: 'plus', a: { 'data-action': 'scanAdd' } })}
      <div class="row" style="gap:8px">${aiOn() ? btn('Explain it simply', { variant: 'secondary', left: 'sparkles', cls: 'grow', a: { 'data-action': 'explain', 'data-name': generic, 'data-target': 'explainScan' } }) : ''}
        ${btn('Related trials', { variant: 'ghost', left: 'flask-conical', cls: 'grow', a: { href: `#/trials?intr=${encodeURIComponent(generic)}` } })}</div></div>
    <p class="pp-caption">${info ? `Summarized from the FDA label${info.manufacturer ? ` (${esc(info.manufacturer)})` : ''}. ` : ''}Your own prescription label and pharmacist come first.</p></section>`;
  $('#srH').focus({ preventScroll: true });
  if (info) loadChecks(info, strengthTxt, lot);
}

// Recalls, "already tracking", and label interaction mentions. Filled in after the result shows.
async function loadChecks(info, strength, lot) {
  let c;
  try { c = await api('/drug/checks', { method: 'POST', body: { generic: info.generic || '', brand: info.brand || '', ndc: info.via === 'ndc' ? info.ndc || '' : '', lot, strength, ingredients: info.rx?.ingredients || [] } }); }
  catch { const el = $('#scanChecks'); if (el) el.innerHTML = ''; return; }
  const el = $('#scanChecks'); if (!el) return;
  const parts = [];
  if (c.duplicate) parts.push(`<div class="note note--info"><strong>You already track ${esc(c.duplicate.name)}${c.duplicate.dose ? ` · ${esc(c.duplicate.dose)}` : ''}.</strong>
    <span>${c.duplicate.sameStrength ? 'Adding it again would double your reminders.' : 'Different strength? If your dose changed, update the old entry instead.'}</span>
    <div>${btn(`Edit ${esc(c.duplicate.name)} instead`, { variant: 'secondary', size: 'sm', a: { 'data-action': 'editMed', 'data-id': c.duplicate.id } })}</div></div>`);
  if (c.recalls.length) {
    const mine = c.recalls.some(x => x.lotMatch);
    parts.push(`<div class="note note--missed" role="alert"><strong class="row" style="gap:6px">${icon('circle-alert', { size: 16 })}${mine ? 'Your lot number is on an FDA recall' : 'There’s an open FDA recall for this medicine'}</strong>
      <ul class="list list--s">${c.recalls.slice(0, 2).map(x => `<li>${esc(x.reason || x.product)}${x.classification ? ` (${esc(x.classification)}${x.date ? `, ${esc(fmtShort(x.date))}` : ''})` : ''}</li>`).join('')}</ul>
      <span>${mine ? 'Call your pharmacy today.' : 'It may not affect your bottle. Ask your pharmacy.'} Don’t stop taking it without talking to them.</span></div>`);
  }
  if (c.interactions.length) parts.push(`<div class="note note--warm"><strong class="row" style="gap:6px">${icon('messages-square', { size: 16 })}Worth asking your pharmacist</strong>
    <ul class="list list--s">${c.interactions.slice(0, 3).map(x => `<li>The ${esc(x.labelOf)} label mentions ${esc(x.mentions)}: “${esc(x.snippet)}”</li>`).join('')}</ul></div>`);
  el.innerHTML = parts.join('') || `<p class="pp-caption row" style="gap:8px">${icon('shield-check', { size: 14 })}No open recalls found, and its label doesn’t mention your other meds.</p>`;
}

// ---------- Check-in ----------
PAGES.checkin = async q => {
  const list = await api(`/checkins?days=14&today=${today()}`);
  const t = list.find(c => c.date === today()) || {};
  const mood = +q.get('m') || t.mood;
  $('#main').innerHTML = `${head({ title: 'Daily check-in', sub: 'Twenty seconds a day gives your doctor the full picture.' })}
  <div class="cols" data-screen-label="Check-in">
    <form class="pp-card pp-card--pad-lg col col--main" id="ciForm" style="gap:28px" novalidate>
      <fieldset><legend class="pp-h4" style="margin-bottom:12px">How are you feeling today?</legend>
        <div class="moods">${MOODS.map(([ic, l], i) => `<label class="mood" style="--mood:${MOOD_COL[i]}"><input type="radio" name="mood" value="${i + 1}" ${mood === i + 1 ? 'checked' : ''} required>
          <span class="mood__box">${icon(ic, { size: 34, stroke: 1.75 })}<span class="mood__label">${l}</span></span></label>`).join('')}</div></fieldset>
      <fieldset><legend class="pp-h4" style="margin-bottom:12px">Anything bothering you? <span class="pp-caption" style="font-weight:500">Pick all that apply</span></legend>
        <div class="row" style="gap:8px">${EFFECTS.map(e => `<label class="chip"><input type="checkbox" name="sideEffects" value="${e}" ${t.sideEffects?.includes(e) ? 'checked' : ''}>
          <span class="pp-tag pp-tag--interactive">${icon('check', { size: 14, stroke: 2.6, cls: 'chip__check' })}${e}</span></label>`).join('')}</div></fieldset>
      ${textarea({ label: 'Anything else you noticed?', hint: '(optional)', value: t.notes, a: { name: 'notes', maxlength: 1000, placeholder: 'Slept badly, felt dizzy after the evening dose…' } })}
      ${textarea({ label: 'Questions for your doctor', hint: '(optional, added to your report)', value: t.questions, a: { name: 'questions', maxlength: 1000, placeholder: 'Can I take this with ibuprofen?' } })}
      <div class="alert" id="ciErr" role="alert" hidden></div>
      <div>${btn(t.date ? 'Update check-in' : 'Save check-in', { size: 'lg', left: 'check', a: { type: 'submit' } })}</div>
      <div class="emergency">${icon('phone', { size: 16, color: 'var(--status-missed-text)' })}<p class="pp-caption" style="color:var(--text-body)">Chest pain, trouble breathing, swelling of the face or throat? Call 911 now. For a possible overdose, call Poison Help at 1-800-222-1222.</p></div>
    </form>
    <div class="col">
      <section class="pp-card pp-card--pad-md stack" style="gap:14px" id="insight" aria-live="polite">
        ${t.date ? '' : `<div class="row" style="gap:16px;flex-wrap:nowrap">${pip('wink', 72)}<p class="pp-body-s">Save today’s check-in and I’ll tell you what I’m noticing.</p></div>`}</section>
      <section class="pp-card pp-card--pad-md stack" style="gap:12px"><h2 class="pp-h4">Last two weeks</h2>
        ${list.length ? `<div class="stack" style="gap:6px">${list.map(c => `<div class="hist"><span class="hist__date">${c.date === today() ? 'Today' : esc(fmtDate(c.date))}</span>
          <span style="color:${MOOD_COL[c.mood - 1]}">${icon(MOODS[c.mood - 1][0], { size: 22, title: MOODS[c.mood - 1][1] })}</span>
          <span class="pp-caption hist__fx">${esc(c.sideEffects?.join(', ') || 'No side effects')}</span></div>`).join('')}</div>` : '<p class="pp-body-s pp-muted">Your check-ins will show up here.</p>'}</section>
    </div>
  </div>`;
  if (t.date) showInsight();
  $('#ciForm').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target), err = $('#ciErr');
    if (!f.get('mood')) { err.hidden = false; err.textContent = 'Pick how you’re feeling first.'; return $('#ciForm input[name=mood]').focus(); }
    try {
      await api('/checkins', { method: 'POST', body: { date: today(), mood: +f.get('mood'), sideEffects: f.getAll('sideEffects'), notes: f.get('notes'), questions: f.get('questions') } });
      chime();
      S.wantNote = true;
      history.replaceState(null, '', '#/checkin');
      await PAGES.checkin(new URLSearchParams());
      const fxNew = f.getAll('sideEffects');
      toast({ tone: 'taken', title: 'Check-in saved', message: fxNew.length ? `Noted: ${fxNew.join(', ').toLowerCase()}. Add details (when it started, how bad) so your doctor and study team get the full picture.` : 'It’s on your doctor report now.',
        ...(fxNew.length && { ms: 9000, actions: btn('Add details', { variant: 'secondary', size: 'sm', left: 'circle-plus', a: { 'data-action': 'addEffect' } }) }) });
    } catch (x) { err.hidden = false; err.textContent = x.message; }
  };
};

async function showInsight() {
  const r = await api(`/report?days=7&today=${today()}&now=${nowHM()}`);
  const tips = [];
  if (r.adherence != null) tips.push(r.adherence >= 90 ? `You took <strong>${r.adherence}%</strong> of your doses this week. That’s excellent.` : `You took <strong>${r.adherence}%</strong> of your doses this week. Want me to add another reminder time?`);
  for (const f of r.flagged) tips.push(`You’ve noted <strong>${esc(f.toLowerCase())}</strong> on 3 or more days this week. It’s flagged on your doctor report. If it gets worse, call your care team.`);
  if (r.moods.length >= 4) {
    const m = r.moods.map(x => x.mood), half = Math.floor(m.length / 2), avg = a => a.reduce((s, x) => s + x, 0) / a.length;
    const diff = avg(m.slice(half)) - avg(m.slice(0, half));
    if (Math.abs(diff) >= 0.5) tips.push(`Your mood is trending <strong>${diff > 0 ? 'up' : 'down'}</strong> this week.`);
  }
  if (r.notes[0]?.questions && r.notes[0].date === today()) tips.push('Your question is saved on your doctor report for your next visit.');
  if (!tips.length) tips.push('Thanks for checking in. Patterns show up after a few days of check-ins.');
  const box = $('#insight'); if (!box) return;
  box.innerHTML = `<h2 class="pp-h4">Pip noticed</h2><div class="row" style="gap:16px;align-items:flex-start;flex-wrap:nowrap">${pip(r.flagged.length ? 'alert' : 'celebrate', 72)}
    <ul class="insights">${tips.map(t => `<li>${t}</li>`).join('')}</ul></div>${aiOn() ? '<div id="aiNote" hidden></div>' : ''}`;
  const note = $('#aiNote'), cached = S.aiNote?.date === today() && S.aiNote.note;
  if (!note || (!cached && !S.wantNote)) return;
  S.wantNote = false;
  note.hidden = false;
  note.innerHTML = cached ? aiNoteHtml(cached) : thinking('Pip is writing you a note…');
  if (cached) return;
  try {
    const { note: n } = await api('/ai/insight', { method: 'POST', body: { today: today(), now: nowHM() } });
    S.aiNote = { date: today(), note: n };
    if ($('#aiNote')) $('#aiNote').innerHTML = aiNoteHtml(n);
  } catch { if ($('#aiNote')) $('#aiNote').hidden = true; }
}

// ---------- Health log: measurements and side effects ----------
const VT = {
  bp: { ic: 'heart-pulse', hint: 'Sit quietly for 5 minutes first, feet flat, arm at heart level.' },
  weight: { ic: 'scale', step: 0.1, hint: 'Same scale, same time of day (morning, before eating).' },
  glucose: { ic: 'droplet', hint: 'From your meter. Note when you checked.' },
  temp: { ic: 'thermometer', step: 0.1 }, spo2: { ic: 'wind', hint: 'From a fingertip pulse oximeter.' },
  pain: { ic: 'bandage', hint: '0 = no pain, 10 = the worst you can imagine.' }, a1c: { ic: 'test-tube', step: 0.1, hint: 'From a lab result.' },
};
const vText = v => (v.type === 'bp' ? `${v.value}/${v.value2}` : `${v.value}`);
const vWhen = at => { const d = new Date(at), day = d.toLocaleDateString('en-CA'); return `${day === today() ? 'Today' : fmtDate(day)} ${fmtTime(hm(at))}`; };
const FLAG = { urgent: ['Check now', 'missed'], high: ['High', 'due'], low: ['Low', 'due'] };
const flagBadge = f => (f && FLAG[f] ? badge(FLAG[f][0], { tone: FLAG[f][1], size: 'sm', ic: f === 'urgent' ? 'circle-alert' : null }) : '');
function spark(xs, { w = 120, h = 34, two = false } = {}) {
  if (xs.length < 2) return '';
  const all = xs.flatMap(v => (two ? [+v.value, +v.value2] : [+v.value])), lo = Math.min(...all), hi = Math.max(...all), r = hi - lo || 1;
  const line = k => xs.map((v, i) => `${(i / (xs.length - 1) * (w - 4) + 2).toFixed(1)},${(h - 3 - (+v[k] - lo) / r * (h - 6)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${line('value')}" fill="none" stroke="var(--brand)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${two ? `<polyline points="${line('value2')}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : ''}</svg>`;
}
function vitalTile(type, xs) {
  const V = VITALS[type], last = xs.at(-1);
  return `<article class="vtile${last?.flag === 'urgent' ? ' vtile--urgent' : ''}">
    <div class="row" style="gap:10px;flex-wrap:nowrap"><span class="tile tile--brand-soft tile--sm">${icon(VT[type].ic, { size: 18 })}</span><h3 class="pp-h4" style="flex:1">${V.label}</h3>
      ${iconBtn('plus', `Add ${V.label.toLowerCase()}`, { variant: 'secondary', size: 'sm', a: { 'data-action': 'addVital', 'data-type': type } })}</div>
    ${last ? `<div class="vtile__val"><span class="pp-mono">${esc(vText(last))}</span><span class="vtile__unit">${V.unit}</span>${flagBadge(last.flag)}</div>
      <div class="pp-caption">${esc(vWhen(last.at))}${type === 'glucose' && last.context ? ` · ${esc(last.context)}` : ''}${type === 'bp' && last.pulse ? ` · pulse ${last.pulse}` : ''}</div>${spark(xs.slice(-20), { two: type === 'bp' })}`
      : `<p class="pp-caption">No readings yet.</p>`}</article>`;
}
const SEV = { mild: ['Mild', null, 'Noticeable, but doesn’t get in the way'], moderate: ['Moderate', 'due', 'Gets in the way of daily activities'], severe: ['Severe', 'missed', 'Can’t do your usual activities'] };
const isSeriousFx = e => e.severity === 'severe' || e.serious?.er || e.serious?.hospital;
function effectRow(e) {
  const sev = SEV[e.severity] || SEV.mild, ongoing = !e.endDate;
  return `<div class="fxd${isSeriousFx(e) ? ' fxd--serious' : ''}">
    <div class="row" style="gap:8px"><strong class="fxd__name">${esc(e.name)}</strong>${badge(sev[0], { tone: sev[1], size: 'sm' })}${ongoing ? badge('Ongoing', { tone: 'info', size: 'sm', dot: true }) : ''}
      ${e.serious?.er ? badge('ER visit', { tone: 'missed', size: 'sm' }) : ''}${e.serious?.hospital ? badge('Hospital stay', { tone: 'missed', size: 'sm' }) : ''}${e.serious?.stoppedMed ? badge('Medicine stopped', { tone: 'due', size: 'sm' }) : ''}</div>
    <div class="pp-caption">${ongoing ? `Since ${esc(fmtDate(e.startDate))}` : `${esc(fmtDate(e.startDate))} to ${esc(fmtDate(e.endDate))}`}${e.suspects?.length ? ` · Maybe from ${esc(e.suspects.map(x => x.name).join(', '))}` : ''}</div>
    ${e.notes ? `<p class="pp-body-s">${esc(e.notes)}</p>` : ''}
    <div class="row" style="gap:6px">${ongoing ? btn('It stopped', { variant: 'secondary', size: 'sm', left: 'check', a: { 'data-action': 'endEffect', 'data-id': e._id } }) : ''}${btn('Edit', { variant: 'ghost', size: 'sm', left: 'pencil', a: { 'data-action': 'editEffect', 'data-id': e._id } })}</div></div>`;
}
PAGES.health = async () => {
  const [vs, fx] = await Promise.all([api('/vitals?days=120'), api('/effects')]);
  S.vitals = vs; S.effects = fx;
  const by = t => vs.filter(v => v.type === t).sort((a, b) => new Date(a.at) - new Date(b.at));
  const recent = vs.slice(0, 12), ongoing = fx.filter(e => !e.endDate), past = fx.filter(e => e.endDate);
  $('#main').innerHTML = `${head({ title: 'Health log', sub: 'Measurements and side effects, ready for your doctor and study team.', actions: btn('Report a side effect', { variant: 'secondary', left: 'circle-plus', a: { 'data-action': 'addEffect' } }) })}
  <div class="cols" data-screen-label="Health log">
    <div class="col col--main">
      <section class="pp-card pp-card--pad-md stack" style="gap:16px" aria-labelledby="vH"><h2 id="vH" class="pp-h3">Measurements</h2>
        <div class="vgrid">${Object.keys(VITALS).map(t => vitalTile(t, by(t))).join('')}</div></section>
      <section class="pp-card pp-card--pad-md stack" style="gap:14px" aria-labelledby="eH">
        <div class="row" style="justify-content:space-between"><h2 id="eH" class="pp-h3">Side effects</h2>${btn('Report one', { size: 'sm', left: 'circle-plus', a: { 'data-action': 'addEffect' } })}</div>
        <p class="pp-caption">The details study teams and doctors ask for: when it started and stopped, how bad it was, and which medicine might be causing it.</p>
        ${fx.length ? `${ongoing.length ? `<div class="stack" style="gap:10px">${ongoing.map(effectRow).join('')}</div>` : ''}
          ${past.length ? `<details class="refill" ${ongoing.length ? '' : 'open'}><summary><span class="pp-field__label">Past side effects</span> <span class="pp-caption">(${past.length})</span></summary><div class="stack" style="gap:10px;margin-top:10px">${past.map(effectRow).join('')}</div></details>` : ''}`
          : `<div class="row" style="gap:14px;flex-wrap:nowrap">${pip('happy', 56)}<p class="pp-body-s pp-muted">Nothing reported. If something feels off after a medicine, report it here.</p></div>`}
      </section>
    </div>
    <div class="col">
      <section class="pp-card pp-card--pad-md stack" style="gap:10px" aria-labelledby="rH"><h2 id="rH" class="pp-h4">Recent readings</h2>
        ${recent.length ? `<div class="stack" style="gap:6px">${recent.map(v => `<div class="vrow"><span class="tile tile--sm tile--brand-soft">${icon(VT[v.type].ic, { size: 16 })}</span>
          <div style="flex:1;min-width:0"><div style="font-weight:650;color:var(--text-strong)">${VITALS[v.type].label} <span class="pp-mono">${esc(vText(v))}</span> <span class="pp-caption">${VITALS[v.type].unit}</span></div>
          <div class="pp-caption">${esc(vWhen(v.at))}${v.note ? ` · ${esc(v.note)}` : ''}</div></div>${flagBadge(v.flag)}
          ${iconBtn('trash-2', `Delete this ${VITALS[v.type].label.toLowerCase()} reading`, { size: 'sm', a: { 'data-action': 'delVital', 'data-id': v._id } })}</div>`).join('')}</div>`
          : '<p class="pp-body-s pp-muted">Your readings will show up here.</p>'}</section>
      <section class="pp-card pp-card--pad-md stack" style="gap:10px"><h2 class="pp-h4 row" style="gap:8px">${icon('phone', { size: 18, color: 'var(--status-missed-text)' })}Get help now</h2>
        <ul class="list list--s"><li>Blood pressure 180/120 or higher <strong>with</strong> chest pain, shortness of breath, weakness or vision changes: call 911.</li>
          <li>Blood sugar under 54, or you’re confused or can’t keep food down: get help now.</li><li>Oxygen under 90% with trouble breathing: call 911.</li>
          <li>A side effect that’s severe, or swelling of the face or throat: call 911.</li></ul></section>
    </div>
  </div>`;
};
function vitalDialog(type) {
  const V = VITALS[type], step = VT[type].step || 1, n = new Date();
  const field = (label, name, a = {}) => input({ label, a: { name, type: 'number', step, min: a.min ?? V.min, max: a.max ?? V.max, inputmode: 'decimal', required: a.required !== false, placeholder: a.ph || '' } });
  const d = openDialog({ title: `Add ${V.label.toLowerCase()}`, width: 480, body: `<form class="stack" style="gap:16px;margin-top:10px" novalidate>
    ${VT[type].hint ? `<p class="pp-caption">${VT[type].hint}</p>` : ''}
    ${type === 'bp' ? `<div class="grid-2">${field('Top number (systolic)', 'value', { ph: '120' })}${field('Bottom number (diastolic)', 'value2', { min: V.min2, max: V.max2, ph: '80' })}</div>${field('Pulse (optional)', 'pulse', { min: 30, max: 230, required: false, ph: '72' })}`
      : field(`${V.label} (${V.unit})`, 'value', { ph: { weight: '180', glucose: '110', temp: '98.6', spo2: '98', pain: '3', a1c: '7.0' }[type] })}
    ${type === 'glucose' ? select({ label: 'When', value: 'fasting', options: ['fasting', 'before a meal', 'after a meal', 'bedtime', 'other'].map(v => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })), a: { name: 'context' } }) : ''}
    <div class="grid-2">${input({ label: 'Date', a: { name: 'date', type: 'date', value: today(), max: today(), required: true } })}${input({ label: 'Time', a: { name: 'time', type: 'time', value: n.toTimeString().slice(0, 5), required: true } })}</div>
    ${input({ label: 'Note (optional)', a: { name: 'note', maxlength: 300, placeholder: type === 'glucose' ? 'Skipped breakfast' : '' } })}
    <div class="alert" role="alert" hidden></div>
    <div class="row" style="justify-content:flex-end;gap:10px">${btn('Cancel', { variant: 'ghost', a: { 'data-close': '' } })}${btn('Save', { left: 'check', a: { type: 'submit' } })}</div></form>` });
  const form = $('form', d.el);
  form.onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form)), err = $('.alert', form);
    const [y, mo, da] = f.date.split('-').map(Number), [hh, mi] = (f.time || '12:00').split(':').map(Number);
    try {
      const v = await api('/vitals', { method: 'POST', body: { ...f, type, at: new Date(y, mo - 1, da, hh, mi).toISOString() } });
      d.close(); chime();
      if (v.flag === 'urgent') toast({ tone: 'missed', sticky: true, title: `${V.label}: ${vText(v)} ${V.unit}`, message: v.flagText });
      else toast({ tone: 'taken', title: `${V.label} saved`, message: `${vText(v)} ${V.unit}${v.flag ? ` · ${FLAG[v.flag][0].toLowerCase()}` : ''}. It’s on your doctor report.` });
      if (route() === 'health') render();
    } catch (x) { err.hidden = false; err.textContent = x.message; }
  };
}
async function effectDialog(e = {}) {
  const prof = S.prof || (S.prof = await api('/profile').catch(() => ({ studies: [] })));
  const sus = new Set((e.suspects || []).map(x => x.id)), ongoing = !e.endDate;
  const d = openDialog({ title: e._id ? 'Edit side effect' : 'Report a side effect', width: 560, body: `<form class="stack" style="gap:18px;margin-top:10px" novalidate>
    ${input({ label: 'What did you notice?', a: { name: 'name', value: e.name || '', required: true, list: 'fxList', placeholder: 'e.g. Nausea, rash, dizziness' } })}<datalist id="fxList">${EFFECTS.map(x => `<option value="${x}">`).join('')}</datalist>
    <div class="grid-2">${input({ label: 'When did it start?', a: { name: 'startDate', type: 'date', value: e.startDate || today(), max: today(), required: true } })}
      <div class="stack" style="gap:8px">${checkbox({ label: 'Still happening', checked: ongoing, a: { name: 'ongoing', id: 'fxOngoing' } })}${input({ label: 'When did it stop?', cls: 'fx-end', a: { name: 'endDate', type: 'date', value: e.endDate || today(), max: today() } })}</div></div>
    <fieldset><legend class="pp-field__label" style="margin-bottom:8px">How bad is it?</legend><div class="sev">${Object.entries(SEV).map(([k, [l, , hint]]) => `<label class="sev__opt"><input type="radio" name="severity" value="${k}" ${(e.severity || 'mild') === k ? 'checked' : ''}><span><strong>${l}</strong><span class="pp-caption">${hint}</span></span></label>`).join('')}</div></fieldset>
    ${S.meds.length ? `<fieldset><legend class="pp-field__label" style="margin-bottom:8px">Which medicine might be causing it? <span class="pp-caption" style="font-weight:500">Pick any, or none</span></legend>
      <div class="row" style="gap:8px">${S.meds.map(m => `<label class="chip"><input type="checkbox" name="suspects" value="${m._id}" ${sus.has(m._id) ? 'checked' : ''}><span class="pp-tag pp-tag--interactive">${icon('check', { size: 14, stroke: 2.6, cls: 'chip__check' })}${esc(m.name)}${m.trialId ? ' (study)' : ''}</span></label>`).join('')}</div></fieldset>` : ''}
    <fieldset><legend class="pp-field__label" style="margin-bottom:8px">Did any of these happen?</legend><div class="stack" style="gap:8px">
      ${checkbox({ label: 'I went to the ER or urgent care', checked: e.serious?.er, a: { name: 'er' } })}${checkbox({ label: 'I stayed in the hospital', checked: e.serious?.hospital, a: { name: 'hospital' } })}${checkbox({ label: 'A medicine was stopped because of it', checked: e.serious?.stoppedMed, a: { name: 'stoppedMed' } })}</div></fieldset>
    ${textarea({ label: 'Anything else?', hint: '(optional)', value: e.notes || '', a: { name: 'notes', maxlength: 1000, rows: 3, placeholder: 'Worse in the afternoon, better with food…' } })}
    <div class="alert" role="alert" hidden></div>
    <div class="row" style="justify-content:space-between;gap:10px">${e._id ? btn('Delete', { variant: 'ghost', left: 'trash-2', a: { 'data-del': '' } }) : '<span></span>'}
      <span class="row" style="gap:10px">${btn('Cancel', { variant: 'ghost', a: { 'data-close': '' } })}${btn('Save', { left: 'check', a: { type: 'submit' } })}</span></div></form>` });
  const form = $('form', d.el), endBox = $('.fx-end', d.el), sync = () => (endBox.hidden = $('#fxOngoing', d.el).checked);
  $('#fxOngoing', d.el).onchange = sync; sync();
  $('[data-del]', d.el)?.addEventListener('click', async () => { await api(`/effects/${e._id}`, { method: 'DELETE' }); d.close(); render(); });
  form.onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(form), err = $('.alert', form);
    const body = { name: (f.get('name') || '').trim(), startDate: f.get('startDate'), endDate: f.get('ongoing') ? '' : f.get('endDate'), severity: f.get('severity'),
      suspects: f.getAll('suspects'), serious: { er: !!f.get('er'), hospital: !!f.get('hospital'), stoppedMed: !!f.get('stoppedMed') }, notes: f.get('notes') };
    if (!body.name) { err.hidden = false; err.textContent = 'Say what you noticed.'; return $('input[name=name]', form).focus(); }
    try {
      const r = await api(e._id ? `/effects/${e._id}` : '/effects', { method: e._id ? 'PUT' : 'POST', body });
      d.close(); chime();
      const study = r.suspects?.find(x => x.trialId) && (prof.studies || []).find(st => st.nctId === r.suspects.find(x => x.trialId).trialId);
      if (r.urgent) toast({ tone: 'missed', sticky: true, title: 'Tell your care team today', message: `${r.name} sounds serious. If it’s an emergency, call 911.${study?.coordinatorPhone ? ` Your study team: ${study.coordinatorPhone}.` : ''}` });
      else toast({ tone: 'taken', title: 'Side effect saved', message: study ? 'It’s on your doctor report and in your study team summary.' : 'It’s on your doctor report.' });
      if (['health', 'checkin'].includes(route())) render();
    } catch (x) { err.hidden = false; err.textContent = x.message; }
  };
}

// ---------- Ask Pip ----------
const SUGGEST = ['What is each of my meds for?', 'Can I take ibuprofen with my meds?', 'Tips so I don’t miss a dose', 'What side effects should I watch for?', 'How am I doing this week?'];
// Light formatting for Pip's replies: escape first, then **bold** and "- " bullets.
function fmtMsg(t) {
  return esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').split(/\n{2,}/).map(block => {
    const lines = block.split('\n');
    return lines.every(l => /^\s*[-*•] /.test(l))
      ? `<ul>${lines.map(l => `<li>${l.replace(/^\s*[-*•] /, '')}</li>`).join('')}</ul>`
      : `<p>${lines.map(l => (/^\s*[-*•] /.test(l) ? '• ' + l.replace(/^\s*[-*•] /, '') : l)).join('<br>')}</p>`;
  }).join('');
}
const pipAvatar = () => `<span class="chat__av">${pill(PIP_PILL, 24)}</span>`;

PAGES.chat = async () => {
  const r = await api(`/report?days=7&today=${today()}&now=${nowHM()}`);
  $('#main').innerHTML = `${head({ title: 'Ask Pip', sub: 'Questions about your medicines, answered in plain words.' })}
  <div class="cols" data-screen-label="Ask Pip">
    <section class="pp-card col col--main chat" aria-label="Chat with Pip">
      <div class="chat__head"><span id="chatPip">${pip('happy', 44)}</span><div style="flex:1;min-width:0"><h2 class="pp-h4">Pip</h2><p class="pp-caption">Knows your meds and check-ins. Not a doctor.</p></div>
        <span id="chatNew">${btn('New chat', { variant: 'ghost', size: 'sm', left: 'rotate-ccw', a: { 'data-action': 'clearChat' } })}</span></div>
      <div class="chat__log" id="chatLog" role="log" aria-live="polite"></div>
      <div class="chat__suggest" id="chatSuggest" role="group" aria-label="Quick questions" hidden></div>
      <form class="chat__form" id="chatForm"><label style="flex:1;min-width:0"><span class="sr-only">Message Pip</span>
        <textarea id="chatIn" rows="1" maxlength="2000" placeholder="Ask about your medicines…" class="pp-textarea chat__input"></textarea></label>
        ${iconBtn('send-horizontal', 'Send', { variant: 'primary', a: { type: 'submit', id: 'chatSend' } })}</form>
      <p class="pp-caption chat__foot">Powered by Google Gemini. Emergencies: call 911.</p>
    </section>
    <div class="col">
      <section class="pp-card pp-card--pad-md stack" style="gap:14px"><h2 class="pp-h4">What Pip knows</h2>
        <p class="pp-caption">Pip uses your PillPal data and FDA label text to answer. Nothing else.</p>
        ${S.meds.map(m => `<div class="row" style="gap:12px;flex-wrap:nowrap">${medIcon(m, 38, 26)}<div style="min-width:0;flex:1">
          <div style="font-weight:650;color:var(--text-strong);font-size:14.5px">${esc(m.name)}${m.dose ? ` · ${esc(m.dose)}` : ''}</div>
          <div class="pp-caption">${esc(m.times.map(fmtTime).join(', ') + (m.instructions ? ' · ' + m.instructions : ''))}</div></div></div>`).join('') || '<p class="pp-body-s pp-muted">No medications yet.</p>'}
        <div class="row" style="gap:8px;padding-top:4px">${badge(`${r.adherence ?? '–'}% taken this week`, { tone: 'taken', ic: 'check' })}
          ${r.sideEffects.slice(0, 3).map(f => badge(`${esc(f.name)} · ${plural(f.count, 'day')}`, { tone: 'due' })).join('')}</div>
      </section>
      <section class="pp-card pp-card--tinted pp-card--pad-md stack" style="gap:10px">
        <h2 class="pp-h4 row" style="gap:8px">${icon('shield-check', { size: 20, color: 'var(--brand-text)' })}What Pip won’t do</h2>
        <ul class="list"><li>Diagnose anything</li><li>Tell you to start, stop, skip, double or change a dose</li><li>Replace your pharmacist or doctor</li></ul>
      </section>
      <section class="pp-card pp-card--pad-md stack" style="gap:10px"><h2 class="pp-h4">In an emergency</h2>
        <div class="stack" style="gap:8px">${[['Emergency', '911', 'tel:911'], ['Poison Help', '1-800-222-1222', 'tel:18002221222'], ['Crisis Lifeline', '988', 'tel:988']]
          .map(([l, n, h]) => `<a class="phone-row" href="${h}"><span>${l}</span><span class="pp-mono">${n}</span></a>`).join('')}</div>
      </section>
    </div>
  </div>`;
  $('#chatForm').onsubmit = e => { e.preventDefault(); const t = $('#chatIn').value.trim(); if (t) { $('#chatIn').value = ''; sendChat(t); } };
  $('#chatIn').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatForm').requestSubmit(); } };
  $('#chatIn').oninput = e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(140, e.target.scrollHeight) + 'px'; };
  renderChat();
  if (S.pendingAsk) { const q = S.pendingAsk; S.pendingAsk = null; sendChat(q); }
  else api('/ai/warm', { method: 'POST', body: { today: today(), now: nowHM() } }).catch(() => {});
};

function renderChat() {
  const log = $('#chatLog'); if (!log) return;
  const last = S.chat.at(-1);
  $('#chatPip').innerHTML = pip(S.chatBusy ? 'wink' : last?.urgent ? 'alert' : 'happy', 44);
  $('#chatNew').hidden = !S.chat.length;
  $('#chatSend').disabled = S.chatBusy;
  log.innerHTML = S.chat.length
    ? S.chat.map((m, i) => m.role === 'user'
      ? `<div class="msg msg--user"><div class="bubble bubble--user">${esc(m.text)}</div></div>`
      : m.urgent
        ? `<div class="msg"><span class="chat__av chat__av--urgent">${icon('phone', { size: 18 })}</span><div class="bubble bubble--urgent" role="alert">${fmtMsg(m.text)}</div></div>`
        : `<div class="msg">${pipAvatar()}<div class="stack" style="gap:6px;align-items:flex-start;max-width:78%"><div class="bubble bubble--pip${m.error ? ' bubble--error' : ''}">${fmtMsg(m.text)}</div>
            ${m.error || m.streaming ? '' : btn('Read aloud', { variant: 'ghost', size: 'sm', left: 'volume-2', a: { 'data-action': 'speak', 'data-i': i, 'aria-label': 'Read this answer aloud' } })}</div></div>`).join('')
      + (S.chatBusy && !S.chat.at(-1)?.streaming ? `<div class="msg" role="status">${pipAvatar()}<div class="bubble bubble--pip pp-muted">Pip is thinking…</div></div>` : '')
    : `<div class="chat__empty">${pip('happy', 104)}<div><p class="pp-h3">Hi ${esc(S.user.name)}, I’m Pip.</p><p class="pp-body pp-muted" style="margin-top:4px">Ask me anything about your medicines.</p></div>
        <div class="row" style="gap:8px;justify-content:center;max-width:560px">${SUGGEST.map(q => tag(q, { a: { 'data-action': 'suggest' } })).join('')}</div></div>`;
  log.scrollTop = S.chat.length ? log.scrollHeight : 0;
  // Quick questions stay handy after the first message (ones not asked yet come first).
  const sug = $('#chatSuggest');
  if (sug) {
    sug.hidden = !S.chat.length;
    const asked = new Set(S.chat.filter(m => m.role === 'user').map(m => m.text));
    sug.innerHTML = [...SUGGEST.filter(q => !asked.has(q)), ...SUGGEST.filter(q => asked.has(q))]
      .map(q => tag(esc(q), { a: { 'data-action': 'suggest', ...(S.chatBusy && { disabled: true }) } })).join('');
  }
}

// Pip's reply streams in as Gemini writes it (Server-Sent Events), so the first words show within a second or so.
async function sendChat(text) {
  if (S.chatBusy) return;
  const history = [...S.chat.filter(m => !m.error).map(({ role, text: t }) => ({ role, text: t })), { role: 'user', text }];
  S.chat.push({ role: 'user', text });
  S.chatBusy = true;
  renderChat();
  const msg = { role: 'model', text: '', streaming: true };
  let frame = 0;
  const paint = () => { frame = 0; const b = $('#chatLog .msg:last-child .bubble--pip'); if (b && msg.text) b.innerHTML = fmtMsg(msg.text); else renderChat(); const log = $('#chatLog'); if (log) log.scrollTop = log.scrollHeight; };
  try {
    const r = await fetch('/api/ai/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history, today: today(), now: nowHM() }) });
    if (r.status === 401) { S.chatBusy = false; return renderAuth(); }
    if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({}))).error || 'I couldn’t answer just now. Try again in a moment.');
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', errMsg = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, k).replace(/^data: ?/, ''); buf = buf.slice(k + 2);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.error) errMsg = ev.error;
        if (ev.t) {
          if (!S.chat.includes(msg)) { S.chat.push(msg); renderChat(); }
          msg.text += ev.t; if (ev.urgent) msg.urgent = true;
          frame ||= requestAnimationFrame(paint);
        }
      }
    }
    if (!msg.text) throw new Error(errMsg || 'I couldn’t answer just now. Try again in a moment.');
    if (errMsg) msg.text += `\n\n(${errMsg})`;
    if (S.user.prefs?.voice) speak(msg.text);
  } catch (x) {
    if (!S.chat.includes(msg)) S.chat.push({ role: 'model', text: x.message || 'I couldn’t answer just now. Try again in a moment.', error: true });
  }
  delete msg.streaming;
  S.chatBusy = false;
  renderChat();
  $('#chatIn')?.focus();
}

// ---------- Report ----------
function sparkline(moods) {
  if (moods.length < 2) return '<p class="pp-body-s pp-muted">Check in on two or more days to see a mood trend.</p>';
  const W = 600, H = 90, pts = moods.map((m, i) => [i / (moods.length - 1) * (W - 20) + 10, H - 10 - (m.mood - 1) / 4 * (H - 20)]);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="Mood from ${MOODS[moods[0].mood - 1][1]} to ${MOODS[moods.at(-1).mood - 1][1]} over ${moods.length} check-ins" style="overflow:visible">
    <polyline points="${pts.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="var(--brand)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>
    <div class="pp-caption spread" style="margin-top:6px"><span>${fmtDate(moods[0].date)}</span><span>1 = awful, 5 = great</span><span>${fmtDate(moods.at(-1).date)}</span></div>`;
}
function reportText(r) {
  const L = ['PillPal medication summary', `Patient: ${r.patient}`, `Period: ${r.from} to ${r.to} (${r.days} days)`,
    `Overall adherence: ${r.adherence ?? 'n/a'}%${r.scheduled ? ` (${r.taken}/${r.scheduled} doses)` : ''}`, '', 'Medications:'];
  for (const m of r.meds) L.push(`- ${m.name}${m.dose ? ' ' + m.dose : ''}${m.reason ? ` (for ${m.reason})` : ''}${m.trialId ? ` [study ${m.trialId}]` : ''}: ${m.adherence ?? 'n/a'}% taken, ${m.missed} missed, ${m.skipped} skipped. Schedule: ${m.times.map(fmtTime).join(', ')}${m.active ? '' : ' (stopped)'}`);
  L.push('', `Side effects reported: ${r.sideEffects.map(s => `${s.name} (${plural(s.count, 'day')})`).join(', ') || 'none'}`);
  if (r.flagged.length) L.push(`Flagged (3+ days in the last week): ${r.flagged.join(', ')}`);
  L.push(`Average mood: ${r.moodAvg ?? 'n/a'}/5`);
  if (r.vitals?.length) { L.push('', 'Measurements:'); for (const v of r.vitals) L.push(`- ${v.label}: latest ${v.type === 'bp' ? `${v.latest.value}/${v.latest.value2}` : v.latest.value} ${v.unit} (${v.latest.date}), average ${v.avg}${v.avg2 ? '/' + v.avg2 : ''}, range ${v.min} to ${v.max}, ${plural(v.count, 'reading')}${v.flagged ? `, ${v.flagged} outside the usual range` : ''}`); }
  if (r.effects?.length) { L.push('', 'Side effects in detail:'); for (const e of r.effects) L.push(`- ${e.name}: ${e.severity}, ${e.startDate} to ${e.endDate || 'ongoing'}${e.suspects.length ? `, possibly from ${e.suspects.map(x => x.name).join(', ')}` : ''}${e.urgent ? ' (SERIOUS)' : ''}`); }
  if (r.medFeel?.length) { L.push('', 'How each medication feels (check-ins after doses):'); for (const f of r.medFeel) L.push(`- ${f.name}: mood ${f.moodAvg}/5 over ${plural(f.count, 'check-in')}; ${f.sideEffects.map(x => `${x.name} (${x.count})`).join(', ') || 'no side effects noted'}${f.notes.length ? `; notes: ${f.notes.map(n => `${n.date} "${n.notes}"`).join(' / ')}` : ''}`); }
  if (r.notes.length) { L.push('', 'Patient notes and questions:'); for (const n of r.notes) L.push(`- ${n.date}: ${[n.notes, n.questions && 'Q: ' + n.questions].filter(Boolean).join(' / ')}`); }
  const prep = S.prep?.[r.days];
  if (prep) { L.push('', 'Visit summary (AI-drafted from the data above):', prep.summary); if (prep.questions.length) { L.push('Questions I want to ask:'); prep.questions.forEach(q => L.push(`- ${q}`)); } }
  L.push('', 'Self-reported by the patient with PillPal. Not a medical record.');
  return L.join('\n');
}
const thinking = msg => `<p class="pp-body-s pp-muted row" role="status" style="gap:10px;flex-wrap:nowrap">${pip('wink', 36)}<span>${esc(msg)}</span></p>`;
const aiNoteHtml = note => `<div class="pp-card pp-card--warm pp-card--pad-sm stack" style="gap:6px"><span class="pp-overline ai-tag">${icon('sparkles', { size: 14 })}A note from Pip · AI</span><p class="pp-body-s" style="color:var(--text-strong)">${esc(note)}</p></div>`;
function prepHtml(p) {
  if (!p) return `<div class="row no-print" style="justify-content:space-between;gap:16px"><div><h3 class="pp-h4">Visit prep</h3><p class="pp-body-s pp-muted">Let Pip draft a short summary and questions for your appointment.</p></div>
    ${btn('Draft with Pip', { variant: 'secondary', left: 'sparkles', a: { 'data-action': 'visitPrep' } })}</div>`;
  return `<div class="stack" style="gap:10px"><h3 class="pp-h4">Visit summary</h3><p class="pp-body-s" style="color:var(--text-strong)">${esc(p.summary)}</p>
    ${p.questions.length ? `<h3 class="pp-h4" style="margin-top:6px">Questions I want to ask</h3><ul class="list">${p.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
    <p class="pp-caption">AI-drafted by Pip (Google Gemini) from the data in this report. Review it before sharing.</p></div>`;
}

PAGES.report = async () => {
  const r = await api(`/report?days=${S.period}&today=${today()}&now=${nowHM()}`);
  S.report = r;
  const trials = r.meds.filter(m => m.trialId), long = { month: 'short', day: 'numeric', year: 'numeric' };
  const kpis = [[r.adherence != null ? r.adherence + '%' : 'n/a', 'Overall adherence'], [`${r.taken}/${r.scheduled}`, 'Doses taken'], [r.streak, 'Current streak (days)'], [r.moodAvg ?? 'n/a', 'Average mood (1–5)']];
  const recent = m => m.recentMissed.slice(-2).map(x => { const [d, t] = x.split(' '); return `${fmtDate(d)} ${fmtTime(t)}`; }).join(', ');
  $('#main').innerHTML = `${head({ title: 'Doctor report', sub: 'A one-page summary to print, save as PDF, or paste into a patient portal message.',
    actions: tabs([7, 14, 30, 90].map(n => ({ value: String(n), label: `${n} days` })), String(S.period), { action: 'period', label: 'Report period' })
      + btn('Copy text', { variant: 'secondary', left: 'copy', a: { 'data-action': 'copyReport' } }) + btn('Print / PDF', { left: 'printer', a: { 'data-action': 'print' } }) })}
  <article class="pp-card pp-card--pad-none report" aria-labelledby="docH" data-screen-label="Doctor report">
    <header class="report__head"><div class="stack" style="gap:6px"><h2 id="docH" class="pp-h2">Medication adherence summary</h2>
      <p class="pp-body-s pp-muted">Patient: <strong style="color:var(--text-strong)">${esc(r.patient)}</strong> · ${fmtDate(r.from, long)} to ${fmtDate(r.to, long)}</p></div>
      <div class="stack" style="gap:6px;align-items:flex-end">${logo(18)}<p class="pp-caption" style="text-align:right">Generated ${new Date(r.generatedAt).toLocaleDateString([], long)}<br>Self-reported via PillPal</p></div></header>
    <section class="report__sec"><div class="kpis">${kpis.map(([v, l]) => `<div class="kpi"><div class="kpi__v">${esc(v)}</div><div class="pp-caption" style="margin-top:4px">${l}</div></div>`).join('')}</div></section>
    ${aiOn() ? `<section class="report__sec" id="prep">${prepHtml(S.prep?.[S.period])}</section>` : ''}
    <section class="report__sec"><h3 class="pp-h4" style="margin-bottom:12px">Medications</h3>
      ${r.meds.length ? `<div style="overflow-x:auto"><div role="table" aria-label="Medications" class="mtable">
        <div role="row" class="mtable__row"><span role="columnheader">Medication</span><span role="columnheader">Schedule</span><span role="columnheader">Adherence</span><span role="columnheader">Missed / skipped</span></div>
        ${r.meds.map(m => `<div role="row" class="mtable__row"><div role="cell"><strong style="color:var(--text-strong)">${esc(m.name)}</strong> ${esc(m.dose)}
            ${m.reason ? `<div class="pp-caption">for ${esc(m.reason)}</div>` : ''}${m.trialId ? `<div style="margin-top:4px">${badge(`Study ${esc(m.trialId)}`, { tone: 'accent', size: 'sm' })}</div>` : ''}${m.active ? '' : '<div class="pp-caption">Stopped</div>'}</div>
          <div role="cell" class="pp-mono">${m.times.map(fmtTime).join(' · ')}</div>
          <div role="cell"><span style="font-weight:700;color:var(--text-strong)">${m.adherence ?? 'n/a'}${m.adherence != null ? '%' : ''}</span>
            <div class="meter" aria-hidden="true"><i style="width:${m.adherence || 0}%;background:${m.adherence != null && m.adherence < 80 ? 'var(--status-missed)' : 'var(--brand)'}"></i></div></div>
          <div role="cell">${m.missed} / ${m.skipped}${m.recentMissed.length ? `<div class="pp-caption">Last missed: ${recent(m)}</div>` : ''}</div></div>`).join('')}
      </div></div>` : '<p class="pp-body-s pp-muted">No medications tracked in this period.</p>'}</section>
    <section class="report__sec"><h3 class="pp-h4" style="margin-bottom:12px">Daily adherence</h3>
      <div class="bars" role="img" aria-label="${r.daily.filter(d => d.scheduled && d.taken === d.scheduled).length} of ${r.daily.filter(d => d.scheduled).length} days fully taken">${r.daily.map(d =>
        `<span style="height:${d.scheduled ? Math.max(4, d.taken / d.scheduled * 100) : 4}%;background:${!d.scheduled ? 'var(--surface-sunken)' : d.taken === d.scheduled ? 'var(--brand)' : 'var(--status-due)'}" title="${esc(fmtDate(d.date))}: ${d.taken}/${d.scheduled}"></span>`).join('')}</div>
      <div class="pp-caption spread" style="margin-top:6px"><span>${fmtDate(r.from)}</span><span>${fmtDate(r.to)}</span></div></section>
    <section class="report__sec"><h3 class="pp-h4" style="margin-bottom:12px">Reported side effects</h3>
      ${r.sideEffects.length ? `<div class="stack" style="gap:0">${r.sideEffects.map(s => `<div class="fx-row"><span class="row" style="gap:8px;color:var(--text-strong)">${esc(s.name)}
        ${r.flagged.includes(s.name) ? badge('3+ days this week', { tone: 'missed', size: 'sm', ic: 'circle-alert' }) : ''}</span><span class="pp-caption">${plural(s.count, 'day')}</span></div>`).join('')}</div>`
        : '<p class="pp-body-s pp-muted">None reported.</p>'}</section>
    ${r.medFeel?.length ? `<section class="report__sec"><h3 class="pp-h4" style="margin-bottom:12px">How each medication feels</h3><div class="stack" style="gap:0">${r.medFeel.map(f => `<div class="fx-row" style="align-items:flex-start">
      <div class="stack" style="gap:2px;min-width:0"><strong style="color:var(--text-strong)">${esc(f.name)}</strong>
        <span class="pp-caption">${esc(f.sideEffects.map(x => `${x.name} (${x.count})`).join(', ') || 'No side effects noted')}</span>
        ${f.notes.map(n => `<span class="pp-caption">${esc(fmtDate(n.date))}: “${esc(n.notes)}”</span>`).join('')}</div>
      <span class="pp-caption" style="white-space:nowrap">Mood ${f.moodAvg}/5 · ${plural(f.count, 'check-in')}</span></div>`).join('')}</div></section>` : ''}
    ${r.vitals?.length ? `<section class="report__sec"><h3 class="pp-h4" style="margin-bottom:12px">Measurements</h3><div class="vrep">${r.vitals.map(v => `<div class="vrep__row">
        <div><strong style="color:var(--text-strong)">${esc(v.label)}</strong><div class="pp-caption">${plural(v.count, 'reading')}${v.flagged ? ` · ${v.flagged} outside the usual range` : ''}</div></div>
        <div><span class="pp-caption">Latest</span><div class="pp-mono" style="font-weight:700;color:var(--text-strong)">${esc(v.type === 'bp' ? `${v.latest.value}/${v.latest.value2}` : String(v.latest.value))} <span class="pp-caption">${esc(v.unit)}</span></div><div class="pp-caption">${esc(fmtDate(v.latest.date))}</div></div>
        <div><span class="pp-caption">Average</span><div class="pp-mono">${v.avg}${v.avg2 ? '/' + v.avg2 : ''}</div><div class="pp-caption">range ${v.min} to ${v.max}</div></div>
        <div>${spark(v.series.slice(-40), { w: 160, h: 40, two: v.type === 'bp' })}</div></div>`).join('')}</div></section>` : ''}
    ${r.effects?.length ? `<section class="report__sec"><h3 class="pp-h4" style="margin-bottom:12px">Side effects in detail</h3><div style="overflow-x:auto"><div role="table" aria-label="Side effects in detail" class="mtable mtable--fx">
        <div role="row" class="mtable__row"><span role="columnheader">Side effect</span><span role="columnheader">Dates</span><span role="columnheader">Severity</span><span role="columnheader">Possible cause</span></div>
        ${r.effects.map(e => `<div role="row" class="mtable__row"><div role="cell"><strong style="color:var(--text-strong)">${esc(e.name)}</strong>${e.urgent ? ` ${badge('Serious', { tone: 'missed', size: 'sm' })}` : ''}${e.notes ? `<div class="pp-caption">${esc(e.notes)}</div>` : ''}</div>
          <div role="cell" class="pp-body-s">${esc(fmtDate(e.startDate))} to ${e.endDate ? esc(fmtDate(e.endDate)) : '<strong>ongoing</strong>'}</div>
          <div role="cell">${esc(title(e.severity))}${e.serious.er ? '<div class="pp-caption">ER visit</div>' : ''}${e.serious.hospital ? '<div class="pp-caption">Hospital stay</div>' : ''}${e.serious.stoppedMed ? '<div class="pp-caption">Medicine stopped</div>' : ''}</div>
          <div role="cell" class="pp-body-s">${esc(e.suspects.map(x => x.name).join(', ') || 'Not sure')}</div></div>`).join('')}</div></div></section>` : ''}
    <section class="report__sec"><h3 class="pp-h4" style="margin-bottom:12px">Mood trend</h3>${sparkline(r.moods)}</section>
    <section class="report__sec"><h3 class="pp-h4" style="margin-bottom:12px">Patient notes and questions</h3>
      ${r.notes.length ? `<ul class="list">${r.notes.map(n => `<li><strong style="color:var(--text-strong)">${n.date === today() ? 'Today' : esc(fmtDate(n.date))}:</strong> ${esc(n.notes)}${n.questions ? `${n.notes ? '<br>' : ''}<em>Question:</em> ${esc(n.questions)}` : ''}</li>`).join('')}</ul>` : '<p class="pp-body-s pp-muted">No notes.</p>'}</section>
    ${trials.length ? `<section class="report__sec"><h3 class="pp-h4" style="margin-bottom:12px">Clinical trial participation</h3><ul class="list">${trials.map(m =>
      `<li>${esc(m.name)}: <a href="${ctLink(m.trialId)}" target="_blank" rel="noopener">${esc(m.trialId)}</a>${(() => { const st = r.studies?.find(x => x.nctId === m.trialId); return st?.participantId ? `, participant ${esc(st.participantId)}` : ''; })()}, ${m.adherence ?? 'n/a'}${m.adherence != null ? '%' : ''} adherence</li>`).join('')}</ul></section>` : ''}
    <section class="report__sec report__sec--last"><p class="pp-caption">Data is self-reported by the patient and has not been clinically verified. PillPal is not a medical record or a diagnostic tool.</p></section>
  </article>`;
};

// ---------- Trials & community ----------
const RESOURCES = [
  ['triangle-alert', 'Report a side effect to the FDA', 'MedWatch reports help catch drug safety problems for everyone.', 'https://www.fda.gov/safety/medwatch-fda-safety-information-and-adverse-event-reporting-program'],
  ['recycle', 'Safely dispose of old meds', 'Find a drug take-back location so leftover pills don’t end up misused.', 'https://www.dea.gov/takebackday'],
  ['phone', 'Poison Help: 1-800-222-1222', 'Free, confidential, 24/7 help if someone took the wrong medicine or too much.', 'tel:18002221222'],
  ['flask-conical', 'What joining a study means', 'Plain-language guide to eligibility, consent, and your rights.', 'https://clinicaltrials.gov/study-basics/learn-about-studies'],
];
const phaseTxt = p => (p === 'NA' ? '' : p.replace('EARLY_PHASE', 'Early phase ').replace('PHASE', 'Phase '));
const STATUS_TXT = { RECRUITING: ['Recruiting', 'taken'], NOT_YET_RECRUITING: ['Not yet recruiting', 'info'], ACTIVE_NOT_RECRUITING: ['Active, not recruiting', 'info'], COMPLETED: ['Completed', null], ENROLLING_BY_INVITATION: ['By invitation', 'info'], TERMINATED: ['Stopped early', 'missed'], WITHDRAWN: ['Withdrawn', 'missed'], SUSPENDED: ['Paused', 'due'] };
const ctLink = id => `https://clinicaltrials.gov/study/${encodeURIComponent(id)}`;
const ageWords = t => [t.minAge && `${t.minAge.toLowerCase()}+`, t.maxAge && `up to ${t.maxAge.toLowerCase()}`].filter(Boolean).join(', ') || 'any age';
const profileAge = p => (p?.birthYear ? new Date().getFullYear() - p.birthYear : null);
// A study's title and status from ClinicalTrials.gov (via the server, else straight from the browser).
async function lookupStudy(id) {
  const r = await api(`/trials/${encodeURIComponent(id)}`);
  if (!r.blocked) return r;
  try { const d = await (await fetch(r.apiUrl, { headers: { Accept: 'application/json' } })).json(); return { found: true, url: r.url, ...mapStudy(d) }; }
  catch { return { unknown: true, url: r.url }; }
}
function studyCard(st, linkedMeds) {
  const soon = (st.visits || []).filter(v => v.date >= today());
  return `<article class="pp-card pp-card--pad-md stack study" style="gap:12px" data-study="${esc(st.nctId)}">
    <div class="row" style="gap:6px">${badge(esc(st.nctId), { tone: 'accent', ic: 'flask-conical' })}<span data-status></span></div>
    <h3 class="pp-h4"><a href="${ctLink(st.nctId)}" target="_blank" rel="noopener">${esc(st.title || 'Study on ClinicalTrials.gov')}</a></h3>
    <div class="study__facts">
      ${st.participantId ? `<div><span class="pp-caption">Participant ID</span><strong class="pp-mono">${esc(st.participantId)}</strong></div>` : ''}
      ${st.site ? `<div><span class="pp-caption">Study site</span><strong>${esc(st.site)}</strong></div>` : ''}
      ${linkedMeds.length ? `<div><span class="pp-caption">Study medicine</span><strong>${esc(linkedMeds.map(m => m.name).join(', '))}</strong></div>` : ''}
    </div>
    ${st.coordinatorName || st.coordinatorPhone || st.coordinatorEmail ? `<div class="row" style="gap:8px"><span class="pp-body-s" style="flex:1 1 100%">${icon('user-round', { size: 14, style: 'display:inline;vertical-align:-2px' })} ${esc(st.coordinatorName || 'Study coordinator')}</span>
      ${st.coordinatorPhone ? btn('Call', { variant: 'secondary', size: 'sm', left: 'phone', a: { href: `tel:${st.coordinatorPhone.replace(/[^\d+]/g, '')}` } }) : ''}${st.coordinatorEmail ? btn('Email', { variant: 'secondary', size: 'sm', left: 'mail', a: { href: `mailto:${st.coordinatorEmail}` } }) : ''}</div>` : ''}
    <div class="stack" style="gap:6px"><span class="pp-overline pp-muted">Upcoming visits</span>
      ${soon.length ? soon.slice(0, 3).map(v => `<div class="visit">${icon('calendar', { size: 16 })}<span><strong>${esc(fmtDate(v.date))}${v.time ? ` · ${fmtTime(v.time)}` : ''}</strong> ${esc(v.label)}</span></div>`).join('') : '<p class="pp-caption">None added. Add your visit dates and PillPal will remind you.</p>'}</div>
    <div class="row" style="gap:8px;margin-top:auto">${btn('Send to my study team', { size: 'sm', left: 'send', a: { 'data-action': 'studySummary', 'data-id': st.nctId } })}
      ${btn('Edit', { variant: 'ghost', size: 'sm', left: 'pencil', a: { 'data-action': 'editStudy', 'data-id': st.nctId } })}</div></article>`;
}
function trialCard(t, prof) {
  const fit = t.fit || quickFit(t, { age: profileAge(prof), sex: prof?.sex });
  return `<article class="pp-card pp-card--pad-md stack" style="gap:10px" data-trial="${esc(t.id)}">
    <div class="row" style="gap:6px">${badge('Recruiting', { tone: 'taken', dot: true })}${t.phases.map(phaseTxt).filter(Boolean).map(p => badge(esc(p))).join('')}</div>
    <h3 class="pp-h4"><a href="${ctLink(t.id)}" target="_blank" rel="noopener">${esc(t.title)}</a></h3>
    <p class="pp-caption">${esc(t.conditions.join(', '))}</p><p class="pp-body-s">${esc(t.summary)}${t.summary.length >= 260 ? '…' : ''}</p>
    <p class="pp-caption row" style="gap:6px;flex-wrap:nowrap">${icon('user-round', { size: 14 })}<span>Ages ${esc(ageWords(t))} · ${t.sex === 'ALL' ? 'all sexes' : esc(t.sex.toLowerCase()) + ' only'}${t.healthy ? ' · healthy volunteers welcome' : ''}</span></p>
    ${fit.fits ? '' : `<div>${badge(`May not fit: ${esc(fit.why.join('; '))}`, { tone: 'due', size: 'sm', ic: 'circle-alert' })}</div>`}
    ${t.locations.length ? `<p class="pp-caption row" style="gap:6px;flex-wrap:nowrap">${icon('map-pin', { size: 14 })}<span>${esc(t.locations.join(' · '))}${t.locationCount > 3 ? ` +${t.locationCount - 3} more` : ''}</span></p>` : ''}
    ${t.sponsor ? `<p class="pp-caption">Sponsor: ${esc(t.sponsor)}</p>` : ''}
    <div class="precheck" aria-live="polite"></div>
    <div class="row" style="gap:8px;margin-top:auto">${btn(`View ${esc(t.id)}`, { variant: 'secondary', size: 'sm', right: 'external-link', a: { href: ctLink(t.id), target: '_blank', rel: 'noopener' } })}
      ${aiOn() && t.criteria ? btn('Pip pre-check', { variant: 'soft', size: 'sm', left: 'sparkles', a: { 'data-action': 'precheck', 'data-id': t.id } }) : ''}</div></article>`;
}
PAGES.trials = async q => {
  const prof = S.prof = await api('/profile');
  const p = prof.profile || {}, studies = prof.studies || [];
  const reasons = [...new Set([...(p.conditions || []), ...S.meds.map(m => m.reason).filter(Boolean)])];
  const intr = q.get('intr') || '';
  const orphan = [...new Set(S.meds.filter(m => m.trialId && !studies.some(st => st.nctId === m.trialId)).map(m => m.trialId))];
  const sexOpts = [{ value: '', label: 'Prefer not to say' }, { value: 'female', label: 'Female' }, { value: 'male', label: 'Male' }];
  $('#main').innerHTML = `${head({ title: 'Clinical trials & community', sub: 'Keep your study details in one place, and find studies that are recruiting now.' })}
  <div class="stack" style="gap:24px" data-screen-label="Trials & help">
    <section class="stack" style="gap:14px" aria-labelledby="msH">
      <div class="row" style="justify-content:space-between"><h2 id="msH" class="pp-h3">My studies</h2>${btn('Add a study', { variant: 'secondary', size: 'sm', left: 'plus', a: { 'data-action': 'editStudy' } })}</div>
      ${studies.length || orphan.length ? `<div class="trial-grid">${studies.map(st => studyCard(st, S.meds.filter(m => m.trialId === st.nctId))).join('')}
        ${orphan.map(id => `<article class="pp-card pp-card--pad-md stack" style="gap:10px">${badge(esc(id), { tone: 'accent', ic: 'flask-conical' })}<p class="pp-body-s">${esc(S.meds.filter(m => m.trialId === id).map(m => m.name).join(', '))} is a study medicine. Add the study details (participant ID, coordinator, visit dates) so you can reach the study team fast.</p>
          <div>${btn('Add study details', { size: 'sm', left: 'plus', a: { 'data-action': 'editStudy', 'data-new': id } })}</div></article>`).join('')}</div>`
        : `<div class="pp-card pp-card--pad-md row" style="gap:16px;flex-wrap:nowrap">${pip('wink', 56)}<p class="pp-body-s">In a clinical trial? Add it here to keep your participant ID, coordinator and visit dates handy, and send updates to your study team.</p></div>`}
    </section>
    <form class="pp-card pp-card--pad-md stack" style="gap:14px" id="aboutForm" aria-labelledby="abH">
      <div><h2 id="abH" class="pp-h4">About you</h2><p class="pp-caption">Studies set rules on age, sex and health conditions. This helps PillPal show which ones might fit. It stays in your account.</p></div>
      <div class="about-grid">${input({ label: 'Birth year', a: { name: 'birthYear', type: 'number', min: 1900, max: new Date().getFullYear(), value: p.birthYear ?? '', placeholder: '1968', inputmode: 'numeric' } })}
        ${select({ label: 'Sex', value: p.sex || '', options: sexOpts, a: { name: 'sex' } })}
        ${input({ label: 'Where you live', ic: 'map-pin', a: { name: 'location', value: p.location || '', placeholder: 'City, state or ZIP' } })}
        ${input({ label: 'Health conditions', cls: 'about-wide', hint: 'Separate with commas', a: { name: 'conditions', value: (p.conditions || []).join(', '), placeholder: 'Type 2 diabetes, high blood pressure' } })}</div>
      <div>${btn('Save', { variant: 'secondary', size: 'sm', left: 'check', a: { type: 'submit' } })}</div>
    </form>
    <h2 class="pp-h3">Find a study</h2>
    <form class="pp-card pp-card--pad-md trial-form" id="trialForm">
      ${input({ label: 'Condition', a: { name: 'cond', id: 'tCond', value: intr ? '' : reasons[0] || '', placeholder: 'e.g. type 2 diabetes', list: 'tCondList' } })}<datalist id="tCondList">${reasons.map(r => `<option value="${esc(r)}">`).join('')}</datalist>
      ${input({ label: 'Medication (optional)', a: { name: 'intr', value: intr, placeholder: 'e.g. metformin', list: 'tMedList' } })}<datalist id="tMedList">${S.meds.map(m => `<option value="${esc(m.name)}">`).join('')}</datalist>
      ${input({ label: 'Near (city or state)', ic: 'map-pin', a: { name: 'loc', value: p.location || '', placeholder: 'e.g. New Brunswick, NJ' } })}
      ${btn('Find trials', { left: 'search', a: { type: 'submit' } })}
    </form>
    <div id="trialResults" class="stack" style="gap:12px" aria-live="polite"></div>
    <h2 class="pp-h3" style="margin-top:8px">Help for you and your community</h2>
    <div class="res-grid">${RESOURCES.map(([ic, t, x, h]) => `<a href="${h}" ${h.startsWith('http') ? 'target="_blank" rel="noopener"' : ''} class="pp-card pp-card--interactive pp-card--pad-md res">
      <span class="tile tile--brand-soft">${icon(ic, { size: 22 })}</span><h3 class="pp-h4">${t}</h3><p class="pp-body-s pp-muted">${x}</p></a>`).join('')}</div>
  </div>`;
  // Check each study ID against ClinicalTrials.gov (status badge, or a warning when the ID isn't found).
  for (const st of studies) lookupStudy(st.nctId).then(r => {
    const el = $(`[data-study="${CSS.escape(st.nctId)}"] [data-status]`); if (!el) return;
    if (r.found) { const [l, tone] = STATUS_TXT[r.status] || [r.status ? title(r.status.replace(/_/g, ' ')) : 'On ClinicalTrials.gov', null]; el.innerHTML = badge(esc(l), { tone, size: 'sm' }); }
    else if (!r.unknown) el.innerHTML = badge('ID not found on ClinicalTrials.gov', { tone: 'missed', size: 'sm', ic: 'circle-alert' });
  }).catch(() => {});
  $('#aboutForm').onsubmit = async e => {
    e.preventDefault();
    try { S.prof = await api('/profile', { method: 'PUT', body: { profile: Object.fromEntries(new FormData(e.target)) } }); toast({ tone: 'taken', title: 'Saved', message: 'Study matches now use your details.' }); if ($('#trialResults').innerHTML) run(); }
    catch (x) { toast({ tone: 'missed', title: 'Couldn’t save that', message: x.message }); }
  };
  const box = $('#trialResults');
  const show = (list, searchUrl, note = '') => {
    S.trialList = list;
    const all = `<p class="pp-caption">${note}<a href="${esc(searchUrl)}" target="_blank" rel="noopener">See every result on ClinicalTrials.gov ${icon('external-link', { size: 12, style: 'display:inline;vertical-align:-1px' })}</a></p>`;
    box.innerHTML = list.length ? `<p class="pp-body-s pp-muted">${list.length === 1 ? '1 recruiting study' : `${list.length} recruiting studies`} found. Talk with your doctor before joining any study.</p>
      <div class="trial-grid">${list.map(t => trialCard(t, S.prof.profile)).join('')}</div>${all}`
      : `<div class="pp-card pp-card--pad-lg row" style="gap:16px;flex-wrap:nowrap">${pip('sleepy', 64)}<div class="stack" style="gap:6px"><p class="pp-body">No recruiting studies matched. Try a broader condition or remove the location.</p>${all}</div></div>`;
    announce(`${list.length} studies found`);
  };
  const run = async () => {
    const f = Object.fromEntries(new FormData($('#trialForm')));
    if (!f.cond && !f.intr) { box.innerHTML = '<div class="alert" role="alert">Enter a condition or a medication.</div>'; return; }
    box.innerHTML = `<div class="pp-card pp-card--pad-md row" style="gap:16px;flex-wrap:nowrap">${pip('wink', 48)}<p class="pp-body">Searching ClinicalTrials.gov…</p></div>`;
    try {
      const r = await api(`/trials?${new URLSearchParams(f)}`);
      if (!r.blocked) return show(r.studies, r.searchUrl);
      // The server couldn't reach ClinicalTrials.gov: ask it straight from the browser, else link to the website search.
      try {
        const d = await (await fetch(r.apiUrl, { headers: { Accept: 'application/json' } })).json();
        show((d.studies || []).map(x => mapStudy(x, f.loc || '')).filter(t => t.id), r.searchUrl);
      } catch {
        box.innerHTML = `<div class="pp-card pp-card--pad-lg row" style="gap:16px;flex-wrap:nowrap">${pip('sleepy', 64)}<div class="stack" style="gap:10px"><p class="pp-body">ClinicalTrials.gov didn’t answer PillPal just now, but your search works on their website.</p>
          <div>${btn('Open these results on ClinicalTrials.gov', { right: 'external-link', a: { href: r.searchUrl, target: '_blank', rel: 'noopener' } })}</div></div></div>`;
      }
    } catch (x) { if (x.status === 401) return renderAuth(); box.innerHTML = `<div class="pp-card pp-card--pad-lg row" style="gap:16px;flex-wrap:nowrap">${pip('sleepy', 64)}<p class="pp-body">${esc(x.message)}</p></div>`; }
  };
  $('#trialForm').onsubmit = e => { e.preventDefault(); run(); };
  if (intr || reasons[0]) run();
};
function studyDialog(st = {}) {
  const visitRow = (v = {}) => `<div class="visit-row">${input({ label: 'Date', a: { type: 'date', name: 'vDate', value: v.date || '', 'aria-label': 'Visit date' } })}${input({ label: 'Time', a: { type: 'time', name: 'vTime', value: v.time || '' } })}
    ${input({ label: 'What', a: { name: 'vLabel', value: v.label || '', placeholder: 'Week 12 visit' } })}${iconBtn('trash-2', 'Remove this visit', { size: 'sm', a: { 'data-rmv': '' } })}</div>`;
  const editing = !!st.title || (S.prof?.studies || []).some(x => x.nctId === st.nctId);
  const d = openDialog({ title: editing ? 'Study details' : 'Add a study', width: 620, body: `<form class="stack" style="gap:16px;margin-top:10px" novalidate>
    <div class="row" style="gap:10px;align-items:flex-end;flex-wrap:nowrap"><div style="flex:1">${input({ label: 'Study ID (NCT number)', hint: 'On your consent form or study card', a: { name: 'nctId', value: st.nctId || '', placeholder: 'NCT05971940', required: true, autocomplete: 'off' } })}</div>
      ${btn('Look up', { variant: 'secondary', left: 'search', a: { 'data-lookup': '' } })}</div>
    <div class="lookup" data-found ${st.title ? '' : 'hidden'}>${st.title ? `<strong style="color:var(--text-strong)">${esc(st.title)}</strong>` : ''}</div>
    <input type="hidden" name="title" value="${esc(st.title || '')}">
    <div class="grid-2">${input({ label: 'Participant ID', a: { name: 'participantId', value: st.participantId || '', placeholder: 'From your study card' } })}${input({ label: 'Study site', a: { name: 'site', value: st.site || '', placeholder: 'Clinic or hospital' } })}</div>
    <div class="grid-2">${input({ label: 'Coordinator name', a: { name: 'coordinatorName', value: st.coordinatorName || '' } })}${input({ label: 'Coordinator phone', ic: 'phone', a: { name: 'coordinatorPhone', type: 'tel', value: st.coordinatorPhone || '' } })}</div>
    ${input({ label: 'Coordinator email', ic: 'mail', a: { name: 'coordinatorEmail', type: 'email', value: st.coordinatorEmail || '' } })}
    <fieldset class="stack" style="gap:8px"><legend class="pp-field__label" style="margin-bottom:8px">Study visits</legend><div class="stack" style="gap:8px" data-visits>${(st.visits?.length ? st.visits : [{}]).map(visitRow).join('')}</div>
      <div>${btn('Add a visit', { variant: 'ghost', size: 'sm', left: 'plus', a: { 'data-addv': '' } })}</div></fieldset>
    <div class="alert" role="alert" hidden></div>
    <div class="row" style="justify-content:space-between;gap:10px">${editing ? btn('Remove study', { variant: 'ghost', left: 'trash-2', a: { 'data-del': '' } }) : '<span></span>'}
      <span class="row" style="gap:10px">${btn('Cancel', { variant: 'ghost', a: { 'data-close': '' } })}${btn('Save', { left: 'check', a: { type: 'submit' } })}</span></div></form>` });
  const form = $('form', d.el), err = $('.alert', form), vbox = $('[data-visits]', form);
  d.el.addEventListener('click', e => {
    if (e.target.closest('[data-addv]')) { vbox.insertAdjacentHTML('beforeend', visitRow()); vbox.lastElementChild.querySelector('input').focus(); }
    const rm = e.target.closest('[data-rmv]'); if (rm) rm.closest('.visit-row').remove();
  });
  $('[data-lookup]', form).onclick = async () => {
    const id = form.elements.nctId.value.trim().toUpperCase(), box = $('[data-found]', form);
    if (!/^NCT\d{8}$/.test(id)) { err.hidden = false; err.textContent = 'Study IDs look like NCT12345678.'; return; }
    err.hidden = true; box.hidden = false; box.textContent = 'Checking ClinicalTrials.gov…';
    const r = await lookupStudy(id).catch(() => ({ unknown: true }));
    if (r.found) { box.innerHTML = `<strong style="color:var(--text-strong)">${esc(r.title)}</strong><span>${esc((STATUS_TXT[r.status] || [r.status])[0] || '')}${r.sponsor ? ` · ${esc(r.sponsor)}` : ''}</span>`; form.elements.title.value = r.title; }
    else box.innerHTML = r.unknown ? 'Couldn’t reach ClinicalTrials.gov. You can still save it.' : '<strong style="color:var(--status-missed-text)">No study with that ID on ClinicalTrials.gov.</strong><span>Check the number on your consent form.</span>';
  };
  const save = async list => { S.prof = await api('/profile', { method: 'PUT', body: { studies: list } }); d.close(); render(); };
  $('[data-del]', form)?.addEventListener('click', async () => { await save((S.prof.studies || []).filter(x => x.nctId !== st.nctId)); toast({ title: 'Study removed' }); });
  form.onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(form), dates = f.getAll('vDate'), times = f.getAll('vTime'), labels = f.getAll('vLabel');
    const next = { ...Object.fromEntries(['nctId', 'title', 'participantId', 'site', 'coordinatorName', 'coordinatorPhone', 'coordinatorEmail'].map(k => [k, String(f.get(k) || '').trim()])),
      visits: dates.map((dt, i) => ({ date: dt, time: times[i], label: labels[i] })).filter(v => v.date) };
    next.nctId = next.nctId.toUpperCase();
    try {
      await save([...(S.prof.studies || []).filter(x => x.nctId !== st.nctId && x.nctId !== next.nctId), next]);
      toast({ tone: 'taken', title: 'Study saved', message: next.visits.length ? 'Your next visit shows on Today.' : '' });
    } catch (x) { err.hidden = false; err.textContent = x.message; }
  };
}
async function studySummaryDialog(nct) {
  const r = await api(`/study-summary?nct=${encodeURIComponent(nct)}&days=30&today=${today()}&now=${nowHM()}`);
  const mail = `mailto:${r.email}?subject=${encodeURIComponent(r.subject)}&body=${encodeURIComponent(r.text.slice(0, 1800))}`;
  const d = openDialog({ title: 'Send to my study team', width: 640, body: `<div class="stack" style="gap:14px;margin-top:8px">
    <p class="pp-body-s pp-muted">Your last 30 days: study medicine doses, side effects, measurements and notes. Review it, then email, copy or print.</p>
    <textarea class="pp-textarea summary-text" readonly rows="14" aria-label="Summary for your study team">${esc(r.text)}</textarea>
    <div class="row" style="gap:8px;justify-content:flex-end">${btn('Print', { variant: 'ghost', left: 'printer', a: { 'data-print': '' } })}${btn('Copy', { variant: 'secondary', left: 'copy', a: { 'data-copy': '' } })}
      ${btn(r.email ? 'Email study team' : 'Email', { left: 'send', a: { href: mail } })}</div>
    <p class="pp-caption">Email opens in your mail app. ${r.email ? '' : 'Add your coordinator’s email in the study details to fill it in. '}Nothing is sent until you press send there.</p></div>` });
  $('[data-copy]', d.el).onclick = async () => { try { await navigator.clipboard.writeText(r.text); toast({ tone: 'taken', title: 'Copied' }); } catch { $('.summary-text', d.el).select(); } };
  $('[data-print]', d.el).onclick = () => { const w = open('', '_blank'); if (!w) return; w.document.write(`<title>${esc(r.subject)}</title><pre style="font:14px/1.5 system-ui;white-space:pre-wrap;margin:32px">${esc(r.text)}</pre>`); w.document.close(); w.print(); };
}

// ---------- Settings ----------
PAGES.settings = async () => {
  const p = S.user.prefs || {};
  const perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  const SW = [['largeText', 'Larger text', 'Bigger type everywhere'], ['highContrast', 'High contrast', 'Stronger text and borders'],
    ['voice', 'Read reminders out loud', 'Pip speaks when it’s time for a dose'], ['reduceMotion', 'Reduce motion', 'Turns off animations'],
    ...(S.user.ai ? [['noAi', 'Turn off AI features', 'Ask Pip, smart scanning and explanations use Google Gemini. When on, your question and relevant medication info are sent to Google.']] : [])];
  $('#main').innerHTML = `${head({ title: 'Settings', sub: 'Make PillPal comfortable for you.' })}
  <div class="cols" data-screen-label="Settings">
    <div class="col col--wide">
      <section class="pp-card pp-card--pad-md"><h2 class="pp-h4" style="margin-bottom:6px">Comfort &amp; accessibility</h2>
        ${SW.map(([k, l, h]) => `<div class="set-row"><div style="min-width:0"><div style="font-weight:650;color:var(--text-strong)" id="sw-${k}">${l}</div><div class="pp-caption" style="margin-top:2px">${h}</div></div>
          ${toggle({ checked: p[k], a: { 'data-pref': k, 'aria-labelledby': `sw-${k}` } })}</div>`).join('')}
        <div style="padding-top:16px">${select({ label: 'Appearance', ic: 'sun-moon', value: p.theme || 'system', options: [{ value: 'system', label: 'Match my device' }, { value: 'light', label: 'Light' }, { value: 'warm', label: 'Warm' }, { value: 'dark', label: 'Dark' }], a: { id: 'theme' } })}</div>
      </section>
      <section class="pp-card pp-card--pad-md stack" style="gap:14px"><h2 class="pp-h4">Reminders</h2>
        <p class="pp-body-s">${perm === 'granted' ? 'Desktop notifications are on.' : perm === 'denied' ? 'Notifications are blocked in your browser settings. In-app reminders still work while PillPal is open.' : perm === 'unsupported' ? 'This browser doesn’t support notifications. In-app reminders still work.' : 'Turn on notifications so reminders reach you even in another tab.'}</p>
        <div class="row">${perm === 'default' ? btn('Turn on notifications', { left: 'bell', a: { 'data-action': 'notifyPerm' } }) : ''}${btn('Send a test reminder', { variant: 'secondary', a: { 'data-action': 'testReminder' } })}</div>
        <p class="pp-caption">Reminders work while PillPal is open (a tab or the installed app). Keep it running in the background.</p>
      </section>
    </div>
    <div class="col">
      <section class="pp-card pp-card--pad-md stack" style="gap:14px"><h2 class="pp-h4">Desktop app</h2>
        <p class="pp-body-s">Install PillPal so it opens in its own window, like any desktop app.</p>
        <div id="installBtn" ${S.install ? '' : 'hidden'}>${btn('Install PillPal', { variant: 'secondary', left: 'download', a: { 'data-action': 'install' } })}</div>
        <p class="pp-caption" id="installHint" ${S.install ? 'hidden' : ''}>In Chrome or Edge: open the browser menu, then choose “Install PillPal” (under “Cast, save, and share” or “Apps”).</p>
      </section>
      <section class="pp-card pp-card--pad-md stack" style="gap:10px" aria-live="polite"><h2 class="pp-h4 row" style="gap:8px">${icon('sparkles', { size: 18, color: 'var(--brand-text)' })}Pip’s AI (Google Gemini)</h2>
        <div id="aiStatus"><p class="pp-caption">Checking…</p></div></section>
      <section class="pp-card pp-card--pad-md stack" style="gap:12px"><h2 class="pp-h4 row" style="gap:8px">${icon('sparkles', { size: 18, color: 'var(--accent-text)' })}Demo mode</h2>
        <p class="pp-body-s">${S.user.demo ? 'You’re in the demo. Reset it to start the story fresh before a presentation.' : 'Open a separate demo account with 60 days of sample meds, doses and check-ins, so every feature has something to show. Your own data isn’t touched.'}</p>
        <div>${S.user.demo ? btn('Reset demo', { variant: 'secondary', left: 'rotate-ccw', a: { 'data-action': 'resetDemo' } }) : btn('Open the demo', { variant: 'secondary', left: 'sparkles', a: { 'data-action': 'openDemo' } })}</div></section>
      <section class="pp-card pp-card--pad-md stack" style="gap:14px"><h2 class="pp-h4">Account</h2>
        <div class="row" style="gap:12px;flex-wrap:nowrap"><span class="avatar avatar--static">${initial()}</span><div style="min-width:0"><div style="font-weight:700;color:var(--text-strong)">${esc(S.user.name)}</div><div class="pp-caption">${esc(S.user.email)}</div></div></div>
        <p class="pp-caption">Your data stays in your PillPal account. Nothing is shared unless you print or copy your report.</p>
        <div>${btn('Sign out', { variant: 'secondary', left: 'log-out', a: { 'data-action': 'logout' } })}</div>
      </section>
    </div>
  </div>`;
  api('/ai/status').then(a => {
    const box = $('#aiStatus'); if (!box) return;
    box.innerHTML = !a.configured ? '<p class="pp-body-s">Not set up. Add <code>GEMINI_API_KEY=…</code> to the <code>.env</code> file and restart the server.</p>'
      : a.ok ? `<p class="pp-body-s row" style="gap:6px">${badge('Connected', { tone: 'taken', ic: 'check' })}<span class="pp-mono" style="font-size:13px">${esc(a.model)}</span></p>`
      : a.ok === false ? `<div class="note note--missed"><strong>Gemini isn’t answering</strong><span>${esc(a.error)}</span></div><p class="pp-caption">The server log shows each Gemini error too.</p>`
      : '<p class="pp-body-s pp-muted">Not checked yet.</p>';
  }).catch(() => {});
  document.querySelectorAll('[data-pref]').forEach(i => (i.onchange = () => { S.user.prefs = { ...S.user.prefs, [i.dataset.pref]: i.checked }; savePrefs(); }));
  $('#theme').onchange = e => { S.user.prefs = { ...S.user.prefs, theme: e.target.value }; savePrefs(); };
};
async function savePrefs() {
  applyPrefs();
  try { await api('/me', { method: 'PATCH', body: { prefs: S.user.prefs } }); announce('Settings saved'); }
  catch (x) { toast({ tone: 'missed', title: 'Couldn’t save that', message: x.message }); }
}
addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.install = e; $('#installBtn')?.removeAttribute('hidden'); $('#installHint')?.setAttribute('hidden', ''); });

// ---------- reminders ----------
function remind(m, time, test = false) {
  chime();
  const detail = [m.dose, m.instructions].filter(Boolean).join(' · ');
  if (S.user.prefs?.voice) speak(`Time to take your ${m.name}${m.dose ? ', ' + m.dose : ''}.`);
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
    const n = new Notification(`Time for ${m.name}`, { body: detail || 'Open PillPal to log it.', icon: '/icon.svg', tag: `${m._id}|${time}` });
    n.onclick = () => { focus(); location.hash = '#/today'; };
  }
  toast({ reminder: true, sticky: !test, title: `Time for ${m.name}`, message: test ? 'This is a test reminder.' : detail || fmtTime(time),
    actions: test ? '' : `<div class="stack" style="gap:8px"><div class="row" style="gap:8px">${btn('Take', { size: 'sm', left: 'check', a: { 'data-action': 'toastDose', 'data-med': m._id, 'data-time': time } })}
      ${btn('Skip', { variant: 'secondary', size: 'sm', left: 'skip-forward', a: { 'data-action': 'toastDose', 'data-status': 'skipped', 'data-med': m._id, 'data-time': time } })}</div>${snoozeForm(m, { date: today(), time })}</div>` });
}
// Log a dose; the server starts (Take/Skip) or resets (Undo) the med's timer and sends it back.
async function logDose(m, date, time, status, endTimer = false) {
  const r = await api('/doses', { method: 'POST', body: { medId: m._id, date, time, status, endTimer } });
  m.timer = r.timer || null; m.snooze = null;
  return r;
}
// After a dose: when the next one is, and an offer to log how this medicine is feeling.
function tookToast(m, time) {
  document.querySelectorAll(`[data-snooze-for="${m._id}"]`).forEach(el => el.remove());
  const t = doseTimers().find(x => x.m._id === m._id);
  const all = todayItems().every(i => i.status === 'taken' || i.status === 'skipped');
  toast({ tone: 'taken', title: all ? 'Everything logged for today' : `${m.name} logged`, ms: 10000,
    message: `${t?.state === 'counting' ? `Timer started: next dose in ${inWords(t.end - Date.now())} (${atWords(t.end)}).` : `Taken at ${fmtTime(nowHM())}.`} How are you feeling on it?`,
    actions: btn('Quick check-in', { variant: 'secondary', size: 'sm', left: 'heart-pulse', a: { 'data-action': 'medCheckin', 'data-med': m._id, 'data-time': time } }) });
}
// "Remind me in X minutes": the form sits in reminder toasts and on due dose timers.
document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-snooze]');
  if (!f) return;
  e.preventDefault();
  const min = Math.round(+f.elements.min.value), m = S.meds.find(x => x._id === f.dataset.med);
  if (!m) return;
  if (!(min >= 1 && min <= 240)) { f.elements.min.focus(); return toast({ tone: 'missed', title: 'Pick 1 to 240 minutes' }); }
  try {
    const { snooze } = await api(`/meds/${m._id}/snooze`, { method: 'POST', body: { minutes: min, date: f.dataset.date, time: f.dataset.time } });
    m.snooze = snooze;
    f.closest('.pp-toast')?.remove();
    toast({ title: `I’ll remind you in ${plural(min, 'minute')}`, message: `About your ${m.name}, at ${fmtTime(hm(snooze.until))}.` }).dataset.snoozeFor = m._id;
    if (route() === 'today') render();
  } catch (x) { if (x.status === 401) renderAuth(); else toast({ tone: 'missed', title: 'Couldn’t set that reminder', message: x.message }); }
});
function startReminders() {
  clearInterval(S.timer);
  const tick = async () => {
    const t = nowHM(), d = today();
    for (const m of S.meds) for (const time of m.times) {
      const key = `${m._id}|${d}|${time}`;
      if (time !== t || S.notified.has(key)) continue;
      S.notified.add(key);
      const logged = await api(`/doses?date=${d}`).catch(() => []);
      if (!logged.some(x => x.medId === m._id && x.time === time)) remind(m, time);
    }
    // A dose timer that just ran out (and wasn't snoozed): time for the next dose.
    for (const m of S.meds) {
      const tm = m.timer, end = tm && +new Date(tm.endsAt), key = tm && `t|${m._id}|${tm.endsAt}`;
      if (!tm || end > Date.now() || S.notified.has(key)) continue;
      S.notified.add(key);
      if (Date.now() - end > 30 * 60e3 || (m.snooze && +new Date(m.snooze.until) > Date.now())) continue;
      if (!$('.pp-toast--reminder') && openSlots(m).length) remind(m, pickSlot(m));
      if (route() === 'today' && !document.querySelector('.pp-dialog__overlay') && !document.activeElement?.closest('form')) render();
    }
    // Snoozed doses ("remind me in X minutes") come back when their time is up.
    for (const m of S.meds) {
      const z = m.snooze, key = z && `z|${m._id}|${z.until}`;
      if (!z || +new Date(z.until) > Date.now() || S.notified.has(key)) continue;
      S.notified.add(key);
      if (Date.now() - new Date(z.until) > 30 * 60e3 || z.date !== d) continue;
      const logged = await api(`/doses?date=${d}`).catch(() => []);
      if (!logged.some(x => x.medId === m._id && x.time === z.time)) remind(m, z.time);
    }
    if (route() !== 'today') updateBadge();
  };
  S.timer = setInterval(tick, 15000);
  tick();
}

// ---------- More sheet (phones) ----------
function openMore() {
  const items = [['health', 'Health log', 'activity'], ['chat', 'Ask Pip', 'messages-square'], ['report', 'Doctor report', 'file-text'], ['trials', 'Trials & help', 'flask-conical'], ['settings', 'Settings', 'settings']].filter(n => aiOn() || n[0] !== 'chat');
  const el = document.createElement('div');
  el.id = 'moreSheet';
  el.innerHTML = `<div class="sheet__back" data-sheet-close></div><div class="sheet" role="dialog" aria-modal="true" aria-label="More"><div class="sheet__grip"></div>
    ${items.map(([id, l, ic]) => `<a class="sheet__item" href="#/${id}"><span class="tile tile--brand-soft tile--sm">${icon(ic, { size: 20 })}</span><span style="flex:1">${l}</span>${icon('chevron-right', { size: 18, color: 'var(--text-muted)' })}</a>`).join('')}</div>`;
  el.addEventListener('click', e => { if (e.target.closest('[data-sheet-close]') || e.target.closest('a')) setTimeout(() => el.remove()); });
  el.addEventListener('keydown', e => { if (e.key === 'Escape') { el.remove(); $('[data-nav-more]')?.focus(); } });
  document.body.append(el);
  $('.sheet__item', el).focus();
}

// ---------- actions (event delegation) ----------
const ACTIONS = {
  async dose(b) {
    const status = b.dataset.status || null, m = S.meds.find(x => x._id === b.dataset.med), time = b.dataset.time;
    const hadTimer = !!m.timer;
    await logDose(m, b.dataset.date || today(), time, status, !!b.closest('[data-timer]'));
    if (status === 'taken') chime();
    announce(status ? `${m.name} marked ${status}` : `${m.name} reset`);
    await render();
    (b.closest('[data-timer]') ? $(`[data-timer][aria-label="${CSS.escape(m.name)}"] button`) : $(`.pp-dose [data-med="${m._id}"][data-time="${time}"]`))?.focus();
    if (status === 'taken') tookToast(m, time);
    else if (!status && hadTimer && !m.timer) toast({ title: `${m.name} timer reset`, message: `Back to ${hoursWord(intervalHours(m))}. It starts again when you tap Take.` });
    else if (status === 'skipped') toast({ title: `${m.name} skipped`, message: 'No timer started. Tap Take when you have your next dose.' });
  },
  async toastDose(b) {
    b.closest('.pp-toast')?.remove();
    const m = S.meds.find(x => x._id === b.dataset.med), status = b.dataset.status || 'taken';
    await logDose(m, today(), b.dataset.time, status, status === 'skipped');
    if (status === 'taken') chime();
    if (route() === 'today') await render(); else updateBadge();
    if (status === 'taken') tookToast(m, b.dataset.time); else toast({ title: `${m.name} skipped`, message: 'No timer started.' });
  },
  medCheckin(b) { const m = S.meds.find(x => x._id === b.dataset.med); b.closest('.pp-toast')?.remove(); if (m) medCheckinDialog(m, b.dataset.time || ''); },
  openMed(b) { const m = S.meds.find(x => x._id === b.dataset.id); if (m) medDetail(m); },
  removeMed(b) {
    const m = S.meds.find(x => x._id === b.dataset.id);
    confirmDialog({ title: `Remove ${m.name}?`, text: 'This deletes it from PillPal, along with its dose history and check-ins. To keep its history on your doctor report, choose “Stop tracking” instead.', ok: 'Remove', onOk: async () => {
      try {
        await api(`/meds/${m._id}?remove=1&today=${today()}`, { method: 'DELETE' });
        await loadMeds(); await render();
        toast({ title: `${m.name} removed`, message: 'It’s out of your cabinet.' });
      } catch (x) { toast({ tone: 'missed', title: 'Couldn’t remove that', message: x.message }); }
    } });
  },
  addMed: () => medDialog(),
  askMed(b) { const m = S.meds.find(x => x._id === b.dataset.id); S.pendingAsk = `Tell me about my ${m.name}: what it’s for, how to take it well, and what side effects to watch for.`; location.hash = '#/chat'; },
  suggest: b => sendChat(b.textContent.trim()),
  speak: b => speak(S.chat[b.dataset.i]?.text || ''),
  clearChat() { S.chat = []; renderChat(); $('#chatIn')?.focus(); },
  async explain(b) {
    const box = $('#' + b.dataset.target);
    b.disabled = true;
    box.innerHTML = `<div class="pp-card pp-card--warm pp-card--pad-sm"><span class="pp-overline ai-tag">${icon('sparkles', { size: 14 })}Pip explains · AI</span><p class="pp-body-s pp-muted" style="margin-top:8px">Pip is putting it simply…</p></div>`;
    try {
      const e = await api('/ai/explain', { method: 'POST', body: { name: b.dataset.name } });
      box.innerHTML = `<div class="pp-card pp-card--warm pp-card--pad-sm stack" style="gap:8px"><span class="pp-overline ai-tag">${icon('sparkles', { size: 14 })}Pip explains · AI</span>
        <p class="pp-body-s" style="color:var(--text-strong)">${esc(e.simple)}</p>
        ${e.tips.length ? `<div class="pp-overline pp-muted" style="margin-top:4px">Tips</div><ul class="list list--s">${e.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
        ${e.askDoctor.length ? `<div class="pp-overline pp-muted" style="margin-top:4px">Worth asking your pharmacist</div><ul class="list list--s">${e.askDoctor.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}</div>`;
      b.remove();
    } catch (x) { box.innerHTML = `<div class="alert" role="alert">${esc(x.message)}</div>`; b.disabled = false; }
  },
  async visitPrep(b) {
    b.disabled = true;
    $('#prep').innerHTML = thinking('Pip is drafting your visit summary…');
    try {
      (S.prep ||= {})[S.period] = await api('/ai/visit-prep', { method: 'POST', body: { days: S.period, today: today(), now: nowHM() } });
      $('#prep').innerHTML = prepHtml(S.prep[S.period]);
    } catch (x) { $('#prep').innerHTML = prepHtml(); toast({ tone: 'missed', title: 'Pip couldn’t draft that', message: x.message }); }
  },
  editMed: b => medDialog(S.meds.find(m => m._id === b.dataset.id)),
  delMed(b) {
    const m = S.meds.find(x => x._id === b.dataset.id);
    confirmDialog({ title: `Stop tracking ${m.name}?`, text: 'Its history stays in your doctor report.', ok: 'Stop tracking', onOk: async () => {
      try {
        await api(`/meds/${m._id}?today=${today()}`, { method: 'DELETE' });
        await loadMeds(); await render();
        toast({ title: `Stopped tracking ${m.name}`, message: 'Its history stays in your doctor report.' });
      } catch (x) { toast({ tone: 'missed', title: 'Couldn’t remove that', message: x.message }); }
    } });
  },
  capture: () => capture('button'),
  closeResult() { resetScan(); $('#scanBtn').focus(); },
  // Tap-to-pick / "Did you mean": look up the chosen name, and remember the fix for this user's next scans.
  async pickDrug(b) {
    const name = b.dataset.name, words = (S.lastWords || []).slice(0, 3);
    setScan('scanning', `Looking up ${name}…`);
    try {
      const r = await api(`/drug?q=${encodeURIComponent(name)}`);
      if (r.info && words.length && !words.some(w => w.toUpperCase() === name.toUpperCase())) api('/drug/fix', { method: 'POST', body: { words, name } }).catch(() => {});
      showResult(r, name);
    } catch (x) { if (x.status === 401) throw x; setScan('error', x.message); scanError(x.message); }
  },
  light: () => setLight(!S.light),
  scanAdd() { medDialog(S.prefill || {}); },
  period(b) { S.period = +b.dataset.value; render(); },
  print: () => print(),
  async copyReport() {
    try { await navigator.clipboard.writeText(reportText(S.report)); toast({ tone: 'taken', title: 'Report copied', message: 'Paste it into your patient portal message.' }); }
    catch { toast({ tone: 'missed', title: 'Copy failed', message: 'Use Print / PDF instead.' }); }
  },
  async notifyPerm() { await Notification.requestPermission(); render(); },
  testReminder() { remind(S.meds[0] || { _id: 'test', name: 'your medication' }, nowHM(), true); },
  async install() { await S.install?.prompt(); S.install = null; $('#installBtn')?.setAttribute('hidden', ''); $('#installHint')?.removeAttribute('hidden'); },
  theme: b => ($('#themeMenu') ? $('#themeMenu').remove() : themeMenu(b)),
  setTheme(b) {
    $('#themeMenu')?.remove();
    S.user.prefs = { ...S.user.prefs, theme: b.dataset.value }; savePrefs();
    if (route() === 'settings') { const t = $('#theme'); if (t) t.value = S.user.prefs.theme; }
    document.querySelector('[data-action="theme"]:not([hidden])')?.focus();
  },
  more: () => openMore(),
  editStudy(b) { const st = (S.prof?.studies || []).find(x => x.nctId === b.dataset.id) || (b.dataset.new ? { nctId: b.dataset.new } : {}); studyDialog(st); },
  studySummary: b => studySummaryDialog(b.dataset.id),
  async precheck(b) {
    const card = b.closest('[data-trial]'), box = $('.precheck', card), t = (S.trialList || []).find(x => x.id === b.dataset.id);
    b.disabled = true; box.innerHTML = thinking('Pip is reading the eligibility rules…');
    try {
      const r = await api(`/trials/${b.dataset.id}/precheck`, { method: 'POST', body: { criteria: t?.criteria || '', title: t?.title || '', today: today(), now: nowHM() } });
      const tone = { likely: 'taken', maybe: 'due', unlikely: 'missed' }[r.verdict], word = { likely: 'Looks like a fit', maybe: 'Maybe a fit', unlikely: 'Probably not a fit' }[r.verdict];
      const list = (h, xs) => (xs.length ? `<div class="pp-overline pp-muted" style="margin-top:4px">${h}</div><ul class="list list--s">${xs.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
      box.innerHTML = `<div class="pp-card pp-card--warm pp-card--pad-sm stack" style="gap:6px"><div class="row" style="gap:8px">${badge(word, { tone, size: 'sm' })}<span class="pp-overline ai-tag">${icon('sparkles', { size: 12 })}Pip pre-check</span></div>
        <p class="pp-body-s" style="color:var(--text-strong)">${esc(r.summary)}</p>${list('Seems to match', r.matches)}${list('Might rule you out', r.concerns)}${list('Ask the study team', r.ask)}
        <p class="pp-caption">Pip’s guess from the study’s rules and your PillPal info. Only the study team can say if you qualify.</p></div>`;
      b.remove();
    } catch (x) { box.innerHTML = `<div class="alert" role="alert">${esc(x.message)}</div>`; b.disabled = false; }
  },
  addVital: b => vitalDialog(b.dataset.type),
  async delVital(b) { await api(`/vitals/${b.dataset.id}`, { method: 'DELETE' }); toast({ title: 'Reading deleted' }); render(); },
  addEffect: () => effectDialog(),
  editEffect(b) { const e = (S.effects || []).find(x => x._id === b.dataset.id); if (e) effectDialog(e); },
  async endEffect(b) {
    const e = (S.effects || []).find(x => x._id === b.dataset.id); if (!e) return;
    await api(`/effects/${e._id}`, { method: 'PUT', body: { ...e, suspects: e.suspects.map(x => x.id), endDate: today() } });
    toast({ tone: 'taken', title: `${e.name} marked as stopped`, message: 'Glad it’s over. It stays on your report.' }); render();
  },
  openDemo(b) { confirmDialog({ title: 'Open the demo?', text: 'You’ll leave your account and open a separate demo account with sample data. Sign back in any time; your data isn’t changed.', ok: 'Open demo', variant: 'primary', onOk: () => startDemo(b) }); },
  async resetDemo(b) {
    b.disabled = true;
    await api('/demo/reset', { method: 'POST', body: demoBody() });
    Object.assign(S, { chat: [], prep: null, aiNote: null, mix: null, notified: new Set() });
    await loadMeds(); location.hash = '#/today'; await render(true);
    toast({ tone: 'taken', title: 'Demo reset', message: 'Fresh 60-day story, with a dose coming due in about 2 minutes.' });
  },
  reload: () => location.reload(),
  async logout() {
    await api('/logout', { method: 'POST' }).catch(() => {});
    stopCamera(); clearInterval(S.timer); S.user = null; S.chat = []; S.aiNote = S.prep = null;
    document.documentElement.className = ''; history.replaceState(null, '', location.pathname); renderAuth();
  },
};
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-action]');
  if (!b || !ACTIONS[b.dataset.action]) return;
  e.preventDefault();
  try { await ACTIONS[b.dataset.action](b, e); }
  catch (x) { if (x.status === 401) renderAuth(); else toast({ tone: 'missed', title: 'Oops', message: x.message }); }
});

// ---------- boot ----------
(async () => {
  try { S.user = await api('/me'); } catch { return renderAuth(); }
  await enter();
})();
