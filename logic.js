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

// ---------- mixing checks ----------
// Labels often warn about a drug class ("NSAIDs", "blood thinners") rather than by name, so each ingredient also
// answers to the class words a label would use. Curated for common outpatient meds; unknown drugs fall back to their name.
const CLASSES = [
  [['NSAID', 'NSAIDs', 'nonsteroidal anti-inflammatory', 'pain reliever', 'pain relievers'], 'ibuprofen naproxen aspirin diclofenac celecoxib meloxicam ketorolac indomethacin etodolac nabumetone'],
  [['anticoagulant', 'anticoagulants', 'blood thinner', 'blood thinners', 'antiplatelet'], 'warfarin apixaban rivaroxaban dabigatran edoxaban clopidogrel heparin enoxaparin'],
  [['ACE inhibitor', 'ACE inhibitors', 'angiotensin-converting enzyme'], 'lisinopril enalapril ramipril benazepril captopril quinapril fosinopril'],
  [['ARB', 'ARBs', 'angiotensin receptor blocker', 'angiotensin II receptor'], 'losartan valsartan irbesartan olmesartan candesartan telmisartan'],
  [['diuretic', 'diuretics', 'water pill'], 'hydrochlorothiazide furosemide chlorthalidone spironolactone torsemide bumetanide triamterene'],
  [['potassium-sparing', 'potassium supplements', 'potassium supplement'], 'spironolactone triamterene amiloride eplerenone potassium_chloride'],
  [['SSRI', 'SSRIs', 'selective serotonin reuptake', 'serotonergic', 'antidepressant', 'antidepressants'], 'sertraline fluoxetine citalopram escitalopram paroxetine fluvoxamine'],
  [['SNRI', 'SNRIs', 'serotonergic', 'antidepressant', 'antidepressants'], 'venlafaxine duloxetine desvenlafaxine'],
  [['MAOI', 'MAOIs', 'monoamine oxidase inhibitor', 'MAO inhibitor', 'MAO inhibitors'], 'phenelzine tranylcypromine selegiline isocarboxazid rasagiline'],
  [['opioid', 'opioids', 'narcotic', 'CNS depressants'], 'oxycodone hydrocodone morphine tramadol codeine fentanyl hydromorphone methadone tapentadol'],
  [['benzodiazepine', 'benzodiazepines', 'CNS depressants', 'sedative', 'sedatives'], 'alprazolam lorazepam diazepam clonazepam temazepam'],
  [['statin', 'statins', 'HMG-CoA reductase'], 'atorvastatin simvastatin rosuvastatin pravastatin lovastatin pitavastatin'],
  [['beta blocker', 'beta blockers', 'beta-blocker', 'beta-blockers', 'beta-adrenergic'], 'metoprolol atenolol propranolol carvedilol bisoprolol nebivolol labetalol'],
  [['sulfonylurea', 'sulfonylureas', 'insulin secretagogue', 'insulin secretagogues'], 'glipizide glyburide glimepiride'],
  [['nitrate', 'nitrates'], 'nitroglycerin isosorbide'],
  [['PDE5 inhibitor', 'PDE-5 inhibitors', 'phosphodiesterase'], 'sildenafil tadalafil vardenafil'],
  [['triptan', 'triptans', 'serotonergic'], 'sumatriptan rizatriptan zolmitriptan eletriptan'],
  [['antacid', 'antacids'], 'calcium_carbonate aluminum_hydroxide magnesium_hydroxide'],
  [['thyroid hormone', 'thyroid hormones'], 'levothyroxine liothyronine'],
];
const CLASS_OF = new Map();
for (const [terms, drugs] of CLASSES) for (const d of drugs.split(' ').map(x => x.replace('_', ' '))) CLASS_OF.set(d, [...(CLASS_OF.get(d) || []), ...terms]);
// Names a label might use for a med: its own name, its ingredients, and their classes.
export function mixNames(name = '', ingredients = []) {
  const ing = ingredients.map(i => String(i).toLowerCase());
  const words = ing.flatMap(i => i.split(/[\s/]+/));
  const classes = [...ing, ...words].flatMap(w => CLASS_OF.get(w) || []);
  return [...new Set([name, ...ingredients, ...classes].filter(x => x && x.length >= 3))];
}
// How strongly the label words it. Pip never judges beyond the label's own wording.
export const mixLevel = (snippet = '') =>
  /contraindicat|do not (use|take|combine|coadminister)|should not be (used|taken|given|coadministered)|avoid (use|taking|concomitant|co-?administration|combin)|must not/i.test(snippet) ? 'avoid' : 'caution';

