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
