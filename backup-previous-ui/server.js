import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { extractCandidates, buildReport, addDays } from './logic.js';

const scrypt = promisify(crypto.scrypt);
const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const PROD = process.env.NODE_ENV === 'production';
const DIR = import.meta.dirname;

// ---------- database ----------
async function connect() {
  let uri = process.env.MONGODB_URI;
  if (!uri) {
    // Zero-setup local dev: embedded mongod persisted to .data/db. Set MONGODB_URI (e.g. Atlas) for real deploys.
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const dbPath = path.join(DIR, '.data', 'db');
    fs.mkdirSync(dbPath, { recursive: true });
    const mongod = await MongoMemoryServer.create({ instance: { dbPath, storageEngine: 'wiredTiger' } });
    uri = mongod.getUri();
    console.log(`No MONGODB_URI set, using embedded MongoDB at ${dbPath}`);
  }
  const db = (await new MongoClient(uri).connect()).db(process.env.MONGODB_DB || 'pillpal');
  await Promise.all([
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('meds').createIndex({ userId: 1, active: 1 }),
    db.collection('doses').createIndex({ userId: 1, medId: 1, date: 1, time: 1 }, { unique: true }),
    db.collection('checkins').createIndex({ userId: 1, date: 1 }, { unique: true }),
  ]);
  return db;
}
const db = await connect();
const users = db.collection('users'), sessions = db.collection('sessions'), meds = db.collection('meds'),
  doses = db.collection('doses'), checkins = db.collection('checkins');

// ---------- validation ----------
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
function str(v, max, name, required = true) {
  if (v == null || v === '') { if (required) throw bad(`${name} is required`); return ''; }
  if (typeof v !== 'string') throw bad(`${name} must be text`);
  v = v.trim();
  if (required && !v) throw bad(`${name} is required`);
  if (v.length > max) throw bad(`${name} is too long (max ${max} characters)`);
  return v;
}
const date = (v, name = 'Date') => { if (!DATE.test(v)) throw bad(`${name} must be YYYY-MM-DD`); return v; };
const oid = id => { if (!ObjectId.isValid(id)) throw bad('Invalid id'); return new ObjectId(id); };
const clean = v => (typeof v === 'string' ? v.replace(/[^\w\s.,'-]/g, ' ').trim().slice(0, 80) : '');

function medInput(b) {
  const times = Array.isArray(b.times) ? [...new Set(b.times.filter(t => TIME.test(t)))].sort() : [];
  if (!times.length || times.length > 8) throw bad('Add between 1 and 8 reminder times');
  const trialId = str(b.trialId, 20, 'Trial ID', false).toUpperCase();
  if (trialId && !/^NCT\d{8}$/.test(trialId)) throw bad('Trial IDs look like NCT12345678');
  return {
    name: str(b.name, 80, 'Medication name'),
    dose: str(b.dose, 40, 'Dose', false),
    reason: str(b.reason, 80, 'Reason', false),
    instructions: str(b.instructions, 200, 'Instructions', false),
    color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#13A89E',
    times, trialId,
  };
}

// ---------- auth ----------
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
async function hashPw(pw, salt = crypto.randomBytes(16)) {
  return `${salt.toString('hex')}:${(await scrypt(pw, salt, 64)).toString('hex')}`;
}
async function verifyPw(pw, stored) {
  const [salt, hash] = stored.split(':');
  return crypto.timingSafeEqual(await scrypt(pw, Buffer.from(salt, 'hex'), 64), Buffer.from(hash, 'hex'));
}
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('='))
  .filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const maxAge = 30 * 864e5;
  await sessions.insertOne({ _id: sha(token), userId, expiresAt: new Date(Date.now() + maxAge) });
  res.cookie('pp_session', token, { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge, path: '/' });
}

async function auth(req, res, next) {
  const t = cookies(req).pp_session;
  const s = t && await sessions.findOne({ _id: sha(t), expiresAt: { $gt: new Date() } });
  if (!s) throw bad('Please sign in', 401);
  req.userId = s.userId;
  next();
}

// ponytail: in-memory login limiter, per process. Move to Mongo/Redis if you run more than one instance.
const attempts = new Map();
const limited = k => { const a = attempts.get(k); return a && a.until > Date.now() && a.n >= 8; };
const failed = k => { const a = attempts.get(k); if (!a || a.until < Date.now()) attempts.set(k, { n: 1, until: Date.now() + 15 * 6e4 }); else a.n++; };

const publicUser = u => ({ name: u.name, email: u.email, prefs: u.prefs || {}, ai: !!GEMINI_KEY });

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
const smallJson = express.json({ limit: '100kb' }), imageJson = express.json({ limit: '6mb' });
app.use((req, res, next) => (req.path === '/api/ai/scan' ? imageJson : smallJson)(req, res, next));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
  next();
});
app.use(express.static(path.join(DIR, 'public'), { maxAge: PROD ? '1h' : 0 }));

