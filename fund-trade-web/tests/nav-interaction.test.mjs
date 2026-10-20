import test from 'node:test';
import assert from 'node:assert/strict';
import { setupNavChartInteractions, measureNavChange } from '../src/nav-interaction.js';
import { renderNavChart } from '../src/nav-chart.js';

// Public synthetic NAVs only; this harness has no file access or account fixture.
const publicPoints = [
  { date: '2026-01-01', nav: 1.7, change: null, x: 5, y: 70 },
  { date: '2026-01-02', nav: 1.8, change: 0.02, x: 15, y: 55 },
  { date: '2026-01-11', nav: 2.1, change: -0.01, x: 95, y: 20 },
];

function node(parent = null) {
  const style = { getPropertyValue(name) { return this[name] || ''; }, setProperty(name, value) { this[name] = value; } };
  const result = { parent, hidden: true, textContent: '', className: '', style, classes: new Set() };
  result.contains = target => { for (let current = target; current; current = current.parent) if (current === result) return true; return false; };
  result.closest = selector => { for (let current = result; current; current = current.parent) if (selector === '.nav-chart' && current.chart) return current; return null; };
  result.classList = { toggle(name, enabled) { if (enabled) result.classes.add(name); else result.classes.delete(name); } };
  Object.defineProperty(result, 'innerHTML', { set() { throw new Error('Dynamic tooltip values must use textContent.'); } });
  return result;
}

function harness(raw = JSON.stringify(publicPoints), dimensions = {}, trades = [], domain = null) {
  const listeners = new Map();
  const root = node();
  root.addEventListener = (name, callback) => listeners.set(name, callback);
  root.removeEventListener = (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); };
  const chart = node(root);
  if (dimensions.costY) chart.style.setProperty('--nav-cost-y', dimensions.costY);
  chart.chart = true;
  chart.raw = raw;
  chart.tradeRaw = typeof trades === 'string' ? trades : JSON.stringify(trades);
  chart.domainRaw = typeof domain === 'string' ? domain : domain === null ? null : JSON.stringify(domain);
  chart.getAttribute = name => name === 'data-nav-trades' ? chart.tradeRaw : name === 'data-nav-domain' ? chart.domainRaw : name === 'data-nav-points' ? chart.raw : null;
  const rect = { left: 100, top: 20, width: 300, height: 128, ...dimensions };
  chart.getBoundingClientRect = () => rect;
  const elements = Object.fromEntries(['line', 'point', 'tooltip', 'date', 'status', 'value', 'change', 'trades', 'axis-date', 'left-days', 'right-days'].map(name => [name, node(chart)]));
  const measurement = Object.fromEntries(['panel', 'result', 'dates', 'days', 'value', 'band', 'start', 'end', 'start-line', 'end-line'].map(name => [name, node(chart)]));
  elements.tooltip.getBoundingClientRect = () => ({ width: dimensions.tooltipWidth || 104, height: dimensions.tooltipHeight || 18 });
  const resting = [node(chart), node(chart)];
  resting.forEach((element, index) => { element.hidden = false; element.style = { left: '15%', top: '55%', ...(index === 0 ? { bottom: '0' } : {}) }; });
  chart.querySelector = selector => selector.startsWith('.nav-measure-') ? measurement[selector.slice(13)] : elements[selector.replace('.nav-hover-', '')] || (selector === '.nav-chart-rest-line' ? resting[0] : selector === '.nav-chart-rest-point' ? resting[1] : null);
  chart.querySelectorAll = selector => selector.includes('nav-chart-rest') ? resting : [];
  const marker = node(chart);
  const markerDot = node(marker);
  function emit(name, properties = {}) {
    const event = { target: chart, clientX: rect.left, relatedTarget: null, prevented: false, preventDefault() { this.prevented = true; }, ...properties };
    listeners.get(name)?.(event);
    return event;
  }
  const cleanup = setupNavChartInteractions(root, dimensions.interactions);
  return { root, chart, rect, elements, measurement, resting, marker, markerDot, emit, listeners, cleanup };
}

