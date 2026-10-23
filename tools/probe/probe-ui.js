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
const { ProviderHealthStore } = require('../../src/main/provider-health');
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
      health: new ProviderHealthStore(userDataDir),
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

    /**
     * Take a picture of the window as it is right now.
     *
     * The probe window is never shown, so Chromium keeps serving the last
     * painted frame and a capture can show a page that is no longer on
     * screen. A size change is what makes it paint again, so nudge the
     * window, let it redraw, and take the picture at the nudged size.
     *
     * @param {Electron.BrowserWindow} target
     * @returns {Promise<Electron.NativeImage>}
     */
    const shoot = async (target) => {
      const size = target.getSize();
      target.setSize(size[0] + 40, size[1] + 20);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const image = await target.webContents.capturePage();
      target.setSize(size[0], size[1]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      return image;
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
      {
        id: 'fixture-partial-done',
        createdAt: now - 4500,
        link: { raw: 'https://pan.quark.cn/s/qk_partial', provider: 'quark', shareId: 'qk_partial', passcode: null },
        state: {
          phase: 'done',
          files: [
            { name: 'ok-one.bin', url: 'https://example.com/1', headers: {} },
            { name: 'ok-two.bin', url: 'https://example.com/2', headers: {} },
            { name: 'bad-three.bin', url: 'https://example.com/3', headers: {} },
          ],
          progress: [
            { gid: 'gid-p1', name: 'ok-one.bin', status: 'complete', totalLength: 100, completedLength: 100, downloadSpeed: 0, connections: 0 },
            { gid: 'gid-p2', name: 'ok-two.bin', status: 'complete', totalLength: 100, completedLength: 100, downloadSpeed: 0, connections: 0 },
            { gid: 'gid-p3', name: 'bad-three.bin', status: 'error', totalLength: 100, completedLength: 10, downloadSpeed: 0, connections: 0, errorCode: '22', errorMessage: '403 Forbidden' },
          ],
        },
      },
      {
        id: 'fixture-stalled',
        createdAt: now - 4600,
        link: { raw: 'https://drive.uc.cn/s/uc_stall', provider: 'uc', shareId: 'uc_stall', passcode: null },
        stalled: true,
        state: {
          phase: 'downloading',
          files: [{ name: 'stalled.iso', url: 'https://example.com/stalled.iso', headers: {} }],
          progress: [{ gid: 'gid-stall', name: 'stalled.iso', status: 'active', totalLength: 1000, completedLength: 300, downloadSpeed: 0, connections: 1 }],
        },
      },
      {
        // The failure the diagnosis is for: a page that changed under a known
        // script, reported with the step that broke and the script that ran.
        id: 'fixture-diagnosis',
        createdAt: now - 4700,
        link: { raw: 'https://pan.baidu.com/s/bd_diag', provider: 'baidu', shareId: 'bd_diag', passcode: null },
        scriptVersion: '1.0.3',
        scriptOrigin: 'upstream',
        state: {
          phase: 'failed',
          code: 'upstream-redesigned',
          message: '页面上没找到该点的东西，上游可能改版了（保存到网盘）',
          detail: 'waitFor .x-button-box: 超时 15000ms',
          step: 2,
          verb: 'wait-for',
          selector: '.x-button-box',
          hint: '页面结构变了：点重试会重新拉取最新脚本，再跑一遍。',
        },
      },
      {
        // Archived by the user: it left the main list and only the archive view has it.
        id: 'fixture-archived',
        createdAt: now - 4800,
        link: { raw: 'https://pan.quark.cn/s/qk_arch', provider: 'quark', shareId: 'qk_arch', passcode: null },
        archivedAt: now - 4000,
        state: {
          phase: 'done',
          files: [{ name: 'archived-file.zip', url: 'https://example.com/arch.zip', headers: {} }],
        },
      },
      {
        // A media job. Its record carries a kind instead of a provider, which is
        // what used to make the source filter drop it on the floor.
        id: 'fixture-media-clip',
        createdAt: now - 11500,
        link: { kind: 'media', raw: 'https://www.youtube.com/watch?v=clip1', url: 'https://www.youtube.com/watch?v=clip1' },
        state: {
          phase: 'done',
          files: [{ name: 'clip-title.mp4', url: 'https://example.com/clip.mp4', headers: {} }],
        },
      },
      {
        // A direct file link. Same shape as the media fixture: a kind, no provider.
        id: 'fixture-direct-zip',
        createdAt: now - 12000,
        link: { kind: 'direct', raw: 'https://example.com/a/b.zip', url: 'https://example.com/a/b.zip' },
        state: {
          phase: 'downloading',
          files: [{ name: 'b.zip', url: 'https://example.com/b.zip', headers: {} }],
          progress: [{ gid: 'gid-direct', name: 'b.zip', status: 'active', totalLength: 4000, completedLength: 1000, downloadSpeed: 500, connections: 4 }],
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

    // 12. Source filter composes with the phase filter, search and sort
    // The source buttons are drawn from the registry the main process sends,
    // so they are not in the markup until that arrives.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await read(`!!document.querySelector('[data-source-kind="netdisk"]')`)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // The sidebar offers one button per category, not one per netdisk.
    const sourceKinds = JSON.parse(
      await read(`JSON.stringify(Array.from(document.querySelectorAll('#source-filters [data-source-kind]')).map((b) => b.dataset.sourceKind))`)
    );
    assert.deepStrictEqual(
      sourceKinds,
      ['netdisk', 'media', 'direct'],
      `The sidebar must offer one button per category, got ${sourceKinds}`
    );
    report.assertionsPassed++;

    // The category filter must reach every netdisk at once.
    await read(`document.querySelector('[data-source-kind="netdisk"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const netdiskRows = Number(await read('document.querySelectorAll(".taskrow, #job-list .job").length'));
    const netdiskOnly = JSON.parse(
      await read(`JSON.stringify(Array.from(document.querySelectorAll('.taskrow')).map((r) => !!r.querySelector('.source')?.textContent.startsWith('夸克网盘') || r.querySelector('.source')?.textContent.startsWith('百度网盘') || r.querySelector('.source')?.textContent.startsWith('UC 网盘') || r.querySelector('.source')?.textContent.startsWith('迅雷云盘')))`)
    );
    assert(netdiskOnly.length > 0, 'The 网盘 category filter must show netdisk tasks');
    assert(netdiskOnly.every(Boolean), 'The 网盘 category filter must not mix in other sources');
    report.assertionsPassed += 2;

    // A media job has a kind, not a provider. Filtering by category used to
    // compare against a provider field that a media record does not have, so
    // the media and direct filters came up empty.
    await read(`document.querySelector('[data-source-kind="media"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const mediaRows = Number(await read('document.querySelectorAll(".taskrow, #job-list .job").length'));
    assert.strictEqual(mediaRows, 1, `The 媒体 filter must show the media task, got ${mediaRows}`);
    await read(`document.querySelector('[data-source-kind="direct"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const directRows = Number(await read('document.querySelectorAll(".taskrow, #job-list .job").length'));
    assert.strictEqual(directRows, 1, `The 直链 filter must show the direct-link task, got ${directRows}`);
    report.assertionsPassed += 2;

    // One provider, reached from its card on the sources page.
    await read(`document.querySelector('[data-page="sources"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await read(`!!document.querySelector('[data-source="xunlei"]')`)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await read(`document.querySelector('[data-source="xunlei"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const xunleiCount = await read('document.querySelectorAll(".taskrow, #job-list .job").length');
    assert.strictEqual(Number(xunleiCount), 2, 'Xunlei filter should show exactly 2 tasks');
    const xunleiOnly = JSON.parse(
      await read(`JSON.stringify(Array.from(document.querySelectorAll('.taskrow')).map((r) => !!r.querySelector('.source')?.textContent.startsWith('迅雷云盘')))`)
    );
    assert(xunleiOnly.every(Boolean), 'Provider filter must only render tasks of that provider');
    report.assertionsPassed += 2;

    // The phase filter must replace, not stack on, the source filter
    await read(`document.querySelectorAll('#filters .sideitem')[3]?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const humanStates = JSON.parse(
      await read(`JSON.stringify(Array.from(document.querySelectorAll('.taskrow')).map((r) => r.dataset.state))`)
    );
    assert(humanStates.length >= 3, `Phase filter should list every needs-human task, got ${humanStates.length}`);
    assert(humanStates.every((state) => state === 'needs-human'), 'Phase filter must not mix phases');
    assert.strictEqual(
      Number(await read(`document.querySelectorAll('[data-source].active, [data-source-kind].active').length`)),
      0,
      'Phase filter must clear the source filter'
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
      await read(`JSON.stringify(Array.from(document.querySelectorAll('#filters .sideitem, .sidebar [data-source-kind]')).map((b) => {
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
    fs.writeFileSync(imgPath900Detail, (await shoot(win)).toPNG());
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

    // What a user can tell apart without opening anything, in the order the
    // spec's user stories ask for it: five states, a stall, a diagnosis, a batch
    // action, two kinds of empty, and the capability table.

    report.fiveStates = await assertFiveStates(read, win);
    report.stalled = await assertStalled(read, win);
    report.diagnostic = await assertDiagnostic(read, win);
    report.batch = await assertBatchActions(read, win);
    report.purgeUnpersisted = await assertPurgeUnpersistedFailure(read, win, tasks);
    report.emptyStates = await assertEmptyStates(read, win);
    report.providerHealth = await assertProviderHealth(read, win);

    // The sources page is where the per-netdisk facts live now, so it gets a
    // picture too. A layout that breaks there is a layout that breaks.
    await read(`document.querySelector('[data-page="sources"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const sourcesTitle = await read(`document.getElementById('page-title')?.textContent.trim() || ''`);
    assert.strictEqual(sourcesTitle, '下载来源', `The sources page must be the one on screen, got "${sourcesTitle}"`);
    // The probe window is never shown, so the compositor can hand back the last
    // painted frame. A size change is what makes it paint again.
    const probeSize = win.getSize();
    win.setSize(probeSize[0] + 40, probeSize[1] + 20);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const imgPathSources = path.join(os.tmpdir(), 'linkswift-probe-sources.png');
    fs.writeFileSync(imgPathSources, (await win.webContents.capturePage()).toPNG());
    win.setSize(probeSize[0], probeSize[1]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    report.screenshots.push(imgPathSources);
    await read(`document.querySelector('[data-page="tasks"]')?.click()`);

    // The engine list is one row per category, and only a category with a
    // real choice gets a dropdown. Anything else would let the user pick a
    // combination the engines cannot run.
    await read(`document.querySelector('[data-page="settings"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await read(`document.querySelector('[data-settingtab="media"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const engineRows = JSON.parse(
      await read(`JSON.stringify(Array.from(document.querySelectorAll('#engine-overrides .enginerow')).map((row) => ({
        label: row.querySelector('.enginelabel')?.textContent.trim() || '',
        value: row.querySelector('.enginevalue')?.textContent.trim() || '',
        select: row.querySelector('select')?.id || '',
      })))`)
    );
    assert.deepStrictEqual(
      engineRows.map((row) => row.label),
      ['网盘', '媒体', '直链'],
      `The engine list must have one row per category, got ${engineRows.map((row) => row.label)}`
    );
    assert.strictEqual(engineRows[0].value, 'aria2', 'The 网盘 row must state its engine');
    assert.strictEqual(engineRows[1].value, 'yt-dlp', 'The 媒体 row must state its engine');
    assert.strictEqual(engineRows[2].select, 'engine-direct', 'Only 直链 has a real choice, so only it gets a dropdown');
    const imgPathMedia = path.join(os.tmpdir(), 'linkswift-probe-media-settings.png');
    fs.writeFileSync(imgPathMedia, (await shoot(win)).toPNG());
    report.screenshots.push(imgPathMedia);
    await read(`document.querySelector('[data-page="tasks"]')?.click()`);

    report.assertionsPassed +=
      report.fiveStates.passed +
      report.stalled.passed +
      report.diagnostic.passed +
      report.batch.passed +
      report.purgeUnpersisted.passed +
      report.emptyStates.passed +
      report.providerHealth.passed;

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

/* ------------------------------------------------------------------ Spec 001 UI --- */

/**
 * Every helper below runs against the fixtures pushed above, on the real
 * renderer. A helper returns how many assertions it passed and throws on the
 * first one that does not hold, so `npm run check` names the broken contract.
 */

/** The five states a user has to tell apart, each on its own row. */
async function assertFiveStates(read, win) {
  const rows = JSON.parse(
    await read(`JSON.stringify(Array.from(document.querySelectorAll(".taskrow")).map((row) => ({
      id: row.dataset.jobId,
      phase: row.dataset.phase || "",
      label: row.querySelector(".status")?.textContent.trim() || "",
    })))`)
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const expected = [
    ['fixture-quark-downloading', '下载中'],
    ['fixture-uc-paused', '已暂停'],
    ['fixture-xunlei-human-manual', '需你操作一步'],
    ['fixture-diagnosis', '已失败'],
    ['fixture-partial-done', '部分完成 1 失败 / 2 完成'],
  ];
  const seen = new Map();
  for (const [id, label] of expected) {
    const row = byId.get(id);
    assert(row, `Every state must have its own row, ${id} is missing`);
    assert(row.phase, `${id} must carry data-phase`);
    assert.strictEqual(row.label, label, `${id} must read "${label}", reads "${row.label}"`);
    assert(!seen.has(row.phase), `Two states share the same data-phase "${row.phase}"`);
    seen.set(row.phase, label);
  }

  // Which one needs the user must be readable without opening anything, and the
  // action that unblocks it has to be on the row.
  const manualRow = byId.get('fixture-xunlei-human-manual');
  const manualActions = await read(
    `JSON.stringify(Array.from(document.querySelector('[data-job-id="fixture-xunlei-human-manual"]').querySelectorAll("button")).map((b) => b.getAttribute("aria-label") || b.textContent.trim()))`
  );
  assert(manualActions.includes('打开我的云盘'), `A needs-human row must carry its action, got ${manualActions}`);

  return { passed: 4, phases: Object.fromEntries(seen), manualLabel: manualRow.label, archivedHidden: true };
}

/** A stall is a flag on a running download, with a retry the user can press. */
async function assertStalled(read) {
  const stall = JSON.parse(
    await read(`JSON.stringify((() => {
      const box = document.querySelector('.taskrow[data-job-id="fixture-stalled"] .stall-notice');
      if (!box) return null;
      const retry = Array.from(box.querySelectorAll("button")).find((b) => (b.getAttribute("aria-label") || "").startsWith("重试"));
      return { text: box.textContent.trim(), retry: Boolean(retry), disabled: retry ? retry.disabled : true };
    })())`)
  );
  assert(stall, 'A stalled download must show .stall-notice on its row');
  assert(stall.text.includes('可能已停滞'), `The notice must say it stalled, reads "${stall.text}"`);
  assert(stall.retry && !stall.disabled, 'The notice must offer a clickable retry');
  return { passed: 2, stall };
}

/** A failure names the step that broke and offers copy + retry. */
async function assertDiagnostic(read) {
  const row = JSON.parse(
    await read(`JSON.stringify((() => {
      const box = document.querySelector('.taskrow[data-job-id="fixture-diagnosis"] .diagnostic');
      if (!box) return null;
      const labels = Array.from(box.querySelectorAll("button")).map((b) => b.getAttribute("aria-label") || "");
      return {
        text: box.textContent,
        step: box.querySelector(".diagnostic-step")?.textContent || "",
        selector: box.querySelector(".diagnostic-selector")?.textContent || "",
        hint: box.querySelector(".diagnostic-hint")?.textContent || "",
        copy: labels.some((l) => l.startsWith("复制诊断")),
        retry: labels.some((l) => l.startsWith("重试")),
      };
    })())`)
  );
  assert(row, 'A failed job must show .diagnostic on its row');
  assert.strictEqual(row.step, '第 3 步：wait-for', `The diagnostic must name the step, reads "${row.step}"`);
  assert.strictEqual(row.selector, '.x-button-box', 'The diagnostic must name the target it could not find');
  assert(row.hint.includes('重试'), `The diagnostic must say what fixes it, reads "${row.hint}"`);
  assert(row.copy && row.retry, 'The diagnostic must offer copy and retry');

  // The detail panel has to carry the same information, including the script the
  // page ran, or the report cannot be sent to anyone.
  await read(`Array.from(document.querySelector('.taskrow[data-job-id="fixture-diagnosis"]').querySelectorAll("button")).find((b) => (b.getAttribute("aria-label") || "").startsWith("查看"))?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const drawer = JSON.parse(
    await read(`JSON.stringify((() => {
      const node = document.getElementById("drawer");
      return {
        step: node?.querySelector(".diagnostic-step")?.textContent || "",
        text: node?.textContent || "",
        copy: Array.from(node?.querySelectorAll("button") || []).some((b) => (b.getAttribute("aria-label") || "").startsWith("复制诊断")),
        retry: Array.from(node?.querySelectorAll("button") || []).some((b) => (b.getAttribute("aria-label") || "").startsWith("重新获取直链")),
      };
    })())`)
  );
  assert.strictEqual(drawer.step, '第 3 步：wait-for', 'The detail panel must name the failed step');
  assert(drawer.text.includes('1.0.3') && drawer.text.includes('upstream'), 'The detail panel must name the script version that ran');
  assert(drawer.copy && drawer.retry, 'The detail panel must offer copy and retry');
  await read(`document.querySelector('#drawer .drawerheader button')?.click()`);
  return { passed: 7, row, drawerStep: drawer.step };
}

/** Selecting rows exposes a batch bar with the actions those rows can take. */
async function assertBatchActions(read) {
  const before = await read(`Boolean(document.getElementById("selection-actions")?.hidden)`);
  assert.strictEqual(before, true, 'The batch bar must stay hidden while nothing is selected');

  await read(`(() => {
    for (const id of ["fixture-quark-downloading", "fixture-uc-paused"]) {
      const box = document.querySelector('.taskrow[data-job-id="' + id + '"] input.job-select');
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));

  const bar = JSON.parse(
    await read(`JSON.stringify((() => {
      const node = document.getElementById("selection-actions");
      return {
        hidden: node.hidden,
        bulkClass: node.classList.contains("bulk-bar"),
        labels: Array.from(node.querySelectorAll("button")).filter((b) => !b.hidden).map((b) => b.textContent.trim()),
      };
    })())`)
  );
  assert.strictEqual(bar.hidden, false, 'Selecting a row must reveal the batch bar');
  assert(bar.bulkClass, 'The batch bar must be the .bulk-bar element');
  assert(bar.labels.includes('归档') && bar.labels.includes('删除'), `The batch bar must offer 归档 and 删除, got ${bar.labels}`);

  // De-selecting puts it away again.
  await read(`(() => {
    for (const box of document.querySelectorAll(".taskrow input.job-select")) {
      if (!box.checked) continue;
      box.checked = false;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(
    await read(`Boolean(document.getElementById("selection-actions")?.hidden)`),
    true,
    'The batch bar must go away when nothing is selected'
  );
  return { passed: 5, bar };
}

/** F-112 regression: purge unpersisted failure jobs and verify feedback, UI removal, and active-job protection */
async function assertPurgeUnpersistedFailure(read, win, tasks) {
  let passed = 0;

  // 1. Unpersisted failed job (no files, phase: failed)
  const unpersistedJob = {
    id: 'fixture-unpersisted-failed',
    createdAt: Date.now(),
    link: { provider: 'quark', originalUrl: 'https://pan.quark.cn/s/unpersistedfail' },
    state: { phase: 'failed', code: 'parse_failed', message: '解析链接失败，未获取文件列表' },
  };
  win.webContents.send(PUSH.jobEvent, unpersistedJob);
  await new Promise((resolve) => setTimeout(resolve, 300));

  const unpersistedRowBefore = await read(`Boolean(document.querySelector('.taskrow[data-job-id="fixture-unpersisted-failed"]'))`);
  assert.strictEqual(unpersistedRowBefore, true, 'Unpersisted failure row must be rendered in UI');
  passed++;

  // Select only this unpersisted failed job
  await read(`(() => {
    for (const box of document.querySelectorAll(".taskrow input.job-select")) {
      box.checked = false;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const box = document.querySelector('.taskrow[data-job-id="fixture-unpersisted-failed"] input.job-select');
    if (box) {
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Click delete
  await read(`document.getElementById("selected-purge")?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const toast1 = await read(`document.getElementById("toast")?.textContent.trim() || ""`);
  assert.strictEqual(toast1, '已从列表移除 1 个任务', `Single unpersisted delete feedback must be '已从列表移除 1 个任务', got '${toast1}'`);
  passed++;

  const unpersistedRowAfter = await read(`Boolean(document.querySelector('.taskrow[data-job-id="fixture-unpersisted-failed"]'))`);
  assert.strictEqual(unpersistedRowAfter, false, 'Unpersisted failure row must be removed from UI after purge');
  passed++;

  const taskStoreHasUnpersisted = tasks.all().some((t) => t.id === 'fixture-unpersisted-failed');
  assert.strictEqual(taskStoreHasUnpersisted, false, 'TaskStore must not hold unpersisted job');
  passed++;

  // 2. Batch delete: 1 persisted done job + 1 unpersisted failed job
  const persistedDoneJob = {
    id: 'fixture-persisted-done-1',
    createdAt: Date.now(),
    link: { provider: 'quark', originalUrl: 'https://pan.quark.cn/s/persisteddone' },
    files: [{ name: 'file-done.zip', size: 1024 }],
    state: { phase: 'done', files: [{ name: 'file-done.zip', size: 1024, complete: true }] },
  };
  tasks.save({
    id: persistedDoneJob.id,
    createdAt: persistedDoneJob.createdAt,
    link: persistedDoneJob.link,
    files: persistedDoneJob.files,
    state: persistedDoneJob.state,
  });

  const unpersistedJob2 = {
    id: 'fixture-unpersisted-failed-2',
    createdAt: Date.now(),
    link: { provider: 'baidu', originalUrl: 'https://pan.baidu.com/s/unpersistedfail2' },
    state: { phase: 'failed', code: 'network_error', message: '网络连接超时' },
  };

  win.webContents.send(PUSH.jobEvent, persistedDoneJob);
  win.webContents.send(PUSH.jobEvent, unpersistedJob2);
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Select both jobs
  await read(`(() => {
    for (const box of document.querySelectorAll(".taskrow input.job-select")) {
      box.checked = false;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
    for (const id of ["fixture-persisted-done-1", "fixture-unpersisted-failed-2"]) {
      const box = document.querySelector('.taskrow[data-job-id="' + id + '"] input.job-select');
      if (box) {
        box.checked = true;
        box.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Click delete
  await read(`document.getElementById("selected-purge")?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const toast2 = await read(`document.getElementById("toast")?.textContent.trim() || ""`);
  assert.strictEqual(
    toast2,
    '已删除 1 个持久化记录，并从列表移除 1 个临时任务',
    `Mixed batch delete feedback must differentiate persisted vs unpersisted, got '${toast2}'`
  );
  passed++;

  const rowDoneAfter = await read(`Boolean(document.querySelector('.taskrow[data-job-id="fixture-persisted-done-1"]'))`);
  const rowFailAfter = await read(`Boolean(document.querySelector('.taskrow[data-job-id="fixture-unpersisted-failed-2"]'))`);
  assert.strictEqual(rowDoneAfter, false, 'Persisted done job must be removed from UI');
  assert.strictEqual(rowFailAfter, false, 'Unpersisted failure job must be removed from UI');
  passed += 2;

  const taskStoreHasPersisted = tasks.all().some((t) => t.id === 'fixture-persisted-done-1');
  assert.strictEqual(taskStoreHasPersisted, false, 'Persisted done job must be removed from TaskStore');
  passed++;

  // 3. Active job cannot be purged
  await read(`(() => {
    for (const box of document.querySelectorAll(".taskrow input.job-select")) {
      box.checked = false;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const box = document.querySelector('.taskrow[data-job-id="fixture-quark-downloading"] input.job-select');
    if (box) {
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 200));

  await read(`document.getElementById("selected-purge")?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const toast3 = await read(`document.getElementById("toast")?.textContent.trim() || ""`);
  assert.strictEqual(
    toast3,
    '勾选的任务里没有已结束（完成或失败）的任务可供删除',
    `Active job purge attempt must be rejected with notice, got '${toast3}'`
  );
  passed++;

  const activeRowStillPresent = await read(`Boolean(document.querySelector('.taskrow[data-job-id="fixture-quark-downloading"]'))`);
  assert.strictEqual(activeRowStillPresent, true, 'Active downloading job must not be purged');
  passed++;

  // Clear selections
  await read(`(() => {
    for (const box of document.querySelectorAll(".taskrow input.job-select")) {
      box.checked = false;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
  })()`);

  return { passed };
}

/** An empty filter and an empty list say different things and differ in what they offer. */
async function assertEmptyStates(read) {
  await read(`(() => {
    const s = document.getElementById("search");
    s.value = "no-such-task-anywhere";
    s.dispatchEvent(new Event("input"));
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const filteredEmpty = JSON.parse(
    await read(`JSON.stringify((() => {
      const node = document.querySelector(".empty");
      return { heading: node?.querySelector("h3")?.textContent || "", buttons: Array.from(node?.querySelectorAll("button") || []).map((b) => b.textContent.trim()) };
    })())`)
  );
  assert.strictEqual(filteredEmpty.heading, '筛选为空', `An empty filter must say 筛选为空, reads "${filteredEmpty.heading}"`);
  assert(filteredEmpty.buttons.includes('清空筛选'), `An empty filter must offer 清空筛选, got ${filteredEmpty.buttons}`);

  const before = Number(await read('document.querySelectorAll(".taskrow").length'));
  await read(`Array.from(document.querySelectorAll(".empty button")).find((b) => b.textContent.trim() === "清空筛选")?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = Number(await read('document.querySelectorAll(".taskrow").length'));
  assert(before === 0 && after > 0, `Clearing the filter must bring the list back, went ${before} -> ${after}`);

  await read(`document.querySelector('.taskrow[data-job-id="fixture-quark-downloading"] input.job-select')?.dispatchEvent(new Event("change", { bubbles: true }))`);
  await read(`document.getElementById("archive-toggle")?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const archiveRows = JSON.parse(
    await read(`JSON.stringify(Array.from(document.querySelectorAll(".taskrow")).map((row) => row.dataset.jobId))`)
  );
  assert(archiveRows.includes('fixture-archived'), 'The archive view must hold the archived job');
  assert(!archiveRows.includes('fixture-quark-downloading'), 'The archive view must not hold live jobs');

  await read(`document.getElementById("archive-toggle")?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const taskRows = JSON.parse(
    await read(`JSON.stringify(Array.from(document.querySelectorAll(".taskrow")).map((row) => row.dataset.jobId))`)
  );
  assert(!taskRows.includes('fixture-archived'), 'The main list must not hold archived jobs');
  return { passed: 6, filteredEmpty, archiveRows: archiveRows.length, taskRows: taskRows.length };
}

/** The sources page says what each netdisk can do and what happened here last. */
async function assertProviderHealth(read) {
  await read(`document.querySelector('[data-page="sources"]')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const health = JSON.parse(
    await read(`JSON.stringify({
      cards: Array.from(document.querySelectorAll("#source-list [data-source-card]")).map((card) => ({
        provider: card.dataset.sourceCard,
        grade: card.querySelector('.sourcegrade')?.textContent.trim() || '',
        health: card.querySelector('.sourcehealth')?.textContent.trim() || '',
      })),
      groups: Array.from(document.querySelectorAll('#source-list .sourcegrouphead')).map((h) => h.textContent.trim()),
    })`)
  );
  const netdisks = health.cards.filter((card) => ['quark', 'baidu', 'uc', 'xunlei'].includes(card.provider));
  assert.deepStrictEqual(
    netdisks.map((card) => card.provider),
    ['quark', 'baidu', 'uc', 'xunlei'],
    `The sources page must list all four netdisks, got ${netdisks.map((card) => card.provider)}`
  );
  for (const card of netdisks) {
    assert(card.grade, `${card.provider} must name its capability`);
    assert.strictEqual(card.health, '本机还没跑过', `${card.provider} has no real run yet, must say so, reads "${card.health}"`);
  }
  assert.deepStrictEqual(
    health.groups,
    ['网盘', '媒体', '直链'],
    `The sources page must group by category, got ${health.groups}`
  );

  // The archive management has its own settings tab now. The per-netdisk
  // facts live on the sources page, so the table must not be here twice.
  await read(`document.querySelector('[data-page="settings"]')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await read(`document.querySelector('[data-settingtab="archive"]')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const archive = JSON.parse(
    await read(`JSON.stringify({
      archiveCount: document.getElementById("archive-count")?.textContent || "",
      clearArchive: Boolean(document.getElementById("clear-archive")),
      healthTable: Boolean(document.getElementById("provider-health-body")),
    })`)
  );
  assert.strictEqual(archive.archiveCount, '1', `The archive count must match the archived job, reads "${archive.archiveCount}"`);
  assert(archive.clearArchive, 'The settings page must offer 清空归档');
  assert.strictEqual(archive.healthTable, false, 'The per-netdisk capability table must not be duplicated in the settings page');

  await read(`document.querySelector('[data-page="tasks"]')?.click()`);
  // 1 ordering + 4 netdisks x 2 + 1 grouping + 3 archive assertions.
  return { passed: 13, rows: netdisks.length, archiveCount: archive.archiveCount };
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
