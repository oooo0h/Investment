import test from 'node:test';
import assert from 'node:assert/strict';
import { captureFundViewport, restoreFundViewport, createFundViewportKeeper } from '../src/viewport-anchor.js';

function fixture() {
  const elements = new Map(), listeners = new Map(), frames = new Map(), timers = new Map(), observers = [];
  let sequence = 0;
  const view = {
    scrollY: 900, innerHeight: 844, scrollTo({ top }) { this.scrollY = top; },
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type, callback) { if (listeners.get(type) === callback) listeners.delete(type); },
    requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback) { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.active = true; observers.push(this); }
      observe() {}
      disconnect() { this.active = false; }
    },
  };
  const root = { querySelector: selector => elements.get(selector) || null, querySelectorAll: () => [...elements.values()] };
  const element = (selector, top, height, panel = null) => {
    const item = { offsetTop: top, offsetHeight: height, offsetWidth: 500, dataset: {}, closest: () => panel, getBoundingClientRect: () => ({ top: top - view.scrollY + 24, bottom: top - view.scrollY + height + 24 }) };
    elements.set(selector, item);
    return item;
  };
  element('.fund-page', 0, 2500);
  elements.set('.site-header', { getBoundingClientRect: () => ({ bottom: 90 }) });
  const panel = element('[data-panel="nav-quotes"]', 1000, 700);
  panel.dataset.panel = 'nav-quotes';
  panel.closest = () => panel;
  element('[data-panel="nav-quotes"] > summary', 1020, 28, panel);
  element('[data-panel="nav-quotes"] .nav-value', 1060, 40, panel);
  const chart = element('[data-panel="nav-quotes"] [data-nav-chart]', 1130, 320, panel);
  const flush = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback()); };
  return { root, view, elements, panel, chart, frames, timers, listeners, observers, flush };
}

test('a fund switch preserves the public NAV panel instead of absolute document Y', () => {
  const { root, view, panel } = fixture();
  const snapshot = captureFundViewport(root, view);
  assert.equal(snapshot.selector, '[data-panel="nav-quotes"]');
  panel.offsetTop += 240;
  restoreFundViewport(root, snapshot, view);
  assert.equal(view.scrollY, 1140);
  assert.equal(panel.offsetTop - view.scrollY, 100);
});

test('the reading anchor follows the viewport top without reserving space for the scrolling toolbar', () => {
  const { root, view, elements } = fixture();
  view.scrollY = 1030;
  elements.set('.site-header', { getBoundingClientRect: () => ({ bottom: 500 }) });
  const snapshot = captureFundViewport(root, view);
  assert.equal(snapshot.selector, '[data-panel="nav-quotes"] > summary');
  assert.equal(snapshot.offset, -10);
});

test('reading inside the chart preserves that chart despite changes within and above its panel', () => {
  const { root, view, chart, panel } = fixture();
  view.scrollY = 1150;
  const snapshot = captureFundViewport(root, view);
  assert.equal(snapshot.selector, '[data-panel="nav-quotes"] [data-nav-chart]');
  panel.offsetTop += 200;
  chart.offsetTop += 240;
  restoreFundViewport(root, snapshot, view);
  assert.equal(chart.offsetTop - view.scrollY, -20);
});

test('entrance transforms do not affect the stored layout coordinate', () => {
  const { root, view } = fixture();
  const snapshot = captureFundViewport(root, view);
  assert.equal(snapshot.offset, 100);
  assert.notEqual(snapshot.offset, root.querySelector(snapshot.selector).getBoundingClientRect().top);
});

test('a small tail of basic information does not displace the public NAV reading anchor', () => {
  const { root, view, elements, panel } = fixture();
  panel.offsetTop = 1030;
  elements.get('[data-panel="nav-quotes"] > summary').offsetTop = 1050;
  elements.get('[data-panel="nav-quotes"] .nav-value').offsetTop = 1090;
  elements.get('[data-panel="nav-quotes"] [data-nav-chart]').offsetTop = 1160;
  const basics = { offsetTop: 600, offsetHeight: 420, offsetWidth: 500, dataset: { panel: 'fund-basics' } };
  basics.closest = () => basics;
  elements.set('[data-panel="fund-basics"]', basics);
  assert.equal(captureFundViewport(root, view).selector, '[data-panel="nav-quotes"]');
});

