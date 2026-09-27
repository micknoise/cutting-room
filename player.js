// Playlist/transport. TRACKS comes from tracks.js (generated from the
// generator's own JSON reports). Mirrors the local preview player's
// functionality (dropdown grouped by genre, prev/next, auto-advance,
// loop-playlist) plus wiring into the Landscape visualizer.
(function () {
  var canvas = document.getElementById('scene');
  var landscape = new Landscape(canvas);
  window.__cuttingRoom = { landscape: landscape }; // exposed for debugging only

  var player = document.getElementById('player');
  var select = document.getElementById('trackSelect');
  var npTitle = document.getElementById('npTitle');
  var npMeta = document.getElementById('npMeta');
  var autoAdvance = document.getElementById('autoAdvance');
  var loopPlaylist = document.getElementById('loopPlaylist');
  var startHint = document.getElementById('startHint');

  var current = 0;
  var started = false;

  function title(genre) {
    return genre.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }).replace('Dnb', 'DnB');
  }

  function renderNowPlaying(t) {
    npTitle.textContent = String(t.n).padStart(3, '0') + ' · ' + title(t.genre);
    npMeta.innerHTML =
      '<span class="pill">' + t.form + '</span>' +
      '<span><b>' + t.bpm + '</b> bpm</span>' +
      '<span><b>' + t.dur + '</b></span>' +
      '<span>' + t.traj + '</span>';
  }

  function loadTrack(idx, doPlay) {
    current = ((idx % TRACKS.length) + TRACKS.length) % TRACKS.length;
    var t = TRACKS[current];
    // Re-assigning .src (even to the same URL) makes the element reload
    // from scratch, restarting playback at 0 -- a real bug this caused:
    // pressing the *native* play button fires our 'play' listener, which
    // calls loadTrack(current, true) for the track that was already
    // loaded and had just started playing, immediately restarting it.
    // Comparing against the resolved absolute URL (reading .src back
    // always gives the absolute form, even when it was set with a
    // relative path) makes this a no-op when the right track is already
    // loaded.
    var resolved = new URL(t.path, window.location.href).href;
    if (player.src !== resolved) player.src = t.path;
    select.value = String(current);
    renderNowPlaying(t);
    landscape.setTrack(t);
    if (doPlay) {
      player.play().catch(function () { /* needs a user gesture first -- fine, the start hint covers that */ });
    }
  }

  function populateTrackSelect() {
    var groups = {};
    TRACKS.forEach(function (t, i) {
      if (!groups[t.genre]) {
        var og = document.createElement('optgroup');
        var count = TRACKS.filter(function (x) { return x.genre === t.genre; }).length;
        og.label = title(t.genre) + ' (' + count + ')';
        groups[t.genre] = og;
      }
      var opt = document.createElement('option');
      opt.value = i;
      opt.textContent = String(t.n).padStart(3, '0') + ' · seed ' + t.seed + ' · ' + t.dur;
      groups[t.genre].appendChild(opt);
    });
    Object.keys(groups).sort().forEach(function (g) { select.appendChild(groups[g]); });
  }

  function begin() {
    if (started) return;
    started = true;
    landscape.resumeAudio();
    startHint.setAttribute('hidden', '');
    loadTrack(current, true);
  }

  populateTrackSelect();
  renderNowPlaying(TRACKS[0]);
  landscape.setTrack(TRACKS[0]);
  // Two real bugs, both here:
  // 1) The native <audio> element had no `src` at all until begin()/
  //    loadTrack() ran, so the browser correctly greyed out its own play
  //    button (there was nothing to play) until a track was picked from
  //    the dropdown, which is what actually called loadTrack.
  // 2) bindAudio() (which calls createMediaElementSource -- allowed any
  //    time, no gesture needed) used to run lazily *inside* begin(), i.e.
  //    inside the 'play' event handler fired by the very play() call that
  //    triggered it. Rewiring the element's audio graph while a play()
  //    promise from that same call was still settling raced it: Chrome
  //    aborted the play() with "interrupted by a new load request".
  // Fix: point at track 0 and bind the audio graph immediately on load
  // (both gesture-free), and leave only audioCtx.resume() -- the one part
  // that genuinely needs a user gesture -- for begin().
  player.src = TRACKS[0].path;
  landscape.bindAudio(player);

  startHint.addEventListener('click', begin);
  document.addEventListener('keydown', function (e) {
    if (!started && (e.key === ' ' || e.key === 'Enter')) begin();
  });

  select.addEventListener('change', function () {
    started = true; // picking a track from the list is itself the user gesture
    landscape.resumeAudio();
    startHint.setAttribute('hidden', '');
    loadTrack(parseInt(select.value, 10), true);
  });
  document.getElementById('prevBtn').addEventListener('click', function () {
    begin();
    loadTrack(current - 1, true);
  });
  document.getElementById('nextBtn').addEventListener('click', function () {
    begin();
    loadTrack(current + 1, true);
  });
  player.addEventListener('play', begin);
  player.addEventListener('ended', function () {
    if (!autoAdvance.checked) return;
    if (current === TRACKS.length - 1 && !loopPlaylist.checked) return;
    loadTrack(current + 1, true);
  });
})();

