import test from 'node:test';
import assert from 'node:assert/strict';
import { NAV_PERIODS, resolveNavRange, moveNavBoundary, resolveNavSliderDomain, summarizeNavRange } from '../src/nav-range.js';

const history = dates => dates.map((date, index) => ({ date, nav: 1 + index / 100 }));

test('trend and latest-trade shortcuts preserve all seven calendar shortcuts', () => {
  assert.deepEqual(NAV_PERIODS.map(period => period.label), ['最近下跌', '最近上涨', '自交易以来', '最近1个月', '上个月', '最近3个月', '最近半年', '最近1年', '最近3年', '成立以来']);
  assert.equal(NAV_PERIODS[0].id, 'recent-decline');
  assert.equal(NAV_PERIODS[1].id, 'recent-rise');
});

test('rolling months clamp month-end and leap-year boundaries using the latest NAV', () => {
  const rows = history(['2024-02-28', '2024-02-29', '2024-03-01', '2024-03-31']);
  assert.equal(resolveNavRange(rows, { preset: '1m' }).from, '2024-02-29');
  const annual = history(['2023-02-28', '2023-03-01', '2024-02-29']);
  assert.equal(resolveNavRange(annual, { preset: '1y' }).from, '2023-02-28');
});

test('previous month means the previous complete calendar month across New Year', () => {
  const rows = history(['2025-11-28', '2025-12-01', '2025-12-31', '2026-01-09']);
  const result = resolveNavRange(rows, { preset: 'last-month' });
  assert.deepEqual(result.points.map(point => point.date), ['2025-12-01', '2025-12-31']);
});

test('multi-month and year shortcuts clip to the available NAV history', () => {
  const rows = history(['2023-01-02', '2025-10-16', '2026-04-16', '2026-07-16', '2026-10-16']);
  assert.equal(resolveNavRange(rows, { preset: '3m' }).from, '2026-07-16');
  assert.equal(resolveNavRange(rows, { preset: '6m' }).from, '2026-04-16');
  assert.equal(resolveNavRange(rows, { preset: '1y' }).from, '2025-10-16');
  assert.equal(resolveNavRange(rows, { preset: '3y' }).from, '2025-10-16');
  assert.equal(resolveNavRange(rows, { preset: 'all' }).from, '2023-01-02');
});

test('slider boundaries stay ordered and can select a single published date', () => {
  const rows = history(['2026-01-02', '2026-01-05', '2026-01-06']);
  const selection = moveNavBoundary(rows, { preset: 'all' }, 'start', 99);
  assert.deepEqual(selection, { from: '2026-01-06', to: '2026-01-06' });
  assert.deepEqual(moveNavBoundary(rows, selection, 'end', -99), selection);
  assert.equal(resolveNavRange(rows, selection).points.length, 1);
  assert.equal(resolveNavRange(rows, selection).preset, null);
});

test('custom dates remain pinned when refreshed history gains earlier and later observations', () => {
  const selection = { from: '2026-01-05', to: '2026-01-06' };
  const rows = history(['2025-12-31', '2026-01-05', '2026-01-06', '2026-01-07']);
  assert.deepEqual(resolveNavRange(rows, selection).points.map(point => point.date), ['2026-01-05', '2026-01-06']);
});

test('empty history and unavailable previous-month history have explicit empty ranges', () => {
  assert.deepEqual(resolveNavRange([]).points, []);
  const rows = history(['2026-01-05']);
  const result = resolveNavRange(rows, { preset: 'last-month' });
  assert.deepEqual(result.points, []);
  assert.equal(result.from, '2025-12-01');
  assert.equal(result.to, '2025-12-31');
  assert.deepEqual(moveNavBoundary([], { preset: 'all' }, 'start', 0), { preset: 'all' });
});

