// Pure logic shared by the server and test.js: label OCR parsing + clinician report math.

const STOP = new Set(`TABLET TABLETS CAPSULE CAPSULES TAKE TAKES DAILY ONCE TWICE TIMES EVERY HOURS MOUTH ORAL WITH
FOOD WATER PHARMACY QUANTITY REFILL REFILLS DATE FILLED EXPIRES DOCTOR PRESCRIBER PATIENT DISCARD AFTER BEFORE
ONLY CAUTION FEDERAL PROHIBITS TRANSFER THIS DRUG OTHER THAN PERSON WHOM PRESCRIBED KEEP REACH CHILDREN STORE
ROOM TEMPERATURE SODIUM CALCIUM POTASSIUM MAGNESIUM HYDROCHLORIDE EXTENDED RELEASE DELAYED NEEDED PAIN MORNING
NIGHT BEDTIME GENERIC SUBSTITUTED STREET AVENUE ROAD SUITE WALGREENS WALMART TARGET COSTCO KROGER MANUFACTURER
LABEL WARNING WARNINGS INFORMATION DIRECTIONS USES DOSE DOSAGE STRENGTH
MEAL MEALS WHITE BLUE YELLOW ORANGE PINK GREEN BROWN PURPLE OVAL ROUND OBLONG IMPRINTED SCORED DESCRIPTION
FILL FILLED REFILLS DISCARD USE NDC LOT EXP EXPIRATION`.split(/\s+/));

// Pull NDC codes, likely drug-name words and a strength out of OCR'd label text.
export function extractCandidates(text = '') {
  const up = text.toUpperCase();
  // Package NDC is labeler-product-package; openFDA's product_ndc is the first two segments.
  const ndc = [...new Set([...up.matchAll(/\b(\d{4,5})-(\d{3,4})-(\d{1,2})\b/g)].map(m => `${m[1]}-${m[2]}`))];
  // ponytail: longest-word-first heuristic; drug names tend to be long, label noise short.
  // OCR often swaps letters for look-alike digits (METF0RMIN, LISIN0PRIL): keep those words, with the digits mapped back.
  const fix = w => w.replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B');
  const words = [...new Set((up.match(/[A-Z0-9]{4,}/g) || []).filter(w => /[A-Z]/.test(w) && (w.match(/\d/g) || []).length <= 2 && (w.match(/[A-Z]/g) || []).length >= 4).map(w => (/\d/.test(w) ? fix(w) : w)))]
    .filter(w => !STOP.has(w))
    .sort((a, b) => b.length - a.length)
    .slice(0, 10);
  const s = up.match(/(\d+(?:\.\d+)?)\s?(MG|MCG|ML|G)\b/);
  return { ndc, words, strength: s ? `${s[1]} ${s[2].toLowerCase()}` : '' };
}

export const addDays = (d, n) => {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

// meds: [{_id,name,dose,times,startDate,endDate,reason,trialId}], doses: [{medId,date,time,status}]
// today/now are the patient's local "YYYY-MM-DD"/"HH:MM" so future doses today don't count as missed.
export function buildReport({ meds, doses, checkins, today, now, days }) {
  const from = addDays(today, -(days - 1));
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const status = new Map(doses.map(d => [`${d.medId}|${d.date}|${d.time}`, d.status]));
  const daily = dates.map(date => ({ date, scheduled: 0, taken: 0 }));

  const medRows = meds.map(m => {
    let scheduled = 0, taken = 0, skipped = 0;
    const missed = [];
    dates.forEach((date, i) => {
      if (date < m.startDate || (m.endDate && date > m.endDate)) return;
      for (const time of m.times) {
        if (date === today && time > now) continue;
        scheduled++; daily[i].scheduled++;
        const s = status.get(`${m._id}|${date}|${time}`);
        if (s === 'taken') { taken++; daily[i].taken++; }
        else if (s === 'skipped') skipped++;
        else missed.push(`${date} ${time}`);
      }
    });
    return {
      id: String(m._id), name: m.name, dose: m.dose, times: m.times, reason: m.reason, trialId: m.trialId,
      instructions: m.instructions, active: !m.endDate, scheduled, taken, skipped, missed: missed.length,
      recentMissed: missed.slice(-5), adherence: scheduled ? Math.round((taken / scheduled) * 100) : null,
    };
  }).filter(r => r.scheduled || r.active);

  const scheduled = medRows.reduce((a, r) => a + r.scheduled, 0);
  const taken = medRows.reduce((a, r) => a + r.taken, 0);

  // Streak: consecutive fully-taken days, ignoring days with nothing scheduled and an unfinished today.
  let streak = 0;
  for (let i = daily.length - 1; i >= 0; i--) {
    const d = daily[i];
    if (!d.scheduled) continue;
    if (d.taken === d.scheduled) streak++;
    else if (d.date !== today) break;
  }

  const effects = new Map();
  for (const c of checkins) for (const e of c.sideEffects || []) effects.set(e, (effects.get(e) || 0) + 1);
  const week = checkins.filter(c => c.date > addDays(today, -7));
  const flagged = [...effects.keys()].filter(e => week.filter(c => c.sideEffects?.includes(e)).length >= 3);
  const moods = checkins.filter(c => c.mood).sort((a, b) => a.date.localeCompare(b.date)).map(c => ({ date: c.date, mood: c.mood }));

  return {
    from, to: today, days,
    adherence: scheduled ? Math.round((taken / scheduled) * 100) : null,
    scheduled, taken, streak, daily, meds: medRows,
    sideEffects: [...effects].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    flagged,
    moods,
    moodAvg: moods.length ? +(moods.reduce((a, m) => a + m.mood, 0) / moods.length).toFixed(1) : null,
    notes: checkins.filter(c => c.notes || c.questions).sort((a, b) => b.date.localeCompare(a.date))
      .map(c => ({ date: c.date, notes: c.notes, questions: c.questions })),
  };
}

// ---------- scanning helpers (see docs: "PillPal bottle scanning: research and improvement plan") ----------

// How alike two words are, 0..1 (1 = same), on letters and digits only. Used to rank RxNorm matches across OCR words.
export function similarity(a = '', b = '') {
  a = a.toUpperCase().replace(/[^A-Z0-9]/g, ''); b = b.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!a || !b) return 0;
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return 1 - d[b.length] / Math.max(a.length, b.length);
}
// Best similarity between an OCR word and any word of a drug name ("ATORVASTATlN" vs "atorvastatin calcium").
export const bestWordSim = (word, name) => {
  const ws = String(word).split(/[\s/-]+/).filter(Boolean), ns = String(name).split(/[\s/-]+/).filter(Boolean);
  return Math.max(similarity(word, name), ...ws.flatMap(a => ns.map(b => similarity(a, b))));
};

