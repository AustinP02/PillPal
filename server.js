import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { extractCandidates, buildReport, addDays, bestWordSim, productNdcSplits, parseSig, pillLook, mentions as mentionsOf } from './logic.js';

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
    db.collection('scanfixes').createIndex({ userId: 1, word: 1 }, { unique: true }),
  ]);
  return db;
}
const db = await connect();
const users = db.collection('users'), sessions = db.collection('sessions'), meds = db.collection('meds'),
  doses = db.collection('doses'), checkins = db.collection('checkins'), scanfixes = db.collection('scanfixes');

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
  const input = medInput(req.body);
  const doc = { ...input, ingredients: [], userId: req.userId, active: true, startDate: date(req.body.today, 'today'), createdAt: new Date() };
  const { insertedId } = await meds.insertOne(doc);
  // RxNorm ingredients (for duplicate and interaction checks) fill in after the save, so saving stays instant.
  ingredientsFor(input.name).then(ingredients => ingredients.length && meds.updateOne({ _id: insertedId }, { $set: { ingredients } })).catch(() => {});
  res.status(201).json({ ...doc, _id: insertedId });
});

app.put('/api/meds/:id', auth, async (req, res) => {
  const input = medInput(req.body);
  const r = await meds.findOneAndUpdate({ _id: oid(req.params.id), userId: req.userId }, { $set: input }, { returnDocument: 'after' });
  if (!r) throw bad('Medication not found', 404);
  ingredientsFor(input.name).then(ingredients => ingredients.length && meds.updateOne({ _id: r._id }, { $set: { ingredients } })).catch(() => {});
  res.json(r);
});

// Soft delete: history stays in the clinician report.
app.delete('/api/meds/:id', auth, async (req, res) => {
  const r = await meds.updateOne({ _id: oid(req.params.id), userId: req.userId },
    { $set: { active: false, endDate: addDays(date(req.query.today, 'today'), -1) } });
  if (!r.matchedCount) throw bad('Medication not found', 404);
  res.json({ ok: true });
});

// Before adding a med: is the same ingredient already tracked? (Lipitor vs atorvastatin, or a strength change.)
app.post('/api/meds/check', auth, async (req, res) => {
  const name = str(req.body.name, 80, 'Medication name');
  res.json({ duplicate: await duplicateOf(req.userId, await ingredientsFor(name), req.body.id, req.body.dose) });
});

// doses
app.get('/api/doses', auth, async (req, res) =>
  res.json(await doses.find({ userId: req.userId, date: date(req.query.date) }, { projection: { _id: 0, medId: 1, time: 1, status: 1, at: 1 } }).toArray()));

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
const interactionText = l => clip(first(l?.drug_interactions) || '', 4000);
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

// ---------- Gemini: Pip's AI (scan vision, chat, explainers, insights, visit prep) ----------
const PAL_RULES = `You are Pip, the friendly capsule mascot of PillPal, a medication tracking app. Be warm, plain (6th-grade reading level) and brief: usually under 120 words.
Rules you never break:
- You are not a doctor or pharmacist. Never diagnose. Never tell someone to start, stop, skip, double, split or change a dose; send those questions to their prescriber or pharmacist.
- If the user describes an emergency (chest pain, trouble breathing, swelling of face or throat, fainting, seizure, possible overdose, thoughts of self-harm), FIRST tell them to call 911 now (Poison Help 1-800-222-1222 for overdose or poisoning, 988 for a mental health crisis).
- General facts about medicines are fine. Ground them in the FDA label excerpts you are given, and say plainly when you are unsure or when it depends on the person.
- Only use the user's data you are given. Never invent doses, times or history.
- Plain text. Short paragraphs or simple "- " bullets. No headings, no tables, no emoji.`;

