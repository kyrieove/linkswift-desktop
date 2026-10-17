// Run JS inside a page of the running app and print the result.
//   node tools/probe/cdp-eval.js <url-substring> "<expression>"
// The app must be started with: npx electron . --remote-debugging-port=9222
// Set CDP_PORT to target another DevTools endpoint, for example 9223 for a
// WebView2 app started with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS.
// Page list: http://127.0.0.1:9222/json  (renderer = index.html, share page = pan.quark.cn / pan.baidu.com)
const [, , match, expression] = process.argv;
const port = process.env.CDP_PORT || '9222';

(async () => {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = pages.find((entry) => entry.url.includes(match));
  if (!page) {
    console.error(`没有 URL 含 "${match}" 的页面。现有：\n${pages.map((p) => p.url).join('\n')}`);
    process.exit(2);
  }
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.onopen = () =>
    socket.send(
      JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }),
    );
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id !== 1) return;
    console.log(JSON.stringify(data.result?.result?.value ?? data, null, 1).slice(0, 4000));
    process.exit(0);
  };
})();
