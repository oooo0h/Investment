import test from 'node:test';
import assert from 'node:assert/strict';
import { getNavChartDisplay } from '../nav-display.js';
import { buildEstimatedNav } from '../nav-estimates.js';
import { renderNavChart } from '../nav-chart.js';
import { summarizeNavRange } from '../nav-range.js';

// Invented public NAVs and percentage changes only; no account fixtures.
const point = (date, nav) => ({ date, nav });
const official = [point('2026-01-01', 1), point('2026-01-15', 1.5), point('2026-01-16', 2)];
const estimates = [
  { date: '2026-01-17', nav: 2.2, estimated: true, change: .1 },
  { date: '2026-01-18', nav: 2.09, estimated: true, change: -.05 },
];
const data = () => ({ points: [...official, ...estimates], latestOfficialDate: '2026-01-16', today: '2026-01-19' });
const emptySummary = { startDate: null, endDate: null, startNav: null, endNav: null, change: null };

test('headline uses the same estimated endpoint as the chart and the selected official starting NAV', () => {
  const display = getNavChartDisplay({ points: official.slice(1), preset: '1m' }, data());
  assert.deepEqual(display.points, official.slice(1));
  assert.deepEqual(display.estimatedPoints, estimates);
  assert.equal(display.domainEnd, '2026-01-19');
  assert.deepEqual(display.summary, { startDate: '2026-01-15', endDate: '2026-01-18', startNav: 1.5, endNav: 2.09, change: 2.09 / 1.5 - 1 });
  assert.notEqual(display.summary.change, estimates.at(-1).change, 'the headline is an interval return, not the final daily percentage');
  const markup = renderNavChart(display.points, { estimatedPoints: display.estimatedPoints, domainEnd: display.domainEnd });
  const payload = JSON.parse(/data-nav-points="([^"]+)"/.exec(markup)[1].replaceAll('&quot;', '"'));
  assert.equal(payload.at(-1).nav, display.summary.endNav);
  assert.equal(payload.at(-1).date, display.summary.endDate);
  assert.deepEqual(Object.keys(display).sort(), ['domainEnd', 'estimatedPoints', 'points', 'summary']);
});

test('a historical range ending before the latest published day excludes all estimates', () => {
  const selected = official.slice(0, 2);
  const display = getNavChartDisplay({ points: selected, preset: null }, data());
  assert.deepEqual(display.points, selected);
  assert.deepEqual(display.estimatedPoints, []);
  assert.equal(display.domainEnd, null);
  assert.deepEqual(display.summary, summarizeNavRange(selected));
});

test('last-month never adds estimates even when its observed endpoint equals the latest official date', () => {
  const display = getNavChartDisplay({ points: official, preset: 'last-month' }, data());
  assert.deepEqual(display.estimatedPoints, []);
  assert.equal(display.domainEnd, null);
  assert.deepEqual(display.summary, summarizeNavRange(official));
});

test('manual and available trend selections reaching the latest official day retain current live-chart behavior', () => {
  for (const preset of [null, 'all', 'recent-decline', 'recent-rise', 'since-trade']) {
    const display = getNavChartDisplay({ points: official.slice(1), preset }, data());
    assert.equal(display.estimatedPoints.length, 2);
    assert.equal(display.summary.endDate, '2026-01-18');
    assert.equal(display.summary.startDate, '2026-01-15');
  }
});

test('empty and unavailable selections do not create a chart or headline from estimates alone', () => {
  for (const range of [undefined, null, {}, { points: [] }, { points: official, unavailable: true }]) {
    const display = getNavChartDisplay(range, data());
    assert.deepEqual(display.points, []);
    assert.deepEqual(display.estimatedPoints, []);
    assert.equal(display.domainEnd, null);
    assert.deepEqual(display.summary, emptySummary);
  }
});

