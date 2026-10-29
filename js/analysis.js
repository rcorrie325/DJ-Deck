// Offline track analysis: 3-band waveform peaks and BPM / first-beat detection.

const ANALYSIS_RATE = 11025; // Hz, plenty for visuals and beat detection
export const BIN_RATE = 150; // waveform bins per second of audio

export async function analyzeTrack(buffer) {
  const length = Math.ceil(buffer.duration * ANALYSIS_RATE);
  const off = new OfflineAudioContext(3, length, ANALYSIS_RATE);
  const src = off.createBufferSource();
  src.buffer = buffer;
  const merger = off.createChannelMerger(3);

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

  const { bpm, firstBeat } = detectBpm(bands[0], ANALYSIS_RATE);
  return { peaks, binRate: BIN_RATE, bpm, firstBeat };
}

// Onset envelope from the low band, then autocorrelation over tempo candidates.
export function detectBpm(data, sampleRate) {
  const hop = 128;
  const envRate = sampleRate / hop;
  const frames = Math.floor(data.length / hop);
  if (frames < envRate * 4) return { bpm: null, firstBeat: 0 };

  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let j = f * hop, end = j + hop; j < end; j++) sum += data[j] * data[j];
    energy[f] = Math.sqrt(sum / hop);
  }
  // Positive energy change = onset strength.
  const env = new Float32Array(frames);
  for (let f = 1; f < frames; f++) env[f] = Math.max(0, energy[f] - energy[f - 1]);
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
