// Synthetic state only: this suite never opens ledger.enc.json or any workbook.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calculateLedger, describeModeEffect } from '../src/engine.js';
import { estimateApplications, GUOFU_TRADING_DATES } from '../src/application-estimates.js';
import { getDailyCode } from '../src/vault.js';
import { unlockErrorMessage } from '../src/unlock-errors.js';
import { createRefreshController } from '../src/refresh-controller.js';
import { NAV_PERIODS, recentNavPeriod, resolveNavRange, moveNavBoundary, summarizeNavRange, resolveNavSliderDomain, latestCoveredTradeDate } from '../src/nav-range.js';
import { renderNavChart, buildTradeMarkers } from '../src/nav-chart.js';
import { calculateNavAnnualized, evaluateAnnualDiscipline, evaluateAddDiscipline, getNavDisciplineGap } from '../src/nav-annualized.js';
import { setupNavChartInteractions } from '../src/nav-interaction.js';
import { setupNavSliderInteractions } from '../src/nav-slider.js';
import { calculateTransactionPerformance } from '../src/transaction-performance.js';
import { FUNDS, FUND_CODES } from '../src/funds.js';
import { DISCIPLINE_ENTRIES } from '../src/discipline.js';
import { createDisciplineSync } from '../src/discipline-sync.js';
import { REGION_DATA } from '../src/region-data.js';
import { evaluateUsExposure } from '../src/us-exposure.js';
import { calculateHoldingDuration, createHoldingDurationScale } from '../src/holding-duration.js';
import { renderBondsPage } from '../src/bonds-view.js';
import { calculateBondHoldingValue, addPendingPurchaseValue, BOND_CODES } from '../src/bond-model.js';
import { calculatePortfolioAllocation, evaluateHoldingLimit } from '../src/portfolio-allocation.js';
import { evaluateBondReserve, bondReserveTone } from '../src/bond-reserve.js';
import { calculateBondHoldingDuration } from '../src/bond-holding-duration.js';
import { getEstimateDates, getEstimateTargetDate, parseEstimatePercent, buildEstimatedNav } from '../src/nav-estimates.js';
import { loadNavEstimates, saveNavEstimates, NAV_ESTIMATE_STORAGE_KEY } from '../src/nav-estimate-store.js';
import { renderEstimatePanel } from '../src/estimate-panel.js';
import { getDisciplineActions, adjustDisciplineRule } from '../src/discipline-actions.js';
import { getNavChartDisplay } from '../src/nav-display.js';
import { createFundViewportKeeper } from '../src/viewport-anchor.js';
import { navDateForOrder } from '../src/trading-calendar.js';
import { parseTransactionDate } from '../src/transaction-date.js';
import { renderTradeDialog, renderReviewDialog, TRADE_FUNDS, TRADE_OPTIONS, CASH_CODE, inferTradeMode } from '../src/trade-dialog.js';
import { buyFee } from '../src/fee-rules.js';


