// TextFold as an app: the same local server and the same reader, in one window.
//
// The packaged app carries its own Python (payload/python, from python-build-standalone) and the code (payload/app:
// textfold/, its web/ inside). It starts the server on a free port of 127.0.0.1, with the reader's papers kept in the app's data
// folder (TEXTFOLD_DATA), and points its window at it. Settings and keys stay where the server always keeps them,
// ~/.textfold. Pages on other sites open in the system browser, where the reader is already signed in.
// Run from the repository without a payload (`npm start`), it uses the python3 on the PATH (python on Windows) and the
// repository itself.
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const WIN = process.platform === 'win32';
const PAYLOAD = app.isPackaged ? path.join(process.resourcesPath, 'payload') : path.join(__dirname, 'payload');
const BUNDLED = WIN ? path.join(PAYLOAD, 'python', 'python.exe') : path.join(PAYLOAD, 'python', 'bin', 'python3');
const PACKED = fs.existsSync(BUNDLED);
const PYTHON = PACKED ? BUNDLED : WIN ? 'python' : 'python3';
const CODE = PACKED ? path.join(PAYLOAD, 'app') : path.join(__dirname, '..');

let server = null;
let win = null;

// the data folder (papers/, out/, server.log), the one `python3 -m textfold serve` keeps too (store.app_data()): on a Mac
// ~/Library/Application Support/TextFold, Electron's own; on Windows %LOCALAPPDATA%\TextFold, where Electron's is Roaming
// (TEXTFOLD_DATA, as for the server: another folder, for a test run)
app.setName('TextFold');
if (process.env.TEXTFOLD_DATA) app.setPath('userData', path.resolve(process.env.TEXTFOLD_DATA));
else if (WIN) app.setPath('userData', path.join(process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'), 'TextFold'));
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

// a free port from a quiet base, so a server run by hand on 3017 is never in the way
function freePort(start = 31917) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(freePort(start + 1)));
    probe.once('listening', () => probe.close(() => resolve(start)));
    probe.listen(start, '127.0.0.1');
  });
}

async function waitReady(port, tries = 160) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/models`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function startServer(port) {
  // A GUI app starts with a bare PATH: the usual install places are added so that the server finds node and npx
  // (the ChatGPT bridge) at once; on a Mac it also asks the login shell for the agents' places (textfold/agents.py).
  const home = app.getPath('home');
  const extra = WIN
    ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'), path.join(home, '.local', 'bin')]
    : ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin')];
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';   // Windows spells it Path
  const env = {
    ...process.env,
    [key]: [...extra, process.env[key] || (WIN ? '' : '/usr/bin:/bin')].filter(Boolean).join(path.delimiter),
    TEXTFOLD_DATA: app.getPath('userData'),
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  const log = fs.createWriteStream(path.join(app.getPath('userData'), 'server.log'), { flags: 'a' });
  // (windowsHide: no console window beside the app's own)
  server = spawn(PYTHON, ['-s', '-u', '-m', 'textfold', 'serve', '--port', String(port)], { cwd: CODE, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  server.on('exit', (code) => { server = null; if (code && win && !win.isDestroyed()) win.webContents.send?.('server-exit', code); });
}

async function open() {
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 720, minHeight: 520, show: true, title: 'TextFold',
    backgroundColor: '#FAF9F7', autoHideMenuBar: true,   // (Windows: the menu bar shows on Alt)
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'splash.html'));
  const local = (url) => /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(url);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (local(url) || url.startsWith('file:')) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  const port = await freePort();
  startServer(port);
  if (!(await waitReady(port))) {
    const where = path.join(app.getPath('userData'), 'server.log');
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<pre style="font:14px -apple-system,'Segoe UI',sans-serif;padding:24px;white-space:pre-wrap">TextFold could not start its server.\n\nThe log is in ${where}</pre>`)}`);
    return;
  }
  win.loadURL(`http://127.0.0.1:${port}/`);
}

ipcMain.handle('open-external', (_e, url) => (/^https?:/.test(url) ? shell.openExternal(url) : null));
// a file the reader saves (a page, its notes): where it goes, they choose in the system's own dialog; the path, or null
const KINDS = { html: 'Web page', md: 'Markdown', json: 'JSON' };
ipcMain.handle('save-file', async (e, name, data) => {
  const ext = path.extname(String(name)).slice(1).toLowerCase();
  if (!KINDS[ext]) return null;
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
    defaultPath: path.join(app.getPath('downloads'), path.basename(String(name))),
    filters: [{ name: KINDS[ext], extensions: [ext] }],
  });
  if (r.canceled || !r.filePath) return null;
  await fs.promises.writeFile(r.filePath, String(data), 'utf8');
  return r.filePath;
});

app.whenReady().then(open);
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (server) server.kill(); });
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) open(); });
