// Demo mode: a 60-day showcase story (the classic set of meds) and Pip's pre-written answers.
// Pure functions: the server inserts what buildDemo returns. Times are the visitor's local times.
import { addDays } from './logic.js';

const MEDS = [
  { key: 'metformin', name: 'Metformin', dose: '500 mg', reason: 'Type 2 diabetes', instructions: 'Take 1 tablet twice daily with meals', times: ['08:00', '18:00'],
    shape: 'oval', color: '#F1F4F4', start: 59, quantity: 60, unitsPerDose: 1, fill: 26, refills: 1, hours: 12, ing: [['6809', 'metformin']],
    basis: 'Your directions: twice daily with meals' },
  { key: 'lisinopril', name: 'Lisinopril', dose: '10 mg', reason: 'Blood pressure', instructions: 'Take 1 tablet every morning', times: ['08:00'],
    shape: 'round', color: '#F2B8A0', start: 59, quantity: 90, unitsPerDose: 1, fill: 40, refills: 3, hours: 24, ing: [['29046', 'lisinopril']],
    basis: 'Your directions: once every morning' },
  { key: 'atorvastatin', name: 'Atorvastatin', dose: '20 mg', reason: 'Cholesterol', instructions: 'Take 1 tablet at bedtime', times: ['21:30'],
    shape: 'oval', color: '#FFFFFF', start: 59, quantity: 90, unitsPerDose: 1, fill: 50, refills: 2, hours: 24, ing: [['83367', 'atorvastatin']],
    basis: 'Your directions: once a day at bedtime' },
  { key: 'omeprazole', name: 'Omeprazole', dose: '20 mg', reason: 'Heartburn', instructions: 'Take 1 capsule 30 minutes before breakfast', times: ['07:30'],
    shape: 'capsule', color: '#7B2D8E', start: 45, quantity: 30, unitsPerDose: 1, fill: 18, refills: 2, hours: 24, ing: [['7646', 'omeprazole']],
    basis: 'Your directions: once a day before breakfast' },
  { key: 'vitd', name: 'Vitamin D3', dose: '1000 IU', reason: 'Low vitamin D', instructions: 'Take 1 softgel with lunch', times: ['12:30'],
    shape: 'round', color: '#F4C430', start: 59, quantity: 120, unitsPerDose: 1, fill: 55, hours: 24, ing: [['11253', 'cholecalciferol']],
    basis: 'Your directions: once a day with lunch' },
  { key: 'study', name: 'Orforglipron', dose: '12 mg (study)', reason: 'ACHIEVE-1 diabetes study', instructions: 'Take 1 tablet each morning, with or without food', times: ['09:00'],
    shape: 'round', color: '#A9DEDE', start: 21, trialId: 'NCT05971940', hours: 24, ing: [], basis: 'Study instructions: once a day' },
  { key: 'advil', name: 'Advil', dose: '200 mg', reason: 'Knee pain', instructions: 'Take 1 to 2 capsules every 6 hours as needed (max 6 a day)', times: ['13:00'],
    shape: 'capsule', color: '#EE6F33', start: 20, quantity: 40, asNeeded: true, hours: 6, ing: [['5640', 'ibuprofen']],
    basis: 'Label: 1 to 2 capsules every 6 hours as needed' },
  { key: 'amoxicillin', name: 'Amoxicillin', dose: '5 mL', reason: 'Ear infection', instructions: 'Take 5 mL by mouth three times a day for 10 days', times: ['08:00', '14:00', '20:00'],
    form: 'liquid', color: '#E86A8E', start: 6, discard: 8, hours: 8, ing: [['723', 'amoxicillin']], basis: 'Your directions: three times a day' },
  { key: 'guaifenesin', name: 'Guaifenesin', dose: '10 mL', reason: 'Chest congestion', instructions: 'Take 10 mL at bedtime as needed for cough', times: ['21:00'],
    form: 'liquid', color: '#D9772B', start: 4, asNeeded: true, hours: 4, ing: [['5032', 'guaifenesin']], basis: 'Label: every 4 hours as needed' },
];