const source = (await readFile(new URL('../src/app.js', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?;\s*/gm, '')
  .replace(/await import\('\.\/vault\.js(?:\?[^']*)?'\)/, 'await loadVault()');
assert.ok(source.includes('await loadVault()'), 'The vault must be replaced with a synthetic dependency.');
assert.ok(!source.includes('await import('), 'Tests must not import the live vault dependency.');
const RealDate = Date;

async function flushMicrotasks() {
  for (let count = 0; count < 12; count += 1) await Promise.resolve();
}

function fakeClock(timestamp) {
  let now = RealDate.parse(timestamp);
  let nextId = 0;
  const timers = new Map();
  function schedule(callback, delay, repeat = 0) {
    const id = ++nextId;
    timers.set(id, { callback, at: now + delay, repeat });
    return id;
  }
  return {
    get now() { return now; },
    timers,
    Date: class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    setTimeout: (callback, delay = 0) => schedule(callback, delay),
    setInterval: (callback, delay) => schedule(callback, delay, delay),
    clear: id => timers.delete(id),
    advanceWithoutCallbacks(milliseconds) { now += milliseconds; },
    tick(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        const [id, timer] = next;
        now = Math.max(now, timer.at);
        if (!timer.repeat) timers.delete(id);
        timer.callback();
        if (timer.repeat && timers.has(id)) timer.at = now + timer.repeat;
      }
      now = end;
    },
  };
}

function harness(timestamp = '2026-01-08T02:00:00.000Z', options = {}) {
  const clock = fakeClock(timestamp);
  const storage = options.storage || new Map();
  const localStorage = storage instanceof Map ? {
    getItem: key => storage.has(key) ? String(storage.get(key)) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  } : storage;
  const scrollCalls = [];
  const scrollY = Number.isFinite(options.scrollY) ? options.scrollY : 0;
  const documentEvents = new Map();
  const windowEvents = new Map();
  const listen = collection => (name, callback) => collection.set(name, callback);
  const app = { innerHTML: '', addEventListener: listen(documentEvents), querySelector: () => null, querySelectorAll: () => [] };
  const timer = { textContent: '', dataset: {} };
  const toast = { textContent: '', classList: { add() {}, remove() {} } };
  const input = { value: '', focus() {} };
  const error = { textContent: '' };
  const meta = { content: '' };
  let transitionSkips = 0;
  const document = {
    documentElement: { dataset: {} },
    querySelector(selector) {
      if (selector === '#app') return app;
      if (selector === '#toast') return toast;
      if (selector === '#session-timer') return app.innerHTML.includes('id="session-timer"') ? timer : null;
      if (selector === '#vault-password') return input;
      if (selector === '#gate-error') return error;
      return meta;
    },
    querySelectorAll: () => [],
    addEventListener: listen(documentEvents),
  };
  if (options.transition) document.startViewTransition = update => {
    update();
    return { finished: new Promise(() => {}), skipTransition() { transitionSkips += 1; } };
  };
  const location = { hash: '#/' };
  const window = {
    addEventListener: listen(windowEvents), removeEventListener(name) { windowEvents.delete(name); },
    scrollY, innerHeight: 844,
    scrollTo(settings) { scrollCalls.push(settings); this.scrollY = settings.top; },
    requestAnimationFrame: callback => clock.setTimeout(callback, 16), cancelAnimationFrame: clock.clear,
    setTimeout: clock.setTimeout, clearTimeout: clock.clear,
  };
  const day = () => getDailyCode(new RealDate(clock.now));
  const loadVault = options.loadVault || (async () => ({ getDailyCode: day, unlockVault: async () => ({ funds: {} }) }));
  const fakeBondOpen = options.openBondStore || (async () => {
    let closed = false;
    let snapshot = { bonds: [{ code: '006485', marketValue: 110, holdingProfit: 10 }, { code: '006663', marketValue: 220, holdingProfit: 20 }, { code: '004103', marketValue: 0, holdingProfit: 0 }], updatedAt: '2026-01-08T02:00:00.000Z' };
    return {
      getSnapshot() { if (closed) throw new Error('closed'); return structuredClone(snapshot); },
      async save(bonds) { if (closed) throw new Error('closed'); snapshot = { bonds: structuredClone(bonds), updatedAt: new RealDate(clock.now).toISOString() }; return structuredClone(snapshot); },
      close() { closed = true; },
    };
  });
  const fetch = options.fetch || (async url => ({ ok: true, json: async () => ({ code: /([0-9]{6})\.json$/.exec(url)?.[1], history: [] }) }));
  const api = new Function('BOND_CODES', 'addPendingPurchaseValue', 'describeModeEffect', 'recentNavPeriod', 'calculateLedger', 'estimateApplications', 'GUOFU_TRADING_DATES', 'createRefreshController', 'NAV_PERIODS', 'resolveNavRange', 'latestCoveredTradeDate', 'moveNavBoundary', 'summarizeNavRange', 'resolveNavSliderDomain', 'renderNavChart', 'buildTradeMarkers', 'calculateNavAnnualized', 'evaluateAnnualDiscipline', 'evaluateAddDiscipline', 'getNavDisciplineGap', 'setupNavChartInteractions', 'setupNavSliderInteractions', 'calculateTransactionPerformance', 'FUNDS', 'FUND_CODES', 'DISCIPLINE_ENTRIES', 'createDisciplineSync', 'REGION_DATA', 'evaluateUsExposure', 'calculateHoldingDuration', 'createHoldingDurationScale', 'openBondStore', 'renderBondsPage', 'calculateBondHoldingValue', 'evaluateBondReserve', 'bondReserveTone', 'calculatePortfolioAllocation', 'evaluateHoldingLimit', 'calculateBondHoldingDuration', 'getEstimateDates', 'getEstimateTargetDate', 'parseEstimatePercent', 'buildEstimatedNav', 'loadNavEstimates', 'saveNavEstimates', 'renderEstimatePanel', 'getDisciplineActions', 'adjustDisciplineRule', 'getNavChartDisplay', 'createFundViewportKeeper', 'unlockErrorMessage', 'navDateForOrder', 'parseTransactionDate', 'renderTradeDialog', 'renderReviewDialog', 'TRADE_FUNDS', 'TRADE_OPTIONS', 'CASH_CODE', 'inferTradeMode', 'buyFee', 'document', 'location', 'window', 'matchMedia', 'localStorage', 'Date',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'scrollTo', 'scrollY', 'fetch', 'loadVault',
    `${source}\nreturn { state, startSession, checkSession, lock, render, remainingTime, actionClick, useTradeWheel, unlock, saveCashFlow, saveNavEstimateEdits, refreshCurrentData, dataRefresh, disciplineSync, chartOverlays, navRangeControls, navContext, navSliderDomain, navVisualValues, valuation, ledger, navPanel, navRangeProfit, updateNavMeasurement, bondPositions, equityHoldingDistribution, fundRegions, sparkline, estimateHomePanel, bondReserveCheck, portfolioAllocation, annualDisciplineAlert, handles: () => ({ sessionInterval, sessionTimeout, dailyCodeReader }) };`)(
    BOND_CODES, addPendingPurchaseValue, describeModeEffect, recentNavPeriod, calculateLedger, estimateApplications, GUOFU_TRADING_DATES, createRefreshController, NAV_PERIODS, resolveNavRange, latestCoveredTradeDate, moveNavBoundary, summarizeNavRange, resolveNavSliderDomain, renderNavChart, buildTradeMarkers, calculateNavAnnualized, evaluateAnnualDiscipline, evaluateAddDiscipline, getNavDisciplineGap, setupNavChartInteractions, setupNavSliderInteractions, calculateTransactionPerformance, FUNDS, FUND_CODES, DISCIPLINE_ENTRIES, createDisciplineSync, REGION_DATA, evaluateUsExposure, calculateHoldingDuration, createHoldingDurationScale, fakeBondOpen, renderBondsPage, calculateBondHoldingValue, evaluateBondReserve, bondReserveTone, calculatePortfolioAllocation, evaluateHoldingLimit, calculateBondHoldingDuration, getEstimateDates, getEstimateTargetDate, parseEstimatePercent, buildEstimatedNav, loadNavEstimates, saveNavEstimates, renderEstimatePanel, getDisciplineActions, adjustDisciplineRule, getNavChartDisplay, createFundViewportKeeper, unlockErrorMessage, navDateForOrder, parseTransactionDate, renderTradeDialog, renderReviewDialog, TRADE_FUNDS, TRADE_OPTIONS, CASH_CODE, inferTradeMode, buyFee, document, location, window, () => ({ matches: false }), localStorage, clock.Date,
    clock.setTimeout, clock.clear, clock.setInterval, clock.clear, settings => scrollCalls.push(settings), scrollY, fetch, loadVault,
  );
  function start() {
    api.state.unlocked = true;
    api.state.visible = false;
    api.state.funds = { '005698': { transactions: [], mode: 'profit-first', rate: null } };
    api.startSession(day(), day);
    api.render();
  }
  function click(action, extra = {}) {
    const target = { dataset: { action, ...extra } };
    api.actionClick({ preventDefault() {}, target: { closest: selector => selector === '[data-action]' ? target : null } });
  }
  function submit() {
    input.value = 'synthetic-test-input';
    const button = { disabled: false, textContent: '', innerHTML: '' };
    return api.unlock({ preventDefault() {}, target: { elements: { password: input }, querySelector: () => button } });
  }
  return { api, clock, app, document, documentEvents, windowEvents, window, location, scrollCalls, start, click, submit, day, storage, localStorage, toast,
    get transitionSkips() { return transitionSkips; } };
}

function assertLocked(h) {
  assert.equal(h.api.state.unlocked, false);
  assert.equal(h.api.state.visible, false);
  assert.deepEqual(h.api.state.funds, {});
  assert.equal(h.api.state.createdAt, null);
  assert.equal(h.api.state.deadline, 0);
  assert.equal(h.api.state.sessionDay, null);
  assert.deepEqual(h.api.handles(), { sessionInterval: null, sessionTimeout: null, dailyCodeReader: null });
  assert.match(h.app.innerHTML, /id="unlock-form"/);
}

// The read-only transaction panel receives invented spreadsheet-source records.
function sourceTransactionHarness(transactions = [], options = {}) {
  const h = harness(options.now);
  h.start();
  const code = options.code || '005698';
  h.location.hash = `#/fund/${code}`;
  h.api.state.funds[code] = { mode: 'profit-first', rate: '0.15', incomplete: options.incomplete === true, transactions: structuredClone(transactions) };
  h.api.state.nav[code] = { history: structuredClone(options.history || [{ date: '2026-01-07', nav: 2 }]) };
  h.api.render();
  return { h, code };
}

test('transaction cards retain compact details and pending status while every mutation entry point is retired', () => {
  const { h, code } = sourceTransactionHarness([
    { id: 'sheet-buy', type: 'buy', status: 'confirmed', date: '2026-01-01', amount: 100, nav: 2, shares: 50, fee: 0 },
    { id: 'sheet-pending', type: 'sip', status: 'pending', sourceStatus: 'processing', submittedAt: '2026-01-02T10:00:00', amount: 10 },
  ]);
  const original = structuredClone(h.api.state.funds[code].transactions);
  assert.match(h.app.innerHTML, /transaction transaction-pending/);
  assert.match(h.app.innerHTML, /等待成交确认，买入金额已计入市值/);
  assert.match(h.app.innerHTML, /transaction-profit-row|transaction-detail-metrics/);
  assert.doesNotMatch(h.app.innerHTML, /transaction-form|transaction-dialog|transaction-actions|登记交易|data-action="transaction-/);
  for (const action of ['transaction-new', 'transaction-edit', 'transaction-delete', 'transaction-delete-confirm', 'transaction-sip-toggle']) h.click(action, { id: 'sheet-buy' });
  assert.deepEqual(h.api.state.funds[code].transactions, original);
  assert.doesNotMatch(h.app.innerHTML, /transaction-form|transaction-dialog/);
  h.api.lock();
});

test('transaction details omit supplementary dates and distinguish estimated shares from confirmed shares', () => {
  const { h } = sourceTransactionHarness([
    { id: 'estimated-source', type: 'buy', status: 'estimated', date: '2026-01-01', dateBasis: 'order', amount: 100, nav: 2, shares: 49.5, fee: 1, formulaAdjustment: 'purchase-net-shares' },
  ]);
  assert.match(h.app.innerHTML, /估算份额/);
  assert.match(h.app.innerHTML, /data-formula-adjustment/);
  assert.doesNotMatch(h.app.innerHTML, /交易日期沿用原始下单日期|原表未提供成交净值日期|录入日期：|来源备份净值日期|估值净值日期[^<]*含估算交易/);
  h.api.lock();
});

test('unlock ignores legacy browser transaction overlays and fee preferences without deleting them', async () => {
  const saved = new Map([
    ['fund-ledger:transactions:local:v1', 'legacy-encrypted-synthetic-overlay'],
    ['fund-ledger:transaction-fees:v1', '{"005698:buy":0.15}'],
  ]);
  const before = new Map(saved), accessed = [];
  const storage = {
    getItem(key) { accessed.push(['read', key]); return saved.get(key) ?? null; },
    setItem(key, value) { accessed.push(['write', key]); saved.set(key, String(value)); },
    removeItem(key) { accessed.push(['remove', key]); saved.delete(key); },
  };
  const snapshot = { createdAt: 'synthetic-sheet', funds: { '005698': { transactions: [{ id: 'sheet-only', type: 'buy', status: 'confirmed', date: '2026-01-01', nav: 2, shares: 1, fee: 0 }], mode: 'profit-first' } } };
  let h;
  h = harness(undefined, { storage, loadVault: async () => ({
    getDailyCode: () => h.day(),
    unlockVault: async (_password, { onSession }) => { onSession({ close() {}, refresh: async () => structuredClone(snapshot) }); return structuredClone(snapshot); },
  }) });
  await h.submit();
  assert.equal(h.api.state.unlocked, true);
  assert.deepEqual(h.api.state.funds['005698'].transactions.map(row => row.id), ['sheet-only']);
  assert.ok(accessed.every(([, key]) => !key.includes('transactions') && !key.includes('transaction-fees')));
  assert.deepEqual(saved, before);
  h.api.lock();
  assert.deepEqual(saved, before);
});

test('the exposure adjustment stays below rule one and document budget shorthand renders in clear yuan units', () => {
  const h = harness();
  h.start();
  h.api.state.disciplines = [
    { id: 'us-exposure', title: '基金持有量按美股含量确定。', detail: '如果美股含量低于40%，则【立刻】降低该基金持仓。' },
    { id: 'us-exposure-adjustment', title: '美股含量不达标的基金，加仓金额/比例【减半】，卖出金额/比例【翻倍】。', detail: '' },
    { id: 'add-discipline', title: '加仓纪律， 加仓一定要是【少频次，高金额】的。', detail: '' },
    { id: 'add-discipline-decline', title: '自上次交易节点后，跌幅超过了 平均年化收益率 的2倍，进行一次加仓（1w元）', detail: '' },
  ];
  h.api.render();
  const first = h.app.innerHTML.match(/<(?:article|details) class="discipline-entry[^>]*data-discipline="us-exposure"[\s\S]*?<\/(?:article|details)>/)[0];
  assert.match(first, /data-discipline="us-exposure-adjustment"/);
  assert.match(first, /discipline-clause-label">1\.1<\/small>/);
  assert.match(first, /减半|翻倍/);
  assert.equal((h.app.innerHTML.match(/data-discipline="us-exposure-adjustment"/g) || []).length, 1);
  assert.match(h.app.innerHTML, /discipline-number">1万元<\/strong>/);
  assert.doesNotMatch(h.app.innerHTML, /1w元/);
  h.api.lock();
});

test('a pending record that already contains NAV asks for missing information instead of falsely asking for NAV', () => {
  const { h } = sourceTransactionHarness([{ id: 'synthetic-pending-with-nav', type: 'buy', date: '2026-01-01', status: 'pending', sourceStatus: 'processing', amount: 100, nav: 2 }]);
  const card = h.app.innerHTML.match(/<article class="transaction transaction-pending">[\s\S]*?<\/article>/)[0];
  const footer = card.match(/<summary class="transaction-profit-row">[\s\S]*?<\/summary>/)[0];
  assert.match(footer, /表格资料待补全/);
  assert.match(footer, /详细信息/);
  assert.doesNotMatch(footer, /待补净值|transaction-profit-value|transaction-profit-rate/);
  h.api.lock();
});

test('transaction profit amounts and rates share the details summary while auxiliary figures stay below it', () => {
  const { h } = sourceTransactionHarness([{ id: 'synthetic-summary-buy', type: 'buy', date: '2026-01-01', status: 'confirmed', amount: 100, nav: 1, shares: 100, fee: 0 }]);
  const details = h.app.innerHTML.match(/<details class="transaction-detail" data-id="synthetic-summary-buy">[\s\S]*?<\/details>/)[0];
  const summary = details.match(/<summary class="transaction-profit-row">[\s\S]*?<\/summary>/)[0];
  assert.match(summary, /本笔累计盈亏/);
  assert.match(summary, /class="transaction-profit-value num [^"]*"><span class="masked"/);
  assert.match(summary, /class="transaction-profit-rate num positive">\+100\.00%/);
  assert.match(summary, /class="transaction-detail-toggle">详细信息/);
  assert.doesNotMatch(summary, /本笔剩余市值|确认份额|本笔原始成本/);
  assert.match(details.slice(details.indexOf('</summary>')), /本笔剩余市值|本笔原始成本/);
  assert.doesNotMatch(h.app.innerHTML, /data-action="transaction-(?:new|edit|delete)"/);
  h.api.lock();
});

test('sale and cash-dividend profit summaries keep their own realized semantics and a dividend has no fabricated rate', () => {
  const { h } = sourceTransactionHarness([
    { id: 'synthetic-summary-buy', type: 'buy', date: '2026-01-01', status: 'confirmed', amount: 100, nav: 1, shares: 100, fee: 0 },
    { id: 'synthetic-summary-sale', type: 'sell', date: '2026-01-02', status: 'confirmed', amount: 40, nav: 2, shares: 20, fee: 0 },
    { id: 'synthetic-summary-dividend', type: 'dividend', date: '2026-01-03', status: 'confirmed', amount: 5, nav: 2, shares: 0, fee: 0 },
  ]);
  const summaryFor = id => h.app.innerHTML.match(new RegExp(`<details class="transaction-detail" data-id="${id}"><summary[\\s\\S]*?<\\/summary>`))[0];
  assert.match(summaryFor('synthetic-summary-sale'), /本笔已实现盈亏/);
  assert.match(summaryFor('synthetic-summary-sale'), /transaction-profit-rate/);
  assert.match(summaryFor('synthetic-summary-dividend'), /本笔分红收益/);
  assert.doesNotMatch(summaryFor('synthetic-summary-dividend'), /transaction-profit-rate/);
  h.api.lock();
});

test('cancelled records disappear from transaction cards and counts while unverified records remain visible', () => {
  const { h } = sourceTransactionHarness([
    { id: 'synthetic-cancelled', type: 'buy', status: 'cancelled', date: '2026-01-01', amount: 100 },
    { id: 'synthetic-unverified', type: 'buy', status: 'pending', sourceStatus: 'unverified', submittedAt: '2026-01-02T10:00:00', amount: 100 },
  ]);
  const panel = h.app.innerHTML.match(/<details class="panel ledger-panel[\s\S]*$/)[0];
  assert.match(panel, /class="fund-code">1 笔/);
  assert.doesNotMatch(panel, /synthetic-cancelled|已撤单|<option value="excluded"|未记录/);
  assert.match(panel, /data-id="synthetic-unverified"/);
  assert.match(panel, /待核验/);
  h.api.lock();
});

test('chart overlays use current ledger cost and only included buys and sells without account fields', () => {
  const h = harness();
  h.start();
  const transactions = [
    { id: 'buy', date: '2026-01-01', type: 'buy', nav: 2, shares: 50, fee: 1, amount: 101 },
    { id: 'sell', date: '2026-01-02', type: 'sell', nav: 3, shares: 10, fee: 0, amount: 30 },
    { id: 'dividend', date: '2026-01-03', type: 'dividend', nav: 3, shares: 0, fee: 0, amount: 2 },
    { id: 'estimate', date: '2026-01-04', type: 'sip', nav: 4, shares: 5, fee: 0, amount: 20, status: 'estimated' },
    { id: 'pending', type: 'buy', status: 'pending' },
    { id: 'cancelled', type: 'sell', status: 'cancelled' },
  ];
  h.api.state.funds['005698'].transactions = transactions;
  const result = h.api.chartOverlays('005698');
  const { summary } = calculateLedger(transactions);
  assert.equal(result.costNav, summary.principal / summary.shares);
  assert.equal(result.costEstimated, true);
  assert.deepEqual(result.markers.map(row => row.type), ['buy', 'sell', 'buy']);
  assert.deepEqual(result.markers.map(row => row.estimated), [false, false, true]);
  for (const marker of result.markers) assert.deepEqual(Object.keys(marker).sort(), ['date', 'estimated', 'nav', 'type']);
  h.api.state.funds['005698'].mode = 'principal-first';
  assert.notEqual(h.api.chartOverlays('005698').costNav, result.costNav);
});

test('chart cost is absent for empty, invalid, and fully closed holdings', () => {
  const h = harness();
  h.start();
  assert.equal(h.api.chartOverlays('005698').costNav, null);
  h.api.state.funds['005698'].transactions = [
    { date: '2026-01-01', type: 'buy', nav: 2, shares: 5, fee: 0 },
    { date: '2026-01-02', type: 'sell', nav: 3, shares: 5, fee: 0 },
  ];
  assert.equal(h.api.chartOverlays('005698').costNav, null);
  h.api.state.funds['005698'].transactions[1].shares = 10;
  const invalid = h.api.chartOverlays('005698');
  assert.equal(invalid.costNav, null);
  assert.equal(invalid.markers.length, 1);
});

test('trend buttons have a separate lower row and missing intervals are disabled in the UI', () => {
  const h = harness();
  const history = [{ date: '2026-01-01', nav: 1 }, { date: '2026-01-02', nav: 2 }];
  const controls = h.api.navRangeControls('005698', history, resolveNavRange(history));
  assert.ok(controls.indexOf('data-period="recent-decline"') < controls.indexOf('data-period="recent-rise"'));
  assert.ok(controls.indexOf('class="nav-periods nav-trends"') < controls.indexOf('data-period="recent-decline"'));
  assert.ok(controls.indexOf('data-period="recent-rise"') < controls.indexOf('data-period="since-trade"'));
  assert.match(controls, /data-period="recent-decline"[^>]* disabled/);
  assert.doesNotMatch(controls, /data-period="recent-rise"[^>]* disabled/);
  h.start();
  h.api.actionClick({ preventDefault() {}, target: { closest: selector => selector === '[data-action]' ? { disabled: true, dataset: { action: 'nav-period', period: 'recent-decline', fund: '005698' } } : null } });
  assert.deepEqual(h.api.state.navRanges, {});
});

test('since-trade anchors only to the last included buy or sell, excluding pending operations and cash dividends', () => {
  const h = harness();
  h.start();
  h.api.state.funds['005698'].transactions = [
    { date: '2026-01-01', type: 'buy', nav: 2, shares: 10, fee: 0 },
    { date: '2026-01-02', type: 'sell', nav: 3, shares: 2, fee: 0 },
    { date: '2026-01-03', type: 'dividend', nav: 3, shares: 0, fee: 0, amount: 1 },
    { date: '2026-01-04', type: 'buy', status: 'pending' },
    { date: '2026-01-05', type: 'sell', status: 'cancelled' },
  ];
  assert.deepEqual(h.api.navContext('005698'), { tradeDate: '2026-01-02' });
  assert.deepEqual(h.api.navContext('016701'), { tradeDate: null });
  const history = [{ date: '2026-01-01', nav: 2 }, { date: '2026-01-02', nav: 3 }, { date: '2026-01-03', nav: 3 }];
  const range = resolveNavRange(history, { preset: 'since-trade' }, h.api.navContext('005698'));
  assert.equal(range.from, '2026-01-02');
  assert.equal(range.tradeAvailable, true);
  assert.match(h.api.navRangeControls('005698', history, range), /data-period="since-trade"[^>]*aria-pressed="true"\s*>/);
});

test('floating rail positions remain anchored across redraws and earlier NAV history insertion', () => {
  const h = harness();
  const history = Array.from({ length: 20 }, (_, index) => ({ date: new RealDate(Date.UTC(2026, 0, index + 2)).toISOString().slice(0, 10), nav: 1 }));
  const range = resolveNavRange(history, { from: history[12].date, to: history[19].date });
  h.api.navSliderDomain('005698', history, range, { visualDomain: { min: 3.45, max: 19 }, visualValues: { start: 12.23, end: 19 } });
  const controls = h.api.navRangeControls('005698', history, range);
  assert.match(controls, /min="3\.45"/);
  assert.match(controls, /value="12\.23"/);
  const updated = [{ date: '2026-01-01', nav: 1 }, ...history];
  const updatedRange = resolveNavRange(updated, { from: range.from, to: range.to });
  const domain = h.api.navSliderDomain('005698', updated, updatedRange);
  const visual = h.api.navVisualValues('005698', updated, updatedRange, domain);
  assert.ok(Math.abs(domain.min - 4.45) < 1e-9);
  assert.ok(Math.abs(visual.start - 13.23) < 1e-9);
});

test('only the selected four fund routes render while hidden catalogue routes return to the discipline home', () => {
  const h = harness();
  h.start();
  assert.match(h.app.innerHTML, /<h1>交易纪律<\/h1>/);
  assert.equal((h.app.innerHTML.match(/data-discipline=/g) || []).length, DISCIPLINE_ENTRIES.length);
  assert.doesNotMatch(h.app.innerHTML, /class="fund-card /);
  for (const fund of FUNDS) {
    h.location.hash = `#/fund/${fund.code}`;
    h.api.state.nav[fund.code] = { history: [{ date: '2026-01-01', nav: 1 }, { date: '2026-01-02', nav: 1.1 }] };
    h.api.render();
    assert.ok(h.app.innerHTML.includes(`<h1>${fund.name}</h1>`));
    assert.match(h.app.innerHTML, /data-period="since-trade"[^>]*disabled/);
    assert.doesNotMatch(h.app.innerHTML, /class="nav-cost-line"/);
  }
  for (const hiddenCode of ['000216', '009608', '018124', '015789', '019454', '022459', '022429']) {
    h.location.hash = `#/fund/${hiddenCode}`;
    h.api.render();
    assert.match(h.app.innerHTML, /<h1>交易纪律<\/h1>/);
    assert.doesNotMatch(h.app.innerHTML, /class="[^"]*\bnav-panel\b/);
  }
});

test('home shows the latest personal discipline, emphasizes instructions and has no fund overview values', () => {
  const h = harness();
  h.start();
  h.api.state.visible = true;
  h.api.state.funds['005698'].transactions = [
    { date: '2026-01-01', type: 'buy', nav: 2, shares: 50, fee: 0, amount: 100 },
  ];
  h.api.state.nav['005698'] = { history: [{ date: '2026-01-02', nav: 3 }] };
  h.api.render();
  assert.match(h.app.innerHTML, /data-discipline="add-discipline"/);
  assert.match(h.app.innerHTML, /<strong class="discipline-emphasis">少频次，高金额<\/strong>/);
  assert.match(h.app.innerHTML, /<strong class="discipline-emphasis discipline-number">1万元<\/strong>/);
  assert.match(h.app.innerHTML, /加仓金额\/比例<strong class="discipline-emphasis">减半<\/strong>/);
  assert.match(h.app.innerHTML, /卖出金额\/比例<strong class="discipline-emphasis">翻倍<\/strong>/);
  assert.match(h.app.innerHTML, /<strong class="discipline-emphasis discipline-number">40%<\/strong>/);
  assert.match(h.app.innerHTML, /<strong class="discipline-emphasis discipline-number">1\/6～1\/3<\/strong>/);
  assert.match(h.app.innerHTML, /<strong class="discipline-emphasis discipline-number">5万元<\/strong>/);
  assert.match(h.app.innerHTML, /<strong class="discipline-emphasis">立刻<\/strong>/);
  assert.doesNotMatch(h.app.innerHTML, /当前市值|持有收益率|最新净值|当日涨跌幅|累计上涨|累计下跌|10%|15%/);
  assert.doesNotMatch(h.app.innerHTML, /fund-card|card-value|fund-description/);
  const home = h.app.innerHTML.match(/<main[\s\S]*?<\/main>/)[0];
  for (const fund of FUNDS) assert.ok(home.includes(`href="#/fund/${fund.code}"`));
});

test('the long-term rule opens only four fund names and holding times and preserves its disclosure choice', () => {
  const h = harness();
  h.start();
  const longTermRule = () => h.app.innerHTML.match(/<details\b[^>]*data-discipline="long-term"[\s\S]*?<\/details>/)?.[0] || '';
  const rule = longTermRule();
  assert.match(rule, /class="[^"]*\bdiscipline-entry-checkable\b/);
  assert.match(rule, /data-panel="discipline-long-term"/);
  assert.doesNotMatch(rule.slice(0, rule.indexOf('>')), /\sopen(?:\s|$|=)/);
  const summary = rule.match(/<summary\b[\s\S]*?<\/summary>/)?.[0] || '';
  assert.match(summary, /查看持有时间/);
  assert.match(summary, /收起持有时间/);
  const list = rule.match(/<ul\b[^>]*class="[^"]*\bholding-duration-list\b[^"]*"[\s\S]*?<\/ul>/)?.[0] || '';
  assert.equal((list.match(/data-holding-fund=/g) || []).length, 4);
  for (const fund of FUNDS) {
    const row = list.match(new RegExp(`<li\\b[^>]*data-holding-fund="${fund.code}"[\\s\\S]*?<\\/li>`))?.[0] || '';
    assert.equal(row.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), `${fund.name} 暂无记录`);
    assert.doesNotMatch(row, /role="progressbar"|aria-valuenow=|aria-valuemax=/);
  }
  assert.doesNotMatch(list, /\d{4}-\d{2}-\d{2}|%|份额|净值|收益率|金额|成本|当前市值/);

  const panel = { dataset: { panel: 'discipline-long-term' }, open: true, matches: selector => selector === 'details[data-panel]' };
  h.app.contains = candidate => candidate === panel;
  h.documentEvents.get('toggle')({ target: panel });
  h.api.render();
  assert.equal(h.api.state.expandedPanels['discipline-long-term'], true);
  assert.match(longTermRule().slice(0, longTermRule().indexOf('>')), /\sopen(?:\s|$|=)/);
  panel.open = false;
  h.documentEvents.get('toggle')({ target: panel });
  h.api.render();
  assert.equal(h.api.state.expandedPanels['discipline-long-term'], false);
  assert.doesNotMatch(longTermRule().slice(0, longTermRule().indexOf('>')), /\sopen(?:\s|$|=)/);
});

test('home holding times use the current continuous holding period and expose only duration or status', () => {
  const h = harness('2026-01-07T16:00:00.000Z');
  h.start();
  const transaction = (date, type, shares) => ({ date, type, shares, nav: 2, fee: 0 });
  h.api.state.funds['005698'].transactions = [
    transaction('2026-01-01', 'buy', 10),
    transaction('2026-01-05', 'sell', 3),
    transaction('2026-01-06', 'buy', 2),
  ];
  h.api.state.funds['270023'].transactions = [
    transaction('2026-01-01', 'buy', 10),
    transaction('2026-01-06', 'sell', 10),
  ];
  h.api.state.funds['016701'].transactions = [
    transaction('2026-01-01', 'buy', 10),
    transaction('2026-01-06', 'sell', 10),
    transaction('2026-01-07', 'buy', 2),
  ];
  h.api.render();
  const holdingRow = code => h.app.innerHTML.match(new RegExp(`<li\\b[^>]*data-holding-fund="${code}"[\\s\\S]*?<\\/li>`))?.[0] || '';
  const holdingText = code => holdingRow(code).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.match(holdingText('005698'), /已持有\s*7\s*天/);
  assert.match(holdingText('270023'), /已清仓/);
  assert.match(holdingText('016701'), /已持有\s*1\s*天/);
  assert.match(holdingText('006373'), /暂无记录/);
  const progress = code => {
    const row = holdingRow(code);
    const track = row.match(/<[^>]*role="progressbar"[^>]*>/)?.[0] || '';
    const maximum = Number(/aria-valuemax="([^"]+)"/.exec(track)?.[1]);
    const current = Number(/aria-valuenow="([^"]+)"/.exec(track)?.[1]);
    const width = Number(/class="holding-progress-fill"[^>]*style="width:\s*([\d.]+)%/.exec(row)?.[1]);
    assert.ok(track);
    assert.ok(Number.isFinite(maximum) && maximum >= current);
    assert.match(row, /class="holding-progress-maximum"/);
    assert.match(row.replace(/<[^>]*>/g, ' '), new RegExp(`${maximum}\\s*天`));
    return { current, maximum, width };
  };
  const initialProgress = new Map([['005698', 7], ['016701', 1]].map(([code, days]) => {
    const bar = progress(code);
    assert.equal(bar.current, days, 'progress keeps the real holding days');
    assert.ok(bar.width > 60 && bar.width <= 100);
    assert.ok(Math.abs(bar.width / 100 - days / bar.maximum) < 0.00001);
    return [code, bar];
  }));
  for (const code of ['270023', '006373']) assert.doesNotMatch(holdingRow(code), /role="progressbar"|aria-valuenow=|aria-valuemax=/);
  h.api.render();
  for (const [code, bar] of initialProgress) assert.deepEqual(progress(code), bar, 'redrawing does not change the random display scale');

  h.api.state.funds['006373'].transactions = [transaction('2026-01-08', 'buy', 2)];
  h.api.render();
  assert.match(holdingText('006373'), /已持有\s*0\s*天/);
  assert.deepEqual(progress('006373'), { current: 0, maximum: 1, width: 0 });
  h.api.state.funds['005698'].incomplete = true;
  h.api.render();
  assert.match(holdingText('005698'), /约\s*7\s*天/);
  for (const fund of FUNDS) {
    assert.doesNotMatch(holdingText(fund.code), /\d{4}-\d{2}-\d{2}|%|份额|净值|收益率|金额|成本|当前市值/);
  }
});

test('annual discipline alert belongs to the matching fund and disappears only when its public NAV condition clears', () => {
  const h = harness();
  h.start();
  const history = [
    { date: '2024-01-01', nav: 1 },
    { date: '2025-12-31', nav: 1 },
    { date: '2026-01-02', nav: 1 },
    { date: '2026-01-07', nav: 2 },
  ];
  h.api.state.nav['005698'] = { history };
  h.api.render();
  assert.doesNotMatch(h.app.innerHTML, /class="annual-discipline-alert"/);
  h.location.hash = '#/fund/005698';
  h.api.render();
  const alert = h.app.innerHTML.match(/<aside class="annual-discipline-alert"[\s\S]*?<\/aside>/)?.[0];
  assert.ok(alert);
  assert.match(alert, /role="alert"/);
  assert.match(alert, /data-fund="005698"/);
  assert.match(alert, /年初基准 2026-01-02/);
  assert.match(alert, /大幅止盈/);
  assert.doesNotMatch(alert, /button|data-action|关闭/);
  h.api.state.navPreset = 'one-month';
  h.api.render();
  assert.match(h.app.innerHTML, /class="annual-discipline-alert"/);
  h.location.hash = '#/fund/270023';
  h.api.render();
  assert.doesNotMatch(h.app.innerHTML, /class="annual-discipline-alert"/);
  h.location.hash = '#/fund/005698';
  h.api.state.nav['005698'].history = history.map((point, index) => index === history.length - 1 ? { ...point, nav: 1.1 } : point);
  h.api.render();
  assert.doesNotMatch(h.app.innerHTML, /data-rule="(?:annual-profit|add-discipline-decline)/);
  assert.match(h.app.innerHTML, /美股含量未达标/);
});

test('each fund basic information section retains its dated public region distribution before the NAV section', () => {
  const h = harness();
  h.start();
  for (const fund of FUNDS) {
    h.location.hash = `#/fund/${fund.code}`;
    h.api.render();
    const regions = h.app.innerHTML.match(/<details\b(?=[^>]*class="[^"]*\bfund-regions\b)[^>]*>[\s\S]*?<\/details>/)?.[0];
    assert.ok(regions);
    assert.match(regions, /aria-label="基金基本信息"/);
    assert.match(regions, /<h2>基金基本信息<\/h2>/);
    assert.doesNotMatch(regions, /<h2>股票地区分布<\/h2>/);
    assert.match(regions, /data-nav-annualized/);
    assert.doesNotMatch(h.api.navPanel(fund), /data-nav-annualized|class="nav-annualized"/);
    const data = REGION_DATA[fund.code];
    assert.ok(regions.includes(`datetime="${data.asOf}"`));
    assert.ok(regions.includes(data.source.url));
    assert.match(regions, /占基金净资产/);
    for (const region of data.regions) {
      assert.ok(regions.includes(region.name));
      assert.ok(regions.includes(`${region.percent.toFixed(2)}%`));
    }
    assert.ok(h.app.innerHTML.indexOf('class="panel fund-regions') < h.app.innerHTML.indexOf('class="panel nav-panel'));
    assert.doesNotMatch(regions, /当前市值|持有份额|个人|账户金额/);
  }
});

test('the home exposure rule opens only dated below-threshold checks and retains its disclosure choice across redraws', () => {
  const h = harness();
  h.start();
  const exposureRule = () => h.app.innerHTML.match(/<details\b[^>]*data-discipline="us-exposure"[\s\S]*?<\/details>/)?.[0] || '';
  const rule = exposureRule();
  assert.match(rule, /class="[^"]*\bdiscipline-entry-checkable\b/);
  assert.match(rule, /data-panel="discipline-us-exposure"/);
  assert.match(rule, /data-exposure-status="below"/);
  assert.doesNotMatch(rule.slice(0, rule.indexOf('>')), /\sopen(?:\s|$|=)/);
  assert.match(rule.match(/<summary\b[\s\S]*?<\/summary>/)?.[0] || '', /未完全遵守/);
  assert.equal((rule.match(/data-exposure-fund=/g) || []).length, 1);
  for (const fund of FUNDS) {
    const row = rule.match(new RegExp(`<li\\b[^>]*data-exposure-fund="${fund.code}"[\\s\\S]*?<\\/li>`))?.[0] || '';
    if (fund.code !== '005698') {
      assert.equal(row, '', 'funds meeting the threshold are omitted from the reason list');
      continue;
    }
    const report = REGION_DATA[fund.code];
    assert.ok(row.includes(fund.name));
    assert.ok(row.includes(`href="#/fund/${fund.code}?section=us-exposure"`));
    assert.ok(row.includes(`${report.regions.find(region => region.name === '美国').percent.toFixed(2)}%`));
    assert.ok(row.includes(`datetime="${report.asOf}"`));
    assert.ok(row.includes(report.publishedAt));
    assert.ok(row.includes(report.source.url));
    assert.match(row, /原报告/);
    assert.match(row, /exposure-check-below/);
  }
  assert.match(rule, /23\.34/);
  assert.doesNotMatch(rule, /exposure-overview|exposure-method|exposure-check-met|exposure-check-unavailable/);
  assert.doesNotMatch(rule, /已降低个人持仓|已经减仓|当前市值|持有份额|账户金额/);

  const panel = { dataset: { panel: 'discipline-us-exposure' }, open: true, matches: selector => selector === 'details[data-panel]' };
  h.app.contains = candidate => candidate === panel;
  h.documentEvents.get('toggle')({ target: panel });
  assert.equal(h.api.state.expandedPanels['discipline-us-exposure'], true);
  h.api.render();
  assert.match(exposureRule().slice(0, exposureRule().indexOf('>')), /\sopen(?:\s|$|=)/);
  panel.open = false;
  h.documentEvents.get('toggle')({ target: panel });
  h.api.render();
  assert.equal(h.api.state.expandedPanels['discipline-us-exposure'], false);
  assert.doesNotMatch(exposureRule().slice(0, exposureRule().indexOf('>')), /\sopen(?:\s|$|=)/);
});

test('exposure reason routes locate each fund US row once and return to the expanded home rule', () => {
  const h = harness();
  const calls = [];
  const querySelector = h.document.querySelector.bind(h.document);
  h.document.querySelector = selector => {
    if (/^#fund-\d{6}-us-exposure$/.test(selector) || selector === '[data-discipline="us-exposure"] > summary') return {
      focus(settings) { calls.push({ method: 'focus', selector, settings }); },
      scrollIntoView(settings) { calls.push({ method: 'scrollIntoView', selector, settings }); },
    };
    return querySelector(selector);
  };
  h.start();
  for (const fund of FUNDS) {
    h.location.hash = `#/fund/${fund.code}?section=us-exposure`;
    const previousCalls = calls.length;
    h.windowEvents.get('hashchange')();
    assert.ok(h.app.innerHTML.includes(`<h1>${fund.name}</h1>`));
    assert.doesNotMatch(h.app.innerHTML, /<h1>交易纪律<\/h1>/);
    const row = h.app.innerHTML.match(new RegExp(`<li\\b[^>]*id="fund-${fund.code}-us-exposure"[^>]*>`))?.[0] || '';
    assert.match(row, /tabindex="-1"/);
    assert.match(row, /exposure-location/);
    assert.deepEqual(calls.slice(previousCalls), [
      { method: 'focus', selector: `#fund-${fund.code}-us-exposure`, settings: { preventScroll: true } },
      { method: 'scrollIntoView', selector: `#fund-${fund.code}-us-exposure`, settings: { block: 'center', behavior: 'instant' } },
    ]);
    h.api.render();
    assert.equal(calls.length, previousCalls + 2, 'an ordinary redraw does not relocate the current route');
  }
  assert.deepEqual(h.scrollCalls, [], 'exposure navigation does not override its target with a top scroll');

  h.location.hash = '#/?section=us-exposure';
  h.windowEvents.get('hashchange')();
  const homeOpeningTag = () => h.app.innerHTML.match(/<details\b[^>]*data-discipline="us-exposure"[^>]*>/)?.[0] || '';
  assert.match(homeOpeningTag(), /\sopen(?:\s|$|=|>)/);
  assert.deepEqual(calls.at(-2), { method: 'focus', selector: '[data-discipline="us-exposure"] > summary', settings: { preventScroll: true } });
  assert.deepEqual(calls.at(-1), { method: 'scrollIntoView', selector: '[data-discipline="us-exposure"] > summary', settings: { block: 'center', behavior: 'instant' } });
  const panel = { dataset: { panel: 'discipline-us-exposure' }, open: false, matches: selector => selector === 'details[data-panel]' };
  h.app.contains = candidate => candidate === panel;
  h.documentEvents.get('toggle')({ target: panel });
  const previousCalls = calls.length;
  h.api.render();
  assert.doesNotMatch(homeOpeningTag(), /\sopen(?:\s|$|=|>)/);
  assert.equal(calls.length, previousCalls, 'a redraw respects the user closing the reason');

  h.api.lock();
  h.start();
  assert.match(homeOpeningTag(), /\sopen(?:\s|$|=|>)/);
  assert.equal(calls.length, previousCalls + 2, 'unlocking locates the retained route again');
  h.location.hash = '#/fund/005698';
  h.windowEvents.get('hashchange')();
  assert.deepEqual(h.scrollCalls, [{ top: 0, behavior: 'instant' }]);
  h.location.hash = '#/fund/005698?section=us-exposure';
  h.windowEvents.get('hashchange')();
  assert.ok(h.app.innerHTML.includes(`<h1>${FUNDS.find(fund => fund.code === '005698').name}</h1>`));
  assert.equal(calls.length, previousCalls + 4, 'returning to a reason link relocates its fund');
});

test('only the fund below the public US threshold is highlighted in both navigation and its fund page without transactions', () => {
  const h = harness();
  h.start();
  assert.deepEqual(h.api.state.funds['005698'].transactions, []);
  for (const fund of FUNDS) {
    h.location.hash = `#/fund/${fund.code}`;
    h.api.render();
    for (const className of ['desktop-nav', 'bottom-nav']) {
      const nav = h.app.innerHTML.match(new RegExp(`<nav class="${className}"[\\s\\S]*?<\\/nav>`))?.[0] || '';
      for (const entry of FUNDS) {
        const link = nav.match(new RegExp(`<a\\b[^>]*href="#/fund/${entry.code}"[^>]*>`))?.[0] || '';
        assert.ok(link);
        if (entry.code === '005698') {
          assert.match(link, /exposure-nav-warning/);
          assert.match(link, /(?:title|aria-label)="[^"]*美股含量未达标/);
        } else assert.doesNotMatch(link, /exposure-nav-warning|美股含量未达标/);
      }
    }
    const page = h.app.innerHTML.match(/<main\b[\s\S]*?<\/main>/)?.[0] || '';
    if (fund.code === '005698') {
      assert.match(page, /class="status-chip exposure-warning"[\s\S]*?美股含量未达标/);
      assert.match(page, /class="[^"]*\bfund-regions\b[^"]*\bexposure-below\b/);
      assert.match(page, /region-us region-us-below/);
      assert.match(page, /16\.66%/);
      assert.match(page, /规则门槛 40%/);
      assert.match(page, /相差 23\.34 个百分点/);
      assert.match(page, /尚未配置交易数据/);
    } else assert.doesNotMatch(page, /status-chip exposure-warning|exposure-below|region-us-below|美股含量未达标/);
  }
});

test('the add alert uses the last included transaction and shows only the matching add clause', () => {
  const h = harness();
  h.start();
  h.location.hash = '#/fund/005698';
  h.api.state.nav['005698'] = { history: [
    { date: '2010-01-01', nav: 1 }, { date: '2025-12-31', nav: 4 },
    { date: '2026-01-02', nav: 4 }, { date: '2026-01-07', nav: 3 },
  ] };
  h.api.state.funds['005698'].transactions = [
    { date: '2026-01-02', type: 'buy', nav: 4, shares: 10, fee: 0 },
    { date: '2026-01-06', type: 'buy', status: 'pending' },
    { date: '2026-01-07', type: 'sell', status: 'cancelled' },
  ];
  h.api.render();
  const alert = h.app.innerHTML.match(/<aside class="annual-discipline-alert"[\s\S]*?<\/aside>/)?.[0] || '';
  assert.match(alert, /data-rule="add-discipline-decline"/);
  assert.match(alert, /上次交易节点 2026-01-02/);
  assert.match(alert, /上次交易节点后跌幅/);
  assert.match(alert, /进行一次加仓/);
  assert.doesNotMatch(alert, /适当止盈|大幅止盈|button|data-action/);
  h.api.state.funds['005698'].transactions.push({ date: '2026-01-07', type: 'buy', nav: 3, shares: 1, fee: 0 });
  h.api.render();
  assert.doesNotMatch(h.app.innerHTML, /data-rule="add-discipline-decline"/);
  assert.match(h.app.innerHTML, /美股含量未达标/);
});

test('the profit alert displays exactly the matching current subclauses', () => {
  const h = harness();
  h.start();
  h.location.hash = '#/fund/005698';
  const history = (firstDate, firstNav, lastNav) => [
    { date: firstDate, nav: firstNav },
    { date: '2025-12-31', nav: 1 },
    { date: '2026-01-02', nav: 1 },
    { date: '2026-01-07', nav: lastNav },
  ];
  const currentAlert = () => {
    h.api.render();
    return h.app.innerHTML.match(/<aside class="annual-discipline-alert"[\s\S]*?<\/aside>/)?.[0] || '';
  };
  h.api.state.nav['005698'] = { history: history('2020-01-01', 1, 1.5) };
  const moderate = currentAlert();
  assert.match(moderate, /data-rule="annual-profit-multiple"/);
  assert.match(moderate, /适当止盈/);
  assert.doesNotMatch(moderate, /annual-profit-100|大幅止盈|100%/);
  h.api.state.nav['005698'].history = history('2025-01-01', 0.1, 2);
  const absolute = currentAlert();
  assert.match(absolute, /data-rule="annual-profit-100"/);
  assert.match(absolute, /大幅止盈/);
  assert.doesNotMatch(absolute, /annual-profit-multiple|适当止盈/);
  h.api.state.nav['005698'].history = history('2020-01-01', 1, 2);
  const both = currentAlert();
  assert.match(both, /data-rule="annual-profit-100"/);
  assert.match(both, /data-rule="annual-profit-multiple"/);
  assert.doesNotMatch(both, /button|data-action|关闭/);
});

test('triggered fund reminders render as the first fund-page block in normal flow', () => {
  const h = harness();
  h.start();
  h.api.state.nav['005698'] = { history: [
    { date: '2020-01-01', nav: 1 }, { date: '2025-12-31', nav: 1 },
    { date: '2026-01-02', nav: 1 }, { date: '2026-01-07', nav: 2 },
  ] };
  const alertFor = hash => {
    h.location.hash = hash;
    h.api.render();
    return h.app.innerHTML.match(/<aside class="annual-discipline-alert"[\s\S]*?<\/aside>/)?.[0] || '';
  };
  const ordinary = alertFor('#/fund/005698');
  assert.match(ordinary, /class="annual-discipline-alert"/);
  assert.doesNotMatch(ordinary, /exposure-route-alert|add-route-alert|discipline-route-alert/);
  const located = alertFor('#/fund/005698?section=us-exposure');
  assert.equal(located, ordinary, 'route section does not change the reminder markup');
  assert.match(located, /role="alert"/);
  assert.match(located, /美股含量未达标/);
  assert.match(located, /data-rule="annual-profit-100"/);
  assert.match(located, /data-rule="annual-profit-multiple"/);
  assert.equal((located.match(/data-rule=/g) || []).length, 2);
  assert.ok(!fundDisclosure(h, 'nav-quotes').includes(ordinary), 'reminder is outside the panel list');
  assert.ok(h.app.innerHTML.indexOf(ordinary) > h.app.innerHTML.indexOf('<main'), 'reminder stays in normal page flow');
  assert.ok(h.app.innerHTML.indexOf(ordinary) < h.app.innerHTML.indexOf('data-panel="fund-basics"'), 'reminder is the first fund-page block');
});

test('the estimated-record chip names the latest estimated NAV date', () => {
  const h = harness();
  h.start();
  h.api.state.funds['005698'].transactions = [
    { id: 'estimated-older', date: '2026-01-02', type: 'buy', nav: 1, shares: 1, fee: 0, amount: 1, status: 'estimated' },
    { id: 'estimated-newer', date: '2026-01-05', type: 'buy', nav: 1, shares: 1, fee: 0, amount: 1, status: '历史估算' },
  ];
  h.location.hash = '#/fund/005698';
  h.api.render();
  assert.match(h.app.innerHTML, /已估算 2026-01-05 净值/);
  assert.doesNotMatch(h.app.innerHTML, /含估算记录/);
});

test('a newly invalid shared trend stays selected and disabled with an empty chart after refresh', () => {
  const h = harness();
  h.start();
  h.location.hash = '#/fund/005698';
  const history = values => values.map((nav, index) => ({ date: `2026-01-${String(index + 1).padStart(2, '0')}`, nav }));
  h.api.state.nav['005698'] = { history: history([2, 1, 1.8, 1.5, 1.6, 1.4]) };
  h.api.state.navPreset = 'recent-rise';
  h.api.render();
  assert.equal(h.api.state.navPreset, 'recent-rise');
  assert.match(h.app.innerHTML, /data-period="recent-rise"[^>]*aria-pressed="true"[^>]*disabled/);
  assert.match(h.app.innerHTML, /data-period="recent-decline"[^>]*aria-pressed="false"/);
  assert.match(h.app.innerHTML, /暂无上涨区间/);
  assert.match(h.app.innerHTML, /data-nav-count>0 期/);
  assert.match(h.app.innerHTML, /data-nav-boundary="start"[^>]*disabled/);
  h.api.state.nav['005698'].history = history([1, 2, 1.3, 1.5, 1.4, 1.6]);
  h.api.state.navPreset = 'recent-decline';
  h.api.render();
  assert.equal(h.api.state.navPreset, 'recent-decline');
  assert.match(h.app.innerHTML, /data-period="recent-decline"[^>]*aria-pressed="true"[^>]*disabled/);
  assert.match(h.app.innerHTML, /data-period="recent-rise"[^>]*aria-pressed="false"/);
  assert.match(h.app.innerHTML, /暂无下跌区间/);
  assert.match(h.app.innerHTML, /data-nav-count>0 期/);
});

test('recent date controls use an adaptive visible domain while retaining actual selected dates', () => {
  const h = harness();
  const history = Array.from({ length: 200 }, (_, index) => ({ date: new RealDate(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10), nav: 1 + index / 1000 }));
  const range = resolveNavRange(history, { preset: '1m' });
  const controls = h.api.navRangeControls('005698', history, range);
  const start = /data-nav-boundary="start"[^>]*min="(\d+)"[^>]*max="(\d+)"[^>]*value="(\d+)"/.exec(controls);
  assert.ok(start);
  assert.ok(Number(start[1]) > 0, 'Recent dates should not share a track with the full older history.');
  assert.equal(Number(start[2]), history.length - 1);
  assert.equal(Number(start[3]), range.start);
  assert.match(controls, new RegExp(`data-nav-start>${range.from}<`));
  assert.deepEqual(h.api.state.navDomains['005698'], { from: history[Number(start[1])].date, to: history.at(-1).date });
});

test('public NAV annualization uses the full loaded history independently of selected and unavailable ranges', () => {
  const h = harness();
  h.start();
  h.location.hash = '#/fund/005698';
  h.api.state.nav['005698'] = { history: [
    { date: '2024-01-01', nav: 1 },
    { date: '2025-01-01', nav: Math.pow(1.12, 366 / 365.2425) },
    { date: '2026-01-01', nav: Math.pow(1.12, 731 / 365.2425) },
  ] };
  for (const preset of ['1m', 'all', 'since-trade', 'recent-decline']) {
    h.api.state.navPreset = preset;
    h.api.render();
    assert.match(h.app.innerHTML, /data-nav-annualized>\+12\.00%</);
    assert.match(h.app.innerHTML, /title="按全部已载入正式净值计算复合年化；不含昨日估值，未计现金分红再投资"/);
    const information = h.api.fundRegions(FUNDS.find(fund => fund.code === '005698'));
    assert.match(information, /data-nav-annualized>\+12\.00%</);
    assert.doesNotMatch(h.api.navPanel(FUNDS.find(fund => fund.code === '005698')), /data-nav-annualized|class="nav-annualized"/);
    assert.equal((h.app.innerHTML.match(/data-nav-annualized/g) || []).length, 1);
  }
  assert.match(h.app.innerHTML, /暂无下跌区间/);
  h.api.state.nav['005698'].history.at(-1).nav = 1;
  h.api.render();
  assert.match(h.app.innerHTML, /data-nav-annualized>0\.00%</);
});

test('public NAV annualization displays a dash for less than a full year of history', () => {
  const h = harness();
  h.start();
  h.location.hash = '#/fund/005698';
  h.api.state.nav['005698'] = { history: [{ date: '2026-01-01', nav: 1 }, { date: '2026-01-06', nav: 1.1 }] };
  h.api.render();
  const fund = FUNDS.find(entry => entry.code === '005698');
  assert.match(h.api.fundRegions(fund), /<span>平均年化<\/span><strong[^>]*data-nav-annualized>—</);
  assert.doesNotMatch(h.api.navPanel(fund), /data-nav-annualized|class="nav-annualized"/);
});

function installRangePanel(h) {
  const fields = new Map();
  const field = selector => {
    if (!fields.has(selector)) fields.set(selector, { textContent: '', innerHTML: '', setAttribute() {} });
    return fields.get(selector);
  };
  const inputs = ['start', 'end'].map(boundary => ({ dataset: { navBoundary: boundary }, setAttribute() {} }));
  const slider = { dataset: {}, style: { setProperty() {} }, querySelectorAll: () => inputs };
  const buttons = [
    { cycle: 'months', period: '1m' }, { period: 'last-month' }, { cycle: 'years', period: '1y' }, { period: 'all' },
    ...NAV_PERIODS.filter(period => period.id.startsWith('recent-') || period.id === 'since-trade').map(period => ({ period: period.id })),
  ].map(dataset => ({ dataset, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }));
  const panel = {
    querySelector: selector => selector === '.nav-range-slider' ? slider : field(selector),
    querySelectorAll: selector => selector === '[data-cycle]' ? buttons.filter(button => button.dataset.cycle) : buttons,
  };
  h.app.querySelector = selector => selector.startsWith('.nav-panel[data-fund=') ? panel : null;
  return { fields, inputs, buttons };
}

function sharedRangeHarness() {
  const h = harness();
  h.start();
  const rows = Array.from({ length: 6 }, (_, index) => ({ date: `2026-01-0${index + 1}`, nav: 1 + index / 100 }));
  for (const [code, date] of [['005698', '2026-01-02'], ['270023', '2026-01-04']]) {
    h.api.state.nav[code] = { history: rows.map(point => ({ ...point })) };
    h.api.state.funds[code] = { mode: 'profit-first', rate: null, transactions: [{ id: `synthetic-${code}`, date, type: 'buy', nav: 1, shares: 1, fee: 0, status: 'confirmed' }] };
  }
  h.location.hash = '#/fund/005698';
  h.api.render();
  installRangePanel(h);
  return h;
}

test('range buttons share their preset across funds while each fund resolves its own transaction date', () => {
  const h = sharedRangeHarness();
  const deadline = h.api.state.deadline;
  h.click('nav-period', { fund: '005698', period: 'since-trade' });
  assert.equal(h.api.state.navPreset, 'since-trade');
  h.api.render();
  assert.match(h.app.innerHTML, /data-nav-start>2026-01-02</);
  h.location.hash = '#/fund/270023';
  h.windowEvents.get('hashchange')();
  assert.match(h.app.innerHTML, /data-period="since-trade"[^>]*aria-pressed="true"\s*>/);
  assert.match(h.app.innerHTML, /data-nav-start>2026-01-04</);
  assert.equal(h.api.state.navPreset, 'since-trade');
  assert.equal(h.api.state.deadline, deadline);
});

test('a shared unavailable transaction range stays selected until the user chooses another available button', () => {
  const h = sharedRangeHarness();
  h.click('nav-period', { fund: '005698', period: 'since-trade' });
  h.api.state.funds['270023'].transactions = [];
  h.location.hash = '#/fund/270023';
  h.windowEvents.get('hashchange')();
  assert.equal(h.api.state.navPreset, 'since-trade');
  assert.match(h.app.innerHTML, /data-period="since-trade"[^>]*aria-pressed="true"[^>]*disabled/);
  assert.match(h.app.innerHTML, /暂无交易区间/);
  assert.match(h.app.innerHTML, /data-nav-count>0 期/);
  h.click('nav-period', { fund: '270023', period: 'since-trade' });
  assert.equal(h.api.state.navPreset, 'since-trade');
  h.click('nav-period', { fund: '270023', period: '1m' });
  assert.equal(h.api.state.navPreset, '1m');
  h.location.hash = '#/fund/005698';
  h.windowEvents.get('hashchange')();
  assert.match(h.app.innerHTML, /data-period="1m"[^>]*aria-pressed="true"/);
  assert.match(h.app.innerHTML, /data-nav-start>2026-01-01</);
});

test('a shared trend does not silently change when the target fund has the opposite available trend', () => {
  const h = sharedRangeHarness();
  h.api.state.nav['005698'].history = [2, 1.8, 1.6].map((nav, index) => ({ date: `2026-01-0${index + 1}`, nav }));
  h.click('nav-period', { fund: '005698', period: 'recent-decline' });
  h.location.hash = '#/fund/270023';
  h.windowEvents.get('hashchange')();
  assert.equal(h.api.state.navPreset, 'recent-decline');
  assert.match(h.app.innerHTML, /data-period="recent-decline"[^>]*aria-pressed="true"[^>]*disabled/);
  assert.match(h.app.innerHTML, /暂无下跌区间/);
  h.click('nav-period', { fund: '270023', period: 'recent-decline' });
  assert.equal(h.api.state.navPreset, 'recent-decline');
  h.click('nav-period', { fund: '270023', period: 'recent-rise' });
  h.location.hash = '#/fund/005698';
  h.windowEvents.get('hashchange')();
  assert.equal(h.api.state.navPreset, 'recent-rise');
  assert.match(h.app.innerHTML, /data-period="recent-rise"[^>]*aria-pressed="true"[^>]*disabled/);
  assert.match(h.app.innerHTML, /暂无上涨区间/);
});

test('manual dates are shared across funds and a new shared button clears them and slider domains', () => {
  const h = sharedRangeHarness();
  h.click('nav-period', { fund: '005698', period: '3m' });
  h.documentEvents.get('input')({ target: { matches: () => true, dataset: { fund: '005698', navBoundary: 'start' }, value: '4' } });
  assert.deepEqual(h.api.state.navRanges, {});
  assert.deepEqual(h.api.state.navCustomRange, { from: '2026-01-05', to: '2026-01-06' });
  assert.equal(h.api.state.navPreset, '3m');
  h.location.hash = '#/fund/270023';
  h.windowEvents.get('hashchange')();
  assert.match(h.app.innerHTML, /data-nav-start>2026-01-05</);
  assert.match(h.app.innerHTML, /data-nav-end>2026-01-06</);
  h.click('nav-period', { fund: '270023', period: '1m' });
  assert.deepEqual(h.api.state.navRanges, {});
  assert.equal(h.api.state.navCustomRange, null);
  assert.equal(h.api.state.navDomains['005698'], undefined);
  assert.equal(h.api.state.navVisuals['005698'], undefined);
  h.location.hash = '#/fund/005698';
  h.windowEvents.get('hashchange')();
  assert.match(h.app.innerHTML, /data-period="1m"[^>]*aria-pressed="true"/);
  assert.match(h.app.innerHTML, /data-nav-start>2026-01-01</);
});

test('ordinary range controls have exactly four buttons with independent initial month and year cursors', () => {
  const h = harness();
  const history = [{ date: '2026-01-01', nav: 1 }, { date: '2026-01-02', nav: 2 }];
  const controls = h.api.navRangeControls('005698', history, resolveNavRange(history));
  const row = controls.match(/<div class="nav-periods"[^>]*>[\s\S]*?<\/div>/)?.[0];
  assert.ok(row);
  assert.equal((row.match(/<button /g) || []).length, 4);
  assert.deepEqual(h.api.state.navCycles, { months: '1m', years: '1y' });
  assert.match(row, /data-action="nav-cycle" data-cycle="months" data-period="1m"[^>]*aria-label="最近1个月，点击切换为最近3个月"/);
  assert.match(row, /data-action="nav-cycle" data-cycle="years" data-period="1y"[^>]*aria-label="最近1年，点击切换为最近3年"/);
  assert.ok(row.indexOf('data-cycle="months"') < row.indexOf('data-period="last-month"'));
  assert.ok(row.indexOf('data-period="last-month"') < row.indexOf('data-cycle="years"'));
  assert.ok(row.indexOf('data-cycle="years"') < row.indexOf('data-period="all"'));
  const trends = controls.match(/<div class="nav-periods nav-trends"[^>]*>[\s\S]*?<\/div>/)?.[0];
  assert.equal((trends.match(/<button /g) || []).length, 3);
  assert.ok(trends.indexOf('recent-decline') < trends.indexOf('recent-rise'));
  assert.ok(trends.indexOf('recent-rise') < trends.indexOf('since-trade'));
});

test('each month-cycle click applies the next range and updates its label and next-value hint immediately', () => {
  const h = sharedRangeHarness();
  const panel = installRangePanel(h);
  const button = panel.buttons.find(entry => entry.dataset.cycle === 'months');
  const deadline = h.api.state.deadline;
  for (const [preset, label, next] of [
    ['3m', '最近3个月', '最近6个月'], ['6m', '最近6个月', '最近1个月'], ['1m', '最近1个月', '最近3个月'],
  ]) {
    h.click('nav-cycle', { fund: '005698', cycle: 'months' });
    assert.equal(h.api.state.navPreset, preset);
    assert.equal(h.api.state.navCycles.months, preset);
    assert.equal(button.dataset.period, preset);
    assert.equal(button.textContent, label);
    assert.equal(button.attributes['aria-label'], `${label}，点击切换为${next}`);
    assert.equal(button.attributes['aria-pressed'], 'true');
    assert.equal(h.api.state.navCycles.years, '1y');
    assert.equal(h.api.state.deadline, deadline);
  }
});

test('year and month cursors persist independently across funds and always resolve target-fund dates', () => {
  const h = sharedRangeHarness();
  h.click('nav-cycle', { fund: '005698', cycle: 'months' });
  h.api.state.nav['270023'].history = [
    { date: '2024-12-31', nav: 1 }, { date: '2025-09-30', nav: 1.2 }, { date: '2025-12-31', nav: 1.3 },
  ];
  h.location.hash = '#/fund/270023';
  h.windowEvents.get('hashchange')();
  assert.match(h.app.innerHTML, /data-cycle="months" data-period="3m"[^>]*aria-pressed="true"/);
  assert.match(h.app.innerHTML, /data-nav-end>2025-12-31</);
  h.click('nav-cycle', { fund: '270023', cycle: 'years' });
  assert.equal(h.api.state.navPreset, '3y');
  assert.deepEqual(h.api.state.navCycles, { months: '3m', years: '3y' });
  h.location.hash = '#/fund/005698';
  h.windowEvents.get('hashchange')();
  assert.match(h.app.innerHTML, /data-cycle="years" data-period="3y"[^>]*aria-pressed="true"/);
  assert.match(h.app.innerHTML, /data-nav-end>2026-01-06</);
  h.click('nav-cycle', { fund: '005698', cycle: 'years' });
  assert.equal(h.api.state.navPreset, '1y');
  h.click('nav-cycle', { fund: '005698', cycle: 'months' });
  assert.equal(h.api.state.navPreset, '6m');
  assert.deepEqual(h.api.state.navCycles, { months: '6m', years: '1y' });
  h.api.render();
  assert.match(h.app.innerHTML, /data-cycle="months"[^>]*>最近6个月<\/button>/);
  assert.doesNotMatch(h.app.innerHTML, /最近半年/);
});

test('manual dates preserve both cycle cursors and another preset source synchronizes the matching cursor', () => {
  const h = sharedRangeHarness();
  h.click('nav-period', { fund: '005698', period: '6m' });
  h.click('nav-period', { fund: '005698', period: '3y' });
  h.documentEvents.get('input')({ target: { matches: () => true, dataset: { fund: '005698', navBoundary: 'start' }, value: '4' } });
  assert.deepEqual(h.api.state.navCycles, { months: '6m', years: '3y' });
  assert.deepEqual(h.api.state.navCustomRange, { from: '2026-01-05', to: '2026-01-06' });
  assert.deepEqual(h.api.state.navRanges, {});
  h.click('nav-cycle', { fund: '005698', cycle: 'months' });
  assert.equal(h.api.state.navPreset, '1m');
  assert.equal(h.api.state.navCustomRange, null);
  assert.deepEqual(h.api.state.navRanges, {});
  assert.deepEqual(h.api.state.navCycles, { months: '1m', years: '3y' });
  h.api.state.navPreset = '6m';
  h.api.render();
  assert.equal(h.api.state.navCycles.months, '6m');
  h.click('nav-cycle', { fund: '005698', cycle: 'months' });
  assert.equal(h.api.state.navPreset, '1m');
  const before = structuredClone(h.api.state.navCycles);
  h.click('nav-cycle', { fund: '005698', cycle: 'unavailable' });
  assert.deepEqual(h.api.state.navCycles, before);
});

test('MMDD is zero-padded and uses Beijing midnight, including year and leap-day boundaries', () => {
  const cases = [
    ['2026-01-01T00:00:00.000Z', '0101'],
    ['2026-01-08T15:59:59.999Z', '0108'],
    ['2026-01-08T16:00:00.000Z', '0109'],
    ['2026-12-31T15:59:59.999Z', '1231'],
    ['2026-12-31T16:00:00.000Z', '0101'],
    ['2028-02-28T16:00:00.000Z', '0229'],
    ['2028-02-29T16:00:00.000Z', '0301'],
  ];
  for (const [date, expected] of cases) assert.equal(getDailyCode(new RealDate(date)), expected);
});

test('session stays unlocked beyond three minutes and expires at Beijing midnight exactly', () => {
  const h = harness();
  h.start();
  const midnight = RealDate.parse('2026-01-08T16:00:00.000Z');
  assert.equal(h.api.state.deadline, midnight);
  assert.equal(h.api.state.dayDeadline, midnight);
  assert.equal(h.api.remainingTime(), '14:00:00');
  h.clock.tick(180000);
  assert.equal(h.api.state.unlocked, true);
  assert.equal(h.api.remainingTime(), '13:57:00');
  h.clock.advanceWithoutCallbacks(midnight - h.clock.now - 1);
  assert.equal(h.api.checkSession(), true);
  assert.equal(h.api.remainingTime(), '00:00:01');
  h.clock.tick(1);
  assertLocked(h);
  assert.equal(h.api.remainingTime(), '00:00:00');
  assert.equal(h.clock.timers.size, 0);
});

test('Beijing day deadlines handle midnight, year rollover and leap day without using the host timezone', () => {
  for (const [start, expected] of [
    ['2026-01-08T15:59:59.500Z', '2026-01-08T16:00:00.000Z'],
    ['2026-01-08T16:00:00.000Z', '2026-01-09T16:00:00.000Z'],
    ['2026-12-31T15:59:59.999Z', '2026-12-31T16:00:00.000Z'],
    ['2026-12-31T16:00:00.000Z', '2027-01-01T16:00:00.000Z'],
    ['2028-02-28T16:00:00.000Z', '2028-02-29T16:00:00.000Z'],
  ]) {
    const h = harness(start);
    h.start();
    const deadline = RealDate.parse(expected);
    assert.equal(h.api.state.deadline, deadline);
    assert.equal(h.api.state.dayDeadline, deadline);
    assert.equal(h.clock.timers.get(h.api.handles().sessionTimeout).at, deadline);
    assert.ok(deadline > h.clock.now && deadline - h.clock.now <= 86400000);
  }
});

test('clicks, filtering, navigation, and theme changes never extend the deadline', () => {
  const h = harness();
  h.start();
  const deadline = h.api.state.deadline;
  h.clock.tick(60000);
  for (const action of ['privacy', 'more', 'theme', 'reset-filter']) h.click(action);
  h.documentEvents.get('change')({ target: { id: 'type-filter', value: 'buy' } });
  h.location.hash = '#/fund/016701';
  h.windowEvents.get('hashchange')();
  assert.equal(h.api.state.deadline, deadline);
  h.clock.tick(120000);
  assert.equal(h.api.state.unlocked, true);
  assert.equal(h.api.state.deadline, deadline);
  h.clock.advanceWithoutCallbacks(deadline - h.clock.now);
  h.click('privacy');
  assertLocked(h);
});

for (const event of ['focus', 'visibilitychange']) test(`background recovery through ${event} checks elapsed wall time before displaying data`, () => {
  const h = harness();
  h.start();
  h.clock.advanceWithoutCallbacks(h.api.state.deadline - h.clock.now + 1);
  (event === 'focus' ? h.windowEvents : h.documentEvents).get(event)();
  assertLocked(h);
});

test('a click at the deadline cannot reveal data while background timers are delayed', () => {
  const h = harness();
  h.start();
  h.clock.advanceWithoutCallbacks(h.api.state.deadline - h.clock.now);
  h.click('privacy');
  assertLocked(h);
});

test('a session crossing Beijing midnight locks at that boundary even between interval ticks', () => {
  const h = harness('2026-01-08T15:59:59.500Z');
  h.start();
  h.clock.tick(499);
  assert.equal(h.api.state.unlocked, true);
  h.clock.tick(1);
  assertLocked(h);
});

test('returning after midnight rejects the prior day while background timers remain delayed', () => {
  const h = harness('2026-01-08T15:59:59.500Z');
  h.start();
  h.clock.advanceWithoutCallbacks(500);
  h.documentEvents.get('visibilitychange')();
  assertLocked(h);
});

test('the Beijing day boundary remains a hard cap even if another action changes the session deadline', () => {
  const h = harness('2026-01-08T15:59:59.500Z');
  h.start();
  h.api.state.deadline += 86400000;
  h.clock.advanceWithoutCallbacks(500);
  assert.equal(h.api.checkSession(), false);
  assertLocked(h);
});

test('the daily reader rejects a changed calendar day even when the clock moves before the saved deadline', () => {
  const h = harness();
  h.start();
  h.clock.advanceWithoutCallbacks(-86400000);
  assert.equal(h.api.checkSession(), false);
  assertLocked(h);
});

test('manual and bfcache locks clear timers and skip any old visible transition snapshot', () => {
  const h = harness(undefined, { transition: true });
  h.start();
  h.click('privacy');
  h.click('theme');
  h.api.lock();
  assertLocked(h);
  assert.equal(h.transitionSkips, 1);
  h.start();
  h.windowEvents.get('pageshow')({ persisted: true });
  assertLocked(h);
});

test('a completed revalidation starts a new session without leaving an old timer', () => {
  const h = harness();
  h.start();
  const deadline = h.api.state.deadline;
  h.clock.tick(1000);
  h.api.lock();
  h.start();
  assert.equal(h.clock.timers.size, 2);
  assert.equal(h.api.state.deadline, deadline);
  assert.equal(h.api.state.deadline, h.api.state.dayDeadline);
  h.clock.advanceWithoutCallbacks(deadline - h.clock.now - 1);
  assert.equal(h.api.checkSession(), true);
  assert.equal(h.api.state.unlocked, true);
  h.clock.tick(1);
  assertLocked(h);
});

test('a successful synthetic unlock starts a live session', async () => {
  const h = harness();
  await h.submit();
  assert.equal(h.api.state.unlocked, true);
  assert.equal(h.api.state.deadline, RealDate.parse('2026-01-08T16:00:00.000Z'));
  assert.equal(h.api.state.deadline, h.api.state.dayDeadline);
});

test('revalidation on the following Beijing day grants only that new day', async () => {
  const h = harness('2026-12-31T15:59:59.500Z');
  await h.submit();
  h.clock.advanceWithoutCallbacks(500);
  assert.equal(h.api.checkSession(), false);
  assertLocked(h);
  await h.submit();
  assert.equal(h.api.state.unlocked, true);
  assert.equal(h.api.state.sessionDay, '0101');
  assert.equal(h.api.state.deadline, RealDate.parse('2027-01-01T16:00:00.000Z'));
  assert.equal(h.api.remainingTime(), '24:00:00');
});

test('a new page still requires validation while another page has a same-day unlocked session', async () => {
  const h = harness();
  await h.submit();
  assert.equal(h.api.state.unlocked, true);
  const fresh = harness(new RealDate(h.clock.now).toISOString());
  assertLocked(fresh);
  assert.equal(fresh.clock.timers.size, 0);
});

test('an unlock invalidated by locking cannot later reopen the account from a stale async result', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness(undefined, { loadVault: async () => ({ getDailyCode: () => h.day(), unlockVault: () => pending }) });
  const unlocking = h.submit();
  await flushMicrotasks();
  h.api.lock();
  release({ funds: {} });
  await unlocking;
  assertLocked(h);
});

test('a stale unlock completion cannot replace or extend a newer validated session', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let attempts = 0;
  const h = harness(undefined, { loadVault: async () => ({
    getDailyCode: () => h.day(),
    unlockVault: () => ++attempts === 1 ? pending : Promise.resolve({ funds: {}, createdAt: 'synthetic-new-session' }),
  }) });
  const oldUnlock = h.submit();
  await flushMicrotasks();
  h.api.lock();
  await h.submit();
  assert.equal(h.api.state.unlocked, true);
  const deadline = h.api.state.deadline;
  h.clock.tick(1000);
  release({ funds: {}, createdAt: 'synthetic-old-session' });
  await oldUnlock;
  assert.equal(h.api.state.unlocked, true);
  assert.equal(h.api.state.createdAt, 'synthetic-new-session');
  assert.equal(h.api.state.deadline, deadline);
});

