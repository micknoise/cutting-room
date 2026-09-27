// Wireframe world, three.js edition. Object-based, not one big bouncy
// environment: the environment (a wireframe wave-floor) is mostly just
// something to fly through at a steady, continuous drift, while discrete
// wireframe objects (polyhedra) scattered through it are what actually
// bounce/pulse with the bass, and each audio "event" (an onset detected
// from the bass band) punches out one more of them near the flight path
// that grows and dissolves. Motion trails are a GPU accumulation buffer
// (render scene -> blend with last frame -> that becomes next frame's
// "last") -- efficient, no per-object fade bookkeeping.
//
// Two inputs drive it throughout: the piece's own composed per-section
// `intensity` (a slow "designed journey" -- flight speed, object density)
// and live Web Audio frequency analysis of the actual sound (fast bass/
// mid/treble reactivity -- object bob/pulse, onset spawns). A "theme"
// (palette + which polyhedra shapes dominate) is picked per song-form
// letter and cross-fades in over ~1.2s whenever the section changes, so a
// repeated letter always gets the same world.

const THEMES = [
  { name: 'Dunes', bg: 0x0a0a0d, line: 0x9099c9, glow: 0x4a5080, shape: 0 },
  { name: 'Crystal Peaks', bg: 0x070a0d, line: 0xbfe3e0, glow: 0x3f7f78, shape: 1 },
  { name: 'Deep Canyon', bg: 0x0a0810, line: 0xa37fc9, glow: 0x4a3560, shape: 2 },
  { name: 'Frozen Ridge', bg: 0x080a0c, line: 0x9fc4d6, glow: 0x3a5566, shape: 0 },
  { name: 'Dusk Fields', bg: 0x0a0810, line: 0xb98aa0, glow: 0x5c3648, shape: 1 },
  { name: 'Still Water', bg: 0x06090a, line: 0x7fa89e, glow: 0x294844, shape: 2 },
];
const SHAPE_KINDS = ['ico', 'dodeca', 'octa'];

function lerp(a, b, t) { return a + (b - a) * t; }
function hexToRgb(hex) { return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]; }
function rgbLerpHex(hexA, hexB, t) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  const r = Math.round(lerp(a[0], b[0], t)), g = Math.round(lerp(a[1], b[1], t)), bl = Math.round(lerp(a[2], b[2], t));
  return (r << 16) | (g << 8) | bl;
}
// Deterministic string hash -> same theme for the same (genre, letter)
// every time, so a repeated song-form letter always gets the same world.
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const FLOOR_SPAN = 260;      // world units square the floor grid covers
const FLOOR_SEG = 44;        // grid divisions per side
const OBJECT_SPAN = 420;     // world-Z depth objects are spread/recycled across
const OBJECT_COUNT = 16;
const SPAWN_LIFETIME_S = 1.3;
const ONSET_RATIO = 1.32;
const ONSET_REFRACTORY_S = 0.16;

const FLOOR_VS = `
  uniform float uTime;
  uniform float uAmp;
  varying float vDist;
  float heightAt(float x, float z) {
    float v = 0.0;
    v += sin(x * 0.05 + z * 0.03 + uTime * 0.6) * 0.9;
    v += sin(x * 0.11 - z * 0.05 - uTime * 0.9) * 0.35;
    v += sin((x + z) * 0.02 + uTime * 0.25) * 1.6;
    return v * uAmp;
  }
  void main() {
    vec3 p = position;
    p.y = heightAt(p.x, p.z + uTime * 0.0);
    vDist = length((modelViewMatrix * vec4(p, 1.0)).xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
const LINE_FS = `
  precision mediump float;
  uniform vec3 uColor;
  uniform vec3 uFog;
  uniform float uFogDensity;
  varying float vDist;
  void main() {
    float fog = 1.0 - exp(-uFogDensity * vDist * vDist);
    gl_FragColor = vec4(mix(uColor, uFog, clamp(fog, 0.0, 1.0)), 1.0);
  }
