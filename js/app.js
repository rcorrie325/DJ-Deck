import { Deck } from './deck.js';
import { Mixer, peakLevel, FX_BEATS } from './mixer.js';
import { Library } from './library.js';
import { Spotify } from './spotify.js';
import { analyzeTrack } from './analysis.js';
import { drawZoom, drawOverview } from './waveform.js';
import { Knob } from './knob.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ctx = new AudioContext({ latencyHint: 'interactive' });
const mixer = new Mixer(ctx);
const decks = { A: new Deck(ctx, 'A', mixer.input('A')), B: new Deck(ctx, 'B', mixer.input('B')) };
const library = new Library();
const spotify = new Spotify();
const trackIndex = new Map(); // id -> track (local and Spotify)
const playlistCache = new Map();
const ZOOMS = [2, 4, 6, 8, 12, 16, 24];
let zoomIdx = 3;
let crate = { key: 'local', title: 'Local Files', tracks: [] };

window.spindeck = { ctx, mixer, decks, library, spotify }; // handy for debugging in the console

document.addEventListener('pointerdown', () => ctx.state !== 'running' && ctx.resume(), true);
document.addEventListener('keydown', () => ctx.state !== 'running' && ctx.resume(), true);

// ---------- helpers ----------

function fmtTime(s, tenths = true) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return tenths ? `${m}:${sec.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(sec)).padStart(2, '0')}`;
}

