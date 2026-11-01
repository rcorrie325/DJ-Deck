// Remembers the decks and mixer between launches: which songs are loaded, where they were,
// tempo, key lock, loops, knobs, faders and effects. Restored paused; never auto-plays.

const KEY = 'spindeck.session';
const SAVE_MS = 1000;
const $ = (sel) => document.querySelector(sel);

function readSaved() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}

function deckState(d) {
  if (!d.track?.fp) return null;
  return {
    fp: d.track.fp,
    title: d.track.title,
    pos: d.position,
    rate: d.rate,
    range: d.range,
    keylock: d.keylock,
    loop: d.loop ? { start: d.loop.start, end: d.loop.end, beats: d.loop.beats } : null,
  };
}

export function captureSession({ decks, mixer }) {
  const knobs = window.spindeck?.knobs || {};
  return {
    v: 1,
    decks: { A: deckState(decks.A), B: deckState(decks.B) },
    knobs: Object.fromEntries(Object.entries(knobs).map(([k, o]) => [k, o.value])),
    faders: { A: +$('#faderA').value, B: +$('#faderB').value },
    xfader: +$('#xfader').value,
    curve: $('#xfCurve').value,
    fx: { A: mixer.getFx('A'), B: mixer.getFx('B') },
  };
}

const setRange = (el, v) => {
  if (!el || !Number.isFinite(v)) return;
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

// loadToDeck(id, track) is the app's normal deck loader.
export function setupSession({ decks, mixer, library, loadToDeck, toast }) {
  let started = false;
  let last = '';

  function save() {
    if (!started) return; // never overwrite the saved session before it has been restored
    const json = JSON.stringify(captureSession({ decks, mixer }));
    if (json === last) return;
    last = json;
    try { localStorage.setItem(KEY, json); } catch { /* storage full or blocked */ }
  }

  function restoreMixer(s) {
    const knobs = window.spindeck?.knobs || {};
    for (const id of ['A', 'B']) {
      const fx = s.fx?.[id];
      const sel = $(`.mix-col[data-ch="${id}"] .fx-type`);
      if (fx && sel && sel.value !== fx.type) {
        sel.value = fx.type;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    for (const [k, v] of Object.entries(s.knobs || {})) if (knobs[k] && Number.isFinite(v)) knobs[k].value = v;
    setRange($('#faderA'), s.faders?.A);
    setRange($('#faderB'), s.faders?.B);
    setRange($('#xfader'), s.xfader);
    const curve = $('#xfCurve');
    if (s.curve && curve.value !== s.curve) {
      curve.value = s.curve;
      curve.dispatchEvent(new Event('change', { bubbles: true }));
    }
    for (const id of ['A', 'B']) {
      if (s.fx?.[id] && !!mixer.getFx(id).on !== !!s.fx[id].on) $(`.mix-col[data-ch="${id}"] .fx-on`)?.click();
    }
  }

  async function restoreDeck(id, st) {
    const track = library.byFp.get(st.fp);
    if (!track) return st.title || 'a song';
    const deck = decks[id];
    await loadToDeck(id, track);
    if (deck.track?.fp !== st.fp) return st.title;
    if (st.range) deck.range = st.range;
    if (Number.isFinite(st.rate)) deck.setRate(st.rate);
    if (!!st.keylock !== !!deck.keylock) deck.setKeylock(!!st.keylock);
    if (Number.isFinite(st.pos)) deck.seek(st.pos);
    if (st.loop) {
      deck.lastLoop = { ...st.loop };
      deck.reloop();
    }
    return null;
  }

  async function restore() {
    const s = readSaved();
    if (!s || s.v !== 1) return;
    try {
      restoreMixer(s);
      const missing = [];
      for (const id of ['A', 'B']) {
        if (!s.decks?.[id]) continue;
        const m = await restoreDeck(id, s.decks[id]);
        if (m) missing.push(m);
      }
      if (missing.length) toast(`Couldn't put back ${missing.map((t) => `“${t}”`).join(' and ')} — add the file again to use it.`, 6000);
    } catch (err) {
      console.warn('SpinDeck: could not restore the last session', err);
    }
  }

  function start() {
    if (started) return;
    started = true;
    last = JSON.stringify(captureSession({ decks, mixer }));
    setInterval(save, SAVE_MS);
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  }

  return { restore, start, save };
}
