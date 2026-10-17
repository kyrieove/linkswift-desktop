'use strict';

/**
 * Paste the share text Baidu's own share dialog produces, then read what the
 * composer sends to the host.
 *
 *   npx electron tools/probe/probe-paste.js
 *
 * The fix has to survive real Chromium paste semantics, so this drives the real
 * input instead of assigning .value.
 */

const { app, BrowserWindow, clipboard, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PUSH } = require('../../src/shared/protocol');
const { Store } = require('../../src/main/store');
const { UserscriptSource } = require('../../src/main/userscript');
const { JobManager } = require('../../src/main/job');
const { loadVendor } = require('../../src/main/vendor');
const { registerIpc } = require('../../src/main/ipc');
const { parseShareLink } = require('../../src/shared/providers');

const ROOT = path.join(__dirname, '..', '..');
const REPORT_PATH = path.join(os.tmpdir(), 'linkswift-paste-report.json');

const SAMPLES = {
  // What Baidu's share dialog copies, the shape the user reported.
  blurb:
    '通过网盘分享的文件：支持v1.15.7.rar\n链接: https://pan.baidu.com/s/1LBO1Kp3yHPYVFxukMC7YFQ 提取码: c81v',
  // Link on its own line, passcode on the next.
  linkThenCode: 'https://pan.baidu.com/s/1LBO1Kp3yHPYVFxukMC7YFQ\n     提取码: c81v',
  // Quark's equivalent.
  quark: '我用夸克网盘分享了「B站@热心网友033-通用版V5.0.zip」\n链接：https://pan.quark.cn/s/32a5d87a6d67 提取码：c81v',
};

app.on('window-all-closed', () => {});

async function run() {
  await app.whenReady();
  const report = {};

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-paste-probe-'));
  const store = new Store(userDataDir);
  const userscript = new UserscriptSource({
    userDataDir,
    bundledPath: path.join(ROOT, 'resources', 'userscript.user.js'),
  });
  const { vendor, resources } = loadVendor(ROOT);

  const partition = 'persist:linkswift-paste-probe';
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

  const jobs = new JobManager({
    store,
    userscript,
    vendor,
    resources,
    partition,
    preloadPath: path.join(ROOT, 'src', 'preload', 'netdisk-preload.js'),
    emit: () => {},
  });
  jobs.register(ipcMain);
  registerIpc(ipcMain, jobs);

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 800));

  const read = async (expression) => {
    try {
      return await win.webContents.executeJavaScript(expression);
    } catch (error) {
      return `ERROR: ${error.message}`;
    }
  };

  win.focus();
  win.webContents.focus();

  report.samples = {};
  for (const [name, text] of Object.entries(SAMPLES)) {
    await read(`(function () {
      const input = document.getElementById('link-input');
      input.value = '';
      document.getElementById('composer-error').hidden = true;
      window.__sent = null;
      if (!window.__hooked) {
        window.__hooked = true;
        const real = window.linkswift.submit;
        window.linkswift.submit = function (raw) {
          window.__sent = raw;
          return Promise.resolve({ ok: false, message: 'probe stop' });
        };
      }
      return 'ready';
    })()`);

    clipboard.writeText(text);
    win.webContents.paste();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const inputValue = await read('document.getElementById("link-input").value');
    const submitted = await read(
      `(function () { document.getElementById('submit-form').requestSubmit(); return 'sent'; })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    const sent = await read('window.__sent');
    const error = await read(
      `(function () { const n = document.getElementById('composer-error'); return n.hidden ? '' : n.textContent; })()`,
    );
    report.samples[name] = {
      inputValue,
      submitted,
      sent,
      error,
      parsed: sent ? parseShareLink(sent) : null,
      sentAsUrl: sent ? new URL(sent).href : null,
    };
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
}

run()
  .then(() => app.exit(0))
  .catch((error) => {
    fs.writeFileSync(
      REPORT_PATH,
      JSON.stringify({ fatal: String((error && error.stack) || error) }, null, 2),
      'utf8',
    );
    app.exit(1);
  });
