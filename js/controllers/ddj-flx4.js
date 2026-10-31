// Built-in mapping for the Pioneer DDJ-FLX4, active as soon as the board is connected.
// MIDI numbers follow Mixxx's community DDJ-FLX4 mapping (res/controllers/Pioneer-DDJ-FLX4.midi.xml).
// Everything acts through the same targets MIDI Learn uses (js/midi-targets.js), so a
// control behaves the same whether it's driven by this profile or by a learned mapping.

import { peakLevel } from '../mixer.js';

const DECKS = ['A', 'B'];
const LOOP_PADS = [0.25, 0.5, 1, 2, 4, 8, 16, 32]; // BEAT LOOP pad mode, pads 1–8
const JUMP_PADS = [-1, 1, -2, 2, -4, 4, -8, 8]; // BEAT JUMP pad mode, pads 1–8 (beats)
const FX_ORDER = ['echo', 'reverb', 'flanger'];
const TAKEOVER = 0.03;
const JOG_SEEK = 1.8 / 720; // s per tick on the platter top: one turn ≈ 1.8 s, like a 33⅓ rpm record
const JOG_SEARCH = 0.05; // s per tick for SHIFT + jog
const JOG_BEND = 0.01; // playback-rate bend per tick while playing
const JOG_DECAY_MS = 80;
const SCRUB_MS = 25; // while playing, platter moves are applied in batches this often
// Sent every 200 ms by Mixxx and rekordbox; the board treats it as "software connected".
const KEEPALIVE = [0xf0, 0x00, 0x40, 0x05, 0x00, 0x00, 0x04, 0x05, 0x00, 0x50, 0x02, 0xf7];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const $ = (sel) => document.querySelector(sel);

export const DDJ_FLX4 = {
  id: 'ddj-flx4',
  name: 'Pioneer DDJ-FLX4',
  match: (portName) => /ddj[\s-]*flx4/i.test(portName),
  create: (ctx) => new Flx4(ctx),
};

class Flx4 {
  // ctx: { target(id), decks, mixer, toast, settings: { invertTempo } }
  constructor(ctx) {
    this.ctx = ctx;
    this.msb = new Map(); // 14-bit controls: last MSB / LSB per control
    this.lsb = new Map();
    this.takeover = new Map();
    this.fxCh = { A: false, B: false }; // BEAT FX channel select switch
    this.jogTimers = {};
    this.scrub = { A: 0, B: 0 }; // platter ticks waiting to be applied
    this.scrubTimers = {};
    this.ledCache = new Map();
  }

  #t(id) { return this.ctx.target(id); }

  #press(id) { this.#t(id)?.on(1, true); }

