/** Decorative interface motion. No account values or DOM text are inspected. */
const STYLE_ID = 'fund-interface-motion-styles';
const SURFACES = '.discipline-entry, .gate-panel, .panel, [data-motion-tilt]';
const TILT_SURFACES = '.gate-panel, .fund-regions, .bond-card, [data-motion-tilt]';
const PRESS_TARGETS = 'button, summary, .exposure-check-target, .desktop-nav a, .bottom-nav a, .back-link';
const ENTRANCES = '.gate-content > .brand, .gate-panel, .discipline-heading, .discipline-entry, .back-link, .page-heading, .fund-regions, .fund-layout > .nav-panel, .main-column > .panel, .bonds-summary, .bonds-state, .bond-card, [data-motion-enter]';

function installStyles(document) {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .motion-surface { position: relative; }
    .motion-lightspot { position: absolute; inset: 0; pointer-events: none; border-radius: inherit; z-index: 1; opacity: 0; background: radial-gradient(480px circle at var(--motion-x, 50%) var(--motion-y, 50%), color-mix(in srgb, var(--blue, #54cbbb) 8%, transparent), transparent 70%); }
    .motion-ripple-host { position: relative; isolation: isolate; overflow: hidden; }
    .motion-ripple { position: absolute; display: block; width: 20px; height: 20px; margin: -10px 0 0 -10px; border: 1px solid currentColor; border-radius: 50%; pointer-events: none; z-index: 2; opacity: .22; background: color-mix(in srgb, currentColor 10%, transparent); }
    .desktop-nav.motion-nav-ready { position: relative; }
    .desktop-nav.motion-nav-ready a.active::after { display: none; }
    .motion-nav-indicator { position: absolute; left: 0; bottom: 3px; width: 1px; height: 2px; border-radius: 3px; pointer-events: none; background: currentColor; box-shadow: 0 0 14px currentColor; transform-origin: left center; }
    .motion-progress-controlled .holding-progress-fill { transition: none !important; }
    @media (prefers-reduced-motion: reduce) {
      .motion-lightspot, .motion-ripple { display: none !important; }
    }
  `;
  document.head.append(style);
}

export function createInterfaceMotion({ root = document.querySelector('#app') } = {}) {
  const gsap = globalThis.gsap;
  if (!root || !gsap?.context) return { refresh() {}, destroy() {} };
  const document = root.ownerDocument;
  const window = document.defaultView;
  installStyles(document);

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const listeners = [];
  const transientNodes = new Set();
  const decoratedSurfaces = new Set();
  const pressed = new Set();
  const detailAnimations = new Map();
  const navigationHistory = new Map();
  let scope = null;
  let observer = null;
  let currentMain = null;
  let previousView = null;
  let previousRoute = null;
  let destroyed = false;
  let activeSurface = null;
  let surfaceRect = null;
  let spotlight = null;
  let tiltX = null;
  let tiltY = null;
  let magneticTarget = null;
  let magnetX = null;
  let magnetY = null;
  let activeNav = null;
  let indicator = null;

  const canAnimate = () => !destroyed && !reduced.matches && !document.hidden;
  const inRoot = target => target?.isConnected && root.contains(target);
  const scoped = callback => {
    if (!destroyed && scope) scope.add(callback);
  };
  const on = (target, type, callback, options) => {
    target.addEventListener(type, callback, options);
    listeners.push(() => target.removeEventListener(type, callback, options));
  };

  function removeTransientNodes() {
    transientNodes.forEach(node => node.remove());
    transientNodes.clear();
  }

  function cleanScope() {
    observer?.disconnect();
    observer = null;
    detailAnimations.forEach(animation => animation.kill());
    detailAnimations.clear();
    scope?.revert();
    scope = null;
    decoratedSurfaces.forEach(surface => {
      surface.classList.remove('motion-surface', 'motion-progress-controlled');
      surface.style.removeProperty('--motion-x');
      surface.style.removeProperty('--motion-y');
      surface.style.removeProperty('--spotlight-x');
      surface.style.removeProperty('--spotlight-y');
    });
    decoratedSurfaces.clear();
    root.querySelectorAll('.motion-ripple-host').forEach(target => target.classList.remove('motion-ripple-host'));
    root.querySelectorAll('.motion-nav-ready').forEach(nav => nav.classList.remove('motion-nav-ready'));
    root.querySelectorAll('.motion-progress-controlled').forEach(detail => detail.classList.remove('motion-progress-controlled'));
    removeTransientNodes();
    pressed.clear();
    activeSurface = surfaceRect = spotlight = tiltX = tiltY = null;
    magneticTarget = magnetX = magnetY = activeNav = indicator = null;
  }

  function reveal(targets, stagger = 0) {
    const connected = targets.filter(inRoot);
    if (!connected.length || !canAnimate()) return;
    scoped(() => {
      gsap.fromTo(connected, { y: 24, opacity: .08 }, {
        y: 0, opacity: 1, duration: .36, ease: 'power3.out',
        stagger: { amount: Math.min(stagger, .12) },
        overwrite: 'auto', clearProps: 'opacity,transform,willChange',
        onStart() { connected.forEach(target => { target.style.willChange = 'transform, opacity'; }); }
      });
    });
  }

  function prepareEntrances(animate) {
    if (!animate || !canAnimate()) return;
    const candidates = [...root.querySelectorAll(ENTRANCES)].filter(target =>
      !target.closest('details:not([open])') && !target.parentElement?.closest('[data-motion-enter]')
    );
    const screenHeight = window.innerHeight;
    const visible = [];
    const deferred = [];
    // Read layout in one pass; elements remain readable until their entrance starts.
    candidates.forEach(target => {
      const rect = target.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      if (rect.top < screenHeight && rect.bottom > 0) visible.push(target);
      else if (rect.top >= screenHeight) deferred.push(target);
    });
    reveal(visible, .12);
    if (!window.IntersectionObserver || !deferred.length) return;
    observer = new window.IntersectionObserver(entries => {
      const entered = entries.filter(entry => entry.isIntersecting && inRoot(entry.target));
      entered.forEach(entry => observer?.unobserve(entry.target));
      reveal(entered.map(entry => entry.target), .08);
    }, { threshold: .08, rootMargin: '0px 0px -20px 0px' });
    deferred.forEach(target => observer.observe(target));
  }

  function navPosition(nav, link) {
    const navRect = nav.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    return { x: linkRect.left - navRect.left + nav.scrollLeft, width: linkRect.width };
  }

  function moveIndicator(nav, link, immediate = false) {
    if (!indicator || nav !== activeNav || !inRoot(link)) return;
    const position = navPosition(nav, link);
    const color = window.getComputedStyle(link).color;
    scoped(() => gsap.to(indicator, {
      x: position.x, scaleX: position.width, color,
      duration: immediate || !canAnimate() ? 0 : .3,
      ease: 'power3.out', overwrite: true
    }));
    if (link.matches('[aria-current="page"], .active')) navigationHistory.set('desktop', position);
  }

  function prepareNavigation(animate) {
    activeNav = root.querySelector('.desktop-nav');
    const link = activeNav?.querySelector('[aria-current="page"], .active');
    if (!link || !activeNav.getBoundingClientRect().width) return;
    indicator = document.createElement('span');
    indicator.className = 'motion-nav-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    activeNav.classList.add('motion-nav-ready');
    activeNav.append(indicator);
    transientNodes.add(indicator);
    const previous = navigationHistory.get('desktop');
    if (previous && animate && canAnimate()) {
      scoped(() => gsap.set(indicator, { x: previous.x, scaleX: previous.width }));
      moveIndicator(activeNav, link);
    } else moveIndicator(activeNav, link, true);
  }

  function animateDetail(detail, animate = true) {
    detailAnimations.get(detail)?.kill();
    detailAnimations.delete(detail);
    const content = [...detail.children].filter(child => child.tagName !== 'SUMMARY' && !child.matches('.motion-lightspot'));
    const bars = [...detail.querySelectorAll('.holding-progress-fill')];
    if (!detail.open || !canAnimate() || !animate) {
      scoped(() => gsap.set([...content, ...bars], { clearProps: 'opacity,transform,transformOrigin,willChange' }));
      return;
    }
    detail.classList.add('motion-progress-controlled');
    scoped(() => {
      const timeline = gsap.timeline({ defaults: { ease: 'power3.out', overwrite: 'auto' } });
      if (content.length) timeline.fromTo(content, { y: 9, opacity: .1 }, {
        y: 0, opacity: 1, duration: .32, clearProps: 'opacity,transform,willChange'
      }, 0);
      if (bars.length) timeline.fromTo(bars, { scaleX: 0, transformOrigin: 'left center' }, {
        scaleX: 1, duration: .72, stagger: { amount: .14 },
        clearProps: 'transform,transformOrigin,willChange'
      }, .07);
      timeline.eventCallback('onComplete', () => detailAnimations.delete(detail));
      detailAnimations.set(detail, timeline);
    });
  }

  function endSurface() {
    if (activeSurface && inRoot(activeSurface)) {
      const surface = activeSurface;
      const light = spotlight;
      scoped(() => {
        gsap.to(surface, { rotationX: 0, rotationY: 0, duration: .38, ease: 'power3.out', overwrite: 'auto', clearProps: 'transform,transformPerspective,willChange' });
        if (light) gsap.to(light, { opacity: 0, duration: .24, overwrite: true });
      });
    }
    activeSurface = surfaceRect = spotlight = tiltX = tiltY = null;
  }

  function startSurface(surface) {
    if (surface === activeSurface) return;
    endSurface();
    activeSurface = surface;
    surfaceRect = surface.getBoundingClientRect();
    spotlight = surface.querySelector(':scope > .motion-lightspot');
    if (!spotlight) {
      spotlight = document.createElement('span');
      spotlight.className = 'motion-lightspot';
      spotlight.setAttribute('aria-hidden', 'true');
      surface.append(spotlight);
      transientNodes.add(spotlight);
      surface.classList.add('motion-surface');
      decoratedSurfaces.add(surface);
    }
    scoped(() => {
      gsap.to(spotlight, { opacity: 1, duration: .22, overwrite: true });
      if (surface.matches(TILT_SURFACES) && surfaceRect.height < 620) {
        gsap.set(surface, { transformPerspective: 1100, willChange: 'transform' });
        tiltX = gsap.quickTo(surface, 'rotationX', { duration: .4, ease: 'power3.out' });
        tiltY = gsap.quickTo(surface, 'rotationY', { duration: .4, ease: 'power3.out' });
      }
    });
  }

  function endMagnet() {
    if (magneticTarget && inRoot(magneticTarget)) {
      const target = magneticTarget;
      scoped(() => gsap.to(target, { x: 0, y: 0, duration: .3, ease: 'power3.out', overwrite: 'auto', clearProps: 'transform' }));
    }
    magneticTarget = magnetX = magnetY = null;
  }

  function pointerMove(event) {
    if (!canAnimate() || !finePointer.matches || event.pointerType === 'touch') return;
    const target = event.target instanceof window.Element ? event.target : null;
    const surface = target?.closest(SURFACES);
    if (surface && inRoot(surface)) {
      startSurface(surface);
      const x = Math.min(surfaceRect.width, Math.max(0, event.clientX - surfaceRect.left));
      const y = Math.min(surfaceRect.height, Math.max(0, event.clientY - surfaceRect.top));
      surface.style.setProperty('--motion-x', `${x}px`);
      surface.style.setProperty('--motion-y', `${y}px`);
      surface.style.setProperty('--spotlight-x', `${x / surfaceRect.width * 100}%`);
      surface.style.setProperty('--spotlight-y', `${y / surfaceRect.height * 100}%`);
      const focused = surface.matches(':focus-within');
      tiltX?.(focused ? 0 : (.5 - y / surfaceRect.height) * 5);
      tiltY?.(focused ? 0 : (x / surfaceRect.width - .5) * 5);
    } else endSurface();

    // Only the icon moves; the button's hit target remains stationary.
    const button = target?.closest('.icon-button, .button.primary');
    const icon = button?.querySelector('.icon');
    if (icon && icon !== magneticTarget) {
      endMagnet();
      magneticTarget = icon;
      scoped(() => {
        magnetX = gsap.quickTo(icon, 'x', { duration: .28, ease: 'power3.out' });
        magnetY = gsap.quickTo(icon, 'y', { duration: .28, ease: 'power3.out' });
      });
    } else if (!icon) endMagnet();
    if (icon) {
      const rect = button.getBoundingClientRect();
      magnetX?.(((event.clientX - rect.left) / rect.width - .5) * 5);
      magnetY?.(((event.clientY - rect.top) / rect.height - .5) * 5);
    }
  }

  function releasePresses() {
    pressed.forEach(target => {
      if (!inRoot(target)) return;
      scoped(() => gsap.to(target, { scale: 1, duration: .26, ease: 'back.out(1.5)', overwrite: 'auto', clearProps: 'transform,transformOrigin' }));
    });
    pressed.clear();
  }

  function press(event) {
    if (!canAnimate() || (event.type === 'pointerdown' && event.button !== 0)) return;
    const target = event.target instanceof window.Element ? event.target.closest(PRESS_TARGETS) : null;
    if (!target || !inRoot(target) || target.matches(':disabled, [aria-disabled="true"]')) return;
    if (event.type === 'keydown' && (!['Enter', ' '].includes(event.key) || event.repeat || !target.matches('button, summary'))) return;
    pressed.add(target);
    scoped(() => gsap.to(target, { scale: target.tagName === 'SUMMARY' ? .997 : .965, duration: .14, ease: 'power2.out', overwrite: 'auto' }));
    if (target.tagName === 'SUMMARY') return;
    const rect = target.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'motion-ripple';
    ripple.setAttribute('aria-hidden', 'true');
    ripple.style.left = `${event.type === 'pointerdown' ? event.clientX - rect.left : rect.width / 2}px`;
    ripple.style.top = `${event.type === 'pointerdown' ? event.clientY - rect.top : rect.height / 2}px`;
    target.classList.add('motion-ripple-host');
    target.append(ripple);
    transientNodes.add(ripple);
    scoped(() => gsap.to(ripple, {
      scale: Math.min(18, Math.max(rect.width, rect.height) / 8), opacity: 0,
      duration: .55, ease: 'power2.out',
      onComplete() { ripple.remove(); transientNodes.delete(ripple); }
    }));
  }

  function refresh({ view = 'home', reason = 'render' } = {}) {
    if (destroyed) return;
    const main = root.querySelector('main');
    // Navigation hrefs contain only public page identities. No labels or account
    // contents are read, and an ordinary same-page redraw does not replay motion.
    const activeHref = root.querySelector('.desktop-nav [aria-current="page"], .bottom-nav [aria-current="page"]')?.getAttribute('href') || '';
    const route = `${view}:${activeHref}`;
    const routeChanged = route !== previousRoute;
    if (main === currentMain && reason === 'render' && !routeChanged) return;
    cleanScope();
    currentMain = main;
    previousView = view;
    previousRoute = route;
    scope = gsap.context(() => {}, root);
    if (!canAnimate()) return;
    prepareNavigation(routeChanged);
    prepareEntrances(routeChanged);
    root.querySelectorAll('details[open]').forEach(detail => animateDetail(detail, routeChanged));
  }

  on(root, 'pointermove', pointerMove, { passive: true });
  on(root, 'pointerleave', () => { endSurface(); endMagnet(); releasePresses(); });
  on(root, 'pointerdown', press, { passive: true });
  on(root, 'keydown', press);
  on(window, 'pointerup', releasePresses, { passive: true });
  on(window, 'pointercancel', releasePresses, { passive: true });
  on(window, 'keyup', releasePresses);
  on(window, 'blur', () => { endSurface(); endMagnet(); releasePresses(); });
  on(root, 'toggle', event => {
    if (event.target instanceof window.HTMLDetailsElement && inRoot(event.target)) animateDetail(event.target);
  }, true);
  on(root, 'pointerover', event => {
    if (!canAnimate()) return;
    const link = event.target instanceof window.Element ? event.target.closest('.desktop-nav a') : null;
    if (link && activeNav?.contains(link)) moveIndicator(activeNav, link);
  }, { passive: true });
  on(root, 'pointerout', event => {
    if (activeNav && !activeNav.contains(event.relatedTarget)) {
      const current = activeNav.querySelector('[aria-current="page"], .active');
      if (current) moveIndicator(activeNav, current);
    }
  }, { passive: true });
  on(root, 'focusin', event => {
    const link = event.target instanceof window.Element ? event.target.closest('.desktop-nav a') : null;
    if (link && activeNav?.contains(link)) moveIndicator(activeNav, link);
  });
  on(root, 'focusout', event => {
    if (activeNav && !activeNav.contains(event.relatedTarget)) {
      const current = activeNav.querySelector('[aria-current="page"], .active');
      if (current) moveIndicator(activeNav, current);
    }
  });
  on(document, 'visibilitychange', () => {
    // Revert immediately instead of leaving partially hidden elements on return.
    refresh({ view: previousView || 'home', reason: 'visibility' });
  });
  on(reduced, 'change', () => refresh({ view: previousView || 'home', reason: 'preference' }));
  on(finePointer, 'change', () => { endSurface(); endMagnet(); });

  return {
    refresh,
    destroy() {
      if (destroyed) return;
      cleanScope();
      destroyed = true;
      listeners.splice(0).forEach(remove => remove());
      navigationHistory.clear();
      currentMain = previousView = previousRoute = null;
    }
  };
}
