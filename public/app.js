// PillPal front end. No framework: hash routes render template strings; every dynamic value goes through esc().
const S = { user: null, meds: [], doses: [], period: 30, notified: new Set(), stream: null, busy: false, prefill: null, install: null };
const app = document.getElementById('app');
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const today = () => new Date().toLocaleDateString('en-CA');
const nowHM = () => new Date().toTimeString().slice(0, 5);
const fmtTime = t => new Date(`2000-01-01T${t}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDate = (d, o = { weekday: 'short', month: 'short', day: 'numeric' }) => new Date(d + 'T12:00').toLocaleDateString([], o);
const title = s => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: r.status });
  return data;
}
const announce = msg => { const l = $('#live'); l.textContent = ''; setTimeout(() => (l.textContent = msg), 50); };

// ---------- icons & mascot ----------
const P = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  pill: '<rect x="2.5" y="8" width="19" height="8" rx="4" transform="rotate(-45 12 12)"/><path d="M8.5 8.5l7 7"/>',
  camera: '<path d="M4 7h3l2-3h6l2 3h3v13H4z"/><circle cx="12" cy="13" r="4"/>',
  heart: '<path d="M12 20s-7-4.5-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.5-9 9-9 9z"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/><path d="M7.5 15h9"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  check: '<path d="M5 12l5 5L20 7"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5v.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  print: '<path d="M6 9V3h12v6M6 18H4v-7h16v7h-2"/><path d="M7 14h10v7H7z"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V4h12"/>',
  flame: '<path d="M12 3c3 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-5 3-7 1 2 2 3 3 3 0-3 0-5 0-7z"/>',
  pin: '<path d="M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  phone: '<path d="M5 3h4l2 5-3 2a12 12 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z"/>',
  recycle: '<path d="M7 19H4l3-5M17 19h3l-3-5M9 5l3-3 3 3M12 2v8M7 14l5-4 5 4"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
  send: '<path d="M4 12l16-8-6 16-3-7z"/><path d="M11 13l9-9"/>',
  volume: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
};
const icon = n => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${P[n]}</svg>`;

// Pal: a two-tone capsule. Moods: happy, wave, cheer, concerned, focus.
function pal(mood = 'happy', size = 120) {
  const ink = 'var(--mascot-ink)';
  const arms = {
    cheer: '<path d="M34 114L12 82"/><path d="M126 114L148 82"/>',
    wave: '<path d="M34 120L16 144"/><g class="wave"><path d="M126 118L150 92"/></g>',
  }[mood] || '<path d="M34 120L16 144"/><path d="M126 120L144 144"/>';
  const eyes = mood === 'cheer'
    ? `<path d="M53 95q9-11 18 0M89 95q9-11 18 0" stroke="${ink}" stroke-width="5" fill="none" stroke-linecap="round"/>`
    : `<circle cx="62" cy="92" r="11" fill="#fff" stroke="${ink}" stroke-width="3"/><circle cx="98" cy="92" r="11" fill="#fff" stroke="${ink}" stroke-width="3"/>
       <circle cx="${mood === 'focus' ? 62 : 64}" cy="93" r="${mood === 'focus' ? 6.5 : 5}" fill="${ink}"/><circle cx="${mood === 'focus' ? 98 : 100}" cy="93" r="${mood === 'focus' ? 6.5 : 5}" fill="${ink}"/>
       <circle cx="66" cy="89" r="1.8" fill="#fff"/><circle cx="102" cy="89" r="1.8" fill="#fff"/>`;
  const mouth = {
    cheer: `<path d="M67 119q13 20 26 0z" fill="${ink}"/>`,
    concerned: `<path d="M71 129q9-6 18 0" stroke="${ink}" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    focus: `<ellipse cx="80" cy="125" rx="4.5" ry="5" fill="${ink}"/>`,
  }[mood] || `<path d="M70 121q10 10 20 0" stroke="${ink}" stroke-width="5" fill="none" stroke-linecap="round"/>`;
  const brows = mood === 'concerned' ? `<path d="M52 76l14 4M108 76l-14 4" stroke="${ink}" stroke-width="4" stroke-linecap="round"/>` : '';
  return `<svg class="pal ${mood}" width="${size}" height="${Math.round(size * 1.375)}" viewBox="0 0 160 220" aria-hidden="true">
    <ellipse cx="80" cy="212" rx="38" ry="6" fill="${ink}" opacity=".12"/>
    <g class="body">
      <g stroke="${ink}" stroke-width="6" stroke-linecap="round" fill="none">${arms}<path d="M64 194v12M96 194v12"/></g>
      <path d="M32 110V68a48 48 0 0 1 96 0v42z" fill="var(--coral)"/>
      <path d="M32 110v42a48 48 0 0 0 96 0v-42z" fill="var(--cream)"/>
      <path d="M32 110h96" stroke="${ink}" stroke-width="4"/>
      <rect x="32" y="20" width="96" height="180" rx="48" fill="none" stroke="${ink}" stroke-width="5"/>
      <rect x="46" y="36" width="10" height="38" rx="5" fill="#fff" opacity=".6"/>
      <g class="eyes">${eyes}</g>${brows}
      <ellipse cx="50" cy="119" rx="7" ry="4.5" fill="var(--coral)" opacity=".5"/><ellipse cx="110" cy="119" rx="7" ry="4.5" fill="var(--coral)" opacity=".5"/>
      ${mouth}
    </g></svg>`;
}

const MOODS = ['Awful', 'Not great', 'Okay', 'Good', 'Great'];
function face(n) {
  const mouth = ['M15 31q9-8 18 0', 'M16 30q8-4 16 0', 'M16 29h16', 'M16 27q8 5 16 0', 'M15 26q9 9 18 0'][n - 1];
  const c = ['var(--danger)', 'var(--warn)', 'var(--ink-2)', 'var(--brand)', 'var(--ok)'][n - 1];
  return `<svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true"><circle cx="24" cy="24" r="21" fill="none" stroke="${c}" stroke-width="3"/><circle cx="17" cy="19" r="2.6" fill="${c}"/><circle cx="31" cy="19" r="2.6" fill="${c}"/><path d="${mouth}" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"/></svg>`;
}
const COLORS = [['#13A89E', 'Teal'], ['#FF7A59', 'Coral'], ['#FFC94D', 'Sunny yellow'], ['#8B7CF6', 'Violet'], ['#3B82F6', 'Blue'], ['#F472B6', 'Rose']];
const EFFECTS = ['Nausea', 'Headache', 'Dizziness', 'Fatigue', 'Upset stomach', 'Rash or itching', 'Trouble sleeping', 'Dry mouth', 'Anxiety', 'Muscle pain', 'Low appetite', 'Other'];

// ---------- feedback: toasts, sound, confetti ----------
function toast(html, { mood = 'happy', reminder = false, sticky = false } = {}) {
  const t = document.createElement('div');
  t.className = 'toast' + (reminder ? ' reminder' : '');
  t.setAttribute('role', reminder ? 'alert' : 'status');
  t.innerHTML = `${pal(mood, 44)}<div>${html}</div>`;
  $('#toasts').append(t);
  if (!sticky) setTimeout(() => t.remove(), 5000);
  return t;
}
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
function confetti() {
  if (S.user?.prefs?.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('div');
  c.className = 'confetti';
  const cols = ['#0B7A75', '#FF7A59', '#FFC94D', '#13A89E', '#8B7CF6'];
  c.innerHTML = Array.from({ length: 48 }, () => `<i style="left:${Math.random() * 100}%;background:${cols[Math.random() * 5 | 0]};--dx:${(Math.random() - 0.5) * 240}px;--r:${Math.random() * 720}deg;animation-delay:${Math.random() * 0.3}s"></i>`).join('');
  document.body.append(c);
  setTimeout(() => c.remove(), 2200);
}

// ---------- auth ----------
function renderAuth(mode = 'login', err = '') {
  stopCamera();
  app.removeAttribute('aria-busy');
  const signup = mode === 'signup';
  app.innerHTML = `<div class="auth">
    <section class="auth-hero">
      ${pal('wave', 110)}
      <h1>Your pills, remembered.</h1>
      <p>PillPal reminds you on time, scans your bottles, and turns daily check-ins into a one-page summary your doctor can read in a minute.</p>
      <ul>
        <li>${icon('bell')} Gentle reminders, read out loud if you like</li>
        <li>${icon('camera')} Scan a bottle, get the FDA label facts</li>
        <li>${icon('file')} Doctor-ready reports you can print or share</li>
        <li>${icon('flask')} Find clinical trials that are recruiting near you</li>
      </ul>
    </section>
    <main class="auth-main" id="main">
      <div class="auth-card">
        <div class="tabs" role="tablist" aria-label="Account">
          <button role="tab" aria-selected="${!signup}" data-mode="login">Sign in</button>
          <button role="tab" aria-selected="${signup}" data-mode="signup">Create account</button>
        </div>
        <form id="authForm" class="stack" novalidate>
          <h2>${signup ? 'Nice to meet you!' : 'Welcome back'}</h2>
          ${signup ? '<div><label for="aName">Your first name</label><input id="aName" name="name" type="text" autocomplete="given-name" required></div>' : ''}
          <div><label for="aEmail">Email</label><input id="aEmail" name="email" type="email" autocomplete="email" required></div>
          <div><label for="aPass">Password ${signup ? '<span class="hint">(8 or more characters)</span>' : ''}</label>
            <input id="aPass" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="8" required></div>
          <label class="row" style="font-weight:400"><input type="checkbox" id="aShow"> Show password</label>
          <div class="error" role="alert" ${err ? '' : 'hidden'}>${esc(err)}</div>
          <button class="btn primary" type="submit">${signup ? 'Create my account' : 'Sign in'}</button>
        </form>
        <p class="fine" style="margin-top:1.5rem">PillPal supports your care team. It doesn't replace them. In an emergency, call 911.</p>
      </div>
    </main></div>`;
  app.querySelectorAll('[data-mode]').forEach(b => (b.onclick = () => renderAuth(b.dataset.mode)));
  $('#aShow').onchange = e => ($('#aPass').type = e.target.checked ? 'text' : 'password');
  $('#authForm').onsubmit = async e => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    try {
      S.user = await api(signup ? '/signup' : '/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      await enter();
      if (signup) toast(`<b>Hi ${esc(S.user.name)}, I'm Pal!</b><p class="muted">Let's add your first medication.</p>`, { mood: 'wave' });
    } catch (x) { renderAuth(mode, x.message); }
  };
  $('#authForm input').focus();
}

// ---------- shell & routing ----------
const NAV = [['today', 'Today', 'home'], ['meds', 'My meds', 'pill'], ['scan', 'Scan bottle', 'camera'], ['checkin', 'Check-in', 'heart'],
  ['report', 'Doctor report', 'file'], ['trials', 'Trials & help', 'flask'], ['settings', 'Settings', 'sliders']];

function applyPrefs() {
  const p = S.user?.prefs || {}, r = document.documentElement;
  r.classList.toggle('large-text', !!p.largeText);
  r.classList.toggle('high-contrast', !!p.highContrast);
  r.classList.toggle('reduce-motion', !!p.reduceMotion);
  if (p.theme === 'light' || p.theme === 'dark') r.dataset.theme = p.theme; else delete r.dataset.theme;
}
const loadMeds = async () => (S.meds = await api('/meds'));

async function enter() {
  applyPrefs();
  await loadMeds();
  app.removeAttribute('aria-busy');
  app.innerHTML = `<div class="shell">
    <aside class="side">
      <a class="brand" href="#/today">${pal('happy', 34)}<span>PillPal</span></a>
      <nav aria-label="Main"><ul>${NAV.map(([id, label, ic]) => `<li><a class="nav" href="#/${id}" data-nav="${id}">${icon(ic)}<span>${label}</span>${id === 'today' ? '<span class="badge" id="dueBadge" hidden></span>' : ''}</a></li>`).join('')}</ul></nav>
      <div class="side-foot"><b>Not medical advice.</b> Always follow your prescription label and your care team.</div>
    </aside>
    <main id="main" tabindex="-1"></main></div>
    <button class="ask-fab no-print" id="askFab" data-action="chatOpen" ${aiOn() ? '' : 'hidden'}>${pal('happy', 30)}<span>Ask Pal</span></button>`;
  if (!location.hash) location.hash = '#/today'; else render(true);
  startReminders();
}

const PAGES = {};
async function render(focus = false) {
  const [page, qs] = location.hash.slice(2).split('?');
  const id = PAGES[page] ? page : 'today';
  if (id !== 'scan') stopCamera();
  document.querySelectorAll('[data-nav]').forEach(a => a.dataset.nav === id ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  document.title = `${NAV.find(n => n[0] === id)[1]} · PillPal`;
  const main = $('#main');
  try {
    await PAGES[id](new URLSearchParams(qs));
  } catch (e) {
    if (e.status === 401) return renderAuth();
    main.innerHTML = `<div class="card empty">${pal('concerned', 80)}<h2>That didn't load</h2><p>${esc(e.message)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`;
  }
  if (focus) $('#main h1')?.focus();
}
addEventListener('hashchange', () => S.user && render(true));

const head = (h, sub, actions = '') => `<header class="page-head"><div><h1 tabindex="-1">${h}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${actions ? `<div class="row no-print">${actions}</div>` : ''}</header>`;

// ---------- Today ----------
function todayItems() {
  const st = new Map(S.doses.map(d => [`${d.medId}|${d.time}`, d.status]));
  return S.meds.flatMap(m => m.times.map(time => ({ m, time, status: st.get(`${m._id}|${time}`) })))
    .sort((a, b) => a.time.localeCompare(b.time) || a.m.name.localeCompare(b.m.name));
}
function updateBadge(items = todayItems()) {
  const n = items.filter(i => !i.status && i.time <= nowHM()).length, b = $('#dueBadge');
  if (b) { b.hidden = !n; b.textContent = n; b.setAttribute('aria-label', `${n} due`); }
}
function doseRow({ m, time, status }) {
  const due = !status && time <= nowHM(), when = fmtTime(time);
  const data = `data-med="${m._id}" data-time="${time}"`;
  const meta = [m.dose, m.instructions].filter(Boolean).join(' · ');
  return `<div class="dose ${status || ''} ${due ? 'due' : ''}">
    <div class="pill-dot" style="--c:${esc(m.color)}"></div>
    <div><b>${esc(m.name)}</b>${m.trialId ? ` <span class="tag trial">${icon('flask')} ${esc(m.trialId)}</span>` : ''}${meta ? `<div class="meta">${esc(meta)}</div>` : ''}</div>
    <div class="row">${status
      ? `<span class="status-done">${icon(status === 'taken' ? 'check' : 'x')} ${status === 'taken' ? 'Taken' : 'Skipped'}</span>
         <button class="btn sm ghost" data-action="dose" ${data} data-status="" aria-label="Undo ${esc(m.name)} at ${when}">Undo</button>`
      : `<button class="btn sm ghost" data-action="dose" ${data} data-status="skipped" aria-label="Skip ${esc(m.name)} at ${when}">Skip</button>
         <button class="btn sm primary" data-action="dose" ${data} data-status="taken" aria-label="Mark ${esc(m.name)} at ${when} as taken">${icon('check')} Taken</button>`}
    </div></div>`;
}

PAGES.today = async () => {
  const main = $('#main');
  const [doses, rep, checks] = await Promise.all([
    api(`/doses?date=${today()}`), api(`/report?days=14&today=${today()}&now=${nowHM()}`), api(`/checkins?days=1&today=${today()}`)]);
  S.doses = doses;
  const items = todayItems(), done = items.filter(i => i.status).length, taken = items.filter(i => i.status === 'taken').length;
  const due = items.filter(i => !i.status && i.time <= nowHM()), next = items.find(i => !i.status && i.time > nowHM());
  updateBadge(items);
  const h = new Date().getHours(), hi = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';

  let mood = 'happy', msg, sub = '';
  if (!S.meds.length) { mood = 'wave'; msg = "Hi, I'm Pal! Let's set up your first medication."; sub = 'Scan the bottle or type it in. It takes about 30 seconds.'; }
  else if (done === items.length) { mood = 'cheer'; msg = 'All done for today. Nice work!'; sub = `${plural(taken, 'dose')} taken. See you tomorrow.`; }
  else if (due.length) { mood = 'concerned'; msg = `${plural(due.length, 'dose')} waiting for you`; sub = `Since ${fmtTime(due[0].time)}. Tap “Taken” once you've had it.`; }
  else { msg = `Next up: ${next.m.name} at ${fmtTime(next.time)}`; sub = "I'll remind you when it's time."; }

  const pct = items.length ? done / items.length : 0, C = 2 * Math.PI * 52;
  const slots = [...new Set(items.map(i => i.time))];
  const daily = rep.daily;
  const dotCls = d => !d.scheduled ? '' : d.taken === d.scheduled ? 'full' : d.taken ? 'part' : d.date === today() ? '' : 'miss';

  main.innerHTML = `${head(`${hi}, ${esc(S.user.name)}`, fmtDate(today(), { weekday: 'long', month: 'long', day: 'numeric' }),
    `<a class="btn" href="#/scan">${icon('camera')} Scan a bottle</a><button class="btn primary" data-action="addMed">${icon('plus')} Add medication</button>`)}
  <div class="grid-today">
    <div class="col">
      <section class="card hero" aria-label="Today's summary">
        ${pal(mood, 96)}
        <div class="bubble" role="status">${esc(msg)}<small>${esc(sub)}</small></div>
        ${items.length ? `<div class="ring" role="img" aria-label="${done} of ${items.length} doses logged today">
          <svg viewBox="0 0 132 132"><circle class="track" cx="66" cy="66" r="52"/><circle class="bar" cx="66" cy="66" r="52" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"/></svg>
          <div class="lbl"><b>${done}/${items.length}</b><span>logged</span></div></div>` : ''}
      </section>
      <section class="card" aria-labelledby="schedH">
        <h2 id="schedH">Today's schedule</h2>
        ${items.length ? slots.map(t => {
          const its = items.filter(i => i.time === t), late = its.some(i => !i.status) && t <= nowHM();
          return `<div class="slot"><div class="slot-time">${icon('bell')} ${fmtTime(t)} ${late ? '<span class="tag bad">Due now</span>' : ''}</div>${its.map(doseRow).join('')}</div>`;
        }).join('') : `<div class="empty">${pal('wave', 64)}<p>No medications yet.</p><div class="row"><a class="btn" href="#/scan">${icon('camera')} Scan a bottle</a><button class="btn primary" data-action="addMed">${icon('plus')} Add by hand</button></div></div>`}
      </section>
    </div>
    <div class="col">
      <section class="card" aria-labelledby="streakH">
        <div class="streak"><div class="flame">${icon('flame')}</div><div><b>${rep.streak}</b> <span class="muted">day streak</span><h2 id="streakH" class="sr-only">Streak</h2>
          <p class="fine">${rep.adherence == null ? 'Your streak starts with your first dose.' : `${rep.adherence}% of doses taken in the last 2 weeks`}</p></div></div>
        <div class="dots" role="img" aria-label="Last 14 days: ${daily.filter(d => dotCls(d) === 'full').length} complete days">${daily.map(d => `<span class="${dotCls(d)}" title="${fmtDate(d.date)}: ${d.taken}/${d.scheduled}"></span>`).join('')}</div>
        <div class="legend" aria-hidden="true"><span><i style="background:var(--brand)"></i>All taken</span><span><i style="background:var(--sun)"></i>Some</span><span><i style="background:var(--coral)"></i>Missed</span></div>
      </section>
      <section class="card" aria-labelledby="ciH">
        <h2 id="ciH">How are you feeling?</h2>
        ${checks.length ? `<p class="row">${face(checks[0].mood)} <span>You felt <b>${MOODS[checks[0].mood - 1].toLowerCase()}</b> today. <a href="#/checkin">Update check-in</a></span></p>`
          : `<p class="muted" style="margin-bottom:.8rem">A 20-second check-in helps your doctor spot patterns.</p>
             <div class="faces">${[1, 2, 3, 4, 5].map(n => `<a class="face" href="#/checkin?m=${n}">${face(n)}${MOODS[n - 1]}</a>`).join('')}</div>`}
      </section>
      <section class="card">
        <h2>Ready for your next visit?</h2>
        <p class="muted" style="margin-bottom:1rem">Your doctor report updates itself as you log doses and check in.</p>
        <a class="btn" href="#/report">${icon('file')} Open doctor report</a>
      </section>
    </div>
  </div>`;
};

// ---------- Meds ----------
PAGES.meds = async q => {
  await loadMeds();
  $('#main').innerHTML = `${head('My medications', 'Everything PillPal reminds you about.',
    `<a class="btn" href="#/scan">${icon('camera')} Scan a bottle</a><button class="btn primary" data-action="addMed">${icon('plus')} Add medication</button>`)}
  ${S.meds.length ? `<div class="med-grid">${S.meds.map(m => `<article class="card med" style="--c:${esc(m.color)}">
      <div class="med-head"><div class="pill-dot" style="--c:${esc(m.color)}"></div><div><h3>${esc(m.name)}</h3><p class="muted">${esc([m.dose, m.reason && 'for ' + m.reason].filter(Boolean).join(' · ') || 'No dose added')}</p></div></div>
      <div class="times">${m.times.map(t => `<span class="tag">${icon('bell')} ${fmtTime(t)}</span>`).join('')}</div>
      ${m.instructions ? `<p class="fine">${esc(m.instructions)}</p>` : ''}
      ${m.trialId ? `<p><span class="tag trial">${icon('flask')} Study medication · ${esc(m.trialId)}</span></p>` : ''}
      <div class="row">${aiOn() ? `<button class="btn sm" data-action="askMed" data-id="${m._id}">${icon('chat')} Ask Pal</button>` : ''}<button class="btn sm" data-action="editMed" data-id="${m._id}">Edit</button><button class="btn sm ghost danger" data-action="delMed" data-id="${m._id}">Stop tracking</button></div>
    </article>`).join('')}</div>`
    : `<div class="card empty">${pal('wave', 90)}<h2>Let's add your first medication</h2><p>Scan the bottle with your camera, or type the name.</p>
       <div class="row"><a class="btn" href="#/scan">${icon('camera')} Scan a bottle</a><button class="btn primary" data-action="addMed">${icon('plus')} Add by hand</button></div></div>`}`;
  if (q.get('add')) { history.replaceState(null, '', '#/meds'); medDialog(S.prefill || {}); S.prefill = null; }
};

const timeRow = t => `<div class="time-row"><input type="time" name="times" value="${esc(t)}" aria-label="Reminder time" required>
  <button type="button" class="btn icon ghost" data-rm aria-label="Remove this time">${icon('trash')}</button></div>`;

function medDialog(m = {}) {
  const d = document.createElement('dialog');
  d.setAttribute('aria-labelledby', 'mdTitle');
  const color = m.color || COLORS[S.meds.length % COLORS.length][0];
  d.innerHTML = `<form novalidate>
    <div class="row" style="justify-content:space-between"><h2 id="mdTitle">${m._id ? 'Edit' : 'Add'} medication</h2>
      <button type="button" class="btn icon ghost" data-close aria-label="Close">${icon('x')}</button></div>
    <div><label for="mName">Medication name</label>
      <div class="row" style="flex-wrap:nowrap"><input id="mName" name="name" type="text" required autocomplete="off" value="${esc(m.name)}" placeholder="e.g. Lipitor or atorvastatin">
      <button type="button" class="btn" id="mLookup">${icon('search')} Look up</button></div>
      <div id="mInfo" class="lookup" hidden aria-live="polite" style="margin-top:.5rem"></div></div>
    <div class="row" style="align-items:start">
      <div style="flex:1;min-width:150px"><label for="mDose">Dose</label><input id="mDose" name="dose" type="text" value="${esc(m.dose)}" placeholder="10 mg, 1 tablet"></div>
      <div style="flex:1;min-width:150px"><label for="mReason">What it's for <span class="hint">(optional)</span></label><input id="mReason" name="reason" type="text" value="${esc(m.reason)}" placeholder="Cholesterol"></div>
    </div>
    <div><label for="mInstr">Instructions <span class="hint">(optional)</span></label><input id="mInstr" name="instructions" type="text" value="${esc(m.instructions)}" placeholder="Take with food"></div>
    <fieldset><legend>Reminder times</legend><div id="mTimes" class="stack" style="gap:8px">${(m.times?.length ? m.times : ['08:00']).map(timeRow).join('')}</div>
      <button type="button" class="btn sm ghost" id="mAddTime" style="margin-top:8px">${icon('plus')} Add another time</button></fieldset>
    <fieldset><legend>Pill color <span class="hint">so you can spot it fast</span></legend><div class="swatches">${COLORS.map(([c, n]) =>
      `<label class="swatch"><input type="radio" name="color" value="${c}" ${color === c ? 'checked' : ''}><span style="--c:${c}"></span><span class="sr-only">${n}</span></label>`).join('')}</div></fieldset>
    <div><label for="mTrial">Clinical trial ID <span class="hint">(only if this is a study medication)</span></label><input id="mTrial" name="trialId" type="text" value="${esc(m.trialId)}" placeholder="NCT12345678"></div>
    <div id="mErr" class="error" role="alert" hidden></div>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">${icon('check')} Save</button></div>
  </form>`;
  const form = $('form', d);
  d.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) d.close();
    const rm = e.target.closest('[data-rm]');
    if (rm && $('#mTimes', d).children.length > 1) rm.parentElement.remove();
  });
  $('#mAddTime', d).onclick = () => { $('#mTimes', d).insertAdjacentHTML('beforeend', timeRow('20:00')); $('#mTimes', d).lastElementChild.querySelector('input').focus(); };
  $('#mLookup', d).onclick = async () => {
    const box = $('#mInfo', d), q = $('#mName', d).value.trim();
    if (!q) return $('#mName', d).focus();
    box.hidden = false; box.textContent = 'Checking the FDA database…';
    try {
      const { info } = await api(`/drug?q=${encodeURIComponent(q)}`);
      box.innerHTML = info ? `<b>${esc(title(info.brand || info.generic))}</b> ${info.generic ? `(${esc(info.generic.toLowerCase())})` : ''}<br>${esc(info.uses || 'No usage summary on the label.')}
        ${info.boxedWarning ? `<p class="boxed" style="margin-top:.5rem"><b>${icon('alert')} Boxed warning</b>${esc(info.boxedWarning)}</p>` : ''}`
        : "I couldn't find that name. Check the spelling, or keep it as typed.";
    } catch (x) { box.textContent = x.message; }
  };
  form.onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(form);
    const body = { ...Object.fromEntries(['name', 'dose', 'reason', 'instructions', 'color', 'trialId'].map(k => [k, f.get(k) || ''])), times: f.getAll('times').filter(Boolean), today: today() };
    try {
      await (m._id ? api(`/meds/${m._id}`, { method: 'PUT', body }) : api('/meds', { method: 'POST', body }));
      d.close();
      await loadMeds();
      await render();
      chime();
      toast(`<b>${esc(body.name)} saved</b><p class="muted">I'll remind you at ${body.times.map(fmtTime).join(', ')}.</p>`, { mood: 'cheer' });
    } catch (x) { const el = $('#mErr', d); el.hidden = false; el.textContent = x.message; }
  };
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
}