function esc(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- decks ----------

function deckTemplate(id) {
  return `
  <div class="deck-head">
    <div class="platter" title="Drag to nudge (playing) or scrub (paused)">
      <div class="platter-disc"><img class="platter-art" alt=""><div class="platter-mark"></div></div>
    </div>
    <div class="deck-info">
      <div class="deck-letter">${id}</div>
      <div class="deck-title">Drop a track here</div>
      <div class="deck-artist">&nbsp;</div>
      <div class="deck-times"><span class="t-el">0:00.0</span><span class="t-rem">-0:00.0</span></div>
    </div>
    <div class="deck-bpm"><b class="bpm-val">--.-</b><span class="bpm-unit">BPM</span><span class="pitch-val">+0.00%</span></div>
  </div>
  <canvas class="overview" title="Click to jump"></canvas>
  <div class="deck-body">
    <div class="deck-controls">
      <div class="transport">
        <button class="btn cue" title="Cue">CUE</button>
        <button class="btn play" title="Play / pause">▶</button>
        <button class="btn sync" title="Sync tempo and beat to the other deck">SYNC</button>
      </div>
      <div class="pads hotcues">
        ${[0, 1, 2, 3].map((i) => `<button class="pad hot" data-i="${i}" title="Hot cue ${i + 1} (Shift-click to delete)">${i + 1}</button>`).join('')}
      </div>
      <div class="pads loops">
        ${[0.5, 1, 2, 4, 8, 16].map((b) => `<button class="pad loop" data-beats="${b}" title="${b}-beat loop">${b === 0.5 ? '½' : b}</button>`).join('')}
      </div>
    </div>
    <div class="pitch">
      <button class="btn small range" title="Pitch range">±8%</button>
      <input type="range" class="pitch-fader" min="-1" max="1" step="0.0005" value="0" title="Tempo (double-click to reset)">
      <div class="bend">
        <button class="btn small bend-dn" title="Nudge slower">◀</button>
        <button class="btn small bend-up" title="Nudge faster">▶</button>
      </div>
    </div>
  </div>
  <div class="deck-loading" hidden>Analyzing…</div>`;
}

function setupDeck(id) {
  const deck = decks[id];
  const root = $(`#deck${id}`);
  root.innerHTML = deckTemplate(id);
  const ui = {
    root,
    title: $('.deck-title', root),
    artist: $('.deck-artist', root),
    el: $('.t-el', root),
    rem: $('.t-rem', root),
    bpm: $('.bpm-val', root),
    pitchVal: $('.pitch-val', root),
    play: $('.play', root),
    cue: $('.cue', root),
    sync: $('.sync', root),
    range: $('.range', root),
    pitch: $('.pitch-fader', root),
    overview: $('.overview', root),
    disc: $('.platter-disc', root),
    art: $('.platter-art', root),
    loading: $('.deck-loading', root),
    hot: $$('.hot', root),
    loops: $$('.loop', root),
  };
  deck.ui = ui;
  const other = () => decks[id === 'A' ? 'B' : 'A'];

  ui.play.addEventListener('click', () => {
    if (deck.previewingCue) { deck.releasePreview(); return; }
    deck.toggle();
  });
  ui.cue.addEventListener('pointerdown', (e) => { e.preventDefault(); deck.cueDown(); });
  ui.cue.addEventListener('pointerup', () => deck.cueUp());
  ui.cue.addEventListener('pointerleave', () => deck.cueUp());
  ui.sync.addEventListener('click', () => {
    if (!deck.bpm) return toast(`Deck ${id}: no BPM detected for this track`);
    if (!other().currentBpm) return toast('Load a track with a BPM on the other deck first');
    deck.syncTo(other());
  });
  ui.hot.forEach((b) => b.addEventListener('click', (e) => deck.hotCue(+b.dataset.i, e.shiftKey)));
  ui.loops.forEach((b) => b.addEventListener('click', () => deck.setLoop(+b.dataset.beats)));
  ui.pitch.addEventListener('input', () => deck.setPitch(+ui.pitch.value));
  ui.pitch.addEventListener('dblclick', () => { ui.pitch.value = 0; deck.setPitch(0); });
  ui.range.addEventListener('click', () => {
    const ranges = [0.08, 0.16, 0.5];
    const rate = deck.rate;
    deck.range = ranges[(ranges.indexOf(deck.range) + 1) % ranges.length];
    // Keep the current tempo; just rescale the fader.
    if (Math.abs(rate - 1) > deck.range) deck.setRate(1 + Math.sign(rate - 1) * deck.range);
    updateDeckUI(id);
  });
  const bendBtn = (sel, amount) => {
    const b = $(sel, root);
    b.addEventListener('pointerdown', () => deck.setBend(amount));
    for (const ev of ['pointerup', 'pointerleave']) b.addEventListener(ev, () => deck.bend && deck.setBend(0));
  };
  bendBtn('.bend-dn', -0.04);
  bendBtn('.bend-up', 0.04);

  ui.overview.addEventListener('pointerdown', (e) => {
    if (!deck.loaded) return;
    const r = ui.overview.getBoundingClientRect();
    deck.seek(((e.clientX - r.left) / r.width) * deck.duration);
  });

  // Platter: nudge while playing, scrub while paused.
  let lastAngle = null;
  const angleOf = (e) => {
    const r = ui.disc.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  };
  ui.disc.addEventListener('pointerdown', (e) => {
    ui.disc.setPointerCapture(e.pointerId);
    lastAngle = angleOf(e);
  });
  ui.disc.addEventListener('pointermove', (e) => {
    if (lastAngle == null || !deck.loaded) return;
    const a = angleOf(e);
    let d = a - lastAngle;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    lastAngle = a;
    if (deck.playing) deck.setBend(Math.max(-0.3, Math.min(0.3, d * 2)));
    else deck.seek(deck.position + (d / (2 * Math.PI)) * 1.8);
  });
  const endDrag = () => { lastAngle = null; if (deck.bend) deck.setBend(0); };
  ui.disc.addEventListener('pointerup', endDrag);
  ui.disc.addEventListener('pointercancel', endDrag);

  // Drag & drop onto a deck: library rows or files.
  root.addEventListener('dragover', (e) => { e.preventDefault(); root.classList.add('drop'); });
  root.addEventListener('dragleave', () => root.classList.remove('drop'));
  root.addEventListener('drop', async (e) => {
    e.preventDefault();
    root.classList.remove('drop');
    const tid = e.dataTransfer.getData('text/spindeck-track');
    if (tid && trackIndex.has(tid)) return loadToDeck(id, trackIndex.get(tid));
    if (e.dataTransfer.files.length) {
      const added = await addFiles(e.dataTransfer.files);
      if (added[0]) loadToDeck(id, added[0]);
    }
  });

  deck.addEventListener('change', () => updateDeckUI(id));
  updateDeckUI(id);
}

function updateDeckUI(id) {
  const deck = decks[id];
  const ui = deck.ui;
  ui.play.classList.toggle('on', deck.playing);
  ui.play.textContent = deck.playing ? '❚❚' : '▶';
  ui.cue.classList.toggle('on', deck.loaded && !deck.playing && Math.abs(deck.position - deck.cuePoint) < 0.01);
  ui.hot.forEach((b, i) => b.classList.toggle('set', deck.hotCues[i] != null));
  ui.loops.forEach((b) => b.classList.toggle('on', deck.loop?.beats === +b.dataset.beats));
  ui.range.textContent = `±${Math.round(deck.range * 100)}%`;
  ui.pitch.value = deck.pitch;
  const pct = (deck.rate - 1) * 100;
  ui.pitchVal.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
  ui.bpm.textContent = deck.currentBpm ? deck.currentBpm.toFixed(1) : '--.-';
  const o = decks[id === 'A' ? 'B' : 'A'];
  const synced = deck.currentBpm && o.currentBpm && Math.abs(deck.currentBpm - o.currentBpm) < 0.05;
  ui.sync.classList.toggle('on', !!synced);
}

async function loadToDeck(id, track) {
  const deck = decks[id];
  if (track.source === 'spotify') {
    const match = library.findMatch(track);
    if (!match) {
      toast(`No local file for “${track.title}”. Add it to your library to mix it — or ▶ preview it via Spotify.`, 5000);
      return;
    }
    if (track.art && !match.art) match.art = track.art;
    track = match;
  }
  if (deck.playing) {
    toast(`Deck ${id} is playing — pause it before loading a new track`);
    return;
  }
  const ui = deck.ui;
  ui.loading.hidden = false;
  ui.title.textContent = track.title;
  ui.artist.textContent = track.artist || ' ';
  try {
    const buffer = await ctx.decodeAudioData(await track.file.arrayBuffer());
    if (!track.analysis) {
      track.analysis = await analyzeTrack(buffer);
      // Fall back to a tagged BPM only when detection found nothing.
      if (!track.analysis.bpm && track.bpm) track.analysis.bpm = track.bpm;
      track.bpm = track.analysis.bpm;
    }
    deck.load(buffer, track, track.analysis);
    ui.art.src = track.art || '';
    ui.art.hidden = !track.art;
    renderTracks();
  } catch (err) {
    console.error(err);
    toast(`Could not load “${track.title}”: ${err.message || 'unsupported audio format'}`);
    ui.title.textContent = deck.track?.title || 'Drop a track here';
  } finally {
    ui.loading.hidden = true;
  }
}

// ---------- mixer ----------

function setupMixer() {
  // Registry of every mixer knob, keyed 'A.trim', 'B.fx-depth', 'master', 'cue-mix', … (used by MIDI mapping).
  const knobs = (window.spindeck.knobs ||= {});
  const knob = (key, el, opts) => { knobs[key] = new Knob(el, opts); return knobs[key]; };
  for (const id of ['A', 'B']) {
    const col = $(`.mix-col[data-ch="${id}"]`);
    knob(`${id}.trim`, $('[data-k="trim"]', col), { label: 'GAIN', onChange: (v) => mixer.setTrim(id, v) });
    knob(`${id}.high`, $('[data-k="high"]', col), { label: 'HI', onChange: (v) => mixer.setEq(id, 'high', v) });
    knob(`${id}.mid`, $('[data-k="mid"]', col), { label: 'MID', onChange: (v) => mixer.setEq(id, 'mid', v) });
    knob(`${id}.low`, $('[data-k="low"]', col), { label: 'LOW', onChange: (v) => mixer.setEq(id, 'low', v) });
    knob(`${id}.filter`, $('[data-k="filter"]', col), { label: 'FILTER', onChange: (v) => mixer.setFilter(id, v) });
    const fader = $(`#fader${id}`);
    fader.addEventListener('input', () => mixer.setFader(id, +fader.value));
    mixer.setFader(id, +fader.value);
    setupFx(id, col, knob);

    const pfl = $('.pfl', col);
    pfl.addEventListener('click', () => {
      const on = !mixer.channels[id].cueOn;
      mixer.setCue(id, on);
      pfl.classList.toggle('on', on);
      pfl.setAttribute('aria-pressed', on);
    });

    // Keep echo / flanger in time with the deck's playing tempo.
    const deck = decks[id];
    deck.addEventListener('change', () => mixer.setFxBpm(id, deck.currentBpm));
    mixer.setFxBpm(id, deck.currentBpm);
  }
  knob('master', $('.master-col [data-k="master"]'), {
    label: 'MASTER', min: 0, max: 1, value: 0.8, onChange: (v) => mixer.setMaster(v),
  });
  knob('cue-mix', $('.master-col [data-k="cue-mix"]'), {
    label: 'CUE MIX', min: 0, max: 1, value: 0, onChange: (v) => mixer.setCueMix(v),
  });
  knob('phones', $('.master-col [data-k="phones"]'), {
    label: 'PHONES', min: 0, max: 1, value: 0.8, onChange: (v) => mixer.setPhones(v),
  });
  $('.master-col [data-k="cue-mix"]').title = 'Headphone mix: cue ↔ master';
  $('.master-col [data-k="phones"]').title = 'Headphone level';
  const xf = $('#xfader');
  xf.addEventListener('input', () => mixer.setCrossfader(+xf.value));
  xf.addEventListener('dblclick', () => { xf.value = 0.5; mixer.setCrossfader(0.5); });
  $('#xfCurve').addEventListener('change', (e) => mixer.setCurve(e.target.value));

  mixer.onroute = updateCueAvailability;
  updateCueAvailability();
  setupOutputSettings();
}

const BEAT_LABELS = { 0.5: '½', 0.75: '¾', 1: '1', 2: '2', 4: '4' };

function setupFx(id, col, knob) {
  const type = $('.fx-type', col);
  const on = $('.fx-on', col);
  const beatsEl = $('[data-k="fx-beats"]', col);
  const steps = FX_BEATS.length - 1;
  let beatsKnob = null;
  const refreshBeats = () => {
    const { type: t, beats } = mixer.getFx(id);
    const lbl = $('.knob-label', beatsEl);
    if (t === 'reverb') { lbl.textContent = 'BEATS'; beatsEl.title = 'Not used by reverb'; }
    else if (t === 'flanger') { lbl.textContent = `RATE ${BEAT_LABELS[beats]}`; beatsEl.title = `Flanger sweep: one cycle every ${beats} bar(s)`; }
    else { lbl.textContent = `BEAT ${BEAT_LABELS[beats]}`; beatsEl.title = `Echo time: ${beats} beat(s)`; }
    beatsEl.classList.toggle('inactive', t === 'reverb');
  };
  type.addEventListener('change', () => { mixer.setFx(id, { type: type.value }); refreshBeats(); });
  on.addEventListener('click', () => {
    const v = !mixer.getFx(id).on;
    mixer.setFx(id, { on: v });
    on.classList.toggle('on', v);
    on.setAttribute('aria-pressed', v);
  });
  knob(`${id}.fx-depth`, $('[data-k="fx-depth"]', col), {
    label: 'DEPTH', min: 0, max: 1, value: 0.5, onChange: (v) => mixer.setFx(id, { depth: v }),
  });
  // Stepped knob: its value is an index into FX_BEATS (½ ¾ 1 2 4), snapped to the nearest step.
  beatsKnob = knob(`${id}.fx-beats`, beatsEl, {
    label: 'BEAT 1', min: 0, max: steps, value: FX_BEATS.indexOf(1),
    onChange: (v) => {
      const i = Math.round(v);
      mixer.setFx(id, { beats: FX_BEATS[i] });
      if (!beatsKnob) return;
      beatsKnob.dial.style.setProperty('--rot', `${-135 + (i / steps) * 270}deg`);
      refreshBeats();
    },
  });
  refreshBeats();
}

function updateCueAvailability() {
  const { channels, cueAvailable } = mixer.outputInfo();
  for (const b of $$('.mix-col .pfl')) {
    b.disabled = !cueAvailable;
    b.title = cueAvailable
      ? `Headphone cue (PFL) for channel ${b.closest('.mix-col').dataset.ch}, heard on outputs 3/4`
      : 'Headphone cue needs a 4-channel audio output (e.g. a DJ controller). Choose one in Settings → Audio output.';
  }
  $('.master-col .cue-knobs').classList.toggle('inactive', !cueAvailable);
  $('#outputNote').textContent = cueAvailable
    ? `${channels}-channel output: master on 1/2, headphone cue on 3/4.`
    : `${channels}-channel output: master only. Headphone cue needs a 4-channel device (e.g. a DJ controller).`;
}

// ---------- settings: audio output ----------

function setupOutputSettings() {
  const sel = $('#outputSelect');
  const namesBtn = $('#outputNames');
  if (typeof ctx.setSinkId !== 'function' || !navigator.mediaDevices?.enumerateDevices) {
    sel.disabled = true;
    sel.title = "Output selection isn't supported in this browser";
    $('#outputUnsupported').hidden = false;
    return;
  }
  const refresh = async () => {
    let devices = [];
    try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput'); } catch { /* ignore */ }
    const current = typeof ctx.sinkId === 'string' ? ctx.sinkId : '';
    const outs = devices.filter((d) => d.deviceId && d.deviceId !== 'default');
    sel.innerHTML = '<option value="">System default</option>' + outs.map((d, i) => (
      `<option value="${esc(d.deviceId)}">${esc(d.label || `Output ${i + 1}`)}</option>`)).join('');
    sel.value = outs.some((d) => d.deviceId === current) ? current : '';
    namesBtn.hidden = !devices.length || devices.some((d) => d.label);
  };
  sel.addEventListener('change', async () => {
    try {
      await mixer.setOutputDevice(sel.value);
      const { cueAvailable } = mixer.outputInfo();
      toast(`Audio output: ${sel.selectedOptions[0].textContent}${cueAvailable ? ' · headphone cue on outputs 3/4' : ''}`);
    } catch (err) {
      toast(`Couldn't switch output: ${err.message}`);
      refresh();
    }
    updateCueAvailability();
  });
  // Browsers hide device names until a media permission has been granted.
  namesBtn.addEventListener('click', async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch { toast('Permission denied, device names stay hidden'); }
    refresh();
  });
  navigator.mediaDevices.addEventListener?.('devicechange', refresh);
  $('#settingsBtn').addEventListener('click', refresh);
  refresh();
}

