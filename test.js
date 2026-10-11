import assert from 'node:assert/strict';
import { extractCandidates, buildReport } from './logic.js';

const label = `CVS PHARMACY  RX# 1234567
ATORVASTATIN CALCIUM 20 MG TABLETS
TAKE ONE TABLET BY MOUTH DAILY
NDC 0071-0155-23  QTY 30  REFILLS 2`;
const c = extractCandidates(label);
assert.deepEqual(c.ndc, ['0071-0155']);
assert.equal(c.words[0], 'ATORVASTATIN');
assert.ok(!c.words.includes('TABLETS') && !c.words.includes('CALCIUM'));
assert.equal(c.strength, '20 mg');

const meds = [
  { _id: 'a', name: 'A', times: ['08:00', '20:00'], startDate: '2026-10-08' },
  { _id: 'b', name: 'B', times: ['09:00'], startDate: '2026-09-20', endDate: '2026-10-02' }, // stopped, outside range
];
const doses = [
  { medId: 'a', date: '2026-10-08', time: '08:00', status: 'taken' },
  { medId: 'a', date: '2026-10-08', time: '20:00', status: 'skipped' },
  { medId: 'a', date: '2026-10-09', time: '08:00', status: 'taken' },
  { medId: 'a', date: '2026-10-09', time: '20:00', status: 'taken' },
  { medId: 'a', date: '2026-10-10', time: '08:00', status: 'taken' },
];
const checkins = ['2026-10-08', '2026-10-09', '2026-10-10'].map((date, i) => ({ date, mood: 3 + i % 2, sideEffects: ['Headache'] }));
const r = buildReport({ meds, doses, checkins, today: '2026-10-10', now: '12:00', days: 7 });
assert.equal(r.meds.length, 1);                // stopped med with nothing scheduled is dropped
assert.equal(r.scheduled, 5);                  // 20:00 today is in the future, not missed
assert.equal(r.taken, 4);
assert.equal(r.adherence, 80);
assert.equal(r.meds[0].skipped, 1);
assert.equal(r.meds[0].missed, 0);
assert.equal(r.streak, 2);                     // today + yesterday complete; Oct 8 had a skip
assert.deepEqual(r.flagged, ['Headache']);     // 3 of last 7 days
assert.equal(r.moodAvg, 3.3);
console.log('ok');

// ---------- scanning helpers ----------
import { similarity, bestWordSim, productNdcSplits, ndcFromBarcode, parseSig, pillLook, runOutDate, mentions } from './logic.js';
assert.ok(similarity('METF0RMIN', 'metformin') > 0.85);
assert.ok(bestWordSim('ATORVASTATlN', 'atorvastatin calcium') > 0.9);
assert.ok(similarity('WALGREENS', 'metformin') < 0.4);
assert.deepEqual(productNdcSplits('0071015523'), ['0071-0155', '00710-155', '00710-1552']);
assert.equal(ndcFromBarcode('300710155234').ndc10, '0071015523');              // UPC-A
assert.equal(ndcFromBarcode('0300710155234').ndc10, '0071015523');             // EAN-13
const dm = ndcFromBarcode('0100300710155230172612311012345A\x1d21SER99');      // GS1 Data Matrix
assert.deepEqual([dm.ndc10, dm.expiry, dm.lot, dm.serial], ['0071015523', '2026-12-31', '12345A', 'SER99']);
assert.equal(ndcFromBarcode('012345678905').ndc10, '');                       // ordinary retail UPC is not a drug
assert.deepEqual(parseSig('TAKE 1 TABLET BY MOUTH TWICE DAILY WITH FOOD').times, ['08:00', '20:00']);
assert.equal(parseSig('Take one tablet by mouth twice daily').unitsPerDose, 1);
assert.deepEqual(parseSig('Take 1 tablet in the morning and 1 tablet in the evening').times, ['08:00', '20:00']);
assert.deepEqual(parseSig('Take 1 tablet at bedtime').times, ['21:30']);
assert.deepEqual(parseSig('take 2 capsules three times a day').times, ['08:00', '14:00', '20:00']);
assert.equal(parseSig('take 2 capsules three times a day').unitsPerDose, 2);
assert.deepEqual(parseSig('Take 1 tablet daily').times, ['08:00']);
const prn = parseSig('Take 1 tablet every 6 hours as needed for pain');
assert.equal(prn.asNeeded, true);
assert.equal(parseSig('Take 1 tablet as needed for headache').times.length, 0);
assert.deepEqual(pillLook('WHITE, OVAL TABLET IMPRINTED WITH PD 155'), { shape: 'oval', color: '#F1F4F4' });
assert.equal(pillLook('Qty 30'), null);
assert.equal(runOutDate({ fillDate: '2026-10-01', quantity: 60, unitsPerDose: 1, dosesPerDay: 2 }), '2026-10-31');
assert.equal(runOutDate({ fillDate: '2026-10-01', quantity: 0, dosesPerDay: 2 }), null);
assert.equal(mentions('Avoid potassium supplements. Monitor potassium.', ['Potassium', 'Lithium'])[0].snippet, 'Avoid potassium supplements.');
console.log('scan helpers ok');
assert.ok(extractCandidates('METF0RMIN HCL 500 MG').words.includes('METFORMIN'));
assert.ok(bestWordSim('ATORVASTATIN CALCIUM', 'atorvastatin') === 1);
console.log('ocr fixes ok');
assert.deepEqual(parseSig('TAKE 1 TABLET BY MOUTH TWICE').times, ['08:00', '20:00']);
assert.deepEqual(parseSig('Take 1 tablet twice a week').times, []);
console.log('wrapped directions ok');

