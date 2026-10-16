const { app, BrowserWindow, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const pagePath = path.join(__dirname, 'page2.html');
const preloadPath = path.join(__dirname, 'probe-preload.js');
const throttling = process.argv.includes('--no-throttle') ? false : true;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(pagePath));
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  await app.whenReady();

  const partition = `persist:probe3-${throttling}`;
  const ses = session.fromPartition(partition);
  ses.registerPreloadScript({ id: `p3-${throttling}`, type: 'frame', filePath: preloadPath });

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: { partition, contextIsolation: true, sandbox: true, backgroundThrottling: throttling },
  });

  const read = async (expression) => {
    try { return await win.webContents.executeJavaScript(expression); }
    catch (error) { return { error: String(error) }; }
  };

  await win.loadURL(`http://127.0.0.1:${port}/page2.html`);
  await wait(3000);
  const hiddenNeverShown = await read('window.__ticks');

  await read('window.__ticks = 0');
  win.show();
  await wait(3000);
  const shown = await read('window.__ticks');

  await read('window.__ticks = 0');
  win.hide();
  await wait(6000);
  const hiddenAfterShow = await read('window.__ticks');
  const state = await read('document.visibilityState');

  console.log('PROBE3_JSON_BEGIN');
  console.log(JSON.stringify({
    backgroundThrottlingConfigured: win.webContents.getBackgroundThrottling(),
    expectedTicksPerSecond: 10,
    hiddenNeverShownTicksIn3s: hiddenNeverShown,
    shownTicksIn3s: shown,
    hiddenAfterShowTicksIn6s: hiddenAfterShow,
    hiddenAfterShowVisibility: state,
  }, null, 2));
  console.log('PROBE3_JSON_END');
  server.close();
  app.exit(0);
});
