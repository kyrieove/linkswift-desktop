const { app, BrowserWindow, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const pagePath = path.join(__dirname, 'page2.html');
const preloadPath = path.join(__dirname, 'probe-preload.js');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(pagePath));
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  await app.whenReady();

  const partition = 'persist:linkswift-probe-http';
  const ses = session.fromPartition(partition);
  ses.registerPreloadScript({ id: 'probe-preload-http', type: 'frame', filePath: preloadPath });

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: { partition, contextIsolation: true, sandbox: true },
  });

  const read = async (expression) => {
    try { return await win.webContents.executeJavaScript(expression); }
    catch (error) { return { error: String(error) }; }
  };

  await win.loadURL(`http://127.0.0.1:${port}/page2.html`);
  await wait(3000);

  const out = {};
  out.phaseHiddenNeverShown = {
    ticks: await read('window.__ticks'),
    visibilityState: await read('document.visibilityState'),
  };

  await read('window.__ticks = 0');
  win.show();
  await wait(3000);
  out.phaseShown = {
    ticks: await read('window.__ticks'),
    visibilityState: await read('document.visibilityState'),
  };

  await read('window.__ticks = 0');
  win.hide();
  await wait(6000);
  out.phaseHiddenAfterShow = {
    ticks: await read('window.__ticks'),
    visibilityState: await read('document.visibilityState'),
  };

  out.visibilityEvents = await read('JSON.stringify(window.__events)');
  out.documentCookie = await read('JSON.stringify(document.cookie)');
  out.sessionCookies = (await ses.cookies.get({})).map((c) => `${c.name}=${c.value}; domain=${c.domain}`);
  out.mainWorldWindowIdentity = await read('typeof window.unsafeWindow === "undefined" ? "no-unsafeWindow" : (unsafeWindow === window)');

  console.log('PROBE2_JSON_BEGIN');
  console.log(JSON.stringify(out, null, 2));
  console.log('PROBE2_JSON_END');
  server.close();
  app.exit(0);
});
