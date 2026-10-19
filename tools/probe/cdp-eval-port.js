'use strict';

/**
 * Evaluate one expression in the real app's renderer over CDP.
 *
 *   node tools/probe/cdp-eval-port.js 9223 "<expression>"
 *
 * The bundled cdp-eval.js targets a fixed port and the main window; this one
 * takes the port and can address any target by URL substring, which is what the
 * acceptance run needs for the hidden netdisk windows too.
 */

const args = process.argv.slice(2);
const port = Number(args[0] || 9223);
const expression = args[1] || '';
const match = args[2] || 'renderer/index.html';

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((entry) => entry.type === 'page' && entry.url.includes(match));
  if (!target) {
    console.error(`no page target matching "${match}"; have: ${list.map((e) => e.url).join(' | ')}`);
    process.exit(2);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const result = await new Promise((resolve, reject) => {
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    };
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
    setTimeout(() => reject(new Error('timeout')), 20000);
  });
  ws.close();
  if (result.exceptionDetails) {
    console.error('EXCEPTION: ' + JSON.stringify(result.exceptionDetails.exception || result.exceptionDetails));
    process.exit(1);
  }
  const value = result.result.value;
  console.log(typeof value === 'string' ? value : JSON.stringify(value));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
