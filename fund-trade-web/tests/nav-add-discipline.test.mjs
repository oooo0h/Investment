// Synthetic public NAV and transaction-point data only; no account files are read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateNavAnnualized, evaluateAddDiscipline } from '../src/nav-annualized.js';

const now = '2026-07-01T08:00:00.000Z';
const rule = detail => ({ id: 'add-discipline-decline', title: '加仓纪律', detail: detail ?? '自上次操作节点后，跌幅超过了 平均年化收益率 的2倍，进行一次加仓' });
const tradePoint = (nav = 2) => ({ date: '2026-03-02', nav });
const history = (annual = 0.1, latest = 1.5) => {
  const days = (Date.parse('2026-07-01T00:00:00Z') - Date.parse('2023-01-01T00:00:00Z')) / 86400000;
  return [
    { date: '2023-01-01', nav: latest / Math.pow(1 + annual, days / 365.2425) },
    { date: '2026-03-02', nav: 2 },
    { date: '2026-07-01', nav: latest },
  ];
};

test('7.1 compares the decline from the supplied operation point with the full-history compound annual return', () => {
  const rows = history();
  const signal = evaluateAddDiscipline(rows, { rule: rule(), tradePoint: tradePoint(), now });
  assert.equal(signal.triggered, true);
  assert.equal(signal.asOf, '2026-07-01');
  assert.equal(signal.baselineDate, '2026-03-02');
  assert.equal(signal.decline, 0.25);
  assert.equal(signal.annualized, calculateNavAnnualized(rows));
  assert.equal(signal.multiple, 2);
  assert.equal(signal.estimated, false);
});

test('exact equality at twice the historical annual return does not trigger but an unrounded excess does', () => {
  const point = tradePoint(1.5 / 0.8);
  const equal = evaluateAddDiscipline(history(), { rule: rule(), tradePoint: point, now });
  assert.ok(Math.abs(equal.decline - equal.annualized * 2) < 1e-12);
  assert.equal(equal.triggered, false);
  const above = evaluateAddDiscipline(history(), { rule: rule(), tradePoint: { ...point, nav: point.nav + 1e-8 }, now });
  assert.equal(above.triggered, true);
});

test('an intervening stage high is not the operation baseline and a new operation resets the comparison', () => {
  const rows = [...history(), { date: '2026-05-01', nav: 4 }];
  assert.equal(evaluateAddDiscipline(rows, { rule: rule(), tradePoint: tradePoint(), now }).triggered, true);
  const reset = evaluateAddDiscipline(rows, { rule: rule(), tradePoint: { date: '2026-06-20', nav: 1.6 }, now });
  assert.equal(reset.baselineDate, '2026-06-20');
  assert.ok(Math.abs(reset.decline - 0.0625) < 1e-12);
  assert.equal(reset.triggered, false);
});

test('unknown or nonpositive historical annual return cannot trigger a guessed add threshold', () => {
  const short = [{ date: '2026-01-01', nav: 1 }, { date: '2026-07-01', nav: 1.5 }];
  const unknown = evaluateAddDiscipline(short, { rule: rule(), tradePoint: tradePoint(3), now });
  assert.equal(unknown.annualized, null);
  assert.equal(unknown.decline, 0.5);
  assert.equal(unknown.triggered, false);
  for (const annual of [0, -0.1]) {
    const signal = evaluateAddDiscipline(history(annual), { rule: rule(), tradePoint: tradePoint(3), now });
    assert.ok(signal.annualized <= 0);
    assert.equal(signal.triggered, false);
  }
});

test('current rule text supplies the multiple, including whitespace and the optional possessive marker', () => {
  for (const text of ['平均年化收益率 的 2 倍', '平均年化收益率2倍']) {
    const signal = evaluateAddDiscipline(history(), { rule: rule(text), tradePoint: tradePoint(), now });
    assert.equal(signal.multiple, 2);
    assert.equal(signal.triggered, true);
  }
  const changed = evaluateAddDiscipline(history(), { rule: rule('平均年化收益率的3倍'), tradePoint: tradePoint(), now });
  assert.equal(changed.multiple, 3);
  assert.equal(changed.triggered, false);
  for (const current of [null, { ...rule(), id: 'annual-profit-multiple' }, rule('按新纪律执行。'), rule('平均年化收益率的0倍')]) {
    const signal = evaluateAddDiscipline(history(), { rule: current, tradePoint: tradePoint(), now });
    assert.equal(signal.multiple, null);
    assert.equal(signal.triggered, false);
  }
});