function hiddenMetadata(h) {
  for (const name of ['date', 'status', 'trades']) assert.equal(h.elements[name].hidden, true, `${name} is retained only as hidden metadata`);
}

function clearCaption(h, points) {
  const tooltip = h.elements.tooltip;
  const left = Number.parseFloat(tooltip.style.left), top = Number.parseFloat(tooltip.style.top);
  const width = Math.min(tooltip.getBoundingClientRect().width, h.rect.width - 8), height = tooltip.getBoundingClientRect().height;
  assert.ok(Number.isFinite(left) && Number.isFinite(top), 'caption has finite coordinates');
  assert.ok(left >= 4 && left + width <= h.rect.width - 4, 'caption remains horizontally inside the chart');
  assert.ok(top >= 4 && top + height <= h.rect.height - 4 || top + height <= -8, 'caption fits in-chart or in the reserved area above it');
  const box = { left: left - 1, right: left + width + 1, top: top - 1, bottom: top + height + 1 };
  const pixel = point => ({ x: point.x / 100 * h.rect.width, y: point.y / 100 * h.rect.height });
  const inside = point => point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const intersects = (a, b, c, d) => {
    const bounded = Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x))
      && Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
    return bounded && cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0;
  };
  const corners = [{ x: box.left, y: box.top }, { x: box.right, y: box.top }, { x: box.right, y: box.bottom }, { x: box.left, y: box.bottom }];
  const projected = points.map(pixel);
  assert.ok(projected.every(point => !inside(point)), 'caption does not cover any NAV observation');
  for (let index = 1; index < projected.length; index++) {
    const a = projected[index - 1], b = projected[index];
    assert.equal(inside(a) || inside(b) || corners.some((corner, index) => intersects(a, b, corner, corners[(index + 1) % 4])), false, 'caption does not cover any published or estimated curve segment');
  }
}

test('mobile taps inspect a single NAV without creating an interval; resizing clears desktop anchors', () => {
  const changes = new Map();
  const media = { matches: false, addEventListener: (name, fn) => changes.set(name, fn), removeEventListener: name => changes.delete(name) };
  const h = harness(undefined, { interactions: { matchMedia: () => media } });
  h.emit('click', { clientX: h.rect.left + 45 });
  assert.equal(h.elements.tooltip.hidden, false);
  assert.equal(h.measurement.panel.hidden, true);
  h.emit('keydown', { key: 'Enter' });
  h.emit('pointermove', { clientX: h.rect.left + 285 });
  assert.equal(h.measurement.start.hidden, true);
  assert.equal(h.measurement.panel.hidden, true);
  media.matches = true;
  changes.get('change')();
  h.emit('click', { clientX: h.rect.left + 45 });
  assert.equal(h.measurement.start.hidden, false);
  h.emit('pointermove', { clientX: h.rect.left + 285 });
  assert.equal(h.measurement.panel.hidden, false);
  media.matches = false;
  changes.get('change')();
  assert.equal(h.measurement.panel.hidden, true);
  assert.equal(h.measurement.start.hidden, true);
  h.cleanup();
  assert.equal(changes.size, 0);
});

test('first click anchors, hover updates returns and calendar days, second click clears and third restarts', () => {
  const h = harness();
  h.emit('click', { clientX: 115, isPrimary: false });
  assert.equal(h.measurement.start.hidden, false);
  assert.equal(h.measurement.result.hidden, true);
  h.emit('pointermove', { clientX: 145 });
  assert.equal(h.measurement.value.textContent, '+5.88%');
  assert.equal(h.measurement.days.textContent, '1 天');
  assert.match(h.measurement.dates.textContent, /2026-01-01 → 2026-01-02/);
  h.emit('pointermove', { clientX: 385 });
  assert.equal(h.measurement.value.textContent, '+23.53%');
  assert.equal(h.measurement.days.textContent, '10 天');
  h.emit('click', { clientX: 385 });
  h.emit('pointermove', { clientX: 145 });
  assert.equal(h.measurement.result.hidden, true);
  assert.equal(h.measurement.start.hidden, true);
  h.emit('click', { clientX: 145 });
  assert.equal(h.measurement.result.hidden, true);
  h.emit('pointermove', { clientX: 115 });
  assert.equal(h.measurement.value.textContent, '-5.56%');
  h.emit('keydown', { key: 'Escape' });
  assert.equal(h.measurement.start.hidden, true);
  assert.equal(h.measurement.result.hidden, true);
  h.cleanup();
});

