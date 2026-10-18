'use strict';

const { app, BrowserWindow, ipcMain, Menu, session } = require('electron');
const path = require('node:path');

const { PUSH } = require('../shared/protocol');
const { Store } = require('./store');
const { UserscriptSource } = require('./userscript');
const { JobManager } = require('./job');
const { Aria2Daemon } = require('./aria2-daemon');
const { TaskStore } = require('./task-store');
const { loadVendor } = require('./vendor');
const { registerIpc } = require('./ipc');

/**
 * One persistent partition holds every netdisk login. Electron puts it under
 * app.getPath('userData'), which is %APPDATA%\linkswift-desktop on Windows, and
 * never next to the executable.
 */
const PARTITION = 'persist:linkswift';
const NETDISK_PRELOAD = path.join(__dirname, '..', 'preload', 'netdisk-preload.js');
const RENDERER_PRELOAD = path.join(__dirname, '..', 'preload', 'renderer-preload.js');

/** Visible product name. package.json keeps `name` so userData stays put. */
const PRODUCT_NAME = 'Unidownload';

/** The icon lives beside the source tree, or inside the asar's resources. */
function brandIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'brand', 'unidownload.ico')
    : path.join(__dirname, '..', '..', 'resources', 'brand', 'unidownload.ico');
}

/** @type {BrowserWindow | null} */
let uiWindow = null;
/** @type {JobManager} */
let jobs = null;
/** @type {Aria2Daemon} */
let daemon = null;
let quitting = false;

function createUiWindow() {
  uiWindow = new BrowserWindow({
    width: 900,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: PRODUCT_NAME,
    icon: brandIconPath(),
    backgroundColor: '#233c2e',
    show: true,
    webPreferences: {
      preload: RENDERER_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  uiWindow.show();
  uiWindow.focus();
  uiWindow.on('closed', () => {
    uiWindow = null;
  });
  uiWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

/**
 * @param {import('../shared/protocol').Job} job
 */
function pushJob(job) {
  if (uiWindow && !uiWindow.isDestroyed()) uiWindow.webContents.send(PUSH.jobEvent, job);
}

/** The bundled binary lives beside the source tree, or inside the asar's resources. */
function aria2BinaryPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'aria2', 'aria2c.exe')
    : path.join(__dirname, '..', '..', 'resources', 'aria2', 'aria2c.exe');
}

async function main() {
  // The UI carries its own navigation, so the native File/Edit/View/Window menu
  // bar would only take a row of the window and offer nothing the app lacks.
  // Renderer shortcuts (Ctrl+K, N, Esc) are handled in the page, not here.
  Menu.setApplicationMenu(null);

  const userDataDir = app.getPath('userData');
  const store = new Store(userDataDir);
  const userscript = new UserscriptSource({
    userDataDir,
    bundledPath: path.join(__dirname, '..', '..', 'resources', 'userscript.user.js'),
  });

  const { vendor, resources } = loadVendor(path.join(__dirname, '..', '..'));

  // Refresh without blocking the window. If it fails, the cache or the bundled
  // copy is already loaded, so the app still works offline.
  userscript.refresh();

  const netdiskSession = session.fromPartition(PARTITION);
  netdiskSession.registerPreloadScript({
    id: 'linkswift-netdisk',
    type: 'frame',
    filePath: NETDISK_PRELOAD,
  });

  daemon = new Aria2Daemon({ userDataDir, binaryPath: aria2BinaryPath() });
  const settings = store.getSettings();
  if (settings.aria2Mode !== 'external') {
    // Started before the window so the first paste already has somewhere to go,
    // and before restore() so old jobs can be reattached to it.
    await daemon.start({ dir: settings.aria2.dir });
  }

  jobs = new JobManager({
    store,
    userscript,
    vendor,
    resources,
    partition: PARTITION,
    preloadPath: NETDISK_PRELOAD,
    emit: pushJob,
    daemon,
    tasks: new TaskStore(userDataDir),
  });
  jobs.register(ipcMain);
  registerIpc(ipcMain, jobs);
  jobs.restore();
  createUiWindow();
}

app.whenReady().then(main);

app.on('window-all-closed', () => {
  app.quit();
});

/**
 * aria2 has to be told to stop, not killed: only a graceful shutdown makes it
 * write its session file, and that file is what resumes a half-finished
 * download on the next launch.
 */
app.on('before-quit', (event) => {
  if (quitting || !daemon) return;
  event.preventDefault();
  quitting = true;
  jobs?.shutdown();
  daemon
    .stop()
    .catch((error) => console.error(`[aria2] shutdown failed: ${error.message}`))
    .finally(() => app.quit());
});