const rnd = s => { const x = Math.sin(s * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
const pad = n => String(n).padStart(2, '0');
const localHM = (ms, tz) => { const d = new Date(ms - tz * 60000); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const localDate = (ms, tz) => new Date(ms - tz * 60000).toISOString().slice(0, 10);

// today "YYYY-MM-DD" and now "HH:MM" are the visitor's local values; tz is getTimezoneOffset() (minutes).
export function buildDemo({ today, now, tz = 0, nowMs = Date.now() }) {
  const at = (date, time, plusMin = 0) => new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), +time.slice(0, 2), +time.slice(3, 5) + plusMin) + tz * 60000);
  const meds = MEDS.map(m => ({
    name: m.name, dose: m.dose, reason: m.reason, instructions: m.instructions, times: m.times, trialId: m.trialId || '',
    shape: m.shape || 'round', color: m.color, form: m.form || 'pill', intervalHours: null,
    quantity: m.quantity ?? null, unitsPerDose: m.unitsPerDose ?? null, refills: m.refills ?? null,
    fillDate: m.fill ? addDays(today, -m.fill) : '', discardAfter: m.discard ? addDays(today, m.discard) : '',
    ingredients: m.ing.map(([rxcui, name]) => ({ rxcui, name })), active: true, startDate: addDays(today, -m.start),
    interval: { hours: m.hours, by: 'pip', basis: m.basis, from: 'your directions', at: new Date(nowMs) }, timer: null, snooze: null,
    createdAt: new Date(nowMs - m.start * 864e5), key: m.key,
  }));

  // Doses: mostly on time, weekend evenings slip, a rough patch 5 weeks ago, as-needed meds only some days,
  // and a clean 9-day streak leading up to today.
  // Left open on purpose: today's lisinopril (snoozed demo) and today's as-needed slots.
  const doses = [];
  MEDS.forEach((m, mi) => {
    for (let k = m.start; k >= 0; k--) {
      const date = addDays(today, -k), dow = new Date(date + 'T12:00:00Z').getUTCDay(), weekend = dow === 0 || dow === 6;
      m.times.forEach((time, ti) => {
        if (k === 0 && (time >= now || m.asNeeded || m.key === 'lisinopril')) return;
        const r = rnd(mi * 1000 + k * 10 + ti), r2 = rnd(mi * 977 + k * 13 + ti + 5);
        let status = 'taken';
        if (k <= 9) status = 'taken'; // the last 9 days are a clean streak
        else if (m.asNeeded) status = r < (m.key === 'advil' ? 0.6 : 0.75) ? 'taken' : 'skipped';
        else {
          const p = k >= 34 && k <= 38 ? 0.45 : weekend && time >= '18:00' ? 0.3 : 0.035;
          if (r < p) status = r2 < 0.3 ? 'skipped' : null; // null = missed, nothing logged
        }
        if (status) doses.push({ mi, date, time, status, at: at(date, time, Math.floor(r2 * 25)) });
      });
    }
  });

  // Timers from each med's latest dose taken.
  for (const [mi, m] of meds.entries()) {
    if (MEDS[mi].asNeeded) continue; // as-needed meds only get a timer when actually taken (Advil, below)
    const last = doses.filter(d => d.mi === mi && d.status === 'taken').sort((a, b) => a.at - b.at).at(-1);
    if (last) m.timer = { startedAt: last.at, endsAt: new Date(+last.at + m.interval.hours * 3600e3), hours: m.interval.hours, date: last.date, time: last.time, status: 'taken' };
  }
  // Live moments for a presentation: Advil comes due ~2 minutes after the demo opens; lisinopril is snoozed.
  const ai = MEDS.findIndex(m => m.key === 'advil'), adv = meds[ai];
  const started = nowMs - 6 * 3600e3 + 110e3, sDate = localDate(started, tz), sTime = localHM(started, tz);
  if (sDate >= addDays(today, -1)) {
    doses.push({ mi: ai, date: sDate, time: sTime, status: 'taken', at: new Date(started) });
    adv.timer = { startedAt: new Date(started), endsAt: new Date(started + 6 * 3600e3), hours: 6, date: sDate, time: sTime, status: 'taken' };
  }
  const li = meds.find(m => m.key === 'lisinopril');
  if (now > '08:10' && li.timer && +li.timer.endsAt < nowMs) li.snooze = { date: today, time: '08:00', from: new Date(nowMs - 120e3), until: new Date(nowMs + 8 * 60e3) };

  // Daily check-ins: steady, a rough week, headaches after the study drug started, upset stomach since the antibiotic.
  const checkins = [];
  for (let k = 59; k >= 1; k--) {
    const r = rnd(k * 31 + 7);
    const date = addDays(today, -k);
    let mood = r < 0.18 ? 5 : r > 0.9 ? 3 : 4;
    const fx = [];
    let notes = '', questions = '';
    if (k >= 34 && k <= 38) { mood = k === 36 ? 2 : 3; if (k % 2) fx.push('Fatigue'); if (k === 36) notes = 'Busy week at work. Forgot a few evening doses.'; }
    if ([19, 18, 16, 15, 14, 12].includes(k)) { fx.push('Nausea'); if (k <= 16) fx.push('Low appetite'); mood = Math.min(mood, 3); }
    if (k === 17) notes = 'Queasy in the afternoons since starting the study pill.';
    if (k === 15) questions = 'Could the study drug be causing my nausea?';
    if ([5, 4, 2, 1].includes(k)) { fx.push('Upset stomach'); mood = 3; }
    if (k === 4) notes = 'Stomach feels off after the morning syrup.';
    if (k === 2) questions = 'Should I take amoxicillin with food?';
    if (k === 48 || k === 27) fx.push('Trouble sleeping');
    if (k === 52) notes = 'Walked 30 minutes after dinner every day this week.';
    if (k === 44) questions = 'Is it OK to take Vitamin D with my other pills?';
    if (k > 7 && r < 0.12 && !fx.length && !notes && !questions) continue; // a few days without a check-in, like real life
    checkins.push({ date, mood, sideEffects: fx, notes, questions, updatedAt: at(date, '20:30') });
  }

  // How each med feels, logged right after doses.
  const feel = [['study', 19, 3, ['Nausea'], 'Queasy by mid-afternoon. Smaller lunch helps.'], ['study', 15, 3, ['Nausea', 'Low appetite'], ''], ['study', 9, 4, [], 'Nausea is fading.'],
    ['study', 3, 4, [], 'Sugar numbers are coming down.'], ['amoxicillin', 5, 3, ['Upset stomach'], 'Tastes like bubblegum, stomach a bit off.'], ['amoxicillin', 1, 3, ['Upset stomach'], 'Better when I take it with breakfast.'],
    ['advil', 10, 4, [], 'Knee feels better within an hour.'], ['advil', 2, 5, [], ''], ['metformin', 30, 4, ['Nausea'], 'Mild nausea when I take it before eating.'],
    ['lisinopril', 25, 4, [], ''], ['omeprazole', 20, 5, [], 'No heartburn this week.'], ['guaifenesin', 1, 4, [], 'Slept better, less coughing.']];
  const medcheckins = feel.map(([key, k, mood, sideEffects, notes]) => {
    const mi = MEDS.findIndex(m => m.key === key), date = addDays(today, -k);
    return { mi, medName: MEDS[mi].name, date, time: MEDS[mi].times[0], mood, sideEffects, notes, at: at(date, '13:15') };
  });
  // Measurements: blood pressure most mornings (coming down), weekly weight (down since the study drug), fasting
  // sugar (down, one low reading), a fever with the ear infection, knee pain scores, two A1C lab results.
  const vitals = [], jitter = (s, n) => Math.round((rnd(s) - 0.5) * 2 * n);
  for (let k = 59; k >= 0; k--) {
    const date = addDays(today, -k), f = (59 - k) / 59;
    if (rnd(k * 7 + 1) > 0.3 && (k > 0 || now >= '08:00')) {
      const rough = k >= 34 && k <= 38;
      vitals.push({ type: 'bp', value: Math.round(146 - 16 * f + jitter(k * 3, 6) + (rough ? 10 : 0)), value2: Math.round(92 - 9 * f + jitter(k * 5, 4) + (rough ? 4 : 0)), pulse: 72 + jitter(k * 11, 6), date, at: at(date, '07:45', jitter(k, 10)) });
    }
    if (k % 7 === 3) vitals.push({ type: 'weight', value: Math.round((212 - 1.5 * f * 2 - (k < 21 ? (21 - k) * 0.28 : 0) + jitter(k * 13, 1) * 0.4) * 10) / 10, date, at: at(date, '07:30') });
    if (rnd(k * 17 + 3) > 0.35 && (k > 0 || now >= '07:30')) {
      const g = k === 10 ? 66 : Math.round(170 - 18 * f - (k < 21 ? (21 - k) * 1.1 : 0) + jitter(k * 19, 9));
      vitals.push({ type: 'glucose', value: g, context: 'fasting', date, at: at(date, '07:15'), note: k === 10 ? 'Skipped dinner, felt shaky. Had juice.' : '' });
    }
    if (k <= 20 && rnd(k * 23 + 9) > 0.45) vitals.push({ type: 'pain', value: Math.max(1, Math.round(6 - (20 - k) * 0.15 + jitter(k * 29, 1))), date, at: at(date, '13:00'), note: '' });
  }
  [[7, 100.9], [6, 100.4], [5, 99.1], [3, 98.4]].forEach(([k, v]) => vitals.push({ type: 'temp', value: v, date: addDays(today, -k), at: at(addDays(today, -k), '19:00') }));
  [[6, 97], [3, 98]].forEach(([k, v]) => vitals.push({ type: 'spo2', value: v, date: addDays(today, -k), at: at(addDays(today, -k), '19:05') }));
  [[58, 8.1, 'Lab result from my doctor'], [2, 7.4, 'Study lab, week 8']].forEach(([k, v, note]) => vitals.push({ type: 'a1c', value: v, date: addDays(today, -k), at: at(addDays(today, -k), '10:00'), note }));

  // Side effects in detail, the way a study team asks for them.
  const effects = [
    { name: 'Nausea', startDate: addDays(today, -19), endDate: addDays(today, -11), severity: 'moderate', suspects: ['study'], notes: 'Worse in the afternoon. Smaller meals help.' },
    { name: 'Low appetite', startDate: addDays(today, -16), endDate: addDays(today, -8), severity: 'mild', suspects: ['study'], notes: '' },
    { name: 'Upset stomach', startDate: addDays(today, -5), endDate: '', severity: 'mild', suspects: ['amoxicillin'], notes: 'Better when I take the syrup with food.' },
    { name: 'Fatigue', startDate: addDays(today, -38), endDate: addDays(today, -34), severity: 'mild', suspects: [], notes: 'Stressful week at work.' },
  ].map(e => ({ ...e, serious: { er: false, hospital: false, stoppedMed: false } }));

  // About me (for trial matching) and the study she's in.
  const profile = { birthYear: +today.slice(0, 4) - 58, sex: 'female', location: 'New Brunswick, NJ', conditions: ['Type 2 diabetes', 'High blood pressure', 'High cholesterol'] };
  const studies = [{ nctId: 'NCT05971940', title: 'A Study of Orforglipron (LY3502970) in Adult Participants With Type 2 Diabetes and Inadequate Glycemic Control With Diet and Exercise Alone',
    participantId: 'ACH1-0427', site: 'Clinical Research Center, New Brunswick, NJ', coordinatorName: 'Jordan Lee (sample coordinator)', coordinatorPhone: '(732) 555-0142', coordinatorEmail: 'study.team@example.org',
    visits: [{ date: addDays(today, 3), time: '09:30', label: 'Week 12 visit: labs and vitals' }, { date: addDays(today, 31), time: '10:00', label: 'Week 16 visit' }] }];
  return { meds, doses, checkins, medcheckins, vitals, effects, profile, studies };
}

