import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import https from 'node:https';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildDemo, demoMixes, demoChat, demoExplain, demoInsight, demoVisitPrep, demoPrecheck } from './demo.js';
import { extractCandidates, buildReport, addDays, bestWordSim, productNdcSplits, parseSig, pillLook, mentions as mentionsOf, mixNames, mixLevel, hoursFromDirections, scheduleHours, isLiquid, VITALS, GLUCOSE_CONTEXT, vitalFlag, vitalText, summarizeVitals, mapStudy, STUDY_FIELDS, quickFit, ctgovSearchUrl } from './logic.js';

const scrypt = promisify(crypto.scrypt);
const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
// Google's picks for new projects (Oct 2026): 3.8 Flash for answers, 3.5 Flash-Lite for fast reading. 2.5 models are
// restricted to accounts that already used them, so they're no longer in the fallback list.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const FAST_MODEL = process.env.GEMINI_SCAN_MODEL || 'gemini-3.5-flash-lite';
const PROD = process.env.NODE_ENV === 'production';
const DIR = import.meta.dirname;

// ---------- database ----------
// Zero-setup local dev runs an embedded mongod. Its files live OUTSIDE the project folder: the project sits in OneDrive,
// and OneDrive syncing/locking the database files makes mongod crash mid-run (ECONNREFUSED). If it still stops, it is
// restarted on the same port and the driver reconnects by itself. Set MONGODB_URI (e.g. Atlas) for real deploys.
function localDbPath() {
  if (process.env.PILLPAL_DB_DIR) return process.env.PILLPAL_DB_DIR;
  const base = process.env.LOCALAPPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.local', 'share'));
  return path.join(base, 'PillPal', 'db');
}
async function embeddedMongo() {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const dbPath = localDbPath(), old = path.join(DIR, '.data', 'db');
  // One-time move of data saved by earlier versions (inside the synced project folder).
  if (!fs.existsSync(dbPath) && fs.existsSync(old) && fs.readdirSync(old).length) {
    const tmp = dbPath + '.copying';
    try { fs.rmSync(tmp, { recursive: true, force: true }); fs.cpSync(old, tmp, { recursive: true }); fs.renameSync(tmp, dbPath); console.log(`Copied your existing PillPal data from ${old} to ${dbPath}`); }
    catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); console.error(`Couldn't copy old data (${e.message}); starting with a fresh database.`); }
  }
  fs.mkdirSync(dbPath, { recursive: true });
  let port, restarts = [];
  const start = async () => {
    const m = await MongoMemoryServer.create({ instance: { dbPath, storageEngine: 'wiredTiger', ...(port && { port }) } });
    port = m.instanceInfo.port;
    const inst = m.instanceInfo.instance, lines = [];
    inst.on('instanceSTDOUT', t => { for (const l of String(t).split('\n')) if (/"s":"(E|F|W)"|error|denied|lock/i.test(l)) { lines.push(l.slice(0, 400)); if (lines.length > 8) lines.shift(); } });
    inst.on('instanceSTDERR', t => { lines.push(String(t).slice(0, 400)); if (lines.length > 8) lines.shift(); });
    inst.once('instanceClosed', async code => {
      if (stopping) return;
      console.error(`Embedded MongoDB stopped unexpectedly (exit code ${code}).${lines.length ? ' Last messages:\n  ' + lines.join('\n  ') : ''}`);
      restarts = restarts.filter(t => Date.now() - t < 60e3);
      if (restarts.length >= 3) return console.error('It keeps stopping. Close other PillPal windows, or set MONGODB_URI to a MongoDB Atlas database in .env.');
      restarts.push(Date.now());
      try { await start(); console.log(`Embedded MongoDB restarted on port ${port}.`); } catch (e) { console.error('Could not restart MongoDB:', e.message); }
    });
    return m;
  };
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; process.exit(0); });
  const m = await start();
  console.log(`No MONGODB_URI set, using embedded MongoDB at ${dbPath}`);
  return m.getUri();
}
async function connect() {
  const uri = process.env.MONGODB_URI || await embeddedMongo();
  const db = (await new MongoClient(uri, { serverSelectionTimeoutMS: 15000 }).connect()).db(process.env.MONGODB_DB || 'pillpal');
  await Promise.all([
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('meds').createIndex({ userId: 1, active: 1 }),
    db.collection('doses').createIndex({ userId: 1, medId: 1, date: 1, time: 1 }, { unique: true }),
    db.collection('checkins').createIndex({ userId: 1, date: 1 }, { unique: true }),
    db.collection('scanfixes').createIndex({ userId: 1, word: 1 }, { unique: true }),
    db.collection('medcheckins').createIndex({ userId: 1, medId: 1, at: -1 }),
    db.collection('vitals').createIndex({ userId: 1, at: -1 }),
    db.collection('effects').createIndex({ userId: 1, startDate: -1 }),
  ]);
  return db;
}
const db = await connect();
const users = db.collection('users'), sessions = db.collection('sessions'), meds = db.collection('meds'),
  doses = db.collection('doses'), checkins = db.collection('checkins'), scanfixes = db.collection('scanfixes'),
  medcheckins = db.collection('medcheckins'), vitals = db.collection('vitals'), effects = db.collection('effects');

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
    color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#F1F4F4',
    shape: ['round', 'oval', 'capsule'].includes(b.shape) ? b.shape : 'round',
    form: ['pill', 'liquid'].includes(b.form) ? b.form : isLiquid(`${b.dose} ${b.name} ${b.instructions}`) ? 'liquid' : 'pill',
    // Hours between doses. Blank = Pip works it out (see intervalFor); a number here is the user's own setting.
    intervalHours: num(b.intervalHours, 0.5, 168, 'Hours between doses'),
    times, trialId,
    // Refill info (optional; usually read off the label by Scan). Drives run-out and discard-after reminders.
    quantity: num(b.quantity, 0, 10000, 'Quantity'),
    unitsPerDose: num(b.unitsPerDose, 0.25, 20, 'Units per dose'),
    refills: num(b.refills, 0, 99, 'Refills'),
    fillDate: b.fillDate ? date(b.fillDate, 'Fill date') : '',
    discardAfter: b.discardAfter ? date(b.discardAfter, 'Discard-after date') : '',
  };
}
function num(v, min, max, name) {
  if (v === '' || v == null) return null;
  const n = +v;
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${name} must be between ${min} and ${max}`);
  return n;
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

const ctxCache = new Map(); // userId -> { at, ctx }: what Pip knows, reused across chat messages for a minute
async function auth(req, res, next) {
  const t = cookies(req).pp_session;
  const s = t && await sessions.findOne({ _id: sha(t), expiresAt: { $gt: new Date() } });
  if (!s) throw bad('Please sign in', 401);
  req.userId = s.userId;
  if (req.method !== 'GET' && !req.path.startsWith('/api/ai')) ctxCache.delete(String(s.userId)); // their data changed: Pip's context is stale
  next();
}

// ponytail: in-memory login limiter, per process. Move to Mongo/Redis if you run more than one instance.
const attempts = new Map();
const limited = k => { const a = attempts.get(k); return a && a.until > Date.now() && a.n >= 8; };
const failed = k => { const a = attempts.get(k); if (!a || a.until < Date.now()) attempts.set(k, { n: 1, until: Date.now() + 15 * 6e4 }); else a.n++; };

const publicUser = u => ({ name: u.name, email: u.email, prefs: u.prefs || {}, ai: !!GEMINI_KEY || !!u.demo, demo: !!u.demo });

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
// logic.js is shared: the browser imports it too (trial matching, measurement ranges).
app.get('/logic.js', (req, res) => res.type('text/javascript').sendFile(path.join(DIR, 'logic.js')));

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
  if (!u || u.demo || !(await verifyPw(str(req.body.password, 200, 'Password'), u.passHash))) {
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
  prefs.theme = ['light', 'warm', 'dark'].includes(p.theme) ? p.theme : 'system';
  await users.updateOne({ _id: req.userId }, { $set: { prefs } });
  res.json({ prefs });
});

// meds
app.get('/api/meds', auth, async (req, res) =>
  res.json(await meds.find({ userId: req.userId, active: true }).sort({ createdAt: 1 }).toArray()));

app.post('/api/meds', auth, async (req, res) => {
  const input = medInput(req.body);
  const doc = { ...input, ingredients: [], userId: req.userId, active: true, startDate: date(req.body.today, 'today'), createdAt: new Date() };
  const { insertedId } = await meds.insertOne(doc);
  // RxNorm ingredients (for duplicate and interaction checks) fill in after the save, so saving stays instant.
  ingredientsFor(input.name).then(ingredients => ingredients.length && meds.updateOne({ _id: insertedId }, { $set: { ingredients } })).catch(() => {});
  res.status(201).json({ ...doc, _id: insertedId });
});

app.put('/api/meds/:id', auth, async (req, res) => {
  const input = medInput(req.body);
  const r = await meds.findOneAndUpdate({ _id: oid(req.params.id), userId: req.userId }, { $set: { ...input, interval: null } }, { returnDocument: 'after' });
  if (!r) throw bad('Medication not found', 404);
  ingredientsFor(input.name).then(ingredients => ingredients.length && meds.updateOne({ _id: r._id }, { $set: { ingredients } })).catch(() => {});
  res.json(r);
});

// "Stop tracking" is a soft delete: history stays in the clinician report.
// "Remove" (?remove=1) deletes the medication and everything logged for it.
app.delete('/api/meds/:id', auth, async (req, res) => {
  const _id = oid(req.params.id);
  if (req.query.remove === '1') {
    if (!(await meds.countDocuments({ _id, userId: req.userId }))) throw bad('Medication not found', 404);
    await Promise.all([meds.deleteOne({ _id, userId: req.userId }), doses.deleteMany({ userId: req.userId, medId: String(_id) }),
      medcheckins.deleteMany({ userId: req.userId, medId: String(_id) })]);
    return res.json({ ok: true, removed: true });
  }
  const r = await meds.updateOne({ _id, userId: req.userId }, { $set: { active: false, endDate: addDays(date(req.query.today, 'today'), -1) } });
  if (!r.matchedCount) throw bad('Medication not found', 404);
  res.json({ ok: true });
});

// "Remind me in X minutes" for a dose that's due. One snooze per med; logging the dose clears it.
app.post('/api/meds/:id/snooze', auth, async (req, res) => {
  const minutes = num(req.body.minutes, 1, 240, 'Minutes');
  if (minutes == null) throw bad('How many minutes?');
  const time = req.body.time;
  if (!TIME.test(time)) throw bad('Invalid time');
  const snooze = { date: date(req.body.date), time, from: new Date(), until: new Date(Date.now() + Math.round(minutes) * 60e3) };
  const r = await meds.updateOne({ _id: oid(req.params.id), userId: req.userId }, { $set: { snooze } });
  if (!r.matchedCount) throw bad('Medication not found', 404);
  res.json({ snooze });
});

// Before adding a med: is the same ingredient already tracked? (Lipitor vs atorvastatin, or a strength change.)
app.post('/api/meds/check', auth, async (req, res) => {
  const name = str(req.body.name, 80, 'Medication name');
  res.json({ duplicate: await duplicateOf(req.userId, await ingredientsFor(name), req.body.id, req.body.dose) });
});

// doses
app.get('/api/doses', auth, async (req, res) =>
  res.json(await doses.find({ userId: req.userId, date: date(req.query.date) }, { projection: { _id: 0, medId: 1, time: 1, status: 1, at: 1 } }).toArray()));

// Doses taken since yesterday: the dose timers count from the last one taken for each med.
app.get('/api/doses/recent', auth, async (req, res) => {
  const today = date(req.query.today, 'today');
  res.json(await doses.find({ userId: req.userId, status: 'taken', date: { $gte: addDays(today, -1), $lte: today } },
    { projection: { _id: 0, medId: 1, date: 1, time: 1, at: 1 } }).sort({ at: 1 }).toArray());
});

app.post('/api/doses', auth, async (req, res) => {
  const { medId, status } = req.body;
  const key = { userId: req.userId, medId: String(oid(medId)), date: date(req.body.date), time: req.body.time };
  if (!TIME.test(key.time)) throw bad('Invalid time');
  if (!(await meds.countDocuments({ _id: oid(medId), userId: req.userId }))) throw bad('Medication not found', 404);
  const m = await meds.findOne({ _id: oid(medId), userId: req.userId });
  // The dose timer: Take starts a countdown of the med's interval; Undo of that dose resets it until the next Take.
  // Skip never starts one; skipping the dose a finished timer was waiting for clears that timer.
  let timer = m.timer || null;
  const now = new Date();
  if (status == null) {
    await doses.deleteOne(key);
    if (timer && timer.date === key.date && timer.time === key.time) timer = null;
  } else if (status === 'taken') {
    const hours = m.interval?.hours || fallbackInterval(m).hours;
    await doses.updateOne(key, { $set: { status, at: now } }, { upsert: true });
    timer = { startedAt: now, endsAt: new Date(+now + hours * 3600e3), hours, date: key.date, time: key.time, status };
  } else if (status === 'skipped') {
    await doses.updateOne(key, { $set: { status, at: now } }, { upsert: true });
    if (timer && (new Date(timer.endsAt) <= now || req.body.endTimer === true)) timer = null;
  } else throw bad('Invalid status');
  await meds.updateOne({ _id: m._id }, { $set: { timer, snooze: null } });
  res.json({ ok: true, timer });
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

// Per-medication check-ins ("How do you feel on this one?"), offered right after a dose is taken.
app.get('/api/medcheckins', auth, async (req, res) => {
  const q = { userId: req.userId };
  if (req.query.medId) q.medId = String(oid(req.query.medId));
  res.json(await medcheckins.find(q, { projection: { userId: 0 } }).sort({ at: -1 }).limit(Math.min(+req.query.limit || 20, 100)).toArray());
});
app.post('/api/medcheckins', auth, async (req, res) => {
  const mood = +req.body.mood;
  if (!(mood >= 1 && mood <= 5)) throw bad('Pick how you are feeling (1–5)');
  const m = await meds.findOne({ _id: oid(req.body.medId), userId: req.userId });
  if (!m) throw bad('Medication not found', 404);
  const doc = { userId: req.userId, medId: String(m._id), medName: m.name, date: date(req.body.date), time: TIME.test(req.body.time) ? req.body.time : '',
    mood, sideEffects: Array.isArray(req.body.sideEffects) ? req.body.sideEffects.filter(e => EFFECTS.includes(e)) : [],
    notes: str(req.body.notes, 1000, 'Notes', false), at: new Date() };
  const { insertedId } = await medcheckins.insertOne(doc);
  res.status(201).json({ ...doc, _id: insertedId, userId: undefined });
});

// ---------- health log: measurements ----------
const numIn = (v, min, max, name) => { const n = num(v, min, max, name); if (n == null) throw bad(`${name} is required`); return Math.round(n * 10) / 10; };
app.get('/api/vitals', auth, async (req, res) => {
  const days = Math.min(Math.max(+req.query.days || 90, 1), 730);
  res.json(await vitals.find({ userId: req.userId, at: { $gte: new Date(Date.now() - days * 864e5) } }, { projection: { userId: 0 } }).sort({ at: -1 }).toArray());
});
app.post('/api/vitals', auth, async (req, res) => {
  const b = req.body, type = b.type, V = VITALS[type];
  if (!V) throw bad('Unknown measurement');
  const doc = { userId: req.userId, type, value: numIn(b.value, V.min, V.max, type === 'bp' ? 'Top number (systolic)' : V.label) };
  if (type === 'bp') { doc.value2 = numIn(b.value2, V.min2, V.max2, 'Bottom number (diastolic)'); doc.pulse = num(b.pulse, 30, 230, 'Pulse'); if (doc.value2 >= doc.value) throw bad('The top number should be bigger than the bottom one'); }
  if (type === 'glucose') doc.context = GLUCOSE_CONTEXT.includes(b.context) ? b.context : 'other';
  const at = b.at ? new Date(b.at) : new Date();
  if (isNaN(at) || at > new Date(Date.now() + 5 * 60e3)) throw bad('Pick a time that isn’t in the future');
  Object.assign(doc, { at, date: date(b.date, 'Date'), note: str(b.note, 300, 'Note', false), flag: vitalFlag(doc)?.level || null });
  const { insertedId } = await vitals.insertOne(doc);
  res.status(201).json({ ...doc, _id: insertedId, userId: undefined, flagText: vitalFlag(doc)?.text || '' });
});
app.delete('/api/vitals/:id', auth, async (req, res) => { await vitals.deleteOne({ _id: oid(req.params.id), userId: req.userId }); res.json({ ok: true }); });

// ---------- health log: side effects in detail ----------
// What study teams ask for: when it started and stopped, how bad (mild / moderate / severe), which medicine might
// be the cause, and whether it was serious (ER visit, hospital stay, or a medicine stopped because of it).
const SEVERITY = ['mild', 'moderate', 'severe'];
async function effectInput(req) {
  const b = req.body;
  const suspects = Array.isArray(b.suspects) ? b.suspects.filter(ObjectId.isValid).slice(0, 6) : [];
  const own = suspects.length ? await meds.find({ userId: req.userId }).toArray() : [];
  const startDate = date(b.startDate, 'Start date'), endDate = b.endDate ? date(b.endDate, 'End date') : '';
  if (endDate && endDate < startDate) throw bad('It can’t end before it started');
  return {
    name: str(b.name, 60, 'What you noticed'), startDate, endDate,
    severity: SEVERITY.includes(b.severity) ? b.severity : 'mild',
    serious: { er: !!b.serious?.er, hospital: !!b.serious?.hospital, stoppedMed: !!b.serious?.stoppedMed },
    suspects: own.filter(m => suspects.includes(String(m._id))).map(m => ({ id: String(m._id), name: m.name, trialId: m.trialId || '' })),
    notes: str(b.notes, 1000, 'Notes', false), updatedAt: new Date(),
  };
}
const isSerious = e => e.severity === 'severe' || e.serious?.er || e.serious?.hospital;
app.get('/api/effects', auth, async (req, res) => res.json(await effects.find({ userId: req.userId }, { projection: { userId: 0 } }).sort({ startDate: -1 }).limit(100).toArray()));
app.post('/api/effects', auth, async (req, res) => {
  const doc = { ...(await effectInput(req)), userId: req.userId, createdAt: new Date() };
  const { insertedId } = await effects.insertOne(doc);
  res.status(201).json({ ...doc, _id: insertedId, userId: undefined, serious: doc.serious, urgent: isSerious(doc) });
});
app.put('/api/effects/:id', auth, async (req, res) => {
  const doc = await effectInput(req);
  const r = await effects.findOneAndUpdate({ _id: oid(req.params.id), userId: req.userId }, { $set: doc }, { returnDocument: 'after' });
  if (!r) throw bad('Not found', 404);
  res.json({ ...r, userId: undefined, urgent: isSerious(r) });
});
app.delete('/api/effects/:id', auth, async (req, res) => { await effects.deleteOne({ _id: oid(req.params.id), userId: req.userId }); res.json({ ok: true }); });

// ---------- profile: eligibility basics and the studies the user is in ----------
const SEXES = ['female', 'male'];
function profileInput(b = {}) {
  const year = new Date().getFullYear();
  const birthYear = b.birthYear === '' || b.birthYear == null ? null : num(b.birthYear, year - 120, year, 'Birth year');
  return {
    birthYear: birthYear && Math.round(birthYear), sex: SEXES.includes(b.sex) ? b.sex : '', location: str(b.location, 80, 'Location', false),
    conditions: (Array.isArray(b.conditions) ? b.conditions : String(b.conditions || '').split(',')).map(c => String(c).trim()).filter(Boolean).slice(0, 12).map(c => c.slice(0, 60)),
  };
}
function studyInput(b = {}) {
  const nctId = str(b.nctId, 11, 'Study ID').toUpperCase();
  if (!/^NCT\d{8}$/.test(nctId)) throw bad('Study IDs look like NCT12345678');
  const visits = (Array.isArray(b.visits) ? b.visits : []).slice(0, 20).map(v => ({ date: date(v.date, 'Visit date'), time: TIME.test(v.time) ? v.time : '', label: str(v.label, 80, 'Visit', false) || 'Study visit' }))
    .sort((a, c) => `${a.date} ${a.time}`.localeCompare(`${c.date} ${c.time}`));
  const email = str(b.coordinatorEmail, 120, 'Email', false);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('That email doesn’t look right');
  return { nctId, title: str(b.title, 300, 'Title', false), participantId: str(b.participantId, 40, 'Participant ID', false), site: str(b.site, 120, 'Study site', false),
    coordinatorName: str(b.coordinatorName, 80, 'Coordinator', false), coordinatorPhone: str(b.coordinatorPhone, 30, 'Phone', false), coordinatorEmail: email, visits };
}
app.get('/api/profile', auth, async (req, res) => { const u = await users.findOne({ _id: req.userId }); res.json({ profile: u.profile || {}, studies: u.studies || [] }); });
app.put('/api/profile', auth, async (req, res) => {
  const set = {};
  if (req.body.profile) set.profile = profileInput(req.body.profile);
  if (Array.isArray(req.body.studies)) {
    const list = req.body.studies.slice(0, 10).map(studyInput);
    if (new Set(list.map(x => x.nctId)).size !== list.length) throw bad('That study is already listed');
    set.studies = list;
  }
  await users.updateOne({ _id: req.userId }, { $set: set });
  const u = await users.findOne({ _id: req.userId });
  res.json({ profile: u.profile || {}, studies: u.studies || [] });
});

// clinician report
async function reportFor(userId, q) {
  const today = date(q.today, 'today');
  const now = TIME.test(q.now) ? q.now : '23:59';
  const days = Math.min(Math.max(+q.days || 30, 1), 365);
  const from = addDays(today, -(days - 1));
  const [u, m, d, c, mc, vs, fx] = await Promise.all([
    users.findOne({ _id: userId }),
    meds.find({ userId, startDate: { $lte: today }, $or: [{ endDate: { $exists: false } }, { endDate: { $gte: from } }] }).toArray(),
    doses.find({ userId, date: { $gte: from, $lte: today } }).toArray(),
    checkins.find({ userId, date: { $gte: from, $lte: today } }).toArray(),
    medcheckins.find({ userId, date: { $gte: from, $lte: today } }).sort({ at: -1 }).toArray(),
    vitals.find({ userId, date: { $gte: from, $lte: today } }).toArray(),
    effects.find({ userId, startDate: { $lte: today } }).sort({ startDate: -1 }).toArray(),
  ]);
  // Per-medication check-ins, grouped: average mood, side effects noted, latest few notes.
  const medFeel = [...new Set(mc.map(x => x.medId))].map(id => {
    const list = mc.filter(x => x.medId === id), fx = {};
    list.forEach(x => x.sideEffects.forEach(e => (fx[e] = (fx[e] || 0) + 1)));
    return { medId: id, name: list[0].medName, count: list.length, moodAvg: Math.round(list.reduce((a, x) => a + x.mood, 0) / list.length * 10) / 10,
      sideEffects: Object.entries(fx).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      notes: list.filter(x => x.notes).slice(0, 3).map(x => ({ date: x.date, mood: x.mood, notes: x.notes })) };
  });
  const effectRows = fx.filter(e => !e.endDate || e.endDate >= from).map(({ userId: _, ...e }) => ({ ...e, urgent: isSerious(e) }));
  return { patient: u.name, generatedAt: new Date(), ...buildReport({ meds: m, doses: d, checkins: c, today, now, days }), medFeel,
    vitals: summarizeVitals(vs), effects: effectRows, profile: u.profile || {}, studies: u.studies || [] };
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
  s = s.replace(/^\s*[\d.]*\s*(INDICATIONS (AND|&) USAGE|PURPOSES?|USES?|DOSAGE AND ADMINISTRATION|DIRECTIONS|ADVERSE REACTIONS|BOXED WARNING|DRUG INTERACTIONS|WARNINGS?( AND PRECAUTIONS)?)[:\s]*/i, '').replace(/\s+/g, ' ').trim();
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
async function ndcLookup(ndc) {
  for (const code of ndc.slice(0, 4)) {
    const p = (await fda('ndc', `product_ndc:"${code}"`))?.results?.[0];
    if (!p) continue;
    const l = (await fda('label', `openfda.product_ndc:"${p.product_ndc}"`))?.results?.[0];
    return { ...(l ? labelInfo(l) : {}), brand: p.brand_name, generic: p.generic_name, ndc: p.product_ndc, matched: `NDC ${code}`, via: 'ndc' };
  }
  return null;
}
async function labelByWord(w) {
  return bestLabel((await fda('label', `openfda.brand_name:"${w}" openfda.generic_name:"${w}"`, 10))?.results, w) || null;
}
const STR_T = { type: 'STRING' };
const withTimeout = (p, ms, fallback = null) => Promise.race([p, new Promise(ok => setTimeout(() => ok(fallback), ms))]);

// ---------- RxNorm (NLM RxNav): spelling-tolerant matching to a standard drug ID ----------
// Free, no key. NLM asks for ≤20 requests/s per IP and caching for 12–24 h; cachedJson keeps results in memory.
const RXNAV = 'https://rxnav.nlm.nih.gov/REST';
const rx = p => cachedJson(RXNAV + p);
// A concept's active ingredients (an ingredient concept is its own ingredient).
async function rxConcept(rxcui) {
  const [props, rel] = await Promise.all([rx(`/rxcui/${rxcui}/properties.json`), rx(`/rxcui/${rxcui}/related.json?tty=IN`)]);
  const p = props?.properties;
  if (!p) return null;
  const ingredients = p.tty === 'IN' ? [{ rxcui: p.rxcui, name: p.name }]
    : (rel?.relatedGroup?.conceptGroup || []).flatMap(g => g.conceptProperties || []).map(c => ({ rxcui: c.rxcui, name: c.name }));
  return { rxcui: p.rxcui, name: p.name, tty: p.tty, ingredients };
}
// One OCR word → its closest RxNorm drug, if it's close enough to trust (letters 70%+ alike).
async function rxMatch(word) {
  const d = await rx(`/approximateTerm.json?${new URLSearchParams({ term: word, maxEntries: '6', option: '1' })}`);
  const c = (d?.approximateGroup?.candidate || []).filter(x => x.name);
  const best = c.map(x => ({ ...x, sim: bestWordSim(word, x.name) + (x.source === 'RXNORM' ? 0.001 : 0) })).sort((a, b) => b.sim - a.sim || +a.rank - +b.rank)[0];
  if (!best || best.sim < 0.7) return null;
  const concept = await rxConcept(best.rxcui);
  return concept?.ingredients.length ? { word, sim: Math.min(1, best.sim), ...concept } : null;
}
const ingKey = c => c.ingredients.map(i => i.rxcui).sort().join('+');
const displayName = c => titleCase(c.tty === 'BN' || c.tty === 'IN' ? c.name : c.ingredients.map(i => i.name).join(' / '));
// Candidate words (plus this user's past corrections) → best drug + close runners-up to offer as "Did you mean…".
async function resolveWords(words, userId) {
  words = [...new Set(words.map(w => String(w).trim()).filter(w => w.length >= 3))].slice(0, 8);
  if (!words.length) return null;
  if (userId) {
    const fixes = await scanfixes.find({ userId, word: { $in: words.map(w => w.toUpperCase()) } }).toArray();
    if (fixes.length) words = [...new Set([...fixes.map(f => f.name), ...words])];
  }
  const hits = (await Promise.all(words.slice(0, 6).map((w, i) => rxMatch(w).then(h => h && { ...h, order: i }).catch(() => null)))).filter(Boolean)
    .sort((a, b) => b.sim - a.sim || a.order - b.order);
  if (!hits.length) return null;
  const best = hits[0], seen = new Set([ingKey(best)]);
  const alternatives = hits.slice(1).filter(h => h.sim >= best.sim - 0.12 && !seen.has(ingKey(h)) && seen.add(ingKey(h))).slice(0, 3)
    .map(h => ({ name: displayName(h), word: h.word }));
  return { best, alternatives };
}
const ingredientsFor = name => withTimeout(resolveWords([name]).then(r => r?.best.ingredients || []).catch(() => []), 6000, []);

// Is this strength one RxNorm lists for the ingredient? true / false / null (couldn't tell).
async function strengthKnown(ingRxcui, strength) {
  const m = /(\d+(?:\.\d+)?)\s*(mg|mcg|g|ml|unit)/i.exec(strength || '');
  if (!m) return null;
  const names = ((await rx(`/rxcui/${ingRxcui}/related.json?tty=SCD+SBD`))?.relatedGroup?.conceptGroup || []).flatMap(g => g.conceptProperties || []).map(c => c.name);
  if (!names.length) return null;
  const re = new RegExp(`(^|\\D)${m[1].replace('.', '\\.')}\\s*${m[2]}\\b`, 'i');
  return names.some(n => re.test(n));
}

// NDC first (exact), then RxNorm-matched names, then the plain openFDA word search as a last resort.
// Returns label info + rx (standard ID and ingredients) + alternatives + conflicts between NDC and name.
async function lookupDrug({ ndc = [], words = [], userId, strength = '' }) {
  const [byNdc, byName] = await Promise.all([
    ndcLookup(ndc),
    words.length ? withTimeout(resolveWords(words, userId).catch(() => null), 9000) : null,
  ]);
  const conflicts = [];
  if (byNdc) {
    const g = `${byNdc.generic || ''} ${byNdc.brand || ''}`.toUpperCase();
    const agrees = byName && byName.best.ingredients.some(i => g.includes(i.name.toUpperCase()));
    if (byName && !agrees) conflicts.push(`The NDC on the label is for ${titleCase(byNdc.generic || byNdc.brand)}, but the name reads like ${displayName(byName.best)}. Check which is right.`);
    const rxInfo = agrees ? byName.best : (await withTimeout(resolveWords([byNdc.generic || byNdc.brand]).catch(() => null), 6000))?.best;
    return { ...byNdc, rx: rxInfo && { rxcui: rxInfo.rxcui, ingredients: rxInfo.ingredients }, alternatives: byName && !agrees ? [{ name: displayName(byName.best), word: byName.best.word }] : [], conflicts, confident: !conflicts.length };
  }
  if (byName) {
    const b = byName.best, ing = b.ingredients.map(i => i.name.toUpperCase());
    // A brand word (LIPITOR) searches the brand first; otherwise the ingredient (ATORVASTATIN).
    const tries = [...new Set([...(b.tty === 'BN' ? [b.name.toUpperCase()] : []), ing.join(' AND '), ...ing])];
    const strengthP = strength && b.ingredients.length === 1 ? withTimeout(strengthKnown(b.ingredients[0].rxcui, strength).catch(() => null), 6000) : Promise.resolve(undefined);
    let l = null;
    for (const w of tries) if ((l = await labelByWord(w))) break;
    const strengthOk = await strengthP;
    return { ...(l ? labelInfo(l) : { brand: b.tty === 'BN' ? b.name : '', generic: ing.join(' / ') }), matched: b.word, via: 'rxnorm', ...(strengthOk !== undefined && { strengthOk }),
      rx: { rxcui: b.rxcui, ingredients: b.ingredients }, alternatives: byName.alternatives, conflicts, confident: b.sim >= 0.9 && !byName.alternatives.length };
  }
  for (const w of words.slice(0, 8)) {
    const l = await labelByWord(w);
    if (l) return { ...labelInfo(l), matched: w, via: 'openfda', alternatives: [], conflicts, confident: false };
  }
  return null;
}
// The "TAKE…" line, plus up to two wrapped lines after it, stopping at the next label field (QTY, REFILLS, RX#…).
const directionsIn = text => {
  const lines = String(text).split(/\n/).map(l => l.trim()).filter(Boolean), i = lines.findIndex(l => /\bTAKE\b/i.test(l));
  if (i < 0) return '';
  const out = [lines[i].slice(lines[i].search(/\bTAKE\b/i))];
  for (const l of lines.slice(i + 1, i + 3)) { if (/\b(QTY|QUANTITY|REFILL|RX|NDC|DR\.?|DISCARD|FILLED|DATE|MFG|LOT)\b|^\d/i.test(l)) break; out.push(l); }
  return out.join(' ').replace(/\s+/g, ' ').slice(0, 200);
};
const sigFrom = (directions, ai = {}) => {
  const p = parseSig(directions);
  if (!p.times.length && !p.asNeeded && ai.dosesPerDay >= 1 && ai.dosesPerDay <= 4) p.times = [['08:00'], ['08:00', '20:00'], ['08:00', '14:00', '20:00'], ['08:00', '12:00', '16:00', '20:00']][Math.round(ai.dosesPerDay) - 1];
  if (ai.asNeeded) { p.asNeeded = true; if (!/\b(daily|times|twice|every)\b/i.test(directions)) p.times = []; }
  if (!p.unitsPerDose && ai.unitsPerDose > 0) p.unitsPerDose = ai.unitsPerDose;
  return directions || p.times.length || p.asNeeded ? { ...p, directions } : null;
};

app.get('/api/drug', auth, async (req, res) => {
  const q = clean(req.query.q).toUpperCase();
  if (!q) throw bad('Type a medication name');
  const c = extractCandidates(q);
  // "metformin 500 mg" → METFORMIN; each word on its own too, so "lipitor tablets" and "metf0rmin" still match.
  const words = [...new Set([q.replace(/\s+\d.*$/, ''), ...q.split(/\s+/).filter(w => /[A-Z]{3}/.test(w) && w.length >= 4), ...c.words])].filter(Boolean);
  const info = await lookupDrug({ ndc: c.ndc, words, userId: req.userId });
  res.json({ info, strength: c.strength, candidates: c.words, alternatives: info?.alternatives || [] });
});

// Barcode: the browser decodes the code to a 10-digit NDC; try each way it can split.
app.get('/api/drug/ndc', auth, async (req, res) => {
  const d10 = String(req.query.ndc || '').replace(/\D/g, '');
  if (d10.length !== 10) throw bad('That barcode does not hold a drug code');
  res.json({ info: await lookupDrug({ ndc: productNdcSplits(d10) }), barcode: true });
});

app.post('/api/drug/scan', auth, async (req, res) => {
  const text = str(req.body.text, 5000, 'Label text');
  const c = extractCandidates(text);
  const info = await lookupDrug({ ...c, userId: req.userId });
  res.json({ info, strength: c.strength, candidates: c.words, alternatives: info?.alternatives || [], sig: sigFrom(directionsIn(text)), look: pillLook(text) });
});

// The user picked the right drug for words the reader got wrong: remember it for their next scans.
app.post('/api/drug/fix', auth, async (req, res) => {
  const name = clean(req.body.name);
  const words = (Array.isArray(req.body.words) ? req.body.words : []).map(w => clean(w).toUpperCase()).filter(w => w.length >= 3).slice(0, 3);
  if (!name || !words.length) throw bad('Nothing to remember');
  await Promise.all(words.map(word => scanfixes.updateOne({ userId: req.userId, word }, { $set: { name, at: new Date() } }, { upsert: true })));
  res.json({ ok: true });
});

// After a match: already tracked? open recalls? label interaction mentions with the user's other meds?
// Each part fails soft (empty) so one slow service never blocks the others.
app.post('/api/drug/checks', auth, async (req, res) => {
  const generic = clean(req.body.generic), brand = clean(req.body.brand), ndc = /^\d{4,5}-\d{3,4}$/.test(req.body.ndc) ? req.body.ndc : '';
  const lot = clean(req.body.lot);
  const ingredients = Array.isArray(req.body.ingredients) && req.body.ingredients.length
    ? req.body.ingredients.slice(0, 4).map(i => ({ rxcui: clean(i.rxcui), name: clean(i.name) }))
    : await ingredientsFor(generic || brand);
  const soft = p => withTimeout(p.catch(() => null), 12000);
  const [duplicate, recalls, interactions] = await Promise.all([
    soft(duplicateOf(req.userId, ingredients, null, req.body.strength)),
    soft(recallsFor({ ndc, generic: generic || ingredients[0]?.name, lot })),
    soft(interactionsFor(req.userId, { generic, brand, ingredients })),
  ]);
  res.json({ duplicate, recalls: recalls || [], interactions: interactions || [] });
});

async function activeMedsWithIngredients(userId) {
  const list = await meds.find({ userId, active: true }).toArray();
  await Promise.all(list.filter(m => !m.ingredients?.length).map(async m => { // meds saved before RxNorm matching: fill in once
    m.ingredients = await ingredientsFor(m.name);
    if (m.ingredients.length) await meds.updateOne({ _id: m._id }, { $set: { ingredients: m.ingredients } });
  }));
  return list;
}
async function duplicateOf(userId, ingredients, exceptId, dose) {
  if (!ingredients?.length) return null;
  const key = ingredients.map(i => i.rxcui).sort().join('+');
  const m = (await activeMedsWithIngredients(userId)).find(x => String(x._id) !== String(exceptId || '') && x.ingredients?.length && x.ingredients.map(i => i.rxcui).sort().join('+') === key);
  if (!m) return null;
  const n = v => (/(\d+(?:\.\d+)?)\s*(mg|mcg|g|ml)/i.exec(v || '') || []).slice(1).join(' ').toLowerCase();
  return { id: String(m._id), name: m.name, dose: m.dose, sameStrength: !dose || !m.dose || n(dose) === n(m.dose) };
}

// openFDA recall reports still open for this product. FDA: posted only after classification, status not updated after;
// so the UI words this as "ask your pharmacy", and only says "your lot" when the lot number matches.
async function recallsFor({ ndc, generic, lot }) {
  const q = ndc ? `openfda.product_ndc:"${ndc}"` : generic ? `openfda.generic_name:"${generic.toUpperCase()}"` : '';
  if (!q) return [];
  const d = await fda('enforcement', `${q} AND status:"Ongoing"`, 5);
  const norm = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (d?.results || []).map(r => ({
    classification: r.classification || '', reason: clip(r.reason_for_recall || '', 220), product: clip(r.product_description || '', 160),
    date: /^\d{8}$/.test(r.recall_initiation_date) ? `${r.recall_initiation_date.slice(0, 4)}-${r.recall_initiation_date.slice(4, 6)}-${r.recall_initiation_date.slice(6)}` : '',
    lotMatch: lot ? norm(r.code_info).includes(norm(lot)) : null,
  }));
}

// Label text that names another of the user's meds, both directions. Quotes the label; never judges severity.
// Rx labels have a drug interactions section; OTC labels put the same warnings under "Ask a doctor or pharmacist" / "Do not use".
const interactionText = l => clip([first(l?.drug_interactions), first(l?.ask_doctor_or_pharmacist), first(l?.do_not_use), first(l?.contraindications)].filter(Boolean).join(' '), 6000);
async function interactionsFor(userId, { generic, brand, ingredients }) {
  const newName = titleCase(ingredients[0]?.name || generic || brand || '');
  const newNames = [...new Set([...ingredients.map(i => i.name), generic, brand].filter(Boolean))];
  const newKey = ingredients.map(i => i.rxcui).sort().join('+');
  const [newLabel, all] = await Promise.all([labelByWord((ingredients[0]?.name || generic || brand || '').toUpperCase()).catch(() => null), activeMedsWithIngredients(userId)]);
  const others = all.filter(m => m.ingredients?.map(i => i.rxcui).sort().join('+') !== newKey).slice(0, 8);
  const seen = new Set(), unique = others.filter(m => { const k = titleCase(m.ingredients?.[0]?.name || m.name); return !seen.has(k) && seen.add(k); }); // same drug twice → one note
  const notes = await Promise.all(unique.map(async m => {
    const otherName = titleCase(m.ingredients?.[0]?.name || m.name);
    // This drug's label naming the other med, else the other med's label naming this drug.
    const fwd = mentionsOf(interactionText(newLabel), [m.name, ...(m.ingredients || []).map(i => i.name)])[0];
    if (fwd) return { labelOf: newName, mentions: otherName, snippet: fwd.snippet };
    const l = await labelByWord((m.ingredients?.[0]?.name || m.name).toUpperCase()).catch(() => null);
    const back = mentionsOf(interactionText(l), newNames)[0];
    return back ? { labelOf: otherName, mentions: newName, snippet: back.snippet } : null;
  }));
  const out = notes.filter(Boolean);
  return out;
}

// ---------- dose intervals ----------
// How long between doses of this med, for its timer. Order: the user's own number, then Pip (Gemini) reading the user's
// directions, reminder times and the FDA label's dosing, then the directions parsed by rule, then the reminder times.
function fallbackInterval(m) {
  const h = hoursFromDirections(m.instructions);
  return h ? { hours: h, by: 'directions', basis: `Your directions: “${m.instructions}”` } : { hours: scheduleHours(m.times), by: 'schedule', basis: `${m.times.length === 1 ? 'Once' : `${m.times.length} times`} a day, from your reminder times` };
}
const INTERVAL_SCHEMA = { type: 'OBJECT', required: ['hours', 'basis'], properties: { hours: { type: 'NUMBER' }, basis: STR_T, from: STR_T } };
async function intervalFor(m, aiOk) {
  if (m.intervalHours) return { hours: m.intervalHours, by: 'you', basis: 'You set this' };
  if (GEMINI_KEY && aiOk) {
    try {
      const w = (m.ingredients?.[0]?.name || m.name).toUpperCase().replace(/[^A-Z0-9 -]/g, ' ').trim();
      const label = await withTimeout(lookupDrug({ ndc: [], words: [w] }).catch(() => null), 6000);
      const o = await withTimeout(ask(`A patient tracks this medicine in PillPal.
Name: ${m.name}${label?.generic ? ` (${label.generic})` : ''}. Dose: ${m.dose || 'not given'}. Their directions: ${m.instructions || 'none written'}. Their reminder times: ${m.times.join(', ')}.
FDA label dosing excerpt: ${label?.dosage || 'not available'}
How many hours should pass between doses for THIS patient? Their own written directions come first ("every 6 hours" = 6, "twice daily" = 12, "once daily" = 24, "once weekly" = 168). If they don't say, use how many reminder times they set per day, then the label's usual adult dosing. Never pick a shorter gap than the label allows.
Return JSON: {"hours": number, "basis": "under 14 words: what this is based on", "from": "your directions" | "your reminder times" | "the FDA label"}`,
        { json: true, schema: INTERVAL_SCHEMA, models: [[GEMINI_MODEL, 'low'], ['gemini-3.6-flash', 'low'], [FAST_MODEL, 'low']] }), 15000);
      const hours = Math.round(+o?.hours * 4) / 4;
      if (hours >= 0.5 && hours <= 168) return { hours, by: 'pip', basis: s(o.basis, 140) || 'Pip read your directions and the FDA label', from: s(o.from, 40) };
    } catch (e) { console.error('interval: Pip could not work it out:', e.message); }
  }
  return fallbackInterval(m);
}
// Works out intervals for any of the user's meds that don't have one yet (new, edited, or saved before timers existed).
app.post('/api/meds/intervals', auth, async (req, res) => {
  const u = await users.findOne({ _id: req.userId });
  const list = await meds.find({ userId: req.userId, active: true }).toArray();
  await Promise.all(list.filter(m => !m.interval?.hours).map(async m => {
    m.interval = { ...(await intervalFor(m, !u.prefs?.noAi && !u.demo)), at: new Date() };
    await meds.updateOne({ _id: m._id }, { $set: { interval: m.interval } });
  }));
  res.json(list.map(m => ({ id: String(m._id), interval: m.interval })));
});

// Pip's mix check: every pair of the user's active meds where one label names the other (or its drug class).
// Quotes the label and keeps its own wording's strength (avoid vs. caution); Pip never decides beyond that.
const mixCache = new Map(); // ponytail: in-memory, per process
app.get('/api/meds/mixes', auth, async (req, res) => {
  if ((await users.findOne({ _id: req.userId }))?.demo) return res.json(demoMixes(await meds.find({ userId: req.userId, active: true }).toArray()));
  const list = await activeMedsWithIngredients(req.userId);
  const seen = new Set();
  const uniq = list.filter(m => { const k = m.ingredients?.length ? m.ingredients.map(i => i.rxcui).sort().join('+') : m.name.toLowerCase(); return !seen.has(k) && seen.add(k); }).slice(0, 10);
  const word = m => (m.ingredients?.[0]?.name || m.name).toUpperCase();
  const labels = await Promise.all(uniq.map(m => withTimeout(labelByWord(word(m)).catch(() => null), 10000)));
  const names = uniq.map(m => mixNames(m.name, (m.ingredients || []).map(i => i.name)));
  const pairs = [];
  for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) {
    const fwd = mentionsOf(interactionText(labels[i]), names[j])[0], back = !fwd && mentionsOf(interactionText(labels[j]), names[i])[0];
    const hit = fwd || back;
    if (!hit) continue;
    const [by, other] = fwd ? [uniq[i], uniq[j]] : [uniq[j], uniq[i]];
    pairs.push({ a: { id: String(uniq[i]._id), name: uniq[i].name }, b: { id: String(uniq[j]._id), name: uniq[j].name },
      labelOf: by.name, mentions: other.name, term: hit.name, snippet: hit.snippet, level: mixLevel(hit.snippet) });
  }
  pairs.sort((x, y) => (x.level === 'avoid' ? 0 : 1) - (y.level === 'avoid' ? 0 : 1));
  // Pip rewords each label quote in plain words (one Gemini call, cached). The label quote always stays alongside.
  const u = pairs.length && GEMINI_KEY ? await users.findOne({ _id: req.userId }) : null;
  if (u && !u.prefs?.noAi) {
    const key = pairs.map(p => `${p.labelOf}|${p.mentions}|${p.snippet}`).join('\n');
    let plain = mixCache.get(key);
    if (!plain) {
      plain = await withTimeout(ask(`For each numbered pair, write ONE short plain-language sentence (under 25 words) saying what this FDA label text warns could happen when the two are taken together. Only restate the label; never tell anyone to stop, skip or change a medicine.
${pairs.map((p, i) => `${i + 1}. ${p.labelOf} + ${p.mentions}. Label text: "${p.snippet}"`).join('\n')}
Return JSON: {"plain": ["sentence for pair 1", "..."]}`, { json: true, models: [[GEMINI_MODEL, 'low'], ['gemini-3.6-flash', 'low'], [FAST_MODEL, 'low']] }).then(o => arr(o.plain)).catch(() => null), 9000);
      if (plain?.length === pairs.length) { if (mixCache.size > 200) mixCache.clear(); mixCache.set(key, plain); }
    }
    if (plain?.length === pairs.length) pairs.forEach((p, i) => (p.plain = plain[i]));
  }
  res.json({ pairs, checked: uniq.length });
});

// ---------- ClinicalTrials.gov ----------
// Its firewall turns away some HTTP clients by their TLS fingerprint, so: Node's fetch first, then node:https.
// If both are refused, the browser is told to call the API itself (a real browser gets through) and is always
// given a working ClinicalTrials.gov website link for the same search.
const CT_HEADERS = { Accept: 'application/json', 'User-Agent': 'PillPal/1.0 (medication tracker)' };
function httpsJson(url) {
  return new Promise((ok, fail) => {
    const r = https.get(url, { headers: CT_HEADERS, timeout: 10000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => (body += c));
      res.on('end', () => {
        if (res.statusCode === 404) return ok(null);
        if (res.statusCode >= 400) return fail(Object.assign(new Error(`ClinicalTrials.gov answered ${res.statusCode}`), { status: res.statusCode }));
        try { ok(JSON.parse(body)); } catch { fail(new Error('ClinicalTrials.gov sent something that isn’t JSON')); }
      });
    });
    r.on('timeout', () => r.destroy(new Error('ClinicalTrials.gov timed out')));
    r.on('error', fail);
  });
}
async function ctgov(path) {
  const url = 'https://clinicaltrials.gov/api/v2' + path;
  if (cache.has(url)) return cache.get(url);
  let data;
  try {
    const r = await fetch(url, { headers: CT_HEADERS, signal: AbortSignal.timeout(10000) });
    if (r.status === 404) data = null;
    else if (!r.ok) throw new Error(`answered ${r.status}`);
    else data = await r.json();
  } catch (e) {
    console.error(`ClinicalTrials.gov via fetch failed (${e.message}); retrying with node:https`);
    data = await httpsJson(url);
  }
  if (cache.size > 500) cache.clear();
  cache.set(url, data);
  return data;
}
const ageOf = p => (p?.birthYear ? new Date().getFullYear() - p.birthYear : null);
app.get('/api/trials', auth, async (req, res) => {
  const cond = clean(req.query.cond), intr = clean(req.query.intr), loc = clean(req.query.loc);
  if (!cond && !intr) throw bad('Enter a condition or a medication');
  const p = new URLSearchParams({ 'filter.overallStatus': 'RECRUITING', pageSize: '12', fields: STUDY_FIELDS });
  if (cond) p.set('query.cond', cond);
  if (intr) p.set('query.intr', intr);
  if (loc) p.set('query.locn', loc);
  const searchUrl = ctgovSearchUrl({ cond, intr, loc }), profile = (await users.findOne({ _id: req.userId })).profile || {};
  try {
    const data = await ctgov('/studies?' + p);
    const studies = (data?.studies || []).map(x => mapStudy(x, loc)).filter(t => t.id).map(t => ({ ...t, fit: quickFit(t, { age: ageOf(profile), sex: profile.sex }) }));
    res.json({ studies, searchUrl });
  } catch (e) {
    console.error('ClinicalTrials.gov search failed:', e.message);
    res.json({ blocked: true, apiUrl: 'https://clinicaltrials.gov/api/v2/studies?' + p, searchUrl, profile: { age: ageOf(profile), sex: profile.sex } });
  }
});
// One study, to check an ID and show its title and status (meds with a trial ID, My studies).
app.get('/api/trials/:id', auth, async (req, res) => {
  const id = String(req.params.id).toUpperCase();
  if (!/^NCT\d{8}$/.test(id)) throw bad('Study IDs look like NCT12345678');
  const url = `https://clinicaltrials.gov/study/${id}`;
  try {
    const data = await ctgov(`/studies/${id}?fields=${STUDY_FIELDS}`);
    res.json(data ? { found: true, url, ...mapStudy(data) } : { found: false, id, url });
  } catch (e) { res.json({ blocked: true, id, url, apiUrl: `https://clinicaltrials.gov/api/v2/studies/${id}?fields=${STUDY_FIELDS}` }); }
});
// Pip's pre-check: the study's eligibility criteria against the user's profile, meds and measurements.
// Says "likely / maybe / unlikely" with reasons; the study team always decides.
app.post('/api/trials/:id/precheck', auth, async (req, res) => {
  const id = String(req.params.id).toUpperCase();
  if ((await users.findOne({ _id: req.userId }))?.demo) return res.json(demoPrecheck(id, { title: s(req.body.title, 200) }));
  const u = await aiUser(req);
  if (!/^NCT\d{8}$/.test(id)) throw bad('Study IDs look like NCT12345678');
  let t = null;
  try { const d = await ctgov(`/studies/${id}?fields=${STUDY_FIELDS}`); t = d && mapStudy(d); } catch { /* fall back to what the browser sent */ }
  const criteria = t?.criteria || str(req.body.criteria, 6000, 'Criteria', false);
  if (!criteria) throw bad('Couldn’t load this study’s eligibility rules right now.');
  const r = await reportFor(u._id, { today: req.body.today, now: req.body.now, days: 30 }), p = u.profile || {};
  const list = await meds.find({ userId: u._id, active: true }).toArray();
  const about = [`Age: ${ageOf(p) ?? 'unknown'}`, `Sex: ${p.sex || 'unknown'}`, `Conditions: ${p.conditions?.join(', ') || 'not given'}`,
    `Medications: ${list.map(m => `${m.name}${m.dose ? ' ' + m.dose : ''}`).join(', ') || 'none'}`,
    `Recent measurements: ${r.vitals.map(v => `${v.label} ${vitalText(v.latest)} ${v.unit}`).join('; ') || 'none'}`].join('\n');
  const o = await ask(`A patient is curious whether they might qualify for clinical trial ${id}${t?.title ? ` ("${t.title}")` : ''}.
Study eligibility criteria:\n${criteria.slice(0, 5000)}\n\nWhat PillPal knows about the patient:\n${about}
Compare them. Only use the facts given; when something isn't known, list it as a question for the study team instead of guessing.
Return JSON: {"verdict": "likely" | "maybe" | "unlikely", "summary": "one plain sentence", "matches": ["up to 3 criteria they appear to meet"], "concerns": ["up to 3 criteria that may rule them out"], "ask": ["up to 3 things to ask or check with the study team"]}`,
    { json: true, models: [[GEMINI_MODEL, 'low'], ['gemini-3.6-flash', 'low'], [FAST_MODEL, 'low']] });
  res.json({ verdict: ['likely', 'maybe', 'unlikely'].includes(o.verdict) ? o.verdict : 'maybe', summary: s(o.summary, 300), matches: arr(o.matches), concerns: arr(o.concerns), ask: arr(o.ask) });
});
// "Send to my study team": doses of the study medicine, side effects in detail, measurements and notes, as plain text.
app.get('/api/study-summary', auth, async (req, res) => {
  const u = await users.findOne({ _id: req.userId }), nct = String(req.query.nct || '').toUpperCase();
  const st = (u.studies || []).find(x => x.nctId === nct) || { nctId: nct };
  const days = Math.min(Math.max(+req.query.days || 30, 1), 365);
  const r = await reportFor(u._id, { today: req.query.today, now: req.query.now, days });
  const studyMeds = r.meds.filter(m => m.trialId === nct);
  const L = [`PillPal update for study ${nct}${st.title ? ` (${st.title})` : ''}`, `Participant: ${u.name}${st.participantId ? `, ID ${st.participantId}` : ''}`,
    `Period: ${r.from} to ${r.to} (${days} days)`, ''];
  L.push('Study medication:', ...(studyMeds.length ? studyMeds.map(m => `- ${m.name}${m.dose ? ' ' + m.dose : ''}: ${m.adherence ?? 'n/a'}% of doses taken (${m.taken}/${m.scheduled}), ${m.missed} missed, ${m.skipped} skipped${m.recentMissed.length ? `; last missed ${m.recentMissed.slice(-2).join(', ')}` : ''}`) : ['- No medication in PillPal is linked to this study ID.']));
  L.push('', `Other medications: ${r.meds.filter(m => m.trialId !== nct && m.active).map(m => `${m.name}${m.dose ? ' ' + m.dose : ''}`).join(', ') || 'none'}`);
  L.push('', 'Side effects (adverse events):', ...(r.effects.length ? r.effects.map(e => `- ${e.name}: ${e.severity}, started ${e.startDate}, ${e.endDate ? `ended ${e.endDate}` : 'ongoing'}${e.suspects.length ? `; possibly from ${e.suspects.map(x => x.name).join(', ')}` : ''}${e.serious.er ? '; ER visit' : ''}${e.serious.hospital ? '; hospital stay' : ''}${e.serious.stoppedMed ? '; a medicine was stopped' : ''}${e.notes ? `. "${e.notes}"` : ''}`) : ['- None reported in detail.']));
  if (r.sideEffects.length) L.push(`Daily check-ins also noted: ${r.sideEffects.map(x => `${x.name} (${x.count} days)`).join(', ')}`);
  L.push('', 'Measurements:', ...(r.vitals.length ? r.vitals.map(v => `- ${v.label}: latest ${vitalText(v.latest)} ${v.unit} on ${v.latest.date}; average ${v.avg}${v.avg2 ? '/' + v.avg2 : ''}; range ${v.min} to ${v.max}; ${v.count} readings${v.flagged ? `, ${v.flagged} outside the usual range` : ''}`) : ['- None logged.']));
  const notes = r.notes.slice(0, 5);
  if (notes.length) L.push('', 'Notes and questions:', ...notes.map(n => `- ${n.date}: ${[n.notes, n.questions && 'Question: ' + n.questions].filter(Boolean).join(' / ')}`));
  L.push('', 'Self-reported by the participant with PillPal. Not a medical record.');
  res.json({ text: L.join('\n'), subject: `PillPal update: ${nct}${st.participantId ? ` (participant ${st.participantId})` : ''}`, email: st.coordinatorEmail || '' });
});