test('range values and change follow both selected boundaries instead of the latest daily change', () => {
  const rows = [
    { date: '2026-01-01', nav: 1 }, { date: '2026-01-02', nav: 1.1 },
    { date: '2026-01-03', nav: 1.2 }, { date: '2026-01-04', nav: 1.05 },
  ];
  const full = summarizeNavRange(resolveNavRange(rows, { preset: 'all' }).points);
  const custom = summarizeNavRange(resolveNavRange(rows, { from: '2026-01-02', to: '2026-01-03' }).points);
  assert.equal(full.endNav, 1.05);
  assert.ok(Math.abs(full.change - 0.05) < 1e-12);
  assert.equal(custom.endDate, '2026-01-03');
  assert.equal(custom.endNav, 1.2);
  assert.ok(Math.abs(custom.change - (1.2 / 1.1 - 1)) < 1e-12);
});

test('one selected observation has zero range change and an empty range has no quote', () => {
  const one = summarizeNavRange([{ date: '2026-01-01', nav: 1.25 }]);
  assert.equal(one.change, 0);
  assert.equal(one.startDate, one.endDate);
  assert.equal(summarizeNavRange([]).endNav, null);
  assert.equal(summarizeNavRange([{ date: '2026-01-01', nav: 0 }]).change, null);
});

const navHistory = values => values.map((nav, index) => ({ date: `2026-01-${String(index + 1).padStart(2, '0')}`, nav }));

for (const { name, values, start } of [
  { name: 'a peak plateau uses its rightmost published date', values: [1, 1.4, 1.4, 1.2, 1.1], start: 2 },
  { name: 'a V-shaped rebound below the peak remains in the same decline', values: [1, 1.4, 1.1, 1.25], start: 1 },
  { name: 'a monotonic decline can start at the history boundary', values: [1.4, 1.3, 1.2], start: 0 },
  { name: 'a boundary plateau starts at its rightmost date', values: [1.4, 1.4, 1.3, 1.2], start: 1 },
  { name: 'the nearest valid local peak wins over an older higher peak', values: [1, 2, 1.3, 1.7, 1.4], start: 3 },
  { name: 'a flat latest valley still belongs to the unrecovered peak', values: [1, 1.5, 1.5, 1.2, 1.2], start: 2 },
]) test(`recent decline: ${name}`, () => {
  const rows = navHistory(values);
  const result = resolveNavRange(rows, { preset: 'recent-decline' });
  assert.equal(result.start, start);
  assert.equal(result.end, rows.length - 1);
  assert.equal(result.from, rows[start].date);
  assert.equal(result.to, rows.at(-1).date);
  assert.deepEqual(result.points, rows.slice(start));
  assert.equal(result.declineAvailable, true);
  assert.ok(summarizeNavRange(result.points).change < 0);
});

for (const { name, values } of [
  { name: 'a new high', values: [1, 1.4, 1.2, 1.5] },
  { name: 'a complete recovery to the previous peak', values: [1, 1.4, 1.2, 1.4] },
  { name: 'a crossed recent peak with an older higher peak', values: [1, 2, 1.3, 1.5, 1.4, 1.6] },
  { name: 'a revisited recent peak with an older higher peak', values: [1, 2, 1.3, 1.6, 1.4, 1.6] },
  { name: 'strictly increasing history', values: [1, 1.1, 1.2] },
  { name: 'entirely flat history', values: [1, 1, 1] },
  { name: 'a single published observation', values: [1.2] },
]) test(`recent decline returns only the latest observation for ${name}`, () => {
  const rows = navHistory(values);
  const result = resolveNavRange(rows, { preset: 'recent-decline' });
  assert.equal(result.start, rows.length - 1);
  assert.equal(result.end, rows.length - 1);
  assert.equal(result.from, rows.at(-1).date);
  assert.equal(result.to, rows.at(-1).date);
  assert.deepEqual(result.points, [rows.at(-1)]);
  assert.equal(result.declineAvailable, false);
  assert.equal(summarizeNavRange(result.points).change, 0);
});

