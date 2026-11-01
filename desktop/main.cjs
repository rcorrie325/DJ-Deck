// SpinDeck desktop app (Electron main process).
// Serves the web app from app://spindeck/, reads the music you add straight from disk,
// remembers it between launches, and allows MIDI controllers without prompts.
const { app, BrowserWindow, protocol, ipcMain, dialog, Menu, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { Sources, mediaResponse, AUDIO_EXT } = require('./files.cjs');

const HOST = 'spindeck';
const ORIGIN = `app://${HOST}`;
const APP_ROOT = path.join(__dirname, '..');
const APP_FILES = /^\/(index\.html|styles\.css|js\/[\w./-]+\.js)$/; // the only app files served
const AUDIO_EXTENSIONS = AUDIO_EXT.source.match(/\(([^)]+)\)/)[1].split('|');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

// Tests can point the app at a throwaway profile.
if (process.env.SPINDECK_USER_DATA) app.setPath('userData', process.env.SPINDECK_USER_DATA);

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

let win = null;
let sources = null;
const pendingOpen = []; // files opened from Finder / the Dock before the window was ready

if (!app.requestSingleInstanceLock()) app.quit();

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// Finder "Open With", or songs dropped on the Dock icon.
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (win && sources) openPaths([p]);
  else pendingOpen.push(p);
});

async function openPaths(paths) {
  const entries = await sources.add(paths);
  if (entries.length) win?.webContents.send('open-entries', entries);
}

// ---------- serving the app and the music ----------

async function handleRequest(req) {
  const url = new URL(req.url);
  if (url.host !== HOST) return new Response('Not found', { status: 404 });
  if (url.pathname === '/__media') {
    const p = url.searchParams.get('path');
    if (!sources.isAllowed(p)) return new Response('Forbidden', { status: 403 });
    const r = await mediaResponse(p, req.headers.get('range'));
    return new Response(r.stream ? Readable.toWeb(r.stream) : null, { status: r.status, headers: r.headers });
  }
  const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  if (!APP_FILES.test(pathname) || pathname.includes('..')) return new Response('Not found', { status: 404 });
  try {
    const body = await fs.promises.readFile(path.join(APP_ROOT, pathname));
    return new Response(body, { headers: { 'Content-Type': TYPES[path.extname(pathname)] || 'application/octet-stream' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// ---------- window ----------

const stateFile = () => path.join(app.getPath('userData'), 'window.json');

function loadWindowState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  const state = { ...win.getNormalBounds(), maximized: win.isMaximized() };
  try { fs.writeFileSync(stateFile(), JSON.stringify(state)); } catch { /* not critical */ }
}

function createWindow() {
  const state = loadWindowState();
  win = new BrowserWindow({
    width: state.width || 1440,
    height: state.height || 900,
    x: state.x,
    y: state.y,
    minWidth: 900,
    minHeight: 600,
    title: 'SpinDeck',
    backgroundColor: '#0b0c10',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // keep audio and controller lights running when the window is in the background
    },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', saveWindowState);
  win.on('closed', () => { win = null; });

  // Stay on the app; open any web links in the default browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-finish-load', () => {
    if (pendingOpen.length) openPaths(pendingOpen.splice(0));
  });
  win.loadURL(`${ORIGIN}/index.html`);
}

// MIDI (controllers), MIDI sysex (DDJ-FLX4 keep-alive), output selection and microphone access
// (only used to show audio device names) are allowed for the app itself, nothing else.
const ALLOWED = new Set(['midi', 'midiSysex', 'speaker-selection', 'media']);
function permitted(origin, permission, details = {}) {
  if (!origin?.startsWith(ORIGIN) || !ALLOWED.has(permission)) return false;
  if (permission === 'media') {
    const types = details.mediaTypes || (details.mediaType ? [details.mediaType] : []);
    return types.every((t) => t === 'audio');
  }
  return true;
}

// ---------- menu ----------

function buildMenu() {
  const send = (action) => () => win?.webContents.send('menu', action);
  const template = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'Add Music Files…', accelerator: 'CmdOrCtrl+O', click: send('add-files') },
        { label: 'Add Music Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: send('add-folder') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC: library ----------

const audioFilter = [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }];

function registerIpc() {
  ipcMain.handle('library:pick-files', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Add music files', properties: ['openFile', 'multiSelections'], filters: audioFilter });
    return r.canceled ? [] : sources.add(r.filePaths);
  });
  ipcMain.handle('library:pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Add a music folder', properties: ['openDirectory', 'multiSelections'] });
    return r.canceled ? [] : sources.add(r.filePaths);
  });
  // Paths of files dropped onto the window (read from real File objects in the preload).
  ipcMain.handle('library:add-paths', (_e, paths) => (Array.isArray(paths) ? sources.add(paths.filter((p) => typeof p === 'string')) : []));
  ipcMain.handle('library:restore', () => sources.restore());
  ipcMain.handle('library:locate', async (_e, name) => {
    const r = await dialog.showOpenDialog(win, {
      title: name ? `Locate “${name}”` : 'Locate a song', properties: ['openFile'], filters: audioFilter,
    });
    if (r.canceled) return null;
    const [entry] = await sources.add(r.filePaths);
    return entry || null;
  });
}

// ---------- start ----------

app.whenReady().then(() => {
  sources = new Sources(path.join(app.getPath('userData'), 'library-sources.json')).load();
  protocol.handle('app', handleRequest);
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(permitted(details.requestingUrl || wc.getURL(), permission, details)));
  ses.setPermissionCheckHandler((_wc, permission, origin, details) => permitted(origin, permission, details));
  registerIpc();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