// ---------- Pip's pre-written answers (demo accounts only) ----------
const LABEL_NSAID = 'Non-Steroidal Anti-Inflammatory Agents Including Selective Cyclooxygenase-2 Inhibitors (COX-2 Inhibitors): In patients who are elderly, volume-depleted (including those on diuretic therapy), or with compromised renal function, coadministration of NSAIDs, including selective COX-2 inhibitors, with ACE inhibitors, including lisinopril, may result in deterioration of renal function…';
const LABEL_DIAB = 'Antidiabetics: Epidemiological studies have suggested that concomitant administration of ACE inhibitors and antidiabetic medicines (insulins, oral hypoglycemic agents) may cause an increased blood-glucose-lowering effect with risk of hypoglycemia.';
export function demoMixes(meds) {
  const by = n => meds.find(m => m.name === n);
  const pair = (a, b, labelOf, mentions, snippet, plain) => (by(a) && by(b) ? { a: { id: String(by(a)._id), name: a }, b: { id: String(by(b)._id), name: b }, labelOf, mentions, term: mentions, snippet, level: 'caution', plain } : null);
  return { checked: meds.length, pairs: [
    pair('Lisinopril', 'Advil', 'Lisinopril', 'Advil', LABEL_NSAID, 'Ibuprofen can make lisinopril work less well on blood pressure and, together, they can be hard on the kidneys, especially if you are dehydrated.'),
    pair('Metformin', 'Lisinopril', 'Lisinopril', 'Metformin', LABEL_DIAB, 'Lisinopril can make diabetes medicines lower blood sugar a bit more, so watch for shaky, sweaty or dizzy spells.'),
  ].filter(Boolean) };
}

