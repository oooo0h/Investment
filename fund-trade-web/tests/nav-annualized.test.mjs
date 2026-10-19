// Synthetic public NAV observations only. No file, account, or workbook access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateNavAnnualized, evaluateAnnualDiscipline, evaluateAddDiscipline } from '../src/nav-annualized.js';

const close = (actual, expected, tolerance = 1e-12) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < tolerance, 'annualized synthetic NAV return');

test('annualized return compounds the whole loaded history instead of averaging observed returns', () => {
  const rows = [
    { date: '2019-01-01', nav: 1 },
    { date: '2020-01-01', nav: 2 },
    { date: '2021-01-01', nav: 1 },
  ];
  assert.equal(calculateNavAnnualized(rows), 0);
  const expected = 0.12;
  close(calculateNavAnnualized([
    { date: '2024-01-01', nav: 1 },
    { date: '2026-01-01', nav: Math.pow(1 + expected, 731 / 365.2425) },
  ]), expected);
});

test('actual UTC date spans include leap days and ignore observation count or gaps', () => {
  const sparse = [{ date: '2023-03-01', nav: 1 }, { date: '2024-03-01', nav: 1.21 }];
  const dense = [sparse[0], { date: '2023-05-10', nav: 1.9 }, { date: '2024-02-29', nav: 1.15 }, sparse[1]];
  const expected = Math.pow(1.21, 365.2425 / 366) - 1;
  close(calculateNavAnnualized(sparse), expected);
  close(calculateNavAnnualized(dense), expected);
});

test('a complete calendar year is required, including non-leap and leap-day anniversaries', () => {
  assert.equal(calculateNavAnnualized([{ date: '2025-01-01', nav: 1 }, { date: '2025-12-31', nav: 1.1 }]), null);
  close(calculateNavAnnualized([{ date: '2025-01-01', nav: 1 }, { date: '2026-01-01', nav: 1.1 }]), Math.pow(1.1, 365.2425 / 365) - 1);
  assert.equal(calculateNavAnnualized([{ date: '2024-02-29', nav: 1 }, { date: '2025-02-27', nav: 1.1 }]), null);
  close(calculateNavAnnualized([{ date: '2024-02-29', nav: 1 }, { date: '2025-02-28', nav: 1.1 }]), Math.pow(1.1, 365.2425 / 365) - 1);
});

test('sorting and same-day deduplication use the last valid observation without mutating input', () => {
  const rows = [
    { date: '2026-01-01', nav: 2 }, { date: '2024-01-01', nav: 1 },
    { date: '2026-01-01', nav: 4 }, { date: '2026-01-01', nav: -1 },
    { date: '2025-01-01', nav: 3 },
  ];
  const before = structuredClone(rows);
  close(calculateNavAnnualized(rows), Math.pow(4, 365.2425 / 731) - 1);
  assert.deepEqual(rows, before);
});

test('invalid dates, non-positive NAV, and non-numeric values cannot become endpoint observations', () => {
  const rows = [
    { date: '2024-01-01', nav: 1 }, { date: '2026-01-01', nav: 1.2 },
    { date: '2020-02-30', nav: 1 }, { date: '2020-13-01', nav: 1 },
    { date: '2020-01-01T00:00:00Z', nav: 1 }, { date: ' 2020-01-01', nav: 1 },
    { date: '2027-01-01', nav: '2' }, { date: '2027-01-01', nav: 0 },
    { date: '2027-01-01', nav: -1 }, { date: '2027-01-01', nav: Infinity },
    { date: '2027-01-01', nav: NaN }, { date: '2027-01-01', nav: true }, null,
  ];
  close(calculateNavAnnualized(rows), Math.pow(1.2, 365.2425 / 731) - 1);
});

test('missing, duplicate-only, and short histories return no annualized result', () => {
  for (const rows of [null, {}, [], [{ date: '2026-01-01', nav: 1 }], [
    { date: '2026-01-01', nav: 1 }, { date: '2026-01-01', nav: 2 },
  ], [{ date: '2026-01-01', nav: 1 }, { date: '2026-06-01', nav: 1.2 }]]) {
    assert.equal(calculateNavAnnualized(rows), null);
  }
});