test('measurement uses public NAV ratios, handles identical points and ignores dates without NAV', () => {
  assert.equal(measureNavChange(publicPoints[0], publicPoints[0]), 0);
  assert.equal(measureNavChange(publicPoints[0], { date: '2026-01-03', nav: null }), null);
  assert.equal(measureNavChange(publicPoints[0], { date: 'bad', nav: 2 }), null);
  const h = harness();
  h.emit('keydown', { key: 'Home' }); h.emit('keydown', { key: 'Enter' });
  h.emit('keydown', { key: 'End' });
  assert.equal(h.measurement.value.textContent, '+23.53%');
  h.emit('keydown', { key: 'Enter' }); h.emit('keydown', { key: 'Home' });
  assert.equal(h.measurement.result.hidden, true);
  h.chart.raw = JSON.stringify([{ ...publicPoints[0], nav: 1.99 }]);
  h.emit('pointermove', { clientX: 115 });
  assert.equal(h.measurement.start.hidden, true, 'source replacement clears old anchors');
  h.cleanup();
});

test('pointer inspection chooses the nearest actual date and displays only formatted public values', () => {
  const h = harness();
  h.emit('pointermove', { clientX: h.rect.left + h.rect.width * 0.6 });
  assert.equal(h.elements.date.textContent, '2026-01-11', 'irregular dates are not treated as evenly spaced indices');
  assert.equal(h.elements.value.textContent, '2.1000');
  assert.equal(h.elements.change.textContent, '-1.00%');
  assert.match(h.elements.change.className, /nav-hover-change num negative/);
  assert.equal(h.elements.line.style.left, '95%');
  assert.equal(h.elements.line.style.top, '20%');
  assert.equal(h.elements.line.style.bottom, '0');
  assert.equal(h.elements.point.style.top, '20%');
  assert.equal(h.elements.tooltip.hidden, false);
  hiddenMetadata(h);
  h.emit('pointermove', { target: h.markerDot, clientX: h.rect.left + h.rect.width * 0.2 });
  assert.equal(h.elements.date.textContent, '2026-01-02', 'hovering a transaction marker still inspects public NAV');
  assert.equal(h.elements.change.textContent, '+2.00%');
  assert.match(h.elements.change.className, /positive/);
  h.cleanup();
});

test('hover displays the point date and calendar distances centered between both chart boundaries', () => {
  const h = harness(undefined, { width: 2000 });
  h.emit('pointermove', { clientX: 400 });
  assert.equal(h.elements['axis-date'].textContent, '2026-01-02');
  assert.equal(h.elements['left-days'].textContent, '1 天');
  assert.equal(h.elements['right-days'].textContent, '9 天');
  for (const name of ['axis-date', 'left-days', 'right-days']) {
    assert.equal(h.elements[name].hidden, false);
    assert.ok(Number.isFinite(Number.parseFloat(h.elements[name].style.left)));
  }
  assert.ok(Number.parseFloat(h.elements['left-days'].style.left) < Number.parseFloat(h.elements['right-days'].style.left));
  h.emit('pointerout', { relatedTarget: node() });
  for (const name of ['axis-date', 'left-days', 'right-days']) assert.equal(h.elements[name].hidden, true);
  h.cleanup();
});

