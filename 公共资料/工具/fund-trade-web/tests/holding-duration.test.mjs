// All ledger rows and transactions below are synthetic; no account files are read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateHoldingDuration, createHoldingDurationScale } from '../holding-duration.js';
import { calculateLedger } from '../engine.js';

const now = new Date('2026-10-19T04:00:00Z');
const row = (date, type, shareChange, sharesAfter, extra = {}) => ({ status: 'included', date, type, shareChange, sharesAfter, ...extra });
const run = (rows, options = {}) => calculateHoldingDuration(rows, { now, ...options });
const unavailable = estimated => ({ status: 'unavailable', days: null, startDate: null, estimated });

test('a first acquisition starts calendar days, including weekends and same-day zero', () => {
  assert.deepEqual(run([row('2026-10-19', 'buy', 10, 10)]), {
    status: 'holding', days: 0, startDate: '2026-10-19', estimated: false,
  });
  assert.equal(run([row('2026-10-16', 'buy', 10, 10)]).days, 3);
  assert.equal(run([row('2026-10-01', 'buy', 10, 10)]).days, 18);
});

test('Beijing midnight advances the day independently of host timezone and NAV dates', () => {
  const rows = [row('2026-10-18', 'buy', 10, 10, { valuationDate: '2026-10-16' })];
  assert.equal(run(rows, { now: new Date('2026-10-18T15:59:59Z') }).days, 0);
  assert.equal(run(rows, { now: new Date('2026-10-18T16:00:00Z') }).days, 1);
});

test('partial sales, added purchases and both dividend types preserve the current start', () => {
  const result = run([
    row('2026-10-01', 'buy', 10, 10), row('2026-10-02', 'sip', 2, 12),
    row('2026-10-03', 'sell', -3, 9), row('2026-10-04', 'dividend', 0, 9),
    row('2026-10-05', 'reinvest', 1, 10), row('2026-10-06', 'transfer-in', 5, 15),
  ]);
  assert.deepEqual(result, { status: 'holding', days: 18, startDate: '2026-10-01', estimated: false });
});

test('a complete sale closes the cycle and a new acquisition resets it, preserving same-day order', () => {
  const initial = [row('2026-10-01', 'buy', 10, 10), row('2026-10-10', 'sell', -10, 0)];
  assert.deepEqual(run(initial), { status: 'closed', days: null, startDate: null, estimated: false });
  for (const type of ['buy', 'sip', 'transfer-in']) {
    assert.deepEqual(run([...initial, row('2026-10-10', type, 2, 2)]), {
      status: 'holding', days: 9, startDate: '2026-10-10', estimated: false,
    });
  }
});

test('unknown opening holdings never acquire an invented start, but a later flat restart can be known', () => {
  const opening = [row('2026-10-01', 'buy', 2, 12), row('2026-10-02', 'sell', -3, 9)];
  assert.deepEqual(run(opening), unavailable(false));
  assert.deepEqual(run([row('2026-10-01', 'reinvest', 1, 11)]), unavailable(false));
  assert.deepEqual(run([row('2026-10-01', 'dividend', 0, 10)]), unavailable(false));
  assert.equal(run([...opening, row('2026-10-03', 'sell', -9, 0)]).status, 'closed');
  assert.deepEqual(run([...opening, row('2026-10-03', 'sell', -9, 0), row('2026-10-04', 'buy', 5, 5)]), {
    status: 'holding', days: 15, startDate: '2026-10-04', estimated: false,
  });
});

test('pending, excluded and future transactions cannot alter today or create a starting point', () => {
  assert.deepEqual(run([]), unavailable(false));
  assert.deepEqual(run([{ status: 'pending' }, { status: 'excluded' }]), unavailable(false));
  assert.deepEqual(run([row('2026-10-20', 'buy', 10, 10)]), unavailable(false));
  const rows = [row('2026-10-01', 'buy', 10, 10), { status: 'pending', date: '2026-10-10', type: 'sell' },
    { status: 'excluded' }, row('2026-10-20', 'sell', -10, 0, { estimated: true })];
  assert.deepEqual(run(rows), { status: 'holding', days: 18, startDate: '2026-10-01', estimated: false });
  assert.equal(run([row('2026-10-01', 'sell', -10, 0), row('2026-10-20', 'buy', 2, 2)]).status, 'closed');
});

test('invalid dates, unsound statuses, errors and broken share chains remain unavailable', () => {
  const first = row('2026-10-01', 'buy', 10, 10);
  for (const rows of [null, {}, [null], [{ ...first, status: 'error' }], [{ ...first, status: 'blocked' }],
    [{ ...first, status: 'confirmed' }], [{ ...first, status: 'unknown' }],
    ...['2026-02-30', '2026-13-01', '2026-2-01', '', null].map(date => [{ ...first, date }]),
    [first, row('2026-09-30', 'buy', 2, 12)], [first, row('2026-10-02', 'buy', 2, 13)],
    [{ ...first, type: 'unknown' }], [{ ...first, sharesAfter: NaN }], [{ ...first, shareChange: Infinity }],
    [{ ...first, shareChange: undefined }], [row('2026-10-01', 'sell', -10, -1)],
    [row('2026-10-01', 'buy', -10, 10)], [row('2026-10-01', 'sell', 10, 10)],
    [row('2026-10-01', 'reinvest', 10, 10)], [row('2026-10-01', 'dividend', 0, 0)],
  ]) assert.deepEqual(run(rows), unavailable(false));
  assert.deepEqual(run([first], { hasErrors: true }), unavailable(false));
  assert.deepEqual(run([first], { now: new Date('invalid') }), unavailable(false));
});

