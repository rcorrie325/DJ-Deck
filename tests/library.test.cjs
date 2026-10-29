// Key detection, saved library (IndexedDB), cue persistence, crates and stored folder handles.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MUSIC, chromium, generated, openApp, addFiles, loadDeck, assert, near } = require('./lib.cjs');

const REAL = [
  'Kevin_MacLeod_-_Vibe_Ace.hq.ogg',
  'admiralbob77_-_Choice_-_Drum-bass.hq.ogg',
  '442789__lena-orsa__happy-music-pistachio-ice-cream-ragtime.hq.ogg',
  'Karissa_Hobbs_-_Lets_Go_Fishin.hq.ogg',
];

// Renders chords (arrays of Hz) with oscillators and runs the result through analyzeTrack.
const keyOfChords = (page, chords, secondsEach, type) => page.evaluate(async ([chords, secs, type]) => {
  const { analyzeTrack } = await import('/js/analysis.js');
  const sr = 44100;
  const off = new OfflineAudioContext(2, Math.ceil(sr * secs * chords.length), sr);
  chords.forEach((freqs, i) => freqs.forEach((f) => {
    const o = off.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const g = off.createGain();
    g.gain.value = 0.12;
    o.connect(g).connect(off.destination);
    o.start(i * secs);
    o.stop((i + 1) * secs);
  }));
  const a = await analyzeTrack(await off.startRendering());
  return a.key;
}, [chords, secondsEach, type]);

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const chord = (...notes) => notes.map(hz);

// Polls the saved record of the first library track until pred(record, arg) holds.
async function waitSaved(page, pred, arg, timeout = 5000) {
  const end = Date.now() + timeout;
  for (;;) {
    const rec = await page.evaluate(async () => {
      const t = window.spindeck.library.tracks[0];
      const r = t && await window.spindeck.store.getTrack(t.fp);
      return r && { cues: r.cues, analysis: { bpm: r.analysis?.bpm } };
    });
    if (pred(rec, arg)) return rec;
    if (Date.now() > end) throw new Error(`saved record never matched: ${JSON.stringify(rec)}`);
    await page.waitForTimeout(100);
  }
}