test('a stale unlock rejection cannot close a newer validated session', async () => {
  let rejectOld;
  const pending = new Promise((resolve, reject) => { rejectOld = reject; });
  let attempts = 0;
  const h = harness(undefined, { loadVault: async () => ({
    getDailyCode: () => h.day(),
    unlockVault: () => ++attempts === 1 ? pending : Promise.resolve({ funds: {}, createdAt: 'synthetic-current-session' }),
  }) });
  const oldUnlock = h.submit();
  await flushMicrotasks();
  h.api.lock();
  await h.submit();
  const deadline = h.api.state.deadline;
  rejectOld(new Error('synthetic obsolete request failure'));
  await oldUnlock;
  assert.equal(h.api.state.unlocked, true);
  assert.equal(h.api.state.createdAt, 'synthetic-current-session');
  assert.equal(h.api.state.deadline, deadline);
});

test('unlock completing across midnight fails instead of starting a session on the old day', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness('2026-01-08T15:59:59.500Z', { loadVault: async () => ({ getDailyCode: () => h.day(), unlockVault: () => pending }) });
  const unlocking = h.submit();
  await flushMicrotasks();
  h.clock.advanceWithoutCallbacks(500);
  release({ funds: {} });
  await unlocking;
  assertLocked(h);
});

