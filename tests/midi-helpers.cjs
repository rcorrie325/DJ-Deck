// Fake Web MIDI controller and MIDI Learn helpers shared by the MIDI and integration tests.
const { openApp, assert } = require('./lib.cjs');

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

module.exports = { DEVICE, fakeMidi, open, connect, send, learn, done };
