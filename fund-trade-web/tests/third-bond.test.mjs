// Synthetic inputs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBondWorkbook } from '../scripts/bond-ledger.mjs';
import { normalizeBondEntries, calculateBondSummary, calculateBondHoldingValue } from '../src/bond-model.js';
import { normalizeBondTransactions } from '../src/bond-transactions.js';
import { calculateBondHoldingDuration, getBondRedemptionFeeRate } from '../src/bond-holding-duration.js';
import { calculatePortfolioAllocation } from '../src/portfolio-allocation.js';
import { renderBondsPage } from '../src/bonds-view.js';
const old = [{code:'006485',marketValue:110,holdingProfit:10},{code:'006663',marketValue:220,holdingProfit:20}];
test('a missing third entry stays visible and does not erase existing cards or fabricate totals', () => {
  assert.equal(calculateBondWorkbook('004103',[],{date:'2026-10-21',nav:1}),null);
  assert.deepEqual(normalizeBondEntries(old),old);
  assert.equal(calculateBondSummary(old).marketValue,null);
  assert.throws(()=>calculateBondHoldingValue(old));
  const html=renderBondsPage({entries:old,transactions:{'004103':[]},visible:true});
  assert.match(html,/bond-title-004103/);assert.match(html,/中信保诚稳悦债券C/);
  assert.match(html,/110\.00/);assert.match(html,/220\.00/);
  assert.match(html,/持仓待核验，请补全交易记录/);
  assert.match(html,/data-bond-reserve-share>待核验/);
  assert.doesNotMatch(html,/330\.00/);
});
test('an empty six-column table is a verified zero holding and restores totals', () => {
  const zero = { code: '004103', marketValue: 0, holdingProfit: 0 };
  const entries = [...old, zero];
  const summary = calculateBondSummary(entries);
  assert.equal(summary.marketValue, 330);
  assert.equal(summary.holdingProfit, 30);
  assert.equal(summary.cost, 300);
  assert.equal(summary.returnRate, 0.1);
  assert.equal(calculateBondHoldingValue(entries), 330);
  const allocation = calculatePortfolioAllocation(entries, ['006485', '006663', '004103'], null);
  assert.equal(allocation.status, 'available');
  assert.equal(allocation.shares['004103'], 0);
  assert.equal(calculateBondHoldingDuration({ complete: true, lots: [] }).status, 'empty');
  const html = renderBondsPage({ entries, transactions: { '004103': [] }, visible: true });
  const card = html.match(/aria-labelledby="bond-title-004103"[\s\S]*?<\/details>/)[0];
  assert.match(card, /暂无交易记录/);
  assert.doesNotMatch(card, /持仓待核验/);
});
test('004103 supports FIFO, fees, period tiers, transactions, totals and allocation', () => {
  const rows=[{date:'2026-09-01',type:'buy',amount:10,shares:10,nav:1,fee:0,status:'confirmed'},
    {date:'2026-10-20',type:'buy',amount:20,shares:20,nav:1,fee:0,status:'confirmed'},
    {date:'2026-10-21',type:'sell',amount:5,shares:5,nav:1,fee:0,status:'confirmed'}];
  const result=calculateBondWorkbook('004103',rows,{date:'2026-10-21',nav:1.1});
  assert.equal(result.entry.marketValue,27.5);assert.equal(result.entry.holdingProfit,2.5);
  assert.equal(result.holdingLots.lots[0].remainingShares,5);
  const duration=calculateBondHoldingDuration(result.holdingLots,{code:'004103',now:'2026-10-21'});
  assert.equal(duration.maturityDays,30);assert.equal(duration.under7Ratio,.8);assert.equal(duration.sevenTo29Ratio,0);
  for(const [days,fee] of [[0,.015],[6,.015],[7,.001],[29,.001],[30,0]]) assert.equal(getBondRedemptionFeeRate('004103',days),fee);
  const transactions=normalizeBondTransactions({'004103':rows.map((r,i)=>({...r,id:`synthetic-${i}`,sourceStatus:'calculated'}))});
  assert.equal(transactions['004103'].length,3);
  const entries=[...old,result.entry];assert.equal(calculateBondHoldingValue(entries,2.5),360);
  const allocation=calculatePortfolioAllocation(entries,['006485','006663','004103'],2.5);
  assert.equal(allocation.status,'available');assert.equal(allocation.shares['004103'],27.5/360);
  const html=renderBondsPage({entries,transactions,holdingByCode:{'004103':duration}});
  const card=html.match(/aria-labelledby="bond-title-004103"[\s\S]*?<\/details>/)[0];
  assert.match(card,/7～29天/);assert.match(card,/已满30天/);assert.match(card,/0\.1%/);
  assert.doesNotMatch(card,/27\.50|2\.50|data-(?:amount|shares)=/);
});