// ---------- Scan ----------
let worker;
const loadScript = src => new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => fail(new Error('Could not load the label reader. Check your connection.')); document.head.append(s); });
const setStatus = (t, busy) => { const s = $('#scanStatus'); if (s) s.innerHTML = `<span class="pulse"></span>${esc(t)}`; $('#scanner')?.classList.toggle('busy', !!busy); };
function stopCamera() { S.stream?.getTracks().forEach(t => t.stop()); S.stream = null; }

PAGES.scan = async () => {
  $('#main').innerHTML = `${head('Scan a pill bottle', 'Hold the label up to your camera. Pal reads it and checks the FDA label for you.')}
  <div class="scan-wrap">
    <div class="scanner" id="scanner">
      <video id="cam" playsinline muted aria-label="Camera preview"></video>
      <div class="scan-overlay" aria-hidden="true"><div class="reticle"><span class="c tl"></span><span class="c tr"></span><span class="c bl"></span><span class="c br"></span><div class="scanline"></div></div></div>
      <div class="cam-off" id="camOff" hidden>${pal('concerned', 80)}<h2>Camera is off</h2><p id="camMsg"></p><button class="btn primary" data-action="camOn">${icon('camera')} Try camera again</button></div>
      <div class="scan-status" id="scanStatus" role="status"><span class="pulse"></span>Starting camera…</div>
      <div class="scan-controls"><button class="shutter" id="shutter" data-action="capture" aria-label="Scan the label now"><span>${icon('search')}</span></button></div>
      <section class="scan-result" id="scanResult" hidden aria-labelledby="srH" tabindex="-1"></section>
    </div>
    <form class="card row" id="manual" style="align-items:end">
      <div style="flex:1;min-width:220px"><label for="manualQ">No camera? Type the name on the label</label><input id="manualQ" type="search" placeholder="e.g. metformin" autocomplete="off"></div>
      <button class="btn primary" type="submit">${icon('search')} Look it up</button>
    </form>
    <p class="fine">Tips: good light, fill the frame with the label, hold still for a second. Information comes from FDA drug labels (openFDA). Always follow your own prescription label and pharmacist.</p>
  </div>`;
  $('#manual').onsubmit = async e => {
    e.preventDefault();
    const q = $('#manualQ').value.trim();
    if (!q) return;
    setStatus('Looking it up…', true);
    try { showResult(await api(`/drug?q=${encodeURIComponent(q)}`), q); } catch (x) { setStatus(x.message); }
  };
  startCamera();
};