// ---------- recording ----------

let recorder = null;
let recStart = 0;
function toggleRecord() {
  const btn = $('#recBtn');
  if (recorder) {
    recorder.stop();
    return;
  }
  const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
  recorder = new MediaRecorder(mixer.recordDest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 256000 } : {});
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: recorder.mimeType });
    const ext = recorder.mimeType.includes('mp4') ? 'm4a' : recorder.mimeType.includes('ogg') ? 'ogg' : 'webm';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `spindeck-mix-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    recorder = null;
    btn.classList.remove('on');
    $('#recTime').textContent = '';
    toast('Mix saved to your downloads');
  };
  ctx.resume();
  recorder.start(1000);
  recStart = performance.now();
  btn.classList.add('on');
}

// ---------- library UI ----------

async function addFiles(files) {
  const el = $('#crateTitle');
  const added = await library.addFiles(files, (n, total) => { el.textContent = `Importing ${n}/${total}…`; });
  added.forEach((t) => trackIndex.set(t.id, t));
  $('#localCount').textContent = library.tracks.length;
  if (crate.key === 'local') crate.tracks = library.tracks;
  el.textContent = crate.title;
  renderTracks();
  if (added.length) toast(`Added ${added.length} track${added.length === 1 ? '' : 's'}`);
  return added;
}

function selectCrate(key, title, tracks) {
  crate = { key, title, tracks };
  $$('.crate').forEach((c) => c.classList.toggle('active', c.dataset.crate === key));
  $('#crateTitle').textContent = title;
  renderTracks();
}

function renderTracks() {
  const q = $('#searchInput').value.trim().toLowerCase();
  const list = crate.key === 'local' ? library.tracks : crate.tracks;
  const rows = q && crate.key !== 'search'
    ? list.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q))
    : list;
  const loadedIds = new Set(Object.values(decks).map((d) => d.track?.id));
  $('#emptyState').hidden = rows.length > 0;
  $('#emptyState').textContent = crate.key === 'local'
    ? 'Drop audio files or a folder here, or use “Add files”.'
    : 'No tracks.';
  $('#trackBody').innerHTML = rows.map((t) => {
    const match = t.source === 'spotify' ? library.findMatch(t) : t;
    const bpm = match?.bpm ? match.bpm.toFixed(1) : '';
    const art = t.art ? `<img src="${esc(t.art)}" alt="" loading="lazy">` : '<span class="note">♪</span>';
    const local = t.source === 'spotify'
      ? (match ? '<span class="ok" title="Matched a local file">✓</span>' : '<span class="miss" title="No local file">—</span>')
      : '<span class="ok">●</span>';
    const preview = t.source === 'spotify' ? `<button class="btn tiny pv" data-act="preview" title="Preview on Spotify">▶</button>` : '';
    return `<tr draggable="true" data-id="${esc(t.id)}" class="${loadedIds.has(match?.id) ? 'loaded' : ''} ${t.source === 'spotify' && !match ? 'unmatched' : ''}">
      <td class="art">${art}</td>
      <td class="title">${esc(t.title)}</td>
      <td>${esc(t.artist)}</td>
      <td class="num">${bpm}</td>
      <td class="num">${fmtTime(t.duration, false)}</td>
      <td class="center">${local}</td>
      <td class="load">${preview}<button class="btn tiny" data-act="A">A</button><button class="btn tiny" data-act="B">B</button></td>
    </tr>`;
  }).join('');
}

function setupLibrary() {
  $('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('#folderInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('[data-crate="local"]').addEventListener('click', () => selectCrate('local', 'Local Files', library.tracks));

  const body = $('#trackBody');
  body.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    const row = e.target.closest('tr');
    if (!btn || !row) return;
    const t = trackIndex.get(row.dataset.id);
    if (btn.dataset.act === 'preview') previewSpotify(t);
    else loadToDeck(btn.dataset.act, t);
  });
  body.addEventListener('dblclick', (e) => {
    const row = e.target.closest('tr');
    if (!row || e.target.closest('button')) return;
    const t = trackIndex.get(row.dataset.id);
    loadToDeck(!decks.A.loaded || !decks.A.playing ? 'A' : 'B', t);
  });
  body.addEventListener('dragstart', (e) => {
    const row = e.target.closest('tr');
    if (row) e.dataTransfer.setData('text/spindeck-track', row.dataset.id);
  });

  const zone = $('#dropZone');
  zone.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); zone.classList.add('drop'); } });
  zone.addEventListener('dragleave', () => zone.classList.remove('drop'));
  zone.addEventListener('drop', (e) => {
    zone.classList.remove('drop');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  });

  const search = $('#searchInput');
  search.addEventListener('input', () => { if (crate.key !== 'search') renderTracks(); });
  search.addEventListener('keydown', async (e) => {
    e.stopPropagation(); // keep deck shortcuts from firing while typing
    if (e.key !== 'Enter' || !search.value.trim()) return;
    if (!spotify.loggedIn) return toast('Connect Spotify to search its catalog');
    try {
      const results = await spotify.search(search.value.trim());
      results.forEach((t) => trackIndex.set(t.id, t));
      selectCrate('search', `Spotify: “${search.value.trim()}”`, results);
    } catch (err) { toast(err.message); }
  });
}

// ---------- Spotify ----------

async function initSpotify() {
  $('#redirectUri').textContent = spotify.redirectUri;
  $('#clientIdInput').value = spotify.clientId;
  try {
    await spotify.handleRedirect();
  } catch (err) {
    toast(err.message, 6000);
  }
  if (!spotify.loggedIn) return;
  try {
    const me = await spotify.me();
    const btn = $('#spotifyBtn');
    btn.textContent = 'Log out';
    btn.classList.remove('spotify');
    const u = $('#spotifyUser');
    u.hidden = false;
    const img = me.images?.[0]?.url;
    u.innerHTML = `${img ? `<img src="${esc(img)}" alt="">` : ''}<span>${esc(me.display_name || me.id)}</span>`;
    await renderSpotifyCrates();
  } catch (err) {
    console.error(err);
    toast(`Spotify: ${err.message}`, 6000);
    if (err.status === 401 || err.status === 403 || /refresh|token/i.test(err.message)) spotify.logout();
  }
}

async function renderSpotifyCrates() {
  const el = $('#spotifyCrates');
  el.innerHTML = '<p class="muted small-pad">Loading playlists…</p>';
  let playlists = [];
  try {
    playlists = (await spotify.playlists()).filter(Boolean);
  } catch (err) {
    toast(`Couldn't load playlists: ${err.message}`);
  }
  el.innerHTML = `<button class="crate" data-crate="liked">♥ Liked Songs</button>`
    + playlists.map((p) => `<button class="crate" data-crate="pl:${esc(p.id)}" data-name="${esc(p.name)}">▤ ${esc(p.name)}</button>`).join('');
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('.crate');
    if (!b) return;
    const key = b.dataset.crate;
    const title = key === 'liked' ? 'Liked Songs' : b.dataset.name;
    $('#crateTitle').textContent = 'Loading…';
    try {
      let tracks = playlistCache.get(key);
      if (!tracks) {
        tracks = key === 'liked' ? await spotify.likedTracks() : await spotify.playlistTracks(key.slice(3));
        playlistCache.set(key, tracks);
      }
      tracks.forEach((t) => trackIndex.set(t.id, t));
      selectCrate(key, title, tracks);
    } catch (err) {
      $('#crateTitle').textContent = crate.title;
      toast(`Couldn't load ${title}: ${err.message}`);
    }
  });
}

