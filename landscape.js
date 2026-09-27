// Wireframe landscape, WebGL edition. Two things happen every frame:
//  1. A perspective wireframe terrain grid (heightmap = a sum of travelling
//     sine waves -- cheap, dependency-free, no noise library) scrolls
//     toward the viewer forever.
//  2. Audio "events" (onsets detected from the bass band -- a fast/slow
//     energy envelope crossing a threshold) each punch out a expanding
//     wireframe ring entity that grows, rotates and fades.
// Both are just line segments -- the whole scene is ONE gl.LINES draw call
// a frame. Motion trails are a GPU feedback effect (ping-pong framebuffers:
// each frame, the previous frame's texture is faded toward the theme
// background and the new lines are drawn additively on top), not a
// per-object fade, so it's essentially free.
//
// Two inputs drive the terrain: the piece's own composed per-section
// `intensity` (a slow "designed journey") and live Web Audio frequency
// analysis of the actual sound (fast bass/mid/treble reactivity). A
// "theme" (palette + terrain shape) is picked per song-form letter and
// cross-fades in over ~1.2s whenever the section changes, so a repeated
// letter always gets the same landscape.

const THEMES = [
  { name: 'Dunes', bg: '#0a0a0d', line: '#9099c9', glow: '#4a5080',
    octaves: [[0.05, 0.9, 0.6], [0.11, 0.35, -0.9], [0.021, 1.6, 0.25]], shape: 'identity', base: 0.0 },
  { name: 'Crystal Peaks', bg: '#070a0d', line: '#bfe3e0', glow: '#3f7f78',
    octaves: [[0.07, 1.1, 0.5], [0.16, 0.6, -0.7], [0.033, 0.8, 0.3]], shape: 'abs', base: 0.15 },
  { name: 'Deep Canyon', bg: '#0a0810', line: '#a37fc9', glow: '#4a3560',
    octaves: [[0.045, 1.3, 0.4], [0.09, 0.5, 0.8], [0.02, 0.7, -0.2]], shape: 'negabs', base: -0.1 },
  { name: 'Frozen Ridge', bg: '#080a0c', line: '#9fc4d6', glow: '#3a5566',
    octaves: [[0.06, 0.7, 0.35], [0.13, 0.45, -0.55], [0.028, 1.1, 0.15]], shape: 'identity', base: 0.05 },
  { name: 'Dusk Fields', bg: '#0a0810', line: '#b98aa0', glow: '#5c3648',
    octaves: [[0.08, 0.5, 0.7], [0.19, 0.3, -1.0], [0.04, 0.9, 0.4]], shape: 'abs', base: 0.0 },
  { name: 'Still Water', bg: '#06090a', line: '#7fa89e', glow: '#294844',
    octaves: [[0.03, 1.4, 0.2], [0.065, 0.5, 0.35], [0.14, 0.15, -0.6]], shape: 'identity', base: -0.05 },
];

function shapeHeight(kind, v) {
  if (kind === 'abs') return Math.abs(v) * 1.3 - 0.5;
  if (kind === 'negabs') return -Math.abs(v) * 1.3 + 0.3;
  return v;
}

function lerp(a, b, t) { return a + (b - a) * t; }
function toRgbArr(color) {
  if (Array.isArray(color)) return color;
  const h = color.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbLerpArr(colorA, colorB, t) {
  const a = toRgbArr(colorA), b = toRgbArr(colorB);
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

// A small deterministic string hash -> picks the same theme for the same
// (genre, letter) every time, so a repeated song-form letter within one
// piece always gets the same landscape, echoing the generator's own
// "repeated sections reuse the same identity" rule.
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h);
}

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('shader compile failed: ' + log);
  }
  return sh;
}
function linkProgram(gl, vsSrc, fsSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    throw new Error('program link failed: ' + log);
  }
  return prog;
}

const LINE_VS = `
  attribute vec2 aPos;
  attribute vec3 aColor;
  attribute float aAlpha;
  uniform vec2 uResolution;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 clip = (aPos / uResolution) * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);
    vColor = aColor;
    vAlpha = aAlpha;
  }
`;
const LINE_FS = `
  precision mediump float;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(vColor * vAlpha, vAlpha);
  }
`;
const QUAD_VS = `
  attribute vec2 aPos;
  varying vec2 vUv;
  void main() {
    vUv = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
  }
`;
// Simple GLSL blend: mixes the previous frame's texture toward the theme
// background colour by uDecay each frame (the trail/persistence effect --
// a cheap GPU feedback loop instead of per-object fade bookkeeping).
const QUAD_FS = `
  precision mediump float;
  varying vec2 vUv;
  uniform sampler2D uTex;
  uniform float uDecay;
  uniform vec3 uBg;
  void main() {
    vec3 c = texture2D(uTex, vUv).rgb;
    gl_FragColor = vec4(mix(uBg, c, uDecay), 1.0);
  }
`;