test('hover dots follow the public cost-line coordinate and return to the fund color without it', () => {
  const h = harness(JSON.stringify(publicPoints), { costY: '55%' });
  h.emit('keydown', { key: 'Home' });
  assert.equal(h.elements.point.style.getPropertyValue('--nav-point-color'), 'var(--negative)');
  h.emit('keydown', { key: 'ArrowRight' });
  assert.equal(h.elements.point.style.getPropertyValue('--nav-point-color'), 'var(--positive)', 'an observation on the cost line uses its upper-side color');
  h.emit('keydown', { key: 'End' });
  assert.equal(h.elements.point.style.getPropertyValue('--nav-point-color'), 'var(--positive)');
  h.chart.style.setProperty('--nav-cost-y', '');
  h.emit('keydown', { key: 'Home' });
  assert.equal(h.elements.point.style.getPropertyValue('--nav-point-color'), 'var(--fund)');
  h.cleanup();
});

test('leaving or blurring a chart hides hover overlays while preserving resting guides', () => {
  const h = harness();
  const resting = h.resting.map(element => ({ hidden: element.hidden, style: { ...element.style } }));
  h.emit('pointermove', { clientX: 160 });
  h.emit('pointerout', { relatedTarget: h.markerDot });
  assert.equal(h.elements.tooltip.hidden, false);
  h.emit('pointerout', { target: h.markerDot, relatedTarget: node() });
  for (const name of ['line', 'point', 'tooltip']) assert.equal(h.elements[name].hidden, true);
  h.emit('pointermove', { clientX: 160 });
  h.emit('focusout', { relatedTarget: node() });
  assert.equal(h.elements.tooltip.hidden, true);
  assert.deepEqual(h.resting.map(element => ({ hidden: element.hidden, style: { ...element.style } })), resting);
  h.cleanup();
});

test('touch pointerdown and pointermove inspect values without preventing vertical page scrolling', () => {
  const h = harness();
  const down = h.emit('pointerdown', { pointerType: 'touch', clientX: 160 });
  assert.equal(down.prevented, false);
  assert.equal(h.elements.date.textContent, '2026-01-02');
  const move = h.emit('pointermove', { pointerType: 'touch', clientX: 390 });
  assert.equal(move.prevented, false);
  assert.equal(h.elements.date.textContent, '2026-01-11');
  h.cleanup();
});

test('keyboard arrows, Home, End and Escape work at both boundaries', () => {
  const h = harness();
  for (const [key, date] of [['ArrowRight', '2026-01-01'], ['ArrowRight', '2026-01-02'], ['End', '2026-01-11'], ['ArrowLeft', '2026-01-02'], ['Home', '2026-01-01'], ['ArrowLeft', '2026-01-01']]) {
    const event = h.emit('keydown', { key });
    assert.equal(event.prevented, true);
    assert.equal(h.elements.date.textContent, date);
  }
  assert.equal(h.elements.change.textContent, '—', 'a day without a prior NAV has no invented daily return');
  h.emit('keydown', { key: 'Escape' });
  assert.equal(h.elements.tooltip.hidden, true);
  h.cleanup();
});

test('single-point datasets remain usable and tooltip bounds stay within narrow charts', () => {
  const single = [{ date: '2026-01-01', nav: 1.23456, change: null, x: 50, y: 50 }];
  const h = harness(JSON.stringify(single), { width: 100, height: 112 });
  h.emit('pointermove', { clientX: 180 });
  assert.equal(h.elements.value.textContent, '1.2346');
  h.emit('keydown', { key: 'End' });
  h.emit('keydown', { key: 'ArrowRight' });
  assert.equal(h.elements.date.textContent, single[0].date);
  assert.equal(h.elements.tooltip.style.maxWidth, '92px');
  clearCaption(h, single);
  h.cleanup();
});

test('inline captions avoid an edge-to-edge curve and stay contained at both boundaries', () => {
  const dataset = [{ ...publicPoints[0], x: 0, y: 0 }, { ...publicPoints[1], x: 100, y: 100 }];
  const h = harness(JSON.stringify(dataset), { width: 220, height: 112 });
  h.emit('keydown', { key: 'Home' });
  clearCaption(h, dataset);
  h.emit('keydown', { key: 'End' });
  clearCaption(h, dataset);
  h.cleanup();
});

