// A single playback deck: tempo, key lock, cues, loops and sync. Audio runs in an
// AudioWorklet (deck-worklet.js); this class keeps the transport state and a position clock.

const HOT_CUES = 8;
const modules = new WeakMap(); // AudioContext -> addModule() promise

// Registers the deck processor on a (realtime or offline) context, once per context.
export function loadDeckWorklet(ctx) {
  let p = modules.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(new URL('./deck-worklet.js', import.meta.url));
    p.catch(() => modules.delete(ctx));
    modules.set(ctx, p);
  }
  return p;
}

export class Deck extends EventTarget {
  #node = null;
  #seq = 0;
  #anchor = { pos: 0, time: 0 }; // position `pos` at context time `time`

  constructor(ctx, id, output) {
    super();
    this.ctx = ctx;
    this.id = id;
    this.output = output;
    this.buffer = null;
    this.track = null;
    this.analysis = null;
    this.playing = false;
    this.rate = 1;
    this.bend = 0;
    this.range = 0.08;
    this.keylock = false;
    this.cuePoint = 0;
    this.hotCues = new Array(HOT_CUES).fill(null);
    this.loop = null;
    this.lastLoop = null; // for reloop
    this.loopInPoint = null; // pending manual loop-in
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
    const a = this.#anchor;
    if (!this.playing) return a.pos;
    let p = a.pos + (this.ctx.currentTime - a.time) * this.effectiveRate;
    if (this.loop && p >= this.loop.end) {
      const len = this.loop.end - this.loop.start;
      p = this.loop.start + ((p - this.loop.start) % len);
    }
    return Math.max(0, Math.min(p, this.duration));
  }

  #emit(type) { this.dispatchEvent(new Event(type)); }

  #setAnchor(pos) { this.#anchor = { pos, time: this.ctx.currentTime }; }

