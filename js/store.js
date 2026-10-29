// Small promise-based IndexedDB wrapper for the saved library: tracks (tags, analysis, cues),
// user crates and stored folder handles. Every method degrades to a no-op when IndexedDB is
// unavailable (e.g. some private-browsing modes), so the app still works without persistence.

const DB_NAME = 'spindeck';
const DB_VERSION = 1;
const STORES = { tracks: 'id', crates: 'id', handles: 'id' };

// Fingerprint used as the track record key: stable across sessions for the same file.
export const fingerprint = (file) => `${file.name}|${file.size}|${file.lastModified}`;

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

export class Store {
  constructor(name = DB_NAME) {
    this.name = name;
    this.db = null;
    this.ready = this.#open().catch((err) => {
      console.warn('SpinDeck: saved library unavailable', err);
      return null;
    });
  }

  #open() {
    if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB not supported'));
    const open = indexedDB.open(this.name, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
      }
    };
    return req(open).then((db) => {
      db.onversionchange = () => db.close();
      this.db = db;
      return db;
    });
  }

  async #tx(store, mode, fn) {
    const db = await this.ready;
    if (!db) return undefined;
    const tx = db.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    const value = result instanceof IDBRequest ? req(result) : Promise.resolve(result);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
    return value;
  }

  get(store, key) { return this.#tx(store, 'readonly', (s) => s.get(key)); }
  getAll(store) { return this.#tx(store, 'readonly', (s) => s.getAll()).then((v) => v || []); }
  put(store, value) { return this.#tx(store, 'readwrite', (s) => s.put(value)); }
  delete(store, key) { return this.#tx(store, 'readwrite', (s) => s.delete(key)); }
  clear(store) { return this.#tx(store, 'readwrite', (s) => s.clear()); }

  // --- tracks ---
  async getTrack(id) { return decodeRecord(await this.get('tracks', id)); }
  async getAllTracks() { return (await this.getAll('tracks')).map(decodeRecord); }
  putTrack(rec) { return this.put('tracks', encodeRecord(rec)); }

  // Merge fields into an existing record (or create it).
  async updateTrack(id, fields) {
    const db = await this.ready;
    if (!db) return;
    await this.#tx('tracks', 'readwrite', (s) => {
      const r = s.get(id);
      r.onsuccess = () => s.put(encodeRecord({ ...decodeRecord(r.result), ...fields, id }));
    });
  }

  // --- crates: { id, name, trackIds } ---
  getCrates() { return this.getAll('crates'); }
  putCrate(crate) { return this.put('crates', { ...crate, trackIds: [...crate.trackIds] }); }
  deleteCrate(id) { return this.delete('crates', id); }

  // --- folder handles: { id, name, handle } ---
  getHandles() { return this.getAll('handles'); }
  putHandle(entry) { return this.put('handles', entry); }
  deleteHandle(id) { return this.delete('handles', id); }
}

// Waveform peaks are stored as 8-bit to keep records small (~80 KB for a 3-minute track
// instead of ~320 KB); they come back as Float32Array, as analyzeTrack produces them.
function encodeRecord(rec) {
  if (!rec?.analysis?.peaks) return rec;
  const peaks = rec.analysis.peaks.map((p) => {
    if (p instanceof Uint8Array) return p;
    const q = new Uint8Array(p.length);
    for (let i = 0; i < p.length; i++) q[i] = Math.round(Math.max(0, Math.min(1, p[i])) * 255);
    return q;
  });
  return { ...rec, analysis: { ...rec.analysis, peaks, peaksEncoding: 'u8' } };
}

function decodeRecord(rec) {
  if (!rec?.analysis || rec.analysis.peaksEncoding !== 'u8') return rec;
  const { peaksEncoding, ...analysis } = rec.analysis;
  analysis.peaks = analysis.peaks.map((q) => {
    const p = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) p[i] = q[i] / 255;
    return p;
  });
  return { ...rec, analysis };
}