async function startCamera() {
  try {
    stopCamera();
    S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    if (!$('#cam')) return stopCamera(); // navigated away while the permission prompt was open
    $('#cam').srcObject = S.stream;
    await $('#cam').play();
    $('#camOff').hidden = true;
    setStatus('Fit the label inside the frame, then press scan');
  } catch (e) {
    if (!$('#camOff')) return;
    $('#camOff').hidden = false;
    $('#camMsg').textContent = e.name === 'NotAllowedError'
      ? "Camera access is blocked. Allow it from the camera icon in your browser's address bar, or type the name below."
      : 'No camera found. You can type the medication name below instead.';
    setStatus('Camera off');
  }
}

async function capture() {
  const v = $('#cam');
  if (!S.stream || S.busy || !v.videoWidth) return;
  S.busy = true;
  $('#scanResult').hidden = true;
  setStatus('Hold still…', true);
  try {
    const w = v.videoWidth, h = v.videoHeight;
    if (aiOn()) {
      const f = document.createElement('canvas'), z = Math.min(1, 1280 / w);
      f.width = w * z; f.height = h * z;
      f.getContext('2d').drawImage(v, 0, 0, f.width, f.height);
      setStatus('Pal is reading the label…', true);
      try { return showResult(await api('/ai/scan', { method: 'POST', body: { image: f.toDataURL('image/jpeg', 0.85) } })); }
      catch (x) { if (x.status === 401) throw x; setStatus('Pal is busy, using the basic reader…', true); }
    }
    // Basic reader: crop to the reticle (70% x 56% of the frame), grayscale + contrast for OCR.
    const cw = w * 0.7, ch = h * 0.56, k = Math.max(1, 1400 / cw);
    const c = document.createElement('canvas');
    c.width = cw * k; c.height = ch * k;
    const ctx = c.getContext('2d');
    ctx.filter = 'grayscale(1) contrast(1.5)';
    ctx.drawImage(v, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, c.width, c.height);
    setStatus('Loading the label reader…', true);
    if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
    worker ||= await Tesseract.createWorker('eng', 1, {
      logger: m => m.status === 'recognizing text' && setStatus(`Reading label… ${Math.round(m.progress * 100)}%`, true),
    });
    const { data: { text } } = await worker.recognize(c);
    if (!/[a-z]{4}/i.test(text)) return showResult({ info: null });
    setStatus('Checking the FDA database…', true);
    showResult(await api('/drug/scan', { method: 'POST', body: { text: text.slice(0, 5000) } }));
  } catch (x) {
    setStatus(x.message);
  } finally { S.busy = false; }
}

