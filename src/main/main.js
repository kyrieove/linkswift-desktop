'use strict';

const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');

const { INVOKE, PUSH } = require('../shared/protocol');
const { Store } = require('./store');
const { UserscriptSource } = require('./userscript');
const { JobManager } = require('./job');
const { loadVendor } = require('./vendor');
const aria2 = require('./aria2');

/**
 * One persistent partition holds every netdisk login. Electron puts it under
 * app.getPath('userData'), which is %APPDATA%\linkswift-desktop on Windows, and
 * never next to the executable.
 */
const PARTITION = 'persist:linkswift';
const NETDISK_PRELOAD = path.join(__dirname, '..', 'preload', 'netdisk-preload.js');
const RENDERER_PRELOAD = path.join(__dirname, '..', 'preload', 'renderer-preload.js');

/** @type {BrowserWindow | null} */
let uiWindow = null;
/** @type {JobManager} */
let jobs = null;

function createUiWindow() {
  uiWindow = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    title: 'LinkSwift Desktop',
    backgroundColor: '#1b1b1f',
    show: false,
    webPreferences: {
      preload: RENDERER_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  uiWindow.once('ready-to-show', () => uiWindow?.show());
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

function registerIpc() {
  ipcMain.handle(INVOKE.submit, (_event, rawLink) => jobs.submit(String(rawLink ?? '')));
  ipcMain.handle(INVOKE.cancel, (_event, jobId) => jobs.cancel(String(jobId)));
  ipcMain.handle(INVOKE.getSettings, () => jobs.store.getSettings());
  ipcMain.handle(INVOKE.setSettings, (_event, settings) => jobs.store.setSettings(settings ?? {}));
  ipcMain.handle(INVOKE.revealWindow, (_event, jobId) => jobs.reveal(String(jobId)));

  ipcMain.handle(INVOKE.testAria2, async (_event, config) => {
    const target = config ?? jobs.store.getSettings().aria2;
    try {
      const info = await aria2.getVersion(target);
      return { ok: true, message: `连上了，aria2 ${info.version}` };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
}

async function main() {
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

  jobs = new JobManager({
    store,
    userscript,
    vendor,
    resources,
    partition: PARTITION,
    preloadPath: NETDISK_PRELOAD,
    emit: pushJob,
  });
  jobs.register(ipcMain);
  registerIpc();
  createUiWindow();
}

app.whenReady().then(main);

app.on('window-all-closed', () => {
  app.quit();
});
