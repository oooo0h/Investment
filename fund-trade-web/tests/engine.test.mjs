import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLedger } from '../src/engine.js';

// All test data is invented. Assertion labels deliberately omit account values.
const tx = (type, overrides = {}) => ({ date: '2026-01-01', type, nav: 2, shares: 100, fee: 0, ...overrides });
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-7, label);
test('empty ledger and free shares have defined states', () => {
  const empty = calculateLedger([]);
  assert.ok(empty.summary.valid && empty.summary.principalStatus === 'empty', 'empty state');
  assert.ok(empty.summary.totalReturn === null, 'undefined zero-cost return');
  const opening = calculateLedger([], { openingShares: 5, openingPrincipal: 8, valuationNav: 2, valuationDate: '2026-01-01' });
  assert.ok(opening.summary.identityCheck, 'opening identity');
});
test('both allocation modes preserve value and total profit', () => {
  const transactions = [tx('buy', { fee: 1 }), tx('sell', { date: '2026-01-02', nav: 3, shares: 20, fee: 1 })];
  const profit = calculateLedger(transactions);
  const principal = calculateLedger(transactions, { mode: 'principal-first' });
  assert.ok(profit.summary.valid && principal.summary.valid, 'valid modes');
  close(profit.summary.marketValue, principal.summary.marketValue, 'same market value');
  close(profit.summary.totalProfit, principal.summary.totalProfit, 'same total profit');
  assert.ok(profit.summary.principal > principal.summary.principal, 'allocation differs');
  assert.ok(profit.summary.identityCheck && principal.summary.identityCheck, 'both identities');
  close(profit.rows[0].amount, 201, 'purchase fee included');
  close(profit.rows[1].amount, 59, 'redemption fee excluded');
});
test('decimal half rounding follows the spreadsheet and legacy entered status is accepted', () => {
  const result = calculateLedger([tx('buy', { nav: 10.075, shares: 1, status: '已录入' })]);
  assert.ok(result.summary.valid, 'legacy entered confirmation');
  close(result.rows[0].amount, 10.08, 'decimal half rounded up');
});
test('clearance settles loss and a later purchase restarts principal', () => {
  const result = calculateLedger([tx('buy'), tx('sell', { date: '2026-01-02', nav: 1 }), tx('buy', { date: '2026-01-03', shares: 2 })]);
  assert.ok(result.summary.valid && result.summary.identityCheck, 'valid restart');
  close(result.rows[1].principalAfter, 0, 'cleared principal');
  close(result.rows[1].closedLoss, 100, 'recognized close loss');
  close(result.summary.principal, 4, 'new principal only');
});
test('cash dividends use profit allocation in both modes; reinvest adds no cost', () => {
  const transactions = [tx('buy'), tx('dividend', { date: '2026-01-02', nav: 1.9, shares: 0, amount: 10 }), tx('reinvest', { date: '2026-01-03', shares: 5 })];
  const left = calculateLedger(transactions);
  const right = calculateLedger(transactions, { mode: 'principal-first' });
  assert.ok(left.summary.valid && right.summary.valid, 'valid dividend chain');
  close(left.rows[1].profitWithdrawn, right.rows[1].profitWithdrawn, 'same dividend allocation');
  close(left.rows[2].totalInvested, left.rows[0].totalInvested, 'reinvestment adds no cost');
  assert.ok(left.summary.identityCheck && right.summary.identityCheck, 'dividend identities');
});
test('valuation chooses the newer date and published quote wins ties', () => {
  const transactions = [tx('buy')];
  const newer = calculateLedger(transactions, { valuationNav: 3, valuationDate: '2026-01-02' });
  const older = calculateLedger(transactions, { valuationNav: 3, valuationDate: '2025-12-31' });
  const tie = calculateLedger(transactions, { valuationNav: 4, valuationDate: '2026-01-01' });
  close(newer.summary.valuationNav, 3, 'newer quote');
  close(older.summary.valuationNav, 2, 'transaction quote fallback');
  close(tie.summary.valuationNav, 4, 'published tie');
  const invalid = calculateLedger(transactions, { valuationNav: -1, valuationDate: '2026-01-02' });
  close(invalid.summary.valuationNav, 2, 'invalid published fallback');
});
test('invalid row blocks subsequent rows and suppresses the overall summary', () => {
  const result = calculateLedger([tx('buy'), tx('sell', { shares: 101, date: '2026-01-02' }), tx('buy', { date: '2026-01-03' })]);
  assert.ok(!result.summary.valid && result.summary.marketValue === null, 'invalid summary hidden');
  assert.ok(result.rows[1].status === 'error' && result.rows[2].status === 'blocked', 'chain blocked');
  assert.ok(result.errors.every((error) => !error.message.includes('101')), 'errors omit input values');
});
test('excluded and pending rows do not modify the chain', () => {
  const result = calculateLedger([tx('buy'), { status: '撤单' }, { status: 'pending' }, tx('sip', { date: '2026-01-02', shares: 1, status: 'estimated' })]);
  assert.ok(result.summary.valid && result.summary.includedCount === 2, 'only confirmed included');
  assert.ok(result.summary.pendingCount === 1 && result.summary.estimatedCount === 1, 'status counts');
  assert.equal(result.summary.latestEstimatedDate, '2026-01-02', 'the estimated date is exposed for the heading chip');
  close(result.summary.shares, 101, 'excluded shares unchanged');
});
test('transfer-in requires actual cost and validates confirmation reconciliation', () => {
  const good = calculateLedger([tx('transfer-in', { cost: 200 })]);
  assert.ok(good.summary.valid && good.summary.identityCheck, 'actual transfer cost');
  const absent = calculateLedger([tx('transfer-in')]);
  assert.ok(!absent.summary.valid, 'missing transfer cost');
  const mismatch = calculateLedger([tx('buy', { amount: 250 })]);
  assert.ok(!mismatch.summary.valid, 'mismatched confirmation');
});
test('date order, finite numeric input, positive fee rules, and prior holdings are enforced', () => {
  const scenarios = [
    [tx('buy', { date: '2026-02-30' })],
    [tx('buy'), tx('buy', { date: '2025-12-31' })],
    [tx('buy', { nav: Infinity })],
    [tx('buy', { fee: null })],
    [tx('buy'), tx('sell', { fee: 200 })],
    [tx('reinvest')],
    [tx('buy'), tx('reinvest', { fee: 1 })],
    [tx('buy'), tx('dividend', { amount: 10, shares: 1 })],
  ];
  assert.ok(scenarios.every((transactions) => !calculateLedger(transactions).summary.valid), 'all invalid scenarios rejected');
});
test('every valid step preserves ledger identity after fees, losses, and return', () => {
  const transactions = [tx('buy', { fee: 0.2 }), tx('sip', { date: '2026-01-02', nav: 1.5, shares: 50, fee: 0.1 }),
    tx('sell', { date: '2026-01-03', nav: 1.8, shares: 40, fee: 0.5 }),
    tx('dividend', { date: '2026-01-04', nav: 1.7, shares: 0, amount: 5 }),
    tx('reinvest', { date: '2026-01-05', nav: 1.7, shares: 3 })];
  for (const mode of ['profit-first', 'principal-first']) {
    const result = calculateLedger(transactions, { mode });
    assert.ok(result.summary.valid && result.summary.identityCheck, 'final identity');
    assert.ok(result.rows.every((row) => Math.abs(row.totalProfit - (row.holdingProfit + row.totalProfitWithdrawn - row.totalClosedLoss)) < 0.02), 'all row identities');
  }
});
