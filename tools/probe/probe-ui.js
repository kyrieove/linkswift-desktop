'use strict';

/**
 * Drive the real renderer against the real preload, Aria2Daemon, and IPC handlers.
 *
 *   npm run probe:ui
 */

const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const { PUSH } = require('../../src/shared/protocol');
const { Store } = require('../../src/main/store');
const { UserscriptSource } = require('../../src/main/userscript');
const { JobManager } = require('../../src/main/job');
const { Aria2Daemon } = require('../../src/main/aria2-daemon');
const { TaskStore } = require('../../src/main/task-store');
const { loadVendor } = require('../../src/main/vendor');
const { registerIpc } = require('../../src/main/ipc');

const ROOT = path.join(__dirname, '..', '..');
const REPORT_PATH = path.join(os.tmpdir(), 'linkswift-ui-report.json');
// Cleanup is verified by real state, so it has to be provable that it fails:
// LINKSWIFT_PROBE_LEAK_DAEMON=1 skips daemon.stop and the run must then exit non-zero.
const LEAK_DAEMON = process.env.LINKSWIFT_PROBE_LEAK_DAEMON === '1';
/** Shared with the exit path so a failed cleanup can still kill the real pid. */
const state = { report: null, daemon: null };

// Last resort: Electron has process-level children that keep the app alive even
// after app.exit(), so a failing probe that still owns aria2c kills it here.
process.on('exit', () => {
  if (LEAK_DAEMON && state.daemon && state.daemon.childPid) {
    try {
      process.kill(state.daemon.childPid);
    } catch {}
  }
});

const BRIDGE_SURFACE = [
  'submit',
  'cancel',
  'pause',
  'resume',
  'retry',
  'listJobs',
  'getSettings',
  'setSettings',
  'revealWindow',
  'login',
  'continueAfterLogin',
  'testAria2',
  'aria2Status',
  'restartAria2',
  'openDownloadDir',
  'chooseDirectory',
  'onJobEvent',
];

app.on('window-all-closed', () => {});