function showResult({ info, strength, candidates = [], label }, typed) {
  const box = $('#scanResult');
  box.hidden = false;
  const read = label?.found ? label : null;
  if (!info && !read) {
    setStatus("Couldn't match that label");
    box.innerHTML = `<div class="row" style="justify-content:space-between">${pal('concerned', 54)}<button class="btn icon ghost" data-action="closeResult" aria-label="Close">${icon('x')}</button></div>
      <h2 id="srH">Hmm, I couldn't read that one</h2>
      <p>${typed ? `No FDA label matched “${esc(typed)}”. Check the spelling?` : 'Try brighter light, move closer so the label fills the frame, and hold still.'}</p>
      ${candidates.length ? `<p class="fine">I saw: ${candidates.slice(0, 6).map(esc).join(', ')}</p>` : ''}
      <div class="row"><button class="btn primary" data-action="closeResult">Scan again</button><button class="btn" data-action="addMed">Add by hand</button></div>`;
  } else {
    const name = info ? title(info.brand || info.generic) : title(read.drugName || read.genericName);
    const generic = info?.generic || read?.genericName || name;
    setStatus(`Found ${name}`);
    chime();
    S.prefill = { name, dose: strength || '', reason: '', instructions: read?.directions || '' };
    const facts = read ? [read.quantity && `Qty ${read.quantity}`, read.refills && `Refills: ${read.refills}`, read.pharmacy].filter(Boolean) : [];
    box.innerHTML = `<div class="row" style="justify-content:space-between"><span class="tag ok">${icon(read ? 'sparkle' : 'check')} ${read ? 'Read by Pal' : 'Matched ' + esc(info.matched || typed || '')}</span>
        <button class="btn icon ghost" data-action="closeResult" aria-label="Close">${icon('x')}</button></div>
      <div class="row" style="flex-wrap:nowrap">${pal('cheer', 50)}<div><h2 id="srH">${esc(name)}</h2>
        <p class="muted">${esc([generic !== name ? title(generic) : '', info?.route && title(info.route), strength].filter(Boolean).join(' · '))}</p></div></div>
      ${read?.directions ? `<section class="ai-card"><h3>Your label says</h3><p><b>${esc(read.directions)}</b></p>${facts.length ? `<p class="fine">${esc(facts.join(' · '))}</p>` : ''}
        ${read.warnings.length ? `<div class="chips" style="margin-top:.5rem">${read.warnings.map(w => `<span class="tag trial">${icon('alert')} ${esc(w)}</span>`).join('')}</div>` : ''}</section>` : ''}
      ${info?.boxedWarning ? `<div class="boxed"><b>${icon('alert')} Boxed warning</b><p>${esc(info.boxedWarning)}</p></div>` : ''}
      ${info?.uses ? `<section><h3>Used for</h3><p>${esc(info.uses)}</p></section>` : ''}
      ${info?.sideEffects ? `<section><h3>Common side effects</h3><p>${esc(info.sideEffects)}</p></section>` : info?.warnings ? `<section><h3>Warnings</h3><p>${esc(info.warnings)}</p></section>` : ''}
      ${!info ? '<p class="fine">I read the label but could not find a matching FDA record. Double-check the name with your pharmacist.</p>' : ''}
      <div class="explain-box" id="explainScan"></div>
      <div class="row"><button class="btn primary" data-action="scanAdd">${icon('plus')} Add to my meds</button>
        ${aiOn() ? `<button class="btn" data-action="explain" data-name="${esc(generic)}" data-target="explainScan">${icon('sparkle')} Explain it simply</button>` : ''}
        <a class="btn" href="#/trials?intr=${encodeURIComponent(generic)}">${icon('flask')} Related trials</a></div>
      <p class="fine">${info ? `Summarized from the FDA label${info.manufacturer ? ` (${esc(info.manufacturer)})` : ''}. ` : ''}Your own prescription label and pharmacist come first.</p>`;
  }
  box.focus();
}

