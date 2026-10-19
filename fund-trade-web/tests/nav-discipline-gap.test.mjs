// Synthetic return rates only; no account files, storage, clock or network access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getNavDisciplineGap, evaluateAddDiscipline, evaluateAnnualDiscipline } from '../src/nav-annualized.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, 'the remaining return-rate difference is correct');
const add = (overrides = {}) => ({ annualized: 0.1, multiple: 2, decline: 0.17, triggered: false, ...overrides });
const profit = (overrides = {}) => ({ annualized: 0.1, multiple: 3, absoluteThreshold: null, yearReturn: 0.27, triggered: false, ...overrides });

test('the displayed loss selects the add rule but its size never replaces the last-trade decline', () => {
  const result = getNavDisciplineGap(-0.01, { addSignal: add(), profitSignals: [profit({ triggered: true })] });
  assert.equal(result.kind, 'add');
  close(result.remaining, 0.03);
  assert.equal(result.triggered, false);
});

test('the displayed gain selects profit using the year return rather than the selected chart return', () => {
  const result = getNavDisciplineGap(0.005, { addSignal: add({ triggered: true }), profitSignals: [profit()] });
  assert.equal(result.kind, 'profit');
  close(result.remaining, 0.03);
  assert.equal(result.triggered, false);
});

test('flat, missing and nonnumeric chart returns never select a discipline', () => {
  for (const change of [0, -0, null, undefined, NaN, Infinity, -Infinity, '0.1']) {
    assert.equal(getNavDisciplineGap(change, { addSignal: add(), profitSignals: [profit()] }), null);
  }
});

test('exactly five percentage points remains visible despite floating point subtraction', () => {
  const result = getNavDisciplineGap(-0.01, { addSignal: add({ decline: 0.15 }) });
  assert.equal(result.kind, 'add');
  close(result.remaining, 0.05);
});

test('a gap greater than five percentage points is hidden before display rounding', () => {
  assert.equal(getNavDisciplineGap(-0.01, { addSignal: add({ decline: 0.149999 }) }), null);
  assert.equal(getNavDisciplineGap(0.01, { profitSignals: [profit({ yearReturn: 0.249999 })] }), null);
});

test('missing transaction basis, invalid multipliers and a nonpositive average cannot invent an add signal', () => {
  for (const signal of [null, add({ decline: null }), add({ annualized: null }), add({ annualized: 0 }), add({ annualized: -0.1 }), add({ multiple: null }), add({ multiple: 0 }), add({ multiple: Infinity })]) {
    assert.equal(getNavDisciplineGap(-0.01, { addSignal: signal }), null);
  }
});

test('the nearest independently valid profit condition is selected', () => {
  const result = getNavDisciplineGap(0.01, { profitSignals: [
    profit({ multiple: null, absoluteThreshold: 1, yearReturn: 0.96 }),
    profit({ annualized: 0.33, yearReturn: 0.96 }),
  ] });
  assert.equal(result.kind, 'profit');
  close(result.remaining, 0.03);
  assert.equal(result.triggered, false);
});

test('the absolute profit condition does not require a historical annualized average', () => {
  const result = getNavDisciplineGap(0.01, { profitSignals: [profit({ annualized: null, multiple: null, absoluteThreshold: 1, yearReturn: 0.98 })] });
  close(result.remaining, 0.02);
  assert.equal(result.triggered, false);
});

test('missing year coverage and removed rule parameters never restore a fallback target', () => {
  for (const signal of [null, profit({ yearReturn: null }), profit({ annualized: null }), profit({ multiple: null }), profit({ multiple: 0 }), profit({ multiple: Infinity })]) {
    assert.equal(getNavDisciplineGap(0.01, { profitSignals: [signal] }), null);
  }
  assert.equal(getNavDisciplineGap(0.01, { profitSignals: null }), null);
});

