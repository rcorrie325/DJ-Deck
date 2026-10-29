// Canvas waveform renderers: scrolling zoomed view and full-track overview.

const COLORS = {
  A: { play: '#ff3b5c', accent: 'rgba(255,59,92,' },
  B: { play: '#2fd0ff', accent: 'rgba(47,208,255,' },
};

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h, dpr };
}

// Color a bar by its band mix: lows red, mids green, highs blue (Serato-ish).
function bandColor(l, m, h) {
  const sum = l + m + h + 1e-6;
  const r = Math.round(255 * Math.min(1, (l / sum) * 1.6));
  const g = Math.round(255 * Math.min(1, (m / sum) * 1.6));
  const b = Math.round(255 * Math.min(1, (h / sum) * 2.0));
  return `rgb(${r},${g},${b})`;
}

function maxIn(arr, from, to) {
  let m = 0;
  for (let i = Math.max(0, from); i < Math.min(arr.length, to); i++) if (arr[i] > m) m = arr[i];
  return m;
}

export function drawZoom(canvas, deck, secondsVisible) {
  const ctx = canvas.getContext('2d');
  const { w, h, dpr } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const mid = h / 2;
  const a = deck.analysis;
  const center = w / 2;
  if (!a) {
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, mid - 0.5 * dpr, w, dpr);
    drawPlayhead(ctx, center, h, dpr);
    return;
  }
  const pos = deck.position;
  const pxPerSec = w / secondsVisible;
  const t0 = pos - center / pxPerSec;
  const [low, mi, hi] = a.peaks;
  const binsPerPx = a.binRate / pxPerSec;
  const step = Math.max(1, Math.round(dpr));

  // Loop region
  if (deck.loop) {
    const x1 = (deck.loop.start - t0) * pxPerSec;
    const x2 = (deck.loop.end - t0) * pxPerSec;
    ctx.fillStyle = 'rgba(80,255,140,0.12)';
    ctx.fillRect(x1, 0, x2 - x1, h);
  }

  for (let x = 0; x < w; x += step) {
    const t = t0 + x / pxPerSec;
    if (t < 0 || t > deck.duration) continue;
    const b0 = Math.floor(t * a.binRate);
    const b1 = Math.max(b0 + 1, Math.floor(b0 + binsPerPx * step));
    const l = maxIn(low, b0, b1);
    const m = maxIn(mi, b0, b1);
    const hh = maxIn(hi, b0, b1);
    const amp = Math.min(1, Math.max(l, m, hh) * 1.1);
    const y = amp * (mid - 2 * dpr);
    ctx.fillStyle = bandColor(l, m, hh);
    ctx.globalAlpha = t < pos ? 0.55 : 1;
    ctx.fillRect(x, mid - y, step, y * 2);
  }
  ctx.globalAlpha = 1;

  // Beat grid
  if (deck.bpm) {
    const beat = deck.beatLen;
    let n = Math.ceil((t0 - deck.firstBeat) / beat);
    for (let t = deck.firstBeat + n * beat; t < t0 + w / pxPerSec; t += beat, n++) {
      const x = (t - t0) * pxPerSec;
      const bar = ((n % 4) + 4) % 4 === 0;
      ctx.fillStyle = bar ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.18)';
      ctx.fillRect(x, 0, bar ? 2 * dpr : dpr, bar ? h : h * 0.18);
      if (!bar) ctx.fillRect(x, h - h * 0.18, dpr, h * 0.18);
    }
  }

  drawCueMarkers(ctx, deck, (t) => (t - t0) * pxPerSec, h, dpr);
  drawPlayhead(ctx, center, h, dpr);
}

function drawPlayhead(ctx, x, h, dpr) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(x - dpr, 0, 2 * dpr, h);
}

export const HOT_COLORS = ['#ff4d4d', '#ffa53d', '#3dff8b', '#4da6ff', '#c06bff', '#ff5fcf', '#ffe14d', '#3de8e0'];

function drawCueMarkers(ctx, deck, toX, h, dpr) {
  const s = 6 * dpr;
  ctx.fillStyle = '#ffd400';
  const cx = toX(deck.cuePoint);
  ctx.beginPath();
  ctx.moveTo(cx - s, 0);
  ctx.lineTo(cx + s, 0);
  ctx.lineTo(cx, s * 1.4);
  ctx.fill();
  deck.hotCues.forEach((t, i) => {
    if (t == null) return;
    const x = toX(t);
    ctx.fillStyle = HOT_COLORS[i];
    ctx.fillRect(x - dpr / 2, 0, dpr, h);
    ctx.fillRect(x, h - s * 1.8, s * 1.6, s * 1.8);
    ctx.fillStyle = '#000';
    ctx.font = `bold ${8 * dpr}px system-ui`;
    ctx.fillText(String(i + 1), x + 2 * dpr, h - 3 * dpr);
  });
  // Pending manual loop-in point.
  if (deck.loopInPoint != null) {
    const x = toX(deck.loopInPoint);
    ctx.fillStyle = '#50ff8c';
    for (let y = 0; y < h; y += 6 * dpr) ctx.fillRect(x - dpr / 2, y, dpr, 3 * dpr);
    ctx.fillRect(x, 0, s * 2.2, s * 1.6);
    ctx.fillStyle = '#000';
    ctx.font = `bold ${8 * dpr}px system-ui`;
    ctx.fillText('IN', x + 2 * dpr, s * 1.6 - 2 * dpr);
  }
}

export function drawOverview(canvas, deck) {
  const ctx = canvas.getContext('2d');
  const { w, h, dpr } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const a = deck.analysis;
  if (!a || !deck.duration) return;
  const mid = h / 2;
  const [low, mi, hi] = a.peaks;
  const bins = low.length;
  const progress = deck.position / deck.duration;
  for (let x = 0; x < w; x++) {
    const b0 = Math.floor((x / w) * bins);
    const b1 = Math.floor(((x + 1) / w) * bins);
    const l = maxIn(low, b0, b1);
    const m = maxIn(mi, b0, b1);
    const hh = maxIn(hi, b0, b1);
    const y = Math.min(1, Math.max(l, m, hh)) * (mid - dpr);
    ctx.fillStyle = bandColor(l, m, hh);
    ctx.globalAlpha = x / w < progress ? 0.4 : 0.95;
    ctx.fillRect(x, mid - y, 1, y * 2);
  }
  ctx.globalAlpha = 1;
  const toX = (t) => (t / deck.duration) * w;
  if (deck.loop) {
    ctx.fillStyle = 'rgba(80,255,140,0.35)';
    ctx.fillRect(toX(deck.loop.start), 0, Math.max(2, toX(deck.loop.end) - toX(deck.loop.start)), h);
  }
  drawCueMarkers(ctx, deck, toX, h, dpr);
  ctx.fillStyle = COLORS[deck.id].play;
  ctx.fillRect(progress * w - dpr, 0, 2 * dpr, h);
}
