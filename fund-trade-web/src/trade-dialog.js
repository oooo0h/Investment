// Registration and transfer-review dialogs. Rendering only; the caller owns
// state, validation and network requests. Amounts appear only in the active
// review form the user opened to reconcile a real transfer.
import { buyFee } from './fee-rules.js?v=20261021-fee-rules';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const number = (value, digits = 2) => Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value) : '—';

export const TRADE_FUNDS = Object.freeze([
  { code: '005698', label: '华夏科技', name: '华夏全球科技先锋', group: '权益' },
  { code: '270023', label: '广发全球', name: '广发全球精选', group: '权益' },
  { code: '006373', label: '国富科技', name: '国富全球科技互联', group: '权益' },
  { code: '016701', label: '银华数字', name: '银华海外数字经济', group: '权益' },
  { code: '006485', label: '广发中债1-3年', name: '广发中债1-3年国开行', group: '债券' },
  { code: '006663', label: '易方达安悦超短债', name: '易方达安悦超短债', group: '债券' },
  { code: '004103', label: '中信保诚稳悦', name: '中信保诚稳悦', group: '债券' },
]);

export const CASH_CODE = 'CASH';
const CASH_OPTION = Object.freeze({ code: CASH_CODE, label: '自由现金流', name: '本机现金记录', group: '现金' });
export const TRADE_OPTIONS = Object.freeze([CASH_OPTION, ...TRADE_FUNDS]);
export const inferTradeMode = draft => {
  if (!draft) return 'buy';
  const leftCash = draft.code === CASH_CODE;
  const rightCash = draft.targetCode === CASH_CODE;
  if (leftCash && rightCash) return 'invalid';
  if (leftCash) return 'buy';
  if (rightCash) return 'sell';
  return 'transfer';
};

const optionByCode = code => TRADE_OPTIONS.find(item => item.code === code) || CASH_OPTION;
const modeText = mode => mode === 'sell' ? '卖出' : mode === 'transfer' ? '转换' : mode === 'invalid' ? '待选择' : '买入';
const modeRoute = mode => mode === 'sell' ? '基金 → 自由现金流' : mode === 'transfer' ? '基金 → 基金' : mode === 'invalid' ? '两侧不能都是自由现金流' : '自由现金流 → 基金';
const roleFor = (side, mode) => mode === 'transfer'
  ? (side === 'left' ? '转出基金' : '转入基金')
  : mode === 'sell'
    ? (side === 'left' ? '卖出基金' : '自由现金流')
    : (side === 'left' ? '自由现金流' : '买入基金');
const sharesText = (value, visible) => Number.isFinite(value) ? `${visible ? number(value, 2) : '已隐藏'} 份` : '待核验';
const feeText = (feeInfo, amount) => feeInfo
  ? `预计手续费 ${number(feeInfo.fee, 2)} 元${feeInfo.rate !== null ? `（费率 ${(feeInfo.rate * 100).toFixed(3)}%）` : '（固定 1000 元）'}`
  : amount > 0 ? '按买入金额和费率档位自动计算手续费。' : '填写金额后显示预计手续费。';
const arrowSvg = '<svg viewBox="0 0 120 64" aria-hidden="true"><path d="M8 24h94M88 12l14 12-14 12M112 40H18M32 28 18 40l14 12"/></svg>';
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const CALENDAR_MIN = '2026-01';
const CALENDAR_MAX = '2026-12';
const padDate = value => String(value).padStart(2, '0');
const normalizeDate = value => {
  const match = String(value || '').match(/^(\d{4})[/-](\d{2})[/-](\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
};
const monthOf = value => {
  const iso = normalizeDate(value);
  return iso ? iso.slice(0, 7) : CALENDAR_MAX;
};
const clampMonth = value => value < CALENDAR_MIN ? CALENDAR_MIN : value > CALENDAR_MAX ? CALENDAR_MAX : value;
const shiftMonth = (value, step) => {
  const match = String(value || '').match(/^(\d{4})-(\d{2})$/);
  if (!match) return CALENDAR_MAX;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + step, 1));
  return clampMonth(`${date.getUTCFullYear()}-${padDate(date.getUTCMonth() + 1)}`);
};

