import { calculateLedger, describeModeEffect } from './engine.js?v=20261020-mode-explanation';
import { createRefreshController } from './refresh-controller.js';
import { unlockErrorMessage } from './unlock-errors.js';
import { NAV_PERIODS, recentNavPeriod, resolveNavRange, moveNavBoundary, resolveNavSliderDomain } from './nav-range.js';
import { renderNavChart } from './nav-chart.js?v=20261019-transactions';
import { calculateNavAnnualized, evaluateAnnualDiscipline, evaluateAddDiscipline, getNavDisciplineGap } from './nav-annualized.js?v=20261019-sheet-discipline';
import { setupNavChartInteractions } from './nav-interaction.js?v=20261019-gap-scroll-markers';
import { setupNavSliderInteractions } from './nav-slider.js';
import { calculateTransactionPerformance } from './transaction-performance.js';
import { FUNDS, FUND_CODES } from './funds.js?v=20261019-collapsible-panels';
import { DISCIPLINE_ENTRIES } from './discipline.js?v=20261019-sheet-discipline';
import { createDisciplineSync } from './discipline-sync.js';
import { REGION_DATA } from './region-data.js';
import { evaluateUsExposure } from './us-exposure.js';
import { calculatePortfolioAllocation, evaluateHoldingLimit } from './portfolio-allocation.js';
import { calculateHoldingDuration, createHoldingDurationScale } from './holding-duration.js';
import { openBondStore } from './bond-store.js?v=20261019-bond-calculated-lots';
import { calculateBondSummary } from './bond-model.js';
import { evaluateBondReserve } from './bond-reserve.js';
import { calculateBondHoldingDuration } from './bond-holding-duration.js?v=20261019-bond-calculated-lots';
import { renderBondsPage } from './bonds-view.js?v=20261019-bond-calculated-lots';
import { getEstimateDates, parseEstimatePercent, buildEstimatedNav } from './nav-estimates.js';
import { loadNavEstimates, saveNavEstimates } from './nav-estimate-store.js';
import { renderEstimatePanel } from './estimate-panel.js?v=20261019-collapsible-panels';
import { getDisciplineActions, adjustDisciplineRule } from './discipline-actions.js?v=20261019-sheet-discipline';
import { getNavChartDisplay } from './nav-display.js';
import { createFundViewportKeeper } from './viewport-anchor.js?v=20261019-flow-header';
const TYPE_NAMES = { buy: '买入', sip: '定投', sell: '卖出', reinvest: '红利再投', dividend: '现金分红', 'transfer-in': '转换转入' };
const STATUS_NAMES = { confirmed: '已确认', estimated: '历史估算', pending: '待确认', cancelled: '撤单', failed: '交易失败', closed: '交易关闭' };
const state = { unlocked: false, visible: false, funds: {}, nav: {}, disciplines: DISCIPLINE_ENTRIES, bonds: [], freeCashFlow: null, cashEditing: false, cashDraft: null, cashBusy: false, cashError: '', bondUnavailable: true, bondUpdatedAt: null, navPreset: null, navCycles: { months: '1m', years: '1y' }, navRanges: {}, navDomains: {}, navVisuals: {}, expandedPanels: {}, limit: 25, filter: 'all', statusFilter: 'all', gateBusy: false, createdAt: null, deadline: 0, dayDeadline: 0, sessionDay: null };
const app = document.querySelector('#app');
const fundViewport = createFundViewportKeeper({ root: app, view: window });
Object.assign(state, { navEstimateEntries: [], estimateDrafts: {}, estimateDirections: {}, estimateErrors: {}, estimateStorageAvailable: true, estimateDate: null, estimateLoaded: false });
const icons = {
  book: '<path d="M6 3h13v18H6zM3 6h5M3 12h5M3 18h5M11 8h5M11 12h5M11 16h3"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="m3 3 18 18M10.6 5.1A11 11 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3 4M6.2 6.2C3.5 8.3 2 12 2 12s3.5 7 10 7a12 12 0 0 0 5.8-1.5M10 10a3 3 0 0 0 4 4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8.5 12l2.5 2.5 4.5-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  moon: '<path d="M20.7 13A8.8 8.8 0 0 1 11 3.3 9 9 0 1 0 20.7 13Z"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
  down: '<path d="M12 4v16m-5-5 5 5 5-5"/>',
  up: '<path d="M12 20V4m-5 5 5-5 5 5"/>',
  home: '<path d="m3 10 9-7 9 7v11H3zM9 21v-8h6v8"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  coins: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 4 16 4 16 0V6M4 12v6c0 4 16 4 16 0v-6"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.book}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const number = (value, digits = 2) => Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value) : '—';
const sensitive = (value, digits = 2) => !Number.isFinite(value) ? '—' : state.visible ? esc(number(value, digits)) : '<span class="masked" aria-label="已隐藏">••••••</span>';
const percent = value => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${number(value * 100)}%` : '—';
const signClass = value => Number.isFinite(value) ? value > 0 ? 'positive' : value < 0 ? 'negative' : '' : '';
const fundCodeFromHash = hash => {
  const code = /^#\/fund\/(\d{6})(?:\?[^#]*)?$/.exec(String(hash || ''))?.[1];
  return FUND_CODES.includes(code) ? code : null;
};
const sectionFromHash = hash => new URLSearchParams(String(hash || '').split('?')[1] || '').get('section');
const selectedCode = () => fundCodeFromHash(location.hash);
const routeSection = () => sectionFromHash(location.hash);
const selectedFund = () => FUNDS.find(fund => fund.code === selectedCode());
const selectedBonds = () => /^#\/bonds(?:\?[^#]*)?$/.test(location.hash);
const getBook = code => state.funds[code] ||= { transactions: [], mode: 'profit-first', rate: FUNDS.find(fund => fund.code === code).rate, incomplete: false, sourceNote: '' };
const currentTheme = () => document.documentElement.dataset.theme;
const desktopPanelsOpen = () => matchMedia('(min-width: 761px)').matches;
const panelExpanded = (id, mobileDefault = false) => state.expandedPanels[id] ?? (desktopPanelsOpen() || mobileDefault);
let toastTimer;
let transitioning = false;
let activeTransition = null;
let sessionInterval = null;
let sessionTimeout = null;
let dailyCodeReader = null;
let unlockGeneration = 0;
let vaultSession = null;
let bondStore = null;
let dataVersionBaseline = null;
let navSliders = null;
let locatedRoute = null;
let lastRenderedRoute = location.hash;
// Fund pages restore their scroll position explicitly, so history traversal must not override it.
if (typeof history !== 'undefined' && 'scrollRestoration' in history) {
  try { history.scrollRestoration = 'manual'; } catch { /* Older browsers keep their default restoration. */ }
}
const estimateSaveTimers = new Map();
Object.assign(state, { bondHoldingLots: {}, bondTransactions: {}, bondExpanded: {}, cashUnavailable: false });
const holdingFractions = new Map();
const dataRefresh = createRefreshController({
  readVersion: async () => {
    if (dataVersionBaseline) { const version = dataVersionBaseline; dataVersionBaseline = null; return version; }
    return fetchDataVersion();
  },
  onChange: refreshCurrentData,
  isActive: () => state.unlocked && Boolean(vaultSession) && checkSession(),
  intervalMs: 5000, setIntervalFn: setInterval, clearIntervalFn: clearInterval,
});
const disciplineSync = createDisciplineSync({
  fetchFn: (...args) => fetch(...args),
  isActive: () => state.unlocked && checkSession(),
  onChange: entries => {
    state.disciplines = entries;
    const position = scrollY;
    render();
    scrollTo({ top: position, behavior: 'instant' });
  },
  intervalMs: 5000, setIntervalFn: setInterval, clearIntervalFn: clearInterval,
});

function stopSessionTimers() {
  clearInterval(sessionInterval);
  clearTimeout(sessionTimeout);
  sessionInterval = null;
  sessionTimeout = null;
}

function remainingTime() {
  const seconds = Math.max(0, Math.ceil((Math.min(state.deadline, state.dayDeadline || state.deadline) - Date.now()) / 1000));
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function updateSessionTimer() {
  const timer = document.querySelector('#session-timer');
  if (!timer) return;
  timer.textContent = `剩余 ${remainingTime()}`;
  timer.dataset.urgent = String(state.deadline - Date.now() <= 30000);
}

function checkSession() {
  if (!state.unlocked) return false;
  if (Date.now() >= Math.min(state.deadline, state.dayDeadline || state.deadline)) { lock('timeout'); return false; }
  if (!dailyCodeReader || dailyCodeReader() !== state.sessionDay) { lock('day-change'); return false; }
  updateSessionTimer();
  return true;
}

function startSession(day, getDailyCode) {
  stopSessionTimers();
  const now = Date.now();
  const dayLength = 24 * 60 * 60 * 1000;
  const beijingOffset = 8 * 60 * 60 * 1000;
  state.dayDeadline = (Math.floor((now + beijingOffset) / dayLength) + 1) * dayLength - beijingOffset;
  state.deadline = state.dayDeadline;
  state.sessionDay = day;
  dailyCodeReader = getDailyCode;
  sessionInterval = setInterval(checkSession, 1000);
  sessionTimeout = setTimeout(checkSession, state.dayDeadline - now);
}
function animateChange(update) {
  if (!document.startViewTransition || transitioning) { update(); return; }
  transitioning = true;
  const transition = document.startViewTransition(update);
  activeTransition = transition;
  transition.finished.catch(() => {}).finally(() => { transitioning = false; activeTransition = null; });
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#101825' : '#245bdc';
}
try { setTheme(localStorage.getItem('fund-ledger-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')); }
catch { setTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }

function toast(message) {
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('visible'), 3200);
}

function themeButton() {
  const dark = currentTheme() === 'dark';
  return `<button class="icon-button" type="button" data-action="theme" title="切换到${dark ? '白天' : '黑夜'}模式" aria-label="切换到${dark ? '白天' : '黑夜'}模式">${icon(dark ? 'sun' : 'moon')}</button>`;
}

function renderGate(notice = '') {
  fundViewport.cancel();
  document.title = '解锁 · 基金账本';
  app.innerHTML = `<main id="main" class="gate"><div class="gate-theme">${themeButton()}</div><div class="gate-content">
    <div class="brand"><span class="brand-mark">${icon('book')}</span>基金账本</div>
    <section class="gate-vision" aria-label="基金账本"><p class="observatory-eyebrow">PORTFOLIO OBSERVATORY</p><h2>以纪律，<span>穿越波动。</span></h2><p>记录每次选择 · 看清每段历程</p></section>
    <section class="gate-panel"><div class="gate-lock">${icon('lock')}</div><h1>解锁账本</h1>
      <form id="unlock-form" class="gate-form"><label for="vault-password">访问密码<input id="vault-password" name="password" type="password" inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" autocomplete="off" required aria-describedby="gate-error"></label>
        <button type="submit" class="button primary">解锁${icon('arrow')}</button><p id="gate-error" class="gate-error" role="alert">${esc(notice)}</p>
      </form>
    </section>
  </div></main>`;
}

async function unlock(event) {
  event.preventDefault();
  if (state.gateBusy) return;
  const generation = ++unlockGeneration;
  const isCurrent = () => generation === unlockGeneration;
  state.gateBusy = true;
  const form = event.target;
  const input = form.elements.password;
  const button = form.querySelector('button');
  const error = document.querySelector('#gate-error');
  error.textContent = '';
  button.disabled = true;
  button.textContent = '正在解锁…';
  let password = input.value;
  let openedSession = null;
  let openedBonds = null;
  let bondSnapshot = null;
  input.value = '';
  try {
    const { unlockVault, getDailyCode } = await import('./vault.js?v=20261018-refresh');
    if (!isCurrent()) { password = ''; return; }
    const sessionDay = getDailyCode();
    const baseline = await fetchDataVersion();
    if (!isCurrent()) { password = ''; return; }
    let vault = await unlockVault(password, { onSession: session => { openedSession = session; } });
    if (!isCurrent()) { password = ''; openedSession?.close(); return; }
    try {
      openedBonds = await openBondStore(password, { fetchFn: (...args) => fetch(...args) });
      bondSnapshot = openedBonds.getSnapshot();
    } catch { openedBonds?.close(); openedBonds = null; }
    password = '';
    if (!isCurrent()) { openedSession?.close(); openedBonds?.close(); return; }
    const initial = await readInitialSnapshot(vault, openedSession, baseline, openedBonds, bondSnapshot);
    if (!isCurrent()) { openedSession?.close(); openedBonds?.close(); return; }
    vault = initial.vault;
    bondSnapshot = initial.bondSnapshot;
    if (getDailyCode() !== sessionDay) throw new Error('day-changed');
    if (!vault || typeof vault.funds !== 'object') throw new Error('invalid');
    for (const fund of FUNDS) {
      const entry = vault.funds[fund.code] || {};
      const book = getBook(fund.code);
      book.transactions = (Array.isArray(entry.transactions) ? entry.transactions : []).map((tx, index) => ({ ...tx, id: tx.id || `${fund.code}-${index}` }));
      book.mode = entry.mode === 'principal-first' ? 'principal-first' : 'profit-first';
      book.incomplete = entry.incomplete === true;
      book.sourceNote = typeof entry.sourceNote === 'string' ? entry.sourceNote : '';
    }
    state.createdAt = vault.createdAt;
    vaultSession?.close();
    vaultSession = openedSession;
    bondStore?.close();
    bondStore = openedBonds;
    state.bonds = bondSnapshot?.bonds || [];
    state.bondHoldingLots = bondSnapshot?.holdingLots || {};
    state.bondTransactions = bondSnapshot?.transactions || {};
    state.cashUnavailable = bondSnapshot?.cashFlowUnavailable === true;
    state.bondExpanded = {};
    state.freeCashFlow = Number.isFinite(bondSnapshot?.freeCashFlow) ? bondSnapshot.freeCashFlow : null;
    state.cashEditing = false;
    state.cashDraft = null;
    state.cashBusy = false;
    state.cashError = '';
    state.bondUpdatedAt = bondSnapshot?.updatedAt || null;
    state.bondValuationDate = bondSnapshot?.valuationDate || null;
    state.bondUnavailable = !bondStore;
    dataVersionBaseline = initial.version || { revision: '__initial_unverified__' };
    state.nav = initial.nav;
    state.visible = false;
    state.unlocked = true;
    startSession(sessionDay, getDailyCode);
    render();
    disciplineSync.start();
    if (vaultSession) dataRefresh.start();
  } catch (error) {
    password = '';
    openedSession?.close();
    openedBonds?.close();
    if (!isCurrent()) return;
    dataRefresh.stop();
    disciplineSync.stop();
    vaultSession?.close();
    vaultSession = null;
    clearBondSession();
    dataVersionBaseline = null;
    stopSessionTimers();
    state.unlocked = false;
    state.visible = false;
    state.funds = {};
    state.createdAt = null;
    state.deadline = 0;
    state.dayDeadline = 0;
    state.sessionDay = null;
    dailyCodeReader = null;
    renderGate(unlockErrorMessage(error));
    document.querySelector('#vault-password').focus();
  } finally {
    password = '';
    if (isCurrent()) {
      state.gateBusy = false;
      if (!state.unlocked) { button.disabled = false; button.innerHTML = `解锁${icon('arrow')}`; }
    }
  }
}

function lock(reason = 'manual') {
  cancelEstimateSaves();
  locatedRoute = null;
  navSliders?.cancel();
  unlockGeneration += 1;
  state.gateBusy = false;
  dataRefresh.stop();
  disciplineSync.stop();
  vaultSession?.close();
  vaultSession = null;
  clearBondSession();
  dataVersionBaseline = null;
  activeTransition?.skipTransition();
  stopSessionTimers();
  state.unlocked = false;
  state.visible = false;
  state.funds = {};
  state.createdAt = null;
  state.deadline = 0;
  state.dayDeadline = 0;
  state.sessionDay = null;
  dailyCodeReader = null;
  state.filter = 'all';
  state.statusFilter = 'all';
  state.expandedPanels = {};
  state.navEstimateEntries = [];
  state.estimateDrafts = {};
  state.estimateDirections = {};
  state.estimateErrors = {};
  state.estimateDate = null;
  state.estimateLoaded = false;
  document.querySelector('#toast').classList.remove('visible');
  renderGate(reason === 'data-change' ? '请重新解锁。' : reason === 'timeout' || reason === 'day-change' ? '解锁已到期，请重新验证。' : '');
}

function clearBondSession() {
  bondStore?.close();
  bondStore = null;
  state.bonds = [];
  state.bondHoldingLots = {};
  state.bondTransactions = {};
  state.bondExpanded = {};
  state.cashUnavailable = true;
  state.freeCashFlow = null;
  state.cashEditing = false;
  state.cashDraft = null;
  state.cashBusy = false;
  state.cashError = '';
  state.bondUnavailable = true;
  state.bondUpdatedAt = null;
  state.bondValuationDate = null;
}

async function saveCashFlow(event) {
  event.preventDefault();
  if (!state.unlocked || !checkSession() || state.cashBusy || state.cashUnavailable || !bondStore) return;
  const raw = String(event.target.elements.freeCashFlow?.value ?? '').trim();
  state.cashDraft = raw;
  state.cashError = '';
  let value = null;
  if (raw) {
    if (!/^-?\d+(?:\.\d{1,2})?$/.test(raw)) {
      state.cashError = '请填写有效金额，最多两位小数。';
      render();
      return;
    }
    value = Number(raw);
    if (!Number.isFinite(value)) {
      state.cashError = '请填写有效金额，最多两位小数。';
      render();
      return;
    }
  }
  const store = bondStore, generation = unlockGeneration;
  state.cashBusy = true;
  state.cashError = '';
  render();
  try {
    const saved = await store.saveFreeCashFlow(value);
    if (generation !== unlockGeneration || store !== bondStore || !checkSession()) return;
    state.freeCashFlow = Number.isFinite(saved.freeCashFlow) ? saved.freeCashFlow : value;
    state.cashEditing = false;
    state.cashDraft = null;
    toast(value === null ? '自由现金流已清空' : '自由现金流已保存');
  } catch {
    if (generation === unlockGeneration && store === bondStore && checkSession()) state.cashError = '保存未成功，请检查输入后重试。';
  } finally {
    if (generation === unlockGeneration && store === bondStore && state.unlocked && checkSession()) {
      state.cashBusy = false;
      render();
    }
  }
}

async function fetchDataVersion() {
  try {
    const response = await fetch('./data/version.json', { cache: 'no-store' });
    if (!response.ok) return null;
    const version = await response.json();
    return typeof version?.revision === 'string' && version.revision ? version : null;
  } catch { return null; }
}

async function readPublicNav(code) {
  const response = await fetch(`./data/nav/${code}.json`, { cache: 'no-store' });
  if (!response.ok) throw new Error('unavailable');
  const result = await response.json();
  if (result.code !== code || !Array.isArray(result.history)) throw new Error('invalid');
  result.history = result.history.filter(point => /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.nav) && point.nav > 0).sort((a, b) => a.date.localeCompare(b.date));
  return result;
}

async function readInitialSnapshot(vault, session, initialVersion, initialBondStore = null, initialBonds = null) {
  let before = initialVersion;
  let currentVault = vault;
  let currentBonds = initialBonds;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const quotes = await Promise.all(FUNDS.map(async ({ code }) => {
      try { return [code, await readPublicNav(code)]; }
      catch { return [code, { history: [], unavailable: true }]; }
    }));
    const after = await fetchDataVersion();
    if ((!before && !after) || (before && after && before.revision === after.revision)) {
      return { vault: currentVault, nav: Object.fromEntries(quotes), version: after, bondSnapshot: currentBonds };
    }
    if (!after || !session) throw new Error('snapshot-unavailable');
    before = after;
    const refreshed = await Promise.all([session.refresh(), typeof initialBondStore?.refresh === 'function' ? initialBondStore.refresh() : currentBonds]);
    [currentVault, currentBonds] = refreshed;
  }
  throw new Error('snapshot-changing');
}

async function refreshCurrentData(version) {
  const generation = unlockGeneration;
  const session = vaultSession;
  if (!session || !state.unlocked || !checkSession()) return;
  let vault;
  let quotes;
  let bondSnapshot = null;
  const bondSession = bondStore;
  try {
    [vault, quotes, bondSnapshot] = await Promise.all([session.refresh(), Promise.all(FUNDS.map(fund => readPublicNav(fund.code))), typeof bondSession?.refresh === 'function' ? bondSession.refresh() : null]);
  } catch (error) {
    if (generation === unlockGeneration && error?.name === 'OperationError') lock('data-change');
    throw error;
  }
  const latest = await fetchDataVersion();
  if (!latest || latest.revision !== version.revision) throw new Error('snapshot-changed');
  if (generation !== unlockGeneration || session !== vaultSession || !checkSession()) return;
  if (!vault?.funds || typeof vault.funds !== 'object') throw new Error('invalid');
  const updatedBooks = FUNDS.map(fund => {
    const entry = vault.funds[fund.code];
    if (!entry || !Array.isArray(entry.transactions)) throw new Error('invalid');
    return { code: fund.code, transactions: entry.transactions.map((tx, index) => ({ ...tx, id: tx.id || `${fund.code}-${index}` })), incomplete: entry.incomplete === true, sourceNote: typeof entry.sourceNote === 'string' ? entry.sourceNote : '' };
  });
  for (const { code, ...book } of updatedBooks) Object.assign(getBook(code), book);
  if (bondSnapshot && bondSession === bondStore) {
    state.bonds = bondSnapshot.bonds;
    state.bondHoldingLots = bondSnapshot.holdingLots || {};
    state.bondTransactions = bondSnapshot.transactions || {};
    state.freeCashFlow = Number.isFinite(bondSnapshot.freeCashFlow) ? bondSnapshot.freeCashFlow : null;
    state.cashUnavailable = bondSnapshot.cashFlowUnavailable === true;
    state.bondUpdatedAt = bondSnapshot.updatedAt;
    state.bondValuationDate = bondSnapshot.valuationDate || null;
  }
  state.nav = Object.fromEntries(quotes.map(quote => [quote.code, quote]));
  state.createdAt = vault.createdAt;
  const position = scrollY;
  const expanded = [...app.querySelectorAll('.transaction-detail[open]')].map(detail => detail.dataset.id);
  render();
  app.querySelectorAll('.transaction-detail').forEach(detail => { if (expanded.includes(detail.dataset.id)) detail.open = true; });
  scrollTo({ top: position, behavior: 'instant' });
  toast('数据已更新');
}

async function loadPublicNav() {
  const generation = unlockGeneration;
  const quotes = {};
  await Promise.allSettled(FUNDS.map(async ({ code }) => {
    try {
      quotes[code] = await readPublicNav(code);
    } catch { quotes[code] = { history: [], unavailable: true }; }
  }));
  if (generation === unlockGeneration && state.unlocked && checkSession()) { state.nav = quotes; render(); }
}

function valuation(code) { return estimatedNav(code).points.at(-1) || null; }

const officialNav = code => state.nav[code]?.history || [];

function estimatedNav(code) {
  return buildEstimatedNav(state.nav[code]?.history || [], state.navEstimateEntries.filter(entry => entry.code === code), { now: new Date() });
}

function navEstimateStorage() {
  try { return localStorage; } catch { return null; }
}

function syncNavEstimates() {
  const now = new Date(), { yesterday } = getEstimateDates(now);
  if (!state.estimateLoaded) {
    const loaded = loadNavEstimates({ storage: navEstimateStorage(), now });
    state.navEstimateEntries = loaded.entries;
    state.estimateStorageAvailable = loaded.available;
    state.estimateLoaded = true;
  }
  const retained = FUNDS.flatMap(fund => estimatedNav(fund.code).pending.map(entry => ({ code: fund.code, ...entry })));
  if (JSON.stringify(retained) !== JSON.stringify(state.navEstimateEntries)) {
    state.navEstimateEntries = retained;
    if (state.estimateStorageAvailable) {
      try { saveNavEstimates(retained, { storage: navEstimateStorage(), now }); }
      catch { state.estimateStorageAvailable = false; }
    }
  }
  if (state.estimateDate !== yesterday) {
    cancelEstimateSaves();
    state.estimateDate = yesterday;
    state.estimateDrafts = {};
    state.estimateDirections = {};
    state.estimateErrors = {};
  }
  // Official observations win immediately, including while a form is being edited.
  for (const fund of FUNDS) {
    if (estimatedNav(fund.code).latestOfficialDate >= yesterday) {
      clearTimeout(estimateSaveTimers.get(fund.code));
      estimateSaveTimers.delete(fund.code);
      delete state.estimateDrafts[fund.code];
      delete state.estimateDirections[fund.code];
      delete state.estimateErrors[fund.code];
    }
  }
}

function estimateHomePanel() {
  const date = state.estimateDate;
  const funds = FUNDS.map(fund => {
    const data = estimatedNav(fund.code);
    const previous = data.points.filter(point => point.date < date).at(-1);
    return { code: fund.code, name: fund.name, short: fund.navLabel, baseDate: previous?.date || null, official: Boolean(data.latestOfficialDate && data.latestOfficialDate >= date) };
  });
  const saved = Object.fromEntries(state.navEstimateEntries.filter(entry => entry.date === date).map(entry => [entry.code, Number((entry.change * 100).toPrecision(12))]));
  return renderEstimatePanel({ date, funds, saved, drafts: state.estimateDrafts, directions: state.estimateDirections, errors: state.estimateErrors, open: panelExpanded('nav-estimates'), unavailable: !state.estimateStorageAvailable || !date });
}

function cancelEstimateSaves() {
  for (const timer of estimateSaveTimers.values()) clearTimeout(timer);
  estimateSaveTimers.clear();
}

function updateEstimateError(code) {
  const row = app.querySelector?.(`[data-estimate-fund="${code}"]`);
  if (!row) return;
  const message = state.estimateErrors[code] || '';
  row.classList.toggle('estimate-row-invalid', Boolean(message));
  const input = row.querySelector(`[name="estimate-${code}"]`);
  if (message) input?.setAttribute('aria-invalid', 'true');
  else input?.removeAttribute('aria-invalid');
  const error = row.querySelector('.estimate-error');
  if (error) { error.textContent = message; error.hidden = !message; }
}

function queueEstimateSave(code, delay = 600) {
  if (!FUND_CODES.includes(code) || !state.unlocked || !checkSession()) return;
  clearTimeout(estimateSaveTimers.get(code));
  const generation = unlockGeneration;
  const date = state.estimateDate;
  estimateSaveTimers.set(code, setTimeout(() => {
    estimateSaveTimers.delete(code);
    if (generation !== unlockGeneration || !state.unlocked || !checkSession() || state.estimateDate !== date) return;
    const saved = state.navEstimateEntries.find(entry => entry.code === code && entry.date === date);
    const value = Object.hasOwn(state.estimateDrafts, code) ? state.estimateDrafts[code] : saved ? String(Number((Math.abs(saved.change) * 100).toPrecision(12))) : '';
    const direction = state.estimateDirections[code] || (saved?.change < 0 ? 'down' : 'up');
    state.estimateDirections[code] = direction;
    saveNavEstimateEdits({ preventDefault() {}, target: { elements: { [`estimate-${code}`]: { value }, [`direction-${code}`]: { value: direction } } } }, { automatic: true, onlyCode: code });
  }, delay));
}

function refreshEstimateViews() {
  if (selectedFund() || selectedBonds()) { render(); return; }
  const reserve = bondReserveCheck();
  const sheet = app.querySelector?.('.discipline-sheet');
  if (sheet) sheet.outerHTML = homeRules(reserve);
  const siteHeader = app.querySelector?.('.site-header');
  if (siteHeader) siteHeader.outerHTML = header(null, reserve);
  const navigation = app.querySelector?.('.bottom-nav');
  if (navigation) navigation.outerHTML = bottomNav(null, reserve);
}

function saveNavEstimateEdits(event, { automatic = false, onlyCode = null } = {}) {
  event.preventDefault();
  if (!state.unlocked || !checkSession()) return;
  const date = getEstimateDates(new Date()).yesterday;
  if (!date || date !== state.estimateDate) { syncNavEstimates(); render(); return; }
  const drafts = automatic ? { ...state.estimateDrafts } : {}, errors = automatic ? { ...state.estimateErrors } : {};
  const next = state.navEstimateEntries.filter(entry => entry.date !== date || (onlyCode && entry.code !== onlyCode));
  let invalid = false;
  for (const fund of FUNDS.filter(fund => !onlyCode || fund.code === onlyCode)) {
    delete errors[fund.code];
    if (estimatedNav(fund.code).latestOfficialDate >= date) continue;
    const text = String(event.target.elements[`estimate-${fund.code}`]?.value ?? '').trim();
    drafts[fund.code] = text;
    if (!text) continue;
    const parsedChange = parseEstimatePercent(text);
    const direction = event.target.elements[`direction-${fund.code}`]?.value || state.estimateDirections[fund.code];
    const change = parsedChange === null ? null : direction === 'down' ? -Math.abs(parsedChange) : direction === 'up' ? Math.abs(parsedChange) : parsedChange;
    if (change === null || !Number.isFinite(change) || change <= -1) { errors[fund.code] = '请输入大于 -100% 的有效涨跌幅。'; invalid = true; continue; }
    const entry = { code: fund.code, date, change };
    const candidate = buildEstimatedNav(state.nav[fund.code]?.history || [], [...next.filter(item => item.code === fund.code), entry], { now: new Date() });
    if (candidate.latestOfficialDate && !candidate.points.some(point => point.date === date && point.estimated)) { errors[fund.code] = '估值超出可显示范围。'; invalid = true; }
    else next.push(entry);
  }
  state.estimateDrafts = drafts;
  state.estimateErrors = errors;
  if (!automatic) state.expandedPanels['nav-estimates'] = true;
  if (invalid || (!automatic && Object.keys(errors).length)) { if (automatic) updateEstimateError(onlyCode); else render(); return; }
  try {
    const saved = saveNavEstimates(next, { storage: navEstimateStorage(), now: new Date() });
    state.navEstimateEntries = saved;
    if (automatic) delete state.estimateDrafts[onlyCode];
    else { state.estimateDrafts = {}; state.estimateDirections = {}; }
    state.estimateStorageAvailable = true;
    if (automatic) { updateEstimateError(onlyCode); refreshEstimateViews(); }
    else { render(); toast('估值已保存'); }
  } catch {
    if (automatic) { state.estimateErrors[onlyCode] = '本机保存失败，请重试。'; updateEstimateError(onlyCode); }
    else {
      state.estimateErrors = Object.fromEntries(FUNDS.filter(fund => !estimatedNav(fund.code).latestOfficialDate || estimatedNav(fund.code).latestOfficialDate < date).map(fund => [fund.code, '本机保存失败，请重试。']));
      render();
    }
  }
}

function ledger(code) {
  const book = getBook(code);
  const estimate = valuation(code);
  // Six-column workbooks are authoritative; absent confirmation fields stay absent.
  const transactions = book.transactions;
  const result = calculateLedger(transactions, { mode: book.mode, valuationNav: estimate?.nav ?? null, valuationDate: estimate?.date ?? null, openingPrincipal: 0, openingShares: 0 });
  if (!book.transactions.length || book.incomplete) {
    for (const key of ['shares', 'principal', 'marketValue', 'holdingProfit', 'holdingReturn', 'totalInvested', 'totalRecovered', 'totalProfitWithdrawn', 'totalClosedLoss', 'totalProfit', 'totalReturn']) result.summary[key] = null;
  }
  return result;
}

function fundExposure(code) {
  return evaluateUsExposure(state.disciplines.find(entry => entry.id === 'us-exposure'), REGION_DATA[code]);
}

function portfolioAllocation() {
  const positions = FUNDS.map(fund => {
    const result = ledger(fund.code);
    return { code: fund.code, marketValue: result.summary.valid === true && !result.errors.length && !getBook(fund.code).incomplete ? result.summary.marketValue : null };
  });
  return calculatePortfolioAllocation([...positions, ...(!state.bondUnavailable ? state.bonds : [])], [...FUND_CODES, '006485', '006663']);
}

function holdingLimitCopy(code) {
  const rule = state.disciplines.find(entry => entry.id === 'us-exposure');
  const check = evaluateHoldingLimit(fundExposure(code), rule, portfolioAllocation().shares[code]);
  if (check.targetRatio === null || check.status === 'not-applicable') return '';
  const target = number(check.targetRatio * 100, 0);
  return `<p class="holding-limit-note" data-holding-limit="${esc(check.status)}">持仓上限：总持仓的 <strong class="num">${target}%</strong>。${check.status === 'above' ? `当前占比 <strong class="num">${number(check.allocationRatio * 100)}%</strong>，高于上限，按纪律降低至 ${target}%。` : check.status === 'within' ? `当前占比 <strong class="num">${number(check.allocationRatio * 100)}%</strong>，已在上限以内，无需因本条加仓。` : '当前占比待核验；资料补全后核对是否超限。'}</p>`;
}

function exposureNavTitle(fund, check) {
  return `${fund.fullName} ${fund.code}${check.status === 'below' ? ` · 美股含量未达标：${number(check.usPercent)}%，规则门槛${check.thresholdPercent}%` : ''}`;
}

function bondReserveCheck() {
  let bondValue = null, equityValue = 0;
  const missing = [];
  if (!state.bondUnavailable) {
    try { bondValue = calculateBondSummary(state.bonds).marketValue; } catch { /* Unavailable is never zero. */ }
  }
  for (const fund of FUNDS) {
    const book = getBook(fund.code);
    try {
      const result = ledger(fund.code), value = result.summary.marketValue;
      if (!book.transactions.length || book.incomplete || result.errors.length || result.summary.valid !== true || !Number.isFinite(value) || value < 0) missing.push(fund.navLabel);
      else equityValue += value;
    } catch { missing.push(fund.navLabel); }
  }
  const check = evaluateBondReserve({ equityValue, bondValue, complete: missing.length === 0 });
  const message = check.status === 'below'
    ? `债基占比约 ${number(check.ratio * 100, 0)}%，${check.reason === 'share-high' ? '高于 1/3' : '低于 1/6'}，且持仓未超过 5 万元。`
    : check.status === 'unknown'
      ? bondValue === null ? '债基数据暂不可用，无法核验配置。'
        : missing.length ? `${missing.join('、')}持仓资料不完整，暂无法核验债基占比。`
          : '总持仓暂无有效估值，无法核验债基占比。'
      : '';
  return { ...check, message };
}

function bondHoldingPeriods() {
  return Object.fromEntries(state.bonds.map(entry => [entry.code, calculateBondHoldingDuration(state.bondHoldingLots?.[entry.code], { now: new Date() })]));
}

function bondNavMarkup(active, check, mobile = false) {
  const below = check?.status === 'below', unknown = check?.status === 'unknown';
  const label = below ? '债基，配置未达标' : unknown ? '债基，配置待核验' : '债基';
  const dot = below || unknown ? '<span class="exposure-nav-dot" aria-hidden="true"></span>' : '';
  return `<a href="#/bonds" class="${active ? 'active' : ''}${below ? ' exposure-nav-warning' : unknown ? ' bond-nav-pending' : ''}" ${active ? 'aria-current="page"' : ''} aria-label="${label}">${mobile ? `<span class="nav-letter">债${dot}</span><span>债基</span>` : `债基${dot}`}</a>`;
}

function header(code, reserve) {
  const bonds = selectedBonds(), home = !code && !bonds;
  return `<header class="site-header"><div class="header-inner">
    <a href="#/" class="brand" aria-label="基金账本首页"><span class="brand-mark">${icon('book')}</span><span class="brand-copy"><span>基金账本</span><span id="session-timer" class="session-timer" role="timer" aria-label="本次解锁剩余时间" aria-live="off">剩余 ${remainingTime()}</span></span></a>
    <nav class="desktop-nav" aria-label="主要导航"><a href="#/" class="${home ? 'active' : ''}" ${home ? 'aria-current="page"' : ''}>交易纪律</a>${FUNDS.map(fund => {
      const check = fundExposure(fund.code), below = check.status === 'below';
      return `<a href="#/fund/${fund.code}" class="${code === fund.code ? 'active' : ''}${below ? ' exposure-nav-warning' : ''}" ${code === fund.code ? 'aria-current="page"' : ''} title="${esc(exposureNavTitle(fund, check))}"${below ? ` aria-label="${esc(fund.navLabel)}，美股含量未达标"` : ''}>${fund.navLabel}${below ? '<span class="exposure-nav-dot" aria-hidden="true"></span>' : ''}</a>`;
    }).join('')}${bondNavMarkup(bonds, reserve)}</nav>
    <div class="header-actions"><button type="button" class="icon-button" data-action="privacy" aria-label="${state.visible ? '隐藏' : '显示'}金额和份额" title="${state.visible ? '隐藏' : '显示'}金额和份额" aria-pressed="${state.visible}">${icon(state.visible ? 'eye' : 'eye-off')}</button>${themeButton()}<button type="button" class="icon-button" data-action="lock" aria-label="加锁账本" title="加锁账本">${icon('lock')}</button></div>
  </div></header>`;
}

function bottomNav(code, reserve) {
  const bonds = selectedBonds(), home = !code && !bonds;
  return `<nav class="bottom-nav" aria-label="手机导航"><a href="#/" class="${home ? 'active' : ''}" ${home ? 'aria-current="page"' : ''}>${icon('home')}<span>首页</span></a>${FUNDS.map(fund => {
    const check = fundExposure(fund.code), below = check.status === 'below';
    return `<a href="#/fund/${fund.code}" class="${code === fund.code ? 'active' : ''}${below ? ' exposure-nav-warning' : ''}" ${code === fund.code ? 'aria-current="page"' : ''} aria-label="${esc(exposureNavTitle(fund, check))}"><span class="nav-letter">${fund.initial}${below ? '<span class="exposure-nav-dot" aria-hidden="true"></span>' : ''}</span><span>${fund.navLabel}</span></a>`;
  }).join('')}${bondNavMarkup(bonds, reserve, true)}</nav>`;
}

function applicationInfo(book) {
  const dates = book.transactions.map(tx => String(tx.submittedAt || '').slice(0, 10)).filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
  return {
    count: book.transactions.length,
    firstDate: dates[0] || '待补充',
    lastDate: dates.at(-1) || '待补充',
    processing: book.transactions.filter(tx => tx.sourceStatus === 'processing').length,
    unverified: book.transactions.filter(tx => tx.sourceStatus === 'unverified').length,
    cancelled: book.transactions.filter(tx => ['cancelled', '撤单'].includes(tx.status)).length,
  };
}

function recordPanelState(code) {
  if (!code) return;
  app.querySelectorAll(`details[data-panel][data-fund="${code}"]`).forEach(panel => {
    state.expandedPanels[panel.dataset.panel] = panel.open;
  });
}

function render() {
  navSliders?.cancel();
  if (!state.unlocked) { renderGate(); return; }
  if (!checkSession()) return;
  syncNavEstimates();
  const fund = selectedFund();
  const section = routeSection();
  const locate = locatedRoute !== location.hash && ['us-exposure', 'bond-reserve', 'add-discipline'].includes(section);
  const previousFund = fundCodeFromHash(lastRenderedRoute);
  const viewport = !locate && fund && previousFund && (previousFund === fund.code || !section) ? fundViewport.capture() : null;
  if (!viewport) fundViewport.cancel();
  if (locate && !fund && !selectedBonds()) state.expandedPanels[`discipline-${section}`] = true;
  recordPanelState(fund?.code);
  if (locate && fund && section === 'us-exposure') state.expandedPanels['fund-basics'] = true;
  const bonds = selectedBonds();
  const reserve = bondReserveCheck();
  document.title = fund ? `${fund.short}账本 · 基金账本` : bonds ? '债基 · 基金账本' : '交易纪律 · 基金账本';
  app.innerHTML = `${header(fund?.code, reserve)}${fund ? fundPage(fund) : bonds ? renderBondsPage({ entries: state.bonds, valuationDate: state.bondValuationDate, visible: state.visible, transactions: state.bondTransactions, expandedByCode: { ...(desktopPanelsOpen() ? { "006485": true, "006663": true } : {}), ...state.bondExpanded }, holdingByCode: bondHoldingPeriods(), unavailable: state.bondUnavailable, reserve, locateReserve: section === 'bond-reserve', freeCashFlow: state.freeCashFlow, cashEditing: state.cashEditing, cashDraft: state.cashDraft, cashError: state.cashError, cashBusy: state.cashBusy, cashUnavailable: state.cashUnavailable }) : homePage(reserve)}${bottomNav(fund?.code, reserve)}`;
  app.querySelectorAll('.nav-periods').forEach(periods => { periods.scrollLeft = 0; });
  // Reveal a horizontally clipped tab without scrollIntoView moving the document.
  app.querySelectorAll('.desktop-nav, .bottom-nav').forEach(nav => {
    const link = nav.querySelector('.active');
    if (!link) return;
    const bounds = nav.getBoundingClientRect(), active = link.getBoundingClientRect();
    if (active.left < bounds.left) nav.scrollLeft -= bounds.left - active.left;
    else if (active.right > bounds.right) nav.scrollLeft += active.right - bounds.right;
  });
  locatedRoute = location.hash;
  lastRenderedRoute = location.hash;
  if (locate) {
    const target = section === 'add-discipline'
      ? document.querySelector(fund ? `#fund-${fund.code}-add-discipline` : '[data-discipline="add-discipline"]')
      : section === 'bond-reserve'
      ? document.querySelector(bonds ? '#bonds-reserve-summary' : '[data-discipline="bond-reserve"] > summary') || document.querySelector('[data-discipline="bond-reserve"]')
      : document.querySelector(fund ? `#fund-${fund.code}-us-exposure` : '[data-discipline="us-exposure"] > summary');
    if (typeof target?.focus === 'function') target.focus({ preventScroll: true });
    if (typeof target?.scrollIntoView === 'function') target.scrollIntoView({ block: 'center', behavior: 'instant' });
  } else if (viewport) {
    const renderedRoute = location.hash;
    fundViewport.restore(viewport, { isCurrent: () => state.unlocked && location.hash === renderedRoute });
  }
}

