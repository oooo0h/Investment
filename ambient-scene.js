import * as THREE from './vendor/three/three.module.js';

/** Decorative, account-independent orbital scene. The host is a full-viewport div. */
export function createAmbientScene({ host, reducedMotion = false } = {}) {
  if (!host?.ownerDocument) return { setTheme() {}, setView() {}, destroy() {} };

  const document = host.ownerDocument;
  const window = document.defaultView;
  const canvas = document.createElement('canvas');
  const fallback = document.createElement('div');
  const fallbackRings = Array.from({ length: 3 }, () => document.createElement('i'));
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mobileQuery = window.matchMedia('(max-width: 700px), (pointer: coarse)');
  let quiet = reducedMotion || motionQuery.matches;
  let mobile = mobileQuery.matches;
  let view = 'gate';
  let theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  let destroyed = false;
  let contextLost = false;
  let intersecting = true;
  let renderer;
  let scene;
  let camera;
  let resizeObserver;
  let intersectionObserver;
  let lastFrame = 0;
  let lastTime = 0;
  let elapsed = 0;
  let width = 1;
  let height = 1;
  let scroll = Math.min(window.scrollY / Math.max(window.innerHeight, 1), 2);
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const orbits = [];
  const pointer = new THREE.Vector2();
  const pointerTarget = new THREE.Vector2();
  const targetPosition = new THREE.Vector3();
  const floatingPosition = new THREE.Vector3();
  const orbitalSystem = new THREE.Group();
  const globe = new THREE.Group();
  const stars = new THREE.Group();
  let targetScale = 1;
  let intensity = 1;
  let targetIntensity = 1;

  host.setAttribute('aria-hidden', 'true');
  host.style.pointerEvents = 'none';
  canvas.className = 'ambient-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'display:block;width:100%;height:100%;pointer-events:none;';
  fallback.className = 'ambient-fallback';
  fallback.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
  for (const ring of fallbackRings) {
    ring.style.cssText = 'position:absolute;display:block;width:min(43vw,550px);aspect-ratio:1;border:1px solid;border-radius:50%;pointer-events:none;';
    fallback.append(ring);
  }
  host.append(fallback, canvas);

  const palettes = {
    dark: { primary: 0x82f3d4, secondary: 0x4bb9dc, stars: 0xbce9eb, globe: 0x299888, multiplier: 1 },
    light: { primary: 0x267c75, secondary: 0x609ca4, stars: 0x3d8488, globe: 0x6dafa1, multiplier: 0.66 },
  };

  function paintFallback() {
    const gate = view === 'gate';
    const light = theme === 'light';
    fallback.style.background = light
      ? 'radial-gradient(ellipse at 78% 8%,#58b6a70a,transparent 50%)'
      : 'radial-gradient(ellipse at 78% 8%,#68dabe0a,transparent 50%)';
    fallbackRings.forEach((ring, index) => {
      ring.style.left = gate ? (mobile ? '50%' : '25%') : '88%';
      ring.style.top = gate ? (mobile ? '27%' : '50%') : '12%';
      ring.style.width = gate ? (mobile ? '68vw' : 'min(41vw,550px)') : 'min(30vw,390px)';
      ring.style.borderColor = light ? '#2f8d7522' : '#7be6c329';
      ring.style.opacity = gate ? '1' : '.55';
      ring.style.transform = `translate(-50%,-50%) rotate(${index * 52 - 35}deg) scaleY(${0.38 + index * 0.13}) scale(${1 + index * 0.14})`;
    });
  }

  function rememberGeometry(geometry) {
    geometries.add(geometry);
    return geometry;
  }

  function material(kind, opacity, options = {}, Material = THREE.LineBasicMaterial) {
    const value = new Material({ transparent: true, opacity, depthWrite: false, ...options });
    value.userData.ambientKind = kind;
    value.userData.ambientOpacity = opacity;
    materials.add(value);
    return value;
  }

  function updatePalette() {
    const palette = palettes[theme];
    for (const value of materials) {
      value.color.setHex(palette[value.userData.ambientKind]);
      value.opacity = value.userData.ambientOpacity * palette.multiplier * intensity;
      if (value.userData.ambientGlow) value.blending = theme === 'dark' ? THREE.AdditiveBlending : THREE.NormalBlending;
    }
  }

  function makeGlowTexture() {
    const image = document.createElement('canvas');
    image.width = 128;
    image.height = 128;
    const context = image.getContext('2d');
    if (!context) return null;
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255,255,255,0.9)');
    gradient.addColorStop(0.13, 'rgba(255,255,255,0.56)');
    gradient.addColorStop(0.35, 'rgba(255,255,255,0.19)');
    gradient.addColorStop(0.7, 'rgba(255,255,255,0.035)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
    const texture = new THREE.CanvasTexture(image);
    texture.colorSpace = THREE.SRGBColorSpace;
    textures.add(texture);
    return texture;
  }

  function glowMaterial(texture, kind, opacity) {
    const value = material(kind, opacity, { map: texture, blending: THREE.AdditiveBlending }, THREE.SpriteMaterial);
    value.userData.ambientGlow = true;
    return value;
  }

  function addGlobe() {
    const radius = 1.28;
    const lines = [];
    const segments = mobile ? 72 : 112;
    const appendSegment = (a, b) => lines.push(...a, ...b);
    for (let latitude = -3; latitude <= 3; latitude += 1) {
      const phi = (latitude / 8) * Math.PI;
      const ringRadius = Math.cos(phi) * radius;
      const y = Math.sin(phi) * radius;
      for (let step = 0; step < segments; step += 1) {
        const a = (step / segments) * Math.PI * 2;
        const b = ((step + 1) / segments) * Math.PI * 2;
        appendSegment([Math.cos(a) * ringRadius, y, Math.sin(a) * ringRadius], [Math.cos(b) * ringRadius, y, Math.sin(b) * ringRadius]);
      }
    }
    for (let longitude = 0; longitude < 8; longitude += 1) {
      const angle = (longitude / 8) * Math.PI;
      for (let step = 0; step < segments; step += 1) {
        const a = (step / segments) * Math.PI * 2;
        const b = ((step + 1) / segments) * Math.PI * 2;
        appendSegment([Math.cos(a) * radius * Math.cos(angle), Math.sin(a) * radius, Math.cos(a) * radius * Math.sin(angle)], [Math.cos(b) * radius * Math.cos(angle), Math.sin(b) * radius, Math.cos(b) * radius * Math.sin(angle)]);
      }
    }
    const wireGeometry = rememberGeometry(new THREE.BufferGeometry());
    wireGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    globe.add(new THREE.LineSegments(wireGeometry, material('primary', 0.26)));
    const sphereGeometry = rememberGeometry(new THREE.SphereGeometry(radius * 0.997, mobile ? 24 : 40, mobile ? 16 : 24));
    globe.add(new THREE.Mesh(sphereGeometry, material('globe', 0.065, { side: THREE.FrontSide }, THREE.MeshBasicMaterial)));

    const count = mobile ? 240 : 580;
    const locations = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      const y = 1 - (index / (count - 1)) * 2;
      const crossSection = Math.sqrt(1 - y * y);
      const angle = index * Math.PI * (3 - Math.sqrt(5));
      locations.set([Math.cos(angle) * crossSection * radius, y * radius, Math.sin(angle) * crossSection * radius], index * 3);
    }
    const pointGeometry = rememberGeometry(new THREE.BufferGeometry());
    pointGeometry.setAttribute('position', new THREE.BufferAttribute(locations, 3));
    globe.add(new THREE.Points(pointGeometry, material('primary', 0.76, { size: 0.026, sizeAttenuation: true }, THREE.PointsMaterial)));
    globe.rotation.set(0.12, 0.25, -0.22);
    orbitalSystem.add(globe);
  }

  function addOrbits(glowTexture) {
    const beadGeometry = rememberGeometry(new THREE.SphereGeometry(0.04, 12, 8));
    const beadMaterial = material('primary', 1, {}, THREE.MeshBasicMaterial);
    const haloMaterial = glowTexture ? glowMaterial(glowTexture, 'primary', 0.85) : null;
    const definitions = [
      { radius: 2.04, ratio: 0.82, x: 1.02, y: 0.24, z: -0.2, phase: 0.6, speed: 0.15 },
      { radius: 2.46, ratio: 0.9, x: 0.91, y: -0.44, z: 0.57, phase: 2.5, speed: -0.095 },
      { radius: 1.73, ratio: 1, x: 0.32, y: 0.72, z: -0.51, phase: 4.2, speed: 0.19 },
      { radius: 2.76, ratio: 0.88, x: 1.32, y: 0.4, z: -0.62, phase: 1.7, speed: 0.07 },
      { radius: 1.5, ratio: 1, x: 0.44, y: -0.7, z: 0.82, phase: 5.6, speed: -0.24 },
    ];
    for (const [index, definition] of definitions.entries()) {
      const group = new THREE.Group();
      group.rotation.set(definition.x, definition.y, definition.z);
      group.scale.y = definition.ratio;
      const points = [];
      const steps = mobile ? 144 : 224;
      for (let step = 0; step <= steps; step += 1) {
        const angle = (step / steps) * Math.PI * 2;
        points.push(new THREE.Vector3(Math.cos(angle) * definition.radius, Math.sin(angle) * definition.radius, 0));
      }
      const geometry = rememberGeometry(new THREE.BufferGeometry().setFromPoints(points));
      group.add(new THREE.Line(geometry, material(index % 2 ? 'secondary' : 'primary', index === 0 ? 0.43 : 0.24)));
      const trailPoints = [];
      const trailColors = [];
      for (let step = 0; step <= 48; step += 1) {
        const angle = (step / 48 - 1) * 0.65 * Math.sign(definition.speed);
        trailPoints.push(new THREE.Vector3(Math.cos(angle) * definition.radius, Math.sin(angle) * definition.radius, 0));
        const brightness = Math.pow(step / 48, 1.5);
        trailColors.push(brightness, brightness, brightness);
      }
      const trailGeometry = rememberGeometry(new THREE.BufferGeometry().setFromPoints(trailPoints));
      trailGeometry.setAttribute('color', new THREE.Float32BufferAttribute(trailColors, 3));
      const trail = new THREE.Line(trailGeometry, material(index % 2 ? 'secondary' : 'primary', 0.9, { vertexColors: true }));
      group.add(trail);
      const bead = new THREE.Group();
      bead.add(new THREE.Mesh(beadGeometry, beadMaterial));
      if (haloMaterial) {
        const halo = new THREE.Sprite(haloMaterial);
        halo.scale.setScalar(index === 0 ? 0.54 : 0.37);
        bead.add(halo);
      }
      if (index === 1) bead.children[0].scale.setScalar(1.8);
      group.add(bead);
      orbitalSystem.add(group);
      orbits.push({ ...definition, group, bead, trail });
    }
  }

  function addStars() {
    const count = mobile ? 160 : 420;
    const locations = new Float32Array(count * 3);
    // A fixed seed keeps the decorative composition stable between visits.
    let seed = 41;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    for (let index = 0; index < count; index += 1) {
      locations.set([(random() - 0.5) * 15, (random() - 0.5) * 10, -2 - random() * 3], index * 3);
    }
    const geometry = rememberGeometry(new THREE.BufferGeometry());
    geometry.setAttribute('position', new THREE.BufferAttribute(locations, 3));
    stars.add(new THREE.Points(geometry, material('stars', 0.43, { size: 1.6, sizeAttenuation: false }, THREE.PointsMaterial)));
    scene.add(stars);
  }

  function updateLayout(snap = false) {
    if (!camera) return;
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
    const halfWidth = halfHeight * camera.aspect;
    if (view === 'gate') {
      targetPosition.set(mobile ? 0 : -halfWidth * 0.48, mobile ? halfHeight * 0.32 : -0.1, 0);
      targetScale = mobile ? 0.61 : Math.min(1.12, halfWidth / 5.8);
      targetIntensity = mobile ? 0.78 : 1;
    } else {
      targetPosition.set(halfWidth * (mobile ? 0.91 : 0.81), halfHeight * (view === 'home' ? 0.57 : 0.72), -0.8);
      targetScale = mobile ? 0.42 : view === 'home' ? 0.64 : 0.53;
      targetIntensity = view === 'home' ? 0.65 : 0.43;
    }
    if (snap || quiet) {
      orbitalSystem.position.copy(targetPosition);
      orbitalSystem.scale.setScalar(targetScale);
      intensity = targetIntensity;
      updatePalette();
    }
  }

  function renderFrame(delta = 0) {
    if (!renderer || contextLost || destroyed) return;
    const damping = quiet ? 1 : 1 - Math.exp(-delta * 3.2);
    const movement = quiet ? 0 : 1;
    pointer.lerp(pointerTarget, damping);
    floatingPosition.copy(targetPosition);
    floatingPosition.x += pointer.x * 0.18 * movement;
    floatingPosition.y += (Math.sin(elapsed * 0.32) * 0.09 + pointer.y * 0.12 - scroll * 0.12) * movement;
    orbitalSystem.position.lerp(floatingPosition, damping);
    orbitalSystem.scale.lerp(newScale.setScalar(targetScale), damping);
    orbitalSystem.rotation.y = 0.08 + Math.sin(elapsed * 0.075) * 0.12 * movement + pointer.x * 0.17 * movement;
    orbitalSystem.rotation.x = pointer.y * 0.11 * movement;
    globe.rotation.y = 0.25 + elapsed * 0.024 * movement;
    globe.rotation.z = -0.22 + Math.sin(elapsed * 0.12) * 0.035 * movement;
    stars.rotation.y = elapsed * 0.002 * movement;
    stars.position.x = pointer.x * 0.035 * movement;
    stars.position.y = pointer.y * 0.035 * movement;
    for (const orbit of orbits) {
      const angle = orbit.phase + elapsed * orbit.speed * movement;
      orbit.bead.position.set(Math.cos(angle) * orbit.radius, Math.sin(angle) * orbit.radius, 0);
      orbit.trail.rotation.z = angle;
      orbit.group.rotation.z = orbit.z + Math.sin(elapsed * 0.06 + orbit.phase) * 0.06 * movement;
    }
    intensity += (targetIntensity - intensity) * damping;
    updatePalette();
    renderer.render(scene, camera);
  }

  const newScale = new THREE.Vector3();

  function animate(timestamp) {
    const interval = 1000 / 60;
    if (timestamp - lastFrame < interval) return;
    const delta = lastTime ? Math.min((timestamp - lastTime) / 1000, 0.1) : 1 / 45;
    lastFrame = timestamp;
    lastTime = timestamp;
    elapsed += delta;
    renderFrame(delta);
  }

  function syncPlayback() {
    if (!renderer || destroyed) return;
    renderer.setAnimationLoop(null);
    lastFrame = 0;
    lastTime = 0;
    if (!document.hidden && intersecting && width > 0 && height > 0 && !contextLost) {
      if (quiet) renderFrame();
      else renderer.setAnimationLoop(animate);
    }
  }

  function resize() {
    if (destroyed) return;
    const rect = host.getBoundingClientRect();
    width = Math.round(rect.width);
    height = Math.round(rect.height);
    if (!renderer || width < 1 || height < 1) {
      syncPlayback();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    stars.scale.x = Math.max(0.65, camera.aspect / 1.65);
    updateLayout(true);
    renderFrame();
    syncPlayback();
  }

  function onPointerMove(event) {
    if (quiet) return;
    pointerTarget.set((event.clientX / Math.max(window.innerWidth, 1) - 0.5) * 2, -(event.clientY / Math.max(window.innerHeight, 1) - 0.5) * 2);
  }

  function resetPointer() { pointerTarget.set(0, 0); }
  function onScroll() { scroll = Math.min(window.scrollY / Math.max(window.innerHeight, 1), 2); }
  function onMotionChange() {
    quiet = reducedMotion || motionQuery.matches;
    if (quiet) {
      pointer.set(0, 0);
      resetPointer();
      updateLayout(true);
    }
    syncPlayback();
  }
  function onMobileChange() {
    mobile = mobileQuery.matches;
    paintFallback();
    resize();
  }
  function onContextLost(event) {
    event.preventDefault();
    contextLost = true;
    fallback.style.display = '';
    canvas.style.visibility = 'hidden';
    host.dataset.ambientRenderer = 'fallback';
    syncPlayback();
  }
  function onContextRestored() {
    if (destroyed) return;
    contextLost = false;
    fallback.style.display = 'none';
    canvas.style.visibility = '';
    host.dataset.ambientRenderer = 'three';
    resize();
  }

  function setTheme(value) {
    if (destroyed) return;
    theme = value === 'light' ? 'light' : 'dark';
    host.dataset.ambientTheme = theme;
    paintFallback();
    updatePalette();
    if (quiet) renderFrame();
  }

  function setView(value) {
    if (destroyed) return;
    view = ['gate', 'home', 'fund', 'bonds'].includes(value) ? value : 'home';
    host.dataset.ambientView = view;
    paintFallback();
    updateLayout();
    if (quiet) renderFrame();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    renderer?.setAnimationLoop(null);
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    window.removeEventListener('resize', resize);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerleave', resetPointer);
    window.removeEventListener('blur', resetPointer);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('visibilitychange', syncPlayback);
    motionQuery.removeEventListener('change', onMotionChange);
    mobileQuery.removeEventListener('change', onMobileChange);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
    for (const geometry of geometries) geometry.dispose();
    for (const value of materials) value.dispose();
    for (const texture of textures) texture.dispose();
    scene?.clear();
    renderer?.dispose();
    renderer?.forceContextLoss();
    canvas.remove();
    fallback.remove();
    delete host.dataset.ambientRenderer;
    delete host.dataset.ambientView;
    delete host.dataset.ambientTheme;
  }

  paintFallback();
  host.dataset.ambientRenderer = 'fallback';
  host.dataset.ambientTheme = theme;
  host.dataset.ambientView = view;
  try {
    const context = canvas.getContext('webgl2', { alpha: true, antialias: true, powerPreference: 'high-performance' });
    if (context) {
      renderer = new THREE.WebGLRenderer({ canvas, context, alpha: true, antialias: true, powerPreference: 'high-performance' });
      renderer.setClearColor(0x000000, 0);
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(42, 1, 0.1, 50);
      camera.position.z = 10.5;
      const glowTexture = makeGlowTexture();
      if (glowTexture) {
        const atmosphere = new THREE.Sprite(glowMaterial(glowTexture, 'globe', 0.34));
        atmosphere.scale.setScalar(5.4);
        atmosphere.position.z = -1.6;
        orbitalSystem.add(atmosphere);
      }
      addGlobe();
      addOrbits(glowTexture);
      addStars();
      scene.add(orbitalSystem);
      updatePalette();
      fallback.style.display = 'none';
      host.dataset.ambientRenderer = 'three';
      canvas.addEventListener('webglcontextlost', onContextLost);
      canvas.addEventListener('webglcontextrestored', onContextRestored);
    } else canvas.style.display = 'none';
  } catch {
    renderer?.setAnimationLoop(null);
    renderer?.dispose();
    renderer = undefined;
    for (const geometry of geometries) geometry.dispose();
    for (const value of materials) value.dispose();
    for (const texture of textures) texture.dispose();
    geometries.clear();
    materials.clear();
    textures.clear();
    fallback.style.display = '';
    canvas.style.display = 'none';
    host.dataset.ambientRenderer = 'fallback';
  }

  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerleave', resetPointer, { passive: true });
  window.addEventListener('blur', resetPointer);
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('visibilitychange', syncPlayback);
  motionQuery.addEventListener('change', onMotionChange);
  mobileQuery.addEventListener('change', onMobileChange);
  if (window.ResizeObserver) {
    resizeObserver = new window.ResizeObserver(resize);
    resizeObserver.observe(host);
  }
  if (window.IntersectionObserver) {
    intersectionObserver = new window.IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting;
      syncPlayback();
    });
    intersectionObserver.observe(host);
  }
  resize();
  return { setTheme, setView, destroy };
}