test('today is only an axis domain ending and never invents a value when no estimate exists', () => {
  const display = getNavChartDisplay({ points: official, preset: 'all' }, { ...data(), points: official });
  assert.equal(display.domainEnd, '2026-01-19');
  assert.deepEqual(display.estimatedPoints, []);
  assert.equal(display.summary.endDate, '2026-01-16');
  assert.equal(display.summary.endNav, 2);
});

test('one official point plus an estimate has a valid interval return without an invented earlier base', () => {
  const display = getNavChartDisplay({ points: official.slice(-1), preset: 'all' }, data());
  assert.equal(display.summary.startDate, '2026-01-16');
  assert.equal(display.summary.startNav, 2);
  assert.equal(display.summary.endNav, 2.09);
  assert.equal(display.summary.change, 2.09 / 2 - 1);
});

test('official observations replace same-day estimates and output contains only drawable public fields', () => {
  const selected = [...official, point('2026-01-18', 2.15)];
  const inputData = { ...data(), latestOfficialDate: '2026-01-18', points: [...selected, { ...estimates[1], nav: 999, amount: 'not-for-output' }] };
  const display = getNavChartDisplay({ points: selected, preset: 'all' }, inputData);
  assert.deepEqual(display.estimatedPoints, []);
  assert.equal(display.summary.endNav, 2.15);
  assert.equal(display.summary.endDate, '2026-01-18');
  assert.doesNotMatch(JSON.stringify(display), /not-for-output|amount/);
});

test('point sanitizing, date limits and duplicate policy match what the renderer can draw', () => {
  const selected = [official[2], { ...official[0], shares: 'not-for-output' }, official[1], point('2026-01-16', 2.01),
    point('2026-02-30', 2), point('2026-01-10', Infinity), point('2026-01-11', 0)];
  const inputData = { ...data(), points: [
    ...estimates, { ...estimates[0], nav: 2.21, note: 'not-for-output' },
    { date: '2025-12-31', nav: 1, estimated: true }, { date: '2026-01-20', nav: 2.3, estimated: true },
    { date: '2026-01-18', nav: Infinity, estimated: true }, { date: '2026-01-19', nav: 2.3 },
    { date: '<img onerror=alert(1)>', nav: 2, estimated: true },
  ] };
  const original = structuredClone({ selected, inputData });
  const display = getNavChartDisplay({ points: selected, preset: 'all' }, inputData);
  assert.deepEqual(display.points, [official[0], official[1], point('2026-01-16', 2.01)]);
  assert.equal(display.estimatedPoints.length, 2);
  assert.equal(display.estimatedPoints[0].nav, 2.21);
  assert.equal(display.summary.endDate, '2026-01-18');
  assert.deepEqual({ selected, inputData }, original, 'no source history or estimate record is mutated');
  assert.doesNotMatch(JSON.stringify(display), /not-for-output|shares|note|amount|onerror/);
});

test('invalid or earlier domain days never make a future estimate visible', () => {
  for (const today of [null, undefined, '2026-02-30', '2026-01-15']) {
    const display = getNavChartDisplay({ points: official, preset: 'all' }, { ...data(), today });
    assert.deepEqual(display.estimatedPoints, []);
    assert.deepEqual(display.summary, summarizeNavRange(official));
  }
  const noData = getNavChartDisplay({ points: official, preset: 'all' });
  assert.deepEqual(noData.estimatedPoints, []);
  assert.equal(noData.domainEnd, null);
});

test('estimated data built by the existing estimator compounds correctly without changing official inputs', () => {
  const history = official.map(point => ({ ...point }));
  const original = structuredClone(history);
  const estimatedData = buildEstimatedNav(history, [{ date: '2026-01-17', change: .1 }, { date: '2026-01-18', change: -.05 }], { now: new Date('2026-01-19T02:00:00Z') });
  const display = getNavChartDisplay({ points: history.slice(1), preset: '1m' }, estimatedData);
  assert.equal(display.summary.endNav, 2 * 1.1 * .95);
  assert.equal(display.summary.change, (2 * 1.1 * .95) / 1.5 - 1);
  assert.deepEqual(history, original);
});