function disciplineCopy(value, linkFunds = false) {
  let copy = esc(value).replace(/(\d+(?:\.\d+)?)\s*[wW]\s*元/g, '$1万元').replace(/【([^】]+)】|(?:大幅|适当)止盈|进行一次加仓|\d+(?:\.\d+)?%|\d+(?:\.\d+)?倍|\d+(?:\.\d+)?万元|1\/[36]/g, (match, emphasis) => {
    const text = emphasis || match;
    return `<strong class="discipline-emphasis${/^(\d+(?:\.\d+)?%|\d+(?:\.\d+)?倍|1\/[36](?:～1\/[36])?|[15]万元)$/.test(text) ? ' discipline-number' : ''}">${text}</strong>`;
  });
  copy = copy.replace(/(<strong class="discipline-emphasis">立刻<\/strong>[^。]+。)/, '<span class="discipline-urgent">$1</span>');
  if (linkFunds) for (const fund of FUNDS) copy = copy.replace(fund.navLabel, `<a href="#/fund/${fund.code}" aria-label="进入${fund.navLabel}账本">${fund.navLabel}</a>`);
  return copy;
}

function fundAddSignal(code) {
  const rule = state.disciplines.find(entry => entry.id === 'add-discipline-decline');
  const row = ledger(code).rows.filter(item => item.status === 'included' && item.dateBasis !== 'order' && ['buy', 'sip', 'sell', 'transfer-in', 'reinvest'].includes(item.type)).at(-1);
  const original = row && getBook(code).transactions.find(item => item.id === row.id);
  const tradePoint = row ? { date: row.date, nav: row.nav, estimated: row.estimated === true || ['estimated', '历史估算'].includes(original?.status) } : null;
  return { rule, signal: evaluateAddDiscipline(estimatedNav(code).points, { rule, tradePoint, now: new Date(), annualizedHistory: officialNav(code) }) };
}