app.post('/api/signup', async (req, res) => {
  const name = str(req.body.name, 60, 'Name');
  const email = str(req.body.email, 120, 'Email').toLowerCase();
  const password = str(req.body.password, 200, 'Password');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email');
  if (password.length < 8) throw bad('Password must be at least 8 characters');
  try {
    const { insertedId } = await users.insertOne({ name, email, passHash: await hashPw(password), prefs: {}, createdAt: new Date() });
    await startSession(res, insertedId);
    res.status(201).json({ name, email, prefs: {}, ai: !!GEMINI_KEY });
  } catch (e) {
    if (e.code === 11000) throw bad('An account with that email already exists', 409);
    throw e;
  }
});

app.post('/api/login', async (req, res) => {
  const email = str(req.body.email, 120, 'Email').toLowerCase();
  const key = `${req.ip}|${email}`;
  if (limited(key)) throw bad('Too many attempts. Try again in 15 minutes.', 429);
  const u = await users.findOne({ email });
  if (!u || !(await verifyPw(str(req.body.password, 200, 'Password'), u.passHash))) {
    failed(key);
    throw bad('Email or password is incorrect', 401);
  }
  attempts.delete(key);
  await startSession(res, u._id);
  res.json(publicUser(u));
});

app.post('/api/logout', async (req, res) => {
  const t = cookies(req).pp_session;
  if (t) await sessions.deleteOne({ _id: sha(t) });
  res.clearCookie('pp_session', { path: '/' }).json({ ok: true });
});

app.get('/api/me', auth, async (req, res) => res.json(publicUser(await users.findOne({ _id: req.userId }))));

app.patch('/api/me', auth, async (req, res) => {
  const p = req.body.prefs || {};
  const prefs = Object.fromEntries(['largeText', 'highContrast', 'voice', 'reduceMotion', 'noAi'].map(k => [k, !!p[k]]));
  prefs.theme = ['light', 'dark'].includes(p.theme) ? p.theme : 'system';
  await users.updateOne({ _id: req.userId }, { $set: { prefs } });
  res.json({ prefs });
});

// meds
app.get('/api/meds', auth, async (req, res) =>
  res.json(await meds.find({ userId: req.userId, active: true }).sort({ createdAt: 1 }).toArray()));

app.post('/api/meds', auth, async (req, res) => {
  const doc = { ...medInput(req.body), userId: req.userId, active: true, startDate: date(req.body.today, 'today'), createdAt: new Date() };
  const { insertedId } = await meds.insertOne(doc);
  res.status(201).json({ ...doc, _id: insertedId });
});

app.put('/api/meds/:id', auth, async (req, res) => {
  const r = await meds.findOneAndUpdate({ _id: oid(req.params.id), userId: req.userId }, { $set: medInput(req.body) }, { returnDocument: 'after' });
  if (!r) throw bad('Medication not found', 404);
  res.json(r);
});