function calendarMarkup(draft, calendar) {
  const month = clampMonth(calendar?.month || monthOf(draft.date));
  const [year, monthNumber] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year, monthNumber - 1, 1));
  const leading = (first.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const selected = normalizeDate(draft.date);
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  let cells = '';
  for (let index = 0; index < 42; index += 1) {
    const day = index - leading + 1;
    if (day < 1 || day > daysInMonth) {
      cells += '<span class="trade-calendar-day is-empty" aria-hidden="true"></span>';
      continue;
    }
    const iso = `${year}-${padDate(monthNumber)}-${padDate(day)}`;
    const weekend = index % 7 >= 5 ? ' is-weekend' : '';
    const current = iso === selected ? ' is-selected' : '';
    const now = iso === today ? ' is-today' : '';
    cells += `<button type="button" class="trade-calendar-day${weekend}${current}${now}" data-action="trade-calendar-pick" data-date="${iso}" aria-pressed="${iso === selected}" aria-label="${iso}">${day}</button>`;
  }
  return `<section class="trade-calendar" role="group" aria-label="选择下单日期" tabindex="-1">
    <div class="trade-calendar-head"><button type="button" class="trade-calendar-nav" data-action="trade-calendar-month" data-step="-1" aria-label="上一个月"${month === CALENDAR_MIN ? ' disabled' : ''}>‹</button><strong>${year}年${monthNumber}月</strong><button type="button" class="trade-calendar-nav" data-action="trade-calendar-month" data-step="1" aria-label="下一个月"${month === CALENDAR_MAX ? ' disabled' : ''}>›</button></div>
    <div class="trade-calendar-weekdays">${WEEKDAYS.map(day => `<span>${day}</span>`).join('')}</div>
    <div class="trade-calendar-grid">${cells}</div>
  </section>`;
}

function cashBody({ mode, side, draft, busy }) {
  if (mode === 'buy' && side === 'left') {
    return `<label class="trade-card-field"><span>买入总支出（元）</span><input name="amount" type="text" inputmode="decimal" autocomplete="off" value="${esc(draft.amount)}" placeholder="填写金额"${busy ? ' disabled' : ''}></label><p class="trade-card-hint">从自由现金流支出；手续费见右侧基金卡片。</p>`;
  }
  return `<div class="trade-cash-summary"><strong>${mode === 'sell' ? '赎回款回到现金' : '自由现金流'}</strong><p>${mode === 'sell' ? '净值公布后回填到账金额；本机现金不会被静默改写。' : '选择右侧基金后自动进入买入。'}</p></div>`;
}

function fundBody({ mode, side, code, shares, visible, busy, draft }) {
  if (mode === 'buy') {
    const feeInfo = Number(draft.amount) > 0 ? buyFee(code, Number(draft.amount)) : null;
    return `<p class="trade-card-hint">买入金额在左侧自由现金流卡片填写。</p><p class="trade-fee-preview" data-trade-fee>${feeText(feeInfo, Number(draft.amount))}</p><div class="trade-fund-holding">买入份额 <strong>净值公布后回填</strong></div>`;
  }
  if (mode === 'sell' || (mode === 'transfer' && side === 'left')) {
    const label = mode === 'sell' ? '卖出份额' : '转出份额';
    return `<div class="trade-fund-holding">当前持有 <strong>${sharesText(shares, visible)}</strong></div><label class="trade-card-field"><span>${label}</span><span class="trade-card-inputrow"><input name="outShares" type="text" inputmode="decimal" autocomplete="off" value="${esc(draft.outShares)}" placeholder="例如 1000.000000"${busy ? ' disabled' : ''}><button type="button" class="trade-link-button" data-action="trade-fill-shares"${busy || !Number.isFinite(shares) ? ' disabled' : ''}>全部</button></span></label><p class="trade-card-hint">${mode === 'sell' ? '按成交日期起算持有天数，以 FIFO 计算赎回费。' : '按成交日期起算持有天数，以 FIFO 计算转出赎回费。'}</p>`;
  }
  return `<div class="trade-fund-wait"><span aria-hidden="true">⇠</span><strong>待回填</strong><small>按转出到账金额</small></div><div class="trade-fund-holding">当前持有 <strong>${sharesText(shares, visible)}</strong></div><p class="trade-card-status">转入金额与份额在两端净值公布后回填；核对前暂不计入。</p>`;
}

