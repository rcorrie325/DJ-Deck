// Local track library: file import, tag reading and saved-library restore.
import { ANALYSIS_VERSION, parseKey } from './analysis.js';
import { fingerprint } from './store.js';

export const AUDIO_EXT = /\.(mp3|wav|flac|ogg|oga|m4a|aac|aif|aiff|opus|webm)$/i;
let nextId = 1;

// What gets saved per track (keyed by the file fingerprint).
export function trackRecord(t) {
  return {
    id: t.fp, title: t.title, artist: t.artist, album: t.album, duration: t.duration,
    bpm: t.bpm, tagKey: t.tagKey || null, analysis: t.analysis || null, cues: t.cues || null,
    addedAt: t.addedAt || Date.now(),
  };
}

// Musical key to show for a track: the detected key, else the file's key tag.
export const trackKey = (t) => t?.analysis?.key || t?.tagKey || null;

export const usableAnalysis = (a) => (a && a.version === ANALYSIS_VERSION && a.peaks ? a : null);

export class Library {
  constructor(store = null) {
    this.store = store;
    this.tracks = [];
    this.byId = new Map();
    this.byFp = new Map();
  }

  async addFiles(fileList, onProgress) {
    const files = Array.from(fileList).filter((f) => AUDIO_EXT.test(f.name) || f.type.startsWith('audio/'));
    const added = [];
    let done = 0;
    for (const file of files) {
      done++;
      const fp = fingerprint(file);
      if (this.byFp.has(fp) || this.tracks.some((t) => t.file.name === file.name && t.file.size === file.size)) continue;
      const saved = this.store ? await this.store.getTrack(fp).catch(() => null) : null;
      let track;
      if (saved) {
        // Known file: tags, duration, analysis and cues come back from the saved library.
        track = {
          id: 'local:' + nextId++, fp, file,
          title: saved.title, artist: saved.artist || '', album: saved.album || '', duration: saved.duration,
          bpm: saved.bpm || null, tagKey: saved.tagKey || null,
          analysis: usableAnalysis(saved.analysis), cues: saved.cues || null,
          addedAt: saved.addedAt, source: 'local',
        };
      } else {
        const tags = await readTags(file).catch(() => ({}));
        const fromName = parseFilename(file.name);
        track = {
          id: 'local:' + nextId++, fp, file,
          title: tags.title || fromName.title,
          artist: tags.artist || fromName.artist,
          album: tags.album || '',
          duration: await readDuration(file),
          bpm: tags.bpm || null,
          tagKey: parseKey(tags.key),
          analysis: null,
          cues: null,
          addedAt: Date.now(),
          source: 'local',
        };
        this.store?.putTrack(trackRecord(track)).catch((err) => console.warn('SpinDeck: could not save track', err));
      }
      this.tracks.push(track);
      this.byId.set(track.id, track);
      this.byFp.set(fp, track);
      added.push(track);
      onProgress?.(done, files.length);
    }
    return added;
  }
}

export function parseFilename(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/^\d{1,3}[\s.-]+/, '');
  const parts = base.split(/\s+-\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { artist: '', title: base.trim() };
}

function readDuration(file) {
  return new Promise((resolve) => {
    // Desktop-app files are read through their media URL; browser Files through a blob URL.
    const url = file.url || URL.createObjectURL(file);
    const a = new Audio();
    a.preload = 'metadata';
    const done = (d) => { if (!file.url) URL.revokeObjectURL(url); resolve(Number.isFinite(d) ? d : 0); };
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    a.src = url;
  });
}

// Minimal ID3v2.3/2.4 text-frame reader (title, artist, album, BPM, initial key).
async function readTags(file) {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {};
  const version = head[3];
  if (version < 3) return {};
  const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
  const buf = new Uint8Array(await file.slice(10, 10 + Math.min(size, 512 * 1024)).arrayBuffer());
  const out = {};
  const wanted = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TBPM: 'bpm', TKEY: 'key' };
  let pos = 0;
  if (head[5] & 0x40) {
    // Extended header.
    const ext = version === 4
      ? ((buf[0] & 0x7f) << 21) | ((buf[1] & 0x7f) << 14) | ((buf[2] & 0x7f) << 7) | (buf[3] & 0x7f)
      : ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) + 4;
    pos = ext;
  }
  while (pos + 10 < buf.length) {
    const id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsize = version === 4
      ? ((buf[pos + 4] & 0x7f) << 21) | ((buf[pos + 5] & 0x7f) << 14) | ((buf[pos + 6] & 0x7f) << 7) | (buf[pos + 7] & 0x7f)
      : (buf[pos + 4] << 24) | (buf[pos + 5] << 16) | (buf[pos + 6] << 8) | buf[pos + 7];
    if (fsize <= 0 || pos + 10 + fsize > buf.length) break;
    if (wanted[id]) {
      const body = buf.subarray(pos + 10, pos + 10 + fsize);
      const text = decodeId3Text(body);
      if (text) out[wanted[id]] = wanted[id] === 'bpm' ? parseFloat(text) || null : text;
    }
    pos += 10 + fsize;
  }
  return out;
}

function decodeId3Text(body) {
  const enc = body[0];
  const data = body.subarray(1);
  let text;
  if (enc === 0) text = new TextDecoder('latin1').decode(data);
  else if (enc === 1) text = new TextDecoder('utf-16').decode(data);
  else if (enc === 2) text = new TextDecoder('utf-16be').decode(data);
  else text = new TextDecoder('utf-8').decode(data);
  return text.replace(/\0+$/, '').split('\0')[0].trim();
}

// All audio files under a directory handle (File System Access API), recursively.
export async function filesFromDirectory(dir, out = []) {
  for await (const entry of dir.values()) {
    if (entry.kind === 'directory') await filesFromDirectory(entry, out);
    else if (AUDIO_EXT.test(entry.name)) out.push(await entry.getFile());
  }
  return out;
}
