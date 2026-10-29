// A single playback deck built on AudioBufferSourceNode with tempo, cues, loops and sync.

export class Deck extends EventTarget {
  constructor(ctx, id, output) {
    super();
    this.ctx = ctx;
    this.id = id;
    this.output = output;
    this.buffer = null;
    this.track = null;
    this.analysis = null;
    this.source = null;
    this.playing = false;
    this.startCtxTime = 0;
    this.startOffset = 0;
    this.rate = 1;
    this.bend = 0;
    this.range = 0.08;
    this.cuePoint = 0;
    this.hotCues = [null, null, null, null];
    this.loop = null;
    this.previewingCue = false;
  }

  get loaded() { return !!this.buffer; }
  get duration() { return this.buffer?.duration || 0; }
  get bpm() { return this.analysis?.bpm || this.track?.bpm || null; }
  get firstBeat() { return this.analysis?.firstBeat || 0; }
  get effectiveRate() { return this.rate * (1 + this.bend); }
  get currentBpm() { return this.bpm ? this.bpm * this.rate : null; }
  get beatLen() { return this.bpm ? 60 / this.bpm : 0.5; }

  get position() {
    if (!this.playing) return this.startOffset;
    let p = this.startOffset + (this.ctx.currentTime - this.startCtxTime) * this.effectiveRate;
    if (this.loop && p >= this.loop.end) {
      const len = this.loop.end - this.loop.start;
      p = this.loop.start + ((p - this.loop.start) % len);
    }
    return Math.min(p, this.duration);
  }

  #emit(type) { this.dispatchEvent(new Event(type)); }

  load(buffer, track, analysis) {
    this.stop();
    this.buffer = buffer;
    this.track = track;
    this.analysis = analysis;
    this.startOffset = 0;
    this.rate = 1;
    this.bend = 0;
    this.loop = null;
    this.hotCues = [null, null, null, null];
    this.cuePoint = analysis?.bpm ? analysis.firstBeat : 0;
    this.startOffset = this.cuePoint;
    this.#emit('load');
    this.#emit('change');
  }