const SYNTHETIC_CODES = FUND_CODES;

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

function syntheticVault(label) {
  return {
    createdAt: label,
    funds: Object.fromEntries(SYNTHETIC_CODES.map(code => [code, {
      transactions: [{ id: `${label}-${code}`, type: 'buy', status: 'confirmed', date: '2026-01-01', nav: 2, shares: 1, fee: 0 }],
      mode: 'profit-first', incomplete: false, sourceNote: label,
    }])),
  };
}

function syntheticQuote(code, label) {
  return { code, tag: label, history: [{ date: '2026-01-02', nav: 2 }] };
}

function refreshingHarness() {
  let label = 'synthetic-a';
  let currentVault = syntheticVault(label);
  let refreshReader = async () => currentVault;
  let quoteReader = async code => syntheticQuote(code, label);
  let versionReader = async () => ({ revision: label });
  const sessions = [];
  let h;
  h = harness(undefined, {
    fetch: async url => ({
      ok: true,
      json: async () => {
        if (url === './data/version.json') return versionReader();
        const code = /\/nav\/([0-9]{6})\.json$/.exec(url)?.[1];
        assert.ok(SYNTHETIC_CODES.includes(code), 'requests use synthetic fund responses');
        return quoteReader(code);
      },
    }),
    loadVault: async () => ({
      getDailyCode: () => h.day(),
      unlockVault: async (_password, { onSession }) => {
        const session = {
          closed: false,
          refreshCalls: 0,
          async refresh() { this.refreshCalls += 1; return refreshReader(); },
          close() { this.closed = true; },
        };
        sessions.push(session);
        onSession(session);
        return currentVault;
      },
    }),
  });
  return { h, sessions,
    setSnapshot(next) { label = next; currentVault = syntheticVault(next); },
    setRefreshReader(reader) { refreshReader = reader; },
    resetRefreshReader() { refreshReader = async () => currentVault; },
    setQuoteReader(reader) { quoteReader = reader; },
    setVersionReader(reader) { versionReader = reader; },
    resetVersionReader() { versionReader = async () => ({ revision: label }); },
  };
}

function assertSyntheticSnapshot(h, label) {
  assert.equal(h.api.state.createdAt, label);
  for (const code of SYNTHETIC_CODES) {
    assert.equal(h.api.state.funds[code].transactions[0].id, `${label}-${code}`);
    assert.equal(h.api.state.nav[code].tag, label);
  }
}

test('a data refresh applies transactions and NAV together while preserving UI choices and the original deadline', async () => {
  const fixture = refreshingHarness();
  const { h } = fixture;
  await h.submit();
  await flushMicrotasks();
  await h.api.dataRefresh.check();
  assertSyntheticSnapshot(h, 'synthetic-a');
  h.location.hash = '#/fund/005698';
  const state = h.api.state;
  state.funds['005698'].mode = 'principal-first';
  state.filter = 'buy';
  state.statusFilter = 'confirmed';
  state.limit = 75;
  state.visible = true;
  state.expandedPanels = { holdings: true, transactions: true };
  const deadline = state.deadline;
  const dayDeadline = state.dayDeadline;
  h.clock.advanceWithoutCallbacks(12000);
  fixture.setSnapshot('synthetic-b');
  await h.api.dataRefresh.check();
  assertSyntheticSnapshot(h, 'synthetic-b');
  assert.equal(fixture.sessions[0].refreshCalls, 1);
  assert.equal(state.funds['005698'].mode, 'principal-first');
  assert.equal(state.filter, 'buy');
  assert.equal(state.statusFilter, 'confirmed');
  assert.equal(state.limit, 75);
  assert.equal(state.visible, true);
  assert.deepEqual(state.expandedPanels, { holdings: true, transactions: true });
  assert.equal(state.deadline, deadline);
  assert.equal(state.dayDeadline, dayDeadline);
});

test('a refresh from a closed session cannot refill data after a new unlock', async () => {
  const fixture = refreshingHarness();
  const { h } = fixture;
  await h.submit();
  await flushMicrotasks();
  await h.api.dataRefresh.check();
  const oldRefresh = deferred();
  fixture.setSnapshot('synthetic-old-update');
  fixture.setRefreshReader(() => oldRefresh.promise);
  const checking = h.api.dataRefresh.check();
  await flushMicrotasks();
  assert.equal(fixture.sessions[0].refreshCalls, 1);
  h.api.lock();
  assert.equal(fixture.sessions[0].closed, true);
  assertLocked(h);
  fixture.setSnapshot('synthetic-new-session');
  fixture.resetRefreshReader();
  await h.submit();
  await flushMicrotasks();
  const deadline = h.api.state.deadline;
  oldRefresh.resolve(syntheticVault('synthetic-old-update'));
  await checking;
  assertSyntheticSnapshot(h, 'synthetic-new-session');
  assert.equal(h.api.state.deadline, deadline);
  assert.equal(fixture.sessions[1].closed, false);
});

test('a version change during snapshot loading keeps the complete previous snapshot until a consistent retry', async () => {
  const fixture = refreshingHarness();
  const { h } = fixture;
  await h.submit();
  await flushMicrotasks();
  await h.api.dataRefresh.check();
  const pending = deferred();
  fixture.setSnapshot('synthetic-b');
  fixture.setRefreshReader(() => pending.promise);
  const checking = h.api.dataRefresh.check();
  await flushMicrotasks();
  assertSyntheticSnapshot(h, 'synthetic-a');
  fixture.setSnapshot('synthetic-c');
  pending.resolve(syntheticVault('synthetic-b'));
  await checking;
  assertSyntheticSnapshot(h, 'synthetic-a');
  fixture.resetRefreshReader();
  await h.api.dataRefresh.check();
  assertSyntheticSnapshot(h, 'synthetic-c');
});

test('initial public NAV loading from a closed session cannot replace a newer session snapshot', async () => {
  const fixture = refreshingHarness();
  const { h } = fixture;
  const delayedNav = deferred();
  fixture.setQuoteReader(async code => {
    await delayedNav.promise;
    return syntheticQuote(code, 'synthetic-old-nav');
  });
  const oldUnlock = h.submit();
  await flushMicrotasks();
  h.api.lock();
  fixture.setSnapshot('synthetic-new-session');
  fixture.setQuoteReader(async code => syntheticQuote(code, 'synthetic-new-session'));
  await h.submit();
  await flushMicrotasks();
  assertSyntheticSnapshot(h, 'synthetic-new-session');
  delayedNav.resolve();
  await oldUnlock;
  await flushMicrotasks();
  assertSyntheticSnapshot(h, 'synthetic-new-session');
});

test('an encryption key change during refresh closes the session and returns to the gate', async () => {
  const fixture = refreshingHarness();
  const { h } = fixture;
  await h.submit();
  await flushMicrotasks();
  await h.api.dataRefresh.check();
  fixture.setSnapshot('synthetic-new-encryption');
  fixture.setRefreshReader(async () => {
    const error = new Error('synthetic decryption failure');
    error.name = 'OperationError';
    throw error;
  });
  await assert.doesNotReject(h.api.dataRefresh.check());
  assertLocked(h);
  assert.equal(fixture.sessions[0].closed, true);
  assert.match(h.app.innerHTML, /请重新解锁/);
  assert.equal(h.clock.timers.size, 0);
});

for (const failedReads of [1, 2]) test(`${failedReads === 1 ? 'a single initial version failure' : 'an initially unavailable version manifest'} does not disable automatic refresh`, async () => {
  const fixture = refreshingHarness();
  const { h } = fixture;
  let reads = 0;
  fixture.setVersionReader(async () => {
    if (++reads <= failedReads) throw new Error('synthetic manifest unavailable');
    return { revision: 'synthetic-a' };
  });
  await h.submit();
  await flushMicrotasks();
  await h.api.dataRefresh.check();
  assert.equal(h.api.state.unlocked, true);
  assertSyntheticSnapshot(h, 'synthetic-a');
  const deadline = h.api.state.deadline;
  fixture.setSnapshot('synthetic-recovered-update');
  fixture.resetVersionReader();
  h.clock.tick(5000);
  await h.api.dataRefresh.check();
  assertSyntheticSnapshot(h, 'synthetic-recovered-update');
  assert.equal(h.api.state.deadline, deadline);
  assert.equal(fixture.sessions[0].closed, false);
});

test('a version change during unlock keeps the gate closed until transactions and NAV share a stable snapshot', async () => {
  const fixture = refreshingHarness();
  const { h } = fixture;
  const firstQuotes = deferred();
  const retriedVault = deferred();
  let quoteCalls = 0;
  fixture.setQuoteReader(async code => {
    const initial = ++quoteCalls <= SYNTHETIC_CODES.length;
    if (initial) {
      await firstQuotes.promise;
      return syntheticQuote(code, 'synthetic-a');
    }
    return syntheticQuote(code, 'synthetic-stable-update');
  });
  fixture.setRefreshReader(() => retriedVault.promise);
  const unlocking = h.submit();
  await flushMicrotasks();
  assert.equal(quoteCalls, SYNTHETIC_CODES.length);
  assertLocked(h);
  fixture.setSnapshot('synthetic-stable-update');
  firstQuotes.resolve();
  await flushMicrotasks();
  assert.equal(fixture.sessions[0].refreshCalls, 1);
  assertLocked(h);
  retriedVault.resolve(syntheticVault('synthetic-stable-update'));
  await unlocking;
  assert.equal(h.api.state.unlocked, true);
  assertSyntheticSnapshot(h, 'synthetic-stable-update');
  assert.equal(quoteCalls, SYNTHETIC_CODES.length * 2);
});

test('continuously changing initial versions stop after three snapshot attempts without applying partial data', async () => {
  const fixture = refreshingHarness();
  const { h } = fixture;
  let quoteCalls = 0;
  let quoteLabel = 'synthetic-a';
  fixture.setQuoteReader(async code => {
    const captured = quoteLabel;
    quoteCalls += 1;
    if (quoteCalls % SYNTHETIC_CODES.length === 0) {
      quoteLabel = `synthetic-changing-${quoteCalls / SYNTHETIC_CODES.length}`;
      fixture.setSnapshot(quoteLabel);
    }
    return syntheticQuote(code, captured);
  });
  await h.submit();
  assertLocked(h);
  assert.equal(quoteCalls, SYNTHETIC_CODES.length * 3);
  assert.equal(fixture.sessions[0].refreshCalls, 3);
  assert.equal(fixture.sessions[0].closed, true);
  assert.deepEqual(h.api.state.nav, {});
  assert.equal(h.clock.timers.size, 0);
});

function syntheticDiscipline(revision, absolute = 200) {
  return { revision, entries: [
    { id: 'trade-frequency', title: `Synthetic discipline ${revision}`, detail: '仅为合成页面同步测试。' },
    { id: 'annual-profit', title: '年内收益纪律', detail: `年内涨幅达到${absolute}%，大幅止盈。Synthetic annual ${revision}` },
  ] };
}

function disciplineSyncHarness() {
  let payload = syntheticDiscipline('synthetic-a');
  let reader = async () => ({ ok: true, json: async () => payload });
  const requests = [];
  const h = harness(undefined, {
    fetch: async (url, settings) => {
      if (url === './data/discipline.json') {
        requests.push({ url, settings });
        return reader();
      }
      if (url === './data/version.json') return { ok: true, json: async () => ({ revision: 'synthetic-public-stable' }) };
      const code = /\/nav\/([0-9]{6})\.json$/.exec(url)?.[1];
      assert.ok(FUND_CODES.includes(code), 'public NAV responses use synthetic observations');
      return { ok: true, json: async () => ({ code, history: [
        { date: '2024-01-01', nav: 1 }, { date: '2025-12-31', nav: 1 },
        { date: '2026-01-02', nav: 1 }, { date: '2026-01-07', nav: code === '005698' ? 2 : 1 },
      ] }) };
    },
  });
  return { h, requests,
    setPayload(next) { payload = next; },
    setReader(next) { reader = next; },
    resetReader() { reader = async () => ({ ok: true, json: async () => payload }); },
  };
}

test('the discipline endpoint updates state and the home on its independent interval without extending the session', async () => {
  const fixture = disciplineSyncHarness();
  const { h } = fixture;
  await h.submit();
  await h.api.disciplineSync.check();
  assert.match(h.app.innerHTML, /Synthetic discipline synthetic-a/);
  assert.equal(h.api.state.disciplines[0].title, 'Synthetic discipline synthetic-a');
  const deadline = h.api.state.deadline;
  fixture.setPayload(syntheticDiscipline('synthetic-b'));
  h.clock.tick(5000);
  await h.api.disciplineSync.check();
  assert.equal(h.api.state.disciplines[0].title, 'Synthetic discipline synthetic-b');
  assert.match(h.app.innerHTML, /Synthetic discipline synthetic-b/);
  assert.doesNotMatch(h.app.innerHTML, /Synthetic discipline synthetic-a/);
  assert.equal(h.api.state.deadline, deadline);
  assert.ok(fixture.requests.length >= 2);
  assert.ok(fixture.requests.every(request => request.settings.cache === 'no-store'));
  h.api.lock();
  const calls = fixture.requests.length;
  await h.api.disciplineSync.check();
  assert.equal(fixture.requests.length, calls);
  assert.equal(h.clock.timers.size, 0);
});

test('live discipline revisions recalculate exposure warnings and clear them when the rule is missing or unrecognizable', async () => {
  const exposureInterface = () => h.app.innerHTML
    .replace(/<a\b[^>]*href="#\/bonds"[^>]*>[\s\S]*?<\/a>/g, '')
    .replace(/<(details|article)\b[^>]*data-discipline="bond-reserve"[\s\S]*?<\/\1>/g, '');
  const fixture = disciplineSyncHarness();
  const { h } = fixture;
  const rules = (revision, detail) => ({ revision, entries: [
    { id: 'trade-frequency', title: '合成同步测试', detail: '' },
    ...(detail === null ? [] : [{ id: 'us-exposure', title: '基金持有量按美股含量确定。', detail }]),
  ] });
  fixture.setPayload(rules('synthetic-exposure-40', '如果美股含量低于40%，则立刻降低该基金持仓。'));
  await h.submit();
  await h.api.disciplineSync.check();
  const deadline = h.api.state.deadline;
  const funds = structuredClone(h.api.state.funds);
  assert.match(h.app.innerHTML, /data-exposure-status="below"/);
  assert.equal((h.app.innerHTML.match(/exposure-check-below/g) || []).length, 1);

  fixture.setPayload(rules('synthetic-exposure-15', '如果美股含量低于15%，则立刻降低该基金持仓。'));
  h.clock.tick(5000);
  await h.api.disciplineSync.check();
  assert.match(h.app.innerHTML, /<article\b[^>]*data-discipline="us-exposure"/);
  assert.doesNotMatch(exposureInterface(), /data-panel="discipline-us-exposure"|exposure-badge|美股占比均达标|exposure-nav-warning|未完全遵守|data-exposure-fund=/);

  fixture.setPayload(rules('synthetic-exposure-decimal', '如果美股含量低于46.655%，则立刻降低该基金持仓。'));
  h.clock.tick(5000);
  await h.api.disciplineSync.check();
  assert.equal((h.app.innerHTML.match(/exposure-check-below/g) || []).length, 2);
  assert.match(h.app.innerHTML, /规则门槛46\.655%/);
  h.location.hash = '#/fund/270023';
  h.api.render();
  assert.match(h.app.innerHTML, /status-chip exposure-warning/);
  assert.match(h.app.innerHTML, /规则门槛 46\.655%/);

  fixture.setPayload(rules('synthetic-exposure-unknown', '按定期报告复核美股含量。'));
  h.clock.tick(5000);
  await h.api.disciplineSync.check();
  assert.doesNotMatch(exposureInterface(), /exposure-nav-warning|status-chip exposure-warning|region-us-below/);
  h.location.hash = '#/';
  h.api.render();
  assert.match(h.app.innerHTML, /<article\b[^>]*data-discipline="us-exposure"/);
  const unknownExposureRule = h.app.innerHTML.match(/<article\b[^>]*data-discipline="us-exposure"[\s\S]*?<\/article>/)?.[0] || '';
  assert.doesNotMatch(unknownExposureRule, /data-panel="discipline-us-exposure"|exposure-badge|待核验|未完全遵守|data-exposure-fund=/);

  fixture.setPayload(rules('synthetic-exposure-removed', null));
  h.clock.tick(5000);
  await h.api.disciplineSync.check();
  assert.doesNotMatch(exposureInterface(), /data-discipline="us-exposure"|exposure-nav-warning|未完全遵守/);
  assert.deepEqual(h.api.state.funds, funds);
  assert.equal(h.api.state.deadline, deadline);
  h.api.lock();
});

test('a discipline revision adds and clears the current fund alert without changing NAV or restarting the deadline', async () => {
  const fixture = disciplineSyncHarness();
  const { h } = fixture;
  await h.submit();
  await h.api.disciplineSync.check();
  h.location.hash = '#/fund/005698';
  h.windowEvents.get('hashchange')();
  assert.doesNotMatch(h.app.innerHTML, /class="annual-discipline-alert"/);
  const quotes = h.api.state.nav['005698'].history;
  const deadline = h.api.state.deadline;
  fixture.setPayload(syntheticDiscipline('synthetic-trigger', 100));
  h.clock.tick(5000);
  await h.api.disciplineSync.check();
  const alert = h.app.innerHTML.match(/<aside class="annual-discipline-alert"[\s\S]*?<\/aside>/)?.[0];
  assert.ok(alert);
  assert.match(alert, /data-fund="005698"/);
  assert.match(alert, /Synthetic annual synthetic-trigger/);
  assert.doesNotMatch(alert, /button|data-action|关闭/);
  assert.equal(h.api.state.nav['005698'].history, quotes);
  assert.equal(h.api.state.deadline, deadline);
  fixture.setPayload(syntheticDiscipline('synthetic-clear', 200));
  h.clock.tick(5000);
  await h.api.disciplineSync.check();
  assert.doesNotMatch(h.app.innerHTML, /class="annual-discipline-alert"/);
  assert.equal(h.api.state.disciplines[0].title, 'Synthetic discipline synthetic-clear');
  assert.equal(h.api.state.nav['005698'].history, quotes);
  assert.equal(h.api.state.deadline, deadline);
  h.api.lock();
});

test('a pending discipline response cannot refill a locked page or change the last accepted rule', async () => {
  const fixture = disciplineSyncHarness();
  const { h } = fixture;
  await h.submit();
  await h.api.disciplineSync.check();
  const pending = deferred();
  fixture.setReader(() => pending.promise);
  const checking = h.api.disciplineSync.check();
  await flushMicrotasks();
  h.api.lock();
  assertLocked(h);
  pending.resolve({ ok: true, json: async () => syntheticDiscipline('synthetic-obsolete', 100) });
  await checking;
  assertLocked(h);
  assert.equal(h.api.state.disciplines[0].title, 'Synthetic discipline synthetic-a');
  assert.doesNotMatch(h.app.innerHTML, /synthetic-obsolete|annual-discipline-alert/);
  assert.equal(h.clock.timers.size, 0);
});

for (const stage of ['response', 'json']) test(`an old discipline ${stage} completion cannot overwrite a newly unlocked session`, async () => {
  const fixture = disciplineSyncHarness();
  const { h } = fixture;
  await h.submit();
  await h.api.disciplineSync.check();
  const pending = deferred();
  fixture.setReader(stage === 'response' ? () => pending.promise : async () => ({ ok: true, json: () => pending.promise }));
  const checking = h.api.disciplineSync.check();
  await flushMicrotasks();
  h.api.lock();
  assertLocked(h);
  h.clock.advanceWithoutCallbacks(1000);
  fixture.setPayload(syntheticDiscipline('synthetic-new-session'));
  fixture.resetReader();
  await h.submit();
  await h.api.disciplineSync.check();
  const deadline = h.api.state.deadline;
  assert.match(h.app.innerHTML, /Synthetic discipline synthetic-new-session/);
  const old = syntheticDiscipline('synthetic-stale-session', 100);
  pending.resolve(stage === 'response' ? { ok: true, json: async () => old } : old);
  await checking;
  assert.equal(h.api.state.unlocked, true);
  assert.equal(h.api.state.disciplines[0].title, 'Synthetic discipline synthetic-new-session');
  assert.match(h.app.innerHTML, /Synthetic discipline synthetic-new-session/);
  assert.doesNotMatch(h.app.innerHTML, /synthetic-stale-session/);
  assert.equal(h.api.state.deadline, deadline);
  h.api.lock();
  assert.equal(h.clock.timers.size, 0);
});