function addDisciplineMatches() {
  const matches = FUNDS.map(fund => ({ fund, ...fundAddSignal(fund.code) })).filter(({ signal }) => signal.triggered);
  if (!matches.length) return '';
  return `<div class="add-discipline-matches" aria-label="满足加仓条件的基金">${matches.map(({ fund, signal }) => {
    const actions = getDisciplineActions(fundExposure(fund.code));
    return `<div class="add-discipline-match" data-add-fund="${fund.code}" data-add-budget="${actions.addBudget}"><a href="#/fund/${fund.code}?section=add-discipline" aria-label="查看${esc(fund.name)}加仓提醒"><div class="add-match-main"><strong>${esc(fund.name)}</strong><span class="add-match-state">满足加仓条件</span></div><p class="add-match-reason">上次交易节点后跌幅 <strong class="num">${number(signal.decline * 100)}%</strong>，超过 ${number(signal.multiple, 0)} 倍平均年化（<span class="num">${number(signal.annualized * signal.multiple * 100)}%</span>）。</p><p class="add-match-budget">单次加仓 <strong class="num">${actions.addBudget === 10000 ? '1万' : number(actions.addBudget, 0)}</strong> 元${actions.adjusted ? '<span> · 美股未达标，已减半</span>' : ''}</p><small class="add-match-date">截至 ${esc(signal.asOf)}${signal.estimated ? ' · 上次交易节点含估算' : ''}${icon('arrow')}</small></a></div>`;
  }).join('')}</div>`;
}