// A ring entity template (unit circle, N segments) -- each spawned entity
// is just a transform (center, scale, rotation) applied to these points at
// draw time, so spawning one costs nothing beyond a small object push.
const RING_SEGMENTS = 22;
const RING_PTS = [];
for (let i = 0; i < RING_SEGMENTS; i++) {
  const a = (i / RING_SEGMENTS) * Math.PI * 2;
  RING_PTS.push([Math.cos(a), Math.sin(a)]);
}

const ENTITY_LIFETIME_S = 0.85;
// Onset detection: a fast envelope (~instant) vs a slow one (~0.5s) on the
// bass band -- an "event" fires when fast pulls far enough ahead of slow,
// with a short refractory window so one hit can't retrigger mid-attack.
const ONSET_RATIO = 1.32;
const ONSET_REFRACTORY_S = 0.16;

class Landscape {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', { antialias: true, alpha: false });
    this.audioEl = null;
    this.audioCtx = null;
    this.analyser = null;
    this.freqData = null;
    this.bass = 0; this.mid = 0; this.treble = 0;
    this.bassFast = 0; this.bassSlow = 0;
    this.lastSpawn = -Infinity;
    this.entities = [];
    this.lastFrameTime = performance.now();
    this.scrollZ = 0;

    this.track = null;
    this.sectionStarts = [];
    this.sectionThemeIdx = [];
    this.curSectionIdx = -1;
    this.themeFrom = THEMES[0];
    this.themeTo = THEMES[0];
    this.themeBlend = 1;
    this.themeBlendStart = 0;
    this.designedIntensity = 0.4;

