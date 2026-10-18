'use strict';

// Capture the live app window over CDP so the evidence is the real renderer, not
// the probe fixture.   node tools/probe/cdp-shot.js <port> <outFile>

const fs = require('node:fs');

const [, , portArg, outFile] = process.argv;
const port = portArg || '9222';

(async () => {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = pages.find((entry) => entry.url.includes('index.html'));
  if (!page) {
    console.error('renderer page not found');
    process.exit(2);
  }
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id !== 1) return;
    if (!data.result || !data.result.data) {
      console.error('capture failed', JSON.stringify(data).slice(0, 200));
      process.exit(1);
    }
    fs.writeFileSync(outFile, Buffer.from(data.result.data, 'base64'));
    console.log('saved', outFile);
    process.exit(0);
  };
})();