const pct = v => (v == null ? 'n/a' : `${v}%`);
export function demoChat(q, r, meds) {
  const t = q.toLowerCase(), names = meds.map(m => m.name);
  if (/ibuprofen|advil|motrin|nsaid|pain ?killer|pain reliever/.test(t))
    return `Advil (ibuprofen) is the one to be careful with alongside your lisinopril. The lisinopril label warns that NSAIDs like ibuprofen can blunt its blood-pressure effect and, together, can strain the kidneys, mostly in people who are older, dehydrated or have kidney problems.

- Take Advil with food, and stay under the label's limit of 6 capsules a day.
- Drink plenty of water while you're using it.
- There's no known problem between ibuprofen and your metformin, atorvastatin, omeprazole, vitamin D, amoxicillin or guaifenesin.

Since you use it for your knee most days, ask your pharmacist if acetaminophen (Tylenol) would be a gentler choice for you.`;
  if (/what.*(for|do)|each of my|my meds|my medic/.test(t))
    return `Here's what each one is for:
- Metformin: lowers blood sugar (type 2 diabetes).
- Lisinopril: lowers blood pressure and protects the kidneys.
- Atorvastatin: lowers LDL cholesterol.
- Omeprazole: cuts stomach acid to prevent heartburn.
- Vitamin D3: tops up low vitamin D.
- Orforglipron: the study medicine in your ACHIEVE-1 diabetes trial (a GLP-1 pill).
- Advil: eases your knee pain.
- Amoxicillin: an antibiotic for your ear infection.
- Guaifenesin: loosens chest congestion so coughs bring it up.`;
  if (/nause|queasy|orforglipron|study|trial|appetite/.test(t))
    return `Nausea and a smaller appetite are the most common side effects of orforglipron and other GLP-1 medicines, especially in the first weeks. Your log shows moderate nausea for about a week after you started, and it eased by day 11. That's exactly what your study team wants to hear about, even now that it's better. It's in your "Send to my study team" summary and on your doctor report. Eating smaller meals and stopping when you feel full usually helps. Call the study team right away if you can't keep fluids down.`;
  if (/blood pressure|\bbp\b|sugar|glucose|weight|a1c|measure/.test(t))
    return `Your numbers are moving the right way. Morning blood pressure has come down from the mid 140s to around 130 over 84. Fasting sugar is down from about 170 to the 130s since the study drug started, with one low reading of 66 on the day you skipped dinner. Your A1C went from 8.1 to 7.4, and you're down about 8 pounds. All of it is on your doctor report and in your study summary. If sugar drops under 70 again, have 15 grams of fast sugar and recheck in 15 minutes.`;
  if (/stomach|amoxicillin|syrup|antibiotic/.test(t))
    return `An upset stomach is one of the most common side effects of amoxicillin, and you've logged it on 4 of the last 6 days. Taking each dose with a meal or snack usually helps, and amoxicillin works fine with food. Keep going until the bottle's 10 days are done, even if your ear feels better. Call your doctor if you get watery or bloody diarrhea, a rash, or swelling.`;
  if (/side effect/.test(t))
    return `The common ones to watch:
- Metformin: upset stomach or nausea, better with meals.
- Lisinopril: a dry cough or dizziness when standing up fast.
- Atorvastatin: muscle aches (tell your doctor if they're unexplained).
- Amoxicillin: upset stomach or diarrhea; a rash needs a call to your doctor.
- Advil: heartburn; take it with food.
In your log, nausea (after the study drug started) and an upset stomach (since amoxicillin) stand out. Both are on your doctor report.`;
  if (/miss|forgot|late|skip/.test(t))
    return `Most labels say: take a missed dose as soon as you remember, unless it's almost time for the next one. Then just take the next dose as usual. Never take two doses at once to catch up. For amoxicillin, try to keep the three doses spread through the day so it keeps working. If you miss doses often, tap Remind me on the timer and PillPal will nudge you again.`;
  if (/how am i|doing|adherence|week|streak|progress/.test(t))
    return `You've taken ${pct(r.adherence)} of your doses over the last week, and your streak is ${r.streak} day${r.streak === 1 ? '' : 's'}. Evening doses on weekends are the ones that slip most. Your average mood is ${r.moodAvg ?? 'n/a'} out of 5. ${r.flagged.length ? `${r.flagged.join(' and ')} showed up 3 or more days this week, so it's flagged on your doctor report.` : ''} Nice work keeping it up.`;
  if (/vitamin|supplement/.test(t))
    return `Vitamin D3 is fine to take with all of your medicines. Taking it with lunch, like you do, helps your body absorb it because it needs a little fat from food.`;
  if (/alcohol|drink|beer|wine/.test(t))
    return `Go easy on alcohol: with metformin it raises the risk of a rare but serious problem called lactic acidosis and can drop your blood sugar, and with lisinopril it can make you dizzy. Alcohol also irritates the stomach, which matters with Advil. A drink now and then with food is usually OK for many people; ask your doctor what's safe for you.`;
  return `In demo mode I answer from a set of prepared replies. Try asking me:
- Can I take ibuprofen with my meds?
- What is each of my meds for?
- Could the study drug be causing my nausea?
- How are my blood pressure and sugar doing?
- What side effects should I watch for?
- How am I doing this week?
With a real account, I answer anything about ${names.length ? 'your medicines' : 'medicines'} using Google Gemini.`;
}