  #send(msg) {
    msg.seq = ++this.#seq;
    this.#node?.port.postMessage(msg);
  }

  #onMessage(m) {
    if (m.seq < this.#seq) return; // stale: sent before our latest command
    if (m.ended) {
      if (!this.playing) return;
      this.playing = false;
      this.previewingCue = false;
      this.#anchor = { pos: this.duration, time: this.ctx.currentTime };
      this.#emit('change');
    } else if (this.playing) {
      this.#anchor = { pos: m.pos, time: m.time };
    }
  }

  async #ensureNode() {
    if (this.#node) return this.#node;
    await loadDeckWorklet(this.ctx);
    if (this.#node) return this.#node;
    const node = new AudioWorkletNode(this.ctx, 'spindeck-deck', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    });
    node.port.onmessage = (e) => this.#onMessage(e.data);
    node.connect(this.output);
    this.#node = node;
    this.#send({ type: 'keylock', on: this.keylock });
    return node;
  }

  #sendLoop() {
    this.#send({ type: 'loop', loop: this.loop ? { start: this.loop.start, end: this.loop.end } : null });
  }

  async load(buffer, track, analysis) {
    await this.#ensureNode();
    this.stop();
    this.buffer = buffer;
    this.track = track;
    this.analysis = analysis;
    this.rate = 1;
    this.bend = 0;
    this.loop = null;
    this.lastLoop = null;
    this.loopInPoint = null;
    this.hotCues = new Array(HOT_CUES).fill(null);
    this.cuePoint = analysis?.bpm ? analysis.firstBeat : 0;
    const saved = track?.cues;
    if (saved) {
      if (Number.isFinite(saved.cuePoint)) this.cuePoint = saved.cuePoint;
      for (let i = 0; i < HOT_CUES; i++) {
        const t = saved.hotCues?.[i];
        this.hotCues[i] = Number.isFinite(t) ? t : null;
      }
    }
    const d0 = buffer.getChannelData(0);
    const channels = buffer.numberOfChannels > 1 ? [d0, buffer.getChannelData(1)] : [d0, d0];
    this.#send({ type: 'load', channels, sampleRate: buffer.sampleRate });
    this.#send({ type: 'rate', rate: this.effectiveRate });
    this.#setAnchor(this.cuePoint);
    this.#emit('load');
    this.#emit('change');
  }

  play() {
    if (!this.loaded || this.playing) return;
    let pos = this.#anchor.pos;
    if (pos >= this.duration - 0.01) pos = 0;
    this.ctx.resume();
    this.#setAnchor(pos);
    this.playing = true;
    this.#send({ type: 'play', pos });
    this.#emit('change');
  }

  pause() {
    if (!this.playing) return;
    this.#setAnchor(this.position);
    this.playing = false;
    this.#send({ type: 'pause' });
    this.#emit('change');
  }

  stop() {
    if (this.playing) {
      this.#setAnchor(this.position);
      this.#send({ type: 'pause' });
    }
    this.playing = false;
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    if (!this.loaded) return;
    t = Math.max(0, Math.min(this.duration - 0.001, t));
    if (this.loop && (t < this.loop.start || t >= this.loop.end)) this.exitLoop();
    this.#setAnchor(t);
    this.#send({ type: 'seek', pos: t });
    this.#emit('change');
  }

  setRate(rate) {
    if (this.playing) this.#setAnchor(this.position);
    this.rate = rate;
    this.#send({ type: 'rate', rate: this.effectiveRate });
    this.#emit('change');
  }

  // pitch: -1..1 of current range
  setPitch(p) { this.setRate(1 + p * this.range); }
  get pitch() { return (this.rate - 1) / this.range; }

  setBend(b) {
    if (this.playing) this.#setAnchor(this.position);
    this.bend = b;
    this.#send({ type: 'rate', rate: this.effectiveRate });
  }

  // Key lock: keep the original pitch when the tempo changes (WSOLA time-stretch).
  setKeylock(on) {
    on = !!on;
    if (on === this.keylock) return;
    if (this.playing) this.#setAnchor(this.position);
    this.keylock = on;
    this.#send({ type: 'keylock', on });
    this.#emit('change');
  }

  // --- Cue (CDJ style): hold while paused at cue to preview, press while playing to return.
  cueDown() {
    if (!this.loaded) return;
    if (this.playing) {
      this.pause();
      this.seek(this.cuePoint);
    } else if (Math.abs(this.#anchor.pos - this.cuePoint) < 0.01) {
      this.previewingCue = true;
      this.play();
    } else {
      this.cuePoint = this.snap(this.#anchor.pos);
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
    if (!this.loaded || i < 0 || i >= HOT_CUES) return;
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

  // Loop length in beats when it is a clean fraction of a beat (for lighting the pads).
  #beatsOf(len) {
    if (!this.bpm) return null;
    const b = len / this.beatLen;
    const r = Math.round(b * 64) / 64;
    return Math.abs(b - r) < 0.005 ? r : null;
  }

  #activateLoop(start, end, beats) {
    end = Math.min(this.duration, end);
    if (!(end > start)) return;
    this.loop = { start, end, beats };
    this.lastLoop = { ...this.loop };
    if (this.playing) this.#setAnchor(this.position);
    this.#sendLoop();
    this.#emit('change');
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
    this.loopInPoint = null;
    if (!this.playing) this.#setAnchor(start);
    this.#activateLoop(start, start + beats * this.beatLen, beats);
  }

  exitLoop() {
    if (!this.loop) return;
    if (this.playing) this.#setAnchor(this.position);
    this.loop = null;
    this.#sendLoop();
    this.#emit('change');
  }

  // --- Manual loops
  loopIn() {
    if (!this.loaded) return;
    this.loopInPoint = this.snap(this.position);
    this.#emit('change');
  }

  loopOut() {
    if (!this.loaded || this.loopInPoint == null) return;
    const start = this.loopInPoint;
    const end = this.snap(this.position);
    if (end - start < 0.01) return;
    this.loopInPoint = null;
    this.#activateLoop(start, end, this.#beatsOf(end - start));
  }

  reloop() {
    if (!this.loaded) return;
    if (this.loop) return this.exitLoop();
    if (!this.lastLoop) return;
    const { start, end, beats } = this.lastLoop;
    const pos = this.position;
    this.#activateLoop(start, end, beats);
    if (pos < start || pos >= end) this.seek(start);
  }

  halveLoop() {
    if (!this.loop) return;
    const { start, end, beats } = this.loop;
    const len = (end - start) / 2;
    if (len < 0.005) return;
    this.#activateLoop(start, start + len, beats != null ? beats / 2 : this.#beatsOf(len));
  }

  doubleLoop() {
    if (!this.loop) return;
    const { start, end, beats } = this.loop;
    const len = (end - start) * 2;
    if (start + len > this.duration) return;
    this.#activateLoop(start, start + len, beats != null ? beats * 2 : this.#beatsOf(len));
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
