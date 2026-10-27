// Synthetic entries only; this suite never reads a store, account, or ciphertext.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBondsPage } from '../src/bonds-view.js';
import { calculateBondHoldingDuration } from '../src/bond-holding-duration.js';

const entries = () => [
  { code: '006485', marketValue: 110, holdingProfit: 10 },
  { code: '006663', marketValue: 220, holdingProfit: 20 },
  { code: '004103', marketValue: 0, holdingProfit: 0 },
];

const progress = html => html.match(/<div class="bond-total-progress"[\s\S]*?<p class="bond-total-progress-note">[\s\S]*?<\/p>\s*<\/div>/)?.[0] || '';

test('ultrashort maturity bar calculates and labels the seven-day split, including legacy explicit day weights', () => {
  const source = { complete: true, lots: [
    { status: 'confirmed', confirmedDate: '2026-10-14', remainingShares: 1 },
    { status: 'confirmed', confirmedDate: '2026-10-13', remainingShares: 3 },
  ] };
  for (const code of ['006663', undefined]) {
    const duration = calculateBondHoldingDuration(source, { code, now: '2026-10-20' });
    const html = renderBondsPage({ entries: entries(), holdingByCode: { '006663': duration } });
    const card = html.match(/aria-labelledby="bond-title-006663"[\s\S]*?<\/details>/)[0];
    assert.match(card, /未满7天约25%，已满7天约75%/);
    assert.match(card, /class="bond-duration-recent" style="width:25%"><\/span><span class="bond-duration-mature" style="width:75%"/);
    assert.doesNotMatch(card, /30天|7～29天/);
  }
});

