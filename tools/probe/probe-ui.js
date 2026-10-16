'use strict';

/**
 * Drive the real renderer against the real preload and the real IPC handlers.
 *
 * probe-boot covers the page side. This covers the other half of the contract:
 * that the bridge the renderer actually calls exists, that the handlers behind it
 * work, and that a job event reaches the UI and renders.
 *
 *   npm run probe:ui
 *
 * The report is written to a file because stdout capture for a GUI subsystem
 * process is unreliable through a shell pipeline.
 */

const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PUSH } = require('../../src/shared/protocol');
const { Store } = require('../../src/main/store');
const { UserscriptSource } = require('../../src/main/userscript');
const { JobManager } = require('../../src/main/job');
const { loadVendor } = require('../../src/main/vendor');
const { registerIpc } = require('../../src/main/ipc');

const ROOT = path.join(__dirname, '..', '..');
const REPORT_PATH = path.join(os.tmpdir(), 'linkswift-ui-report.json');

/** Every method the renderer is allowed to assume exists. */
const BRIDGE_SURFACE = ['submit', 'cancel', 'getSettings', 'setSettings', 'revealWindow', 'testAria2', 'onJobEvent'];

const ARIA2_PROBE = {
  domain: 'http://localhost',
  port: '6800',
  path: '/jsonrpc',
  token: 'probe-secret',
  dir: '',
};

// Electron quits by default once every window closes.
app.on('window-all-closed', () => {});

async function run() {
  const report = {};
  const consoleMessages = [];

  await app.whenReady();

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-ui-probe-'));
  const store = new Store(userDataDir);
  const userscript = new UserscriptSource({
    userDataDir,
    bundledPath: path.join(ROOT, 'resources', 'userscript.user.js'),
  });
  const { vendor, resources } = loadVendor(ROOT);

  const partition = 'persist:linkswift-ui-probe';
  session.fromPartition(partition).registerPreloadScript({
    id: 'probe-netdisk',
    type: 'frame',
    filePath: path.join(ROOT, 'src', 'preload', 'netdisk-preload.js'),
  });

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 720,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'renderer-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (event) => {
    // The CSP warning is Electron telling us it is not packaged yet, not a defect.
    if (event.level === 'error') consoleMessages.push(`[console:error] ${String(event.message).slice(0, 220)}`);
  });

  // The same wiring the app uses, so the UI rendering path is exercised for real
  // rather than a no-op emit.
  const jobs = new JobManager({
    store,
    userscript,
    vendor,
    resources,
    partition,
    preloadPath: path.join(ROOT, 'src', 'preload', 'netdisk-preload.js'),
    emit: (job) => {
      if (!win.isDestroyed()) win.webContents.send(PUSH.jobEvent, job);
    },
  });
  jobs.register(ipcMain);
  registerIpc(ipcMain, jobs);

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const read = async (expression) => {
    try {
      return await win.webContents.executeJavaScript(expression);
    } catch (error) {
      return `ERROR: ${error.message}`;
    }
  };

  // 1. The bridge is present with exactly the surface the renderer assumes.
  report.bridge = await read(`JSON.stringify({
    present: Boolean(window.linkswift),
    keys: window.linkswift ? Object.keys(window.linkswift).sort() : [],
    missing: ${JSON.stringify(BRIDGE_SURFACE)}.filter((k) => typeof (window.linkswift || {})[k] !== 'function'),
  })`);

  // 2. With a real host present the preview mock must not install itself. The mock
  // seeds two demo jobs at load, so an empty list proves it stayed out.
  report.rowsAtLoad = await read('document.querySelectorAll("#job-list .job").length');
  report.emptyStateVisibleAtLoad = await read(
    '(function () { const n = document.getElementById("jobs-empty"); return n ? !n.hidden : "no-empty-node"; })()',
  );

  // Count events arriving over the bridge, to separate delivery from rendering.
  await read('window.__probeEventCount = 0; window.linkswift.onJobEvent(function () { window.__probeEventCount++; }); "armed"');

  // 3. Settings round-trip through the real handler and the real store.
  report.settingsRoundTrip = await read(`(async () => {
    const before = await window.linkswift.getSettings();
    const next = Object.assign({}, before, { delivery: 'clipboard', allowTransfer: true });
    next.aria2 = Object.assign({}, before.aria2, { port: '16800' });
    await window.linkswift.setSettings(next);
    const reread = await window.linkswift.getSettings();
    return JSON.stringify({
      delivery: reread.delivery,
      allowTransfer: reread.allowTransfer,
      port: reread.aria2.port,
      persisted: reread.delivery === 'clipboard' && reread.aria2.port === '16800',
    });
  })()`);

  // 4. The aria2 test button's backend, against whatever is listening.
  report.testAria2 = await read(
    `window.linkswift.testAria2(${JSON.stringify(ARIA2_PROBE)}).then((r) => JSON.stringify(r))`,
  );

  // 5. A bad link is rejected without creating a job.
  report.rejectsBadLink = await read(
    `window.linkswift.submit('not a link at all').then((r) => JSON.stringify(r))`,
  );
  report.rowsAfterBadLink = await read('document.querySelectorAll("#job-list .job").length');

  // 6. A good link creates a job, and the event must reach the UI and render.
  report.acceptsGoodLink = await read(
    `window.linkswift.submit('https://pan.quark.cn/s/0123456789ab').then((r) => JSON.stringify(r))`,
  );
  await new Promise((resolve) => setTimeout(resolve, 2500));

  report.eventsReceivedByRenderer = await read('window.__probeEventCount');
  report.rowsAfterGoodLink = await read('document.querySelectorAll("#job-list .job").length');
  report.jobsCountText = await read('(document.getElementById("jobs-count") || {}).textContent || ""');
  report.renderedRowText = await read(
    '(function () { const n = document.querySelector("#job-list .job"); return n ? n.textContent.slice(0, 60) : ""; })()',
  );
  report.emptyStateHiddenAfter = await read(
    '(function () { const n = document.getElementById("jobs-empty"); return n ? n.hidden : "no-empty-node"; })()',
  );

  // 7. Cancel reaches the handler and the row ends in a terminal phase.
  const created = JSON.parse(report.acceptsGoodLink || '{}');
  if (created.jobId) {
    report.cancelResult = await read(
      `window.linkswift.cancel(${JSON.stringify(created.jobId)}).then(() => 'resolved')`,
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    report.phaseAfterCancel = await read(
      '(document.querySelector("#job-list .job .chip") || {}).textContent || ""',
    );
  } else {
    report.cancelResult = 'no jobId to cancel';
  }

  report.consoleMessages = consoleMessages;

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
}

run()
  .then(() => app.exit(0))
  .catch((error) => {
    fs.writeFileSync(REPORT_PATH, JSON.stringify({ fatal: String((error && error.stack) || error) }, null, 2), 'utf8');
    app.exit(1);
  });
