const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('node:path');

const preloadPath = path.join(__dirname, 'probe-preload.js');
let injectionReport = null;

ipcMain.on('injection-result', (_event, payload) => { injectionReport = payload; });

async function main() {
  const partition = 'persist:linkswift-probe';
  const ses = session.fromPartition(partition);

  const registrationId = ses.registerPreloadScript({
    id: 'linkswift-probe-preload',
    type: 'frame',
    filePath: preloadPath,
  });

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
    },
  });

  const out = {
    electronVersion: process.versions.electron,
    registerPreloadScriptReturnedId: registrationId,
    backgroundThrottlingDefault: win.webContents.getBackgroundThrottling(),
    setPreloadsStillPresent: typeof ses.setPreloads === 'function',
  };

  win.webContents.once('did-finish-load', async () => {
    await new Promise((resolve) => setTimeout(resolve, 6500));
    const read = async (expression) => {
      try { return await win.webContents.executeJavaScript(expression); }
      catch (error) { return { error: String(error) }; }
    };
    out.injectionReport = injectionReport;
    out.finalOrder = await read('JSON.stringify(window.__order)');
    out.finalProbe = await read('JSON.stringify(window.__probe)');
    out.timerTicksIn6sAt100ms = await read('window.__ticks');
    out.localStorageReadable = await read('localStorage.getItem("probe_ls")');
    out.cookieReadable = await read('JSON.stringify(document.cookie)');
    out.visibilityState = await read('document.visibilityState');
    console.log('PROBE_JSON_BEGIN');
    console.log(JSON.stringify(out, null, 2));
    console.log('PROBE_JSON_END');
    app.exit(0);
  });

  win.loadFile(path.join(__dirname, 'page.html'));
}

app.whenReady().then(main).catch((error) => {
  console.log('PROBE_JSON_BEGIN');
  console.log(JSON.stringify({ fatal: String(error) }, null, 2));
  console.log('PROBE_JSON_END');
  app.exit(1);
});
