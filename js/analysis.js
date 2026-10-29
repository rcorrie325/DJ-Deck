// Offline track analysis: 3-band waveform peaks, BPM / first-beat and musical key detection.

// Bump when the analysis result changes shape or meaning, so cached analyses get redone.
export const ANALYSIS_VERSION = 2;
const ANALYSIS_RATE = 11025; // Hz, plenty for visuals and beat detection
export const BIN_RATE = 150; // waveform bins per second of audio

export async function analyzeTrack(buffer) {
  const length = Math.ceil(buffer.duration * ANALYSIS_RATE);
  // Channels 0-2: low/mid/high bands; channel 3: full-band mono for key detection.
  const off = new OfflineAudioContext(4, length, ANALYSIS_RATE);
  const src = off.createBufferSource();
  src.buffer = buffer;
  const merger = off.createChannelMerger(4);

  const low = off.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 200;
  const mid = off.createBiquadFilter();
  mid.type = 'bandpass';
  mid.frequency.value = 1000;
  mid.Q.value = 0.7;
  const high = off.createBiquadFilter();
  high.type = 'highpass';
  high.frequency.value = 2500;

  src.connect(low).connect(merger, 0, 0);
  src.connect(mid).connect(merger, 0, 1);
  src.connect(high).connect(merger, 0, 2);
  src.connect(merger, 0, 3); // merger inputs are mono, so this is a downmix
  merger.connect(off.destination);
  src.start(0);
  const rendered = await off.startRendering();

  const bands = [0, 1, 2].map((c) => rendered.getChannelData(c));
  const samplesPerBin = ANALYSIS_RATE / BIN_RATE;
  const bins = Math.ceil(length / samplesPerBin);
  const peaks = [new Float32Array(bins), new Float32Array(bins), new Float32Array(bins)];
  for (let b = 0; b < 3; b++) {
    const data = bands[b];
    const out = peaks[b];
    for (let i = 0; i < bins; i++) {
      const start = Math.floor(i * samplesPerBin);
      const end = Math.min(data.length, Math.floor((i + 1) * samplesPerBin));
      let max = 0;
      for (let j = start; j < end; j++) {
        const v = data[j] < 0 ? -data[j] : data[j];
        if (v > max) max = v;
      }
      out[i] = max;
    }
  }
  // Normalize all bands by the loudest bin so waveforms fill the view.
  let globalMax = 1e-6;
  for (const p of peaks) for (let i = 0; i < p.length; i++) if (p[i] > globalMax) globalMax = p[i];
  for (const p of peaks) for (let i = 0; i < p.length; i++) p[i] /= globalMax;

  const { bpm, firstBeat } = detectBpm(bands, ANALYSIS_RATE);
  const key = detectKey(rendered.getChannelData(3), ANALYSIS_RATE);
  return { version: ANALYSIS_VERSION, peaks, binRate: BIN_RATE, bpm, firstBeat, key };
}

// Positive change in log energy per frame: rises sharply at note/drum attacks.
function onsetEnvelope(data, hop, frames) {
  const env = new Float32Array(frames);
  let prev = 0;
  let total = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let j = f * hop, end = j + hop; j < end; j++) sum += data[j] * data[j];
    const e = Math.log1p(1000 * Math.sqrt(sum / hop));
    if (f > 0) env[f] = Math.max(0, e - prev);
    total += env[f];
    prev = e;
  }
  const mean = total / frames || 1;
  for (let f = 0; f < frames; f++) env[f] /= mean;
  return env;
}

