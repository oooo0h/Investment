import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLedger } from '../src/engine.js';
import { calculateTransactionPerformance } from '../src/transaction-performance.js';

// Invented fixtures only. These figures are unrelated to account data.
const tx = (id, type, fields = {}) => ({ id, type, date: '2026-01-01', nav: 2, shares: 10, fee: 0, ...fields });
const performance = (transactions, options = {}, mode = 'profit-first') => {
  const ledger = calculateLedger(transactions, { mode });
  assert.ok(ledger.summary.valid, 'synthetic ledger is valid');
  return calculateTransactionPerformance(ledger.rows, options);
};
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, 'expected synthetic result');

test('transaction economics are identical in both allocation modes', () => {
  const input = [tx('buy', 'buy', { shares: 100, fee: 1 }), tx('sell', 'sell', { date: '2026-01-02', nav: 3, shares: 30, fee: 1 })];
  const options = { valuationNav: 4, valuationDate: '2026-01-03' };
  const profit = performance(input, options), principal = performance(input, options, 'principal-first');
  assert.deepEqual(profit, principal);
  close(profit.get('sell').cost, 60.3);
  close(profit.get('sell').profit, 28.7);
  close(profit.get('buy').remainingShares, 70);
  close(profit.get('buy').profit, 168);
  close(profit.get('buy').realizedProfit, 28.7);
  close(profit.get('buy').unrealizedProfit, 139.3);
  close(profit.get('buy').returnRate, 168 / 201);
});

test('partial sales and final clearance settle the original lot cost including fees', () => {
  const result = performance([
    tx('buy', 'buy', { shares: 3, fee: 0.01 }),
    tx('first', 'sell', { date: '2026-01-02', shares: 1, nav: 3, fee: 0.01 }),
    tx('last', 'sell', { date: '2026-01-03', shares: 2, nav: 1, fee: 0.01 }),
  ], { valuationNav: 99, valuationDate: '2026-01-04' });
  const buy = result.get('buy');
  close(result.get('first').cost, 2);
  close(result.get('last').cost, 4.01);
  close(buy.remainingCost, 0);
  close(buy.remainingShares, 0);
  close(buy.marketValue, 0);
  close(buy.proceeds, 4.98);
  close(buy.profit, -1.03);
  close(buy.unrealizedProfit, 0);
  assert.equal(buy.valuationDate, '2026-01-03');
});

test('FIFO matches multiple lots, shares net proceeds, and reconciles every cent', () => {
  const result = performance([
    tx('old', 'buy', { shares: 3, nav: 1, fee: 0.01 }),
    tx('new', 'sip', { date: '2026-01-02', shares: 2, nav: 2, fee: 0.01 }),
    tx('sale', 'sell', { date: '2026-01-03', shares: 4, nav: 3, fee: 0.01 }),
  ]);
  const sale = result.get('sale');
  close(sale.cost, 5.02);
  close(sale.profit, 6.97);
  assert.deepEqual(sale.matches.map(match => match.id), ['old', 'new']);
  close(sale.matches.reduce((total, match) => total + match.cost, 0), sale.cost);
  close(sale.matches.reduce((total, match) => total + match.proceeds, 0), sale.proceeds);
  close(result.get('old').remainingShares, 0);
  close(result.get('new').remainingShares, 1);
  close(result.get('new').remainingCost, 2);
  close(result.get('old').proceeds + result.get('new').proceeds, sale.proceeds);
});

test('cash dividends use shares held on that date and only affect eligible lots', () => {
  const result = performance([
    tx('old', 'buy', { shares: 3 }),
    tx('other', 'buy', { shares: 1 }),
    tx('cash', 'dividend', { date: '2026-01-02', shares: 0, amount: 1.01 }),
    tx('later', 'buy', { date: '2026-01-03', shares: 2 }),
  ]);
  close(result.get('old').cashDividends, 0.76);
  close(result.get('other').cashDividends, 0.25);
  close(result.get('later').cashDividends, 0);
  close(result.get('cash').profit, 1.01);
  assert.equal(result.get('cash').returnRate, null);
  close(result.get('cash').allocations.reduce((total, entry) => total + entry.amount, 0), 1.01);
});

test('reinvested shares form a zero-input lot and transfer-in retains its actual cost', () => {
  const result = performance([
    tx('transfer', 'transfer-in', { shares: 5, cost: 10.01, fee: 0.01 }),
    tx('free', 'reinvest', { date: '2026-01-02', shares: 1 }),
    tx('sale', 'sell', { date: '2026-01-03', shares: 6, nav: 3, fee: 0.02 }),
  ]);
  close(result.get('transfer').cost, 10.01);
  close(result.get('free').cost, 0);
  close(result.get('free').profit, 3);
  assert.equal(result.get('free').returnRate, null);
  close(result.get('sale').cost, 10.01);
  close(result.get('sale').profit, 7.97);
});

