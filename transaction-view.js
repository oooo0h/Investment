// Rendering only. Account drafts stay in the unlocked page and are never logged.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const TYPES = { buy: '买入', sip: '定投', sell: '卖出', reinvest: '红利再投', dividend: '现金分红', 'transfer-in': '转换转入' };
const number = (value, digits = 2) => Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value) : '—';
const protectedNumber = (value, visible, digits = 2) => !Number.isFinite(value) ? '—' : visible ? esc(number(value, digits)) : '<span class="masked" aria-label="已隐藏">••••••</span>';
export const transactionAmountLabel = type => type === 'sell' ? '实际到账金额（元）' : type === 'reinvest' ? '再投分红金额（元）' : type === 'dividend' ? '现金分红金额（元）' : '总支出金额（元）';

export function normalizeTransactionDate(date, { year, month, day } = {}) {
  const parts = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.split('-').map(Number) : [new Date().getUTCFullYear(), 1, 1];
  const nextYear = Math.max(1900, Math.min(2199, Number.isInteger(year) ? year : parts[0]));
  const nextMonth = Math.max(1, Math.min(12, Number.isInteger(month) ? month : parts[1]));
  const days = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
  const nextDay = Math.max(1, Math.min(days, Number.isInteger(day) ? day : parts[2]));
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(nextDay).padStart(2, '0')}`;
}

export function renderTransactionDateWheels(date, today) {
  const selected = normalizeTransactionDate(date);
  const [year, month, day] = selected.split('-').map(Number);
  const todayYear = /^\d{4}/.test(today) ? Number(today.slice(0, 4)) : year;
  const firstYear = Math.min(2000, year), lastYear = Math.max(todayYear, year);
  const columns = [
    { key: 'year', label: '年', values: Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index), selected: year },
    { key: 'month', label: '月', values: Array.from({ length: 12 }, (_, index) => index + 1), selected: month },
    { key: 'day', label: '日', values: Array.from({ length: new Date(Date.UTC(year, month, 0)).getUTCDate() }, (_, index) => index + 1), selected: day },
  ];
  return `<div class="transaction-date-picker-heading"><strong>选择交易日期</strong><span>上下滑动调整</span></div><div class="transaction-date-wheels">${columns.map(column => `<div class="transaction-date-column"><span class="transaction-date-wheel-label">${column.label}</span><div class="transaction-date-wheel" data-date-wheel="${column.key}" role="listbox" tabindex="0" aria-label="交易日期${column.label}">${column.values.map(value => `<button type="button" class="transaction-date-option" role="option" tabindex="-1" data-action="transaction-date-option" data-wheel="${column.key}" data-value="${value}" aria-selected="${value === column.selected}">${value}${column.label}</button>`).join('')}</div></div>`).join('')}</div><button type="button" class="button transaction-date-done" data-action="transaction-date-done">完成</button>`;
}

export function renderTransactionPreview(result, { visible = false } = {}) {
  const preview = result?.preview;
  if (!preview || result.error) return `<p class="helper">${esc(result?.error || '填写金额与净值后自动计算。')}</p>`;
  if (preview.status === 'pending') return '<p class="helper">进行中 · 净值填好后自动转为已确认并计算。</p>';
  return `<dl><div><dt>确认份额</dt><dd class="num">${protectedNumber(preview.shares, visible, 6)}</dd></div><div><dt>手续费（元）</dt><dd class="num">${protectedNumber(preview.fee, visible)}</dd></div></dl><p class="helper">按填写的金额、净值与费率自动计算。</p>`;
}

export function renderTransactionEditor({ editor, result, visible = false, amountVisible = visible, busy = false, error = '', today } = {}) {
  if (!editor) return '';
  const draft = editor.draft || {}, editing = Boolean(editor.id);
  const navText = String(draft.nav || '').trim();
  const confirmed = result?.preview?.status === 'confirmed' || /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(navText) && Number(navText) > 0 && Number(navText) <= 1e9;
  const status = confirmed ? 'confirmed' : 'pending';
  const noFee = ['reinvest', 'dividend'].includes(draft.type);
  return `<div class="transaction-dialog-backdrop"><section class="transaction-dialog" data-mode="${editing ? 'edit' : 'new'}" role="dialog" aria-modal="true" aria-labelledby="transaction-dialog-title" tabindex="-1"><div class="transaction-dialog-heading"><div><h2 id="transaction-dialog-title">${editing ? '编辑交易' : '登记交易'}</h2><p class="helper">填写金额和净值，其余自动计算。</p></div><button class="transaction-dialog-close icon-button" type="button" data-action="transaction-cancel" aria-label="取消登记" ${busy ? 'disabled' : ''}>×</button></div><form id="transaction-form" novalidate><div class="transaction-form-grid"><label class="transaction-field transaction-date-field"><span>交易日期</span><div class="transaction-date-control"><input class="transaction-native-date" name="date" type="date" value="${esc(draft.date || today)}" required ${busy ? 'disabled' : ''}><button class="transaction-date-toggle" type="button" data-action="transaction-date-toggle" aria-expanded="false" ${busy ? 'disabled' : ''}>${esc(draft.date || today)}<span aria-hidden="true">⌄</span></button></div></label><div class="transaction-field transaction-type-field"><div class="transaction-type-heading"><label for="transaction-type">交易类型</label><span class="transaction-sip-control"${['buy', 'sip'].includes(draft.type) ? '' : ' hidden'}><button type="button" class="transaction-sip-toggle" data-action="transaction-sip-toggle" role="switch" aria-label="定投" aria-checked="${draft.type === 'sip'}" ${busy ? 'disabled' : ''}><span class="transaction-sip-label">定投</span><span class="transaction-sip-track" aria-hidden="true"><span class="transaction-sip-thumb"></span></span></button></span></div><select id="transaction-type" name="type" ${busy ? 'disabled' : ''}>${Object.entries(TYPES).map(([value, label]) => `<option value="${value}"${value === draft.type ? ' selected' : ''}>${label}</option>`).join('')}</select></div><label class="transaction-field transaction-field-primary"><span id="transaction-amount-label">${transactionAmountLabel(draft.type)}</span><span class="transaction-amount-input"><input name="amount" type="${amountVisible ? 'text' : 'password'}" inputmode="decimal" autocomplete="off" value="${esc(draft.amount)}" placeholder="填写金额" ${busy ? 'disabled' : ''}><button type="button" class="transaction-input-visibility icon-button" data-action="transaction-amount-visibility" aria-label="${amountVisible ? '隐藏输入金额' : '显示输入金额'}" aria-pressed="${amountVisible}" ${busy ? 'disabled' : ''}><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></span></label><label class="transaction-field transaction-field-primary"><span>成交净值</span><input name="nav" type="text" inputmode="decimal" autocomplete="off" value="${esc(draft.nav)}" placeholder="进行中可留空" ${busy ? 'disabled' : ''}></label></div><div class="transaction-date-picker" hidden>${renderTransactionDateWheels(draft.date || today, today)}</div><div class="transaction-status-hint" data-transaction-status><span>${confirmed ? '已确认' : '进行中'}</span><small>${confirmed ? '保存后计入持仓' : '补充净值后自动确认'}</small></div><input name="status" type="hidden" value="${status}"><details class="transaction-advanced" data-transaction-fees${noFee ? ' hidden' : ''}${!draft.feeRate && ['buy', 'sip', 'sell', 'transfer-in'].includes(draft.type) ? ' open' : ''}><summary>手续费率</summary><label class="transaction-field"><span>实际费率（%）</span><input name="feeRate" type="text" inputmode="decimal" value="${esc(draft.feeRate)}" autocomplete="off" placeholder="无手续费填 0" ${busy || noFee ? 'disabled' : ''}></label></details><p class="helper transaction-fee-free"${noFee ? '' : ' hidden'}>本类型手续费率为 0%。</p><div class="transaction-preview" aria-live="polite">${renderTransactionPreview(result, { visible })}</div><p class="transaction-form-error" id="transaction-error" role="alert">${esc(error)}</p><div class="transaction-dialog-actions"><button type="button" class="button" data-action="transaction-cancel" ${busy ? 'disabled' : ''}>取消</button><button type="submit" class="button primary" data-transaction-submit ${busy ? 'disabled' : ''}>${busy ? '正在保存…' : editing ? '保存修改' : '确认登记'}</button></div></form></section></div>`;
}

export function renderTransactionDelete({ removal, busy = false, error = '' } = {}) {
  if (!removal) return '';
  return `<div class="transaction-dialog-backdrop"><section class="transaction-dialog transaction-delete-confirmation" data-mode="delete" role="alertdialog" aria-modal="true" aria-labelledby="transaction-dialog-title" tabindex="-1"><div class="transaction-dialog-heading"><div><h2 id="transaction-dialog-title">删除这笔交易？</h2><p>${esc(removal.date || '日期待核验')} · ${esc(TYPES[removal.type] || '交易')}</p></div><button type="button" class="transaction-dialog-close icon-button" data-action="transaction-cancel" aria-label="取消删除" ${busy ? 'disabled' : ''}>×</button></div><p class="helper">确认后从本机账本移除，相关持仓与收益会重新计算。</p><p class="transaction-form-error" id="transaction-error" role="alert">${esc(error)}</p><div class="transaction-dialog-actions"><button type="button" class="button" data-action="transaction-cancel" ${busy ? 'disabled' : ''}>取消</button><button type="button" class="button danger" data-action="transaction-delete-confirm" ${busy ? 'disabled' : ''}>${busy ? '正在删除…' : '确认删除'}</button></div></section></div>`;
}
