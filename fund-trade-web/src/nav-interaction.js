// Public NAVs and date/type/count trade summaries only. No monetary account data.
import { createNavDateScale } from './nav-chart.js?v=20261020-trading-axis';
const installations = new WeakMap();
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
};
const DAY = 86400000;
const dateStamp = date => Date.parse(`${date}T00:00:00Z`);

export function measureNavChange(start, end) {
  if (!start || !end || !validDate(start.date) || !validDate(end.date)
    || !Number.isFinite(start.nav) || start.nav <= 0 || !Number.isFinite(end.nav) || end.nav <= 0) return null;
  const change = end.nav / start.nav - 1;
  return Number.isFinite(change * 100) ? change : null;
}

function segmentTouchesBox(left, right, box) {
  if (Math.max(left.x, right.x) < box.left || Math.min(left.x, right.x) > box.right
    || Math.max(left.y, right.y) < box.top || Math.min(left.y, right.y) > box.bottom) return false;
  let start = 0, end = 1;
  const dx = right.x - left.x, dy = right.y - left.y;
  for (const [p, q] of [[-dx, left.x - box.left], [dx, box.right - left.x], [-dy, left.y - box.top], [dy, box.bottom - left.y]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const cut = q / p;
    if (p < 0) start = Math.max(start, cut);
    else end = Math.min(end, cut);
    if (start > end) return false;
  }
  return true;
}

function labelPosition(points, point, rect, width, height) {
  const x = point.x / 100 * rect.width, y = point.y / 100 * rect.height;
  const margin = 4, gap = 9;
  const curve = points.filter(item => Number.isFinite(item.nav)).map(item => ({ x: item.x / 100 * rect.width, y: item.y / 100 * rect.height }));
  const candidates = [
    [x + gap, y - height - gap], [x - width - gap, y - height - gap],
    [x + gap, y + gap], [x - width - gap, y + gap],
    [x - width / 2, y - height - gap], [x - width / 2, y + gap],
    [x + gap, y - height / 2], [x - width - gap, y - height / 2],
  ].map(([left, top]) => ({
    left: clamp(left, margin, Math.max(margin, rect.width - width - margin)),
    top: clamp(top, margin, Math.max(margin, rect.height - height - margin)),
  })).sort((a, b) => Math.hypot(a.left + width / 2 - x, a.top + height / 2 - y) - Math.hypot(b.left + width / 2 - x, b.top + height / 2 - y));
  for (const candidate of candidates) {
    const box = { left: candidate.left - margin, right: candidate.left + width + margin, top: candidate.top - margin, bottom: candidate.top + height + margin };
    const coversPoint = curve.some(item => item.x >= box.left && item.x <= box.right && item.y >= box.top && item.y <= box.bottom);
    if (!coversPoint && !curve.some((item, index) => index > 0 && segmentTouchesBox(curve[index - 1], item, box))) return { ...candidate, docked: false, below: candidate.top > y };
  }
  // A reserved strip above the plot is always free of its price curve.
  return { left: clamp(x - width / 2, margin, Math.max(margin, rect.width - width - margin)), top: -height - 8, docked: true, below: false };
}

function chartDomain(raw, points) {
  if (typeof raw !== 'string' || raw.length > 1000) return null;
  try {
    const domain = JSON.parse(raw);
    if (!domain || !['end,lastPublished,left,right,start', 'axis,end,lastPublished,left,right,start'].includes(Object.keys(domain).sort().join(','))
      || ('axis' in domain && domain.axis !== 'valuation')
      || !validDate(domain.start) || !validDate(domain.end) || !validDate(domain.lastPublished)
      || domain.start !== points[0].date || domain.end <= domain.lastPublished
      || domain.lastPublished !== points.filter(point => !point.estimated).at(-1)?.date
      || points.at(-1).date > domain.end || !Number.isFinite(domain.left) || !Number.isFinite(domain.right)
      || domain.left < 0 || domain.right > 100 || domain.left >= domain.right) return null;
    if (domain.axis === 'valuation') domain.scale = createNavDateScale(points.map(point => point.date), domain.end);
    return domain;
  } catch { return null; }
}

function pendingPoint(domain, date) {
  return { date, nav: null, change: null, pending: true, trades: null, y: 50,
    x: domain.left + (domain.scale ? domain.scale.project(date) / domain.scale.span
      : (dateStamp(date) - dateStamp(domain.start)) / (dateStamp(domain.end) - dateStamp(domain.start))) * (domain.right - domain.left) };
}

function tradeSummaries(raw, points) {
  if (raw === null || raw === undefined || raw === '') return [];
  try {
    if (typeof raw !== 'string' || raw.length > 2000000) return [];
    const trades = JSON.parse(raw);
    if (!Array.isArray(trades) || trades.length > 20000) return [];
    const seen = new Set();
    for (const trade of trades) {
      if (!trade || typeof trade !== 'object' || Object.keys(trade).sort().join(',') !== 'count,date,estimated,type'
        || !validDate(trade.date) || trade.date < points[0].date || trade.date > points.at(-1).date
        || !['buy', 'sell'].includes(trade.type) || !Number.isSafeInteger(trade.count) || trade.count <= 0 || trade.count > 1000000
        || typeof trade.estimated !== 'boolean' || seen.has(`${trade.date}|${trade.type}`)) return [];
      seen.add(`${trade.date}|${trade.type}`);
    }
    return trades;
  } catch { return []; }
}

function inspectionTimeline(points, trades) {
  const daily = new Map();
  for (const trade of trades) {
    const summary = daily.get(trade.date) || { buy: 0, sell: 0, estimated: false };
    summary[trade.type] += trade.count;
    summary.estimated ||= trade.estimated;
    daily.set(trade.date, summary);
  }
  const timeline = new Map(points.map(point => [point.date, { ...point, trades: daily.get(point.date) || null }]));
  let leftIndex = 0;
  for (const date of [...daily.keys()].sort()) {
    if (timeline.has(date)) continue;
    while (leftIndex + 1 < points.length && points[leftIndex + 1].date < date) leftIndex += 1;
    const left = points[leftIndex], right = points[leftIndex + 1];
    if (!right) continue;
    const position = (Date.parse(date) - Date.parse(left.date)) / (Date.parse(right.date) - Date.parse(left.date));
    // A trade-only day follows the visible public curve, but has no invented NAV.
    timeline.set(date, { date, nav: null, change: null, x: left.x + (right.x - left.x) * position,
      y: left.y + (right.y - left.y) * position, trades: daily.get(date) });
  }
  return [...timeline.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export function setupNavChartInteractions(root, { matchMedia = globalThis.matchMedia?.bind(globalThis), onMeasure } = {}) {
  if (!root || typeof root.addEventListener !== 'function') return () => {};
  installations.get(root)?.();
  const cache = new WeakMap();
  const indices = new WeakMap();
  const measurements = new WeakMap();
  const measurementCharts = new Set();
  const desktop = matchMedia?.('(min-width: 761px)');
  const canMeasure = () => !desktop || desktop.matches;
  let active = null;
  const findChart = target => {
    const chart = target?.closest?.('.nav-chart');
    return chart && root.contains(chart) ? chart : null;
  };
  function pointsFor(chart) {
    const raw = chart.getAttribute('data-nav-points');
    const tradesRaw = chart.getAttribute('data-nav-trades');
    const domainRaw = chart.getAttribute('data-nav-domain');
    const prior = cache.get(chart);
    if (prior && prior.raw === raw && prior.tradesRaw === tradesRaw && prior.domainRaw === domainRaw) return prior.points;
    if (prior) { measurements.delete(chart); measurementCharts.delete(chart); renderMeasurement(chart); }
    let points = null;
    let domain = null;
    try {
      if (typeof raw !== 'string' || raw.length > 2000000) throw new Error();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.length || parsed.length > 20000) throw new Error();
      let priorDate = '', priorX = -1;
      for (const point of parsed) {
        const keys = point && typeof point === 'object' ? Object.keys(point).sort().join(',') : '';
        if (!point || !['change,date,nav,x,y', 'change,date,estimated,nav,x,y'].includes(keys)
          || ('estimated' in point && point.estimated !== true)
          || !validDate(point.date) || point.date <= priorDate
          || typeof point.nav !== 'number' || !Number.isFinite(point.nav) || point.nav <= 0 || point.nav > Number.MAX_SAFE_INTEGER / 10000
          || !(point.change === null || typeof point.change === 'number' && Number.isFinite(point.change * 100))
          || !Number.isFinite(point.x) || point.x < 0 || point.x > 100 || point.x < priorX
          || !Number.isFinite(point.y) || point.y < 0 || point.y > 100) throw new Error();
        priorDate = point.date;
        priorX = point.x;
      }
      if (parsed.every(point => point.estimated)) throw new Error();
      domain = chartDomain(domainRaw, parsed);
      points = inspectionTimeline(parsed, tradeSummaries(tradesRaw, parsed.filter(point => !point.estimated)));
      if (domain && points.at(-1).date < domain.end) points.push(pendingPoint(domain, domain.end));
    } catch { /* Invalid markup is ignored without echoing its contents. */ }
    cache.set(chart, { raw, tradesRaw, domainRaw, points, domain });
    return points;
  }
  function renderMeasurement(chart) {
    if (!canMeasure()) measurements.delete(chart);
    const scope = chart.closest?.('.nav-chart-frame') || chart;
    const item = measurements.get(chart);
    const panel = scope.querySelector('.nav-measure-panel');
    const result = scope.querySelector('.nav-measure-result');
    const dates = scope.querySelector('.nav-measure-dates');
    const value = scope.querySelector('.nav-measure-value');
    const days = scope.querySelector('.nav-measure-days');
    const caption = chart.querySelector('.nav-measure-caption');
    const band = chart.querySelector('.nav-measure-band');
    const [from, to] = item?.start && item?.end ? [item.start, item.end].sort((a, b) => a.date.localeCompare(b.date)) : [null, null];
    const change = measureNavChange(from, to);
    if (panel) panel.hidden = change === null;
    if (result) result.hidden = change === null;
    if (caption) {
      caption.hidden = change === null;
      if (change !== null) {
        caption.textContent = `${Math.abs(dateStamp(to.date) - dateStamp(from.date)) / DAY} 天`;
        caption.style.setProperty('--nav-measure-midpoint', `${(from.x + to.x) / 2}%`);
      }
    }
    if (change !== null) {
      if (days) days.textContent = `${Math.abs(dateStamp(item.end.date) - dateStamp(item.start.date)) / DAY} 天`;
      if (dates) dates.textContent = `${from.date} → ${to.date}${from.estimated || to.estimated ? ' · 含估值' : ''}`;
      if (value) {
        value.textContent = `${change > 0 ? '+' : ''}${(change * 100).toFixed(2)}%`;
        value.className = `nav-measure-value num${change > 0 ? ' positive' : change < 0 ? ' negative' : ''}`;
      }
    }
    for (const boundary of ['start', 'end']) {
      const point = item?.[boundary];
      const dot = chart.querySelector(`.nav-measure-${boundary}`);
      const line = chart.querySelector(`.nav-measure-${boundary}-line`);
      for (const element of [dot, line]) {
        if (!element) continue;
        element.hidden = !point;
        if (point) element.style.left = `${point.x}%`;
      }
      if (dot && point) dot.style.top = `${point.y}%`;
    }
    if (band) {
      band.hidden = change === null;
      if (change !== null) {
        band.style.left = `${Math.min(item.start.x, item.end.x)}%`;
        band.style.width = `${Math.abs(item.start.x - item.end.x)}%`;
      }
    }
    if (typeof onMeasure === 'function') onMeasure({ chart, start: item?.start || null, end: item?.end || null, pending: item?.pending === true });
  }
  function selectPoint(chart, point) {
    if (!canMeasure()) { measurements.delete(chart); measurementCharts.delete(chart); renderMeasurement(chart); return; }
    if (measurements.has(chart)) { measurements.delete(chart); measurementCharts.delete(chart); renderMeasurement(chart); return; }
    if (!Number.isFinite(point?.nav) || point.nav <= 0) return;
    measurements.set(chart, { start: point, end: null });
    measurementCharts.add(chart);
    renderMeasurement(chart);
  }
  function hide(chart) {
    if (!chart) return;
    for (const selector of ['.nav-hover-line', '.nav-hover-point', '.nav-hover-tooltip', '.nav-hover-axis-date', '.nav-hover-left-days', '.nav-hover-right-days']) {
      const element = chart.querySelector(selector);
      if (element) element.hidden = true;
    }
    for (const boundary of (chart.closest?.('.nav-chart-frame') || chart).querySelectorAll('.nav-chart-dates > time')) boundary.style.visibility = '';
    if (active === chart) active = null;
  }
  function show(chart, selection) {
    const points = pointsFor(chart);
    if (!points) { hide(chart); return; }
    const point = typeof selection === 'number' ? points[clamp(selection, 0, points.length - 1)] : selection;
    const line = chart.querySelector('.nav-hover-line');
    const dot = chart.querySelector('.nav-hover-point');
    const tooltip = chart.querySelector('.nav-hover-tooltip');
    const date = chart.querySelector('.nav-hover-date');
    const status = chart.querySelector('.nav-hover-status');
    const value = chart.querySelector('.nav-hover-value');
    const change = chart.querySelector('.nav-hover-change');
    const trades = chart.querySelector('.nav-hover-trades');
    const rect = chart.getBoundingClientRect();
    if (!line || !dot || !tooltip || !date || !value || !change || !(rect.width > 0) || !(rect.height > 0)) return;
    if (active && active !== chart) hide(active);
    active = chart;
    indices.set(chart, { index: points.findIndex(candidate => candidate.date === point.date), date: point.date });
    const domain = cache.get(chart)?.domain;
    const leftDate = domain?.start || points[0].date, rightDate = domain?.end || points.at(-1).date;
    const leftX = domain?.left ?? points[0].x, rightX = domain?.right ?? points.at(-1).x;
    for (const [selector, text, position] of [
      ['.nav-hover-axis-date', point.date, point.x],
      ['.nav-hover-left-days', `${Math.abs(dateStamp(point.date) - dateStamp(leftDate)) / DAY} 天`, (leftX + point.x) / 2],
      ['.nav-hover-right-days', `${Math.abs(dateStamp(rightDate) - dateStamp(point.date)) / DAY} 天`, (rightX + point.x) / 2],
    ]) {
      const element = chart.querySelector(selector);
      if (element) {
        element.textContent = text;
        const isDate = selector.includes('axis-date');
        const edge = isDate ? 48 : 25;
        element.style.left = `${clamp(position / 100 * rect.width, edge, Math.max(edge, rect.width - edge))}px`;
        // Preserve a single readable baseline; omit day counts only when the
        // date labels leave too little room near a boundary.
        const distance = Math.abs(point.x - (selector.includes('left-days') ? leftX : rightX)) / 100 * rect.width;
        element.hidden = !isDate && distance < 150;
      }
    }
    const boundaryLabels = (chart.closest?.('.nav-chart-frame') || chart).querySelectorAll('.nav-chart-dates > time');
    if (boundaryLabels[0]) boundaryLabels[0].style.visibility = (point.x - leftX) / 100 * rect.width < 140 ? 'hidden' : '';
    if (boundaryLabels[1]) boundaryLabels[1].style.visibility = (rightX - point.x) / 100 * rect.width < 140 ? 'hidden' : '';
    const measurement = measurements.get(chart);
    if (measurement && measurement.end?.date !== point.date) {
      measurement.end = Number.isFinite(point.nav) ? point : null;
      measurement.pending = !Number.isFinite(point.nav);
      renderMeasurement(chart);
    }
    date.textContent = point.date;
    date.hidden = true;
    if (status) {
      status.textContent = point.pending ? '待更新' : point.estimated ? '' : point.nav === null ? '无公布净值' : '已公布';
      status.hidden = true;
      status.className = `nav-hover-status${point.pending ? ' is-pending' : point.estimated ? ' is-estimated' : ''}`;
    }
    value.textContent = point.nav === null ? '—' : point.nav.toFixed(4);
    change.textContent = point.change === null ? '—' : `${point.change > 0 ? '+' : ''}${(point.change * 100).toFixed(2)}%`;
    change.className = `nav-hover-change num${point.change > 0 ? ' positive' : point.change < 0 ? ' negative' : ''}`;
    if (trades) {
      const counts = [];
      if (point.trades?.buy) counts.push(`买入${point.trades.buy}笔`);
      if (point.trades?.sell) counts.push(`卖出${point.trades.sell}笔`);
      trades.textContent = counts.length ? `${counts.join(' / ')}${point.trades.estimated ? ' · 含估算' : ''}` : '';
      trades.hidden = true;
    }
    line.style.left = `${point.x}%`;
    line.style.top = `${point.y}%`;
    line.style.bottom = '0';
    dot.style.left = `${point.x}%`;
    dot.style.top = `${point.y}%`;
    line.hidden = tooltip.hidden = dot.hidden = !Number.isFinite(point.nav);
    if (!Number.isFinite(point.nav)) return point;
    dot.classList.toggle('is-estimated', Boolean(point.estimated));
    const costY = Number.parseFloat(chart.style.getPropertyValue?.('--nav-cost-y') || '');
    const pointColor = Number.isFinite(costY) ? point.y <= costY ? 'var(--positive)' : 'var(--negative)' : 'var(--fund)';
    dot.style.setProperty?.('--nav-point-color', pointColor);
    tooltip.classList.toggle('is-estimated', Boolean(point.estimated));
    tooltip.classList.toggle('is-pending', Boolean(point.pending));
    tooltip.style.maxWidth = `${Math.max(0, rect.width - 8)}px`;
    tooltip.style.left = tooltip.style.top = '0px';
    const measured = tooltip.getBoundingClientRect();
    const width = Math.min(measured.width || 120, Math.max(0, rect.width - 8));
    const height = measured.height || 18;
    const position = labelPosition(points, point, rect, width, height);
    tooltip.style.left = `${position.left}px`;
    tooltip.style.top = `${position.top}px`;
    tooltip.style.transform = 'none';
    tooltip.classList.toggle('is-below', position.below);
    tooltip.classList.toggle('is-docked', position.docked);
    return point;
  }
  function inspect(event) {
    if (event.isPrimary === false) return;
    const chart = findChart(event.target);
    if (!chart) return;
    const points = pointsFor(chart);
    const rect = chart.getBoundingClientRect();
    if (!points || !(rect.width > 0) || !Number.isFinite(event.clientX)) { hide(chart); return; }
    const x = clamp((event.clientX - rect.left) / rect.width * 100, 0, 100);
    const domain = cache.get(chart)?.domain;
    if (domain) {
      const day = Math.round((dateStamp(domain.start) + clamp((x - domain.left) / (domain.right - domain.left), 0, 1)
        * (dateStamp(domain.end) - dateStamp(domain.start))) / DAY);
      const date = domain.scale ? domain.scale.dateAt(clamp((x - domain.left) / (domain.right - domain.left), 0, 1) * domain.scale.span)
        : new Date(day * DAY).toISOString().slice(0, 10);
      if (date > domain.lastPublished) {
        return show(chart, points.find(point => point.date === date) || pendingPoint(domain, date));
      }
    }
    let index = 0;
    for (let candidate = 1; candidate < points.length; candidate += 1) {
      if (Math.abs(points[candidate].x - x) < Math.abs(points[index].x - x)) index = candidate;
    }
    return show(chart, index);
  }
  const click = event => {
    if (event.button !== undefined && event.button !== 0) return;
    const chart = findChart(event.target);
    // Accessibility-generated clicks can report isPrimary=false; button=0
    // already identifies the allowed activation independently of pointer moves.
    if (chart) selectPoint(chart, inspect({ target: event.target, clientX: event.clientX }));
  };
  const pointerDown = event => { if (event.pointerType === 'touch' || event.pointerType === 'pen') inspect(event); };
  const leave = event => {
    const chart = findChart(event.target);
    if (chart && !chart.contains(event.relatedTarget)) hide(chart);
  };
  const keyboard = event => {
    const chart = findChart(event.target);
    if (!chart) return;
    if (event.key === 'Escape') { measurements.delete(chart); measurementCharts.delete(chart); renderMeasurement(chart); hide(chart); return; }
    const points = pointsFor(chart);
    if (points && ['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      const selected = indices.get(chart);
      const point = points.find(point => point.date === selected?.date) || points[0];
      selectPoint(chart, point);
      return;
    }
    if (!points || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = indices.get(chart);
    const domain = cache.get(chart)?.domain;
    if (domain && current && ['ArrowLeft', 'ArrowRight'].includes(event.key) && current.date >= domain.lastPublished) {
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const date = domain.scale ? domain.scale.dateAt(domain.scale.project(current.date) + direction)
        : new Date(clamp(dateStamp(current.date) + direction * DAY, dateStamp(domain.start), dateStamp(domain.end))).toISOString().slice(0, 10);
      if (date >= domain.lastPublished) {
        show(chart, points.find(point => point.date === date) || pendingPoint(domain, date));
        return;
      }
    }
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1
      : current === undefined ? event.key === 'ArrowLeft' ? points.length - 1 : 0
        : current.index + (event.key === 'ArrowRight' ? 1 : -1);
    show(chart, next);
  };
  const handlers = { pointermove: inspect, pointerdown: pointerDown, pointerout: leave, focusout: leave, keydown: keyboard, click };
  const resetMobileMeasurement = () => {
    if (canMeasure()) return;
    for (const chart of measurementCharts) { measurements.delete(chart); renderMeasurement(chart); }
    measurementCharts.clear();
  };
  desktop?.addEventListener?.('change', resetMobileMeasurement);
  for (const [name, handler] of Object.entries(handlers)) root.addEventListener(name, handler, name === 'keydown' ? false : { passive: true });
  const cleanup = () => {
    desktop?.removeEventListener?.('change', resetMobileMeasurement);
    measurementCharts.clear();
    for (const [name, handler] of Object.entries(handlers)) root.removeEventListener(name, handler);
    hide(active);
    if (installations.get(root) === cleanup) installations.delete(root);
  };
  installations.set(root, cleanup);
  return cleanup;
}