export const demoExplain = name => {
  const n = String(name).toLowerCase();
  const E = {
    metformin: ['Metformin lowers blood sugar in type 2 diabetes. It helps your liver make less sugar and helps your body use insulin better.', ['Take it with meals to avoid stomach upset.', 'Keep taking it even when your sugar looks good.', 'Go easy on alcohol.'], ['Should my kidney function be checked while I take this?', 'What should I do if I feel shaky or sweaty?']],
    lisinopril: ['Lisinopril relaxes your blood vessels so your heart pumps more easily. It lowers blood pressure and helps protect your kidneys.', ['Take it at the same time every day.', 'Stand up slowly if you feel dizzy.', 'Ask before using pain relievers like ibuprofen.'], ['What should I do about a dry cough?', 'How often should my blood pressure be checked?']],
    atorvastatin: ['Atorvastatin is a statin. It lowers LDL ("bad") cholesterol so it builds up less in your arteries, cutting the risk of heart attack and stroke.', ['Take it at the same time each day.', 'Large amounts of grapefruit juice can raise its levels.', 'Report unexplained muscle pain.'], ['When will my cholesterol be checked again?', 'Are my muscle aches related to this?']],
    ibuprofen: ['Ibuprofen (Advil) is an NSAID. It blocks chemicals that cause pain, swelling and fever.', ['Take it with food or milk.', 'Use the lowest dose that works, for the shortest time.', 'Stay under the daily limit on the label.'], ['Is ibuprofen safe with my blood pressure medicine?', 'Would acetaminophen be better for me?']],
    amoxicillin: ['Amoxicillin is a penicillin-type antibiotic. It stops bacteria from building their cell walls, so the infection clears.', ['Finish the whole course.', 'Shake the bottle before each dose and use the dosing cup.', 'Take it with food if your stomach is upset.'], ['What should I do if I get a rash?', 'Do I need a follow-up visit?']],
  };
  const k = Object.keys(E).find(x => n.includes(x)) || (n.includes('advil') ? 'ibuprofen' : null);
  const [simple, tips, askDoctor] = k ? E[k] : [`${name} is one of your medicines. In demo mode, Pip has prepared explanations for metformin, lisinopril, atorvastatin, ibuprofen and amoxicillin.`, ['Take it exactly as the label says.'], ['What is this medicine for?']];
  return { simple, tips, askDoctor };
};

