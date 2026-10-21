// Invented records only; no private workbook is read by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareBondWorkbookRows } from '../scripts/live-bond-data.mjs';
import { calculateBondWorkbook } from '../scripts/bond-ledger.mjs';
import { addPendingPurchaseValue } from '../src/bond-model.js';
import { renderBondsPage } from '../src/bonds-view.js';

test('a completed workbook sale remains usable when public prices lag its date', () => {
  const rows = [
    { id: 'opening', date: '2026-10-01', type: 'buy', amount: 100, shares: 100, nav: 1, fee: 0, status: 'estimated' },
    { id: 'filled-sale', date: '2026-10-20', type: 'sell', amount: 12, shares: 10, nav: 1.2, fee: 0, status: 'estimated' },
    { id: 'future-buy', date: '2026-10-21', type: 'buy', amount: 20, shares: null, nav: null, fee: 0, status: 'pending' },
  ];
  const before = structuredClone(rows), prepared = prepareBondWorkbookRows(rows, '2026-10-20');
  assert.equal(prepared[1].status, 'estimated');
  assert.equal(prepared[2].status, 'pending');
  const result = calculateBondWorkbook('006663', prepared, { date: '2026-10-19', nav: 1.1 }, { asOfDate: '2026-10-20' });
  assert.deepEqual(result.entry, { code: '006663', marketValue: 99, holdingProfit: 9 });
  assert.equal(result.valuationDate, '2026-10-19');
  assert.deepEqual(rows, before);
});

test('complete six-column display does not demand nonexistent application or confirmation fields', () => {
  const html = renderBondsPage({ entries: [{ code: '006485', marketValue: 110, holdingProfit: 10 }, { code: '006663', marketValue: 220, holdingProfit: 20 }, { code: '004103', marketValue: 0, holdingProfit: 0 }],
    transactions: { '006663': [{ id: 'filled-sale', date: '2026-10-20', type: 'sell', amount: 12, confirmedAmount: 12, nav: 1.2, shares: 10, fee: 0, status: 'confirmed', sourceStatus: 'calculated', sharesBasis: 'reported' }] } });
  const article = html.match(/<article class="transaction bond-transaction"[\s\S]*?<\/article>/)?.[0];
  assert.ok(article); assert.match(article, /表格已填写|表格资料/);
  assert.match(article, /表格净值/); assert.match(article, /表格金额/);
  assert.doesNotMatch(article, /待补全|待补确认|进行中|申请份额|确认日期|净值日期/);
});

test('only unconfirmed purchases add cash to market value, once, without guessing shares', () => {
  const pending = { id: 'pending-buy', type: 'buy', status: 'pending', amount: 12.34, shares: null, nav: null };
  assert.equal(addPendingPurchaseValue(100, [pending, pending, { ...pending, id: 'sale', type: 'sell' }, { ...pending, id: 'cancelled', status: 'cancelled' }]), 112.34);
  assert.equal(addPendingPurchaseValue(112.34, [{ ...pending, status: 'confirmed' }]), 112.34);
  assert.equal(addPendingPurchaseValue(null, [pending]), null);
  assert.equal(pending.shares, null); assert.equal(pending.nav, null);
});

test('bond pending buy cash changes displayed holdings and totals while preserving earnings and rates', () => {
  const entries = [{ code: '006485', marketValue: 110, holdingProfit: 10 }, { code: '006663', marketValue: 220, holdingProfit: 20 }, { code: '004103', marketValue: 0, holdingProfit: 0 }];
  const html = renderBondsPage({ entries, visible: true, transactions: { '006663': [{ id: 'pending-buy', date: '2026-10-21', type: 'buy', status: 'pending', sourceStatus: 'processing', amount: 30 }] } });
  assert.match(html, /360\.00/); assert.match(html, /250\.00/);
  assert.match(html, /20\.00/); assert.match(html, /10\.00%/);
  assert.equal(entries[1].marketValue, 220);
});
