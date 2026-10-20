import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePortfolioAllocation, evaluateHoldingLimit, holdingLimitFrom } from '../src/portfolio-allocation.js';
const rule = { id: 'us-exposure', title: '基金持有量按美股含量确定。', detail: '如果美股含量低于40%，则【立刻】降低该基金持仓至总持仓的【10%】；已低于10%时不因本条加仓。' };
test('all selected fund values, including bonds, form one denominator and return proportions only', () => {
  const rows = [{ code: 'a', marketValue: 20 }, { code: 'b', marketValue: 80 }], before = structuredClone(rows);
  assert.deepEqual(calculatePortfolioAllocation(rows, ['a', 'b']), { status: 'available', shares: { a: .2, b: .8 } });
  assert.deepEqual(rows, before);
  for (const items of [[rows[0]], [rows[0], rows[0]], [rows[0], { code: 'b', marketValue: null }], [{ code: 'a', marketValue: 0 }, { code: 'b', marketValue: 0 }]]) assert.equal(calculatePortfolioAllocation(items, ['a', 'b']).status, 'unavailable');
});
test('US shortfall activates a 10% cap, already lower allocations do not trigger an increase', () => {
  assert.equal(holdingLimitFrom(rule), .1);
  assert.equal(evaluateHoldingLimit({ status: 'below' }, rule, .100001).status, 'above');
  for (const ratio of [0, .08, .1]) assert.equal(evaluateHoldingLimit({ status: 'below' }, rule, ratio).status, 'within');
  assert.equal(evaluateHoldingLimit({ status: 'met' }, rule, .5).status, 'not-applicable');
  assert.equal(evaluateHoldingLimit({ status: 'below' }, rule, null).status, 'unavailable');
  for (const text of ['降低该基金持仓至总持仓的约10%', '降低该基金持仓至总持仓的10%到20%', '降低该基金持仓。']) assert.equal(holdingLimitFrom({ ...rule, detail: text }), null);
});