// Onset envelope summed over the frequency bands (so bass lines, kicks and
// hi-hats all count), then autocorrelation over tempo candidates.
export function detectBpm(bands, sampleRate) {
  if (!Array.isArray(bands)) bands = [bands];
  const hop = 128;
  const envRate = sampleRate / hop;
  const frames = Math.floor(bands[0].length / hop);
  if (frames < envRate * 4) return { bpm: null, firstBeat: 0 };

  const env = new Float32Array(frames);
  for (const band of bands) {
    const e = onsetEnvelope(band, hop, frames);
    for (let f = 0; f < frames; f++) env[f] += e[f];
  }
  let mean = 0;
  for (let f = 0; f < frames; f++) mean += env[f];
  mean /= frames;
  for (let f = 0; f < frames; f++) env[f] = Math.max(0, env[f] - mean);

  // Analyze at most ~3 minutes from the middle-ish of the track.
  const maxFrames = Math.floor(envRate * 180);
  const from = frames > maxFrames ? Math.floor((frames - maxFrames) / 2) : 0;
  const to = Math.min(frames, from + maxFrames);

  const sample = (pos) => {
    const i = Math.floor(pos);
    const t = pos - i;
    return env[i] * (1 - t) + (env[i + 1] || 0) * t;
  };
  const score = (bpm) => {
    const lag = (envRate * 60) / bpm;
    let s = 0;
    for (let f = from; f < to - lag * 4 - 1; f++) {
      const e = env[f];
      if (e === 0) continue;
      s += e * (sample(f + lag) + 0.5 * sample(f + lag * 2) + 0.25 * sample(f + lag * 4));
    }
    return s;
  };
  // Mild preference for typical DJ tempos.
  const weight = (bpm) => Math.exp(-0.5 * (Math.log2(bpm / 125) / 0.6) ** 2);

  let best = 0;
  let bestScore = -Infinity;
  for (let bpm = 70; bpm <= 190; bpm += 0.5) {
    const s = score(bpm) * weight(bpm);
    if (s > bestScore) { bestScore = s; best = bpm; }
  }
  for (let bpm = best - 0.6; bpm <= best + 0.6; bpm += 0.02) {
    const s = score(bpm) * weight(bpm);
    if (s > bestScore) { bestScore = s; best = bpm; }
  }
  if (bestScore <= 0) return { bpm: null, firstBeat: 0 };

  // Fold into a DJ-friendly range.
  while (best < 78) best *= 2;
  while (best > 180) best /= 2;

  // Autocorrelation only compares nearby beats, so it is coarse. Refine tempo and
  // phase together by fitting a beat grid across the whole analyzed span.
  const smooth = new Float32Array(frames);
  for (let f = 2; f < frames - 2; f++) {
    smooth[f] = env[f] + 0.6 * (env[f - 1] + env[f + 1]) + 0.2 * (env[f - 2] + env[f + 2]);
  }
  const at = (pos) => {
    const i = Math.floor(pos);
    const t = pos - i;
    return smooth[i] * (1 - t) + (smooth[i + 1] || 0) * t;
  };
  const gridFit = (bpm) => {
    const period = (envRate * 60) / bpm;
    let bestP = 0;
    let bestS = -1;
    for (let p = 0; p < period; p += 0.25) {
      let s = 0;
      for (let pos = from + p; pos < to - 2; pos += period) s += at(pos);
      if (s > bestS) { bestS = s; bestP = p; }
    }
    return { score: bestS, phase: bestP };
  };
  let fit = gridFit(best);
  let bpm = best;
  for (let cand = best - 1; cand <= best + 1; cand += 0.02) {
    const f = gridFit(cand);
    if (f.score > fit.score) { fit = f; bpm = cand; }
  }
  const rounded = Math.round(bpm);
  if (Math.abs(bpm - rounded) < 0.05) {
    bpm = rounded;
    fit = gridFit(bpm);
  } else {
    bpm = Math.round(bpm * 100) / 100;
  }

  const beatLen = 60 / bpm;
  let firstBeat = (from + fit.phase) / envRate;
  firstBeat -= Math.floor(firstBeat / beatLen) * beatLen;
  return { bpm, firstBeat };
}

// ---------- Key detection ----------

// In-place iterative radix-2 FFT. re/im: equal power-of-two length typed arrays.
const fftTables = new Map();
export function fft(re, im) {
  const n = re.length;
  let t = fftTables.get(n);
  if (!t) {
    t = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2) };
    for (let i = 0; i < n / 2; i++) {
      t.cos[i] = Math.cos((2 * Math.PI * i) / n);
      t.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    fftTables.set(n, t);
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let x = re[i]; re[i] = re[j]; re[j] = x;
      x = im[i]; im[i] = im[j]; im[j] = x;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = t.cos[k * step];
        const wi = t.sin[k * step];
        const a = i + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

// 12-bin pitch-class profile from spectral peaks between ~C2 and ~C7.
// Each frame is normalized so quiet passages count as much as loud ones. At most maxFrames
// frames (~0.74 s each), spread evenly over the track, keep long tracks fast.
export function chromagram(data, sampleRate, { size = 8192, maxFrames = 300 } = {}) {
  const chroma = new Float64Array(12);
  if (data.length < size) return chroma;
  const stride = Math.max(size / 2, Math.floor((data.length - size) / Math.max(1, maxFrames - 1)));
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  const kMin = Math.max(2, Math.floor((62 * size) / sampleRate));
  const kMax = Math.min(size / 2 - 2, Math.ceil((2100 * size) / sampleRate));
  const mag = new Float32Array(kMax + 2);
  const frame = new Float64Array(12);
  for (let start = 0; start + size <= data.length; start += stride) {
    for (let i = 0; i < size; i++) re[i] = data[start + i] * win[i];
    im.fill(0);
    fft(re, im);
    let peak = 0;
    for (let k = kMin - 1; k <= kMax + 1; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      if (mag[k] > peak) peak = mag[k];
    }
    if (peak < 1e-3) continue; // silence
    frame.fill(0);
    const floor = peak * 0.02;
    for (let k = kMin; k <= kMax; k++) {
      const m = mag[k];
      if (m < floor || m <= mag[k - 1] || m < mag[k + 1]) continue;
      // Parabolic interpolation of the peak position on log magnitudes.
      const a = Math.log(mag[k - 1] + 1e-9), b = Math.log(m), c = Math.log(mag[k + 1] + 1e-9);
      const d = a - 2 * b + c;
      const p = d < 0 ? (0.5 * (a - c)) / d : 0;
      const f = ((k + p) * sampleRate) / size;
      const midi = 69 + 12 * Math.log2(f / 440);
      frame[((Math.round(midi) % 12) + 12) % 12] += Math.sqrt(m);
    }
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += frame[i];
    if (sum > 0) for (let i = 0; i < 12; i++) chroma[i] += frame[i] / sum;
  }
  return chroma;
}

// Krumhansl–Kessler key profiles (tonic first).
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

function pearson(a, b) {
  let ma = 0, mb = 0;
  for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
  ma /= 12; mb /= 12;
  let s = 0, sa = 0, sb = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    s += x * y; sa += x * x; sb += y * y;
  }
  return sa && sb ? s / Math.sqrt(sa * sb) : 0;
}

