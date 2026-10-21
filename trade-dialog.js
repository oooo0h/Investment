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

const fundByCode = code => TRADE_FUNDS.find(fund => fund.code === code) || TRADE_FUNDS[0];
const modeButton = (mode, label, current, busy) => `<button type="button" data-action="trade-mode" data-mode="${mode}" aria-pressed="${mode === current}"${busy ? ' disabled' : ''}>${label}</button>`;
const sharesText = (value, visible) => Number.isFinite(value) ? `${visible ? number(value, 2) : '已隐藏'} 份` : '待核验';
const feeText = (feeInfo, amount) => feeInfo
  ? `预计手续费 ${number(feeInfo.fee, 2)} 元${feeInfo.rate !== null ? `（费率 ${(feeInfo.rate * 100).toFixed(3)}%）` : '（固定 1000 元）'}`
  : amount > 0 ? '按买入金额和费率档位自动计算手续费。' : '填写金额后显示预计手续费。';

function cashCard(side) {
  const buy = side === 'out';
  return `<article class="cash-card ${side}"><span class="cash-card-icon" aria-hidden="true">¥</span><div><span class="cash-card-role">自由现金流</span><strong class="cash-card-name">${buy ? '支出' : '到账'}</strong></div><p class="cash-card-note">${buy ? '买入金额从自由现金流扣减；本机现金不会被静默改写。' : '赎回款回到自由现金流；净值公布后回填到账金额。'}</p></article>`;
}

function fundCardBody({ mode, side, shares, visible, busy, draft }) {
  if (mode === 'buy') {
    const feeInfo = Number(draft.amount) > 0 ? buyFee(draft.code, Number(draft.amount)) : null;
    return `<label class="trade-card-field"><span>买入总支出（元）</span><input name="amount" type="text" inputmode="decimal" autocomplete="off" value="${esc(draft.amount)}" placeholder="填写金额"${busy ? ' disabled' : ''}></label><p class="trade-card-hint">含手续费；按买入金额档位自动计算。</p><p class="trade-fee-preview" data-trade-fee>${feeText(feeInfo, Number(draft.amount))}</p>`;
  }
  if (mode === 'sell' || side === 'out') {
    const label = mode === 'sell' ? '卖出份额' : '转出份额';
    return `<div class="trade-fund-holding">当前持有 <strong>${sharesText(shares, visible)}</strong></div><label class="trade-card-field"><span>${label}</span><span class="trade-card-inputrow"><input name="outShares" type="text" inputmode="decimal" autocomplete="off" value="${esc(draft.outShares)}" placeholder="例如 1000.000000"${busy ? ' disabled' : ''}><button type="button" class="trade-link-button" data-action="trade-fill-shares"${busy || !Number.isFinite(shares) ? ' disabled' : ''}>全部</button></span></label><p class="trade-card-hint">${mode === 'sell' ? '按成交日期起算持有天数，以 FIFO 计算赎回费。' : '按成交日期起算持有天数，以 FIFO 计算转出赎回费。'}</p>`;
  }
  return `<div class="trade-fund-wait"><span aria-hidden="true">⇠</span><strong>待回填</strong><small>按转出到账金额</small></div><div class="trade-fund-holding">当前持有 <strong>${sharesText(shares, visible)}</strong></div><p class="trade-card-status">转入金额与份额在两端净值公布后回填；核对前暂不计入。</p>`;
}

function fundCarousel(side, code, { mode, sharesByCode, visible, busy, draft, skipCode = null }) {
  const board = TRADE_FUNDS.filter(fund => fund.code !== skipCode);
  const active = board.find(fund => fund.code === code) || fundByCode(code);
  const role = side === 'in' ? '转入基金' : side === 'out' ? '转出基金' : '基金';
  const shares = sharesByCode[active.code];
  const stepButton = (step, label) => `<button type="button" class="trade-card-step" data-action="trade-fund-step" data-side="${side}" data-step="${step}" aria-label="${label}：${esc(active.label)}"${busy ? ' disabled' : ''}>${step < 0 ? '▲' : '▼'}</button>`;
  return `<div class="trade-side" data-trade-side="${side}"><div class="fund-carousel" data-carousel="${side}" tabindex="0" role="group" aria-label="选择${role}"${busy ? ' aria-disabled="true"' : ''}>
    <article class="trade-fund-card active" id="fund-option-${side}-${active.code}" data-trade-card="${side}" aria-label="${role}：${esc(active.label)}">
      <div class="trade-fund-head"><span class="trade-fund-role">${role}</span><span class="trade-fund-meta"><span class="trade-fund-code">${active.code} · ${active.group}</span><span class="trade-card-nav">${stepButton(-1, '上一只')}${stepButton(1, '下一只')}</span></span></div>
      <div class="trade-fund-name" aria-live="polite">${esc(active.label)}</div>
      <div class="trade-fund-sub">${esc(active.name)}</div>
      <div class="trade-fund-body">${fundCardBody({ mode, side, shares, visible, busy, draft })}</div>
    </article>
  </div><span class="fund-carousel-hint">滚轮切换${mode === 'transfer' ? ' · 中间箭头反转' : ''}</span></div>`;
}

