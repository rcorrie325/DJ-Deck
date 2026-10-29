import { Deck } from './deck.js';
import { Mixer, peakLevel } from './mixer.js';
import { Library, trackRecord, trackKey, filesFromDirectory } from './library.js';
import { Spotify } from './spotify.js';
import { analyzeTrack, shiftCamelot, camelotCompatible } from './analysis.js';
import { Store } from './store.js';
import { drawZoom, drawOverview } from './waveform.js';
import { Knob } from './knob.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ctx = new AudioContext({ latencyHint: 'interactive' });
const mixer = new Mixer(ctx);
const decks = { A: new Deck(ctx, 'A', mixer.input('A')), B: new Deck(ctx, 'B', mixer.input('B')) };
const store = new Store();
const library = new Library(store);
const spotify = new Spotify();
const trackIndex = new Map(); // id -> track (local and Spotify)
const playlistCache = new Map();
const ZOOMS = [2, 4, 6, 8, 12, 16, 24];
let zoomIdx = 3;
let crate = { key: 'local', title: 'Local Files', tracks: [] };
let userCrates = []; // saved crates: { id, name, trackIds: [fingerprint] }
const missingStubs = new Map(); // fingerprint -> placeholder row for a crate track whose file isn't loaded
const libStats = { analyzed: 0 }; // analyzeTrack calls this session (tests check the cache is used)

window.spindeck = { ctx, mixer, decks, library, spotify }; // handy for debugging in the console
Object.assign(window.spindeck, { store, libStats });

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
  if (track.source === 'missing') {
    toast(`“${track.title}” isn't in this session's library — add its file${$('#reconnectBtn').hidden ? '' : ' or reconnect your library'} first.`, 5000);
    return;
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
      libStats.analyzed++;
      track.analysis = await analyzeTrack(buffer);
      // Fall back to a tagged BPM only when detection found nothing.
      if (!track.analysis.bpm && track.bpm) track.analysis.bpm = track.bpm;
      track.bpm = track.analysis.bpm;
      if (track.fp) store.putTrack(trackRecord(track)).catch(console.warn);
    }
    deckLoading[id] = true;
    try {
      await deck.load(buffer, track, track.analysis); // track.cues are restored by the deck
    } finally {
      deckLoading[id] = false;
    }
    restoreCues(deck, track);
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

// ---------- cue persistence & key matching ----------

const deckLoading = { A: false, B: false };
const cueTimers = new Map();

const cuesOf = (deck) => ({ cuePoint: deck.cuePoint, hotCues: deck.hotCues.slice() });

// Fallback for decks whose load() doesn't apply track.cues itself: apply them here.
function restoreCues(deck, track) {
  const c = track.cues;
  if (!c || deck.track !== track) return;
  const hot = c.hotCues || [];
  const same = (a, b) => (a == null ? b == null : b != null && Math.abs(a - b) < 1e-6);
  const applied = (c.cuePoint == null || same(deck.cuePoint, c.cuePoint))
    && deck.hotCues.every((v, i) => same(hot[i] ?? null, v));
  if (applied) return;
  for (let i = 0; i < deck.hotCues.length; i++) deck.hotCues[i] = hot[i] ?? null;
  if (c.cuePoint != null) {
    deck.cuePoint = c.cuePoint;
    if (!deck.playing) deck.seek(c.cuePoint);
  }
  deck.dispatchEvent(new Event('change'));
}

// Save cue changes to the loaded track's saved record (debounced per track).
function rememberCues(id) {
  const deck = decks[id];
  const t = deck.track;
  if (!t?.fp || deckLoading[id] || !deck.hotCues) return;
  const cues = cuesOf(deck);
  const json = JSON.stringify(cues);
  if (json === JSON.stringify(t.cues)) return;
  t.cues = cues;
  clearTimeout(cueTimers.get(t.fp));
  cueTimers.set(t.fp, setTimeout(() => {
    cueTimers.delete(t.fp);
    store.updateTrack(t.fp, { cues: t.cues }).catch(console.warn);
  }, 400));
}

// Key of a deck as heard: shifted by the tempo change unless the deck has key lock on.
function deckKey(deck) {
  const k = deck.analysis?.key || trackKey(deck.track);
  if (!k) return null;
  return deck.keylock ? k.camelot : shiftCamelot(k.camelot, 12 * Math.log2(deck.rate || 1));
}