// Soft delete: history stays in the clinician report.
app.delete('/api/meds/:id', auth, async (req, res) => {
  const r = await meds.updateOne({ _id: oid(req.params.id), userId: req.userId },
    { $set: { active: false, endDate: addDays(date(req.query.today, 'today'), -1) } });
  if (!r.matchedCount) throw bad('Medication not found', 404);
  res.json({ ok: true });
});

// doses
app.get('/api/doses', auth, async (req, res) =>
  res.json(await doses.find({ userId: req.userId, date: date(req.query.date) }, { projection: { _id: 0, medId: 1, time: 1, status: 1 } }).toArray()));

app.post('/api/doses', auth, async (req, res) => {
  const { medId, status } = req.body;
  const key = { userId: req.userId, medId: String(oid(medId)), date: date(req.body.date), time: req.body.time };
  if (!TIME.test(key.time)) throw bad('Invalid time');
  if (!(await meds.countDocuments({ _id: oid(medId), userId: req.userId }))) throw bad('Medication not found', 404);
  if (status == null) await doses.deleteOne(key);
  else if (['taken', 'skipped'].includes(status)) await doses.updateOne(key, { $set: { status, at: new Date() } }, { upsert: true });
  else throw bad('Invalid status');
  res.json({ ok: true });
});

// check-ins
const EFFECTS = ['Nausea', 'Headache', 'Dizziness', 'Fatigue', 'Upset stomach', 'Rash or itching', 'Trouble sleeping',
  'Dry mouth', 'Anxiety', 'Muscle pain', 'Low appetite', 'Other'];
app.get('/api/checkins', auth, async (req, res) => {
  const today = date(req.query.today, 'today');
  const days = Math.min(Math.max(+req.query.days || 14, 1), 365);
  res.json(await checkins.find({ userId: req.userId, date: { $gt: addDays(today, -days), $lte: today } }, { projection: { _id: 0, userId: 0 } })
    .sort({ date: -1 }).toArray());
});

app.post('/api/checkins', auth, async (req, res) => {
  const mood = +req.body.mood;
  if (!(mood >= 1 && mood <= 5)) throw bad('Pick how you are feeling (1–5)');
  const doc = {
    mood,
    sideEffects: Array.isArray(req.body.sideEffects) ? req.body.sideEffects.filter(e => EFFECTS.includes(e)) : [],
    notes: str(req.body.notes, 1000, 'Notes', false),
    questions: str(req.body.questions, 1000, 'Questions', false),
    updatedAt: new Date(),
  };
  await checkins.updateOne({ userId: req.userId, date: date(req.body.date) }, { $set: doc }, { upsert: true });
  res.json({ ok: true });
});

// clinician report
async function reportFor(userId, q) {
  const today = date(q.today, 'today');
  const now = TIME.test(q.now) ? q.now : '23:59';
  const days = Math.min(Math.max(+q.days || 30, 1), 365);
  const from = addDays(today, -(days - 1));
  const [u, m, d, c] = await Promise.all([
    users.findOne({ _id: userId }),
    meds.find({ userId, startDate: { $lte: today }, $or: [{ endDate: { $exists: false } }, { endDate: { $gte: from } }] }).toArray(),
    doses.find({ userId, date: { $gte: from, $lte: today } }).toArray(),
    checkins.find({ userId, date: { $gte: from, $lte: today } }).toArray(),
  ]);
  return { patient: u.name, generatedAt: new Date(), ...buildReport({ meds: m, doses: d, checkins: c, today, now, days }) };
}
app.get('/api/report', auth, async (req, res) => res.json(await reportFor(req.userId, req.query)));