// ---------- Gemini: Pip's AI (scan vision, chat, explainers, insights, visit prep) ----------
const PAL_RULES = `You are Pip, the friendly capsule mascot of PillPal, a medication tracking app. Be warm, plain (6th-grade reading level) and brief: usually under 120 words.
Be genuinely helpful, like a knowledgeable pharmacist friend:
- Answer the actual question first, in the first sentence. Don't greet, don't introduce yourself, don't open with what you can't do.
- Questions like "can I take X with my meds?" deserve a real answer: say what is known about combining them (for example "There's no known interaction between ibuprofen and cetirizine"), what the FDA labels warn about, and the practical cautions that matter (stomach, kidneys, blood pressure, drowsiness, alcohol, max daily dose on the label). Name the specific meds involved.
- Check their list for doubles: two products with the same active ingredient (a brand and its generic, or a store brand like "All Day Allergy" that is cetirizine). Point it out clearly, since taking both doubles the dose.
- End with at most one short line about checking with their pharmacist when it really depends on their health (kidney or stomach problems, pregnancy, other conditions). Don't hide the answer behind that line.
Rules you never break:
- You are not a doctor. Never diagnose. Never tell someone to start, stop, skip, double, split or change a prescribed dose; for those decisions say to ask their prescriber or pharmacist. Sharing well-established facts about medicines and the label's own directions is fine.
- If the user describes an emergency (chest pain, trouble breathing, swelling of face or throat, fainting, seizure, possible overdose, thoughts of self-harm), FIRST tell them to call 911 now (Poison Help 1-800-222-1222 for overdose or poisoning, 988 for a mental health crisis).
- Ground facts in the FDA label excerpts and ingredient lists you are given plus well-established pharmacology. Say plainly when something is uncertain.
- Only use the user's data you are given. Never invent doses, times or history.
- Plain text. Short paragraphs or simple "- " bullets. No headings, no tables, no emoji.`;

