const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const keyboardKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

function defaultRequestFrame(callback) {
  if (typeof globalThis.requestAnimationFrame === 'function') return globalThis.requestAnimationFrame(callback);
  const timer = setTimeout(() => callback(globalThis.performance?.now?.() ?? Date.now()), 16);
  timer?.unref?.();
  return timer;
}

function defaultCancelFrame(handle) {
  if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

export function createNavSliderController({ onUpdate = () => {}, requestFrame = defaultRequestFrame, cancelFrame = defaultCancelFrame } = {}) {
  let current = null;
  let frame = null;

  function normalize({ code, boundary, domain = {}, range = {} }) {
    if (boundary !== 'start' && boundary !== 'end') return null;
    const max = Math.max(0, Math.floor(finite(domain.max)));
    const start = clamp(finite(range.start), 0, max);
    const end = clamp(finite(range.end, max), start, max);
    return { code, boundary, domain: { min: clamp(finite(domain.min), 0, start), max }, values: { start, end } };
  }

  function snapshot(state) {
    return {
      code: state.code, boundary: state.boundary, domain: { ...state.domain }, values: { ...state.values },
      range: { start: Math.round(state.values.start), end: Math.round(state.values.end) },
    };
  }

  function project(state) {
    const { min, max } = state.domain;
    const value = min + state.position * (max - min);
    state.values[state.boundary] = state.boundary === 'start'
      ? clamp(value, min, state.values.end) : clamp(value, state.values.start, max);
  }

  function advance(state, elapsed) {
    project(state);
    if (state.boundary !== 'start' || elapsed <= 0) return;
    const { min, max } = state.domain;
    const span = max - min;
    if (span <= 0) return;
    if (state.position <= 0.12 && min > 0) {
      const depth = 1 - state.position / 0.12;
      state.domain.min = Math.max(0, min - span * 0.7 * depth * depth * elapsed / 1000);
    } else if (state.position >= 0.35) {
      const selectedSpan = state.values.end - state.values.start;
      const target = Math.max(0, Math.min(state.values.start, max - Math.max(11, selectedSpan * 3)));
      if (target > min) state.domain.min = min + (target - min) * (1 - Math.exp(-elapsed / 220));
    }
    project(state);
  }

  function schedule(state) {
    frame = requestFrame(timestamp => {
      if (current !== state) return;
      frame = null;
      const now = finite(timestamp, state.timestamp ?? 0);
      const elapsed = state.timestamp === null ? 0 : clamp(now - state.timestamp, 0, 50);
      state.timestamp = now;
      advance(state, elapsed);
      onUpdate(snapshot(state));
      if (current === state) schedule(state);
    });
  }

  function cancel() {
    current = null;
    if (frame !== null) cancelFrame(frame);
    frame = null;
  }

  function start(options) {
    cancel();
    const state = normalize(options);
    if (!state) return null;
    const span = state.domain.max - state.domain.min;
    const actual = span ? (state.values[state.boundary] - state.domain.min) / span : 0;
    const pointer = clamp(finite(options.fraction, actual), 0, 1);
    state.grabOffset = pointer - actual;
    state.position = actual;
    state.timestamp = null;
    current = state;
    const result = snapshot(state);
    onUpdate(result);
    if (current === state) schedule(state);
    return result;
  }

  function move(fraction) {
    if (!current) return;
    current.position = clamp(finite(fraction) - current.grabOffset, 0, 1);
  }

  function stop() {
    const state = current;
    if (!state) return null;
    project(state);
    const result = snapshot(state);
    cancel();
    onUpdate(result);
    return result;
  }

  function key(options) {
    if (!keyboardKeys.has(options.key)) return null;
    cancel();
    const state = normalize(options);
    if (!state) return null;
    const boundary = state.boundary;
    const value = Math.round(state.values[boundary]);
    let next = value;
    if (['ArrowLeft', 'ArrowDown'].includes(options.key)) next -= 1;
    if (['ArrowRight', 'ArrowUp'].includes(options.key)) next += 1;
    if (options.key === 'PageDown') next -= 10;
    if (options.key === 'PageUp') next += 10;
    if (options.key === 'Home') next = boundary === 'start' ? 0 : Math.round(state.values.start);
    if (options.key === 'End') next = boundary === 'start' ? Math.round(state.values.end) : state.domain.max;
    state.values[boundary] = boundary === 'start'
      ? clamp(next, 0, state.values.end) : clamp(next, state.values.start, state.domain.max);
    state.domain.min = Math.min(state.domain.min, state.values.start);
    const result = snapshot(state);
    onUpdate(result);
    return result;
  }

  return { start, move, stop, cancel, key };
}

export function setupNavSliderInteractions(root, { onUpdate = () => {}, requestFrame, cancelFrame } = {}) {
  let active = null;
  let destroyed = false;
  const belongs = input => typeof root.contains !== 'function' || root.contains(input);
  const controller = createNavSliderController({
    requestFrame, cancelFrame,
    onUpdate(update) {
      if (active && !belongs(active.input)) { cancel(); return; }
      onUpdate(update);
    },
  });

  function findInput(event) {
    const input = event.target?.closest?.('[data-nav-boundary]');
    return input && !input.disabled && belongs(input) ? input : null;
  }

  function read(input) {
    const slider = input.closest('.nav-range-slider');
    const start = slider?.querySelector('[data-nav-boundary="start"]');
    const end = slider?.querySelector('[data-nav-boundary="end"]');
    if (!start || !end) return null;
    return {
      code: input.dataset.fund, boundary: input.dataset.navBoundary,
      domain: { min: finite(input.min), max: finite(input.max) },
      range: { start: finite(start.value), end: finite(end.value) },
    };
  }

  function fraction(input, event) {
    const rect = input.getBoundingClientRect();
    const width = finite(rect.width, finite(rect.right) - finite(rect.left));
    return clamp((finite(event.clientX, finite(rect.left) + 11) - finite(rect.left) - 11) / Math.max(1, width - 22), 0, 1);
  }

  function release() {
    const previous = active;
    active = null;
    if (previous) {
      try { previous.input.releasePointerCapture?.(previous.pointerId); } catch { /* The element may have been replaced. */ }
    }
  }

  function cancel() {
    controller.cancel();
    release();
  }

  function pointerdown(event) {
    if (destroyed || event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
    const input = findInput(event);
    if (!input) return;
    const options = read(input);
    if (!options || options.domain.max <= options.domain.min) return;
    cancel();
    event.preventDefault();
    active = { input, pointerId: event.pointerId };
    try { input.focus?.({ preventScroll: true }); } catch { input.focus?.(); }
    try { input.setPointerCapture?.(event.pointerId); } catch { /* Pointer capture is optional on older engines. */ }
    controller.start({ ...options, fraction: fraction(input, event) });
  }

  function pointermove(event) {
    if (!active || event.pointerId !== active.pointerId) return;
    if (!belongs(active.input)) { cancel(); return; }
    event.preventDefault();
    controller.move(fraction(active.input, event));
  }

  function pointerup(event) {
    if (!active || event.pointerId !== active.pointerId) return;
    if (!belongs(active.input)) { cancel(); return; }
    controller.move(fraction(active.input, event));
    controller.stop();
    release();
  }

  function pointercancel(event) {
    if (active && event.pointerId === active.pointerId) cancel();
  }

  function keydown(event) {
    if (destroyed || !keyboardKeys.has(event.key)) return;
    const input = findInput(event);
    if (!input) return;
    const options = read(input);
    if (!options) return;
    event.preventDefault();
    cancel();
    controller.key({ ...options, key: event.key });
  }

  function wheel(event) {
    if (destroyed) return;
    const slider = event.target?.closest?.('.nav-range-slider');
    if (!slider) return;
    const input = slider.querySelector?.('[data-nav-boundary="start"]') || event.target?.closest?.('[data-nav-boundary]');
    const options = input ? read(input) : null;
    if (!options || input.disabled || options.domain.max <= options.domain.min) return;
    const delta = Number(event.deltaY) || Number(event.deltaX) || 0;
    if (!delta) return;
    event.preventDefault();
    const step = event.shiftKey ? 5 : 1;
    const direction = delta > 0 ? 1 : -1;
    const span = Math.max(0, Math.round(options.range.end) - Math.round(options.range.start));
    if (span >= options.domain.max) return;
    let start = Math.round(options.range.start) + direction * step;
    let end = Math.round(options.range.end) + direction * step;
    if (start < 0) { start = 0; end = span; }
    if (end > options.domain.max) { end = options.domain.max; start = end - span; }
    if (start === Math.round(options.range.start) && end === Math.round(options.range.end)) return;
    onUpdate({
      code: options.code,
      boundary: options.boundary,
      domain: { min: Math.min(options.domain.min, start), max: options.domain.max },
      range: { start, end },
      values: { start, end },
    });
  }

  const listeners = { pointerdown, pointermove, pointerup, pointercancel, lostpointercapture: pointercancel, keydown, wheel };
  for (const [name, handler] of Object.entries(listeners)) root.addEventListener(name, handler, name === 'wheel' ? { passive: false } : undefined);
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cancel();
    for (const [name, handler] of Object.entries(listeners)) root.removeEventListener?.(name, handler);
  }
  return { cancel, destroy };
}
