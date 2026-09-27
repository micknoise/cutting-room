// Wireframe landscape: a plain canvas-2D perspective grid whose terrain is
// a sum of a handful of travelling sine waves (cheap, dependency-free, and
// visually organic enough -- no noise library needed). The camera-space
// grid positions are fixed; only the *sampling coordinate* fed into the
// height function scrolls forward each frame, so the terrain flows toward
// the viewer forever with no wrap-around seam.
//
// Two independent inputs drive it:
//   - the piece's own composed arc (per-section `intensity` from the
//     generator's own JSON report) -- a slow, designed "journey" through
//     the landscape's scale/energy that has nothing to do with the raw
//     waveform, so it stays meaningful even in a quiet passage.
//   - live Web Audio analysis of the actual sound (bass/mid/treble energy)
//     -- the fast, reactive detail that keeps it locked to what's audible
//     right now.
// A "theme" (palette + terrain shape) is picked per song-form letter (the
// generator's own repeat-section identity -- same letter, same landscape)
// and cross-fades in over ~1.2s whenever the section changes.

const THEMES = [
  { name: 'Dunes', bg: '#0b0906', line: '#c9a869', glow: '#7a5a2c',
    octaves: [[0.05, 0.9, 0.6], [0.11, 0.35, -0.9], [0.021, 1.6, 0.25]], shape: 'identity', base: 0.0 },
  { name: 'Crystal Peaks', bg: '#070a0d', line: '#bfe3e0', glow: '#3f7f78',
    octaves: [[0.07, 1.1, 0.5], [0.16, 0.6, -0.7], [0.033, 0.8, 0.3]], shape: 'abs', base: 0.15 },
  { name: 'Deep Canyon', bg: '#0a0708', line: '#b46a55', glow: '#6e2f22',
    octaves: [[0.045, 1.3, 0.4], [0.09, 0.5, 0.8], [0.02, 0.7, -0.2]], shape: 'negabs', base: -0.1 },
  { name: 'Frozen Ridge', bg: '#080a0c', line: '#9fc4d6', glow: '#3a5566',
    octaves: [[0.06, 0.7, 0.35], [0.13, 0.45, -0.55], [0.028, 1.1, 0.15]], shape: 'identity', base: 0.05 },
  { name: 'Ember Fields', bg: '#0a0705', line: '#d98a4a', glow: '#7a3413',
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
// Accepts either a "#rrggbb" hex string or an already-parsed [r,g,b] array
// and always returns [r,g,b] -- theme colors are carried as arrays through
// every blend step (see _currentBlendedTheme) and only turned into a CSS
// "rgb(...)" string at the point of actually drawing. A real bug this used
// to have: blending fed its own *string* output back in as the next
// blend's starting color, and re-parsing "rgb(10,11,16)" as if it were hex
// silently produced NaN for the red channel (parseInt("rg", 16) stops at
// the first non-hex-digit character and returns NaN) -- so every color
// after the first section change was invisible (an invalid CSS color is
// silently ignored, not an error).
function toRgbArr(color) {
  if (Array.isArray(color)) return color;
  const h = color.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbLerpArr(colorA, colorB, t) {
  const a = toRgbArr(colorA), b = toRgbArr(colorB);
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}
function rgbArrToStr(arr) {
  return `rgb(${Math.round(arr[0])},${Math.round(arr[1])},${Math.round(arr[2])})`;
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

class Landscape {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.audioEl = null;
    this.audioCtx = null;
    this.analyser = null;
    this.freqData = null;
    this.bass = 0; this.mid = 0; this.treble = 0; // smoothed 0..1 energy
    this.t0 = performance.now();
    this.scrollZ = 0;
    this.lastFrameTime = this.t0;

    this.track = null;
    this.sectionStarts = [];
    this.sectionThemeIdx = [];
    this.curSectionIdx = -1;
    this.themeFrom = THEMES[0];
    this.themeTo = THEMES[0];
    this.themeBlend = 1;
    this.themeBlendStart = 0;
    this.designedIntensity = 0.4;

    this._resize();
    window.addEventListener('resize', () => this._resize());
    this._raf = requestAnimationFrame((t) => this._loop(t));
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(window.innerWidth * dpr);
    this.canvas.height = Math.floor(window.innerHeight * dpr);
    this.dpr = dpr;
  }

  // Bind the single persistent <audio> element once. createMediaElementSource
  // can only be called once per element ever, so this must not be re-run
  // when the track (src) changes -- only when the element itself changes.
  bindAudio(audioEl) {
    if (this.audioEl === audioEl) return;
    this.audioEl = audioEl;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AC();
    const source = this.audioCtx.createMediaElementSource(audioEl);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.75;
    source.connect(this.analyser);
    this.analyser.connect(this.audioCtx.destination);
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
  }

  resumeAudio() {
    if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume();
  }

  // `track` carries {genre, sections:[{letter, seconds, intensity}, ...]}.
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
    // A plain object with the same shape as a THEMES entry, interpolated --
    // used only as the starting point of the *next* crossfade so back-to-
    // back section changes (a very short section) don't jump-cut.
    const a = this.themeFrom, b = this.themeTo, t = this.themeBlend;
    return {
      name: b.name, bg: rgbLerpArr(a.bg, b.bg, t), line: rgbLerpArr(a.line, b.line, t),
      glow: rgbLerpArr(a.glow, b.glow, t),
      octaves: b.octaves.map((o, i) => o.map((v, j) => lerp((a.octaves[i] || o)[j], v, t))),
      shape: t > 0.5 ? b.shape : a.shape, base: lerp(a.base, b.base, t),
    };
  }

  _updateAudioFeatures() {
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
    // Exponential smoothing so the terrain moves, not flickers.
    const k = 0.18;
    this.bass += (bass - this.bass) * k;
    this.mid += (mid - this.mid) * k;
    this.treble += (treble - this.treble) * k;
  }

  _loop(now) {
    this._raf = requestAnimationFrame((t) => this._loop(t));
    const dt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;

    if (this.audioEl && this.track && !this.audioEl.paused) {
      this._maybeSwitchSection(this.audioEl.currentTime || 0);
    }
    this._updateAudioFeatures();

    if (this.themeBlend < 1) {
      this.themeBlend = Math.min(1, (now - this.themeBlendStart) / 1200);
    }
    const theme = this._currentBlendedTheme();

    const energy = this.bass * 0.6 + this.mid * 0.3 + this.treble * 0.1;
    const speed = 1.4 + energy * 3.2 + this.designedIntensity * 1.4;
    this.scrollZ += speed * dt;

    this._draw(theme, energy);
  }

  _draw(theme, energy) {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;

    ctx.fillStyle = rgbArrToStr(theme.bg);
    ctx.fillRect(0, 0, w, h);

    const cols = 46, rows = 24;
    const dx = 0.85;
    // zNear must stay well clear of the grid's own half-width (cols*dx/2):
    // a real bug this had was zNear=1 with a ~40-unit-wide grid, meaning
    // the near plane subtended a vastly wider angle than any sane field of
    // view -- almost every near-row point projected thousands of pixels
    // off-screen, so nothing but a couple of near-dead-centre pixels
    // (invisible against the background) ever landed in frame.
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
      v = shapeHeight(theme.shape, v);
      return v * ampBase * ampAudio;
    };

    const pts = [];
    for (let r = 0; r < rows; r++) {
      const z = zNear + (r / (rows - 1)) * (zFar - zNear);
      const worldZSample = z + this.scrollZ;
      const row = [];
      for (let c = 0; c < cols; c++) {
        const x = (c - (cols - 1) / 2) * dx;
        const hgt = heightAt(x, worldZSample);
        const relY = hgt - camY;
        const scale = (focal * Math.min(w, h)) / z;
        const sx = centerX + x * scale;
        const sy = centerY + relY * scale;
        row.push([sx, sy, z]);
      }
      pts.push(row);
    }

    ctx.lineWidth = Math.max(1, 1.1 * this.dpr);
    ctx.strokeStyle = rgbArrToStr(theme.line);
    ctx.shadowColor = rgbArrToStr(theme.glow);
    ctx.shadowBlur = (6 + energy * 18) * this.dpr;
    ctx.globalAlpha = 0.9;

    // Depth-fade: far rows drawn fainter so the grid dissolves into the
    // background instead of hard-clipping at the horizon.
    for (let r = 0; r < rows; r++) {
      const fade = 1 - r / rows;
      ctx.globalAlpha = 0.15 + fade * 0.75;
      ctx.beginPath();
      for (let c = 0; c < cols; c++) {
        const [sx, sy] = pts[r][c];
        if (c === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }
    // Drawn one segment at a time (not a single multi-vertex path): canvas
    // applies globalAlpha at stroke() time, uniformly across the whole
    // current path, so a per-vertex fade only works if each faded segment
    // gets its own beginPath/stroke call.
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows - 1; r++) {
        const fade = 1 - r / rows;
        ctx.globalAlpha = 0.15 + fade * 0.75;
        ctx.beginPath();
        ctx.moveTo(pts[r][c][0], pts[r][c][1]);
        ctx.lineTo(pts[r + 1][c][0], pts[r + 1][c][1]);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }
}

window.Landscape = Landscape;
