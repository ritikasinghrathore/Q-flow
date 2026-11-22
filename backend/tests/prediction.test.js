const test = require('node:test'); const assert = require('node:assert');
const { weightedStats, predict, arrivalWindow } = require('../src/services/prediction.service');
test('newer consultations weigh more than older ones', () => {
  const simple = (600 * 3 + 300 * 3) / 6;
  assert.ok(weightedStats([600, 600, 600, 300, 300, 300]).mean < simple, 'recent short visits should pull the mean down');
  assert.ok(weightedStats([300, 300, 300, 600, 600, 600]).mean > simple, 'recent long visits should pull the mean up');
});
test('weights are normalised: constant data gives that constant', () => {
  const s = weightedStats([480, 480, 480, 480]); assert.ok(Math.abs(s.mean - 480) < 1e-9); assert.ok(s.sd < 1e-9);
});
test('estimate grows with patients ahead', () => {
  const d = [480, 500, 460, 520, 480, 490, 470, 510, 480, 500];
  const a = predict({ durations: d, ahead: 1 }), b = predict({ durations: d, ahead: 5 });
  assert.ok(b.maxMinutes > a.maxMinutes && b.minMinutes > a.minMinutes);
});
test('a consultation in progress counts its actual remaining time, not a fixed half', () => {
  const d = Array(10).fill(600);
  const fresh = predict({ durations: d, ahead: 0, hasActive: true, activeElapsedSec: 0 });
  const late = predict({ durations: d, ahead: 0, hasActive: true, activeElapsedSec: 540 });
  assert.ok(fresh.maxMinutes > late.maxMinutes);
  assert.ok(fresh.factors.remainingMinutesForCurrent > late.factors.remainingMinutesForCurrent);
});
test('pause, unavailability and delay widen the estimate and cap confidence', () => {
  const d = Array(12).fill(480), base = predict({ durations: d, ahead: 2 });
  const paused = predict({ durations: d, ahead: 2, paused: true }), delayed = predict({ durations: d, ahead: 2, delayMin: 10 });
  assert.equal(base.confidence, 'high'); assert.equal(paused.confidence, 'low'); assert.ok(paused.maxMinutes > base.maxMinutes); assert.ok(delayed.minMinutes >= base.minMinutes + 9);
});
test('no data means low confidence and an honest default', () => {
  const p = predict({ durations: [], ahead: 3 }); assert.equal(p.confidence, 'low'); assert.match(p.factors.dataSource, /no data/);
});
test('range is always valid and never negative', () => {
  const p = predict({ durations: [300, 900, 400], ahead: 0 }); assert.ok(p.minMinutes >= 0 && p.maxMinutes > p.minMinutes);
});
test('arrival window: near turn means arrive now, otherwise a later window', () => {
  assert.equal(arrivalWindow({ minMinutes: 5, maxMinutes: 12 }).arriveNow, true);
  const w = arrivalWindow({ minMinutes: 40, maxMinutes: 60 }); assert.equal(w.arriveNow, false); assert.ok(w.fromMinutes === 25 && w.toMinutes >= w.fromMinutes + 5);
});
