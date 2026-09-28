const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../chart-core.js');
const data = require('../data/market-data.json');
test('hidden outlier series do not widen the remaining axis', () => {
  const values = { market: [0, 10, 20], bank: [0, 15, 30], tech: [-100, 1000, 2000], financing: [6, 8, 7] };
  const selected = { market: true, bank: true, tech: true, financing: true };
  const all = C.scaleForVisible(values, selected, 0, 2);
  const hidden = C.scaleForVisible(values, { ...selected, tech: false }, 0, 2);
  assert(hidden.left.max < all.left.max / 10);
  assert.deepEqual(hidden.right, all.right);
});
test('zoom ignores observations outside the selected time window', () => {
  const values = { market: [1000, 20, 21], bank: [null, null, null], tech: [null, null, null], financing: [50, 7, 7.2] };
  const selected = { market: true, financing: true };
  const all = C.scaleForVisible(values, selected, 0, 2);
  const zoom = C.scaleForVisible(values, selected, 1, 2);
  assert(zoom.left.max < all.left.max / 10);
  assert(zoom.right.max < 9);
});
test('single point, flat data, missing data, and all-hidden views have safe bounds', () => {
  for (const input of [[7], [7, 7, 7], [null, NaN, undefined], []]) {
    const scale = C.bounds(input, true);
    assert(Number.isFinite(scale.min) && Number.isFinite(scale.max) && scale.max > scale.min);
  }
  const values = { market: [1], bank: [2], tech: [3], financing: [4] };
  const hidden = C.scaleForVisible(values, {}, 0, 0);
  assert.equal(hidden.left.hasData, false);
  assert.equal(hidden.right.hasData, false);
});
test('missing values remain null and normalization uses the first common index date', () => {
  const rows = [{ date: '2024-01-02', market: null, bank: 20, tech: 30, financing: 7 }, { date: '2024-01-03', market: 10, bank: 20, tech: 40, financing: null }, { date: '2024-01-04', market: 12, bank: 30, tech: 44, financing: 8 }];
  const n = C.normalize(rows);
  assert.equal(n.baseDate, '2024-01-03');
  assert.equal(n.values.market[0], null);
  assert.equal(n.values.financing[1], null);
  assert(Math.abs(n.values.market[2] - 20) < 1e-10);
  assert.equal(n.values.bank[2], 50);
  assert.equal(C.normalize(rows, 'points').values.tech[2], 44);
});
test('non-trading dates snap inward and reversed / empty intervals are rejected', () => {
  const rows = [{ date: '2024-01-05' }, { date: '2024-01-08' }, { date: '2024-01-09' }];
  assert.deepEqual(C.rangeForDates(rows, '2024-01-06', '2024-01-09'), [1, 2]);
  assert.equal(C.rangeForDates(rows, '2024-01-06', '2024-01-07'), null);
  assert.equal(C.rangeForDates(rows, '2024-01-09', '2024-01-05'), null);
  assert.deepEqual(C.rangeForDates(rows, '2024-01-08', '2024-01-08'), [1, 1]);
});
test('saved data has ordered unique dates and an auditable financing calculation', () => {
  assert.equal(data.rows[0].date, '2024-01-02');
  assert.equal(new Set(data.rows.map(r => r.date)).size, data.rows.length);
  for (let i = 0; i < data.rows.length; i++) {
    const row = data.rows[i];
    if (i) assert(data.rows[i - 1].date < row.date);
    for (const key of ['market', 'bank', 'tech']) assert(row[key] === null || row[key] > 0);
    if (row.financing !== null) {
      assert.equal(row.financing, row.financingBuy / row.turnover * 100);
      assert(row.financing >= 0 && row.financing <= 100);
    }
  }
});
