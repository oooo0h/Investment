// Invented public NAVs, events and rates only; never reads account files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEstimateTargetDate, buildEstimatedNav } from '../src/nav-estimates.js';
import { buildTradeMarkers, renderNavChart } from '../src/nav-chart.js';
import { loadNavEstimates, saveNavEstimates } from '../src/nav-estimate-store.js';
import { renderEstimatePanel } from '../src/estimate-panel.js';

const now = new Date('2026-10-20T04:00:00Z');
const history = [{ date: '2026-10-16', nav: 1 }, { date: '2026-10-19', nav: 1.1 }];
const event = overrides => ({ status: 'included', type: 'buy', date: '2026-10-19', nav: 9, dateBasis: 'order', ...overrides });

test('Beijing Saturday, Sunday and Monday target Friday; Tuesday targets Monday', () => {
  for (const stamp of ['2026-10-16T16:00:00Z', '2026-10-18T04:00:00Z', '2026-10-18T16:00:00Z']) {
    assert.equal(getEstimateTargetDate(new Date(stamp)), '2026-10-16');
  }
  assert.equal(getEstimateTargetDate(now), '2026-10-19');
  assert.equal(getEstimateTargetDate(new Date('invalid')), null);
});

test('weekend estimates never create points, compound into Monday, or change the official history', () => {
  const before = structuredClone(history);
  const result = buildEstimatedNav(history.slice(0, 1), [
    { date: '2026-10-17', change: .8 }, { date: '2026-10-18', change: .9 }, { date: '2026-10-19', change: .1 },
  ], { now });
  assert.deepEqual(result.points.map(p => p.date), ['2026-10-16', '2026-10-19']);
  assert.equal(result.points.at(-1).nav, 1.1);
  assert.equal(result.points.at(-1).baseDate, '2026-10-16');
  assert.deepEqual(result.pending, [{ date: '2026-10-19', change: .1 }]);
  assert.deepEqual(history, before);
  // A special official valuation must not be erased by a blanket weekend rule.
  assert.equal(buildEstimatedNav([{ date: '2026-10-18', nav: 1 }], [], { now }).points.length, 1);
});

test('old weekend entries are ignored on load; invalid new saves leave storage untouched', () => {
  const entries = [{ code: '005698', date: '2026-10-18', change: .1 }, { code: '005698', date: '2026-10-19', change: .2 }];
  let raw = JSON.stringify({ version: 1, entries });
  const original = raw;
  const storage = { getItem: () => raw, setItem: (_, value) => { raw = value; } };
  assert.deepEqual(loadNavEstimates({ storage, now }).entries, entries.slice(1));
  assert.throws(() => saveNavEstimates(entries, { storage, now }), /Unable to save NAV estimates/);
  assert.equal(raw, original);
});

test('backed NAV dates locate fills; order-only events use existing public prices and carry their basis', () => {
  const rows = [event({ navDate: '2026-10-16', nav: 1.02, estimated: true }), event({ type: 'sell' })];
  const before = structuredClone(rows);
  const markers = buildTradeMarkers(rows, history);
  assert.deepEqual(markers, [
    { date: '2026-10-16', nav: 1.02, type: 'buy', estimated: true, dateBasis: 'nav' },
    { date: '2026-10-19', nav: 1.1, type: 'sell', estimated: false, dateBasis: 'order' },
  ]);
  assert.deepEqual(rows, before);
  const chart = renderNavChart(history, { markers });
  assert.match(chart, /nav-trade-buy/);
  assert.match(chart, /nav-trade-sell is-order/);
  assert.match(chart, /下单记录，按当日公开净值定位，非成交净值/);
  assert.match(chart, /虚边：下单记录，非成交净值/);
});

test('no weekend NAV, fill, or shifted event is invented for unpriced orders or nonincluded records', () => {
  const markers = buildTradeMarkers([
    event({ date: '2026-10-18' }), event({ status: 'pending' }), event({ status: 'excluded' }),
    event({ status: 'blocked' }), event({ type: 'dividend' }), event({ date: '2026-02-30' }),
  ], history);
  assert.deepEqual(markers, []);
});

test('estimate labels identify their actual date and explain how to handle holidays', () => {
  const panel = renderEstimatePanel({ date: '2026-10-16', funds: [{ code: '005698', name: '示例基金' }] });
  assert.match(panel, /最近工作日估值/);
  assert.match(panel, /所示日期预估涨跌幅/);
  assert.match(panel, /休市日请留空/);
  assert.doesNotMatch(panel, /昨日预估涨跌幅/);
});