async function run(state) {
  const report = {
    ok: false,
    assertionsPassed: 0,
    screenshots: [],
    unverifiedScenarios: ['实际大文件远程下载与网络断点续传（probe 仅做快速本地与受控链路断言）'],
  };
  state.report = report;
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

  const binaryPath = path.join(ROOT, 'resources', 'aria2', 'aria2c.exe');
  const daemon = new Aria2Daemon({ userDataDir, binaryPath });
  const tasks = new TaskStore(userDataDir);
  state.daemon = daemon;

  let win = null;
  let jobs = null;
  let createdJobId = null;

  try {
    const daemonStatus = await daemon.start({ dir: path.join(userDataDir, 'downloads') });
    assert(daemonStatus.running, 'Aria2Daemon must be running');
    state.daemon.childPid = daemon.child && daemon.child.pid ? daemon.child.pid : null;
    report.assertionsPassed++;

    win = new BrowserWindow({
      show: false,
      width: 900,
      height: 760,
      webPreferences: {
        preload: path.join(ROOT, 'src', 'preload', 'renderer-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') {
        const msg = `[console:error] ${String(event.message).slice(0, 220)}`;
        consoleMessages.push(msg);
      }
    });

    jobs = new JobManager({
      store,
      userscript,
      vendor,
      resources,
      partition,
      preloadPath: path.join(ROOT, 'src', 'preload', 'netdisk-preload.js'),
      emit: (job) => {
        if (win && !win.isDestroyed()) win.webContents.send(PUSH.jobEvent, job);
      },
      daemon,
      tasks,
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

    // 1. Assert Bridge Surface
    const bridgeJson = await read(`JSON.stringify({
      present: Boolean(window.linkswift),
      keys: window.linkswift ? Object.keys(window.linkswift).sort() : [],
      missing: ${JSON.stringify(BRIDGE_SURFACE)}.filter((k) => typeof (window.linkswift || {})[k] !== 'function'),
    })`);
    const bridgeData = JSON.parse(bridgeJson);
    assert.strictEqual(bridgeData.present, true, 'window.linkswift bridge must be present');
    assert.strictEqual(bridgeData.missing.length, 0, `Bridge methods missing: ${bridgeData.missing.join(', ')}`);
    report.bridge = bridgeData;
    report.assertionsPassed++;

    // 2. Assert Real Host empty list & empty state at load
    const rowsAtLoad = await read('document.querySelectorAll(".taskrow, #job-list .job").length');
    assert.strictEqual(Number(rowsAtLoad), 0, 'No rows should be seeded at load');
    report.assertionsPassed++;

    const emptyVisible = await read('Boolean(!document.getElementById("jobs-empty")?.hidden || document.querySelector(".empty"))');
    assert.strictEqual(Boolean(emptyVisible), true, 'Empty state must be visible at load');
    report.assertionsPassed++;

    // 3. Settings Roundtrip
    const settingsRes = await read(`(async () => {
      const before = await window.linkswift.getSettings();
      const next = Object.assign({}, before, { delivery: 'clipboard', allowTransfer: true });
      next.aria2 = Object.assign({}, before.aria2, { port: '16800' });
      await window.linkswift.setSettings(next);
      const reread = await window.linkswift.getSettings();
      return JSON.stringify({
        delivery: reread.delivery,
        allowTransfer: reread.allowTransfer,
        port: reread.aria2.port,
        persisted: reread.delivery === 'clipboard' && reread.allowTransfer === true && reread.aria2.port === '16800',
      });
    })()`);
    const settingsData = JSON.parse(settingsRes);
    assert.strictEqual(settingsData.persisted, true, 'Settings roundtrip must persist');
    report.settingsRoundTrip = settingsData;
    report.assertionsPassed++;

    // 4. Bad link rejection
    const badLinkRes = await read(`window.linkswift.submit('not a valid share link').then((r) => JSON.stringify(r))`);
    const badLinkData = JSON.parse(badLinkRes);
    assert.strictEqual(badLinkData.ok, false, 'Invalid link must be rejected');
    assert(Array.isArray(badLinkData.jobs) && badLinkData.jobs[0].error, 'Rejected input must say why, per entry');
    report.assertionsPassed++;

    // 5. Test real submit & push event rendering
    await read('window.__probeEventCount = 0; window.linkswift.onJobEvent(function () { window.__probeEventCount++; }); "armed"');
    const goodLinkRes = await read(`window.linkswift.submit('https://pan.quark.cn/s/0123456789ab').then((r) => JSON.stringify(r))`);
    const goodLinkData = JSON.parse(goodLinkRes);
    assert.strictEqual(goodLinkData.ok, true, 'Valid link must be accepted');
    createdJobId = goodLinkData.jobs[0].jobId;
    assert(createdJobId, 'A valid link must come back with its own jobId');

    // The same link pasted again is already being worked on: no second job.
    const duplicateRes = await read(`window.linkswift.submit('https://pan.quark.cn/s/0123456789ab').then((r) => JSON.stringify(r))`);
    const duplicateData = JSON.parse(duplicateRes);
    assert.strictEqual(duplicateData.jobs[0].duplicateOf, createdJobId, 'An in-flight link must be de-duplicated');
    report.assertionsPassed++;

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const eventsCount = await read('window.__probeEventCount');
    assert(Number(eventsCount) >= 1, 'Renderer must receive at least 1 job event');
    report.assertionsPassed++;

    const rowsAfterSubmit = await read('document.querySelectorAll(".taskrow, #job-list .job").length');
    assert.strictEqual(Number(rowsAfterSubmit), 1, 'Exactly 1 task row must be rendered');
    report.assertionsPassed++;

    // 6. Test cancel of real created job: real IPC/job state plus the exact cancelled label
    const cancelRes = await read(
      `window.linkswift.cancel(${JSON.stringify(createdJobId)}).then(() => "ok", (err) => "ERR: " + err.message)`
    );
    assert.strictEqual(cancelRes, 'ok', `Cancel must resolve, got: ${cancelRes}`);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const cancelStateJson = await read(
      `window.linkswift.listJobs().then((list) => JSON.stringify((list || []).find((j) => j.id === ${JSON.stringify(createdJobId)}) || null))`
    );
    const cancelState = JSON.parse(cancelStateJson);
    assert(cancelState && cancelState.state, 'Cancelled job must still be listed by listJobs');
    assert.strictEqual(cancelState.state.phase, 'failed', 'Cancelled job must end in the failed phase');
    assert.strictEqual(cancelState.state.code, 'cancelled', 'Cancelled job must carry the cancelled code');
    report.cancelState = { phase: cancelState.state.phase, code: cancelState.state.code };
    report.assertionsPassed++;

    const cancelLabel = await read(
      `document.querySelector('.taskrow[data-job-id="${createdJobId}"] .status')?.textContent.trim() || ""`
    );
    assert.strictEqual(
      cancelLabel,
      '已取消',
      'Row must show the exact "已取消" label; the generic "失败 / 取消" filter text must not satisfy it'
    );
    report.assertionsPassed++;

    // 7. Push Fixtures across all 10 phases, four providers, multi-file aggregate progress, hostile filename
    const now = Date.now();
    const longName = 'Unidownload-超长文件名校验-' + 'A'.repeat(96) + '.mp4';
    const fixtures = [
      {
        id: 'fixture-quark-downloading',
        createdAt: now - 1000,
        link: { raw: 'https://pan.quark.cn/s/qk123', provider: 'quark', shareId: 'qk123', passcode: null },
        state: {
          phase: 'downloading',
          files: [
            { name: '<script>alert("xss")</script>.zip', url: 'https://example.com/1.zip', headers: { 'User-Agent': 'quark-agent' } },
            { name: 'file2.bin', url: 'https://example.com/2.bin', headers: {} },
          ],
          progress: [
            { gid: 'gid-1', name: '<script>alert("xss")</script>.zip', status: 'active', totalLength: 2000000, completedLength: 1000000, downloadSpeed: 500000, connections: 8 },
            { gid: 'gid-2', name: 'file2.bin', status: 'active', totalLength: 3000000, completedLength: 1500000, downloadSpeed: 500000, connections: 8 },
          ],
        },
      },
      {
        id: 'fixture-baidu-human-transfer',
        createdAt: now - 2000,
        link: { raw: 'https://pan.baidu.com/s/bd123', provider: 'baidu', shareId: 'bd123', passcode: 'abcd' },
        state: { phase: 'needs-human', reason: 'transfer' },
      },
      {
        id: 'fixture-xunlei-human-manual',
        createdAt: now - 3000,
        link: { raw: 'https://pan.xunlei.com/s/xl123', provider: 'xunlei', shareId: 'xl123', passcode: null },
        state: { phase: 'needs-human', reason: 'manual' },
      },
      {
        id: 'fixture-xunlei-human-login',
        createdAt: now - 3500,
        link: { raw: 'https://pan.xunlei.com/s/xl_login', provider: 'xunlei', shareId: 'xl_login', passcode: null },
        state: { phase: 'needs-human', reason: 'login' },
      },
      {
        id: 'fixture-uc-paused',
        createdAt: now - 4000,
        link: { raw: 'https://drive.uc.cn/s/uc123', provider: 'uc', shareId: 'uc123', passcode: null },
        state: {
          phase: 'paused',
          files: [{ name: 'uc-archive.tar', url: 'https://example.com/uc.tar', headers: {} }],
          progress: [{ gid: 'gid-uc', name: 'uc-archive.tar', status: 'paused', totalLength: 5000000, completedLength: 2000000, downloadSpeed: 0, connections: 0 }],
        },
      },
      {
        id: 'fixture-done-clipboard',
        createdAt: now - 5000,
        link: { raw: 'https://pan.quark.cn/s/qk_done', provider: 'quark', shareId: 'qk_done', passcode: null },
        state: {
          phase: 'done',
          files: [{ name: 'done-file.txt', url: 'https://example.com/done.txt', headers: {} }],
        },
      },
      {
        id: 'fixture-failed-expired',
        createdAt: now - 6000,
        link: { raw: 'https://pan.baidu.com/s/bd_fail', provider: 'baidu', shareId: 'bd_fail', passcode: null },
        state: {
          phase: 'failed',
          code: 'link-expired',
          message: '直链已过期',
          detail: '403 Forbidden\nToken expired',
          files: [{ name: 'failed-file.mp4', url: 'https://example.com/fail.mp4', headers: {} }],
        },
      },
      {
        id: 'fixture-loading',
        createdAt: now - 7000,
        link: { raw: 'https://pan.quark.cn/s/qk_load', provider: 'quark', shareId: 'qk_load', passcode: null },
        state: { phase: 'loading' },
      },
      {
        id: 'fixture-extracting',
        createdAt: now - 8000,
        link: { raw: 'https://pan.baidu.com/s/bd_ext', provider: 'baidu', shareId: 'bd_ext', passcode: null },
        state: { phase: 'extracting' },
      },
      {
        id: 'fixture-linked',
        createdAt: now - 9000,
        link: { raw: 'https://drive.uc.cn/s/uc_link', provider: 'uc', shareId: 'uc_link', passcode: null },
        state: {
          phase: 'linked',
          files: [{ name: 'linked-sample.iso', url: 'https://example.com/sample.iso', headers: {} }],
        },
      },
      {
        id: 'fixture-delivering',
        createdAt: now - 10000,
        link: { raw: 'https://pan.quark.cn/s/qk_del', provider: 'quark', shareId: 'qk_del', passcode: null },
        state: {
          phase: 'delivering',
          files: [{ name: 'delivering-sample.iso', url: 'https://example.com/sample.iso', headers: {} }],
        },
      },
      {
        id: 'fixture-long-multifile',
        createdAt: now - 11000,
        link: { raw: 'https://pan.quark.cn/s/qk_multi', provider: 'quark', shareId: 'qk_multi', passcode: null },
        state: {
          phase: 'downloading',
          files: [
            { name: longName, url: 'https://example.com/long.mp4', headers: { 'User-Agent': 'quark-agent' } },
            { name: 'part-two.mkv', url: 'https://example.com/2.mkv', headers: {} },
            { name: 'part-three.srt', url: 'https://example.com/3.srt', headers: {} },
          ],
          progress: [
            { gid: 'gid-long-1', name: longName, status: 'active', totalLength: 4000000, completedLength: 1000000, downloadSpeed: 250000, connections: 8 },
            { gid: 'gid-long-2', name: 'part-two.mkv', status: 'active', totalLength: 2000000, completedLength: 1000000, downloadSpeed: 250000, connections: 8 },
            { gid: 'gid-long-3', name: 'part-three.srt', status: 'waiting', totalLength: 2000000, completedLength: 0, downloadSpeed: 0, connections: 0 },
          ],
        },
      },
    ];
    for (const fixture of fixtures) {
      win.webContents.send(PUSH.jobEvent, fixture);
    }
    await new Promise((resolve) => setTimeout(resolve, 800));

    // 8. Verify total rows rendered and escaped hostile filename
    const rowCount = await read('document.querySelectorAll(".taskrow, #job-list .job").length');
    assert(Number(rowCount) >= 11, `Expected at least 11 rows, got ${rowCount}`);
    report.assertionsPassed++;

    const hostileRowEscaped = await read(`JSON.stringify((() => {
      const scriptTag = document.querySelector(".taskrow script, #job-list script");
      const filenameNode = Array.from(document.querySelectorAll(".filename, .job__name")).find(n => n.textContent.includes('alert("xss")'));
      return { scriptTagFound: Boolean(scriptTag), textFound: Boolean(filenameNode) };
    })())`);
    const hostileCheck = JSON.parse(hostileRowEscaped);
    assert.strictEqual(hostileCheck.scriptTagFound, false, 'Hostile filename must NOT execute as <script>');
    assert.strictEqual(hostileCheck.textFound, true, 'Hostile filename must be safely rendered as textContent');
    report.assertionsPassed++;

    // 9. Verify Xunlei manual action has NO fake continue button
    await read(`document.querySelector('[data-job-id="fixture-xunlei-human-manual"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const manualActions = await read(`JSON.stringify((() => {
      const drawer = document.getElementById("drawer");
      return Array.from(drawer?.querySelectorAll("button") || []).map(b => b.textContent.trim());
    })())`);
    const manualBtnLabels = JSON.parse(manualActions);
    assert(!manualBtnLabels.includes('我已处理，继续') && !manualBtnLabels.includes('继续解析'), 'Xunlei manual must NEVER offer fake continue button');
    report.assertionsPassed++;

    // 10. Verify Xunlei login DOES offer '我已登录，继续'
    await read(`document.querySelector('[data-job-id="fixture-xunlei-human-login"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const loginActions = await read(`JSON.stringify((() => {
      const drawer = document.getElementById("drawer");
      return Array.from(drawer?.querySelectorAll("button") || []).map(b => b.textContent.trim());
    })())`);
    const loginBtnLabels = JSON.parse(loginActions);
    assert(loginBtnLabels.some(lbl => lbl.includes('我已登录，继续')), 'Xunlei login must offer "我已登录，继续" button');
    report.assertionsPassed++;

    // 11. Test search query
    await read(`(() => {
      const s = document.getElementById("search");
      s.value = "uc-archive";
      s.dispatchEvent(new Event("input"));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const searchMatchCount = await read('document.querySelectorAll(".taskrow, #job-list .job").length');
    assert.strictEqual(Number(searchMatchCount), 1, 'Search query should filter to exactly 1 match');
    report.assertionsPassed++;

    // Reset search
    await read(`(() => {
      const s = document.getElementById("search");
      s.value = "";
      s.dispatchEvent(new Event("input"));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // 12. Provider filter composes with the phase filter, search and sort
    await read(`document.querySelector('[data-source="xunlei"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const xunleiCount = await read('document.querySelectorAll(".taskrow, #job-list .job").length');
    assert.strictEqual(Number(xunleiCount), 2, 'Xunlei filter should show exactly 2 tasks');
    const xunleiOnly = JSON.parse(
      await read(`JSON.stringify(Array.from(document.querySelectorAll('.taskrow')).map((r) => !!r.querySelector('.source')?.textContent.startsWith('迅雷云盘')))`)
    );
    assert(xunleiOnly.every(Boolean), 'Provider filter must only render tasks of that provider');
    report.assertionsPassed += 2;

    // The phase filter must replace, not stack on, the provider filter
    await read(`document.querySelectorAll('#filters .sideitem')[3]?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const humanStates = JSON.parse(
      await read(`JSON.stringify(Array.from(document.querySelectorAll('.taskrow')).map((r) => r.dataset.state))`)
    );
    assert(humanStates.length >= 3, `Phase filter should list every needs-human task, got ${humanStates.length}`);
    assert(humanStates.every((state) => state === 'needs-human'), 'Phase filter must not mix phases');
    assert.strictEqual(
      Number(await read(`document.querySelectorAll('[data-source].active').length`)),
      0,
      'Phase filter must clear the provider filter'
    );
    report.assertionsPassed += 3;

    // Back to all tasks, then sort by name
    await read(`document.querySelectorAll('#filters .sideitem')[0]?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await read(`(() => { const s = document.getElementById('sort'); s.value = 'name'; s.dispatchEvent(new Event('change')); })()`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const sortedNames = JSON.parse(
      await read(`JSON.stringify(Array.from(document.querySelectorAll('.taskrow .filename')).map((n) => n.textContent))`)
    );
    const expectedNames = sortedNames.slice().sort((a, b) => a.localeCompare(b, 'zh-CN'));
    assert(sortedNames.length >= 12, `Expected the full task list after resetting filters, got ${sortedNames.length}`);
    assert.deepStrictEqual(sortedNames, expectedNames, 'Sorting by name must order the rendered rows');
    report.assertionsPassed++;

    // 12b. Long filename and multi-file progress stay inside the row
    const longRowState = JSON.parse(
      await read(`JSON.stringify((() => {
        const row = document.querySelector('.taskrow[data-job-id="fixture-long-multifile"]');
        if (!row) return null;
        const name = row.querySelector('.filename');
        const status = row.querySelector('.status');
        const meta = row.querySelector('.rowmeta');
        const rowBox = row.getBoundingClientRect();
        const statusBox = status ? status.getBoundingClientRect() : null;
        const metaBox = meta ? meta.getBoundingClientRect() : null;
        return {
          titleLength: (name && name.title || '').length,
          textLength: (name && name.textContent || '').length,
          rowOverflow: row.scrollWidth - row.clientWidth,
          statusInsideRow: Boolean(statusBox && statusBox.right <= rowBox.right + 1 && statusBox.left >= rowBox.left - 1),
          statusAboveMeta: Boolean(statusBox && metaBox && statusBox.bottom <= metaBox.bottom + 1),
          progressBars: row.querySelectorAll('.progress').length,
          progressWidth: row.querySelector('.progress span')?.style.width || '',
        };
      })())`)
    );
    assert(longRowState, 'Long filename fixture row must render');
    assert(longRowState.titleLength > 100, 'Long filename must keep the full name in the tooltip');
    assert(longRowState.rowOverflow <= 1, `Row must not scroll horizontally, overflowed by ${longRowState.rowOverflow}px`);
    assert(longRowState.statusInsideRow, 'Status label must stay inside its row');
    assert(longRowState.progressBars === 1, 'Multi-file download must show a single aggregate progress bar');
    assert(/^\d+%$/.test(longRowState.progressWidth), `Aggregate progress width must be a percent, got ${longRowState.progressWidth}`);
    report.assertionsPassed += 4;

    // Detail drawer lists every file with its own row
    await read(`document.querySelector('.taskrow[data-job-id="fixture-long-multifile"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await read(`Array.from(document.querySelectorAll('#drawer .tab')).find((b) => b.textContent.startsWith('文件'))?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const fileItemCount = Number(await read(`document.querySelectorAll('#drawer .fileitem').length`));
    assert.strictEqual(fileItemCount, 3, `Detail files tab must list all 3 files, got ${fileItemCount}`);
    report.assertionsPassed++;

    // 12c. Ctrl+K focuses search, Escape closes the drawer and restores row focus
    await read(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(await read(`document.activeElement?.id || ''`), 'search', 'Ctrl+K must focus the search box');
    report.assertionsPassed++;

    // 13. Test 900x760 light screenshot & no page overflow
    await read(`document.querySelector('#drawer .drawerheader button')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(await read('Boolean(document.getElementById("drawer")?.hidden)'), true, 'Drawer close button must hide the drawer');
    report.assertionsPassed++;

    win.setSize(900, 760);
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Every sidebar filter must be reachable (scrolled, not clipped) at the minimum height
    const shortSidebarUnreachable = JSON.parse(
      await read(`JSON.stringify(Array.from(document.querySelectorAll('#filters .sideitem, .sidebar [data-source]')).map((b) => {
        b.scrollIntoView({ block: 'nearest' });
        const r = b.getBoundingClientRect();
        return r.top < 0 || r.bottom > document.documentElement.clientHeight + 1;
      }))`)
    );
    assert(shortSidebarUnreachable.every((bad) => bad === false), 'Every sidebar filter must be reachable in a short window');
    report.assertionsPassed++;

    // The speed block lives at the bottom of the scrolling sidebar; it has to be
    // reachable there instead of being clipped by the grid row.
    const speedBlock = JSON.parse(
      await read(`JSON.stringify((() => {
        const sb = document.querySelector(".sidebar");
        const box = document.querySelector(".speedbox");
        if (!sb || !box) return null;
        const startTop = sb.scrollTop;
        box.scrollIntoView({ block: "nearest" });
        const r = box.getBoundingClientRect();
        const visible = r.top >= 0 && r.bottom <= document.documentElement.clientHeight + 1;
        sb.scrollTop = startTop;
        return { visible, scrollable: sb.scrollHeight > sb.clientHeight, height: Math.round(r.height) };
      })())`)
    );
    assert(speedBlock, 'The total speed block must exist in the sidebar');
    assert(speedBlock.visible, 'The total speed block must be reachable by scrolling the sidebar, not clipped away');
    assert(speedBlock.height > 20, `The total speed block must not collapse, height=${speedBlock.height}`);
    report.speedBlock = speedBlock;
    report.assertionsPassed += 1;
    await read(`(() => { const sb = document.querySelector('.sidebar'); if (sb) sb.scrollTop = 0; })()`);

    const overflow900 = await read(`JSON.stringify((() => {
      const de = document.documentElement;
      return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, overflow: de.scrollWidth > de.clientWidth };
    })())`);
    const ov900 = JSON.parse(overflow900);
    assert.strictEqual(ov900.overflow, false, 'No page overflow at 900x760');
    report.assertionsPassed++;

    const imgPath900Light = path.join(os.tmpdir(), 'linkswift-probe-900x760-light.png');
    const imgBuf900 = await win.webContents.capturePage();
    fs.writeFileSync(imgPath900Light, imgBuf900.toPNG());
    report.screenshots.push(imgPath900Light);

    await read(`document.querySelector('[data-job-id="fixture-long-multifile"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const imgPath900Detail = path.join(os.tmpdir(), 'linkswift-probe-900x760-light-detail.png');
    const imgBuf900Detail = await win.webContents.capturePage();
    fs.writeFileSync(imgPath900Detail, imgBuf900Detail.toPNG());
    report.screenshots.push(imgPath900Detail);

    // 14. Test 720x520 dark with drawer open, compact layout, overlay, no page overflow
    await read(`document.getElementById("theme")?.click()`);
    win.setSize(720, 520);
    await read(`document.querySelector('[data-job-id="fixture-long-multifile"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const overflow720 = await read(`JSON.stringify((() => {
      const de = document.documentElement;
      return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, overflow: de.scrollWidth > de.clientWidth };
    })())`);
    const ov720 = JSON.parse(overflow720);
    assert.strictEqual(ov720.overflow, false, 'No horizontal page overflow at 720x520 with drawer open');
    report.assertionsPassed++;

    // Detail label column must keep one line each instead of collapsing into a vertical strip
    const detailLabels = JSON.parse(
      await read(`JSON.stringify(Array.from(document.querySelectorAll('#drawer .detailkv span:first-child')).map((label) => ({
        text: label.textContent,
        height: label.clientHeight,
        clipped: label.scrollWidth > label.clientWidth + 1,
      })))`)
    );
    assert(detailLabels.length >= 4, `Detail drawer must render key/value rows, got ${detailLabels.length}`);
    for (const label of detailLabels) {
      assert(label.height <= 24, `Detail label "${label.text}" must stay on one line, height=${label.height}`);
      assert.strictEqual(label.clipped, false, `Detail label "${label.text}" must not be clipped`);
    }
    report.assertionsPassed += 1;

    const imgPath720Dark = path.join(os.tmpdir(), 'linkswift-probe-720x520-dark.png');
    await read(`(() => { const sb = document.querySelector('.sidebar'); if (sb) sb.scrollTop = 0; })()`);
    const imgBuf720 = await win.webContents.capturePage();
    fs.writeFileSync(imgPath720Dark, imgBuf720.toPNG());
    report.screenshots.push(imgPath720Dark);

    // 15. Test Escape key closes drawer and returns focus to the task list
    await read(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const drawerHiddenAfterEsc = await read('Boolean(document.getElementById("drawer")?.hidden)');
    assert.strictEqual(drawerHiddenAfterEsc, true, 'Escape must close drawer');
    const focusAfterEsc = await read(`document.activeElement?.classList.contains('taskrow') || false`);
    assert.strictEqual(focusAfterEsc, true, 'Closing the drawer must return focus to a task row');
    report.assertionsPassed += 2;

    // 16. Dark theme must actually restyle the page, not only relabel the button.
    // Step 14 already switched to dark; capture what that produced.
    const darkState = JSON.parse(
      await read(`JSON.stringify({
        rootDark: document.documentElement.classList.contains("dark"),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        railBg: getComputedStyle(document.querySelector(".rail")).backgroundColor,
      })`)
    );
    await read(`document.getElementById("theme")?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const lightState = JSON.parse(
      await read(`JSON.stringify({
        rootDark: document.documentElement.classList.contains("dark"),
        bodyBg: getComputedStyle(document.body).backgroundColor,
      })`)
    );
    assert.strictEqual(darkState.rootDark, true, 'The dark theme must be applied on documentElement (.dark token scope)');
    assert.notStrictEqual(lightState.bodyBg, darkState.bodyBg, `Switching the theme must change the page background, still ${darkState.bodyBg}`);
    report.theme = { darkState, lightState };
    report.assertionsPassed += 2;

    // 17. A done job without local progress must not borrow the saved clipboard/browser setting
    const doneWording = JSON.parse(
      await read(`JSON.stringify((() => {
        const row = document.querySelector('[data-job-id="fixture-done-clipboard"]');
        return { status: row?.querySelector('.status')?.textContent.trim() || '', metrics: row?.querySelector('.metrics')?.textContent.trim() || '' };
      })())`)
    );
    assert.strictEqual(
      doneWording.status,
      '已投递',
      `A job with no local download bytes must read 已投递, got "${doneWording.status}" (the saved delivery was clipboard)`
    );
    report.doneWording = doneWording;
    report.assertionsPassed += 1;

    // 18. Re-rendering on a push event keeps focus and scroll inside the task list
    await read(`(() => { const r = document.querySelector('.taskrow'); if (r) r.focus(); })()`);
    const focusedBeforePush = await read(`document.activeElement?.dataset?.jobId || ''`);
    win.webContents.send(PUSH.jobEvent, fixtures.find((f) => f.id === 'fixture-quark-downloading'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const refocusState = JSON.parse(
      await read(`JSON.stringify({
        focusedId: document.activeElement?.dataset?.jobId || "",
        rowActive: document.activeElement?.classList?.contains("taskrow") || false,
      })`)
    );
    assert.strictEqual(
      refocusState.focusedId,
      focusedBeforePush,
      `Focus must stay on job ${focusedBeforePush} after a push re-render, got "${refocusState.focusedId}"`
    );
    report.assertionsPassed += 1;

    assert.strictEqual(consoleMessages.length, 0, `Unexpected console errors: ${consoleMessages.join('\n')}`);
    report.consoleMessages = consoleMessages;
    report.ok = true;
  } finally {
    const cleanupErrors = [];
    if (createdJobId && jobs) {
      try {
        await Promise.race([
          jobs.cancel(createdJobId),
          new Promise((_, reject) => setTimeout(() => reject(new Error('cancel timeout')), 3000)),
        ]);
      } catch (err) {
        cleanupErrors.push(`jobs.cancel: ${err.message}`);
      }
    }
    if (jobs) {
      try {
        jobs.shutdown();
      } catch (err) {
        cleanupErrors.push(`jobs.shutdown: ${err.message}`);
      }
    }
    if (daemon && LEAK_DAEMON) {
      // Negative control only: the leak has to be visible to the exit code below.
      cleanupErrors.push('LINKSWIFT_PROBE_LEAK_DAEMON=1: daemon.stop skipped on purpose');
    } else if (daemon) {
      try {
        await Promise.race([
          daemon.stop(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('daemon.stop timeout')), 10000)),
        ]);
      } catch (err) {
        cleanupErrors.push(`daemon.stop: ${err.message}`);
      }
    }
    if (win && !win.isDestroyed()) {
      try {
        win.destroy();
      } catch (err) {
        cleanupErrors.push(`win.destroy: ${err.message}`);
      }
    }
    if (cleanupErrors.length > 0) {
      // A leaked daemon/window is a failed probe, not a footnote.
      report.cleanupErrors = cleanupErrors;
      report.ok = false;
    }
    // The exit code follows real state, not only kill() return values: a daemon
    // that was asked to stop but still answers RPC means aria2c is still here.
    if (daemon) {
      const stillRunning = Boolean(daemon.status().running);
      if (stillRunning) {
        report.cleanupErrors = (report.cleanupErrors || []).concat('daemon still running after cleanup');
        report.ok = false;
      }
    }
    report.cleanup = {
      windowDestroyed: Boolean(win && win.isDestroyed()),
      daemonRunning: Boolean(daemon && daemon.status().running),
    };
  }

  try {
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write report:', err);
    throw err;
  }

  if (!report.ok) {
    throw new Error(
      `UI probe finished without ok completion flag${
        report.cleanupErrors ? `: cleanup failed (${report.cleanupErrors.join('; ')})` : ''
      }`
    );
  }
}

run(state)
  .then(() => {
    // The exit code carries the verdict, so the harness never has to hang on a
    // window or child that outlived the assertions.
    process.stdout.write(`PROBE ${state.report.ok ? 'OK' : 'FAILED'}\n`);
    app.exit(0);
  })
  .catch((error) => {
    // The negative control leaves a real aria2c behind (stop() already cleared
    // this.child), so kill that pid explicitly. This is test-only; production
    // cleanup runs in the finally above.
    if (LEAK_DAEMON && state.daemon && state.daemon.childPid) {
      try {
        process.kill(state.daemon.childPid);
      } catch {}
    }
    try {
      fs.writeFileSync(
        REPORT_PATH,
        JSON.stringify({ ok: false, fatal: String((error && error.stack) || error) }, null, 2),
        'utf8'
      );
    } catch {}
    console.error('PROBE FAILED:', error);
    app.exit(1);
  });