test('a missing or invalid operation point is never inferred from a price peak or pending transaction data', () => {
  for (const point of [null, {}, { date: '2026-03-02' }, { date: '2026-02-30', nav: 2 },
    { date: '2026-03-02', nav: '2' }, { date: '2026-03-02', nav: 0 },
    { date: '2026-03-02', nav: -1 }, { date: '2026-03-02', nav: Infinity },
    { date: '2026-03-02', nav: NaN }, { date: '2026-07-02', nav: 2 }]) {
    const signal = evaluateAddDiscipline(history(), { rule: rule(), tradePoint: point, now });
    assert.equal(signal.baselineDate, null);
    assert.equal(signal.decline, null);
    assert.equal(signal.triggered, false);
  }
  // Pending/uncounted rows stay the caller's responsibility; this pure function
  // accepts only an explicitly selected, already-counted operation point.
  const pendingOnly = evaluateAddDiscipline(history(), { rule: rule(), now, pending: { date: '2026-03-02', nav: 2 } });
  assert.equal(pendingOnly.baselineDate, null);
  assert.equal(pendingOnly.triggered, false);
});

test('the last published NAV must reach the operation date before a decline is calculated', () => {
  const rows = history().map(point => point.date === '2026-07-01' ? { ...point, date: '2026-06-30' } : point);
  const signal = evaluateAddDiscipline(rows, { rule: rule(), tradePoint: { date: '2026-07-01', nav: 2 }, now });
  assert.equal(signal.asOf, '2026-06-30');
  assert.equal(signal.baselineDate, '2026-07-01');
  assert.equal(signal.decline, null);
  assert.equal(signal.triggered, false);
  const sameDate = evaluateAddDiscipline(history(), { rule: rule(), tradePoint: { date: '2026-07-01', nav: 1.5 }, now });
  assert.equal(sameDate.decline, 0);
  assert.equal(sameDate.triggered, false);
});

test('future NAV cannot change the comparison or the average until Beijing reaches its published date', () => {
  const rows = [...history(), { date: '2026-07-02', nav: 0.01 }];
  const before = evaluateAddDiscipline(rows, { rule: rule(), tradePoint: tradePoint(), now: '2026-07-01T15:59:59.999Z' });
  assert.equal(before.asOf, '2026-07-01');
  assert.equal(before.annualized, calculateNavAnnualized(history()));
  assert.equal(before.triggered, true);
  const after = evaluateAddDiscipline(rows, { rule: rule(), tradePoint: tradePoint(), now: '2026-07-01T16:00:00.000Z' });
  assert.equal(after.asOf, '2026-07-02');
  assert.ok(after.annualized < 0);
  assert.equal(after.triggered, false);
});

test('gains, malformed observations, and invalid clocks cannot cause an add signal', () => {
  const rows = [...history(), { date: '2026-02-30', nav: 0.01 }, { date: '2026-07-01', nav: -1 }].reverse();
  const original = structuredClone(rows);
  const gain = evaluateAddDiscipline(rows, { rule: rule(), tradePoint: tradePoint(1), now });
  assert.equal(gain.decline, -0.5);
  assert.equal(gain.triggered, false);
  assert.deepEqual(rows, original);
  const invalid = evaluateAddDiscipline(rows, { rule: rule(), tradePoint: tradePoint(), now: 'invalid-clock' });
  assert.equal(invalid.asOf, null);
  assert.equal(invalid.annualized, null);
  assert.equal(invalid.triggered, false);
  const empty = evaluateAddDiscipline([], { rule: rule(), tradePoint: tradePoint(), now });
  assert.equal(empty.asOf, null);
  assert.equal(empty.triggered, false);
});

test('estimated operation NAV is marked explicitly and is never synthesized by the evaluator', () => {
  const signal = evaluateAddDiscipline(history(), { rule: rule(), tradePoint: { ...tradePoint(), estimated: true }, now });
  assert.equal(signal.estimated, true);
  assert.equal(signal.triggered, true);
  const absent = evaluateAddDiscipline(history(), { rule: rule(), now });
  assert.equal(absent.estimated, false);
  assert.equal(absent.baselineDate, null);
  assert.equal(absent.decline, null);
});
