'use strict';

// Send real mouse events to a page over CDP. Synthetic DOM clicks do not drive
// every dropdown in the netdisk UIs, so the probe needs actual input events.
//   node tools/probe/cdp-click.js <port> <url-substring> <x> <y> [--dbl]

const [, , portArg, match, xArg, yArg, dbl] = process.argv;
const port = portArg || '9222';
const x = Number(xArg);
const y = Number(yArg);

(async () => {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = pages.find((entry) => entry.url.includes(match));
  if (!page) {
    console.error(`no page matching "${match}"`);
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
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      if (dbl === '--dbl') {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 2 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 2 });
      }
      console.log(JSON.stringify({ clicked: { x, y, double: dbl === '--dbl' } }));
      process.exit(0);
    } catch (err) {
      console.error('click failed', err.message);
      process.exit(1);
    }
  };
})();
