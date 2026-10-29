// Cross-feature checks: a MIDI controller driving features built separately
// (key lock, 8 hot cues, manual loops, mixer FX, headphone cue).
const { generated, addFiles, loadDeck, assert, near } = require('./lib.cjs');
const { open, send, learn, done } = require('./midi-helpers.cjs');

const press = async (page, note) => {
  await send(page, [0x90, note, 127]);
  await send(page, [0x80, note, 0]);
};

module.exports = {
  async 'controller drives key lock, hot cue 8, manual loops and FX'({ browser, baseUrl }) {
    const page = await open(browser, baseUrl);
    await addFiles(page, [generated.groove124()]);
    await loadDeck(page, 1, 'A');

    await learn(page, '#deckA .keylock', [0x90, 0x20, 127]);
    await learn(page, '#deckA .hot[data-i="7"]', [0x90, 0x27, 127]);
    await learn(page, '#deckA .loop-in', [0x90, 0x30, 127]);
    await learn(page, '#deckA .loop-out', [0x90, 0x31, 127]);
    await learn(page, '#deckA .loop-half', [0x90, 0x32, 127]);
    await learn(page, '.mix-col[data-ch="A"] .fx-on', [0x90, 0x40, 127]);
    await learn(page, '.mix-col[data-ch="A"] [data-k="fx-depth"]', [0xb0, 0x41, 64]);
    await done(page);

    const state = () => page.evaluate(() => {
      const d = window.spindeck.decks.A;
      return { keylock: d.keylock, hot8: d.hotCues[7], loop: d.loop, fx: window.spindeck.mixer.getFx('A') };
    });

    await press(page, 0x20);
    assert((await state()).keylock, 'key lock should turn on from the controller');
    assert(await page.$eval('#deckA .keylock', (e) => e.classList.contains('on')), 'KEY button lit');
    await page.waitForFunction(() => window.__midiSent.some((m) => m[0] === 0x90 && m[1] === 0x20 && m[2] === 127));

    await page.evaluate(() => window.spindeck.decks.A.seek(10));
    await press(page, 0x27);
    near((await state()).hot8, 10, 0.1, 'hot cue 8 set at the playhead');

    // Manual loop: IN at one beat, OUT four beats later, then halve it.
    const beat = 60 / 124;
    const first = await page.evaluate(() => window.spindeck.decks.A.firstBeat);
    await page.evaluate((t) => window.spindeck.decks.A.seek(t), first + 20 * beat);
    await press(page, 0x30);
    await page.evaluate((t) => window.spindeck.decks.A.seek(t), first + 24 * beat);
    await press(page, 0x31);
    let s = await state();
    assert(s.loop, 'loop active after IN/OUT');
    near(s.loop.end - s.loop.start, 4 * beat, 0.01, 'manual loop length');
    await press(page, 0x32);
    s = await state();
    near(s.loop.end - s.loop.start, 2 * beat, 0.01, 'halved loop length');

    await press(page, 0x40);
    assert((await state()).fx.on, 'FX on from the controller');
    await send(page, [0xb0, 0x41, 64]); // near the knob's 0.5: soft takeover picks up
    await send(page, [0xb0, 0x41, 127]);
    near((await state()).fx.depth, 1, 0.01, 'FX depth follows the controller knob');

    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },
};