test('an already triggered condition has zero distance and wins over an untriggered nearby condition', () => {
  const addition = getNavDisciplineGap(-0.01, { addSignal: add({ decline: 0.24, triggered: true }) });
  assert.deepEqual(addition, { kind: 'add', remaining: 0, triggered: true });
  const sale = getNavDisciplineGap(0.01, { profitSignals: [
    profit({ yearReturn: 0.28 }),
    profit({ multiple: null, absoluteThreshold: 1, yearReturn: 1.1, triggered: true }),
  ] });
  assert.deepEqual(sale, { kind: 'profit', remaining: 0, triggered: true });
});

test('strict equality remains a boundary rather than being mislabeled as a triggered action', () => {
  assert.deepEqual(getNavDisciplineGap(-0.01, { addSignal: add({ decline: 0.2 }) }), { kind: 'add', remaining: 0, triggered: false });
  const result = getNavDisciplineGap(0.01, { profitSignals: [profit({ yearReturn: 0.3 })] });
  assert.deepEqual(result, { kind: 'profit', remaining: 0, triggered: false });
});

test('a negative historical average still requires the year return to become positive for profit', () => {
  const result = getNavDisciplineGap(0.01, { profitSignals: [profit({ annualized: -0.1, yearReturn: -0.03 })] });
  close(result.remaining, 0.03);
  assert.equal(result.triggered, false);
  assert.equal(getNavDisciplineGap(0.01, { profitSignals: [profit({ annualized: -0.1, yearReturn: -0.06 })] }), null);
});

test('a zero annualized average preserves the positive-year prerequisite and current trigger state', () => {
  assert.deepEqual(getNavDisciplineGap(0.01, { profitSignals: [profit({ annualized: 0, yearReturn: 0 })] }), { kind: 'profit', remaining: 0, triggered: false });
  assert.deepEqual(getNavDisciplineGap(0.01, { profitSignals: [profit({ annualized: 0, yearReturn: 0.01, triggered: true })] }), { kind: 'profit', remaining: 0, triggered: true });
});

test('nearby distance selection never mutates input signals', () => {
  const input = { addSignal: add(), profitSignals: [profit(), profit({ multiple: null, absoluteThreshold: 1, yearReturn: 0.99 })] };
  const original = structuredClone(input);
  getNavDisciplineGap(-0.01, input);
  getNavDisciplineGap(0.01, input);
  assert.deepEqual(input, original);
});

test('an effective estimated NAV advances an add gap using official annualization and the original trade baseline', () => {
  const now = '2026-01-08T02:00:00.000Z';
  const official = [{ date: '2010-01-01', nav: 1 }, { date: '2025-12-31', nav: 4 }, { date: '2026-01-02', nav: 4 }, { date: '2026-01-06', nav: 3.5 }];
  const rule = { id: 'add-discipline-decline', title: '自上次交易节点后，跌幅超过平均年化收益率的2倍' };
  const options = { rule, now, tradePoint: { date: '2026-01-02', nav: 4 }, annualizedHistory: official };
  const before = evaluateAddDiscipline(official, options);
  const after = evaluateAddDiscipline([...official, { date: '2026-01-07', nav: 3.465 }], options);
  const first = getNavDisciplineGap(-0.01, { addSignal: before });
  const second = getNavDisciplineGap(-0.01, { addSignal: after });
  assert.ok(first && second);
  close(first.remaining - second.remaining, 0.00875);
  assert.equal(before.annualized, after.annualized);
  assert.equal(before.baselineDate, after.baselineDate);
});

test('a profit estimate can cross the inclusive absolute condition before an official replacement arrives', () => {
  const official = [{ date: '2025-12-31', nav: 1 }, { date: '2026-01-02', nav: 1 }, { date: '2026-01-06', nav: 1.96 }];
  const options = { rule: { id: 'annual-profit-100', title: '年内涨幅收益率达到了100%' }, now: '2026-01-08T02:00:00.000Z', annualizedHistory: official };
  const before = evaluateAnnualDiscipline(official, options);
  const after = evaluateAnnualDiscipline([...official, { date: '2026-01-07', nav: 2 }], options);
  close(getNavDisciplineGap(0.01, { profitSignals: [before] }).remaining, 0.04);
  assert.deepEqual(getNavDisciplineGap(0.01, { profitSignals: [after] }), { kind: 'profit', remaining: 0, triggered: true });
});