module.exports = {
  async 'detects musical keys on synthesized chords'({ browser, baseUrl }) {
    const page = await openApp(browser, baseUrl);
    // Sustained C major triad over a C bass.
    const cMajor = await keyOfChords(page, [chord(48, 60, 64, 67)], 12, 'sine');
    assert(cMajor?.camelot === '8B' && cMajor.name === 'C major' && cMajor.tonic === 0 && cMajor.mode === 'major',
      `C major triad: got ${JSON.stringify(cMajor)}`);
    // Sustained A minor triad, and an Am–Dm–E–Am progression with richer (triangle) tones.
    const aMinor = await keyOfChords(page, [chord(45, 57, 60, 64)], 12, 'sine');
    assert(aMinor?.camelot === '8A' && aMinor.name === 'A minor', `A minor triad: got ${JSON.stringify(aMinor)}`);
    const prog = await keyOfChords(page, [chord(45, 57, 60, 64), chord(50, 57, 62, 65), chord(40, 56, 59, 64), chord(45, 57, 60, 64)], 3, 'triangle');
    assert(prog?.camelot === '8A', `Am–Dm–E–Am progression: got ${JSON.stringify(prog)}`);
    // Silence has no key.
    const silent = await page.evaluate(async () => {
      const { analyzeTrack } = await import('/js/analysis.js');
      return (await analyzeTrack(new AudioBuffer({ length: 44100 * 5, sampleRate: 44100 }))).key;
    });
    assert(silent === null, `silence should have no key, got ${JSON.stringify(silent)}`);

    const helpers = await page.evaluate(async () => {
      const { shiftCamelot, camelotCompatible } = await import('/js/analysis.js');
      return {
        up1: shiftCamelot('8B', 1), down2: shiftCamelot('8A', -2), obj: shiftCamelot({ camelot: '8B', name: 'C major', tonic: 0, mode: 'major' }, 2),
        compat: [['8B', '8B'], ['8B', '9B'], ['8B', '7B'], ['8B', '8A'], ['12A', '1A'], ['8B', '9A'], ['8B', '10B'], ['8A', '3A']].map(([a, b]) => camelotCompatible(a, b)),
      };
    });
    assert(helpers.up1 === '3B' && helpers.down2 === '6A' && helpers.obj.camelot === '10B' && helpers.obj.name === 'D major',
      `shiftCamelot: ${JSON.stringify(helpers)}`);
    assert(JSON.stringify(helpers.compat) === JSON.stringify([true, true, true, true, true, false, false, false]),
      `camelotCompatible: ${helpers.compat}`);
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async 'reports keys of real tracks (informational)'({ browser, baseUrl }) {
    if (!REAL.every((f) => fs.existsSync(path.join(MUSIC, f)))) return 'skip';
    const page = await openApp(browser, baseUrl);
    for (const file of REAL) {
      const r = await page.evaluate(async (url) => {
        const { analyzeTrack, chromagram, keyFromChroma } = await import('/js/analysis.js');
        const buf = await window.spindeck.ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
        const t0 = performance.now();
        const a = await analyzeTrack(buf);
        const ms = performance.now() - t0;
        const mono = new OfflineAudioContext(1, Math.ceil(buf.duration * 11025), 11025);
        const s = mono.createBufferSource();
        s.buffer = buf; s.connect(mono.destination); s.start();
        const { score } = keyFromChroma(chromagram((await mono.startRendering()).getChannelData(0), 11025));
        return { key: a.key, bpm: a.bpm, ms: Math.round(ms), dur: Math.round(buf.duration), score };
      }, `/tests/.music/${file}`);
      console.log(`      ${file}: ${r.key ? `${r.key.camelot} (${r.key.name})` : 'no key'}, corr ${r.score.toFixed(2)}, ${r.bpm} BPM — analyzeTrack ${r.ms} ms for ${r.dur} s`);
      assert(r.ms < 3000, `analysis took ${r.ms} ms`);
    }
    await page.close();
  },

  async 'restores tags, analysis and cues when the same files are re-added after a reload'({ browser, baseUrl }) {
    const files = [generated.groove124(), generated.rolling128()];
    const page = await openApp(browser, baseUrl);
    await addFiles(page, files);
    await loadDeck(page, 1, 'A');
    await page.keyboard.press('1'); // hot cue 1 at the cue point
    await page.evaluate(() => window.spindeck.decks.A.seek(5));
    await page.keyboard.press('2');
    const before = await page.evaluate(() => {
      const d = window.spindeck.decks.A;
      return { hot: d.hotCues.slice(), cue: d.cuePoint, bpm: d.bpm, key: d.analysis.key, analyzed: window.spindeck.libStats.analyzed };
    });
    near(before.bpm, 124, 0.05, 'bpm before reload');
    assert(before.hot[0] != null && Math.abs(before.hot[1] - 5) < 0.01, `hot cues set: ${before.hot}`);
    assert(before.analyzed === 1, 'analyzed once');
    await waitSaved(page, (rec, hot1) => rec?.cues && Math.abs(rec.cues.hotCues[1] - hot1) < 1e-6 && rec.analysis?.bpm, before.hot[1]);

    await page.reload();
    await page.evaluate(() => window.spindeck.ready);
    assert(await page.$$eval('#trackBody tr', (r) => r.length) === 0, 'library starts empty after reload');
    await addFiles(page, files);
    const restored = await page.evaluate(() => {
      const t = window.spindeck.library.tracks.find((x) => x.title === 'Groove 124');
      return {
        bpm: t.analysis?.bpm, peaks: t.analysis?.peaks?.[0]?.constructor.name, bins: t.analysis?.peaks?.[0]?.length,
        cues: t.cues, keyCell: document.querySelector(`#trackBody tr[data-id="${t.id}"] td.key`).textContent,
      };
    });
    near(restored.bpm, 124, 0.05, 'restored bpm');
    assert(restored.peaks === 'Float32Array' && restored.bins > 8000, `restored peaks: ${restored.peaks} ×${restored.bins}`);
    assert(restored.cues && Math.abs(restored.cues.hotCues[1] - 5) < 0.01, `restored cues: ${JSON.stringify(restored.cues)}`);
    assert(restored.keyCell === (before.key?.camelot || ''), `key column shows ${restored.keyCell}, expected ${before.key?.camelot}`);

    await loadDeck(page, 1, 'A');
    const after = await page.evaluate(() => {
      const d = window.spindeck.decks.A;
      return { hot: d.hotCues.slice(), cue: d.cuePoint, bpm: d.bpm, analyzed: window.spindeck.libStats.analyzed, pos: d.position };
    });
    assert(after.analyzed === 0, `track was re-analyzed (${after.analyzed}×) despite the cache`);
    near(after.bpm, 124, 0.05, 'deck bpm after reload');
    near(after.hot[0], before.hot[0], 1e-6, 'hot cue 1 restored');
    near(after.hot[1], before.hot[1], 1e-6, 'hot cue 2 restored');
    near(after.cue, before.cue, 1e-6, 'cue point restored');
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async 'crates: create, rename, drag tracks in, persist, highlight compatible keys, delete'({ browser, baseUrl }) {
    const files = [generated.groove124(), generated.rolling128(), generated.ninety()];
    const page = await openApp(browser, baseUrl);
    page.on('dialog', (d) => d.accept());
    await page.click('#newCrateBtn');
    await page.fill('#userCrates .crate-rename', 'Warmup');
    await page.press('#userCrates .crate-rename', 'Enter');
    await page.waitForSelector('#userCrates .user-crate .crate-name:text("Warmup")');
    await addFiles(page, files);
    await page.dragAndDrop('#trackBody tr:nth-child(1)', '#userCrates .user-crate');
    await page.dragAndDrop('#trackBody tr:nth-child(3)', '#userCrates .user-crate');
    await page.dragAndDrop('#trackBody tr:nth-child(1)', '#userCrates .user-crate'); // duplicate: ignored
    await page.waitForFunction(() => document.querySelector('#userCrates .count').textContent === '2');

    // Rename by double-click.
    await page.dblclick('#userCrates .user-crate .crate-name');
    await page.fill('#userCrates .crate-rename', 'Opening set');
    await page.press('#userCrates .crate-rename', 'Enter');
    await page.waitForSelector('#userCrates .crate-name:text("Opening set")');

    // Key highlighting against the playing deck (keys forced so the check is deterministic).
    await loadDeck(page, 1, 'A');
    const keys = await page.evaluate(() => {
      const { library, decks } = window.spindeck;
      const set = (t, camelot) => { t.analysis ??= {}; t.analysis.key = { camelot }; };
      set(decks.A.track, '8B');
      library.tracks[1].tagKey = { camelot: '9B' }; // compatible
      library.tracks[2].tagKey = { camelot: '3A' }; // not compatible
      document.querySelector('[data-crate="local"]').click();
      decks.A.play();
      return [...document.querySelectorAll('#trackBody tr')].map((r) => [r.dataset.key, r.classList.contains('key-match')]);
    });
    await page.evaluate(() => window.spindeck.decks.A.pause());
    assert(JSON.stringify(keys) === JSON.stringify([['8B', true], ['9B', true], ['3A', false]]), `key-match rows: ${JSON.stringify(keys)}`);

    await page.reload();
    await page.evaluate(() => window.spindeck.ready);
    const crates = await page.evaluate(() => window.spindeck.crates.list().map((c) => ({ name: c.name, n: c.trackIds.length })));
    assert(JSON.stringify(crates) === JSON.stringify([{ name: 'Opening set', n: 2 }]), `crates after reload: ${JSON.stringify(crates)}`);
    await page.click('#userCrates .user-crate');
    await page.waitForFunction(() => document.querySelector('#crateTitle').textContent === 'Opening set');
    let rows = await page.$$eval('#trackBody tr', (r) => r.map((x) => [x.querySelector('.title').textContent, x.classList.contains('unmatched')]));
    assert(JSON.stringify(rows) === JSON.stringify([['Groove 124', true], ['Ninety', true]]), `crate rows before files: ${JSON.stringify(rows)}`);
    await page.click('#trackBody tr:nth-child(1) button[data-act="A"]');
    assert((await page.textContent('#toast')).includes('add its file'), 'missing file explains itself');
    await page.setInputFiles('#fileInput', files);
    await page.waitForFunction(() => window.spindeck.library.tracks.length === 3);
    rows = await page.$$eval('#trackBody tr', (r) => r.map((x) => [x.querySelector('.title').textContent, x.classList.contains('unmatched')]));
    assert(JSON.stringify(rows) === JSON.stringify([['Groove 124', false], ['Ninety', false]]), `crate rows after re-adding files: ${JSON.stringify(rows)}`);
    await loadDeck(page, 2, 'B');

    // Remove one track, then delete the crate.
    await page.click('#trackBody tr:nth-child(1) button[data-act="remove"]');
    await page.waitForFunction(() => document.querySelectorAll('#trackBody tr').length === 1);
    await page.hover('#userCrates .user-crate');
    await page.click('#userCrates .crate-del');
    await page.waitForFunction(() => !document.querySelector('#userCrates .user-crate'));
    assert(await page.textContent('#crateTitle') === 'Local Files', 'deleting the open crate returns to Local Files');
    await page.reload();
    await page.evaluate(() => window.spindeck.ready);
    assert((await page.evaluate(() => window.spindeck.crates.list().length)) === 0, 'deleted crate stays deleted');
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async 'stored folder handle re-imports after reload; Reconnect asks for permission'({ baseUrl }) {
    // Chromium crashes when it reads a directory handle back from IndexedDB in an off-the-record
    // context (what browser.newPage() gives), so this test uses a real on-disk profile.
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'spindeck-profile-'));
    const context = await chromium.launchPersistentContext(profile, { args: ['--autoplay-policy=no-user-gesture-required'] });
    try {
      await folderTest(context, baseUrl);
    } finally {
      await context.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  },

  async 'saves a Spotify playlist as a crate of its matched local tracks'({ browser, baseUrl }) {
    const page = await openApp(browser, baseUrl);
    const sp = (id, name, artist) => ({ id, uri: `spotify:track:${id}`, name, duration_ms: 60000, artists: [{ name: artist }], album: { name: 'X', images: [] } });
    await page.route('https://accounts.spotify.com/authorize**', (r) => r.fulfill({ body: 'auth' }));
    await page.route('https://accounts.spotify.com/api/token', (r) => r.fulfill({ json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 } }));
    await page.route('https://api.spotify.com/v1/**', (r) => {
      const p = new URL(r.request().url()).pathname;
      if (p === '/v1/me') return r.fulfill({ json: { id: 'u1', display_name: 'Test User', images: [] } });
      if (p === '/v1/me/playlists') return r.fulfill({ json: { items: [{ id: 'pl1', name: 'Friday Set' }], next: null } });
      if (p === '/v1/playlists/pl1/items') {
        return r.fulfill({ json: { next: null, items: [{ item: sp('t1', 'Groove 124', 'DJ Test') }, { item: sp('t3', 'Not On Disk', 'Nobody') }, { item: sp('t2', 'Rolling 128', 'Beat Maker') }] } });
      }
      return r.fulfill({ status: 404, json: {} });
    });
    await page.click('#settingsBtn');
    await page.fill('#clientIdInput', 'abc123');
    await page.click('#saveSettings');
    await page.click('#spotifyBtn');
    await page.waitForURL(/accounts\.spotify\.com/);
    const state = new URL(page.url()).searchParams.get('state');
    await page.goto(`${baseUrl}?code=CODE&state=${state}`);
    await page.waitForSelector('[data-crate="pl:pl1"]');
    await addFiles(page, [generated.groove124(), generated.rolling128()]);
    assert(await page.isHidden('#saveCrateBtn'), 'no Save as crate on local files');
    await page.click('[data-crate="pl:pl1"]');
    await page.waitForFunction(() => document.querySelector('#crateTitle').textContent === 'Friday Set');
    await page.click('#saveCrateBtn');
    await page.waitForFunction(() => window.spindeck.crates.list().length === 1);
    const c = await page.evaluate(() => window.spindeck.crates.list()[0]);
    assert(c.name === 'Friday Set' && c.trackIds.length === 2 && c.trackIds[0].startsWith('DJ Test - Groove 124.wav|'),
      `saved crate: ${JSON.stringify(c)}`);
    assert((await page.textContent('#toast')).includes('2 of 3'), 'toast reports matched count');
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async 'library UI fits at desktop and phone widths'({ browser, baseUrl }) {
    const page = await openApp(browser, baseUrl);
    await page.click('#newCrateBtn');
    await page.press('#userCrates .crate-rename', 'Enter');
    await addFiles(page, [generated.groove124(), generated.rolling128()]);
    await loadDeck(page, 1, 'A');
    const shots = process.env.SPINDECK_SHOTS;
    if (shots) await page.screenshot({ path: path.join(shots, 'library-1440.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForTimeout(100);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    if (shots) await page.screenshot({ path: path.join(shots, 'library-390.png'), fullPage: true });
    assert(width <= 390, `page is ${width}px wide at a 390px viewport`);
    assert(await page.isVisible('#trackBody tr:nth-child(1) td.key'), 'key column visible on phones');
    await page.close();
  },
};

async function folderTest(context, baseUrl) {
  // Stand in for the native picker with a real handle from the origin-private file system.
  const init = () => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Music', { create: true });
    if (sessionStorage.getItem('forcePrompt')) {
      window.permissionRequests = 0;
      FileSystemHandle.prototype.queryPermission = async () => 'prompt';
      FileSystemHandle.prototype.requestPermission = async () => { window.permissionRequests++; return 'granted'; };
    }
  };
  const page = await openApp(context, baseUrl, { init });
  const name = path.basename(generated.groove124());
  await page.evaluate(async (name) => {
    const bytes = await (await fetch(`/tests/.cache/${name}`)).arrayBuffer();
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('Music', { create: true })).getDirectoryHandle('House', { create: true });
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(bytes);
    await w.close();
    await (await root.getDirectoryHandle('Music')).getFileHandle('notes.txt', { create: true }); // non-audio: ignored
  }, name);
  await page.click('label:has(#folderInput)');
  await page.waitForFunction(() => window.spindeck.library.tracks.length === 1);
  assert(await page.isHidden('#reconnectBtn'), 'no reconnect button while the folder is open');

  // Permission still granted (Chrome's "allow on every visit"): imports by itself.
  await page.reload();
  await page.evaluate(() => window.spindeck.ready);
  await page.waitForFunction(() => window.spindeck.library.tracks.length === 1);

  // Permission needs a prompt: the sidebar offers Reconnect.
  await page.evaluate(() => sessionStorage.setItem('forcePrompt', '1'));
  await page.reload();
  await page.evaluate(() => window.spindeck.ready);
  assert(await page.isVisible('#reconnectBtn'), 'reconnect button shown');
  assert((await page.evaluate(() => window.spindeck.library.tracks.length)) === 0, 'nothing imported before permission');
  await page.click('#reconnectBtn');
  await page.waitForFunction(() => window.spindeck.library.tracks.length === 1);
  assert(await page.evaluate(() => window.permissionRequests) === 1, 'permission requested once');
  assert(await page.isHidden('#reconnectBtn'), 'reconnect button hidden after reconnecting');
  assert(page.errors.length === 0, `page errors: ${page.errors}`);
  await page.close();
}