test('a graph being read stays the anchor even when a larger holdings panel is visible below it', () => {
  const { root, view, elements, panel } = fixture();
  view.scrollY = 1150;
  panel.offsetHeight = 470;
  const holdings = { offsetTop: 1470, offsetHeight: 1000, offsetWidth: 500, dataset: { panel: 'holdings' } };
  holdings.closest = () => holdings;
  elements.set('[data-panel="holdings"]', holdings);
  assert.equal(captureFundViewport(root, view).selector, '[data-panel="nav-quotes"] [data-nav-chart]');
});

test('nested positioned ancestors contribute to the document layout coordinate', () => {
  const { root, view, panel } = fixture();
  panel.offsetTop = 200;
  panel.offsetParent = { offsetTop: 800, offsetParent: null };
  const snapshot = captureFundViewport(root, view);
  assert.equal(snapshot.offset, 100);
  panel.offsetParent.offsetTop += 150;
  restoreFundViewport(root, snapshot, view);
  assert.equal(view.scrollY, 1050);
});

test('a missing or hidden chart falls back to the same panel position', () => {
  for (const hidden of [false, true]) {
    const { root, view, chart, panel, elements } = fixture();
    view.scrollY = 1150;
    const snapshot = captureFundViewport(root, view);
    if (hidden) chart.offsetHeight = 0;
    else elements.delete('[data-panel="nav-quotes"] [data-nav-chart]');
    panel.offsetTop += 160;
    restoreFundViewport(root, snapshot, view);
    assert.equal(view.scrollY, 1310);
  }
});

test('the top of a fund stays at the top and pages without a fund are not captured', () => {
  const { root, view, elements } = fixture();
  view.scrollY = 0;
  assert.deepEqual(captureFundViewport(root, view), { scroll: 0 });
  elements.delete('.fund-page');
  assert.equal(captureFundViewport(root, view), null);
});

test('a missing semantic section uses the prior position and never produces negative scroll', () => {
  const { root, view } = fixture();
  restoreFundViewport(root, { selector: '.missing', scroll: 420 }, view);
  assert.equal(view.scrollY, 420);
  restoreFundViewport(root, { selector: '[data-panel="nav-quotes"]', offset: 1400 }, view);
  assert.equal(view.scrollY, 0);
});

test('deferred layout changes restore the same reading position after a fund switch', () => {
  const { root, view, panel, flush, observers } = fixture();
  const keeper = createFundViewportKeeper({ root, view });
  keeper.restore(keeper.capture());
  panel.offsetTop += 180;
  observers[0].callback();
  flush();
  assert.equal(view.scrollY, 1080);
  // A second asynchronous content pass is also corrected without a new route.
  panel.offsetTop += 70;
  observers[0].callback();
  flush();
  assert.equal(view.scrollY, 1150);
  keeper.destroy();
});

test('wheel, touch, pointer and scroll keys cancel correction immediately', () => {
  for (const [type, event] of [['wheel', {}], ['touchstart', {}], ['pointerdown', {}], ['keydown', { key: 'PageDown' }]]) {
    const { root, view, panel, flush, listeners, observers } = fixture();
    const keeper = createFundViewportKeeper({ root, view });
    keeper.restore(keeper.capture());
    listeners.get(type)({ type, ...event });
    view.scrollY = 960;
    panel.offsetTop += 180;
    observers[0].callback();
    flush();
    assert.equal(view.scrollY, 960, type);
    assert.equal(observers[0].active, false, type);
    keeper.destroy();
  }
});

test('a stale route and a later restore both cancel obsolete correction work', () => {
  const { root, view, panel, flush, observers } = fixture();
  const keeper = createFundViewportKeeper({ root, view });
  let current = true;
  keeper.restore(keeper.capture(), { isCurrent: () => current });
  current = false;
  panel.offsetTop += 80;
  flush();
  assert.equal(view.scrollY, 900);
  assert.equal(observers[0].active, false);
  keeper.restore(keeper.capture());
  keeper.restore({ scroll: 0 });
  flush();
  assert.equal(view.scrollY, 0);
  assert.equal(observers[1].active, false);
  keeper.destroy();
});

test('correction expires and destroying the keeper removes input listeners', () => {
  const { root, view, timers, listeners, frames, observers } = fixture();
  const keeper = createFundViewportKeeper({ root, view });
  keeper.restore(keeper.capture());
  [...timers.values()][0]();
  assert.equal(frames.size, 0);
  assert.equal(observers[0].active, false);
  keeper.destroy();
  assert.equal(listeners.size, 0);
});
