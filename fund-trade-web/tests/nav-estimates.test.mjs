// Synthetic public NAV and return fixtures only. No accounts, files or storage read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEstimateDates, parseEstimatePercent, buildEstimatedNav } from '../src/nav-estimates.js';

const now = new Date('2026-10-21T04:00:00Z');
const official = (date, nav = 1) => ({ date, nav });
const estimate = (date, change) => ({ date, change });
const run = (history, entries, options = {}) => buildEstimatedNav(history, entries, { now, ...options });
const close = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-12, 'synthetic compounded NAV');

test('Beijing midnight determines today and yesterday independently of host timezone', () => {
  assert.deepEqual(getEstimateDates(new Date('2026-10-18T15:59:59Z')), { today: '2026-10-18', yesterday: '2026-10-17' });
  assert.deepEqual(getEstimateDates(new Date('2026-10-18T16:00:00Z')), { today: '2026-10-19', yesterday: '2026-10-18' });
  assert.deepEqual(getEstimateDates('2025-12-31T16:00:00Z'), { today: '2026-01-01', yesterday: '2025-12-31' });
  assert.deepEqual(getEstimateDates('2024-02-29T16:00:00Z'), { today: '2024-03-01', yesterday: '2024-02-29' });
  for (const invalid of [null, false, '', 'not-a-date', NaN, Infinity, new Date('invalid')]) {
    assert.deepEqual(getEstimateDates(invalid), { today: null, yesterday: null });
  }
});

test('percentage text accepts signed decimal input, optional percent and outer whitespace', () => {
  for (const [raw, ratio] of [['1.25', .0125], ['-1.25%', -.0125], [' +0.5% ', .005], ['.5', .005], ['-.5 %', -.005], ['0', 0], ['-0%', 0], ['1000', 10]]) {
    assert.equal(parseEstimatePercent(raw), ratio);
  }
  assert.equal(parseEstimatePercent('-99.99'), -.9999);
});

test('percentage text rejects partial, nondecimal, nonfinite and impossible NAV changes', () => {
  for (const value of [null, undefined, 1, true, {}, [], '', ' ', '%', '+', '-', '.', '1.', '1e2', '0x10', '1,000', '1%%', '1%foo', 'NaN', 'Infinity', '-100', '-101%', '1.2.3', '1 2', '1 2%', '9'.repeat(400), `0.${'0'.repeat(322)}5`]) {
    assert.equal(parseEstimatePercent(value), null);
  }
});

test('official points are sorted and sanitized, last valid duplicates win, and inputs stay unchanged', () => {
  const history = [official('2026-10-16', 1.1), official('2026-10-15', 1), official('2026-10-16', 1.2), official('2026-10-16', -1), { ...official('2026-10-19', 1.3), estimated: true }];
  const entries = [estimate('2026-10-20', .01)];
  const before = structuredClone({ history, entries });
  const result = run(history, entries);
  assert.deepEqual(result.points.slice(0, 2), [{ date: '2026-10-15', nav: 1, estimated: false }, { date: '2026-10-16', nav: 1.2, estimated: false }]);
  assert.equal(result.latestOfficialDate, '2026-10-16');
  assert.deepEqual({ history, entries }, before);
  assert.equal(history.some(point => point.baseDate), false);
});

test('estimates compound from the previous available point with explicit baseline metadata', () => {
  const result = run([official('2026-10-15')], [estimate('2026-10-20', -.05), estimate('2026-10-16', .1)]);
  assert.deepEqual(result.points.map(point => point.date), ['2026-10-15', '2026-10-16', '2026-10-20']);
  assert.deepEqual(result.points[1], { date: '2026-10-16', nav: 1.1, estimated: true, change: .1, baseDate: '2026-10-15', baseEstimated: false });
  close(result.points[2].nav, 1.045);
  assert.equal(result.points[2].baseDate, '2026-10-16');
  assert.equal(result.points[2].baseEstimated, true);
  assert.equal(result.points.some(point => ['2026-10-19', '2026-10-21'].includes(point.date)), false, 'unfilled dates remain absent');
  assert.deepEqual({ today: result.today, yesterday: result.yesterday }, { today: '2026-10-21', yesterday: '2026-10-20' });
});

test('official publication takes priority and removes every estimate through its latest date', () => {
  const entries = [estimate('2026-10-14', .2), estimate('2026-10-16', .5), estimate('2026-10-19', .8), estimate('2026-10-20', -.05)];
  const result = run([official('2026-10-15'), official('2026-10-19', 2)], entries);
  assert.deepEqual(result.pending, [estimate('2026-10-20', -.05)]);
  assert.deepEqual(result.points.map(point => point.date), ['2026-10-15', '2026-10-19', '2026-10-20']);
  assert.deepEqual(result.points[1], { date: '2026-10-19', nav: 2, estimated: false });
  close(result.points[2].nav, 1.9);
  assert.equal(result.points[2].baseDate, '2026-10-19');
  assert.equal(result.points[2].baseEstimated, false);
  const caughtUp = run([official('2026-10-20', 3)], entries);
  assert.deepEqual(caughtUp.pending, []);
  assert.deepEqual(caughtUp.points, [{ date: '2026-10-20', nav: 3, estimated: false }]);
});