// mixing checks: class words on labels, and the label's own strength of wording
{
  const { mixNames, mixLevel, mentions } = await import('./logic.js');
  const advil = mixNames('Advil', ['ibuprofen']);
  assert.ok(advil.includes('NSAIDs') && advil.includes('ibuprofen'));
  assert.deepEqual(mixNames('Salt', ['sodium chloride']), ['Salt', 'sodium chloride']);
  assert.ok(mixNames('K-Tab', ['potassium chloride']).includes('potassium supplements'));
  assert.equal(mentions('Use of NSAIDs with ACE inhibitors may result in deterioration of renal function.', advil)[0].name, 'NSAIDs');
  assert.equal(mixLevel('Do not coadminister aliskiren with lisinopril in patients with diabetes.'), 'avoid');
  assert.equal(mixLevel('Concomitant use is contraindicated.'), 'avoid');
  assert.equal(mixLevel('May increase the blood-glucose-lowering effect.'), 'caution');
  console.log('mix checks ok');
}

// dose timer intervals and liquid detection
{
  const { hoursFromDirections: h, scheduleHours, isLiquid } = await import('./logic.js');
  assert.equal(h('Take 1 tablet every 6 hours'), 6);
  assert.equal(h('1 tablet every 4 to 6 hours as needed'), 4);
  assert.equal(h('TAKE 1 TABLET BY MOUTH TWICE DAILY'), 12);
  assert.equal(h('three times a day'), 8);
  assert.equal(h('once weekly on Sunday'), 168);
  assert.equal(h('with food'), null);
  assert.equal(scheduleHours(['08:00', '14:00', '20:00']), 8);
  assert.ok(isLiquid('5 mL') && isLiquid('Amoxicillin oral suspension') && !isLiquid('10 mg tablet'));
  console.log('timer intervals ok');
}

// demo mode story
{
  const { buildDemo, demoChat, demoMixes } = await import('./demo.js');
  const d = buildDemo({ today: '2026-10-11', now: '12:20', tz: 240, nowMs: Date.UTC(2026, 9, 11, 16, 20) });
  assert.equal(d.meds.length, 9);
  assert.ok(d.meds.some(m => m.form === 'liquid') && d.meds.some(m => m.shape === 'capsule') && d.meds.some(m => m.trialId));
  const advil = d.meds.find(m => m.name === 'Advil');
  assert.ok(+advil.timer.endsAt - Date.UTC(2026, 9, 11, 16, 20) <= 3 * 60e3, 'Advil comes due within minutes');
  assert.ok(d.meds.find(m => m.name === 'Lisinopril').snooze);
  assert.equal(d.checkins.filter(c => c.sideEffects.includes('Nausea')).length, 6);
  assert.ok(d.vitals.length > 60 && d.effects.length === 4 && d.studies[0].nctId === 'NCT05971940');
  assert.ok(!d.doses.some(x => x.date === '2026-10-11' && x.time >= '12:20' && x.at > new Date(Date.UTC(2026, 9, 11, 16, 20))), 'no future doses');
  assert.match(demoChat('Can I take ibuprofen with my meds?', { adherence: 90, streak: 9, flagged: [] }, []), /lisinopril/);
  assert.equal(demoMixes([{ _id: 'a', name: 'Lisinopril' }, { _id: 'b', name: 'Advil' }]).pairs.length, 1);
  console.log('demo ok');
}

// health log ranges and trial matching
{
  const { vitalFlag, summarizeVitals, quickFit, mapStudy, ctgovSearchUrl } = await import('./logic.js');
  assert.equal(vitalFlag({ type: 'bp', value: 182, value2: 100 }).level, 'urgent');
  assert.equal(vitalFlag({ type: 'bp', value: 142, value2: 85 }).level, 'high');
  assert.equal(vitalFlag({ type: 'bp', value: 118, value2: 76 }), null);
  assert.equal(vitalFlag({ type: 'glucose', value: 66 }).level, 'low');
  assert.equal(vitalFlag({ type: 'temp', value: 100.9 }).level, 'high');
  const sv = summarizeVitals([{ type: 'bp', value: 140, value2: 90, at: '2026-01-01' }, { type: 'bp', value: 120, value2: 80, at: '2026-01-02' }]);
  assert.equal(sv[0].avg, 130); assert.equal(sv[0].avg2, 85); assert.equal(sv[0].latest.value, 120); assert.equal(sv[0].flagged, 1);
  assert.deepEqual(quickFit({ minAge: '65 Years', sex: 'ALL' }, { age: 58, sex: 'female' }), { fits: false, why: ['for ages 65 years and up'] });
  assert.ok(quickFit({ minAge: '18 Years', sex: 'FEMALE' }, { age: 58, sex: 'female' }).fits);
  const t = mapStudy({ protocolSection: { identificationModule: { nctId: 'NCT05971940', briefTitle: 'X' }, eligibilityModule: { minimumAge: '18 Years', sex: 'ALL' } } });
  assert.equal(t.id, 'NCT05971940'); assert.equal(t.minAge, '18 Years');
  assert.match(ctgovSearchUrl({ cond: 'type 2 diabetes', loc: 'NJ' }), /^https:\/\/clinicaltrials\.gov\/search\?cond=type\+2\+diabetes&locStr=NJ&aggFilters=status%3Arec$/);
  console.log('health log + trials ok');
}