test('an available recent decline is the default and empty history falls back to three months', () => {
  const rows = navHistory([1, 1.4, 1.2]);
  assert.deepEqual(resolveNavRange(rows), resolveNavRange(rows, { preset: 'recent-decline' }));
  assert.deepEqual(resolveNavRange([]), {
    start: 0, end: 0, from: null, to: null, points: [], preset: '3m', declineAvailable: false, riseAvailable: false, tradeAvailable: false,
  });
});

test('moving a recent-decline boundary creates a regular custom range', () => {
  const rows = navHistory([1, 1.4, 1.2, 1.25]);
  const selection = moveNavBoundary(rows, { preset: 'recent-decline' }, 'start', 0);
  assert.deepEqual(selection, { from: rows[0].date, to: rows.at(-1).date });
  const result = resolveNavRange(rows, selection);
  assert.equal(result.preset, null);
  assert.deepEqual(result.points, rows);
});

test('an active recent-decline shortcut follows the latest published date after refresh', () => {
  const selection = { preset: 'recent-decline' };
  const rows = navHistory([1, 1.4, 1.1]);
  const before = resolveNavRange(rows, selection);
  const after = resolveNavRange([...rows, { date: '2026-01-05', nav: 1.2 }], selection);
  assert.equal(after.from, before.from);
  assert.equal(after.to, '2026-01-05');
  assert.equal(after.declineAvailable, true);
});

for (const { name, values, start } of [
  { name: 'a trough plateau uses its rightmost published date', values: [2, 1.4, 1.4, 1.7, 1.8], start: 2 },
  { name: 'a pullback above the trough remains in the same rise', values: [2, 1.4, 1.8, 1.6], start: 1 },
  { name: 'a monotonic rise can start at the history boundary', values: [1.2, 1.3, 1.4], start: 0 },
  { name: 'a boundary plateau starts at its rightmost date', values: [1.2, 1.2, 1.3, 1.4], start: 1 },
  { name: 'the nearest valid local trough wins over an older lower trough', values: [2, 1, 1.8, 1.4, 1.7], start: 3 },
  { name: 'a flat latest peak still belongs to the rise', values: [2, 1.4, 1.4, 1.7, 1.7], start: 2 },
]) test(`recent rise: ${name}`, () => {
  const rows = navHistory(values);
  const result = resolveNavRange(rows, { preset: 'recent-rise' });
  assert.equal(result.start, start);
  assert.equal(result.end, rows.length - 1);
  assert.equal(result.from, rows[start].date);
  assert.equal(result.to, rows.at(-1).date);
  assert.deepEqual(result.points, rows.slice(start));
  assert.equal(result.riseAvailable, true);
  assert.ok(summarizeNavRange(result.points).change > 0);
});

for (const { name, values } of [
  { name: 'a new low', values: [2, 1.4, 1.7, 1.2] },
  { name: 'a complete return to the previous trough', values: [2, 1.4, 1.7, 1.4] },
  { name: 'a broken recent trough with an older lower trough', values: [2, 1, 1.8, 1.5, 1.6, 1.4] },
  { name: 'a revisited recent trough with an older lower trough', values: [2, 1, 1.8, 1.4, 1.6, 1.4] },
  { name: 'strictly decreasing history', values: [1.4, 1.3, 1.2] },
  { name: 'entirely flat history', values: [1, 1, 1] },
  { name: 'a single published observation', values: [1.2] },
]) test(`recent rise returns only the latest observation for ${name}`, () => {
  const rows = navHistory(values);
  const result = resolveNavRange(rows, { preset: 'recent-rise' });
  assert.equal(result.start, rows.length - 1);
  assert.equal(result.end, rows.length - 1);
  assert.equal(result.from, rows.at(-1).date);
  assert.equal(result.to, rows.at(-1).date);
  assert.deepEqual(result.points, [rows.at(-1)]);
  assert.equal(result.riseAvailable, false);
  assert.equal(summarizeNavRange(result.points).change, 0);
});