test('captions avoid dense top-left, central and estimated segments in narrow charts', () => {
  for (const [width, coordinates] of [
    [160, [[2, 2], [15, 95], [29, 5], [45, 90], [61, 15], [78, 95], [98, 5]]],
    [220, [[5, 45], [14, 60], [23, 40], [32, 70], [41, 30], [50, 60], [59, 45], [68, 65], [77, 35], [86, 55], [95, 50]]],
    [180, [[5, 15], [22, 70], [49, 40], [74, 10], [95, 85]]],
  ]) {
    const dataset = coordinates.map(([x, y], index) => ({ date: `2026-02-${String(index + 1).padStart(2, '0')}`, nav: 1 + index / 100, change: index ? .01 : null, x, y, ...(index === coordinates.length - 1 ? { estimated: true } : {}) }));
    const h = harness(JSON.stringify(dataset), { width, height: 128 });
    h.emit('keydown', { key: 'Home' });
    for (let index = 0; index < dataset.length; index++) {
      if (index) h.emit('keydown', { key: 'ArrowRight' });
      assert.equal(h.elements.tooltip.hidden, false);
      clearCaption(h, dataset);
      hiddenMetadata(h);
    }
    h.cleanup();
  }
});

test('empty, malformed, injected or non-public payloads are ignored without executing markup', () => {
  globalThis.__navHoverExecuted = false;
  const malicious = [
    null, '', '[]', 'not json', '<img src=x onerror="globalThis.__navHoverExecuted=true">',
    JSON.stringify([{ ...publicPoints[0], date: '<svg onload=alert(1)>' }]),
    JSON.stringify([{ ...publicPoints[0], note: 'private-note' }]),
    JSON.stringify([{ ...publicPoints[0], costNav: 1 }]),
    JSON.stringify([{ ...publicPoints[0], amount: 1 }]),
    JSON.stringify([{ ...publicPoints[0], nav: '<script>alert(1)</script>' }]),
    JSON.stringify([{ ...publicPoints[0], x: -1 }]),
    JSON.stringify([{ ...publicPoints[0], y: 101 }]),
    '[{"date":"2026-01-01","nav":1,"change":1e999,"x":50,"y":50}]',
  ];
  for (const raw of malicious) {
    const h = harness(raw);
    assert.doesNotThrow(() => h.emit('pointermove', { clientX: 150 }));
    assert.equal(h.emit('keydown', { key: 'Home' }).prevented, false);
    assert.equal(h.elements.tooltip.hidden, true);
    assert.equal(h.elements.value.textContent, '');
    h.cleanup();
  }
  assert.equal(globalThis.__navHoverExecuted, false);
  delete globalThis.__navHoverExecuted;
});

test('delegation survives public-data replacement, repeated setup is idempotent, and cleanup removes listeners', () => {
  const h = harness();
  h.emit('keydown', { key: 'End' });
  h.chart.raw = JSON.stringify([{ ...publicPoints[0], nav: 1.99 }]);
  h.emit('pointermove', { clientX: 150 });
  assert.equal(h.elements.value.textContent, '1.9900');
  const secondCleanup = setupNavChartInteractions(h.root);
  assert.equal(h.listeners.size, 6);
  h.emit('keydown', { key: 'Home' });
  assert.equal(h.elements.tooltip.hidden, false);
  secondCleanup();
  assert.equal(h.listeners.size, 0);
  assert.equal(h.elements.tooltip.hidden, true);
  h.cleanup();
});

test('daily trade details remain hidden metadata and never expose monetary fields', () => {
  const h = harness(JSON.stringify(publicPoints), {}, [
    { date: '2026-01-02', type: 'buy', count: 3, estimated: true },
    { date: '2026-01-02', type: 'sell', count: 2, estimated: false },
  ]);
  assert.equal(h.elements.tooltip.hidden, true);
  assert.equal(h.elements.trades.hidden, true);
  h.emit('pointermove', { clientX: 145 });
  assert.equal(h.elements.date.textContent, '2026-01-02');
  assert.equal(h.elements.value.textContent, '1.8000');
  assert.equal(h.elements.trades.textContent, '买入3笔 / 卖出2笔 · 含估算');
  hiddenMetadata(h);
  assert.doesNotMatch(h.elements.trades.textContent, /金额|份额|成本|备注/);
  h.emit('keydown', { key: 'Home' });
  assert.equal(h.elements.trades.textContent, '');
  assert.equal(h.elements.trades.hidden, true);
  h.emit('pointerout');
  assert.equal(h.elements.tooltip.hidden, true);
  h.cleanup();
});

