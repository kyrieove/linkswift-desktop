'use strict';

/**
 * Compare what the preload's isolated world sees with what the page's main world
 * sees, on a real share page.
 *
 *   npx electron tools/probe/probe-world.js <share-url>
 *
 * Writes %TEMP%\linkswift-world-report.json.
 */

const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const REPORT_PATH = path.join(os.tmpdir(), 'linkswift-world-report.json');
const target = process.argv.find((arg) => /^https?:\/\//.test(arg));

let report = null;
ipcMain.on('world-report', (_event, payload) => {
  report = payload;
});

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  if (!target) throw new Error('pass a share URL');

  const partition = 'persist:linkswift-world-probe';
  session.fromPartition(partition).registerPreloadScript({
    id: 'probe-world',
    type: 'frame',
    filePath: path.join(__dirname, 'probe-world-preload.js'),
  });

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { partition, contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });

  await win.loadURL(target).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 30000));

  const fromMain = await win.webContents
    .executeJavaScript(
      `JSON.stringify({
        href: location.href,
        plButton: document.querySelectorAll('.pl-button').length,
        plButtonMode: document.querySelectorAll('.pl-button-mode').length,
        xButtonBox: document.querySelectorAll('.x-button-box').length,
      })`,
    )
    .catch((error) => `threw: ${error.message}`);

  fs.writeFileSync(
    REPORT_PATH,
    JSON.stringify({ target, preloadView: report, mainWorldViaExecute: JSON.parse(fromMain) }, null, 2),
    'utf8',
  );
  app.exit(0);
});