test('all shortcuts and custom ranges report both independent movement availability flags', () => {
  const cases = [
    { values: [], declineAvailable: false, riseAvailable: false },
    { values: [1.2], declineAvailable: false, riseAvailable: false },
    { values: [1, 1.1, 1.2], declineAvailable: false, riseAvailable: true },
    { values: [1.2, 1.1, 1], declineAvailable: true, riseAvailable: false },
    { values: [1, 1.4, 1.1, 1.2], declineAvailable: true, riseAvailable: true },
    { values: [1, 2, 1.3, 1.5, 1.4, 1.6], declineAvailable: false, riseAvailable: true },
    { values: [2, 1, 1.8, 1.5, 1.6, 1.4], declineAvailable: true, riseAvailable: false },
    { values: [1, 1, 1], declineAvailable: false, riseAvailable: false },
  ];
  const selections = [
    ...NAV_PERIODS.map(({ id }) => ({ preset: id })),
    { from: '2026-01-02', to: '2026-01-02' },
  ];
  for (const { values, declineAvailable, riseAvailable } of cases) {
    for (const selection of selections) {
      const range = resolveNavRange(navHistory(values), selection);
      assert.equal(range.declineAvailable, declineAvailable);
      assert.equal(range.riseAvailable, riseAvailable);
    }
  }
});

test('recent rise follows the latest published date and manual boundaries remain ordinary custom ranges', () => {
  const selection = { preset: 'recent-rise' };
  const rows = navHistory([2, 1.4, 1.7]);
  const result = resolveNavRange([...rows, { date: '2026-01-05', nav: 1.6 }], selection);
  assert.equal(result.from, rows[1].date);
  assert.equal(result.to, '2026-01-05');
  assert.equal(result.riseAvailable, true);
  const custom = moveNavBoundary(rows, selection, 'start', 0);
  assert.deepEqual(custom, { from: rows[0].date, to: rows.at(-1).date });
  assert.equal(resolveNavRange(rows, custom).preset, null);
});

test('the single recent-move choice follows the latest turn, with a three-month fallback', () => {
  const cases = [
    { values: [1, 1.4, 1.1, 1.2], preset: 'recent-rise' },
    { values: [1, 1.1, 1.2], preset: 'recent-rise' },
    { values: [1, 2, 1.3, 1.5, 1.4, 1.6], preset: 'recent-rise' },
    { values: [2, 1, 1.8, 1.5, 1.6, 1.4], preset: 'recent-decline' },
    { values: [1, 1, 1], preset: '3m' },
    { values: [1.2], preset: '3m' },
    { values: [], preset: '3m' },
  ];
  for (const { values, preset } of cases) {
    const rows = navHistory(values);
    assert.deepEqual(resolveNavRange(rows), resolveNavRange(rows, { preset }));
  }
});

for (const { preset, available, values, latest } of [
  { preset: 'recent-decline', available: 'declineAvailable', values: [1, 2, 1.3, 1.5, 1.4], latest: 1.6 },
  { preset: 'recent-rise', available: 'riseAvailable', values: [2, 1, 1.8, 1.5, 1.6], latest: 1.4 },
]) test(`${preset} becomes unavailable after refresh crosses the newest same-kind turn`, () => {
  const selection = { preset };
  const rows = navHistory(values);
  const before = resolveNavRange(rows, selection);
  assert.equal(before[available], true);
  assert.equal(before.start, 3);
  const refreshed = [...rows, { date: '2026-01-09', nav: latest }];
  const after = resolveNavRange(refreshed, selection);
  assert.equal(after[available], false);
  assert.deepEqual(after.points, [refreshed.at(-1)]);
  assert.equal(after.from, '2026-01-09');
  assert.equal(after.to, '2026-01-09');
  assert.equal(summarizeNavRange(after.points).change, 0);
});