async function previewSpotify(t) {
  const box = $('#preview');
  try {
    await spotify.previewTrack(t.uri, (s) => {
      if (!s) return;
      $('#previewToggle').textContent = s.paused ? '▶' : '⏸';
    });
    box.hidden = false;
    $('#previewArt').src = t.art || '';
    $('#previewTitle').textContent = t.title;
    $('#previewArtist').textContent = t.artist;
  } catch (err) {
    toast(`Spotify preview: ${err.message}`, 6000);
  }
}

function setupTopbar() {
  $('#spotifyBtn').addEventListener('click', async () => {
    if (spotify.loggedIn) {
      spotify.logout();
      location.reload();
      return;
    }
    if (!spotify.clientId) {
      $('#settingsDialog').showModal();
      toast('Enter your Spotify Client ID first');
      return;
    }
    try { await spotify.login(); } catch (err) { toast(err.message); }
  });
  $('#settingsBtn').addEventListener('click', () => $('#settingsDialog').showModal());
  $('#helpBtn').addEventListener('click', () => $('#helpDialog').showModal());
  $('#saveSettings').addEventListener('click', () => {
    spotify.clientId = $('#clientIdInput').value;
    toast('Saved');
  });
  $('#previewToggle').addEventListener('click', () => spotify.player?.togglePlay());
  $('#recBtn').addEventListener('click', toggleRecord);
  $$('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
    zoomIdx = Math.max(0, Math.min(ZOOMS.length - 1, zoomIdx - Number(b.dataset.zoom)));
  }));
  for (const id of ['A', 'B']) {
    const canvas = $(`#zoom${id}`);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoomIdx = Math.max(0, Math.min(ZOOMS.length - 1, zoomIdx + Math.sign(e.deltaY)));
    }, { passive: false });
    // Drag the zoomed waveform to scrub.
    let lastX = null;
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); lastX = e.clientX; });
    canvas.addEventListener('pointermove', (e) => {
      if (lastX == null || !decks[id].loaded) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      decks[id].seek(decks[id].position - (dx / canvas.clientWidth) * ZOOMS[zoomIdx]);
    });
    canvas.addEventListener('pointerup', () => { lastX = null; });
  }
}

