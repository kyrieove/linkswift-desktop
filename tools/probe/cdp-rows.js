'use strict';

// Read the rendered text of every task row plus the page summary from the live
// renderer over CDP. Quotes stay out of the shell command by living here.
//   node tools/probe/cdp-rows.js [port]

const port = process.argv[2] || process.env.CDP_PORT || '9222';

(async () => {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = pages.find((entry) => entry.url.includes('index.html'));
  if (!page) {
    console.error('renderer page not found');
    process.exit(2);
  }
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const expression = `JSON.stringify({
    title: document.title,
    summary: document.getElementById('task-summary') ? document.getElementById('task-summary').textContent : null,
    rows: Array.from(document.querySelectorAll('.taskrow')).map((row) => ({
      id: row.dataset.jobId,
      state: row.dataset.state,
      status: row.querySelector('.status') ? row.querySelector('.status').textContent.trim() : '',
      text: row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 180),
    })),
  })`;

  socket.onopen = () =>
    socket.send(
      JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })
    );
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id !== 1) return;
    console.log(data.result && data.result.result ? data.result.result.value : JSON.stringify(data));
    process.exit(0);
  };
  socket.onerror = (err) => {
    console.error('cdp error', err && err.message);
    process.exit(1);
  };
})();
