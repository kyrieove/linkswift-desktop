'use strict';

/** Drive the running app over CDP: submit a share link, pause, resume, finish. */

const fs = require('node:fs');
const path = require('node:path');

const SHARE = process.argv[2] || 'https://pan.baidu.com/s/1LBO1Kp3yHPYVFxukMC7YFQ?pwd=c81v';
const DOWNLOAD_DIR = process.argv[3] || 'D:\\2\\dev\\linkswift\\test_download';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  const pages = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = pages.find((entry) => entry.type === 'page' && entry.url.includes('index.html'));
  if (!page) throw new Error('找不到渲染页');
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
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.result?.exceptionDetails) {
      throw new Error(response.result.exceptionDetails.text + ' ' + JSON.stringify(response.result.exceptionDetails.exception?.description || ''));
    }
    return response.result?.result?.value;
  };
  return { evaluate, close: () => socket.close() };
}

const STATE_EXPR = `JSON.stringify(Array.from(document.querySelectorAll('.job')).slice(0, 1).map((row) => ({
  chip: row.querySelector('.chip__label')?.textContent,
  text: row.querySelector('.job__body')?.innerText.replace(/\\n+/g, ' | ').slice(0, 260),
  buttons: Array.from(row.querySelectorAll('.job__actions button')).map((b) => b.textContent.trim()),
})))`;

async function main() {
  const { evaluate, close } = await connect();
  try {
    // 1. 下载目录
    await evaluate(`(() => {
      const input = document.getElementById('aria2-dir');
      input.value = ${JSON.stringify(DOWNLOAD_DIR)};
      document.getElementById('save-settings').click();
      return true;
    })()`);
    await sleep(1200);
    console.log('设置已保存，下载目录：', await evaluate(`document.getElementById('aria2-dir').value`));

    // 2. 提交链接
    await evaluate(`(() => {
      const input = document.getElementById('link-input');
      input.value = ${JSON.stringify(SHARE)};
      document.getElementById('submit-btn').click();
      return true;
    })()`);

    let paused = false;
    let resumed = false;
    let submitted = false;
    let last = '';
    const deadline = Date.now() + 8 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(1500);
      const raw = await evaluate(STATE_EXPR);
      const state = JSON.parse(raw || '[]')[0];
      if (!state) continue;
      const line = `${state.chip} :: ${state.text}`;
      if (line !== last) {
        console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
        last = line;
      }
      if (!submitted && state.chip && state.chip !== '解析中') submitted = true;

      if (!paused && /下载中|排队中/.test(state.chip || '') && /%/.test(state.text || '')) {
        const percent = /(\d+(?:\.\d+)?)%/.exec(state.text);
        if (percent && Number(percent[1]) > 15) {
          const clicked = await evaluate(`(() => {
            const row = document.querySelector('.job');
            const button = Array.from(row.querySelectorAll('.job__actions button')).find((b) => b.textContent.trim() === '暂停');
            if (!button) return false;
            button.click();
            return true;
          })()`);
          if (clicked) {
            paused = true;
            console.log('已点暂停');
          }
        }
      }

      if (paused && !resumed && state.chip === '已暂停') {
        await sleep(3000);
        const stillPaused = JSON.parse((await evaluate(STATE_EXPR)) || '[]')[0];
        console.log(`暂停 3 秒后仍为：${stillPaused?.chip}`);
        const clicked = await evaluate(`(() => {
          const row = document.querySelector('.job');
          const button = Array.from(row.querySelectorAll('.job__actions button')).find((b) => b.textContent.trim() === '继续');
          if (!button) return false;
          button.click();
          return true;
        })()`);
        if (clicked) {
          resumed = true;
          console.log('已点继续');
        }
      }

      if (/下载完成|下载失败|已暂停/.test(state.chip || '') && state.chip === '下载完成') break;
      if (state.chip === '下载失败' && Date.now() > deadline - 5 * 60 * 1000) break;
    }

    const final = JSON.parse((await evaluate(STATE_EXPR)) || '[]')[0];
    console.log('最终状态：', JSON.stringify(final, null, 2));
    const files = await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.job .file__name')).map((n) => n.textContent))`);
    console.log('界面里的文件：', files);
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
