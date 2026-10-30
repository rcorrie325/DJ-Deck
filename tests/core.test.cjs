// Decks, analysis, sync and loops on generated tracks with known tempo and offset.
const { generated, openApp, addFiles, loadDeck, assert, near } = require('./lib.cjs');

const deckState = (page) => page.evaluate(() => Object.fromEntries(['A', 'B'].map((id) => {
  const d = window.spindeck.decks[id];
  return [id, {
    bpm: d.bpm, firstBeat: d.firstBeat, pos: d.position, playing: d.playing,
    rate: d.rate, currentBpm: d.currentBpm, phase: d.beatPhase(), loop: d.loop, hotCues: d.hotCues,
  }];
})));

module.exports = {
  async 'detects BPM and first beat on generated tracks'({ browser, baseUrl }) {
    const page = await openApp(browser, baseUrl);
    await addFiles(page, [generated.groove124(), generated.rolling128()]);
    await loadDeck(page, 1, 'A');
    await loadDeck(page, 2, 'B');
    const s = await deckState(page);
    near(s.A.bpm, 124, 0.05, 'deck A bpm');
    near(s.A.firstBeat, 0.37, 0.01, 'deck A first beat');
    near(s.B.bpm, 128, 0.05, 'deck B bpm');
    near(s.B.firstBeat, 0.11, 0.01, 'deck B first beat');
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async 'plays, syncs tempo and phase, loops and sets hot cues'({ browser, baseUrl }) {
    const page = await openApp(browser, baseUrl);
    await addFiles(page, [generated.groove124(), generated.rolling128()]);
    await loadDeck(page, 1, 'A');
    await loadDeck(page, 2, 'B');
    await page.click('#deckA .play');
    await page.keyboard.press('p');
    await page.waitForTimeout(1200);
    let s = await deckState(page);
    assert(s.A.playing && s.B.playing, 'both decks should be playing');
    assert(s.A.pos > 1, `deck A should have advanced, pos=${s.A.pos}`);

    await page.click('#deckB .sync');
    await page.waitForTimeout(200);
    s = await deckState(page);
    near(s.B.currentBpm, 124, 0.01, 'deck B synced bpm');
    const phaseDiff = Math.abs(((s.A.phase - s.B.phase + 1.5) % 1) - 0.5);
    assert(phaseDiff < 0.02, `beat phases should match, diff=${phaseDiff}`);

    await page.click('#deckA .loop[data-beats="4"]');
    await page.waitForTimeout(2500); // longer than a 4-beat loop at 124 BPM (1.94 s)
    s = await deckState(page);
    assert(s.A.loop, 'loop should be active');
    near(s.A.loop.end - s.A.loop.start, (4 * 60) / 124, 0.001, 'loop length');
    assert(s.A.pos >= s.A.loop.start && s.A.pos < s.A.loop.end, `position ${s.A.pos} should stay inside the loop`);

    await page.keyboard.press('1');
    s = await deckState(page);
    assert(s.A.hotCues[0] != null, 'hot cue 1 should be set');
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async 'sync handles a large tempo gap by widening the pitch range'({ browser, baseUrl }) {
    const page = await openApp(browser, baseUrl);
    await addFiles(page, [generated.groove124(), generated.ninety()]);
    await loadDeck(page, 1, 'A');
    await loadDeck(page, 2, 'B');
    near((await deckState(page)).B.bpm, 92.5, 0.05, 'deck B bpm');
    await page.click('#deckB .sync');
    const s = await deckState(page);
    near(s.B.currentBpm, 124, 0.01, 'deck B synced bpm');
    await page.close();
  },

  async 'tempo reset button returns a synced deck to its original BPM'({ browser, baseUrl }) {
    const page = await openApp(browser, baseUrl);
    const idle = () => page.$eval('#deckB .tempo-reset', (e) => e.classList.contains('idle'));
    assert(await idle(), 'reset is dimmed on an empty deck');
    await addFiles(page, [generated.groove124(), generated.rolling128()]);
    await loadDeck(page, 1, 'A');
    await loadDeck(page, 2, 'B');
    assert(await idle(), 'reset is dimmed at the original tempo');
    await page.click('#deckB .sync');
    let s = await deckState(page);
    near(s.B.currentBpm, 124, 0.01, 'synced to 124');
    assert(!(await idle()), 'reset is lit once the tempo has changed');

    await page.click('#deckB .tempo-reset');
    s = await deckState(page);
    assert(s.B.rate === 1, `rate should be exactly 1, got ${s.B.rate}`);
    near(s.B.currentBpm, 128, 1e-9, 'back to the original 128 BPM');
    near(await page.$eval('#deckB .pitch-fader', (e) => +e.value), 0, 1e-9, 'tempo fader centred');
    assert((await page.textContent('#deckB .pitch-val')) === '+0.00%', 'pitch readout shows +0.00%');
    assert((await page.textContent('#deckB .bpm-val')) === '128.0', 'BPM readout shows 128.0');
    assert(await idle(), 'reset is dimmed again');
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async 'runs fully offline: no requests outside the app, no Spotify UI'({ browser, baseUrl }) {
    const page = await browser.newPage();
    const external = [];
    page.on('request', (r) => { if (!r.url().startsWith(baseUrl) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) external.push(r.url()); });
    await page.goto(baseUrl);
    await addFiles(page, [generated.groove124()]);
    await page.click('#trackBody tr:nth-child(1) button[data-act="A"]');
    await page.waitForFunction(() => window.spindeck.decks.A.loaded);
    await page.click('#deckA .play');
    await page.click('#settingsBtn');
    await page.waitForTimeout(300);
    assert(external.length === 0, `unexpected external requests: ${external.join(', ')}`);
    const text = (await page.content()).toLowerCase();
    assert(!text.includes('spotify'), 'page should not mention Spotify');
    assert(await page.evaluate(() => !('spotify' in window.spindeck)), 'no spotify object');
    await page.close();
  },

  async 'layout has no horizontal scroll at phone width'({ browser, baseUrl }) {
    const page = await openApp(browser, baseUrl);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForTimeout(100);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    assert(width <= 390, `page is ${width}px wide at a 390px viewport`);
    await page.close();
  },
};
