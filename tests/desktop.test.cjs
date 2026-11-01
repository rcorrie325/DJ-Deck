// Desktop-app behaviour in the page, with a fake window.spindeckDesktop bridge standing in for
// Electron (desktop/preload.cjs). The bridge keeps its "disk" and remembered songs in
// localStorage, so a page reload acts like quitting and reopening the app.
const fs = require('fs');
const path = require('path');
const { generated, CACHE, openApp, assert, near } = require('./lib.cjs');

// The fake Mac: { [path]: { size, mtime } }. Paths are URLs on the test server.
function fakeDesktop(initialDisk) {
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  if (!localStorage.getItem('__fakeDisk')) localStorage.setItem('__fakeDisk', JSON.stringify(initialDisk));
  const disk = () => load('__fakeDisk', {});
  const sources = () => load('__fakeSources', { files: [], folders: [] });
  const entry = (p) => {
    const f = disk()[p];
    return f ? { path: p, name: p.split('/').pop(), size: f.size, mtime: f.mtime } : null;
  };
  const inFolder = (dir) => Object.keys(disk()).filter((p) => p.startsWith(dir + '/')).map(entry);
  const add = (paths) => {
    const s = sources();
    const out = [];
    for (const p of paths) {
      if (disk()[p]) { s.files.push(p); out.push(entry(p)); } else if (inFolder(p).length) { s.folders.push(p); out.push(...inFolder(p)); }
    }
    s.files = [...new Set(s.files)];
    s.folders = [...new Set(s.folders)];
    localStorage.setItem('__fakeSources', JSON.stringify(s));
    return out;
  };
  window.__desktopCalls = [];
  window.spindeckDesktop = {
    platform: 'darwin',
    pickFiles: async () => { window.__desktopCalls.push('pickFiles'); return add(window.__pick || []); },
    pickFolder: async () => { window.__desktopCalls.push('pickFolder'); return add(window.__pickFolder ? [window.__pickFolder] : []); },
    restoreLibrary: async () => {
      const s = sources();
      const entries = [];
      const missing = [];
      for (const d of s.folders) { const e = inFolder(d); if (e.length) entries.push(...e); else missing.push(d); }
      for (const p of s.files) { const e = entry(p); if (e) entries.push(e); else missing.push(p); }
      return { entries, missing };
    },
    locate: async () => { const [e] = window.__locate ? add([window.__locate]) : []; return e || null; },
    addDroppedFiles: async (files) => add(Array.from(files, (f) => (window.__dropPaths || {})[f.name]).filter(Boolean)),
    mediaUrl: (p) => encodeURI(p),
    onMenu: (cb) => { window.__menu = cb; },
    onOpenEntries: (cb) => { window.__openEntries = cb; },
  };
}

const urlFor = (file) => '/tests/.cache/' + path.relative(CACHE, file).split(path.sep).join('/');
function diskFor(files) {
  return Object.fromEntries(files.map((f) => {
    const st = fs.statSync(f);
    return [urlFor(f), { size: st.size, mtime: Math.floor(st.mtimeMs) }];
  }));
}

async function openDesktop(browser, baseUrl, files) {
  const page = await openApp(browser, baseUrl, { init: `(${fakeDesktop})(${JSON.stringify(diskFor(files))})` });
  await page.waitForFunction(() => window.spindeck?.ready);
  await page.evaluate(() => window.spindeck.ready);
  return page;
}

async function restart(page) {
  await page.reload();
  await page.waitForFunction(() => window.spindeck?.ready);
  await page.evaluate(() => window.spindeck.ready);
}

const rows = (page) => page.$$eval('#trackBody tr', (r) => r.map((x) => x.querySelector('.title').textContent));
const loadRow = async (page, title, deck) => {
  await page.click(`#trackBody tr:has(.title:text-is("${title}")) button[data-act="${deck}"]`);
  await page.waitForFunction(([d, t]) => window.spindeck.decks[d].track?.title === t, [deck, title]);
};