export function renderTradeDialog({ draft, navPreview, currentShares, sharesByCode = {}, busy = false, error = '', visible = false } = {}) {
  if (!draft) return '';
  const transfer = draft.mode === 'transfer';
  const preview = navPreview?.error
    ? `<span class="trade-preview-error">${esc(navPreview.error)}</span>`
    : `预计净值日 <strong>${esc(navPreview?.date || '—')}</strong>${navPreview?.orderDate && navPreview.date !== navPreview.orderDate ? `（下单日 ${esc(navPreview.orderDate)}，已顺延）` : ''}`;
  const shares = { ...sharesByCode, ...(Number.isFinite(currentShares) ? { [draft.code]: currentShares } : {}) };
  const arrow = transfer
    ? `<button type="button" class="trade-reverse" data-action="trade-reverse" aria-label="反转转出和转入基金" title="反转转出和转入基金"${busy ? ' disabled' : ''}>⇄</button>`
    : '<span class="trade-direction" aria-hidden="true">→</span>';
  const center = `<div class="trade-center"><div class="trade-mode-switch trade-mode-rail" role="group" aria-label="操作模式">${modeButton('buy', '买入', draft.mode, busy)}${modeButton('sell', '卖出', draft.mode, busy)}${modeButton('transfer', '转换', draft.mode, busy)}</div>${arrow}<div class="trade-global"><label class="trade-global-field"><span>下单日期</span><input name="date" type="text" inputmode="numeric" autocomplete="off" maxlength="20" value="${esc(draft.date)}" placeholder="YYYY/MM/DD"${busy ? ' disabled' : ''}></label><div class="trade-global-field"><span>下单时间</span><button type="button" class="trade-cutoff" data-action="trade-cutoff" role="switch" aria-checked="${draft.cutoff === 'after'}"${busy ? ' disabled' : ''}><span class="trade-cutoff-label">15:00 前</span><span class="trade-cutoff-track" aria-hidden="true"><span class="trade-cutoff-thumb"></span></span><span class="trade-cutoff-label">15:00 后</span></button></div></div><p class="trade-nav-preview" data-trade-nav-preview>${preview}</p></div>`;
  const board = transfer
    ? `${fundCarousel('out', draft.code, { mode: draft.mode, sharesByCode: shares, visible, busy, draft, skipCode: draft.targetCode })}${center}${fundCarousel('in', draft.targetCode, { mode: draft.mode, sharesByCode: shares, visible, busy, draft, skipCode: draft.code })}`
    : draft.mode === 'buy'
      ? `${cashCard('out')}${center}${fundCarousel('fund', draft.code, { mode: draft.mode, sharesByCode: shares, visible, busy, draft })}`
      : `${fundCarousel('fund', draft.code, { mode: draft.mode, sharesByCode: shares, visible, busy, draft })}${center}${cashCard('in')}`;
  return `<div class="trade-dialog-backdrop trade-register-backdrop" data-trade-backdrop><section class="trade-dialog trade-board-dialog" role="dialog" aria-modal="true" aria-labelledby="trade-dialog-title" tabindex="-1">
    <div class="trade-dialog-heading"><div><h2 id="trade-dialog-title">登记交易</h2><p class="helper">滚动基金卡片选择；模式、日期和时间在中间设置。</p></div><button type="button" class="trade-dialog-close" data-action="trade-close" aria-label="关闭登记窗口"${busy ? ' disabled' : ''}>×</button></div>
    <form id="trade-form" novalidate>
      <div class="trade-board" data-trade-board="${draft.mode}">${board}</div>
      <input type="hidden" name="code" value="${esc(draft.code)}">${transfer ? `<input type="hidden" name="targetCode" value="${esc(draft.targetCode)}">` : ''}
      <p class="trade-note">${transfer ? '两行先写入日期、类型与转出份额；两端净值公布后按费率回填，并提醒你做二次核对。' : draft.mode === 'sell' ? '卖出份额按成交日期计算持有天数；净值公布后回填净值、手续费和到账金额。' : '写入日期为顺延后的净值日；净值未公布时先显示进行中。'}</p>
      <p class="trade-error" role="alert">${esc(error)}</p>
      <div class="trade-actions"><button type="button" class="button" data-action="trade-close"${busy ? ' disabled' : ''}>取消</button><button type="button" class="button primary" data-action="trade-submit"${busy ? ' disabled' : ''}>${busy ? '正在保存…' : '保存并同步'}</button></div>
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
