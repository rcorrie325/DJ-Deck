// Desktop app file handling (desktop/files.cjs), tested directly in Node on a temporary music folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assert } = require('./lib.cjs');
const { Sources, scanFolder, parseRange, mediaResponse, entryFor } = require('../desktop/files.cjs');

function tempMusic() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spindeck-music-'));
  const write = (rel, bytes = 1000) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(bytes, rel.length));
    return p;
  };
  return { root, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const streamToBuffer = (s) => new Promise((res, rej) => {
  const chunks = [];
  s.on('data', (c) => chunks.push(c)).on('end', () => res(Buffer.concat(chunks))).on('error', rej);
});

module.exports = {
  async 'scans folders for audio, skipping hidden files and non-audio'() {
    const m = tempMusic();
    try {
      m.write('a.mp3');
      m.write('Sets/b.WAV');
      m.write('Sets/deep/c.flac');
      m.write('notes.txt');
      m.write('.hidden/d.mp3');
      m.write('Sets/.e.mp3');
      const names = (await scanFolder(m.root)).map((e) => path.relative(m.root, e.path)).sort();
      assert(JSON.stringify(names) === JSON.stringify(['Sets/b.WAV', 'Sets/deep/c.flac', 'a.mp3'].sort()), `found ${names}`);
      const e = await entryFor(path.join(m.root, 'a.mp3'));
      assert(e.size === 1000 && Number.isInteger(e.mtime) && e.name === 'a.mp3', `entry ${JSON.stringify(e)}`);
    } finally { m.cleanup(); }
  },

  async 'remembers added files and folders across launches; only they can be read'() {
    const m = tempMusic();
    const store = path.join(m.root, 'profile', 'library-sources.json');
    try {
      const single = m.write('Downloads/single.mp3');
      m.write('Music/one.mp3');
      m.write('Music/two.m4a');
      const secret = m.write('Private/secret.mp3');
      let s = new Sources(store).load();
      const added = await s.add([single, path.join(m.root, 'Music'), path.join(m.root, 'nope.mp3')]);
      assert(added.length === 3, `added ${added.length}`);

      // "Restart": a fresh Sources from the saved file.
      s = new Sources(store).load();
      const { entries, missing } = await s.restore();
      assert(entries.length === 3 && missing.length === 0, `restored ${entries.length}, missing ${missing}`);
      assert(s.isAllowed(single), 'added file is readable');
      assert(s.isAllowed(path.join(m.root, 'Music', 'one.mp3')), 'file inside an added folder is readable');
      assert(!s.isAllowed(secret), 'file outside what was added is not readable');
      assert(!s.isAllowed(path.join(m.root, 'Music', '..', 'Private', 'secret.mp3')), '.. tricks are rejected');
      assert(!s.isAllowed(path.join(m.root, 'Music-other', 'x.mp3')), 'sibling folder with the same prefix is rejected');
      assert(!s.isAllowed(''), 'empty path rejected');

      // A song moved away and a folder deleted show up as missing.
      fs.renameSync(single, path.join(m.root, 'moved.mp3'));
      fs.rmSync(path.join(m.root, 'Music'), { recursive: true });
      const after = await new Sources(store).load().restore();
      assert(after.entries.length === 0 && after.missing.length === 2, `after moving: ${JSON.stringify(after)}`);
    } finally { m.cleanup(); }
  },

  async 'parses HTTP ranges like a media server'() {
    const cases = [
      [null, 100, null], ['bytes=0-9', 100, { start: 0, end: 9 }], ['bytes=90-', 100, { start: 90, end: 99 }],
      ['bytes=-10', 100, { start: 90, end: 99 }], ['bytes=95-200', 100, { start: 95, end: 99 }],
      ['bytes=100-', 100, 'unsatisfiable'], ['bytes=5-2', 100, 'unsatisfiable'], ['items=0-1', 100, null],
    ];
    for (const [h, size, want] of cases) {
      const got = parseRange(h, size);
      assert(JSON.stringify(got) === JSON.stringify(want), `parseRange(${h}): ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
    }
  },

  async 'serves whole files and byte ranges (what seeking and tag reading use)'() {
    const m = tempMusic();
    try {
      const p = path.join(m.root, 'song.mp3');
      fs.writeFileSync(p, Buffer.from([...Array(256).keys()]));
      const full = await mediaResponse(p, null);
      assert(full.status === 200 && full.headers['Content-Length'] === '256' && full.headers['Content-Type'] === 'audio/mpeg', 'full response');
      assert((await streamToBuffer(full.stream)).length === 256, 'full body');
      const part = await mediaResponse(p, 'bytes=10-19');
      assert(part.status === 206 && part.headers['Content-Range'] === 'bytes 10-19/256', `range headers ${JSON.stringify(part.headers)}`);
      const body = await streamToBuffer(part.stream);
      assert(body.length === 10 && body[0] === 10 && body[9] === 19, 'range body');
      assert((await mediaResponse(p, 'bytes=500-')).status === 416, 'unsatisfiable range');
      assert((await mediaResponse(path.join(m.root, 'gone.mp3'), null)).status === 404, 'missing file');
    } finally { m.cleanup(); }
  },
};