// The three ways a 10-digit NDC can split (4-4-2, 5-3-2, 5-4-1) as openFDA product NDCs (labeler-product).
export const productNdcSplits = d10 => /^\d{10}$/.test(d10) ? [`${d10.slice(0, 4)}-${d10.slice(4, 8)}`, `${d10.slice(0, 5)}-${d10.slice(5, 8)}`, `${d10.slice(0, 5)}-${d10.slice(5, 9)}`] : [];

// Decode a scanned barcode into an NDC (+ lot / expiry from DSCSA Data Matrix codes).
// UPC-A: "3" + NDC10 + check. EAN-13: "03" + NDC10 + check. GS1 Data Matrix: (01) GTIN-14 = "003" + NDC10 + check, (17) expiry YYMMDD, (10) lot, (21) serial.
export function ndcFromBarcode(raw = '') {
  const v = String(raw).replace(/^\]d2|^\]C1|^\]e0/, ''), digits = v.replace(/\D/g, '');
  let ndc10 = '', lot = '', expiry = '', serial = '';
  if (/^\d{12}$/.test(v) && v[0] === '3') ndc10 = v.slice(1, 11);
  else if (/^\d{13}$/.test(v) && v.startsWith('03')) ndc10 = v.slice(2, 12);
  else if (/^01\d{14}/.test(v.replace(/\x1d/g, ''))) {
    // GS1 element string: fixed-length AIs (01, 17) and variable-length ones (10, 21) ended by GS (\x1d) or end of string.
    let s = v, guard = 0;
    while (s && guard++ < 10) {
      const ai2 = s.slice(0, 2);
      if (ai2 === '01') { const g = s.slice(2, 16); if (g.startsWith('003')) ndc10 = g.slice(3, 13); s = s.slice(16); }
      else if (ai2 === '17') { const e = s.slice(2, 8); expiry = `20${e.slice(0, 2)}-${e.slice(2, 4)}-${e.slice(4, 6) === '00' ? '01' : e.slice(4, 6)}`; s = s.slice(8); }
      else if (ai2 === '10' || ai2 === '21') { const end = s.indexOf('\x1d', 2); const val = end < 0 ? s.slice(2) : s.slice(2, end); if (ai2 === '10') lot = val; else serial = val; s = end < 0 ? '' : s.slice(end + 1); }
      else if (s[0] === '\x1d') s = s.slice(1);
      else break;
    }
  } else if (/^\d{10,11}$/.test(digits) && digits.length === v.length) ndc10 = digits.length === 10 ? digits : '';
  return { ndc10, splits: productNdcSplits(ndc10), lot, expiry, serial };
}

