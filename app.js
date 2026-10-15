import { calculateLedger } from './engine.js';

const FUNDS = [
  { code: '005698', short: '华夏', initial: '华', name: '华夏全球科技先锋', fullName: '华夏全球科技先锋混合（QDII）A', brand: 'huaxia', category: '混合 · QDII · 人民币 A', rate: '0.15' },
  { code: '270023', short: '广发', initial: '广', name: '广发全球精选', fullName: '广发全球精选股票（QDII）A', brand: 'guangfa', category: '股票 · QDII · 人民币 A', rate: '0.16' },
  { code: '006373', short: '国富', initial: '国', name: '国富全球科技互联', fullName: '国富全球科技互联混合（QDII）人民币 A', brand: 'guofu', category: '混合 · QDII · 人民币 A', rate: '0.15' },
  { code: '016701', short: '银华', initial: '银', name: '银华海外数字经济', fullName: '银华海外数字经济量化选股混合发起式（QDII）A', brand: 'yinhua', category: '混合 · QDII · 人民币 A', rate: null },
];
const TYPE_NAMES = { buy: '买入', sip: '定投', sell: '卖出', reinvest: '红利再投', dividend: '现金分红', 'transfer-in': '转换转入' };
const STATUS_NAMES = { confirmed: '已确认', estimated: '历史估算', pending: '待确认', cancelled: '撤单', failed: '交易失败', closed: '交易关闭' };
const state = { unlocked: false, visible: false, funds: {}, nav: {}, limit: 25, filter: 'all', statusFilter: 'all', gateBusy: false, createdAt: null, deadline: 0, dayDeadline: 0, sessionDay: null };
const app = document.querySelector('#app');
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
const selectedCode = () => /^#\/fund\/(005698|270023|006373|016701)$/.exec(location.hash)?.[1] ?? null;
const selectedFund = () => FUNDS.find(fund => fund.code === selectedCode());
const getBook = code => state.funds[code] ||= { transactions: [], mode: 'profit-first', rate: FUNDS.find(fund => fund.code === code).rate, incomplete: false, sourceNote: '' };
const currentTheme = () => document.documentElement.dataset.theme;
let toastTimer;
let transitioning = false;
let activeTransition = null;
let sessionInterval = null;
let sessionTimeout = null;
let dailyCodeReader = null;
let unlockGeneration = 0;
const SESSION_DURATION = 180000;

function stopSessionTimers() {
  clearInterval(sessionInterval);
  clearTimeout(sessionTimeout);
  sessionInterval = null;
  sessionTimeout = null;
}