// Bond-page regression fixtures contain synthetic numbers only.
const syntheticBondEntries = () => [
  { code: '006485', marketValue: 110, holdingProfit: 10 },
  { code: '006663', marketValue: 220, holdingProfit: 20 }, { code: '004103', marketValue: 0, holdingProfit: 0 },
];

function bondsHarness(options = {}) {
  const sessions = [], saves = [], cashSaves = [];
  let saveReader = null;
  let h;
  h = harness(undefined, {
    loadVault: async () => ({ getDailyCode: () => h.day(), unlockVault: async () => syntheticVault('synthetic-bonds-equity-control') }),
    openBondStore: async () => {
      const session = {
        closed: false,
        snapshot: { bonds: syntheticBondEntries(), freeCashFlow: null, updatedAt: '2026-01-08T02:00:00.000Z', ...(options.holdingLots ? { holdingLots: structuredClone(options.holdingLots) } : {}), ...(options.transactions ? { transactions: structuredClone(options.transactions) } : {}) },
        getSnapshot() { assert.equal(this.closed, false); return structuredClone(this.snapshot); },
        async save(entries) {
          assert.equal(this.closed, false);
          saves.push(structuredClone(entries));
          const saved = saveReader ? await saveReader(entries) : { ...this.snapshot, bonds: structuredClone(entries), freeCashFlow: this.snapshot.freeCashFlow, updatedAt: new RealDate(h.clock.now).toISOString() };
          this.snapshot = structuredClone(saved);
          return structuredClone(saved);
        },
        async saveFreeCashFlow(value) {
          assert.equal(this.closed, false);
          cashSaves.push(value);
          const saved = { ...this.snapshot, freeCashFlow: value, updatedAt: new RealDate(h.clock.now).toISOString() };
          this.snapshot = structuredClone(saved);
          return structuredClone(saved);
        },
        close() { this.closed = true; },
      };
      sessions.push(session);
      return session;
    },
  });
  return { h, sessions, saves, cashSaves, setSaveReader(reader) { saveReader = reader; } };
}

function showBonds(h) {
  h.location.hash = '#/bonds';
  h.windowEvents.get('hashchange')();
}

test('004103 missing history names the missing fund while preserving existing bond cards and privacy', async () => {
  const { h } = bondsHarness();
  await h.submit();
  h.api.state.bonds = h.api.state.bonds.filter(entry => entry.code !== '004103');
  showBonds(h);
  assert.match(h.app.innerHTML, /004103持仓资料待补全/);
  assert.match(h.app.innerHTML, /bond-title-004103/);
  assert.match(h.app.innerHTML, /bond-title-006485/);
  assert.match(h.app.innerHTML, /bond-title-006663/);
  assert.match(h.app.innerHTML, /data-bond-reserve-share>待核验/);
  assert.doesNotMatch(h.app.innerHTML, /110\.00|220\.00|330\.00/);
  h.api.lock();
});

function assertBondDeadline(h, deadline, dayDeadline = deadline) {
  assert.equal(h.api.state.deadline, deadline);
  assert.equal(h.api.state.dayDeadline, dayDeadline);
}

test('bond source records are read-only and their disclosure survives ordinary rerenders', async () => {
  const transactions = { '006485': [{ id: 'readonly-bond', type: 'buy', status: 'pending', sourceStatus: 'unverified', date: '2026-01-01', amount: 100 }] };
  const { h } = bondsHarness({ transactions }); await h.submit(); showBonds(h);
  const before = structuredClone(h.api.state.bonds);
  assert.match(h.app.innerHTML, /data-id="bond-readonly-bond"/);
  assert.doesNotMatch(h.app.innerHTML, /id="bond-edit-form"|data-action="bond-(?:edit|close|cancel)"/);
  for (const action of ['bond-edit', 'bond-cancel', 'bond-close']) h.click(action, { code: '006485' });
  assert.deepEqual(h.api.state.bonds, before);
  const panel = { dataset: { bondLedger: '006485' }, open: true, matches: selector => selector === 'details[data-bond-ledger]' };
  h.documentEvents.get('toggle')({ target: panel }); h.api.render();
  assert.match(h.app.innerHTML, /data-bond-ledger="006485"[^>]* open/);
  h.api.lock(); assert.deepEqual(h.api.state.bondTransactions, {}); assert.deepEqual(h.api.state.bondExpanded, {});
});

test('a version refresh applies table bond snapshots and transactions with quotes while keeping independent cash flow and session limits', async () => {
  let revision = 'a', bond = { bonds: syntheticBondEntries(), transactions: {}, holdingLots: {}, freeCashFlow: -12.35, updatedAt: '2026-01-08T02:00:00Z' };
  let h;
  h = harness(undefined, {
    fetch: async url => ({ ok: true, json: async () => url.endsWith('version.json') ? { revision } : { code: /\d{6}/.exec(url)[0], history: [{ date: '2026-01-07', nav: 2 }] } }),
    loadVault: async () => ({ getDailyCode: () => h.day(), unlockVault: async (_password, { onSession }) => { onSession({ close() {}, refresh: async () => syntheticVault(revision) }); return syntheticVault(revision); } }),
    openBondStore: async () => ({ getSnapshot: () => structuredClone(bond), refresh: async () => structuredClone(bond), close() {} }),
  });
  await h.submit(); await h.api.dataRefresh.check(); showBonds(h); const deadline = h.api.state.deadline;
  bond = { ...bond, bonds: [{ code: '006485', marketValue: 150, holdingProfit: 10 }, syntheticBondEntries()[1], syntheticBondEntries()[2]], transactions: { '006485': [{ id: 'refreshed-source-bond', type: 'buy', amount: 1, status: 'pending', date: '2026-01-07' }] } };
  revision = 'b'; await h.api.dataRefresh.check();
  assert.equal(h.api.state.bonds[0].marketValue, 150); assert.match(h.app.innerHTML, /bond-refreshed-source-bond/);
  assert.equal(h.api.state.freeCashFlow, -12.35); assertBondDeadline(h, deadline); h.api.lock();
});

test('a source version changing during unlock refreshes bond and equity snapshots before exposing either', async () => {
  let versions = 0, bondRefreshes = 0, h;
  const before = { bonds: syntheticBondEntries(), transactions: {}, holdingLots: {}, freeCashFlow: null, updatedAt: '2026-01-08T02:00:00Z' };
  const after = { ...before, bonds: [{ code: '006485', marketValue: 150, holdingProfit: 10 }, syntheticBondEntries()[1], syntheticBondEntries()[2]], transactions: { '006485': [{ id: 'initial-latest-bond', type: 'buy', status: 'pending', amount: 1 }] } };
  h = harness(undefined, {
    fetch: async url => ({ ok: true, json: async () => url.endsWith('version.json') ? { revision: ++versions === 1 ? 'a' : 'b' } : { code: /\d{6}/.exec(url)[0], history: [{ date: '2026-01-07', nav: 2 }] } }),
    loadVault: async () => ({ getDailyCode: () => h.day(), unlockVault: async (_password, { onSession }) => { onSession({ close() {}, refresh: async () => syntheticVault('b') }); return syntheticVault('a'); } }),
    openBondStore: async () => ({ getSnapshot: () => structuredClone(before), refresh: async () => { bondRefreshes += 1; return structuredClone(after); }, close() {} }),
  });
  await h.submit();
  assert.equal(h.api.state.unlocked, true); assert.equal(h.api.state.createdAt, 'b');
  assert.equal(bondRefreshes, 1); assert.equal(h.api.state.bonds[0].marketValue, 150);
  assert.equal(h.api.state.bondTransactions['006485'][0].id, 'initial-latest-bond'); h.api.lock();
});

test('bond overview portfolio share follows current equity valuation including yesterday estimates', async () => {
  const { h } = bondsHarness(); await h.submit();
  for (const fund of FUNDS) {
    h.api.state.funds[fund.code] = { mode: 'profit-first', incomplete: false, transactions: [{ id: 'synthetic-share-' + fund.code, type: 'buy', status: 'confirmed', date: '2026-01-01', nav: 1, shares: 100, amount: 100, fee: 0 }] };
    h.api.state.nav[fund.code] = { history: [{ date: '2026-01-06', nav: 1 }] };
  }
  showBonds(h);
  assert.match(h.app.innerHTML, /data-bond-reserve-share>45%/);
  h.api.state.navEstimateEntries = [{ code: FUNDS[0].code, date: '2026-01-07', change: 1 }];
  h.api.render();
  assert.match(h.app.innerHTML, /data-bond-reserve-share>40%/);
  assert.equal(h.api.state.visible, false);
  h.api.lock();
});

test('encrypted snapshot holding lots drive only verified maturity ratios and remain attached to the source snapshot', async () => {
  const holdingLots = {
    '006485': { complete: true, lots: [{ confirmedDate: '2025-12-01', remainingShares: 3, status: 'confirmed' }, { confirmedDate: '2026-01-01', remainingShares: 1, status: 'confirmed' }] },
    '006663': { complete: false, lots: [] },
  };
  const { h } = bondsHarness({ holdingLots }); await h.submit(); showBonds(h);
  assert.deepEqual(h.api.state.bondHoldingLots, holdingLots);
  assert.match(h.app.innerHTML, /未满30天约25%，已满30天约75%/);
  const other = h.app.innerHTML.match(/aria-labelledby="bond-title-006663"[\s\S]*?<\/details>/)[0];
  assert.match(other, /data-bond-duration-status="unknown"/);
  assert.deepEqual(h.api.state.bondHoldingLots, holdingLots);
  assert.match(h.app.innerHTML, /未满30天约25%，已满30天约75%/);
  h.api.lock(); assert.deepEqual(h.api.state.bondHoldingLots, {});
});

test('normal unlock opens the masked bond page with six navigation entries and the current route', async () => {
  const { h, sessions } = bondsHarness();
  await h.submit();
  assert.equal(h.api.state.unlocked, true);
  assert.equal(sessions.length, 1);
  assert.deepEqual(h.api.state.bonds, syntheticBondEntries());
  const deadline = h.api.state.deadline;
  h.clock.advanceWithoutCallbacks(3000);
  showBonds(h);
  assert.equal(h.api.state.visible, false);
  assert.match(h.app.innerHTML, /<h1>债基<\/h1>/);
  assert.match(h.app.innerHTML, /class="masked"/);
  assert.doesNotMatch(h.app.innerHTML, /110\.00|220\.00|330\.00/);
  assert.match(h.app.innerHTML, /\+10\.00%/);
  for (const className of ['desktop-nav', 'bottom-nav']) {
    const nav = h.app.innerHTML.match(new RegExp(`<nav class="${className}"[\\s\\S]*?<\\/nav>`))?.[0];
    assert.ok(nav);
    assert.equal((nav.match(/<a /g) || []).length, 6);
    assert.equal((nav.match(/aria-current="page"/g) || []).length, 1);
    assert.match(nav, /href="#\/bonds" class="active(?: [^"]*)?"[^>]*aria-current="page"/);
  }
  assert.doesNotMatch(h.app.innerHTML, /annual-discipline-alert|id="bond-edit-form"/);
  assertBondDeadline(h, deadline);
  h.api.lock();
  assert.equal(sessions[0].closed, true);
});

test('free cash flow is editable, encrypted in the bond session, masked by default, and clearable', async () => {
  const { h, cashSaves, saves } = bondsHarness();
  await h.submit();
  showBonds(h);
  const deadline = h.api.state.deadline;
  assert.match(h.app.innerHTML, /自由现金流/);
  assert.match(h.app.innerHTML, /未填写/);
  h.click('cash-edit');
  assert.equal(h.api.state.cashEditing, true);
  assert.equal((h.app.innerHTML.match(/type="password"/g) || []).length, 1);
  const submitCash = value => h.api.saveCashFlow({ preventDefault() {}, target: { elements: { freeCashFlow: { value } } } });
  await submitCash('12.345');
  assert.equal(cashSaves.length, 0);
  assert.equal(h.api.state.cashEditing, true);
  assert.ok(h.api.state.cashError);
  assert.match(h.app.innerHTML, /最多两位小数/);
  await submitCash('-12.35');
  assert.deepEqual(cashSaves, [-12.35]);
  assert.equal(h.api.state.freeCashFlow, -12.35);
  assert.equal(h.api.state.cashEditing, false);
  assert.equal(h.api.state.cashError, '');
  assert.doesNotMatch(h.app.innerHTML, /-12\.35|id="cash-flow-form"/);
  assert.match(h.app.innerHTML, /class="masked"/);
  h.click('privacy');
  assert.match(h.app.innerHTML, /-12\.35/);
  h.click('privacy');
  assert.doesNotMatch(h.app.innerHTML, /-12\.35/);
  h.click('cash-edit');
  await submitCash('');
  assert.equal(h.api.state.freeCashFlow, null);
  assert.equal(cashSaves.at(-1), null);
  assert.match(h.app.innerHTML, /未填写/);
  assert.deepEqual(saves, []);
  assertBondDeadline(h, deadline);
  h.api.lock();
});

function configureReserveFixture(h, { equityShares = 1000, bonds = syntheticBondEntries() } = {}) {
  for (const fund of FUNDS) {
    h.api.state.funds[fund.code] = { mode: 'profit-first', incomplete: false, transactions: [{ id: `reserve-${fund.code}`, type: 'buy', status: 'confirmed', date: '2026-01-01', nav: 1, shares: equityShares, amount: equityShares, fee: 0 }] };
    h.api.state.nav[fund.code] = { history: [{ date: '2026-01-07', nav: 1 }] };
  }
  h.api.state.bonds = structuredClone(bonds);
  h.api.state.bondUnavailable = false;
  h.api.render();
}

test('cash changes trigger red, yellow and green reserve notices immediately and clear safely', async () => {
  const { h } = bondsHarness();
  await h.submit();
  configureReserveFixture(h, { equityShares: 50_000 });
  assert.equal(h.api.bondReserveCheck().tone, 'red');
  assert.match(reserveRule(h), /钱不多了/);
  showBonds(h);
  const save = value => h.api.saveCashFlow({ preventDefault() {}, target: { elements: { freeCashFlow: { value } } } });
  h.click('cash-edit');
  await save('49670');
  assert.equal(h.api.bondReserveCheck().status, 'met');
  assert.equal(h.api.bondReserveCheck().tone, 'yellow');
  assert.equal(h.api.bondReserveCheck().notice, 'none');
  assert.equal(h.api.bondReserveCheck().ratio, .2);
  assert.equal(h.api.portfolioAllocation().shares[FUND_CODES[0]], .2);
  assert.match(h.app.innerHTML, /data-bond-reserve-share>20%/);
  assert.doesNotMatch(h.app.innerHTML, /可以花钱了|钱不多了/);
  h.click('cash-edit');
  await save('249670');
  assert.equal(h.api.bondReserveCheck().tone, 'green');
  assert.equal(h.api.bondReserveCheck().notice, 'spend');
  assert.match(h.app.innerHTML, /可以花钱了/);
  assert.match(h.app.innerHTML, /class="bond-total-progress" data-bond-total-tone="green"/);
  h.api.state.cashUnavailable = true;
  assert.equal(h.api.bondReserveCheck().status, 'unknown');
  assert.match(h.api.bondReserveCheck().message, /自由现金流记录暂不可用/);
  assert.equal(h.api.portfolioAllocation().status, 'unavailable');
  h.api.state.cashUnavailable = false;
  h.click('cash-edit');
  await save('');
  assert.equal(h.api.bondReserveCheck().tone, 'red');
  assert.match(h.app.innerHTML, /钱不多了/);
  h.api.lock();
});

test('reserve colors trigger spending or low-cash reminders and keep both yellow boundaries quiet', () => {
  const h = harness();
  h.start();
  configureReserveFixture(h, { equityShares: 100 });
  assert.equal(h.api.bondReserveCheck().reason, 'share-high');
  assert.match(reserveRule(h), /钱不多了/);
  configureReserveFixture(h, { equityShares: 165 });
  assert.equal(h.api.bondReserveCheck().status, 'met');
  assert.equal(h.api.bondReserveCheck().notice, 'low-cash');
  assert.match(reserveRule(h), /钱不多了/);
  for (const [equity, cash] of [[62_500, 49_670], [25_000, 49_670]]) {
    configureReserveFixture(h, { equityShares: equity });
    h.api.state.freeCashFlow = cash;
    h.api.render();
    assert.equal(h.api.bondReserveCheck().status, 'met');
    assert.equal(h.api.bondReserveCheck().tone, 'yellow');
    assert.match(reserveRule(h), /^<article\b/);
    assert.doesNotMatch(reserveRule(h), /钱不多了|可以花钱了|待核验/);
  }
  h.api.state.freeCashFlow = 100_000;
  h.api.render();
  assert.equal(h.api.bondReserveCheck().reason, 'absolute-threshold');
  assert.equal(h.api.bondReserveCheck().tone, 'green');
  assert.match(reserveRule(h), /可以花钱了/);
  for (const name of ['desktop-nav', 'bottom-nav']) {
    const nav = h.app.innerHTML.match(new RegExp(`<nav class="${name}"[\\s\\S]*?<\\/nav>`))[0];
    assert.match(nav, /bond-nav-spend/);
    assert.match(nav, /data-bond-reserve-notice="spend"/);
  }
  h.api.state.freeCashFlow = -331;
  h.api.render();
  assert.equal(h.api.bondReserveCheck().status, 'unknown');
  assert.match(h.api.bondReserveCheck().message, /合计为负/);
  h.api.lock();
});
function reserveRule(h) {
  return h.app.innerHTML.match(/<(?:details|article)\b[^>]*data-discipline="bond-reserve"[\s\S]*?<\/(?:details|article)>/)?.[0] || '';
}

test('the third home rule exposes only a failed reserve check and a link to the bond summary', () => {
  const h = harness();
  h.start();
  configureReserveFixture(h);
  const rule = reserveRule(h);
  assert.match(rule, /^<details\b/);
  assert.match(rule, /data-panel="discipline-bond-reserve"/);
  assert.match(rule, /data-bond-reserve-status="below"/);
  assert.match(rule, /discipline-entry-warning/);
  assert.match(rule, /钱不多了/);
  assert.match(rule, /href="#\/bonds\?section=bond-reserve"/);
  assert.doesNotMatch(rule, /110\.00|220\.00|330\.00|4,000\.00|持有份额|成交净值/);
  assert.doesNotMatch(rule.slice(0, rule.indexOf('>')), /\sopen(?:\s|$|=)/);
  const deadline = h.api.state.deadline;
  const panel = { dataset: { panel: 'discipline-bond-reserve' }, open: true, matches: selector => selector === 'details[data-panel]' };
  h.app.contains = candidate => candidate === panel;
  h.documentEvents.get('toggle')({ target: panel });
  h.api.render();
  assert.match(reserveRule(h).slice(0, reserveRule(h).indexOf('>')), /\sopen(?:\s|$|=)/);
  assertBondDeadline(h, deadline);
  h.api.lock();
});

test('a reserve within the allowed proportion has no extra compliance badge or disclosure', () => {
  const h = harness();
  h.start();
  configureReserveFixture(h, { equityShares: 50_000 });
  h.api.state.freeCashFlow = 49_670;
  h.api.render();
  const rule = reserveRule(h);
  assert.match(rule, /^<article\b/);
  assert.match(rule, /1\/6/);
  assert.match(rule, /1\/3/);
  assert.match(rule, /data-bond-reserve-status="met"/);
  assert.doesNotMatch(rule, /data-panel=|bond-reserve-target|discipline-compliance-line|badge|待核验|未完全遵守/);
  h.api.lock();
});

for (const [label, mutate] of [
  ['empty equity history', h => { h.api.state.funds['005698'].transactions = []; }],
  ['incomplete equity archive', h => { h.api.state.funds['005698'].incomplete = true; }],
  ['invalid equity transaction', h => { h.api.state.funds['005698'].transactions[0].shares = -1; }],
  ['unavailable bond store', h => { h.api.state.bondUnavailable = true; }],
]) test(`the reserve rule treats ${label} as pending verification rather than a confirmed failure`, () => {
  const h = harness();
  h.start();
  configureReserveFixture(h);
  h.api.state.freeCashFlow = 49_670;
  mutate(h);
  h.api.render();
  const rule = reserveRule(h);
  assert.match(rule, /data-bond-reserve-status="unknown"/);
  assert.match(rule, /待核验/);
  assert.doesNotMatch(rule, /data-bond-reserve-status="below"|discipline-entry-warning|exposure-warning|未完全遵守/);
  h.api.lock();
});

test('the independent absolute reserve condition can pass even when the equity archive is incomplete', () => {
  const h = harness();
  h.start();
  configureReserveFixture(h, { bonds: [
    { code: '006485', marketValue: 25000, holdingProfit: 0 },
    { code: '006663', marketValue: 25000, holdingProfit: 0 },
    { code: '004103', marketValue: 0, holdingProfit: 0 },
  ] });
  assert.match(reserveRule(h), /data-bond-reserve-status="below"/, 'the absolute threshold is strictly greater and the proportion is too high');
  h.api.state.bonds[1].marketValue += 1;
  h.api.state.funds['005698'].incomplete = true;
  h.api.render();
  assert.equal(h.api.bondReserveCheck().tone, 'unknown');
  assert.match(reserveRule(h), /待核验/);
  assert.doesNotMatch(reserveRule(h), /钱不多了|可以花钱了/);
  h.api.lock();
});

test('bond reserve reason routes focus their summary once and return to the expanded third home rule', () => {
  const h = harness();
  const calls = [];
  const querySelector = h.document.querySelector.bind(h.document);
  h.document.querySelector = selector => {
    if (selector === '#bonds-reserve-summary' || selector === '[data-discipline="bond-reserve"] > summary') return {
      focus(settings) { calls.push({ method: 'focus', selector, settings }); },
      scrollIntoView(settings) { calls.push({ method: 'scrollIntoView', selector, settings }); },
    };
    return querySelector(selector);
  };
  h.start();
  configureReserveFixture(h);
  const deadline = h.api.state.deadline;
  h.location.hash = '#/bonds?section=bond-reserve';
  h.windowEvents.get('hashchange')();
  assert.match(h.app.innerHTML, /<h1>债基<\/h1>/);
  const summaryTag = h.app.innerHTML.match(/<section\b[^>]*id="bonds-reserve-summary"[^>]*>/)?.[0] || '';
  assert.match(summaryTag, /tabindex="-1"/);
  assert.match(h.app.innerHTML, /href="#\/\?section=bond-reserve"/);
  assert.deepEqual(calls, [
    { method: 'focus', selector: '#bonds-reserve-summary', settings: { preventScroll: true } },
    { method: 'scrollIntoView', selector: '#bonds-reserve-summary', settings: { block: 'center', behavior: 'instant' } },
  ]);
  h.api.render();
  assert.equal(calls.length, 2, 'an ordinary bond redraw does not steal focus or scroll again');
  h.location.hash = '#/?section=bond-reserve';
  h.windowEvents.get('hashchange')();
  assert.match(reserveRule(h).slice(0, reserveRule(h).indexOf('>')), /\sopen(?:\s|$|=)/);
  assert.deepEqual(calls.slice(-2), [
    { method: 'focus', selector: '[data-discipline="bond-reserve"] > summary', settings: { preventScroll: true } },
    { method: 'scrollIntoView', selector: '[data-discipline="bond-reserve"] > summary', settings: { block: 'center', behavior: 'instant' } },
  ]);
  assert.deepEqual(h.scrollCalls, [], 'deep-link targeting is not overwritten by a top scroll');
  assertBondDeadline(h, deadline);
  h.api.lock();
});

test('a quote refresh triggers a green spending reminder from a quiet yellow reserve without extending the session', async () => {
  const fixture = refreshingHarness();
  const { h } = fixture;
  await h.submit();
  await flushMicrotasks();
  await h.api.dataRefresh.check();
  h.api.state.bonds = [
    { code: '006485', marketValue: 25_000, holdingProfit: 0 },
    { code: '006663', marketValue: 25_000, holdingProfit: 0 },
    { code: '004103', marketValue: 0, holdingProfit: 0 },
  ];
  for (const code of FUND_CODES) h.api.state.nav[code] = { history: [{ date: '2026-01-07', nav: 50_000 }] };
  h.api.state.bondUnavailable = false;
  h.api.render();
  assert.match(reserveRule(h), /^<article\b/);
  assert.equal(h.api.bondReserveCheck().tone, 'yellow');
  assert.doesNotMatch(reserveRule(h), /钱不多了|可以花钱了|待核验/);
  const deadline = h.api.state.deadline;
  h.clock.advanceWithoutCallbacks(7000);
  fixture.setSnapshot('synthetic-reserve-new-quotes');
  fixture.setQuoteReader(code => ({ code, history: [{ date: '2026-01-07', nav: 200_000 }] }));
  await h.api.dataRefresh.check();
  assert.equal(h.api.bondReserveCheck().tone, 'green');
  assert.match(reserveRule(h), /可以花钱了/);
  assertBondDeadline(h, deadline);
  h.api.lock();
});

