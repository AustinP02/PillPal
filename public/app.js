// PillPal front end, built on the PillPal design system (/ds). No framework: hash routes render template strings,
// every dynamic value goes through esc(), and clicks are handled by one delegated [data-action] listener.
import { esc, icon, btn, iconBtn, badge, tag, pill, pillBox, medPill, mascot, logo, ring, input, select, textarea, toggle, checkbox, tabs } from './ui.js';
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
function toast({ tone = 'info', title: t, message = '', actions = '', sticky = false, reminder = false }) {
  const el = document.createElement('div');
  el.className = `pp-toast pp-toast--${reminder ? 'due' : tone}${reminder ? ' pp-toast--reminder' : ''}`;
  el.setAttribute('role', reminder ? 'alert' : 'status');
  el.innerHTML = `<span class="pp-toast__icon">${icon(reminder ? 'bell' : TOAST_ICON[tone] || 'bell', { size: 18 })}</span>
    <div style="flex:1;min-width:0">${t ? `<div class="pp-toast__title">${esc(t)}</div>` : ''}${message ? `<div class="pp-toast__msg">${esc(message)}</div>` : ''}${actions ? `<div class="pp-toast__action">${actions}</div>` : ''}</div>
    ${iconBtn('x', 'Dismiss', { size: 'sm', a: { 'data-toast-close': '' }, cls: 'pp-toast__x' })}`;
  $('#toasts').append(el);
  if (!sticky) setTimeout(() => el.remove(), 5000);
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
function confirmDialog({ title: t, text, ok, onOk }) {
  const d = openDialog({ title: t, body: `<p>${esc(text)}</p><div class="pp-dialog__actions">${btn('Cancel', { variant: 'ghost', a: { 'data-close': '' } })}${btn(esc(ok), { variant: 'danger', a: { 'data-ok': '' } })}</div>` });
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
      </form>
    </main></div>`;
  app.querySelectorAll('[data-action="authMode"]').forEach(b => (b.onclick = e => { e.stopPropagation(); renderAuth(b.dataset.value, '', $('#aEmail').value); }));
  $('#aShow').onchange = e => ($('#aPass').type = e.target.checked ? 'text' : 'password');
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

// ---------- shell & routing ----------
const NAV = [['today', 'Today', 'house'], ['meds', 'My meds', 'pill'], ['scan', 'Scan bottle', 'scan-line'], ['checkin', 'Check-in', 'heart-pulse'],
  ['chat', 'Ask Pip', 'messages-square'], ['report', 'Doctor report', 'file-text'], ['trials', 'Trials & help', 'flask-conical'], ['settings', 'Settings', 'settings']];
const TABS = [['today', 'Today', 'house'], ['meds', 'Meds', 'pill'], ['scan', 'Scan', 'scan-line'], ['checkin', 'Check-in', 'heart-pulse']];
const MORE = ['chat', 'report', 'trials', 'settings'];

const darkNow = () => document.documentElement.dataset.theme === 'dark';
function applyPrefs() {
  const p = S.user?.prefs || {}, r = document.documentElement;
  r.classList.toggle('large-text', !!p.largeText);
  r.classList.toggle('high-contrast', !!p.highContrast);
  r.classList.toggle('reduce-motion', !!p.reduceMotion);
  const t = p.theme === 'light' || p.theme === 'dark' ? p.theme : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  r.dataset.theme = t;
  $('meta[name=theme-color]')?.setAttribute('content', t === 'dark' ? '#0A1112' : '#127479');
  document.querySelectorAll('[data-action="theme"]').forEach(b => b.outerHTML = themeBtn());
  const fab = $('#fab'); if (fab) fab.hidden = !aiOn() || route() === 'chat';
  document.querySelectorAll('[data-nav="chat"]').forEach(a => (a.closest('li') || a).hidden = !aiOn());
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => S.user && applyPrefs());
const themeBtn = () => iconBtn(darkNow() ? 'sun' : 'moon', darkNow() ? 'Light mode' : 'Dark mode', { variant: 'secondary', a: { 'data-action': 'theme' } });
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
    <span class="pp-dose__time">${when}</span>${pillBox(medPill(m), 44, 30)}
    <div class="pp-dose__main"><div class="pp-dose__name">${esc(m.name)}${m.dose ? `<span class="pp-dose__dose"> · ${esc(m.dose)}</span>` : ''}</div>
      <div class="pp-dose__meta">${m.instructions ? `<span>${esc(m.instructions)}</span>` : ''}${m.trialId ? badge(esc(m.trialId), { tone: 'accent', size: 'sm', ic: 'flask-conical' }) : ''}</div></div>
    <div class="pp-dose__actions">${right}</div></div>`;
}

PAGES.today = async () => {
  const [doses, rep, checks] = await Promise.all([
    api(`/doses?date=${today()}`), api(`/report?days=90&today=${today()}&now=${nowHM()}`), api(`/checkins?days=1&today=${today()}`)]);
  S.doses = doses;
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
      <section class="pp-card pp-card--pad-md stack" style="gap:20px" aria-labelledby="schedH">
        <h2 id="schedH" class="pp-h3">Today’s schedule</h2>
        ${items.length ? slots : emptyMeds(false)}
      </section>
    </div>
    <div class="col">
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
};

// ---------- Meds ----------
PAGES.meds = async () => {
  await loadMeds();
  $('#main').innerHTML = `${head({ title: 'My medications', sub: 'Everything PillPal reminds you about.', actions: medActions() })}
  <div data-screen-label="My meds">${S.meds.length ? `<div class="med-grid">${S.meds.map(m => `<article class="pp-card pp-card--pad-md med-card">
      <div class="row" style="gap:14px;flex-wrap:nowrap">${pillBox(medPill(m), 56, 38)}<div style="min-width:0"><h3 class="pp-h3">${esc(m.name)}</h3>
        <p class="pp-body-s pp-muted">${esc([m.dose, m.reason && 'for ' + m.reason].filter(Boolean).join(' · ') || 'No dose added')}</p></div></div>
      <div class="row" style="gap:6px">${m.times.map(t => tag(fmtTime(t), { ic: 'bell' })).join('')}</div>
      ${m.instructions ? `<p class="pp-caption">${esc(m.instructions)}</p>` : ''}
      ${runOut(m) || m.discardAfter ? `<p class="pp-caption row" style="gap:6px">${icon('package', { size: 14 })}<span>${esc([runOut(m) && `Runs out around ${fmtDate(runOut(m))}`, refillWord(m), m.discardAfter && `discard after ${fmtDate(m.discardAfter)}`].filter(Boolean).join(' · '))}</span></p>` : ''}
      ${m.trialId ? `<div>${badge(`Study medication · ${esc(m.trialId)}`, { tone: 'accent', ic: 'flask-conical' })}</div>` : ''}
      <div class="row med-card__actions">${aiOn() ? btn('Ask Pip', { variant: 'soft', size: 'sm', left: 'messages-square', a: { 'data-action': 'askMed', 'data-id': m._id } }) : ''}
        ${btn('Edit', { variant: 'secondary', size: 'sm', a: { 'data-action': 'editMed', 'data-id': m._id } })}
        ${btn('Stop tracking', { variant: 'ghost', size: 'sm', a: { 'data-action': 'delMed', 'data-id': m._id } })}</div>
    </article>`).join('')}</div>`
    : `<div class="pp-card pp-card--pad-lg">${emptyMeds(true)}</div>`}</div>`;
};

const timeRow = t => `<div class="pp-input time-row">${icon('bell', { size: 18 })}<input type="time" name="times" value="${esc(t)}" aria-label="Reminder time" required>
  ${iconBtn('trash-2', 'Remove this time', { size: 'sm', a: { 'data-rm': '' } })}</div>`;
const lookupHtml = info => info
  ? `<strong style="color:var(--text-strong)">${esc(title(info.brand || info.generic))}${info.generic ? ` (${esc(info.generic.toLowerCase())})` : ''}</strong>
     <span>${esc(info.uses || 'No usage summary on the label.')}</span>${info.boxedWarning ? `<span class="boxed-mini">Boxed warning: ${esc(info.boxedWarning)}</span>` : ''}`
  : '<strong style="color:var(--text-strong)">No match</strong><span>I couldn’t find that name. Check the spelling, or keep it as typed.</span>';

function medDialog(m = {}) {
  const st = { shape: m.shape || 'round', color: m.color || PILL_COLORS[S.meds.length % PILL_COLORS.length][0] };
  const preview = () => pill(medPill(st), 44);
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
    <fieldset><legend class="pp-field__label" style="margin-bottom:10px">How the pill looks <span class="pp-caption" style="font-weight:500">so you can spot it fast</span></legend>
      <div class="row" style="gap:16px"><span class="pp-pill-icon" id="mPreview" style="width:64px;height:64px">${preview()}</span>
        <div class="stack" style="gap:10px"><div id="mShape">${tabs([{ value: 'round', label: 'Round' }, { value: 'oval', label: 'Oval' }, { value: 'capsule', label: 'Capsule' }], st.shape, { action: 'shape', label: 'Pill shape' })}</div>
          <div role="radiogroup" aria-label="Pill color" class="row" style="gap:8px" id="mColors">${swatches()}</div></div></div></fieldset>
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
    const body = { ...Object.fromEntries(['name', 'dose', 'reason', 'instructions', 'trialId', 'quantity', 'unitsPerDose', 'refills', 'fillDate', 'discardAfter'].map(k => [k, (f.get(k) || '').trim()])), ...st, times: f.getAll('times').filter(Boolean), today: today() };
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
    <div class="stack" style="gap:8px">${btn('Add to my meds', { size: 'lg', block: true, left: 'plus', a: { 'data-action': 'scanAdd' } })}
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
      toast({ tone: 'taken', title: 'Check-in saved', message: 'It’s on your doctor report now.' });
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
      <form class="chat__form" id="chatForm"><label style="flex:1;min-width:0"><span class="sr-only">Message Pip</span>
        <textarea id="chatIn" rows="1" maxlength="2000" placeholder="Ask about your medicines…" class="pp-textarea chat__input"></textarea></label>
        ${iconBtn('send-horizontal', 'Send', { variant: 'primary', a: { type: 'submit', id: 'chatSend' } })}</form>
      <p class="pp-caption chat__foot">Powered by Google Gemini. Emergencies: call 911.</p>
    </section>
    <div class="col">
      <section class="pp-card pp-card--pad-md stack" style="gap:14px"><h2 class="pp-h4">What Pip knows</h2>
        <p class="pp-caption">Pip uses your PillPal data and FDA label text to answer. Nothing else.</p>
        ${S.meds.map(m => `<div class="row" style="gap:12px;flex-wrap:nowrap">${pillBox(medPill(m), 38, 26)}<div style="min-width:0;flex:1">
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
            ${m.error ? '' : btn('Read aloud', { variant: 'ghost', size: 'sm', left: 'volume-2', a: { 'data-action': 'speak', 'data-i': i, 'aria-label': 'Read this answer aloud' } })}</div></div>`).join('')
      + (S.chatBusy ? `<div class="msg" role="status">${pipAvatar()}<div class="bubble bubble--pip pp-muted">Pip is thinking…</div></div>` : '')
    : `<div class="chat__empty">${pip('happy', 104)}<div><p class="pp-h3">Hi ${esc(S.user.name)}, I’m Pip.</p><p class="pp-body pp-muted" style="margin-top:4px">Ask me anything about your medicines.</p></div>
        <div class="row" style="gap:8px;justify-content:center;max-width:560px">${SUGGEST.map(q => tag(q, { a: { 'data-action': 'suggest' } })).join('')}</div></div>`;
  log.scrollTop = S.chat.length ? log.scrollHeight : 0;
}

async function sendChat(text) {
  if (S.chatBusy) return;
  S.chat.push({ role: 'user', text });
  S.chatBusy = true;
  renderChat();
  try {
    const r = await api('/ai/chat', { method: 'POST', body: { messages: S.chat.filter(m => !m.error).map(({ role, text: t }) => ({ role, text: t })), today: today(), now: nowHM() } });
    S.chat.push({ role: 'model', text: r.reply, urgent: r.urgent });
    if (S.user.prefs?.voice) speak(r.reply);
  } catch (x) {
    if (x.status === 401) { S.chatBusy = false; return renderAuth(); }
    S.chat.push({ role: 'model', text: x.message || 'I couldn’t answer just now. Try again in a moment.', error: true });
  }
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
    <section class="report__sec"><h3 class="pp-h4" style="margin-bottom:12px">Mood trend</h3>${sparkline(r.moods)}</section>
    <section class="report__sec"><h3 class="pp-h4" style="margin-bottom:12px">Patient notes and questions</h3>
      ${r.notes.length ? `<ul class="list">${r.notes.map(n => `<li><strong style="color:var(--text-strong)">${n.date === today() ? 'Today' : esc(fmtDate(n.date))}:</strong> ${esc(n.notes)}${n.questions ? `${n.notes ? '<br>' : ''}<em>Question:</em> ${esc(n.questions)}` : ''}</li>`).join('')}</ul>` : '<p class="pp-body-s pp-muted">No notes.</p>'}</section>
    ${trials.length ? `<section class="report__sec"><h3 class="pp-h4" style="margin-bottom:12px">Clinical trial participation</h3><ul class="list">${trials.map(m =>
      `<li>${esc(m.name)}: <a href="https://clinicaltrials.gov/study/${esc(m.trialId)}" target="_blank" rel="noopener">${esc(m.trialId)}</a>, ${m.adherence ?? 'n/a'}${m.adherence != null ? '%' : ''} adherence</li>`).join('')}</ul></section>` : ''}
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
PAGES.trials = async q => {
  const reasons = [...new Set(S.meds.map(m => m.reason).filter(Boolean))];
  const intr = q.get('intr') || '';
  $('#main').innerHTML = `${head({ title: 'Clinical trials & community', sub: 'Research only moves forward when people take part. Find studies that are recruiting now.' })}
  <div class="stack" style="gap:24px" data-screen-label="Trials & help">
    <form class="pp-card pp-card--pad-md trial-form" id="trialForm">
      ${input({ label: 'Condition', a: { name: 'cond', id: 'tCond', value: intr ? '' : reasons[0] || '', placeholder: 'e.g. type 2 diabetes', list: 'tCondList' } })}<datalist id="tCondList">${reasons.map(r => `<option value="${esc(r)}">`).join('')}</datalist>
      ${input({ label: 'Medication (optional)', a: { name: 'intr', value: intr, placeholder: 'e.g. metformin', list: 'tMedList' } })}<datalist id="tMedList">${S.meds.map(m => `<option value="${esc(m.name)}">`).join('')}</datalist>
      ${input({ label: 'Near (city or state)', ic: 'map-pin', a: { name: 'loc', placeholder: 'e.g. New Brunswick, NJ' } })}
      ${btn('Find trials', { left: 'search', a: { type: 'submit' } })}
    </form>
    <div id="trialResults" class="stack" style="gap:12px" aria-live="polite"></div>
    <h2 class="pp-h3" style="margin-top:8px">Help for you and your community</h2>
    <div class="res-grid">${RESOURCES.map(([ic, t, x, h]) => `<a href="${h}" ${h.startsWith('http') ? 'target="_blank" rel="noopener"' : ''} class="pp-card pp-card--interactive pp-card--pad-md res">
      <span class="tile tile--brand-soft">${icon(ic, { size: 22 })}</span><h3 class="pp-h4">${t}</h3><p class="pp-body-s pp-muted">${x}</p></a>`).join('')}</div>
  </div>`;
  const run = async () => {
    const f = Object.fromEntries(new FormData($('#trialForm')));
    const box = $('#trialResults');
    if (!f.cond && !f.intr) { box.innerHTML = '<div class="alert" role="alert">Enter a condition or a medication.</div>'; return; }
    box.innerHTML = `<div class="pp-card pp-card--pad-md row" style="gap:16px;flex-wrap:nowrap">${pip('wink', 48)}<p class="pp-body">Searching ClinicalTrials.gov…</p></div>`;
    try {
      const list = await api(`/trials?${new URLSearchParams(f)}`);
      const phase = p => p === 'NA' ? '' : p.replace('EARLY_PHASE', 'Early phase ').replace('PHASE', 'Phase ');
      box.innerHTML = list.length ? `<p class="pp-body-s pp-muted">${plural(list.length, 'recruiting study').replace('studys', 'studies')} found. Talk with your doctor before joining any study.</p>
        <div class="trial-grid">${list.map(t => `<article class="pp-card pp-card--pad-md stack" style="gap:10px">
          <div class="row" style="gap:6px">${badge('Recruiting', { tone: 'taken', dot: true })}${t.phases.map(phase).filter(Boolean).map(p => badge(esc(p))).join('')}</div>
          <h3 class="pp-h4">${esc(t.title)}</h3><p class="pp-caption">${esc(t.conditions.join(', '))}</p><p class="pp-body-s">${esc(t.summary)}</p>
          ${t.locations.length ? `<p class="pp-caption row" style="gap:6px;flex-wrap:nowrap">${icon('map-pin', { size: 14 })}<span>${esc(t.locations.join(' · '))}${t.locationCount > 3 ? ` +${t.locationCount - 3} more` : ''}</span></p>` : ''}
          ${t.sponsor ? `<p class="pp-caption">Sponsor: ${esc(t.sponsor)}</p>` : ''}
          <div style="margin-top:auto">${btn(`View ${esc(t.id)}`, { variant: 'secondary', size: 'sm', right: 'external-link', a: { href: `https://clinicaltrials.gov/study/${encodeURIComponent(t.id)}`, target: '_blank', rel: 'noopener' } })}</div></article>`).join('')}</div>`
        : `<div class="pp-card pp-card--pad-lg row" style="gap:16px;flex-wrap:nowrap">${pip('sleepy', 64)}<p class="pp-body">No recruiting studies matched. Try a broader condition or remove the location.</p></div>`;
      announce(`${list.length} studies found`);
    } catch (x) { if (x.status === 401) return renderAuth(); box.innerHTML = `<div class="pp-card pp-card--pad-lg row" style="gap:16px;flex-wrap:nowrap">${pip('sleepy', 64)}<p class="pp-body">${esc(x.message)}</p></div>`; }
  };
  $('#trialForm').onsubmit = e => { e.preventDefault(); run(); };
  if (intr || reasons[0]) run();
};

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
        <div style="padding-top:16px">${select({ label: 'Appearance', ic: 'sun-moon', value: p.theme || 'system', options: [{ value: 'system', label: 'Match my device' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], a: { id: 'theme' } })}</div>
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
      <section class="pp-card pp-card--pad-md stack" style="gap:14px"><h2 class="pp-h4">Account</h2>
        <div class="row" style="gap:12px;flex-wrap:nowrap"><span class="avatar avatar--static">${initial()}</span><div style="min-width:0"><div style="font-weight:700;color:var(--text-strong)">${esc(S.user.name)}</div><div class="pp-caption">${esc(S.user.email)}</div></div></div>
        <p class="pp-caption">Your data stays in your PillPal account. Nothing is shared unless you print or copy your report.</p>
        <div>${btn('Sign out', { variant: 'secondary', left: 'log-out', a: { 'data-action': 'logout' } })}</div>
      </section>
    </div>
  </div>`;
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
    actions: test ? '' : btn('Take', { size: 'sm', left: 'check', a: { 'data-action': 'toastDose', 'data-med': m._id, 'data-time': time } })
      + btn('Snooze 10 min', { variant: 'secondary', size: 'sm', a: { 'data-action': 'snooze', 'data-med': m._id, 'data-time': time } }) });
}
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
    if (route() !== 'today') updateBadge();
  };
  S.timer = setInterval(tick, 15000);
  tick();
}

// ---------- More sheet (phones) ----------
function openMore() {
  const items = [['chat', 'Ask Pip', 'messages-square'], ['report', 'Doctor report', 'file-text'], ['trials', 'Trials & help', 'flask-conical'], ['settings', 'Settings', 'settings']].filter(n => aiOn() || n[0] !== 'chat');
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
    const status = b.dataset.status || null, m = S.meds.find(x => x._id === b.dataset.med);
    await api('/doses', { method: 'POST', body: { medId: b.dataset.med, date: today(), time: b.dataset.time, status } });
    if (status === 'taken') chime();
    announce(status ? `${m.name} marked ${status}` : `${m.name} reset`);
    await render();
    $(`[data-med="${b.dataset.med}"][data-time="${b.dataset.time}"]`)?.focus();
    if (!status) return;
    const items = todayItems();
    if (items.every(i => i.status === 'taken' || i.status === 'skipped')) toast({ tone: 'taken', title: 'Everything logged for today', message: `Nice. That’s ${$('#sideStreak')?.textContent || 'another day'} in a row.` });
    else if (status === 'taken') toast({ tone: 'taken', title: `${m.name} logged`, message: `Taken at ${fmtTime(nowHM())}.` });
  },
  async toastDose(b) {
    b.closest('.pp-toast')?.remove();
    await api('/doses', { method: 'POST', body: { medId: b.dataset.med, date: today(), time: b.dataset.time, status: 'taken' } });
    chime();
    if (route() === 'today') render(); else updateBadge();
  },
  snooze(b) {
    b.closest('.pp-toast')?.remove();
    const m = S.meds.find(x => x._id === b.dataset.med), at = new Date(Date.now() + 10 * 60e3).toTimeString().slice(0, 5);
    setTimeout(() => S.user && remind(m, b.dataset.time), 10 * 60e3);
    toast({ title: 'Snoozed for 10 minutes', message: `I’ll remind you again at ${fmtTime(at)}.` });
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
        toast({ title: `${m.name} removed`, message: 'Its history stays in your doctor report.' });
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
  theme() { S.user.prefs = { ...S.user.prefs, theme: darkNow() ? 'light' : 'dark' }; savePrefs(); if (route() === 'settings') { const t = $('#theme'); if (t) t.value = S.user.prefs.theme; } },
  more: () => openMore(),
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
