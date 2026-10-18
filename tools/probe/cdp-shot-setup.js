'use strict';

// Screenshot the renderer, optionally after running a setup expression, using one
// CDP connection. Reusing one connection avoids the stale-frame captures the
// one-shot helper produced after a page reload.
//   node tools/probe/cdp-shot-setup.js <port> <outFile> [setupExpression]

const fs = require('node:fs');

const [, , portArg, outFile, setup] = process.argv;
const port = portArg || '9223';

(async () => {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = pages.find((entry) => entry.url.includes('index.html'));
  if (!page) {
    console.error('renderer page not found');
    process.exit(2);
  }

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(new Error(data.error.message));
    else entry.resolve(data.result);
  };

  socket.onopen = async () => {
    try {
      await send('Page.enable');
      if (setup) {
        await send('Runtime.evaluate', { expression: setup, returnByValue: true, awaitPromise: true });
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      // Force a fresh frame before capturing.
      await send('Runtime.evaluate', { expression: 'document.body.offsetHeight, window.scrollTo(0,0), 1' });
      const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
      console.log('saved', outFile, fs.statSync(outFile).size, 'bytes');
      process.exit(0);
    } catch (err) {
      console.error('capture failed:', err.message);
      process.exit(1);
    }
  };
})();
