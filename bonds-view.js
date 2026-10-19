import { calculateBondSummary } from './bond-model.js?v=20261019-free-cash-flow';
import { BOND_FEE_RULES } from './bond-holding-duration.js?v=20261019-bond-calculated-lots';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const numberFormat = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signClass = value => Number.isFinite(value) ? value > 0 ? 'positive' : value < 0 ? 'negative' : '' : '';
const percentage = value => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${numberFormat.format(value * 100)}%` : '—';
const privateValue = (value, visible, digits = 2) => !Number.isFinite(value) ? '—' : visible
  ? escapeHtml((digits === 2 ? numberFormat : new Intl.NumberFormat('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })).format(value))
  : '<span class="masked" aria-label="已隐藏">••••••</span>';

function holdingDuration(entry, duration, visible) {
  const code = entry.code;
  const calculated = duration?.status === 'calculated';
  const known = ['known', 'calculated'].includes(duration?.status) && Number.isFinite(duration.recentRatio) && Number.isFinite(duration.matureRatio)
    && duration.recentRatio >= 0 && duration.recentRatio <= 1 && duration.matureRatio >= 0 && duration.matureRatio <= 1
    && Math.abs(duration.recentRatio + duration.matureRatio - 1) < 0.00001;
  const recent = known ? Math.round(duration.recentRatio * 100) : null;
  const mature = known ? 100 - recent : null;
  const recentValue = known ? Math.round(entry.marketValue * duration.recentRatio * 100) / 100 : null;
  const matureValue = known ? Math.round((entry.marketValue - recentValue) * 100) / 100 : null;
  const label = known ? `${calculated ? '按所提供流水推算，' : ''}未满30天约${recent}%，已满30天约${mature}%` : duration?.status === 'empty' ? '暂无持仓' : '持有期限待核验';
  const segment = (kind, title, ratio, value) => `<div class="bond-duration-${kind}-label"><span>${title}</span>${known ? `<div class="bond-duration-values"><strong class="num">${calculated ? '约' : ''}${ratio}%</strong><span class="bond-duration-amount num">${privateValue(value, visible)}<small>元</small></span></div>` : ''}</div>`;
  const fee = BOND_FEE_RULES[code];
  const feeRanges = fee?.redemption.map(range => `${range.minDays === 0 ? `&lt;${range.maxDaysExclusive}天` : range.maxDaysExclusive === null ? `≥${range.minDays}天` : `${range.minDays}～${range.maxDaysExclusive - 1}天`} ${Number((range.rate * 100).toPrecision(10))}%`).join(' / ');
  return `<section class="bond-holding-duration" data-bond-duration-status="${known ? calculated ? 'calculated' : 'known' : duration?.status === 'empty' ? 'empty' : 'unknown'}" aria-label="持有期分布"><div class="bond-duration-heading"><span>持有期分布</span>${known ? calculated ? '<span class="bond-duration-status">按所提供流水推算</span>' : '' : `<span class="bond-duration-status">${duration?.status === 'empty' ? '暂无持仓' : '待核验'}</span>`}</div><div class="bond-duration-track" role="img" aria-label="${label}">${known ? `<span class="bond-duration-recent" style="width:${recent}%"></span><span class="bond-duration-mature" style="width:${mature}%"></span>` : ''}</div><div class="bond-duration-labels">${segment('recent', '未满30天', recent, recentValue)}${segment('mature', '已满30天', mature, matureValue)}</div>${fee ? `<p class="bond-fee-rule">买入 ${fee.purchaseRate * 100}% · 卖出 ${feeRanges}</p>` : ''}</section>`;
}

const BOND_TYPES = { buy: '买入', sell: '卖出', 'transfer-in': '转换转入', 'transfer-out': '转换转出' };
const cancelled = row => ['cancelled', 'canceled', '撤单', '已撤单', '已撤销'].includes(row?.status) || ['cancelled', 'canceled'].includes(row?.sourceStatus);
function bondTransaction(row, visible) {
  const pending = row.status !== 'confirmed';
  const calculated = row.sharesBasis === 'calculated' || row.sourceStatus === 'calculated';
  const name = BOND_TYPES[row.type] || '交易';
  const amount = Number.isFinite(row.confirmedAmount) ? row.confirmedAmount : row.amount;
  const shares = Number.isFinite(row.shares) ? row.shares : row.requestedShares;
  const sharesOnly = !Number.isFinite(amount) && Number.isFinite(shares);
  const displayValue = sharesOnly ? privateValue(shares, visible, 6) : privateValue(amount, visible);
  const valueLabel = sharesOnly ? Number.isFinite(row.shares) ? calculated ? '推算份额 · 份' : '确认份额 · 份' : '申请份额 · 份' : Number.isFinite(row.confirmedAmount) ? calculated ? '推算金额 · 元' : '确认金额 · 元' : '申请金额 · 元';
  const status = pending ? row.sourceStatus === 'processing' ? '进行中' : '待核验' : calculated ? '按流水推算' : '已确认';
  const infoLabel = pending ? calculated ? '待补确认信息 · 按流水推算' : '待补确认信息' : calculated ? '推算资料' : '确认资料';
  const numeric = value => Number.isFinite(value) ? escapeHtml(value.toFixed(4)) : '—';
  const metrics = [[calculated ? '推算净值' : '确认净值', numeric(row.nav)], [calculated ? '推算份额' : '确认份额', privateValue(row.shares, visible, 6)], ['申请金额', privateValue(row.amount, visible)], ['申请份额', privateValue(row.requestedShares, visible, 6)], [calculated ? '推算金额' : '确认金额', privateValue(row.confirmedAmount, visible)], ['手续费', privateValue(row.fee, visible)], [calculated ? '推算净值日' : '净值日期', escapeHtml(row.navDate || '待补全')], [calculated ? '推算确认日' : '确认日期', escapeHtml(row.confirmedDate || '待补全')]];
  return `<article class="transaction bond-transaction${pending ? ' transaction-pending' : ''}"><div class="transaction-top"><div class="transaction-label"><div><p class="transaction-title">${name}<span class="row-status${pending ? ' row-status-pending' : ''}">${status}</span></p><p class="transaction-date">申请日期 ${escapeHtml(row.date || String(row.submittedAt || '').slice(0, 10) || '待补全')}</p></div></div><div class="transaction-top-right"><p class="transaction-amount num">${displayValue}<small>${valueLabel}</small></p></div></div><details class="transaction-detail" data-id="bond-${escapeHtml(row.id)}"><summary class="transaction-profit-row"><span class="${pending ? 'transaction-pending-hint' : 'helper'}">${infoLabel}</span><span class="transaction-detail-toggle">详细信息<span class="transaction-detail-chevron" aria-hidden="true">⌄</span></span></summary><div class="detail-inner"><dl class="transaction-stats transaction-detail-metrics">${metrics.map(([title, value]) => `<div><dt>${title}</dt><dd class="num">${value}</dd></div>`).join('')}</dl><p class="helper detail-date-note">申请时间 ${escapeHtml(row.submittedAt || row.date || '待补全')}</p>${visible && row.note ? `<p class="transaction-note">${escapeHtml(row.note)}</p>` : ''}</div></details></article>`;
}
function bondCard(entry, options) {
  const rows = (Array.isArray(options.transactions?.[entry.code]) ? options.transactions[entry.code] : []).filter(row => !cancelled(row)).slice().reverse();
  return `<details class="panel bond-card" data-bond-ledger="${escapeHtml(entry.code)}" aria-labelledby="bond-title-${escapeHtml(entry.code)}"${options.expandedByCode?.[entry.code] ? ' open' : ''}><summary class="bond-card-toggle"><header class="bond-card-heading"><div><p class="bond-code num">${escapeHtml(entry.code)}</p><h2 id="bond-title-${escapeHtml(entry.code)}">${escapeHtml(entry.name)}</h2></div><span class="bond-ledger-hint">${rows.length} 笔<span class="bond-ledger-chevron" aria-hidden="true">⌄</span></span></header><dl class="bond-metrics"><div><dt>当前持仓（元）</dt><dd class="num">${privateValue(entry.marketValue, options.visible)}</dd></div><div><dt>持有收益（元）</dt><dd class="num ${options.visible ? signClass(entry.holdingProfit) : ''}">${privateValue(entry.holdingProfit, options.visible)}</dd></div></dl><div class="bond-return"><span>持有收益率</span><strong class="num ${signClass(entry.returnRate)}">${percentage(entry.returnRate)}</strong></div>${holdingDuration(entry, options.holdingByCode?.[entry.code], options.visible)}</summary><section class="bond-transactions-panel" aria-label="${escapeHtml(entry.name)}逐笔交易"><h3>逐笔交易<span class="fund-code">${rows.length} 笔</span></h3><div class="transaction-list">${rows.length ? rows.map(row => bondTransaction(row, options.visible)).join('') : '<p class="helper">暂无交易记录</p>'}</div></section></details>`;
}

function reserveNote(reserve) {
  if (!reserve || !['below', 'unknown'].includes(reserve.status)) return '';
  const title = reserve.status === 'below' ? '债基配置未达标' : '债基配置待核验';
  return `<div class="bond-reserve-note"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7v1"/></svg><p><strong>${title}</strong>：${escapeHtml(reserve.message)}<a href="#/?section=bond-reserve">查看首页规则与原因</a></p></div>`;
}

