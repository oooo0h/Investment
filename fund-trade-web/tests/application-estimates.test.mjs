import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateApplications, GUOFU_TRADING_DATES } from '../src/application-estimates.js';

// All values and records below are fictitious test fixtures.
const draft = overrides => ({
  id: 'synthetic-application', date: '', submittedAt: '2026-05-08 14:59:59',
  type: 'buy', amount: 200.3, nav: null, shares: null, fee: null,
  status: 'pending', sourceStatus: 'unverified', note: 'synthetic note', ...overrides,
});
const history = [
  { date: '2026-05-08', nav: 2.5 },
  { date: '2026-05-11', nav: 4 },
  { date: '2026-05-12', nav: 5 },
];
const tradingDates = ['2026-05-08', '2026-05-11', '2026-05-12'];
const run = (tx = draft(), options = {}) => estimateApplications([tx], history, { tradingDates, ...options })[0];

test('an unverified application before the cutoff uses its verified open date and exact NAV', () => {
  const result = run();
  assert.equal(result.date, '2026-05-08');
  assert.equal(result.nav, 2.5);
  assert.equal(result.fee, 0.3);
  assert.equal(result.netAmount, 200);
  assert.equal(result.shares, 80);
  assert.equal(result.amount, 200.3);
  assert.equal(result.status, 'estimated');
  assert.equal(result.estimated, true);
  assert.equal(result.estimatedRate, 0.0015);
  assert.equal(result.originalStatus, 'pending');
  assert.equal(result.note, 'synthetic note');
  assert.equal(result.sourceStatus, 'unverified');
  assert.match(result.estimateReason, /待确认/);
});

test('the exact afternoon cutoff and later applications move to the next verified open date', () => {
  for (const time of ['15:00:00', '15:00', '23:59:59']) {
    const result = run(draft({ submittedAt: `2026-05-08 ${time}` }));
    assert.equal(result.date, '2026-05-11');
    assert.equal(result.nav, 4);
    assert.equal(result.shares, 50);
  }
});

test('a day absent from the supplied open calendar moves forward even before the cutoff', () => {
  const result = run(draft({ submittedAt: '2026-05-09 09:00:00' }));
  assert.equal(result.date, '2026-05-11');
  assert.equal(result.nav, 4);
});

test('there is no inferred calendar when verified trading dates are absent', () => {
  const result = estimateApplications([draft()], history)[0];
  assert.equal(result.status, 'pending');
  assert.equal(result.estimated, false);
  assert.equal(result.nav, null);
  assert.equal(result.shares, null);
  assert.match(result.estimateReason, /开放日期/);
});

test('a missing exact target NAV never borrows a later or earlier published NAV', () => {
  const result = estimateApplications([draft({ submittedAt: '2026-05-08 15:00:00' })], history.filter(point => point.date !== '2026-05-11'), { tradingDates })[0];
  assert.equal(result.status, 'pending');
  assert.equal(result.date, '');
  assert.equal(result.nav, null);
  assert.equal(result.fee, null);
  assert.equal(result.shares, null);
  assert.match(result.estimateReason, /不改用其他日期/);
});

test('an exhausted verified calendar leaves the application pending', () => {
  const result = run(draft({ submittedAt: '2026-05-12 15:00:00' }));
  assert.equal(result.status, 'pending');
  assert.match(result.estimateReason, /尚未覆盖/);
});

test('processing, cancelled, failed, closed, confirmed, and other transaction types are retained unchanged', () => {
  const source = [
    draft({ id: 'processing', sourceStatus: 'processing' }),
    draft({ id: 'pending-source', sourceStatus: 'pending' }),
    draft({ id: 'cancelled', status: 'cancelled', sourceStatus: 'cancelled' }),
    draft({ id: 'failed', status: 'failed' }),
    draft({ id: 'closed', status: 'closed' }),
    draft({ id: 'confirmed', status: 'confirmed', date: '2026-05-08', nav: 2.5, shares: 80, fee: 0.3 }),
    draft({ id: 'sell', type: 'sell' }),
    draft({ id: 'dividend', type: 'dividend' }),
    draft({ id: 'reinvest', type: 'reinvest' }),
    draft({ id: 'transfer', type: 'transfer-in' }),
  ];
  const result = estimateApplications(source, history, { tradingDates });
  for (const tx of source) assert.deepEqual(result.find(item => item.id === tx.id), tx);
});

test('sip applications use the same estimate formula and an explicitly supplied rate', () => {
  const result = run(draft({ type: 'sip', amount: 101 }), { rate: 0.01 });
  assert.equal(result.fee, 1);
  assert.equal(result.shares, 40);
  assert.equal(result.estimatedRate, 0.01);
});

test('cent and share rounding handles a binary floating point half boundary', () => {
  const result = estimateApplications([draft({ amount: 5.35 })], [{ date: '2026-05-08', nav: 2 }], { tradingDates, rate: 0 })[0];
  assert.equal(result.fee, 0);
  assert.equal(result.shares, 2.68);
});

test('a decimal share half boundary beyond the epsilon range rounds upward', () => {
  const result = estimateApplications([draft({ amount: 20.18 })], [{ date: '2026-05-08', nav: 2 }], { tradingDates })[0];
  assert.equal(result.netAmount, 20.15);
  assert.equal(result.fee, 0.03);
  assert.equal(result.shares, 10.08);
});

