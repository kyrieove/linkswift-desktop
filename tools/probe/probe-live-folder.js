'use strict';

/**
 * Settle the folder question: what does a quark share row actually contain, and
 * how does the page navigate into a folder?
 *
 *   npx electron tools/probe/probe-live-folder.js <share-url>
 *
 * Writes %TEMP%\linkswift-live-folder.json.
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
const REPORT_PATH = path.join(os.tmpdir(), 'linkswift-live-folder.json');
const PRELOAD_PATH = path.join(ROOT, 'src', 'preload', 'netdisk-preload.js');
const target = process.argv.find((arg) => /^https?:\/\//.test(arg));

app.on('window-all-closed', () => {});

async function run() {
  if (!target) throw new Error('pass a share URL');

  await app.whenReady();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-folder-'));
  const store = new Store(userDataDir);
  const userscript = new UserscriptSource({
    userDataDir,
    bundledPath: path.join(ROOT, 'resources', 'userscript.user.js'),
  });
  const { vendor, resources } = loadVendor(ROOT);

  const partition = 'persist:linkswift-folder-probe';
  session.fromPartition(partition).registerPreloadScript({
    id: 'probe-folder',
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

  await win.loadURL(target).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 16000));

  const read = async (expression) => {
    try {
      return await win.webContents.executeJavaScript(expression);
    } catch (error) {
      return `ERROR: ${error.message}`;
    }
  };

  const listState = `JSON.stringify((() => {
    const dom = document.getElementsByClassName('file-list')[0];
    if (!dom) return 'no .file-list';
    const key = Object.keys(dom).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (!key) return 'no react key';
    const isHost = (f) => f && typeof f.type === 'string';
    const walk = (fiber) => { let p = fiber.return; let g = 0; while (p && isHost(p) && g < 60) { p = p.return; g += 1; } return p; };
    let fiber = walk(dom[key]);
    for (let i = 0; i < 10 && fiber; i += 1) {
      const props = fiber.memoizedProps || {};
      if (Array.isArray(props.list) && props.list.length) {
        return {
          depth: i,
          pathname: location.pathname + location.hash,
          selectedRowKeys: props.selectedRowKeys ?? null,
          items: props.list.map((it) => ({
            fid: it.fid,
            file_name: it.file_name,
            file: it.file,
            file_type: it.file_type,
            category: it.category,
            size: it.size,
            has_fid_token: Boolean(it.share_fid_token || it.fid_token),
          })),
        };
      }
      fiber = walk(fiber);
    }
    return 'no props.list found';
  })())`;

  const report = {};
  report.before = await read(listState);

  // What the row exposes as a navigation target.
  report.rowTargets = await read(`JSON.stringify((() => {
    const row = document.querySelector('.ant-table-row');
    if (!row) return 'no row';
    const named = row.querySelector('.filename-text, .filename, [class*="filename"]');
    return {
      rowClass: String(row.className),
      dataRowKey: row.getAttribute('data-row-key'),
      namedTag: named ? named.tagName : null,
      namedClass: named ? String(named.className) : null,
      namedText: named ? named.textContent.trim() : null,
    };
  })())`);

  // Try entering the folder by double-clicking the file name, which is how the
  // page's own UI does it.
  report.dblclickResult = await read(`(() => {
    const target = document.querySelector('.ant-table-row .filename-text, .ant-table-row [class*="filename-text"]');
    if (!target) return 'no filename element';
    for (const type of ['mousedown', 'mouseup', 'click', 'mousedown', 'mouseup', 'click', 'dblclick']) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, detail: type === 'dblclick' ? 2 : 1 }));
    }
    return 'dispatched';
  })()`);

  await new Promise((resolve) => setTimeout(resolve, 4000));
  report.afterDblclick = await read(listState);
  report.swalAfter = await read(
    'JSON.stringify(Array.from(document.querySelectorAll(".swal2-title, .swal2-html-container")).map((n) => n.textContent.trim()).filter(Boolean))',
  );

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
}

run()
  .then(() => app.exit(0))
  .catch((error) => {
    fs.writeFileSync(REPORT_PATH, JSON.stringify({ fatal: String((error && error.stack) || error) }, null, 2), 'utf8');
    app.exit(1);
  });