function cashFlowValue(value, visible) {
  if (!Number.isFinite(value)) return '<span class="cash-flow-empty">未填写</span>';
  if (!visible) return '<span class="masked" aria-label="已隐藏">••••••</span><small>元</small>';
  return `<span class="num ${signClass(value)}">${value > 0 ? '+' : ''}${escapeHtml(numberFormat.format(value))}</span><small>元</small>`;
}

function cashFlowForm({ visible, draft, error, busy }) {
  const value = draft === null || draft === undefined ? '' : String(draft);
  const invalid = error ? ' aria-invalid="true" aria-describedby="cash-flow-hint cash-flow-error"' : ' aria-describedby="cash-flow-hint"';
  const disabled = busy ? ' disabled' : '';
  return `<form id="cash-flow-form" class="cash-flow-form" autocomplete="off" novalidate aria-busy="${Boolean(busy)}">
    <label for="free-cash-flow">自由现金流（元）<input id="free-cash-flow" name="freeCashFlow" type="${visible ? 'text' : 'password'}" inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="32" value="${escapeHtml(value)}" placeholder="未填写"${invalid}${disabled}></label>
    <p id="cash-flow-hint" class="helper cash-flow-hint">可为负数，留空表示未填写；不计入债基合计或配置比例。</p>
    ${error ? `<p id="cash-flow-error" class="bond-form-error" role="alert">${escapeHtml(error)}</p>` : ''}
    <div class="bond-form-actions"><button type="button" class="button quiet" data-action="cash-cancel"${disabled}>取消</button><button type="submit" class="button primary"${disabled}>${busy ? '保存中…' : '保存'}</button></div>
  </form>`;
}

