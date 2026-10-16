'use strict';

/**
 * Look at one real share page closely enough to settle the driver's selectors.
 *
 *   npx electron tools/probe/probe-live-dom.js <share-url>
 *
 * Writes %TEMP%\linkswift-live-dom.json.
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
const REPORT_PATH = path.join(os.tmpdir(), 'linkswift-live-dom.json');
const PRELOAD_PATH = path.join(ROOT, 'src', 'preload', 'netdisk-preload.js');
const target = process.argv.find((arg) => /^https?:\/\//.test(arg));

app.on('window-all-closed', () => {});

async function run() {
  if (!target) throw new Error('pass a share URL');

  await app.whenReady();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-dom-'));
  const store = new Store(userDataDir);
  const userscript = new UserscriptSource({
    userDataDir,
    bundledPath: path.join(ROOT, 'resources', 'userscript.user.js'),
  });
  const { vendor, resources } = loadVendor(ROOT);

  const partition = 'persist:linkswift-dom-probe';
  session.fromPartition(partition).registerPreloadScript({
    id: 'probe-dom',
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

  const report = {};

  // Every checkbox on the page, with its ancestry, so the real structure shows.
  report.checkboxes = await read(`JSON.stringify(Array.from(document.querySelectorAll('input[type=checkbox]')).map((el) => {
    const chain = [];
    let node = el;
    for (let i = 0; i < 6 && node; i += 1) {
      chain.push(node.tagName + (node.className ? '.' + String(node.className).split(' ').join('.') : ''));
      node = node.parentElement;
    }
    const wrapper = el.closest('label, .ant-checkbox-wrapper, span');
    return {
      checked: el.checked,
      chain,
      wrapperClass: wrapper ? String(wrapper.className) : null,
      inThead: Boolean(el.closest('thead, .ant-table-thead')),
      inTbody: Boolean(el.closest('tbody, .ant-table-tbody')),
      rowText: (function () {
        const tr = el.closest('tr, .ant-table-row');
        return tr ? tr.innerText.replace(/\\s+/g, ' ').slice(0, 80) : null;
      })(),
    };
  }), null, 2)`);

  // Does each candidate selector actually match, and how many times?
  report.selectorMatches = await read(`JSON.stringify((() => {
    const list = [
      '.file-list .ant-checkbox-wrapper',
      '.file-list .ant-checkbox-wrapper:not(.ant-checkbox-wrapper-checked)',
      '.file-list input.ant-checkbox-input',
      '.file-list input.ant-checkbox-input:not(:checked)',
      '.file-list .ant-table-thead .ant-checkbox-wrapper',
      '.file-list .ant-table-thead input[type=checkbox]',
      '.file-list .ant-table-tbody .ant-checkbox-wrapper',
      '.file-list .ant-table-row .ant-checkbox-wrapper',
      '.file-list tbody tr .ant-checkbox-wrapper',
      '.ant-table-thead .ant-checkbox-wrapper',
      '.ant-table-tbody .ant-checkbox-wrapper',
    ];
    const out = {};
    for (const s of list) { try { out[s] = document.querySelectorAll(s).length; } catch (e) { out[s] = 'invalid: ' + e.message; } }
    return out;
  })())`);

  // The row markup, without the base64 noise.
  report.rowMarkup = await read(`JSON.stringify((() => {
    const row = document.querySelector('.ant-table-row') || document.querySelector('.file-list tbody tr');
    if (!row) return 'no row';
    return row.outerHTML.replace(/src="data:[^"]*"/g, 'src="[data-uri]"').slice(0, 1800);
  })())`);

  report.theadMarkup = await read(`JSON.stringify((() => {
    const head = document.querySelector('.ant-table-thead') || document.querySelector('.file-list thead');
    if (!head) return 'no thead';
    return head.outerHTML.replace(/src="data:[^"]*"/g, 'src="[data-uri]"').slice(0, 1200);
  })())`);

  // Walk up the way the userscript's findReact does: skip host-element fibers,
  // take the first component fiber's props.
  report.componentProps = await read(`JSON.stringify((() => {
    const dom = document.getElementsByClassName('file-list')[0];
    if (!dom) return 'no .file-list';
    const key = Object.keys(dom).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (!key) return 'no react key on .file-list';
    const domFiber = dom[key];
    const isHost = (f) => f && typeof f.type === 'string';
    const walk = (fiber) => {
      let parent = fiber.return;
      let guard = 0;
      while (parent && isHost(parent) && guard < 50) { parent = parent.return; guard += 1; }
      return parent;
    };
    let compFiber = walk(domFiber);
    const seen = [];
    for (let i = 0; i < 8 && compFiber; i += 1) {
      const props = compFiber.memoizedProps || {};
      seen.push({
        depth: i,
        type: typeof compFiber.type === 'function' ? (compFiber.type.name || 'anonymous') : String(compFiber.type),
        propKeys: Object.keys(props).slice(0, 20),
        hasSelectedRowKeys: 'selectedRowKeys' in props,
        selectedRowKeys: props.selectedRowKeys ?? null,
        hasList: 'list' in props,
        listLength: Array.isArray(props.list) ? props.list.length : null,
        firstItemKeys: Array.isArray(props.list) && props.list[0] ? Object.keys(props.list[0]).slice(0, 20) : null,
        hasStoken: 'stoken' in props,
        stoken: props.stoken ?? null,
      });
      compFiber = walk(compFiber);
    }
    return seen;
  })())`);

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
}

run()
  .then(() => app.exit(0))
  .catch((error) => {
    fs.writeFileSync(REPORT_PATH, JSON.stringify({ fatal: String((error && error.stack) || error) }, null, 2), 'utf8');
    app.exit(1);
  });