test('every trade-only date remains inspectable without inventing a public NAV', () => {
  const h = harness(JSON.stringify(publicPoints), {}, [
    { date: '2026-01-06', type: 'buy', count: 1, estimated: false },
  ]);
  h.emit('keydown', { key: 'Home' });
  h.emit('keydown', { key: 'ArrowRight' });
  h.emit('keydown', { key: 'ArrowRight' });
  assert.equal(h.elements.date.textContent, '2026-01-06');
  assert.equal(h.elements.value.textContent, '—');
  assert.equal(h.elements.change.textContent, '—');
  assert.equal(h.elements.trades.textContent, '买入1笔');
  for (const name of ['line', 'point', 'tooltip']) assert.equal(h.elements[name].hidden, true, 'a trade-only day has no fabricated NAV annotation');
  hiddenMetadata(h);
  h.emit('pointermove', { clientX: h.rect.left + h.rect.width * (15 + (95 - 15) * 4 / 9) / 100 });
  assert.equal(h.elements.date.textContent, '2026-01-06');
  h.emit('keydown', { key: 'ArrowRight' });
  assert.equal(h.elements.date.textContent, '2026-01-11');
  assert.equal(h.elements.tooltip.hidden, false, 'inspection resumes at the next actual observation');
  h.cleanup();
});

test('malformed, duplicate, outside-window or private trade payloads are rejected while public NAV inspection remains available', () => {
  const valid = { date: '2026-01-02', type: 'buy', count: 1, estimated: false };
  for (const trades of ['not-json', JSON.stringify([{ ...valid, date: '<img onerror=alert(1)>' }]), JSON.stringify([{ ...valid, amount: 'hidden' }]),
    JSON.stringify([{ ...valid, nav: 1.8 }]), JSON.stringify([{ ...valid, id: 'hidden' }]), JSON.stringify([{ ...valid, count: 0 }]),
    JSON.stringify([{ ...valid, estimated: 'true' }]), JSON.stringify([{ ...valid, date: '2025-12-31' }]), JSON.stringify([valid, valid])]) {
    const h = harness(JSON.stringify(publicPoints), {}, trades);
    assert.doesNotThrow(() => h.emit('pointermove', { clientX: 145 }));
    assert.equal(h.elements.value.textContent, '1.8000');
    assert.equal(h.elements.trades.textContent, '');
    assert.equal(h.elements.trades.hidden, true);
    h.cleanup();
  }
});

test('trade-summary changes invalidate the cache even when public NAV points stay unchanged', () => {
  const h = harness(JSON.stringify(publicPoints), {}, [{ date: '2026-01-02', type: 'buy', count: 1, estimated: false }]);
  h.emit('pointermove', { clientX: 145 });
  assert.equal(h.elements.trades.textContent, '买入1笔');
  h.chart.tradeRaw = JSON.stringify([{ date: '2026-01-02', type: 'buy', count: 4, estimated: false }]);
  h.emit('pointermove', { clientX: 145 });
  assert.equal(h.elements.trades.textContent, '买入4笔');
  h.cleanup();
});

const extendedDomain = { start: '2026-01-01', end: '2026-01-05', lastPublished: '2026-01-02', left: 5, right: 95 };
const extendedPoints = [
  { date: '2026-01-01', nav: 1.7, change: null, x: 5, y: 70 },
  { date: '2026-01-02', nav: 1.8, change: .02, x: 27.5, y: 55 },
  { date: '2026-01-04', nav: 1.9, change: .03, x: 72.5, y: 30, estimated: true },
];