test('all source arrays and objects remain untouched, including their original order', () => {
  const source = Object.freeze([
    Object.freeze(draft({ id: 'later', submittedAt: '2026-05-11 09:00:00' })),
    Object.freeze(draft({ id: 'earlier' })),
  ]);
  const original = structuredClone(source);
  const frozenHistory = Object.freeze(history.map(point => Object.freeze({ ...point })));
  const frozenDates = Object.freeze([...tradingDates].reverse());
  const result = estimateApplications(source, frozenHistory, { tradingDates: frozenDates });
  assert.deepEqual(source, original);
  assert.notEqual(result, source);
  assert.notEqual(result[0], source[1]);
  assert.deepEqual(result.map(tx => tx.id), ['earlier', 'later']);
  assert.deepEqual(frozenDates, [...tradingDates].reverse());
  assert.deepEqual(frozenHistory, history);
});

test('sorting uses effective NAV date first and then the application timestamp', () => {
  const result = estimateApplications([
    draft({ id: 'confirmed-later', status: 'confirmed', date: '2026-05-12', submittedAt: '2026-05-01 09:00:00' }),
    draft({ id: 'same-date-later', submittedAt: '2026-05-11 10:00:00' }),
    draft({ id: 'same-date-earlier', submittedAt: '2026-05-08 15:00:00' }),
    draft({ id: 'processing-middle', sourceStatus: 'processing', submittedAt: '2026-05-09 09:00:00' }),
  ], history, { tradingDates });
  assert.deepEqual(result.map(tx => tx.id), ['processing-middle', 'same-date-earlier', 'same-date-later', 'confirmed-later']);
});

test('the open date list can be unsorted with duplicates without inferring missing dates', () => {
  const result = run(draft({ submittedAt: '2026-05-09 09:00:00' }), { tradingDates: ['invalid', '2026-05-12', '2026-05-11', '2026-05-11'] });
  assert.equal(result.date, '2026-05-11');
});

test('invalid timestamps, monetary inputs, rates, and NAVs remain pending without echoing input values', () => {
  for (const submittedAt of ['2026-02-30 09:00:00', '2026-05-08 25:00:00', '2026-05-08 09:60:00', '2026-05-08', '2026-05-08T09:00:00Z']) {
    assert.equal(run(draft({ submittedAt })).status, 'pending');
  }
  for (const amount of [null, NaN, Infinity, -1, 0, 'synthetic']) assert.equal(run(draft({ amount })).status, 'pending');
  for (const rate of [null, NaN, Infinity, -1, 'synthetic']) assert.equal(run(draft(), { rate }).status, 'pending');
  for (const nav of [null, NaN, Infinity, 0, -1]) {
    const result = estimateApplications([draft()], [{ date: '2026-05-08', nav }], { tradingDates })[0];
    assert.equal(result.status, 'pending');
    assert.equal(result.shares, null);
  }
});

test('Beijing-local ISO-style timestamps with an explicit offset are accepted', () => {
  const result = run(draft({ submittedAt: '2026-05-08T14:59:59.123+08:00' }));
  assert.equal(result.status, 'estimated');
  assert.equal(result.date, '2026-05-08');
});

test('invalid collection inputs are handled without inventing transaction data', () => {
  assert.deepEqual(estimateApplications(null, history, { tradingDates }), []);
  assert.equal(estimateApplications([draft()], null, { tradingDates })[0].status, 'pending');
});

test('the Guofu calendar uses the verified window and explicitly checked holiday closures', () => {
  assert.equal(GUOFU_TRADING_DATES[0], '2026-07-01');
  assert.equal(GUOFU_TRADING_DATES.at(-1), '2026-10-15');
  assert.equal(GUOFU_TRADING_DATES.length, 69);
  assert.equal(Object.isFrozen(GUOFU_TRADING_DATES), true);
  assert.equal(GUOFU_TRADING_DATES.coverageStart, '2026-07-01');
  assert.equal(GUOFU_TRADING_DATES.coverageEnd, '2026-10-15');
  for (const date of GUOFU_TRADING_DATES) assert.ok(![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()));
  for (const date of ['2026-07-03', '2026-09-07', '2026-09-25', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07']) assert.equal(GUOFU_TRADING_DATES.includes(date), false);
  for (const date of ['2026-08-11', '2026-10-12']) assert.equal(GUOFU_TRADING_DATES.includes(date), true);
});

test('Guofu applications outside the verified calendar window stay pending rather than borrowing an open day', () => {
  for (const submittedAt of ['2026-06-30 14:00:00', '2026-10-16 09:00:00']) {
    const result = estimateApplications([draft({ submittedAt })], [{ date: '2026-07-01', nav: 2.5 }, { date: '2026-10-15', nav: 2.5 }], { tradingDates: GUOFU_TRADING_DATES })[0];
    assert.equal(result.status, 'pending');
    assert.equal(result.nav, null);
    assert.match(result.estimateReason, /窗口之外/);
  }
});

test('verified Guofu holidays defer to the next approved open day and still require its exact NAV', () => {
  const result = estimateApplications([draft({ submittedAt: '2026-10-02 09:00:00' })], [{ date: '2026-10-08', nav: 2.5 }], { tradingDates: GUOFU_TRADING_DATES })[0];
  assert.equal(result.date, '2026-10-08');
  assert.equal(result.status, 'estimated');
});