// ---------- public health data (openFDA, ClinicalTrials.gov) ----------
const cache = new Map();
async function cachedJson(url) {
  if (cache.has(url)) return cache.get(url);
  const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'PillPal/1.0' } });
  if (!r.ok && r.status !== 404) throw bad('Health data service is unavailable right now', 502);
  const data = r.status === 404 ? null : await r.json();
  if (cache.size > 500) cache.clear(); // ponytail: crude cap; swap for an LRU if traffic grows
  cache.set(url, data);
  return data;
}
const fda = (ep, search, limit = 1) => cachedJson(`https://api.fda.gov/drug/${ep}.json?` + new URLSearchParams({ search, limit: String(limit) }));
// Fuzzy search returns combos first sometimes ("metformin" -> sitagliptin/metformin); prefer exact, then single-ingredient.
function bestLabel(results, w) {
  const score = r => {
    const b = first(r.openfda?.brand_name).toUpperCase(), g = first(r.openfda?.generic_name).toUpperCase();
    return b === w ? 0 : g === w ? 1 : g.startsWith(w) ? 2 + g.length / 100 : b.startsWith(w) ? 3 : 4 + g.length / 100;
  };
  return results?.slice().sort((a, b) => score(a) - score(b))[0];
}
const first = a => (Array.isArray(a) ? a[0] : a) || '';
function clip(s, n = 420) {
  s = s.replace(/^\s*[\d.]*\s*(INDICATIONS (AND|&) USAGE|PURPOSES?|USES?|DOSAGE AND ADMINISTRATION|DIRECTIONS|ADVERSE REACTIONS|BOXED WARNING|WARNINGS?( AND PRECAUTIONS)?)[:\s]*/i, '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, s.lastIndexOf(' ', n)) + '…' : s;
}
function labelInfo(r) {
  const o = r.openfda || {};
  return {
    brand: first(o.brand_name), generic: first(o.generic_name), manufacturer: first(o.manufacturer_name), route: first(o.route),
    uses: clip(first(r.indications_and_usage) || first(r.purpose)),
    dosage: clip(first(r.dosage_and_administration) || first(r.directions || r.dosage_and_administration_table), 300),
    boxedWarning: clip(first(r.boxed_warning), 300),
    warnings: clip(first(r.warnings_and_cautions) || first(r.warnings), 300),
    sideEffects: clip(first(r.adverse_reactions), 300),
    ndc: first(o.product_ndc), setId: r.set_id,
  };
}
async function lookupDrug({ ndc, words }) {
  for (const code of ndc.slice(0, 3)) {
    const p = (await fda('ndc', `product_ndc:"${code}"`))?.results?.[0];
    if (!p) continue;
    const l = (await fda('label', `openfda.product_ndc:"${p.product_ndc}"`))?.results?.[0];
    return { ...(l ? labelInfo(l) : {}), brand: p.brand_name, generic: p.generic_name, ndc: p.product_ndc, matched: `NDC ${code}` };
  }
  for (const w of words.slice(0, 8)) {
    const l = bestLabel((await fda('label', `openfda.brand_name:"${w}" openfda.generic_name:"${w}"`, 10))?.results, w);
    if (l) return { ...labelInfo(l), matched: w };
  }
  return null;
}

app.get('/api/drug', auth, async (req, res) => {
  const q = clean(req.query.q).toUpperCase();
  if (!q) throw bad('Type a medication name');
  const c = extractCandidates(q);
  const info = await lookupDrug({ ndc: c.ndc, words: [...new Set([q.replace(/\s*\d.*$/, ''), ...c.words])].filter(Boolean) });
  res.json({ info, strength: c.strength });
});

app.post('/api/drug/scan', auth, async (req, res) => {
  const c = extractCandidates(str(req.body.text, 5000, 'Label text'));
  res.json({ info: await lookupDrug(c), strength: c.strength, candidates: c.words });
});

app.get('/api/trials', auth, async (req, res) => {
  const cond = clean(req.query.cond), intr = clean(req.query.intr), loc = clean(req.query.loc);
  if (!cond && !intr) throw bad('Enter a condition or a medication');
  const p = new URLSearchParams({
    'filter.overallStatus': 'RECRUITING', pageSize: '12',
    fields: 'NCTId,BriefTitle,Condition,Phase,BriefSummary,LocationCity,LocationState,LocationCountry,LeadSponsorName',
  });
  if (cond) p.set('query.cond', cond);
  if (intr) p.set('query.intr', intr);
  if (loc) p.set('query.locn', loc);
  const data = await cachedJson('https://clinicaltrials.gov/api/v2/studies?' + p);
  const near = loc.toLowerCase();
  res.json((data?.studies || []).map(s => {
    const ps = s.protocolSection || {};
    const locs = [...new Set((ps.contactsLocationsModule?.locations || []).map(l => [l.city, l.state || l.country].filter(Boolean).join(', ')))];
    return {
      id: ps.identificationModule?.nctId,
      title: ps.identificationModule?.briefTitle,
      conditions: (ps.conditionsModule?.conditions || []).slice(0, 4),
      phases: ps.designModule?.phases || [],
      sponsor: ps.sponsorCollaboratorsModule?.leadSponsor?.name || '',
      summary: clip(ps.descriptionModule?.briefSummary || '', 260),
      locationCount: locs.length,
      locations: (near ? [...locs.filter(l => l.toLowerCase().includes(near)), ...locs.filter(l => !l.toLowerCase().includes(near))] : locs).slice(0, 3),
    };
  }));
});

// ---------- Gemini: Pal's AI (scan vision, chat, explainers, insights, visit prep) ----------
const PAL_RULES = `You are Pal, the friendly capsule mascot of PillPal, a medication tracking app. Be warm, plain (6th-grade reading level) and brief: usually under 120 words.
Rules you never break:
- You are not a doctor or pharmacist. Never diagnose. Never tell someone to start, stop, skip, double, split or change a dose; send those questions to their prescriber or pharmacist.
- If the user describes an emergency (chest pain, trouble breathing, swelling of face or throat, fainting, seizure, possible overdose, thoughts of self-harm), FIRST tell them to call 911 now (Poison Help 1-800-222-1222 for overdose or poisoning, 988 for a mental health crisis).
- General facts about medicines are fine. Ground them in the FDA label excerpts you are given, and say plainly when you are unsure or when it depends on the person.
- Only use the user's data you are given. Never invent doses, times or history.
- Plain text. Short paragraphs or simple "- " bullets. No headings, no tables.`;

// Busy/overloaded (429/5xx): retry once, then fall back to an older stable model.
const MODELS = [GEMINI_MODEL, GEMINI_MODEL, 'gemini-2.5-flash'];
async function gemini({ system = PAL_RULES, contents, json = false, temperature = 0.5 }) {
  let r, data;
  for (const [i, model] of MODELS.entries()) {
    if (i) await new Promise(ok => setTimeout(ok, 800 * i));
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      signal: AbortSignal.timeout(45000),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature, ...(json && { responseMimeType: 'application/json' }) },
      }),
    });
    data = await r.json().catch(() => ({}));
    if (r.ok || (r.status !== 429 && r.status < 500)) break;
    console.error('Gemini busy', model, r.status, data.error?.message);
  }
  if (!r.ok) {
    console.error('Gemini error', r.status, data.error?.message);
    throw bad(r.status === 429 ? 'Pal is answering a lot of questions right now. Try again in a minute.' : "Pal's AI is unavailable right now.", 502);
  }
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  if (!text) throw bad("Pal couldn't answer that one. Try asking another way.", 502);
  if (!json) return text;
  try { return JSON.parse(text); } catch { throw bad('Pal got muddled reading that. Please try again.', 502); }
}
const ask = (prompt, opts = {}) => gemini({ ...opts, contents: [{ role: 'user', parts: [{ text: prompt }] }] });
const s = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const arr = v => (Array.isArray(v) ? v.map(x => s(x, 300)).filter(Boolean).slice(0, 6) : []);
const titleCase = t => t.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

