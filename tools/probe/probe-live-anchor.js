'use strict';

/**
 * Find where the userscript's own button should mount on a real share page.
 *
 *   npx electron tools/probe/probe-live-anchor.js <share-url>
 *
 * Writes %TEMP%\linkswift-live-anchor.json.
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
const REPORT_PATH = path.join(os.tmpdir(), 'linkswift-live-anchor.json');
const PRELOAD_PATH = path.join(ROOT, 'src', 'preload', 'netdisk-preload.js');
const target = process.argv.find((arg) => /^https?:\/\//.test(arg));

app.on('window-all-closed', () => {});

async function run() {
  if (!target) throw new Error('pass a share URL');

  await app.whenReady();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-anchor-'));
  const store = new Store(userDataDir);
  const userscript = new UserscriptSource({
    userDataDir,
    bundledPath: path.join(ROOT, 'resources', 'userscript.user.js'),
  });
  const { vendor, resources } = loadVendor(ROOT);

  const partition = 'persist:linkswift-anchor-probe';
  session.fromPartition(partition).registerPreloadScript({
    id: 'probe-anchor',
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

  // A share link that redirects aborts the first navigation, which Electron
  // reports as ERR_ABORTED even though the page loads.
  await win.loadURL(target).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 18000));

  const read = async (expression) => {
    try {
      return await win.webContents.executeJavaScript(expression);
    } catch (error) {
      return `ERROR: ${error.message}`;
    }
  };

  const report = {};

  // Each fragment of the selector the userscript's own config expects for this
  // provider, so the part that fails is visible.
  report.anchorFragments = await read(`JSON.stringify((() => {
    const list = [
      '.module-share-top-bar',
      '.x-button-box',
      '.g-dropdown-button',
      '.tools-more',
      '.module-share-top-bar .x-button-box',
      '.x-button-box .g-dropdown-button.tools-more',
      '.module-share-top-bar .x-button-box .g-dropdown-button.tools-more',
      '.wp-s-agile-tool-bar__header',
      '.g-dropdown-button',
      '[class*="dropdown-button"]',
      '[class*="top-bar"]',
      '[class*="tool-bar"]',
      '[class*="toolbar"]',
      '.share-btns',
    ];
    const out = {};
    for (const s of list) { try { out[s] = document.querySelectorAll(s).length; } catch (e) { out[s] = 'invalid'; } }
    return out;
  })())`);

  // Anything that looks like the share toolbar, so the real class names show.
  report.toolbarCandidates = await read(`JSON.stringify((() => {
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll('div[class], ul[class]')) {
      const cls = String(el.className);
      if (!/top-bar|tool-bar|toolbar|button-box|dropdown|operate|action/i.test(cls)) continue;
      if (seen.has(cls)) continue;
      seen.add(cls);
      out.push({
        tag: el.tagName,
        cls: cls.slice(0, 130),
        children: el.children.length,
        text: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 80),
      });
      if (out.length >= 25) break;
    }
    return out;
  })())`);

  // Where the userscript actually put its own button, if anywhere.
  report.injectedButton = await read(`JSON.stringify((() => {
    const el = document.querySelector('.pl-button, [class*="pl-button"]');
    if (!el) return 'no .pl-button anywhere';
    const parent = el.parentElement;
    return {
      cls: String(el.className),
      parentTag: parent ? parent.tagName : null,
      parentCls: parent ? String(parent.className).slice(0, 130) : null,
    };
  })())`);

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
}

run()
  .then(() => app.exit(0))
  .catch((error) => {
    fs.writeFileSync(REPORT_PATH, JSON.stringify({ fatal: String((error && error.stack) || error) }, null, 2), 'utf8');
    app.exit(1);
  });
