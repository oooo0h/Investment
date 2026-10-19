// Presentation only. No ledger, vault, storage, account values or data requests.
const app = document.querySelector('#app');
const host = document.querySelector('#ambient-scene');
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
let scene = null, motion = null, ambientFactory = null, motionFactory = null;
let frame = null, previousView = null, stopped = false;

function view() {
  if (app.querySelector('.gate')) return 'gate';
  if (app.querySelector('.bonds-page')) return 'bonds';
  if (app.querySelector('.fund-page')) return 'fund';
  return app.querySelector('.discipline-home') ? 'home' : 'gate';
}

function refresh(reason = 'render') {
  if (stopped) return;
  const current = view();
  document.documentElement.dataset.view = current;
  document.body.dataset.view = current;
  scene?.setView(current);
  motion?.refresh({ view: current, reason: previousView === current ? reason : 'route' });
  previousView = current;
}

function schedule() {
  if (frame !== null || stopped) return;
  frame = requestAnimationFrame(() => { frame = null; refresh(); });
}

function theme() {
  scene?.setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
}

function recreate() {
  if (stopped) return;
  scene?.destroy();
  motion?.destroy();
  scene = ambientFactory?.({ host, reducedMotion: motionPreference.matches }) || null;
  motion = motionFactory?.({ root: app }) || null;
  theme();
  refresh('preference');
}

const contentObserver = new MutationObserver(schedule);
contentObserver.observe(app, { childList: true });
const themeObserver = new MutationObserver(() => {
  theme();
  motion?.refresh({ view: view(), reason: 'theme' });
});
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
motionPreference.addEventListener('change', recreate);

// Each visual layer is optional; a graphics failure never blocks the application.
const ambientReady = import('./ambient-scene.js').then(module => {
  if (stopped) return;
  ambientFactory = module.createAmbientScene;
  scene = ambientFactory({ host, reducedMotion: motionPreference.matches });
  theme();
  scene.setView(view());
  document.documentElement.dataset.ambientReady = 'true';
}).catch(() => { document.documentElement.dataset.ambientReady = 'fallback'; });

function loadGsap() {
  if (globalThis.gsap?.context) return Promise.resolve();
  // The official UMD build must run as a classic script, outside ES module strict mode.
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('./vendor/gsap/gsap.min.js', import.meta.url).href;
    script.async = true;
    script.onload = () => globalThis.gsap?.context ? resolve() : reject(new Error('Animation runtime unavailable'));
    script.onerror = () => reject(new Error('Animation runtime unavailable'));
    document.head.append(script);
  });
}

const motionReady = loadGsap().then(() => import('./interface-motion.js')).then(module => {
  if (stopped) return;
  motionFactory = module.createInterfaceMotion;
  motion = motionFactory({ root: app });
  refresh('ready');
  document.documentElement.dataset.motionReady = 'true';
}).catch(() => { document.documentElement.dataset.motionReady = 'fallback'; });

void Promise.allSettled([ambientReady, motionReady]).then(() => {
  if (!stopped) document.documentElement.dataset.visualReady = 'true';
});

function destroy() {
  stopped = true;
  if (frame !== null) cancelAnimationFrame(frame);
  contentObserver.disconnect();
  themeObserver.disconnect();
  motionPreference.removeEventListener('change', recreate);
  motion?.destroy();
  scene?.destroy();
}
window.addEventListener('pagehide', event => { if (!event.persisted) destroy(); });
refresh('initial');
