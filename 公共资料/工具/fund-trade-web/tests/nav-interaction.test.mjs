import test from 'node:test';
import assert from 'node:assert/strict';
import { setupNavChartInteractions } from '../nav-interaction.js';
import { renderNavChart } from '../nav-chart.js';

// Public synthetic NAVs only; this harness has no file access or account fixture.
const publicPoints = [
  { date: '2026-01-01', nav: 1.7, change: null, x: 5, y: 70 },
  { date: '2026-01-02', nav: 1.8, change: 0.02, x: 15, y: 55 },
  { date: '2026-01-11', nav: 2.1, change: -0.01, x: 95, y: 20 },
];

function node(parent = null) {
  const result = { parent, hidden: true, textContent: '', className: '', style: {}, classes: new Set() };
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
  chart.chart = true;
  chart.raw = raw;
  chart.tradeRaw = typeof trades === 'string' ? trades : JSON.stringify(trades);
  chart.domainRaw = typeof domain === 'string' ? domain : domain === null ? null : JSON.stringify(domain);
  chart.getAttribute = name => name === 'data-nav-trades' ? chart.tradeRaw : name === 'data-nav-domain' ? chart.domainRaw : name === 'data-nav-points' ? chart.raw : null;
  const rect = { left: 100, top: 20, width: 300, height: 128, ...dimensions };
  chart.getBoundingClientRect = () => rect;
  const elements = Object.fromEntries(['line', 'point', 'tooltip', 'date', 'status', 'value', 'change', 'trades'].map(name => [name, node(chart)]));
  elements.tooltip.getBoundingClientRect = () => ({ width: 152, height: elements.trades.hidden ? 44 : 64 });
  chart.querySelector = selector => elements[selector.replace('.nav-hover-', '')] || null;
  const marker = node(chart);
  const markerDot = node(marker);
  function emit(name, properties = {}) {
    const event = { target: chart, clientX: rect.left, relatedTarget: null, prevented: false, preventDefault() { this.prevented = true; }, ...properties };
    listeners.get(name)?.(event);
    return event;
  }
  const cleanup = setupNavChartInteractions(root);
  return { root, chart, rect, elements, marker, markerDot, emit, listeners, cleanup };
}

test('pointer inspection chooses the nearest actual date and displays only formatted public values', () => {
  const h = harness();
  h.emit('pointermove', { clientX: h.rect.left + h.rect.width * 0.6 });
  assert.equal(h.elements.date.textContent, '2026-01-11', 'irregular dates are not treated as evenly spaced indices');
  assert.equal(h.elements.value.textContent, '2.1000');
  assert.equal(h.elements.change.textContent, '-1.00%');
  assert.match(h.elements.change.className, /nav-hover-change num negative/);
  assert.equal(h.elements.line.style.left, '95%');
  assert.equal(h.elements.point.style.top, '20%');
  assert.equal(h.elements.tooltip.hidden, false);
  h.emit('pointermove', { target: h.markerDot, clientX: h.rect.left + h.rect.width * 0.2 });
  assert.equal(h.elements.date.textContent, '2026-01-02', 'hovering a transaction marker still inspects public NAV');
  assert.equal(h.elements.change.textContent, '+2.00%');
  assert.match(h.elements.change.className, /positive/);
  h.cleanup();
});

test('moving within a chart keeps inspection visible and leaving the chart hides all overlays', () => {
  const h = harness();
  h.emit('pointermove', { clientX: 160 });
  h.emit('pointerout', { relatedTarget: h.markerDot });
  assert.equal(h.elements.tooltip.hidden, false);
  h.emit('pointerout', { target: h.markerDot, relatedTarget: node() });
  for (const name of ['line', 'point', 'tooltip']) assert.equal(h.elements[name].hidden, true);
  h.emit('pointermove', { clientX: 160 });
  h.emit('focusout', { relatedTarget: node() });
  assert.equal(h.elements.tooltip.hidden, true);
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
  assert.equal(parseFloat(h.elements.tooltip.style.left), 4);
  assert.ok(parseFloat(h.elements.tooltip.style.top) >= 4 && parseFloat(h.elements.tooltip.style.top) + 44 <= 108);
  h.cleanup();
});

test('tooltip switches below high points and stays horizontally contained at both ends', () => {
  const dataset = [{ ...publicPoints[0], x: 0, y: 0 }, { ...publicPoints[1], x: 100, y: 100 }];
  const h = harness(JSON.stringify(dataset), { width: 220, height: 112 });
  h.emit('keydown', { key: 'Home' });
  assert.ok(h.elements.tooltip.classes.has('is-below'));
  assert.equal(parseFloat(h.elements.tooltip.style.left), 4);
  h.emit('keydown', { key: 'End' });
  assert.ok(!h.elements.tooltip.classes.has('is-below'));
  assert.ok(parseFloat(h.elements.tooltip.style.left) + 152 <= 216);
  h.cleanup();
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
  assert.equal(h.listeners.size, 5);
  h.emit('keydown', { key: 'Home' });
  assert.equal(h.elements.tooltip.hidden, false);
  secondCleanup();
  assert.equal(h.listeners.size, 0);
  assert.equal(h.elements.tooltip.hidden, true);
  h.cleanup();
});

test('daily trade details appear only while inspecting a date with records and never expose monetary fields', () => {
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
  assert.equal(h.elements.trades.hidden, false);
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
  assert.ok(Math.abs(parseFloat(h.elements.line.style.left) - (15 + (95 - 15) * 4 / 9)) < 0.00001);
  assert.ok(Math.abs(parseFloat(h.elements.point.style.top) - (55 + (20 - 55) * 4 / 9)) < 0.00001);
  h.emit('pointermove', { clientX: h.rect.left + h.rect.width * (15 + (95 - 15) * 4 / 9) / 100 });
  assert.equal(h.elements.date.textContent, '2026-01-06');
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
  assert.equal(h.elements.line.style.left, '50%');
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
    assert.equal(h.elements.status.hidden, status === '');
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
  assert.equal(parseFloat(h.elements.tooltip.style.left), 4);
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
    assert.equal(h.elements.status.hidden, expectedStatus === '');
    assert.equal(h.elements.value.textContent, expectedValue);
    h.cleanup();
  }
});