// ---------- Check-in ----------
PAGES.checkin = async q => {
  const list = await api(`/checkins?days=14&today=${today()}`);
  const t = list.find(c => c.date === today()) || {};
  const mood = +q.get('m') || t.mood;
  $('#main').innerHTML = `${head('Daily check-in', 'Twenty seconds a day gives your doctor the full picture.')}
  <div class="grid-today">
    <form class="card stack" id="ciForm" novalidate>
      <fieldset><legend>How are you feeling today?</legend><div class="faces">${[1, 2, 3, 4, 5].map(n =>
        `<label class="face"><input type="radio" name="mood" value="${n}" ${mood === n ? 'checked' : ''} required><span>${face(n)}${MOODS[n - 1]}</span></label>`).join('')}</div></fieldset>
      <fieldset><legend>Anything bothering you? <span class="hint">Pick all that apply</span></legend><div class="chips">${EFFECTS.map(e =>
        `<label class="chip-check"><input type="checkbox" name="sideEffects" value="${e}" ${t.sideEffects?.includes(e) ? 'checked' : ''}><span>${e}</span></label>`).join('')}</div></fieldset>
      <div><label for="ciNotes">Anything else you noticed? <span class="hint">(optional)</span></label><textarea id="ciNotes" name="notes" maxlength="1000" placeholder="Slept badly, felt dizzy after the evening dose…">${esc(t.notes)}</textarea></div>
      <div><label for="ciQ">Questions for your doctor <span class="hint">(optional, added to your report)</span></label><textarea id="ciQ" name="questions" maxlength="1000" placeholder="Can I take this with ibuprofen?">${esc(t.questions)}</textarea></div>
      <div id="ciErr" class="error" role="alert" hidden></div>
      <div class="row"><button class="btn primary" type="submit">${icon('check')} ${t.date ? 'Update' : 'Save'} check-in</button></div>
      <p class="fine">Chest pain, trouble breathing, swelling of the face or throat? Call 911 now. For a possible overdose, call Poison Help at 1-800-222-1222.</p>
    </form>
    <div class="col">
      <section class="card" id="insight" aria-live="polite">${t.date ? '' : `<div class="insight">${pal('happy', 70)}<p>Save today's check-in and I'll tell you what I'm noticing.</p></div>`}</section>
      <section class="card"><h2>Last two weeks</h2>${list.length ? `<div class="history">${list.map(c => `<div class="h"><b>${fmtDate(c.date)}</b>${face(c.mood)}<p class="fine">${esc(c.sideEffects?.join(', ') || 'No side effects')}</p></div>`).join('')}</div>` : '<p class="muted">Your check-ins will show up here.</p>'}</section>
    </div>
  </div>`;
  if (t.date) showInsight();
  $('#ciForm').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/checkins', { method: 'POST', body: { date: today(), mood: +f.get('mood'), sideEffects: f.getAll('sideEffects'), notes: f.get('notes'), questions: f.get('questions') } });
      chime();
      S.wantNote = true;
      await PAGES.checkin(new URLSearchParams());
      announce('Check-in saved');
    } catch (x) { const el = $('#ciErr'); el.hidden = false; el.textContent = x.message; }
  };
};

async function showInsight() {
  const r = await api(`/report?days=7&today=${today()}&now=${nowHM()}`);
  const tips = [];
  if (r.adherence != null) tips.push(r.adherence >= 90 ? `You took <b>${r.adherence}%</b> of your doses this week. That's excellent.` : `You took <b>${r.adherence}%</b> of your doses this week. Want me to add another reminder time?`);
  for (const f of r.flagged) tips.push(`You've noted <b>${esc(f.toLowerCase())}</b> on 3 or more days this week. It's flagged on your doctor report. If it gets worse, call your care team.`);
  if (r.moods.length >= 4) {
    const m = r.moods.map(x => x.mood), half = Math.floor(m.length / 2), avg = a => a.reduce((s, x) => s + x, 0) / a.length;
    const diff = avg(m.slice(half)) - avg(m.slice(0, half));
    if (Math.abs(diff) >= 0.5) tips.push(`Your mood is trending <b>${diff > 0 ? 'up' : 'down'}</b> this week.`);
  }
  if (r.notes[0]?.questions) tips.push('Your question is saved on your doctor report for your next visit.');
  if (!tips.length) tips.push('Thanks for checking in. Patterns show up after a few days of check-ins.');
  $('#insight').innerHTML = `<h2>Pal noticed</h2><div class="insight">${pal(r.flagged.length ? 'concerned' : 'cheer', 70)}<ul>${tips.map(t => `<li>${t}</li>`).join('')}</ul></div>
    ${aiOn() ? '<div class="ai-card" id="aiNote" style="margin-top:1rem" hidden></div>' : ''}`;
  const box = $('#aiNote'), cached = S.aiNote?.date === today() && S.aiNote.note;
  if (!box || (!cached && !S.wantNote)) return;
  S.wantNote = false;
  box.hidden = false;
  box.innerHTML = cached ? aiNoteHtml(cached) : thinking('Pal is writing you a note…');
  if (cached) return;
  try {
    const { note } = await api('/ai/insight', { method: 'POST', body: { today: today(), now: nowHM() } });
    S.aiNote = { date: today(), note };
    box.innerHTML = aiNoteHtml(note);
  } catch (x) { box.hidden = true; }
}

