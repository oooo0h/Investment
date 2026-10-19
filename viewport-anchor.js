// Preserve the section being read rather than an absolute document scroll value.
// offsetTop/offsetHeight deliberately ignore entrance and hover transforms.
const ANCHORS = [
  '.fund-page > .page-heading',
  '[data-panel="fund-basics"]',
  '[data-panel="nav-quotes"]',
  '[data-panel="nav-quotes"] > summary',
  '[data-panel="nav-quotes"] .nav-value',
  '[data-panel="nav-quotes"] [data-nav-chart]',
  '[data-panel="nav-quotes"] .nav-periods',
  '[data-panel="nav-quotes"] .nav-sliders',
  '[data-panel="holdings"]',
  '[data-panel="transactions"]',
];

function layoutBox(element) {
  if (!element || !element.offsetHeight || !element.offsetWidth) return null;
  let top = 0;
  for (let parent = element; parent; parent = parent.offsetParent) top += parent.offsetTop || 0;
  return { top, height: element.offsetHeight, bottom: top + element.offsetHeight };
}

export function captureFundViewport(root, view = globalThis.window) {
  if (!root?.querySelector('.fund-page')) return null;
  const scroll = view.scrollY || 0;
  if (scroll <= 1) return { scroll: 0 };
  const header = root.querySelector('.site-header')?.getBoundingClientRect();
  const readingLine = scroll + Math.max(0, header?.bottom || 0) + 16;
  const candidates = ANCHORS.flatMap(selector => {
    const element = root.querySelector(selector), box = layoutBox(element);
    return box ? [{ selector, element, ...box }] : [];
  });
  // A tiny tail of the preceding panel can remain below a sticky header.
  // Keep a substantive panel at the reading line, or the main visible panel.
  const visibleHeight = box => Math.max(0, Math.min(box.bottom, scroll + view.innerHeight) - Math.max(box.top, readingLine));
  const panels = candidates.filter(box => box.element.dataset?.panel);
  const atReadingLine = panels.find(box => box.top <= readingLine && box.bottom > readingLine && visibleHeight(box) >= Math.min(120, view.innerHeight * .2));
  const mainPanel = atReadingLine || panels.sort((a, b) => visibleHeight(b) - visibleHeight(a))[0];
  const readingCandidates = mainPanel && visibleHeight(mainPanel) > 0
    ? candidates.filter(box => box.element === mainPanel.element || box.element.closest?.('[data-panel]') === mainPanel.element)
    : candidates;
  const containing = readingCandidates.filter(box => box.top <= readingLine && box.bottom > readingLine);
  const nearest = containing.length
    ? containing.sort((a, b) => b.top - a.top || a.height - b.height)[0]
    : readingCandidates.filter(box => box.bottom > scroll && box.top < scroll + view.innerHeight)
      .sort((a, b) => Math.abs(a.top - readingLine) - Math.abs(b.top - readingLine))[0];
  if (!nearest) return { scroll };
  const panel = nearest.element.closest?.('[data-panel]');
  const panelBox = layoutBox(panel);
  return {
    scroll, selector: nearest.selector, offset: nearest.top - scroll,
    ...(panelBox ? { fallback: `[data-panel="${panel.dataset.panel}"]`, fallbackOffset: panelBox.top - scroll } : {}),
  };
}

export function restoreFundViewport(root, snapshot, view = globalThis.window) {
  if (!snapshot) return;
  const anchor = snapshot.selector && layoutBox(root.querySelector(snapshot.selector));
  const fallback = !anchor && snapshot.fallback && layoutBox(root.querySelector(snapshot.fallback));
  const top = anchor ? anchor.top - snapshot.offset
    : fallback ? fallback.top - snapshot.fallbackOffset : snapshot.scroll;
  view.scrollTo({ top: Math.max(0, top || 0), behavior: 'instant' });
}

export function createFundViewportKeeper({ root, view = globalThis.window } = {}) {
  let cancelPending = () => {};
  const cancel = () => { cancelPending(); cancelPending = () => {}; };
  const onUserInput = event => {
    if (event.type !== 'keydown' || ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Tab', 'Escape'].includes(event.key)) cancel();
  };
  const inputEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
  for (const type of inputEvents) view.addEventListener(type, onUserInput, { capture: true, passive: true });
  return {
    capture: () => captureFundViewport(root, view),
    cancel,
    restore(snapshot, { isCurrent = () => true } = {}) {
      cancel();
      if (!snapshot) return;
      let active = true, frame = null, observer = null, expiry = null, initialFrames = 2;
      const apply = () => {
        if (!active || !isCurrent()) { cancel(); return; }
        restoreFundViewport(root, snapshot, view);
      };
      const schedule = () => {
        if (!active || frame !== null) return;
        frame = view.requestAnimationFrame(() => {
          frame = null;
          apply();
          if (active && --initialFrames > 0) schedule();
        });
      };
      cancelPending = () => {
        active = false;
        if (frame !== null) view.cancelAnimationFrame(frame);
        if (expiry !== null) view.clearTimeout(expiry);
        observer?.disconnect();
      };
      apply();
      schedule();
      if (view.ResizeObserver) {
        observer = new view.ResizeObserver(schedule);
        root.querySelectorAll('.fund-page, .fund-page > *, .fund-layout > *').forEach(element => observer.observe(element));
      }
      // Correct deferred fonts/layout without fighting any subsequent manual scroll.
      root.ownerDocument?.fonts?.ready?.then(schedule, () => {});
      expiry = view.setTimeout(cancel, 1500);
    },
    destroy() {
      cancel();
      for (const type of inputEvents) view.removeEventListener(type, onUserInput, { capture: true });
    },
  };
}