    this._initGL();
    this._resize();
    window.addEventListener('resize', () => this._resize());
    this._raf = requestAnimationFrame((t) => this._loop(t));
  }

  _initGL() {
    const gl = this.gl;
    this.lineProg = linkProgram(gl, LINE_VS, LINE_FS);
    this.quadProg = linkProgram(gl, QUAD_VS, QUAD_FS);

    this.lineLoc = {
      aPos: gl.getAttribLocation(this.lineProg, 'aPos'),
      aColor: gl.getAttribLocation(this.lineProg, 'aColor'),
      aAlpha: gl.getAttribLocation(this.lineProg, 'aAlpha'),
      uResolution: gl.getUniformLocation(this.lineProg, 'uResolution'),
    };
    this.quadLoc = {
      aPos: gl.getAttribLocation(this.quadProg, 'aPos'),
      uTex: gl.getUniformLocation(this.quadProg, 'uTex'),
      uDecay: gl.getUniformLocation(this.quadProg, 'uDecay'),
      uBg: gl.getUniformLocation(this.quadProg, 'uBg'),
    };

    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.lineBuf = gl.createBuffer();

    // The trail feedback effect needs only ONE extra texture (not a full
    // ping-pong pair of framebuffers): each frame renders straight to the
    // visible canvas (fade pass + lines), then a single cheap
    // gl.copyTexImage2D grabs that same visible framebuffer into this
    // texture to serve as "previous frame" for the next fade pass. That
    // replaces a whole extra textured full-screen draw+shader pass (a
    // "blit to screen" step) with a raw pixel copy -- no shader
    // invocation, the cheapest way the GPU can move a screen's worth of
    // pixels.
    this.prevTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.prevTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  _resize() {
    // Capped below the usual 2x/3x retina factor: fragment cost scales with
    // the *square* of this (2x = 4x the pixels), and a background wireframe
    // gains little visible sharpness past ~1.5x while paying a lot for it.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    this.canvas.width = w;
    this.canvas.height = h;
    this.dpr = dpr;
    this.gl.viewport(0, 0, w, h);
    // Re-seed the "previous frame" texture at the new size (blank -- one
    // faded-from-black frame on resize is invisible in practice).
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.prevTex);
    // RGB, not RGBA: the context below is created with alpha:false, so the
    // default framebuffer has no alpha channel at all. copyTexImage2D
    // (used every frame in _draw) requesting RGBA against an alpha-less
    // framebuffer is a format mismatch that fails with GL_INVALID_OPERATION
    // -- silently (WebGL errors don't throw), so the trail texture was
    // never actually being updated. The fade shader only ever reads
    // .rgb anyway, so RGB is also simply the correct format to ask for.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, w, h, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
  }

  // Bind the single persistent <audio> element once. createMediaElementSource
  // can only be called once per element ever, and doesn't itself need a user
  // gesture (only audioCtx.resume() does), so this is safe to call as soon
  // as the element exists.
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
      const idx = hashStr(track.genre + ':' + s.letter) % THEMES.length;
      this.sectionThemeIdx.push(idx);
      t += s.seconds;
    });
    this.curSectionIdx = -1;
    this.entities = [];
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
      this.themeFrom = this._currentBlendedTheme();
      this.themeTo = theme;
      this.themeBlend = 0;
      this.themeBlendStart = performance.now();
      const section = this.track.sections[idx];
      this.designedIntensity = (section && typeof section.intensity === 'number') ? section.intensity : 0.4;
      const el = document.getElementById('npLandscape');
      if (el) el.textContent = theme.name;
    }
  }

  _currentBlendedTheme() {
    const a = this.themeFrom, b = this.themeTo, t = this.themeBlend;
    return {
      name: b.name, bg: rgbLerpArr(a.bg, b.bg, t), line: rgbLerpArr(a.line, b.line, t),
      glow: rgbLerpArr(a.glow, b.glow, t),
      octaves: b.octaves.map((o, i) => o.map((v, j) => lerp((a.octaves[i] || o)[j], v, t))),
      shape: t > 0.5 ? b.shape : a.shape, base: lerp(a.base, b.base, t),
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
    bass = bass / bassEnd / 255;
    mid = mid / (midEnd - bassEnd) / 255;
    treble = treble / (n - midEnd) / 255;

    const k = 0.18;
    this.bass += (bass - this.bass) * k;
    this.mid += (mid - this.mid) * k;
    this.treble += (treble - this.treble) * k;

    // Onset detector: a fast envelope tracks the instantaneous bass energy
    // closely, a slow one only drifts toward it -- when the fast one pulls
    // far enough ahead (a sudden hit), that's an "event".
    this.bassFast += (bass - this.bassFast) * Math.min(1, dt * 14);
    this.bassSlow += (bass - this.bassSlow) * Math.min(1, dt * 2.2);
    const now = performance.now() / 1000;
    if (this.bassFast > this.bassSlow * ONSET_RATIO + 0.03
        && this.bassFast > 0.18
        && now - this.lastSpawn > ONSET_REFRACTORY_S) {
      this.lastSpawn = now;
      this._spawnEntity();
    }
  }

  _spawnEntity() {
    if (this.entities.length > 10) this.entities.shift();
    this.entities.push({
      x: (Math.random() * 0.7 + 0.15), // fraction of canvas width
      y: (Math.random() * 0.35 + 0.08), // fraction of canvas height (upper region)
      rot0: Math.random() * Math.PI * 2,
      spin: (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 1.2),
      born: performance.now() / 1000,
      hue: Math.random(),
    });
  }

  _loop(now) {
    this._raf = requestAnimationFrame((t) => this._loop(t));
    const dt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;

    if (this.audioEl && this.track && !this.audioEl.paused) {
      this._maybeSwitchSection(this.audioEl.currentTime || 0);
    }
    this._updateAudioFeatures(dt);

    if (this.themeBlend < 1) {
      this.themeBlend = Math.min(1, (now - this.themeBlendStart) / 1200);
    }
    const theme = this._currentBlendedTheme();
    const energy = this.bass * 0.6 + this.mid * 0.3 + this.treble * 0.1;
    const speed = 1.4 + energy * 3.2 + this.designedIntensity * 1.4;
    this.scrollZ += speed * dt;

    this._draw(theme, energy, now / 1000);
  }

  _buildVertices(theme, energy, nowS) {
    const w = this.canvas.width, h = this.canvas.height;
    const cols = 38, rows = 18;
    const dx = 0.85;
    const zNear = 5.0, zFar = 34.0;
    const camY = 0.25 + this.designedIntensity * 0.35;
    const focal = 1.3;
    const centerX = w / 2, centerY = h * 0.46;
    const ampBase = 0.85 + this.designedIntensity * 0.75;
    const ampAudio = 1.0 + this.bass * 1.8 + this.mid * 0.6;

    const heightAt = (x, z) => {
      let v = theme.base;
      for (const [freq, amp, speedMul] of theme.octaves) {
        v += Math.sin(x * freq + z * freq * 0.6 + this.scrollZ * speedMul) * amp;
      }
      return shapeHeight(theme.shape, v) * ampBase * ampAudio;
    };

    const pts = [];
    for (let r = 0; r < rows; r++) {
      const z = zNear + (r / (rows - 1)) * (zFar - zNear);
      const worldZSample = z + this.scrollZ;
      const row = [];
      const scale = (focal * Math.min(w, h)) / z;
      const fade = Math.max(0.06, 1 - r / rows);
      for (let c = 0; c < cols; c++) {
        const x = (c - (cols - 1) / 2) * dx;
        const relY = heightAt(x, worldZSample) - camY;
        row.push([centerX + x * scale, centerY + relY * scale, fade]);
      }
      pts.push(row);
    }

    const [lr, lg, lb] = theme.line;
    const cr = lr / 255, cg = lg / 255, cb = lb / 255;
    const verts = [];
    const pushSeg = (x0, y0, a0, x1, y1, a1, r, g, b) => {
      verts.push(x0, y0, r, g, b, a0, x1, y1, r, g, b, a1);
    };

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const [x0, y0, a0] = pts[r][c], [x1, y1, a1] = pts[r][c + 1];
        pushSeg(x0, y0, a0 * 0.9, x1, y1, a1 * 0.9, cr, cg, cb);
      }
    }
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows - 1; r++) {
        const [x0, y0, a0] = pts[r][c], [x1, y1, a1] = pts[r + 1][c];
        pushSeg(x0, y0, a0 * 0.9, x1, y1, a1 * 0.9, cr, cg, cb);
      }
    }

    // Event entities: expanding, rotating, fading wireframe rings -- each
    // audio "event" (see _updateAudioFeatures's onset detector) punches one
    // of these out. Brightened relative to the terrain so they pop.
    const [gr, gg, gb] = theme.glow;
    const er = Math.min(1, cr * 1.3 + 0.15), eg = Math.min(1, cg * 1.3 + 0.15), eb = Math.min(1, cb * 1.3 + 0.15);
    this.entities = this.entities.filter((e) => nowS - e.born < ENTITY_LIFETIME_S);
    for (const e of this.entities) {
      const age = (nowS - e.born) / ENTITY_LIFETIME_S; // 0..1
      const alpha = (1 - age) * 0.85;
      const scale = (0.03 + age * 0.22) * Math.min(w, h);
      const rot = e.rot0 + e.spin * (nowS - e.born);
      const cx = e.x * w, cy = e.y * h;
      const cosr = Math.cos(rot), sinr = Math.sin(rot);
      for (let i = 0; i < RING_SEGMENTS; i++) {
        const [ux0, uy0] = RING_PTS[i];
        const [ux1, uy1] = RING_PTS[(i + 1) % RING_SEGMENTS];
        const x0 = cx + (ux0 * cosr - uy0 * sinr) * scale;
        const y0 = cy + (ux0 * sinr + uy0 * cosr) * scale;
        const x1 = cx + (ux1 * cosr - uy1 * sinr) * scale;
        const y1 = cy + (ux1 * sinr + uy1 * cosr) * scale;
        pushSeg(x0, y0, alpha, x1, y1, alpha, er, eg, eb);
      }
      // A couple of cheap radial spokes so it reads as a "burst", not just a ring.
      for (let i = 0; i < 4; i++) {
        const a = rot + (i / 4) * Math.PI * 2;
        const x1 = cx + Math.cos(a) * scale * 1.4;
        const y1 = cy + Math.sin(a) * scale * 1.4;
        pushSeg(cx, cy, 0, x1, y1, alpha * 0.6, gr / 255, gg / 255, gb / 255);
      }
    }

    return new Float32Array(verts);
  }

  _draw(theme, energy, nowS) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    const verts = this._buildVertices(theme, energy, nowS);
    const vertCount = verts.length / 6;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);

    // Pass 1: fade the previous frame (captured below) toward the theme
    // background -- the trail, a full-screen GLSL blend rather than
    // per-object fade bookkeeping. Drawn straight to the visible canvas.
    gl.useProgram(this.quadProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(this.quadLoc.aPos);
    gl.vertexAttribPointer(this.quadLoc.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.prevTex);
    gl.uniform1i(this.quadLoc.uTex, 0);
    gl.uniform1f(this.quadLoc.uDecay, 0.90);
    gl.uniform3f(this.quadLoc.uBg, theme.bg[0] / 255, theme.bg[1] / 255, theme.bg[2] / 255);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 2: draw this frame's lines additively on top (sharp, glows where
    // segments overlap -- no native shadow/blur needed).
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.useProgram(this.lineProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    const stride = 6 * 4;
    gl.enableVertexAttribArray(this.lineLoc.aPos);
    gl.vertexAttribPointer(this.lineLoc.aPos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.lineLoc.aColor);
    gl.vertexAttribPointer(this.lineLoc.aColor, 3, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(this.lineLoc.aAlpha);
    gl.vertexAttribPointer(this.lineLoc.aAlpha, 1, gl.FLOAT, false, stride, 20);
    gl.uniform2f(this.lineLoc.uResolution, w, h);
    gl.lineWidth(1);
    gl.drawArrays(gl.LINES, 0, vertCount);

    // Pass 3: grab the frame we just rendered as "previous" for next
    // frame's fade -- a raw pixel copy off the default framebuffer, no
    // shader/draw call at all (cheaper than the textured blit this
    // replaced).
    gl.bindTexture(gl.TEXTURE_2D, this.prevTex);
    gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGB, 0, 0, w, h, 0);
  }
}

window.Landscape = Landscape;
