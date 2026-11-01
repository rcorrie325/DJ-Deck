// Bridge between the SpinDeck page and the desktop app. The page only gets these functions,
// never direct file-system access.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('spindeckDesktop', {
  platform: process.platform,
  pickFiles: () => ipcRenderer.invoke('library:pick-files'),
  pickFolder: () => ipcRenderer.invoke('library:pick-folder'),
  restoreLibrary: () => ipcRenderer.invoke('library:restore'),
  locate: (name) => ipcRenderer.invoke('library:locate', String(name || '')),
  // Files dropped onto the window: their real paths come from the File objects themselves,
  // so the page can't ask for arbitrary paths.
  addDroppedFiles: (files) => {
    const paths = Array.from(files || [], (f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } }).filter(Boolean);
    return paths.length ? ipcRenderer.invoke('library:add-paths', paths) : Promise.resolve([]);
  },
  mediaUrl: (p) => `app://spindeck/__media?path=${encodeURIComponent(p)}`,
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
  onOpenEntries: (cb) => ipcRenderer.on('open-entries', (_e, entries) => cb(entries)),
});
