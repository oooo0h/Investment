import test from 'node:test';
import assert from 'node:assert/strict';
import { createEdgeNavigation } from '../src/edge-navigation.js';

function fixture({ width = 1000, left = 200, right = 800, fine = true, pointerEvents = true } = {}) {
  const events = new Map(), timers = new Map(), mediaEvents = new Map(), classes = new Set();
  let serial = 0, present = true;
  const properties = new Map(), windowEvents = new Map();
  const html = { dataset: {}, style: { setProperty: (name, value) => properties.set(name, value), removeProperty: name => properties.delete(name) }, classList: { toggle(name, value) { if (value) classes.add(name); else classes.delete(name); }, remove: name => classes.delete(name) } };
  const media = { matches: fine, addEventListener: (name, callback) => mediaEvents.set(name, callback), removeEventListener: name => mediaEvents.delete(name) };
  const document = { documentElement: html, activeElement: null, addEventListener: (name, callback) => events.set(name, callback), removeEventListener: name => events.delete(name) };
  const header = { inert: false, contains: target => target === header, getBoundingClientRect: () => ({ left: 16, right: 172, top: 100, bottom: 600 }) };
  const view = { innerWidth: width, PointerEvent: pointerEvents ? function() {} : undefined, addEventListener: (name, callback) => windowEvents.set(name, callback), removeEventListener: name => windowEvents.delete(name), matchMedia: () => media, setTimeout: (callback, delay) => { const id = ++serial; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id) };
  const controller = createEdgeNavigation({ root: { ownerDocument: document, querySelector: selector => selector === 'main.workspace' ? { getBoundingClientRect: () => ({ left, right }) } : present ? header : null }, view });
  return { controller, html, header, document, events, timers, media, mediaEvents, classes, properties, view, windowEvents,
    present: value => { present = value; controller.sync(); },
    move: (x, y = 300) => events.get(pointerEvents ? 'pointermove' : 'mousemove')({ clientX: x, clientY: y, pointerType: pointerEvents ? 'mouse' : undefined }),
    flush: () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } } };
}

test('desktop menu is visible by default and fades only while changing sides', () => {
  const h = fixture(); assert.equal(h.html.dataset.edgeNavOpen, 'true'); assert.equal(h.header.inert, false);
  h.move(5); assert.equal(h.html.dataset.edgeNavSide, 'left'); assert.equal(h.html.dataset.edgeNavOpen, 'true');
  h.move(995); assert.equal(h.html.dataset.edgeNavOpen, 'false');
  h.move(994); assert.equal(h.html.dataset.edgeNavOpen, 'false');
  h.flush(); assert.equal(h.html.dataset.edgeNavSide, 'right'); assert.equal(h.html.dataset.edgeNavOpen, 'true');
  h.move(500); h.flush(); assert.equal(h.html.dataset.edgeNavOpen, 'true'); assert.equal(h.html.dataset.edgeNavSide, 'right');
  h.controller.destroy(); assert.equal(h.header.inert, false); assert.equal(h.events.size, 0);
});

test('menu stays visible over content and through rerenders; mobile and locked screens retain their own navigation', () => {
  const h = fixture(); h.move(5); h.move(100); h.flush(); assert.equal(h.html.dataset.edgeNavOpen, 'true');
  h.document.activeElement = h.header; h.move(500); h.flush(); assert.equal(h.html.dataset.edgeNavOpen, 'true');
  h.document.activeElement = null; h.move(500); h.flush(); assert.equal(h.html.dataset.edgeNavOpen, 'true');
  h.controller.sync(); assert.equal(h.html.dataset.edgeNavOpen, 'true'); assert.equal(h.header.inert, false);
  h.present(false); assert.equal(h.classes.has('edge-nav-enabled'), false);
  h.present(true); h.view.innerWidth = 390; h.media.matches = false; h.mediaEvents.get('change')();
  assert.equal(h.classes.has('edge-nav-enabled'), false); assert.equal(h.header.inert, false);
  h.controller.destroy(); assert.equal(h.timers.size, 0);
});

test('wide screen gutters reveal menus beside the content without reaching the viewport edge', () => {
  const h = fixture({ width: 2552, left: 638, right: 1914 });
  h.move(550); assert.equal(h.html.dataset.edgeNavOpen, 'true'); assert.equal(h.html.dataset.edgeNavSide, 'left');
  assert.equal(h.properties.get('--edge-nav-left'), '462px');
  h.move(2000); h.flush();
  assert.equal(h.html.dataset.edgeNavOpen, 'true'); assert.equal(h.html.dataset.edgeNavSide, 'right');
  assert.equal(h.properties.get('--edge-nav-right'), '462px');
  h.move(1200); h.flush(); assert.equal(h.html.dataset.edgeNavOpen, 'true'); assert.equal(h.html.dataset.edgeNavSide, 'right');
  h.controller.destroy(); assert.equal(h.properties.size, 0); assert.equal(h.windowEvents.size, 0);
});

test('mouse input without PointerEvent support still switches the always-visible menu', () => {
  for (const pointerEvents of [true, false]) {
    const h = fixture({ pointerEvents });
    assert.equal(h.html.dataset.edgeNavOpen, 'true');
    h.move(850); h.move(500); h.flush();
    assert.equal(h.classes.has('edge-nav-enabled'), true); assert.equal(h.html.dataset.edgeNavOpen, 'true');
    assert.equal(h.html.dataset.edgeNavSide, 'right');
    h.controller.destroy();
  }
});

test('touch input does not switch the menu to another side', () => {
  const h = fixture();
  h.events.get('pointermove')({ clientX: 995, clientY: 300, pointerType: 'touch' });
  assert.equal(h.html.dataset.edgeNavSide, 'left'); assert.equal(h.html.dataset.edgeNavOpen, 'true');
  h.controller.destroy();
});
