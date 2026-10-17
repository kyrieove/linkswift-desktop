// Submit a pasted string through the real composer and follow the job to a terminal phase.
//   node tools/probe/cdp-submit.js "<pasted text>" [waitSeconds]
// The app must be started with: npx electron . --remote-debugging-port=9222
const [, , text = '', waitArg = '90'] = process.argv;
const waitMs = Number(waitArg) * 1000;

const pages = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = pages.find((entry) => entry.url.endsWith('renderer/index.html'));
if (!page) {
  console.error('找不到渲染页。现有：\n' + pages.map((p) => p.url).join('\n'));
  process.exit(2);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

socket.onmessage = (message) => {
  const data = JSON.parse(message.data);
  const entry = pending.get(data.id);
  if (entry) {
    pending.delete(data.id);
    entry(data);
  }
};

function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (data) => {
      if (data.result?.exceptionDetails) reject(new Error(JSON.stringify(data.result.exceptionDetails)));
      else resolve(data.result?.result?.value);
    });
    socket.send(
      JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }),
    );
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await new Promise((resolve) => (socket.onopen = resolve));

const before = await evaluate('document.querySelectorAll("#job-list .job").length');
await evaluate(`(function () {
  const input = document.getElementById('link-input');
  input.value = ${JSON.stringify(text)};
  document.getElementById('composer-error').hidden = true;
  document.getElementById('submit-form').requestSubmit();
  return 'submitted';
})()`);
await sleep(600);

const composerError = await evaluate(
  `(function () { const n = document.getElementById('composer-error'); return n.hidden ? '' : n.textContent; })()`,
);
const inputValue = await evaluate('document.getElementById("link-input").value');
const rowsAfter = await evaluate('document.querySelectorAll("#job-list .job").length');
console.log(JSON.stringify({ inputValue, composerError, rowsBefore: before, rowsAfter }, null, 1));

const readNewest = `(function () {
  const rows = document.querySelectorAll('#job-list .job');
  const row = rows[0];
  if (!row) return null;
  const chip = row.querySelector('.chip');
  return JSON.stringify({ chip: chip ? chip.textContent : '', text: row.textContent.slice(0, 900) });
})()`;

let last = '';
const deadline = Date.now() + waitMs;
while (Date.now() < deadline) {
  const raw = await evaluate(readNewest);
  if (raw && raw !== last) {
    last = raw;
    console.log(raw);
  }
  if (raw && /已完成|失败/.test(JSON.parse(raw).chip)) break;
  await sleep(2000);
}

socket.close();
process.exit(0);
