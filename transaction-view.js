// Rendering only. Account drafts stay in the unlocked page and are never logged.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const TYPES = { buy: '买入', sip: '定投', sell: '卖出', reinvest: '红利再投', dividend: '现金分红', 'transfer-in': '转换转入' };
const number = (value, digits = 2) => Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value) : '—';
const protectedNumber = (value, visible, digits = 2) => !Number.isFinite(value) ? '—' : visible ? esc(number(value, digits)) : '<span class="masked" aria-label="已隐藏">••••••</span>';
export const transactionAmountLabel = type => type === 'sell' ? '实际到账金额（元）' : type === 'reinvest' ? '再投分红金额（元）' : type === 'dividend' ? '现金分红金额（元）' : '总支出金额（元）';

export function renderTransactionPreview(result, { visible = false } = {}) {
  const preview = result?.preview;
  if (!preview || result.error) return '<p class="helper">' + esc(result?.error || '填写金额、净值或份额后自动计算。') + '</p>';
  if (preview.status === 'pending') return '<p class="helper">进行中 · 补全后自动确认。</p>';
  return '<dl><div><dt>确认份额</dt><dd class="num">' + protectedNumber(preview.shares, visible, 2) + '</dd></div><div><dt>手续费（元）</dt><dd class="num">' + protectedNumber(preview.fee, visible) + '</dd></div></dl>';
}

