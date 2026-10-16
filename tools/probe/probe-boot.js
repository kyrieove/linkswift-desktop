'use strict';

/**
 * Boot the real integration stack against a local fixture and report what
 * happened.
 *
 * It exercises the actual code paths, not stand-ins: the real Store, the real
 * UserscriptSource, the real vendor files, the real JobManager, the real
 * netdisk preload and the real 810 KB userscript.
 *
 * The fixture is served on 127.0.0.1 but reached as pan.quark.cn through a host
 * resolver rule, so the preload's own host check runs for real.
 *
 *   npm run probe:boot
 *
 * The report is written to a file because stdout capture for a GUI subsystem
 * process is unreliable through a shell pipeline.
 */

const { app, ipcMain, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { INTERNAL } = require('../../src/shared/protocol');
const { Store } = require('../../src/main/store');
const { UserscriptSource } = require('../../src/main/userscript');
const { JobManager } = require('../../src/main/job');
const { loadVendor } = require('../../src/main/vendor');
const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(
  __dirname,
  process.argv.includes('--react') ? 'fixture-quark-react.html' : 'fixture-quark.html',
);
const REPORT_PATH = path.join(os.tmpdir(), 'linkswift-boot-report.json');

// Electron quits by default once every window closes. A job window is destroyed
// when its job settles, so without this the probe would exit before reporting.
app.on('window-all-closed', () => {});
const TRACE_PATH = path.join(os.tmpdir(), 'linkswift-boot-trace.log');
const WAIT_MS = 25000;

app.commandLine.appendSwitch('host-resolver-rules', 'MAP pan.quark.cn 127.0.0.1');

/** @type {any[]} */
const observations = [];

function trace(label) {
  fs.appendFileSync(TRACE_PATH, `${new Date().toISOString()} ${label}\n`);
}

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(fs.readFileSync(FIXTURE));
});

async function run() {
  fs.writeFileSync(TRACE_PATH, '', 'utf8');
  trace('run:start');

  await app.whenReady();
  trace('app:ready');
  // The preload is registered on the session, the way the app does it. Registering
  // it per window as well would run two instances that race each other.
  const probePartition = 'persist:linkswift-probe';
  const probePreload = path.join(ROOT, 'src', 'preload', 'netdisk-preload.js');
  session.fromPartition(probePartition).registerPreloadScript({
    id: 'probe-netdisk-boot',
    type: 'frame',
    filePath: probePreload,
  });


  const port = server.address().port;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-probe-'));
  const store = new Store(userDataDir);
  trace('store:ready');

  const userscript = new UserscriptSource({
    userDataDir,
    bundledPath: path.join(ROOT, 'resources', 'userscript.user.js'),
  });
  const script = userscript.get();
  trace(`userscript:ready version=${script.version} origin=${script.origin}`);

  const { vendor, resources } = loadVendor(ROOT);
  trace('vendor:ready');

  const jobs = new JobManager({
    store,
    userscript,
    vendor,
    resources,
    partition: probePartition,
    preloadPath: path.join(ROOT, 'src', 'preload', 'netdisk-preload.js'),
    emit: () => {},
  });
  trace('jobmanager:ready');

  // JobManager also listens on this channel. Adding a listener first records
  // everything without changing behaviour.
  ipcMain.on(INTERNAL.observation, (_event, observation) => {
    observations.push(observation);
  });
  jobs.register(ipcMain);

  const result = jobs.submit(`http://pan.quark.cn:${port}/s/FIXTURESHARE`);
  trace(`submit:${JSON.stringify(result)}`);
  const job = jobs.jobs.get(result.jobId);

  const consoleMessages = [];
  job.window.webContents.on('console-message', (event) => {
    consoleMessages.push(`[console:${event.level}] ${String(event.message).slice(0, 300)}`);
  });
  job.window.webContents.on('did-fail-load', (_event, code, description, url) => {
    consoleMessages.push(`[did-fail-load] ${code} ${description} ${url}`);
  });
  job.window.webContents.on('preload-error', (_event, preloadPath, error) => {
    consoleMessages.push(`[preload-error] ${preloadPath} ${error.message}`);
  });

  // A job window is destroyed the moment its job settles, so the page state has
  // to be read while the job is still running. Wait for the injection to land,
  // snapshot then, and only afterwards wait out the rest of the flow.
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && !observations.some((o) => o.kind === 'injected')) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // The driver reaches its click about 1.3s after injection, and the resulting
  // dialog settles the job and destroys this window, so sample early.
  await new Promise((resolve) => setTimeout(resolve, 200));
  trace('snapshot:page-state');

  const read = async (expression) => {
    try {
      return await job.window.webContents.executeJavaScript(expression);
    } catch (error) {
      return `ERROR: ${error.message}`;
    }
  };

  const pageState = {
    loadedUrl: await read('location.href'),
    hostname: await read('location.hostname'),
    mainWorld: {
      jQuery: await read('typeof window.jQuery'),
      dollar: await read('typeof window.$'),
      Swal: await read('typeof window.Swal'),
      md5: await read('typeof window.md5'),
      GM_xmlhttpRequest: await read('typeof window.GM_xmlhttpRequest'),
      GM_info_version: await read('window.GM_info && window.GM_info.script.version'),
      shimInstalled: await read('window.__linkswiftShimInstalled === true'),
      unsafeWindowIsWindow: await read('typeof unsafeWindow === "undefined" ? "not-defined" : (unsafeWindow === window)'),
      // The userscript's re-entry guard key, matched by prefix so this probe does
      // not depend on a literal that survives file re-encoding.
      userscriptReentryGuard: await read('Object.keys(window).some((k) => k.startsWith("LinkSwift"))'),
    },
    dom: {
      scriptButton: await read('Boolean(document.querySelector(\'.pl-button-mode[data-mode="aria2"]\'))'),
      buttonCount: await read('document.querySelectorAll(".pl-button-mode").length'),
      initButtonPresent: await read('Boolean(document.querySelector(".pl-button-init"))'),
      checkboxWrappers: await read('document.querySelectorAll(".file-list .ant-checkbox-wrapper").length'),
    },
  };

  const remaining = Math.max(0, deadline - Date.now());
  await new Promise((resolve) => setTimeout(resolve, remaining));
  trace(`waited:${WAIT_MS}ms`);

  const report = {
    scriptSource: { version: script.version, origin: script.origin, chars: script.source.length },
    submitResult: result,
    finalState: job.state,
    pageState,
    observationKinds: observations.reduce((counts, observation) => {
      counts[observation.kind] = (counts[observation.kind] ?? 0) + 1;
      return counts;
    }, {}),
    driverResult: observations.find((observation) => observation.kind === 'driver-result') ?? null,
    dialogs: observations.filter((observation) => observation.kind === 'dialog').map((observation) => observation.text),
    scriptErrors: observations
      .filter((observation) => observation.kind === 'script-error')
      .map((observation) => observation.message),
    httpRequests: observations
      .filter((observation) => observation.kind === 'http')
      .map((observation) => `${observation.method} ${observation.url}`),
    consoleMessages,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  trace('report:written');
}

server.listen(0, '127.0.0.1', () => {
  run()
    .then(() => {
      server.close();
      app.exit(0);
    })
    .catch((error) => {
      fs.writeFileSync(REPORT_PATH, JSON.stringify({ fatal: String((error && error.stack) || error) }, null, 2), 'utf8');
      server.close();
      app.exit(1);
    });
});
