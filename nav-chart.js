// Render price coordinates only. Never interpolate account amounts, shares or notes.
const WIDTH = 300;
const HEIGHT = 128;
const LEFT = 8;
const RIGHT = WIDTH - LEFT;
const TOP = 12;
const BOTTOM = HEIGHT - TOP;

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

const coordinate = value => Number(value.toFixed(4)).toString();
const timestamp = date => Date.parse(`${date}T00:00:00Z`);
const validNav = (value, allowZero = false) => typeof value === 'number' && Number.isFinite(value)
  && (allowZero ? value >= 0 : value > 0) && value <= Number.MAX_SAFE_INTEGER / 10000;
const attribute = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

export function createNavScale(values) {
  const prices = values.filter(value => validNav(value));
  if (!prices.length) return null;
  let minimum = prices[0], maximum = prices[0];
  for (const price of prices) { minimum = Math.min(minimum, price); maximum = Math.max(maximum, price); }
  const spread = Math.max(maximum - minimum, maximum * Number.EPSILON * 32, Number.MIN_VALUE * 1024);
  const padding = maximum === minimum ? maximum * .005 : spread * .025;
  const rawStep = (spread + padding * 2) / 4;
  const unit = 10 ** Math.floor(Math.log10(rawStep));
  const step = Math.ceil(rawStep / unit * 10) / 10 * unit;
  const lower = Math.max(0, Math.floor((minimum - padding) / step) * step);
  const upper = Math.ceil((maximum + padding) / step) * step;
  const count = Math.round((upper - lower) / step);
  const digits = Math.min(12, Math.max(4, Math.ceil(-Math.log10(step)) + 1));
  const format = value => value !== 0 && (Math.abs(value) < 1e-8 || Math.abs(value) >= 1e6)
    ? value.toExponential(3) : value.toFixed(digits);
  return { lower, upper, ticks: Array.from({ length: count + 1 }, (_, index) => {
    const value = lower + step * index;
    return { value, label: format(value) };
  }) };
}

function compactMarkers(markers, x, y) {
  const clusters = [];
  const distance = (left, right) => ((left.x - right.x) / 3.5) ** 2 + ((left.y - right.y) / 9) ** 2;
  for (const marker of markers) {
    const projected = { ...marker, x: x(marker.date) / WIDTH * 100, y: y(marker.nav) / HEIGHT * 100 };
    let nearest = null, nearestDistance = Infinity;
    for (const cluster of clusters) {
      if (cluster.type !== marker.type) continue;
      const separation = distance(cluster, projected);
      if (separation <= 1 && separation < nearestDistance) { nearest = cluster; nearestDistance = separation; }
    }
    if (!nearest) clusters.push({ ...projected, from: marker.date, to: marker.date, members: [projected] });
    else {
      const count = nearest.count + marker.count;
      nearest.x = (nearest.x * nearest.count + projected.x * marker.count) / count;
      nearest.y = (nearest.y * nearest.count + projected.y * marker.count) / count;
      nearest.count = count;
      nearest.estimated ||= marker.estimated;
      nearest.from = nearest.from < marker.date ? nearest.from : marker.date;
      nearest.to = nearest.to > marker.date ? nearest.to : marker.date;
      nearest.members.push(projected);
    }
  }
  // Anchor each cluster to an actual trade point rather than inventing a price.
  return clusters.map(cluster => {
    const representative = cluster.members.reduce((best, point) => distance(cluster, point) < distance(cluster, best) ? point : best);
    return { ...cluster, x: representative.x, y: representative.y, offscale: representative.offscale };
  });
}

