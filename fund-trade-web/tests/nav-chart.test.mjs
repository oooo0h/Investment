import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNavChart, createNavScale } from '../src/nav-chart.js';

// Invented NAVs and markers only. Never read account snapshots in this suite.
const point = (date, nav) => ({ date, nav });
const points = [point('2026-01-01', 1.7), point('2026-01-02', 1.8), point('2026-01-11', 2.1)];
const curve = markup => /class="nav-chart-curve" points="([^"]+)"/.exec(markup)?.[1].split(' ').map(pair => pair.split(',').map(Number));
const markerPosition = (markup, type) => {
  const match = new RegExp(`class="nav-trade-marker nav-trade-${type}[^\\"]*" style="left:([\\d.]+)%;top:([\\d.]+)%"`).exec(markup);
  return match ? [Number(match[1]) / 100 * 300, Number(match[2]) / 100 * 128] : null;
};
const assertSafe = markup => {
  assert.doesNotMatch(markup, /NaN|Infinity|<text\b|chart-caption|data-cost/);
  assert.equal((markup.match(/<svg\b/g) || []).length, 1);
};
const hoverPoints = markup => JSON.parse(/data-nav-points="([^"]*)"/.exec(markup)[1].replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
const tradeSummaries = markup => JSON.parse(/data-nav-trades="([^"]*)"/.exec(markup)[1].replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
const coloredSegments = markup => [...markup.matchAll(/<polyline class="(nav-chart-(?:estimated-)?curve)" points="([^"]+)" fill="none" stroke="var\(--(fund|positive|negative)\)"[^>]*>/g)].map(match => ({
  estimated: match[1].includes('estimated'), color: match[3],
  points: match[2].split(' ').map(pair => pair.split(',').map(Number)), markup: match[0],
}));

test('adaptive Y ticks divide a tight visible domain evenly, including flat and tiny series', () => {
  for (const values of [[2.111, 2.115, 2.113], [1.2, 1.2], [1e-10, 2e-10], [100, 200]]) {
    const scale = createNavScale(values);
    assert.ok(scale.lower < Math.min(...values) && scale.upper > Math.max(...values));
    assert.ok(scale.ticks.length >= 4 && scale.ticks.length <= 8);
    const step = scale.ticks[1].value - scale.ticks[0].value;
    for (let index = 2; index < scale.ticks.length; index++) {
      assert.ok(Math.abs((scale.ticks[index].value - scale.ticks[index - 1].value) / step - 1) < 1e-10);
    }
    assert.equal(new Set(scale.ticks.map(tick => tick.label)).size, scale.ticks.length);
  }
  const scale = createNavScale([2.111, 2.115]);
  assert.ok(scale.upper - scale.lower < .01, 'small visible changes use a close scale');
});