// Which model answers, and how much it "thinks" first (thinking adds seconds; reading a label needs little).
// Busy (429/5xx) or not available to this key (403/404): retry once, then the next model in the plan.
// Gemini 3.6+ ignores temperature/top_p/top_k and newer models reject them, so none are sent.
const MODELS = [[GEMINI_MODEL, 'low'], [GEMINI_MODEL, 'low'], ['gemini-3.6-flash', 'low'], [FAST_MODEL, 'minimal']];
const SCAN_MODELS = [[FAST_MODEL, 'minimal'], [GEMINI_MODEL, 'low'], [GEMINI_MODEL, 'low'], ['gemini-3.6-flash', 'low']];
const thinkingFor = (model, level) => !level ? null : /2\.5/.test(model) ? { thinkingBudget: /pro/.test(model) ? 128 : 0 }
  : { thinkingLevel: level === 'minimal' && /3\.8|pro/.test(model) ? 'low' : level }; // 3.8 Flash has no "minimal"
// Last result, shown in Settings and the server log, so a bad key or model is easy to spot.
const aiStatus = { ok: null, model: GEMINI_MODEL, error: '', at: null };
const keyProblem = (status, msg) => status === 401 || /api[ _-]?key|unauthenticated|access_token|credential|permission denied/i.test(msg) && [400, 401, 403].includes(status);
async function gemini({ system = PAL_RULES, contents, json = false, schema = null, models = null }) {
  const plan = models || MODELS;
  let r, data, i = 0, noThinking = false, plain = false;
  while (i < plan.length) {
    const [model, level] = plan[i], thinking = noThinking || plain ? null : thinkingFor(model, level), sch = plain ? null : schema;
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      signal: AbortSignal.timeout(45000),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { ...(json && { responseMimeType: 'application/json' }), ...(sch && { responseSchema: sch }), ...(thinking && { thinkingConfig: thinking }) },
      }),
    }).catch(e => ({ ok: false, status: 0, json: async () => ({ error: { message: `Couldn't reach Google: ${e.message}` } }) }));
    data = await r.json().catch(() => ({}));
    if (r.ok) { Object.assign(aiStatus, { ok: true, model, error: '', at: new Date() }); break; }
    const msg = data.error?.message || '';
    console.error(`Gemini ${model} → ${r.status}: ${msg}`);
    if (keyProblem(r.status, msg)) {
      Object.assign(aiStatus, { ok: false, model, error: `Google didn't accept the API key: ${msg}`, at: new Date() });
      throw bad("Pip's AI can't sign in to Google: the Gemini API key was rejected. Check GEMINI_API_KEY in .env.", 502);
    }
    // A setting this model rejects (400): drop the optional extras (thinking, schema) and ask the same model again.
    if (r.status === 400 && thinking && /think/i.test(msg)) { noThinking = true; continue; }
    if (r.status === 400 && !plain && (thinking || sch)) { plain = true; continue; }
    // Not available to this key, busy, or still a 400: move on to the next model in the plan.
    Object.assign(aiStatus, { ok: false, model, error: `${model}: ${r.status} ${msg}`.trim(), at: new Date() });
    i++; plain = false; noThinking = false;
    if (i < plan.length && plan[i][0] === model) await new Promise(ok => setTimeout(ok, 800));
  }
  if (!r.ok) throw bad(r.status === 429 ? 'Pip is answering a lot of questions right now. Try again in a minute.' : "Pip's AI is unavailable right now.", 502);
  const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
  if (!text) throw bad("Pip couldn't answer that one. Try asking another way.", 502);
  if (!json) return text;
  try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw bad('Pip got muddled reading that. Please try again.', 502); }
}
// Same model plan and error handling as gemini(), but streams text pieces to onText as they arrive.
// Falls back to the next model only if nothing has been sent yet.
async function geminiStream({ system = PAL_RULES, contents, models }, onText) {
  let i = 0, noThinking = false, sent = false, lastErr = '', lastStatus = 0;
  while (i < models.length) {
    const [model, level] = models[i], thinking = noThinking ? null : thinkingFor(model, level);
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST', signal: AbortSignal.timeout(45000),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { ...(thinking && { thinkingConfig: thinking }) } }),
    }).catch(e => ({ ok: false, status: 0, json: async () => ({ error: { message: `Couldn't reach Google: ${e.message}` } }) }));
    if (!r.ok) {
      const msg = (await r.json().catch(() => ({}))).error?.message || '';
      console.error(`Gemini ${model} (stream) → ${r.status}: ${msg}`);
      if (keyProblem(r.status, msg)) {
        Object.assign(aiStatus, { ok: false, model, error: `Google didn't accept the API key: ${msg}`, at: new Date() });
        throw bad("Pip's AI can't sign in to Google: the Gemini API key was rejected. Check GEMINI_API_KEY in .env.", 502);
      }
      if (r.status === 400 && thinking) { noThinking = true; continue; }
      lastErr = msg; lastStatus = r.status; i++; noThinking = false;
      continue;
    }
    Object.assign(aiStatus, { ok: true, model, error: '', at: new Date() });
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const t = (JSON.parse(line.slice(5)).candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
          if (t) { sent = true; onText(t); }
        } catch { /* partial or keep-alive line */ }
      }
    }
    if (sent) return;
    lastErr = 'empty reply'; i++;
  }
  Object.assign(aiStatus, { ok: false, error: lastErr, at: new Date() });
  throw bad(lastStatus === 429 ? 'Pip is answering a lot of questions right now. Try again in a minute.' : "Pip's AI is unavailable right now.", 502);
}
// At startup: is the key accepted, and can it use the model? Logged, and shown in Settings.
async function checkGemini() {
  if (!GEMINI_KEY) return console.log('Gemini: no GEMINI_API_KEY set, so AI features are off.');
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}`, { headers: { 'x-goog-api-key': GEMINI_KEY }, signal: AbortSignal.timeout(10000) });
    const d = await r.json().catch(() => ({}));
    Object.assign(aiStatus, r.ok ? { ok: true, error: '' } : { ok: false, error: keyProblem(r.status, d.error?.message || '') ? `Google didn't accept the API key: ${d.error?.message}` : `${GEMINI_MODEL}: ${r.status} ${d.error?.message || ''}` }, { at: new Date() });
    console.log(r.ok ? `Gemini: key works, using ${GEMINI_MODEL} (fast reads: ${FAST_MODEL}).` : `Gemini check FAILED: ${aiStatus.error}`);
  } catch (e) { Object.assign(aiStatus, { ok: false, error: `Couldn't reach Google: ${e.message}`, at: new Date() }); console.log(`Gemini check FAILED: ${aiStatus.error}`); }
}
app.get('/api/ai/status', auth, (req, res) => res.json({ configured: !!GEMINI_KEY, ...aiStatus }));