function remainingTime() {
  const seconds = Math.max(0, Math.ceil((Math.min(state.deadline, state.dayDeadline || state.deadline) - Date.now()) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function updateSessionTimer() {
  const timer = document.querySelector('#session-timer');
  if (!timer) return;
  timer.textContent = `剩余 ${remainingTime()}`;
  timer.dataset.urgent = String(state.deadline - Date.now() <= 30000);
}

function checkSession() {
  if (!state.unlocked) return false;
  if (Date.now() >= state.deadline) { lock('timeout'); return false; }
  if (!dailyCodeReader || dailyCodeReader() !== state.sessionDay) { lock('day-change'); return false; }
  updateSessionTimer();
  return true;
}

function startSession(day, getDailyCode) {
  stopSessionTimers();
  const now = Date.now();
  const dayLength = 24 * 60 * 60 * 1000;
  const beijingOffset = 8 * 60 * 60 * 1000;
  state.deadline = now + SESSION_DURATION;
  state.dayDeadline = (Math.floor((now + beijingOffset) / dayLength) + 1) * dayLength - beijingOffset;
  state.sessionDay = day;
  dailyCodeReader = getDailyCode;
  sessionInterval = setInterval(checkSession, 1000);
  sessionTimeout = setTimeout(checkSession, Math.min(SESSION_DURATION, state.dayDeadline - now));
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
  document.title = '解锁 · 基金账本';
  app.innerHTML = `<main id="main" class="gate"><div class="gate-theme">${themeButton()}</div><div class="gate-content">
    <div class="brand"><span class="brand-mark">${icon('book')}</span>基金账本</div>
    <section class="gate-panel"><div class="gate-lock">${icon('lock')}</div><h1>打开你的基金账本</h1>
      <p class="gate-description">当日日期密码，解锁有效 3 分钟。<br>按北京时间当天日期输入 MMDD。金额默认隐藏。</p>
      <form id="unlock-form" class="gate-form"><label for="vault-password">当日日期密码<input id="vault-password" name="password" type="password" inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" autocomplete="off" required aria-describedby="gate-error"></label>
        <button type="submit" class="button primary">解锁账本${icon('arrow')}</button><p id="gate-error" class="gate-error" role="alert">${esc(notice)}</p>
      </form>
    </section><p class="gate-footnote">${icon('shield')}<span>密码只用于本机解密，不会上传。到期、跨日、刷新或加锁后，需要重新验证。</span></p>
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
  input.value = '';
  try {
    const { unlockVault, getDailyCode } = await import('./vault.js?v=20261015-daily2');
    if (!isCurrent()) { password = ''; return; }
    const sessionDay = getDailyCode();
    const vault = await unlockVault(password);
    password = '';
    if (!isCurrent()) return;
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
    state.visible = false;
    state.unlocked = true;
    startSession(sessionDay, getDailyCode);
    render();
    loadPublicNav();
  } catch {
    password = '';
    if (!isCurrent()) return;
    stopSessionTimers();
    state.unlocked = false;
    state.visible = false;
    state.funds = {};
    state.createdAt = null;
    state.deadline = 0;
    state.dayDeadline = 0;
    state.sessionDay = null;
    dailyCodeReader = null;
    renderGate('未能解锁，请检查日期密码后重试。');
    document.querySelector('#vault-password').focus();
  } finally {
    password = '';
    if (isCurrent()) {
      state.gateBusy = false;
      if (!state.unlocked) { button.disabled = false; button.innerHTML = `解锁账本${icon('arrow')}`; }
    }
  }
}

function lock(reason = 'manual') {
  unlockGeneration += 1;
  state.gateBusy = false;
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
  document.querySelector('#toast').classList.remove('visible');
  renderGate(reason === 'timeout' ? '解锁已到期，请重新验证。' : reason === 'day-change' ? '日期已更新，请使用当日日期密码。' : '');
}

async function loadPublicNav() {
  await Promise.allSettled(FUNDS.map(async ({ code }) => {
    try {
      const response = await fetch(`./data/nav/${code}.json`);
      if (!response.ok) throw new Error('unavailable');
      const result = await response.json();
      if (result.code !== code || !Array.isArray(result.history)) throw new Error('invalid');
      result.history = result.history.filter(point => /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.nav) && point.nav > 0).sort((a, b) => a.date.localeCompare(b.date));
      state.nav[code] = result;
    } catch { state.nav[code] = { history: [], unavailable: true }; }
  }));
  if (state.unlocked && checkSession()) render();
}

function valuation(code) { return state.nav[code]?.history.at(-1) || null; }

function ledger(code) {
  const book = getBook(code);
  const estimate = valuation(code);
  const result = calculateLedger(book.incomplete ? [] : book.transactions, { mode: book.mode, valuationNav: estimate?.nav ?? null, valuationDate: estimate?.date ?? null, openingPrincipal: 0, openingShares: 0 });
  if (!book.transactions.length || book.incomplete) {
    for (const key of ['shares', 'principal', 'marketValue', 'holdingProfit', 'holdingReturn', 'totalInvested', 'totalRecovered', 'totalProfitWithdrawn', 'totalClosedLoss', 'totalProfit', 'totalReturn']) result.summary[key] = null;
  }
  if (book.incomplete) {
    result.rows = book.transactions.slice().sort((a, b) => String(a.submittedAt || '').localeCompare(String(b.submittedAt || ''))).map((tx, index) => ({ ...tx, index: index + 1, status: ['cancelled', '撤单'].includes(tx.status) ? 'excluded' : 'pending' }));
    Object.assign(result.summary, { valid: false, principalStatus: null, identityCheck: null, valuationNav: null, valuationDate: null, lastNav: null, lastDate: null, includedCount: 0, pendingCount: result.rows.filter(row => row.status === 'pending').length, estimatedCount: 0 });
  }
  return result;
}

function header(code) {
  return `<header class="site-header"><div class="header-inner">
    <a href="#/" class="brand" aria-label="基金账本首页"><span class="brand-mark">${icon('book')}</span><span class="brand-copy"><span>基金账本</span><span id="session-timer" class="session-timer" role="timer" aria-label="本次解锁剩余时间" aria-live="off">剩余 ${remainingTime()}</span></span></a>
    <nav class="desktop-nav" aria-label="主要导航"><a href="#/" class="${code ? '' : 'active'}" ${code ? '' : 'aria-current="page"'}>我的基金</a>${FUNDS.map(fund => `<a href="#/fund/${fund.code}" class="${code === fund.code ? 'active' : ''}" ${code === fund.code ? 'aria-current="page"' : ''}>${fund.short}账本</a>`).join('')}</nav>
    <div class="header-actions"><button type="button" class="icon-button" data-action="privacy" aria-label="${state.visible ? '隐藏' : '显示'}金额和份额" title="${state.visible ? '隐藏' : '显示'}金额和份额" aria-pressed="${state.visible}">${icon(state.visible ? 'eye' : 'eye-off')}</button>${themeButton()}<button type="button" class="icon-button" data-action="lock" aria-label="加锁账本" title="加锁账本">${icon('lock')}</button></div>
  </div></header>`;
}

function bottomNav(code) {
  return `<nav class="bottom-nav" aria-label="手机导航"><a href="#/" class="${code ? '' : 'active'}" ${code ? '' : 'aria-current="page"'}>${icon('home')}<span>首页</span></a>${FUNDS.map(fund => `<a href="#/fund/${fund.code}" class="${code === fund.code ? 'active' : ''}" ${code === fund.code ? 'aria-current="page"' : ''}><span class="nav-letter">${fund.initial}</span><span>${fund.short}</span></a>`).join('')}</nav>`;
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

function render() {
  if (!state.unlocked) { renderGate(); return; }
  if (!checkSession()) return;
  const fund = selectedFund();
  document.title = fund ? `${fund.short}账本 · 基金账本` : '我的基金 · 基金账本';
  app.innerHTML = `${header(fund?.code)}${fund ? fundPage(fund) : homePage()}${bottomNav(fund?.code)}<footer class="footer"><span>基金账本 · 交易计算与净值日期分开核对</span><span>数据在本机解密 · 更新后重新发布</span></footer>`;
}

function homePage() {
  return `<main id="main" class="workspace home-page"><div class="page-heading"><div><p class="eyebrow">PERSONAL FUND LEDGER</p><h1>我的基金</h1><p class="subtitle">每笔交易有据可查，每一分收益清楚归属。</p></div><span class="status-chip dot">账本已解锁</span></div>
    <div class="session-note">${icon('shield')}<span>${state.visible ? '当前显示金额和份额。点击右上角小眼睛可随时隐藏。' : '金额和份额已隐藏。点击右上角小眼睛可显示。'} 每次解锁有效 3 分钟，到期或北京时间跨日后自动加锁。</span></div>
    <div class="section-heading"><h2>基金账本</h2><span class="helper">人民币 A 类 · ${FUNDS.length} 只基金</span></div>
    <div class="fund-list">${FUNDS.map(fund => {
      const { summary } = ledger(fund.code);
      const book = getBook(fund.code);
      if (book.incomplete) {
        const info = applicationInfo(book);
        return `<a class="fund-card brand-${fund.brand}" href="#/fund/${fund.code}" aria-label="进入${fund.fullName}账本"><div class="fund-id"><span class="fund-initial">${fund.initial}</span><div><h3 class="fund-name">${fund.name}</h3><p class="fund-description"><span class="fund-code">${fund.code}</span>${fund.category}</p></div></div><div><p class="card-label">已导入记录</p><p class="card-value num">${info.count}<small class="record-unit">条</small></p><p class="helper">${info.processing} 进行中 · ${info.unverified} 待核验 · ${info.cancelled} 已撤单</p></div><div><p class="card-label">最近申请日期</p><p class="card-date num">${esc(info.lastDate)}</p><p class="helper">查看申请记录</p></div><span class="enter-arrow">${icon('arrow')}</span></a>`;
      }
      return `<a class="fund-card brand-${fund.brand}" href="#/fund/${fund.code}" aria-label="进入${fund.fullName}账本"><div class="fund-id"><span class="fund-initial">${fund.initial}</span><div><h3 class="fund-name">${fund.name}</h3><p class="fund-description"><span class="fund-code">${fund.code}</span>${fund.category}</p></div></div><div><p class="card-label">当前市值</p><p class="card-value num">${sensitive(summary.marketValue)}</p><p class="helper">${book.transactions.length ? `${book.transactions.length} 笔交易` : '尚无交易'} · ${book.mode === 'principal-first' ? '本金优先' : '利润优先'}</p>${summary.lastDate ? `<p class="helper">最近交易 ${esc(summary.lastDate)}</p>` : ''}</div><div><p class="card-label">持有收益率</p><p class="card-return num ${signClass(summary.holdingReturn)}">${percent(summary.holdingReturn)}</p><p class="helper">${summary.valid ? summary.valuationDate ? `净值日期 ${esc(summary.valuationDate)}` : '等待净值' : '有交易待修正'}</p></div><span class="enter-arrow">${icon('arrow')}</span></a>`;
    }).join('')}</div>
    <div class="home-bottom"><section class="panel"><h2>两种模式，同一本账</h2><div class="method-inline"><div><h3>利润优先</h3><p>卖出到账先提取当时可用利润，剩余部分冲减本金。</p></div><div><h3>本金优先</h3><p>卖出到账先回收本金，超过剩余本金的部分计作提取利润。</p></div></div><p class="helper details-box">在基金页随时切换，全部历史交易会按所选口径重新计算。</p></section><section class="panel"><h2>使用提醒</h2><ul class="quiet-list"><li>以交易确认单的净值、份额和实际手续费为准。</li><li>QDII 净值可能延迟公布，请留意估值采用的日期。</li><li>账本展示已发布的数据快照，数据更新后重新发布。</li></ul></section></div>
  </main>`;
}

function metric(label, value, digits = 2, extra = '') {
  return `<div><dt>${label}</dt><dd class="num ${extra}">${sensitive(value, digits)}</dd></div>`;
}

function fundPage(fund) {
  const book = getBook(fund.code);
  const result = ledger(fund.code);
  if (book.incomplete) return applicationPage(fund, book, result);
  const { summary, errors } = result;
  const principalState = book.incomplete ? '成交资料待补充' : !book.transactions.length ? '尚未配置交易数据' : { empty: '当前无持仓', recovered: '本金已全部回收', invested: '仍有本金在持' }[summary.principalStatus] || '请先修正交易';
  return `<main id="main" class="workspace fund-page brand-${fund.brand}"><a class="back-link" href="#/">${icon('back')}我的基金</a><div class="page-heading"><div class="fund-title-line"><span class="fund-initial">${fund.initial}</span><div><h1>${fund.name}</h1><p class="fund-subtitle"><span class="fund-code">${fund.code}</span>${fund.category}</p></div></div><span class="status-chip dot">已发布账本</span></div>
    <div class="fund-layout"><div class="main-column"><section class="panel summary-panel"><div class="section-heading"><h2>持仓与收益</h2><span class="status-chip">${principalState}</span></div>
      ${summary.lastDate ? `<p class="helper">最近交易日期 ${esc(summary.lastDate)}</p>` : ''}
      ${book.sourceNote ? `<p class="source-note">${icon('info')}<span>${esc(book.sourceNote)}</span></p>` : ''}
      <div class="mode-control ${book.mode}" role="group" aria-label="卖出到账分配模式"><button data-action="mode" data-mode="profit-first" aria-pressed="${book.mode === 'profit-first'}" ${book.incomplete ? 'disabled' : ''}>利润优先</button><button data-action="mode" data-mode="principal-first" aria-pressed="${book.mode === 'principal-first'}" ${book.incomplete ? 'disabled' : ''}>本金优先</button></div><p class="mode-explanation">${book.incomplete ? '目前仅展示申请记录。补充已确认净值、份额和手续费后，才能计算本金与收益。' : `${book.mode === 'profit-first' ? '到账先提取当时可用利润，再回收本金。' : '到账先回收剩余本金，超出部分计为提取利润。'} 切换会重算全部历史。`}</p>
      ${errors.length ? `<div class="error-note" role="alert">第 ${errors[0].index} 笔交易待修正：${esc(errors[0].message)}<br>修正前暂停展示汇总结果。</div>` : ''}
      <div class="summary-main"><div><p class="card-label">当前市值（元）</p><p class="card-value num">${sensitive(summary.marketValue)}</p><p class="helper">${book.incomplete ? '成交资料待补充，暂不估值' : `估值净值日期 ${esc(summary.valuationDate || '尚无可用净值')}`}</p></div><div class="summary-return"><p class="card-label">持有收益率</p><span class="num ${signClass(summary.holdingReturn)}">${percent(summary.holdingReturn)}</span></div></div>
      <dl class="summary-grid">${metric('剩余本金（元）', summary.principal)}${metric('持有收益（元）', summary.holdingProfit, 2, signClass(summary.holdingProfit))}${metric('持有份额', summary.shares, 6)}${metric('累计投入（元）', summary.totalInvested)}${metric('累计到账（元）', summary.totalRecovered)}${metric('已提取利润（元）', summary.totalProfitWithdrawn)}${metric('累计收益（元）', summary.totalProfit, 2, signClass(summary.totalProfit))}<div><dt>累计收益率</dt><dd class="num ${signClass(summary.totalReturn)}">${percent(summary.totalReturn)}</dd></div>${metric('清仓损失（元）', summary.totalClosedLoss)}</dl>
      <p class="summary-foot">${icon('info')}<span>${book.incomplete ? `${book.transactions.length} 条申请记录 · ${summary.pendingCount} 条待确认或待核验。所有申请记录均未计入持仓、成本或收益，已撤单记录仅供追溯。` : `${summary.includedCount} 笔计入 · ${summary.pendingCount} 笔待确认或待修正 · ${summary.estimatedCount} 笔历史估算。累计收益率为累计收益 ÷ 累计投入，非年化。`}</span></p>
    </section>${ledgerPanel(result, book)}</div><aside class="side-column">${navPanel(fund)}${feePanel(fund, book)}</aside></div></main>`;
}

function applicationPage(fund, book, result) {
  const info = applicationInfo(book);
  return `<main id="main" class="workspace fund-page application-page brand-${fund.brand}"><a class="back-link" href="#/">${icon('back')}我的基金</a><div class="page-heading"><div class="fund-title-line"><span class="fund-initial">${fund.initial}</span><div><h1>${fund.name}</h1><p class="fund-subtitle"><span class="fund-code">${fund.code}</span>${fund.category}</p></div></div></div><div class="fund-layout"><div class="main-column"><section class="panel summary-panel application-overview"><div class="section-heading"><h2>已导入 ${info.count} 条申请记录</h2><span class="status-chip">截图已上传</span></div><p class="application-dates">最近申请 <strong class="num">${esc(info.lastDate)}</strong><span>记录范围 ${esc(info.firstDate)} 至 ${esc(info.lastDate)}</span></p><dl class="application-counts"><div><dt>进行中</dt><dd class="num">${info.processing}</dd></div><div><dt>待核验</dt><dd class="num">${info.unverified}</dd></div><div><dt>已撤单</dt><dd class="num">${info.cancelled}</dd></div></dl><p class="helper application-notice">申请记录如下。截图未提供成交净值、确认份额和实际手续费，收益暂不计算。</p></section>${ledgerPanel(result, book)}</div><aside class="side-column">${navPanel(fund)}${feePanel(fund, book)}</aside></div></main>`;
}

function sparkline(history) {
  const points = history.slice(-60);
  if (points.length < 2) return '';
  const min = Math.min(...points.map(point => point.nav));
  const max = Math.max(...points.map(point => point.nav));
  const range = max - min || 1;
  const coordinates = points.map((point, index) => `${number(index / (points.length - 1) * 250, 2).replaceAll(',', '')},${number(76 - (point.nav - min) / range * 64, 2).replaceAll(',', '')}`).join(' ');
  return `<svg class="sparkline" viewBox="0 0 250 87" preserveAspectRatio="none" role="img" aria-label="最近 ${points.length} 个已公布净值走势"><path d="M0 81H250" stroke="var(--line)" stroke-width="1"/><polyline points="${coordinates}" pathLength="1"/></svg><p class="chart-caption"><span>${esc(points[0].date)}</span><span>${esc(points.at(-1).date)}</span></p>`;
}

function safeSource(value) {
  try { const url = new URL(value); return url.protocol === 'https:' ? esc(url.href) : ''; } catch { return ''; }
}

function navPanel(fund) {
  const nav = state.nav[fund.code];
  const last = nav?.history.at(-1);
  const before = nav?.history.at(-2);
  const change = last && before ? last.nav / before.nav - 1 : null;
  const source = safeSource(nav?.source);
  return `<section class="panel nav-panel"><div class="section-heading"><h2>公开净值</h2><span class="helper">人民币 A</span></div><div class="nav-value"><strong class="num">${last ? number(last.nav, 4) : '—'}</strong><span class="num ${signClass(change)}">${percent(change)}</span></div><p class="nav-date">${last ? `净值日期 ${esc(last.date)}` : nav?.unavailable ? '公开净值暂不可用' : '正在读取公开净值…'}</p>${nav?.history ? sparkline(nav.history) : ''}<p class="helper">最近 60 个已公布净值 · 非账户收益曲线</p><p class="helper details-box">${source ? `<a class="inline-source" href="${source}" target="_blank" rel="noopener noreferrer">公开净值来源</a> · ` : ''}本站净值为发布时快照，非实时自动更新。同步日期不等于净值日期。</p></section>`;
}

function feePanel(fund, book) {
  return `<section class="panel fee-panel"><h2>费用与口径</h2><dl class="fee-display"><dt>买入参考费率</dt>${book.rate === null ? '<dd class="fee-unknown">以实际确认为准</dd>' : `<dd class="num">${esc(book.rate)}<small>%</small></dd>`}</dl><p class="helper">${book.rate === null ? '参考费率尚未配置，' : '平台优惠费率仅供参考，'}账本计算使用每笔交易的实际手续费。</p><details class="details-box"><summary>查看计算说明</summary><ul class="quiet-list"><li>买入和定投：本金按含手续费的总支出累计。</li><li>红利再投：增加份额，不增加投入本金。</li><li>现金分红：按实际到账金额处理。</li><li>卖出：实际到账按所选模式分配给本金与利润。</li><li>撤单、失败、关闭与待确认交易不计入持仓。</li><li>全部份额卖出时，未收回本金计入清仓损失。</li></ul></details></section>`;
}
function ledgerPanel(result, book) {
  const filtered = result.rows.filter(row => (state.filter === 'all' || row.type === state.filter) && (state.statusFilter === 'all' || row.status === state.statusFilter || (book.incomplete && row.sourceStatus === state.statusFilter) || (state.statusFilter === 'error' && row.status === 'blocked')));
  const shown = filtered.slice().reverse().slice(0, state.limit);
  const statusOptions = book.incomplete ? [['all', '全部状态'], ['processing', '进行中'], ['unverified', '待核验'], ['excluded', '已撤单']] : [['all', '全部状态'], ['included', '已计入'], ['pending', '待确认'], ['excluded', '未计入'], ['error', '待修正']];
  return `<section class="panel ledger-panel"><div class="section-heading"><div><h2>${book.incomplete ? '申请记录' : '逐笔交易'}</h2><p class="helper">${book.incomplete ? '按申请时间倒序 · 申请日期不作为净值日期' : '最近交易在前 · 展开查看分配明细'}</p></div><span class="fund-code">${book.transactions.length} ${book.incomplete ? '条' : '笔'}</span></div>
    <div class="ledger-toolbar"><select id="type-filter" aria-label="筛选交易类型"><option value="all">全部类型</option>${Object.entries(TYPE_NAMES).map(([key, label]) => `<option value="${key}" ${state.filter === key ? 'selected' : ''}>${label}</option>`).join('')}</select><select id="status-filter" aria-label="筛选记录状态">${statusOptions.map(([key, label]) => `<option value="${key}" ${state.statusFilter === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
    <div class="transaction-list">${shown.length ? shown.map(row => transactionCard(row, book)).join('') : `<div class="empty-state">${icon('book')}<h3>${book.transactions.length ? '没有符合条件的交易' : '尚未配置交易数据'}</h3><p>${book.transactions.length ? '调整类型或状态筛选，查看其他记录。' : '此账本已准备好，更新交易数据并重新发布后即可查看。'}</p>${book.transactions.length ? '<button class="button" data-action="reset-filter">清除筛选</button>' : ''}</div>`}</div>${filtered.length > shown.length ? `<button class="button more-button" data-action="more">再显示 25 笔 · 还有 ${filtered.length - shown.length} 笔</button>` : ''}</section>`;
}

function transactionCard(row, book) {
  const tx = book.transactions.find(item => item.id === row.id) || row;
  const out = row.type === 'sell' || row.type === 'dividend';
  const label = book.incomplete ? row.status === 'excluded' ? '已撤单' : { processing: '进行中', unverified: '待核验' }[tx.sourceStatus] || '待确认' : row.status === 'included' ? (['estimated', '历史估算'].includes(tx.status) ? '历史估算' : '已确认') : { pending: '待确认', excluded: STATUS_NAMES[tx.status] || tx.status || '未计入', error: '待修正', blocked: '前序待修正' }[row.status];
  const hasNote = tx.note !== undefined && tx.note !== null && String(tx.note).trim() !== '';
  const dateNote = book.incomplete ? `净值日期：${esc(tx.date || '待确认')} · 申请日期：${esc(tx.submittedAt || '待补充')}。申请日期不用于持仓估值。` : `净值日期：${esc(tx.date || '待填')}${tx.recordedAt ? ` · 录入日期：${esc(String(tx.recordedAt).slice(0, 10))}` : ' · 录入日期：原表未记录'}。两者含义不同。`;
  const detailMetrics = [metric('成交净值', null), metric('确认份额', tx.shares, 6), metric('实际手续费', tx.fee), metric('本笔份额变动', row.shareChange, 6), metric('交易后份额', row.sharesAfter, 6), metric('交易前市值', row.valueBefore), metric('当时可用利润', row.availableProfit), metric('本笔提取利润', row.profitWithdrawn), metric('本笔回收本金', row.principalRecovered), metric('交易后本金', row.principalAfter), metric('交易后市值', row.valueAfter), metric('本笔清仓损失', row.closedLoss), metric('累计投入', row.totalInvested), metric('累计到账', row.totalRecovered), metric('累计提取利润', row.totalProfitWithdrawn), metric('累计清仓损失', row.totalClosedLoss), metric('累计收益', row.totalProfit)];
  detailMetrics[0] = `<div><dt>成交净值</dt><dd class="num">${number(tx.nav, 4)}</dd></div>`;
  return `<article class="transaction"><div class="transaction-top"><div class="transaction-label"><span class="transaction-type-icon ${out ? 'out' : ''}">${icon(out ? 'up' : row.type === 'reinvest' ? 'coins' : 'down')}</span><div><p class="transaction-title">${esc(TYPE_NAMES[row.type] || '未知类型')}${book.incomplete ? '申请' : ''}<span class="row-status">${esc(label)}</span></p><p class="transaction-date">${book.incomplete ? `申请日期 ${esc(tx.submittedAt || '待补充')}` : esc(row.date || '净值日期待填')} · 第 ${row.index} ${book.incomplete ? '条' : '笔'}</p></div></div><p class="transaction-amount num">${row.type === 'reinvest' ? sensitive(tx.shares, 6) : sensitive(row.amount ?? tx.amount ?? tx.cost)}<small>${book.incomplete ? '申请金额 · 元' : row.type === 'reinvest' ? '增加份额 · 份' : out ? '实际到账 · 元' : '确认支出 · 元'}</small></p></div>
    ${book.incomplete ? '' : `<dl class="transaction-stats">${metric('剩余本金', row.principalAfter)}${metric('交易后收益', row.holdingProfit, 2, signClass(row.holdingProfit))}<div><dt>交易后收益率</dt><dd class="num ${signClass(row.holdingReturn)}">${percent(row.holdingReturn)}</dd></div></dl>`}${row.error ? `<p class="row-error">${esc(row.error)}</p>` : ''}
    <details class="transaction-detail" data-id="${esc(row.id)}"><summary>${book.incomplete ? '申请信息与待补充成交资料' : '成交与分配明细'}</summary><div class="detail-inner">${book.incomplete ? '<p class="helper detail-date-note">成交净值、确认份额与实际手续费尚待补充。</p>' : `<dl class="transaction-stats">${detailMetrics.join('')}</dl>`}<p class="helper detail-date-note">${dateNote}</p>${hasNote ? `<p class="transaction-note">${state.visible ? `备注：${esc(tx.note)}` : '备注已隐藏'}</p>` : ''}</div></details></article>`;
}

app.addEventListener('submit', event => {
  if (event.target.id === 'unlock-form') return unlock(event);
});
app.addEventListener('change', event => {
  if (!state.unlocked || !checkSession()) return;
  if (event.target.id === 'type-filter' || event.target.id === 'status-filter') {
    state[event.target.id === 'type-filter' ? 'filter' : 'statusFilter'] = event.target.value;
    state.limit = 25;
    const position = scrollY;
    render();
    scrollTo({ top: position, behavior: 'instant' });
  }
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
  if (!target) return;
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
    if (getBook(selectedCode()).incomplete) return;
    getBook(selectedCode()).mode = target.dataset.mode;
    const position = scrollY;
    animateChange(() => { render(); scrollTo({ top: position, behavior: 'instant' }); });
    toast(`已切换为${target.dataset.mode === 'profit-first' ? '利润优先' : '本金优先'}，历史已重算`);
  }
  if (action === 'more') { const position = scrollY; state.limit += 25; render(); scrollTo({ top: position, behavior: 'instant' }); }
  if (action === 'reset-filter') { state.filter = 'all'; state.statusFilter = 'all'; render(); }
}
document.addEventListener('click', actionClick);
window.addEventListener('hashchange', () => { if (!state.unlocked || !checkSession()) return; state.limit = 25; state.filter = 'all'; state.statusFilter = 'all'; render(); scrollTo({ top: 0, behavior: 'instant' }); });
window.addEventListener('pageshow', event => { if (event.persisted) lock(); });
document.addEventListener('visibilitychange', checkSession);
window.addEventListener('focus', checkSession);
renderGate();
