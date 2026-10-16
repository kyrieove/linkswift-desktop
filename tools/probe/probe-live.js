'use strict';

/**
 * Load a real share page in the app's own hidden window and report what is
 * actually there.
 *
 * This is the step that cannot be faked: the local fixture has no React state and
 * no real markup, so the driver's selectors can only be settled against a live
 * page.
 *
 *   npx electron tools/probe/probe-live.js <share-url>            # survey only
 *   npx electron tools/probe/probe-live.js <share-url> --drive     # survey, then drive
 *
 * Survey mode uses a plain window with the real preload and never submits a job,
 * so the app's own driver does not run and the window stays alive to be read.
 * Drive mode goes through the real JobManager, driver included.
 *
 * The report goes to %TEMP%\linkswift-live-report.json.
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
const REPORT_PATH = path.join(os.tmpdir(), 'linkswift-live-report.json');
const PRELOAD_PATH = path.join(ROOT, 'src', 'preload', 'netdisk-preload.js');

const target = process.argv.find((arg) => /^https?:\/\//.test(arg));
const shouldDrive = process.argv.includes('--drive');

// Electron quits by default once every window closes.
app.on('window-all-closed', () => {});

/** @type {any[]} */
const observations = [];

const SELECTORS = [
  '.share-btns',
  '.pl-button',
  '.pl-button-init',
  '.pl-button-mode',
  '.pl-button-mode[data-mode="aria2"]',
  '.file-list',
  '.file-list [class*="checkbox"]',
  '.file-list input[type=checkbox]',
  '[class*="ant-checkbox"]',
  'input[type=checkbox]',
  '.ant-table-row',
  '.ant-table-tbody tr',
  '[class*="file-list"] [class*="row"]',
  '.share-password',
  'input[placeholder*="密码"]',
  'input[placeholder*="提取码"]',
  '.ant-input',
  '.swal2-container',
];

/** @param {import('electron').WebContents} contents */
async function survey(contents) {
  const read = async (expression) => {
    try {
      return await contents.executeJavaScript(expression);
    } catch (error) {
      return `ERROR: ${error.message}`;
    }
  };

  return {
    page: {
      href: await read('location.href'),
      title: await read('document.title'),
      readyState: await read('document.readyState'),
      bodyTextHead: await read('document.body ? document.body.innerText.replace(/\\s+/g, " ").slice(0, 400) : "no body"'),
    },
    anchorCounts: await read(
      `JSON.stringify((() => { const o = {}; for (const s of ${JSON.stringify(SELECTORS)}) o[s] = document.querySelectorAll(s).length; return o; })())`,
    ),
    // Everything with a class that looks like a list row, so the real markup shows.
    listCandidates: await read(`JSON.stringify((() => {
      const out = [];
      for (const el of document.querySelectorAll('[class*="file-list"], [class*="filelist"], [class*="table"], [class*="list"]')) {
        if (out.length >= 6) break;
        const cls = String(el.className).slice(0, 120);
        const rows = el.querySelectorAll('input[type=checkbox]').length;
        out.push({ tag: el.tagName, cls, children: el.children.length, checkboxes: rows, text: el.innerText ? el.innerText.replace(/\\s+/g, ' ').slice(0, 120) : '' });
      }
      return out;
    })())`),
    fileListHtml: await read(`JSON.stringify((() => {
      const list = document.querySelector('.file-list');
      return list ? list.outerHTML.slice(0, 3000) : 'no .file-list';
    })())`),
    swalText: await read(
      'JSON.stringify(Array.from(document.querySelectorAll(".swal2-title, .swal2-html-container")).map((n) => n.textContent.trim()).filter(Boolean))',
    ),
    reactSelection: await read(`JSON.stringify((() => {
      const el = document.querySelector('.file-list');
      if (!el) return 'no .file-list';
      let node = el;
      let depth = 0;
      while (node && depth < 40) {
        const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        if (key) {
          const fiber = node[key];
          const props = (fiber.memoizedProps && Object.keys(fiber.memoizedProps).length ? fiber.memoizedProps : null)
            || (fiber.return && fiber.return.memoizedProps) || null;
          if (props) {
            return {
              depth,
              propKeys: Object.keys(props).slice(0, 30),
              selectedRowKeys: props.selectedRowKeys ?? null,
              listLength: Array.isArray(props.list) ? props.list.length : null,
              firstItemKeys: Array.isArray(props.list) && props.list[0] ? Object.keys(props.list[0]) : null,
            };
          }
        }
        node = node.parentElement;
        depth += 1;
      }
      return 'no react fiber found walking up';
    })())`),
  };
}