let keyRefSig = '';
function playingKeys() {
  return Object.values(decks).filter((d) => d.playing).map(deckKey).filter(Boolean);
}
const isKeyMatch = (camelot, refs) => !!camelot && refs.some((r) => camelotCompatible(camelot, r));

// Re-highlight rows only when the reference keys actually change (deck 'change' fires often).
function updateKeyMatches(force = false) {
  const refs = playingKeys();
  const sig = refs.join(',');
  if (!force && sig === keyRefSig) return;
  keyRefSig = sig;
  $$('#trackBody tr').forEach((row) => row.classList.toggle('key-match', isKeyMatch(row.dataset.key, refs)));
}

function setupLibraryDeckHooks() {
  for (const id of ['A', 'B']) {
    decks[id].addEventListener('change', () => {
      rememberCues(id);
      updateKeyMatches();
    });
  }
  // Flush pending cue saves when the page is hidden or goes away.
  const flush = () => {
    for (const d of Object.values(decks)) {
      const t = d.track;
      if (!t?.fp || !cueTimers.has(t.fp)) continue;
      clearTimeout(cueTimers.get(t.fp));
      cueTimers.delete(t.fp);
      store.updateTrack(t.fp, { cues: t.cues }).catch(console.warn);
    }
  };
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
}

// ---------- mixer ----------

function setupMixer() {
  for (const id of ['A', 'B']) {
    const col = $(`.mix-col[data-ch="${id}"]`);
    new Knob($('[data-k="trim"]', col), { label: 'GAIN', onChange: (v) => mixer.setTrim(id, v) });
    new Knob($('[data-k="high"]', col), { label: 'HI', onChange: (v) => mixer.setEq(id, 'high', v) });
    new Knob($('[data-k="mid"]', col), { label: 'MID', onChange: (v) => mixer.setEq(id, 'mid', v) });
    new Knob($('[data-k="low"]', col), { label: 'LOW', onChange: (v) => mixer.setEq(id, 'low', v) });
    new Knob($('[data-k="filter"]', col), { label: 'FILTER', onChange: (v) => mixer.setFilter(id, v) });
    const fader = $(`#fader${id}`);
    fader.addEventListener('input', () => mixer.setFader(id, +fader.value));
    mixer.setFader(id, +fader.value);
  }
  new Knob($('.master-col [data-k="master"]'), {
    label: 'MASTER', min: 0, max: 1, value: 0.8, onChange: (v) => mixer.setMaster(v),
  });
  const xf = $('#xfader');
  xf.addEventListener('input', () => mixer.setCrossfader(+xf.value));
  xf.addEventListener('dblclick', () => { xf.value = 0.5; mixer.setCrossfader(0.5); });
  $('#xfCurve').addEventListener('change', (e) => mixer.setCurve(e.target.value));
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
  if (crate.key.startsWith('crate:') && added.length) {
    const c = userCrates.find((x) => 'crate:' + x.id === crate.key);
    if (c) crate.tracks = crateTracks(c);
  }
  el.textContent = crate.title;
  renderTracks();
  if (added.length) toast(`Added ${added.length} track${added.length === 1 ? '' : 's'}`);
  return added;
}

function selectCrate(key, title, tracks) {
  crate = { key, title, tracks };
  $$('.crate').forEach((c) => c.classList.toggle('active', c.dataset.crate === key));
  $('#crateTitle').textContent = title;
  $('#saveCrateBtn').hidden = !(key === 'liked' || key.startsWith('pl:'));
  renderTracks();
}