  // Soft takeover, like Mixxx: a hardware control only takes over once it reaches the on-screen value.
  #absolute(id, v) {
    const t = this.#t(id);
    if (!t) return;
    const st = this.takeover.get(id) || { picked: false, last: null, lastSet: null };
    this.takeover.set(id, st);
    const cur = t.get?.();
    if (cur == null) { t.on(v); return; }
    if (st.picked && st.lastSet != null && Math.abs(cur - st.lastSet) > 0.02) st.picked = false; // moved on screen
    if (!st.picked) {
      const crossed = st.last != null && (st.last - cur) * (v - cur) <= 0;
      if (Math.abs(v - cur) <= TAKEOVER || crossed) st.picked = true;
    }
    st.last = v;
    if (!st.picked) return;
    t.on(v);
    st.lastSet = t.get?.() ?? v;
  }

  // 14-bit CC pairs: MSB on cc, LSB on cc + 0x20. Returns 0..1 or null if this isn't one.
  #fourteenBit(status, cc, value) {
    const key = (c) => `${status}:${c}`;
    if (cc < 0x20) this.msb.set(key(cc), value);
    else this.lsb.set(key(cc - 0x20), value);
    const base = cc < 0x20 ? cc : cc - 0x20;
    const full = ((this.msb.get(key(base)) ?? 0) << 7) | (this.lsb.get(key(base)) ?? 0);
    return { control: base, v: full / 16383 };
  }

  // Returns true if the message was a DDJ-FLX4 control this profile handles.
  handle(data) {
    const [status, d1, d2 = 0] = data;
    const kind = status & 0xf0;
    const ch = status & 0x0f;
    if (kind === 0x80 || kind === 0x90) return this.#note(ch, d1, kind === 0x90 && d2 > 0);
    if (kind === 0xb0) return this.#cc(status, ch, d1, d2);
    return false;
  }

  #note(ch, n, pressed) {
    const { decks } = this.ctx;
    if (ch <= 1) {
      const id = DECKS[ch];
      const deck = decks[id];
      switch (n) {
        case 0x0b: this.#t(`${id}.play`)?.on(pressed ? 1 : 0, pressed); return true; // PLAY/PAUSE
        case 0x0c: this.#t(`${id}.cue`)?.on(pressed ? 1 : 0, pressed); return true; // CUE (hold to preview)
        case 0x48: if (pressed) { deck.pause(); deck.seek(0); } return true; // SHIFT + CUE: back to the start
        case 0x58: if (pressed) this.#press(`${id}.sync`); return true; // BEAT SYNC
        case 0x60: if (pressed) $(`#deck${id} .range`)?.click(); return true; // SHIFT + SYNC: tempo range
        case 0x10: if (pressed) this.#press(`${id}.loopIn`); return true; // LOOP IN
        case 0x11: if (pressed) this.#press(`${id}.loopOut`); return true; // LOOP OUT
        case 0x4d: if (pressed) this.#press(`${id}.reloop`); return true; // RELOOP / EXIT
        case 0x51: if (pressed) this.#press(`${id}.loopHalf`); return true; // CUE/LOOP CALL ◀: halve loop
        case 0x53: if (pressed) this.#press(`${id}.loopDouble`); return true; // CUE/LOOP CALL ▶: double loop
        case 0x54: if (pressed) this.#press(`${id}.pfl`); return true; // headphone CUE
        case 0x36: case 0x67: return true; // jog touch: turning the top already moves the track
        case 0x3f: return true; // SHIFT: the board already sends separate shifted notes
        default: return false;
      }
    }
    // Performance pads: 0x97 / 0x99 (deck 1 / 2), with SHIFT 0x98 / 0x9A.
    if (ch >= 7 && ch <= 10) {
      const id = ch <= 8 ? 'A' : 'B';
      const shift = ch === 8 || ch === 10;
      const deck = decks[id];
      if (!pressed) return true;
      if (n <= 0x07) { deck.hotCue(n, shift); return true; } // HOT CUE mode (SHIFT deletes)
      if (n >= 0x60 && n <= 0x67) { deck.setLoop(LOOP_PADS[n - 0x60]); return true; } // BEAT LOOP mode
      if (n >= 0x20 && n <= 0x27) { // BEAT JUMP mode
        if (deck.loaded) deck.seek(deck.position + JUMP_PADS[n - 0x20] * deck.beatLen);
        return true;
      }
      return true; // other pad modes (sampler, pad FX, keyboard) aren't supported yet
    }
    // BEAT FX section: 0x94 / 0x95.
    if (ch === 4 || ch === 5) {
      if (n === 0x10 && ch === 4) { this.fxCh.A = pressed; return true; } // channel select: CH1
      if (n === 0x11 && ch === 5) { this.fxCh.B = pressed; return true; } // channel select: CH2
      if (!pressed) return true;
      if (n === 0x47) { this.#fxToggle(); return true; } // BEAT FX ON/OFF
      if (n === 0x63) { this.#fxCycleType(); return true; } // BEAT FX SELECT
      if (n === 0x4a || n === 0x4b) { this.#fxBeats(n === 0x4a ? -1 : 1); return true; } // BEAT ◀ / ▶
      return true;
    }
    // Browser section: 0x96.
    if (ch === 6) {
      if (n === 0x46 && pressed) this.#press('A.load'); // LOAD deck 1
      if (n === 0x47 && pressed) this.#press('B.load'); // LOAD deck 2
      return n === 0x46 || n === 0x47 || n === 0x41 || n === 0x42;
    }
    return false;
  }

  #cc(status, ch, cc, value) {
    if (ch <= 1) {
      const id = DECKS[ch];
      if (cc === 0x21) { this.#jogSide(id, value - 64); return true; } // jog outer ring: nudge
      if (cc === 0x22 || cc === 0x23) { this.#platter(id, value - 64); return true; } // jog top: move through the track
      if (cc === 0x29) { this.#jogSearch(id, value - 64); return true; } // SHIFT + jog
      const fourteen = { 0x00: 'pitch', 0x13: 'fader', 0x04: 'trim', 0x07: 'high', 0x0b: 'mid', 0x0f: 'low' };
      const base = cc < 0x20 ? cc : cc - 0x20;
      const what = fourteen[base];
      if (!what) return false;
      const { v } = this.#fourteenBit(status, cc, value);
      if (what === 'pitch') {
        // The fader's top is "−" (slower), like a CDJ. invertTempo flips it if a board reports the other way.
        const up = this.ctx.settings.invertTempo ? v : 1 - v;
        this.#absolute(`${id}.pitch`, up);
      } else if (what === 'fader') {
        this.#absolute(`${id}.fader`, v);
      } else {
        this.#absolute(`${id}.${what}`, v);
      }
      return true;
    }
    if (ch === 6) {
      if (cc === 0x40) { // BROWSE encoder (two's complement)
        const ticks = value < 64 ? value : value - 128;
        if (ticks) this.#t('library.browse')?.on(ticks);
        return true;
      }
      const map = { 0x1f: 'xfader', 0x0c: 'cue-mix', 0x17: 'A.filter', 0x18: 'B.filter' };
      const base = cc < 0x20 ? cc : cc - 0x20;
      if (!map[base] || (cc >= 0x40)) return false;
      const { v } = this.#fourteenBit(status, cc, value);
      this.#absolute(map[base], v);
      return true;
    }
    if (ch === 4 && cc === 0x02) { // BEAT FX LEVEL/DEPTH (7-bit)
      for (const id of this.#fxTargets()) this.#absolute(`${id}.fx-depth`, value / 127);
      return true;
    }
    return false;
  }

  // Outer ring: bend the tempo while playing (beatmatching), scrub while paused.
  #jogSide(id, ticks) {
    const deck = this.ctx.decks[id];
    if (!deck.loaded || !ticks) return;
    if (deck.playing) {
      deck.setBend(clamp(ticks * JOG_BEND, -0.3, 0.3));
      clearTimeout(this.jogTimers[id]);
      this.jogTimers[id] = setTimeout(() => { if (deck.bend) deck.setBend(0); }, JOG_DECAY_MS);
    } else {
      deck.seek(deck.position + ticks * JOG_SEEK);
    }
  }

  // Platter top: move the playhead like a record, also while the track is playing.
  // While playing, ticks are batched so the deck isn't re-seeked hundreds of times a second.
  #platter(id, ticks) {
    const deck = this.ctx.decks[id];
    if (!deck.loaded || !ticks) return;
    if (!deck.playing) {
      deck.seek(deck.position + ticks * JOG_SEEK);
      return;
    }
    this.scrub[id] += ticks;
    if (this.scrubTimers[id]) return;
    this.scrubTimers[id] = setTimeout(() => {
      this.scrubTimers[id] = null;
      const t = this.scrub[id];
      this.scrub[id] = 0;
      if (t && deck.loaded) deck.seek(deck.position + t * JOG_SEEK);
    }, SCRUB_MS);
  }

  #jogSearch(id, ticks) {
    const deck = this.ctx.decks[id];
    if (deck.loaded && ticks) deck.seek(deck.position + ticks * JOG_SEARCH);
  }

  // FX go to the channel(s) picked on the BEAT FX CH SELECT switch; with neither picked, both.
  #fxTargets() {
    const picked = DECKS.filter((id) => this.fxCh[id]);
    return picked.length ? picked : DECKS;
  }

  #fxToggle() {
    const { mixer } = this.ctx;
    const ids = this.#fxTargets();
    const on = !ids.some((id) => mixer.getFx(id).on);
    for (const id of ids) if (mixer.getFx(id).on !== on) $(`.mix-col[data-ch="${id}"] .fx-on`)?.click();
  }

  #fxCycleType() {
    for (const id of this.#fxTargets()) {
      const sel = $(`.mix-col[data-ch="${id}"] .fx-type`);
      if (!sel) continue;
      const next = FX_ORDER[(FX_ORDER.indexOf(sel.value) + 1) % FX_ORDER.length];
      sel.value = next;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  #fxBeats(step) {
    const knobs = window.spindeck?.knobs || {};
    for (const id of this.#fxTargets()) {
      const k = knobs[`${id}.fx-beats`];
      if (k) k.value = clamp(Math.round(k.value) + step, k.min, k.max);
    }
  }

  // ---------- lights ----------

  // Returns the [status, data1, value] messages whose state changed since the last call.
  lights() {
    const { decks, mixer, target } = this.ctx;
    const out = [];
    const set = (status, d1, on) => {
      const v = on === true ? 127 : on === false ? 0 : on;
      const k = (status << 8) | d1;
      if (this.ledCache.get(k) === v) return;
      this.ledCache.set(k, v);
      out.push([status, d1, v]);
    };
    DECKS.forEach((id, i) => {
      const deck = decks[id];
      const note = 0x90 | i;
      set(note, 0x0b, deck.playing);
      set(note, 0x0c, !!target(`${id}.cue`)?.led?.());
      set(note, 0x58, !!target(`${id}.sync`)?.led?.());
      set(note, 0x54, !!target(`${id}.pfl`)?.led?.());
      set(note, 0x10, deck.loaded);
      set(note, 0x11, deck.loaded);
      set(note, 0x4d, !!deck.loop);
      for (let p = 0; p < 8; p++) {
        const cue = deck.hotCues[p] != null;
        set(0x97 + i * 2, p, cue); // pads
        set(0x98 + i * 2, p, cue); // pads with SHIFT
        set(0x97 + i * 2, 0x60 + p, deck.loop?.beats === LOOP_PADS[p]);
      }
      // Level meter on the board: 0..127.
      set(0xb0 | i, 0x02, Math.round(peakLevel(mixer.channels[id].analyser) * 127));
    });
    set(0x94, 0x47, this.#fxTargets().some((id) => mixer.getFx(id).on));
    return out;
  }

  // Turn every light we've lit back off (on disconnect or when the profile is disabled).
  lightsOff() {
    const out = [];
    for (const [k, v] of this.ledCache) if (v) out.push([k >> 8, k & 0xff, 0]);
    this.ledCache.clear();
    return out;
  }

  keepalive() { return KEEPALIVE; }
}