test('hover distinguishes published and estimated NAVs and pending dates without snapping blank space to a value', () => {
  const h = harness(JSON.stringify(extendedPoints), {}, [], extendedDomain);
  h.emit('pointermove', { clientX: h.rect.left + h.rect.width * .5 });
  assert.equal(h.elements.date.textContent, '2026-01-03');
  assert.equal(h.elements.status.textContent, '待更新');
  assert.equal(h.elements.value.textContent, '—');
  assert.equal(h.elements.change.textContent, '—');
  assert.equal(h.elements.point.hidden, true, 'a missing observation has no price dot');
  assert.equal(h.elements.line.hidden, true);
  assert.equal(h.elements.tooltip.hidden, true);
  hiddenMetadata(h);
  h.emit('pointermove', { clientX: h.rect.left + h.rect.width * .725 });
  assert.equal(h.elements.date.textContent, '2026-01-04');
  assert.equal(h.elements.status.textContent, '');
  assert.equal(h.elements.status.hidden, true);
  assert.equal(h.elements.value.textContent, '1.9000');
  assert.equal(h.elements.change.textContent, '+3.00%');
  assert.equal(h.elements.point.hidden, false);
  assert.equal(h.elements.point.classes.has('is-estimated'), true);
  h.emit('pointermove', { clientX: h.rect.left + h.rect.width * .275 });
  assert.equal(h.elements.date.textContent, '2026-01-02');
  assert.equal(h.elements.status.textContent, '已公布');
  hiddenMetadata(h);
  assert.equal(h.elements.value.textContent, '1.8000');
  assert.equal(h.elements.point.classes.has('is-estimated'), false);
  h.emit('pointermove', { clientX: h.rect.left + h.rect.width });
  assert.equal(h.elements.date.textContent, '2026-01-05');
  assert.equal(h.elements.status.textContent, '待更新');
  assert.equal(h.elements.value.textContent, '—');
  assert.equal(h.elements.trades.hidden, true);
  h.cleanup();
});

test('keyboard inspection steps through calendar dates in the pending tail and can inspect an estimated day', () => {
  const h = harness(JSON.stringify(extendedPoints), {}, [], extendedDomain);
  for (const [key, date, status] of [
    ['Home', '2026-01-01', '已公布'],
    ['ArrowRight', '2026-01-02', '已公布'],
    ['ArrowRight', '2026-01-03', '待更新'],
    ['ArrowRight', '2026-01-04', ''],
    ['ArrowRight', '2026-01-05', '待更新'],
    ['ArrowRight', '2026-01-05', '待更新'],
    ['ArrowLeft', '2026-01-04', ''],
    ['ArrowLeft', '2026-01-03', '待更新'],
    ['ArrowLeft', '2026-01-02', '已公布'],
    ['End', '2026-01-05', '待更新'],
  ]) {
    assert.equal(h.emit('keydown', { key }).prevented, true);
    assert.equal(h.elements.date.textContent, date);
    assert.equal(h.elements.status.textContent, status);
    hiddenMetadata(h);
    assert.equal(h.elements.tooltip.hidden, status === '待更新');
  }
  h.emit('keydown', { key: 'Escape' });
  assert.equal(h.elements.tooltip.hidden, true);
  h.cleanup();
});

test('the end of an extended single-observation chart is pending rather than a duplicated last NAV', () => {
  const h = harness(JSON.stringify([extendedPoints[0]]), { width: 100 }, [], { ...extendedDomain, lastPublished: '2026-01-01' });
  h.emit('keydown', { key: 'End' });
  assert.equal(h.elements.date.textContent, '2026-01-05');
  assert.equal(h.elements.status.textContent, '待更新');
  assert.equal(h.elements.value.textContent, '—');
  assert.equal(h.elements.point.hidden, true);
  assert.equal(h.elements.tooltip.hidden, true);
  assert.equal(h.elements.line.hidden, true);
  h.emit('keydown', { key: 'Home' });
  assert.equal(h.elements.date.textContent, '2026-01-01');
  assert.equal(h.elements.status.textContent, '已公布');
  assert.equal(h.elements.value.textContent, '1.7000');
  h.cleanup();
});