test('total progress uses signed cash and prioritizes red below the exact threshold', () => {
  for (const [cash, tone] of [[49_669.99, 'red'], [49_670, 'yellow'], [49_670.01, 'yellow']]) {
    const html = progress(renderBondsPage({ entries: entries(), freeCashFlow: cash, reserve: { ratio: .25 } }));
    assert.match(html, new RegExp(`data-bond-total-tone="${tone}"`));
    assert.match(html, /role="img"[^>]*当前占比约25%/);
    assert.match(html, /bond-total-segment-red.*bond-total-segment-yellow.*bond-total-segment-green/);
    assert.doesNotMatch(html, /style="width:|49,?6|data-(?:amount|value|cost)=/);
  }
  assert.match(progress(renderBondsPage({ entries: entries(), reserve: { ratio: .25 } })), /data-bond-total-tone="red"/);
});

test('total progress uses inclusive ratio boundaries before rounding and green for other known ratios', () => {
  for (const [ratio, tone] of [[0, 'green'], [1 / 6 - .000001, 'green'], [1 / 6, 'yellow'], [.25, 'yellow'], [1 / 3, 'yellow'], [1 / 3 + .000001, 'green'], [1, 'green']]) {
    const html = progress(renderBondsPage({ entries: entries(), freeCashFlow: 49_670, reserve: { ratio } }));
    assert.match(html, new RegExp(`data-bond-total-tone="${tone}"`));
    assert.match(html, new RegExp(`当前占比约${Math.round(ratio * 100)}%`));
  }
});

test('unavailable totals or shares retain the full color key without fabricated percentages or personal amounts', () => {
  for (const options of [{ cashUnavailable: true, reserve: { ratio: .25 } }, { reserve: { ratio: null } }, { reserve: { ratio: NaN } }, { reserve: { ratio: -1 } }, { reserve: { ratio: 2 } }]) {
    const html = progress(renderBondsPage({ entries: entries(), freeCashFlow: 49_670, ...options }));
    assert.match(html, /data-bond-total-tone="unknown"/);
    assert.match(html, /占比待核验/);
    assert.doesNotMatch(html, /aria-valuenow|style="width:|role="progressbar"/);
    assert.match(html, /bond-total-segment-red.*bond-total-segment-yellow.*bond-total-segment-green/);
    assert.match(html, /分段金额暂不可用/);
  }
});

test('color legends show the actual holding amount inside each band and respect global amount visibility', () => {
  const options = { entries: entries(), freeCashFlow: 179_670, reserve: { ratio: .4 } };
  const shown = progress(renderBondsPage({ ...options, visible: true }));
  for (const [color, amount] of [['red', '50,000.00'], ['yellow', '100,000.00'], ['green', '30,000.00']]) {
    assert.ok(shown.includes(`class="bond-total-${color}"><span class="num">${amount}<small>元`));
  }
  assert.doesNotMatch(shown, /＜|＞|～|低于5万元|占比1\/6|其余|规则|progressbar/);
  const hidden = progress(renderBondsPage(options));
  assert.doesNotMatch(hidden, /50,000|100,000|30,000|450,000/);
  assert.equal((hidden.match(/class="masked"/g) || []).length, 3);
  const zero = progress(renderBondsPage({ entries: entries(), freeCashFlow: -330, reserve: { ratio: 0 }, visible: true }));
  assert.equal((zero.match(/0\.00<small>元/g) || []).length, 3);
  assert.doesNotMatch(zero, /Infinity|NaN|～/);
});

test('band amounts conserve displayed cents, stop at current holdings and never show a negative band', () => {
  for (const [holding, ratio] of [[20_000, .4], [50_000, .25], [60_000, .4], [90_000, .25], [123_456.78, .37], [180_000.01, .4]]) {
    const shown = progress(renderBondsPage({ entries: entries(), freeCashFlow: holding - 330, reserve: { ratio }, visible: true }));
    const amounts = [...shown.matchAll(/class="bond-total-(?:red|yellow|green)"><span class="num">([\d,.]+)<small>元/g)].map(match => Math.round(Number(match[1].replaceAll(',', '')) * 100));
    assert.equal(amounts.length, 3);
    assert.equal(amounts.reduce((sum, amount) => sum + amount, 0), Math.round(holding * 100));
    assert.equal(amounts[0], Math.min(Math.round(holding * 100), 5_000_000));
    assert.ok(amounts.every(amount => amount >= 0));
  }
});

test('reserve notes are conditional: red warns about cash, green invites spending, yellow stays quiet', () => {
  for (const [cash, ratio, expected] of [[0, .25, '钱不多了'], [49_670, .5, '可以花钱了'], [49_670, .25, null]]) {
    const html = renderBondsPage({ entries: entries(), freeCashFlow: cash, reserve: { ratio, status: 'met', message: 'SYNTHETIC_NOTICE' } });
    const overview = html.match(/aria-label="债基合计"[\s\S]*?<\/section>/)[0];
    if (expected) {
      assert.ok(overview.includes(expected));
      assert.match(overview, /SYNTHETIC_NOTICE/);
      assert.match(overview, /href="#\/\?section=bond-reserve"/);
    } else assert.doesNotMatch(overview, /bond-reserve-note|SYNTHETIC_NOTICE/);
  }
});

test('bond cards are collapsed by default and open only when selected', () => {
  const transactions = { '006485': [] };
  const collapsed = renderBondsPage({ entries: entries(), transactions });
  const cards = [...collapsed.matchAll(/<details class="panel bond-card"[^>]*>/g)].map(match => match[0]);
  assert.equal(cards.length, 3);
  assert.ok(cards.every(tag => !/\bopen\b/.test(tag)));
  const opened = renderBondsPage({ entries: entries(), transactions, expandedByCode: { '006485': true } });
  assert.match(opened, /data-bond-ledger="006485"[^>]* open/);
});

test('partial screenshot records render all ledgers without inventing account totals or returns', () => {
  const transactions = { '006485': [{ id: 'synthetic-pending', date: '2024-01-02', type: 'buy', amount: 1,
    shares: null, nav: null, fee: null, status: 'pending', sourceStatus: 'unverified' }], '006663': [] };
  const html = renderBondsPage({ entries: [], transactions });
  assert.equal((html.match(/class="panel bond-card"/g) || []).length, 3);
  const overview = html.match(/<section[^>]*aria-label="债基合计"[\s\S]*?<\/section>/)[0];
  assert.match(overview, /合计持仓金额（元）/);
  assert.match(overview, /占总持仓比例（含自由现金流）/);
  assert.equal((overview.match(/<dl>[\s\S]*?<\/dl>/)[0].match(/待核验/g) || []).length, 3);
  assert.doesNotMatch(html, /交易记录已接入|暂不展示账户汇总|class="bonds-summary-return|1\.00/);
});

test('available amount uses the green band when present and falls back to the yellow band', () => {
  const green = renderBondsPage({ entries: entries(), freeCashFlow: 179_670, reserve: { ratio: .4 }, visible: true });
  assert.match(green, /data-bond-available="green"/);
  assert.match(green, /可用金额（元）[\s\S]*?30,000\.00/);
  const hidden = renderBondsPage({ entries: entries(), freeCashFlow: 179_670, reserve: { ratio: .4 } });
  assert.match(hidden, /data-bond-available="green"/);
  assert.doesNotMatch(hidden, /30,000/);
  const yellow = renderBondsPage({ entries: entries(), freeCashFlow: 59_670, reserve: { ratio: .25 }, visible: true });
  assert.match(yellow, /data-bond-available="yellow"/);
  assert.match(yellow, /可用金额（元）[\s\S]*?10,000\.00/);
  const smallGreen = renderBondsPage({ entries: entries(), freeCashFlow: 59_670, reserve: { ratio: .36 }, visible: true });
  assert.match(smallGreen, /data-bond-available="yellow"/);
  assert.match(smallGreen, /data-bond-available="yellow"[\s\S]*?5,555\.56/);
  const boundary = renderBondsPage({ entries: entries(), freeCashFlow: 54_670, reserve: { ratio: .4 }, visible: true });
  assert.match(boundary, /data-bond-available="green"/);
  assert.match(boundary, /data-bond-available="green"[\s\S]*?5,000\.00/);
  const unknown = renderBondsPage({ entries: entries(), freeCashFlow: 59_670, reserve: { ratio: null } });
  assert.match(unknown, /data-bond-available="unknown"/);
  assert.match(unknown, /可用金额（元）[\s\S]*?待核验/);
});

test('bond cards and totals mask amounts by default while showing cost-based rates', () => {
  const html = renderBondsPage({ entries: entries() });
  assert.equal((html.match(/class="panel bond-card"/g) || []).length, 3);
  assert.equal((html.match(/class="masked" aria-label="已隐藏"/g) || []).length, 7);
  assert.equal((html.match(/\+10\.00%/g) || []).length, 2);
  assert.match(html, /006485/);
  assert.match(html, /006663/);
  assert.doesNotMatch(html, /110\.00|220\.00|330\.00|data-(?:amount|shares|cost|market-value|holding-profit)=/);
  assert.doesNotMatch(html, /<input/);
});

test('the explicit visible mode reveals formatted amounts without enabling position editing', () => {
  const html = renderBondsPage({ entries: entries(), visible: true, editing: '006485' });
  assert.match(html, /330\.00/);
  assert.match(html, /220\.00/);
  assert.doesNotMatch(html, /id="bond-edit-form"|data-action="bond-edit"|<input/);
  assert.doesNotMatch(html, /type="password"|class="masked"/);
});

test('free cash flow masks by default, reveals a signed amount, and edits with the same privacy rule', () => {
  const hidden = renderBondsPage({ entries: entries(), freeCashFlow: 123.45 });
  assert.match(hidden, /自由现金流/);
  assert.equal((hidden.match(/class="masked" aria-label="已隐藏"/g) || []).length, 8);
  assert.doesNotMatch(hidden, /123\.45/);
  const visible = renderBondsPage({ entries: entries(), freeCashFlow: 123.45, visible: true });
  assert.match(visible, /\+123\.45/);
  assert.match(visible, /可自由支配的现金净额/);
  const empty = renderBondsPage({ entries: entries() });
  assert.match(empty, /未填写/);
  const editing = renderBondsPage({ entries: entries(), freeCashFlow: 123.45, cashEditing: true, cashDraft: '123.45' });
  assert.match(editing, /id="cash-flow-form"/);
  assert.match(editing, /name="freeCashFlow" type="password"[^>]*value="123\.45"/);
  assert.match(editing, /data-action="cash-cancel"/);
  assert.equal((editing.match(/type="password"/g) || []).length, 1);
  const error = renderBondsPage({ entries: entries(), cashEditing: true, cashDraft: 'bad', cashError: '<script>throw new Error("unsafe")</script>' });
  assert.match(error, /aria-invalid="true"/);
  assert.match(error, /&lt;script&gt;/);
  assert.doesNotMatch(error, /<script/);
});

test('the overview shows only a rounded current portfolio share even while amounts are hidden', () => {
  const html = renderBondsPage({ entries: entries(), reserve: { status: 'met', ratio: 0.28456 } });
  assert.match(html, /占总持仓比例（含自由现金流）/);
  assert.match(html, /data-bond-reserve-share>28%/);
  assert.doesNotMatch(html, /330\.00|110\.00|220\.00|28\.456/);
  assert.match(renderBondsPage({ entries: entries(), reserve: { status: 'unknown', ratio: null } }), /data-bond-reserve-share>待核验/);
});

test('the overview adds signed cash, preserves fund returns, and withholds unavailable cash totals', () => {
  for (const [cash, total] of [[12.35, '342.35'], [-12.35, '317.65'], [0, '330.00'], [null, '330.00']]) {
    const html = renderBondsPage({ entries: entries(), freeCashFlow: cash, visible: true });
    const overview = html.match(/aria-label="债基合计"[\s\S]*?<\/section>/)[0];
    assert.ok(overview.includes(total));
    assert.equal((html.match(/\+10\.00%/g) || []).length, 2);
    assert.match(html, /计入债基总持仓和配置比例/);
    assert.doesNotMatch(renderBondsPage({ entries: entries(), freeCashFlow: cash }), /342\.35|317\.65|330\.00/);
  }
  const html = renderBondsPage({ entries: entries(), cashUnavailable: true, visible: true, reserve: { ratio: .25 } });
  const overview = html.match(/aria-label="债基合计"[\s\S]*?<\/section>/)[0];
  assert.equal((overview.match(/<dl>[\s\S]*?<\/dl>/)[0].match(/待核验/g) || []).length, 3);
  assert.equal((html.match(/class="panel bond-card"/g) || []).length, 3);
});

test('a verified maturity distribution places recent holdings in red left and mature holdings in green right', () => {
  const html = renderBondsPage({ entries: entries(), holdingByCode: { '006485': { status: 'known', recentRatio: 0.25, matureRatio: 0.75 } } });
  const card = html.match(/aria-labelledby="bond-title-006485"[\s\S]*?<\/details>/)[0];
  assert.match(card, /data-bond-duration-status="known"/);
  assert.match(card, /class="bond-duration-recent" style="width:25%"><\/span><span class="bond-duration-mature" style="width:75%"/);
  assert.match(card, /未满30天约25%，已满30天约75%/);
  assert.match(card, /买入 0%.*卖出 &lt;7天 1\.5%.*7～29天 0\.1%.*≥30天 0%/);
  const other = html.match(/aria-labelledby="bond-title-006663"[\s\S]*?<\/details>/)[0];
  assert.match(other, /bond-fee-rule.*买入 0%.*卖出 &lt;7天 1\.5%.*≥7天 0%/);
  assert.doesNotMatch(other, /0\.1%|≥30天 0%/);
  assert.doesNotMatch(html, /remainingShares|confirmedDate|data-(?:amount|shares|cost)=/);
});

test('missing, partial and invalid maturity evidence retains a neutral track without fabricated proportions', () => {
  for (const duration of [undefined, { status: 'unknown' }, { status: 'known', recentRatio: 0.2, matureRatio: 0.2 }, { status: 'calculated', recentRatio: .2, matureRatio: null }]) {
    const html = renderBondsPage({ entries: entries(), holdingByCode: { '006485': duration } });
    const card = html.match(/aria-labelledby="bond-title-006485"[\s\S]*?<\/details>/)[0];
    assert.match(card, /data-bond-duration-status="unknown"/);
    assert.match(card, /持有期限待核验/);
    assert.doesNotMatch(card, /class="bond-duration-(?:recent|mature)" style=/);
    assert.doesNotMatch(card, /class="bond-duration-amount|class="bond-duration-values/);
  }
});

test('calculated holding proportions explicitly describe supplied history and mask segment amounts by default', () => {
  const options = { entries: entries(), holdingByCode: { '006485': { status: 'calculated', recentRatio: .25, matureRatio: .75 } } };
  const hidden = renderBondsPage(options).match(/aria-labelledby="bond-title-006485"[\s\S]*?<\/details>/)[0];
  assert.match(hidden, /data-bond-duration-status="calculated"/);
  assert.match(hidden, /bond-duration-status">按所提供流水推算/);
  assert.match(hidden, /按所提供流水推算，未满30天约25%，已满30天约75%/);
  assert.match(hidden, /bond-duration-recent-label[\s\S]*?约25%[\s\S]*?bond-duration-amount num"><span class="masked"/);
  assert.match(hidden, /bond-duration-mature-label[\s\S]*?约75%[\s\S]*?bond-duration-amount num"><span class="masked"/);
  assert.doesNotMatch(hidden, /27\.50|82\.50|已核验|核验通过|全部持仓/);
  const visible = renderBondsPage({ ...options, visible: true }).match(/aria-labelledby="bond-title-006485"[\s\S]*?<\/details>/)[0];
  assert.match(visible, /bond-duration-amount num">27\.50<small>元/);
  assert.match(visible, /bond-duration-amount num">82\.50<small>元/);
});

test('maturity segments show rounded ratios with masked current amounts and reveal only under the global visibility choice', () => {
  const options = { entries: entries(), holdingByCode: { '006485': { status: 'known', recentRatio: 0.3334, matureRatio: 0.6666 } } };
  const hidden = renderBondsPage(options).match(/aria-labelledby="bond-title-006485"[\s\S]*?<\/details>/)[0];
  assert.match(hidden, /bond-duration-recent-label[\s\S]*?33%[\s\S]*?bond-duration-amount num"><span class="masked"/);
  assert.match(hidden, /bond-duration-mature-label[\s\S]*?67%[\s\S]*?bond-duration-amount num"><span class="masked"/);
  assert.doesNotMatch(hidden, /36\.67|73\.33/);
  const visible = renderBondsPage({ ...options, visible: true }).match(/aria-labelledby="bond-title-006485"[\s\S]*?<\/details>/)[0];
  assert.match(visible, /bond-duration-recent-label[\s\S]*?33%[\s\S]*?bond-duration-amount num">36\.67<small>元/);
  assert.match(visible, /bond-duration-mature-label[\s\S]*?67%[\s\S]*?bond-duration-amount num">73\.33<small>元/);
  assert.doesNotMatch(visible, /remainingShares|confirmedDate|data-(?:amount|shares|cost)=/);
  const empty = renderBondsPage({ entries: entries(), holdingByCode: { '006485': { status: 'empty', recentRatio: 0, matureRatio: 0 } } }).match(/aria-labelledby="bond-title-006485"[\s\S]*?<\/details>/)[0];
  assert.match(empty, /暂无持仓/);
  assert.doesNotMatch(empty, /class="bond-duration-amount|class="bond-duration-values/);
});

test('bond cards expand a compact read-only ledger with known facts, pending hints and no cancelled records or fabricated profit', () => {
  const transactions = { '006485': [
    { id: 'confirmed', type: 'transfer-out', date: '2026-10-01', submittedAt: '2026-10-01T10:00:00', navDate: '2026-10-01', confirmedDate: '2026-10-08', confirmedAmount: 12, amount: null, shares: 10, nav: 1.2, fee: 0, status: 'confirmed' },
    { id: 'pending', type: 'transfer-out', date: '2026-10-16', requestedShares: 3, shares: null, amount: null, nav: null, navDate: null, fee: null, status: 'pending', sourceStatus: 'processing', note: '<img src=x>' },
    { id: 'cancelled', type: 'buy', status: 'cancelled', amount: 2 },
  ] };
  const html = renderBondsPage({ entries: entries(), transactions, expandedByCode: { '006485': true } });
  assert.match(html, /data-bond-ledger="006485"[^>]* open/);
  assert.match(html, /bond-ledger-hint">2 笔/);
  assert.match(html, /data-id="bond-pending"/);
  assert.match(html, /申请份额 · 份/);
  assert.match(html, /transaction-pending-hint">待补确认信息/);
  assert.match(html, /确认日期|净值日期|确认净值|确认份额|手续费/);
  assert.doesNotMatch(html, /bond-cancelled|id="bond-edit-form"|data-action="bond-(?:edit|close|cancel)"|累计盈亏|已实现盈亏|<img/);
  assert.doesNotMatch(html, /12\.00|10\.000000|3\.000000/);
  const visible = renderBondsPage({ entries: entries(), transactions, visible: true });
  assert.match(visible, /12\.00/); assert.match(visible, /3\.00/); assert.match(visible, /&lt;img src=x&gt;/);
});

test('a paired transfer-out row is labelled 转出 while an ordinary sell remains 卖出', () => {
  const base = { date: '2026-10-22', type: 'sell', status: 'confirmed', sourceStatus: 'confirmed', shares: 1, nav: 1, amount: 1, fee: 0 };
  const transactions = { '006485': [
    { ...base, id: 'transfer-leg', transferId: 'transfer-synthetic', transferStatus: 'reviewed' },
    { ...base, id: 'ordinary-sell', date: '2026-10-23' },
  ] };
  const html = renderBondsPage({ entries: entries(), transactions, expandedByCode: { '006485': true } });
  assert.match(html, /transaction-title">转出<span/);
  assert.match(html, /transaction-title">卖出<span/);
});

test('calculated transaction labels keep inferred confirmations distinct and leave pending records pending', () => {
  const base = { type: 'transfer-in', date: '2026-10-01', navDate: '2026-10-01', confirmedDate: '2026-10-02', amount: null, shares: 10, nav: 1.2, fee: 0 };
  const transactions = { '006485': [
    { ...base, id: 'estimated', status: 'confirmed', sharesBasis: 'calculated', sourceStatus: 'calculated' },
    { ...base, id: 'pending-estimated', status: 'pending', sharesBasis: 'calculated', sourceStatus: 'calculated' },
    { ...base, id: 'reported', status: 'confirmed', sharesBasis: 'reported', sourceStatus: 'confirmed' },
  ] };
  const html = renderBondsPage({ entries: entries(), transactions, expandedByCode: { '006485': true } });
  const articles = html.match(/<article class="transaction bond-transaction[\s\S]*?<\/article>/g);
  const calculated = articles.find(article => article.includes('data-id="bond-estimated"'));
  assert.match(calculated, /推算份额 · 份/);
  assert.match(calculated, /row-status[^>]*>按流水推算/);
  for (const label of ['推算净值', '推算份额', '推算净值日', '推算确认日']) assert.ok(calculated.includes(label));
  assert.doesNotMatch(calculated, /确认资料|已确认|确认净值|确认份额|10\.000000/);
  const pending = articles.find(article => article.includes('data-id="bond-pending-estimated"'));
  assert.match(pending, /row-status[^>]*>待补全/);
  assert.match(pending, /待补确认信息 · 按流水推算/);
  assert.doesNotMatch(pending, /已确认/);
  const reported = articles.find(article => article.includes('data-id="bond-reported"'));
  assert.match(reported, /确认份额 · 份/);
  assert.match(reported, /已确认/);
  assert.match(reported, /确认净值|确认日期/);
  assert.doesNotMatch(reported, /推算/);
});

test('loading, unavailable, missing and invalid entries never invent zero returns', () => {
  for (const options of [
    { loading: true }, { unavailable: true, entries: entries() }, {}, { entries: [] },
    { entries: [{ code: '006485', marketValue: null, holdingProfit: null }] },
  ]) {
    const html = renderBondsPage(options);
    assert.match(html, /正在读取债基记录|债基数据暂不可用/);
    assert.doesNotMatch(html, /0\.00%|class="panel bond-card"|<input/);
  }
});