// ---------- demo mode ----------
// A separate, throwaway account filled with a 60-day showcase story (demo.js). Pip's answers there are pre-written,
// so a presentation never waits on, or depends on, Gemini. Demo accounts older than a day are tidied away.
const userColls = () => [meds, doses, checkins, medcheckins, scanfixes, vitals, effects];
async function seedDemo(userId, b) {
  await Promise.all(userColls().map(c => c.deleteMany({ userId })));
  const today = date(b.today, 'today'), now = TIME.test(b.now) ? b.now : '12:00', tz = Number.isFinite(+b.tz) && Math.abs(+b.tz) <= 840 ? +b.tz : 0;
  const d = buildDemo({ today, now, tz });
  const ids = [], byKey = {};
  for (const { key, ...m } of d.meds) { const id = (await meds.insertOne({ ...m, userId })).insertedId; ids.push(id); byKey[key] = { id: String(id), name: m.name, trialId: m.trialId }; }
  await Promise.all([
    doses.insertMany(d.doses.map(({ mi, ...x }) => ({ ...x, userId, medId: String(ids[mi]) }))),
    checkins.insertMany(d.checkins.map(c => ({ ...c, userId }))),
    medcheckins.insertMany(d.medcheckins.map(({ mi, ...c }) => ({ ...c, userId, medId: String(ids[mi]) }))),
    vitals.insertMany(d.vitals.map(v => ({ ...v, note: v.note || '', userId, flag: vitalFlag(v)?.level || null }))),
    effects.insertMany(d.effects.map(e => ({ ...e, suspects: e.suspects.map(k => byKey[k]).filter(Boolean), userId, createdAt: new Date(), updatedAt: new Date() }))),
    users.updateOne({ _id: userId }, { $set: { profile: d.profile, studies: d.studies } }),
  ]);
  ctxCache.delete(String(userId));
}
app.post('/api/demo/start', async (req, res) => {
  for (const u of await users.find({ demo: true, createdAt: { $lt: new Date(Date.now() - 864e5) } }).toArray()) {
    await Promise.all([...userColls(), sessions].map(c => c.deleteMany({ userId: u._id })));
    await users.deleteOne({ _id: u._id });
  }
  const { insertedId } = await users.insertOne({ name: 'Denise', email: `demo-${crypto.randomBytes(6).toString('hex')}@demo.pillpal`, passHash: '', demo: true, prefs: {}, createdAt: new Date() });
  await seedDemo(insertedId, req.body);
  await startSession(res, insertedId);
  res.status(201).json(publicUser(await users.findOne({ _id: insertedId })));
});
app.post('/api/demo/reset', auth, async (req, res) => {
  const u = await users.findOne({ _id: req.userId });
  if (!u?.demo) throw bad('Only demo accounts can be reset', 403);
  await seedDemo(u._id, req.body);
  res.json({ ok: true });
});
// Demo accounts: Pip's AI features answer from demo.js (label scanning still reads the photo for real).
app.use('/api/ai', auth, async (req, res, next) => {
  if (req.method !== 'POST' || req.path === '/scan') return next();
  const u = await users.findOne({ _id: req.userId });
  if (!u?.demo) return next();
  const q = req.body || {}, week = () => reportFor(u._id, { ...q, days: 7 });
  if (req.path === '/warm') return res.json({ ok: true });
  if (req.path === '/chat' || req.path === '/chat/stream') {
    const { contents, urgent } = chatInput(req);
    const reply = urgent ? SAFETY : demoChat(contents.at(-1).parts[0].text, await week(), await meds.find({ userId: u._id, active: true }).toArray());
    if (req.path === '/chat') return res.json({ reply, urgent });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    for (const w of reply.split(/(?<=\s)/)) { res.write(`data: ${JSON.stringify({ t: w, urgent })}\n\n`); await new Promise(ok => setTimeout(ok, 16)); }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    return res.end();
  }
  if (req.path === '/explain') return res.json(demoExplain(clean(q.name)));
  if (req.path === '/insight') return res.json({ note: demoInsight(await week()) });
  if (req.path === '/visit-prep') return res.json(demoVisitPrep(await reportFor(u._id, q)));
  next();
});
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
  if (recent.length >= 20) throw bad('Pip needs a short breather. Try again in a minute.', 429);
  aiCalls.set(k, [...recent, now]);
  return u;
}

