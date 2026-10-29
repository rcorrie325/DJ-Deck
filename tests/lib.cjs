// Tiny test harness: static server, Playwright browser, generated audio, assertions.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(__dirname, '.cache');
const MUSIC = path.join(__dirname, '.music');

const TYPES = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};

function startServer() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(ROOT, url.endsWith('/') ? url + 'index.html' : url);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Mono 16-bit WAV with a kick on every beat and a hat on the off-beat.
function makeBeatWav(file, { bpm, seconds = 60, offset = 0, sr = 44100 }) {
  if (fs.existsSync(file)) return file;
  const n = Math.floor(seconds * sr);
  const out = new Float32Array(n);
  const beat = 60 / bpm;
  let seed = Math.round(bpm * 100);
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let t = offset; t < seconds; t += beat) {
    const s = Math.floor(t * sr);
    for (let i = 0; i < 0.15 * sr && s + i < n; i++) {
      const tt = i / sr;
      out[s + i] += 0.8 * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-tt * 30)) * tt) * Math.exp(-tt * 18);
    }
    const h = Math.floor((t + beat / 2) * sr);
    for (let i = 0; i < 0.03 * sr && h + i < n; i++) out[h + i] += 0.15 * rand() * Math.exp((-i / sr) * 120);
  }
  for (let i = 0; i < n; i++) out[i] += 0.08 * Math.sin((2 * Math.PI * 220 * i) / sr);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(out[i] * 30000))), 44 + i * 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return file;
}

const generated = {
  groove124: () => makeBeatWav(path.join(CACHE, 'DJ Test - Groove 124.wav'), { bpm: 124, offset: 0.37 }),
  rolling128: () => makeBeatWav(path.join(CACHE, 'Beat Maker - Rolling 128.wav'), { bpm: 128, offset: 0.11 }),
  ninety: () => makeBeatWav(path.join(CACHE, 'Slow Jam - Ninety.wav'), { bpm: 92.5, offset: 0.2 }),
};

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function near(actual, expected, tol, msg) {
  assert(Math.abs(actual - expected) <= tol, `${msg}: expected ${expected} ±${tol}, got ${actual}`);
}

// Opens the app in a fresh page and collects page errors.
async function openApp(browser, baseUrl, { init } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && page.errors.push(m.text()));
  if (init) await page.addInitScript(init);
  await page.goto(baseUrl);
  return page;
}

async function addFiles(page, files) {
  const before = await page.$$eval('#trackBody tr', (r) => r.length);
  await page.setInputFiles('#fileInput', files);
  await page.waitForFunction((n) => document.querySelectorAll('#trackBody tr').length >= n, before + files.length);
}

async function loadDeck(page, row, deck) {
  await page.click(`#trackBody tr:nth-child(${row}) button[data-act="${deck}"]`);
  await page.waitForFunction(
    ([d, r]) => window.spindeck.decks[d].track?.id === document.querySelector(`#trackBody tr:nth-child(${r})`).dataset.id
      || window.spindeck.decks[d].track?.title === document.querySelector(`#trackBody tr:nth-child(${r}) .title`).textContent,
    [deck, row],
  );
}

module.exports = {
  ROOT, CACHE, MUSIC, chromium, startServer, generated, makeBeatWav, assert, near, openApp, addFiles, loadDeck,
};
