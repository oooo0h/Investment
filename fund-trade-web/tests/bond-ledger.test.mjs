import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBondWorkbook } from '../scripts/bond-ledger.mjs';
import { calculateBondHoldingDuration, normalizeBondHoldingLots } from '../src/bond-holding-duration.js';
const row = (date, type, shares, amount) => ({ date, type, shares, amount, nav: 1, fee: 0, status: 'estimated' });
const quote = { date: '2026-10-15', nav: 1.2 };
test('complete workbook rows feed FIFO remaining value and provisional order-date lots without changing inputs', () => {
  const rows = [row('2026-09-01', 'buy', 10, 10), row('2026-10-03', 'buy', 20, 20), row('2026-10-10', 'sell', 12, 12)];
  const before = structuredClone(rows);
  const result = calculateBondWorkbook('006485', rows, quote);
  assert.deepEqual(result.entry, { code: '006485', marketValue: 21.6, holdingProfit: 3.6 });
  assert.deepEqual(result.holdingLots.lots, [{ orderDate: '2026-10-03', remainingShares: 18, status: 'confirmed' }]);
  assert.deepEqual(rows, before);
  assert.equal(result.holdingLots.complete, false);
  const normalized = normalizeBondHoldingLots({ '006485': result.holdingLots });
  const duration = calculateBondHoldingDuration(normalized['006485'], { now: '2026-10-19' });
  assert.equal(duration.status, 'calculated'); assert.equal(duration.dateBasis, 'order');
  assert.equal(duration.youngestDays, 16); assert.equal(duration.recentRatio, 1);
});
test('incomplete fields, missing opening shares, later trades and invalid quotes cannot create a holding', () => {
  for (const rows of [[row('2026-10-01', 'sell', 5, 5)], [{ ...row('2026-10-01', 'buy', 5, 5), fee: null }],
    [{ ...row('2026-10-01', 'buy', 5, 5), status: 'pending' }], [row('2026-10-16', 'buy', 5, 5)]]) {
    assert.equal(calculateBondWorkbook('006485', rows, quote), null);
  }
  const valid = [row('2026-10-01', 'buy', 5, 5)];
  const base = calculateBondWorkbook('006485', valid, quote);
  assert.deepEqual(calculateBondWorkbook('006485', [...valid, { status: 'pending', sourceStatus: 'processing' }], quote), base);
  assert.deepEqual(calculateBondWorkbook('006485', [...valid, { status: 'pending', sourceStatus: 'draft', date: null }], quote), base);
  assert.deepEqual(calculateBondWorkbook('006485', [...valid, { status: 'pending', date: '2026-10-19' }], quote), base);
  assert.equal(calculateBondWorkbook('006485', valid, { ...quote, nav: null }), null);
  assert.throws(() => normalizeBondHoldingLots({ '006485': { complete: true, lots: base.holdingLots.lots } }));
});
