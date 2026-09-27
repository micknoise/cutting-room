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
//
// Two more things read directly from the track's own data, not just live
// signal analysis:
//  - Tempo: every track carries a BPM. A beat clock (beatCount/beatPhase)
//    is derived straight from audioEl.currentTime * bpm/60 -- real musical
//    time, not the motion clock -- and the pool's reshape/explosion
//    events + the camera's focus changes are quantized to it (each object
//    reshapes on its own beat-multiple, staggered across the pool; focus
//    changes every 2 bars), so the big visual changes land ON the beat.
//    The shared motion clock's own rate is additionally scaled by
//    bpm/110, so a fast track feels more urgent throughout, not only at
//    the quantized events.
//  - Spectrum: each object's own wireframe is continuously displaced
//    along its own vertex-from-center direction by a 64-band log-spaced
//    FFT texture (see OBJECT_VS/uFFT) -- so the actual shape of every
//    polyhedron is sculpted by the music's real spectral content every
//    frame, not just its 3-band bass/mid/treble energy average. A slow
//    real-time UV drift keeps the same audio from always deforming the
//    same vertices, so it never settles into a static "ready position".
//  - Onsets additionally reroll a random subset of the pool's spin
//    vectors each hit, so rotation direction/speed keeps changing instead
//    of grinding on in one fixed direction all track.