function renderTracks() {
  const q = $('#searchInput').value.trim().toLowerCase();
  const list = crate.key === 'local' ? library.tracks : crate.tracks;
  const rows = q && crate.key !== 'search'
    ? list.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q))
    : list;
  const loadedIds = new Set(Object.values(decks).map((d) => d.track?.id));
  const refs = playingKeys();
  keyRefSig = refs.join(',');
  const inUserCrate = crate.key.startsWith('crate:');
  $('#emptyState').hidden = rows.length > 0;
  $('#emptyState').textContent = crate.key === 'local'
    ? 'Drop audio files or a folder here, or use “Add files”.'
    : inUserCrate ? 'Empty crate — drag tracks from your library onto it in the sidebar.' : 'No tracks.';
  $('#trackBody').innerHTML = rows.map((t) => {
    const match = t.source === 'spotify' ? library.findMatch(t) : t;
    const bpm = match?.bpm ? match.bpm.toFixed(1) : '';
    const key = trackKey(match);
    const camelot = key?.camelot || '';
    const art = t.art ? `<img src="${esc(t.art)}" alt="" loading="lazy">` : '<span class="note">♪</span>';
    const local = t.source === 'spotify'
      ? (match ? '<span class="ok" title="Matched a local file">✓</span>' : '<span class="miss" title="No local file">—</span>')
      : t.source === 'missing'
        ? '<span class="miss" title="File not added this session">—</span>'
        : '<span class="ok">●</span>';
    const preview = t.source === 'spotify' ? `<button class="btn tiny pv" data-act="preview" title="Preview on Spotify">▶</button>` : '';
    const remove = inUserCrate ? '<button class="btn tiny" data-act="remove" title="Remove from crate">×</button>' : '';
    const cls = [
      loadedIds.has(match?.id) && 'loaded',
      ((t.source === 'spotify' && !match) || t.source === 'missing') && 'unmatched',
      isKeyMatch(camelot, refs) && 'key-match',
    ].filter(Boolean).join(' ');
    return `<tr draggable="true" data-id="${esc(t.id)}" data-key="${camelot}" class="${cls}">
      <td class="art">${art}</td>
      <td class="title">${esc(t.title)}</td>
      <td>${esc(t.artist)}</td>
      <td class="num">${bpm}</td>
      <td class="key" title="${esc(key?.name || '')}">${camelot}</td>
      <td class="num">${fmtTime(t.duration, false)}</td>
      <td class="center">${local}</td>
      <td class="load">${preview}${remove}<button class="btn tiny" data-act="A">A</button><button class="btn tiny" data-act="B">B</button></td>
    </tr>`;
  }).join('');
}

// ---------- saved library: crates & folders ----------

const trackFp = (t) => (t?.source === 'spotify' ? library.findMatch(t)?.fp : t?.fp) || null;

function crateTracks(c) {
  return c.trackIds.map((fp) => library.byFp.get(fp) || missingStubs.get(fp) || stubFor(fp, null));
}

function stubFor(fp, rec) {
  const name = fp.split('|')[0];
  const stub = {
    id: 'missing:' + fp, fp, source: 'missing',
    title: rec?.title || name, artist: rec?.artist || '', album: rec?.album || '',
    duration: rec?.duration || 0, bpm: rec?.bpm || null, tagKey: rec?.tagKey || null,
    analysis: rec?.analysis?.key ? { key: rec.analysis.key } : null,
  };
  if (rec) missingStubs.set(fp, stub);
  trackIndex.set(stub.id, stub);
  return stub;
}

async function openUserCrate(id) {
  const c = userCrates.find((x) => x.id === id);
  if (!c) return;
  // Fill in saved details for tracks whose files aren't in this session's library.
  await Promise.all(c.trackIds.filter((fp) => !library.byFp.has(fp) && !missingStubs.has(fp)).map(async (fp) => {
    stubFor(fp, await store.getTrack(fp).catch(() => null));
  }));
  selectCrate('crate:' + c.id, c.name, crateTracks(c));
}

function renderUserCrates() {
  $('#userCrates').innerHTML = userCrates.map((c) => `
    <div class="crate user-crate${crate.key === 'crate:' + c.id ? ' active' : ''}" role="button" tabindex="0"
      data-crate="crate:${esc(c.id)}" data-id="${esc(c.id)}" title="Drop tracks here · double-click to rename">
      <span class="crate-name">▣ ${esc(c.name)}</span>
      <span class="crate-side"><span class="count">${c.trackIds.length}</span><button class="crate-del" title="Delete crate" aria-label="Delete crate ${esc(c.name)}">×</button></span>
    </div>`).join('');
}

const saveCrate = (c) => store.putCrate(c).catch((err) => toast(`Couldn't save crate: ${err.message}`));

