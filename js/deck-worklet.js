// Deck playback processor: variable-rate reading, seamless loops and WSOLA key lock.
//
// Commands (port messages, every one carries an incrementing `seq`; positions in seconds):
//   {type:'load', channels:[Float32Array, Float32Array?], sampleRate}
//   {type:'play', pos} {type:'pause'} {type:'seek', pos} {type:'rate', rate}
//   {type:'loop', loop:{start,end}|null} {type:'keylock', on}
// Reports: {pos, time, seq} about every 20 ms while playing, {ended:true, seq} at the end of the track.
// processorOptions.commands may hold an initial list of commands (handy for OfflineAudioContext).

const XFADE_SEC = 0.005; // de-click crossfade on jumps, pause and play
const REPORT_SEC = 0.02;

class DeckProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.L = null;
    this.R = null;
    this.len = 0;
    this.pos = 0; // read position in samples (linear mode)
    this.rate = 1;
    this.loop = null; // {s, e, len} in samples
    this.keylock = false;
    this.playing = false;
    this.seq = 0;
    this.reportIn = 0;

    // WSOLA setup: ~40 ms frames, 50% overlap, periodic Hann (sums to 1 at hop N/2).
    const N = Math.round(0.04 * sampleRate / 2) * 2;
    this.N = N;
    this.Hs = N / 2;
    this.tol = Math.round(0.008 * sampleRate);
    this.win = new Float32Array(N);
    for (let n = 0; n < N; n++) this.win[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N);
    this.olaL = new Float32Array(N);
    this.olaR = new Float32Array(N);
    this.tmpl = new Float32Array(this.Hs);
    this.region = new Float32Array(2 * this.tol + this.Hs + 8);
    const F = 1 << Math.ceil(Math.log2(this.Hs * 2 + 256));
    this.fifoL = new Float32Array(F);
    this.fifoR = new Float32Array(F);
    this.fifoPos = new Float64Array(F);
    this.fifoMask = F - 1;
    this.fifoHead = 0;
    this.fifoCount = 0;
    this.anaPos = 0;
    this.prevStart = 0;

    // De-click: fade-out tail of the old signal plus fade-in of the new one.
    this.xf = Math.max(1, Math.round(XFADE_SEC * sampleRate));
    this.tailL = new Float32Array(this.xf);
    this.tailR = new Float32Array(this.xf);
    this.tailIdx = this.xf; // >= xf means no tail
    this.fadeIn = 0; // samples of fade-in left

    this.port.onmessage = (e) => this.command(e.data);
    for (const c of options?.processorOptions?.commands || []) this.command(c);
  }

  // ---------- commands ----------

  command(m) {
    if (m.seq != null) this.seq = m.seq;
    switch (m.type) {
      case 'load': {
        let [L, R] = m.channels;
        R = R || L;
        if (m.sampleRate && m.sampleRate !== sampleRate) {
          L = resample(L, m.sampleRate);
          R = R === m.channels[0] ? L : resample(R, m.sampleRate);
        }
        this.L = L;
        this.R = R;
        this.len = L.length;
        this.playing = false;
        this.loop = null;
        this.pos = 0;
        this.tailIdx = this.xf;
        break;
      }
      case 'play':
        if (!this.L) break;
        this.startTail();
        this.jump(m.pos * sampleRate);
        this.playing = true;
        this.fadeIn = this.xf;
        this.reportIn = 0;
        break;
      case 'pause':
        this.startTail();
        this.playing = false;
        break;
      case 'seek':
        if (!this.L) break;
        this.startTail();
        this.jump(m.pos * sampleRate);
        if (this.playing) this.fadeIn = this.xf;
        this.reportIn = 0;
        break;
      case 'rate':
        this.rate = Math.max(0.05, Math.min(4, m.rate));
        break;
      case 'loop':
        if (m.loop && m.loop.end > m.loop.start) {
          const s = m.loop.start * sampleRate;
          const e = m.loop.end * sampleRate;
          this.loop = { s, e, len: e - s };
        } else {
          this.loop = null;
        }
        break;
      case 'keylock': {
        const on = !!m.on;
        if (on === this.keylock) break;
        const p = this.currentPos();
        this.startTail();
        this.keylock = on;
        this.jump(p);
        if (this.playing) this.fadeIn = this.xf;
        break;
      }
    }
  }

  // Position (samples) of the next sample that will be output.
  currentPos() {
    if (!this.keylock) return this.pos;
    if (this.fifoCount) return this.fifoPos[this.fifoHead];
    return this.wrap(this.anaPos + (this.Hs - this.Hs * this.rate) / 2);
  }

  jump(p) {
    this.pos = Math.max(0, p);
    if (this.keylock) this.resetWsola(this.pos);
  }

  // Capture a short fade-out of whatever is playing right now.
  startTail() {
    if (!this.playing || !this.L) { this.tailIdx = this.xf; return; }
    this.tailL.fill(0);
    this.tailR.fill(0);
    this.render(this.tailL, this.tailR, 0, this.xf);
    this.tailIdx = 0;
  }

  wrap(p) {
    const lp = this.loop;
    if (lp && p >= lp.e) p = lp.s + ((p - lp.s) % lp.len);
    return p;
  }

  // ---------- rendering ----------

  // Fills out[off..off+n) from the current engine; returns true at end of track.
  render(outL, outR, off, n) {
    return this.keylock ? this.renderWsola(outL, outR, off, n) : this.renderLinear(outL, outR, off, n);
  }

  renderLinear(outL, outR, off, n) {
    const { L, R, len, rate } = this;
    const lp = this.loop;
    let pos = this.pos;
    for (let k = 0; k < n; k++) {
      if (lp && pos >= lp.e) pos = lp.s + ((pos - lp.s) % lp.len);
      if (pos >= len - 1) {
        this.pos = len;
        return true;
      }
      const i = pos | 0;
      const f = pos - i;
      let j = i + 1;
      if (lp && j >= lp.e) j = Math.min(len - 1, Math.floor(lp.s + ((j - lp.s) % lp.len)));
      outL[off + k] = L[i] + (L[j] - L[i]) * f;
      outR[off + k] = R[i] + (R[j] - R[i]) * f;
      pos += rate;
    }
    this.pos = pos;
    return false;
  }

  renderWsola(outL, outR, off, n) {
    const mask = this.fifoMask;
    for (let k = 0; k < n; k++) {
      if (!this.fifoCount) this.wsolaFrame();
      const h = this.fifoHead;
      if (this.fifoPos[h] >= this.len) {
        this.pos = this.len;
        return true;
      }
      outL[off + k] = this.fifoL[h];
      outR[off + k] = this.fifoR[h];
      this.fifoHead = (h + 1) & mask;
      this.fifoCount--;
    }
    this.pos = this.currentPos();
    return false;
  }

  // Source sample i (float, mapped into the loop), or 0 outside the track.
  idx(i) {
    const lp = this.loop;
    if (lp && i >= lp.e) i = lp.s + ((i - lp.s) % lp.len);
    return Math.floor(i);
  }

  // Start WSOLA so that the first output sample corresponds to source position p.
  resetWsola(p) {
    const Hs = this.Hs;
    const Ha = Hs * this.rate;
    this.fifoHead = 0;
    this.fifoCount = 0;
    this.olaL.fill(0);
    this.olaR.fill(0);
    this.anaPos = p - (Hs - Ha) / 2;
    // Prime with the frame before so the first emitted chunk is at full level.
    this.prevStart = Math.round(this.anaPos - Ha);
    this.addFrame(this.prevStart);
    this.shiftOla();
  }

  addFrame(c) {
    const { N, win, olaL, olaR, L, R, len } = this;
    for (let n = 0; n < N; n++) {
      const i = this.idx(c + n);
      if (i < 0 || i >= len) continue;
      const w = win[n];
      olaL[n] += w * L[i];
      olaR[n] += w * R[i];
    }
  }

  shiftOla() {
    const { Hs, N, olaL, olaR } = this;
    olaL.copyWithin(0, Hs, N);
    olaR.copyWithin(0, Hs, N);
    olaL.fill(0, N - Hs);
    olaR.fill(0, N - Hs);
  }

  gatherMono(dst, start, count) {
    const { L, R, len } = this;
    for (let n = 0; n < count; n++) {
      const i = this.idx(start + n);
      dst[n] = i >= 0 && i < len ? L[i] + R[i] : 0;
    }
  }

  // One WSOLA step: pick the frame start near the nominal analysis position that best
  // continues the previous frame, overlap-add it, and queue Hs finished output samples.
  wsolaFrame() {
    const { Hs, tol, tmpl, region, olaL, olaR } = this;
    const step = this.rate;
    const Ha = Hs * step;
    const base = Math.round(this.anaPos);

    // Template: natural continuation of the previous frame over the overlap region.
    this.gatherMono(tmpl, this.prevStart + Hs, Hs);
    this.gatherMono(region, base - tol, 2 * tol + Hs);
    const score = (r, inc) => {
      let cc = 0;
      let ee = 1e-9;
      for (let n = 0; n < Hs; n += inc) {
        const v = region[r + n];
        cc += v * tmpl[n];
        ee += v * v;
      }
      return cc / Math.sqrt(ee);
    };
    let te = 0;
    for (let n = 0; n < Hs; n += 2) te += tmpl[n] * tmpl[n];
    // Ties (and silence) resolve to the nominal position so the clock stays unbiased.
    let fine = tol;
    if (te > 1e-6) {
      const margin = 1e-6 * Math.sqrt(te);
      let best = tol;
      let bestScore = score(tol, 2);
      for (let r = 0; r <= 2 * tol; r += 4) {
        const s = score(r, 2);
        if (s > bestScore + margin) { bestScore = s; best = r; }
      }
      const lo = Math.max(0, best - 4);
      const hi = Math.min(2 * tol, best + 4);
      fine = best;
      bestScore = score(best, 1);
      for (let r = lo; r <= hi; r++) {
        const s = score(r, 1);
        if (s > bestScore + margin) { bestScore = s; fine = r; }
      }
    }
    const c = base - tol + fine;

    this.addFrame(c);
    // Emit the finished first half with its (nominal) source positions.
    const mask = this.fifoMask;
    let w = (this.fifoHead + this.fifoCount) & mask;
    const p0 = this.anaPos + (Hs - Ha) / 2;
    for (let j = 0; j < Hs; j++) {
      this.fifoL[w] = olaL[j];
      this.fifoR[w] = olaR[j];
      this.fifoPos[w] = this.wrap(p0 + j * step);
      w = (w + 1) & mask;
    }
    this.fifoCount += Hs;
    this.shiftOla();

    this.prevStart = c;
    this.anaPos += Ha;
    const lp = this.loop;
    if (lp && this.prevStart >= lp.e) {
      const k = Math.floor((this.prevStart - lp.s) / lp.len);
      this.prevStart -= k * lp.len;
      this.anaPos -= k * lp.len;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const oL = out[0];
    const oR = out[1] || out[0];
    const n = oL.length;
    let ended = false;
    if (this.playing && this.L) {
      ended = this.render(oL, oR, 0, n);
      if (this.fadeIn > 0) {
        for (let k = 0; k < n && this.fadeIn > 0; k++, this.fadeIn--) {
          const g = 1 - this.fadeIn / this.xf;
          oL[k] *= g;
          if (oR !== oL) oR[k] *= g;
        }
      }
    }
    if (this.tailIdx < this.xf) {
      for (let k = 0; k < n && this.tailIdx < this.xf; k++, this.tailIdx++) {
        const g = 1 - this.tailIdx / this.xf;
        oL[k] += this.tailL[this.tailIdx] * g;
        if (oR !== oL) oR[k] += this.tailR[this.tailIdx] * g;
      }
    }
    if (ended) {
      this.playing = false;
      this.port.postMessage({ ended: true, seq: this.seq });
    } else if (this.playing) {
      this.reportIn -= n;
      if (this.reportIn <= 0) {
        this.reportIn = Math.round(REPORT_SEC * sampleRate);
        this.port.postMessage({ pos: this.currentPos() / sampleRate, time: currentTime + n / sampleRate, seq: this.seq });
      }
    }
    return true;
  }
}

function resample(data, fromRate) {
  const ratio = fromRate / sampleRate;
  const out = new Float32Array(Math.floor(data.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const p = i * ratio;
    const j = p | 0;
    const f = p - j;
    out[i] = data[j] + ((data[j + 1] ?? data[j]) - data[j]) * f;
  }
  return out;
}

registerProcessor('spindeck-deck', DeckProcessor);