// ---------- keyboard ----------

function setupKeys() {
  const map = {
    q: ['A', 'play'], w: ['A', 'cue'], e: ['A', 'sync'], r: ['A', 'loop'], a: ['A', 'nudge-'], s: ['A', 'nudge+'],
    p: ['B', 'play'], o: ['B', 'cue'], i: ['B', 'sync'], u: ['B', 'loop'], k: ['B', 'nudge-'], l: ['B', 'nudge+'],
    1: ['A', 'hot', 0], 2: ['A', 'hot', 1], 3: ['A', 'hot', 2], 4: ['A', 'hot', 3],
    7: ['B', 'hot', 0], 8: ['B', 'hot', 1], 9: ['B', 'hot', 2], 0: ['B', 'hot', 3],
  };
  const codeKey = (e) => (e.code.startsWith('Digit') ? e.code.slice(5) : e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : null);
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input[type=search], input:not([type]), input[type=text]') || e.metaKey || e.ctrlKey) return;
    const xf = $('#xfader');
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.target === xf) return; // native slider handling
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      xf.value = e.shiftKey ? (dir < 0 ? 0 : 1) : Math.max(0, Math.min(1, +xf.value + dir * 0.05));
      mixer.setCrossfader(+xf.value);
      e.preventDefault();
      return;
    }
    const m = map[codeKey(e)];
    if (!m || e.repeat) return;
    e.preventDefault();
    const [id, act, n] = m;
    const deck = decks[id];
    if (act === 'play') { if (deck.previewingCue) deck.releasePreview(); else deck.toggle(); }
    else if (act === 'cue') deck.cueDown();
    else if (act === 'sync') deck.ui.sync.click();
    else if (act === 'loop') deck.setLoop(4);
    else if (act === 'hot') deck.hotCue(n, e.shiftKey);
    else if (act === 'nudge-') deck.setBend(-0.04);
    else if (act === 'nudge+') deck.setBend(0.04);
  });
  document.addEventListener('keyup', (e) => {
    const m = map[codeKey(e)];
    if (!m) return;
    const deck = decks[m[0]];
    if (m[1] === 'cue') deck.cueUp();
    if (m[1].startsWith('nudge')) deck.setBend(0);
  });
}

// ---------- render loop ----------

function frame() {
  const secs = ZOOMS[zoomIdx];
  for (const id of ['A', 'B']) {
    const deck = decks[id];
    const ui = deck.ui;
    drawZoom($(`#zoom${id}`), deck, secs);
    drawOverview(ui.overview, deck);
    const pos = deck.position;
    ui.el.textContent = fmtTime(pos);
    ui.rem.textContent = '-' + fmtTime(deck.duration - pos);
    ui.rem.classList.toggle('warn', deck.loaded && deck.duration - pos < 30 && deck.playing);
    ui.disc.style.setProperty('--spin', `${(pos * 0.5556 * 360) % 360}deg`);
    $(`#meter${id}`).style.setProperty('--lvl', peakLevel(mixer.channels[id].analyser));
  }
  $('#masterMeter').style.setProperty('--lvl', peakLevel(mixer.analyser));
  if (recorder) $('#recTime').textContent = fmtTime((performance.now() - recStart) / 1000, false);
  requestAnimationFrame(frame);
}

setupDeck('A');
setupDeck('B');
setupMixer();
setupLibrary();
setupTopbar();
setupKeys();
initSpotify();
requestAnimationFrame(frame);
