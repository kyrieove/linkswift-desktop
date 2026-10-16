// Quit the running app gracefully through the debug port, so the session's cookies are flushed to disk.
// taskkill /F can lose a login made in the last few seconds.
//   node tools/probe/cdp-quit.js
(async () => {
  const { webSocketDebuggerUrl } = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const socket = new WebSocket(webSocketDebuggerUrl);
  socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  socket.onmessage = () => process.exit(0);
  setTimeout(() => process.exit(0), 3000);
})();
