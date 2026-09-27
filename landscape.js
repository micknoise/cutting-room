// Wireframe world, three.js edition.
//
// Motion model: audio energy is a VELOCITY MULTIPLIER, never a bounce or
// spring. A single clock, `motionT`, accumulates every frame at a rate of
// (baseline + energy*gain) -- that's the only place live audio touches
// anything. Every animated quantity in the scene -- object rotation, an
// object's own bob/orbit/sway wander, its "dance" cycle (see below), the
// camera's orbit angle, the forward flight distance, even a spawned
// shape's grow/dissolve age -- is a fixed-amplitude function of that one
// clock (or of its per-frame delta). So louder, busier music makes
// everything play out faster -- more rotation, faster orbits, quicker
// dance cycles, a faster forward push -- and quiet music slows it all
// back down together, in lockstep, like changing a playback speed. Never
// a per-hit positional kick or amplitude pump that snaps back afterward
// -- that reads as a wobble/bounce, which is exactly what this avoids.
//
// Each pool object runs its own continuous "dance": it rotates the whole
// time, and on a per-object cycle (paced by motionT, so the cycle itself
// runs faster in energetic passages) it reshapes into a fresh wireframe
// form with a quick scale-burst "explosion" -- rotate, change shape,
// reset, repeat. The camera doesn't wander on its own axis or fake a
// roll/bank; it orbits bodily around whichever object is currently in
// focus (a literal `cam.position` revolution, re-aimed with `lookAt`
// every frame), while that focus point itself keeps marching forward
// through the world at the same energy-scaled pace as everything else.
// Audio "events" (onsets) additionally punch out extra one-shot wireframe
// shapes near the path. Motion trails are a GPU accumulation buffer
// (render scene -> blend with last frame -> that becomes next frame's
// "last") -- efficient, no per-object fade bookkeeping.
//
// A "theme" (palette + which polyhedra shapes dominate) is picked per
// song-form letter and cross-fades in over ~1.2s whenever the section
// changes; the object pool is immediately reshaped toward the incoming
// theme's shapes (see _retheme) so the cut reads as a new world right
// when the theme name does, rather than waiting on the slow natural
// reshape cadence.

