const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

function inputValue(code, drafts, saved) {
  const value = own(drafts, code) ? String(drafts[code] ?? '') : Number.isFinite(saved?.[code]) ? String(saved[code]) : '';
  const numeric = /^[+-]?((?:\d+(?:\.\d+)?|\.\d+))\s*%?$/.exec(value.trim());
  // Retain malformed drafts verbatim so validation can explain the user's input.
  return numeric ? numeric[1] : value;
}

function inputDirection(code, directions, drafts, saved) {
  if (['up', 'down'].includes(directions?.[code])) return directions[code];
  if (own(drafts, code)) {
    const draft = String(drafts[code] ?? '').trim();
    if (draft.startsWith('-')) return 'down';
    if (draft.startsWith('+')) return 'up';
  }
  return Number.isFinite(saved?.[code]) && saved[code] < 0 ? 'down' : 'up';
}

function confirmedQuote(fund, date) {
  if (fund.confirmedDate !== date || !Number.isFinite(fund.confirmedNav) || fund.confirmedNav <= 0) {
    return '<div class="estimate-confirmed estimate-confirmed-empty" role="status">所示日期无公布净值</div>';
  }
  const change = fund.confirmedChange;
  const hasChange = typeof change === 'number' && Number.isFinite(change);
  const roundedChange = hasChange ? Number((change * 100).toFixed(2)) : null;
  const changeText = hasChange ? `${roundedChange > 0 ? '+' : ''}${roundedChange.toFixed(2)}%` : '';
  const tone = roundedChange > 0 ? 'positive' : roundedChange < 0 ? 'negative' : '';
  return `<div class="estimate-confirmed" aria-label="${escapeHtml(date)}已确认涨跌幅与净值">${hasChange ? `<strong class="estimate-confirmed-change num ${tone}" title="较${escapeHtml(fund.changeBaseDate || '前次')}净值" aria-label="较${escapeHtml(fund.changeBaseDate || '前次')}净值变动${changeText}">${changeText}</strong>` : '<span class="estimate-confirmed-missing">涨跌幅待确认</span>'}<span class="estimate-confirmed-label">确认净值</span><span class="estimate-confirmed-nav num" data-confirmed-nav>${fund.confirmedNav.toFixed(4)}</span></div>`;
}

/**
 * Render confirmed public NAVs and percentage estimates without reading time or storage.
 * A confirmed NAV must match the displayed date and takes priority over drafts.
 * confirmedChange is a ratio against the previous official NAV, not percent points.
 * saved values use percentage points: 1.25 represents +1.25%, not 0.0125.
 * A present drafts property (including an empty string) takes priority over saved.
 * The direction switch owns the sign; valid numeric fields display magnitudes.
 */
export function renderEstimatePanel({
  date = '', funds = [], drafts = {}, saved = {}, directions = {}, errors = {}, open = false, unavailable = false,
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
    const descriptions = [fund.baseDate ? baseId : '', errorId].filter(Boolean);
    const value = official ? '' : inputValue(code, drafts, saved);
    const direction = inputDirection(code, directions, drafts, saved);
    const disabled = official || unavailable ? ' disabled' : '';
    const dateLabel = official && fund.confirmedDate === date ? '净值日期' : '基准';
    const displayDate = official && fund.confirmedDate === date ? fund.confirmedDate : fund.baseDate;
    return `<div class="estimate-row${official ? ' estimate-row-official' : ''}${error ? ' estimate-row-invalid' : ''}" data-estimate-fund="${escapeHtml(code)}">
      <div class="estimate-fund"><${official ? 'span' : 'label'}${official ? '' : ` for="${escapeHtml(fieldId)}"`} class="estimate-fund-name" title="${escapeHtml(fullName)}">${escapeHtml(name)}</${official ? 'span' : 'label'}>${displayDate ? `<span id="${escapeHtml(baseId)}" class="estimate-base">${dateLabel} <time datetime="${escapeHtml(displayDate)}">${escapeHtml(displayDate)}</time></span>` : ''}</div>
      ${official ? confirmedQuote(fund, date) : `<div class="estimate-field"><button type="button" class="estimate-direction" data-action="estimate-direction" data-code="${escapeHtml(code)}" data-direction="${direction}" role="switch" aria-checked="${direction === 'up'}" aria-label="${escapeHtml(fullName)}估值方向：${direction === 'up' ? '涨' : '跌'}，点击切换"${disabled}><span class="estimate-direction-thumb" aria-hidden="true"></span><span class="estimate-direction-up" aria-hidden="true">涨</span><span class="estimate-direction-down" aria-hidden="true">跌</span></button><input type="hidden" name="direction-${escapeHtml(code)}" value="${direction}"${disabled}><div class="estimate-input-wrap"><input id="${escapeHtml(fieldId)}" name="estimate-${escapeHtml(code)}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="24" placeholder="未填写" value="${escapeHtml(value)}" aria-label="${escapeHtml(fullName)}所示日期预估涨跌幅，单位百分比"${descriptions.length ? ` aria-describedby="${escapeHtml(descriptions.join(' '))}"` : ''}${error ? ' aria-invalid="true"' : ''}${disabled}><span class="estimate-unit" aria-hidden="true">%</span></div></div>`}
      <p id="${escapeHtml(errorId)}" class="estimate-error" role="alert"${error ? '' : ' hidden'}>${escapeHtml(error)}</p>
    </div>`;
  }).join('');

  return `<details class="panel estimate-panel panel-disclosure" data-panel="nav-estimates"${open ? ' open' : ''}>
    <summary class="panel-toggle"><h2>最近工作日估值</h2>${date ? `<time class="estimate-date num" datetime="${escapeHtml(date)}">${escapeHtml(date)}</time>` : ''}</summary>
    <div class="panel-content"><form id="nav-estimate-form" class="estimate-form" novalidate>${unavailable ? '<p class="estimate-unavailable" role="status">估值暂不可用</p>' : ''}<p class="helper">已公布的显示确认净值；其余可补充所示日期的估值。休市日请留空，沿用最新已公布净值。</p><div class="estimate-rows">${rows}</div></form></div>
  </details>`;
}