async function labelFacts(name) {
  const w = name.toUpperCase().replace(/[^A-Z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim();
  const i = w && await lookupDrug({ ndc: [], words: [w] }).catch(() => null);
  return i ? `${name} (FDA label: ${titleCase(i.brand || i.generic)}). Used for: ${i.uses || 'n/a'} Warnings: ${i.boxedWarning || i.warnings || 'n/a'} Side effects: ${i.sideEffects || 'n/a'}` : '';
}

async function patientContext(u, q, { labels = true } = {}) {
  const [list, r, feel] = await Promise.all([withTimeout(activeMedsWithIngredients(u._id), 3000).then(l => l || meds.find({ userId: u._id, active: true }).toArray()), reportFor(u._id, { ...q, days: 7 }),
    medcheckins.find({ userId: u._id }).sort({ at: -1 }).limit(6).toArray()]);
  // Label lookups are cached after the first time; a slow FDA/RxNorm reply is skipped rather than holding up Pip.
  const facts = labels ? (await Promise.all(list.slice(0, 6).map(m => withTimeout(labelFacts(m.name).catch(() => ''), 2500, '')))).filter(Boolean) : [];
  return [
    `First name: ${u.name}. Today: ${r.to}, local time ${TIME.test(q.now) ? q.now : 'unknown'}.`,
    `Current medications: ${list.map(m => `${m.name}${m.ingredients?.length ? ` [active ingredient: ${m.ingredients.map(i => i.name).join(' + ')}]` : ''}${m.dose ? ' ' + m.dose : ''} at ${m.times.join(', ')}${m.reason ? ` for ${m.reason}` : ''}${m.instructions ? ` (${m.instructions})` : ''}${m.trialId ? ` [clinical trial ${m.trialId}]` : ''}`).join('; ') || 'none added yet'}.`,
    `Last 7 days: ${r.adherence ?? 'n/a'}% of doses taken (${r.taken}/${r.scheduled}), streak ${r.streak} days, average mood ${r.moodAvg ?? 'n/a'}/5, side effects: ${r.sideEffects.map(x => `${x.name} on ${x.count} days`).join(', ') || 'none reported'}${r.flagged.length ? `; flagged 3+ days: ${r.flagged.join(', ')}` : ''}.`,
    r.vitals.length ? `Measurements, last 7 days: ${r.vitals.map(v => `${v.label} latest ${vitalText(v.latest)} ${v.unit}${v.type === 'glucose' && v.latest.context ? ` (${v.latest.context})` : ''}, average ${v.avg}${v.avg2 ? '/' + v.avg2 : ''}${v.flagged ? `, ${v.flagged} flagged` : ''}`).join('; ')}.` : '',
    r.effects.length ? `Side effects reported in detail: ${r.effects.slice(0, 6).map(e => `${e.name} (${e.severity}, from ${e.startDate}${e.endDate ? ` to ${e.endDate}` : ', ongoing'}${e.suspects.length ? `, suspected: ${e.suspects.map(x => x.name).join(', ')}` : ''}${isSerious(e) ? ', SERIOUS' : ''})`).join('; ')}.` : '',
    feel.length ? `How they said they felt after recent doses (1 = awful, 5 = great): ${feel.map(f => `${f.date} ${f.medName}: ${f.mood}/5${f.sideEffects.length ? `, ${f.sideEffects.join(', ')}` : ''}${f.notes ? ` ("${f.notes.slice(0, 160)}")` : ''}`).join(' | ')}` : '',
    r.notes.length ? `Recent notes: ${r.notes.slice(0, 3).map(n => `${n.date}: ${[n.notes, n.questions && 'Question: ' + n.questions].filter(Boolean).join(' / ')}`).join(' | ')}` : '',
    facts.length ? `FDA label excerpts:\n${facts.join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

// Chat answers fast: 3.6 Flash with minimal thinking first (smarter than Flash-Lite, still quick), the reply streamed to the browser as it's written,
// and the user's context built once and reused (rebuilt when their data changes, or after a minute).
const CHAT_MODELS = [['gemini-3.6-flash', 'minimal'], [FAST_MODEL, 'minimal'], [GEMINI_MODEL, 'low']];
async function chatContext(u, q) {
  const k = String(u._id), c = ctxCache.get(k);
  if (c && Date.now() - c.at < 60e3) return c.ctx;
  const ctx = await patientContext(u, q);
  if (ctxCache.size > 500) ctxCache.clear();
  ctxCache.set(k, { at: Date.now(), ctx });
  return ctx;
}
function chatInput(req) {
  const msgs = Array.isArray(req.body.messages) ? req.body.messages.slice(-16) : [];
  if (msgs.at(-1)?.role !== 'user') throw bad('Ask Pip a question');
  const contents = msgs.map(m => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: str(m.text, 2000, 'Message') }] }));
  return { contents, urgent: EMERGENCY.test(contents.at(-1).parts[0].text) };
}
const chatSystem = ctx => `${PAL_RULES}\n\nWhat you know about this user from their PillPal account (private):\n${ctx}`;
// Opening Ask Pip warms the context so the first answer is quick too.
app.post('/api/ai/warm', auth, async (req, res) => { const u = await aiUser(req); await chatContext(u, req.body).catch(() => {}); res.json({ ok: true }); });
app.post('/api/ai/chat', auth, async (req, res) => {
  const u = await aiUser(req), { contents, urgent } = chatInput(req);
  // Emergencies get a fixed safety message first, and still get it if the AI is down.
  let reply = '';
  try { reply = await gemini({ system: chatSystem(await chatContext(u, req.body)), contents, models: CHAT_MODELS }); } catch (e) { if (!urgent) throw e; }
  res.json({ reply: urgent ? `${SAFETY}${reply ? '\n\n' + reply : ''}` : reply, urgent });
});
// Streaming chat (Server-Sent Events): {t: text} chunks as Gemini writes them, then {done: true}.
app.post('/api/ai/chat/stream', auth, async (req, res) => {
  const u = await aiUser(req), { contents, urgent } = chatInput(req);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
  const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
  if (urgent) send({ t: SAFETY + '\n\n', urgent: true });
  try { await geminiStream({ system: chatSystem(await chatContext(u, req.body)), contents, models: CHAT_MODELS }, t => send({ t })); }
  catch (e) { if (!urgent) send({ error: e.message || "Pip's AI is unavailable right now." }); }
  send({ done: true });
  res.end();
});
const EMERGENCY = /overdos|too many (pills|tablets)|took (\d+|ten|a lot|all)\b|double dose|chest pain|can'?t breathe|trouble breathing|short(ness)? of breath|swell|faint|pass(ed)? out|seizure|suicid|kill myself|end my life|self[- ]?harm|poison/i;
const SAFETY = 'If this is an emergency, call 911 now. For a possible overdose or poisoning, call Poison Help at 1-800-222-1222 (free, 24/7). For a mental health crisis, call or text 988.';

// What Gemini must return for a label photo. Strict schema = predictable fields; values are still cross-checked below.
const STR = STR_T, NUM = { type: 'NUMBER', nullable: true };
const LABEL_SCHEMA = { type: 'OBJECT', required: ['found', 'drugName'], properties: {
  found: { type: 'BOOLEAN' }, drugName: STR, genericName: STR, strength: STR, dosageForm: STR, directions: STR, ndc: STR,
  quantity: NUM, refills: NUM, unitsPerDose: NUM, dosesPerDay: NUM, asNeeded: { type: 'BOOLEAN' },
  fillDate: STR, discardAfter: STR, lot: STR, expiration: STR, pharmacy: STR, rxNumber: STR, pillDescription: STR,
  warnings: { type: 'ARRAY', items: STR },
} };
const isoDate = v => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim()); return m ? m[0] : ''; };
const posNum = (v, max) => (Number.isFinite(+v) && +v > 0 && +v <= max ? +v : null);

app.post('/api/ai/scan', auth, async (req, res) => {
  await aiUser(req);
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(req.body.image || '');
  if (!m) throw bad('Send a JPEG, PNG or WebP photo');
  const t0 = Date.now();
  const o = await gemini({ models: SCAN_MODELS,
    system: 'You read pharmacy and medication labels from photos. Copy text exactly as printed. Never guess text you cannot see: leave a field "" (or null for numbers) unless you can read it on the label.',
    json: true, schema: LABEL_SCHEMA,
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: `image/${m[1]}`, data: m[2] } },
      { text: 'Read the medication label in this photo. found = false if no medication label is readable. drugName and genericName as printed; strength like "20 mg"; directions = the "take..." line verbatim; ndc as printed; quantity and refills as numbers; unitsPerDose (tablets or capsules per dose) and dosesPerDay only if the directions state them; asNeeded = true for "as needed" / PRN; fillDate, discardAfter ("discard after" / "use by") and expiration as YYYY-MM-DD; lot; pharmacy; rxNumber; pillDescription = any printed description of how the pill looks; warnings = short warning-sticker texts.' },
    ] }],
  });
  const label = { found: !!o.found, drugName: s(o.drugName), genericName: s(o.genericName), strength: s(o.strength, 40), dosageForm: s(o.dosageForm, 60),
    directions: s(o.directions, 300), ndc: s(o.ndc, 20), quantity: posNum(o.quantity, 10000), refills: Number.isFinite(+o.refills) && o.refills !== null && o.refills !== '' ? Math.max(0, Math.min(99, +o.refills)) : null,
    fillDate: isoDate(o.fillDate), discardAfter: isoDate(o.discardAfter), lot: s(o.lot, 40), expiration: isoDate(o.expiration),
    pharmacy: s(o.pharmacy, 80), rxNumber: s(o.rxNumber, 30), pillDescription: s(o.pillDescription, 200), warnings: arr(o.warnings) };
  if (!label.found) return res.json({ info: null, label, ai: true });
  const up = v => v.toUpperCase().replace(/[^A-Z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = [...new Set([up(label.genericName), up(label.drugName), ...up(label.drugName).split(' ').filter(w => w.length >= 4)])].filter(Boolean);
  const t1 = Date.now();
  const info = await lookupDrug({ ndc: extractCandidates(label.ndc).ndc, words, userId: req.userId, strength: label.strength });
  console.log(`scan timing: Gemini read ${t1 - t0} ms · drug match + checks ${Date.now() - t1} ms`);
  // Cross-check what the model read against the national drug list, so a misread or made-up value can't slip through.
  const conflicts = [...(info?.conflicts || [])];
  if (!info) conflicts.push(`Couldn’t find “${label.drugName || label.genericName}” in the national drug list. Check the spelling on the label.`);
  else if (label.strength && info.rx?.ingredients?.length === 1) {
    const ok = info.strengthOk !== undefined ? info.strengthOk : await withTimeout(strengthKnown(info.rx.ingredients[0].rxcui, label.strength).catch(() => null), 6000);
    if (ok === false) conflicts.push(`${label.strength} isn’t a strength listed for ${titleCase(info.rx.ingredients[0].name)}. Double-check the label.`);
  }
  res.json({ info: info && { ...info, conflicts }, conflicts, strength: label.strength, label, ai: true, alternatives: info?.alternatives || [], candidates: words,
    sig: sigFrom(label.directions, { dosesPerDay: posNum(o.dosesPerDay, 12), unitsPerDose: posNum(o.unitsPerDose, 20), asNeeded: !!o.asNeeded }),
    look: pillLook(`${label.pillDescription} ${label.dosageForm}`) });
});

app.post('/api/ai/explain', auth, async (req, res) => {
  await aiUser(req);
  const name = clean(req.body.name);
  if (!name) throw bad('Which medication?');
  const facts = await labelFacts(name);
  const o = await ask(`Explain the medication "${name}" to a patient in plain language.${facts ? `\nGround your answer in this FDA label excerpt:\n${facts}` : ''}
Return JSON: {"simple": "2-3 sentences: what it is and what it does in the body", "tips": ["3 short practical tips for taking it well"], "askDoctor": ["2 short questions worth asking a pharmacist or doctor"]}`, { json: true, models: [[GEMINI_MODEL, 'low'], [GEMINI_MODEL, 'low'], ['gemini-3.6-flash', 'low'], [FAST_MODEL, 'low']] });
  res.json({ simple: s(o.simple, 700), tips: arr(o.tips), askDoctor: arr(o.askDoctor) });
});

app.post('/api/ai/insight', auth, async (req, res) => {
  const u = await aiUser(req);
  const ctx = await patientContext(u, req.body, { labels: false });
  const note = await ask(`${ctx}\n\nThey just saved today's check-in. Write Pip's note: 2-3 warm sentences reacting specifically to their adherence, mood and any side effects, then one tiny practical tip. If a side effect is flagged, gently suggest mentioning it to their care team. Plain text, no lists, under 70 words.`);
  res.json({ note: s(note, 800) });
});

app.post('/api/ai/visit-prep', auth, async (req, res) => {
  const u = await aiUser(req);
  const r = await reportFor(u._id, req.body);
  const data = { days: r.days, from: r.from, to: r.to, adherence: r.adherence, taken: r.taken, scheduled: r.scheduled,
    meds: r.meds.map(m => ({ name: m.name, dose: m.dose, for: m.reason, trial: m.trialId, adherence: m.adherence, missed: m.missed, skipped: m.skipped })),
    sideEffects: r.sideEffects, flagged: r.flagged, moodAvg: r.moodAvg, notes: r.notes.slice(0, 8),
    measurements: r.vitals.map(v => ({ what: v.label, unit: v.unit, count: v.count, first: vitalText(v.first), latest: vitalText(v.latest), avg: v.avg2 ? `${v.avg}/${v.avg2}` : v.avg, flagged: v.flagged })),
    sideEffectDetails: r.effects.map(e => ({ name: e.name, severity: e.severity, start: e.startDate, end: e.endDate || 'ongoing', suspected: e.suspects.map(x => x.name), serious: isSerious(e) })) };
  const o = await ask(`Self-reported medication data from PillPal:\n${JSON.stringify(data)}
Return JSON: {"summary": "3-4 neutral, factual sentences a clinician can skim: adherence overall and per medication if notable, recurring symptoms, mood trend. No advice, no diagnosis.", "questions": ["3-5 questions the patient could ask at their visit, written in first person"]}`, { json: true });
  res.json({ summary: s(o.summary, 1200), questions: arr(o.questions) });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (!err.status || err.status >= 500) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong on our side' });
});

app.listen(PORT, () => { console.log(`PillPal running at http://localhost:${PORT}`); checkGemini(); });
