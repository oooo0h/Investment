// Synthetic date indexes only. No account data, NAV file, or workbook is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavSliderController, setupNavSliderInteractions } from '../src/nav-slider.js';

function frames() {
  let next = 0;
  const pending = new Map();
  const callbacks = [];
  return {
    pending, callbacks,
    request(callback) { const id = ++next; pending.set(id, callback); callbacks.push(callback); return id; },
    cancel(id) { pending.delete(id); },
    step(timestamp) {
      const running = [...pending.values()];
      pending.clear();
      for (const callback of running) callback(timestamp);
    },
  };
}

function harness() {
  const clock = frames();
  const updates = [];
  const controller = createNavSliderController({ onUpdate: update => updates.push(update), requestFrame: clock.request, cancelFrame: clock.cancel });
  return { clock, updates, controller, get latest() { return updates.at(-1); } };
}

const options = (overrides = {}) => ({ code: 'synthetic-fund', boundary: 'start', domain: { min: 50, max: 100 }, range: { start: 60, end: 100 }, fraction: 0.2, ...overrides });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, 'synthetic index matches');
const position = update => (update.values[update.boundary] - update.domain.min) / (update.domain.max - update.domain.min);

test('grabbing off the thumb center preserves its position and pointer movement keeps that offset', () => {
  const h = harness();
  h.controller.start(options({ fraction: 0.22 }));
  assert.equal(h.latest.values.start, 60);
  h.clock.step(0);
  assert.equal(h.latest.values.start, 60);
  h.controller.move(0.42);
  h.clock.step(16);
  close(position(h.latest), 0.4);
  close(h.latest.values.start, 70);
  assert.deepEqual(h.latest.range, { start: 70, end: 100 });
  h.controller.cancel();
});

test('holding at the left edge expands continuously while the thumb stays under the pointer', () => {
  const h = harness();
  h.controller.start(options());
  h.controller.move(0);
  h.clock.step(0);
  let previousMin = h.latest.domain.min;
  for (let timestamp = 16; timestamp <= 160; timestamp += 16) {
    h.clock.step(timestamp);
    assert.ok(h.latest.domain.min < previousMin);
    assert.ok(previousMin - h.latest.domain.min < 1, 'one frame makes a small progressive change');
    close(position(h.latest), 0);
    assert.equal(h.latest.values.end, 100);
    previousMin = h.latest.domain.min;
  }
  assert.ok(!Number.isInteger(h.latest.values.start), 'visual thumb retains a fractional index');
  assert.equal(h.latest.range.start, Math.round(h.latest.values.start));
  h.controller.cancel();
});

test('expansion speed increases smoothly deeper inside the left edge zone', () => {
  const run = fraction => {
    const h = harness();
    h.controller.start(options());
    h.controller.move(fraction);
    h.clock.step(0);
    h.clock.step(50);
    const result = h.latest.domain.min;
    h.controller.cancel();
    return result;
  };
  assert.ok(run(0) < run(0.06));
  assert.ok(run(0.06) < run(0.11));
  assert.equal(run(0.2), 50);
});

test('a delayed animation frame caps elapsed time instead of jumping through the history', () => {
  const run = timestamp => {
    const h = harness();
    h.controller.start(options());
    h.controller.move(0);
    h.clock.step(0);
    h.clock.step(timestamp);
    const result = h.latest.domain.min;
    h.controller.cancel();
    return result;
  };
  close(run(5000), run(50));
  assert.ok(run(5000) > 45);
});

test('moving right eases the domain inward without moving the thumb away from the pointer', () => {
  const h = harness();
  h.controller.start(options({ domain: { min: 0, max: 100 }, range: { start: 95, end: 100 }, fraction: 0.95 }));
  h.clock.step(0);
  h.clock.step(16);
  assert.ok(h.latest.domain.min > 0 && h.latest.domain.min < 10);
  close(position(h.latest), 0.95);
  const first = h.latest.domain.min;
  for (let timestamp = 32; timestamp <= 5000; timestamp += 16) h.clock.step(timestamp);
  assert.ok(h.latest.domain.min > first && h.latest.domain.min <= 89);
  assert.ok(h.latest.domain.max - h.latest.domain.min >= 11, 'at least twelve observations remain visible');
  close(position(h.latest), 0.95);
  h.controller.cancel();
});

test('expansion stops at the first historical index and both thumbs stay ordered', () => {
  const h = harness();
  h.controller.start(options({ domain: { min: 1, max: 100 }, range: { start: 1, end: 70 }, fraction: 0 }));
  h.clock.step(0);
  for (let timestamp = 50; timestamp <= 500; timestamp += 50) h.clock.step(timestamp);
  assert.equal(h.latest.domain.min, 0);
  assert.equal(h.latest.values.start, 0);
  h.controller.move(1);
  h.clock.step(550);
  assert.equal(h.latest.values.start, 70);
  assert.equal(h.latest.values.end, 70);
  h.controller.cancel();
});

