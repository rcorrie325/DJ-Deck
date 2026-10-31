// Web MIDI controller support: device handling, MIDI Learn, soft takeover, encoders, LED feedback.

import { DDJ_FLX4 } from './controllers/ddj-flx4.js';

const STORE = 'spindeck.midi.mappings';
const SETTINGS = 'spindeck.midi.settings';
const UNSUPPORTED = 'Controllers need Chrome or Edge (Web MIDI)';
const TAKEOVER = 0.04; // soft-takeover window (fraction of the control's range)
const LED_MS = 100;
const KEEPALIVE_MS = 200;
// Controllers with a built-in mapping that works as soon as they're plugged in.
const PROFILES = [DDJ_FLX4];

const $ = (sel) => document.querySelector(sel);
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
}
function save(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ }
}

// Compare port names loosely so "XYZ MIDI In" matches "XYZ MIDI Out".
const portName = (s = '') => s.toLowerCase().replace(/\b(in|out|input|output)\b/g, '').replace(/\s+/g, ' ').trim();

// Parse a raw MIDI message. Note-off and note-on velocity 0 share the note-on key.
export function parseMidi(data) {
  const [status, d1 = 0, d2 = 0] = data;
  if (status == null || status >= 0xf0) return null; // clock, active sensing, sysex…
  const kind = status & 0xf0;
  const ch = status & 0x0f;
  if (kind === 0x90 || kind === 0x80) {
    const pressed = kind === 0x90 && d2 > 0;
    return { type: 'note', key: `144:${ch}:${d1}`, ch, data1: d1, raw: pressed ? d2 : 0, value: pressed ? d2 / 127 : 0, pressed };
  }
  if (kind === 0xb0) return { type: 'cc', key: `176:${ch}:${d1}`, ch, data1: d1, raw: d2, value: d2 / 127, pressed: d2 > 0 };
  if (kind === 0xe0) {
    const raw = (d2 << 7) | d1;
    return { type: 'pb', key: `224:${ch}`, ch, data1: 0, raw, value: raw / 16383, pressed: true };
  }
  return null;
}

export const describeMsg = (m) => (m.type === 'note' ? `Note ${m.data1}` : m.type === 'cc' ? `CC ${m.data1}` : 'Pitch bend') + ` · ch ${m.ch + 1}`;

// Relative encoders: 64-centred (63 = -1, 65 = +1) or two's complement (127 = -1, 1 = +1).
const classifyRel = (v) => (v >= 33 && v <= 95 ? 'center' : 'twos');
const decodeRel = (v, mode) => (mode === 'center' ? v - 64 : v < 64 ? v : v - 128);

export class Midi {
  constructor({ targets, toast = () => {} }) {
    this.targets = targets;
    this.byId = new Map(targets.map((t) => [t.id, t]));
    this.toast = toast;
    this.access = null;
    this.mappings = load(STORE, {}); // { deviceName: { msgKey: { target, kind, type, ch, data1, led, mode? } } }
    this.settings = { led: true, builtin: true, invertTempo: false, ...load(SETTINGS, {}) };
    this.profiles = new Map(); // input port name -> { profile, inst } for boards with a built-in mapping
    this.keepaliveTimer = null;
    this.learning = false;
    this.learnTarget = null;
    this.state = new Map(); // runtime per-mapping state (soft takeover, encoder detection)
    this.ledCache = new Map();
    this.ledTimer = null;
    this.lastDevice = null;

    this.#buildBar();
    this.#bindUI();
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
      window.addEventListener(type, (e) => this.#onLearnEvent(e), true);
    }
    window.addEventListener('keydown', (e) => {
      if (!this.learning || e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (this.learnTarget) this.select(null);
      else this.setLearn(false);
    }, true);

    // Reconnect silently if the user already granted MIDI access.
    // Ask for sysex only if it was granted before, so no prompt appears on page load.
    const granted = (desc) => navigator.permissions?.query(desc).then((p) => p.state === 'granted').catch(() => false);
    Promise.all([granted({ name: 'midi', sysex: true }), granted({ name: 'midi' })]).then(([sx, plain]) => {
      if ((sx || plain) && navigator.requestMIDIAccess) this.connect({ sysex: !!sx });
    });
  }

  get supported() { return typeof navigator.requestMIDIAccess === 'function'; }

  get inputs() { return this.access ? [...this.access.inputs.values()].filter((p) => p.state !== 'disconnected') : []; }

  get outputs() { return this.access ? [...this.access.outputs.values()].filter((p) => p.state !== 'disconnected') : []; }

  // ---------- connection ----------

  // sysex lets SpinDeck send the keep-alive some boards (e.g. the DDJ-FLX4) expect; it's optional.
  async connect({ sysex = true } = {}) {
    if (!this.supported) {
      this.#setStatus(UNSUPPORTED);
      this.toast(UNSUPPORTED);
      return false;
    }
    if (!this.access) {
      try {
        this.access = await navigator.requestMIDIAccess({ sysex }).catch((err) => {
          if (!sysex) throw err;
          return navigator.requestMIDIAccess({ sysex: false });
        });
      } catch (err) {
        this.#setStatus(`MIDI access was blocked (${err.message || err.name}). Allow it in the site settings and try again.`);
        return false;
      }
      this.access.onstatechange = () => this.#refreshPorts();
    }
    this.#refreshPorts();
    clearInterval(this.ledTimer);
    this.ledTimer = setInterval(() => this.updateLeds(), LED_MS);
    return true;
  }

  #refreshPorts() {
    for (const input of this.inputs) {
      input.onmidimessage = (e) => this.handle(input.name, e.data);
    }
    this.#syncProfiles();
    this.ledCache.clear(); // resend LED state to newly plugged devices
    this.render();
  }

