// All amounts below are synthetic and never read from an account or a file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOND_FUNDS, normalizeBondEntries, normalizeFreeCashFlow, calculateBondSummary } from '../src/bond-model.js';

const entries = (first = {}, second = {}) => [
  { code: '006485', marketValue: 120, holdingProfit: 20, ...first },
  { code: '006663', marketValue: 45, holdingProfit: -5, ...second },
];
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12);

test('only the two requested public bond identities are exposed', () => {
  assert.deepEqual(BOND_FUNDS, [
    { code: '006485', name: '广发中债1-3年国开行债券指数C' },
    { code: '006663', name: '易方达安悦超短债债券C' },
  ]);
  assert.ok(Object.isFrozen(BOND_FUNDS));
  assert.ok(BOND_FUNDS.every(Object.isFrozen));
});

test('normalization rounds to cents, orders by the catalogue, and keeps payload fields minimal', () => {
  const source = entries({ marketValue: 2.675, holdingProfit: 1.005 }, { marketValue: 5.005, holdingProfit: -1.005 }).reverse();
  const before = structuredClone(source);
  const normalized = normalizeBondEntries(source);
  assert.deepEqual(normalized, [
    { code: '006485', marketValue: 2.68, holdingProfit: 1.01 },
    { code: '006663', marketValue: 5.01, holdingProfit: -1.01 },
  ]);
  assert.deepEqual(source, before);
  assert.deepEqual(normalizeBondEntries(normalized), normalized);
  assert.ok(normalized.every(entry => Object.keys(entry).sort().join(',') === 'code,holdingProfit,marketValue'));
});

test('each return uses its cost rather than market value and the total uses total cost', () => {
  const summary = calculateBondSummary(entries());
  assert.deepEqual(summary.holdings.map(row => row.cost), [100, 50]);
  assert.deepEqual(summary.holdings.map(row => row.returnRate), [0.2, -0.1]);
  assert.equal(summary.marketValue, 165);
  assert.equal(summary.holdingProfit, 15);
  assert.equal(summary.cost, 150);
  assert.equal(summary.returnRate, 0.1);
  assert.notEqual(summary.returnRate, summary.holdingProfit / summary.marketValue);
  assert.notEqual(summary.returnRate, summary.holdings.reduce((sum, row) => sum + row.returnRate, 0) / 2);
  assert.deepEqual(summary.holdings.map(row => row.name), BOND_FUNDS.map(fund => fund.name));
});

test('cent arithmetic avoids binary decimal drift and supports zero profit and total loss', () => {
  const decimal = calculateBondSummary(entries({ marketValue: 0.3, holdingProfit: 0.1 }, { marketValue: 0.2, holdingProfit: 0.1 }));
  assert.equal(decimal.marketValue, 0.5);
  assert.equal(decimal.holdingProfit, 0.2);
  assert.equal(decimal.cost, 0.3);
  close(decimal.returnRate, 2 / 3);
  const loss = calculateBondSummary(entries({ marketValue: 0, holdingProfit: -0.05 }, { marketValue: 0.1, holdingProfit: -0 }));
  assert.equal(loss.holdings[0].returnRate, -1);
  assert.equal(loss.holdings[1].returnRate, 0);
  assert.equal(Object.is(loss.holdings[1].holdingProfit, -0), false);
  assert.equal(loss.cost, 0.15);
  close(loss.returnRate, -1 / 3);
});

test('small scientific-notation values round safely and cannot erase positive cost', () => {
  assert.deepEqual(normalizeBondEntries(entries({ holdingProfit: 1e-7 }))[0], { code: '006485', marketValue: 120, holdingProfit: 0 });
  assert.throws(() => normalizeBondEntries(entries({ marketValue: 0.004, holdingProfit: 0 })), { message: 'Invalid bond entries.' });
});

test('unknown, missing, duplicate, extra-field or nonnumeric input fails without guessed holdings', () => {
  const bad = [
    null, [], entries().slice(0, 1), [...entries(), entries()[0]],
    entries({ code: '000000' }), entries({}, { code: '006485' }),
    entries({ marketValue: null }), entries({ holdingProfit: null }),
    entries({ marketValue: '' }), entries({ marketValue: '120' }), entries({ holdingProfit: '-5' }),
    entries({ marketValue: NaN }), entries({ marketValue: Infinity }), entries({ holdingProfit: -Infinity }),
    entries({ marketValue: -0.001 }), entries({ holdingProfit: 120 }), entries({ holdingProfit: 121 }),
    entries({ cost: 100 }), entries({ note: 'SYNTHETIC_PRIVATE_MARKER' }),
    entries({ marketValue: Number.MAX_VALUE }), entries({ holdingProfit: -Number.MAX_VALUE }),
  ];
  for (const value of bad) {
    for (const calculate of [normalizeBondEntries, calculateBondSummary]) {
      assert.throws(() => calculate(value), { message: 'Invalid bond entries.' });
    }
  }
});

test('free cash flow is optional, rounded to cents, and may be negative', () => {
  assert.equal(normalizeFreeCashFlow(undefined), null);
  assert.equal(normalizeFreeCashFlow(null), null);
  assert.equal(normalizeFreeCashFlow(''), null);
  assert.equal(normalizeFreeCashFlow(0), 0);
  assert.equal(normalizeFreeCashFlow(1.005), 1.01);
  assert.equal(normalizeFreeCashFlow(-2.5), -2.5);
  for (const value of ['12', NaN, Infinity, -Infinity, [], {}, Number.MAX_VALUE]) {
    assert.throws(() => normalizeFreeCashFlow(value), { message: 'Invalid bond entries.' });
  }
});

test('overflowing summed amounts and accessor errors remain generic and never echo input', () => {
  const large = { marketValue: 60_000_000_000_000, holdingProfit: 0 };
  assert.throws(() => calculateBondSummary(entries(large, large)), { message: 'Invalid bond entries.' });
  const source = entries();
  Object.defineProperty(source[0], 'holdingProfit', { enumerable: true, get() { throw new Error('SYNTHETIC_PRIVATE_MARKER'); } });
  for (const calculate of [normalizeBondEntries, calculateBondSummary]) {
    assert.throws(() => calculate(source), error => error.message === 'Invalid bond entries.' && !error.stack.includes('SYNTHETIC_PRIVATE_MARKER'));
  }
});
