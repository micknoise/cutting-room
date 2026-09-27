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
    player.src = t.path;
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
    landscape.bindAudio(player);
    landscape.resumeAudio();
    startHint.setAttribute('hidden', '');
    loadTrack(current, true);
  }

  populateTrackSelect();
  renderNowPlaying(TRACKS[0]);
  landscape.setTrack(TRACKS[0]);

  startHint.addEventListener('click', begin);
  document.addEventListener('keydown', function (e) {
    if (!started && (e.key === ' ' || e.key === 'Enter')) begin();
  });

  select.addEventListener('change', function () {
    started = true; // picking a track from the list is itself the user gesture
    landscape.bindAudio(player);
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

