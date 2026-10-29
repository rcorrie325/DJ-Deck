// Mixer FX and headphone cue: rendered offline in the page, plus the mixer UI in the real app.
const { generated, openApp, addFiles, loadDeck, assert, near } = require('./lib.cjs');

// Installs window.mt: offline render helpers around the real Mixer module.
async function setupOffline(page) {
  await page.evaluate(async () => {
    const { Mixer } = await import('/js/mixer.js');
    const SR = 44100;
    let seed = 12345;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

    // Mono test signals, generated in JS so every render gets identical input.
    const signals = {
      noise(n) { seed = 12345; const d = new Float32Array(n); for (let i = 0; i < n; i++) d[i] = 0.15 * rand() + 0.1 * Math.sin((2 * Math.PI * 330 * i) / SR); return d; },
      click(n) { const d = new Float32Array(n); d[Math.round(0.1 * SR)] = 0.5; return d; },
      burst(n) { seed = 777; const d = new Float32Array(n); for (let i = 0; i < 0.2 * SR; i++) d[i] = 0.2 * rand(); return d; },
      sine440(n) { const d = new Float32Array(n); for (let i = 0; i < n; i++) d[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / SR); return d; },
      sine1000(n) { const d = new Float32Array(n); for (let i = 0; i < n; i++) d[i] = 0.2 * Math.sin((2 * Math.PI * 1000 * i) / SR); return d; },
    };

    // render({ seconds, channels, inputs: { A: 'noise' }, setup(mixer), at: [[time, fn(mixer)]] }) → Float32Array[]
    async function render({ seconds = 1, channels = 2, inputs = { A: 'noise' }, setup, at = [] }) {
      const n = Math.round(seconds * SR);
      const ctx = new OfflineAudioContext(channels, n, SR);
      const mixer = new Mixer(ctx);
      for (const [id, sig] of Object.entries(inputs)) {
        const buf = ctx.createBuffer(1, n, SR);
        buf.copyToChannel(signals[sig](n), 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(mixer.input(id));
        src.start(0);
      }
      setup?.(mixer, ctx);
      for (const [t, fn] of at) ctx.suspend(t).then(() => { fn(mixer, ctx); ctx.resume(); });
      const out = await ctx.startRendering();
      const res = [];
      for (let c = 0; c < out.numberOfChannels; c++) res.push(out.getChannelData(c));
      res.mixer = mixer;
      return res;
    }

    const span = (d, t0, t1) => d.subarray(Math.round(t0 * SR), Math.round(t1 * SR));
    const rms = (d) => { let s = 0; for (const v of d) s += v * v; return Math.sqrt(s / Math.max(1, d.length)); };
    const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
    const argmax = (d, from = 0, to = d.length) => { let k = from; for (let i = from; i < to; i++) if (Math.abs(d[i]) > Math.abs(d[k])) k = i; return k; };
    const tone = (d, hz) => {
      let s = 0; let c = 0;
      for (let i = 0; i < d.length; i++) { s += d[i] * Math.sin((2 * Math.PI * hz * i) / SR); c += d[i] * Math.cos((2 * Math.PI * hz * i) / SR); }
      return (2 / d.length) * Math.hypot(s, c);
    };
    window.mt = { SR, render, span, rms, maxDiff, argmax, tone };
  });
}

module.exports = {
  async 'FX off leaves the signal identical to the no-FX baseline'({ browser, baseUrl }) {
    const page = await openApp(browser, baseUrl);
    await setupOffline(page);
    const r = await page.evaluate(async () => {
      const { render, maxDiff, span, rms } = window.mt;
      const base = await render({ seconds: 1.2 });
      // Configured but never switched on.
      const configured = await render({ seconds: 1.2, setup: (m) => { m.setFx('A', { type: 'reverb', depth: 0.9, beats: 2 }); m.setFxBpm('A', 128); } });
      // Flanger switched on, then off again mid-render: after it settles the output must match again.
      const toggled = await render({
        seconds: 1.2,
        setup: (m) => m.setFx('A', { type: 'flanger', on: true, depth: 0.7 }),
        at: [[0.4, (m) => m.setFx('A', { on: false })]],
      });
      return {
        configured: maxDiff(base[0], configured[0]),
        during: maxDiff(span(base[0], 0.1, 0.39), span(toggled[0], 0.1, 0.39)),
        after: maxDiff(span(base[0], 0.6, 1.2), span(toggled[0], 0.6, 1.2)),
        level: rms(span(base[0], 0.1, 1.2)),
        fx: configured.mixer.getFx('A'),
      };
    });
    assert(r.level > 0.05, `baseline should carry signal, rms=${r.level}`);
    assert(r.configured < 1e-4, `FX configured but off should be transparent, max diff ${r.configured}`);
    assert(r.during > 0.01, `flanger on should change the signal, max diff ${r.during}`);
    assert(r.after < 1e-4, `after switching the flanger off the output should match the baseline, max diff ${r.after}`);
    assert(r.fx.type === 'reverb' && r.fx.on === false && r.fx.beats === 2, `partial setFx state: ${JSON.stringify(r.fx)}`);
    await page.close();
  },

  async 'echo repeats an impulse after beats × 60 / BPM'({ browser, baseUrl }) {
    const page = await openApp(browser, baseUrl);
    await setupOffline(page);
    for (const [bpm, beats] of [[120, 1], [128, 0.75], [124, 0.5]]) {
      const r = await page.evaluate(async ([bpm, beats]) => {
        const { render, argmax, SR } = window.mt;
        const out = await render({
          seconds: 1.5, inputs: { A: 'click' },
          setup: (m) => { m.setFxBpm('A', bpm); m.setFx('A', { type: 'echo', on: true, depth: 0.5, beats }); },
        });
        const d = out[0];
        const p0 = argmax(d, 0, Math.round(0.2 * SR));
        const p1 = argmax(d, p0 + Math.round(0.05 * SR));
        return { dt: (p1 - p0) / SR, a0: Math.abs(d[p0]), a1: Math.abs(d[p1]) };
      }, [bpm, beats]);
      near(r.dt, (beats * 60) / bpm, 0.002, `echo time at ${bpm} BPM, ${beats} beat(s)`);
      assert(r.a1 > 0.3 * r.a0, `echo should be audible: dry ${r.a0}, repeat ${r.a1}`);
    }
    await page.close();
  },

  async 'reverb adds a tail that keeps ringing after FX is switched off'({ browser, baseUrl }) {
    const page = await openApp(browser, baseUrl);
    await setupOffline(page);
    const r = await page.evaluate(async () => {
      const { render, rms, span } = window.mt;
      const tail = (out) => rms(span(out[0], 0.5, 1.5));
      const dry = await render({ seconds: 2, inputs: { A: 'burst' } });
      const wet = await render({ seconds: 2, inputs: { A: 'burst' }, setup: (m) => m.setFx('A', { type: 'reverb', on: true, depth: 0.6 }) });
      const off = await render({
        seconds: 2, inputs: { A: 'burst' },
        setup: (m) => m.setFx('A', { type: 'reverb', on: true, depth: 0.6 }),
        at: [[0.25, (m) => m.setFx('A', { on: false })]],
      });
      return { dry: tail(dry), wet: tail(wet), off: tail(off), burst: rms(span(dry[0], 0, 0.2)) };
    });
    assert(r.dry < 1e-5, `no reverb: silence after the burst, rms=${r.dry}`);
    assert(r.wet > 0.01 * r.burst, `reverb tail energy ${r.wet} (burst ${r.burst})`);
    assert(r.off > 0.5 * r.wet, `tail should ring out after switching off: ${r.off} vs ${r.wet}`);
    await page.close();
  },

  async 'flanger changes the signal'({ browser, baseUrl }) {
    const page = await openApp(browser, baseUrl);
    await setupOffline(page);
    const r = await page.evaluate(async () => {
      const { render, rms, span } = window.mt;
      const base = await render({ seconds: 1.5 });
      const fl = await render({ seconds: 1.5, setup: (m) => m.setFx('A', { type: 'flanger', on: true, depth: 0.6, beats: 0.5 }) });
      const a = span(base[0], 0.2, 1.5);
      const b = span(fl[0], 0.2, 1.5);
      const diff = new Float32Array(a.length).map((_, i) => a[i] - b[i]);
      return { diff: rms(diff), level: rms(a) };
    });
    assert(r.diff > 0.1 * r.level, `flanger should audibly change the signal: diff ${r.diff}, level ${r.level}`);
    await page.close();
  },

  async 'headphone cue goes to outputs 3/4 on a 4-channel device'({ browser, baseUrl }) {
    const page = await openApp(browser, baseUrl);
    await setupOffline(page);
    const r = await page.evaluate(async () => {
      const { render, span, tone } = window.mt;
      const levels = (out) => out.map((d) => ({ a: tone(span(d, 0.3, 1), 440), b: tone(span(d, 0.3, 1), 1000) }));
      // A (440 Hz) faded down but cued, B (1 kHz) on the master.
      const cued = await render({
        channels: 4, inputs: { A: 'sine440', B: 'sine1000' },
        setup: (m) => { m.setFader('A', 0); m.setCrossfader(0.5); m.setCue('A', true); m.setCueMix(0); m.setPhones(0.9); },
      });
      // Cue mix fully to master: phones carry the master instead of the cue.
      const masterInPhones = await render({
        channels: 4, inputs: { A: 'sine440', B: 'sine1000' },
        setup: (m) => { m.setFader('A', 0); m.setCue('A', true); m.setCueMix(1); m.setPhones(0.9); },
      });
      const stereo = await render({ channels: 2, inputs: { A: 'sine440' }, setup: (m) => m.setCue('A', true) });
      return {
        info4: cued.mixer.outputInfo(), info2: stereo.mixer.outputInfo(),
        cued: levels(cued), mp: levels(masterInPhones), rec: cued.mixer.recordDest,
      };
    });
    assert(r.info4.cueAvailable && r.info4.channels === 4, `4-ch output info: ${JSON.stringify(r.info4)}`);
    assert(!r.info2.cueAvailable, `stereo output should have no cue: ${JSON.stringify(r.info2)}`);
    const [m1, m2, p1, p2] = r.cued;
    for (const [name, ch] of [['out 1', m1], ['out 2', m2]]) {
      assert(ch.b > 0.05, `${name}: master (B) should be present, ${ch.b}`);
      assert(ch.a < 1e-3, `${name}: cued channel A must not leak into the master, ${ch.a}`);
    }
    for (const [name, ch] of [['out 3', p1], ['out 4', p2]]) {
      assert(ch.a > 0.05, `${name}: cued A should be in the headphones, ${ch.a}`);
      assert(ch.b < 1e-3, `${name}: with CUE MIX at cue, master should be out of the headphones, ${ch.b}`);
    }
    const [, , q1] = r.mp;
    assert(q1.b > 0.05 && q1.a < 1e-3, `CUE MIX at master: phones should carry the master only, ${JSON.stringify(q1)}`);
    assert(r.rec === null, 'recordDest is null on an OfflineAudioContext');
    await page.close();
  },

  async 'mixer UI: FX controls, cue buttons, knob registry, BPM hook'({ browser, baseUrl }) {
    const page = await openApp(browser, baseUrl);
    const keys = ['trim', 'high', 'mid', 'low', 'filter', 'fx-depth', 'fx-beats'];
    const expected = [...['A', 'B'].flatMap((id) => keys.map((k) => `${id}.${k}`)), 'master', 'cue-mix', 'phones'];
    const reg = await page.evaluate(() => Object.keys(window.spindeck.knobs || {}));
    for (const k of expected) assert(reg.includes(k), `knob ${k} should be registered (have ${reg})`);

    for (const id of ['A', 'B']) {
      const col = `.mix-col[data-ch="${id}"]`;
      const opts = await page.$$eval(`${col} .fx-type option`, (o) => o.map((x) => x.value));
      assert(opts.join() === 'echo,reverb,flanger', `FX types: ${opts}`);
      await page.selectOption(`${col} .fx-type`, 'flanger');
      await page.click(`${col} .fx-on`);
      let fx = await page.evaluate((i) => window.spindeck.mixer.getFx(i), id);
      assert(fx.on && fx.type === 'flanger', `FX should be on (flanger): ${JSON.stringify(fx)}`);
      assert(await page.$eval(`${col} .fx-on`, (b) => b.classList.contains('on')), 'FX button lit');
      assert((await page.textContent(`${col} [data-k="fx-beats"] .knob-label`)).startsWith('RATE'), 'flanger shows RATE');
      await page.click(`${col} .fx-on`);
      fx = await page.evaluate((i) => window.spindeck.mixer.getFx(i), id);
      assert(!fx.on, 'FX should toggle off');
    }

    // MIDI-style control through the registry.
    const fx = await page.evaluate(() => {
      const { knobs, mixer } = window.spindeck;
      knobs['A.fx-depth'].value = 0.9;
      knobs['A.fx-beats'].value = 4; // index → 4 beats
      knobs['B.fx-beats'].value = 0.2; // snaps to ½
      knobs['cue-mix'].value = 0.5;
      return { a: mixer.getFx('A'), b: mixer.getFx('B'), cueMix: mixer.cueMix };
    });
    near(fx.a.depth, 0.9, 1e-9, 'A depth via knob');
    assert(fx.a.beats === 4 && fx.b.beats === 0.5, `stepped beats: ${fx.a.beats}, ${fx.b.beats}`);
    near(fx.cueMix, 0.5, 1e-9, 'cue mix via knob');

    // Headless Chromium has a stereo output, so PFL is disabled with an explanation.
    const info = await page.evaluate(() => window.spindeck.mixer.outputInfo());
    const pfl = await page.$eval('.mix-col[data-ch="A"] .pfl', (b) => ({ disabled: b.disabled, title: b.title }));
    if (!info.cueAvailable) {
      assert(pfl.disabled && /4-channel/.test(pfl.title), `PFL should be disabled with a hint: ${JSON.stringify(pfl)}`);
    }
    await page.click('#settingsBtn');
    assert(await page.isVisible('#outputSelect'), 'Audio output select in Settings');
    assert(/channel output/.test(await page.textContent('#outputNote')), 'output note shown');
    await page.keyboard.press('Escape');

    // Loading a track updates the FX tempo.
    await addFiles(page, [generated.groove124()]);
    await loadDeck(page, 1, 'A');
    const bpm = await page.evaluate(() => window.spindeck.mixer.channels.A.fx.bpm);
    near(bpm, 124, 0.05, 'FX tempo follows deck A');
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },
};