module.exports = {
  async 'desktop: songs, decks and mixer come back after quitting and reopening'({ browser, baseUrl }) {
    const files = [generated.groove124(), generated.rolling128()];
    const page = await openDesktop(browser, baseUrl, files);
    await page.evaluate((p) => { window.__pick = p; }, files.map(urlFor));
    await page.click('label:has(#fileInput)'); // "Add files" opens the Mac file picker, not the browser's
    await page.waitForFunction(() => document.querySelectorAll('#trackBody tr').length === 2);
    assert((await page.evaluate(() => window.__desktopCalls)).includes('pickFiles'), 'native picker used');

    await loadRow(page, 'Groove 124', 'A');
    await loadRow(page, 'Rolling 128', 'B');
    await page.evaluate(() => {
      const { decks, knobs } = window.spindeck;
      decks.A.setRate(1.05);
      decks.A.seek(12);
      decks.B.seek(20);
      knobs['A.high'].value = 0.5;
    });
    await page.click('#deckA .keylock');
    await page.click('#deckB .loop[data-beats="4"]');
    await page.evaluate(() => {
      const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set('#faderB', 0.4);
      set('#xfader', 0.2);
      const type = document.querySelector('.mix-col[data-ch="A"] .fx-type');
      type.value = 'reverb';
      type.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.click('.mix-col[data-ch="A"] .fx-on');
    await page.waitForTimeout(1500); // the session is saved every second

    await restart(page);

    assert(JSON.stringify((await rows(page)).sort()) === JSON.stringify(['Groove 124', 'Rolling 128']), `library after restart: ${await rows(page)}`);
    assert(await page.isHidden('#reconnectBtn'), 'no Reconnect button needed');
    const s = await page.evaluate(() => {
      const { decks, knobs, mixer } = window.spindeck;
      const d = (k) => ({ title: k.track?.title, pos: k.position, rate: k.rate, keylock: k.keylock, loop: k.loop, playing: k.playing });
      return {
        A: d(decks.A), B: d(decks.B), high: knobs['A.high'].value,
        faderB: +document.querySelector('#faderB').value, xfader: +document.querySelector('#xfader').value, fx: mixer.getFx('A'),
      };
    });
    assert(s.A.title === 'Groove 124' && s.B.title === 'Rolling 128', `decks: ${s.A.title} / ${s.B.title}`);
    assert(!s.A.playing && !s.B.playing, 'restored paused, never auto-plays');
    near(s.A.pos, 12, 0.05, 'deck A position');
    near(s.A.rate, 1.05, 1e-6, 'deck A tempo');
    assert(s.A.keylock, 'deck A key lock');
    assert(s.B.loop?.beats === 4, `deck B loop: ${JSON.stringify(s.B.loop)}`);
    near(s.B.pos, 20, 0.6, 'deck B position (inside its loop)');
    near(s.high, 0.5, 1e-6, 'EQ knob');
    near(s.faderB, 0.4, 1e-6, 'channel fader B');
    near(s.xfader, 0.2, 1e-6, 'crossfader');
    assert(s.fx.type === 'reverb' && s.fx.on, `FX: ${JSON.stringify(s.fx)}`);
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async 'desktop: a moved song shows as missing, and Locate… brings it back with its cues'({ browser, baseUrl }) {
    const files = [generated.groove124(), generated.rolling128()];
    const page = await openDesktop(browser, baseUrl, files);
    await page.evaluate((p) => { window.__pick = p; }, files.map(urlFor));
    await page.click('label:has(#fileInput)');
    await page.waitForFunction(() => document.querySelectorAll('#trackBody tr').length === 2);
    await loadRow(page, 'Rolling 128', 'A');
    await page.evaluate(() => window.spindeck.decks.A.hotCue(0)); // a hot cue to check it survives the move
    const fp = await page.evaluate(() => window.spindeck.decks.A.track.fp);
    const crateId = await page.evaluate(async (f) => (await window.spindeck.crates.create('Friday', [f])).id, fp);
    await page.waitForTimeout(600);

    // Move the file on "disk" (same name, size and date — like dragging it to another folder in Finder).
    const moved = path.join(CACHE, 'moved', path.basename(files[1]));
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.copyFileSync(files[1], moved);
    const st = fs.statSync(files[1]);
    fs.utimesSync(moved, st.atime, st.mtime);
    await page.evaluate(([from, to]) => {
      const disk = JSON.parse(localStorage.getItem('__fakeDisk'));
      disk[to] = disk[from];
      delete disk[from];
      localStorage.setItem('__fakeDisk', JSON.stringify(disk));
    }, [urlFor(files[1]), urlFor(moved)]);

    await restart(page);
    assert((await page.textContent('#toast')).includes("couldn't be found"), 'missing song reported');
    assert(JSON.stringify(await rows(page)) === JSON.stringify(['Groove 124']), 'only the song still in place is in the library');

    await page.evaluate((id) => window.spindeck.crates.open(id), crateId);
    await page.waitForSelector('#trackBody tr.unmatched button[data-act="locate"]');
    await page.evaluate((p) => { window.__locate = p; }, urlFor(moved));
    await page.click('#trackBody tr.unmatched button[data-act="locate"]');
    await page.waitForFunction(() => !document.querySelector('#trackBody tr.unmatched'));
    const t = await page.evaluate((f) => { const tr = window.spindeck.library.byFp.get(f); return tr && { fp: tr.fp, cues: tr.cues }; }, fp);
    assert(t && t.fp === fp, 'moved file reattached to the same track');
    assert(t.cues?.hotCues?.[0] != null, `hot cue kept: ${JSON.stringify(t.cues)}`);
    await loadRow(page, 'Rolling 128', 'B'); // and it plays from its new place
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async 'desktop: songs dragged in from Finder are remembered'({ browser, baseUrl }) {
    const files = [generated.groove124()];
    const page = await openDesktop(browser, baseUrl, files);
    await page.evaluate(([name, p]) => {
      window.__dropPaths = { [name]: p };
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], name));
      document.querySelector('#dropZone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, [path.basename(files[0]), urlFor(files[0])]);
    await page.waitForFunction(() => document.querySelectorAll('#trackBody tr').length === 1);
    await restart(page);
    assert(JSON.stringify(await rows(page)) === JSON.stringify(['Groove 124']), 'dropped song back after restart');
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async 'browser version: mixer settings are remembered too'({ browser, baseUrl }) {
    const page = await openApp(browser, baseUrl);
    await page.waitForFunction(() => window.spindeck?.ready);
    await page.evaluate(() => window.spindeck.ready);
    await page.evaluate(() => {
      window.spindeck.knobs['B.low'].value = -0.5;
      const x = document.querySelector('#xfader');
      x.value = 0.8;
      x.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(1500);
    await restart(page);
    near(await page.evaluate(() => window.spindeck.knobs['B.low'].value), -0.5, 1e-6, 'EQ low B restored');
    near(await page.$eval('#xfader', (e) => +e.value), 0.8, 1e-6, 'crossfader restored');
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },
};