function annualDisciplineAlert(code) {
  const matches = state.disciplines.filter(entry => entry.id === 'annual-profit' || entry.id.startsWith('annual-profit-'))
    .map(rule => ({ rule, kind: 'annual', signal: evaluateAnnualDiscipline(estimatedNav(code).points, { rule, now: new Date(), annualizedHistory: officialNav(code) }) }))
    .filter(({ signal }) => signal.triggered);
  const addition = fundAddSignal(code);
  if (addition.signal.triggered) matches.push({ ...addition, kind: 'add' });
  const exposure = fundExposure(code), actions = getDisciplineActions(exposure);
  const below = exposure.status === 'below';
  if (!matches.length && !below) return '';
  const signal = matches[0]?.signal;
  const annual = matches.find(item => item.kind === 'annual')?.signal;
  const add = matches.find(item => item.kind === 'add')?.signal;
  const exposureNote = below ? `<div class="fund-exposure-note annual-exposure-note">${icon('info')}<p><strong>美股含量未达标</strong>：${number(exposure.usPercent)}%，低于规则门槛 ${esc(exposure.thresholdPercent)}%，相差 ${number(exposure.gapPercent)} 个百分点。<a href="#/?section=us-exposure">查看首页规则与原因</a></p></div>` : '';
  const summary = `${annual ? `<p class="annual-alert-return">年内涨幅<strong class="num">${percent(annual.yearReturn)}</strong></p>` : ''}${add ? `<p class="annual-alert-return">上次交易节点后跌幅<strong class="num">${number(add.decline * 100)}%</strong></p><p class="annual-action-note">单次加仓 ${number(actions.addBudget, 0)} 元${actions.adjusted ? '（美股未达标，已减半）' : ''}</p>` : ''}`;
  const date = signal ? `<p class="annual-alert-date">截至 ${esc(signal.asOf)}${annual ? ` · 年初基准 ${esc(annual.baselineDate)}` : ''}${add ? ` · 上次交易节点 ${esc(add.baselineDate)}${add.estimated ? '（估算）' : ''}` : ''}</p>` : '';
  const adjustedNote = annual && actions.adjusted ? '<p class="annual-action-note">美股含量未达标，卖出金额/比例翻倍，上限为当前持仓。</p>' : '';
  const rules = matches.length ? `<div class="annual-alert-rules">${matches.map(({ rule }) => {
    const displayRule = adjustDisciplineRule(rule, exposure);
    const content = esc(`${displayRule.title}${displayRule.detail ? ` ${displayRule.detail}` : ''}`).replace(/【([^】]+)】|(?:大幅|适当)止盈|进行一次加仓|全部卖出|\d+(?:\.\d+)?%|\d+(?:\.\d+)?倍/g, (match, emphasis) => `<strong>${emphasis || match}</strong>`);
    return `<p class="annual-alert-rule" data-rule="${esc(rule.id)}"${rule.id === 'add-discipline-decline' ? ` id="fund-${esc(code)}-add-discipline" tabindex="-1"` : ''}><small>${rule.id === 'annual-profit-100' ? '6.1' : rule.id === 'annual-profit-multiple' ? '6.2' : rule.id === 'add-discipline-decline' ? '7.1' : '6'}</small><span>${content}${rule.id === 'add-discipline-decline' ? '<a class="add-rule-return" href="#/?section=add-discipline">查看首页加仓提醒</a>' : ''}</span></p>`;
  }).join('')}</div>` : '';
  return `<aside class="annual-discipline-alert" role="alert" aria-label="交易纪律提醒" data-fund="${esc(code)}"><div class="alert-heading"><strong>交易纪律提醒</strong></div>${exposureNote}${below ? holdingLimitCopy(code) : ''}${summary}${date}${adjustedNote}${rules}</aside>`;
}