async function createCrate(name, trackIds = []) {
  const base = name || 'New crate';
  let unique = base;
  for (let n = 2; userCrates.some((c) => c.name === unique); n++) unique = `${base} ${n}`;
  const c = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: unique, trackIds: [...new Set(trackIds)] };
  userCrates.push(c);
  await saveCrate(c);
  renderUserCrates();
  return c;
}

async function addToCrate(crateId, fps) {
  const c = userCrates.find((x) => x.id === crateId);
  if (!c) return 0;
  const fresh = fps.filter((fp) => fp && !c.trackIds.includes(fp));
  if (!fresh.length) return 0;
  c.trackIds.push(...fresh);
  await saveCrate(c);
  renderUserCrates();
  if (crate.key === 'crate:' + c.id) { crate.tracks = crateTracks(c); renderTracks(); }
  return fresh.length;
}

async function removeFromCrate(crateId, fp) {
  const c = userCrates.find((x) => x.id === crateId);
  if (!c) return;
  c.trackIds = c.trackIds.filter((x) => x !== fp);
  await saveCrate(c);
  renderUserCrates();
  if (crate.key === 'crate:' + c.id) { crate.tracks = crateTracks(c); renderTracks(); }
}

async function renameCrate(crateId, name) {
  const c = userCrates.find((x) => x.id === crateId);
  name = name.trim();
  if (!c || !name || name === c.name) return renderUserCrates();
  c.name = name;
  await saveCrate(c);
  renderUserCrates();
  if (crate.key === 'crate:' + c.id) { crate.title = name; $('#crateTitle').textContent = name; }
}

async function deleteCrate(crateId) {
  userCrates = userCrates.filter((x) => x.id !== crateId);
  await store.deleteCrate(crateId).catch(console.warn);
  if (crate.key === 'crate:' + crateId) selectCrate('local', 'Local Files', library.tracks);
  renderUserCrates();
}

function startRename(el) {
  const c = userCrates.find((x) => x.id === el.dataset.id);
  if (!c || el.querySelector('input')) return;
  const input = document.createElement('input');
  input.className = 'crate-rename';
  input.value = c.name;
  input.setAttribute('aria-label', 'Crate name');
  el.querySelector('.crate-name').replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) renameCrate(c.id, input.value); else renderUserCrates();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}

