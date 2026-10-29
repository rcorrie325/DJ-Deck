// Two-channel DJ mixer: trim, 3-band EQ with kills, filter, faders, crossfader, master + limiter.

const dbToGain = (db) => Math.pow(10, db / 20);

export class Mixer {
  constructor(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.1;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.recordDest = ctx.createMediaStreamDestination();

    this.master.connect(this.limiter).connect(this.analyser);
    this.analyser.connect(ctx.destination);
    this.analyser.connect(this.recordDest);

    this.channels = { A: this.#makeChannel(), B: this.#makeChannel() };
    this.xfade = 0.5;
    this.curve = 'smooth';
    this.setCrossfader(0.5);
  }

  #makeChannel() {
    const ctx = this.ctx;
    const trim = ctx.createGain();
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 220;
    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1000;
    mid.Q.value = 0.7;
    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 3500;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 22000;
    lp.Q.value = 0.7;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 10;
    hp.Q.value = 0.7;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const fader = ctx.createGain();
    const xf = ctx.createGain();

    trim.connect(low).connect(mid).connect(high).connect(lp).connect(hp);
    hp.connect(analyser);
    hp.connect(fader).connect(xf).connect(this.master);
    return { input: trim, trim, low, mid, high, lp, hp, analyser, fader, xf };
  }

  input(id) { return this.channels[id].input; }

  #ramp(param, value) {
    param.setTargetAtTime(value, this.ctx.currentTime, 0.01);
  }

  // v: -1..1. Bottom of the knob is a full kill.
  setEq(id, band, v) {
    const db = v <= -0.98 ? -60 : v < 0 ? v * 26 : v * 6;
    this.#ramp(this.channels[id][band].gain, db);
  }

  setTrim(id, v) { this.#ramp(this.channels[id].trim.gain, dbToGain(v * 12)); }

  // v: -1 (low-pass) .. 0 (off) .. 1 (high-pass)
  setFilter(id, v) {
    const ch = this.channels[id];
    const lp = v < -0.02 ? 20000 * Math.pow(120 / 20000, -v) : 22000;
    const hp = v > 0.02 ? 20 * Math.pow(9000 / 20, v) : 10;
    const q = Math.abs(v) > 0.02 ? 1.4 : 0.7;
    this.#ramp(ch.lp.frequency, lp);
    this.#ramp(ch.hp.frequency, hp);
    ch.lp.Q.value = q;
    ch.hp.Q.value = q;
  }

  setFader(id, v) { this.#ramp(this.channels[id].fader.gain, v * v); }

  setMaster(v) { this.#ramp(this.master.gain, v * v * 1.2); }

  setCrossfader(x) {
    this.xfade = x;
    let a;
    let b;
    if (this.curve === 'sharp') {
      a = x < 0.92 ? 1 : (1 - x) / 0.08;
      b = x > 0.08 ? 1 : x / 0.08;
    } else {
      a = Math.cos((x * Math.PI) / 2);
      b = Math.sin((x * Math.PI) / 2);
    }
    this.#ramp(this.channels.A.xf.gain, a);
    this.#ramp(this.channels.B.xf.gain, b);
  }

  setCurve(curve) {
    this.curve = curve;
    this.setCrossfader(this.xfade);
  }
}

const meterBuf = new Float32Array(1024);
export function peakLevel(analyser) {
  analyser.getFloatTimeDomainData(meterBuf);
  let peak = 0;
  for (let i = 0; i < meterBuf.length; i++) {
    const v = Math.abs(meterBuf[i]);
    if (v > peak) peak = v;
  }
  // Map -48dB..0dB to 0..1
  const db = 20 * Math.log10(peak + 1e-9);
  return Math.max(0, Math.min(1, (db + 48) / 48));
}
