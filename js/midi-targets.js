// Registry of MIDI-mappable controls. Each target acts through the public deck/mixer APIs.
//
// target = { id, label, selector, type, on(value, pressed), get?(), led?(), available?() }
//   type 'button':   on(value 0..1, pressed bool)   — press and release are both delivered
//   type 'absolute': on(value 0..1)                 — get() returns the current value 0..1 (soft takeover)
//   type 'relative': on(ticks)                      — signed encoder ticks
//   led():           optional, returns the on/off state shown on the controller's LED

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const $ = (sel) => document.querySelector(sel);
const press = (fn) => (v, pressed) => { if (pressed) fn(); };

const HOT_CUES = 8;
const LOOP_BEATS = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
const JOG_SEEK = 0.02; // seconds per tick while paused
const JOG_BEND = 0.01; // playback-rate bend per tick while playing
const JOG_DECAY_MS = 80;

// An element "is on" if the app marks it so (class or aria-pressed).
const isOn = (el) => !!el && (el.classList.contains('on') || el.classList.contains('active') || el.getAttribute('aria-pressed') === 'true');

function setRange(input, v) {
  const min = +(input.min || 0);
  const max = +(input.max || 1);
  input.value = min + v * (max - min);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function getRange(input) {
  const min = +(input.min || 0);
  const max = +(input.max || 1);
  return (+input.value - min) / (max - min);
}

// Call the first deck method that exists, otherwise click the on-screen button.
function callOr(deck, names, sel) {
  for (const n of names) {
    if (typeof deck[n] === 'function') return deck[n]();
  }
  $(sel)?.click();
}

export function buildTargets({ decks, mixer, toast = () => {}, jogSensitivity = () => 1 }) {
  const knobs = () => window.spindeck?.knobs || {};
  const targets = [];
  const add = (t) => targets.push(t);

  for (const id of ['A', 'B']) {
    const deck = decks[id];
    const other = () => decks[id === 'A' ? 'B' : 'A'];
    const d = `#deck${id}`;
    const L = `Deck ${id}`;

    add({
      id: `${id}.play`, label: `${L} Play`, selector: `${d} .play`, type: 'button',
      on: press(() => (deck.previewingCue ? deck.releasePreview() : deck.toggle())),
      led: () => deck.playing,
    });
    add({
      id: `${id}.cue`, label: `${L} Cue`, selector: `${d} .cue`, type: 'button',
      on: (v, pressed) => (pressed ? deck.cueDown() : deck.cueUp()),
      led: () => deck.previewingCue || (deck.loaded && !deck.playing && Math.abs(deck.position - deck.cuePoint) < 0.01),
    });
    add({
      id: `${id}.sync`, label: `${L} Sync`, selector: `${d} .sync`, type: 'button',
      on: press(() => {
        if (!deck.bpm) return toast(`Deck ${id}: no BPM detected for this track`);
        if (!other().currentBpm) return toast('Load a track with a BPM on the other deck first');
        deck.syncTo(other());
      }),
      led: () => !!(deck.currentBpm && other().currentBpm && Math.abs(deck.currentBpm - other().currentBpm) < 0.05),
    });
    add({
      id: `${id}.keylock`, label: `${L} Key lock`, selector: `${d} .keylock`, type: 'button',
      on: press(() => {
        if (typeof deck.setKeylock === 'function') deck.setKeylock(!deck.keylock);
        else $(`${d} .keylock`)?.click();
      }),
      led: () => !!deck.keylock,
    });
    for (let i = 0; i < HOT_CUES; i++) {
      add({
        id: `${id}.hot${i + 1}`, label: `${L} Hot cue ${i + 1}`, selector: `${d} .hot[data-i="${i}"]`, type: 'button',
        on: press(() => deck.hotCue(i)),
        led: () => deck.hotCues?.[i] != null,
      });
    }
    for (const b of LOOP_BEATS) {
      const name = b === 0.25 ? '¼' : b === 0.5 ? '½' : b;
      add({
        id: `${id}.loop${b}`, label: `${L} ${name}-beat loop`, selector: `${d} .loop[data-beats="${b}"]`, type: 'button',
        on: press(() => deck.setLoop(b)),
        led: () => deck.loop?.beats === b,
      });
    }
    const loopActive = () => !!deck.loop;
    add({
      id: `${id}.loopIn`, label: `${L} Loop in`, selector: `${d} .loop-in`, type: 'button',
      on: press(() => callOr(deck, ['loopIn'], `${d} .loop-in`)), led: loopActive,
    });
    add({
      id: `${id}.loopOut`, label: `${L} Loop out`, selector: `${d} .loop-out`, type: 'button',
      on: press(() => callOr(deck, ['loopOut'], `${d} .loop-out`)), led: loopActive,
    });
    add({
      id: `${id}.reloop`, label: `${L} Reloop / exit`, selector: `${d} .reloop`, type: 'button',
      on: press(() => callOr(deck, ['reloop'], `${d} .reloop`)), led: loopActive,
    });
    add({
      id: `${id}.loopHalf`, label: `${L} Loop ½`, selector: `${d} .loop-half`, type: 'button',
      on: press(() => callOr(deck, ['loopHalf', 'loopHalve', 'halveLoop'], `${d} .loop-half`)),
    });
    add({
      id: `${id}.loopDouble`, label: `${L} Loop ×2`, selector: `${d} .loop-double`, type: 'button',
      on: press(() => callOr(deck, ['loopDouble', 'doubleLoop'], `${d} .loop-double`)),
    });
    add({
      id: `${id}.nudgeDown`, label: `${L} Nudge −`, selector: `${d} .bend-dn`, type: 'button',
      on: (v, pressed) => deck.setBend(pressed ? -0.04 : 0),
    });
    add({
      id: `${id}.nudgeUp`, label: `${L} Nudge +`, selector: `${d} .bend-up`, type: 'button',
      on: (v, pressed) => deck.setBend(pressed ? 0.04 : 0),
    });
    add({
      id: `${id}.pitch`, label: `${L} Tempo fader`, selector: `${d} .pitch-fader`, type: 'absolute',
      on: (v) => {
        const p = clamp(v * 2 - 1, -1, 1);
        deck.setPitch(Math.abs(p) < 0.004 ? 0 : p);
        const input = $(`${d} .pitch-fader`);
        if (input) input.value = deck.pitch;
      },
      get: () => clamp((deck.pitch + 1) / 2, 0, 1),
    });
    let jogTimer = null;
    add({
      id: `${id}.jog`, label: `${L} Jog wheel`, selector: `${d} .platter-disc`, type: 'relative',
      on: (ticks) => {
        if (!deck.loaded) return;
        const sens = jogSensitivity();
        if (deck.playing) {
          deck.setBend(clamp(ticks * JOG_BEND * sens, -0.3, 0.3));
          clearTimeout(jogTimer);
          jogTimer = setTimeout(() => { if (deck.bend) deck.setBend(0); }, JOG_DECAY_MS);
        } else {
          deck.seek(deck.position + ticks * JOG_SEEK * sens);
        }
      },
    });
    add({
      id: `${id}.load`, label: `${L} Load selected track`, selector: `${d} .deck-info`, type: 'button',
      on: press(() => {
        const row = $('#trackBody tr.midi-sel') || $('#trackBody tr');
        row?.querySelector(`button[data-act="${id}"]`)?.click();
      }),
    });
  }

  // Mixer knobs, via the knob registry (window.spindeck.knobs).
  const knobNames = { trim: 'Gain', high: 'EQ high', mid: 'EQ mid', low: 'EQ low', filter: 'Filter', 'fx-depth': 'FX depth', 'fx-beats': 'FX beats' };
  const knobTarget = (kid, label, selector) => ({
    id: kid, label, selector, type: 'absolute',
    available: () => !!knobs()[kid],
    on: (v) => {
      const k = knobs()[kid];
      if (k) k.value = k.min + v * (k.max - k.min);
    },
    get: () => {
      const k = knobs()[kid];
      return k ? (k.value - k.min) / (k.max - k.min) : 0;
    },
  });
  for (const ch of ['A', 'B']) {
    for (const [k, name] of Object.entries(knobNames)) {
      add(knobTarget(`${ch}.${k}`, `Channel ${ch} ${name}`, `.mix-col[data-ch="${ch}"] [data-k="${k}"]`));
    }
    const fsel = `#fader${ch}`;
    add({
      id: `${ch}.fader`, label: `Channel ${ch} fader`, selector: fsel, type: 'absolute',
      on: (v) => { const el = $(fsel); if (el) setRange(el, v); },
      get: () => { const el = $(fsel); return el ? getRange(el) : 0; },
    });
    const pfl = `.mix-col[data-ch="${ch}"] .pfl`;
    add({
      id: `${ch}.pfl`, label: `Channel ${ch} headphone cue`, selector: pfl, type: 'button',
      on: press(() => $(pfl)?.click()),
      led: () => (typeof mixer?.pfl === 'object' && mixer.pfl ? !!mixer.pfl[ch] : isOn($(pfl))),
    });
    const fx = `.mix-col[data-ch="${ch}"] .fx-on`;
    add({
      id: `${ch}.fxOn`, label: `Channel ${ch} FX on`, selector: fx, type: 'button',
      on: press(() => $(fx)?.click()),
      led: () => isOn($(fx)),
    });
  }
  add(knobTarget('master', 'Master volume', '.master-col [data-k="master"]'));
  add(knobTarget('cue-mix', 'Headphone cue/master mix', '[data-k="cue-mix"]'));
  add(knobTarget('phones', 'Headphone volume', '[data-k="phones"]'));
  add({
    id: 'xfader', label: 'Crossfader', selector: '#xfader', type: 'absolute',
    on: (v) => { const el = $('#xfader'); if (el) setRange(el, v); },
    get: () => { const el = $('#xfader'); return el ? getRange(el) : 0.5; },
  });

  // Library browse: an encoder moves the highlighted row; "Load selected" on each deck loads it.
  add({
    id: 'library.browse', label: 'Library browse', selector: '#dropZone', type: 'relative',
    on: (ticks) => {
      const rows = [...document.querySelectorAll('#trackBody tr')];
      if (!rows.length) return;
      const cur = rows.findIndex((r) => r.classList.contains('midi-sel'));
      const next = clamp((cur < 0 ? -1 : cur) + Math.sign(ticks) * Math.max(1, Math.round(Math.abs(ticks) / 2)), 0, rows.length - 1);
      rows.forEach((r, i) => r.classList.toggle('midi-sel', i === next));
      rows[next].scrollIntoView({ block: 'nearest' });
    },
  });

  return targets;
}
