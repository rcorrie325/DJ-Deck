// Web MIDI: learn, soft takeover, encoders, cue hold, LED feedback, persistence and import/export.
// Uses a fake navigator.requestMIDIAccess so no hardware is needed.
const fs = require('fs');
const path = require('path');
const { generated, openApp, addFiles, loadDeck, assert, near, CACHE } = require('./lib.cjs');

const DEVICE = 'Fake DJ Controller';

function fakeMidi(name) {
  const sent = [];
  const mk = (id, type) => ({ id, name, type, state: 'connected', connection: 'open', onmidimessage: null });
  const input = mk('in-1', 'input');
  const output = { ...mk('out-1', 'output'), send(data) { sent.push(Array.from(data)); } };
  const access = { sysexEnabled: false, inputs: new Map([[input.id, input]]), outputs: new Map([[output.id, output]]), onstatechange: null };
  window.__midiSent = sent;
  window.__midiSend = (bytes, port = input) => port.onmidimessage?.({ data: new Uint8Array(bytes), target: port });
  window.__midiPlug = (n) => {
    const p = { id: `in-${access.inputs.size + 1}`, name: n, type: 'input', state: 'connected', onmidimessage: null };
    access.inputs.set(p.id, p);
    access.onstatechange?.({ port: p });
    return p.id;
  };
  window.__midiSendFrom = (id, bytes) => window.__midiSend(bytes, access.inputs.get(id));
  navigator.requestMIDIAccess = async () => access;
}

async function open(browser, baseUrl) {
  // Each test gets a fresh browser context, so localStorage starts empty.
  const page = await openApp(browser, baseUrl, { init: `(${fakeMidi})(${JSON.stringify(DEVICE)})` });
  await connect(page);
  return page;
}

async function connect(page) {
  await page.click('#midiBtn');
  await page.click('#midiConnect');
  await page.waitForFunction((d) => document.querySelector('#midiDevices').textContent.includes(d), DEVICE);
  await page.click('#midiDialog button[value="close"]');
}

const send = (page, bytes) => page.evaluate((b) => window.__midiSend(b), bytes);

async function learn(page, selector, bytes) {
  if (!(await page.evaluate(() => window.spindeck.midi.learning))) {
    await page.click('#midiBtn');
    await page.click('#midiLearn');
  }
  await page.click(selector);
  const label = await page.evaluate(() => window.spindeck.midi.learnTarget?.label);
  assert(label, `clicking ${selector} in learn mode should select it`);
  const bar = await page.textContent('.midi-learn-bar');
  assert(bar.includes(`Move a control on your controller for: ${label}`), `status bar: ${bar}`);
  await send(page, bytes);
  assert(!(await page.evaluate(() => window.spindeck.midi.learnTarget)), 'message should complete the mapping');
}

async function done(page) {
  await page.click('.midi-learn-bar button');
}

const deck = (page, id) => page.evaluate((d) => {
  const k = window.spindeck.decks[d];
  return { playing: k.playing, pos: k.position, bend: k.bend, cue: k.cuePoint, preview: k.previewingCue, pitch: k.pitch };
}, id);