// Manual NAV estimates use public synthetic NAV/rate data and isolated storage.
function configureEstimateFixture(h) {
  const history = [
    { date: '2024-01-01', nav: 1 }, { date: '2025-01-01', nav: 1.1 },
    { date: '2026-01-05', nav: 1.15 }, { date: '2026-01-06', nav: 1.2 },
  ];
  h.api.state.funds = Object.fromEntries(FUNDS.map(fund => [fund.code, {
    transactions: [{ id: `synthetic-estimate-${fund.code}`, type: 'buy', status: 'confirmed', date: '2025-01-02', nav: 1.1, shares: 1, fee: 0 }],
    mode: 'profit-first', rate: null, incomplete: false, sourceNote: 'synthetic public estimate isolation',
  }]));
  h.api.state.nav = Object.fromEntries(FUNDS.map(fund => [fund.code, { history: structuredClone(history) }]));
  h.api.state.bonds = syntheticBondEntries();
  h.api.state.bondUnavailable = false;
  h.api.render();
  return history;
}

function estimatePanel(h) {
  return h.app.innerHTML.match(/<details\b[^>]*data-panel="nav-estimates"[\s\S]*?<\/details>/)?.[0] || '';
}

function estimateInput(h, code) {
  return estimatePanel(h).match(new RegExp(`<input\\b[^>]*name="estimate-${code}"[^>]*>`))?.[0] || '';
}

function estimateDirectionInput(h, code) {
  return estimatePanel(h).match(new RegExp(`<input\\b[^>]*name="direction-${code}"[^>]*>`))?.[0] || '';
}

function submitNavEstimates(h, values = {}, directions = null) {
  const elements = Object.fromEntries(FUNDS.map(fund => {
    const saved = h.api.state.navEstimateEntries.find(entry => entry.code === fund.code && entry.date === h.api.state.estimateDate);
    const value = Object.hasOwn(values, fund.code) ? values[fund.code] : saved ? String(saved.change * 100) : '';
    return [`estimate-${fund.code}`, { value }];
  }));
  for (const [code, value] of Object.entries(directions || {})) elements[`direction-${code}`] = { value };
  return h.api.saveNavEstimateEdits({ preventDefault() {}, target: { id: 'nav-estimate-form', elements } });
}

function chartAttribute(html, name) {
  const raw = html.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  return raw ? JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&')) : null;
}

function configureNavGapFixture(h, { kind = 'add' } = {}) {
  const code = '005698', fund = FUNDS.find(item => item.code === code);
  const history = kind === 'profit' ? [
    { date: '2025-12-31', nav: 1 }, { date: '2026-01-02', nav: 1 },
    { date: '2026-01-05', nav: 1.95 }, { date: '2026-01-06', nav: 1.96 },
  ] : [
    { date: '2010-01-01', nav: 1 }, { date: '2025-12-31', nav: 1 },
    { date: '2026-01-02', nav: 1 }, { date: '2026-01-03', nav: 4 },
    { date: '2026-01-05', nav: 3.8 }, { date: '2026-01-06', nav: 3.5 },
  ];
  h.api.state.nav[code] = { history };
  h.api.state.funds[code] = {
    mode: 'profit-first', rate: null, incomplete: false,
    transactions: [{ id: 'synthetic-nav-gap-trade', type: 'buy', status: 'confirmed', date: '2026-01-03', nav: 4, shares: 1, fee: 0 }],
  };
  h.api.state.navRanges[code] = { from: '2026-01-05', to: '2026-01-06' };
  return { code, fund, history };
}

function navGapMarkup(html) {
  return html.match(/<p\b[^>]*data-nav-discipline-gap[^>]*>[\s\S]*?<\/p>/)?.[0] || '';
}

test('the public NAV loss hint keeps its transaction baseline when the selected chart interval is shorter', () => {
  const h = harness();
  h.start();
  const { code, fund, history } = configureNavGapFixture(h);
  const gap = navGapMarkup(h.api.navPanel(fund));
  const expected = (calculateNavAnnualized(history) * 2 - (1 - 3.5 / 4)) * 100;
  assert.match(gap, /距加仓标准还差/);
  assert.ok(gap.includes(expected.toFixed(2)), 'gap uses the last trade, not the smaller selected-chart decline');
  assert.match(gap, /个百分点/);
  assert.doesNotMatch(gap, / hidden|止盈标准|持有份额|当前市值/);
  assert.equal(h.api.state.navRanges[code].from, '2026-01-05');
  h.api.lock();
});

test('the public NAV gain hint compares its year return with the absolute profit clause even without a full-year average', () => {
  const h = harness();
  h.start();
  const { fund, history } = configureNavGapFixture(h, { kind: 'profit' });
  assert.equal(calculateNavAnnualized(history), null);
  const gap = navGapMarkup(h.api.navPanel(fund));
  assert.match(gap, /距止盈标准还差 <span class="num">4\.00<\/span> 个百分点/);
  assert.doesNotMatch(gap, / hidden|加仓标准|当前市值|收益金额/);
  h.api.lock();
});

test('range button updates replace the hint when the displayed sign changes and clear it for a flat interval', () => {
  const h = harness();
  h.start();
  const { code, fund } = configureNavGapFixture(h);
  const { fields } = installRangePanel(h);
  h.click('nav-period', { fund: code, period: 'all' });
  const gap = fields.get('[data-nav-discipline-gap]');
  assert.equal(gap.hidden, false);
  assert.match(gap.innerHTML, /已达到止盈标准/);
  assert.match(navGapMarkup(h.api.navPanel(fund)), /已达到止盈标准/);
  h.click('nav-period', { fund: code, period: 'since-trade' });
  assert.equal(gap.hidden, false);
  assert.match(gap.innerHTML, /距加仓标准还差/);
  assert.doesNotMatch(gap.innerHTML, /止盈标准/);
  assert.ok(fields.get('[data-nav-change]').textContent.startsWith('-'));
  h.click('nav-period', { fund: code, period: 'last-month' });
  assert.equal(gap.innerHTML, '');
  assert.equal(gap.hidden, true);
  assert.match(navGapMarkup(h.api.navPanel(fund)), /data-nav-discipline-gap hidden><\/p>/);
  h.api.lock();
});

test('a manual estimate updates the public NAV discipline distance and official replacement takes precedence', () => {
  const h = harness();
  h.start();
  const { code, fund, history } = configureNavGapFixture(h, { kind: 'profit' });
  assert.match(navGapMarkup(h.api.navPanel(fund)), />4\.00<\/span>/);
  submitNavEstimates(h, { [code]: '1' });
  assert.match(navGapMarkup(h.api.navPanel(fund)), />2\.04<\/span>/);
  assert.equal(calculateNavAnnualized(history), null);
  submitNavEstimates(h, { [code]: '10' });
  assert.match(navGapMarkup(h.api.navPanel(fund)), /已达到止盈标准/);
  h.api.state.nav[code].history.push({ date: '2026-01-07', nav: 1.97 });
  h.api.state.navRanges[code] = { from: '2026-01-05', to: '2026-01-07' };
  h.api.render();
  assert.match(navGapMarkup(h.api.navPanel(fund)), />3\.00<\/span>/);
  assert.equal(h.api.state.navEstimateEntries.some(entry => entry.code === code), false);
  h.api.lock();
});

test('the public NAV hint stays empty when its gap exceeds five points or its transaction basis is missing', () => {
  const h = harness();
  h.start();
  let fixture = configureNavGapFixture(h, { kind: 'profit' });
  fixture.history.at(-1).nav = 1.94;
  h.api.state.navRanges[fixture.code] = { from: '2026-01-02', to: '2026-01-06' };
  assert.match(navGapMarkup(h.api.navPanel(fixture.fund)), /data-nav-discipline-gap hidden><\/p>/);
  fixture = configureNavGapFixture(h);
  h.api.state.funds[fixture.code].transactions = [];
  assert.match(navGapMarkup(h.api.navPanel(fixture.fund)), /data-nav-discipline-gap hidden><\/p>/);
  h.api.lock();
});

test('the home estimate disclosure uses Beijing yesterday and exactly the four current public fund inputs', () => {
  const h = harness('2026-01-07T16:02:00.000Z');
  h.start();
  configureEstimateFixture(h);
  const panel = estimatePanel(h);
  assert.match(panel, /<h2>最近工作日估值<\/h2>/);
  assert.match(panel, /datetime="2026-01-07"/);
  assert.equal(h.api.state.estimateDate, '2026-01-07');
  assert.equal((panel.match(/name="estimate-\d{6}"/g) || []).length, 4);
  assert.doesNotMatch(panel.slice(0, panel.indexOf('>')), /\sopen(?:\s|$|=)/);
  for (const fund of FUNDS) {
    assert.match(estimateInput(h, fund.code), /type="text" inputmode="decimal"/);
    assert.match(estimateInput(h, fund.code), /placeholder="未填写"/);
    assert.doesNotMatch(estimateInput(h, fund.code), /\sdisabled/);
  }
  const deadline = h.api.state.deadline;
  const disclosure = { dataset: { panel: 'nav-estimates' }, open: true, matches: selector => selector === 'details[data-panel]' };
  h.app.contains = candidate => candidate === disclosure;
  h.documentEvents.get('toggle')({ target: disclosure });
  h.api.render();
  assert.match(estimatePanel(h).slice(0, estimatePanel(h).indexOf('>')), /\sopen(?:\s|$|=)/);
  assertBondDeadline(h, deadline);
  h.api.lock();
});

test('saved estimate percentages survive a new locked page and revalidation without persisting account or NAV data', async () => {
  const storage = new Map();
  const h = harness(undefined, { storage });
  h.start();
  configureEstimateFixture(h);
  submitNavEstimates(h, { '005698': '+1.25', '016701': '-0.5' });
  assert.match(estimateInput(h, '005698'), /value="1\.25"/);
  assert.match(estimateInput(h, '016701'), /value="0\.5"/);
  assert.match(estimateDirectionInput(h, '016701'), /value="down"/);
  const payload = JSON.parse(storage.get(NAV_ESTIMATE_STORAGE_KEY));
  assert.deepEqual(Object.keys(payload).sort(), ['entries', 'version']);
  assert.equal(payload.entries.length, 2);
  for (const entry of payload.entries) assert.deepEqual(Object.keys(entry).sort(), ['change', 'code', 'date']);
  assert.equal(payload.entries.find(entry => entry.code === '005698').change, 0.0125);
  h.api.lock();
  assert.deepEqual(h.api.state.navEstimateEntries, []);
  assert.deepEqual(h.api.state.estimateDrafts, {});
  assert.deepEqual(h.api.state.estimateErrors, {});
  assert.equal(h.api.state.estimateDate, null);
  assert.equal(h.api.state.estimateLoaded, false);
  assert.doesNotMatch(h.app.innerHTML, /nav-estimate-form/);
  const next = harness('2026-01-08T02:01:00.000Z', { storage });
  assertLocked(next);
  assert.doesNotMatch(next.app.innerHTML, /nav-estimate-form/);
  await next.submit();
  assert.equal(next.api.state.navEstimateEntries.length, 2);
  assert.match(estimateInput(next, '005698'), /value="1\.25"/);
  assert.match(estimateInput(next, '016701'), /value="0\.5"/);
  assert.match(estimateDirectionInput(next, '016701'), /value="down"/);
  assert.deepEqual([...storage.keys()], [NAV_ESTIMATE_STORAGE_KEY]);
  next.api.lock();
});

test('a manual estimate updates current valuation and discipline triggers while keeping the official average annualization', () => {
  const h = harness();
  h.start();
  const history = configureEstimateFixture(h), fund = FUNDS[0], code = fund.code;
  const navBefore = structuredClone(h.api.state.nav), valuationBefore = structuredClone(h.api.valuation(code));
  const fundsBefore = structuredClone(h.api.state.funds);
  const ledgerBefore = structuredClone(h.api.ledger(code)), reserveBefore = structuredClone(h.api.bondReserveCheck());
  const annualBefore = calculateNavAnnualized(history), alertBefore = h.api.annualDisciplineAlert(code);
  const annualMarkup = html => html.match(/<strong\b[^>]*data-nav-annualized[^>]*>[\s\S]*?<\/strong>/)?.[0];
  const displayedBefore = annualMarkup(h.api.fundRegions(fund));
  assert.ok(displayedBefore, 'the comparison must use the rendered full-history annualization');
  submitNavEstimates(h, { [code]: '175' });
  const chart = h.api.sparkline(history, code, resolveNavRange(history));
  const points = chartAttribute(chart, 'data-nav-points');
  const manual = points.find(point => point.estimated);
  assert.equal(manual.date, '2026-01-07');
  assert.ok(Math.abs(manual.nav - 3.3) < 1e-12);
  assert.match(chart, /class="nav-chart-estimated-curve"[^>]*stroke-dasharray=/);
  assert.match(chart, /class="nav-chart-estimated-point"/);
  assert.deepEqual(h.api.state.nav, navBefore);
  const valuationAfter = h.api.valuation(code), ledgerAfter = h.api.ledger(code);
  assert.equal(valuationAfter.date, '2026-01-07');
  assert.equal(valuationAfter.estimated, true);
  assert.ok(Math.abs(valuationAfter.nav - manual.nav) < 1e-12);
  assert.notEqual(valuationAfter.nav, valuationBefore.nav);
  assert.equal(ledgerAfter.summary.valuationDate, '2026-01-07');
  assert.ok(Math.abs(ledgerAfter.summary.marketValue - ledgerBefore.summary.marketValue * 2.75) < 1e-12);
  for (const key of ['shares', 'principal', 'totalInvested', 'totalRecovered']) assert.equal(ledgerAfter.summary[key], ledgerBefore.summary[key]);
  const historicalRows = result => result.rows.map(({ date, nav, type, status }) => ({ date, nav, type, status }));
  assert.deepEqual(historicalRows(ledgerAfter), historicalRows(ledgerBefore));
  assert.deepEqual(h.api.state.funds, fundsBefore);
  assert.notEqual(h.api.bondReserveCheck().ratio, reserveBefore.ratio);
  assert.equal(calculateNavAnnualized(h.api.state.nav[code].history), annualBefore);
  assert.equal(annualMarkup(h.api.fundRegions(fund)), displayedBefore, 'manual estimate does not change average annualization');
  assert.doesNotMatch(h.api.navPanel(fund), /data-nav-annualized|class="nav-annualized"/);
  assert.notEqual(h.api.annualDisciplineAlert(code), alertBefore);
  assert.match(h.api.annualDisciplineAlert(code), /data-rule="annual-profit-100"/);
  const chartHeading = h.api.navPanel(fund).split('<div id="nav-chart-')[0];
  assert.doesNotMatch(chartHeading, /估算|预估/);
  h.api.lock();
});

test('latest public charts extend a blank pending tail to today while historic and last-month selections keep their original domain', () => {
  const h = harness();
  h.start();
  const history = configureEstimateFixture(h), code = FUNDS[0].code;
  const latest = h.api.sparkline(history, code, resolveNavRange(history));
  const domain = chartAttribute(latest, 'data-nav-domain');
  assert.deepEqual({ start: domain.start, end: domain.end, lastPublished: domain.lastPublished }, {
    start: '2024-01-01', end: '2026-01-08', lastPublished: '2026-01-06',
  });
  assert.ok(domain.left >= 0 && domain.left < domain.right && domain.right <= 100);
  assert.match(latest, /nav-chart-pending-region/);
  assert.match(latest, /nav-chart-pending-label[^>]*>待更新</);
  assert.ok(chartAttribute(latest, 'data-nav-points').every(point => point.date <= '2026-01-06' && !point.estimated));
  const historic = h.api.sparkline(history.slice(0, -1), code, { preset: 'manual' });
  assert.equal(chartAttribute(historic, 'data-nav-domain'), null);
  assert.doesNotMatch(historic, /nav-chart-pending-region|nav-chart-estimated-curve/);
  const lastMonth = h.api.sparkline(history, code, { preset: 'last-month' });
  assert.equal(chartAttribute(lastMonth, 'data-nav-domain'), null);
  h.api.lock();
});

test('an official quote refresh removes the replaced local estimate, renders a solid observation and disables yesterday input', async () => {
  const fixture = refreshingHarness(), { h } = fixture;
  await h.submit();
  await flushMicrotasks();
  await h.api.dataRefresh.check();
  submitNavEstimates(h, { '005698': '2.5' });
  assert.equal(h.api.state.navEstimateEntries.length, 1);
  h.api.state.estimateDrafts['005698'] = '8';
  h.api.state.estimateDirections['005698'] = 'down';
  h.api.state.estimateErrors['005698'] = 'synthetic obsolete draft error';
  const deadline = h.api.state.deadline;
  fixture.setSnapshot('synthetic-official-estimate-replacement');
  fixture.setQuoteReader(code => ({ code, history: [{ date: '2026-01-02', nav: 2 }, { date: '2026-01-07', nav: 2.2 }] }));
  await h.api.dataRefresh.check();
  assert.deepEqual(h.api.state.navEstimateEntries, []);
  assert.equal(Object.hasOwn(h.api.state.estimateDrafts, '005698'), false);
  assert.equal(Object.hasOwn(h.api.state.estimateDirections, '005698'), false);
  assert.equal(Object.hasOwn(h.api.state.estimateErrors, '005698'), false);
  assert.deepEqual(JSON.parse(h.storage.get(NAV_ESTIMATE_STORAGE_KEY)).entries, []);
  assert.match(estimateInput(h, '005698'), /\sdisabled/);
  assert.match(estimatePanel(h), /已更新/);
  const chart = h.api.sparkline(h.api.state.nav['005698'].history, '005698');
  assert.doesNotMatch(chart, /nav-chart-estimated-curve|nav-chart-estimated-point/);
  assert.match(chart, /class="nav-chart-curve"/);
  const replacement = chartAttribute(chart, 'data-nav-points').find(point => point.date === '2026-01-07');
  assert.equal(replacement.nav, 2.2);
  assert.ok(!replacement.estimated);
  assert.equal(h.api.valuation('005698').date, '2026-01-07');
  assertBondDeadline(h, deadline);
  h.api.lock();
});

test('clearing a saved input deletes only that manual estimate and restores the pending chart tail', () => {
  const h = harness();
  h.start();
  const history = configureEstimateFixture(h);
  submitNavEstimates(h, { '005698': '1.5', '016701': '-0.75' });
  submitNavEstimates(h, { '005698': '' });
  assert.deepEqual(h.api.state.navEstimateEntries.map(entry => entry.code), ['016701']);
  assert.deepEqual(JSON.parse(h.storage.get(NAV_ESTIMATE_STORAGE_KEY)).entries.map(entry => entry.code), ['016701']);
  assert.match(estimateInput(h, '005698'), /value=""/);
  const chart = h.api.sparkline(history, '005698');
  assert.doesNotMatch(chart, /nav-chart-estimated-curve|nav-chart-estimated-point/);
  assert.match(chart, /nav-chart-pending-region/);
  h.api.lock();
});

for (const invalid of ['-100', '-100.01', '1e2', 'NaN', '1/2']) test(`invalid manual estimate ${invalid} does not partially save another fund or show success`, () => {
  const h = harness();
  h.start();
  configureEstimateFixture(h);
  submitNavEstimates(h, { '005698': '1.25', '016701': invalid });
  assert.deepEqual(h.api.state.navEstimateEntries, []);
  assert.equal(h.storage.has(NAV_ESTIMATE_STORAGE_KEY), false);
  assert.equal(h.toast.textContent, '');
  assert.ok(h.api.state.estimateErrors['016701']);
  assert.equal(h.api.state.estimateDrafts['016701'], invalid);
  assert.match(estimateInput(h, '016701'), /aria-invalid="true"/);
  h.api.lock();
});

for (const denyRead of [false, true]) test(`estimate storage ${denyRead ? 'read denial' : 'write failure'} never reports a successful save or loses the draft`, () => {
  const h = harness(undefined, { storage: {
    getItem() { if (denyRead) throw new Error('synthetic storage denied'); return null; },
    setItem() { throw new Error('synthetic storage full'); },
  } });
  h.start();
  configureEstimateFixture(h);
  if (denyRead) {
    assert.equal(h.api.state.estimateStorageAvailable, false);
    assert.match(estimatePanel(h), /估值暂不可用/);
    assert.match(estimateInput(h, '005698'), /\sdisabled/);
  }
  submitNavEstimates(h, { '005698': '1.25' });
  assert.deepEqual(h.api.state.navEstimateEntries, []);
  assert.equal(h.api.state.estimateDrafts['005698'], '1.25');
  assert.ok(h.api.state.estimateErrors['005698']);
  assert.equal(h.toast.textContent, '');
  assert.match(estimatePanel(h), /本机保存失败/);
  h.api.lock();
});

test('estimate edits never extend the Beijing deadline and an expired submit clears memory while retaining rate-only storage', () => {
  const h = harness();
  h.start();
  configureEstimateFixture(h);
  const deadline = h.api.state.deadline;
  h.clock.advanceWithoutCallbacks(11000);
  submitNavEstimates(h, { '005698': '1.25' });
  assertBondDeadline(h, deadline);
  const saved = h.storage.get(NAV_ESTIMATE_STORAGE_KEY);
  h.click('theme');
  h.clock.advanceWithoutCallbacks(deadline - h.clock.now);
  submitNavEstimates(h, { '005698': '2.5' });
  assertLocked(h);
  assert.deepEqual(h.api.state.navEstimateEntries, []);
  assert.deepEqual(h.api.state.estimateDrafts, {});
  assert.deepEqual(h.api.state.estimateErrors, {});
  assert.equal(h.api.state.estimateLoaded, false);
  assert.equal(h.api.state.estimateDate, null);
  assert.doesNotMatch(h.app.innerHTML, /nav-estimate-form|nav-chart-estimated/);
  assert.equal(h.storage.get(NAV_ESTIMATE_STORAGE_KEY), saved);
  assert.deepEqual([...h.storage.keys()].sort(), [NAV_ESTIMATE_STORAGE_KEY, 'fund-ledger-theme'].sort());
  for (const entry of JSON.parse(saved).entries) assert.deepEqual(Object.keys(entry).sort(), ['change', 'code', 'date']);
});

function configureHomeAddFixture(h) {
  const byCode = code => FUNDS.find(fund => fund.code === code);
  const triggered = byCode('005698'), belowThreshold = byCode('270023');
  const noTrade = byCode('016701'), negativeAnnual = byCode('006373');
  for (const fund of FUNDS) {
    const latestNav = fund.code === belowThreshold.code ? 3.8 : 3;
    h.api.state.nav[fund.code] = { history: [
      { date: '2010-01-01', nav: fund.code === negativeAnnual.code ? 5 : 1 },
      { date: '2025-12-31', nav: 4 }, { date: '2026-01-02', nav: 4 }, { date: '2026-01-06', nav: latestNav },
    ] };
    h.api.state.funds[fund.code] = {
      transactions: fund.code === noTrade.code ? [] : [
        { id: `synthetic-home-add-${fund.code}`, date: '2026-01-02', type: 'buy', status: 'confirmed', nav: 4, shares: 1, fee: 0 },
        { date: '2026-01-05', type: 'buy', status: 'pending' },
        { date: '2026-01-06', type: 'sell', status: 'cancelled' },
      ],
      mode: 'profit-first', rate: null, incomplete: false, sourceNote: 'synthetic add rule fixture',
    };
  }
  h.api.render();
  return { triggered, belowThreshold, noTrade, negativeAnnual };
}

function homeAddRule(h) {
  return h.app.innerHTML.match(/<article\b[^>]*data-discipline="add-discipline"[\s\S]*?<\/article>/)?.[0] || '';
}

test('home add discipline names only a triggered fund and shows public decline, threshold and date details beneath the fixed rule', () => {
  const h = harness();
  h.start();
  const { triggered, belowThreshold, noTrade, negativeAnnual } = configureHomeAddFixture(h);
  const rule = homeAddRule(h);
  assert.match(rule, /<strong class="discipline-emphasis discipline-number">1万元<\/strong>/);
  assert.match(rule, /class="add-discipline-matches"/);
  assert.equal((rule.match(/data-add-fund=/g) || []).length, 1);
  assert.ok(rule.includes(`data-add-fund="${triggered.code}"`));
  assert.ok(rule.includes(`href="#/fund/${triggered.code}?section=add-discipline"`));
  assert.match(rule, /上次交易节点后跌幅/);
  assert.ok(rule.includes(triggered.name));
  assert.match(rule, /25(?:\.00)?%/);
  assert.match(rule, /阈值|门槛|倍平均年化/);
  assert.match(rule, /2026-01-06/);
  for (const fund of [belowThreshold, noTrade, negativeAnnual]) assert.ok(!rule.includes(`data-add-fund="${fund.code}"`));
  assert.ok(rule.indexOf('add-discipline-matches') > rule.indexOf('data-discipline="add-discipline-decline"'));
  const matches = rule.slice(rule.indexOf('class="add-discipline-matches"'));
  assert.doesNotMatch(matches, /当前市值|持有份额|交易金额|累计投入|剩余本金|本笔/);
  h.api.lock();
});