test('pending, excluded, error and blocked records never receive invented returns', () => {
  const ledger = calculateLedger([
    tx('buy', 'buy'),
    tx('pending', 'buy', { status: 'pending', shares: null, fee: null }),
    tx('cancelled', 'buy', { status: 'cancelled', shares: null, fee: null }),
    tx('error', 'sell', { shares: 20 }),
    tx('blocked', 'buy'),
  ]);
  const result = calculateTransactionPerformance(ledger.rows);
  for (const id of ['pending', 'cancelled', 'error', 'blocked']) {
    const row = result.get(id);
    assert.equal(row.kind, 'unavailable');
    for (const key of ['cost', 'marketValue', 'profit', 'returnRate', 'realizedProfit', 'unrealizedProfit', 'remainingShares']) assert.equal(row[key], null);
  }
  close(result.get('buy').profit, 0);
});

test('valuation falls back to the latest valid transaction and never backfills an older quote', () => {
  const input = [tx('buy', 'buy'), tx('later', 'sip', { date: '2026-01-03', nav: 3 })];
  for (const options of [undefined, { valuationNav: null, valuationDate: '2026-01-04' }, { valuationNav: 99, valuationDate: '2026-01-02' }]) {
    const result = performance(input, options);
    close(result.get('buy').marketValue, 30);
    assert.equal(result.get('buy').valuationDate, '2026-01-03');
  }
  const tie = performance(input, { valuationNav: 4, valuationDate: '2026-01-03' });
  close(tie.get('buy').marketValue, 40);
  const unavailable = calculateTransactionPerformance([{ id: 'missing', type: 'buy', status: 'included', amount: 1, shares: 1, fee: 0 }]);
  assert.equal(unavailable.get('missing').returnRate, null);
  assert.equal(unavailable.get('missing').profit, null);
});

test('estimated basis and dispositions mark the affected economics as estimated', () => {
  const result = performance([
    tx('estimate', 'buy', { status: 'estimated', estimated: true }),
    tx('confirmed-sale', 'sell', { date: '2026-01-02', shares: 5, nav: 3 }),
  ]);
  assert.equal(result.get('estimate').estimated, true);
  assert.equal(result.get('confirmed-sale').estimated, true);
  close(result.get('confirmed-sale').profit, 5);
});

test('share precision and cumulative cost rounding conserve every closing cent', () => {
  const result = performance([
    tx('lot', 'buy', { nav: 3.000003, shares: 0.999999, fee: 0.01 }),
    tx('sale-a', 'sell', { date: '2026-01-02', nav: 4, shares: 0.333333 }),
    tx('sale-b', 'sell', { date: '2026-01-03', nav: 4, shares: 0.333333 }),
    tx('sale-c', 'sell', { date: '2026-01-04', nav: 4, shares: 0.333333 }),
  ]);
  const lot = result.get('lot');
  close(result.get('sale-a').cost + result.get('sale-b').cost + result.get('sale-c').cost, lot.cost);
  close(lot.remainingCost, 0);
  close(lot.remainingShares, 0);
  close(lot.profit, lot.proceeds - lot.cost);
  assert.ok([...result.values()].every(row => row.cost >= 0));
});

test('malformed included inputs and oversells fail safely without mutating valid lots', () => {
  const ledger = calculateLedger([tx('good', 'buy')]);
  const result = calculateTransactionPerformance([
    ...ledger.rows,
    { ...tx('oversell', 'sell', { shares: 11, amount: 22 }), status: 'included' },
    { ...tx('after', 'buy', { amount: 20 }), status: 'included' },
  ]);
  assert.equal(result.get('oversell').kind, 'unavailable');
  assert.equal(result.get('after').kind, 'unavailable');
  close(result.get('good').remainingShares, 10);
  assert.equal(calculateTransactionPerformance(null).size, 0);
});

test('duplicate identifiers and unsafe numeric magnitudes cannot produce returns', () => {
  const rows = calculateLedger([tx('same', 'buy')]).rows;
  const duplicate = calculateTransactionPerformance([...rows, { ...rows[0] }]);
  assert.equal(duplicate.get('same').kind, 'unavailable');
  const overflow = calculateTransactionPerformance([{ ...tx('huge', 'buy', { nav: 1e300, amount: 1e301 }), status: 'included' }]);
  assert.equal(overflow.get('huge').kind, 'unavailable');
  assert.equal(overflow.get('huge').returnRate, null);
});