module.exports = {
  async 'learn a note and a CC: play toggles, fader and EQ move with soft takeover'({ browser, baseUrl }) {
    const page = await open(browser, baseUrl);
    await addFiles(page, [generated.groove124()]);
    await loadDeck(page, 1, 'A');

    await learn(page, '#deckA .play', [0x90, 0x0b, 127]);
    assert(!(await deck(page, 'A')).playing, 'the learn message itself should not trigger the control');
    // Clicking a target in learn mode must not run its normal action.
    await learn(page, '#faderA', [0xb0, 0x13, 20]);
    near(await page.$eval('#faderA', (e) => +e.value), 0.85, 0.001, 'fader untouched while learning');
    await learn(page, '.mix-col[data-ch="A"] [data-k="high"]', [0xb1, 0x10, 0]);
    await done(page);
    assert(!(await page.evaluate(() => document.querySelector('.midi-target'))), 'outlines removed after Done');

    await send(page, [0x90, 0x0b, 127]);
    await send(page, [0x80, 0x0b, 0]);
    assert((await deck(page, 'A')).playing, 'note should start deck A');
    await send(page, [0x90, 0x0b, 100]);
    await send(page, [0x90, 0x0b, 0]);
    assert(!(await deck(page, 'A')).playing, 'note should pause deck A');

    // Fader at 0.85: a far-away value is ignored until the hardware crosses the on-screen value.
    await send(page, [0xb0, 0x13, 10]);
    near(await page.$eval('#faderA', (e) => +e.value), 0.85, 0.001, 'soft takeover ignores far value');
    await send(page, [0xb0, 0x13, 60]);
    near(await page.$eval('#faderA', (e) => +e.value), 0.85, 0.001, 'still not picked up');
    await send(page, [0xb0, 0x13, 115]); // crosses 0.85 (≈108)
    near(await page.$eval('#faderA', (e) => +e.value), 115 / 127, 0.002, 'fader picked up after crossing');
    await send(page, [0xb0, 0x13, 0]);
    near(await page.$eval('#faderA', (e) => +e.value), 0, 0.001, 'fader follows once picked up');

    // EQ knob centred (0.5): first value 0 is ignored; 64 picks it up; 127 turns it fully up.
    const hi = () => page.evaluate(() => window.spindeck.knobs['A.high'].value);
    await send(page, [0xb1, 0x10, 0]);
    near(await hi(), 0, 1e-9, 'EQ ignores far value');
    await send(page, [0xb1, 0x10, 64]);
    await send(page, [0xb1, 0x10, 127]);
    near(await hi(), 1, 1e-9, 'EQ high fully up');
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async 'jog wheel: 64-centred and two\'s-complement encoders seek and bend'({ browser, baseUrl }) {
    const page = await open(browser, baseUrl);
    await addFiles(page, [generated.groove124(), generated.rolling128()]);
    await loadDeck(page, 1, 'A');
    await loadDeck(page, 2, 'B');
    await learn(page, '#deckA .platter-disc', [0xb0, 0x22, 65]);
    await learn(page, '#deckB .platter-disc', [0xb1, 0x22, 1]);
    await done(page);

    // Paused deck A, 64-centred: +10 ticks then -4 ticks.
    let p0 = (await deck(page, 'A')).pos;
    await send(page, [0xb0, 0x22, 74]);
    let p1 = (await deck(page, 'A')).pos;
    near(p1 - p0, 10 * 0.02, 0.002, 'deck A seeks forward');
    await send(page, [0xb0, 0x22, 60]);
    near((await deck(page, 'A')).pos - p1, -4 * 0.02, 0.002, 'deck A seeks back');

    // Paused deck B, two's complement: +3, then 126 = -2.
    p0 = (await deck(page, 'B')).pos;
    await send(page, [0xb1, 0x22, 3]);
    p1 = (await deck(page, 'B')).pos;
    near(p1 - p0, 3 * 0.02, 0.002, 'deck B seeks forward');
    await send(page, [0xb1, 0x22, 126]);
    near((await deck(page, 'B')).pos - p1, -2 * 0.02, 0.002, 'deck B seeks back');
    const modes = await page.evaluate((d) => Object.values(window.spindeck.midi.mappings[d]).map((m) => m.mode), DEVICE);
    assert(modes.includes('center') && modes.includes('twos'), `encoder modes detected: ${modes}`);

    // Playing deck: ticks bend the tempo, which returns to 0 shortly after the wheel stops.
    await page.click('#deckB .play');
    await send(page, [0xb1, 0x22, 5]);
    const b = (await deck(page, 'B')).bend;
    assert(b > 0, `deck B should bend forward, bend=${b}`);
    await send(page, [0xb1, 0x22, 123]);
    assert((await deck(page, 'B')).bend < 0, 'deck B should bend back');
    await page.waitForTimeout(250);
    assert((await deck(page, 'B')).bend === 0, 'bend returns to 0');
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async 'cue hold previews and returns; LED feedback follows play state'({ browser, baseUrl }) {
    const page = await open(browser, baseUrl);
    await addFiles(page, [generated.groove124()]);
    await loadDeck(page, 1, 'A');
    await learn(page, '#deckA .cue', [0x90, 0x0c, 127]);
    await learn(page, '#deckA .play', [0x90, 0x0b, 127]);
    await done(page);

    const cue = (await deck(page, 'A')).cue;
    await send(page, [0x90, 0x0c, 127]);
    await page.waitForTimeout(400);
    let s = await deck(page, 'A');
    assert(s.playing && s.preview, 'holding cue previews');
    await send(page, [0x90, 0x0c, 0]);
    s = await deck(page, 'A');
    assert(!s.playing, 'releasing cue stops');
    near(s.pos, cue, 0.001, 'back at the cue point');

    // Wait until the play LED reflects the paused state (the preview lit it), then start from a clean log.
    await page.waitForFunction(() => window.__midiSent.filter((m) => m[1] === 0x0b).pop()?.[2] === 0);
    await page.evaluate(() => { window.__midiSent.length = 0; });
    await page.click('#deckA .play');
    await page.waitForFunction(() => window.__midiSent.some((m) => m[0] === 0x90 && m[1] === 0x0b && m[2] === 127));
    await page.click('#deckA .play');
    await page.waitForFunction(() => window.__midiSent.some((m) => m[0] === 0x90 && m[1] === 0x0b && m[2] === 0));
    // Only sends on change.
    const n = await page.evaluate(() => window.__midiSent.filter((m) => m[1] === 0x0b).length);
    await page.waitForTimeout(350);
    assert((await page.evaluate(() => window.__midiSent.filter((m) => m[1] === 0x0b).length)) === n, 'no repeated LED messages');

    // Turning LED feedback off stops updates.
    await page.click('#midiBtn');
    await page.uncheck('#midiLed');
    await page.click('#midiDialog button[value="close"]');
    await page.evaluate(() => { window.__midiSent.length = 0; });
    await page.click('#deckA .play');
    await page.waitForTimeout(300);
    assert((await page.evaluate(() => window.__midiSent.length)) === 0, 'LEDs off when disabled');
    await page.click('#deckA .play');
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async 'mappings persist, clear, and round-trip through export/import'({ browser, baseUrl }) {
    let page = await open(browser, baseUrl);
    await learn(page, '#faderB', [0xb0, 0x30, 108]);
    await learn(page, '#xfader', [0xb0, 0x31, 64]);
    // Right-click clears a mapping in learn mode.
    await learn(page, '#deckA .sync', [0x90, 0x05, 127]);
    await page.click('#deckA .sync', { button: 'right' });
    await done(page);
    let count = await page.evaluate(() => window.spindeck.midi.count);
    assert(count === 2, `expected 2 mappings after clearing one, got ${count}`);
    await page.reload();
    await connect(page);
    count = await page.evaluate(() => window.spindeck.midi.count);
    assert(count === 2, `mappings should persist across reload, got ${count}`);
    await send(page, [0xb0, 0x30, 108]);
    await send(page, [0xb0, 0x30, 20]);
    near(await page.$eval('#faderB', (e) => +e.value), 20 / 127, 0.002, 'fader B mapped after reload');

    await page.click('#midiBtn');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#midiExport')]);
    const file = path.join(CACHE, 'midi-export.json');
    await dl.saveAs(file);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(Object.keys(json.mappings[DEVICE]).length === 2, 'export contains the mappings');
    await page.click('#midiClear');
    assert((await page.evaluate(() => window.spindeck.midi.count)) === 0, 'clear all');
    assert((await page.textContent('#midiMappings')).includes('No mappings'), 'list shows empty');
    await page.setInputFiles('#midiImport', file);
    await page.waitForFunction(() => window.spindeck.midi.count === 2);
    assert((await page.textContent('#midiMappings')).includes('Crossfader'), 'list shows imported mapping');
    await page.click('#midiDialog button[value="close"]');
    await send(page, [0xb0, 0x31, 64]);
    await send(page, [0xb0, 0x31, 127]);
    near(await page.$eval('#xfader', (e) => +e.value), 1, 0.001, 'imported crossfader mapping works');

    // Hot-plug: a new device appears in the list.
    await page.evaluate(() => window.__midiPlug('Second Controller'));
    await page.click('#midiBtn');
    assert((await page.textContent('#midiDevices')).includes('Second Controller'), 'hot-plugged device listed');
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async 'shows a message without Web MIDI; dialog fits a phone screen'({ browser, baseUrl }) {
    const page = await openApp(browser, baseUrl, { init: () => { delete Navigator.prototype.requestMIDIAccess; } });
    await page.click('#midiBtn');
    await page.click('#midiConnect');
    assert((await page.textContent('#midiStatus')).includes('Controllers need Chrome or Edge (Web MIDI)'), 'unsupported message');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    const w = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.querySelector('#midiDialog').scrollWidth));
    assert(w <= 390, `dialog/page ${w}px wide at a 390px viewport`);
    await page.close();
  },
};