// Index into SHAPE_KINDS: 0 ico, 1 dodeca, 2 octa, 3 tetra, 4 torus,
// 5 torusKnot, 6 box, 7 cone, 8 sphere, 9 cylinder, 10 ring. Each theme
// leans on a handful of these (picked most of the time, not exclusively
// -- see pickShapeKind) so a "world" reads as a coherent family of forms
// while still surprising you.
// Each theme now owns a genuinely distinct hue (not just a slightly
// different shade of dark blue-grey), a near-exclusive shape family (no
// two themes share a shape kind, so silhouettes alone tell them apart),
// and its own floor character -- a frequency multiplier on the terrain's
// heightfield (broad slow dunes vs. choppy ridges) and its own fog
// density (clear vs. hazy). Color, shape family, AND environment texture
// all changing together is what makes a theme switch read as an actually
// different "landscape" rather than a slightly-different tint.
const THEMES = [
  { name: 'Dunes', bg: 0x0a0806, line: 0xd9a463, glow: 0x8a5a25, shapes: [3, 7], floorFreq: 0.7, fog: 0.00005 },
  { name: 'Crystal Peaks', bg: 0x060a0c, line: 0x7fe0e8, glow: 0x2f8a92, shapes: [0, 2], floorFreq: 1.45, fog: 0.00004 },
  { name: 'Deep Canyon', bg: 0x0a0610, line: 0xc86bdc, glow: 0x6b2b7a, shapes: [1, 6], floorFreq: 1.0, fog: 0.00009 },
  { name: 'Frozen Ridge', bg: 0x06080c, line: 0xaad4ff, glow: 0x3f6fa0, shapes: [4, 10], floorFreq: 1.2, fog: 0.00006 },
  { name: 'Dusk Fields', bg: 0x0a0608, line: 0xe0708a, glow: 0x8a2f42, shapes: [5, 9], floorFreq: 0.85, fog: 0.00008 },
  { name: 'Still Water', bg: 0x060a08, line: 0x7fe0a8, glow: 0x2f8a58, shapes: [8], floorFreq: 0.5, fog: 0.00005 },
];
const SHAPE_KINDS = ['ico', 'dodeca', 'octa', 'tetra', 'torus', 'torusKnot', 'box', 'cone', 'sphere', 'cylinder', 'ring'];
function pickShapeKind(theme) {
  if (theme && theme.shapes && theme.shapes.length && Math.random() < 0.88) {
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
const FOCUS_BEATS = 8;       // camera cuts to a new focus object every 2 bars (4/4 assumed)
const REF_BPM = 110;         // reference tempo the base motion rate is tuned around

const FLOOR_VS = `
  uniform float uTime;
  uniform float uAmp;
  uniform float uFreqMul;
  varying float vDist;
  float heightAt(float x, float z) {
    float fx = x * uFreqMul, fz = z * uFreqMul;
    float v = 0.0;
    v += sin(fx * 0.05 + fz * 0.03 + uTime * 0.6) * 0.9;
    v += sin(fx * 0.11 - fz * 0.05 - uTime * 0.9) * 0.35;
    v += sin((fx + fz) * 0.02 + uTime * 0.25) * 1.6;
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
// Object wireframes: same fog treatment as the floor, plus the actual
// "geometry shifts with the audio analysis" mechanism. Each vertex is
// pushed out along its own direction from the object's center (a
// perfectly good pseudo-normal for a shape centered at the origin) by an
// amount sampled from a 64-band FFT texture -- and *which* band a given
// vertex samples depends on its own angle/radius around the shape, so
// different parts of the same polyhedron visibly respond to different
// parts of the spectrum. uTime drifts that sampling slowly in real time
// so a repeated audio snapshot doesn't always deform the same vertices.
const OBJECT_VS = `
  uniform sampler2D uFFT;
  uniform float uDeform;
  uniform float uTime;
  varying float vDist;
  void main() {
    float len = length(position) + 0.0001;
    vec3 dir = position / len;
    float ang = atan(position.z, position.x);
    float uvCoord = fract(ang * 0.15915 + len * 0.02 + uTime * 0.015);
    float mag = texture2D(uFFT, vec2(uvCoord, 0.5)).r;
    vec3 displaced = position + dir * mag * uDeform;
    vDist = length((modelViewMatrix * vec4(displaced, 1.0)).xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
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
    this.lastFocusBeat = -FOCUS_BEATS;
    this.orbitAngle = 0;
    this.orbitDir = 1;

    // Beat clock, derived from the track's own BPM + real playback time
    // (not the motion clock) -- see header comment.
    this.beatCount = 0;
    this.beatPhase = 0;

    // 64-band log-spaced FFT texture sampled by OBJECT_VS to deform every
    // wireframe's actual vertices. Built once; only its contents change
    // (see _updateAudioFeatures), so no material ever needs to reassign
    // the texture reference itself.
    this.FFT_TEX_BINS = 64;
    this.fftArray = new Float32Array(this.FFT_TEX_BINS);
    this.fftTexture = new THREE.DataTexture(this.fftArray, this.FFT_TEX_BINS, 1, THREE.RedFormat, THREE.FloatType);
    this.fftTexture.magFilter = THREE.LinearFilter;
    this.fftTexture.minFilter = THREE.LinearFilter;
    this.fftTexture.needsUpdate = true;

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
      uniforms: { uTime: { value: 0 }, uAmp: { value: 1.0 }, uFreqMul: { value: 1.0 }, uColor: { value: new THREE.Color(0xffffff) },
        uFog: { value: new THREE.Color(0x000000) }, uFogDensity: { value: 0.00006 } },
      vertexShader: FLOOR_VS, fragmentShader: LINE_FS,
    });
    this.floorMesh = new THREE.LineSegments(this._buildFloorGeometry(), this.floorMat);
    this.floorMesh.frustumCulled = false;
    this.scene.add(this.floorMesh);

    this.objectMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xffffff) }, uFog: { value: new THREE.Color(0x000000) },
        uFogDensity: { value: 0.00006 }, uFFT: { value: this.fftTexture }, uDeform: { value: 1.1 }, uTime: { value: 0 } },
      vertexShader: OBJECT_VS, fragmentShader: LINE_FS,
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
  // positional variety, PLUS -- independent of that -- its own "dance":
  // continuous rotation, and a reshape-with-scale-burst quantized to its
  // own beat multiple (beatPeriod/beatOffset/lastReshapeBeat) so it lands
  // precisely on the track's actual tempo grid, staggered across the pool
  // so objects don't all pop on the same beat. Rotation and wander stay
  // fixed-amplitude functions of the motion clock -- the reshape is what's
  // locked to musical time instead.
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
      // Speed and direction are tracked separately (spinBase always
      // positive, spinSign is the actual ±1 direction per axis) so a
      // "direction change" can be a plain sign flip -- a visible reversal
      // -- rather than a reroll to a new random vector that might
      // coincidentally look like more of the same.
      spinBase: new THREE.Vector3(0.6 + Math.random() * 2.4, 0.6 + Math.random() * 2.4, 0.6 + Math.random() * 2.4),
      spinSign: new THREE.Vector3(Math.random() < 0.5 ? -1 : 1, Math.random() < 0.5 ? -1 : 1, Math.random() < 0.5 ? -1 : 1),
      beatPeriod: [2, 4, 8][(Math.random() * 3) | 0],
      beatOffset: 0,
      lastReshapeBeat: -1,
      orbitCamR: 24 + Math.random() * 16,
    };
    mesh.userData.beatOffset = (Math.random() * mesh.userData.beatPeriod) | 0;
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
      floorFreq: lerp(a.floorFreq, b.floorFreq, t), fog: lerp(a.fog, b.fog, t),
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
      // Flip rotation direction -- all three axes together, not each
      // independently -- on a random subset of the pool on every hit.
      // Flipping axes independently could still leave the strongest axis
      // (the one that actually dominates how the tumble reads) pointing
      // the same way as before, which is exactly why this kept looking
      // like "still just spinning one way": a partial flip is invisible.
      // A whole-object flip is what actually reverses the visible tumble.
      for (const o of this.objects) {
        if (Math.random() < 0.4) {
          const u = o.userData;
          u.spinSign.x *= -1; u.spinSign.y *= -1; u.spinSign.z *= -1;
        }
      }
    }

    // Full-spectrum, log-frequency-spaced deformation texture: every
    // wireframe's own vertex shader (OBJECT_VS) samples this, so the
    // actual shape of every object is continuously sculpted by the real
    // spectral content, not just the coarse 3-band energy above.
    const sampleRate = (this.audioCtx && this.audioCtx.sampleRate) || 44100;
    const nyquist = sampleRate / 2;
    let peak = 0;
    for (let i = 0; i < n; i++) if (this.freqData[i] > peak) peak = this.freqData[i];
    if (peak > 6) {
      const logMin = Math.log2(40), logMax = Math.log2(9000);
      for (let kIdx = 0; kIdx < this.FFT_TEX_BINS; kIdx++) {
        const t = kIdx / (this.FFT_TEX_BINS - 1);
        const freq = Math.pow(2, logMin + t * (logMax - logMin));
        const binIdx = Math.min(n - 1, Math.floor((freq / nyquist) * n));
        // Temporally smoothed (blended toward the new reading rather than
        // snapped to it) so the deformation flows/breathes with the sound
        // instead of flickering to a new noise pattern every frame.
        const raw = this.freqData[binIdx] / 255;
        this.fftArray[kIdx] += (raw - this.fftArray[kIdx]) * 0.3;
      }
    } else {
      for (let kIdx = 0; kIdx < this.FFT_TEX_BINS; kIdx++) this.fftArray[kIdx] *= 0.85;
    }
    this.fftTexture.needsUpdate = true;
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
        uFogDensity: { value: theme.fog || 0.00006 }, uFFT: { value: this.fftTexture }, uDeform: { value: 0.8 }, uTime: { value: 0 } },
      vertexShader: OBJECT_VS, fragmentShader: LINE_FS, transparent: true,
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

    // Nothing here should move when there's no audio actually playing --
    // "constant motion" (see header) was always about not going dead
    // during a quiet passage of a *playing* track, never about animating
    // with no sound at all. So: no audio features, no motion-clock
    // advance, no rotation, no camera orbit, no shape deformation change
    // while paused/idle -- the whole scene just sits exactly as it was.
    const playing = !!(this.audioEl && this.track && !this.audioEl.paused);
    const currentTime = (this.audioEl && this.track) ? (this.audioEl.currentTime || 0) : 0;
    if (playing) {
      this._maybeSwitchSection(currentTime);
      this._updateAudioFeatures(dt);
    }
    if (this.themeBlend < 1) this.themeBlend = Math.min(1, (now - this.themeBlendStart) / 1200);
    const theme = this._blendedThemeSnapshot();

    // Tempo: a beat clock derived straight from the track's own BPM and
    // real playback position, independent of the motion clock -- see
    // header comment. Falls back to a plausible default before a track's
    // BPM is known so nothing divides by zero. Freezes on its own while
    // paused, since currentTime itself doesn't advance.
    const bpm = (this.track && this.track.bpm) || REF_BPM;
    const beatSec = 60 / bpm;
    this.beatCount = Math.floor(currentTime / beatSec);
    this.beatPhase = currentTime / beatSec - this.beatCount;

    // The only place live audio energy touches anything continuous: how
    // fast the shared motion clock runs -- additionally scaled by tempo,
    // so a fast track feels more urgent throughout. Everything below
    // reads its phase from motionT/dMotion at fixed amplitude. Zero while
    // not playing, so motionT/flightDist simply hold their value.
    const energy = playing ? (this.bass * 0.6 + this.mid * 0.3 + this.treble * 0.1) : 0;
    const bpmRatio = bpm / REF_BPM;
    // Measured across real playback, energy typically runs ~0.17 (quiet)
    // to ~0.61 (loud). A 0.35 baseline swamped that range (quiet-vs-loud
    // was under 2x); a lower baseline with a bigger energy weight gives a
    // clearly perceptible ~3x swing so the whole scene's pace visibly
    // tracks the music instead of just gently drifting with it.
    const motionRate = playing ? (0.12 + energy * 2.8 + this.designedIntensity * 0.2) * bpmRatio : 0;
    const dMotion = dt * motionRate;
    this.motionT += dMotion;
    this.flightDist += dMotion * 46;

    if (playing) {
      this.objectMat.uniforms.uTime.value = now / 1000;
      this.objectMat.uniforms.uDeform.value = 0.9 + this.designedIntensity * 1.0;
    }

    this._updateWorld(dt, dMotion, theme, energy);
    this._render(theme);
  }

  _updateWorld(dt, dMotion, theme, energy) {
    const cam = this.camera;
    const motionT = this.motionT;
    const beatCount = this.beatCount, beatPhase = this.beatPhase;

    // Camera: a literal orbit around whichever object is currently in
    // focus, re-aimed with lookAt every frame -- never a self-roll/bank
    // on the camera's own axis. The orbit pivot marches forward through
    // the world at the same energy-scaled pace as the forward flight, so
    // "focus" and "push forward" and "round" all happen at once: the
    // camera circles a subject that is itself continuously advancing.
    const pivotZ = -this.flightDist - FOCUS_AHEAD;
    if (!this.focusObj || beatCount - this.lastFocusBeat >= FOCUS_BEATS) {
      this.focusObj = this._pickFocusObject();
      const u = this.focusObj.userData;
      u.centerX = (Math.random() - 0.5) * 26;
      u.baseX = u.centerX;
      u.orbitCamR = 22 + Math.random() * 16;
      this.lastFocusBeat = beatCount;
      // The orbit direction itself never used to change -- orbitAngle was
      // derived straight from motionT*ORBIT_RATE, a value that only ever
      // grows, so the camera circled the same rotational way forever; a
      // focus change only ever looked like a teleport to a new position
      // that then kept circling exactly as before. Flipping the direction
      // here, on the same "reset" moment the subject changes, is what
      // actually varies it.
      this.orbitDir *= -1;
    }
    const focus = this.focusObj;
    const R = focus.userData.orbitCamR;
    // Accumulated from dMotion*direction each frame (not derived from
    // motionT directly), so a direction flip changes which way the angle
    // moves from here on rather than snapping the whole angle to a
    // mirrored value.
    this.orbitAngle += dMotion * ORBIT_RATE * this.orbitDir;
    const orbitAngle = this.orbitAngle;
    const fx = focus.position.x, fy = focus.position.y + 2, fz = pivotZ;
    cam.position.set(fx + Math.cos(orbitAngle) * R, fy + 6 + Math.sin(motionT * 0.12) * 2, fz + Math.sin(orbitAngle) * R);
    cam.up.set(0, 1, 0);
    cam.lookAt(fx, fy, fz);

    this.floorMesh.position.z = cam.position.z;
    this.floorMesh.position.x = cam.position.x;
    this.floorMat.uniforms.uTime.value = this.flightDist * 0.05;
    this.floorMat.uniforms.uAmp.value = 0.8 + this.designedIntensity * 0.9;
    this.floorMat.uniforms.uFreqMul.value = theme.floorFreq;
    this.floorMat.uniforms.uFogDensity.value = theme.fog;
    this.floorMat.uniforms.uColor.value.setHex(theme.line);
    this.floorMat.uniforms.uFog.value.setHex(theme.bg);

    this.objectMat.uniforms.uFogDensity.value = theme.fog;
    this.objectMat.uniforms.uColor.value.setHex(theme.line);
    this.objectMat.uniforms.uFog.value.setHex(theme.bg);

    // Rotation's own speed kicker: dMotion already carries the slow
    // ambient energy contour (see header), but that's smoothed enough
    // that a viewer can't feel it tracking the actual music. Layering the
    // FAST bass envelope in as a direct multiplier makes every hit
    // visibly surge the tumble and let it settle back between hits --
    // the part that actually reads as "responding to the music".
    const rotKick = 1 + this.bassFast * 4.5;

    for (const o of this.objects) {
      const u = o.userData;

      // Continuous rotation -- the "dance" never stops, it just plays
      // faster or slower with dMotion (which is itself energy-scaled) and
      // surges further with rotKick on top.
      o.rotation.x += u.spinBase.x * u.spinSign.x * dMotion * rotKick;
      o.rotation.y += u.spinBase.y * u.spinSign.y * dMotion * rotKick;
      o.rotation.z += u.spinBase.z * u.spinSign.z * dMotion * rotKick;

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

      // The dance's reshape/explosion is quantized to this object's own
      // beat multiple (staggered via beatOffset so the pool doesn't all
      // pop on the same beat) -- landing on the track's real tempo grid --
      // but ONLY actually fires once there's real energy above the local
      // baseline right then (hasNoise), not on a bare metronome: a
      // schedule with nothing behind it read as things shifting for no
      // audible reason. It keeps checking every frame while the scheduled
      // beat is current, so it fires the moment a hit lands within that
      // beat, or simply sits out a beat with no real hit in it at all.
      const hasNoise = this.bassFast > this.bassSlow * 1.12 + 0.015 && this.bassFast > 0.08;
      if (beatCount >= 0 && (beatCount - u.beatOffset) % u.beatPeriod === 0 && beatCount !== u.lastReshapeBeat && hasNoise) {
        u.lastReshapeBeat = beatCount;
        this._reshapeObject(o, theme);
        const behaviors = ['bob', 'orbit', 'sway', 'still'];
        u.behavior = behaviors[(Math.random() * behaviors.length) | 0];
        // A reshape is a "reset" -- give it a fresh rotation speed, and
        // make the direction change definite rather than a coin flip.
        u.spinBase.set(0.6 + Math.random() * 2.4, 0.6 + Math.random() * 2.4, 0.6 + Math.random() * 2.4);
        u.spinSign.x *= -1; u.spinSign.y *= -1; u.spinSign.z *= -1;
        // The burst alone wasn't always noticeable -- punctuate the
        // reshape with a couple of extra one-shot shapes appearing right
        // at the object, so the moment reads as a small event, not just a
        // silhouette quietly changing.
        this._spawnEvent(theme);
        if (Math.random() < 0.5) this._spawnEvent(theme);
      }
      // Scale-burst envelope, 2.5x bigger peak and a longer window than
      // the original pass -- that one was too subtle to register as an
      // "explosion" against the object's base size.
      const beatsSinceReshape = (beatCount - u.lastReshapeBeat) + beatPhase;
      const burstWindow = 0.55;
      o.scale.setScalar(beatsSinceReshape < burstWindow ? 1 + Math.sin(Math.min(1, beatsSinceReshape / burstWindow) * Math.PI) * 2.0 : 1);

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