function exposureRuleDetails(checks) {
  const below = checks.filter(check => check.status === 'below');
  return `<div class="discipline-compliance-details"><div class="exposure-reasons"><ul class="exposure-checks">${below.map(({ fund, ...check }) => {
    const source = safeSource(check.source?.url);
    const comparison = `美股占比 <strong class="num">${number(check.usPercent)}%</strong>，低于规则门槛 <strong>${esc(check.thresholdPercent)}%</strong>，相差 <strong>${number(check.gapPercent)}</strong> 个百分点。`;
    return `<li class="exposure-check exposure-check-below" data-exposure-fund="${fund.code}"><a class="exposure-check-target" href="#/fund/${fund.code}?section=us-exposure" aria-label="查看${esc(fund.name)}的美国持仓比例"><div class="exposure-check-heading"><span class="exposure-check-name">${esc(fund.name)}<span class="fund-code">${fund.code}</span></span><span class="exposure-check-state">未达标</span></div><p>${comparison}</p>${holdingLimitCopy(fund.code)}</a>${check.asOf ? `<p class="exposure-check-source">持仓截至 <time datetime="${esc(check.asOf)}">${esc(check.asOf)}</time>${check.publishedAt ? ` · 公告 ${esc(check.publishedAt)}` : ''}${source ? ` · <a class="inline-source" href="${source}" target="_blank" rel="noopener noreferrer" aria-label="${esc(check.source.title)}">原报告</a>` : ''}</p>` : ''}</li>`;
  }).join('')}</ul></div></div>`;
}

function holdingDurationDetails() {
  const now = new Date();
  return `<div class="discipline-compliance-details"><ul class="holding-duration-list">${FUNDS.map(fund => {
    const book = getBook(fund.code), result = ledger(fund.code);
    const originals = new Map(book.transactions.map(transaction => [transaction.id, transaction]));
    const rows = result.rows.map(row => ({ ...row, estimated: row.estimated === true || ['estimated', '历史估算'].includes(originals.get(row.id)?.status) }));
    const duration = calculateHoldingDuration(rows, { now, incomplete: book.incomplete === true, hasErrors: result.errors.length > 0 });
    const text = duration.status === 'holding'
      ? `已持有 <span class="num">${number(duration.days, 0)}</span> 天`
      : duration.status === 'closed' ? '已清仓' : book.transactions.length ? '待核验' : '暂无记录';
    let progress = '';
    if (duration.status === 'holding') {
      if (!holdingFractions.has(fund.code)) holdingFractions.set(fund.code, 0.64 + Math.random() * 0.24);
      const scale = createHoldingDurationScale(duration.days, holdingFractions.get(fund.code));
      if (scale) progress = `<div class="holding-progress-layout"><div class="holding-progress-track" role="progressbar" aria-label="${esc(fund.name)}持有时间" aria-valuemin="0" aria-valuenow="${duration.days}" aria-valuemax="${scale.maximum}" aria-valuetext="已持有 ${duration.days} 天"><span class="holding-progress-fill" style="width: ${(scale.ratio * 100).toFixed(3)}%"></span></div><span class="holding-progress-maximum" aria-hidden="true"><span class="num">${number(scale.maximum, 0)}</span> 天</span></div>`;
    }
    return `<li data-holding-fund="${fund.code}"><div class="holding-duration-heading"><span class="holding-fund-name">${esc(fund.name)}</span><strong class="holding-duration${duration.status === 'holding' ? '' : ' holding-duration-empty'}">${text}</strong></div>${progress}</li>`;
  }).join('')}</ul></div>`;
}

function homePage(reserve) {
  return `<main id="main" class="workspace home-page discipline-home"><header class="discipline-heading"><p class="observatory-eyebrow">PORTFOLIO OBSERVATORY</p><h1>交易纪律</h1><p class="observatory-caption">市场有波动，行动有章法。</p></header>${estimateHomePanel()}${homeRules(reserve)}</main>`;
}

function homeRules(reserve) {
  const labels = { 'us-exposure': '美股含量', 'long-term': '长期持有', 'bond-reserve': '债基配置', 'equity-scope': '基金精简', 'annual-profit': '年度止盈', 'add-discipline': '加仓纪律' };
  const headingNumbers = { 'us-exposure': '1', 'long-term': '2', 'bond-reserve': '3', 'equity-scope': '4', 'annual-profit': '6', 'add-discipline': '7' };
  const groups = ['us-exposure', 'annual-profit', 'add-discipline'].filter(id => state.disciplines.some(entry => entry.id === id));
  const entries = state.disciplines.filter(entry => !groups.some(id => entry.id.startsWith(`${id}-`)));
  const clauseLabels = { 'us-exposure-adjustment': '1.1', 'annual-profit-100': '6.1', 'annual-profit-multiple': '6.2', 'add-discipline-decline': '7.1' };
  return `<section class="discipline-sheet" aria-label="持有与交易纪律">${entries.map(entry => {
      const children = groups.includes(entry.id) ? state.disciplines.filter(child => child.id.startsWith(`${entry.id}-`)) : [];
      const punctuation = entry.detail.match(/^[。！？]+/)?.[0] || '';
      const detail = entry.detail.slice(punctuation.length).trim();
      const headingNumber = headingNumbers[entry.id];
      const heading = `<h2${headingNumber ? ' class="discipline-numbered-heading"' : ''}>${headingNumber ? `<span class="discipline-heading-number">${headingNumber}.</span>` : ''}<span>${disciplineCopy(entry.title + punctuation, entry.id === 'equity-scope')}</span></h2>`;
      const content = `${heading}${detail ? `<p>${disciplineCopy(detail, entry.id === 'equity-scope')}</p>` : ''}${children.length ? `<div class="discipline-subrules">${children.map(child => `<div class="discipline-subrule" data-discipline="${esc(child.id)}"><small class="discipline-clause-label">${esc(clauseLabels[child.id] || '')}</small><p>${disciplineCopy(`${child.title}${child.detail ? ` ${child.detail}` : ''}`)}</p></div>`).join('')}</div>` : ''}`;
      if (entry.id === 'us-exposure') {
        const checks = FUNDS.map(fund => ({ fund, ...fundExposure(fund.code) }));
        const below = checks.filter(check => check.status === 'below').length;
        if (below) return `<details class="discipline-entry discipline-entry-checkable discipline-entry-warning" data-discipline="us-exposure" data-panel="discipline-us-exposure" data-exposure-status="below" ${panelExpanded('discipline-us-exposure') ? 'open' : ''}><summary class="discipline-rule-toggle"><span class="discipline-entry-label">${esc(labels[entry.id])}</span><div class="discipline-entry-content">${content}<div class="discipline-compliance-line"><span class="exposure-badge exposure-warning">${icon('info')}未完全遵守 · ${below}只未达标</span><span class="discipline-expand-hint"><span class="when-closed">查看原因</span><span class="when-open">收起原因</span>${icon('down')}</span></div></div></summary>${exposureRuleDetails(checks)}</details>`;
      }
      if (entry.id === 'long-term') return `<details class="discipline-entry discipline-entry-checkable${panelExpanded('discipline-long-term') ? ' holding-progress-visible' : ''}" data-discipline="long-term" data-panel="discipline-long-term" ${panelExpanded('discipline-long-term') ? 'open' : ''}><summary class="discipline-rule-toggle"><span class="discipline-entry-label">${esc(labels[entry.id])}</span><div class="discipline-entry-content">${content}<div class="discipline-compliance-line"><span class="discipline-expand-hint"><span class="when-closed">查看持有时间</span><span class="when-open">收起持有时间</span>${icon('down')}</span></div></div></summary>${holdingDurationDetails()}</details>`;
      if (entry.id === 'bond-reserve' && reserve.status !== 'met') {
        const below = reserve.status === 'below', label = below ? '未完全遵守' : '待核验';
        return `<details class="discipline-entry discipline-entry-checkable${below ? ' discipline-entry-warning' : ''}" data-discipline="bond-reserve" data-panel="discipline-bond-reserve" data-bond-reserve-status="${reserve.status}" ${panelExpanded('discipline-bond-reserve') ? 'open' : ''}><summary class="discipline-rule-toggle"><span class="discipline-entry-label">${esc(labels[entry.id])}</span><div class="discipline-entry-content">${content}<div class="discipline-compliance-line"><span class="exposure-badge ${below ? 'exposure-warning' : 'bond-reserve-pending'}">${icon('info')}${label}</span><span class="discipline-expand-hint"><span class="when-closed">查看原因</span><span class="when-open">收起原因</span>${icon('down')}</span></div></div></summary><div class="discipline-compliance-details"><a class="exposure-check-target bond-reserve-target" href="#/bonds?section=bond-reserve" aria-label="查看债基配置"><p>${esc(reserve.message)}</p><span class="bond-reserve-link">查看债基${icon('arrow')}</span></a></div></details>`;
      }
      if (entry.id === 'bond-reserve') return `<article class="discipline-entry" data-discipline="bond-reserve" data-bond-reserve-status="met" tabindex="-1"><p class="discipline-entry-label">${esc(labels[entry.id])}</p><div class="discipline-entry-content">${content}</div></article>`;
      return `<article class="discipline-entry${entry.id === 'add-discipline' ? ' discipline-entry-focus' : ''}" data-discipline="${esc(entry.id)}"${entry.id === 'add-discipline' ? ' tabindex="-1"' : ''}><p class="discipline-entry-label">${esc(labels[entry.id] || '交易纪律')}</p><div class="discipline-entry-content">${content}${entry.id === 'add-discipline' ? addDisciplineMatches() : ''}</div></article>`;
    }).join('')}</section>`;
}

function metric(label, value, digits = 2, extra = '') {
  return `<div><dt>${label}</dt><dd class="num ${extra}">${sensitive(value, digits)}</dd></div>`;
}

