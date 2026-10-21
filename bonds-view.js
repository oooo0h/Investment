import { calculateBondSummary, calculateBondHoldingValue, addPendingPurchaseValue, BOND_FUNDS } from './bond-model.js?v=20261021-third-bond';
import { BOND_FEE_RULES } from './bond-holding-duration.js?v=20261021-third-bond';
import { bondReserveTone, BOND_RESERVE_RULE } from './bond-reserve.js?v=20261020-bond-color-notices';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const numberFormat = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signClass = value => Number.isFinite(value) ? value > 0 ? 'positive' : value < 0 ? 'negative' : '' : '';
const percentage = value => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${numberFormat.format(value * 100)}%` : '—';
const privateValue = (value, visible, digits = 2) => !Number.isFinite(value) ? '—' : visible
  ? escapeHtml((digits === 2 ? numberFormat : new Intl.NumberFormat('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })).format(value))
  : '<span class="masked" aria-label="已隐藏">••••••</span>';

const decimalParts = value => {
  const [coefficient, exponent = '0'] = value.toString().split('e');
  const [whole, fraction = ''] = coefficient.split('.');
  return { digits: BigInt(whole + fraction), places: fraction.length - Number(exponent) };
};

// Apportion the smallest display units by the actual ratios, with an exact total.
// Decimal integer weights avoid floating-point cent drift and percentage rounding.
function apportionUnits(ratios, total) {
  const decimals = ratios.map(decimalParts);
  const places = Math.max(0, ...decimals.map(part => part.places));
  const weights = decimals.map(part => part.digits * 10n ** BigInt(places - part.places));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0n);
  const values = weights.map(weight => total * weight / weightTotal);
  const order = weights.map((weight, index) => ({ index, remainder: total * weight % weightTotal }))
    .sort((left, right) => left.remainder === right.remainder ? left.index - right.index : left.remainder > right.remainder ? -1 : 1);
  const remainder = Number(total - values.reduce((sum, value) => sum + value, 0n));
  for (let index = 0; index < remainder; index++) values[order[index].index]++;
  return values;
}

function marketValueCents(value) {
  const { digits, places } = decimalParts(value);
  return places <= 2 ? digits * 10n ** BigInt(2 - places) : (digits * 2n + 10n ** BigInt(places - 2)) / (2n * 10n ** BigInt(places - 2));
}

function allocatedValue(value, visible) {
  if (!visible) return privateValue(0, false);
  return `${(value / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(value % 100n).toString().padStart(2, '0')}`;
}

function holdingDuration(entry, duration, visible) {
  const code = entry.code;
  // Older duration payloads measured every fund against 30 days. Reuse only
  // their explicit under-seven-day weight for this fund's seven-day boundary.
  if (code === '006663' && Number.isFinite(duration?.under7Ratio)) {
    duration = { ...duration, recentRatio: duration.under7Ratio, matureRatio: 1 - duration.under7Ratio };
  } else if (code === '006663' && duration?.maturityDays !== 7) {
    duration = { ...duration, recentRatio: null, matureRatio: null };
  }
  const calculated = duration?.status === 'calculated';
  const known = ['known', 'calculated'].includes(duration?.status) && Number.isFinite(duration.recentRatio) && Number.isFinite(duration.matureRatio)
    && duration.recentRatio >= 0 && duration.recentRatio <= 1 && duration.matureRatio >= 0 && duration.matureRatio <= 1
    && Math.abs(duration.recentRatio + duration.matureRatio - 1) < 0.00001;
  const validTiers = known && Number.isFinite(duration.under7Ratio) && Number.isFinite(duration.sevenTo29Ratio)
    && duration.under7Ratio >= 0 && duration.sevenTo29Ratio >= 0
    && Math.abs(duration.under7Ratio + duration.sevenTo29Ratio - duration.recentRatio) < 0.00001;
  // Keep legacy two-band inputs usable without inventing an unreported 7-day split.
  const threeTiers = ['006485', '004103'].includes(code) && (!known || validTiers);
  const segments = threeTiers ? [
    { kind: 'recent', title: '未满7天', ratio: duration?.under7Ratio },
    { kind: 'middle', title: '7～29天', ratio: duration?.sevenTo29Ratio },
    { kind: 'mature', title: '已满30天', ratio: duration?.matureRatio },
  ] : [
    { kind: 'recent', title: code === '006663' ? '未满7天' : '未满30天', ratio: duration?.recentRatio },
    { kind: 'mature', title: code === '006663' ? '已满7天' : '已满30天', ratio: duration?.matureRatio },
  ];
  const ratios = segments.map(segment => segment.ratio);
  const percents = known ? apportionUnits(ratios, 100n).map(Number) : [];
  const amounts = known ? apportionUnits(ratios, marketValueCents(entry.marketValue)) : [];
  const label = known ? `${calculated ? '按所提供流水推算，' : ''}${segments.map((segment, index) => `${segment.title}约${percents[index]}%`).join('，')}` : duration?.status === 'empty' ? '暂无持仓' : '持有期限待核验';
  const segmentLabel = (segment, index) => `<div class="bond-duration-${segment.kind}-label"><span>${segment.title}</span>${known ? `<div class="bond-duration-values"><strong class="num">${calculated ? '约' : ''}${percents[index]}%</strong><span class="bond-duration-amount num">${allocatedValue(amounts[index], visible)}<small>元</small></span></div>` : ''}</div>`;
  const fee = BOND_FEE_RULES[code];
  const feeRanges = fee?.redemption.map(range => `${range.minDays === 0 ? `&lt;${range.maxDaysExclusive}天` : range.maxDaysExclusive === null ? `≥${range.minDays}天` : `${range.minDays}～${range.maxDaysExclusive - 1}天`} ${Number((range.rate * 100).toPrecision(10))}%`).join(' / ');
  return `<section class="bond-holding-duration${threeTiers ? ' bond-duration-three-tiers' : ''}" data-bond-duration-status="${known ? calculated ? 'calculated' : 'known' : duration?.status === 'empty' ? 'empty' : 'unknown'}" aria-label="持有期分布"><div class="bond-duration-heading"><span>持有期分布</span>${known ? calculated ? '<span class="bond-duration-status">按所提供流水推算</span>' : '' : `<span class="bond-duration-status">${duration?.status === 'empty' ? '暂无持仓' : '待核验'}</span>`}</div><div class="bond-duration-track" role="img" aria-label="${label}">${known ? segments.map((segment, index) => `<span class="bond-duration-${segment.kind}" style="width:${percents[index]}%"></span>`).join('') : ''}</div><div class="bond-duration-labels">${segments.map(segmentLabel).join('')}</div>${calculated ? `<p class="bond-duration-note">${duration.dateBasis === 'order' ? '持有天数按交易日推算；实际确认日待补全。' : '按所提供流水推算，未核验期初持仓'}</p>` : ''}${fee ? `<p class="bond-fee-rule">买入 ${fee.purchaseRate * 100}% · 卖出 ${feeRanges}</p>` : ''}</section>`;
}

const BOND_TYPES = { buy: '买入', sell: '卖出', 'transfer-in': '转入', 'transfer-out': '转换转出' };
const cancelled = row => ['cancelled', 'canceled', '撤单', '已撤单', '已撤销'].includes(row?.status) || ['cancelled', 'canceled'].includes(row?.sourceStatus);
function bondTransaction(row, visible) {
  const pending = row.status !== 'confirmed';
  const calculated = row.sharesBasis === 'calculated' || row.sourceStatus === 'calculated';
  const recorded = !pending && row.sourceStatus === 'calculated' && row.sharesBasis !== 'calculated';
  const name = BOND_TYPES[row.type] || '交易';
  const amount = Number.isFinite(row.confirmedAmount) ? row.confirmedAmount : row.amount;
  const shares = Number.isFinite(row.shares) ? row.shares : row.requestedShares;
  const sharesOnly = !Number.isFinite(amount) && Number.isFinite(shares);
  const displayValue = sharesOnly ? privateValue(shares, visible, 2) : privateValue(amount, visible);
  const valueLabel = recorded ? '表格金额 · 元' : sharesOnly ? Number.isFinite(row.shares) ? calculated ? '推算份额 · 份' : '确认份额 · 份' : '申请份额 · 份' : Number.isFinite(row.confirmedAmount) ? calculated ? '推算金额 · 元' : '确认金额 · 元' : '申请金额 · 元';
  const status = pending ? row.sourceStatus === 'processing' ? '进行中' : '待补全' : recorded ? '表格已填写' : calculated ? '按流水推算' : '已确认';
  const infoLabel = pending ? calculated ? '待补确认信息 · 按流水推算' : '待补确认信息' : recorded ? '表格资料' : calculated ? '推算资料' : '确认资料';
  const numeric = value => Number.isFinite(value) ? escapeHtml(value.toFixed(4)) : '—';
  const metrics = recorded ? [['表格净值', numeric(row.nav)], ['表格份额', privateValue(row.shares, visible, 2)], ['表格金额', privateValue(amount, visible)], ['手续费', privateValue(row.fee, visible)]]
    : [[calculated ? '推算净值' : '确认净值', numeric(row.nav)], [calculated ? '推算份额' : '确认份额', privateValue(row.shares, visible, 2)], ['申请金额', privateValue(row.amount, visible)], ['申请份额', privateValue(row.requestedShares, visible, 2)], [calculated ? '推算金额' : '确认金额', privateValue(row.confirmedAmount, visible)], ['手续费', privateValue(row.fee, visible)], [calculated ? '推算净值日' : '净值日期', escapeHtml(row.navDate || '待补全')], [calculated ? '推算确认日' : '确认日期', escapeHtml(row.confirmedDate || '待补全')]];
  return `<article class="transaction bond-transaction${pending ? ' transaction-pending' : ''}"><div class="transaction-top"><div class="transaction-label"><div><p class="transaction-title">${name}<span class="row-status${pending ? ' row-status-pending' : ''}">${status}</span></p><p class="transaction-date">${recorded ? '交易日期' : '申请日期'} ${escapeHtml(row.date || String(row.submittedAt || '').slice(0, 10) || '待补全')}</p></div></div><div class="transaction-top-right"><p class="transaction-amount num">${displayValue}<small>${valueLabel}</small></p></div></div><details class="transaction-detail" data-id="bond-${escapeHtml(row.id)}"><summary class="transaction-profit-row"><span class="${pending ? 'transaction-pending-hint' : 'helper'}">${infoLabel}</span><span class="transaction-detail-toggle">详细信息<span class="transaction-detail-chevron" aria-hidden="true">⌄</span></span></summary><div class="detail-inner"><dl class="transaction-stats transaction-detail-metrics">${metrics.map(([title, value]) => `<div><dt>${title}</dt><dd class="num">${value}</dd></div>`).join('')}</dl><p class="helper detail-date-note">${recorded ? '表格日期' : '申请时间'} ${escapeHtml(row.submittedAt || row.date || '待补全')}</p>${visible && row.note ? `<p class="transaction-note">${escapeHtml(row.note)}</p>` : ''}</div></details></article>`;
}
function bondCard(entry, options) {
  const rows = (Array.isArray(options.transactions?.[entry.code]) ? options.transactions[entry.code] : []).filter(row => !cancelled(row)).slice().reverse();
  return `<details class="panel bond-card" data-bond-ledger="${escapeHtml(entry.code)}" aria-labelledby="bond-title-${escapeHtml(entry.code)}"${options.expandedByCode?.[entry.code] ? ' open' : ''}><summary class="bond-card-toggle"><header class="bond-card-heading"><div><p class="bond-code num">${escapeHtml(entry.code)}</p><h2 id="bond-title-${escapeHtml(entry.code)}">${escapeHtml(entry.name)}</h2></div><span class="bond-ledger-hint">${rows.length} 笔<span class="bond-ledger-chevron" aria-hidden="true">⌄</span></span></header><dl class="bond-metrics"><div><dt>当前持仓（元）</dt><dd class="num">${privateValue(addPendingPurchaseValue(entry.marketValue, rows), options.visible)}</dd></div><div><dt>持有收益（元）</dt><dd class="num ${options.visible ? signClass(entry.holdingProfit) : ''}">${privateValue(entry.holdingProfit, options.visible)}</dd></div></dl><div class="bond-return"><span>持有收益率</span><strong class="num ${signClass(entry.returnRate)}">${percentage(entry.returnRate)}</strong></div>${!Number.isFinite(entry.marketValue) ? '<p class="helper">持仓待核验，请补全交易记录。</p>' : ''}${holdingDuration(entry, options.holdingByCode?.[entry.code], options.visible)}</summary><section class="bond-transactions-panel" aria-label="${escapeHtml(entry.name)}逐笔交易"><h3>逐笔交易<span class="fund-code">${rows.length} 笔</span></h3><div class="transaction-list">${rows.length ? rows.map(row => bondTransaction(row, options.visible)).join('') : '<p class="helper">暂无交易记录</p>'}</div></section></details>`;
}

function reserveNote(reserve) {
  if (!reserve || !['red', 'green', 'unknown'].includes(reserve.tone)) return '';
  const title = { red: '钱不多了', green: '可以花钱了', unknown: '债基配置待核验' }[reserve.tone];
  return `<div class="bond-reserve-note"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7v1"/></svg><p><strong>${title}</strong>：${escapeHtml(reserve.message)}<a href="#/?section=bond-reserve">查看首页规则与原因</a></p></div>`;
}