test('the end thumb changes only its selected value and respects start and latest bounds', () => {
  const h = harness();
  h.controller.start(options({ boundary: 'end', range: { start: 60, end: 80 }, fraction: 0.6 }));
  h.controller.move(0);
  h.clock.step(0);
  h.clock.step(50);
  assert.deepEqual(h.latest.values, { start: 60, end: 60 });
  assert.equal(h.latest.domain.min, 50);
  h.controller.move(1);
  h.clock.step(100);
  assert.deepEqual(h.latest.values, { start: 60, end: 100 });
  assert.equal(h.latest.domain.min, 50);
  h.controller.cancel();
});

test('stop keeps the last fractional visual value, cancels animation, and ignores stale callbacks', () => {
  const h = harness();
  h.controller.start(options());
  h.controller.move(0);
  h.clock.step(0);
  h.clock.step(16);
  const before = h.latest;
  const stale = h.clock.callbacks.at(-1);
  const stopped = h.controller.stop();
  assert.deepEqual(stopped, before);
  assert.ok(!Number.isInteger(stopped.values.start));
  assert.equal(h.clock.pending.size, 0);
  const count = h.updates.length;
  stale(1000);
  h.controller.move(0.5);
  h.clock.step(2000);
  assert.equal(h.updates.length, count);
});

test('cancel and restart isolate animation generations without delivering old updates', () => {
  const h = harness();
  h.controller.start(options());
  const stale = h.clock.callbacks.at(-1);
  h.controller.cancel();
  h.controller.start(options({ code: 'synthetic-new', range: { start: 70, end: 100 }, fraction: 0.4 }));
  const count = h.updates.length;
  stale(5000);
  assert.equal(h.updates.length, count);
  h.clock.step(0);
  assert.equal(h.latest.code, 'synthetic-new');
  assert.equal(h.latest.values.start, 70);
  h.controller.cancel();
});

test('keyboard controls step through integer observations and honor complete-history bounds', () => {
  const h = harness();
  const cases = [
    { boundary: 'start', key: 'ArrowLeft', expected: 59 },
    { boundary: 'start', key: 'ArrowRight', expected: 61 },
    { boundary: 'start', key: 'ArrowDown', expected: 59 },
    { boundary: 'start', key: 'ArrowUp', expected: 61 },
    { boundary: 'start', key: 'PageDown', expected: 50 },
    { boundary: 'start', key: 'PageUp', expected: 70 },
    { boundary: 'start', key: 'Home', expected: 0 },
    { boundary: 'start', key: 'End', expected: 80 },
    { boundary: 'end', key: 'Home', expected: 60 },
    { boundary: 'end', key: 'End', expected: 100 },
    { boundary: 'end', key: 'PageDown', expected: 70 },
    { boundary: 'end', key: 'PageUp', expected: 90 },
  ];
  for (const { boundary, key, expected } of cases) {
    const result = h.controller.key(options({ boundary, key, range: { start: 60, end: 80 } }));
    assert.equal(result.range[boundary], expected);
    assert.ok(result.range.start <= result.range.end);
    assert.ok(result.domain.min <= result.values.start);
  }
  assert.equal(h.controller.key(options({ key: 'Tab' })), null);
  assert.equal(h.clock.pending.size, 0);
});

function domHarness() {
  const clock = frames();
  const listeners = new Map();
  let connected = true;
  const updates = [];
  const captured = [];
  const released = [];
  let focused = 0;
  const slider = { querySelector: selector => selector.includes('"start"') ? inputs.start : selector.includes('"end"') ? inputs.end : null };
  const input = boundary => ({
    dataset: { navBoundary: boundary, fund: 'synthetic-fund' }, min: '50', max: '100', value: boundary === 'start' ? '60' : '100',
    disabled: false,
    closest: selector => selector === '.nav-range-slider' ? slider : selector === '[data-nav-boundary]' ? inputs[boundary] : null,
    getBoundingClientRect: () => ({ left: 0, right: 222, width: 222 }),
    setPointerCapture(id) { captured.push(id); },
    releasePointerCapture(id) { released.push(id); },
    focus() { focused += 1; },
  });
  const inputs = { start: input('start'), end: input('end') };
  const root = {
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name, handler) { if (listeners.get(name) === handler) listeners.delete(name); },
    contains(node) { return connected && Object.values(inputs).includes(node); },
  };
  const handle = setupNavSliderInteractions(root, {
    requestFrame: clock.request, cancelFrame: clock.cancel,
    onUpdate(update) {
      updates.push(update);
      for (const boundary of ['start', 'end']) {
        inputs[boundary].min = String(update.domain.min);
        inputs[boundary].max = String(update.domain.max);
        inputs[boundary].value = String(update.values[boundary]);
      }
    },
  });
  function dispatch(name, overrides = {}) {
    let prevented = false;
    const event = { target: inputs.start, pointerId: 1, isPrimary: true, button: 0, clientX: 51,
      preventDefault() { prevented = true; }, ...overrides };
    listeners.get(name)?.(event);
    return prevented;
  }
  return { clock, listeners, inputs, updates, captured, released, handle, dispatch,
    replace() { connected = false; }, get focused() { return focused; }, get latest() { return updates.at(-1); } };
}