// Busy/overloaded (429/5xx): retry once, then fall back to an older stable model.
// Model + how much it "thinks" before answering. Thinking adds seconds; reading a label or a short explainer needs little.
// Gemini 3+ takes thinkingLevel; 2.5 models take thinkingBudget (0 = off on 2.5 Flash).
const MODELS = [GEMINI_MODEL, GEMINI_MODEL, 'gemini-2.5-flash'];
// Scanning: the fast Flash-Lite model first (Google's pick for high-throughput reading), then the main model with low thinking.
const SCAN_MODELS = [[process.env.GEMINI_SCAN_MODEL || 'gemini-3.5-flash-lite', 'minimal'], [GEMINI_MODEL, 'low'], [GEMINI_MODEL, 'low'], ['gemini-2.5-flash', 'low']];
const thinkingFor = (model, level) => !level ? null : /2\.5/.test(model) ? { thinkingBudget: /pro/.test(model) ? 128 : 0 } : { thinkingLevel: level };
async function gemini({ system = PAL_RULES, contents, json = false, temperature = 0.5, schema = null, models = null }) {
  const plan = models || MODELS.map(m => [m, null]);
  let r, data, i = 0, noThinking = false;
  while (i < plan.length) {
    const [model, level] = plan[i], thinking = noThinking ? null : thinkingFor(model, level);
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      signal: AbortSignal.timeout(45000),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature, ...(json && { responseMimeType: 'application/json' }), ...(schema && { responseSchema: schema }), ...(thinking && { thinkingConfig: thinking }) },
      }),
    });
    data = await r.json().catch(() => ({}));
    if (r.ok) break;
    const msg = data.error?.message || '';
    // Settings a model rejects (400) shouldn't break anything: drop them and ask the same model again.
    if (r.status === 400 && thinking && /think/i.test(msg)) { console.error('Gemini thinking setting rejected, retrying without it:', msg); noThinking = true; continue; }
    if (r.status === 400 && schema) { console.error('Gemini schema rejected, retrying without it:', msg); schema = null; continue; }
    // Model not available to this key (404/403) or busy (429/5xx): move on to the next model in the plan.
    if (![403, 404, 429].includes(r.status) && r.status < 500) break;
    console.error('Gemini unavailable/busy', model, r.status, msg);
    i++;
    if (i < plan.length && plan[i][0] === model) await new Promise(ok => setTimeout(ok, 800));
  }
  if (!r.ok) {
    console.error('Gemini error', r.status, data.error?.message);
    throw bad(r.status === 429 ? 'Pip is answering a lot of questions right now. Try again in a minute.' : "Pip's AI is unavailable right now.", 502);
  }
  const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
  if (!text) throw bad("Pip couldn't answer that one. Try asking another way.", 502);
  if (!json) return text;
  try { return JSON.parse(text); } catch { throw bad('Pip got muddled reading that. Please try again.', 502); }
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
  if (msgs.at(-1)?.role !== 'user') throw bad('Ask Pip a question');
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

// What Gemini must return for a label photo. Strict schema = predictable fields; values are still cross-checked below.
const STR = { type: 'STRING' }, NUM = { type: 'NUMBER', nullable: true };
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
    json: true, temperature: 0.1, schema: LABEL_SCHEMA,
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
Return JSON: {"simple": "2-3 sentences: what it is and what it does in the body", "tips": ["3 short practical tips for taking it well"], "askDoctor": ["2 short questions worth asking a pharmacist or doctor"]}`, { json: true, temperature: 0.4, models: [[GEMINI_MODEL, 'low'], [GEMINI_MODEL, 'low'], ['gemini-2.5-flash', 'low']] });
  res.json({ simple: s(o.simple, 700), tips: arr(o.tips), askDoctor: arr(o.askDoctor) });
});

app.post('/api/ai/insight', auth, async (req, res) => {
  const u = await aiUser(req);
  const ctx = await patientContext(u, req.body, { labels: false });
  const note = await ask(`${ctx}\n\nThey just saved today's check-in. Write Pip's note: 2-3 warm sentences reacting specifically to their adherence, mood and any side effects, then one tiny practical tip. If a side effect is flagged, gently suggest mentioning it to their care team. Plain text, no lists, under 70 words.`, { temperature: 0.8 });
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