function cashFlowPanel({ freeCashFlow = null, visible = false, editing = false, draft = null, error = '', busy = false, unavailable = false } = {}) {
  const hasValue = Number.isFinite(freeCashFlow);
  return `<section class="panel free-cash-flow-panel" aria-labelledby="free-cash-flow-title">
    <div class="cash-flow-heading"><div><p class="bond-code">CASH FLOW</p><h2 id="free-cash-flow-title">自由现金流</h2></div>${editing ? '<span class="bond-editing-state">编辑中</span>' : `<button type="button" class="button bond-edit-button" data-action="cash-edit"${busy || unavailable ? ' disabled' : ''}>${hasValue ? '编辑' : '填写'}</button>`}</div>
    ${editing ? cashFlowForm({ visible, draft, error, busy }) : `<p class="cash-flow-value">${unavailable ? '<span class="cash-flow-empty">本机现金流暂不可用</span>' : cashFlowValue(freeCashFlow, visible)}</p><p class="cash-flow-note">可自由支配的现金净额；不计入债基合计或配置比例。</p>`}
  </section>`;
}

/** Render data supplied by the local bond store; this module never reads storage. */
export function renderBondsPage({ entries = [], visible = false, transactions = {}, expandedByCode = {}, holdingByCode = {}, loading = false, unavailable = false, reserve = null, locateReserve = false, freeCashFlow = null, cashEditing = false, cashDraft = null, cashError = '', cashBusy = false, cashUnavailable = false } = {}) {
  const heading = '<header class="page-heading bonds-heading"><div><h1>债基</h1><p class="bonds-local-note">数据来自基金表格</p></div></header>';
  const reserveAttributes = `id="bonds-reserve-summary" tabindex="-1"${reserve ? ` data-bond-reserve-status="${escapeHtml(reserve.status)}"` : ''}`;
  const locationClass = locateReserve ? ' bond-reserve-location' : '';
  if (loading) return `<main id="main" class="workspace bonds-page">${heading}<section class="panel bonds-state" aria-busy="true"><p>正在读取债基记录…</p></section></main>`;
  let summary = null;
  if (!unavailable && Array.isArray(entries) && entries.length) {
    try { summary = calculateBondSummary(entries); } catch { /* Invalid or unavailable records have no financial display. */ }
  }
  if (!summary) return `<main id="main" class="workspace bonds-page">${heading}<section ${reserveAttributes} class="panel bonds-state${locationClass}" role="status">${reserveNote(reserve) || '<p>债基数据暂不可用</p>'}</section></main>`;
  const options = { visible: Boolean(visible), transactions, expandedByCode, holdingByCode };
  return `<main id="main" class="workspace bonds-page">${heading}
    <section ${reserveAttributes} class="panel bonds-summary${locationClass}" aria-label="债基合计">${reserveNote(reserve)}<dl>
      <div><dt>合计持仓（元）</dt><dd class="num">${privateValue(summary.marketValue, options.visible)}</dd></div>
      <div><dt>合计持有收益（元）</dt><dd class="num ${options.visible ? signClass(summary.holdingProfit) : ''}">${privateValue(summary.holdingProfit, options.visible)}</dd></div>
      <div class="bonds-summary-return"><dt>合计持有收益率</dt><dd class="num ${signClass(summary.returnRate)}">${percentage(summary.returnRate)}</dd></div>
    </dl><p class="bond-reserve-share"><span>占总持仓</span><strong class="num" data-bond-reserve-share>${Number.isFinite(reserve?.ratio) ? `${Math.round(reserve.ratio * 100)}%` : '待核验'}</strong></p></section>
    ${cashFlowPanel({ freeCashFlow, visible: options.visible, editing: cashEditing, draft: cashDraft, error: cashError, busy: cashBusy, unavailable: cashUnavailable })}
    <div class="bonds-grid">${summary.holdings.map(entry => bondCard(entry, options)).join('')}</div>
    <p class="helper bonds-rate-note">收益率＝持有收益 ÷（当前持仓金额－持有收益）</p>
  </main>`;
}