test('delegated pointer dragging captures the pointer, uses inset rail coordinates, and releases without snapping', () => {
  const h = domHarness();
  assert.equal(h.dispatch('pointerdown', { clientX: 55 }), true);
  assert.deepEqual(h.captured, [1]);
  assert.equal(h.focused, 1);
  assert.equal(h.latest.values.start, 60);
  h.dispatch('pointermove', { clientX: 15 });
  h.clock.step(0);
  h.clock.step(16);
  close(position(h.latest), 0);
  const visual = h.latest.values.start;
  h.dispatch('pointerup', { clientX: 15 });
  close(h.latest.values.start, visual);
  assert.deepEqual(h.released, [1]);
  assert.equal(h.clock.pending.size, 0);
  h.handle.destroy();
});

test('unrelated pointers, disabled inputs, and non-primary presses do not change the active range', () => {
  const h = domHarness();
  h.inputs.start.disabled = true;
  assert.equal(h.dispatch('pointerdown'), false);
  h.inputs.start.disabled = false;
  assert.equal(h.dispatch('pointerdown', { isPrimary: false }), false);
  assert.equal(h.dispatch('pointerdown', { button: 2 }), false);
  h.dispatch('pointerdown');
  const count = h.updates.length;
  h.dispatch('pointermove', { pointerId: 2, clientX: 11 });
  h.dispatch('pointerup', { pointerId: 2, clientX: 11 });
  assert.equal(h.updates.length, count);
  h.dispatch('pointercancel');
  assert.deepEqual(h.released, [1]);
  assert.equal(h.clock.pending.size, 0);
  h.handle.destroy();
});

test('delegated keyboard controls prevent native stepping and keep unrelated keys available', () => {
  const h = domHarness();
  assert.equal(h.dispatch('keydown', { key: 'ArrowLeft' }), true);
  assert.equal(h.latest.range.start, 59);
  assert.equal(h.dispatch('keydown', { key: 'Home' }), true);
  assert.equal(h.latest.range.start, 0);
  assert.equal(h.latest.domain.min, 0);
  assert.equal(h.dispatch('keydown', { target: h.inputs.end, key: 'End' }), true);
  assert.equal(h.latest.range.end, 100);
  assert.equal(h.dispatch('keydown', { key: 'Tab' }), false);
  assert.equal(h.clock.pending.size, 0);
  h.handle.destroy();
});

test('replacing the range element cancels pending animation and releases pointer capture', () => {
  const h = domHarness();
  h.dispatch('pointerdown');
  h.dispatch('pointermove', { clientX: 11 });
  const count = h.updates.length;
  h.replace();
  h.clock.step(0);
  assert.equal(h.updates.length, count);
  assert.deepEqual(h.released, [1]);
  assert.equal(h.clock.pending.size, 0);
  h.handle.destroy();
});

test('wheel pans the selected interval while preserving its width', () => {
  const h = domHarness();
  h.inputs.end.value = '90';
  assert.equal(h.dispatch('wheel', { deltaY: 100 }), true);
  assert.deepEqual(h.latest.range, { start: 61, end: 91 });
  assert.deepEqual(h.latest.domain, { min: 50, max: 100 });
  h.dispatch('wheel', { deltaY: -100 });
  assert.deepEqual(h.latest.range, { start: 60, end: 90 });
  h.dispatch('wheel', { deltaY: 100, shiftKey: true });
  assert.deepEqual(h.latest.range, { start: 65, end: 95 });
  assert.equal(h.handle.cancel(), undefined);
});

test('cancel stops an active drag and destroy removes every listener exactly once', () => {
  const h = domHarness();
  h.dispatch('pointerdown');
  const stale = h.clock.callbacks.at(-1);
  h.handle.cancel();
  const count = h.updates.length;
  stale(1000);
  assert.equal(h.updates.length, count);
  assert.deepEqual(h.released, [1]);
  assert.equal(h.clock.pending.size, 0);
  assert.equal(h.listeners.size, 7);
  h.handle.destroy();
  h.handle.destroy();
  assert.equal(h.listeners.size, 0);
});

test('Node setup works without browser window or animation-frame globals', () => {
  const listeners = new Map();
  const root = {
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const handle = setupNavSliderInteractions(root);
  assert.equal(listeners.size, 7);
  handle.cancel();
  handle.destroy();
  assert.equal(listeners.size, 0);
  const controller = createNavSliderController();
  controller.start(options());
  controller.cancel();
});
