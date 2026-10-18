'use strict';

/** Drive the running app over CDP through the two failure paths the user named. */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const INVALID = 'https://pan.baidu.com/s/1LBO1Kp3yHPYVFxukMC7YFQxxxxxxxx';
const VALID = 'https://pan.baidu.com/s/1LBO1Kp3yHPYVFxukMC7YFQ?pwd=c81v';
const CANCEL_DIR = 'D:\\2\\dev\\linkswift\\test_download\\cancel-probe';

async function connect() {
  const pages = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = pages.find((entry) => entry.type === 'page' && entry.url.includes('index.html'));
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)(data);
      pending.delete(data.id);
    }
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const evaluate = (expression) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, (data) => resolve(data.result?.result?.value));
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
  return { evaluate, close: () => socket.close() };
}

const FIRST_JOB = `JSON.stringify((() => {
  const row = document.querySelector('.job');
  if (!row) return null;
  return {
    chip: row.querySelector('.chip__label')?.textContent,
    buttons: Array.from(row.querySelectorAll('.job__actions button')).map((b) => b.textContent.trim()),
    text: row.querySelector('.job__body')?.innerText.replace(/\\n+/g, ' | ').slice(0, 300),
  };
})())`;

async function submit(evaluate, link) {
  await evaluate(`(() => {
    const input = document.getElementById('link-input');
    input.value = ${JSON.stringify(link)};
    document.getElementById('submit-btn').click();
    return true;
  })()`);
}

async function waitChip(evaluate, wanted, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let seen = null;
  while (Date.now() < deadline) {
    await sleep(1500);
    seen = JSON.parse((await evaluate(FIRST_JOB)) || 'null');
    if (seen && wanted.includes(seen.chip)) return seen;
  }
  return seen;
}

async function main() {
  const { evaluate, close } = await connect();
  try {
    // 1. 链接失效
    await submit(evaluate, INVALID);
    const failed = await waitChip(evaluate, ['下载失败']);
    console.log('失效链接 ->', JSON.stringify(failed, null, 2));

    // 2. 网络问题之外的另一条：取消正在下载的任务
    await evaluate(`(() => {
      document.getElementById('aria2-dir').value = ${JSON.stringify(CANCEL_DIR)};
      document.getElementById('save-settings').click();
      return true;
    })()`);
    await sleep(1000);
    await submit(evaluate, VALID);
    const downloading = await waitChip(evaluate, ['下载中'], 120000);
    console.log('开始下载 ->', downloading?.chip, downloading?.buttons);
    const clicked = await evaluate(`(() => {
      const row = document.querySelector('.job');
      const button = Array.from(row.querySelectorAll('.job__actions button')).find((b) => b.textContent.trim() === '取消');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    console.log('点击取消:', clicked);
    const cancelled = await waitChip(evaluate, ['已取消', '下载失败'], 30000);
    console.log('取消后 ->', JSON.stringify(cancelled, null, 2));
  } finally {
    close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('E2E FAILED:', error.message);
    process.exit(1);
  });
