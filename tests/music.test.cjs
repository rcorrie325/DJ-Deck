// BPM and beat-grid checks on real (Creative Commons) music. Run tests/fetch-music.sh first.
const fs = require('fs');
const path = require('path');
const { MUSIC, openApp, assert } = require('./lib.cjs');

// Reference tempo from a line fit through librosa's beat times; reference first
// beat from an independent full-band spectral-flux grid search (see tests/README.md).
const TRACKS = [
  { file: 'Kevin_MacLeod_-_Vibe_Ace.hq.ogg', bpm: 130.03, phase: 0.008 },
  { file: 'admiralbob77_-_Choice_-_Drum-bass.hq.ogg', bpm: 136.19, phase: 0.434 },
  { file: '442789__lena-orsa__happy-music-pistachio-ice-cream-ragtime.hq.ogg', bpm: 144.05, phase: 0.068 },
  // Loose live recording: tempo only (librosa's own beats wobble ±150 ms here).
  { file: 'Karissa_Hobbs_-_Lets_Go_Fishin.hq.ogg', bpm: 117.3, phase: null },
];

const haveMusic = () => TRACKS.every((t) => fs.existsSync(path.join(MUSIC, t.file)));

module.exports = {
  async 'BPM and beat grid on real music'({ browser, baseUrl }) {
    if (!haveMusic()) return 'skip';
    const page = await openApp(browser, baseUrl);
    const failures = [];
    for (const t of TRACKS) {
      const a = await page.evaluate(async (url) => {
        const { analyzeTrack } = await import('/js/analysis.js');
        const buf = await window.spindeck.ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
        const r = await analyzeTrack(buf);
        return { bpm: r.bpm, firstBeat: r.firstBeat };
      }, `/tests/.music/${t.file}`);
      // Accept half/double time, within 1%.
      const ratio = [0.5, 1, 2].map((m) => a.bpm / (t.bpm * m)).find((r) => Math.abs(r - 1) < 0.01);
      if (!ratio) failures.push(`${t.file}: bpm ${a.bpm}, expected ~${t.bpm}`);
      if (t.phase != null && ratio) {
        const period = 60 / a.bpm;
        const diff = Math.abs(((a.firstBeat - t.phase) / period + 1.5) % 1 - 0.5) * period;
        if (diff > 0.025) failures.push(`${t.file}: first beat ${a.firstBeat.toFixed(3)}, expected ~${t.phase} (off by ${Math.round(diff * 1000)} ms)`);
      }
    }
    assert(failures.length === 0, failures.join('\n'));
    await page.close();
  },
};