  #startSource(offset) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.effectiveRate;
    if (this.loop) {
      src.loop = true;
      src.loopStart = this.loop.start;
      src.loopEnd = this.loop.end;
    }
    src.connect(this.output);
    src.onended = () => {
      if (this.source !== src) return;
      this.source = null;
      this.playing = false;
      this.startOffset = this.duration;
      this.#emit('change');
    };
    this.startCtxTime = this.ctx.currentTime;
    this.startOffset = offset;
    src.start(0, offset);
    this.source = src;
  }

  #stopSource() {
    if (!this.source) return;
    const src = this.source;
    this.source = null;
    try { src.stop(); } catch { /* already stopped */ }
    src.disconnect();
  }

  // Re-anchor the position clock (needed whenever the rate changes).
  #rebase() {
    this.startOffset = this.position;
    this.startCtxTime = this.ctx.currentTime;
  }

  play() {
    if (!this.loaded || this.playing) return;
    if (this.startOffset >= this.duration - 0.01) this.startOffset = 0;
    this.ctx.resume();
    this.#startSource(this.startOffset);
    this.playing = true;
    this.#emit('change');
  }

  pause() {
    if (!this.playing) return;
    this.startOffset = this.position;
    this.#stopSource();
    this.playing = false;
    this.#emit('change');
  }

  stop() {
    this.#stopSource();
    this.playing = false;
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    if (!this.loaded) return;
    t = Math.max(0, Math.min(this.duration - 0.001, t));
    if (this.loop && (t < this.loop.start || t >= this.loop.end)) this.exitLoop();
    if (this.playing) {
      this.#stopSource();
      this.#startSource(t);
    } else {
      this.startOffset = t;
    }
    this.#emit('change');
  }

  setRate(rate) {
    if (this.playing) this.#rebase();
    this.rate = rate;
    this.source?.playbackRate.setValueAtTime(this.effectiveRate, this.ctx.currentTime);
    this.#emit('change');
  }

  // pitch: -1..1 of current range
  setPitch(p) { this.setRate(1 + p * this.range); }
  get pitch() { return (this.rate - 1) / this.range; }

  setBend(b) {
    if (this.playing) this.#rebase();
    this.bend = b;
    this.source?.playbackRate.setValueAtTime(this.effectiveRate, this.ctx.currentTime);
  }

  // --- Cue (CDJ style): hold while paused at cue to preview, press while playing to return.
  cueDown() {
    if (!this.loaded) return;
    if (this.playing) {
      this.pause();
      this.seek(this.cuePoint);
    } else if (Math.abs(this.startOffset - this.cuePoint) < 0.01) {
      this.previewingCue = true;
      this.play();
    } else {
      this.cuePoint = this.snap(this.startOffset);
      this.seek(this.cuePoint);
    }
    this.#emit('change');
  }

  cueUp() {
    if (!this.previewingCue) return;
    this.previewingCue = false;
    this.pause();
    this.seek(this.cuePoint);
  }

  // Lock a cue preview into normal playback (pressing play while holding cue).
  releasePreview() { this.previewingCue = false; }

  hotCue(i, del = false) {
    if (!this.loaded) return;
    if (del) this.hotCues[i] = null;
    else if (this.hotCues[i] == null) this.hotCues[i] = this.position;
    else this.seek(this.hotCues[i]);
    this.#emit('change');
  }

  // Snap a time to the nearest beat if a grid is known and we're close.
  snap(t) {
    if (!this.bpm) return t;
    const beat = Math.round((t - this.firstBeat) / this.beatLen);
    const snapped = this.firstBeat + beat * this.beatLen;
    return Math.abs(snapped - t) < 0.08 ? Math.max(0, snapped) : t;
  }

  setLoop(beats) {
    if (!this.loaded) return;
    if (this.loop?.beats === beats) return this.exitLoop();
    const pos = this.position;
    let start = pos;
    if (this.bpm) {
      // Start on the current beat.
      const beat = Math.floor((pos - this.firstBeat) / this.beatLen + 1e-6);
      start = Math.max(0, this.firstBeat + beat * this.beatLen);
    }
    const end = Math.min(this.duration, start + beats * this.beatLen);
    this.loop = { start, end, beats };
    if (this.source) {
      this.source.loopStart = start;
      this.source.loopEnd = end;
      this.source.loop = true;
    }
    if (!this.playing) this.startOffset = start;
    this.#emit('change');
  }

  exitLoop() {
    if (!this.loop) return;
    if (this.playing) this.#rebase();
    this.loop = null;
    if (this.source) this.source.loop = false;
    this.#emit('change');
  }

  beatPhase() {
    if (!this.bpm) return 0;
    const b = (this.position - this.firstBeat) / this.beatLen;
    return b - Math.floor(b);
  }

  // Match tempo and beat phase to another deck.
  syncTo(other) {
    if (!this.bpm || !other?.loaded || !other.currentBpm) return false;
    let target = other.currentBpm;
    // Handle half/double time.
    while (target / this.bpm > 1.5) target /= 2;
    while (target / this.bpm < 0.67) target *= 2;
    const rate = target / this.bpm;
    if (Math.abs(rate - 1) > this.range) {
      this.range = [0.08, 0.16, 0.5].find((r) => Math.abs(rate - 1) <= r) || 0.5;
    }
    this.setRate(rate);
    if (other.playing || this.playing) {
      let diff = other.beatPhase() - this.beatPhase();
      if (diff > 0.5) diff -= 1;
      if (diff < -0.5) diff += 1;
      if (Math.abs(diff) > 0.005) this.seek(this.position + diff * this.beatLen);
    }
    this.#emit('change');
    return true;
  }
}