// Directions ("sig") → suggested reminder times. A suggestion only: the user always confirms in the add form.
const SIG_RULES = [
  [/\b(as needed|prn|when needed|if needed)\b/, { asNeeded: true }],
  [/\b(four times (a|per|each)? ?day|4 times (a|per|each)? ?day|qid|every 6 hours|q6h)\b/, { times: ['08:00', '12:00', '16:00', '20:00'] }],
  [/\b(three times (a|per|each)? ?day|3 times (a|per|each)? ?day|tid|every 8 hours|q8h)\b/, { times: ['08:00', '14:00', '20:00'] }],
  [/\b(twice (a|per|each)? ?day|twice daily|2 times (a|per|each)? ?day|two times (a|per|each)? ?day|bid|every 12 hours|q12h)\b/, { times: ['08:00', '20:00'] }],
  [/\btwice\b(?! (a|per|each|every)? ?(week|month))/, { times: ['08:00', '20:00'] }],
  [/\bmorning and (in the )?evening\b|\bmorning and (at )?(night|bedtime)\b/, { times: ['08:00', '20:00'] }],
  [/\b(breakfast and dinner|breakfast and supper|with meals twice)\b/, { times: ['08:00', '18:00'] }],
  [/\b(at bedtime|before bed|qhs|hs|at night|nightly|every night|each night|in the evening|every evening)\b/, { times: ['21:30'] }],
  [/\b(once (a|per|each)? ?day|once daily|daily|every day|each day|qd|every morning|in the morning|qam|every 24 hours)\b/, { times: ['08:00'] }],
];
const DAY_PARTS = [[/\b(morning|breakfast)\b/, '08:00'], [/\b(noon|lunch|midday)\b/, '12:00'], [/\bafternoon\b/, '14:00'],
  [/\b(dinner|supper)\b/, '18:00'], [/\bevening\b/, '20:00'], [/\b(bedtime|bed time|at night)\b/, '21:30']];
const WORDNUM = { one: 1, two: 2, three: 3, four: 4, half: 0.5, '1/2': 0.5 };
export function parseSig(text = '') {
  const t = ` ${String(text).toLowerCase().replace(/\s+/g, ' ')} `;
  const out = { times: [], asNeeded: false, unitsPerDose: null, withFood: /\b(with food|with meals?|after (a )?meal|with breakfast|with dinner)\b/.test(t) };
  const u = t.match(/\btake (\d+(?:\.\d+)?|one|two|three|four|half|1\/2) (tablet|tab|capsule|cap|pill|softgel|teaspoon|ml)/);
  if (u) out.unitsPerDose = WORDNUM[u[1]] ?? +u[1];
  for (const [re, r] of SIG_RULES) if (re.test(t)) {
    if (r.asNeeded) { out.asNeeded = true; continue; }
    if (!out.times.length) out.times = r.times;
  }
  // USP <17> style names parts of the day ("1 tablet in the morning and 1 tablet in the evening"): 2+ parts win.
  const parts = [...new Set(DAY_PARTS.filter(([re]) => re.test(t)).map(([, h]) => h))].sort();
  if (parts.length >= 2) out.times = parts;
  if (out.asNeeded && !/\b(daily|times|twice|every)\b/.test(t)) out.times = [];
  return out;
}

// "white, oval tablet imprinted with ..." → PillPal's pill picker (shape + nearest swatch). Unknown → null.
const LOOK_COLORS = [[/\b(white|off-white|cream)\b/, '#F1F4F4'], [/\b(pink|peach|salmon)\b/, '#F2B8A0'], [/\b(yellow|gold)\b/, '#F4C430'], [/\b(blue|aqua|light blue|turquoise)\b/, '#A9DEDE'], [/\b(green|teal)\b/, '#127479'], [/\b(orange|red|brown)\b/, '#EE6F33']];
export function pillLook(text = '') {
  const t = String(text).toLowerCase();
  const shape = /\b(capsule|softgel|gelcap)\b/.test(t) ? 'capsule' : /\b(oval|oblong|elliptical)\b/.test(t) ? 'oval' : /\b(round|circular)\b/.test(t) ? 'round' : null;
  const color = (LOOK_COLORS.find(([re]) => re.test(t)) || [])[1] || null;
  return shape || color ? { shape, color } : null;
}

// When a bottle runs out: fill date + quantity ÷ (units per dose × doses per day). null when we can't tell.
export function runOutDate({ fillDate, quantity, unitsPerDose = 1, dosesPerDay }) {
  if (!fillDate || !(quantity > 0) || !(dosesPerDay > 0)) return null;
  return addDays(fillDate, Math.floor(quantity / ((unitsPerDose || 1) * dosesPerDay)));
}

// Sentences of label text that mention one of `names` (whole words, any case). For "worth asking your pharmacist" notes.
export function mentions(text = '', names = []) {
  const found = [];
  const sentences = String(text).replace(/\s+/g, ' ').split(/(?<=[.;])\s+/);
  for (const n of names.filter(x => x && x.length >= 4)) {
    const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const hit = sentences.find(x => re.test(x));
    if (hit) found.push({ name: n, snippet: hit.length > 220 ? hit.slice(0, hit.lastIndexOf(' ', 220)) + '…' : hit });
  }
  return found;
}