test('pending-tail inspection remains bounded for distant valid dates without generating a daily-sized array', () => {
  const h = harness(JSON.stringify([extendedPoints[0]]), {}, [], { ...extendedDomain, end: '9999-12-31', lastPublished: '2026-01-01' });
  h.emit('keydown', { key: 'End' });
  assert.equal(h.elements.date.textContent, '9999-12-31');
  assert.equal(h.elements.status.textContent, '待更新');
  h.emit('keydown', { key: 'ArrowLeft' });
  assert.equal(h.elements.date.textContent, '9999-12-30');
  assert.equal(h.elements.value.textContent, '—');
  h.cleanup();
});

test('domain metadata changes invalidate inspection cache without changing the public NAV payload', () => {
  const h = harness(JSON.stringify(extendedPoints), {}, [], extendedDomain);
  h.emit('keydown', { key: 'End' });
  assert.equal(h.elements.status.textContent, '待更新');
  h.chart.domainRaw = null;
  h.emit('keydown', { key: 'End' });
  assert.equal(h.elements.date.textContent, '2026-01-04');
  assert.equal(h.elements.status.textContent, '');
  assert.equal(h.elements.status.hidden, true);
  assert.equal(h.elements.value.textContent, '1.9000');
  h.cleanup();
});

test('malformed or private domain and estimate metadata cannot render unsafe tooltip content', () => {
  for (const domain of ['not-json', { ...extendedDomain, end: '<img onerror=alert(1)>' }, { ...extendedDomain, amount: 'private-amount' }, { ...extendedDomain, lastPublished: '2026-01-04' }]) {
    const h = harness(JSON.stringify(extendedPoints), {}, [], domain);
    h.emit('keydown', { key: 'End' });
    assert.equal(h.elements.date.textContent, '2026-01-04');
    assert.equal(h.elements.status.textContent, '');
    assert.equal(h.elements.status.hidden, true);
    assert.doesNotMatch(h.elements.status.textContent, /private|<img|onerror/);
    h.cleanup();
  }
  for (const parsed of [[{ ...extendedPoints[2] }], [extendedPoints[0], { ...extendedPoints[2], amount: 'private-amount' }], [extendedPoints[0], { ...extendedPoints[2], estimated: 'true' }]]) {
    const h = harness(JSON.stringify(parsed), {}, [], extendedDomain);
    h.emit('keydown', { key: 'End' });
    assert.equal(h.elements.tooltip.hidden, true);
    assert.equal(h.elements.value.textContent, '');
    h.cleanup();
  }
});

test('rendered public metadata drives pending inspection and an official update replaces the forecast in the tooltip', () => {
  const decode = (markup, name) => JSON.parse(new RegExp(`${name}="([^"]*)"`).exec(markup)[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
  const estimate = { date: '2026-01-12', nav: 2.2, estimated: true };
  for (const [observations, expectedStatus, expectedValue] of [
    [publicPoints, '', '2.2000'],
    [[...publicPoints, { date: '2026-01-12', nav: 2.15 }], '已公布', '2.1500'],
  ]) {
    const markup = renderNavChart(observations, { domainEnd: '2026-01-13', estimatedPoints: [estimate] });
    const h = harness(JSON.stringify(decode(markup, 'data-nav-points')), {}, decode(markup, 'data-nav-trades'), decode(markup, 'data-nav-domain'));
    h.emit('keydown', { key: 'End' });
    assert.equal(h.elements.date.textContent, '2026-01-13');
    assert.equal(h.elements.status.textContent, '待更新');
    assert.equal(h.elements.value.textContent, '—');
    h.emit('keydown', { key: 'ArrowLeft' });
    assert.equal(h.elements.date.textContent, '2026-01-12');
    assert.equal(h.elements.status.textContent, expectedStatus);
    hiddenMetadata(h);
    assert.equal(h.elements.value.textContent, expectedValue);
    h.cleanup();
  }
});