const sliderHistory = (length, offset = 0) => Array.from({ length }, (_, index) => ({
  date: new Date(Date.UTC(2020, 0, index + offset + 1)).toISOString().slice(0, 10), nav: 1,
}));

test('slider initial domain uses three selected spans with at least twelve observations', () => {
  const rows = sliderHistory(100);
  const range = { start: 90, end: 99 };
  assert.deepEqual(resolveNavSliderDomain(rows, range), { min: 72, max: 99, from: rows[72].date, to: rows[99].date });
  const short = resolveNavSliderDomain(rows, { start: 98, end: 99 });
  assert.equal(short.min, 88);
  assert.equal(short.max - short.min + 1, 12);
  assert.ok((99 - 98) / (short.max - short.min) > (99 - 98) / 99);
  const older = resolveNavSliderDomain(rows, { start: 20, end: 30 });
  assert.equal(older.min, 20);
  assert.equal(older.max, 99);
});

test('a stored slider domain stays date-anchored when refresh adds earlier and later published observations', () => {
  const rows = sliderHistory(100);
  const previous = { from: rows[60].date, to: rows[99].date };
  assert.equal(resolveNavSliderDomain(rows, { start: 90, end: 99 }, previous).min, 60);
  const extended = sliderHistory(115, -5);
  const range = resolveNavRange(extended, { from: rows[90].date, to: rows[99].date });
  const domain = resolveNavSliderDomain(extended, range, previous);
  assert.equal(domain.min, 65);
  assert.equal(domain.from, previous.from);
  assert.equal(domain.max, extended.length - 1);
  assert.equal(domain.to, extended.at(-1).date);
});

test('the start thumb expands the earlier domain at the inclusive twelve-percent edge threshold', () => {
  const rows = sliderHistory(101);
  const previous = { from: rows[50].date, to: rows[100].date };
  const edge = resolveNavSliderDomain(rows, { start: 56, end: 100 }, previous, { phase: 'drag', boundary: 'start' });
  assert.equal(edge.min, 25);
  assert.equal(edge.max, 100);
  const inside = resolveNavSliderDomain(rows, { start: 57, end: 100 }, previous, { phase: 'drag', boundary: 'start' });
  assert.equal(inside.min, 50);
});

test('drag expansion adds at least six observations and stops at the earliest published date', () => {
  const rows = sliderHistory(101);
  const nearEnd = { from: rows[95].date, to: rows[100].date };
  const expanded = resolveNavSliderDomain(rows, { start: 95, end: 100 }, nearEnd, { phase: 'drag', boundary: 'start' });
  assert.equal(expanded.min, 89);
  const nearBeginning = { from: rows[3].date, to: rows[100].date };
  const earliest = resolveNavSliderDomain(rows, { start: 3, end: 100 }, nearBeginning, { phase: 'drag', boundary: 'start' });
  assert.equal(earliest.min, 0);
  assert.equal(earliest.from, rows[0].date);
  assert.equal(resolveNavSliderDomain(rows, { start: 0, end: 100 }, earliest, { phase: 'drag', boundary: 'start' }).min, 0);
});

test('dragging inward or moving the end thumb keeps the current earlier limit', () => {
  const rows = sliderHistory(101);
  const previous = { from: rows[40].date, to: rows[100].date };
  assert.equal(resolveNavSliderDomain(rows, { start: 90, end: 100 }, previous, { phase: 'drag', boundary: 'start' }).min, 40);
  assert.equal(resolveNavSliderDomain(rows, { start: 40, end: 100 }, previous, { phase: 'drag', boundary: 'end' }).min, 40);
  assert.equal(resolveNavSliderDomain(rows, { start: 90, end: 100 }, previous, { phase: 'commit', boundary: 'end' }).min, 40);
});