// ---------- Report ----------
function sparkline(moods) {
  if (moods.length < 2) return '<p class="muted">Check in on two or more days to see a mood trend.</p>';
  const W = 600, H = 90, pts = moods.map((m, i) => [i / (moods.length - 1) * (W - 20) + 10, H - 10 - (m.mood - 1) / 4 * (H - 20)]);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Mood from ${MOODS[moods[0].mood - 1]} to ${MOODS[moods.at(-1).mood - 1]} over ${moods.length} check-ins">
    <polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" stroke="var(--brand)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
    ${pts.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="4.5" fill="var(--surface)" stroke="var(--brand)" stroke-width="2.5"><title>${fmtDate(moods[i].date)}: ${MOODS[moods[i].mood - 1]}</title></circle>`).join('')}</svg>
    <div class="row fine" style="justify-content:space-between"><span>${fmtDate(moods[0].date)}</span><span>1 = awful, 5 = great</span><span>${fmtDate(moods.at(-1).date)}</span></div>`;
}
function reportText(r) {
  const L = [`PillPal medication summary`, `Patient: ${r.patient}`, `Period: ${r.from} to ${r.to} (${r.days} days)`,
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

PAGES.report = async () => {
  const r = await api(`/report?days=${S.period}&today=${today()}&now=${nowHM()}`);
  const trials = r.meds.filter(m => m.trialId);
  $('#main').innerHTML = `${head('Doctor report', 'A one-page summary to print, save as PDF, or paste into a patient portal message.',
    `<div class="seg" role="group" aria-label="Report period">${[7, 14, 30, 90].map(d => `<button data-action="period" data-days="${d}" aria-pressed="${S.period === d}">${d} days</button>`).join('')}</div>
     <button class="btn" data-action="copyReport">${icon('copy')} Copy text</button><button class="btn primary" data-action="print">${icon('print')} Print / PDF</button>`)}
  <article class="doc report" aria-labelledby="docH">
    <header class="doc-head"><div><h2 id="docH">Medication adherence summary</h2><p class="muted">Patient: <b>${esc(r.patient)}</b> · ${fmtDate(r.from, { month: 'short', day: 'numeric', year: 'numeric' })} to ${fmtDate(r.to, { month: 'short', day: 'numeric', year: 'numeric' })}</p></div>
      <p class="fine">Generated ${new Date(r.generatedAt).toLocaleString()}<br>Self-reported via PillPal</p></header>
    <section><div class="kpis">
      <div class="kpi"><b>${r.adherence ?? 'n/a'}${r.adherence != null ? '%' : ''}</b><span>Overall adherence</span></div>
      <div class="kpi"><b>${r.taken}/${r.scheduled}</b><span>Doses taken</span></div>
      <div class="kpi"><b>${r.streak}</b><span>Current streak (days)</span></div>
      <div class="kpi"><b>${r.moodAvg ?? 'n/a'}</b><span>Average mood (1–5)</span></div></div></section>
    ${aiOn() ? `<section id="prep">${prepHtml(S.prep?.[S.period])}</section>` : ''}
    <section><h3>Medications</h3>${r.meds.length ? `<div style="overflow-x:auto"><table><thead><tr><th scope="col">Medication</th><th scope="col">Schedule</th><th scope="col">Adherence</th><th scope="col">Missed / skipped</th></tr></thead><tbody>
      ${r.meds.map(m => `<tr><td><b>${esc(m.name)}</b> ${esc(m.dose)}${m.reason ? `<div class="fine">for ${esc(m.reason)}</div>` : ''}${m.trialId ? `<div><span class="tag trial">Study ${esc(m.trialId)}</span></div>` : ''}${m.active ? '' : '<div class="fine">Stopped</div>'}</td>
        <td>${m.times.map(fmtTime).join('<br>')}</td>
        <td>${m.adherence ?? 'n/a'}${m.adherence != null ? '%' : ''}<div class="meter ${m.adherence < 80 ? 'low' : ''}" aria-hidden="true"><i style="width:${m.adherence || 0}%"></i></div></td>
        <td>${m.missed} / ${m.skipped}${m.recentMissed.length ? `<div class="fine">Last missed: ${m.recentMissed.slice(-2).map(x => { const [d, t] = x.split(' '); return `${fmtDate(d)} ${fmtTime(t)}`; }).join(', ')}</div>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No medications tracked in this period.</p>'}</section>
    <section><h3>Daily adherence</h3>
      <div class="bars" role="img" aria-label="${r.daily.filter(d => d.scheduled && d.taken === d.scheduled).length} of ${r.daily.filter(d => d.scheduled).length} days fully taken">${r.daily.map(d => `<span class="${d.scheduled ? '' : 'none'}" style="height:${d.scheduled ? Math.max(4, d.taken / d.scheduled * 100) : 4}%" title="${fmtDate(d.date)}: ${d.taken}/${d.scheduled}"></span>`).join('')}</div>
      <div class="row fine" style="justify-content:space-between;margin-top:.4rem"><span>${fmtDate(r.from)}</span><span>${fmtDate(r.to)}</span></div></section>
    <section><h3>Reported side effects</h3>${r.sideEffects.length ? `<table><thead><tr><th scope="col">Symptom</th><th scope="col">Days reported</th></tr></thead><tbody>${r.sideEffects.map(s => `<tr><td>${esc(s.name)} ${r.flagged.includes(s.name) ? '<span class="tag bad">3+ days this week</span>' : ''}</td><td>${s.count}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">None reported.</p>'}</section>
    <section><h3>Mood trend</h3>${sparkline(r.moods)}</section>
    <section><h3>Patient notes and questions</h3>${r.notes.length ? `<ul>${r.notes.map(n => `<li><b>${fmtDate(n.date)}:</b> ${esc(n.notes)}${n.questions ? `<br><i>Question:</i> ${esc(n.questions)}` : ''}</li>`).join('')}</ul>` : '<p class="muted">No notes.</p>'}</section>
    ${trials.length ? `<section><h3>Clinical trial participation</h3><ul>${trials.map(m => `<li>${esc(m.name)}: <a href="https://clinicaltrials.gov/study/${esc(m.trialId)}" target="_blank" rel="noopener">${esc(m.trialId)}</a>, ${m.adherence ?? 'n/a'}% adherence</li>`).join('')}</ul></section>` : ''}
    <section><p class="fine">Data is self-reported by the patient and has not been clinically verified. PillPal is not a medical record or a diagnostic tool.</p></section>
  </article>`;
  S.report = r;
};

// ---------- Trials & community ----------
PAGES.trials = async q => {
  const reasons = [...new Set(S.meds.map(m => m.reason).filter(Boolean))];
  const intr = q.get('intr') || '';
  $('#main').innerHTML = `${head('Clinical trials & community', 'Research only moves forward when people take part. Find studies that are recruiting now.')}
  <form class="card search-bar" id="trialForm">
    <div><label for="tCond">Condition</label><input id="tCond" name="cond" type="text" value="${esc(intr ? '' : reasons[0] || '')}" placeholder="e.g. type 2 diabetes" list="tCondList"><datalist id="tCondList">${reasons.map(r => `<option value="${esc(r)}">`).join('')}</datalist></div>
    <div><label for="tIntr">Medication <span class="hint">(optional)</span></label><input id="tIntr" name="intr" type="text" value="${esc(intr)}" placeholder="e.g. metformin" list="tMedList"><datalist id="tMedList">${S.meds.map(m => `<option value="${esc(m.name)}">`).join('')}</datalist></div>
    <div><label for="tLoc">Near <span class="hint">(city or state)</span></label><input id="tLoc" name="loc" type="text" placeholder="e.g. New Brunswick, NJ"></div>
    <button class="btn primary" type="submit">${icon('search')} Find trials</button>
  </form>
  <div id="trialResults" style="margin:20px 0 32px" aria-live="polite"></div>
  <h2 style="margin-bottom:1rem">Help for you and your community</h2>
  <div class="resources">
    <a class="card resource" href="https://www.fda.gov/safety/medwatch-fda-safety-information-and-adverse-event-reporting-program" target="_blank" rel="noopener"><span class="ic">${icon('alert')}</span><h3>Report a side effect to the FDA</h3><p class="fine">MedWatch reports help catch drug safety problems for everyone.</p></a>
    <a class="card resource" href="https://www.dea.gov/takebackday" target="_blank" rel="noopener"><span class="ic">${icon('recycle')}</span><h3>Safely dispose of old meds</h3><p class="fine">Find a drug take-back location so leftover pills don't end up misused.</p></a>
    <a class="card resource" href="tel:18002221222"><span class="ic">${icon('phone')}</span><h3>Poison Help: 1-800-222-1222</h3><p class="fine">Free, confidential, 24/7 help if someone took the wrong medicine or too much.</p></a>
    <a class="card resource" href="https://clinicaltrials.gov/study-basics/learn-about-studies" target="_blank" rel="noopener"><span class="ic">${icon('flask')}</span><h3>What joining a study means</h3><p class="fine">Plain-language guide to eligibility, consent, and your rights.</p></a>
  </div>`;
  const run = async () => {
    const f = Object.fromEntries(new FormData($('#trialForm')));
    const box = $('#trialResults');
    if (!f.cond && !f.intr) { box.innerHTML = '<p class="error">Enter a condition or a medication.</p>'; return; }
    box.innerHTML = `<div class="row">${pal('focus', 40)}<span>Searching ClinicalTrials.gov…</span></div>`;
    try {
      const list = await api(`/trials?${new URLSearchParams(f)}`);
      const phase = p => p === 'NA' ? '' : p.replace('EARLY_PHASE', 'Early phase ').replace('PHASE', 'Phase ');
      box.innerHTML = list.length ? `<p class="muted" style="margin-bottom:12px">${plural(list.length, 'recruiting study')} found. Talk with your doctor before joining any study.</p>
        <div class="trial-grid">${list.map(t => `<article class="card trial-card">
          <div class="row"><span class="tag ok">Recruiting</span>${t.phases.map(phase).filter(Boolean).map(p => `<span class="tag">${esc(p)}</span>`).join('')}</div>
          <h3>${esc(t.title)}</h3><p class="fine">${esc(t.conditions.join(', '))}</p><p>${esc(t.summary)}</p>
          ${t.locations.length ? `<p class="fine row" style="gap:.3rem">${icon('pin')} ${esc(t.locations.join(' · '))}${t.locationCount > 3 ? ` +${t.locationCount - 3} more` : ''}</p>` : ''}
          ${t.sponsor ? `<p class="fine">Sponsor: ${esc(t.sponsor)}</p>` : ''}
          <a class="btn sm" href="https://clinicaltrials.gov/study/${encodeURIComponent(t.id)}" target="_blank" rel="noopener">View ${esc(t.id)} ${icon('external')}</a></article>`).join('')}</div>`
        : `<div class="card empty">${pal('concerned', 60)}<p>No recruiting studies matched. Try a broader condition or remove the location.</p></div>`;
      announce(`${list.length} studies found`);
    } catch (x) { box.innerHTML = `<p class="error">${esc(x.message)}</p>`; }
  };
  $('#trialForm').onsubmit = e => { e.preventDefault(); run(); };
  if (intr || reasons[0]) run();
};

// ---------- Settings ----------
PAGES.settings = async () => {
  const p = S.user.prefs || {};
  const perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  const sw = (k, label, hint) => `<label class="switch"><span><b>${label}</b><span class="hint">${hint}</span></span><input type="checkbox" role="switch" data-pref="${k}" ${p[k] ? 'checked' : ''}></label>`;
  $('#main').innerHTML = `${head('Settings', 'Make PillPal comfortable for you.')}
  <div class="grid-today">
    <div class="col">
      <section class="card"><h2>Comfort & accessibility</h2>
        ${sw('largeText', 'Larger text', 'Bigger type everywhere')}
        ${sw('highContrast', 'High contrast', 'Stronger text and borders')}
        ${sw('voice', 'Read reminders out loud', 'Pal speaks when it is time for a dose')}
        ${sw('reduceMotion', 'Reduce motion', 'Turns off animations and confetti')}
        ${S.user.ai ? sw('noAi', 'Turn off AI features', "Ask Pal, smart scanning and explanations use Google Gemini. When on, your question and relevant medication info are sent to Google.") : ''}
        <div style="padding-top:14px"><label for="theme">Appearance</label><select id="theme">${['system', 'light', 'dark'].map(t => `<option value="${t}" ${(p.theme || 'system') === t ? 'selected' : ''}>${title(t === 'system' ? 'match my device' : t)}</option>`).join('')}</select></div>
      </section>
      <section class="card"><h2>Reminders</h2>
        <p class="muted" style="margin-bottom:1rem">${perm === 'granted' ? 'Desktop notifications are on.' : perm === 'denied' ? 'Notifications are blocked in your browser settings. In-app reminders still work while PillPal is open.' : perm === 'unsupported' ? 'This browser does not support notifications. In-app reminders still work.' : 'Turn on notifications so reminders reach you even in another tab.'}</p>
        <div class="row">${perm === 'default' ? `<button class="btn primary" data-action="notifyPerm">${icon('bell')} Turn on notifications</button>` : ''}<button class="btn" data-action="testReminder">Send a test reminder</button></div>
        <p class="fine" style="margin-top:.8rem">Reminders work while PillPal is open (a tab or the installed app). Keep it running in the background.</p>
      </section>
    </div>
    <div class="col">
      <section class="card"><h2>Desktop app</h2>
        <p class="muted" style="margin-bottom:1rem">Install PillPal so it opens in its own window, like any desktop app.</p>
        <button class="btn primary" data-action="install" ${S.install ? '' : 'hidden'} id="installBtn">${icon('download')} Install PillPal</button>
        <p class="fine" ${S.install ? 'hidden' : ''}>In Chrome or Edge: open the browser menu, then choose “Install PillPal” (under “Cast, save, and share” or “Apps”).</p>
      </section>
      <section class="card"><h2>Account</h2><p><b>${esc(S.user.name)}</b><br><span class="muted">${esc(S.user.email)}</span></p>
        <p class="fine" style="margin:.8rem 0 1rem">Your data stays in your PillPal account. Nothing is shared unless you print or copy your report.</p>
        <button class="btn" data-action="logout">${icon('logout')} Sign out</button></section>
    </div>
  </div>`;
  const save = async () => { applyPrefs(); $('#askFab').hidden = !aiOn(); try { await api('/me', { method: 'PATCH', body: { prefs: S.user.prefs } }); announce('Settings saved'); } catch (x) { toast(esc(x.message), { mood: 'concerned' }); } };
  document.querySelectorAll('[data-pref]').forEach(i => (i.onchange = () => { S.user.prefs = { ...S.user.prefs, [i.dataset.pref]: i.checked }; save(); }));
  $('#theme').onchange = e => { S.user.prefs = { ...S.user.prefs, theme: e.target.value }; save(); };
};
addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.install = e; $('#installBtn')?.removeAttribute('hidden'); });

// ---------- reminders ----------
function remind(m, time, test = false) {
  chime();
  const detail = [m.dose, m.instructions].filter(Boolean).join(' · ');
  if (S.user.prefs?.voice && 'speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(`Time to take your ${m.name}${m.dose ? ', ' + m.dose : ''}.`));
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
    const n = new Notification(`Time for ${m.name}`, { body: detail || 'Open PillPal to log it.', icon: '/icon.svg', tag: `${m._id}|${time}` });
    n.onclick = () => { focus(); location.hash = '#/today'; };
  }
  toast(`<b>Time for ${esc(m.name)}</b><p class="muted">${esc(test ? 'This is a test reminder.' : detail || fmtTime(time))}</p>
    ${test ? '' : `<div class="row"><button class="btn sm primary" data-action="toastDose" data-med="${m._id}" data-time="${time}">${icon('check')} Taken</button>
    <button class="btn sm" data-action="snooze" data-med="${m._id}" data-time="${time}">Snooze 10 min</button></div>`}`, { mood: 'wave', reminder: true, sticky: !test });
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
    updateBadge();
  };
  S.timer = setInterval(tick, 15000);
  tick();
}

// ---------- AI (Gemini via the server) ----------
const aiOn = () => !!S.user?.ai && !S.user.prefs?.noAi;
const thinking = msg => `<div class="row" role="status">${pal('focus', 36)}<span class="muted">${esc(msg)}</span><span class="dots-typing" aria-hidden="true"><i></i><i></i><i></i></span></div>`;
const aiNoteHtml = note => `<p class="ai-tag">${icon('sparkle')} A note from Pal · AI</p><p>${esc(note)}</p>`;
function prepHtml(p) {
  if (!p) return `<div class="row no-print" style="justify-content:space-between"><div><h3>Visit prep</h3><p class="muted">Let Pal draft a short summary and questions for your appointment.</p></div>
    <button class="btn" data-action="visitPrep">${icon('sparkle')} Draft with Pal</button></div>`;
  return `<h3>Visit summary</h3><p>${esc(p.summary)}</p>
    ${p.questions.length ? `<h3 style="margin-top:1rem">Questions I want to ask</h3><ul>${p.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
    <p class="fine">AI-drafted by Pal (Google Gemini) from the data in this report. Review it before sharing.</p>`;
}

// Light formatting for Pal's replies: escape first, then **bold** and "- " bullets.
function fmtMsg(t) {
  return esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').split(/\n{2,}/).map(block => {
    const lines = block.split('\n');
    return lines.every(l => /^\s*[-*•] /.test(l))
      ? `<ul>${lines.map(l => `<li>${l.replace(/^\s*[-*•] /, '')}</li>`).join('')}</ul>`
      : `<p>${lines.map(l => (/^\s*[-*•] /.test(l) ? '• ' + l.replace(/^\s*[-*•] /, '') : l)).join('<br>')}</p>`;
  }).join('');
}
const SUGGEST = ['What is each of my meds for?', 'Can I take ibuprofen with my meds?', "Tips so I don't miss a dose", 'What side effects should I watch for?', 'How am I doing this week?'];
S.chat = [];

function openChat(question) {
  let d = $('#chat');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'chat';
    d.className = 'chat';
    d.setAttribute('aria-labelledby', 'chatH');
    d.innerHTML = `<div class="chat-head">${pal('wave', 34)}<div><h2 id="chatH">Ask Pal</h2><p class="fine">Knows your meds and check-ins. Not a doctor.</p></div>
        <button class="btn icon ghost" data-close aria-label="Close chat">${icon('x')}</button></div>
      <div class="chat-log" id="chatLog" role="log" aria-live="polite"></div>
      <form class="chat-form" id="chatForm"><label for="chatIn" class="sr-only">Message Pal</label>
        <textarea id="chatIn" rows="1" maxlength="2000" placeholder="Ask about your medicines…"></textarea>
        <button class="btn primary icon" aria-label="Send">${icon('send')}</button></form>
      <p class="fine chat-foot">Powered by Google Gemini. Emergencies: call 911.</p>`;
    document.body.append(d);
    d.addEventListener('click', e => {
      if (e.target.closest('[data-close]')) d.close();
      const sug = e.target.closest('[data-suggest]');
      if (sug) sendChat(sug.textContent);
      const sp = e.target.closest('[data-speak]');
      if (sp && 'speechSynthesis' in window) { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(S.chat[sp.dataset.speak].text)); }
    });
    $('#chatForm', d).onsubmit = e => { e.preventDefault(); const t = $('#chatIn').value.trim(); if (t) { $('#chatIn').value = ''; sendChat(t); } };
    $('#chatIn', d).onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatForm').requestSubmit(); } };
  }
  renderChat();
  d.showModal();
  if (question) sendChat(question); else $('#chatIn').focus();
}

function renderChat() {
  const log = $('#chatLog');
  log.innerHTML = S.chat.length
    ? S.chat.map((m, i) => `<div class="msg ${m.role}${m.urgent ? ' urgent' : ''}">${m.role === 'model' ? pal(m.urgent ? 'concerned' : 'happy', 26) : ''}
        <div class="bubble-msg">${fmtMsg(m.text)}${m.role === 'model' && !m.error ? `<button class="speak" data-speak="${i}" aria-label="Read this answer aloud">${icon('volume')}</button>` : ''}</div></div>`).join('')
      + (S.chatBusy ? `<div class="msg model">${pal('focus', 26)}<div class="bubble-msg"><span class="dots-typing" role="status" aria-label="Pal is typing"><i></i><i></i><i></i></span></div></div>` : '')
    : `<div class="chat-empty">${pal('wave', 64)}<p><b>Hi ${esc(S.user.name)}! I'm Pal.</b><br>Ask me anything about your medicines.</p>
        <div class="chips">${SUGGEST.map(q => `<button class="btn sm" data-suggest>${q}</button>`).join('')}</div></div>`;
  log.scrollTop = log.scrollHeight;
}

async function sendChat(text) {
  if (S.chatBusy) return;
  S.chat.push({ role: 'user', text });
  S.chatBusy = true;
  renderChat();
  try {
    const r = await api('/ai/chat', { method: 'POST', body: { messages: S.chat.filter(m => !m.error).map(({ role, text }) => ({ role, text })), today: today(), now: nowHM() } });
    S.chat.push({ role: 'model', text: r.reply, urgent: r.urgent });
    if (S.user.prefs?.voice && 'speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(r.reply));
  } catch (x) {
    S.chat.push({ role: 'model', text: x.message, error: true });
  }
  S.chatBusy = false;
  renderChat();
  $('#chatIn')?.focus();
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
    if (status && todayItems().every(i => i.status)) { confetti(); toast('<b>Everything logged for today!</b><p class="muted">Pal is proud of you.</p>', { mood: 'cheer' }); }
  },
  async toastDose(b) {
    b.closest('.toast')?.remove();
    await api('/doses', { method: 'POST', body: { medId: b.dataset.med, date: today(), time: b.dataset.time, status: 'taken' } });
    chime();
    if (location.hash.startsWith('#/today')) render(); else updateBadge();
  },
  snooze(b) {
    b.closest('.toast')?.remove();
    const m = S.meds.find(x => x._id === b.dataset.med);
    setTimeout(() => remind(m, b.dataset.time), 10 * 60e3);
    announce('Snoozed for 10 minutes');
  },
  addMed: () => medDialog(),
  chatOpen: () => openChat(),
  askMed(b) { const m = S.meds.find(x => x._id === b.dataset.id); openChat(`Tell me about my ${m.name}: what it's for, how to take it well, and what side effects to watch for.`); },
  async explain(b) {
    const box = $('#' + b.dataset.target);
    b.disabled = true;
    box.innerHTML = thinking('Pal is putting it simply…');
    try {
      const e = await api('/ai/explain', { method: 'POST', body: { name: b.dataset.name } });
      box.innerHTML = `<div class="ai-card"><p class="ai-tag">${icon('sparkle')} Pal explains · AI</p><p>${esc(e.simple)}</p>
        ${e.tips.length ? `<h3>Tips</h3><ul>${e.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
        ${e.askDoctor.length ? `<h3>Worth asking your pharmacist</h3><ul>${e.askDoctor.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}</div>`;
      b.remove();
    } catch (x) { box.innerHTML = `<p class="error">${esc(x.message)}</p>`; b.disabled = false; }
  },
  async visitPrep(b) {
    b.disabled = true;
    $('#prep').innerHTML = thinking('Pal is drafting your visit summary…');
    try {
      (S.prep ||= {})[S.period] = await api('/ai/visit-prep', { method: 'POST', body: { days: S.period, today: today(), now: nowHM() } });
      $('#prep').innerHTML = prepHtml(S.prep[S.period]);
    } catch (x) { $('#prep').innerHTML = prepHtml() + `<p class="error">${esc(x.message)}</p>`; }
  },
  editMed: b => medDialog(S.meds.find(m => m._id === b.dataset.id)),
  async delMed(b) {
    const m = S.meds.find(x => x._id === b.dataset.id);
    if (!confirm(`Stop tracking ${m.name}? Its history stays in your doctor report.`)) return;
    await api(`/meds/${m._id}?today=${today()}`, { method: 'DELETE' });
    await render();
    announce(`${m.name} removed`);
  },
  capture, camOn: startCamera,
  closeResult() { $('#scanResult').hidden = true; setStatus('Fit the label inside the frame, then press scan'); $('#shutter').focus(); },
  scanAdd() { location.hash = '#/meds?add=1'; },
  period(b) { S.period = +b.dataset.days; render(); },
  print: () => print(),
  async copyReport() {
    try { await navigator.clipboard.writeText(reportText(S.report)); toast('<b>Report copied</b><p class="muted">Paste it into your patient portal message.</p>', { mood: 'cheer' }); }
    catch { toast('Copy failed. Use Print / PDF instead.', { mood: 'concerned' }); }
  },
  async notifyPerm() { await Notification.requestPermission(); render(); },
  testReminder() {
    remind(S.meds[0] || { _id: 'test', name: 'your medication' }, nowHM(), true);
  },
  async install() { await S.install?.prompt(); S.install = null; $('#installBtn')?.setAttribute('hidden', ''); },
  async logout() { await api('/logout', { method: 'POST' }); stopCamera(); clearInterval(S.timer); S.user = null; S.chat = []; S.aiNote = S.prep = null; $('#chat')?.remove(); location.hash = ''; renderAuth(); },
};
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-action]');
  if (!b || !ACTIONS[b.dataset.action]) return;
  e.preventDefault();
  try { await ACTIONS[b.dataset.action](b, e); }
  catch (x) { if (x.status === 401) renderAuth(); else toast(`<b>Oops.</b> ${esc(x.message)}`, { mood: 'concerned' }); }
});

// ---------- boot ----------
(async () => {
  try { S.user = await api('/me'); await enter(); }
  catch { renderAuth(); }
})();