// AI is opt-out per user because health data goes to Google. Plus a per-user rate limit.
const aiCalls = new Map(); // ponytail: in-memory, per process
async function aiUser(req) {
  if (!GEMINI_KEY) throw bad('AI features are not set up on this server (GEMINI_API_KEY).', 503);
  const u = await users.findOne({ _id: req.userId });
  if (u.prefs?.noAi) throw bad('AI features are turned off in your settings.', 403);
  const now = Date.now(), k = String(u._id), recent = (aiCalls.get(k) || []).filter(t => now - t < 60e3);
  if (recent.length >= 20) throw bad('Pal needs a short breather. Try again in a minute.', 429);
  aiCalls.set(k, [...recent, now]);
  return u;
}

async function labelFacts(name) {
  const w = name.toUpperCase().replace(/[^A-Z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim();
  const i = w && await lookupDrug({ ndc: [], words: [w] }).catch(() => null);
  return i ? `${name} (FDA label: ${titleCase(i.brand || i.generic)}). Used for: ${i.uses || 'n/a'} Warnings: ${i.boxedWarning || i.warnings || 'n/a'} Side effects: ${i.sideEffects || 'n/a'}` : '';
}

async function patientContext(u, q, { labels = true } = {}) {
  const [list, r] = await Promise.all([meds.find({ userId: u._id, active: true }).toArray(), reportFor(u._id, { ...q, days: 7 })]);
  const facts = labels ? (await Promise.all(list.slice(0, 6).map(m => labelFacts(m.name)))).filter(Boolean) : [];
  return [
    `First name: ${u.name}. Today: ${r.to}, local time ${TIME.test(q.now) ? q.now : 'unknown'}.`,
    `Current medications: ${list.map(m => `${m.name}${m.dose ? ' ' + m.dose : ''} at ${m.times.join(', ')}${m.reason ? ` for ${m.reason}` : ''}${m.instructions ? ` (${m.instructions})` : ''}${m.trialId ? ` [clinical trial ${m.trialId}]` : ''}`).join('; ') || 'none added yet'}.`,
    `Last 7 days: ${r.adherence ?? 'n/a'}% of doses taken (${r.taken}/${r.scheduled}), streak ${r.streak} days, average mood ${r.moodAvg ?? 'n/a'}/5, side effects: ${r.sideEffects.map(x => `${x.name} on ${x.count} days`).join(', ') || 'none reported'}${r.flagged.length ? `; flagged 3+ days: ${r.flagged.join(', ')}` : ''}.`,
    r.notes.length ? `Recent notes: ${r.notes.slice(0, 3).map(n => `${n.date}: ${[n.notes, n.questions && 'Question: ' + n.questions].filter(Boolean).join(' / ')}`).join(' | ')}` : '',
    facts.length ? `FDA label excerpts:\n${facts.join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

app.post('/api/ai/chat', auth, async (req, res) => {
  const u = await aiUser(req);
  const msgs = Array.isArray(req.body.messages) ? req.body.messages.slice(-16) : [];
  if (msgs.at(-1)?.role !== 'user') throw bad('Ask Pal a question');
  const contents = msgs.map(m => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: str(m.text, 2000, 'Message') }] }));
  // Emergencies get a fixed safety message first, and still get it if the AI is down.
  const urgent = EMERGENCY.test(contents.at(-1).parts[0].text);
  let reply = '';
  try {
    const ctx = await patientContext(u, req.body);
    reply = await gemini({ system: `${PAL_RULES}\n\nWhat you know about this user from their PillPal account (private):\n${ctx}`, contents });
  } catch (e) { if (!urgent) throw e; }
  res.json({ reply: urgent ? `${SAFETY}${reply ? '\n\n' + reply : ''}` : reply, urgent });
});
const EMERGENCY = /overdos|too many (pills|tablets)|took (\d+|ten|a lot|all)\b|double dose|chest pain|can'?t breathe|trouble breathing|short(ness)? of breath|swell|faint|pass(ed)? out|seizure|suicid|kill myself|end my life|self[- ]?harm|poison/i;
const SAFETY = 'If this is an emergency, call 911 now. For a possible overdose or poisoning, call Poison Help at 1-800-222-1222 (free, 24/7). For a mental health crisis, call or text 988.';

app.post('/api/ai/scan', auth, async (req, res) => {
  await aiUser(req);
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(req.body.image || '');
  if (!m) throw bad('Send a JPEG, PNG or WebP photo');
  const o = await gemini({
    system: 'You read pharmacy and medication labels from photos. Copy text exactly as printed. Never guess text you cannot see.',
    json: true, temperature: 0.1,
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: `image/${m[1]}`, data: m[2] } },
      { text: 'Read the medication label in this photo. Return JSON with keys: found (boolean; false if no medication label is readable), drugName (as printed), genericName, strength (like "20 mg"), dosageForm, directions (the "take..." instructions, verbatim), ndc, quantity, refills, pharmacy, warnings (array of short warning-sticker texts). Use "" or [] for anything not visible.' },
    ] }],
  });
  const label = { found: !!o.found, drugName: s(o.drugName), genericName: s(o.genericName), strength: s(o.strength, 40), dosageForm: s(o.dosageForm, 60),
    directions: s(o.directions, 300), ndc: s(o.ndc, 20), quantity: s(o.quantity, 30), refills: s(o.refills, 30), pharmacy: s(o.pharmacy, 80), warnings: arr(o.warnings) };
  if (!label.found) return res.json({ info: null, label, ai: true });
  const up = v => v.toUpperCase().replace(/[^A-Z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = [...new Set([up(label.genericName), up(label.drugName), ...up(label.drugName).split(' ').filter(w => w.length >= 4)])].filter(Boolean);
  res.json({ info: await lookupDrug({ ndc: extractCandidates(label.ndc).ndc, words }), strength: label.strength, label, ai: true });
});

app.post('/api/ai/explain', auth, async (req, res) => {
  await aiUser(req);
  const name = clean(req.body.name);
  if (!name) throw bad('Which medication?');
  const facts = await labelFacts(name);
  const o = await ask(`Explain the medication "${name}" to a patient in plain language.${facts ? `\nGround your answer in this FDA label excerpt:\n${facts}` : ''}
Return JSON: {"simple": "2-3 sentences: what it is and what it does in the body", "tips": ["3 short practical tips for taking it well"], "askDoctor": ["2 short questions worth asking a pharmacist or doctor"]}`, { json: true, temperature: 0.4 });
  res.json({ simple: s(o.simple, 700), tips: arr(o.tips), askDoctor: arr(o.askDoctor) });
});

app.post('/api/ai/insight', auth, async (req, res) => {
  const u = await aiUser(req);
  const ctx = await patientContext(u, req.body, { labels: false });
  const note = await ask(`${ctx}\n\nThey just saved today's check-in. Write Pal's note: 2-3 warm sentences reacting specifically to their adherence, mood and any side effects, then one tiny practical tip. If a side effect is flagged, gently suggest mentioning it to their care team. Plain text, no lists, under 70 words.`, { temperature: 0.8 });
  res.json({ note: s(note, 800) });
});

app.post('/api/ai/visit-prep', auth, async (req, res) => {
  const u = await aiUser(req);
  const r = await reportFor(u._id, req.body);
  const data = { days: r.days, from: r.from, to: r.to, adherence: r.adherence, taken: r.taken, scheduled: r.scheduled,
    meds: r.meds.map(m => ({ name: m.name, dose: m.dose, for: m.reason, trial: m.trialId, adherence: m.adherence, missed: m.missed, skipped: m.skipped })),
    sideEffects: r.sideEffects, flagged: r.flagged, moodAvg: r.moodAvg, notes: r.notes.slice(0, 8) };
  const o = await ask(`Self-reported medication data from PillPal:\n${JSON.stringify(data)}
Return JSON: {"summary": "3-4 neutral, factual sentences a clinician can skim: adherence overall and per medication if notable, recurring symptoms, mood trend. No advice, no diagnosis.", "questions": ["3-5 questions the patient could ask at their visit, written in first person"]}`, { json: true, temperature: 0.3 });
  res.json({ summary: s(o.summary, 1200), questions: arr(o.questions) });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (!err.status || err.status >= 500) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong on our side' });
});

app.listen(PORT, () => console.log(`PillPal running at http://localhost:${PORT}`));