test('committing the start thumb inward shrinks context without excluding either selected boundary', () => {
  const rows = sliderHistory(101);
  const previous = { from: rows[30].date, to: rows[100].date };
  const domain = resolveNavSliderDomain(rows, { start: 90, end: 100 }, previous, { phase: 'commit', boundary: 'start' });
  assert.equal(domain.min, 70);
  assert.ok(domain.min >= 30 && domain.min <= 90);
  assert.equal(domain.max, 100);
  const unchanged = resolveNavSliderDomain(rows, { start: 60, end: 100 }, previous, { phase: 'commit', boundary: 'start' });
  assert.equal(unchanged.min, 30);
});

test('commit shrinking uses the inclusive thirty-five-percent inward threshold', () => {
  const rows = sliderHistory(101);
  const previous = { from: rows[40].date, to: rows[100].date };
  const below = resolveNavSliderDomain(rows, { start: 60, end: 62 }, previous, { phase: 'commit', boundary: 'start' });
  const threshold = resolveNavSliderDomain(rows, { start: 61, end: 63 }, previous, { phase: 'commit', boundary: 'start' });
  assert.equal(below.min, 40);
  assert.equal(threshold.min, 61);
});

test('slider domain clamps replaced history and always includes an earlier selected start', () => {
  const rows = sliderHistory(30);
  const previous = { from: rows[15].date, to: rows[29].date };
  const earlier = resolveNavSliderDomain(rows, { start: 10, end: 20 }, previous);
  assert.equal(earlier.min, 10);
  const truncated = sliderHistory(20, 5);
  const domain = resolveNavSliderDomain(truncated, { start: 15, end: 19 }, { from: rows[0].date, to: rows[29].date });
  assert.equal(domain.min, 0);
  assert.equal(domain.max, 19);
  const invalid = resolveNavSliderDomain(rows, { start: 25, end: 29 }, { from: 'unavailable', to: rows[29].date });
  assert.deepEqual(invalid, resolveNavSliderDomain(rows, { start: 25, end: 29 }));
});

test('empty, single-date, and short slider histories have safe published-date bounds', () => {
  assert.deepEqual(resolveNavSliderDomain([], { start: 0, end: 0 }), { min: 0, max: 0, from: null, to: null });
  const one = sliderHistory(1);
  assert.deepEqual(resolveNavSliderDomain(one, { start: 0, end: 0 }), { min: 0, max: 0, from: one[0].date, to: one[0].date });
  const short = sliderHistory(5);
  assert.deepEqual(resolveNavSliderDomain(short, { start: 3, end: 4 }), { min: 0, max: 4, from: short[0].date, to: short[4].date });
});

test('since-trade starts from the latest provided operation and follows the latest published NAV', () => {
  const rows = navHistory([1, 1.2, 1.1, 1.3]);
  const range = resolveNavRange(rows, { preset: 'since-trade' }, { tradeDate: rows[2].date });
  assert.equal(range.tradeAvailable, true);
  assert.deepEqual(range.points, rows.slice(2));
  assert.equal(range.to, rows.at(-1).date);
  assert.deepEqual(moveNavBoundary(rows, { preset: 'since-trade' }, 'start', 1, { tradeDate: rows[2].date }), { from: rows[1].date, to: rows.at(-1).date });
});

test('since-trade is unavailable without a valid operation before the last NAV and does not invent prices', () => {
  const rows = navHistory([1, 1.2]);
  for (const tradeDate of [null, '', '2026-02-31', '2026-01-03']) {
    const range = resolveNavRange(rows, { preset: 'since-trade' }, { tradeDate });
    assert.equal(range.tradeAvailable, false);
    assert.deepEqual(range.points, [rows.at(-1)]);
  }
  const missingDay = resolveNavRange([{ date: '2026-01-01', nav: 1 }, { date: '2026-01-05', nav: 2 }], { preset: 'since-trade' }, { tradeDate: '2026-01-03' });
  assert.equal(missingDay.from, '2026-01-05');
  assert.equal(missingDay.points.length, 1);
});