function fundRegions(fund) {
  const data = REGION_DATA[fund.code];
  if (!data) return '';
  const history = officialNav(fund.code);
  const annualized = calculateNavAnnualized(history);
  const allocation = portfolioAllocation().shares[fund.code];
  const overview = `<div class="fund-basic-overview"><p class="fund-portfolio-share"><span>占总持仓比例</span><strong class="num" data-fund-portfolio-share>${Number.isFinite(allocation) ? number(allocation * 100) + '%' : '待核验'}</strong></p><p class="nav-annualized" title="按全部已载入正式净值计算复合年化；不含昨日估值，未计现金分红再投资"><span>平均年化</span><strong class="num ${signClass(annualized)}" data-nav-annualized>${percent(annualized)}</strong></p>${history.at(-1)?.date ? `<p class="helper">净值截至 <time datetime="${esc(history.at(-1).date)}">${esc(history.at(-1).date)}</time></p>` : ''}</div>`;
  const check = fundExposure(fund.code), below = check.status === 'below';
  const source = safeSource(data.source?.url);
  return `<details class="panel fund-regions panel-disclosure${below ? ' exposure-below' : ''}" aria-label="基金基本信息" data-panel="fund-basics" data-fund="${fund.code}"${panelExpanded('fund-basics', true) ? ' open' : ''}><summary class="panel-toggle"><h2>基金基本信息</h2><time class="helper" datetime="${esc(data.asOf)}" title="报告公告日期 ${esc(data.publishedAt || '待核实')}">地区截至 ${esc(data.asOf)}</time></summary><div class="panel-content">${overview}<p class="region-basis">直接股票持仓 · 占基金净资产</p><ul class="region-shares">${data.regions.map(region => `<li${region.name === '美国' ? ` id="fund-${fund.code}-us-exposure" tabindex="-1" class="region-us${below ? ' region-us-below' : ''}${routeSection() === 'us-exposure' ? ' exposure-location' : ''}"` : ''}><span>${esc(region.name)}${region.name === '美国' && below ? '<small class="region-state">未达标</small>' : ''}</span><strong class="num">${number(region.percent, 2)}%</strong></li>`).join('')}</ul>${data.note ? `<p class="helper region-note">${esc(data.note)}</p>` : ''}${source ? `<a class="inline-source" href="${source}" target="_blank" rel="noopener noreferrer" aria-label="${esc(data.source.title)}">原报告</a>` : ''}</div></details>`;
}

function fundPage(fund) {
  const book = getBook(fund.code);
  const result = ledger(fund.code);
  const { summary, errors } = result;
  const alternate = calculateLedger(book.transactions, { mode: book.mode === 'principal-first' ? 'profit-first' : 'principal-first',
    valuationNav: summary.valuationNav, valuationDate: summary.valuationDate });
  const modeEffect = describeModeEffect(result, alternate, { incomplete: book.incomplete });
  const principalState = !book.transactions.length ? '暂无交易记录' : book.incomplete ? '成交资料待补全' : { empty: '当前无持仓', recovered: '本金已全部回收', invested: '仍有本金在持' }[summary.principalStatus] || '请先修正交易';
  const sixColumnSource = !book.transactions.length || book.transactions.every(tx => tx.dateBasis === 'order');
  const exposure = fundExposure(fund.code);
  const estimatedChip = summary.estimatedCount
    ? `<span class="status-chip dot">${sixColumnSource ? '历史估算 · 沿用原表' : summary.latestEstimatedDate ? `已估算 ${esc(summary.latestEstimatedDate)} 净值` : '已估算历史净值'}</span>`
    : '';
  return `<main id="main" class="workspace fund-page brand-${fund.brand}"><a class="back-link" href="#/">${icon('back')}返回首页</a><div class="page-heading"><div class="fund-title-line"><span class="fund-initial">${fund.initial}</span><div><h1>${fund.name}</h1><p class="fund-subtitle"><span class="fund-code">${fund.code}</span>${fund.category}</p></div></div><div class="fund-heading-flags">${exposure.status === 'below' ? `<span class="status-chip exposure-warning">${icon('info')}美股含量未达标</span>` : ''}${estimatedChip}</div></div>
    ${annualDisciplineAlert(fund.code)}${fundRegions(fund)}<div class="fund-layout">${navPanel(fund)}<div class="main-column"><details class="panel summary-panel panel-disclosure" data-panel="holdings" data-fund="${fund.code}" ${panelExpanded('holdings') ? 'open' : ''}><summary class="panel-toggle"><h2>持仓与收益</h2><span class="status-chip">${principalState}</span></summary><div class="panel-content">
      ${summary.lastDate ? `<p class="helper">最近交易日期 ${esc(summary.lastDate)}</p>` : ''}
      <div class="mode-control ${book.mode}" role="group" aria-label="卖出到账分配模式"><button data-action="mode" data-mode="profit-first" aria-pressed="${book.mode === 'profit-first'}">利润优先</button><button data-action="mode" data-mode="principal-first" aria-pressed="${book.mode === 'principal-first'}">本金优先</button></div>
      <p class="mode-explanation" role="status" data-mode-effect="${modeEffect.kind}">${modeEffect.message}</p>
      ${errors.length ? `<div class="error-note" role="alert">第 ${errors[0].index} 笔交易待修正：${esc(errors[0].message)}<br>修正前暂停展示汇总结果。</div>` : ''}
      <div class="summary-main"><div><p class="card-label">当前市值（元）</p><p class="card-value num">${sensitive(summary.marketValue)}</p><p class="helper">估值净值日期 ${esc(summary.valuationDate || '尚无可用净值')}</p></div><div class="summary-return"><p class="card-label">持有收益率</p><span class="num ${signClass(summary.holdingReturn)}">${percent(summary.holdingReturn)}</span></div></div>
      <dl class="summary-grid">${metric('剩余本金（元）', summary.principal)}${metric('持有收益（元）', summary.holdingProfit, 2, signClass(summary.holdingProfit))}${metric('持有份额', summary.shares, 2)}${metric('累计投入（元）', summary.totalInvested)}${metric('累计到账（元）', summary.totalRecovered)}${metric('已提取利润（元）', summary.totalProfitWithdrawn)}${metric('累计收益（元）', summary.totalProfit, 2, signClass(summary.totalProfit))}<div><dt>累计收益率</dt><dd class="num ${signClass(summary.totalReturn)}">${percent(summary.totalReturn)}</dd></div>${metric('清仓损失（元）', summary.totalClosedLoss)}</dl>
    </div></details>${ledgerPanel(result, book, fund.code)}</div></div></main>`;
}
function chartOverlays(code) {
  const { summary, rows } = ledger(code);
  const originals = new Map(getBook(code).transactions.map(tx => [tx.id, tx]));
  const costNav = summary.valid && Number.isFinite(summary.principal) && summary.principal >= 0 && Number.isFinite(summary.shares) && summary.shares > 0
    ? summary.principal / summary.shares : null;
  const markers = rows.filter(row => row.status === 'included' && row.dateBasis !== 'order' && ['buy', 'sip', 'transfer-in', 'reinvest', 'sell'].includes(row.type))
    .map(row => ({ date: row.date, nav: row.nav, type: row.type === 'sell' ? 'sell' : 'buy', estimated: row.estimated === true || ['estimated', '历史估算'].includes(originals.get(row.id)?.status) }));
  return { costNav, costEstimated: summary.estimatedCount > 0, markers };
}

function sparkline(history, code, range = null) {
  const official = state.nav[code]?.history || [];
  const display = getNavChartDisplay({ ...range, points: history }, estimatedNav(code));
  return renderNavChart(display.points, { ...chartOverlays(code), referenceHistory: official, domainEnd: display.domainEnd, estimatedPoints: display.estimatedPoints });
}

function navPeriodDisabled(period, range) {
  return period === 'recent-decline' && !range.declineAvailable || period === 'recent-rise' && !range.riseAvailable || period === 'since-trade' && !range.tradeAvailable;
}

function navContext(code) {
  const rows = ledger(code).rows.filter(row => row.status === 'included' && row.dateBasis !== 'order' && ['buy', 'sip', 'sell', 'transfer-in', 'reinvest'].includes(row.type));
  return { tradeDate: rows.at(-1)?.date || null };
}

function navSelection(code) {
  return state.navRanges[code] || (state.navPreset ? { preset: state.navPreset } : undefined);
}

function selectedNavRange(code, history) {
  let selection = navSelection(code);
  if (selection?.preset?.startsWith('recent-')) selection = { preset: recentNavPeriod(history)?.id || '3m' };
  const range = resolveNavRange(history, selection, navContext(code));
  if (!selection && history.length && range.preset) state.navPreset = range.preset;
  return navPeriodDisabled(range.preset, range)
    ? { ...range, from: null, to: null, points: [], unavailable: true } : range;
}

function navRangeDate(summary, nav, range) {
  if (range?.unavailable) return ({ 'recent-rise': '暂无上涨区间', 'recent-decline': '暂无下跌区间', 'since-trade': '暂无交易区间' })[range.preset] || '所选时段暂无净值';
  return summary.endDate ? `净值日期 ${esc(summary.endDate)}` : nav?.unavailable ? '公开净值暂不可用' : nav?.history?.length ? '所选时段暂无净值' : nav ? '暂无净值' : '正在读取公开净值…';
}

function railAnchor(history, value) {
  const bounded = Math.max(0, Math.min(history.length - 1, value));
  const index = Math.floor(bounded);
  return { date: history[index].date, fraction: bounded - index };
}

function railValue(history, anchor, fallback) {
  const index = history.findIndex(point => point.date === anchor?.date);
  return index >= 0 ? Math.min(history.length - 1, index + (anchor.fraction || 0)) : fallback;
}

function navSliderDomain(code, history, range, { reset = false, visualDomain, visualValues } = {}) {
  if (reset) { delete state.navDomains[code]; delete state.navVisuals[code]; }
  const previous = state.navDomains[code];
  const domain = resolveNavSliderDomain(history, range, previous);
  if (visualDomain) domain.min = Math.max(0, Math.min(domain.max, visualDomain.min));
  else if (previous?.from === domain.from) domain.min = Math.min(range.start, domain.min + (previous.fraction || 0));
  const anchor = railAnchor(history, domain.min);
  state.navDomains[code] = { from: anchor.date, to: domain.to, ...(anchor.fraction ? { fraction: anchor.fraction } : {}) };
  if (visualValues) state.navVisuals[code] = { from: range.from, to: range.to, start: railAnchor(history, visualValues.start), end: railAnchor(history, visualValues.end) };
  else if (state.navVisuals[code]?.from !== range.from || state.navVisuals[code]?.to !== range.to) delete state.navVisuals[code];
  return domain;
}

function navVisualValues(code, history, range, domain) {
  const saved = state.navVisuals[code];
  const start = saved?.from === range.from && saved?.to === range.to ? railValue(history, saved.start, range.start) : range.start;
  const end = saved?.from === range.from && saved?.to === range.to ? railValue(history, saved.end, range.end) : range.end;
  return { start: Math.max(domain.min, Math.min(domain.max, start)), end: Math.max(domain.min, Math.min(domain.max, end)) };
}

const NAV_CYCLES = { months: ['1m', '3m', '6m'], years: ['1y', '3y'] };

function syncNavCycle(preset) {
  for (const [cycle, periods] of Object.entries(NAV_CYCLES)) if (periods.includes(preset)) state.navCycles[cycle] = preset;
}

function navCycleDetails(cycle) {
  const periods = NAV_CYCLES[cycle];
  if (!periods) return null;
  const index = Math.max(0, periods.indexOf(state.navCycles[cycle]));
  const current = periods[index], next = periods[(index + 1) % periods.length];
  const label = id => id.endsWith('m') ? `最近${parseInt(id)}个月` : `最近${parseInt(id)}年`;
  return { current, next, label: label(current), hint: `点击切换为${label(next)}` };
}

function navPeriodButton(code, period, range) {
  return `<button type="button" data-action="nav-period" data-period="${period.id}" data-fund="${code}" aria-pressed="${range.preset === period.id}" ${navPeriodDisabled(period.id, range) ? 'disabled' : ''}>${period.label}</button>`;
}

function navCycleButton(code, cycle, range) {
  const { current, label, hint } = navCycleDetails(cycle);
  return `<button type="button" data-action="nav-cycle" data-cycle="${cycle}" data-period="${current}" data-fund="${code}" aria-pressed="${range.preset === current}" aria-label="${label}，${hint}" title="${hint}">${label}</button>`;
}

function navTrendButtons(code, history, range) {
  const trend = recentNavPeriod(history);
  return `${trend ? navPeriodButton(code, trend, range) : '<button type="button" disabled>近期走势</button>'}${navPeriodButton(code, NAV_PERIODS.find(period => period.id === 'since-trade'), range)}`;
}