  // ---------- built-in controller mappings ----------

  #syncProfiles() {
    const names = new Set(this.inputs.map((p) => p.name));
    for (const [name, p] of this.profiles) {
      if (names.has(name) && this.settings.builtin) continue;
      this.#send(name, p.inst.lightsOff());
      this.profiles.delete(name);
    }
    if (this.settings.builtin) {
      for (const name of names) {
        if (this.profiles.has(name)) continue;
        const profile = PROFILES.find((pr) => pr.match(name));
        if (!profile) continue;
        const inst = profile.create({
          target: (id) => this.byId.get(id),
          decks: window.spindeck?.decks,
          mixer: window.spindeck?.mixer,
          toast: this.toast,
          settings: this.settings,
        });
        this.profiles.set(name, { profile, inst });
        this.toast(`${profile.name} connected — ready to play`);
      }
    }
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    if (this.access?.sysexEnabled && this.profiles.size) {
      const tick = () => { for (const [name, p] of this.profiles) this.#send(name, [p.inst.keepalive()]); };
      tick();
      this.keepaliveTimer = setInterval(tick, KEEPALIVE_MS);
    }
  }

  #send(device, messages) {
    if (!messages?.length) return;
    for (const o of this.#outputsFor(device)) {
      for (const m of messages) { try { o.send(m); } catch { /* port went away */ } }
    }
  }

  setBuiltin(on) {
    this.settings.builtin = !!on;
    save(SETTINGS, this.settings);
    if (this.access) this.#syncProfiles();
    this.render();
  }

  setInvertTempo(on) {
    this.settings.invertTempo = !!on;
    save(SETTINGS, this.settings);
  }

  // ---------- incoming messages ----------

  handle(device, data) {
    const msg = parseMidi(data);
    if (!msg) return;
    this.lastDevice = device;
    if (this.learnTarget) {
      if (msg.type === 'note' && !msg.pressed) return; // wait for a press
      this.#bind(device, msg);
      return;
    }
    const m = this.mappings[device]?.[msg.key];
    const t = m && this.byId.get(m.target);
    if (!t) {
      // No learned mapping for this control: fall back to the board's built-in mapping, if any.
      const p = this.profiles.get(device);
      if (p) {
        try { p.inst.handle(data); } catch (err) { console.warn(`${p.profile.name} mapping failed`, err); }
      }
      return;
    }
    const st = this.#state(device, msg.key);
    try {
      if (m.kind === 'button') t.on(msg.value, msg.pressed);
      else if (m.kind === 'absolute') this.#absolute(t, msg.value, st);
      else if (m.kind === 'relative') {
        const ticks = this.#relative(m, msg.raw, st);
        if (ticks) t.on(ticks);
      }
    } catch (err) {
      console.warn('MIDI target failed', t.id, err);
    }
  }

  #state(device, key) {
    const k = `${device}|${key}`;
    if (!this.state.has(k)) this.state.set(k, { picked: false, last: null, lastSet: null, votes: { center: 0, twos: 0 } });
    return this.state.get(k);
  }

  // Soft takeover: only follow the hardware once it reaches the on-screen value.
  #absolute(t, v, st) {
    const cur = t.get?.();
    if (cur == null || Number.isNaN(cur)) { t.on(v); return; }
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

  #relative(m, raw, st) {
    if (!m.mode) {
      st.votes[classifyRel(raw)]++;
      if (st.votes.center + st.votes.twos >= 3) {
        m.mode = st.votes.center >= st.votes.twos ? 'center' : 'twos';
        this.#save();
      }
    }
    return decodeRel(raw, m.mode || classifyRel(raw));
  }

  // ---------- learn ----------

  setLearn(on) {
    this.learning = !!on;
    this.learnTarget = null;
    document.body.classList.toggle('midi-learning', this.learning);
    if (this.learning) $('#midiDialog')?.open && $('#midiDialog').close();
    this.#marks();
    this.#learnStatus();
  }

  select(target) {
    this.learnTarget = target;
    this.#marks();
    this.#learnStatus();
  }

  #available(t) {
    if (t.available && !t.available()) return null;
    return document.querySelector(t.selector);
  }

  #targetAt(node) {
    const els = new Map();
    for (const t of this.targets) {
      const el = this.#available(t);
      if (el) els.set(el, t);
    }
    for (let n = node; n && n !== document.body; n = n.parentElement) {
      if (els.has(n)) return els.get(n);
    }
    return null;
  }

  #onLearnEvent(e) {
    if (!this.learning || !(e.target instanceof Element)) return;
    if (e.target.closest('.midi-learn-bar, dialog')) return;
    const t = this.#targetAt(e.target);
    if (!t) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'contextmenu' || (e.type === 'pointerdown' && e.button === 0 && e.shiftKey)) {
      const n = this.clearTarget(t.id);
      this.#learnStatus(n ? `Cleared mapping for ${t.label}.` : `${t.label} isn't mapped.`);
    } else if (e.type === 'pointerdown' && e.button === 0) {
      this.select(t);
    }
  }

  #bind(device, msg) {
    const t = this.learnTarget;
    let kind = null;
    if (t.type === 'button' && msg.type !== 'pb') kind = 'button';
    if (t.type === 'absolute' && msg.type !== 'note') kind = 'absolute';
    if (t.type === 'relative' && msg.type === 'cc') kind = 'relative';
    if (!kind) {
      const want = t.type === 'button' ? 'a button' : t.type === 'relative' ? 'a jog wheel or endless encoder' : 'a knob or fader';
      this.#learnStatus(`That was ${msg.type === 'note' ? 'a button' : 'a knob/fader'} — use ${want} for: ${t.label}`);
      return;
    }
    const maps = (this.mappings[device] ||= {});
    for (const [k, m] of Object.entries(maps)) if (m.target === t.id) delete maps[k];
    const m = { target: t.id, kind, type: msg.type, ch: msg.ch, data1: msg.data1, led: kind === 'button' && !!t.led };
    maps[msg.key] = m;
    const k = `${device}|${msg.key}`;
    this.state.delete(k);
    this.ledCache.delete(k);
    const st = this.#state(device, msg.key);
    if (kind === 'absolute') st.last = msg.value;
    if (kind === 'relative') st.votes[classifyRel(msg.raw)]++;
    this.#save();
    this.learnTarget = null;
    this.#marks();
    this.#learnStatus(`Mapped ${t.label} → ${describeMsg(msg)}. Click another control, or press Done.`);
    this.render();
  }

  clearTarget(id) {
    let n = 0;
    for (const maps of Object.values(this.mappings)) {
      for (const [k, m] of Object.entries(maps)) if (m.target === id) { delete maps[k]; n++; }
    }
    this.#save();
    this.#marks();
    this.render();
    return n;
  }

  clearAll() {
    this.#ledsOff();
    this.mappings = {};
    this.state.clear();
    this.#save();
    this.#marks();
    this.render();
  }

  #mappedIds() {
    const ids = new Set();
    for (const maps of Object.values(this.mappings)) for (const m of Object.values(maps)) ids.add(m.target);
    return ids;
  }

  #marks() {
    document.querySelectorAll('.midi-target, .midi-mapped, .midi-selected').forEach((el) => el.classList.remove('midi-target', 'midi-mapped', 'midi-selected'));
    if (!this.learning) return;
    const mapped = this.#mappedIds();
    for (const t of this.targets) {
      const el = this.#available(t);
      if (!el) continue;
      el.classList.add('midi-target');
      el.classList.toggle('midi-mapped', mapped.has(t.id));
      el.classList.toggle('midi-selected', this.learnTarget === t);
    }
  }

  #buildBar() {
    const bar = document.createElement('div');
    bar.className = 'midi-learn-bar';
    bar.hidden = true;
    bar.innerHTML = '<span class="midi-learn-text"></span><button type="button" class="btn small">Done</button>';
    bar.querySelector('button').addEventListener('click', () => this.setLearn(false));
    document.body.append(bar);
    this.bar = bar;
  }

  #learnStatus(msg) {
    this.bar.hidden = !this.learning;
    if (!this.learning) return;
    let text = msg || (this.learnTarget
      ? `Move a control on your controller for: ${this.learnTarget.label}`
      : 'MIDI Learn: click a control on screen, then move it on your controller. Right-click a mapped control to clear it.');
    if (!this.inputs.length) text += ' (No controller connected — open 🎛 and press Connect.)';
    this.bar.querySelector('.midi-learn-text').textContent = text;
  }

  // ---------- LED feedback ----------

  #outputsFor(device) {
    const n = portName(device);
    return this.outputs.filter((o) => portName(o.name) === n);
  }

  static ledBytes(m, on) {
    const v = on ? 127 : 0;
    if (m.type === 'note') return [0x90 | m.ch, m.data1, v];
    if (m.type === 'cc') return [0xb0 | m.ch, m.data1, v];
    return null;
  }

  updateLeds() {
    if (!this.settings.led || !this.access) return;
    for (const [name, p] of this.profiles) {
      try { this.#send(name, p.inst.lights()); } catch (err) { console.warn(`${p.profile.name} lights failed`, err); }
    }
    for (const [device, maps] of Object.entries(this.mappings)) {
      const outs = this.#outputsFor(device);
      if (!outs.length) continue;
      for (const [key, m] of Object.entries(maps)) {
        const t = this.byId.get(m.target);
        if (!m.led || !t?.led) continue;
        let on;
        try { on = !!t.led(); } catch { continue; }
        const ck = `${device}|${key}`;
        if (this.ledCache.get(ck) === on) continue;
        this.ledCache.set(ck, on);
        const bytes = Midi.ledBytes(m, on);
        if (bytes) outs.forEach((o) => { try { o.send(bytes); } catch { /* port went away */ } });
      }
    }
  }

  #ledsOff() {
    for (const [name, p] of this.profiles) this.#send(name, p.inst.lightsOff());
    for (const [device, maps] of Object.entries(this.mappings)) {
      const outs = this.#outputsFor(device);
      for (const [key, m] of Object.entries(maps)) {
        if (!this.ledCache.get(`${device}|${key}`)) continue;
        const bytes = Midi.ledBytes(m, false);
        if (bytes) outs.forEach((o) => { try { o.send(bytes); } catch { /* ignore */ } });
      }
    }
    this.ledCache.clear();
  }

  setLedEnabled(on) {
    if (!on) this.#ledsOff();
    this.settings.led = !!on;
    save(SETTINGS, this.settings);
    this.ledCache.clear();
  }

  // ---------- import / export ----------

  #save() { save(STORE, this.mappings); }

  exportJSON() {
    return JSON.stringify({ app: 'spindeck', kind: 'midi-mappings', version: 1, mappings: this.mappings }, null, 2);
  }

  importJSON(text) {
    const data = JSON.parse(text);
    const src = data?.mappings && typeof data.mappings === 'object' ? data.mappings : data;
    if (!src || typeof src !== 'object') throw new Error('Not a SpinDeck MIDI mapping file');
    let n = 0;
    for (const [device, maps] of Object.entries(src)) {
      if (!maps || typeof maps !== 'object') continue;
      for (const [key, m] of Object.entries(maps)) {
        if (!m || !this.byId.has(m.target) || !['button', 'absolute', 'relative'].includes(m.kind)) continue;
        if (!['note', 'cc', 'pb'].includes(m.type) || !/^(144|176):\d+:\d+$|^224:\d+$/.test(key)) continue;
        (this.mappings[device] ||= {})[key] = {
          target: m.target, kind: m.kind, type: m.type, ch: m.ch | 0, data1: m.data1 | 0, led: !!m.led,
          ...(m.mode === 'center' || m.mode === 'twos' ? { mode: m.mode } : {}),
        };
        n++;
      }
    }
    if (!n) throw new Error('No mappings found in that file');
    this.state.clear();
    this.ledCache.clear();
    this.#save();
    this.render();
    return n;
  }

  // ---------- dialog UI ----------

  #setStatus(text) {
    const el = $('#midiStatus');
    if (el) el.textContent = text;
  }

  #bindUI() {
    $('#midiBtn')?.addEventListener('click', () => { this.render(); $('#midiDialog').showModal(); });
    $('#midiConnect')?.addEventListener('click', () => this.connect());
    $('#midiLearn')?.addEventListener('click', () => this.setLearn(!this.learning));
    const builtin = $('#midiBuiltin');
    if (builtin) {
      builtin.checked = this.settings.builtin;
      builtin.addEventListener('change', () => this.setBuiltin(builtin.checked));
    }
    const inv = $('#midiInvertTempo');
    if (inv) {
      inv.checked = this.settings.invertTempo;
      inv.addEventListener('change', () => this.setInvertTempo(inv.checked));
    }
    const led = $('#midiLed');
    if (led) {
      led.checked = this.settings.led;
      led.addEventListener('change', () => this.setLedEnabled(led.checked));
    }
    $('#midiExport')?.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([this.exportJSON()], { type: 'application/json' }));
      const dev = Object.keys(this.mappings).length === 1 ? Object.keys(this.mappings)[0] : 'controllers';
      a.download = `spindeck-midi-${dev.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'mapping'}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    });
    $('#midiImport')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const n = this.importJSON(await file.text());
        this.toast(`Imported ${n} mapping${n === 1 ? '' : 's'}`);
      } catch (err) {
        this.toast(`Import failed: ${err.message}`);
      }
    });
    $('#midiClear')?.addEventListener('click', () => {
      const n = this.count;
      this.clearAll();
      this.toast(`Cleared ${n} mapping${n === 1 ? '' : 's'}`);
    });
    $('#midiMappings')?.addEventListener('click', (e) => {
      const row = e.target.closest('tr');
      if (!row) return;
      const maps = this.mappings[row.dataset.dev];
      const m = maps?.[row.dataset.key];
      if (!m) return;
      if (e.target.closest('.midi-del')) {
        delete maps[row.dataset.key];
        this.#save();
        this.#marks();
        this.render();
      } else if (e.target.matches('.midi-led')) {
        m.led = e.target.checked;
        this.ledCache.delete(`${row.dataset.dev}|${row.dataset.key}`);
        if (!m.led) {
          const bytes = Midi.ledBytes(m, false);
          if (bytes) this.#outputsFor(row.dataset.dev).forEach((o) => o.send(bytes));
        }
        this.#save();
      }
    });
  }

  get count() { return Object.values(this.mappings).reduce((n, maps) => n + Object.keys(maps).length, 0); }

  render() {
    const devs = $('#midiDevices');
    if (!devs) return;
    if (!this.supported) this.#setStatus(UNSUPPORTED);
    else if (!this.access) this.#setStatus('Plug in your controller, then press Connect.');
    else if (!this.inputs.length) this.#setStatus('No controllers found. Plug one in — it will show up here automatically.');
    else this.#setStatus(`Connected: ${this.inputs.length} MIDI input${this.inputs.length === 1 ? '' : 's'}.`);
    devs.innerHTML = this.inputs.map((p) => {
      const n = Object.keys(this.mappings[p.name] || {}).length;
      const builtin = this.profiles.get(p.name);
      const info = builtin
        ? `<span class="midi-builtin">✓ built-in ${esc(builtin.profile.name)} mapping</span>${n ? ` <span class="muted">+ ${n} of your own</span>` : ''}`
        : `<span class="muted">· ${n} mapping${n === 1 ? '' : 's'}</span>`;
      return `<li><span class="midi-dot"></span>${esc(p.name)} ${info}</li>`;
    }).join('');
    $('#midiConnect').textContent = this.access ? 'Rescan' : 'Connect controller';
    $('#midiLearn').classList.toggle('on', this.learning);
    $('#midiCount').textContent = this.count;
    const multi = Object.keys(this.mappings).length > 1;
    const rows = [];
    for (const [dev, maps] of Object.entries(this.mappings)) {
      for (const [key, m] of Object.entries(maps)) {
        const t = this.byId.get(m.target);
        const ledBox = t?.led && m.type !== 'pb'
          ? `<label class="midi-led-l" title="LED feedback"><input type="checkbox" class="midi-led" ${m.led ? 'checked' : ''}>LED</label>` : '';
        rows.push(`<tr data-dev="${esc(dev)}" data-key="${esc(key)}">
          <td>${esc(t?.label || m.target)}${multi ? `<div class="muted tiny">${esc(dev)}</div>` : ''}</td>
          <td class="muted">${describeMsg(m)}${m.kind === 'relative' ? ' (rel)' : ''}</td>
          <td>${ledBox}</td>
          <td><button type="button" class="btn tiny midi-del" title="Remove mapping">×</button></td></tr>`);
      }
    }
    $('#midiMappings').innerHTML = rows.join('') || '<tr><td class="muted">No mappings yet. Use MIDI Learn to add some.</td></tr>';
  }
}