function tradeStack(side, selectedCode, otherCode, { mode, sharesByCode, visible, busy, draft }) {
  const selectedIndex = Math.max(0, TRADE_OPTIONS.findIndex(option => option.code === selectedCode));
  const role = roleFor(side, mode);
  const ordered = [];
  for (let step = 4; step >= 1; step -= 1) ordered.push({ option: TRADE_OPTIONS[(selectedIndex - step + TRADE_OPTIONS.length) % TRADE_OPTIONS.length], distance: step });
  ordered.push({ option: TRADE_OPTIONS[selectedIndex], distance: 0 });
  for (let step = 1; step <= 3; step += 1) ordered.push({ option: TRADE_OPTIONS[(selectedIndex + step) % TRADE_OPTIONS.length], distance: step });
  const cards = ordered.map(({ option, distance }) => {
    const selected = distance === 0;
    const opacity = selected ? 1 : Math.max(.06, 1 - distance * .23);
    const code = option.code;
    const shares = sharesByCode[code];
    const body = selected
      ? code === CASH_CODE
        ? cashBody({ mode, side, draft, otherCode, busy })
        : fundBody({ mode, side, code, shares, visible, busy, draft })
      : '';
    return `<article class="trade-stack-card${selected ? ' is-selected' : ''}${code === CASH_CODE ? ' is-cash' : ''}" style="--distance:${distance};--opacity:${opacity}" data-action="trade-pick" data-side="${side}" data-code="${code}" aria-label="${role}：${esc(option.label)}${selected ? '，已选中' : ''}">
      <div class="trade-stack-head"><span class="trade-stack-role">${selected ? role : side === 'left' ? '左侧' : '右侧'}</span><span class="trade-stack-code">${code === CASH_CODE ? '现金' : esc(code)} · ${esc(option.group)}</span></div>
      <div class="trade-stack-name">${esc(option.label)}</div>${selected ? `<div class="trade-stack-sub">${esc(option.name)}</div><div class="trade-stack-body">${body}</div>` : ''}
    </article>`;
  }).join('');
  return `<div class="trade-side" data-trade-side="${side}"><div class="trade-stack" data-stack="${side}" tabindex="0" role="group" aria-label="选择${role}"${busy ? ' aria-disabled="true"' : ''}>${cards}</div></div>`;
}

export function renderTradeDialog({ draft, navPreview, currentShares, sharesByCode = {}, busy = false, error = '', visible = false, calendar = { open: false, month: null } } = {}) {
  if (!draft) return '';
  const mode = inferTradeMode(draft);
  const transfer = mode === 'transfer';
  const left = optionByCode(draft.code);
  const right = optionByCode(draft.targetCode);
  const calendarPanel = calendarMarkup(draft, calendar);
  const preview = navPreview?.error
    ? `<span class="trade-preview-error">${esc(navPreview.error)}</span>`
    : `预计净值日 <strong>${esc(navPreview?.date || '—')}</strong>${navPreview?.orderDate && navPreview.date !== navPreview.orderDate ? `（下单日 ${esc(navPreview.orderDate)}，已顺延）` : ''}`;
  const shares = { ...sharesByCode, ...(Number.isFinite(currentShares) && draft.code !== CASH_CODE ? { [draft.code]: currentShares } : {}) };
  const note = transfer ? '两行先写入日期、类型与转出份额；两端净值公布后回填，并提醒二次核对。' : mode === 'sell' ? '卖出份额按成交日期计算持有天数；净值公布后回填净值、手续费和到账金额。' : '写入日期为顺延后的净值日；净值未公布时先显示进行中。';
  const center = `<div class="trade-center"><div class="trade-mode-badge" data-trade-mode="${mode}"><span>${modeText(mode)}</span><small>${modeRoute(mode)}</small></div><div class="trade-calendar-wrap">${calendarPanel}</div><div class="trade-global"><div class="trade-global-field"><span>下单时间</span><button type="button" class="trade-cutoff" data-action="trade-cutoff" role="switch" aria-checked="${draft.cutoff === 'after'}"${busy ? ' disabled' : ''}><span class="trade-cutoff-label">15:00 前</span><span class="trade-cutoff-track" aria-hidden="true"><span class="trade-cutoff-thumb"></span></span><span class="trade-cutoff-label">15:00 后</span></button></div></div><button type="button" class="trade-arrow" data-action="trade-reverse" aria-label="交换左右两侧资产" title="交换左右两侧资产"${busy ? ' disabled' : ''}>${arrowSvg}</button><button type="button" class="button primary trade-save" data-action="trade-submit"${busy ? ' disabled' : ''}>${busy ? '正在保存…' : '保存并同步'}</button><p class="trade-nav-preview" data-trade-nav-preview>${preview}</p><p class="trade-error" role="alert">${esc(error)}</p><p class="trade-note">${note}</p></div>`;
  return `<div class="trade-dialog-backdrop trade-register-backdrop" data-trade-backdrop><section class="trade-dialog trade-board-dialog" role="dialog" aria-modal="true" aria-labelledby="trade-dialog-title" tabindex="-1">
    <div class="trade-dialog-heading"><div><h2 id="trade-dialog-title">登记交易</h2><p class="helper">滚动卡片选择两侧资产；中间自动判断买入、卖出或转换。</p></div><button type="button" class="trade-dialog-close" data-action="trade-close" aria-label="关闭登记窗口"${busy ? ' disabled' : ''}>×</button></div>
    <form id="trade-form" novalidate>
      <div class="trade-board" data-trade-board="${mode}">${tradeStack('left', draft.code, draft.targetCode, { mode, sharesByCode: shares, visible, busy, draft })}${center}${tradeStack('right', draft.targetCode, draft.code, { mode, sharesByCode: shares, visible, busy, draft })}</div>
      <input type="hidden" name="code" value="${esc(left.code)}"><input type="hidden" name="targetCode" value="${esc(right.code)}">
    </form>
  </section></div>`;
}

