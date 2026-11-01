// Desktop-app support. In the Mac app, window.spindeckDesktop (desktop/preload.cjs) gives the
// page access to the songs you've added; in a browser this module does nothing.

export const desktop = window.spindeckDesktop || null;

const MIME = {
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', aif: 'audio/aiff', aiff: 'audio/aiff', webm: 'audio/webm',
};

// A song on disk that behaves like a browser File for the rest of the app
// (name / size / lastModified / type, slice().arrayBuffer(), arrayBuffer()).
// Bytes are read on demand through the app's media URL, never all at import.
export class DiskFile {
  constructor(entry) {
    this.path = entry.path;
    this.name = entry.name;
    this.size = entry.size;
    this.lastModified = entry.mtime;
    this.type = MIME[this.name.split('.').pop().toLowerCase()] || '';
    this.url = desktop.mediaUrl(entry.path);
  }

  slice(start = 0, end = this.size) {
    start = Math.max(0, start);
    end = Math.min(this.size, end);
    return {
      arrayBuffer: async () => {
        if (end <= start) return new ArrayBuffer(0);
        const res = await fetch(this.url, { headers: { Range: `bytes=${start}-${end - 1}` } });
        if (!res.ok) throw new Error(`Couldn't read “${this.name}”`);
        const buf = await res.arrayBuffer();
        return res.status === 206 ? buf : buf.slice(start, end);
      },
    };
  }

  async arrayBuffer() {
    const res = await fetch(this.url);
    if (!res.ok) throw new Error(`Couldn't read “${this.name}” — it may have been moved or deleted`);
    return res.arrayBuffer();
  }
}

export const toDiskFiles = (entries) => (entries || []).map((e) => new DiskFile(e));