export function renderTransactionEditor({ editor, result, visible = false, amountVisible = visible, busy = false, error = '', today } = {}) {
  if (!editor) return '';
  const draft = editor.draft || {}, editing = Boolean(editor.id);
  const navText = String(draft.nav || '').trim();
  const confirmed = result?.preview?.status === 'confirmed' || /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(navText) && Number(navText) > 0 && Number(navText) <= 1e9;
  const status = confirmed ? 'confirmed' : 'pending';
  const noFee = ['reinvest', 'dividend'].includes(draft.type);
  const disabled = busy ? ' disabled' : '';
  const inputType = amountVisible ? 'text' : 'password';
  const typeOptions = Object.entries(TYPES).map(([value, label]) => '<option value="' + value + '"' + (value === draft.type ? ' selected' : '') + '>' + label + '</option>').join('');
  return '<div class="transaction-dialog-backdrop"><section class="transaction-dialog" data-mode="' + (editing ? 'edit' : 'new') + '" role="dialog" aria-modal="true" aria-labelledby="transaction-dialog-title" tabindex="-1">' +
    '<div class="transaction-dialog-heading"><div><h2 id="transaction-dialog-title">' + (editing ? '编辑交易' : '登记交易') + '</h2><p class="helper">金额、净值和份额互相计算。</p></div><button class="transaction-dialog-close icon-button" type="button" data-action="transaction-cancel" aria-label="取消登记"' + disabled + '>×</button></div>' +
    '<form id="transaction-form" novalidate><div class="transaction-form-grid">' +
    '<label class="transaction-field transaction-date-field"><span>交易日期</span><input class="transaction-date-input" name="date" type="text" inputmode="numeric" autocomplete="off" maxlength="20" placeholder="YYYY/MM/DD" value="' + esc(editor.dateText !== undefined ? editor.dateText : String(draft.date || today).replaceAll('-', '/')) + '"' + disabled + '></label>' +
    '<div class="transaction-field transaction-type-field"><div class="transaction-type-heading"><label for="transaction-type">交易类型</label><span class="transaction-sip-control"' + (['buy', 'sip'].includes(draft.type) ? '' : ' hidden') + '><button type="button" class="transaction-sip-toggle" data-action="transaction-sip-toggle" role="switch" aria-label="定投" aria-checked="' + (draft.type === 'sip') + '"' + disabled + '><span class="transaction-sip-label">定投</span><span class="transaction-sip-track" aria-hidden="true"><span class="transaction-sip-thumb"></span></span></button></span></div><select id="transaction-type" name="type"' + disabled + '>' + typeOptions + '</select></div>' +
    '<label class="transaction-field transaction-field-primary"><span id="transaction-amount-label">' + transactionAmountLabel(draft.type) + '</span><span class="transaction-amount-input"><input name="amount" type="' + inputType + '" inputmode="decimal" autocomplete="off" value="' + esc(draft.amount) + '" placeholder="填写金额"' + disabled + '><button type="button" class="transaction-input-visibility icon-button" data-action="transaction-amount-visibility" aria-label="' + (amountVisible ? '隐藏输入金额与份额' : '显示输入金额与份额') + '" aria-pressed="' + amountVisible + '"' + disabled + '><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></span></label>' +
    '<label class="transaction-field transaction-field-primary"><span>成交净值</span><input name="nav" type="text" inputmode="decimal" autocomplete="off" value="' + esc(draft.nav) + '" placeholder="进行中可留空"' + disabled + '></label>' +
    '<label class="transaction-field transaction-field-primary transaction-shares-field"><span>确认份额</span><span class="transaction-shares-input"><input name="shares" type="' + inputType + '" inputmode="decimal" autocomplete="off" value="' + esc(draft.shares) + '" placeholder="填写或自动计算"' + (busy || draft.type === 'dividend' ? ' disabled' : '') + '></span></label></div>' +
    '<div class="transaction-status-hint" data-transaction-status><span>' + (confirmed ? '已确认' : '进行中') + '</span><small>' + (confirmed ? '保存后计入持仓' : '补全后自动确认') + '</small></div><input name="status" type="hidden" value="' + status + '">' +
    '<div class="transaction-fee-field"><div class="transaction-fee-heading">手续费</div><div class="transaction-fee-inputs"><label class="transaction-field transaction-fee-rate"><span>比例（%）</span><input name="feeRate" type="text" inputmode="decimal" value="' + esc(noFee ? '0' : draft.feeRate) + '" autocomplete="off"' + (busy || noFee ? ' disabled' : '') + '></label><label class="transaction-field transaction-fee-amount"><span>金额（元）</span><input name="feeAmount" type="' + inputType + '" inputmode="decimal" value="' + esc(noFee ? '0' : draft.feeAmount) + '" autocomplete="off"' + (busy || noFee ? ' disabled' : '') + '></label></div></div>' +
    '<div class="transaction-preview" aria-live="polite">' + renderTransactionPreview(result, { visible }) + '</div><p class="transaction-form-error" id="transaction-error" role="alert">' + esc(error) + '</p><div class="transaction-dialog-actions"><button type="button" class="button" data-action="transaction-cancel"' + disabled + '>取消</button><button type="submit" class="button primary" data-transaction-submit' + disabled + '>' + (busy ? '正在保存…' : editing ? '保存修改' : '确认登记') + '</button></div></form></section></div>';
}

export function renderTransactionDelete({ removal, busy = false, error = '' } = {}) {
  if (!removal) return '';
  return '<div class="transaction-dialog-backdrop"><section class="transaction-dialog transaction-delete-confirmation" data-mode="delete" role="alertdialog" aria-modal="true" aria-labelledby="transaction-dialog-title" tabindex="-1"><div class="transaction-dialog-heading"><div><h2 id="transaction-dialog-title">删除这笔交易？</h2><p>' + esc(removal.date || '日期待核验') + ' · ' + esc(TYPES[removal.type] || '交易') + '</p></div><button type="button" class="transaction-dialog-close icon-button" data-action="transaction-cancel" aria-label="取消删除"' + (busy ? ' disabled' : '') + '>×</button></div><p class="helper">确认后从本机账本移除，相关持仓与收益会重新计算。</p><p class="transaction-form-error" id="transaction-error" role="alert">' + esc(error) + '</p><div class="transaction-dialog-actions"><button type="button" class="button" data-action="transaction-cancel"' + (busy ? ' disabled' : '') + '>取消</button><button type="button" class="button danger" data-action="transaction-delete-confirm"' + (busy ? ' disabled' : '') + '>' + (busy ? '正在删除…' : '确认删除') + '</button></div></section></div>';
}