async function run() {
  if (!target) throw new Error('pass a share URL as the first argument');

  const report = { target, shouldDrive };
  const consoleMessages = [];

  await app.whenReady();

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-live-'));
  const store = new Store(userDataDir);
  const userscript = new UserscriptSource({
    userDataDir,
    bundledPath: path.join(ROOT, 'resources', 'userscript.user.js'),
  });
  const { vendor, resources } = loadVendor(ROOT);

  const partition = 'persist:linkswift-live-probe';
  session.fromPartition(partition).registerPreloadScript({
    id: 'probe-netdisk-live',
    type: 'frame',
    filePath: PRELOAD_PATH,
  });

  // The real boot handshake, so the preload gets real vendor and userscript text.
  const jobs = new JobManager({
    store,
    userscript,
    vendor,
    resources,
    partition,
    preloadPath: PRELOAD_PATH,
    emit: () => {},
  });
  ipcMain.on(INTERNAL.observation, (_event, observation) => observations.push(observation));
  jobs.register(ipcMain);

  if (!shouldDrive) {
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 900,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') consoleMessages.push(String(event.message).slice(0, 200));
    });
    win.webContents.on('did-fail-load', (_e, code, description, url) => {
      consoleMessages.push(`[did-fail-load] ${code} ${description} ${url}`);
    });

    await win.loadURL(target).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 15000));
    report.survey = await survey(win.webContents);
    report.consoleMessages = consoleMessages;
  } else {
    const result = jobs.submit(target);
    report.submitResult = result;
    const job = jobs.jobs.get(result.jobId);
    if (!job) throw new Error('no job was created for that link');

    job.window.webContents.on('console-message', (event) => {
      consoleMessages.push(`[${event.level}] ${String(event.message).slice(0, 400)}`);
    });

    const frames = [];
    let elapsed = 0;
    for (const interval of [500, 1000, 1500, 2500, 5000, 10000, 12000]) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      elapsed += interval;
      if (!job.window || job.window.isDestroyed()) break;
      const state = await job.window.webContents.executeJavaScript(`({
        href: location.href,
        buttonCount: document.querySelectorAll('.pl-button-mode[data-mode="aria2"]').length,
        xButtonBox: document.querySelectorAll('.x-button-box').length,
        bodyLength: document.body ? document.body.innerHTML.length : -1,
      })`).catch((error) => ({ error: error.message }));
      frames.push({ at: elapsed, ...state, phase: job.state });
      if (job.state.phase !== 'extracting') break;
    }
    report.frames = frames;
    report.finalState = job.state;
    report.consoleMessages = consoleMessages;
  }

  report.observationKinds = observations.reduce((counts, o) => {
    counts[o.kind] = (counts[o.kind] ?? 0) + 1;
    return counts;
  }, {});
  report.scriptErrors = observations.filter((o) => o.kind === 'script-error').map((o) => o.message);
  report.driverResults = observations.filter((o) => o.kind === 'driver-result');
  report.httpRequests = observations.filter((o) => o.kind === 'http').map((o) => `${o.method} ${o.url}`);
  report.dialogs = observations.filter((o) => o.kind === 'dialog').map((o) => o.text);
  // The full request bodies, so a rejected call can be inspected rather than guessed at.
  report.httpDetail = observations
    .filter((o) => o.kind === 'http')
    .map((o) => ({
      url: o.url,
      method: o.method,
      headers: o.headers,
      body: typeof o.body === 'string' ? o.body.slice(0, 900) : o.body,
    }));

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
}

run()
  .then(() => app.exit(0))
  .catch((error) => {
    fs.writeFileSync(REPORT_PATH, JSON.stringify({ fatal: String((error && error.stack) || error) }, null, 2), 'utf8');
    app.exit(1);
  });