test('real calendar dates include leap days, while impossible leap dates fail', () => {
  assert.equal(run([row('2024-02-29', 'buy', 10, 10)], { now: new Date('2024-03-01T04:00:00Z') }).days, 1);
  assert.deepEqual(run([row('2025-02-29', 'buy', 10, 10)]), unavailable(false));
});

test('estimates and incomplete history are marked without carrying a closed cycle into a fresh one', () => {
  const estimatedBuy = row('2026-10-01', 'buy', 10, 10, { estimated: true });
  assert.equal(run([estimatedBuy]).estimated, true);
  assert.equal(run([row('2026-10-01', 'buy', 10, 10)], { incomplete: true }).estimated, true);
  const rows = [estimatedBuy, row('2026-10-02', 'sell', -10, 0), row('2026-10-03', 'buy', 5, 5)];
  assert.equal(run(rows).estimated, false);
  assert.equal(run(rows, { incomplete: true }).estimated, true);
  assert.equal(run([row('2026-10-01', 'buy', 10, 10), row('2026-10-02', 'sell', -1, 9, { estimated: true })]).estimated, true);
});

test('six-decimal precision keeps a positive minimum share and matches ledger zero rounding', () => {
  assert.equal(run([row('2026-10-01', 'buy', 0.000001, 0.000001)]).status, 'holding');
  assert.equal(run([row('2026-10-01', 'buy', 1, 1), row('2026-10-02', 'sell', -0.999999, 0.000001)]).status, 'holding');
  assert.equal(run([row('2026-10-01', 'buy', 0.0000005, 0.000001)]).status, 'holding');
  assert.equal(run([row('2026-10-01', 'buy', 1, 1), row('2026-10-02', 'sell', -1, 0.0000001)]).status, 'closed');
  assert.deepEqual(run([row('2026-10-01', 'buy', 1, 1), row('2026-10-02', 'sell', -1.000001, -0.000001)]), unavailable(false));
});

test('synthetic calculateLedger output works directly and opening shares stay private', () => {
  const tx = (date, type, shares) => ({ date, type, shares, nav: 2, fee: 0 });
  const transactions = [tx('2026-10-01', 'buy', 10), tx('2026-10-02', 'sell', 10), tx('2026-10-03', 'sip', 5)];
  const ledger = calculateLedger(transactions);
  assert.equal(ledger.summary.valid, true);
  const result = run(ledger.rows);
  assert.deepEqual(result, { status: 'holding', days: 16, startDate: '2026-10-03', estimated: false });
  assert.deepEqual(Object.keys(result).sort(), ['status', 'days', 'startDate', 'estimated'].sort());
  const opening = calculateLedger([tx('2026-10-01', 'buy', 2)], { openingShares: 10, openingPrincipal: 20 });
  assert.deepEqual(run(opening.rows), unavailable(false));
});

test('the display scale keeps zero days truthful and one day finite', () => {
  assert.deepEqual(createHoldingDurationScale(0, 0.64), { maximum: 1, ratio: 0 });
  assert.deepEqual(createHoldingDurationScale(1, 0.64), { maximum: 1, ratio: 1 });
  assert.deepEqual(createHoldingDurationScale(1, 0.88), { maximum: 1, ratio: 1 });
});

test('the adaptive display maximum is an integer and positive holding fills more than sixty percent', () => {
  for (const days of [2, 7, 365, 10000, 1000000000, Number.MAX_SAFE_INTEGER]) {
    for (const fraction of [0.6000000000000001, 0.64, 0.76, 0.88, 0.9999999999999999]) {
      const result = createHoldingDurationScale(days, fraction);
      assert.equal(result.maximum, Math.max(days, Math.floor(days / fraction)));
      assert.equal(Number.isInteger(result.maximum), true);
      assert.ok(result.maximum >= days);
      assert.equal(result.ratio, days / result.maximum);
      assert.ok(result.ratio > 0.6 && result.ratio <= 1);
    }
  }
});

test('invalid day counts and fractions never produce a display scale', () => {
  for (const days of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10', null, undefined]) {
    assert.equal(createHoldingDurationScale(days, 0.75), null);
  }
  for (const fraction of [0, -1, 0.6, 1, 1.01, NaN, Infinity, '0.75', null, undefined]) {
    assert.equal(createHoldingDurationScale(10, fraction), null);
  }
});