test('falling endpoint NAV produces a negative annualized result without account inputs', () => {
  close(calculateNavAnnualized([{ date: '2024-01-01', nav: 2 }, { date: '2026-01-01', nav: 1 }]), Math.pow(0.5, 365.2425 / 731) - 1);
});

test('logarithmic compounding avoids overflowing the endpoint ratio and rejects non-finite output', () => {
  const long = calculateNavAnnualized([{ date: '1000-01-01', nav: 1e-300 }, { date: '2000-01-01', nav: 1e300 }]);
  assert.ok(Number.isFinite(long) && long > 0);
  assert.equal(calculateNavAnnualized([{ date: '2025-01-01', nav: 1e-300 }, { date: '2026-01-01', nav: 1e300 }]), null);
});

const annualRule = detail => ({ id: 'annual-profit', title: '年内涨幅纪律', detail: detail ?? '超过了平均年化收益率的3倍/甚至达到了100%，一定要大幅止盈。' });
const currentNow = '2026-07-01T08:00:00.000Z';

test('annual discipline uses the first current-year NAV and compound historical average with cross-year coverage', () => {
  const rows = [
    { date: '2023-01-01', nav: 1 }, { date: '2025-12-31', nav: 1.1 },
    { date: '2026-01-02', nav: 1 }, { date: '2026-07-01', nav: 1.5 },
  ];
  const signal = evaluateAnnualDiscipline(rows, { rule: annualRule(), now: currentNow });
  assert.equal(signal.year, 2026);
  assert.equal(signal.baselineDate, '2026-01-02');
  assert.equal(signal.asOf, '2026-07-01');
  assert.equal(signal.yearReturn, 0.5);
  assert.equal(signal.annualized, calculateNavAnnualized(rows));
  assert.equal(signal.multiple, 3);
  assert.equal(signal.absoluteThreshold, 1);
  assert.equal(signal.triggered, true);
});

test('annualized history can exclude manual estimates from the threshold while current values keep the latest estimate', () => {
  const official = [
    { date: '2023-01-01', nav: 1 }, { date: '2025-12-31', nav: 1.1 },
    { date: '2026-01-02', nav: 1 }, { date: '2026-06-30', nav: 1.5 },
  ];
  const merged = [...official, { date: '2026-07-01', nav: 3 }];
  const signal = evaluateAnnualDiscipline(merged, { rule: annualRule(), now: currentNow, annualizedHistory: official });
  assert.equal(signal.annualized, calculateNavAnnualized(official));
  assert.equal(signal.yearReturn, 2);
  assert.equal(signal.asOf, '2026-07-01');
});

test('add discipline uses official annualization while the latest estimated NAV still drives the decline', () => {
  const official = [
    { date: '2023-01-01', nav: 1 }, { date: '2026-01-02', nav: 4 },
    { date: '2026-06-30', nav: 1.5 },
  ];
  const merged = [...official, { date: '2026-07-01', nav: 3 }];
  const rule = { id: 'add-discipline-decline', title: '加仓纪律', detail: '自上次交易节点后，跌幅超过了 平均年化收益率 的2倍，进行一次加仓' };
  const signal = evaluateAddDiscipline(merged, {
    rule,
    tradePoint: { date: '2026-01-02', nav: 4 },
    now: currentNow,
    annualizedHistory: official,
  });
  assert.equal(signal.annualized, calculateNavAnnualized(official));
  assert.equal(signal.decline, 0.25);
  assert.equal(signal.baselineDate, '2026-01-02');
  assert.equal(signal.asOf, '2026-07-01');
  assert.equal(signal.triggered, true);
});