// ---------- dose timers ----------
// Hours between doses stated in directions: "every 6 hours", "q8h", "every 4 to 6 hours" (the shorter gap is the earliest
// next dose), "twice daily" = 12, "once weekly" = 168. null when the text doesn't say.
export function hoursFromDirections(text = '') {
  const t = ` ${String(text).toLowerCase().replace(/\s+/g, ' ')} `;
  let m = t.match(/\bevery (\d+(?:\.\d+)?)(?:\s*(?:-|to|or)\s*(\d+(?:\.\d+)?))? ?(?:hours?|hrs?|h)\b/) || t.match(/\bq ?(\d+) ?h\b/);
  if (m) return +m[1];
  if (/\b(once (a|per|each)? ?week|once weekly|every week|weekly)\b/.test(t)) return 168;
  if (/\b(every other day|every 2 days|every 48 hours)\b/.test(t)) return 48;
  if (/\b(four times (a|per|each)? ?day|4 times (a|per|each)? ?day|qid)\b/.test(t)) return 6;
  if (/\b(three times (a|per|each)? ?day|3 times (a|per|each)? ?day|tid)\b/.test(t)) return 8;
  if (/\b(twice (a|per|each)? ?day|twice daily|2 times (a|per|each)? ?day|two times (a|per|each)? ?day|bid)\b/.test(t)) return 12;
  if (/\b(once (a|per|each)? ?day|once daily|every day|each day|daily|qd|nightly|every night|at bedtime)\b/.test(t)) return 24;
  return null;
}
// Without directions: a day split evenly across the reminder times (1 time = 24 h, 2 = 12 h…).
export const scheduleHours = (times = []) => Math.round(24 / Math.max(1, times.length) * 10) / 10;
// Liquid vs pills, from what the user typed or the label's dosage form.
export const isLiquid = (text = '') => /\b(ml|mls|millilit(er|re)s?|teaspoons?|tsp|tablespoons?|tbsp|syrup|solution|suspension|liquid|elixir|drops?|oral sol)\b/i.test(text);

// ---------- health log: measurements ----------
// Ranges for checking input, plus the gentle flags shown on the log and the report (common adult reference ranges).
export const VITALS = {
  bp: { label: 'Blood pressure', unit: 'mmHg', min: 50, max: 260, min2: 30, max2: 160 },
  weight: { label: 'Weight', unit: 'lb', min: 40, max: 800 },
  glucose: { label: 'Blood sugar', unit: 'mg/dL', min: 20, max: 600 },
  temp: { label: 'Temperature', unit: '°F', min: 90, max: 110 },
  spo2: { label: 'Oxygen', unit: '%', min: 50, max: 100 },
  pain: { label: 'Pain', unit: '/10', min: 0, max: 10 },
  a1c: { label: 'A1C', unit: '%', min: 3, max: 20 },
};
export const GLUCOSE_CONTEXT = ['fasting', 'before a meal', 'after a meal', 'bedtime', 'other'];
// null, or { level: 'high' | 'low' | 'urgent', text }.
export function vitalFlag(v) {
  const x = +v.value, y = +v.value2;
  switch (v.type) {
    case 'bp':
      if (x >= 180 || y >= 120) return { level: 'urgent', text: 'Very high. Recheck in 5 minutes; with chest pain, shortness of breath, weakness or vision changes, call 911.' };
      if (x >= 140 || y >= 90) return { level: 'high', text: 'High' };
      if (x < 90 || y < 60) return { level: 'low', text: 'Low' };
      return null;
    case 'glucose':
      if (x < 54) return { level: 'urgent', text: 'Very low. Have 15 g of fast sugar now (juice, glucose tabs) and recheck in 15 minutes.' };
      if (x < 70) return { level: 'low', text: 'Low' };
      if (x >= 300) return { level: 'urgent', text: 'Very high. Follow your care plan and call your care team.' };
      if (x > 180) return { level: 'high', text: 'High' };
      return null;
    case 'temp': return x >= 103 ? { level: 'urgent', text: 'High fever. Call your care team.' } : x >= 100.4 ? { level: 'high', text: 'Fever' } : x < 95 ? { level: 'low', text: 'Low' } : null;
    case 'spo2': return x < 90 ? { level: 'urgent', text: 'Low oxygen. If you are short of breath, call 911.' } : x < 95 ? { level: 'low', text: 'A bit low' } : null;
    case 'pain': return x >= 7 ? { level: 'high', text: 'Severe pain' } : null;
    case 'a1c': return x >= 6.5 ? { level: 'high', text: 'Above the usual goal (talk with your doctor about yours)' } : null;
    default: return null;
  }
}
export const vitalText = v => (v.type === 'bp' ? `${v.value}/${v.value2}${v.pulse ? `, pulse ${v.pulse}` : ''}` : `${v.value}`);
// Per type: count, latest, average, range, flagged count, and a trend series (oldest first).
export function summarizeVitals(list = []) {
  const out = [];
  for (const type of Object.keys(VITALS)) {
    const xs = list.filter(v => v.type === type).sort((a, b) => new Date(a.at) - new Date(b.at));
    if (!xs.length) continue;
    const avg = k => Math.round(xs.reduce((s, v) => s + +v[k], 0) / xs.length * 10) / 10;
    out.push({ type, label: VITALS[type].label, unit: VITALS[type].unit, count: xs.length, latest: xs.at(-1), first: xs[0],
      avg: avg('value'), avg2: type === 'bp' ? avg('value2') : null,
      min: Math.min(...xs.map(v => +v.value)), max: Math.max(...xs.map(v => +v.value)),
      flagged: xs.filter(v => vitalFlag(v)).length, series: xs.map(v => ({ at: v.at, date: v.date, value: +v.value, value2: v.value2 == null ? null : +v.value2 })) });
  }
  return out;
}

