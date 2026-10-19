// Public NAVs and date/type/count trade summaries only. No monetary account data.
const installations = new WeakMap();
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
};
const DAY = 86400000;
const dateStamp = date => Date.parse(`${date}T00:00:00Z`);

function chartDomain(raw, points) {
  if (typeof raw !== 'string' || raw.length > 1000) return null;
  try {
    const domain = JSON.parse(raw);
    if (!domain || Object.keys(domain).sort().join(',') !== 'end,lastPublished,left,right,start'
      || !validDate(domain.start) || !validDate(domain.end) || !validDate(domain.lastPublished)
      || domain.start !== points[0].date || domain.end <= domain.lastPublished
      || domain.lastPublished !== points.filter(point => !point.estimated).at(-1)?.date
      || points.at(-1).date > domain.end || !Number.isFinite(domain.left) || !Number.isFinite(domain.right)
      || domain.left < 0 || domain.right > 100 || domain.left >= domain.right) return null;
    return domain;
  } catch { return null; }
}

function pendingPoint(domain, date) {
  return { date, nav: null, change: null, pending: true, trades: null, y: 50,
    x: domain.left + (dateStamp(date) - dateStamp(domain.start)) / (dateStamp(domain.end) - dateStamp(domain.start)) * (domain.right - domain.left) };
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

export function setupNavChartInteractions(root) {
  if (!root || typeof root.addEventListener !== 'function') return () => {};
  installations.get(root)?.();
  const cache = new WeakMap();
  const indices = new WeakMap();
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
  function hide(chart) {
    if (!chart) return;
    for (const selector of ['.nav-hover-line', '.nav-hover-point', '.nav-hover-tooltip']) {
      const element = chart.querySelector(selector);
      if (element) element.hidden = true;
    }
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
    date.textContent = point.date;
    if (status) {
      status.textContent = point.pending ? '待更新' : point.estimated ? '估算' : point.nav === null ? '无公布净值' : '已公布';
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
      trades.hidden = !counts.length;
    }
    line.style.left = `${point.x}%`;
    dot.style.left = `${point.x}%`;
    dot.style.top = `${point.y}%`;
    line.hidden = tooltip.hidden = false;
    dot.hidden = Boolean(point.pending);
    dot.classList.toggle('is-estimated', Boolean(point.estimated));
    tooltip.classList.toggle('is-estimated', Boolean(point.estimated));
    tooltip.classList.toggle('is-pending', Boolean(point.pending));
    tooltip.style.maxWidth = `${Math.max(0, rect.width - 8)}px`;
    const measured = tooltip.getBoundingClientRect();
    const width = Math.min(measured.width || 152, Math.max(0, rect.width - 8));
    const height = Math.min(measured.height || 44, Math.max(0, rect.height - 8));
    const pixelX = point.x / 100 * rect.width;
    const pixelY = point.y / 100 * rect.height;
    let below = pixelY - height - 8 < 4;
    let top = below ? pixelY + 8 : pixelY - height - 8;
    if (below && top + height > rect.height - 4 && pixelY >= rect.height / 2) { below = false; top = pixelY - height - 8; }
    tooltip.style.left = `${clamp(pixelX - width / 2, 4, Math.max(4, rect.width - width - 4))}px`;
    tooltip.style.top = `${clamp(top, 4, Math.max(4, rect.height - height - 4))}px`;
    tooltip.style.transform = 'none';
    tooltip.classList.toggle('is-below', below);
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
      const date = new Date(day * DAY).toISOString().slice(0, 10);
      if (date > domain.lastPublished) {
        show(chart, points.find(point => point.date === date) || pendingPoint(domain, date));
        return;
      }
    }
    let index = 0;
    for (let candidate = 1; candidate < points.length; candidate += 1) {
      if (Math.abs(points[candidate].x - x) < Math.abs(points[index].x - x)) index = candidate;
    }
    show(chart, index);
  }
  const pointerDown = event => { if (event.pointerType === 'touch' || event.pointerType === 'pen') inspect(event); };
  const leave = event => {
    const chart = findChart(event.target);
    if (chart && !chart.contains(event.relatedTarget)) hide(chart);
  };
  const keyboard = event => {
    const chart = findChart(event.target);
    if (!chart) return;
    if (event.key === 'Escape') { hide(chart); return; }
    const points = pointsFor(chart);
    if (!points || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = indices.get(chart);
    const domain = cache.get(chart)?.domain;
    if (domain && current && ['ArrowLeft', 'ArrowRight'].includes(event.key) && current.date >= domain.lastPublished) {
      const date = new Date(clamp(dateStamp(current.date) + (event.key === 'ArrowRight' ? DAY : -DAY), dateStamp(domain.start), dateStamp(domain.end))).toISOString().slice(0, 10);
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
  const handlers = { pointermove: inspect, pointerdown: pointerDown, pointerout: leave, focusout: leave, keydown: keyboard };
  for (const [name, handler] of Object.entries(handlers)) root.addEventListener(name, handler, name === 'keydown' ? false : { passive: true });
  const cleanup = () => {
    for (const [name, handler] of Object.entries(handlers)) root.removeEventListener(name, handler);
    hide(active);
    if (installations.get(root) === cleanup) installations.delete(root);
  };
  installations.set(root, cleanup);
  return cleanup;
}
