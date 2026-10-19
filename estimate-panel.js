const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

function inputValue(code, drafts, saved) {
  if (own(drafts, code)) return String(drafts[code] ?? '');
  const value = saved?.[code];
  return Number.isFinite(value) ? String(value) : '';
}

/**
 * Render public fund percentage estimates without reading time or storage.
 * saved values use percentage points: 1.25 represents +1.25%, not 0.0125.
 * A present drafts property (including an empty string) takes priority over saved.
 */
export function renderEstimatePanel({
  date = '', funds = [], drafts = {}, saved = {}, errors = {}, open = false, unavailable = false,
} = {}) {
  const rows = funds.map(fund => {
    const code = String(fund.code ?? '');
    const name = String(fund.short || fund.name || code);
    const fullName = String(fund.name || name);
    const fieldId = `nav-estimate-${code}`;
    const baseId = `${fieldId}-base`;
    const errorId = `${fieldId}-error`;
    const official = fund.official === true;
    const error = !official && typeof errors?.[code] === 'string' ? errors[code] : '';
    const descriptions = [fund.baseDate ? baseId : '', error ? errorId : ''].filter(Boolean);
    const value = official ? '' : inputValue(code, drafts, saved);
    return `<div class="estimate-row${official ? ' estimate-row-official' : ''}${error ? ' estimate-row-invalid' : ''}" data-estimate-fund="${escapeHtml(code)}">
      <div class="estimate-fund"><label for="${escapeHtml(fieldId)}" class="estimate-fund-name" title="${escapeHtml(fullName)}">${escapeHtml(name)}</label>${fund.baseDate ? `<span id="${escapeHtml(baseId)}" class="estimate-base">基准 <time datetime="${escapeHtml(fund.baseDate)}">${escapeHtml(fund.baseDate)}</time></span>` : ''}</div>
      <div class="estimate-field"><div class="estimate-input-wrap"><input id="${escapeHtml(fieldId)}" name="estimate-${escapeHtml(code)}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="24" placeholder="${official ? '—' : '未填写'}" value="${escapeHtml(value)}" aria-label="${escapeHtml(fullName)}昨日预估涨跌幅，单位百分比"${descriptions.length ? ` aria-describedby="${escapeHtml(descriptions.join(' '))}"` : ''}${error ? ' aria-invalid="true"' : ''}${official || unavailable ? ' disabled' : ''}><span class="estimate-unit" aria-hidden="true">%</span></div>${official ? '<span class="estimate-official">已更新</span>' : ''}</div>
      ${error ? `<p id="${escapeHtml(errorId)}" class="estimate-error" role="alert">${escapeHtml(error)}</p>` : ''}
    </div>`;
  }).join('');

  return `<details class="panel estimate-panel panel-disclosure" data-panel="nav-estimates"${open ? ' open' : ''}>
    <summary class="panel-toggle"><h2>昨日估值</h2>${date ? `<time class="estimate-date num" datetime="${escapeHtml(date)}">${escapeHtml(date)}</time>` : ''}</summary>
    <div class="panel-content"><form id="nav-estimate-form" class="estimate-form" novalidate>${unavailable ? '<p class="estimate-unavailable" role="status">估值暂不可用</p>' : ''}<div class="estimate-rows">${rows}</div><div class="estimate-actions"><button type="submit" class="button primary"${unavailable || funds.every(fund => fund.official === true) ? ' disabled' : ''}>保存估值</button></div></form></div>
  </details>`;
}