export function renderNavChart(points, { costNav = null, markers = [], referenceHistory = [], domainEnd = null, estimatedPoints = [] } = {}) {
  const byDate = new Map();
  for (const point of Array.isArray(points) ? points : []) {
    if (point && validDate(point.date) && validNav(point.nav)) byDate.set(point.date, { date: point.date, nav: point.nav });
  }
  const safePoints = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  if (!safePoints.length) return '<p class="nav-chart-empty">该时段暂无净值数据</p>';
  const firstDate = safePoints[0].date;
  const lastDate = safePoints.at(-1).date;
  const endDate = validDate(domainEnd) && domainEnd > lastDate ? domainEnd : lastDate;
  const extended = endDate > lastDate;
  const estimates = new Map();
  for (const point of Array.isArray(estimatedPoints) ? estimatedPoints : []) {
    if (!point || point.estimated !== true || !validDate(point.date) || !validNav(point.nav)
      || point.date < firstDate || point.date > endDate || byDate.has(point.date)) continue;
    estimates.set(point.date, { date: point.date, nav: point.nav, estimated: true,
      change: typeof point.change === 'number' && Number.isFinite(point.change * 100) ? point.change : null });
  }
  const combined = [...safePoints, ...estimates.values()].sort((left, right) => left.date.localeCompare(right.date));
  const firstTime = timestamp(firstDate);
  const duration = timestamp(endDate) - firstTime;
  const markerGroups = new Map();
  const seenIds = new Set();
  for (const marker of Array.isArray(markers) ? markers : []) {
    const type = ['buy', 'sip', 'transfer-in', 'reinvest'].includes(marker?.type) ? 'buy' : marker?.type === 'sell' ? 'sell' : null;
    if (!marker || !validDate(marker.date) || !validNav(marker.nav) || !type
      || marker.date < firstDate || marker.date > endDate) continue;
    if (typeof marker.id === 'string' && marker.id) {
      if (seenIds.has(marker.id)) continue;
      seenIds.add(marker.id);
    }
    const key = `${marker.date}|${type}|${marker.nav}`;
    const existing = markerGroups.get(key);
    if (existing) { existing.count += 1; existing.estimated ||= marker.estimated === true; }
    else markerGroups.set(key, { date: marker.date, nav: marker.nav, type, estimated: marker.estimated === true, count: 1 });
  }
  const safeMarkers = [...markerGroups.values()].sort((left, right) => left.date.localeCompare(right.date));
  const hasCost = validNav(costNav, true);
  const scale = createNavScale(combined.map(point => point.nav));
  const { lower, upper } = scale;
  const span = upper - lower;
  const x = date => duration === 0 ? WIDTH / 2 : LEFT + (timestamp(date) - firstTime) / duration * (RIGHT - LEFT);
  const y = nav => TOP + (1 - (nav - lower) / span) * (BOTTOM - TOP);
  const compact = compactMarkers(safeMarkers.map(point => ({ ...point,
    offscale: point.nav > upper ? 'above' : point.nav < lower ? 'below' : null })), x,
    nav => Math.max(TOP, Math.min(BOTTOM, y(nav))));
  const dailyTrades = new Map();
  for (const marker of safeMarkers) {
    const key = `${marker.date}|${marker.type}`;
    const existing = dailyTrades.get(key);
    if (existing) { existing.count += marker.count; existing.estimated ||= marker.estimated; }
    else dailyTrades.set(key, { date: marker.date, type: marker.type, count: marker.count, estimated: marker.estimated });
  }
  const tradeSummary = [...dailyTrades.values()].sort((left, right) => left.date.localeCompare(right.date) || left.type.localeCompare(right.type));
  const references = new Map();
  for (const point of Array.isArray(referenceHistory) ? referenceHistory : []) {
    if (point && validDate(point.date) && validNav(point.nav)) references.set(point.date, { date: point.date, nav: point.nav });
  }
  for (const point of safePoints) references.set(point.date, point);
  const dailyChanges = new Map();
  let previous = null;
  for (const point of [...references.values()].sort((left, right) => left.date.localeCompare(right.date))) {
    const change = previous ? point.nav / previous.nav - 1 : null;
    dailyChanges.set(point.date, change !== null && Number.isFinite(change * 100) ? change : null);
    previous = point;
  }
  const publicPoints = combined.map((point, index) => {
    const previous = combined[index - 1];
    const estimatedChange = point.change ?? (previous ? point.nav / previous.nav - 1 : null);
    return {
      date: point.date, nav: point.nav,
      change: point.estimated ? estimatedChange !== null && Number.isFinite(estimatedChange * 100) ? estimatedChange : null : dailyChanges.get(point.date) ?? null,
      x: Number(coordinate(x(point.date) / WIDTH * 100)), y: Number(coordinate(y(point.nav) / HEIGHT * 100)),
      ...(point.estimated ? { estimated: true } : {}),
    };
  });
  const pointColor = nav => !hasCost ? 'fund' : nav >= costNav ? 'positive' : 'negative';
  const colorStyle = nav => hasCost ? `;--nav-point-color:var(--${pointColor(nav)})` : '';
  // Every edge touching an estimate is dashed. Cost crossings add rendering
  // coordinates only: the observation payload remains the original public NAVs.
  const segments = [];
  const appendSegment = (estimated, color, left, right) => {
    const prior = segments.at(-1);
    if (prior?.estimated === estimated && prior.color === color) prior.points.push(right);
    else segments.push({ estimated, color, points: [left, right] });
  };
  for (let index = 1; index < combined.length; index += 1) {
    const left = combined[index - 1], right = combined[index];
    const estimated = Boolean(left.estimated || right.estimated);
    const start = { x: x(left.date), y: y(left.nav) };
    const end = { x: x(right.date), y: y(right.nav) };
    if (hasCost && ((left.nav < costNav && right.nav > costNav) || (left.nav > costNav && right.nav < costNav))) {
      const fraction = (costNav - left.nav) / (right.nav - left.nav);
      const crossing = { x: start.x + (end.x - start.x) * fraction, y: y(costNav) };
      appendSegment(estimated, pointColor(left.nav), start, crossing);
      appendSegment(estimated, pointColor(right.nav), crossing, end);
    } else {
      // An endpoint exactly on cost follows the other endpoint. A flat edge on
      // cost is red, so every priced edge uses one of the requested two colors.
      appendSegment(estimated, pointColor(hasCost && left.nav === costNav ? right.nav : left.nav), start, end);
    }
  }
  const curve = segments.map(segment => `<polyline class="${segment.estimated ? 'nav-chart-estimated-curve' : 'nav-chart-curve'}" points="${segment.points.map(point => `${coordinate(point.x)},${coordinate(point.y)}`).join(' ')}" fill="none" stroke="var(--${segment.color})" stroke-width="1.8"${hasCost ? ` style="stroke:var(--${segment.color})"` : ''}${segment.estimated ? ' stroke-dasharray="4 4"' : ''} stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`).join('')
    + (safePoints.length === 1 ? `<circle class="nav-chart-point" cx="${coordinate(x(firstDate))}" cy="${coordinate(y(safePoints[0].nav))}" r="2.5" fill="var(--${pointColor(safePoints[0].nav)})" vector-effect="non-scaling-stroke"/>` : '');
  // HTML dots keep their circular shape when the SVG stretches with the chart.
  const estimatedDots = [...estimates.values()].map(point => `<span class="nav-chart-estimated-point" style="left:${coordinate(x(point.date) / WIDTH * 100)}%;top:${coordinate(y(point.nav) / HEIGHT * 100)}%${colorStyle(point.nav)}" aria-hidden="true"></span>`).join('');
  const pending = extended ? `<rect class="nav-chart-pending-region" x="${coordinate(x(lastDate))}" y="0" width="${coordinate(RIGHT - x(lastDate))}" height="${HEIGHT}" fill="var(--nav-pending-fill, color-mix(in srgb, var(--muted) 7%, transparent))" aria-hidden="true"/>` : '';
  const pendingLabel = extended ? `<span class="nav-chart-pending-label" style="left:${coordinate(x(lastDate) / WIDTH * 100)}%" aria-hidden="true">待更新</span>` : '';
  const domain = extended ? ` data-nav-domain="${attribute(JSON.stringify({ start: firstDate, end: endDate, lastPublished: lastDate, left: LEFT / WIDTH * 100, right: RIGHT / WIDTH * 100 }))}"` : '';
  const beijingDay = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const domainLabels = `<div class="nav-chart-dates" aria-hidden="true"><time datetime="${firstDate}">${firstDate}</time><time${extended ? ' class="nav-chart-domain-end"' : ''} datetime="${endDate}">${extended ? `${endDate === beijingDay ? '今天' : '截至'} ${endDate.slice(5)}` : endDate}</time></div>`;
  const costInRange = hasCost && costNav >= lower && costNav <= upper;
  const costLine = costInRange ? `<line class="nav-cost-line" x1="${LEFT}" y1="${coordinate(y(costNav))}" x2="${RIGHT}" y2="${coordinate(y(costNav))}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="5 4" vector-effect="non-scaling-stroke"/>` : '';
  const costLabel = hasCost ? `<span class="nav-cost-label" style="top:${coordinate(Math.max(TOP, Math.min(BOTTOM, y(costNav))) / HEIGHT * 100)}%">成本${costInRange ? '' : costNav > upper ? ' ↑' : ' ↓'}</span>` : '';
  const trades = compact.map(marker => {
    const buying = marker.type === 'buy';
    const name = buying ? '买入' : '卖出';
    const dates = marker.from === marker.to ? marker.from : `${marker.from}至${marker.to}`;
    const description = `${name} · ${dates}${marker.count > 1 ? ` · 共${marker.count}笔` : ''}${marker.estimated ? ' · 含估算' : ''}${marker.offscale ? ' · 超出当前刻度' : ''}`;
    return `<span class="nav-trade-marker nav-trade-${marker.type}${marker.estimated ? ' is-estimated' : ''}${marker.count > 1 ? ' is-cluster' : ''}${marker.offscale ? ` nav-trade-offscale-${marker.offscale}` : ''}" style="left:${coordinate(marker.x)}%;top:${coordinate(marker.y)}%" role="img" aria-label="${description}" title="${description}"><span class="nav-trade-dot" aria-hidden="true"></span></span>`;
  }).join('');
  const legend = safeMarkers.length ? `<div class="nav-chart-legend">${safeMarkers.some(marker => marker.type === 'buy') ? '<span class="nav-chart-legend-buy"><span class="nav-trade-dot" aria-hidden="true"></span>买入</span>' : ''}${safeMarkers.some(marker => marker.type === 'sell') ? '<span class="nav-chart-legend-sell"><span class="nav-trade-dot" aria-hidden="true"></span>卖出</span>' : ''}${safeMarkers.some(marker => marker.estimated) ? '<span class="nav-chart-legend-estimated">含估算成交</span>' : ''}</div>` : '';
  // Short visible windows keep each actual/estimated observation connected to the
  // date baseline. Pending dates never manufacture an observation or a guide.
  const resting = duration <= 7 * 86400000 ? publicPoints.map(point => `<span class="nav-chart-rest-line" data-date="${point.date}" style="left:${coordinate(point.x)}%;top:${coordinate(point.y)}%;bottom:0" aria-hidden="true"></span><span class="nav-chart-rest-point${point.estimated ? ' is-estimated' : ''}" data-date="${point.date}" style="left:${coordinate(point.x)}%;top:${coordinate(point.y)}%${colorStyle(point.nav)}" aria-hidden="true"></span>`).join('') : '';
  const hover = '<span class="nav-hover-line" hidden aria-hidden="true"></span><span class="nav-hover-point" hidden aria-hidden="true"></span><div class="nav-hover-tooltip" hidden role="status" aria-live="polite"><strong class="nav-hover-value num" title="单位净值"></strong><span class="nav-hover-change num" title="当日涨跌"></span><span class="nav-hover-meta" hidden aria-hidden="true"><span class="nav-hover-date" hidden></span><span class="nav-hover-status" hidden></span><span class="nav-hover-trades" hidden></span></span></div>';
  const costCoordinate = hasCost ? ` style="--nav-cost-y:${coordinate(y(costNav) / HEIGHT * 100)}%"` : '';
  const grid = scale.ticks.map(tick => `<line class="nav-grid-line" x1="${LEFT}" y1="${coordinate(y(tick.value))}" x2="${RIGHT}" y2="${coordinate(y(tick.value))}" vector-effect="non-scaling-stroke"/>`).join('');
  const axis = `<div class="nav-y-axis" aria-hidden="true">${scale.ticks.map(tick => `<span style="top:${coordinate(y(tick.value) / HEIGHT * 100)}%">${tick.label}</span>`).join('')}</div>`;
  const measurement = '<span class="nav-measure-band" hidden aria-hidden="true"></span><span class="nav-measure-start-line" hidden aria-hidden="true"></span><span class="nav-measure-end-line" hidden aria-hidden="true"></span><span class="nav-measure-start" hidden aria-hidden="true">A</span><span class="nav-measure-end" hidden aria-hidden="true">B</span><span class="nav-hover-axis-date" hidden></span><span class="nav-hover-left-days" hidden></span><span class="nav-hover-right-days" hidden></span>';
  const measurementPanel = '<div class="nav-measure-panel" hidden><div class="nav-measure-result" hidden role="status" aria-live="polite"><div class="nav-measure-period"><strong class="nav-measure-days num"></strong><span class="nav-measure-dates"></span></div><div class="nav-measure-return"><span>区间涨跌幅</span><strong class="nav-measure-value num"></strong></div></div></div>';
  return `<div class="nav-chart-frame"><div class="nav-chart" tabindex="0" aria-label="净值图，使用左右方向键查看日期，回车选择起点或清空，Escape清除选点" data-nav-points="${attribute(JSON.stringify(publicPoints))}" data-nav-trades="${attribute(JSON.stringify(tradeSummary))}"${domain}${costCoordinate}><svg class="sparkline nav-plot" viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="none" role="img" aria-label="${firstDate}至${endDate}，${estimates.size ? `${combined.length}个净值` : `${safePoints.length}个已公布净值`}${extended ? '，右侧待更新' : ''}${costInRange ? '，含成本线' : ''}${safeMarkers.length ? '，含买卖记录' : ''}">${grid}${pending}${costLine}${curve}</svg>${axis}${estimatedDots}${pendingLabel}${costLabel}${trades}${resting}${measurement}${hover}</div>${domainLabels}${legend}${measurementPanel}</div>`;
}