test('plain NAV curve has one SVG, an adaptive vertical axis, and elapsed-date x coordinates', () => {
  const input = [points[2], points[0], points[1]];
  const original = structuredClone(input);
  const markup = renderNavChart(input);
  assertSafe(markup);
  assert.deepEqual(input, original);
  assert.match(markup, /class="nav-chart"/);
  assert.match(markup, /class="sparkline nav-plot"/);
  assert.match(markup, /2026-01-01至2026-01-11，3个已公布净值/);
  const positions = curve(markup);
  assert.equal(positions[0][0], 8);
  assert.equal(positions[2][0], 292);
  assert.ok(Math.abs((positions[1][0] - positions[0][0]) / (positions[2][0] - positions[0][0]) - 0.1) < 0.00001);
  assert.doesNotMatch(markup, /class="nav-cost|class="nav-trade|class="nav-chart-legend/);
});

test('cost outside the visible NAV scale uses a directional label without flattening the public curve', () => {
  for (const costNav of [0, 0.9134567, 4.1234567]) {
    const markup = renderNavChart(points, { costNav });
    assertSafe(markup);
    assert.doesNotMatch(markup, /class="nav-cost-line"/);
    assert.match(markup, /class="nav-cost-label"[^>]*>成本 [↑↓]<\/span>/);
    assert.deepEqual(curve(markup), curve(renderNavChart(points)));
    assert.doesNotMatch(markup, /成本[：:\d]|costNav|data-cost/);
    assert.ok(curve(markup).every(([, y]) => y > 12 && y < 116), 'NAV curve also stays inside the plot');
  }
  assert.match(renderNavChart(points, { costNav: 1.9 }), /class="nav-cost-line"[^>]*stroke-dasharray="5 4"/);
});

test('buy and sell positions use actual marker NAV and interpolate dates within the selected window', () => {
  const markup = renderNavChart(points, { markers: [
    { date: '2026-01-06', nav: 3.2, type: 'buy' },
    { date: '2026-01-11', nav: 1.2, type: 'sell', estimated: true },
  ] });
  assertSafe(markup);
  const buy = markerPosition(markup, 'buy');
  const sell = markerPosition(markup, 'sell');
  assert.equal(buy[0], 150, 'mid-window date is at the middle of the timeline');
  assert.ok(Math.abs(sell[0] - 292) < 0.001);
  assert.ok(buy[1] < Math.min(...curve(markup).map(([, y]) => y)), 'marker uses its own execution NAV');
  assert.ok(sell[1] > Math.max(...curve(markup).map(([, y]) => y)));
  assert.match(markup, /nav-trade-buy[^>]*aria-label="买入 · 2026-01-06 · 超出当前刻度"/);
  assert.match(markup, /nav-trade-sell is-estimated[^>]*aria-label="卖出 · 2026-01-11 · 含估算 · 超出当前刻度"/);
  assert.match(markup, /nav-trade-offscale-above/);
  assert.match(markup, /nav-trade-offscale-below/);
  assert.ok(markup.indexOf('class="nav-trade-marker') > markup.indexOf('</svg>'), 'trade symbols render in HTML so SVG stretching cannot resize them');
  assert.doesNotMatch(markup, /<g\b|<path\b/);
  assert.match(markup, /nav-chart-legend-buy/);
  assert.match(markup, /nav-chart-legend-sell/);
  assert.match(markup, /nav-chart-legend-estimated">含估算成交<\/span>/);
  for (const label of markup.matchAll(/(?:aria-label|title)="([^"]*)"/g)) assert.doesNotMatch(label[1], /3\.2|1\.2|金额|份额/);
});

test('trade direction controls round-dot symbols independently of the estimated state', () => {
  const markup = renderNavChart(points, { markers: [
    { date: '2026-01-02', nav: 1.8, type: 'buy' },
    { date: '2026-01-03', nav: 1.9, type: 'sell' },
    { date: '2026-01-04', nav: 1.85, type: 'buy', estimated: true },
    { date: '2026-01-05', nav: 1.95, type: 'sell', estimated: true },
  ] });
  assertSafe(markup);
  assert.doesNotMatch(markup, /[▲▼△▽]/);
  for (const type of ['buy', 'sell']) {
    assert.match(markup, new RegExp(`class="nav-trade-marker nav-trade-${type}"[^>]*><span class="nav-trade-dot" aria-hidden="true"></span></span>`));
    assert.match(markup, new RegExp(`class="nav-trade-marker nav-trade-${type} is-estimated"[^>]*><span class="nav-trade-dot" aria-hidden="true"></span></span>`));
    assert.match(markup, new RegExp(`class="nav-chart-legend-${type}"><span class="nav-trade-dot" aria-hidden="true"></span>${type === 'buy' ? '买入' : '卖出'}`));
  }
  assert.doesNotMatch(markup, /class="nav-trade-dot is-estimated"/);
});

test('subscriptions, transfers and dividend reinvestments keep the buy symbol and aggregate with buys', () => {
  const markup = renderNavChart(points, { markers: [
    ...['buy', 'sip', 'transfer-in', 'reinvest'].map((type, index) => ({ id: `synthetic-${index}`, date: '2026-01-02', nav: 1.8, type, estimated: type === 'sip' })),
    { date: '2026-01-02', nav: 1.8, type: 'sell', estimated: true },
  ] });
  assert.deepEqual(tradeSummaries(markup), [
    { date: '2026-01-02', type: 'buy', count: 4, estimated: true },
    { date: '2026-01-02', type: 'sell', count: 1, estimated: true },
  ]);
  assert.equal((markup.match(/class="nav-trade-marker nav-trade-buy/g) || []).length, 1);
  assert.equal((markup.match(/class="nav-trade-marker nav-trade-sell/g) || []).length, 1);
  assert.match(markup, /买入 · 2026-01-02 · 共4笔 · 含估算/);
  assert.doesNotMatch(markup, /class="nav-trade-dot is-estimated"|nav-trade-sip|nav-trade-transfer-in|nav-trade-reinvest/);
});

test('outside-window and invalid markers are omitted without changing curve scale', () => {
  const markup = renderNavChart(points, { markers: [
    { date: '2025-12-31', nav: 900, type: 'buy' },
    { date: '2026-01-12', nav: 800, type: 'sell' },
    { date: '2026-01-06', nav: Infinity, type: 'buy' },
    { date: '2026-01-06', nav: -1, type: 'sell' },
    { date: '2026-01-06', nav: 1.8, type: 'advice' },
    { date: '<img src=x onerror=alert(1)>', nav: 2, type: 'buy' },
  ] });
  assertSafe(markup);
  assert.deepEqual(curve(markup), curve(renderNavChart(points)));
  assert.doesNotMatch(markup, /class="nav-trade|class="nav-chart-legend|2025-12-31|2026-01-12|<img|alert|onerror/);
  assert.deepEqual(tradeSummaries(markup), []);
});

test('single-point, flat and extremely close NAVs remain finite and usable', () => {
  for (const input of [[point('2026-01-01', 1.23)], [point('2026-01-01', 1.23), point('2026-01-02', 1.23)], [point('2026-01-01', 0.0000000001), point('2026-01-02', 0.0000000002)]]) {
    const markup = renderNavChart(input, { costNav: 0 });
    assertSafe(markup);
    assert.match(markup, /nav-chart-(?:point|curve)/);
  }
  const single = renderNavChart([point('2026-01-01', 1.23)], { markers: [{ date: '2026-01-01', nav: 1.2, type: 'buy' }] });
  assert.equal(markerPosition(single, 'buy')[0], 150);
  assert.match(single, /class="nav-chart-point" cx="150"/);
});

test('duplicate dates are safe and same-position trades aggregate without leaking identifiers', () => {
  const markup = renderNavChart([point('2026-01-01', 1.2), point('2026-01-01', 1.3)], { markers: [
    { id: 'first', date: '2026-01-01', nav: 1.25, type: 'buy' },
    { id: 'first', date: '2026-01-01', nav: 1.25, type: 'buy' },
    { id: 'second', date: '2026-01-01', nav: 1.25, type: 'buy', estimated: true },
    { id: '<img onerror=alert(1)>', date: '2026-01-01', nav: 1.25, type: 'sell' },
  ] });
  assertSafe(markup);
  assert.equal((markup.match(/class="nav-trade-marker nav-trade-buy/g) || []).length, 1);
  assert.equal((markup.match(/class="nav-trade-marker nav-trade-sell/g) || []).length, 1);
  assert.match(markup, /买入 · 2026-01-01 · 共2笔 · 含估算/);
  assert.match(markup, /1个已公布净值/);
  assert.doesNotMatch(markup, /first|second|<img|onerror|alert/);
});

test('bad points and cost inputs fail closed without unsafe interpolation', () => {
  for (const input of [undefined, null, {}, [], [null, {}, point('2026-02-30', 1), point('2026-01-01', NaN), point('2026-01-01', Infinity), point('2026-01-01', -1), point('2026-01-01', '1.2'), point('2026-01-01', 1e100), point('" onload="alert(1)', 1)]]) {
    assert.equal(renderNavChart(input, { costNav: 1, markers: [{ date: '2026-01-01', nav: 1.2, type: 'buy' }] }), '<p class="nav-chart-empty">该时段暂无净值数据</p>');
  }
  for (const costNav of [-1, NaN, Infinity, '1.2', 1e100]) {
    const markup = renderNavChart(points, { costNav, markers: null });
    assertSafe(markup);
    assert.doesNotMatch(markup, /nav-cost/);
  }
});

test('hover payload includes only public selected-date values and daily changes from the full reference history', () => {
  const referenceHistory = [point('2025-12-31', 1.6), ...points];
  const markup = renderNavChart(points.slice(1), { referenceHistory, costNav: 0.9134567, markers: [
    { id: 'private-identifier', date: '2026-01-02', nav: 1.8, type: 'buy', amount: 'private-amount', shares: 'private-shares', note: 'private-note' },
  ] });
  const payload = hoverPoints(markup);
  assert.match(markup, /tabindex="0" aria-label="净值图，使用左右方向键查看日期；电脑端可按回车选择区间起点或清空，Escape清除选点"/);
  assert.doesNotMatch(markup, /清除选点<\/button>|nav-measure-status|区间已固定/);
  assert.match(markup, /data-nav-points="\[\{&quot;date&quot;/);
  assert.deepEqual(payload.map(value => value.date), ['2026-01-02', '2026-01-11']);
  assert.ok(Math.abs(payload[0].change - (1.8 / 1.7 - 1)) < 1e-12, 'first selected day uses the actual preceding NAV');
  for (const value of payload) {
    assert.equal(Object.keys(value).sort().join(','), 'change,date,nav,x,y');
    assert.ok(value.x >= 0 && value.x <= 100 && value.y >= 0 && value.y <= 100);
  }
  assert.doesNotMatch(markup, /private-identifier|private-amount|private-shares|private-note|costNav/);
  for (const name of ['line', 'point', 'tooltip']) assert.match(markup, new RegExp(`class="nav-hover-${name}" hidden`));
  assert.equal(hoverPoints(renderNavChart([points[0]]))[0].change, null);
});

test('a dense six-month series uses compact clusters while retaining every original trade date', () => {
  const history = Array.from({ length: 180 }, (_, index) => point(new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10), 1.8 + index * 0.001 + Math.sin(index / 12) * 0.08));
  const markers = history.filter((_, index) => index % 3 === 0).map((entry, index) => ({ ...entry, type: 'buy', estimated: true, id: `not-for-output-${index}`, amount: 'hidden-amount', shares: 'hidden-shares', note: 'hidden-note' }));
  const markup = renderNavChart(history, { markers });
  const dots = (markup.match(/class="nav-trade-marker /g) || []).length;
  assert.ok(dots > 1 && dots <= 25, `dense trade dots are compact: ${dots}`);
  assert.ok(dots < markers.length);
  const summary = tradeSummaries(markup);
  assert.deepEqual(summary.map(trade => trade.date), markers.map(marker => marker.date));
  assert.equal(summary.reduce((total, trade) => total + trade.count, 0), markers.length);
  for (const trade of summary) {
    assert.equal(Object.keys(trade).sort().join(','), 'count,date,estimated,type');
    assert.equal(trade.estimated, true);
  }
  assert.match(markup, /is-cluster/);
  assert.match(markup, /买入 · \d{4}-\d{2}-\d{2}至\d{4}-\d{2}-\d{2} · 共\d+笔 · 含估算/);
  assert.doesNotMatch(markup, /not-for-output|hidden-amount|hidden-shares|hidden-note/);
});

test('daily counts preserve both directions and different execution NAVs without exposing prices', () => {
  const markup = renderNavChart(points, { markers: [
    { date: '2026-01-02', nav: 1.8, type: 'buy' },
    { date: '2026-01-02', nav: 1.81, type: 'buy', estimated: true },
    { date: '2026-01-02', nav: 1.8, type: 'sell' },
  ] });
  assert.deepEqual(tradeSummaries(markup), [
    { date: '2026-01-02', type: 'buy', count: 2, estimated: true },
    { date: '2026-01-02', type: 'sell', count: 1, estimated: false },
  ]);
  assert.equal((markup.match(/class="nav-trade-marker nav-trade-buy/g) || []).length, 1);
  assert.equal((markup.match(/class="nav-trade-marker nav-trade-sell/g) || []).length, 1);
  assert.match(markup, /class="nav-hover-trades" hidden/);
});

test('an extended date domain leaves the official curve on its real dates and marks the pending region', () => {
  const markup = renderNavChart(points, { domainEnd: '2026-01-15' });
  assertSafe(markup);
  const positions = curve(markup);
  assert.equal(positions[0][0], 8);
  assert.ok(Math.abs(positions.at(-1)[0] - (8 + 10 / 14 * 284)) < .0001);
  assert.ok(positions.at(-1)[0] < 292, 'the latest official observation does not move to today');
  assert.match(markup, /class="nav-chart-pending-region"/);
  assert.match(markup, /class="nav-chart-pending-label"[^>]*>待更新/);
  assert.match(markup, /class="nav-chart-domain-end" datetime="2026-01-15">截至 01-15/);
  assert.match(markup, /2026-01-01至2026-01-15，3个已公布净值/);
  assert.deepEqual(hoverPoints(markup).map(point => point.date), points.map(point => point.date));
  assert.doesNotMatch(markup, /nav-chart-estimated-curve|nav-chart-estimated-point/);
});

test('a recorded trade can appear in the pending date area without fabricating a public NAV observation', () => {
  const markers = [{ date: '2026-01-13', nav: 2, type: 'buy' }, { date: '2026-01-16', nav: 2, type: 'sell' }];
  const markup = renderNavChart(points, { domainEnd: '2026-01-15', markers });
  assert.ok(markerPosition(markup, 'buy'));
  assert.equal(markerPosition(markup, 'sell'), null);
  assert.deepEqual(hoverPoints(markup).map(point => point.date), points.map(point => point.date));
  assert.match(markup, /待更新/);
  assert.equal(markerPosition(renderNavChart(points, { markers }), 'buy'), null);
});

test('today is visibly labelled using the Beijing calendar without altering the plot height', () => {
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const markup = renderNavChart([point(yesterday, 1)], { domainEnd: today });
  assert.match(markup, new RegExp(`class="nav-chart-domain-end" datetime="${today}">今天 ${today.slice(5)}`));
  assert.match(markup, /viewBox="0 0 300 128"/);
});

test('historical and invalid domain endings preserve the previous chart geometry', () => {
  const original = renderNavChart(points);
  for (const domainEnd of [null, '2026-01-01', '2026-01-11', '2026-02-30', '<img onerror=alert(1)>']) {
    const markup = renderNavChart(points, { domainEnd });
    assert.deepEqual(curve(markup), curve(original));
    assert.doesNotMatch(markup, /nav-chart-pending|data-nav-domain=|nav-chart-domain-end|<img|onerror/);
  }
});

test('a single official NAV stays at its actual first-date coordinate when today extends the domain', () => {
  const markup = renderNavChart([point('2026-01-01', 1.2)], { domainEnd: '2026-01-03' });
  assertSafe(markup);
  assert.match(markup, /class="nav-chart-point" cx="8"/);
  assert.ok(Math.abs(hoverPoints(markup)[0].x - 8 / 300 * 100) < .0001);
  assert.doesNotMatch(markup, /class="nav-chart-curve"/);
  assert.match(renderNavChart([point('2026-01-01', 1.2)]), /class="nav-chart-point" cx="150"/);
});

test('estimated NAVs retain dashed extensions and whitelisted inspection fields without an estimated-only symbol', () => {
  const estimates = [
    { date: '2026-01-12', nav: 2.2, change: .03, estimated: true, amount: 'private-amount', note: 'private-note' },
    { date: '2026-01-13', nav: 2.3, estimated: true, shares: 'private-shares' },
  ];
  const original = structuredClone(estimates);
  const markup = renderNavChart(points, { domainEnd: '2026-01-13', estimatedPoints: estimates });
  assertSafe(markup);
  assert.deepEqual(estimates, original);
  assert.match(markup, /class="nav-chart-estimated-curve"[^>]*stroke-dasharray="4 4"/);
  assert.equal((markup.match(/class="nav-chart-estimated-point"/g) || []).length, 2);
  assert.match(markup, /<span class="nav-chart-estimated-point" style="left:[\d.]+%;top:[\d.]+%" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(markup.match(/<svg\b[\s\S]*?<\/svg>/)[0], /nav-chart-estimated-point/, 'forecast dots are outside the stretched SVG');
  assert.doesNotMatch(markup, /nav-chart-legend-estimate-price|估算净值/);
  const payload = hoverPoints(markup);
  assert.equal(payload.length, 5);
  assert.deepEqual(payload.filter(point => !point.estimated).map(point => point.date), points.map(point => point.date));
  assert.equal(payload[3].estimated, true);
  assert.equal(payload[3].change, .03);
  assert.ok(Math.abs(payload[4].change - (2.3 / 2.2 - 1)) < 1e-12);
  assert.equal(Object.keys(payload[3]).sort().join(','), 'change,date,estimated,nav,x,y');
  assert.doesNotMatch(markup, /private-amount|private-note|private-shares|data-amount|data-shares/);
});

test('manual NAVs add no text legend while the historical trade estimate legend is preserved', () => {
  const estimatedPoints = [{ date: '2026-01-12', nav: 2.2, estimated: true }];
  const plain = renderNavChart(points);
  assert.doesNotMatch(plain, /nav-chart-legend/);
  const forecast = renderNavChart(points, { domainEnd: '2026-01-12', estimatedPoints });
  assert.doesNotMatch(forecast, /nav-chart-legend|估算净值/);
  assert.doesNotMatch(forecast, /nav-chart-legend-estimated"/);
  const both = renderNavChart(points, { domainEnd: '2026-01-12', estimatedPoints, markers: [{ date: '2026-01-02', nav: 1.8, type: 'buy', estimated: true }] });
  assert.match(both, /class="nav-chart-legend-estimated">含估算成交<\/span>/);
  assert.doesNotMatch(both, /class="nav-trade-dot is-estimated"/);
  assert.doesNotMatch(both, /nav-chart-legend-estimate-price|估算净值/);
});

test('official observations always replace a same-day estimate and keep their published daily change', () => {
  const markup = renderNavChart(points, { domainEnd: '2026-01-12', estimatedPoints: [
    { date: '2026-01-11', nav: 99, change: 99, estimated: true },
    { date: '2026-01-12', nav: 2.2, estimated: true },
  ] });
  const payload = hoverPoints(markup);
  const official = payload.find(point => point.date === '2026-01-11');
  assert.equal(official.nav, 2.1);
  assert.equal(official.estimated, undefined);
  assert.ok(Math.abs(official.change - (2.1 / 1.8 - 1)) < 1e-12);
  assert.equal((markup.match(/class="nav-chart-estimated-point"/g) || []).length, 1);
  assert.match(markup, /4个净值/);
  assert.doesNotMatch(markup, /估算净值/);
});

test('an interior estimate has dashed connections on both sides without a solid shortcut', () => {
  const markup = renderNavChart([point('2026-01-01', 1), point('2026-01-03', 1.2), point('2026-01-04', 1.3)], {
    estimatedPoints: [{ date: '2026-01-02', nav: 1.1, estimated: true }],
  });
  const solid = curve(markup);
  assert.equal(solid.length, 2);
  assert.ok(Math.abs(solid[0][0] - (8 + 2 / 3 * 284)) < .0001, 'the solid segment begins at the next published point');
  assert.match(markup, /class="nav-chart-estimated-curve"/);
  const nextOfficial = hoverPoints(markup).find(point => point.date === '2026-01-03');
  assert.ok(Math.abs(nextOfficial.change - .2) < 1e-12, 'published changes do not use estimated observations');
});

test('estimates never create a chart without real history or escape the selected date domain', () => {
  const estimated = { date: '2026-01-12', nav: 2.2, estimated: true };
  assert.equal(renderNavChart([], { domainEnd: '2026-01-12', estimatedPoints: [estimated] }), '<p class="nav-chart-empty">该时段暂无净值数据</p>');
  const markup = renderNavChart(points, { estimatedPoints: [estimated, { date: '2025-12-31', nav: 1, estimated: true },
    { date: '2026-01-05', nav: 1.9, estimated: false }, { date: '<svg onload=alert(1)>', nav: 1, estimated: true },
    { date: '2026-01-06', nav: Infinity, estimated: true }] });
  assert.deepEqual(hoverPoints(markup).map(point => point.date), points.map(point => point.date));
  assert.doesNotMatch(markup, /nav-chart-estimated|<svg onload|2025-12-31|2026-01-12/);
});

test('a visible range of at most seven elapsed calendar days gives every NAV a lower-only resting guide', () => {
  const series = [point('2026-01-01', 1), point('2026-01-04', 1.1), point('2026-01-08', 1.04)];
  const markup = renderNavChart(series);
  const payload = hoverPoints(markup);
  const lines = [...markup.matchAll(/class="nav-chart-rest-line" data-date="([^"]+)" style="left:([\d.]+)%;top:([\d.]+)%;bottom:0" aria-hidden="true"/g)];
  const dots = [...markup.matchAll(/class="nav-chart-rest-point" data-date="([^"]+)" style="left:([\d.]+)%;top:([\d.]+)%" aria-hidden="true"/g)];
  assert.equal(lines.length, series.length);
  assert.equal(dots.length, series.length);
  for (let index = 0; index < payload.length; index += 1) {
    assert.deepEqual(lines[index].slice(1), [payload[index].date, String(payload[index].x), String(payload[index].y)]);
    assert.deepEqual(dots[index].slice(1), lines[index].slice(1));
    assert.ok(Number(lines[index][3]) > 0, 'the guide starts at the observation instead of the top of the chart');
  }
  assert.ok(markup.indexOf('class="nav-chart-rest-line"') > markup.indexOf('</svg>'), 'HTML guides and dots retain their shape at responsive aspect ratios');
  assert.match(markup, /class="nav-hover-line" hidden/);
  assertSafe(markup);
});

test('more than seven visible days omits resting guides even when the real observations span fewer days', () => {
  assert.doesNotMatch(renderNavChart(points), /nav-chart-rest-/);
  const series = [point('2026-01-01', 1), point('2026-01-03', 1.1)];
  const markup = renderNavChart(series, { domainEnd: '2026-01-09' });
  assert.doesNotMatch(markup, /nav-chart-rest-/);
  assert.match(markup, /nav-chart-pending-region/);
  assert.match(markup, /class="nav-hover-line" hidden/);
});

test('short-window resting guides include estimates and never extend to a pending date', () => {
  const series = [point('2026-01-01', 1), point('2026-01-02', 1.1)];
  const markup = renderNavChart(series, {
    domainEnd: '2026-01-06',
    estimatedPoints: [{ date: '2026-01-04', nav: 1.08, estimated: true, note: 'private-note' }],
  });
  const dates = [...markup.matchAll(/class="nav-chart-rest-line" data-date="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(dates, ['2026-01-01', '2026-01-02', '2026-01-04']);
  assert.equal((markup.match(/class="nav-chart-rest-point(?: is-estimated)?"/g) || []).length, 3);
  assert.match(markup, /class="nav-chart-rest-point is-estimated" data-date="2026-01-04"/);
  const estimate = hoverPoints(markup).at(-1);
  assert.match(markup, new RegExp(`class="nav-chart-rest-line" data-date="2026-01-04" style="left:${estimate.x}%;top:${estimate.y}%;bottom:0"`));
  assert.doesNotMatch(markup, /nav-chart-rest-(?:line|point)[^>]*data-date="2026-01-06"|private-note/);
  assert.match(markup, /nav-chart-estimated-curve/);
});

test('single observations and sanitized duplicates produce exactly one resting guide per valid date', () => {
  const single = renderNavChart([point('2026-01-01', 1)]);
  assert.match(single, /class="nav-chart-rest-line" data-date="2026-01-01" style="left:50%;top:[\d.]+%;bottom:0"/);
  const markup = renderNavChart([
    point('2026-01-02', 1.1), point('2026-01-01', 1), point('2026-01-02', 1.2),
    point('2026-01-03', Infinity), point('<img onerror=alert(1)>', 1),
  ]);
  assert.equal((markup.match(/class="nav-chart-rest-line"/g) || []).length, 2);
  assert.deepEqual(hoverPoints(markup).map(point => point.nav), [1, 1.2]);
  assert.doesNotMatch(markup, /<img|onerror/);
  assert.doesNotMatch(renderNavChart([]), /nav-chart-rest-/);
});

test('inline inspection exposes only NAV and change while keeping legacy metadata in a hidden container', () => {
  const markup = renderNavChart(points);
  assert.match(markup, /class="nav-hover-tooltip" hidden role="status" aria-live="polite"><strong class="nav-hover-value num" title="单位净值"><\/strong><span class="nav-hover-change num" title="当日涨跌"><\/span><span class="nav-hover-meta" hidden aria-hidden="true">/);
  for (const name of ['date', 'status', 'trades']) assert.match(markup, new RegExp(`class="nav-hover-${name}" hidden`));
  assert.equal(hoverPoints(markup).length, points.length);
  assert.deepEqual(tradeSummaries(markup), []);
});

test('a cost crossing splits the edge at its interpolated coordinate and preserves the observation payload', () => {
  const series = [point('2026-01-01', 1), point('2026-01-03', 3)];
  const original = structuredClone(series);
  const markup = renderNavChart(series, { costNav: 2 });
  const segments = coloredSegments(markup);
  assert.deepEqual(segments.map(segment => segment.color), ['negative', 'positive']);
  const scale = createNavScale([1, 3]);
  const crossingY = Number((12 + (1 - (2 - scale.lower) / (scale.upper - scale.lower)) * 104).toFixed(4));
  assert.deepEqual(segments[0].points.at(-1), [150, crossingY]);
  assert.deepEqual(segments[1].points[0], [150, crossingY]);
  assert.match(markup, /style="--nav-cost-y:[\d.]+%"/);
  assert.deepEqual(hoverPoints(markup).map(({ date, nav }) => ({ date, nav })), series);
  assert.deepEqual(series, original);
  assert.equal(hoverPoints(markup).length, 2, 'the rendering-only crossing is never a made-up NAV');
  for (const segment of segments) assert.match(segment.markup, new RegExp(`style="stroke:var\\(--${segment.color}\\)"`));
  assertSafe(markup);
});

test('descending edges cross correctly and adjacent same-side segments merge', () => {
  const markup = renderNavChart([
    point('2026-01-01', 4), point('2026-01-02', 3), point('2026-01-05', 1), point('2026-01-06', .8),
  ], { costNav: 2 });
  const segments = coloredSegments(markup);
  assert.deepEqual(segments.map(segment => segment.color), ['positive', 'negative']);
  assert.equal(segments[0].points.length, 3);
  assert.equal(segments[1].points.length, 3);
  assert.deepEqual(segments[0].points.at(-1), segments[1].points[0]);
  assert.ok(Math.abs(segments[0].points.at(-1)[0] - (8 + 2.5 / 5 * 284)) < .0001, 'crossing x interpolates across the actual three-day edge');
});

test('estimated edges retain dashed styling on both sides of every cost crossing', () => {
  const series = [point('2026-01-01', 1), point('2026-01-03', 1)];
  const markup = renderNavChart(series, {
    costNav: 2, estimatedPoints: [{ date: '2026-01-02', nav: 3, estimated: true }],
  });
  const segments = coloredSegments(markup);
  assert.deepEqual(segments.map(segment => segment.color), ['negative', 'positive', 'negative']);
  assert.equal(segments.length, 3);
  assert.equal(segments.every(segment => segment.estimated), true);
  for (const segment of segments) assert.match(segment.markup, /stroke-dasharray="4 4"/);
  assert.deepEqual(segments[0].points.at(-1), segments[1].points[0]);
  assert.deepEqual(segments[1].points.at(-1), segments[2].points[0]);
  assert.equal(hoverPoints(markup).length, 3);
  assert.match(markup, /class="nav-chart-estimated-point" style="left:[\d.]+%;top:[\d.]+%;--nav-point-color:var\(--positive\)"/);
});

test('cost-equal endpoints take the non-equal edge side and flat cost edges are red', () => {
  for (const [series, expected] of [
    [[point('2026-01-01', 2), point('2026-01-02', 1)], 'negative'],
    [[point('2026-01-01', 1), point('2026-01-02', 2)], 'negative'],
    [[point('2026-01-01', 2), point('2026-01-02', 3)], 'positive'],
    [[point('2026-01-01', 3), point('2026-01-02', 2)], 'positive'],
    [[point('2026-01-01', 2), point('2026-01-02', 2)], 'positive'],
  ]) {
    const segments = coloredSegments(renderNavChart(series, { costNav: 2 }));
    assert.equal(segments.length, 1);
    assert.equal(segments[0].color, expected);
    assert.equal(segments[0].points.length, 2);
  }
});

test('resting dots, estimates and isolated observations use the same above/below cost color', () => {
  const markup = renderNavChart([point('2026-01-01', 1), point('2026-01-02', 2)], {
    costNav: 2, domainEnd: '2026-01-03', estimatedPoints: [{ date: '2026-01-03', nav: 3, estimated: true }],
  });
  assert.match(markup, /class="nav-chart-rest-point" data-date="2026-01-01"[^>]*--nav-point-color:var\(--negative\)/);
  assert.match(markup, /class="nav-chart-rest-point" data-date="2026-01-02"[^>]*--nav-point-color:var\(--positive\)/);
  assert.match(markup, /class="nav-chart-rest-point is-estimated" data-date="2026-01-03"[^>]*--nav-point-color:var\(--positive\)/);
  assert.match(renderNavChart([point('2026-01-01', 1)], { costNav: 2 }), /class="nav-chart-point"[^>]*fill="var\(--negative\)"/);
  assert.match(renderNavChart([point('2026-01-01', 3)], { costNav: 2 }), /class="nav-chart-point"[^>]*fill="var\(--positive\)"/);
});

test('missing or invalid cost preserves fund color without cost coordinate or side data', () => {
  for (const costNav of [null, undefined, NaN, Infinity, -1, '2']) {
    const markup = renderNavChart(points, { costNav });
    assert.deepEqual(coloredSegments(markup).map(segment => segment.color), ['fund']);
    assert.doesNotMatch(markup, /--nav-cost-y|--nav-point-color|data-cost|data-nav-cost|costNav/);
  }
  const markup = renderNavChart(points, { costNav: 1.9134567 });
  assert.doesNotMatch(markup, /1\.9134567|data-cost|costNav/);
  for (const entry of hoverPoints(markup)) assert.equal(Object.keys(entry).sort().join(','), 'change,date,nav,x,y');
  assert.deepEqual(coloredSegments(renderNavChart(points, { costNav: 0 })).map(segment => segment.color), ['positive']);
});