function amountText(value) { return Number.isFinite(value) ? number(value, 2) : '待回填'; }

export function renderReviewDialog({ records = [], rows = {}, reviewId = null, draft = null, fundName = code => code, busy = false, error = '', result = null } = {}) {
  const record = records.find(item => item.id === reviewId) || null;
  if (!records.length && !result) return '';
  const list = records.map(item => {
    const row = rows[item.id] || {};
    const difference = Number.isFinite(row.outAmount) && Number.isFinite(row.inAmount) ? row.outAmount - row.inAmount : null;
    return `<article class="transfer-review-card" data-transfer-id="${esc(item.id)}"><div class="transfer-review-head"><div><strong>${esc(fundName(item.outCode))} → ${esc(fundName(item.inCode))}</strong><small>净值日 ${esc(item.navDate)} · 下单日 ${esc(item.orderDate)}</small></div>${reviewId === item.id ? '<span class="status-chip">正在核对</span>' : `<button type="button" class="button" data-action="review-open" data-id="${esc(item.id)}"${busy ? ' disabled' : ''}>核对</button>`}</div><dl class="transfer-review-values"><div><dt>转出金额（计算）</dt><dd class="num">${amountText(row.outAmount)}</dd></div><div><dt>转入金额（计算）</dt><dd class="num">${amountText(row.inAmount)}</dd></div><div><dt>预计退回现金</dt><dd class="num">${Number.isFinite(difference) ? number(Math.abs(difference), 2) + (difference < 0 ? '（需补足）' : '') : '—'}</dd></div></dl></article>`;
  }).join('');
  const form = record && draft ? `<form id="review-form" class="transfer-review-form" novalidate>
    <p class="helper">对照确认单填写实际金额；差额 = 转出到账 − 转入金额（含费），将退回自由现金流。</p>
    <div class="trade-row"><label class="trade-field"><span>实际转出到账金额（元）</span><input name="outAmount" type="text" inputmode="decimal" value="${esc(draft.outAmount)}"${busy ? ' disabled' : ''}></label><label class="trade-field"><span>实际转入金额（含费，元）</span><input name="inAmount" type="text" inputmode="decimal" value="${esc(draft.inAmount)}"${busy ? ' disabled' : ''}></label></div>
    <div class="trade-row"><label class="trade-field"><span>转出手续费（元）</span><input name="outFee" type="text" inputmode="decimal" value="${esc(draft.outFee)}"${busy ? ' disabled' : ''}></label><label class="trade-field"><span>转入手续费（元）</span><input name="inFee" type="text" inputmode="decimal" value="${esc(draft.inFee)}"${busy ? ' disabled' : ''}></label></div>
    <label class="trade-field"><span>转入确认份额（可留空自动算）</span><input name="inShares" type="text" inputmode="decimal" value="${esc(draft.inShares)}" placeholder="留空按转入金额÷净值"${busy ? ' disabled' : ''}></label>
    <p class="transfer-difference">差额 <strong class="num" data-review-difference>—</strong> 元</p>
    <p class="trade-error" role="alert">${esc(error)}</p>
    <div class="trade-actions"><button type="button" class="button" data-action="review-cancel"${busy ? ' disabled' : ''}>取消</button><button type="button" class="button primary" data-action="review-submit"${busy ? ' disabled' : ''}>${busy ? '正在保存…' : '确认核对'}</button></div>
  </form>` : '';
  const resultPanel = result ? `<div class="transfer-result"><p>核对已保存。差额 <strong class="num">${esc(number(Math.abs(result.difference ?? 0), 2))}</strong> 元${result.difference < 0 ? '需从自由现金流补足' : '应退回自由现金流'}。</p><p class="helper">是否把这笔差额计入自由现金流？</p><p class="trade-error" role="alert">${esc(error)}</p><div class="trade-actions"><button type="button" class="button" data-action="review-cash-skip"${busy ? ' disabled' : ''}>暂不调整</button><button type="button" class="button primary" data-action="review-cash-confirm"${busy ? ' disabled' : ''}>计入自由现金流</button></div></div>` : '';
  return `<div class="trade-dialog-backdrop" data-trade-backdrop><section class="trade-dialog trade-review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-dialog-title" tabindex="-1">
    <div class="trade-dialog-heading"><div><h2 id="review-dialog-title">转换二次核对</h2><p class="helper">双方真实净值已更新，请对照确认单核对实际金额；本窗口会显示具体金额。</p></div><button type="button" class="trade-dialog-close" data-action="review-close" aria-label="关闭核对窗口"${busy ? ' disabled' : ''}>×</button></div>
    ${resultPanel}${result ? '' : `<div class="transfer-review-list">${list || '<p class="helper">暂无待核对的转换记录。</p>'}</div>${form}`}
  </section></div>`;
}