function navRangeControls(code, history, range) {
  if (!history.length) return '';
  syncNavCycle(range.preset);
  const domain = navSliderDomain(code, history, range);
  const visual = navVisualValues(code, history, range, domain);
  const position = index => domain.max > domain.min ? (index - domain.min) / (domain.max - domain.min) * 100 : 0;
  return `<div class="nav-range-controls"><div class="nav-range-labels num"><span data-nav-start>${esc(range.from)}</span><span data-nav-end>${esc(range.to)}</span></div>
    <div class="nav-range-slider" role="group" aria-label="净值日期范围" data-start-at-end="${range.start === domain.max}" style="--range-start:${position(visual.start)}%;--range-end:${position(visual.end)}%"><div class="nav-range-track" aria-hidden="true"></div>${['start', 'end'].map(boundary => `<input type="range" class="nav-range-input" data-nav-boundary="${boundary}" data-fund="${code}" min="${domain.min}" max="${domain.max}" step="any" value="${visual[boundary]}" aria-label="${boundary === 'start' ? '开始日期' : '结束日期'}" aria-valuetext="${esc(history[range[boundary]].date)}" aria-controls="nav-chart-${code}" ${domain.max > domain.min && range.points.length ? '' : 'disabled'}>`).join('')}</div>
    <div class="nav-periods" role="group" aria-label="净值快捷时段">${navCycleButton(code, 'months', range)}${navPeriodButton(code, NAV_PERIODS.find(period => period.id === 'last-month'), range)}${navCycleButton(code, 'years', range)}${navPeriodButton(code, NAV_PERIODS.find(period => period.id === 'all'), range)}</div>
    <div class="nav-periods nav-trends" role="group" aria-label="趋势与交易时段">${navTrendButtons(code, history, range)}</div></div>`;
}

function updateNavRange(code, selection, interaction = {}) {
  const history = state.nav[code]?.history;
  const panel = app.querySelector(`.nav-panel[data-fund="${code}"]`);
  if (!history?.length || !panel) return;
  if (selection.preset && !NAV_PERIODS.some(period => period.id === selection.preset)) return;
  const range = resolveNavRange(history, selection, navContext(code));
  if (navPeriodDisabled(selection.preset, range)) return;
  const previous = navSelection(code);
  const sameDates = previous?.from === range.from && previous?.to === range.to;
  if (selection.preset) {
    state.navPreset = selection.preset;
    syncNavCycle(selection.preset);
    state.navRanges = {};
    state.navDomains = {};
    state.navVisuals = {};
  } else state.navRanges[code] = selection;
  const domain = navSliderDomain(code, history, range, interaction);
  const display = getNavChartDisplay(range, estimatedNav(code));
  const { summary } = display;
  panel.querySelector('[data-nav-value]').textContent = number(summary.endNav, 4);
  const change = panel.querySelector('[data-nav-change]');
  change.textContent = percent(summary.change);
  change.className = `num ${signClass(summary.change)}`;
  const disciplineGap = panel.querySelector('[data-nav-discipline-gap]');
  if (disciplineGap) {
    disciplineGap.innerHTML = navDisciplineGap(code, summary.change);
    disciplineGap.hidden = !disciplineGap.innerHTML;
  }
  panel.querySelector('[data-nav-date]').textContent = navRangeDate(summary, state.nav[code], range);
  if (!sameDates || !interaction.visualDomain) panel.querySelector('[data-nav-chart]').innerHTML = sparkline(range.points, code, range);
  panel.querySelector('[data-nav-count]').textContent = `${display.points.length + display.estimatedPoints.length} 期`;
  panel.querySelector('[data-nav-start]').textContent = range.from;
  panel.querySelector('[data-nav-end]').textContent = range.to;
  const slider = panel.querySelector('.nav-range-slider');
  const visual = navVisualValues(code, history, range, domain);
  const position = index => domain.max > domain.min ? (index - domain.min) / (domain.max - domain.min) * 100 : 0;
  slider.dataset.startAtEnd = String(range.start === domain.max);
  slider.style.setProperty('--range-start', `${position(visual.start)}%`);
  slider.style.setProperty('--range-end', `${position(visual.end)}%`);
  slider.querySelectorAll('[data-nav-boundary]').forEach(input => {
    input.min = domain.min;
    input.max = domain.max;
    input.value = visual[input.dataset.navBoundary];
    input.disabled = domain.max <= domain.min || !range.points.length;
    input.setAttribute('aria-valuetext', history[range[input.dataset.navBoundary]].date);
  });
  panel.querySelectorAll('[data-cycle]').forEach(button => {
    const details = navCycleDetails(button.dataset.cycle);
    if (!details) return;
    button.dataset.period = details.current;
    button.textContent = details.label;
    button.setAttribute('aria-label', `${details.label}，${details.hint}`);
    button.title = details.hint;
  });
  panel.querySelectorAll('[data-period]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.period === range.preset));
    button.disabled = navPeriodDisabled(button.dataset.period, range);
  });
  panel.querySelector('.nav-trends').innerHTML = navTrendButtons(code, history, range);
}

function safeSource(value) {
  try { const url = new URL(value); return url.protocol === 'https:' ? esc(url.href) : ''; } catch { return ''; }
}

function navDisciplineGap(code, change) {
  if (!Number.isFinite(change) || change === 0) return '';
  const gap = getNavDisciplineGap(change, change < 0
    ? { addSignal: fundAddSignal(code).signal }
    : { profitSignals: state.disciplines.filter(rule => rule.id === 'annual-profit' || rule.id.startsWith('annual-profit-')).map(rule => evaluateAnnualDiscipline(estimatedNav(code).points, { rule, now: new Date(), annualizedHistory: officialNav(code) })) });
  if (!gap) return '';
  const name = gap.kind === 'add' ? '加仓' : '止盈';
  const context = gap.kind === 'add' ? '按最新净值、上次交易节点及现有加仓纪律计算' : '按最新净值、年内涨幅及现有止盈纪律计算';
  const distance = gap.remaining > 0 && gap.remaining < 0.00005 ? '&lt;0.01' : number(gap.remaining * 100);
  const content = gap.triggered ? `已达到${name}标准` : gap.remaining === 0 ? `已到${name}临界值` : `距${name}标准还差 <span class="num">${distance}</span> 个百分点`;
  return `<span class="nav-discipline-distance ${gap.kind === 'add' ? 'negative' : 'positive'}" title="${context}">${content}</span>`;
}

function navPanel(fund) {
  const nav = state.nav[fund.code];
  const history = nav?.history || [];
  const range = selectedNavRange(fund.code, history);
  const display = getNavChartDisplay(range, estimatedNav(fund.code));
  const { summary } = display;
  const disciplineGap = navDisciplineGap(fund.code, summary.change);

  return `<details class="panel nav-panel panel-disclosure" data-panel="nav-quotes" data-fund="${fund.code}"${panelExpanded('nav-quotes', true) ? ' open' : ''}><summary class="panel-toggle"><h2>公开净值</h2><span class="helper" data-nav-count>${display.points.length + display.estimatedPoints.length} 期</span></summary><div class="panel-content"><div class="nav-value"><strong class="num" data-nav-value>${number(summary.endNav, 4)}</strong><span class="num ${signClass(summary.change)}" data-nav-change title="所选区间涨跌幅">${percent(summary.change)}</span></div><p class="nav-discipline-gap" data-nav-discipline-gap${disciplineGap ? '' : ' hidden'}>${disciplineGap}</p><p class="nav-date" data-nav-date>${navRangeDate(summary, nav, range)}</p><div id="nav-chart-${fund.code}" data-nav-chart>${history.length ? sparkline(range.points, fund.code, range) : ''}</div>${navRangeControls(fund.code, history, range)}</div></details>`;
}