test('the year and reset boundary follow Beijing midnight, with future-dated NAV excluded', () => {
  const rows = [
    { date: '2024-12-31', nav: 1 }, { date: '2025-01-02', nav: 1 },
    { date: '2025-12-31', nav: 2 }, { date: '2026-01-01', nav: 3 },
  ];
  const before = evaluateAnnualDiscipline(rows, { rule: annualRule(), now: '2025-12-31T15:59:59.999Z' });
  assert.equal(before.year, 2025);
  assert.equal(before.asOf, '2025-12-31');
  assert.equal(before.yearReturn, 1);
  assert.equal(before.triggered, true);
  const after = evaluateAnnualDiscipline(rows, { rule: annualRule(), now: '2025-12-31T16:00:00.000Z' });
  assert.equal(after.year, 2026);
  assert.equal(after.baselineDate, '2026-01-01');
  assert.equal(after.yearReturn, 0);
  assert.equal(after.triggered, false);
});

test('a truncated current-year history cannot invent an annual baseline even if its NAV doubles', () => {
  for (const start of ['2026-01-01', '2026-04-01']) {
    const signal = evaluateAnnualDiscipline([{ date: start, nav: 1 }, { date: '2026-07-01', nav: 2 }], { rule: annualRule(), now: currentNow });
    assert.equal(signal.baselineDate, null);
    assert.equal(signal.yearReturn, null);
    assert.equal(signal.asOf, '2026-07-01');
    assert.equal(signal.triggered, false);
  }
});

test('no current-year observations or missing previous-year coverage means no current annual trigger', () => {
  const oldOnly = evaluateAnnualDiscipline([{ date: '2024-01-01', nav: 1 }, { date: '2025-12-31', nav: 2 }], { rule: annualRule(), now: currentNow });
  assert.equal(oldOnly.asOf, null);
  assert.equal(oldOnly.yearReturn, null);
  assert.equal(oldOnly.triggered, false);
  const gap = evaluateAnnualDiscipline([{ date: '2024-01-01', nav: 1 }, { date: '2026-01-02', nav: 1 }, { date: '2026-07-01', nav: 2 }], { rule: annualRule(), now: currentNow });
  assert.equal(gap.baselineDate, null);
  assert.equal(gap.triggered, false);
});

test('less than a full year cannot use a guessed average but the explicit 100-percent threshold still applies', () => {
  const rows = [{ date: '2025-12-31', nav: 1 }, { date: '2026-01-02', nav: 10 }, { date: '2026-07-01', nav: 20 }];
  const signal = evaluateAnnualDiscipline(rows, { rule: annualRule(), now: currentNow });
  assert.equal(signal.annualized, null);
  assert.equal(signal.yearReturn, 1);
  assert.equal(signal.triggered, true);
  const withoutAbsolute = evaluateAnnualDiscipline(rows, { rule: annualRule('超过平均年化收益率的3倍。'), now: currentNow });
  assert.equal(withoutAbsolute.triggered, false);
});

test('exactly three times the historical average does not trigger, while an unrounded excess does', () => {
  const days = (Date.parse('2026-07-01T00:00:00Z') - Date.parse('2023-01-01T00:00:00Z')) / 86400000;
  const first = 1.5 / Math.pow(1 + 0.5 / 3, days / 365.2425);
  const rows = [
    { date: '2023-01-01', nav: first }, { date: '2025-12-31', nav: 1 },
    { date: '2026-01-02', nav: 1 }, { date: '2026-07-01', nav: 1.5 },
  ];
  const equal = evaluateAnnualDiscipline(rows, { rule: annualRule('超过平均年化收益率的3倍。'), now: currentNow });
  close(equal.annualized * 3, equal.yearReturn);
  assert.equal(equal.triggered, false);
  rows[0].nav *= 1.000000001;
  const above = evaluateAnnualDiscipline(rows, { rule: annualRule('超过平均年化收益率的3倍。'), now: currentNow });
  assert.ok(above.yearReturn > above.annualized * 3);
  assert.equal(above.triggered, true);
});

test('the absolute threshold includes 100 percent but excludes a smaller gain', () => {
  for (const [last, expected] of [[1.999999, false], [2, true], [2.000001, true]]) {
    const signal = evaluateAnnualDiscipline([
      { date: '2025-12-31', nav: 1 }, { date: '2026-01-02', nav: 1 }, { date: '2026-07-01', nav: last },
    ], { rule: annualRule('年内涨幅达到100%。'), now: currentNow });
    assert.equal(signal.triggered, expected);
  }
});

