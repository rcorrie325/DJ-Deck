// Smoke test for the built Mac app, run on GitHub's Mac machines after packaging:
//   node desktop/smoke.cjs dist/mac-universal/SpinDeck.app/Contents/MacOS/SpinDeck [screenshot dir]
// Launches the real app, opens a song from disk, checks it decodes and that MIDI is allowed
// without a prompt, then quits, relaunches and checks the song and the deck came back.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');
const { makeBeatWav } = require('../tests/lib.cjs');

const exe = process.argv[2];
const shots = process.argv[3] || null;
if (!exe || !fs.existsSync(exe)) {
  console.error(`App executable not found: ${exe}`);
  process.exit(2);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'spindeck-smoke-'));
const song = makeBeatWav(path.join(work, 'Music', 'Smoke Test - Groove 124.wav'), { bpm: 124, offset: 0.37, seconds: 30 });
const userData = path.join(work, 'profile');
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? '  ✓' : '  ✗'} ${msg}`); if (!ok) failures.push(msg); };

async function launch() {
  const app = await electron.launch({ executablePath: exe, env: { ...process.env, SPINDECK_USER_DATA: userData }, timeout: 60000 });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.waitForFunction(() => window.spindeck?.ready, null, { timeout: 30000 });
  await page.evaluate(() => window.spindeck.ready);
  return { app, page, errors };
}

(async () => {
  console.log('First launch');
  let { app, page, errors } = await launch();
  check((await page.evaluate(() => location.href)).startsWith('app://spindeck/'), 'app loads from app://spindeck');
  check(await page.evaluate(() => typeof window.spindeckDesktop?.pickFiles === 'function'), 'desktop bridge available');
  const midi = await page.evaluate(() => navigator.requestMIDIAccess({ sysex: true }).then(() => 'granted', (e) => e.name));
  check(midi === 'granted', `MIDI allowed without a prompt (${midi})`);

  // Same path as opening a song from Finder / dropping it on the Dock icon.
  await app.evaluate(({ app: a }, p) => a.emit('open-file', { preventDefault() {} }, p), song);
  await page.waitForFunction(() => [...document.querySelectorAll('#trackBody .title')].some((e) => e.textContent === 'Groove 124'), null, { timeout: 20000 });
  check(true, 'song opened from disk appears in the library');
  await page.click('#trackBody tr:has(.title:text-is("Groove 124")) button[data-act="A"]');
  await page.waitForFunction(() => window.spindeck.decks.A.loaded, null, { timeout: 30000 });
  const bpm = await page.evaluate(() => window.spindeck.decks.A.bpm);
  check(Math.abs(bpm - 124) < 0.1, `song decoded from disk, BPM ${bpm}`);
  await page.evaluate(() => { window.spindeck.decks.A.setRate(1.04); window.spindeck.decks.A.seek(7); });
  await page.waitForTimeout(1500); // session is saved every second
  if (shots) await page.screenshot({ path: path.join(shots, 'smoke-first-launch.png') });
  check(errors.length === 0, `no errors on first launch${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await app.close();

  console.log('Second launch (after quitting)');
  ({ app, page, errors } = await launch());
  const titles = await page.$$eval('#trackBody .title', (els) => els.map((e) => e.textContent));
  check(titles.includes('Groove 124'), `library remembered (${titles.join(', ')})`);
  await page.waitForFunction(() => window.spindeck.decks.A.loaded, null, { timeout: 30000 }).catch(() => {});
  const deck = await page.evaluate(() => {
    const d = window.spindeck.decks.A;
    return { title: d.track?.title, pos: d.position, rate: d.rate, playing: d.playing };
  });
  check(deck.title === 'Groove 124', `deck A has the song again (${deck.title})`);
  check(Math.abs(deck.pos - 7) < 0.1 && Math.abs(deck.rate - 1.04) < 1e-6, `deck A position ${deck.pos.toFixed(2)} s, tempo ${deck.rate}`);
  check(!deck.playing, 'restored paused');
  if (shots) await page.screenshot({ path: path.join(shots, 'smoke-second-launch.png') });
  check(errors.length === 0, `no errors on second launch${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await app.close();

  fs.rmSync(work, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nSmoke test passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