function setupCrates() {
  const box = $('#userCrates');
  $('#newCrateBtn').addEventListener('click', async () => {
    const c = await createCrate();
    const el = box.querySelector(`[data-id="${CSS.escape(c.id)}"]`);
    if (el) startRename(el);
  });
  box.addEventListener('click', (e) => {
    const el = e.target.closest('.user-crate');
    if (!el) return;
    if (e.target.closest('.crate-del')) {
      const c = userCrates.find((x) => x.id === el.dataset.id);
      if (c && confirm(`Delete the crate “${c.name}”? The tracks stay in your library.`)) deleteCrate(c.id);
      return;
    }
    openUserCrate(el.dataset.id);
  });
  box.addEventListener('keydown', (e) => {
    const el = e.target.closest('.user-crate');
    if (el && e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openUserCrate(el.dataset.id); }
    if (el && e.target === el && e.key === 'F2') startRename(el);
  });
  box.addEventListener('dblclick', (e) => {
    const el = e.target.closest('.user-crate');
    if (el && !e.target.closest('.crate-del')) startRename(el);
  });
  // Drop library rows onto a crate.
  const hasTrack = (e) => e.dataTransfer?.types.includes('text/spindeck-track');
  box.addEventListener('dragover', (e) => {
    const el = e.target.closest('.user-crate');
    if (!el || !hasTrack(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    $$('.user-crate.drop', box).forEach((x) => x !== el && x.classList.remove('drop'));
    el.classList.add('drop');
  });
  box.addEventListener('dragleave', (e) => {
    const el = e.target.closest('.user-crate');
    if (el && !el.contains(e.relatedTarget)) el.classList.remove('drop');
  });
  box.addEventListener('drop', async (e) => {
    const el = e.target.closest('.user-crate');
    if (!el || !hasTrack(e)) return;
    e.preventDefault();
    el.classList.remove('drop');
    const t = trackIndex.get(e.dataTransfer.getData('text/spindeck-track'));
    const fp = trackFp(t);
    if (!fp) return toast('Only tracks with a local file can go in a crate');
    const c = userCrates.find((x) => x.id === el.dataset.id);
    const n = await addToCrate(el.dataset.id, [fp]);
    toast(n ? `Added “${t.title}” to ${c.name}` : `“${t.title}” is already in ${c.name}`);
  });

  $('#saveCrateBtn').addEventListener('click', async () => {
    const fps = [...new Set(crate.tracks.map(trackFp).filter(Boolean))];
    if (!fps.length) return toast('None of these tracks match a local file yet — add the files first');
    const c = await createCrate(crate.title, fps);
    toast(`Saved crate “${c.name}” with ${fps.length} of ${crate.tracks.length} tracks`);
  });
}

// Chrome/Edge: remember picked folders so the library can be re-imported after a reload.
let pendingFolders = [];

async function importFolders(entries) {
  const files = [];
  for (const entry of entries) {
    try {
      files.push(...await filesFromDirectory(entry.handle));
    } catch (err) {
      console.warn(err);
      toast(`Couldn't read the folder “${entry.name}”: ${err.message}`);
    }
  }
  if (files.length) await addFiles(files);
}

function showReconnect() {
  const btn = $('#reconnectBtn');
  btn.hidden = pendingFolders.length === 0;
  btn.title = `Re-open your saved music folders: ${pendingFolders.map((f) => f.name).join(', ')}`;
}

async function pickFolder() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'spindeck-music', mode: 'read' });
  } catch (err) {
    if (err.name !== 'AbortError') toast(`Couldn't open the folder: ${err.message}`);
    return;
  }
  const saved = await store.getHandles().catch(() => []);
  let entry = null;
  for (const s of saved) if (await s.handle.isSameEntry?.(handle).catch(() => false)) entry = s;
  if (!entry) {
    entry = { id: Date.now().toString(36), name: handle.name, handle };
    await store.putHandle(entry).catch((err) => console.warn('SpinDeck: could not remember folder', err));
  }
  pendingFolders = pendingFolders.filter((f) => f.id !== entry.id);
  showReconnect();
  await importFolders([entry]);
}

async function restoreFolders() {
  const saved = await store.getHandles().catch(() => []);
  const granted = [];
  for (const entry of saved) {
    const state = await entry.handle.queryPermission?.({ mode: 'read' }).catch(() => 'denied');
    (state === 'granted' ? granted : pendingFolders).push(entry);
  }
  showReconnect();
  if (granted.length) await importFolders(granted);
}

async function reconnectFolders() {
  const ok = [];
  for (const entry of pendingFolders) {
    try {
      if (await entry.handle.requestPermission({ mode: 'read' }) === 'granted') ok.push(entry);
    } catch (err) { console.warn(err); }
  }
  pendingFolders = pendingFolders.filter((f) => !ok.includes(f));
  showReconnect();
  if (ok.length) await importFolders(ok);
  else toast('Permission to read your music folder was not granted');
}

async function initSavedLibrary() {
  userCrates = await store.getCrates().catch(() => []);
  renderUserCrates();
  if (window.showDirectoryPicker) await restoreFolders();
}

function setupLibrary() {
  $('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('#folderInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  if (window.showDirectoryPicker) {
    $('#folderInput').closest('label').addEventListener('click', (e) => {
      e.preventDefault();
      pickFolder();
    });
  }
  $('#reconnectBtn').addEventListener('click', reconnectFolders);
  $('[data-crate="local"]').addEventListener('click', () => selectCrate('local', 'Local Files', library.tracks));
  setupCrates();
  setupLibraryDeckHooks();
  window.spindeck.crates = { list: () => userCrates, create: createCrate, add: addToCrate, remove: removeFromCrate, open: openUserCrate };
  window.spindeck.ready = initSavedLibrary().catch((err) => console.warn('SpinDeck: saved library', err));

  const body = $('#trackBody');
  body.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    const row = e.target.closest('tr');
    if (!btn || !row) return;
    const t = trackIndex.get(row.dataset.id);
    if (btn.dataset.act === 'preview') previewSpotify(t);
    else if (btn.dataset.act === 'remove') removeFromCrate(crate.key.slice(6), trackFp(t));
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