test('zero or negative current-year gains never trigger even if the long-run average is negative', () => {
  for (const last of [1, 0.9]) {
    const signal = evaluateAnnualDiscipline([
      { date: '2023-01-01', nav: 10 }, { date: '2025-12-31', nav: 1 },
      { date: '2026-01-02', nav: 1 }, { date: '2026-07-01', nav: last },
    ], { rule: annualRule(), now: currentNow });
    assert.ok(signal.annualized < 0);
    assert.equal(signal.triggered, false);
  }
});

test('missing or changed rule text never silently restores old trigger thresholds', () => {
  const rows = [{ date: '2025-12-31', nav: 1 }, { date: '2026-01-02', nav: 1 }, { date: '2026-07-01', nav: 2.1 }];
  for (const rule of [null, { id: 'other', title: '平均年化收益率的3倍', detail: '达到100%' }, annualRule('继续长期持有。')]) {
    const signal = evaluateAnnualDiscipline(rows, { rule, now: currentNow });
    assert.equal(signal.multiple, null);
    assert.equal(signal.absoluteThreshold, null);
    assert.equal(signal.triggered, false);
  }
  const changed = evaluateAnnualDiscipline(rows, { rule: annualRule('超过平均年化收益率的4倍，或达到了120%。'), now: currentNow });
  assert.equal(changed.multiple, 4);
  assert.equal(changed.absoluteThreshold, 1.2);
  assert.equal(changed.triggered, false);
});

test('annual discipline applies strict date and NAV validation and safely handles invalid clocks', () => {
  const rows = [
    { date: '2025-12-31', nav: 1 }, { date: '2026-01-02', nav: 1 },
    { date: '2026-07-01', nav: 2 }, { date: '2026-02-30', nav: 10 },
    { date: '2026-07-01', nav: NaN }, { date: '2026-07-02', nav: 100 },
  ];
  const before = structuredClone(rows);
  const signal = evaluateAnnualDiscipline(rows, { rule: annualRule(), now: currentNow });
  assert.equal(signal.baselineDate, '2026-01-02');
  assert.equal(signal.asOf, '2026-07-01');
  assert.equal(signal.yearReturn, 1);
  assert.equal(signal.triggered, true);
  assert.deepEqual(rows, before);
  const invalid = evaluateAnnualDiscipline(rows, { rule: annualRule(), now: 'invalid-date' });
  assert.equal(invalid.year, null);
  assert.equal(invalid.triggered, false);
});

const absoluteRule = {
  id: 'annual-profit-100', title: '如果本年的年内涨幅收益率达到了100%，',
  detail: '【一定】要大幅止盈（清除本金/卖出一半持仓等等）',
};
const multipleRule = {
  id: 'annual-profit-multiple', title: '如果本年内的年内涨幅收益率超过了平均年化收益率的3倍，',
  detail: '【一定】要适当止盈（清除本金/卖出一半持仓等等）',
};
const splitHistory = (first, last) => [
  { date: '2023-01-01', nav: first }, { date: '2025-12-31', nav: 1 },
  { date: '2026-01-02', nav: 1 }, { date: '2026-07-01', nav: last },
];

test('split 6.2 can trigger below 100 percent without inheriting the absolute threshold or its wording', () => {
  const rows = splitHistory(1, 1.5);
  const relative = evaluateAnnualDiscipline(rows, { rule: multipleRule, now: currentNow });
  const absolute = evaluateAnnualDiscipline(rows, { rule: absoluteRule, now: currentNow });
  assert.equal(relative.triggered, true);
  assert.equal(relative.multiple, 3);
  assert.equal(relative.absoluteThreshold, null);
  assert.equal(absolute.triggered, false);
  assert.equal(absolute.multiple, null);
  assert.equal(absolute.absoluteThreshold, 1);
  assert.match(multipleRule.detail, /适当止盈/);
  assert.match(absoluteRule.detail, /大幅止盈/);
});