function ledgerPanel(result, book, code) {
  const originalById = new Map(book.transactions.map(tx => [tx.id, tx]));
  const quote = valuation(code);
  const performance = calculateTransactionPerformance(result.rows.map(row => ({ ...row, estimated: row.estimated === true || ['estimated', '历史估算'].includes(originalById.get(row.id)?.status) })), { valuationNav: quote?.nav ?? null, valuationDate: quote?.date ?? null });
  const visibleRows = result.rows.filter(row => {
    const original = originalById.get(row.id) || row;
    return !['cancelled', 'canceled', '撤单', '已撤单', '已撤销'].includes(original.status) && !['cancelled', 'canceled'].includes(original.sourceStatus);
  });
  const filtered = visibleRows.filter(row => (state.filter === 'all' || row.type === state.filter) && (state.statusFilter === 'all' || row.status === state.statusFilter || (state.statusFilter === 'error' && row.status === 'blocked')));
  const shown = filtered.slice().reverse().slice(0, state.limit);
  const statusOptions = [['all', '全部状态'], ['included', '已确认'], ['pending', '进行中'], ['error', '待修正']];
  return `<details class="panel ledger-panel panel-disclosure" data-panel="transactions" data-fund="${code}" ${panelExpanded('transactions') ? 'open' : ''}><summary class="panel-toggle"><h2>逐笔交易</h2><span class="fund-code">${visibleRows.length} 笔</span></summary><div class="panel-content">
    <div class="ledger-toolbar"><select id="type-filter" aria-label="筛选交易类型"><option value="all">全部类型</option>${Object.entries(TYPE_NAMES).map(([key, label]) => `<option value="${key}" ${state.filter === key ? 'selected' : ''}>${label}</option>`).join('')}</select><select id="status-filter" aria-label="筛选记录状态">${statusOptions.map(([key, label]) => `<option value="${key}" ${state.statusFilter === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
    <div class="transaction-list">${shown.length ? shown.map(row => transactionCard(row, book, performance.get(row.id))).join('') : `<div class="empty-state"><h3>${visibleRows.length ? '没有符合条件的交易' : '尚无交易记录'}</h3>${visibleRows.length ? '<button class="button" data-action="reset-filter">清除筛选</button>' : ''}</div>`}</div>${filtered.length > shown.length ? `<button class="button more-button" data-action="more">再显示 25 笔 · 还有 ${filtered.length - shown.length} 笔</button>` : ''}</div></details>`;
}

function transactionCard(row, book, performance = {}) {
  const tx = book.transactions.find(item => item.id === row.id) || row;
  const included = row.status === 'included';
  const pending = row.status === 'pending';
  const estimated = included && (row.estimated === true || ['estimated', '历史估算'].includes(tx.status));
  const values = included || tx.dateBasis === 'order' ? tx : {};
  const out = row.type === 'sell' || row.type === 'dividend';
  const label = included ? estimated ? '估算成交' : '已确认'
    : row.status === 'excluded' ? ['cancelled', '撤单'].includes(tx.status) || tx.sourceStatus === 'cancelled' ? '已撤单' : STATUS_NAMES[tx.status] || '未计入'
    : row.status === 'pending' ? tx.sourceStatus === 'processing' ? '进行中' : ['unverified', 'incomplete'].includes(tx.sourceStatus) ? '资料待补全' : '待确认'
    : row.status === 'error' ? '待修正' : '前序待修正';
  const hasNote = tx.note !== undefined && tx.note !== null && String(tx.note).trim() !== '';
  const displayDate = tx.dateBasis === 'order' ? `交易日期（下单） ${esc(tx.submittedAt || row.date)}` : included && row.date ? `${estimated ? '估算净值日期' : '净值日期'} ${esc(row.date)}` : tx.submittedAt ? `申请日期 ${esc(tx.submittedAt)}` : esc(row.date || '净值日期待填');
  const dateNote = tx.dateBasis === 'order' ? `交易日期沿用原始下单日期；${tx.navDate ? `来源备份净值日期 ${esc(tx.navDate)}${estimated ? '（历史估算）' : '（沿用原确认状态）'}` : '原表未提供成交净值日期'}。` : tx.submittedAt
    ? `申请日期：${esc(tx.submittedAt)} · ${estimated ? '估算净值日期' : '净值日期'}：${esc(row.date || '待确认')}`
    : `净值日期：${esc(row.date || '待填')}${tx.recordedAt ? ` · 录入日期：${esc(String(tx.recordedAt).slice(0, 10))}` : ' · 录入日期：原表未记录'}`;
  const detailMetrics = [
    `<div><dt>成交净值</dt><dd class="num">${number(values.nav, 4)}</dd></div>`,
    metric('确认份额', values.shares, 2), metric('实际手续费', values.fee),
    ...(performance.kind === 'lot' ? [metric('本笔剩余市值', performance.marketValue)] : []),
    ...(performance.kind === 'lot' || performance.kind === 'sell' ? [metric(performance.kind === 'sell' ? '卖出成本（FIFO）' : row.type === 'reinvest' ? '新增投入' : '本笔原始成本', performance.cost)] : []),
    ...(performance.kind === 'lot' ? [metric('本笔剩余份额', performance.remainingShares, 2), metric('本笔剩余成本', performance.remainingCost), metric('本笔卖出回款', performance.proceeds), metric('本笔分红', performance.cashDividends), metric('本笔已实现盈亏', performance.realizedProfit, 2, signClass(performance.realizedProfit)), metric('本笔未实现盈亏', performance.unrealizedProfit, 2, signClass(performance.unrealizedProfit))] : []),
  ];
  const profitLabel = performance.kind === 'sell' ? performance.estimated ? '本笔已实现盈亏（估算）' : '本笔已实现盈亏' : performance.kind === 'dividend' ? '本笔分红收益' : performance.estimated ? '本笔累计盈亏（估算）' : '本笔累计盈亏';
  const pendingHint = Number.isFinite(tx.nav) && tx.nav > 0 ? '表格资料待补全' : '表格净值待补全';
  const profitSummary = pending
    ? `<span class="transaction-pending-hint">${pendingHint}</span>`
    : `<span class="transaction-profit-summary"><span class="transaction-profit-label">${profitLabel}</span><span class="transaction-profit-values"><strong class="transaction-profit-value num ${signClass(performance.profit)}">${sensitive(performance.profit)}</strong>${performance.kind === 'dividend' ? '' : `<span class="transaction-profit-rate num ${signClass(performance.returnRate)}">${percent(performance.returnRate)}</span>`}</span></span>`;
  const estimateExtras = performance.kind === 'lot' ? `<p class="helper detail-date-note">估值净值日期 ${esc(performance.valuationDate || '待更新')}${performance.estimated ? ' · 含估算交易' : ''}</p>` : '';
  return `<article class="transaction${pending ? ' transaction-pending' : ''}"><details class="transaction-detail" data-id="${esc(row.id)}"><summary class="transaction-expand"><div class="transaction-top"><div class="transaction-label"><span class="transaction-type-icon ${out ? 'out' : ''}">${icon(out ? 'up' : row.type === 'reinvest' ? 'coins' : 'down')}</span><div><p class="transaction-title">${esc(TYPE_NAMES[row.type] || '未知类型')}<span class="row-status${pending ? ' row-status-pending' : ''}">${esc(label)}</span></p><p class="transaction-date">${displayDate} · 第 ${row.index} 笔</p></div></div><div class="transaction-top-right"><p class="transaction-amount num">${included && row.type === 'reinvest' ? sensitive(values.shares, 2) : sensitive(row.amount ?? tx.amount ?? tx.cost)}<small>${!included ? '记录金额 · 元' : row.type === 'reinvest' ? '增加份额 · 份' : estimated ? '估算支出 · 元' : out ? '实际到账 · 元' : '确认支出 · 元'}</small></p></div></div>
    ${row.error ? `<p class="row-error">${esc(row.error)}</p>` : ''}
    <div class="transaction-profit-row">${profitSummary}<span class="transaction-detail-toggle">详细信息<span class="transaction-detail-chevron" aria-hidden="true">⌄</span></span></div></summary><div class="detail-inner"><dl class="transaction-stats transaction-detail-metrics">${detailMetrics.join('')}</dl><p class="helper detail-date-note">${dateNote}</p>${row.estimateReason ? `<p class="helper detail-date-note">${esc(row.estimateReason)}</p>` : ''}${estimateExtras}${hasNote && state.visible ? `<p class="transaction-note">备注：${esc(tx.note)}</p>` : ''}</div></details></article>`;
}
app.addEventListener('toggle', event => {
  const panel = event.target;
  if (panel.matches('details[data-bond-ledger]') && state.unlocked && checkSession()) { state.bondExpanded[panel.dataset.bondLedger] = panel.open; return; }
  if (!panel.matches('details[data-panel]') || !app.contains(panel) || !state.unlocked || !checkSession()) return;
  state.expandedPanels[panel.dataset.panel] = panel.open;
  if (panel.dataset.panel === 'discipline-long-term' && panel.classList) {
    if (!panel.open) panel.classList.remove('holding-progress-visible');
    else if (!panel.classList.contains('holding-progress-visible')) {
      panel.querySelectorAll('.holding-progress-fill').forEach(fill => fill.getBoundingClientRect());
      panel.classList.add('holding-progress-visible');
    }
  }
}, true);
app.addEventListener('submit', event => {
  if (event.target.id === 'unlock-form') return unlock(event);
  if (event.target.id === 'nav-estimate-form') {
    event.preventDefault();
    for (const code of new Set([...Object.keys(state.estimateDrafts), ...Object.keys(state.estimateDirections)])) queueEstimateSave(code, 0);
    return;
  }
  if (event.target.id === 'cash-flow-form') return saveCashFlow(event);
});
app.addEventListener('change', event => {
  if (!state.unlocked || !checkSession()) return;
  if (event.target.closest?.('#nav-estimate-form') && /^estimate-\d{6}$/.test(event.target.name)) { queueEstimateSave(event.target.name.slice(9), 0); return; }
  if (event.target.matches?.('[data-nav-boundary]')) {
    const input = event.target;
    const code = input.dataset.fund;
    updateNavRange(code, moveNavBoundary(state.nav[code]?.history || [], navSelection(code), input.dataset.navBoundary, input.value, navContext(code)));
    return;
  }
  if (event.target.id === 'type-filter' || event.target.id === 'status-filter') {
    state[event.target.id === 'type-filter' ? 'filter' : 'statusFilter'] = event.target.value;
    state.limit = 25;
    const position = scrollY;
    render();
    scrollTo({ top: position, behavior: 'instant' });
  }
});
function setEstimateDirection(code, direction, source = null) {
  state.estimateDirections[code] = direction;
  const row = source?.closest?.('.estimate-row') || app.querySelector(`[data-estimate-fund="${code}"]`);
  const button = row?.querySelector?.('.estimate-direction');
  if (button) {
    button.dataset.direction = direction;
    button.setAttribute('aria-checked', String(direction === 'up'));
    const fund = FUNDS.find(item => item.code === code);
    button.setAttribute('aria-label', `${fund?.name || ''}估值方向：${direction === 'up' ? '涨' : '跌'}，点击切换`);
  }
  const hidden = row?.querySelector?.(`[name="direction-${code}"]`);
  if (hidden) hidden.value = direction;
}

app.addEventListener('input', event => {
  const input = event.target;
  if (input.closest?.('#nav-estimate-form')) {
    if (state.unlocked && checkSession() && /^estimate-\d{6}$/.test(input.name)) {
      const code = input.name.slice(9);
      if (FUND_CODES.includes(code)) {
        const raw = String(input.value).trim();
        if (/^[+-](?:\d+(?:\.\d+)?|\.\d+)\s*%?$/.test(raw)) {
          setEstimateDirection(code, raw.startsWith('-') ? 'down' : 'up', input);
          input.value = raw.slice(1);
        }
        state.estimateDrafts[code] = input.value;
        queueEstimateSave(code);
      }
    }
    return;
  }
  if (!input.matches('[data-nav-boundary]') || !state.unlocked || !checkSession()) return;
  const code = input.dataset.fund;
  const history = state.nav[code]?.history || [];
  updateNavRange(code, moveNavBoundary(history, navSelection(code), input.dataset.navBoundary, input.value, navContext(code)));
});
function actionClick(event) {
  if (state.unlocked && !checkSession()) { event.preventDefault(); return; }
  if (event.target.closest('.skip-link')) {
    event.preventDefault();
    const main = document.querySelector('main');
    if (main) { main.tabIndex = -1; main.focus({ preventScroll: true }); main.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    return;
  }
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const action = target.dataset.action;
  if (action === 'theme') {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    animateChange(() => {
      setTheme(next);
      try { localStorage.setItem('fund-ledger-theme', next); } catch {}
      document.querySelectorAll('[data-action="theme"]').forEach(button => { button.innerHTML = icon(next === 'dark' ? 'sun' : 'moon'); button.title = button.ariaLabel = `切换到${next === 'dark' ? '白天' : '黑夜'}模式`; });
    });
    return;
  }
  if (!state.unlocked) return;
  if (action === 'estimate-direction' && FUND_CODES.includes(target.dataset.code)) {
    setEstimateDirection(target.dataset.code, target.dataset.direction === 'down' ? 'up' : 'down', target);
    queueEstimateSave(target.dataset.code);
    return;
  }
  if (action === 'cash-edit' && selectedBonds() && !state.cashBusy && !state.cashUnavailable && bondStore) {
    state.cashEditing = true;
    state.cashDraft = Number.isFinite(state.freeCashFlow) ? String(state.freeCashFlow) : '';
    state.cashError = '';
    render();
  }
  if (action === 'cash-cancel' && !state.cashBusy) {
    state.cashEditing = false;
    state.cashDraft = null;
    state.cashError = '';
    render();
  }
  if (action === 'nav-period') updateNavRange(target.dataset.fund, { preset: target.dataset.period }, { reset: true });
  if (action === 'nav-cycle') {
    const details = navCycleDetails(target.dataset.cycle);
    if (details) updateNavRange(target.dataset.fund, { preset: details.next }, { reset: true });
  }
  if (action === 'privacy') {
    activeTransition?.skipTransition();
    state.visible = !state.visible;
    const position = scrollY;
    const expanded = [...app.querySelectorAll('.transaction-detail[open]')].map(detail => detail.dataset.id);
    render();
    app.querySelectorAll('.transaction-detail').forEach(detail => { if (expanded.includes(detail.dataset.id)) detail.open = true; });
    scrollTo({ top: position, behavior: 'instant' });
  }
  if (action === 'lock') lock();
  if (action === 'mode') {
    getBook(selectedCode()).mode = target.dataset.mode;
    const position = scrollY;
    animateChange(() => { render(); scrollTo({ top: position, behavior: 'instant' }); });
    toast(`已切换为${target.dataset.mode === 'profit-first' ? '利润优先' : '本金优先'}，历史已重算`);
  }
  if (action === 'more') { const position = scrollY; state.limit += 25; render(); scrollTo({ top: position, behavior: 'instant' }); }
  if (action === 'reset-filter') { state.filter = 'all'; state.statusFilter = 'all'; render(); }
}
setupNavChartInteractions(app);
navSliders = setupNavSliderInteractions(app, { onUpdate(update) {
  if (!state.unlocked || !checkSession()) { navSliders?.cancel(); return; }
  const history = state.nav[update.code]?.history;
  if (!history?.length) return;
  const { start, end } = update.range;
  if (!history[start] || !history[end]) return;
  updateNavRange(update.code, { from: history[start].date, to: history[end].date }, { visualDomain: update.domain, visualValues: update.values });
} });
document.addEventListener('click', actionClick);
window.addEventListener('hashchange', () => {
  if (!state.unlocked || !checkSession()) return;
  const previousFund = fundCodeFromHash(lastRenderedRoute);
  const nextFund = selectedCode();
  const section = routeSection();
  // A lateral fund switch keeps the comparison viewport and the panel choices.
  const preserveFundView = Boolean(previousFund && nextFund && previousFund !== nextFund && !section);
  state.limit = 25;
  state.filter = 'all';
  state.statusFilter = 'all';
  if (preserveFundView) recordPanelState(previousFund);
  else state.expandedPanels = {};
  render();
  if (!preserveFundView && !['us-exposure', 'bond-reserve', 'add-discipline'].includes(section)) scrollTo({ top: 0, behavior: 'instant' });
});
window.addEventListener('pageshow', event => { if (event.persisted) lock(); });
document.addEventListener('visibilitychange', () => { if (checkSession()) dataRefresh.check(); });
window.addEventListener('focus', () => { if (checkSession()) dataRefresh.check(); });
renderGate();
