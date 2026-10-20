// Desktop presentation only. No storage, network or account data.
export function createEdgeNavigation({ root, view = root?.ownerDocument?.defaultView } = {}) {
  const document = root?.ownerDocument;
  if (!document || !view?.matchMedia) return { sync() {}, destroy() {} };
  const media = view.matchMedia('(min-width: 761px)');
  const html = document.documentElement;
  let side = 'left', opened = false, switchTimer = null, pendingSide = null, destroyed = false;
  let leftBoundary = 80, rightBoundary = view.innerWidth - 80;
  const header = () => root.querySelector('.site-header');
  const enabled = () => view.innerWidth >= 761 && media.matches && Boolean(header());
  const measure = () => {
    const width = view.innerWidth;
    const box = root.querySelector('main.workspace')?.getBoundingClientRect();
    // The entire gutter beside the content is a target, not just a thin strip
    // at the far edge of a wide display. Keep targets usable on small desktops.
    leftBoundary = Math.max(80, Math.min(width * .3, (box?.left ?? 64) + 16));
    rightBoundary = Math.min(width - 80, Math.max(width * .7, (box?.right ?? width - 64) - 16));
    const offset = distance => Math.max(16, distance - 156 - 20);
    html.style.setProperty('--edge-nav-left', `${offset(box?.left ?? 0)}px`);
    html.style.setProperty('--edge-nav-right', `${offset(width - (box?.right ?? width))}px`);
  };
  const cancel = () => {
    if (switchTimer !== null) view.clearTimeout(switchTimer);
    switchTimer = null; pendingSide = null;
  };
  const paint = () => {
    html.dataset.edgeNavSide = side;
    html.dataset.edgeNavOpen = String(opened);
    const element = header();
    if (element) element.inert = enabled() && !opened;
  };
  const show = next => {
    if (switchTimer !== null && pendingSide === next) return;
    cancel();
    if (next !== side && opened) {
      opened = false; paint();
      pendingSide = next;
      switchTimer = view.setTimeout(() => { switchTimer = null; pendingSide = null; side = next; opened = true; paint(); }, 180);
    } else { side = next; opened = true; paint(); }
  };
  const pointer = event => {
    const element = header();
    if (!element || event.pointerType === 'touch' || !Number.isFinite(event.clientX) || view.innerWidth < 761) return;
    if (!enabled()) return;
    if (event.clientX <= leftBoundary) return show('left');
    if (event.clientX >= rightBoundary) return show('right');
  };
  const sync = () => {
    if (destroyed) return;
    const active = enabled();
    html.classList.toggle('edge-nav-enabled', active);
    if (!active) cancel();
    opened = active && switchTimer === null;
    measure();
    paint();
  };
  const moveEvent = view.PointerEvent ? 'pointermove' : 'mousemove';
  document.addEventListener(moveEvent, pointer, { passive: true, capture: true });
  media.addEventListener('change', sync);
  view.addEventListener('resize', sync);
  sync();
  return { sync, destroy() {
    destroyed = true; cancel();
    document.removeEventListener(moveEvent, pointer, true);
    media.removeEventListener('change', sync);
    view.removeEventListener('resize', sync);
    if (header()) header().inert = false;
    html.classList.remove('edge-nav-enabled');
    delete html.dataset.edgeNavSide; delete html.dataset.edgeNavOpen;
    html.style.removeProperty('--edge-nav-left'); html.style.removeProperty('--edge-nav-right');
  } };
}
