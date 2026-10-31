// Pioneer DDJ-FLX4 built-in mapping, driven with the board's real MIDI messages through a fake
// Web MIDI device named "DDJ-FLX4". No hardware is involved.
const { generated, openApp, addFiles, loadDeck, assert, near } = require('./lib.cjs');
const { fakeMidi, open, send, learn, done } = require('./midi-helpers.cjs');

const NAME = 'DDJ-FLX4';

async function openFlx4(browser, baseUrl, { sysex = false } = {}) {
  const page = await openApp(browser, baseUrl, { init: `(${fakeMidi})(${JSON.stringify(NAME)}, ${sysex})` });
  await page.click('#midiBtn');
  await page.click('#midiConnect');
  await page.waitForFunction((d) => document.querySelector('#midiDevices').textContent.includes(d), NAME);
  return page;
}

// 14-bit controls arrive as MSB on cc, LSB on cc + 0x20.
const fourteen = async (page, status, cc, v) => {
  const full = Math.round(v * 16383);
  await send(page, [status, cc, full >> 7]);
  await send(page, [status, cc + 0x20, full & 0x7f]);
};
const press = async (page, status, note) => {
  await send(page, [status, note, 127]);
  await send(page, [status, note, 0]);
};
const sent = (page) => page.evaluate(() => window.__midiSent.map((m) => m.join(',')));
const deck = (page, id) => page.evaluate((d) => {
  const k = window.spindeck.decks[d];
  return { playing: k.playing, pos: k.position, rate: k.rate, bpm: k.currentBpm, loop: k.loop, hot: k.hotCues.slice(), beatLen: k.beatLen };
}, id);

