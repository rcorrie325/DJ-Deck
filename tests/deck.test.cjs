// Deck engine: worklet position clock, seeking, key lock (WSOLA), manual loops, 8 hot cues.
const { generated, openApp, addFiles, loadDeck, assert, near } = require('./lib.cjs');

async function withDeck(browser, baseUrl) {
  const page = await openApp(browser, baseUrl);
  await addFiles(page, [generated.groove124()]);
  await loadDeck(page, 1, 'A');
  return page;
}

// Position advance vs. context time × rate, sampled in one go.
async function measureDrift(page, { rate, keylock, seconds = 3 }) {
  return page.evaluate(async ([rate, keylock, seconds]) => {
    const { ctx, decks } = window.spindeck;
    const d = decks.A;
    d.setKeylock(keylock);
    d.setRate(rate);
    d.seek(5);
    d.play();
    await new Promise((r) => setTimeout(r, 400));
    const p0 = d.position;
    const t0 = ctx.currentTime;
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const p1 = d.position;
    const t1 = ctx.currentTime;
    d.pause();
    return { moved: p1 - p0, expected: (t1 - t0) * rate };
  }, [rate, keylock, seconds]);
}

module.exports = {
  async 'position clock tracks elapsed time × rate (< 5 ms drift)'({ browser, baseUrl }) {
    const page = await withDeck(browser, baseUrl);
    for (const [rate, keylock] of [[1, false], [1.06, false], [0.94, true]]) {
      const r = await measureDrift(page, { rate, keylock });
      near(r.moved, r.expected, 0.005, `drift at rate ${rate}, keylock ${keylock}`);
    }
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async 'seek while playing never jumps back'({ browser, baseUrl }) {
    const page = await withDeck(browser, baseUrl);
    for (const keylock of [false, true]) {
      const r = await page.evaluate(async (keylock) => {
        const d = window.spindeck.decks.A;
        d.setKeylock(keylock);
        d.seek(2);
        d.play();
        await new Promise((res) => setTimeout(res, 500));
        d.seek(20);
        const samples = [];
        const t0 = performance.now();
        while (performance.now() - t0 < 600) {
          samples.push(d.position);
          await new Promise((res) => requestAnimationFrame(res));
        }
        d.pause();
        let back = 0;
        for (let i = 1; i < samples.length; i++) back = Math.max(back, samples[i - 1] - samples[i]);
        return { min: Math.min(...samples), back, last: samples.at(-1) };
      }, keylock);
      assert(r.min >= 19.995, `keylock ${keylock}: position fell to ${r.min} after seeking to 20`);
      assert(r.back < 0.005, `keylock ${keylock}: position stepped back by ${r.back}s`);
      assert(r.last > 20.3, `keylock ${keylock}: position should advance after the seek, got ${r.last}`);
    }
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async 'key lock keeps pitch while changing tempo (offline render)'({ browser, baseUrl }) {
    const page = await openApp(browser, baseUrl);
    const res = await page.evaluate(async () => {
      const { loadDeckWorklet } = await import('/js/deck.js');
      const sr = 44100;
      const src = new Float32Array(2 * sr);
      for (let i = 0; i < src.length; i++) src[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
      const render = async (keylock) => {
        const oc = new OfflineAudioContext(2, Math.round(2.2 * sr), sr);
        await loadDeckWorklet(oc);
        const node = new AudioWorkletNode(oc, 'spindeck-deck', {
          numberOfInputs: 0,
          outputChannelCount: [2],
          processorOptions: {
            commands: [
              { type: 'load', channels: [src, src], sampleRate: sr, seq: 1 },
              { type: 'keylock', on: keylock, seq: 2 },
              { type: 'rate', rate: 1.08, seq: 3 },
              { type: 'play', pos: 0, seq: 4 },
            ],
          },
        });
        node.connect(oc.destination);
        const d = (await oc.startRendering()).getChannelData(0);
        let last = d.length - 1;
        while (last > 0 && Math.abs(d[last]) < 1e-4) last--;
        // Upward zero crossings (interpolated) between 0.2 s and 1.6 s.
        const xs = [];
        for (let i = Math.round(0.2 * sr); i < 1.6 * sr; i++) {
          if (d[i - 1] < 0 && d[i] >= 0) xs.push(i - 1 + d[i - 1] / (d[i - 1] - d[i]));
        }
        const freq = ((xs.length - 1) * sr) / (xs.at(-1) - xs[0]);
        let peak = 0;
        for (let i = Math.round(0.2 * sr); i < 1.6 * sr; i++) peak = Math.max(peak, Math.abs(d[i]));
        return { freq, consumed: last / sr, peak };
      };
      return { on: await render(true), off: await render(false) };
    });
    console.log(`      keylock on: ${res.on.freq.toFixed(2)} Hz, ended after ${res.on.consumed.toFixed(3)} s;`
      + ` off: ${res.off.freq.toFixed(2)} Hz, ended after ${res.off.consumed.toFixed(3)} s`);
    near(res.on.freq, 440, 440 * 0.02, 'keylock on frequency');
    near(res.off.freq, 440 * 1.08, 475 * 0.02, 'keylock off frequency');
    near(res.on.consumed, 2 / 1.08, (2 / 1.08) * 0.02, 'keylock on: output length for 2 s of source');
    near(res.off.consumed, 2 / 1.08, (2 / 1.08) * 0.02, 'keylock off: output length for 2 s of source');
    assert(res.on.peak > 0.45 && res.on.peak < 0.55, `keylock on level should be ~0.5, got ${res.on.peak}`);
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async 'key lock button toggles and lights'({ browser, baseUrl }) {
    const page = await withDeck(browser, baseUrl);
    await page.click('#deckA .keylock');
    assert(await page.evaluate(() => window.spindeck.decks.A.keylock), 'keylock should be on');
    assert(await page.$eval('#deckA .keylock', (b) => b.classList.contains('on')), 'KEY button should be lit');
    await page.click('#deckA .keylock');
    assert(!(await page.evaluate(() => window.spindeck.decks.A.keylock)), 'keylock should be off');
    await page.close();
  },

  async 'manual loop in / out / halve / double / reloop'({ browser, baseUrl }) {
    const page = await withDeck(browser, baseUrl);
    const s = await page.evaluate(async () => {
      const d = window.spindeck.decks.A;
      const beat = (n) => d.firstBeat + n * d.beatLen;
      const out = {};
      d.seek(beat(10) + 0.01);
      document.querySelector('#deckA .loop-in').click();
      out.inPoint = d.loopInPoint;
      out.inLit = document.querySelector('#deckA .loop-in').classList.contains('on');
      d.seek(beat(14) - 0.02);
      document.querySelector('#deckA .loop-out').click();
      out.afterOut = { ...d.loop };
      document.querySelector('#deckA .loop-half').click();
      out.half = { ...d.loop };
      out.pad2 = document.querySelector('#deckA .loop[data-beats="2"]').classList.contains('on');
      document.querySelector('#deckA .loop-double').click();
      document.querySelector('#deckA .loop-double').click();
      out.double = { ...d.loop };
      document.querySelector('#deckA .reloop').click();
      out.exited = d.loop;
      d.seek(beat(30));
      document.querySelector('#deckA .reloop').click();
      out.reloop = { ...d.loop };
      out.reloopPos = d.position;
      // Play a 1-beat loop for longer than its length.
      d.halveLoop(); d.halveLoop(); d.halveLoop();
      out.oneBeat = { ...d.loop };
      d.play();
      await new Promise((r) => setTimeout(r, 1300));
      out.playPos = d.position;
      d.pause();
      out.beat = d.beatLen;
      out.b10 = beat(10);
      return out;
    });
    near(s.inPoint, s.b10, 1e-6, 'loop in snaps to beat 10');
    assert(s.inLit, 'IN should be lit while an in point is pending');
    near(s.afterOut.start, s.b10, 1e-6, 'loop start');
    near(s.afterOut.end, s.b10 + 4 * s.beat, 1e-6, 'loop out snaps to beat 14');
    assert(s.afterOut.beats === 4, `manual loop should read as 4 beats, got ${s.afterOut.beats}`);
    near(s.half.end - s.half.start, 2 * s.beat, 1e-6, 'halved loop length');
    assert(s.pad2, 'the 2-beat pad should light after halving');
    near(s.double.start, s.b10, 1e-6, 'doubled loop keeps its start');
    near(s.double.end - s.double.start, 8 * s.beat, 1e-6, 'doubled loop length');
    assert(s.exited === null, 'reloop while looping should exit the loop');
    near(s.reloop.end - s.reloop.start, 8 * s.beat, 1e-6, 'reloop restores the last loop');
    near(s.reloopPos, s.b10, 1e-6, 'reloop jumps to the loop start when outside');
    near(s.oneBeat.end - s.oneBeat.start, s.beat, 1e-6, '1-beat loop');
    assert(s.playPos >= s.oneBeat.start && s.playPos < s.oneBeat.end, `position ${s.playPos} should stay in the loop`);
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },

  async '8 hot cues: set, light, jump and restore from track.cues'({ browser, baseUrl }) {
    const page = await withDeck(browser, baseUrl);
    assert((await page.$$('#deckA .pad.hot')).length === 8, 'deck should have 8 hot cue pads');
    await page.evaluate(() => {
      const d = window.spindeck.decks.A;
      for (let i = 0; i < 8; i++) { d.seek(1 + i * 2); d.hotCue(i); }
      d.seek(40);
    });
    let s = await page.evaluate(() => window.spindeck.decks.A.hotCues);
    assert(s.length === 8 && s.every((t, i) => Math.abs(t - (1 + i * 2)) < 1e-6), `hot cues: ${s}`);
    const lit = await page.$$eval('#deckA .pad.hot.set', (b) => b.length);
    assert(lit === 8, `all 8 pads should be lit, got ${lit}`);
    await page.click('#deckA .hot[data-i="5"]');
    near(await page.evaluate(() => window.spindeck.decks.A.position), 11, 1e-6, 'jump to hot cue 6');
    await page.click('#deckA .hot[data-i="7"]', { modifiers: ['Shift'] });
    assert((await page.evaluate(() => window.spindeck.decks.A.hotCues[7])) === null, 'shift-click deletes hot cue 8');

    s = await page.evaluate(async () => {
      const d = window.spindeck.decks.A;
      const cues = { cuePoint: 3.5, hotCues: [null, 2, null, null, null, null, 9.25, null] };
      await d.load(d.buffer, { ...d.track, cues }, d.analysis);
      return { cue: d.cuePoint, hot: d.hotCues, pos: d.position };
    });
    near(s.cue, 3.5, 1e-9, 'restored cue point');
    assert(s.hot.length === 8 && s.hot[1] === 2 && s.hot[6] === 9.25 && s.hot[0] === null, `restored hot cues: ${s.hot}`);
    near(s.pos, 3.5, 1e-9, 'loads parked at the cue point');
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },
};