test('manual NAV estimates recalculate the home add matches using the latest merged value', () => {
  const h = harness();
  h.start();
  const { triggered, belowThreshold } = configureHomeAddFixture(h);
  const before = homeAddRule(h);
  submitNavEstimates(h, { [triggered.code]: '100', [belowThreshold.code]: '-50' });
  assert.equal(h.api.state.navEstimateEntries.length, 2);
  assert.notEqual(homeAddRule(h), before);
  assert.ok(!homeAddRule(h).includes(`data-add-fund="${triggered.code}"`));
  assert.ok(homeAddRule(h).includes(`data-add-fund="${belowThreshold.code}"`));
  const chart = h.api.sparkline(h.api.state.nav[belowThreshold.code].history, belowThreshold.code);
  assert.match(chart, /nav-chart-estimated-curve/);
  h.api.lock();
});

test('add discipline deep links focus clause 7.1 once and return to the home rule without stealing focus on redraw', () => {
  const h = harness(), calls = [];
  const querySelector = h.document.querySelector.bind(h.document);
  const code = '005698';
  const targets = [`#fund-${code}-add-discipline`, '[data-discipline="add-discipline"]'];
  h.document.querySelector = selector => targets.includes(selector) ? {
    focus(settings) { calls.push({ method: 'focus', selector, settings }); },
    scrollIntoView(settings) { calls.push({ method: 'scrollIntoView', selector, settings }); },
  } : querySelector(selector);
  h.start();
  configureHomeAddFixture(h);
  const deadline = h.api.state.deadline;
  h.location.hash = `#/fund/${code}?section=add-discipline`;
  h.windowEvents.get('hashchange')();
  const clause = h.app.innerHTML.match(new RegExp(`<p\\b(?=[^>]*id="fund-${code}-add-discipline")(?=[^>]*data-rule="add-discipline-decline")[^>]*>[\\s\\S]*?<\\/p>`))?.[0] || '';
  assert.match(clause, /tabindex="-1"/);
  assert.match(clause, /<small>7\.1<\/small>/);
  assert.match(h.app.innerHTML, /href="#\/\?section=add-discipline"/);
  const alert = h.app.innerHTML.match(/<aside\b[^>]*class="[^"]*annual-discipline-alert[^"]*"[\s\S]*?<\/aside>/)?.[0] || '';
  assert.match(alert, /class="annual-discipline-alert"/);
  assert.doesNotMatch(alert, /exposure-route-alert|add-route-alert|discipline-route-alert/);
  assert.deepEqual(calls, [
    { method: 'focus', selector: targets[0], settings: { preventScroll: true } },
    { method: 'scrollIntoView', selector: targets[0], settings: { block: 'center', behavior: 'instant' } },
  ]);
  h.api.render();
  assert.equal(calls.length, 2);
  h.location.hash = '#/?section=add-discipline';
  h.windowEvents.get('hashchange')();
  assert.match(homeAddRule(h).slice(0, homeAddRule(h).indexOf('>')), /tabindex="-1"/);
  assert.deepEqual(calls.slice(-2), [
    { method: 'focus', selector: targets[1], settings: { preventScroll: true } },
    { method: 'scrollIntoView', selector: targets[1], settings: { block: 'center', behavior: 'instant' } },
  ]);
  h.api.render();
  assert.equal(calls.length, 4);
  assert.deepEqual(h.scrollCalls, []);
  assertBondDeadline(h, deadline);
  h.api.lock();
});

test('a public quote recovery removes the home add match without deleting the permanent add rule or extending the session', async () => {
  const fixture = refreshingHarness(), { h } = fixture;
  const triggeredCode = FUNDS[0].code;
  const publicQuotes = (code, latest) => ({ code, history: [
    { date: '2010-01-01', nav: 0.5 }, { date: '2025-12-31', nav: 2 },
    { date: '2026-01-01', nav: 2 }, { date: '2026-01-06', nav: code === triggeredCode ? latest : 2 },
  ] });
  fixture.setQuoteReader(code => publicQuotes(code, 1.5));
  await h.submit();
  await flushMicrotasks();
  await h.api.dataRefresh.check();
  assert.ok(homeAddRule(h).includes(`data-add-fund="${triggeredCode}"`));
  assert.equal((homeAddRule(h).match(/data-add-fund=/g) || []).length, 1);
  const deadline = h.api.state.deadline;
  fixture.setSnapshot('synthetic-add-quote-recovered');
  fixture.setQuoteReader(code => publicQuotes(code, 2));
  await h.api.dataRefresh.check();
  assert.doesNotMatch(homeAddRule(h), /add-discipline-matches|data-add-fund=/);
  assert.match(homeAddRule(h), /data-discipline="add-discipline-decline"/);
  assert.match(homeAddRule(h), /1万元/);
  assertBondDeadline(h, deadline);
  h.api.lock();
});

test('date range interaction leaves full-history annualization in basic information and never writes it into the chart panel', () => {
  const h = harness();
  h.start();
  configureEstimateFixture(h);
  const fund = FUNDS[0];
  h.location.hash = `#/fund/${fund.code}`;
  h.api.render();
  const information = h.api.fundRegions(fund);
  assert.match(information, /data-nav-annualized/);
  const { fields } = installRangePanel(h);
  h.click('nav-period', { fund: fund.code, period: '1m' });
  assert.equal(h.api.fundRegions(fund), information);
  assert.equal(fields.has('[data-nav-annualized]'), false);
  assert.doesNotMatch(h.api.navPanel(fund), /data-nav-annualized|class="nav-annualized"/);
  h.api.lock();
});

test('triggered home add cards apply half the fixed budget only to the fund below the US exposure rule', () => {
  const h = harness();
  h.start();
  configureHomeAddFixture(h);
  const usRule = h.api.state.disciplines.find(entry => entry.id === 'us-exposure');
  assert.equal(evaluateUsExposure(usRule, REGION_DATA['005698']).status, 'below');
  assert.equal(evaluateUsExposure(usRule, REGION_DATA['270023']).status, 'met');
  h.api.state.nav['270023'].history.at(-1).nav = 3;
  h.api.render();
  const rule = homeAddRule(h);
  const card = code => rule.match(new RegExp(`data-add-fund="${code}"[\\s\\S]*?<\\/a>`))?.[0] || '';
  const below = card('005698'), met = card('270023');
  assert.ok(below, 'the below-threshold fund has its own linked public rule card');
  assert.ok(met, 'the conforming fund has its own linked public rule card');
  assert.match(below.replace(/<[^>]*>/g, ''), /5,?000\s*元|0\.5\s*万元/);
  assert.match(met.replace(/<[^>]*>/g, ''), /10,?000\s*元|1\s*万\s*元/);
  assert.match(below, /section=add-discipline/);
  assert.match(met, /section=add-discipline/);
  assert.doesNotMatch(below + met, /当前市值|持有份额|账户金额|累计投入/);
  h.api.lock();
});

test('fund-specific profit actions double selling for low US exposure while preserving the 100 percent trigger', () => {
  const h = harness();
  h.start();
  const history = (firstDate, firstNav, lastNav) => [
    { date: firstDate, nav: firstNav }, { date: '2025-12-31', nav: 1 },
    { date: '2026-01-02', nav: 1 }, { date: '2026-01-07', nav: lastNav },
  ];
  const originalRules = structuredClone(h.api.state.disciplines);
  const clause = (code, id, points) => {
    h.api.state.nav[code] = { history: points };
    const alert = h.api.annualDisciplineAlert(code);
    const raw = alert.match(new RegExp(`<p\\b[^>]*data-rule="${id}"[^>]*>[\\s\\S]*?<\\/p>`))?.[0] || '';
    return raw.replace(/<[^>]*>/g, '').replace(/\s+/g, '');
  };
  const moderateHistory = history('2020-01-01', 1, 1.5);
  assert.match(clause('005698', 'annual-profit-multiple', moderateHistory), /3倍.*减仓40%/);
  assert.match(clause('270023', 'annual-profit-multiple', moderateHistory), /3倍.*减仓20%/);
  const absoluteHistory = history('2025-01-01', 0.1, 2);
  assert.match(clause('005698', 'annual-profit-100', absoluteHistory), /100%.*全部卖出/);
  assert.match(clause('270023', 'annual-profit-100', absoluteHistory), /100%.*清除本金\/卖出一半持仓，选金额大的/);
  assert.equal(clause('005698', 'annual-profit-100', history('2025-01-01', 0.1, 1.9999)), '');
  assert.equal(clause('270023', 'annual-profit-100', history('2025-01-01', 0.1, 1.9999)), '');
  assert.deepEqual(h.api.state.disciplines, originalRules, 'derived fund actions never rewrite the standing shared rules');
  h.api.lock();
});

test('yesterday estimate rows expose a direction switch and save an absolute value with the selected sign', () => {
  const h = harness();
  h.start();
  configureEstimateFixture(h);
  const code = '005698';
  assert.equal((estimatePanel(h).match(/data-action="estimate-direction"/g) || []).length, 4);
  const switches = estimatePanel(h).match(/<button\b[^>]*data-action="estimate-direction"[^>]*>/g) || [];
  assert.ok(switches.every(button => /role="switch"/.test(button)));
  assert.match(estimateDirectionInput(h, code), /value="up"/);
  submitNavEstimates(h, { [code]: '+1.25' }, { [code]: 'down' });
  assert.equal(h.api.state.navEstimateEntries.find(entry => entry.code === code).change, -0.0125);
  assert.match(estimateInput(h, code), /value="1\.25"/);
  assert.match(estimateDirectionInput(h, code), /value="down"/);
  submitNavEstimates(h, { [code]: '-1.25' }, { [code]: 'up' });
  assert.equal(h.api.state.navEstimateEntries.find(entry => entry.code === code).change, 0.0125);
  assert.match(estimateInput(h, code), /value="1\.25"/);
  assert.match(estimateDirectionInput(h, code), /value="up"/);
  h.api.lock();
});

for (const percent of ['100', '125']) test(`the downward switch rejects ${percent} percent before saving and preserves the prior estimate`, () => {
  const h = harness();
  h.start();
  configureEstimateFixture(h);
  submitNavEstimates(h, { '005698': '1.25' }, { '005698': 'down' });
  const previous = h.storage.get(NAV_ESTIMATE_STORAGE_KEY);
  h.toast.textContent = '';
  submitNavEstimates(h, { '005698': percent }, { '005698': 'down' });
  assert.equal(h.storage.get(NAV_ESTIMATE_STORAGE_KEY), previous);
  assert.equal(h.api.state.navEstimateEntries.find(entry => entry.code === '005698').change, -0.0125);
  assert.ok(h.api.state.estimateErrors['005698']);
  assert.equal(h.toast.textContent, '');
  assert.match(estimateDirectionInput(h, '005698'), /value="down"/);
  h.api.lock();
});

test('desktop and bottom navigation, estimate rows and holding rows all retain the requested fund order', () => {
  const h = harness();
  h.start();
  const expected = ['016701', '006373', '270023', '005698'];
  for (const navClass of ['desktop-nav', 'bottom-nav']) {
    const navigation = h.app.innerHTML.match(new RegExp(`<nav\\b[^>]*class="${navClass}"[^>]*>[\\s\\S]*?<\\/nav>`))?.[0] || '';
    assert.deepEqual([...navigation.matchAll(/href="#\/fund\/(\d{6})"/g)].map(match => match[1]), expected);
  }
  assert.deepEqual([...estimatePanel(h).matchAll(/name="estimate-(\d{6})"/g)].map(match => match[1]), expected);
  const holdingList = h.app.innerHTML.match(/<ul\b[^>]*class="holding-duration-list"[\s\S]*?<\/ul>/)?.[0] || '';
  assert.deepEqual([...holdingList.matchAll(/data-holding-fund="(\d{6})"/g)].map(match => match[1]), expected);
  h.api.lock();
});

test('direction clicks and signed paste update the active row in place without redrawing the form or renewing the session', () => {
  const h = harness();
  h.start();
  configureEstimateFixture(h);
  const code = '005698', hidden = { value: 'up' }, attributes = {};
  const button = {
    dataset: { action: 'estimate-direction', code, direction: 'up' },
    setAttribute(name, value) { attributes[name] = value; },
    closest(selector) { return selector === '.estimate-row' ? row : null; },
  };
  const row = { querySelector: selector => selector === '.estimate-direction' ? button : selector === `[name="direction-${code}"]` ? hidden : null };
  const initialHtml = h.app.innerHTML, deadline = h.api.state.deadline;
  h.api.actionClick({ preventDefault() {}, target: { closest: selector => selector === '[data-action]' ? button : null } });
  assert.equal(button.dataset.direction, 'down');
  assert.equal(hidden.value, 'down');
  assert.equal(attributes['aria-checked'], 'false');
  assert.equal(h.api.state.estimateDirections[code], 'down');
  assert.equal(h.app.innerHTML, initialHtml);
  const input = {
    name: `estimate-${code}`, value: '-2.5',
    closest: selector => selector === '.estimate-row' ? row : selector === '#nav-estimate-form' ? {} : null,
  };
  h.documentEvents.get('input')({ target: input });
  assert.equal(input.value, '2.5');
  assert.equal(hidden.value, 'down');
  assert.equal(h.api.state.estimateDrafts[code], '2.5');
  input.value = '+0.5';
  h.documentEvents.get('input')({ target: input });
  assert.equal(input.value, '0.5');
  assert.equal(hidden.value, 'up');
  assert.equal(attributes['aria-checked'], 'true');
  assert.equal(h.api.state.estimateDirections[code], 'up');
  assert.equal(h.app.innerHTML, initialHtml);
  assertBondDeadline(h, deadline);
  h.api.lock();
  assert.deepEqual(h.api.state.estimateDirections, {});
});

function installAutoEstimateForm(h) {
  const rows = new Map(), inputs = new Map(), directions = new Map(), switches = new Map(), feedback = new Map();
  const form = { id: 'nav-estimate-form', elements: {} };
  const sections = new Map(['.discipline-sheet', '.site-header', '.bottom-nav'].map(selector => [selector, { outerHTML: '' }]));
  let connected = true;
  const classes = () => {
    const values = new Set();
    return { add: value => values.add(value), remove: value => values.delete(value), contains: value => values.has(value),
      toggle(value, enabled) { if (enabled ?? !values.has(value)) values.add(value); else values.delete(value); } };
  };
  for (const fund of FUNDS) {
    const code = fund.code;
    const saved = h.api.state.navEstimateEntries.find(entry => entry.code === code && entry.date === h.api.state.estimateDate);
    const initialDirection = h.api.state.estimateDirections[code] || (saved?.change < 0 ? 'down' : 'up');
    const hidden = { name: `direction-${code}`, value: initialDirection };
    const error = { id: `nav-estimate-${code}-error`, textContent: '', hidden: true };
    const attributes = new Map();
    let currentValue = Object.hasOwn(h.api.state.estimateDrafts, code) ? h.api.state.estimateDrafts[code] : saved ? String(Math.abs(saved.change * 100)) : '';
    const input = {
      id: `nav-estimate-${code}`, name: `estimate-${code}`, dataset: {}, selectionStart: currentValue.length, selectionEnd: currentValue.length,
      get value() { return currentValue; },
      set value(value) { currentValue = String(value); this.selectionStart = currentValue.length; this.selectionEnd = currentValue.length; },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      removeAttribute(name) { attributes.delete(name); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      focus() { h.document.activeElement = input; },
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
      closest(selector) { return !connected ? null : selector === '#nav-estimate-form' ? form : selector === '.estimate-row' ? row : null; },
    };
    const button = {
      dataset: { action: 'estimate-direction', code, direction: initialDirection }, attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); },
      closest(selector) { return connected && selector === '.estimate-row' ? row : null; },
    };
    const row = {
      dataset: { estimateFund: code }, classList: classes(),
      querySelector(selector) {
        if (!connected) return null;
        if (selector === '.estimate-direction') return button;
        if (selector.includes('estimate-error') || selector === `#${error.id}`) return error;
        if (selector.includes(`direction-${code}`)) return hidden;
        if (selector.includes(`estimate-${code}`) || selector === 'input:not([type="hidden"])') return input;
        return null;
      },
    };
    rows.set(code, row); inputs.set(code, input); directions.set(code, hidden); switches.set(code, button); feedback.set(code, error);
    form.elements[input.name] = input; form.elements[hidden.name] = hidden;
  }
  const originalAppQuery = h.app.querySelector?.bind(h.app) || (() => null);
  const originalDocumentQuery = h.document.querySelector.bind(h.document);
  const find = selector => {
    if (!connected) return null;
    if (selector === '#nav-estimate-form') return form;
    if (sections.has(selector)) return sections.get(selector);
    const code = /(?:data-estimate-fund="|nav-estimate-|estimate-|direction-)(\d{6})/.exec(selector)?.[1];
    if (!code) return null;
    if (selector.includes('estimate-error') || selector.endsWith('-error')) return feedback.get(code);
    if (selector.includes('data-estimate-fund')) return rows.get(code);
    if (selector.includes('direction-')) return directions.get(code);
    return inputs.get(code);
  };
  h.app.querySelector = selector => find(selector) || originalAppQuery(selector);
  h.document.querySelector = selector => find(selector) || originalDocumentQuery(selector);
  h.document.getElementById = id => find(`#${id}`);
  h.app.contains = candidate => connected && (candidate === form || [...rows.values(), ...inputs.values(), ...switches.values(), ...feedback.values()].includes(candidate));
  return {
    form, rows, inputs, directions, switches, feedback, sections,
    input(code, value, selection = null) {
      const input = inputs.get(code);
      input.value = value;
      if (selection) input.setSelectionRange(...selection);
      input.focus();
      h.documentEvents.get('input')({ target: input });
      return input;
    },
    direction(code) {
      const button = switches.get(code);
      h.api.actionClick({ preventDefault() {}, target: { closest: selector => selector === '[data-action]' ? button : null } });
    },
    disconnect() { connected = false; },
  };
}

test('estimate inputs auto-save after 600 ms without a save button, form redraw, focus loss or caret movement', async () => {
  const h = harness();
  h.start();
  configureEstimateFixture(h);
  assert.doesNotMatch(estimatePanel(h), /保存估值|type="submit"/);
  const ui = installAutoEstimateForm(h), initialHtml = h.app.innerHTML;
  const deadline = h.api.state.deadline;
  const input = ui.input('005698', '1.25', [1, 2]);
  h.clock.tick(599);
  await flushMicrotasks();
  assert.equal(h.storage.has(NAV_ESTIMATE_STORAGE_KEY), false);
  h.clock.tick(1);
  await flushMicrotasks();
  assert.equal(h.api.state.navEstimateEntries.find(entry => entry.code === '005698')?.change, 0.0125);
  assert.equal(JSON.parse(h.storage.get(NAV_ESTIMATE_STORAGE_KEY)).entries[0].change, 0.0125);
  assert.equal(h.app.innerHTML, initialHtml);
  assert.equal(h.document.activeElement, input);
  assert.equal(ui.form.elements['estimate-005698'], input);
  assert.equal(input.value, '1.25');
  assert.equal(input.selectionStart, 1);
  assert.equal(input.selectionEnd, 2);
  assert.equal(h.toast.textContent, '');
  assert.equal(Boolean(h.api.state.expandedPanels['nav-estimates']), false);
  assertBondDeadline(h, deadline);
  h.api.lock();
});

test('switching an existing estimate direction automatically saves the new sign without rewriting the amount', async () => {
  const h = harness();
  h.start();
  configureEstimateFixture(h);
  submitNavEstimates(h, { '005698': '1.25' });
  h.toast.textContent = '';
  const ui = installAutoEstimateForm(h), input = ui.inputs.get('005698');
  input.setSelectionRange(2, 2);
  const initialHtml = h.app.innerHTML;
  ui.direction('005698');
  assert.equal(ui.directions.get('005698').value, 'down');
  h.clock.tick(600);
  await flushMicrotasks();
  assert.equal(h.api.state.navEstimateEntries.find(entry => entry.code === '005698')?.change, -0.0125);
  assert.equal(input.value, '1.25');
  assert.equal(input.selectionStart, 2);
  ui.direction('005698');
  h.clock.tick(600);
  await flushMicrotasks();
  assert.equal(h.api.state.navEstimateEntries.find(entry => entry.code === '005698')?.change, 0.0125);
  assert.equal(h.app.innerHTML, initialHtml);
  assert.equal(h.toast.textContent, '');
  h.api.lock();
});

test('independent auto-save timers retain an invalid fund estimate while another fund saves and show inline feedback', async () => {
  const h = harness();
  h.start();
  configureEstimateFixture(h);
  submitNavEstimates(h, { '005698': '1.25' });
  const ui = installAutoEstimateForm(h);
  ui.input('005698', '-100');
  h.clock.tick(300);
  ui.input('270023', '2.5');
  h.clock.tick(300);
  await flushMicrotasks();
  assert.equal(h.api.state.navEstimateEntries.find(entry => entry.code === '005698')?.change, 0.0125);
  assert.ok(h.api.state.estimateErrors['005698']);
  assert.equal(ui.inputs.get('005698').getAttribute('aria-invalid'), 'true');
  assert.equal(ui.feedback.get('005698').hidden, false);
  assert.ok(ui.feedback.get('005698').textContent);
  assert.equal(h.api.state.navEstimateEntries.some(entry => entry.code === '270023'), false);
  h.clock.tick(300);
  await flushMicrotasks();
  assert.equal(h.api.state.navEstimateEntries.find(entry => entry.code === '270023')?.change, 0.025);
  assert.equal(h.api.state.navEstimateEntries.find(entry => entry.code === '005698')?.change, 0.0125);
  assert.ok(h.api.state.estimateErrors['005698']);
  h.api.lock();
});

test('clearing an estimate automatically removes the saved rate and leaves its field untouched', async () => {
  const h = harness();
  h.start();
  configureEstimateFixture(h);
  submitNavEstimates(h, { '005698': '1.25' });
  const ui = installAutoEstimateForm(h), initialHtml = h.app.innerHTML;
  const input = ui.input('005698', '');
  h.clock.tick(600);
  await flushMicrotasks();
  assert.equal(h.api.state.navEstimateEntries.some(entry => entry.code === '005698'), false);
  assert.equal(JSON.parse(h.storage.get(NAV_ESTIMATE_STORAGE_KEY)).entries.some(entry => entry.code === '005698'), false);
  assert.equal(input.value, '');
  assert.equal(input.selectionStart, 0);
  assert.equal(ui.feedback.get('005698').hidden, true);
  assert.equal(h.app.innerHTML, initialHtml);
  h.api.lock();
});

