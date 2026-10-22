// Board-scoped Three.js effects for the registration dialog.
// Rendering only; no ledger, storage, network or account values.
import * as THREE from '../vendor/three/three.module.js';

const PALETTES = {
  dark: {
    buy: 0x8fbaff, sell: 0x7fe0c0, transfer: 0xc9a7ff,
    particles: [0x6ea8ff, 0x7fe0c0, 0xc9a7ff],
  },
  light: {
    buy: 0x0c725d, sell: 0x17826f, transfer: 0x8361ad,
    particles: [0x0c725d, 0x17826f, 0x8361ad],
  },
};

function radialTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255,255,255,0.85)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.28)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

export function createTradeEffects({ theme = 'dark', reducedMotion = false } = {}) {
  if (typeof document === 'undefined' || typeof window === 'undefined' || !document.createElement) {
    return { mount() {}, sync() {}, start() {}, stop() {}, destroy() {}, pulse() {}, setMode() {}, setTheme() {} };
  }
  let host = null, running = false, destroyed = false, frame = null, startedAt = performance.now();
  let palette = PALETTES[theme] || PALETTES.dark;
  let mode = 'buy', width = 1, height = 1;
  let leftTarget = null, rightTarget = null, curve = null, curvePoints = [];
  let pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  let pulseStarted = -1, pulseDirection = 1, pulseColor = null;

  const canvas = document.createElement('canvas');
  canvas.className = 'trade-effects-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  } catch {
    return { mount() {}, sync() {}, start() {}, stop() {}, destroy() {}, pulse() {}, setMode() {}, setTheme() {} };
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(0, 1, 1, 0, .1, 100);
  camera.position.z = 10;

  // Particle field. Positions are normalized and reprojected on resize.
  const COUNT = 150;
  const base = new Float32Array(COUNT * 2), phases = new Float32Array(COUNT), speeds = new Float32Array(COUNT);
  const positions = new Float32Array(COUNT * 3), colors = new Float32Array(COUNT * 3);
  for (let index = 0; index < COUNT; index += 1) {
    base[index * 2] = Math.random();
    base[index * 2 + 1] = Math.random();
    phases[index] = Math.random() * Math.PI * 2;
    speeds[index] = .5 + Math.random() * .9;
    const color = new THREE.Color(palette.particles[index % palette.particles.length]);
    colors[index * 3] = color.r; colors[index * 3 + 1] = color.g; colors[index * 3 + 2] = color.b;
    positions[index * 3 + 2] = 0;
  }
  const particleGeometry = new THREE.BufferGeometry();
  particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  particleGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const particleMaterial = new THREE.PointsMaterial({ size: 2.7, vertexColors: true, transparent: true, opacity: .78, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: false });
  const particles = new THREE.Points(particleGeometry, particleMaterial);
  scene.add(particles);

  const texture = radialTexture();
  const halos = [0, 1].map(() => {
    const material = new THREE.SpriteMaterial({ map: texture, color: palette[mode], transparent: true, opacity: .3, blending: THREE.AdditiveBlending, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(250, 250, 1);
    sprite.visible = false;
    scene.add(sprite);
    return sprite;
  });

  let tube = null;
  const beadMaterial = new THREE.MeshBasicMaterial({ color: palette[mode], transparent: true, opacity: .95, blending: THREE.AdditiveBlending, depthWrite: false });
  const bead = new THREE.Mesh(new THREE.CircleGeometry(5.4, 22), beadMaterial);
  bead.visible = false;
  scene.add(bead);
  const ringMaterial = new THREE.MeshBasicMaterial({ color: palette[mode], transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(9, 11, 48), ringMaterial);
  ring.visible = false;
  scene.add(ring);

  function modeColor() { return palette[mode] || palette.buy; }
  function setColors() {
    const color = modeColor();
    beadMaterial.color.setHex(color);
    ringMaterial.color.setHex(color);
    halos.forEach(halo => halo.material.color.setHex(color));
    if (tube) tube.material.color.setHex(color);
    for (let index = 0; index < COUNT; index += 1) {
      const tint = new THREE.Color(palette.particles[index % palette.particles.length]);
      colors[index * 3] = tint.r; colors[index * 3 + 1] = tint.g; colors[index * 3 + 2] = tint.b;
    }
    particleGeometry.attributes.color.needsUpdate = true;
  }
  setColors();

  function resize() {
    if (!host) return;
    width = Math.max(2, host.clientWidth);
    height = Math.max(2, host.clientHeight);
    renderer.setSize(width, height, false);
    camera.left = 0; camera.right = width; camera.top = height; camera.bottom = 0;
    camera.updateProjectionMatrix();
    sync();
    if (reducedMotion) renderFrame(performance.now());
  }

  function cardCenters() {
    if (!host) return [];
    const board = host.getBoundingClientRect();
    return [...host.querySelectorAll('.trade-stack-card.is-selected')].map(element => {
      const rect = element.getBoundingClientRect();
      return new THREE.Vector3(rect.left + rect.width / 2 - board.left, height - (rect.top + rect.height / 2 - board.top), 0);
    });
  }

  function rebuildCurve() {
    curvePoints = cardCenters();
    if (tube) { tube.geometry.dispose(); tube.material.dispose(); scene.remove(tube); tube = null; }
    if (curvePoints.length < 2) {
      halos.forEach(halo => { halo.visible = false; });
      bead.visible = false;
      return;
    }
    const [left, right] = curvePoints;
    const control = new THREE.Vector3((left.x + right.x) / 2, Math.min(height - 28, Math.max(left.y, right.y) + Math.min(82, height * .22)), 0);
    curve = new THREE.QuadraticBezierCurve3(left, control, right);
    tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 2.3, 6, false),
      new THREE.MeshBasicMaterial({ color: modeColor(), transparent: true, opacity: .5, blending: THREE.AdditiveBlending, depthWrite: false }));
    scene.add(tube);
    halos.forEach((halo, index) => {
      const point = curvePoints[index];
      halo.position.copy(point);
      halo.visible = true;
    });
    bead.visible = true;
  }

  function sync() {
    if (!host) return;
    rebuildCurve();
  }

  function pulse(kind = 'wheel') {
    pulseStarted = performance.now();
    pulseDirection = kind === 'reverse' ? -1 : 1;
    pulseColor = kind === 'reverse' ? palette.transfer : modeColor();
    ringMaterial.color.setHex(pulseColor);
  }

  function renderFrame(now) {
    if (destroyed || !host) return;
    const elapsed = (now - startedAt) / 1000;
    pointer.x += (pointer.tx - pointer.x) * .06;
    pointer.y += (pointer.ty - pointer.y) * .06;
    for (let index = 0; index < COUNT; index += 1) {
      const drift = Math.sin(elapsed * .16 * speeds[index] + phases[index]) * .012;
      const swell = Math.cos(elapsed * .12 * speeds[index] + phases[index]) * .01;
      positions[index * 3] = (base[index * 2] + drift + pointer.x * .018) * width;
      positions[index * 3 + 1] = (base[index * 2 + 1] + swell + pointer.y * .014) * height;
    }
    particleGeometry.attributes.position.needsUpdate = true;
    halos.forEach((halo, index) => {
      const pulseScale = pulseStarted > 0 ? 1 + Math.max(0, 1 - (now - pulseStarted) / 900) * .18 : 1;
      halo.material.opacity = .26 + Math.sin(elapsed * 1.2 + index) * .04;
      halo.scale.set(250 * pulseScale, 250 * pulseScale, 1);
    });
    if (curve && bead.visible) {
      const cycle = (elapsed * .085) % 1;
      let progress = pulseStarted > 0 ? Math.min(1, Math.max(0, (now - pulseStarted) / 900)) : cycle;
      if (pulseDirection < 0) progress = 1 - progress;
      const point = curve.getPointAt(Math.min(.999, Math.max(.001, progress)));
      bead.position.copy(point);
      const scale = pulseStarted > 0 ? 1 + Math.max(0, 1 - (now - pulseStarted) / 900) * .8 : 1;
      bead.scale.set(scale, scale, 1);
    }
    if (pulseStarted > 0) {
      const progress = Math.min(1, Math.max(0, (now - pulseStarted) / 900));
      ring.visible = true;
      if (curvePoints.length >= 2) ring.position.set((curvePoints[0].x + curvePoints[1].x) / 2, (curvePoints[0].y + curvePoints[1].y) / 2, 0);
      else ring.position.set(width / 2, height / 2, 0);
      const scale = .4 + progress * 5;
      ring.scale.set(scale, scale, 1);
      ringMaterial.opacity = Math.max(0, .62 * (1 - progress));
      if (progress >= 1) { pulseStarted = -1; ring.visible = false; }
    }
    renderer.render(scene, camera);
  }

  function loop(now) {
    if (!running || destroyed) return;
    renderFrame(now);
    frame = requestAnimationFrame(loop);
  }

  function start() {
    if (running || destroyed) return;
    running = true;
    startedAt = performance.now();
    if (reducedMotion) renderFrame(startedAt);
    else frame = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  function pointerMove(event) {
    if (!host) return;
    const rect = host.getBoundingClientRect();
    pointer.tx = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width - .5) * 2));
    pointer.ty = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height - .5) * 2));
    if (!reducedMotion) {
      host.style.setProperty('--trade-tilt-x', `${pointer.tx * -.8}deg`);
      host.style.setProperty('--trade-tilt-y', `${pointer.ty * .65}deg`);
    }
  }
  function pointerLeave() {
    pointer.tx = 0; pointer.ty = 0;
    if (!host) return;
    host.style.setProperty('--trade-tilt-x', '0deg');
    host.style.setProperty('--trade-tilt-y', '0deg');
  }

  let observer = null;
  function mount(nextHost) {
    if (destroyed || !nextHost) return;
    if (host === nextHost && canvas.parentElement === nextHost) { sync(); return; }
    if (host) {
      host.removeEventListener('pointermove', pointerMove);
      host.removeEventListener('pointerleave', pointerLeave);
    }
    host = nextHost;
    host.appendChild(canvas);
    host.addEventListener('pointermove', pointerMove, { passive: true });
    host.addEventListener('pointerleave', pointerLeave, { passive: true });
    if (observer) observer.disconnect();
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => resize());
      observer.observe(host);
    }
    resize();
    sync();
  }

  function setMode(nextMode) {
    if (!['buy', 'sell', 'transfer'].includes(nextMode) || nextMode === mode) return;
    mode = nextMode;
    setColors();
    sync();
    if (reducedMotion) renderFrame(performance.now());
  }

  function setTheme(nextTheme) {
    palette = PALETTES[nextTheme] || PALETTES.dark;
    setColors();
    if (reducedMotion) renderFrame(performance.now());
  }

  function destroy() {
    destroyed = true;
    stop();
    if (host) {
      host.removeEventListener('pointermove', pointerMove);
      host.removeEventListener('pointerleave', pointerLeave);
    }
    if (observer) observer.disconnect();
    observer = null;
    if (tube) { tube.geometry.dispose(); tube.material.dispose(); }
    particleGeometry.dispose(); particleMaterial.dispose();
    halos.forEach(halo => { halo.material.dispose(); });
    if (texture) texture.dispose();
    bead.geometry.dispose(); beadMaterial.dispose();
    ring.geometry.dispose(); ringMaterial.dispose();
    renderer.dispose();
    canvas.remove();
    host = null;
  }

  return { mount, sync, start, stop, destroy, pulse, setMode, setTheme };
}