test('split 6.1 can trigger while 6.2 is below its own threshold', () => {
  const rows = splitHistory(0.1, 2);
  const absolute = evaluateAnnualDiscipline(rows, { rule: absoluteRule, now: currentNow });
  const relative = evaluateAnnualDiscipline(rows, { rule: multipleRule, now: currentNow });
  assert.equal(absolute.yearReturn, 1);
  assert.equal(absolute.triggered, true);
  assert.ok(relative.annualized * relative.multiple > relative.yearReturn);
  assert.equal(relative.triggered, false);
});

test('both split clauses report their own trigger when both independent conditions are satisfied', () => {
  const rows = splitHistory(1, 2);
  const absolute = evaluateAnnualDiscipline(rows, { rule: absoluteRule, now: currentNow });
  const relative = evaluateAnnualDiscipline(rows, { rule: multipleRule, now: currentNow });
  assert.equal(absolute.triggered, true);
  assert.equal(relative.triggered, true);
  assert.equal(absolute.multiple, null);
  assert.equal(relative.absoluteThreshold, null);
  assert.equal(absolute.baselineDate, relative.baselineDate);
  assert.equal(absolute.asOf, relative.asOf);
});

test('split 6.1 includes exactly 100 percent and does not require a complete-year average', () => {
  const rows = [{ date: '2025-12-31', nav: 1 }, { date: '2026-01-02', nav: 10 }, { date: '2026-07-01', nav: 20 }];
  const absolute = evaluateAnnualDiscipline(rows, { rule: absoluteRule, now: currentNow });
  const relative = evaluateAnnualDiscipline(rows, { rule: multipleRule, now: currentNow });
  assert.equal(absolute.annualized, null);
  assert.equal(absolute.yearReturn, 1);
  assert.equal(absolute.triggered, true);
  assert.equal(relative.annualized, null);
  assert.equal(relative.triggered, false);
  rows.at(-1).nav = 19.999999;
  assert.equal(evaluateAnnualDiscipline(rows, { rule: absoluteRule, now: currentNow }).triggered, false);
});

test('split 6.2 excludes equality at three times average but accepts an unrounded excess', () => {
  const days = (Date.parse('2026-07-01T00:00:00Z') - Date.parse('2023-01-01T00:00:00Z')) / 86400000;
  const rows = splitHistory(1.5 / Math.pow(1 + 0.5 / 3, days / 365.2425), 1.5);
  const equal = evaluateAnnualDiscipline(rows, { rule: multipleRule, now: currentNow });
  close(equal.annualized * 3, equal.yearReturn);
  assert.equal(equal.triggered, false);
  rows[0].nav *= 1.000000001;
  assert.equal(evaluateAnnualDiscipline(rows, { rule: multipleRule, now: currentNow }).triggered, true);
});

test('both split clauses require current-year observations and previous-year source coverage', () => {
  const cases = [
    [{ date: '2026-03-01', nav: 1 }, { date: '2026-07-01', nav: 3 }],
    [{ date: '2023-01-01', nav: 1 }, { date: '2026-01-02', nav: 1 }, { date: '2026-07-01', nav: 3 }],
    [{ date: '2024-01-01', nav: 1 }, { date: '2025-12-31', nav: 3 }],
  ];
  for (const history of cases) {
    for (const rule of [absoluteRule, multipleRule]) {
      const signal = evaluateAnnualDiscipline(history, { rule, now: currentNow });
      assert.equal(signal.baselineDate, null);
      assert.equal(signal.yearReturn, null);
      assert.equal(signal.triggered, false);
    }
  }
});

test('recognized split IDs still require a threshold in their own current text', () => {
  for (const rule of [absoluteRule, multipleRule]) {
    const removed = { ...rule, title: '按最新条款执行。', detail: '' };
    const signal = evaluateAnnualDiscipline(splitHistory(1, 3), { rule: removed, now: currentNow });
    assert.equal(signal.multiple, null);
    assert.equal(signal.absoluteThreshold, null);
    assert.equal(signal.triggered, false);
  }
});
