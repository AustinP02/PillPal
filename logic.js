// Pure logic shared by the server and test.js: label OCR parsing + clinician report math.

const STOP = new Set(`TABLET TABLETS CAPSULE CAPSULES TAKE TAKES DAILY ONCE TWICE TIMES EVERY HOURS MOUTH ORAL WITH
FOOD WATER PHARMACY QUANTITY REFILL REFILLS DATE FILLED EXPIRES DOCTOR PRESCRIBER PATIENT DISCARD AFTER BEFORE
ONLY CAUTION FEDERAL PROHIBITS TRANSFER THIS DRUG OTHER THAN PERSON WHOM PRESCRIBED KEEP REACH CHILDREN STORE
ROOM TEMPERATURE SODIUM CALCIUM POTASSIUM MAGNESIUM HYDROCHLORIDE EXTENDED RELEASE DELAYED NEEDED PAIN MORNING
NIGHT BEDTIME GENERIC SUBSTITUTED STREET AVENUE ROAD SUITE WALGREENS WALMART TARGET COSTCO KROGER MANUFACTURER
LABEL WARNING WARNINGS INFORMATION DIRECTIONS USES DOSE DOSAGE STRENGTH`.split(/\s+/));

// Pull NDC codes, likely drug-name words and a strength out of OCR'd label text.
export function extractCandidates(text = '') {
  const up = text.toUpperCase();
  // Package NDC is labeler-product-package; openFDA's product_ndc is the first two segments.
  const ndc = [...new Set([...up.matchAll(/\b(\d{4,5})-(\d{3,4})-(\d{1,2})\b/g)].map(m => `${m[1]}-${m[2]}`))];
  // ponytail: longest-word-first heuristic; drug names tend to be long, label noise short.
  const words = [...new Set(up.match(/[A-Z]{4,}/g) || [])]
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
