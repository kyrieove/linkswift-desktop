'use strict';

/**
 * Snapshot a share page at several moments while the driver runs, so a
 * late-rendering host and an early driver are not confused for each other.
 *
 *   npx electron tools/probe/probe-live-timeline.js <share-url>
 *
 * Writes %TEMP%\linkswift-live-timeline.json.
 */

const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { INTERNAL } = require('../../src/shared/protocol');
const { Store } = require('../../src/main/store');
const { UserscriptSource } = require('../../src/main/userscript');
const { JobManager } = require('../../src/main/job');
const { loadVendor } = require('../../src/main/vendor');

const ROOT = path.join(__dirname, '..', '..');
const REPORT_PATH = path.join(os.tmpdir(), 'linkswift-live-timeline.json');
const PRELOAD_PATH = path.join(ROOT, 'src', 'preload', 'netdisk-preload.js');
const target = process.argv.find((arg) => /^https?:\/\//.test(arg));

app.on('window-all-closed', () => {});

async function run() {
  if (!target) throw new Error('pass a share URL');

  await app.whenReady();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-timeline-'));
  const store = new Store(userDataDir);
  const userscript = new UserscriptSource({
    userDataDir,
    bundledPath: path.join(ROOT, 'resources', 'userscript.user.js'),
  });
  const { vendor, resources } = loadVendor(ROOT);

  const partition = 'persist:linkswift-timeline-probe';
  session.fromPartition(partition).registerPreloadScript({
    id: 'probe-timeline',
    type: 'frame',
    filePath: PRELOAD_PATH,
  });

  const jobs = new JobManager({
    store,
    userscript,
    vendor,
    resources,
    partition,
    preloadPath: PRELOAD_PATH,
    emit: () => {},
  });
  ipcMain.on(INTERNAL.observation, () => {});
  jobs.register(ipcMain);

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { partition, contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });

  const frames = [];
  const snapshot = async (label) => {
    const read = async (expression) => {
      try {
        return await win.webContents.executeJavaScript(expression);
      } catch (error) {
        return `ERROR: ${error.message}`;
      }
    };
    frames.push({
      label,
      href: await read('location.href'),
      readyState: await read('document.readyState'),
      xButtonBox: await read('document.querySelectorAll(".x-button-box").length'),
      plButton: await read('document.querySelectorAll(".pl-button").length'),
      aria2Mode: await read('document.querySelectorAll(\'.pl-button-mode[data-mode="aria2"]\').length'),
      swal: await read('document.querySelectorAll(".swal2-container").length'),
      text: await read('document.body ? document.body.innerText.replace(/\\s+/g, " ").slice(0, 260) : "no body"'),
    });
  };

  await win.loadURL(target).catch(() => {});
  for (const delay of [2000, 4000, 6000, 10000, 15000, 22000, 30000]) {
    await new Promise((resolve) => setTimeout(resolve, delay === 2000 ? 2000 : delay - frames[frames.length - 1].at));
    await snapshot(`t+${delay}ms`);
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify({ target, frames }, null, 2), 'utf8');
}

run()
  .then(() => app.exit(0))
  .catch((error) => {
    fs.writeFileSync(REPORT_PATH, JSON.stringify({ fatal: String((error && error.stack) || error) }, null, 2), 'utf8');
    app.exit(1);
  });
