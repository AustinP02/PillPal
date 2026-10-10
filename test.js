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
