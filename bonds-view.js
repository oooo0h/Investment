import { calculateBondSummary } from './bond-model.js?v=20261019-free-cash-flow';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const numberFormat = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signClass = value => Number.isFinite(value) ? value > 0 ? 'positive' : value < 0 ? 'negative' : '' : '';
const percentage = value => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${numberFormat.format(value * 100)}%` : '—';
const privateValue = (value, visible) => !Number.isFinite(value) ? '—' : visible
  ? escapeHtml(numberFormat.format(value))
  : '<span class="masked" aria-label="已隐藏">••••••</span>';

function editForm(entry, { visible, draft, error, busy }) {
  const values = draft && (!draft.code || draft.code === entry.code) ? draft : entry;
  const inputType = visible ? 'text' : 'password';
  const invalid = error ? ' aria-invalid="true" aria-describedby="bond-form-error"' : '';
  const disabled = busy ? ' disabled' : '';
  return `<form id="bond-edit-form" class="bond-edit-form" data-code="${escapeHtml(entry.code)}" autocomplete="off" novalidate aria-busy="${Boolean(busy)}">
    <input type="hidden" name="code" value="${escapeHtml(entry.code)}">
    <div class="bond-edit-fields">
      <label for="bond-market-value">当前持仓金额（元）<input id="bond-market-value" name="marketValue" type="${inputType}" inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="32" value="${escapeHtml(values.marketValue)}" required${invalid}${disabled}></label>
      <label for="bond-holding-profit">持有收益（元，可为负）<input id="bond-holding-profit" name="holdingProfit" type="${inputType}" inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="32" value="${escapeHtml(values.holdingProfit)}" required${invalid}${disabled}></label>
    </div>
    ${error ? `<p id="bond-form-error" class="bond-form-error" role="alert">${escapeHtml(error)}</p>` : ''}
    <div class="bond-form-actions"><button type="button" class="button quiet" data-action="bond-cancel"${disabled}>取消</button><button type="submit" class="button primary"${disabled}>${busy ? '保存中…' : '保存'}</button></div>
  </form>`;
}

function bondCard(entry, options) {
  const isEditing = options.editing === entry.code;
  return `<article class="panel bond-card" aria-labelledby="bond-title-${escapeHtml(entry.code)}">
    <header class="bond-card-heading"><div><p class="bond-code num">${escapeHtml(entry.code)}</p><h2 id="bond-title-${escapeHtml(entry.code)}">${escapeHtml(entry.name)}</h2></div>${isEditing ? '<span class="bond-editing-state">编辑中</span>' : `<button type="button" class="button bond-edit-button" data-action="bond-edit" data-code="${escapeHtml(entry.code)}" aria-label="编辑${escapeHtml(entry.name)}持仓"${options.busy ? ' disabled' : ''}>编辑</button>`}</header>
    ${isEditing ? editForm(entry, options) : `<dl class="bond-metrics">
      <div><dt>当前持仓（元）</dt><dd class="num">${privateValue(entry.marketValue, options.visible)}</dd></div>
      <div><dt>持有收益（元）</dt><dd class="num ${options.visible ? signClass(entry.holdingProfit) : ''}">${privateValue(entry.holdingProfit, options.visible)}</dd></div>
    </dl><div class="bond-return"><span>持有收益率</span><strong class="num ${signClass(entry.returnRate)}">${percentage(entry.returnRate)}</strong></div>`}
  </article>`;
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

function cashFlowPanel({ freeCashFlow = null, visible = false, editing = false, draft = null, error = '', busy = false } = {}) {
  const hasValue = Number.isFinite(freeCashFlow);
  return `<section class="panel free-cash-flow-panel" aria-labelledby="free-cash-flow-title">
    <div class="cash-flow-heading"><div><p class="bond-code">CASH FLOW</p><h2 id="free-cash-flow-title">自由现金流</h2></div>${editing ? '<span class="bond-editing-state">编辑中</span>' : `<button type="button" class="button bond-edit-button" data-action="cash-edit"${busy ? ' disabled' : ''}>${hasValue ? '编辑' : '填写'}</button>`}</div>
    ${editing ? cashFlowForm({ visible, draft, error, busy }) : `<p class="cash-flow-value">${cashFlowValue(freeCashFlow, visible)}</p><p class="cash-flow-note">可自由支配的现金净额；不计入债基合计或配置比例。</p>`}
  </section>`;
}

/** Render data supplied by the local bond store; this module never reads storage. */
export function renderBondsPage({ entries = [], visible = false, editing = null, draft = null, error = '', busy = false, loading = false, unavailable = false, reserve = null, locateReserve = false, freeCashFlow = null, cashEditing = false, cashDraft = null, cashError = '', cashBusy = false } = {}) {
  const heading = '<header class="page-heading bonds-heading"><div><h1>债基</h1><p class="bonds-local-note">修改保存在当前浏览器</p></div></header>';
  const reserveAttributes = `id="bonds-reserve-summary" tabindex="-1"${reserve ? ` data-bond-reserve-status="${escapeHtml(reserve.status)}"` : ''}`;
  const locationClass = locateReserve ? ' bond-reserve-location' : '';
  if (loading) return `<main id="main" class="workspace bonds-page">${heading}<section class="panel bonds-state" aria-busy="true"><p>正在读取债基记录…</p></section></main>`;
  let summary = null;
  if (!unavailable && Array.isArray(entries) && entries.length) {
    try { summary = calculateBondSummary(entries); } catch { /* Invalid or unavailable records have no financial display. */ }
  }
  if (!summary) return `<main id="main" class="workspace bonds-page">${heading}<section ${reserveAttributes} class="panel bonds-state${locationClass}" role="status">${reserveNote(reserve) || '<p>债基数据暂不可用</p>'}</section></main>`;
  const options = { visible: Boolean(visible), editing, draft, error, busy: Boolean(busy) };
  return `<main id="main" class="workspace bonds-page">${heading}
    <section ${reserveAttributes} class="panel bonds-summary${locationClass}" aria-label="债基合计">${reserveNote(reserve)}<dl>
      <div><dt>合计持仓（元）</dt><dd class="num">${privateValue(summary.marketValue, options.visible)}</dd></div>
      <div><dt>合计持有收益（元）</dt><dd class="num ${options.visible ? signClass(summary.holdingProfit) : ''}">${privateValue(summary.holdingProfit, options.visible)}</dd></div>
      <div class="bonds-summary-return"><dt>合计持有收益率</dt><dd class="num ${signClass(summary.returnRate)}">${percentage(summary.returnRate)}</dd></div>
    </dl></section>
    ${cashFlowPanel({ freeCashFlow, visible: options.visible, editing: cashEditing, draft: cashDraft, error: cashError, busy: cashBusy })}
    <div class="bonds-grid">${summary.holdings.map(entry => bondCard(entry, options)).join('')}</div>
    <p class="helper bonds-rate-note">收益率＝持有收益 ÷（当前持仓金额－持有收益）</p>
  </main>`;
}