// ---------- clinical trials ----------
// ClinicalTrials.gov API v2 study → what PillPal shows. Used by the server, and mirrored in the browser fallback.
export function mapStudy(s, near = '') {
  const ps = s.protocolSection || {}, el = ps.eligibilityModule || {};
  const locs = [...new Set((ps.contactsLocationsModule?.locations || []).map(l => [l.city, l.state || l.country].filter(Boolean).join(', ')))];
  const n = near.toLowerCase();
  return {
    id: ps.identificationModule?.nctId, title: ps.identificationModule?.briefTitle || '', status: ps.statusModule?.overallStatus || '',
    conditions: (ps.conditionsModule?.conditions || []).slice(0, 4), phases: ps.designModule?.phases || [],
    sponsor: ps.sponsorCollaboratorsModule?.leadSponsor?.name || '', summary: String(ps.descriptionModule?.briefSummary || '').replace(/\s+/g, ' ').slice(0, 260),
    minAge: el.minimumAge || '', maxAge: el.maximumAge || '', sex: el.sex || 'ALL', healthy: !!el.healthyVolunteers,
    criteria: String(el.eligibilityCriteria || '').slice(0, 3000),
    locationCount: locs.length, locations: (n ? [...locs.filter(l => l.toLowerCase().includes(n)), ...locs.filter(l => !l.toLowerCase().includes(n))] : locs).slice(0, 3),
  };
}
export const STUDY_FIELDS = 'NCTId,BriefTitle,OverallStatus,Condition,Phase,BriefSummary,LocationCity,LocationState,LocationCountry,LeadSponsorName,MinimumAge,MaximumAge,Sex,HealthyVolunteers,EligibilityCriteria';
// "18 Years" / "6 Months" → years.
export const ageYears = s => { const m = /([\d.]+)\s*(year|month|week|day)/i.exec(s || ''); if (!m) return null; const u = m[2].toLowerCase(); return +m[1] / (u === 'year' ? 1 : u === 'month' ? 12 : u === 'week' ? 52 : 365); };
// Does a profile clearly fall outside the study's age or sex limits? (Everything else is for the study team.)
export function quickFit(t, { age, sex } = {}) {
  const why = [];
  const lo = ageYears(t.minAge), hi = ageYears(t.maxAge);
  if (age != null && lo != null && age < lo) why.push(`for ages ${t.minAge.toLowerCase()} and up`);
  if (age != null && hi != null && age > hi) why.push(`for ages up to ${t.maxAge.toLowerCase()}`);
  if (sex && t.sex && t.sex !== 'ALL' && t.sex.toLowerCase() !== sex.toLowerCase()) why.push(`for ${t.sex.toLowerCase()} participants only`);
  return { fits: !why.length, why };
}
// The ClinicalTrials.gov website search for the same query: a working link even when the API can't be reached.
export const ctgovSearchUrl = ({ cond = '', intr = '', loc = '' }) =>
  'https://clinicaltrials.gov/search?' + new URLSearchParams(Object.entries({ cond, intr, locStr: loc, aggFilters: 'status:rec' }).filter(([, v]) => v));