function totalHoldingProgress(holdingValue, ratio, visible) {
  const knownValue = Number.isFinite(holdingValue) && holdingValue >= 0;
  const knownRatio = knownValue && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1;
  const tone = bondReserveTone(holdingValue, ratio);
  const percent = knownRatio ? Math.round(ratio * 100) : null;
  const total = knownRatio && ratio > 0 ? holdingValue / ratio : null;
  const knownTotal = Number.isFinite(total) && total > 0;
  const { absoluteThreshold, maxRatio } = BOND_RESERVE_RULE;
  const knownAmounts = knownTotal || knownRatio && holdingValue === 0;
  let amounts = null;
  if (knownAmounts) {
    const cents = marketValueCents(holdingValue);
    const threshold = marketValueCents(absoluteThreshold);
    const upper = knownTotal ? marketValueCents(total * maxRatio) : 0n;
    const red = cents < threshold ? cents : threshold;
    const capacity = upper > threshold ? upper - threshold : 0n;
    const yellow = cents - red < capacity ? cents - red : capacity;
    amounts = [red, yellow, cents - red - yellow];
  }
  const amount = index => amounts ? `${allocatedValue(amounts[index], visible)}<small>元</small>` : '—';
  const status = knownRatio ? `约${percent}%` : '占比待核验';
  return `<div class="bond-total-progress" data-bond-total-tone="${tone}">
    <div class="bond-total-progress-heading"><span>持仓区间金额</span><span class="bond-total-progress-status">${status}</span></div>
    <div class="bond-duration-track bond-total-progress-track" role="img" aria-label="红、黄、绿持仓区间，${knownRatio ? `当前占比约${percent}%` : '当前占比待核验'}"><span class="bond-total-segment-red"></span><span class="bond-total-segment-yellow"></span><span class="bond-total-segment-green"></span></div>
    <div class="bond-total-progress-legend"><span class="bond-total-red"><span class="num">${amount(0)}</span></span><span class="bond-total-yellow"><span class="num">${amount(1)}</span></span><span class="bond-total-green"><span class="num">${amount(2)}</span></span></div>
    <p class="bond-total-progress-note">${knownAmounts ? '三段金额合计为当前持仓，含自由现金流。' : '总持仓待核验，分段金额暂不可用。'}</p>
  </div>`;
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
    <p id="cash-flow-hint" class="helper cash-flow-hint">可为负数，留空表示未填写；计入债基总持仓和配置比例，负数相应扣减。</p>
    ${error ? `<p id="cash-flow-error" class="bond-form-error" role="alert">${escapeHtml(error)}</p>` : ''}
    <div class="bond-form-actions"><button type="button" class="button quiet" data-action="cash-cancel"${disabled}>取消</button><button type="submit" class="button primary"${disabled}>${busy ? '保存中…' : '保存'}</button></div>
  </form>`;
}

function cashFlowPanel({ freeCashFlow = null, visible = false, editing = false, draft = null, error = '', busy = false, unavailable = false } = {}) {
  const hasValue = Number.isFinite(freeCashFlow);
  return `<section class="panel free-cash-flow-panel" aria-labelledby="free-cash-flow-title">
    <div class="cash-flow-heading"><div><p class="bond-code">CASH FLOW</p><h2 id="free-cash-flow-title">自由现金流</h2></div>${editing ? '<span class="bond-editing-state">编辑中</span>' : `<button type="button" class="button bond-edit-button" data-action="cash-edit"${busy || unavailable ? ' disabled' : ''}>${hasValue ? '编辑' : '填写'}</button>`}</div>
    ${editing ? cashFlowForm({ visible, draft, error, busy }) : `<p class="cash-flow-value">${unavailable ? '<span class="cash-flow-empty">本机现金流暂不可用</span>' : cashFlowValue(freeCashFlow, visible)}</p><p class="cash-flow-note">可自由支配的现金净额；计入债基总持仓和配置比例。</p>`}
  </section>`;
}

/** Render data supplied by the local bond store; this module never reads storage. */
export function renderBondsPage({ entries = [], valuationDate = null, visible = false, transactions = {}, expandedByCode = {}, holdingByCode = {}, loading = false, unavailable = false, reserve = null, locateReserve = false, freeCashFlow = null, cashEditing = false, cashDraft = null, cashError = '', cashBusy = false, cashUnavailable = false } = {}) {
  const calculated = Object.values(holdingByCode).some(item => item?.status === 'calculated');
  const hasPending = Object.values(transactions).some(rows => rows.some(row => row.status === 'pending'));
  const heading = `<header class="page-heading bonds-heading"><div><h1>债基</h1><p class="bonds-local-note">${calculated ? '按完整记录推算' : '数据来自基金表格'}${valuationDate ? ` · 净值截至 ${escapeHtml(valuationDate)}` : ''}${hasPending ? ' · 待确认买入金额先计入市值，份额与收益待确认' : ''}</p></div></header>`;
  let reserveAttributes = `id="bonds-reserve-summary" tabindex="-1"${reserve ? ` data-bond-reserve-status="${escapeHtml(reserve.status)}"` : ''}`;
  const locationClass = locateReserve ? ' bond-reserve-location' : '';
  if (loading) return `<main id="main" class="workspace bonds-page">${heading}<section class="panel bonds-state" aria-busy="true"><p>正在读取债基记录…</p></section></main>`;
  let summary = null;
  if (!unavailable && Array.isArray(entries) && entries.length) {
    try { summary = calculateBondSummary(entries); } catch { /* Invalid or unavailable records have no financial display. */ }
  }
  let holdingValue = null;
  if (summary && !cashUnavailable) {
    try { holdingValue = calculateBondHoldingValue(entries.map(entry => ({ ...entry, marketValue: addPendingPurchaseValue(entry.marketValue, transactions[entry.code] || []) })), freeCashFlow); } catch { /* Preserve fund cards while the aggregate is unavailable. */ }
  }
  const tone = bondReserveTone(holdingValue, reserve?.ratio);
  if (reserve) reserve = { ...reserve, tone };
  reserveAttributes += ` data-bond-reserve-tone="${tone}"`;
  const overview = `<section ${reserveAttributes} class="panel bonds-summary bonds-summary-overview${locationClass}" aria-label="债基合计">${summary ? reserveNote(reserve) : ''}<dl>
    <div><dt>合计持仓金额（元）</dt><dd class="num${holdingValue === null ? ' bonds-summary-pending' : ''}">${holdingValue !== null ? privateValue(holdingValue, Boolean(visible)) : '待核验'}</dd></div>
    <div><dt>占总持仓比例（含自由现金流）</dt><dd class="num${holdingValue !== null && Number.isFinite(reserve?.ratio) ? '' : ' bonds-summary-pending'}" data-bond-reserve-share>${holdingValue !== null && Number.isFinite(reserve?.ratio) ? `${Math.round(reserve.ratio * 100)}%` : '待核验'}</dd></div>
  </dl>${totalHoldingProgress(holdingValue, reserve?.ratio, Boolean(visible))}</section>`;
  if (!summary) {
    const hasRecords = !unavailable && BOND_FUNDS.some(fund => transactions?.[fund.code]?.length);
    if (hasRecords) {
      const options = { visible: Boolean(visible), transactions, expandedByCode, holdingByCode: {} };
      return `<main id="main" class="workspace bonds-page">${heading}${overview}<div class="bonds-grid">${BOND_FUNDS.map(fund => bondCard(fund, options)).join('')}</div></main>`;
    }
    return `<main id="main" class="workspace bonds-page">${heading}<section ${reserveAttributes} class="panel bonds-state${locationClass}" role="status">${reserveNote(reserve) || '<p>债基数据暂不可用</p>'}</section></main>`;
  }
  const options = { visible: Boolean(visible), transactions, expandedByCode, holdingByCode };
  return `<main id="main" class="workspace bonds-page">${heading}
    ${overview}
    ${cashFlowPanel({ freeCashFlow, visible: options.visible, editing: cashEditing, draft: cashDraft, error: cashError, busy: cashBusy, unavailable: cashUnavailable })}
    <div class="bonds-grid">${BOND_FUNDS.map(fund => bondCard(summary.holdings.find(entry => entry.code === fund.code) || fund, options)).join('')}</div>
    <p class="helper bonds-rate-note">${hasPending ? '收益率按已确认持仓计算；待确认买入只计入市值。' : '收益率＝持有收益 ÷（当前持仓金额－持有收益）'}</p>
  </main>`;
}