// Index into SHAPE_KINDS: 0 ico, 1 dodeca, 2 octa, 3 tetra, 4 torus,
// 5 torusKnot, 6 box, 7 cone, 8 sphere, 9 cylinder, 10 ring. Each theme
// leans on a handful of these (picked most of the time, not exclusively
// -- see pickShapeKind) so a "world" reads as a coherent family of forms
// while still surprising you.
const THEMES = [
  { name: 'Dunes', bg: 0x0a0a0d, line: 0x9099c9, glow: 0x4a5080, shapes: [0, 7, 3, 9] },
  { name: 'Crystal Peaks', bg: 0x070a0d, line: 0xbfe3e0, glow: 0x3f7f78, shapes: [0, 2, 5, 10] },
  { name: 'Deep Canyon', bg: 0x0a0810, line: 0xa37fc9, glow: 0x4a3560, shapes: [1, 6, 3, 9] },
  { name: 'Frozen Ridge', bg: 0x080a0c, line: 0x9fc4d6, glow: 0x3a5566, shapes: [2, 3, 4, 8] },
  { name: 'Dusk Fields', bg: 0x0a0810, line: 0xb98aa0, glow: 0x5c3648, shapes: [4, 7, 1, 10] },
  { name: 'Still Water', bg: 0x06090a, line: 0x7fa89e, glow: 0x294844, shapes: [5, 4, 0, 8] },
];
const SHAPE_KINDS = ['ico', 'dodeca', 'octa', 'tetra', 'torus', 'torusKnot', 'box', 'cone', 'sphere', 'cylinder', 'ring'];
function pickShapeKind(theme) {
  if (theme && theme.shapes && theme.shapes.length && Math.random() < 0.7) {
    return theme.shapes[(Math.random() * theme.shapes.length) | 0];
  }
  return (Math.random() * SHAPE_KINDS.length) | 0;
}

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
const SPAWN_LIFETIME_M = 0.6;   // in motion-clock units, not seconds -- see header
const ONSET_RATIO = 1.32;
const ONSET_REFRACTORY_S = 0.14;
const FOCUS_AHEAD = 46;      // world units the camera's orbit pivot sits ahead of the flight position
const ORBIT_RATE = 0.8;      // camera orbit angular speed per motion-clock unit

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
  let src;
  switch (kind) {
    case 0: src = new THREE.IcosahedronGeometry(radius, 0); break;
    case 1: src = new THREE.DodecahedronGeometry(radius, 0); break;
    case 2: src = new THREE.OctahedronGeometry(radius, 0); break;
    case 3: src = new THREE.TetrahedronGeometry(radius, 0); break;
    case 4: src = new THREE.TorusGeometry(radius * 0.8, radius * 0.28, 6, 14); break;
    case 5: src = new THREE.TorusKnotGeometry(radius * 0.55, radius * 0.16, 48, 6, 2, 3); break;
    case 6: src = new THREE.BoxGeometry(radius * 1.3, radius * 1.3, radius * 1.3); break;
    case 7: src = new THREE.ConeGeometry(radius * 0.85, radius * 1.8, 6); break;
    case 8: src = new THREE.SphereGeometry(radius * 0.85, 10, 7); break;
    case 9: src = new THREE.CylinderGeometry(radius * 0.7, radius * 0.7, radius * 1.6, 8); break;
    default: src = new THREE.RingGeometry(radius * 0.4, radius * 0.85, 12, 1); break;
  }
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

    // The single shared clock: everything animated reads its phase from
    // this (or from its per-frame delta, dMotion) instead of wall time,
    // so "louder = faster" applies uniformly. See header comment.
    this.motionT = 0;

    this.focusObj = null;
    this.focusRetargetAt = 0;

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
    const startTheme = this._blendedThemeSnapshot();
    for (let i = 0; i < OBJECT_COUNT; i++) this.objects.push(this._makeObject(true, startTheme));

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

  // Each object gets one of four independent wander behaviors for
  // positional variety, PLUS -- independent of that -- its own "dance"
  // cycle (cycleLen/cycleOffset/lastCycleIdx): a fixed-amplitude,
  // motionT-paced loop of continuous rotation, a periodic reshape into a
  // fresh form, and a quick scale-burst around each reshape. Both are
  // fixed-amplitude functions of the shared clock -- never audio
  // amplitude directly -- so the music's energy only ever changes how
  // fast the loop plays, not how far anything swings.
  _makeObject(randomizeZ, theme) {
    const kind = pickShapeKind(theme);
    const radius = 4 + Math.random() * 9;
    const mesh = new THREE.LineSegments(makeShapeGeometry(kind, radius), this.objectMat);
    mesh.frustumCulled = false;
    const baseX = (Math.random() - 0.5) * 140;
    const behaviors = ['bob', 'orbit', 'sway', 'still'];
    mesh.userData = {
      kind,
      baseX, centerX: baseX,
      baseY: 6 + Math.random() * 22,
      bobAmp: 1.5 + Math.random() * 3,
      bobRate: 0.3 + Math.random() * 0.5,
      bobPhase: Math.random() * Math.PI * 2,
      behavior: behaviors[(Math.random() * behaviors.length) | 0],
      orbitRadius: 8 + Math.random() * 20,
      orbitRate: 0.15 + Math.random() * 0.35,
      swayAmp: 8 + Math.random() * 16,
      swayRate: 0.08 + Math.random() * 0.22,
      spin: new THREE.Vector3((Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5),
      cycleLen: 1.3 + Math.random() * 2.4,
      cycleOffset: Math.random(),
      lastCycleIdx: 0,
      orbitCamR: 24 + Math.random() * 16,
    };
    mesh.position.set(baseX, mesh.userData.baseY,
      -(randomizeZ ? Math.random() * OBJECT_SPAN : 0));
    this.scene.add(mesh);
    return mesh;
  }

  _reshapeObject(o, theme) {
    const u = o.userData;
    o.geometry.dispose();
    u.kind = pickShapeKind(theme);
    const radius = 4 + Math.random() * 9;
    o.geometry = makeShapeGeometry(u.kind, radius);
  }

  // Recycling alone (an object drifting past the camera and being pushed
  // back out ahead) would take up to OBJECT_SPAN/speed seconds -- tens of
  // seconds -- to visit every object, far too slow for a section change
  // to actually look different. Reshape most of the pool immediately and
  // punctuate the cut with a small spawn burst.
  _retheme(theme) {
    for (const o of this.objects) {
      if (Math.random() < 0.8) this._reshapeObject(o, theme);
    }
    const bursts = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < bursts; i++) this._spawnEvent(theme);
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
      this._retheme(theme);
    }
  }

  _blendedThemeSnapshot() {
    const a = this.themeFrom, b = this.themeTo, t = this.themeBlend;
    return {
      name: b.name, bg: rgbLerpHex(a.bg, b.bg, t), line: rgbLerpHex(a.line, b.line, t),
      glow: rgbLerpHex(a.glow, b.glow, t), shapes: t > 0.5 ? b.shapes : a.shapes,
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
      // Onsets only ever spawn extra one-shot geometry -- never touch the
      // camera or any continuous position/scale. A strong hit just spawns
      // more of them at once ("more geometry explosions"), it doesn't
      // shove anything.
      const strength = Math.min(1, (this.bassFast - this.bassSlow) * 2.2);
      this._spawnEvent();
      if (strength > 0.55) this._spawnEvent();
      if (strength > 0.85) this._spawnEvent();
    }
  }

  // Each audio "event" punches out a wireframe polyhedron near the flight
  // path: it grows in, then dissolves (opacity fade) and is disposed. Its
  // whole life is timed in motion-clock units (bornMotion/age), so it
  // lives through the same number of "beats" of animation regardless of
  // how fast or slow the music has the clock running -- just compressed
  // or stretched in real seconds.
  _spawnEvent(themeOverride) {
    if (this.spawned.length > 14) this._disposeSpawn(this.spawned.shift());
    const theme = themeOverride || this._blendedThemeSnapshot();
    const kind = pickShapeKind(theme);
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
    this.spawned.push({ mesh, mat, bornMotion: this.motionT,
      // Drift sideways as it grows, so a burst doesn't read as several
      // copies of the same shape pinned to one spot.
      drift: (Math.random() - 0.5) * 10,
      spin: new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3) });
  }

  _disposeSpawn(s) {
    this.spawnGroup.remove(s.mesh);
    s.mesh.geometry.dispose();
    s.mat.dispose();
  }

  // Pick a fresh camera focus from the pool -- any object works, since
  // _updateWorld pins the focused object's depth to the advancing orbit
  // pivot and gives it a clean, near-centered horizontal placement the
  // moment it's picked (see below), rather than requiring it to already
  // happen to be well positioned.
  _pickFocusObject() {
    const pool = this.objects;
    let next = pool[(Math.random() * pool.length) | 0];
    if (pool.length > 1) {
      let guard = 0;
      while (next === this.focusObj && guard++ < 5) next = pool[(Math.random() * pool.length) | 0];
    }
    return next;
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

    // The only place live audio energy touches anything: how fast the
    // shared motion clock runs. Everything else below reads its phase
    // from motionT/dMotion at fixed amplitude.
    const energy = this.bass * 0.6 + this.mid * 0.3 + this.treble * 0.1;
    const motionRate = 0.35 + energy * 1.7 + this.designedIntensity * 0.25;
    const dMotion = dt * motionRate;
    this.motionT += dMotion;
    this.flightDist += dMotion * 46;

    this._updateWorld(dt, dMotion, theme, energy);
    this._render(theme);
  }

  _updateWorld(dt, dMotion, theme, energy) {
    const cam = this.camera;
    const motionT = this.motionT;

    // Camera: a literal orbit around whichever object is currently in
    // focus, re-aimed with lookAt every frame -- never a self-roll/bank
    // on the camera's own axis. The orbit pivot marches forward through
    // the world at the same energy-scaled pace as the forward flight, so
    // "focus" and "push forward" and "round" all happen at once: the
    // camera circles a subject that is itself continuously advancing.
    const pivotZ = -this.flightDist - FOCUS_AHEAD;
    if (!this.focusObj || motionT > this.focusRetargetAt) {
      this.focusObj = this._pickFocusObject();
      const u = this.focusObj.userData;
      u.centerX = (Math.random() - 0.5) * 26;
      u.baseX = u.centerX;
      u.orbitCamR = 22 + Math.random() * 16;
      this.focusRetargetAt = motionT + 2.4 + Math.random() * 1.8;
    }
    const focus = this.focusObj;
    const R = focus.userData.orbitCamR;
    const orbitAngle = motionT * ORBIT_RATE;
    const fx = focus.position.x, fy = focus.position.y + 2, fz = pivotZ;
    cam.position.set(fx + Math.cos(orbitAngle) * R, fy + 6 + Math.sin(motionT * 0.12) * 2, fz + Math.sin(orbitAngle) * R);
    cam.up.set(0, 1, 0);
    cam.lookAt(fx, fy, fz);

    this.floorMesh.position.z = cam.position.z;
    this.floorMesh.position.x = cam.position.x;
    this.floorMat.uniforms.uTime.value = this.flightDist * 0.05;
    this.floorMat.uniforms.uAmp.value = 0.8 + this.designedIntensity * 0.9;
    this.floorMat.uniforms.uColor.value.setHex(theme.line);
    this.floorMat.uniforms.uFog.value.setHex(theme.bg);

    this.objectMat.uniforms.uColor.value.setHex(theme.line);
    this.objectMat.uniforms.uFog.value.setHex(theme.bg);

    for (const o of this.objects) {
      const u = o.userData;

      // Continuous rotation -- the "dance" never stops, it just plays
      // faster or slower with dMotion (which is itself energy-scaled).
      o.rotation.x += u.spin.x * dMotion;
      o.rotation.y += u.spin.y * dMotion;
      o.rotation.z += u.spin.z * dMotion;

      if (u.behavior === 'orbit') {
        o.position.x = u.centerX + Math.cos(motionT * u.orbitRate + u.bobPhase) * u.orbitRadius;
        o.position.y = u.baseY + Math.sin(motionT * u.orbitRate + u.bobPhase) * u.orbitRadius * 0.4;
      } else if (u.behavior === 'sway') {
        o.position.x = u.baseX + Math.sin(motionT * u.swayRate + u.bobPhase) * u.swayAmp;
        o.position.y = u.baseY + Math.sin(motionT * u.bobRate + u.bobPhase) * u.bobAmp * 0.6;
      } else if (u.behavior === 'still') {
        o.position.x = u.baseX;
        o.position.y = u.baseY;
      } else {
        o.position.x = u.baseX;
        o.position.y = u.baseY + Math.sin(motionT * u.bobRate + u.bobPhase) * u.bobAmp;
      }

      // The dance cycle: purely a function of motionT, so it needs no
      // per-hit trigger or spring state. Crossing into a new cycle count
      // reshapes the object; a short window right after that is a smooth
      // scale-burst "explosion" -- rotate, change shape, reset, repeat.
      const cycleVal = motionT / u.cycleLen + u.cycleOffset;
      const cycleIdx = Math.floor(cycleVal);
      const cyclePos = cycleVal - cycleIdx;
      if (cycleIdx !== u.lastCycleIdx) {
        u.lastCycleIdx = cycleIdx;
        this._reshapeObject(o, theme);
      }
      const burstWindow = 0.18;
      o.scale.setScalar(cyclePos < burstWindow ? 1 + Math.sin((cyclePos / burstWindow) * Math.PI) * 0.8 : 1);

      if (o === focus) {
        // Pinned to the advancing orbit pivot instead of the ordinary
        // recycle logic below -- it's the camera's subject, so its depth
        // is what "pushing forward" is measured against, not the other
        // way around.
        o.position.z = pivotZ;
      } else if (o.position.z > cam.position.z + 30) {
        // Recycle objects that have drifted behind the camera back out
        // ahead, so a fixed small pool reads as an endless field of forms.
        o.position.z -= OBJECT_SPAN;
        u.baseX = cam.position.x + (Math.random() - 0.5) * 150;
        u.centerX = u.baseX;
      }
    }

    for (let i = this.spawned.length - 1; i >= 0; i--) {
      const s = this.spawned[i];
      const age = motionT - s.bornMotion;
      if (age > SPAWN_LIFETIME_M) { this._disposeSpawn(s); this.spawned.splice(i, 1); continue; }
      const growWindow = SPAWN_LIFETIME_M * 0.25;
      const growT = Math.min(1, age / growWindow);
      const grow = growT * growT * (3 - 2 * growT);
      s.mesh.scale.setScalar(0.05 + grow * 1.3);
      s.mesh.position.x += s.drift * dMotion;
      s.mesh.rotation.x += s.spin.x * dMotion; s.mesh.rotation.y += s.spin.y * dMotion; s.mesh.rotation.z += s.spin.z * dMotion;
      s.mat.opacity = age < growWindow ? grow : 1 - (age - growWindow) / (SPAWN_LIFETIME_M - growWindow);
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
