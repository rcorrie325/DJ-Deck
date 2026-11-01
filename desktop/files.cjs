// File-system side of the desktop app: the list of songs and folders you've added,
// folder scanning, and serving audio with HTTP range support. No Electron imports,
// so it can be tested with plain Node.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const AUDIO_EXT = /\.(mp3|wav|flac|ogg|oga|m4a|aac|aif|aiff|opus|webm)$/i;
const MIME = {
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', aif: 'audio/aiff', aiff: 'audio/aiff', webm: 'audio/webm',
};
const MAX_FILES = 50000;

const mimeFor = (p) => MIME[path.extname(p).slice(1).toLowerCase()] || 'application/octet-stream';
const isAudio = (p) => AUDIO_EXT.test(p);

// { path, name, size, mtime } for an existing audio file, or null. mtime is whole milliseconds,
// like a browser File's lastModified, so saved fingerprints (name|size|mtime) stay comparable.
async function entryFor(p) {
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return null;
    return { path: p, name: path.basename(p), size: st.size, mtime: Math.floor(st.mtimeMs) };
  } catch {
    return null;
  }
}

// Every audio file under dir (hidden files/folders skipped, symlinked folders not followed).
async function scanFolder(dir) {
  const found = [];
  const stack = [dir];
  while (stack.length && found.length < MAX_FILES) {
    const cur = stack.pop();
    let items;
    try { items = await fsp.readdir(cur, { withFileTypes: true }); } catch { continue; }
    items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const it of items) {
      if (it.name.startsWith('.')) continue;
      const p = path.join(cur, it.name);
      if (it.isDirectory()) stack.push(p);
      else if ((it.isFile() || it.isSymbolicLink()) && isAudio(it.name)) found.push(p);
    }
  }
  const entries = await Promise.all(found.map(entryFor));
  return entries.filter(Boolean);
}

// The songs and folders you've added, saved to a JSON file between launches.
class Sources {
  constructor(file) {
    this.file = file;
    this.files = new Set();
    this.folders = new Set();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.files = new Set((data.files || []).map((p) => path.resolve(p)));
      this.folders = new Set((data.folders || []).map((p) => path.resolve(p)));
    } catch { /* first launch or unreadable: start empty */ }
    return this;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ files: [...this.files], folders: [...this.folders] }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // Inside a folder you've added, or a file you've added: the only paths the app may read.
  isAllowed(p) {
    if (typeof p !== 'string' || !p) return false;
    const r = path.resolve(p);
    if (this.files.has(r)) return true;
    for (const f of this.folders) if (r.startsWith(f + path.sep)) return true;
    return false;
  }

  // Add files and/or folders by path. Returns the audio entries now available from them.
  async add(paths) {
    const entries = [];
    for (const raw of paths) {
      const p = path.resolve(raw);
      let st;
      try { st = await fsp.stat(p); } catch { continue; }
      if (st.isDirectory()) {
        this.folders.add(p);
        entries.push(...await scanFolder(p));
      } else if (st.isFile() && isAudio(p)) {
        this.files.add(p);
        const e = await entryFor(p);
        if (e) entries.push(e);
      }
    }
    this.save();
    return dedupe(entries);
  }

  // Everything you've added, re-read from disk. Paths that no longer exist come back in `missing`.
  async restore() {
    const entries = [];
    const missing = [];
    for (const f of this.folders) {
      if (!fs.existsSync(f)) { missing.push(f); continue; }
      entries.push(...await scanFolder(f));
    }
    for (const p of this.files) {
      const e = await entryFor(p);
      if (e) entries.push(e);
      else missing.push(p);
    }
    return { entries: dedupe(entries), missing };
  }
}

function dedupe(entries) {
  const seen = new Set();
  return entries.filter((e) => (seen.has(e.path) ? false : seen.add(e.path)));
}

// Parses a "Range: bytes=a-b" header. Returns { start, end } (inclusive), null for no/ignored
// range, or 'unsatisfiable'.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') { // suffix range: last N bytes
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

// What to send back for a media request: status, headers and a file stream (or null body).
async function mediaResponse(p, rangeHeader) {
  let st;
  try { st = await fsp.stat(p); } catch { return { status: 404, headers: {}, stream: null }; }
  const size = st.size;
  const base = { 'Content-Type': mimeFor(p), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const range = parseRange(rangeHeader, size);
  if (range === 'unsatisfiable') return { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` }, stream: null };
  if (!range) return { status: 200, headers: { ...base, 'Content-Length': String(size) }, stream: fs.createReadStream(p) };
  return {
    status: 206,
    headers: { ...base, 'Content-Length': String(range.end - range.start + 1), 'Content-Range': `bytes ${range.start}-${range.end}/${size}` },
    stream: fs.createReadStream(p, { start: range.start, end: range.end }),
  };
}

module.exports = { AUDIO_EXT, mimeFor, isAudio, entryFor, scanFolder, Sources, parseRange, mediaResponse };