// Key object for a tonic pitch class (0 = C) and mode ('major' | 'minor').
export function makeKey(tonic, mode) {
  tonic = ((Math.round(tonic) % 12) + 12) % 12;
  const major = mode === 'major';
  const rel = major ? tonic : (tonic + 3) % 12; // relative major shares the Camelot number
  const num = ((rel * 7 + 7) % 12) + 1;
  return {
    camelot: `${num}${major ? 'B' : 'A'}`,
    name: `${(major ? MAJOR_NAMES : MINOR_NAMES)[tonic]} ${major ? 'major' : 'minor'}`,
    tonic,
    mode: major ? 'major' : 'minor',
  };
}

// Best Krumhansl–Schmuckler match for a chroma vector: { key, score } (key null if undetermined).
export function keyFromChroma(chroma) {
  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma[i];
  if (!(total > 0)) return { key: null, score: 0 };
  let best = null;
  let bestScore = -Infinity;
  const rot = new Float64Array(12);
  for (const [mode, prof] of [['major', MAJOR_PROFILE], ['minor', MINOR_PROFILE]]) {
    for (let t = 0; t < 12; t++) {
      for (let pc = 0; pc < 12; pc++) rot[pc] = prof[(pc - t + 12) % 12];
      const s = pearson(chroma, rot);
      if (s > bestScore) { bestScore = s; best = [t, mode]; }
    }
  }
  if (bestScore < 0.25) return { key: null, score: bestScore };
  return { key: makeKey(best[0], best[1]), score: bestScore };
}

export function detectKey(data, sampleRate) {
  return keyFromChroma(chromagram(data, sampleRate)).key;
}

// Accepts a key object, a Camelot code ('8B') or a key name ('Am', 'C#m', 'F major', 'Bbmin').
export function parseKey(k) {
  if (!k) return null;
  if (typeof k === 'object') return k.camelot ? k : null;
  const s = String(k).trim();
  let m = /^(\d{1,2})\s*([ABab])$/.exec(s);
  if (m) {
    const num = +m[1];
    if (num < 1 || num > 12) return null;
    const major = m[2].toUpperCase() === 'B';
    const rel = ((((num - 8) * 7) % 12) + 12) % 12; // tonic of the major key with this number
    return makeKey(major ? rel : rel + 9, major ? 'major' : 'minor');
  }
  m = /^([A-Ga-g])\s*([#♯b♭]?)\s*(m|min|minor|maj|major|M)?$/.exec(s);
  if (!m) return null;
  let tonic = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
  if (m[2] === '#' || m[2] === '♯') tonic++;
  if (m[2] === 'b' || m[2] === '♭') tonic--;
  const minor = m[3] === 'm' || m[3] === 'min' || m[3] === 'minor';
  return makeKey(tonic, minor ? 'minor' : 'major');
}

// Key after transposing by a number of semitones (rounded to the nearest semitone).
// Returns a Camelot string when given a string, otherwise a key object.
export function shiftCamelot(key, semitones) {
  const k = parseKey(key);
  if (!k) return null;
  const shifted = makeKey(k.tonic + Math.round(semitones || 0), k.mode);
  return typeof key === 'string' ? shifted.camelot : shifted;
}

// Harmonic mixing: same number (same key or relative major/minor), or ±1 with the same letter.
export function camelotCompatible(a, b) {
  const ka = parseKey(a);
  const kb = parseKey(b);
  if (!ka || !kb) return false;
  const na = parseInt(ka.camelot, 10);
  const nb = parseInt(kb.camelot, 10);
  if (na === nb) return true;
  const d = (na - nb + 12) % 12;
  return ka.camelot.slice(-1) === kb.camelot.slice(-1) && (d === 1 || d === 11);
}