module.exports = {
  async 'DDJ-FLX4 works out of the box: transport, faders, EQ, tempo, pads, jog, FX, browse and lights'({ browser, baseUrl }) {
    const page = await openFlx4(browser, baseUrl);
    const dialog = await page.textContent('#midiDevices');
    assert(dialog.includes('built-in Pioneer DDJ-FLX4 mapping'), `dialog should show the built-in mapping: ${dialog}`);
    await page.click('#midiDialog button[value="close"]');
    await addFiles(page, [generated.groove124(), generated.rolling128()]);
    await loadDeck(page, 1, 'A');
    await loadDeck(page, 2, 'B');

    // PLAY/PAUSE deck 1, with its LED.
    await press(page, 0x90, 0x0b);
    assert((await deck(page, 'A')).playing, 'deck 1 PLAY starts deck A');
    await page.waitForFunction(() => window.__midiSent.some((m) => m.join(',') === '144,11,127'));

    // Channel fader 1 (14-bit) with soft takeover: a far-away value is ignored until it reaches the on-screen 0.85.
    await fourteen(page, 0xb0, 0x13, 0.1);
    near(await page.$eval('#faderA', (e) => +e.value), 0.85, 0.001, 'far fader value ignored (soft takeover)');
    await fourteen(page, 0xb0, 0x13, 0.85);
    await fourteen(page, 0xb0, 0x13, 0.25);
    near(await page.$eval('#faderA', (e) => +e.value), 0.25, 0.001, 'channel fader 1 follows the board');

    // Crossfader (0xB6, 14-bit) and EQ HI on channel 1.
    await fourteen(page, 0xb6, 0x1f, 0.5);
    await fourteen(page, 0xb6, 0x1f, 0);
    near(await page.$eval('#xfader', (e) => +e.value), 0, 0.001, 'crossfader hard left');
    await fourteen(page, 0xb0, 0x07, 0.5);
    await fourteen(page, 0xb0, 0x07, 1);
    near(await page.evaluate(() => window.spindeck.knobs['A.high'].value), 1, 0.01, 'EQ HI 1 at max');

    // Tempo fader: top is "−" (slower), like a CDJ. Pick up at the centre first.
    await fourteen(page, 0xb0, 0x00, 0.5);
    await fourteen(page, 0xb0, 0x00, 1);
    let a = await deck(page, 'A');
    near(a.rate, 0.92, 0.002, 'tempo fader at the top slows deck A by the ±8% range');
    // "Reverse tempo fader" option flips it.
    await page.click('#midiBtn');
    await page.click('#midiInvertTempo');
    await page.click('#midiDialog button[value="close"]');
    await fourteen(page, 0xb0, 0x00, 0);
    await fourteen(page, 0xb0, 0x00, 1);
    near((await deck(page, 'A')).rate, 1.08, 0.002, 'reversed tempo fader: top speeds up');

    // Hot cue pad 1 (deck 1), its LED, and SHIFT + pad to delete.
    await page.evaluate(() => window.spindeck.decks.A.seek(5));
    await press(page, 0x97, 0x00);
    near((await deck(page, 'A')).hot[0], 5, 0.1, 'pad 1 sets hot cue 1');
    await page.waitForFunction(() => window.__midiSent.some((m) => m.join(',') === '151,0,127'));
    await press(page, 0x98, 0x00);
    assert((await deck(page, 'A')).hot[0] == null, 'SHIFT + pad 1 deletes hot cue 1');

    // BEAT LOOP pad 5 = 4 beats; BEAT JUMP pad 2 = +1 beat on deck 2.
    await press(page, 0x97, 0x64);
    assert((await deck(page, 'A')).loop?.beats === 4, 'beat loop pad 5 sets a 4-beat loop');
    await page.evaluate(() => window.spindeck.decks.B.seek(10));
    let b = await deck(page, 'B');
    await press(page, 0x99, 0x21);
    near((await deck(page, 'B')).pos, b.pos + b.beatLen, 0.01, 'beat jump pad 2 jumps one beat forward');

    // Jog platter on paused deck 2: one full turn (720 ticks) scrubs ~1.8 s.
    b = await deck(page, 'B');
    await page.evaluate(() => { for (let i = 0; i < 72; i++) window.__midiSend([0xb1, 0x22, 64 + 10]); });
    near((await deck(page, 'B')).pos, b.pos + 1.8, 0.02, 'jog turn scrubs the paused deck');

    // BEAT SYNC deck 2 to deck 1.
    await press(page, 0x91, 0x58);
    near((await deck(page, 'B')).bpm, (await deck(page, 'A')).bpm, 0.01, 'SYNC matches deck 2 to deck 1');

    // BEAT FX: ON/OFF with no channel picked applies to both; CH1 select + LEVEL/DEPTH affects channel A only.
    await press(page, 0x94, 0x47);
    let fx = await page.evaluate(() => [window.spindeck.mixer.getFx('A').on, window.spindeck.mixer.getFx('B').on]);
    assert(fx[0] && fx[1], `FX ON/OFF should turn FX on for both channels: ${fx}`);
    await send(page, [0x94, 0x10, 127]); // channel select switch to CH1
    await send(page, [0xb4, 0x02, 64]); // pick up near the 0.5 default
    await send(page, [0xb4, 0x02, 127]);
    fx = await page.evaluate(() => [window.spindeck.mixer.getFx('A').depth, window.spindeck.mixer.getFx('B').depth]);
    near(fx[0], 1, 0.01, 'FX depth on channel A');
    near(fx[1], 0.5, 0.01, 'channel B depth untouched');

    // BROWSE + LOAD: stop deck 2's track, browse to row 1 and load it onto deck 2.
    await send(page, [0xb6, 0x40, 1]);
    await press(page, 0x96, 0x47);
    await page.waitForFunction(() => window.spindeck.decks.B.track?.title === 'Groove 124');

    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async 'DDJ-FLX4: your MIDI Learn mappings override the built-in ones; built-in can be switched off'({ browser, baseUrl }) {
    const page = await openFlx4(browser, baseUrl);
    await page.click('#midiDialog button[value="close"]');
    await addFiles(page, [generated.groove124(), generated.rolling128()]);
    await loadDeck(page, 1, 'A');
    await loadDeck(page, 2, 'B');
    // Re-map deck 1's PLAY button to deck B.
    await learn(page, '#deckB .play', [0x90, 0x0b, 127]);
    await done(page);
    await press(page, 0x90, 0x0b);
    assert((await deck(page, 'B')).playing && !(await deck(page, 'A')).playing, 'learned mapping wins over the built-in one');
    await page.click('#midiBtn');
    await page.click('#midiBuiltin'); // switch built-in mappings off
    const dialog = await page.textContent('#midiDevices');
    assert(!dialog.includes('built-in'), 'device no longer listed as using the built-in mapping');
    await page.click('#midiDialog button[value="close"]');
    await press(page, 0x97, 0x00);
    assert((await deck(page, 'A')).hot[0] == null, 'with built-in mappings off, pads do nothing');
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async 'DDJ-FLX4 gets the keep-alive message when sysex is allowed'({ browser, baseUrl }) {
    const page = await openFlx4(browser, baseUrl, { sysex: true });
    await page.waitForTimeout(500);
    const msgs = await sent(page);
    const keepalive = '240,0,64,5,0,0,4,5,0,80,2,247';
    const n = msgs.filter((m) => m === keepalive).length;
    assert(n >= 2, `expected repeated keep-alive messages, got ${n}`);
    await page.close();
  },

  async 'other controllers are not affected by the DDJ-FLX4 mapping'({ browser, baseUrl }) {
    const page = await open(browser, baseUrl); // a generic fake controller, not a DDJ
    await addFiles(page, [generated.groove124()]);
    await loadDeck(page, 1, 'A');
    await press(page, 0x90, 0x0b);
    assert(!(await deck(page, 'A')).playing, 'unmapped controller does nothing without MIDI Learn');
    assert(!(await page.textContent('#midiDevices')).includes('built-in'), 'no built-in mapping shown');
    await page.close();
  },
};