`;
// Same fog treatment for ordinary (non-shader-displaced) LineSegments
// objects -- a plain onBeforeCompile-free approach: a tiny custom material
// reusing the same fragment shader, fed a flat vertex shader.
const PLAIN_VS = `
  varying float vDist;
  void main() {
    vDist = length((modelViewMatrix * vec4(position, 1.0)).xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Fullscreen accumulation/trail shader: blends the freshly rendered scene
// texture over the previous accumulated frame, fading the latter toward
// the theme background -- the trail, as one cheap full-screen pass.
const QUAD_VS = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const QUAD_FS = `
  precision mediump float;
  varying vec2 vUv;
  uniform sampler2D tPrev;
  uniform sampler2D tCur;
  uniform vec3 uBg;
  uniform float uDecay;
  void main() {
    vec3 prev = mix(uBg, texture2D(tPrev, vUv).rgb, uDecay);
    vec3 cur = texture2D(tCur, vUv).rgb;
    gl_FragColor = vec4(max(prev, cur), 1.0);
  }
`;

function makeShapeGeometry(kind, radius) {
  const src = kind === 0 ? new THREE.IcosahedronGeometry(radius, 0)
    : kind === 1 ? new THREE.DodecahedronGeometry(radius, 0)
    : new THREE.OctahedronGeometry(radius, 0);
  return new THREE.EdgesGeometry(src);
}

class Landscape {
  constructor(canvas) {
    this.canvas = canvas;
    this.audioEl = null;
    this.audioCtx = null;
    this.analyser = null;
    this.freqData = null;
    this.bass = 0; this.mid = 0; this.treble = 0;
    this.bassFast = 0; this.bassSlow = 0;
    this.lastSpawn = -Infinity;
    this.spawned = [];
    this.lastFrameTime = performance.now();
    this.flightDist = 0;

    this.track = null;
    this.sectionStarts = [];
    this.sectionThemeIdx = [];
    this.curSectionIdx = -1;
    this.themeFrom = THEMES[0];
    this.themeTo = THEMES[0];
    this.themeBlend = 1;
    this.themeBlendStart = 0;
    this.designedIntensity = 0.4;

    this._initScene();
    this._resize();
    window.addEventListener('resize', () => this._resize());
    this._raf = requestAnimationFrame((t) => this._loop(t));
  }

  _initScene() {
    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
    renderer.setClearColor(0x000000, 1);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1400);

    this.floorMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uAmp: { value: 1.0 }, uColor: { value: new THREE.Color(0xffffff) },
        uFog: { value: new THREE.Color(0x000000) }, uFogDensity: { value: 0.00006 } },
      vertexShader: FLOOR_VS, fragmentShader: LINE_FS,
    });
    this.floorMesh = new THREE.LineSegments(this._buildFloorGeometry(), this.floorMat);
    this.floorMesh.frustumCulled = false;
    this.scene.add(this.floorMesh);

    this.objectMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xffffff) }, uFog: { value: new THREE.Color(0x000000) },
        uFogDensity: { value: 0.00006 } },
      vertexShader: PLAIN_VS, fragmentShader: LINE_FS,
    });

    this.objects = [];
    for (let i = 0; i < OBJECT_COUNT; i++) this.objects.push(this._makeObject(true));

    this.spawnGroup = new THREE.Group();
    this.scene.add(this.spawnGroup);

    // Trail/accumulation buffers.
    this.sceneRT = new THREE.WebGLRenderTarget(2, 2, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.accumRT = [
      new THREE.WebGLRenderTarget(2, 2, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }),
      new THREE.WebGLRenderTarget(2, 2, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }),
    ];
    this.accumIdx = 0;
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadMat = new THREE.ShaderMaterial({
      uniforms: { tPrev: { value: null }, tCur: { value: null }, uBg: { value: new THREE.Color(0x000000) }, uDecay: { value: 0.86 } },
      vertexShader: QUAD_VS, fragmentShader: QUAD_FS, depthTest: false, depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.quadMat);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  _buildFloorGeometry() {
    const seg = FLOOR_SEG, span = FLOOR_SPAN;
    const pts = [];
    for (let i = 0; i <= seg; i++) {
      const x = (i / seg - 0.5) * span;
      pts.push(x, 0, -span / 2, x, 0, span / 2);
    }
    for (let j = 0; j <= seg; j++) {
      const z = (j / seg - 0.5) * span;
      pts.push(-span / 2, 0, z, span / 2, 0, z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return geo;
  }

  _makeObject(randomizeZ) {
    const kind = (Math.random() * 3) | 0;
    const radius = 4 + Math.random() * 9;
    const mesh = new THREE.LineSegments(makeShapeGeometry(kind, radius), this.objectMat);
    mesh.frustumCulled = false;
    mesh.userData = {
      kind,
      baseY: 6 + Math.random() * 22,
      bobAmp: 1.5 + Math.random() * 3,
      bobRate: 0.3 + Math.random() * 0.5,
      bobPhase: Math.random() * Math.PI * 2,
      spin: new THREE.Vector3((Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.25),
    };
    mesh.position.set((Math.random() - 0.5) * 140, mesh.userData.baseY,
      -(randomizeZ ? Math.random() * OBJECT_SPAN : 0));
    this.scene.add(mesh);
    return mesh;
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.floor(window.innerWidth));
    const h = Math.max(1, Math.floor(window.innerHeight));
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pw = Math.max(1, Math.floor(w * dpr)), ph = Math.max(1, Math.floor(h * dpr));
    this.sceneRT.setSize(pw, ph);
    this.accumRT[0].setSize(pw, ph);
    this.accumRT[1].setSize(pw, ph);
  }

  // Bind the single persistent <audio> element once. createMediaElementSource
  // can only be called once per element ever, and doesn't itself need a user
  // gesture (only audioCtx.resume() does), so this is safe on load.
  bindAudio(audioEl) {
    if (this.audioEl === audioEl) return;
    this.audioEl = audioEl;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AC();
    const source = this.audioCtx.createMediaElementSource(audioEl);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.6;
    source.connect(this.analyser);
    this.analyser.connect(this.audioCtx.destination);
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
  }

  resumeAudio() {
    if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume();
  }

  setTrack(track) {
    this.track = track;
    this.sectionStarts = [];
    this.sectionThemeIdx = [];
    let t = 0;
    (track.sections || []).forEach((s) => {
      this.sectionStarts.push(t);
      this.sectionThemeIdx.push(hashStr(track.genre + ':' + s.letter) % THEMES.length);
      t += s.seconds;
    });
    this.curSectionIdx = -1;
    for (const s of this.spawned) this._disposeSpawn(s);
    this.spawned = [];
    this._maybeSwitchSection(0);
  }

  _maybeSwitchSection(currentTime) {
    if (!this.sectionStarts.length) return;
    let idx = 0;
    for (let i = 0; i < this.sectionStarts.length; i++) {
      if (currentTime >= this.sectionStarts[i]) idx = i; else break;
    }
    if (idx !== this.curSectionIdx) {
      this.curSectionIdx = idx;
      const theme = THEMES[this.sectionThemeIdx[idx]];
      this.themeFrom = this._blendedThemeSnapshot();
      this.themeTo = theme;
      this.themeBlend = 0;
      this.themeBlendStart = performance.now();
      const section = this.track.sections[idx];
      this.designedIntensity = (section && typeof section.intensity === 'number') ? section.intensity : 0.4;
      const el = document.getElementById('npLandscape');
      if (el) el.textContent = theme.name;
    }
  }

  _blendedThemeSnapshot() {
    const a = this.themeFrom, b = this.themeTo, t = this.themeBlend;
    return {
      name: b.name, bg: rgbLerpHex(a.bg, b.bg, t), line: rgbLerpHex(a.line, b.line, t),
      glow: rgbLerpHex(a.glow, b.glow, t), shape: t > 0.5 ? b.shape : a.shape,
    };
  }

  _updateAudioFeatures(dt) {
    if (!this.analyser) return;
    this.analyser.getByteFrequencyData(this.freqData);
    const n = this.freqData.length;
    const bassEnd = Math.max(1, Math.floor(n * 0.12));
    const midEnd = Math.max(bassEnd + 1, Math.floor(n * 0.5));
    let bass = 0, mid = 0, treble = 0;
    for (let i = 0; i < bassEnd; i++) bass += this.freqData[i];
    for (let i = bassEnd; i < midEnd; i++) mid += this.freqData[i];
    for (let i = midEnd; i < n; i++) treble += this.freqData[i];
    bass = bass / bassEnd / 255; mid = mid / (midEnd - bassEnd) / 255; treble = treble / (n - midEnd) / 255;
    const k = 0.18;
    this.bass += (bass - this.bass) * k;
    this.mid += (mid - this.mid) * k;
    this.treble += (treble - this.treble) * k;

    this.bassFast += (bass - this.bassFast) * Math.min(1, dt * 14);
    this.bassSlow += (bass - this.bassSlow) * Math.min(1, dt * 2.2);
    const now = performance.now() / 1000;
    if (this.bassFast > this.bassSlow * ONSET_RATIO + 0.03 && this.bassFast > 0.18
        && now - this.lastSpawn > ONSET_REFRACTORY_S) {
      this.lastSpawn = now;
      this._spawnEvent();
    }
  }

  // Each audio "event" punches out a wireframe polyhedron near the flight
  // path: it grows in, then dissolves (opacity fade) and is disposed.
  _spawnEvent() {
    if (this.spawned.length > 8) this._disposeSpawn(this.spawned.shift());
    const theme = this._blendedThemeSnapshot();
    const kind = (Math.random() * 3) | 0;
    const radius = 2 + Math.random() * 2.5;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(theme.glow) }, uFog: { value: new THREE.Color(theme.bg) },
        uFogDensity: { value: 0.00006 } },
      vertexShader: PLAIN_VS, fragmentShader: LINE_FS, transparent: true,
    });
    const mesh = new THREE.LineSegments(makeShapeGeometry(kind, radius), mat);
    mesh.frustumCulled = false;
    const ahead = 40 + Math.random() * 30;
    mesh.position.set(this.camera.position.x + (Math.random() - 0.5) * 30,
      6 + Math.random() * 16, this.camera.position.z - ahead);
    mesh.scale.setScalar(0.05);
    this.spawnGroup.add(mesh);
    this.spawned.push({ mesh, mat, born: performance.now() / 1000,
      spin: new THREE.Vector3((Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2) });
  }

  _disposeSpawn(s) {
    this.spawnGroup.remove(s.mesh);
    s.mesh.geometry.dispose();
    s.mat.dispose();
  }

  _loop(now) {
    this._raf = requestAnimationFrame((t) => this._loop(t));
    const dt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;

    if (this.audioEl && this.track && !this.audioEl.paused) {
      this._maybeSwitchSection(this.audioEl.currentTime || 0);
    }
    this._updateAudioFeatures(dt);
    if (this.themeBlend < 1) this.themeBlend = Math.min(1, (now - this.themeBlendStart) / 1200);
    const theme = this._blendedThemeSnapshot();

    const energy = this.bass * 0.6 + this.mid * 0.3 + this.treble * 0.1;
    const speed = 9 + energy * 22 + this.designedIntensity * 10;
    this.flightDist += speed * dt;

    this._updateWorld(dt, now / 1000, theme, energy, speed);
    this._render(theme);
  }

  _updateWorld(dt, nowS, theme, energy, speed) {
    const cam = this.camera;
    // Continuous forward flight, with a gentle autonomous drift for an
    // organic "fly around" feel rather than a dead-straight line.
    cam.position.z = -this.flightDist;
    cam.position.x = Math.sin(nowS * 0.09) * 14 + Math.sin(nowS * 0.021) * 26;
    // Kept low and close to the floor ("eye just above the surface") --
    // at the earlier height (~8-12 units) with a shallow downward tilt,
    // the floor sat almost entirely below the visible frustum and never
    // actually showed as a grid. Low eye height + a real downward tilt is
    // what makes a wide, receding wireframe floor with objects clearly
    // floating *above* it, rather than eye-level clutter.
    cam.position.y = 3.2 + Math.sin(nowS * 0.05) * 0.6 + this.designedIntensity * 0.8;
    const lookX = cam.position.x + Math.sin(nowS * 0.09 + 0.3) * 10;
    const lookZ = cam.position.z - 60;
    cam.up.set(0, 1, 0);
    cam.lookAt(lookX, cam.position.y - 9, lookZ);

    this.floorMesh.position.z = cam.position.z;
    this.floorMesh.position.x = cam.position.x;
    this.floorMat.uniforms.uTime.value = this.flightDist * 0.05;
    this.floorMat.uniforms.uAmp.value = 0.8 + this.designedIntensity * 0.9 + this.bass * 1.4;
    this.floorMat.uniforms.uColor.value.setHex(theme.line);
    this.floorMat.uniforms.uFog.value.setHex(theme.bg);

    this.objectMat.uniforms.uColor.value.setHex(theme.line);
    this.objectMat.uniforms.uFog.value.setHex(theme.bg);

    const bounce = 0.5 + this.bass * 2.2;
    for (const o of this.objects) {
      const u = o.userData;
      o.rotation.x += u.spin.x * dt; o.rotation.y += u.spin.y * dt; o.rotation.z += u.spin.z * dt;
      o.position.y = u.baseY + Math.sin(nowS * u.bobRate + u.bobPhase) * u.bobAmp * bounce;
      // Recycle objects that have drifted behind the camera back out ahead,
      // so a fixed small pool reads as an endless field of forms.
      if (o.position.z > cam.position.z + 30) {
        o.position.z -= OBJECT_SPAN;
        o.position.x = cam.position.x + (Math.random() - 0.5) * 140;
      }
    }

    for (let i = this.spawned.length - 1; i >= 0; i--) {
      const s = this.spawned[i];
      const age = nowS - s.born;
      if (age > SPAWN_LIFETIME_S) { this._disposeSpawn(s); this.spawned.splice(i, 1); continue; }
      const growT = Math.min(1, age / 0.3);
      const grow = growT * growT * (3 - 2 * growT);
      s.mesh.scale.setScalar(0.05 + grow * 1.3);
      s.mesh.rotation.x += s.spin.x * dt; s.mesh.rotation.y += s.spin.y * dt; s.mesh.rotation.z += s.spin.z * dt;
      s.mat.opacity = age < 0.3 ? grow : 1 - (age - 0.3) / (SPAWN_LIFETIME_S - 0.3);
    }
  }

  _render(theme) {
    const renderer = this.renderer;
    renderer.autoClear = true;
    renderer.setRenderTarget(this.sceneRT);
    renderer.setClearColor(theme.bg, 1);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    const writeIdx = 1 - this.accumIdx;
    this.quadMat.uniforms.tPrev.value = this.accumRT[this.accumIdx].texture;
    this.quadMat.uniforms.tCur.value = this.sceneRT.texture;
    this.quadMat.uniforms.uBg.value.setHex(theme.bg);
    this.quadMat.uniforms.uDecay.value = 0.86;
    renderer.setRenderTarget(this.accumRT[writeIdx]);
    renderer.clear();
    renderer.render(this.quadScene, this.quadCamera);

    renderer.setRenderTarget(null);
    renderer.clear();
    // Blit: reuse the same quad material/pass with decay=0 (pure copy of
    // "cur", which is exactly what we just wrote into accumRT[writeIdx]).
    this.quadMat.uniforms.tPrev.value = this.accumRT[writeIdx].texture;
    this.quadMat.uniforms.tCur.value = this.accumRT[writeIdx].texture;
    this.quadMat.uniforms.uDecay.value = 0;
    renderer.render(this.quadScene, this.quadCamera);

    this.accumIdx = writeIdx;
  }
}

window.Landscape = Landscape;