export const demoInsight = r => `You took ${pct(r.adherence)} of your doses this week. That's solid. Your upset stomach has shown up ${r.flagged.includes('Upset stomach') ? 'on 3 or more days, since the amoxicillin started' : 'a few times'}, so it's flagged for your doctor. Tiny tip: take the syrup with breakfast and dinner.`;

export const demoVisitPrep = r => ({
  summary: `Over the last ${r.days} days the patient took ${pct(r.adherence)} of scheduled doses (${r.taken} of ${r.scheduled}). Misses cluster on weekend evenings${r.days >= 40 ? ' and in one difficult week about five weeks ago' : ''}. Moderate nausea and low appetite were reported after starting the study drug orforglipron (NCT05971940) and resolved after about 8 days. Morning blood pressure fell from about 146/92 to about 130/83, fasting glucose from about 170 to the 130s (one reading of 66 mg/dL), A1C from 8.1% to 7.4%, and weight by about 8 lb. An upset stomach has been reported on 4 of the last 6 days since starting amoxicillin. Average mood is ${r.moodAvg ?? 'n/a'}/5.`,
  questions: ['Was my nausea from the study drug, and is anything else expected as the dose goes up?', 'Should I take amoxicillin with food to help my stomach?', 'Is it safe to keep using Advil for my knee with lisinopril?', 'How can I stop missing my weekend evening doses?'],
});

// Pip's eligibility pre-check, pre-written for the demo.
export const demoPrecheck = (id, t = {}) => id === 'NCT05971940'
  ? { verdict: 'likely', summary: 'You’re already enrolled in this study, and your profile fits its main rules.', matches: ['Adult with type 2 diabetes', 'A1C was above 7% when you joined'], concerns: [], ask: ['Ask how long the study lasts after week 16'] }
  : { verdict: 'maybe', summary: `You may fit ${t.title ? 'this study' : 'it'}, but you’re already in a drug trial, and most studies don’t allow two at once.`,
      matches: ['Adult age', 'Has type 2 diabetes'], concerns: ['Already taking part in another clinical trial (ACHIEVE-1)'], ask: ['Ask whether people in other studies can join', 'Check whether your current medicines are allowed'] };