test('a pending auto-save follows its draft across a route change without drawing an estimate form into the fund page', async () => {
  const h = harness();
  h.start();
  configureEstimateFixture(h);
  const ui = installAutoEstimateForm(h);
  ui.input('005698', '1.25');
  h.clock.tick(300);
  h.location.hash = '#/fund/270023';
  h.windowEvents.get('hashchange')();
  ui.disconnect();
  h.clock.tick(300);
  await flushMicrotasks();
  assert.equal(h.api.state.navEstimateEntries.find(entry => entry.code === '005698')?.change, 0.0125);
  assert.match(h.app.innerHTML, /class="workspace fund-page/);
  assert.doesNotMatch(h.app.innerHTML, /id="nav-estimate-form"/);
  h.location.hash = '#/';
  h.windowEvents.get('hashchange')();
  assert.match(estimateInput(h, '005698'), /value="1\.25"/);
  h.api.lock();
});

test('locking cancels every pending estimate auto-save and delayed callbacks cannot write after the session expires', async () => {
  const h = harness();
  h.start();
  configureEstimateFixture(h);
  const ui = installAutoEstimateForm(h);
  ui.input('005698', '1.25');
  ui.input('270023', '2.5');
  h.clock.tick(300);
  h.api.lock();
  h.clock.tick(1000);
  await flushMicrotasks();
  assertLocked(h);
  assert.equal(h.storage.has(NAV_ESTIMATE_STORAGE_KEY), false);
  assert.deepEqual(h.api.state.navEstimateEntries, []);
  assert.deepEqual(h.api.state.estimateDrafts, {});
  assert.deepEqual(h.api.state.estimateDirections, {});
  assert.equal(h.clock.timers.size, 0);
  const expired = harness('2026-01-08T15:59:59.700Z');
  expired.start();
  configureEstimateFixture(expired);
  installAutoEstimateForm(expired).input('005698', '1.25');
  expired.clock.advanceWithoutCallbacks(600);
  expired.clock.tick(0);
  await flushMicrotasks();
  assertLocked(expired);
  assert.equal(expired.storage.has(NAV_ESTIMATE_STORAGE_KEY), false);
  assert.deepEqual(expired.api.state.navEstimateEntries, []);
});

for (const savedDown of [false, true]) test(`${savedDown ? 'clearing a saved downward estimate' : 'selecting down before entering an estimate'} retains the chosen direction after the empty auto-save`, async () => {
  const h = harness();
  h.start();
  configureEstimateFixture(h);
  if (savedDown) submitNavEstimates(h, { '005698': '-1.25' });
  const ui = installAutoEstimateForm(h);
  if (savedDown) ui.input('005698', '');
  else ui.direction('005698');
  h.clock.tick(600);
  await flushMicrotasks();
  assert.equal(h.api.state.navEstimateEntries.some(entry => entry.code === '005698'), false);
  assert.equal(h.api.state.estimateDirections['005698'], 'down');
  assert.equal(ui.directions.get('005698').value, 'down');
  ui.input('005698', '2.5');
  h.clock.tick(600);
  await flushMicrotasks();
  assert.equal(h.api.state.navEstimateEntries.find(entry => entry.code === '005698')?.change, -0.025);
  h.api.lock();
});

test('automatic estimates update the home discipline fragments while retaining the active input and its caret', async () => {
  const h = harness();
  h.start();
  configureHomeAddFixture(h);
  const ui = installAutoEstimateForm(h), initialHtml = h.app.innerHTML;
  ui.direction('270023');
  const input = ui.input('270023', '50', [1, 1]);
  h.clock.tick(600);
  await flushMicrotasks();
  let rules = ui.sections.get('.discipline-sheet').outerHTML;
  assert.ok(rules.includes('data-add-fund="270023"'));
  assert.ok(rules.includes('data-add-fund="005698"'));
  assert.match(ui.sections.get('.site-header').outerHTML, /class="site-header"/);
  assert.match(ui.sections.get('.bottom-nav').outerHTML, /class="bottom-nav"/);
  assert.equal(h.app.innerHTML, initialHtml);
  assert.equal(h.document.activeElement, input);
  assert.equal(input.selectionStart, 1);
  ui.input('005698', '100');
  h.clock.tick(600);
  await flushMicrotasks();
  rules = ui.sections.get('.discipline-sheet').outerHTML;
  assert.ok(rules.includes('data-add-fund="270023"'));
  assert.ok(!rules.includes('data-add-fund="005698"'));
  assert.equal(h.app.innerHTML, initialHtml);
  h.api.lock();
});

test('interval profit includes in-range cash flows and fees without mistaking deposits or withdrawals for gains', () => {
  const h = harness(); h.start();
  const code = '005698';
  const buy = (date, shares, nav, fee = 0) => ({ date, type: 'buy', status: 'confirmed', shares, nav, fee, amount: shares * nav + fee });
  h.api.state.funds[code] = { mode: 'profit-first', incomplete: false, transactions: [
    buy('2026-01-01', 100, 1, 1), buy('2026-01-04', 10, 1.1, 1),
    { date: '2026-01-05', type: 'sell', status: 'confirmed', shares: 20, nav: 1.2, fee: .5, amount: 23.5 },
    { date: '2026-01-06', type: 'dividend', status: 'confirmed', shares: 0, nav: 1.2, fee: 0, amount: 2 },
    { date: '2026-01-06', type: 'buy', status: 'pending', amount: 999 },
  ] };
  const range = { startDate: '2026-01-03', endDate: '2026-01-06', startNav: 1.1, endNav: 1.2 };
  assert.equal(h.api.navRangeProfit(code, range), 11.5);
  h.api.state.funds[code].mode = 'principal-first';
  assert.equal(h.api.navRangeProfit(code, range), 11.5);
  h.api.state.funds[code].incomplete = true;
  assert.equal(h.api.navRangeProfit(code, range), null);
  h.api.state.funds[code].incomplete = false;
  h.api.state.funds[code].transactions = [buy('2026-01-03', 100, 1.1, 1)];
  assert.equal(h.api.navRangeProfit(code, range), 9);
  assert.equal(h.api.navRangeProfit(code, { ...range, endDate: range.startDate, endNav: range.startNav }), -1);
  h.api.lock();
});

test('interval profit headline follows the selected dates, hides private figures, and uses red gains and green losses', () => {
  const h = harness(); h.start(); const fund = FUNDS.find(fund => fund.code === '005698');
  h.api.state.funds[fund.code] = { mode: 'profit-first', incomplete: false, transactions: [{ date: '2026-01-01', type: 'buy', status: 'confirmed', shares: 100, nav: 1, fee: 0, amount: 100 }] };
  h.api.state.nav[fund.code] = { history: [{ date: '2026-01-01', nav: 1 }, { date: '2026-01-03', nav: 1.1 }, { date: '2026-01-06', nav: 1.2 }] };
  h.api.state.navRanges[fund.code] = { from: '2026-01-03', to: '2026-01-06' };
  const hidden = h.api.navPanel(fund).split('<div id="nav-chart-')[0];
  assert.match(hidden, /区间盈亏（元）/); assert.match(hidden, /data-nav-value><span class="masked"/);
  assert.doesNotMatch(hidden, /\+10\.00/);
  h.api.state.visible = true;
  assert.match(h.api.navPanel(fund), /class="num positive"[^>]*data-nav-value>\+10\.00</);
  h.api.state.nav[fund.code].history[2].nav = 1;
  assert.match(h.api.navPanel(fund), /class="num negative"[^>]*data-nav-value>-10\.00</);
  h.location.hash = `#/fund/${fund.code}`; const { fields } = installRangePanel(h);
  h.click('nav-period', { fund: fund.code, period: 'all' });
  assert.equal(fields.get('[data-nav-value]').innerHTML, '0.00');
  h.api.state.funds[fund.code].incomplete = true;
  assert.match(h.api.navPanel(fund), /data-nav-value>待核验</);
  h.api.lock();
});

test('chart measurement updates headline profit and percentage live, resets on clear and honors privacy', () => {
  const h = harness(); h.start(); const code = '005698';
  h.api.state.visible = true;
  h.api.state.funds[code] = { mode: 'profit-first', incomplete: false, transactions: [{ date: '2026-01-01', type: 'buy', status: 'confirmed', shares: 100, nav: 1, fee: 0, amount: 100 }] };
  h.api.state.nav[code] = { history: [{ date: '2026-01-01', nav: 1 }, { date: '2026-01-03', nav: 1.1 }, { date: '2026-01-06', nav: 1.2 }] };
  h.location.hash = `#/fund/${code}`;
  const { fields } = installRangePanel(h), panel = h.app.querySelector(`.nav-panel[data-fund="${code}"]`);
  panel.dataset = { fund: code };
  const chart = { closest: () => panel }, start = { date: '2026-01-03', nav: 1.1 };
  h.api.updateNavMeasurement({ chart, start, end: { date: '2026-01-06', nav: 1.2 } });
  assert.equal(fields.get('[data-nav-value]').innerHTML, '+10.00');
  assert.equal(fields.get('[data-nav-change]').textContent, '+9.09%');
  h.api.updateNavMeasurement({ chart, start, end: { date: '2026-01-06', nav: 1 } });
  assert.equal(fields.get('[data-nav-value]').innerHTML, '-10.00');
  assert.match(fields.get('[data-nav-value]').className, /negative/);
  h.api.state.visible = false;
  h.api.updateNavMeasurement({ chart, start, end: { date: '2026-01-06', nav: 1.2 } });
  assert.match(fields.get('[data-nav-value]').innerHTML, /masked/);
  h.api.state.visible = true;
  h.api.updateNavMeasurement({ chart, start: null, end: null });
  assert.equal(fields.get('[data-nav-value]').innerHTML, '+20.00');
  h.api.updateNavMeasurement({ chart, start, end: null, pending: true });
  assert.equal(fields.get('[data-nav-value]').innerHTML, '待更新');
  h.api.lock();
});

test('unconfirmed fund purchases increase only market value and leave profit, returns and shares unchanged', () => {
  const h = harness(); h.start(); const code = '005698';
  const transactions = [{ id: 'buy', date: '2026-01-01', type: 'buy', status: 'confirmed', amount: 100, nav: 1, shares: 100, fee: 0 }];
  h.api.state.funds[code] = { mode: 'profit-first', incomplete: false, transactions };
  h.api.state.nav[code] = { history: [{ date: '2026-01-06', nav: 1.1 }] };
  const before = h.api.ledger(code).summary;
  transactions.push({ id: 'pending-buy', date: '2026-01-07', type: 'buy', status: 'pending', sourceStatus: 'processing', amount: 30 });
  const after = h.api.ledger(code).summary;
  assert.equal(after.marketValue, before.marketValue + 30);
  for (const field of ['shares', 'principal', 'holdingProfit', 'holdingReturn', 'totalProfit', 'totalReturn']) assert.equal(after[field], before[field]);
  h.api.lock();
});

test('four-fund allocation fills the bar, labels each fund, respects privacy and never normalizes a partial total', () => {
  const h = harness(); h.start();
  const scope = h.app.innerHTML.match(/<article[^>]*data-discipline="equity-scope"[\s\S]*?<\/article>/)?.[0];
  assert.ok(scope); assert.doesNotMatch(scope, /目前暂定/);
  assert.match(scope, /基金持仓分布/);
  for (const [index, fund] of FUNDS.entries()) {
    h.api.state.funds[fund.code] = { mode: 'profit-first', incomplete: false, transactions: [{ date: '2026-01-01', type: 'buy', status: 'confirmed', shares: 1, nav: 1, amount: 1, fee: 0 }] };
    h.api.state.nav[fund.code] = { history: [{ date: '2026-01-01', nav: 1 }, { date: '2026-01-06', nav: index + 1 }] };
  }
  const hidden = h.api.equityHoldingDistribution();
  assert.match(hidden, /data-equity-allocation="available"/);
  assert.equal((hidden.match(/class="masked"/g) || []).length, 4);
  assert.equal([...hidden.matchAll(/style="width:([\d.]+)%"/g)].reduce((sum, match) => sum + Number(match[1]), 0), 100);
  h.api.state.visible = true;
  const visible = h.api.equityHoldingDistribution();
  for (const fund of FUNDS) assert.ok(visible.includes(`href="#/fund/${fund.code}"`));
  assert.match(visible, /40\.0%/); assert.match(visible, /4\.00<small>元/);
  h.api.state.funds[FUNDS[0].code].incomplete = true;
  const partial = h.api.equityHoldingDistribution();
  assert.match(partial, /data-equity-allocation="unavailable"/);
  assert.doesNotMatch(partial, /style="width:|合计 100%/);
  h.api.lock();
});

test('the chart headline and dashed endpoint share the merged estimate while a historic selection remains official', () => {
  const h = harness();
  h.start();
  configureEstimateFixture(h);
  const fund = FUNDS.find(entry => entry.code === '005698');
  submitNavEstimates(h, { [fund.code]: '175' });
  h.api.state.visible = true;
  const current = h.api.navPanel(fund);
  assert.match(current, /data-nav-value>\+2\.20</);
  assert.match(current, /data-nav-date>净值日期 2026-01-07</);
  assert.equal(chartAttribute(current, 'data-nav-points').find(point => point.estimated)?.nav, 3.3);
  assert.ok(current.includes(`data-nav-count>${chartAttribute(current, 'data-nav-points').length} 期<`));
  assert.doesNotMatch(current.split('<div id="nav-chart-')[0], /估算|预估/);
  h.api.state.navRanges[fund.code] = { from: '2024-01-01', to: '2025-01-01' };
  const historic = h.api.navPanel(fund);
  assert.match(historic, /data-nav-value>0\.00</);
  assert.match(historic, /data-nav-date>净值日期 2025-01-01</);
  assert.ok(chartAttribute(historic, 'data-nav-points').every(point => !point.estimated));
  assert.doesNotMatch(historic, /nav-chart-estimated-curve|nav-chart-pending-region/);
  h.location.hash = `#/fund/${fund.code}`;
  const { fields } = installRangePanel(h);
  h.click('nav-period', { fund: fund.code, period: 'all' });
  assert.equal(fields.get('[data-nav-value]').innerHTML, '+2.20');
  assert.equal(fields.get('[data-nav-date]').textContent, '净值日期 2026-01-07');
  h.api.lock();
});

test('an arriving official NAV replaces a manual value and recalculates both the holding valuation and home add signal', async () => {
  const fixture = refreshingHarness(), { h } = fixture;
  const quote = (code, replacement = false) => ({ code, history: [
    { date: '2010-01-01', nav: 0.5 }, { date: '2025-12-31', nav: 2 },
    { date: '2026-01-01', nav: 2 }, { date: '2026-01-06', nav: code === '005698' ? 1.9 : 2 },
    ...(replacement ? [{ date: '2026-01-07', nav: 2 }] : []),
  ] });
  fixture.setQuoteReader(code => quote(code));
  await h.submit();
  await flushMicrotasks();
  await h.api.dataRefresh.check();
  assert.doesNotMatch(homeAddRule(h), /data-add-fund="005698"/);
  submitNavEstimates(h, { '005698': '-25' });
  assert.ok(homeAddRule(h).includes('data-add-fund="005698"'));
  assert.ok(Math.abs(h.api.valuation('005698').nav - 1.425) < 1e-12);
  assert.ok(Math.abs(h.api.ledger('005698').summary.marketValue - 1.425) <= 0.0051, 'holding value uses the merged estimate with normal cent rounding');
  assert.equal(h.api.ledger('005698').summary.valuationDate, '2026-01-07');
  fixture.setSnapshot('synthetic-merged-value-official-replacement');
  fixture.setQuoteReader(code => quote(code, true));
  await h.api.dataRefresh.check();
  assert.equal(h.api.state.navEstimateEntries.some(entry => entry.code === '005698'), false);
  assert.equal(h.api.valuation('005698').nav, 2);
  assert.equal(h.api.valuation('005698').estimated, false);
  assert.equal(h.api.ledger('005698').summary.marketValue, 2);
  assert.doesNotMatch(homeAddRule(h), /data-add-fund="005698"/);
  h.api.lock();
});

test('a manual current valuation never supplies a missing official NAV for an unverified historical application', () => {
  const h = harness('2026-05-13T02:00:00.000Z');
  h.start();
  configureEstimateFixture(h);
  const code = '006373';
  const application = { id: 'synthetic-missing-official-nav', date: '', submittedAt: '2026-05-12 14:00:00', type: 'buy', amount: 20.03, nav: null, shares: null, fee: null, status: 'pending', sourceStatus: 'unverified' };
  h.api.state.funds[code] = { transactions: [application], mode: 'profit-first', rate: null, incomplete: true, sourceNote: 'synthetic pending application' };
  h.api.state.nav[code] = { history: [{ date: '2026-05-08', nav: 2.5 }, { date: '2026-05-11', nav: 4 }] };
  h.api.render();
  assert.equal(h.api.ledger(code).summary.includedCount, 0);
  submitNavEstimates(h, { [code]: '25' });
  assert.equal(h.api.valuation(code).date, '2026-05-12');
  assert.equal(h.api.valuation(code).nav, 5);
  const result = h.api.ledger(code);
  assert.equal(result.summary.includedCount, 0);
  assert.equal(result.rows[0].status, 'pending');
  assert.deepEqual(h.api.state.funds[code].transactions, [application]);
  assert.ok(h.api.state.nav[code].history.every(point => point.date !== '2026-05-12'));
  h.api.lock();
});

function fundDisclosure(h, name, code = '005698') {
  return h.app.innerHTML.match(new RegExp(`<details\\b(?=[^>]*data-panel="${name}")(?=[^>]*data-fund="${code}")[^>]*>[\\s\\S]*?<\\/details>`))?.[0] || '';
}

function disclosureIsOpen(markup) {
  return /\sopen(?:\s|$|=)/.test(markup.slice(0, markup.indexOf('>')));
}

test('public quotes and basic information start expanded and independently preserve close and reopen choices', () => {
  const h = harness();
  h.start();
  configureEstimateFixture(h);
  h.location.hash = '#/fund/005698';
  h.api.render();
  const names = ['fund-basics', 'nav-quotes'];
  for (const name of names) {
    const markup = fundDisclosure(h, name);
    assert.match(markup, /class="[^"]*\bpanel-disclosure\b/);
    assert.match(markup, /<summary class="panel-toggle">/);
    assert.match(markup, /<div class="panel-content">/);
    assert.equal(disclosureIsOpen(markup), true);
  }
  const panels = names.map(panel => ({ dataset: { panel, fund: '005698' }, open: true, matches: selector => selector === 'details[data-panel]' }));
  h.app.contains = candidate => panels.includes(candidate);
  h.app.querySelectorAll = selector => selector.startsWith('details[data-panel][data-fund=') ? panels : [];
  const deadline = h.api.state.deadline;
  for (const panel of panels) {
    panel.open = false;
    h.documentEvents.get('toggle')({ target: panel });
    h.api.render();
    assert.equal(h.api.state.expandedPanels[panel.dataset.panel], false);
    assert.equal(disclosureIsOpen(fundDisclosure(h, panel.dataset.panel)), false);
  }
  h.api.render();
  assert.ok(names.every(name => !disclosureIsOpen(fundDisclosure(h, name))));
  for (const panel of panels) {
    panel.open = true;
    h.documentEvents.get('toggle')({ target: panel });
    h.api.render();
    assert.equal(h.api.state.expandedPanels[panel.dataset.panel], true);
    assert.equal(disclosureIsOpen(fundDisclosure(h, panel.dataset.panel)), true);
  }
  assertBondDeadline(h, deadline);
  h.api.lock();
});

test('switching between fund pages retains the reading section despite different heading heights and keeps panel choices', () => {
  const h = harness(undefined, { scrollY: 640 });
  h.start();
  h.location.hash = '#/fund/005698';
  h.windowEvents.get('hashchange')();
  h.scrollCalls.length = 0;
  const panels = [
    { dataset: { panel: 'fund-basics', fund: '005698' }, open: false },
    { dataset: { panel: 'nav-quotes', fund: '005698' }, open: true },
    { dataset: { panel: 'holdings', fund: '005698' }, open: true },
    { dataset: { panel: 'transactions', fund: '005698' }, open: false },
  ];
  h.app.querySelectorAll = selector => selector === 'details[data-panel][data-fund="005698"]' ? panels : [];
  const nav = {
    get offsetTop() { return h.app.innerHTML.includes('data-fund="006373"') ? 1280 : 1000; },
    offsetHeight: 700, offsetWidth: 500, dataset: { panel: 'nav-quotes' }, closest() { return this; },
  };
  h.app.querySelector = selector => selector === '.fund-page' ? {} : selector === '.site-header' ? { getBoundingClientRect: () => ({ bottom: 90 }) }
    : selector === '[data-panel="nav-quotes"]' ? nav : null;
  h.location.hash = '#/fund/006373';
  h.windowEvents.get('hashchange')();
  assert.deepEqual(h.scrollCalls, [{ top: 920, behavior: 'instant' }], 'the NAV panel keeps the same viewport position after its document position changes');
  assert.deepEqual(h.api.state.expandedPanels, { 'fund-basics': false, 'nav-quotes': true, holdings: true, transactions: false });
  assert.equal(disclosureIsOpen(fundDisclosure(h, 'fund-basics', '006373')), false);
  assert.equal(disclosureIsOpen(fundDisclosure(h, 'nav-quotes', '006373')), true);
  assert.equal(disclosureIsOpen(fundDisclosure(h, 'holdings', '006373')), true);
  assert.equal(disclosureIsOpen(fundDisclosure(h, 'transactions', '006373')), false);

  h.location.hash = '#/';
  h.windowEvents.get('hashchange')();
  assert.deepEqual(h.scrollCalls.at(-1), { top: 640, behavior: 'instant' }, 'returning home restores its previous position');
  assert.deepEqual(h.api.state.expandedPanels, {}, 'fund panel choices do not leak into another route type');
  h.api.lock();
});

test('equity and bond pages remember their reading position across route switches', () => {
  const h = harness();
  h.start();
  h.location.hash = '#/fund/005698';
  h.windowEvents.get('hashchange')();
  h.scrollCalls.length = 0;
  h.window.scrollY = 800;
  h.location.hash = '#/bonds';
  h.windowEvents.get('hashchange')();
  assert.deepEqual(h.scrollCalls.at(-1), { top: 0, behavior: 'instant' }, 'first visit to bonds starts at the top');
  h.window.scrollY = 200;
  h.location.hash = '#/fund/005698';
  h.windowEvents.get('hashchange')();
  assert.deepEqual(h.scrollCalls.at(-1), { top: 800, behavior: 'instant' }, 'returning to the equity page restores its position');
  h.location.hash = '#/bonds';
  h.windowEvents.get('hashchange')();
  assert.deepEqual(h.scrollCalls.at(-1), { top: 200, behavior: 'instant' }, 'returning to bonds restores its position');
  h.api.lock();
});

test('a US exposure deep link opens closed basic information after capturing old DOM state and locates its row only once', () => {
  const h = harness(), code = '005698', calls = [];
  h.start();
  configureEstimateFixture(h);
  h.location.hash = `#/fund/${code}`;
  h.api.state.expandedPanels['fund-basics'] = false;
  h.api.state.expandedPanels['nav-quotes'] = false;
  h.api.render();
  assert.equal(disclosureIsOpen(fundDisclosure(h, 'fund-basics')), false);
  const panels = ['fund-basics', 'nav-quotes'].map(panel => ({ dataset: { panel, fund: code }, open: false }));
  h.app.querySelectorAll = selector => selector.startsWith('details[data-panel][data-fund=') ? panels : [];
  const querySelector = h.document.querySelector.bind(h.document);
  h.document.querySelector = selector => selector === `#fund-${code}-us-exposure` ? {
    focus(settings) { calls.push({ method: 'focus', settings }); },
    scrollIntoView(settings) { calls.push({ method: 'scrollIntoView', settings }); },
  } : querySelector(selector);
  const deadline = h.api.state.deadline;
  h.location.hash = `#/fund/${code}?section=us-exposure`;
  h.windowEvents.get('hashchange')();
  assert.equal(disclosureIsOpen(fundDisclosure(h, 'fund-basics')), true);
  assert.equal(disclosureIsOpen(fundDisclosure(h, 'nav-quotes')), false);
  assert.deepEqual(calls, [
    { method: 'focus', settings: { preventScroll: true } },
    { method: 'scrollIntoView', settings: { block: 'center', behavior: 'instant' } },
  ]);
  panels[0].open = true;
  h.api.render();
  assert.equal(disclosureIsOpen(fundDisclosure(h, 'fund-basics')), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(h.scrollCalls, []);
  assertBondDeadline(h, deadline);
  h.api.lock();
});

test('local mode exposes the + registration card stack and inferred transfer', () => {
  const h = harness();
  h.api.state.localMode = true;
  h.start();
  assert.match(h.app.innerHTML, /data-action="trade-open"/);
  assert.match(h.app.innerHTML, /同步交易记录/);
  h.click('trade-open');
  assert.match(h.app.innerHTML, /id="trade-form"/);
  assert.match(h.app.innerHTML, /data-trade-mode="buy"/);
  assert.match(h.app.innerHTML, /name="amount"/);
  assert.match(h.app.innerHTML, /class="trade-calendar"/);
  h.click('trade-calendar-pick', { date: '2026-10-23' });
  assert.equal(h.api.state.tradeDraft.date, '2026/10/23');
  assert.match(h.app.innerHTML, /class="trade-calendar"/);
  h.click('trade-pick', { side: 'right', code: '016701' });
  h.click('trade-pick', { side: 'left', code: '005698' });
  assert.match(h.app.innerHTML, /name="outShares"/);
  assert.match(h.app.innerHTML, /name="targetCode"/);
  assert.match(h.app.innerHTML, /data-trade-mode="transfer"/);
  assert.match(h.app.innerHTML, /class="trade-board"/);
  assert.match(h.app.innerHTML, /class="trade-stack"/);
  assert.match(h.app.innerHTML, /data-action="trade-reverse"/);
  const beforeWheel = h.api.state.tradeDraft.code;
  const stack = { dataset: { stack: 'left' } };
  h.api.useTradeWheel({ target: { closest: selector => selector === '.trade-stack' ? stack : null }, deltaY: 1, preventDefault() {} });
  assert.notEqual(h.api.state.tradeDraft.code, beforeWheel);
  const outCode = h.api.state.tradeDraft.code, inCode = h.api.state.tradeDraft.targetCode;
  h.api.state.tradeDraft.outShares = '10';
  h.click('trade-reverse');
  assert.equal(h.api.state.tradeDraft.code, inCode);
  assert.equal(h.api.state.tradeDraft.targetCode, outCode);
  assert.equal(h.api.state.tradeDraft.outShares, '');
  h.api.state.transferCounts = { awaiting: 0, review: 1, reviewed: 0, total: 1 };
  h.api.state.tradeOpen = false;
  h.api.state.tradeDraft = null;
  h.api.render();
  assert.match(h.app.innerHTML, /transfer-banner/);
  assert.match(h.app.innerHTML, /1 笔转换待二次核对/);
  assert.match(h.app.innerHTML, /class="nav-todo"/);
  assert.match(h.app.innerHTML, /nav-todo-badge/);
  assert.doesNotMatch(h.app.innerHTML, /nav-add-badge/);
  h.api.lock();
});