test('no missing baseline is invented and valid rates remain pending until one becomes available', () => {
  const pending = [estimate('2026-10-19', .02), estimate('2026-10-20', -.01)];
  const missing = run([], pending);
  assert.deepEqual(missing.points, []);
  assert.deepEqual(missing.pending, pending);
  assert.equal(missing.latestOfficialDate, null);
  assert.deepEqual(run(null, pending).pending, pending);
  const laterBaseline = run([official('2026-10-16', 2)], pending);
  assert.equal(laterBaseline.points.length, 3);
  close(laterBaseline.points.at(-1).nav, 2 * 1.02 * .99);
});

test('only real calendar dates, positive finite NAVs and finite numeric return ratios are accepted', () => {
  const dates = ['2026-02-30', '2025-02-29', '2026-13-01', '2026-2-01', ' 2026-10-20', '2026-10-20T00:00:00Z', '', null];
  const invalidNavs = [0, -1, '1', true, null, NaN, Infinity, Number.MAX_SAFE_INTEGER];
  const invalidChanges = [null, undefined, true, '0.01', NaN, Infinity, -Infinity, -1, -1.01];
  const history = [official('2026-10-15'), ...dates.map(date => official(date)), ...invalidNavs.map(nav => official('2026-10-16', nav)), null];
  const entries = [...dates.map(date => estimate(date, .1)), ...invalidChanges.map(change => estimate('2026-10-20', change)), null];
  const result = run(history, entries);
  assert.deepEqual(result.points, [{ date: '2026-10-15', nav: 1, estimated: false }]);
  assert.deepEqual(result.pending, []);
  const leap = run([official('2024-02-29')], [estimate('2024-03-01', .1)], { now: new Date('2024-03-02T04:00:00Z') });
  assert.equal(leap.points.length, 2);
});

test('today has no estimated point, while an actual official point today is allowed', () => {
  const entries = [estimate('2026-10-20', .01), estimate('2026-10-21', .02), estimate('2026-10-22', .03)];
  assert.deepEqual(run([official('2026-10-19')], entries).pending, [estimate('2026-10-20', .01)]);
  assert.deepEqual(run([official('2026-10-21', 2), official('2026-10-22', 3)], entries).points, [{ date: '2026-10-21', nav: 2, estimated: false }]);
  assert.deepEqual(run([official('2026-10-19')], entries, { now: new Date('invalid') }), {
    points: [], pending: [], today: null, yesterday: null, latestOfficialDate: null,
  });
});

test('duplicate rates use the last valid value and zero is a deliberate estimate rather than a blank day', () => {
  const result = run([official('2026-10-15')], [estimate('2026-10-20', .01), estimate('2026-10-20', .03), estimate('2026-10-20', NaN), estimate('2026-10-19', 0)]);
  assert.deepEqual(result.pending, [estimate('2026-10-19', 0), estimate('2026-10-20', .03)]);
  assert.equal(result.points[1].estimated, true);
  assert.equal(result.points[1].nav, 1);
  assert.equal(result.points[2].baseDate, '2026-10-19');
});

test('overflow or chart-unsafe derived NAVs are not plotted and remain pending', () => {
  const entries = [estimate('2026-10-16', Number.MAX_VALUE), estimate('2026-10-20', -.1)];
  const result = run([official('2026-10-15', 2)], entries);
  assert.deepEqual(result.pending, entries);
  assert.deepEqual(result.points.map(point => point.date), ['2026-10-15', '2026-10-20']);
  assert.equal(result.points[1].nav, 1.8);
  assert.equal(result.points[1].baseDate, '2026-10-15');
  const limit = Number.MAX_SAFE_INTEGER / 10000;
  assert.equal(run([official('2026-10-15', limit)], [estimate('2026-10-20', 1)]).points.length, 1);
  assert.equal(run([official('2026-10-15', Number.MIN_VALUE)], [estimate('2026-10-20', -.9)]).points.length, 1);
});

test('pending storage payloads never contain computed NAV or arbitrary source fields', () => {
  const entry = { date: '2026-10-20', change: .01, fundCode: '005698', note: 'synthetic-untrusted', arbitrary: 42 };
  const history = [Object.freeze({ date: '2026-10-19', nav: 1, note: 'synthetic-official' })];
  const result = run(history, [Object.freeze(entry)]);
  assert.deepEqual(result.pending, [{ date: '2026-10-20', change: .01 }]);
  assert.deepEqual(Object.keys(result.points[0]).sort(), ['date', 'estimated', 'nav']);
  assert.equal(JSON.stringify(result).includes('synthetic-untrusted'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-official'), false);
  const refreshed = run(history, result.pending);
  assert.deepEqual(refreshed, result);
  result.points[0].nav = 99;
  assert.equal(history[0].nav, 1);
});
