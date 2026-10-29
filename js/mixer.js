// Two-channel DJ mixer: trim, 3-band EQ with kills, filter, per-channel FX (echo / reverb / flanger),
// faders, crossfader, master + limiter, headphone cue (PFL) on outputs 3/4 of a 4-channel device.
//
// Channel chain:  trim → low → mid → high → lp → hp → [FX dry/wet] → fxOut → fader → xf → master
//                                                                    ├→ analyser (channel meter, post-FX, pre-fader)
//                                                                    └→ cue send (PFL, post-FX, pre-fader)

const dbToGain = (db) => Math.pow(10, db / 20);

export const FX_TYPES = ['echo', 'reverb', 'flanger'];
export const FX_BEATS = [0.5, 0.75, 1, 2, 4];
const FX_FADE = 0.03; // seconds; ramp for sends / dry-wet changes
const DEFAULT_BPM = 120;
const ECHO_FEEDBACK = 0.45;
const FLANGER_FB = 0.55; // weight of the emulated recirculation taps

// Stereo decaying-noise impulse response (deterministic so renders are repeatable).
function makeImpulse(ctx, seconds = 2.5, decay = 3.2) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  let seed = 22222;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // Gentle one-pole damping that closes over time, so the tail darkens as it decays.
      const k = 0.6 - 0.45 * t;
      lp += k * (rand() - lp);
      d[i] = lp * Math.pow(1 - t, decay);
    }
  }
  return buf;
}

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
    // Not available on OfflineAudioContext.
    this.recordDest = typeof ctx.createMediaStreamDestination === 'function' ? ctx.createMediaStreamDestination() : null;

    this.master.connect(this.limiter).connect(this.analyser);
    if (this.recordDest) this.analyser.connect(this.recordDest); // master only, never the cue

    this.impulse = makeImpulse(ctx);

    // Headphone bus: PFL sum and master, blended by the CUE MIX knob, then PHONES level.
    this.cueBus = ctx.createGain();
    this.cueMixCue = ctx.createGain();
    this.cueMixMaster = ctx.createGain();
    this.phones = ctx.createGain();
    this.cueBus.connect(this.cueMixCue).connect(this.phones);
    this.analyser.connect(this.cueMixMaster).connect(this.phones);

    // 4-channel output stage (built once, connected only when the device has ≥ 4 outputs).
    const stereo = () => {
      const g = ctx.createGain();
      g.channelCount = 2;
      g.channelCountMode = 'explicit';
      g.channelInterpretation = 'speakers'; // mono decks up-mix to both sides
      return g;
    };
    this.masterOut = stereo();
    this.phonesOut = stereo();
    this.analyser.connect(this.masterOut);
    this.phones.connect(this.phonesOut);
    this.splitMaster = ctx.createChannelSplitter(2);
    this.splitPhones = ctx.createChannelSplitter(2);
    this.merger = ctx.createChannelMerger(4);
    this.masterOut.connect(this.splitMaster);
    this.phonesOut.connect(this.splitPhones);
    this.splitMaster.connect(this.merger, 0, 0);
    this.splitMaster.connect(this.merger, 1, 1);
    this.splitPhones.connect(this.merger, 0, 2);
    this.splitPhones.connect(this.merger, 1, 3);
    this.outChannels = 0;

    this.channels = { A: this.#makeChannel('A'), B: this.#makeChannel('B') };
    this.xfade = 0.5;
    this.curve = 'smooth';
    this.setCrossfader(0.5);
    this.cueMix = 0;
    this.setCueMix(0);
    this.setPhones(0.8);
    this.#route();
    // The device can change under us (e.g. the OS default output switches).
    ctx.addEventListener?.('sinkchange', () => this.#route());
  }

  #makeChannel(id) {
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
    const cue = ctx.createGain();
    cue.gain.value = 0;

    const fx = this.#makeFx(hp);
    trim.connect(low).connect(mid).connect(high).connect(lp).connect(hp);
    fx.out.connect(analyser);
    fx.out.connect(fader).connect(xf).connect(this.master);
    fx.out.connect(cue).connect(this.cueBus);
    const ch = { id, input: trim, trim, low, mid, high, lp, hp, fx, fxOut: fx.out, analyser, fader, xf, cue, cueOn: false };
    this.#applyFx(ch, true);
    return ch;
  }

  // One FX unit: dry path straight through, plus a send per effect type summed into one wet return.
  #makeFx(src) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    src.connect(dry).connect(out);
    wet.connect(out);
    const sends = {};
    for (const t of FX_TYPES) {
      sends[t] = ctx.createGain();
      sends[t].gain.value = 0;
      src.connect(sends[t]);
    }

    // Echo: delay with a darkening feedback loop.
    const echoDelay = ctx.createDelay(8);
    const echoFb = ctx.createGain();
    echoFb.gain.value = ECHO_FEEDBACK;
    const echoTone = ctx.createBiquadFilter();
    echoTone.type = 'lowpass';
    echoTone.frequency.value = 3800;
    echoTone.Q.value = 0.5;
    sends.echo.connect(echoDelay);
    echoDelay.connect(echoTone).connect(echoFb).connect(echoDelay);
    echoDelay.connect(wet);

    // Reverb: convolution with a generated stereo decaying-noise impulse.
    const conv = ctx.createConvolver();
    conv.buffer = this.impulse;
    sends.reverb.connect(conv).connect(wet);

    // Flanger: 1–5 ms swept delay. Feedback is emulated with extra taps at 2× and 3× the delay
    // (the first recirculations), because a DelayNode inside a real feedback cycle is clamped to
    // ≥ one render quantum (~2.7 ms), which would cut off the bottom of the sweep.
    const lfo = ctx.createOscillator();
    lfo.type = 'triangle';
    lfo.frequency.value = 0.25;
    const taps = [];
    for (let k = 1; k <= 3; k++) {
      const d = ctx.createDelay(0.05);
      d.delayTime.value = 0.003 * k;
      const depth = ctx.createGain();
      depth.gain.value = 0.002 * k; // base 3 ms ± 2 ms → 1–5 ms
      lfo.connect(depth).connect(d.delayTime);
      const g = ctx.createGain();
      g.gain.value = Math.pow(FLANGER_FB, k - 1) * (k === 1 ? 1 : 0.9);
      sends.flanger.connect(d).connect(g).connect(wet);
      taps.push({ d, depth, g });
    }
    lfo.start();

    return {
      out, dry, wet, sends, echoDelay, echoFb, conv, lfo, taps,
      state: { type: 'echo', on: false, depth: 0.5, beats: 1 },
      bpm: DEFAULT_BPM,
      activeSend: null,
    };
  }

  input(id) { return this.channels[id].input; }

  #ramp(param, value) {
    param.setTargetAtTime(value, this.ctx.currentTime, 0.01);
  }

  // Linear ramp that lands exactly on `value` (so a bypassed dry gain is exactly 1).
  #glide(param, value, time = FX_FADE, now = false) {
    const t = this.ctx.currentTime;
    param.cancelScheduledValues(t);
    if (now) { param.value = value; return; }
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(value, t + time);
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

  // ---------- FX ----------

  // opts: { type: 'echo'|'reverb'|'flanger', on: bool, depth: 0..1, beats: number } — any subset.
  setFx(id, opts = {}) {
    const ch = this.channels[id];
    const s = ch.fx.state;
    if (opts.type != null) {
      if (!FX_TYPES.includes(opts.type)) throw new Error(`Unknown FX type: ${opts.type}`);
      s.type = opts.type;
    }
    if (opts.on != null) s.on = !!opts.on;
    if (opts.depth != null && Number.isFinite(+opts.depth)) s.depth = Math.max(0, Math.min(1, +opts.depth));
    if (opts.beats != null && +opts.beats > 0) s.beats = +opts.beats;
    this.#applyFx(ch);
    return { ...s };
  }

  getFx(id) { return { ...this.channels[id].fx.state }; }

  // Called whenever the deck's playing tempo changes; keeps echo / flanger in time.
  setFxBpm(id, bpm) {
    const fx = this.channels[id].fx;
    bpm = Number.isFinite(bpm) && bpm > 20 ? bpm : DEFAULT_BPM;
    if (Math.abs(bpm - fx.bpm) < 1e-3) return;
    fx.bpm = bpm;
    this.#applyTiming(fx, false);
  }

  #applyTiming(fx, now) {
    const beat = 60 / fx.bpm;
    const delay = Math.min(7.9, fx.state.beats * beat);
    const p = fx.echoDelay.delayTime;
    if (now) {
      p.value = delay;
    } else {
      p.cancelScheduledValues(this.ctx.currentTime);
      p.setTargetAtTime(delay, this.ctx.currentTime, 0.02);
    }
    // Flanger: one full sweep every `beats` bars.
    const hz = 1 / (fx.state.beats * 4 * beat);
    if (now) fx.lfo.frequency.value = hz;
    else fx.lfo.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.05);
  }

  #applyFx(ch, now = false) {
    const fx = ch.fx;
    const s = fx.state;
    this.#applyTiming(fx, now);
    const ang = (s.depth * Math.PI) / 2;
    const active = s.on ? s.type : null;
    // Only the active effect gets input; others fade their send so tails ring out on their own.
    for (const t of FX_TYPES) this.#glide(fx.sends[t].gain, t === active ? 1 : 0, FX_FADE, now);
    this.#glide(fx.dry.gain, s.on ? Math.cos(ang) : 1, FX_FADE, now);
    // The wet return is left alone when switching off so echo / reverb tails decay naturally.
    if (s.on) this.#glide(fx.wet.gain, Math.sin(ang), FX_FADE, now);
    else if (now) fx.wet.gain.value = 0;
    fx.activeSend = active;
  }

  // ---------- headphone cue ----------

  setCue(id, on) {
    const ch = this.channels[id];
    ch.cueOn = !!on;
    this.#glide(ch.cue.gain, ch.cueOn ? 1 : 0, 0.01);
  }

  // v: 0 = cue only .. 1 = master only (equal power).
  setCueMix(v) {
    this.cueMix = Math.max(0, Math.min(1, v));
    const a = (this.cueMix * Math.PI) / 2;
    this.#ramp(this.cueMixCue.gain, Math.cos(a));
    this.#ramp(this.cueMixMaster.gain, Math.sin(a));
  }

  setPhones(v) { this.#ramp(this.phones.gain, v * v * 1.2); }

  outputInfo() {
    return { channels: this.outChannels, cueAvailable: this.outChannels >= 4 };
  }

  // Resolves once the new device is active; rejects when the browser can't pick outputs.
  async setOutputDevice(deviceId) {
    if (typeof this.ctx.setSinkId !== 'function') {
      throw new Error("Output selection isn't supported in this browser");
    }
    await this.ctx.setSinkId(deviceId || '');
    this.#route();
    return this.outputInfo();
  }

  // Wire the output stage for the current device: 4 discrete channels (master 1/2, phones 3/4)
  // when available, plain stereo master otherwise.
  #route() {
    const dest = this.ctx.destination;
    const max = dest.maxChannelCount || 2;
    const want = max >= 4 ? 4 : 2;
    try { this.analyser.disconnect(dest); } catch { /* not connected */ }
    try { this.merger.disconnect(); } catch { /* not connected */ }
    if (want === 4) {
      try {
        if (dest.channelCount !== 4) dest.channelCount = 4;
        dest.channelCountMode = 'explicit';
        dest.channelInterpretation = 'discrete';
      } catch { /* offline destinations have a fixed count */ }
      this.merger.connect(dest);
    } else {
      try {
        if (dest.channelCount !== 2 && max >= 2) dest.channelCount = 2;
        dest.channelInterpretation = 'speakers';
      } catch { /* fixed */ }
      this.analyser.connect(dest);
    }
    this.outChannels = max;
    this.onroute?.(this.outputInfo());
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
