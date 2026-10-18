'use strict';

const assert = require('node:assert');

const { Job } = require('../src/main/job');

/**
 * The job state machine, driven by the observations the page actually sends.
 *
 * No network and no window: every case here is a rule that used to be wrong or
 * missing, and each one is checked on the states the renderer reads.
 */

function makeJob(overrides = {}) {
  const emitted = [];
  const deliveries = [];
  const job = new Job({
    link: {
      raw: 'https://pan.baidu.com/s/1abcdef',
      provider: 'baidu',
      shareId: '1abcdef',
      passcode: null,
    },
    deliver: async (files) => {
      deliveries.push(files);
      return {
        delivery: 'aria2',
        files,
        gids: files.map((file) => ({ file, gid: 'gid-' + file.name })),
        config: { domain: 'http://127.0.0.1', port: '1', path: '/jsonrpc', token: '', dir: '' },
      };
    },
    emit: (updated) => emitted.push(updated.state.phase),
    onDone: () => {},
    persist: () => {},
    allowTransfer: () => false,
    config: () => ({ domain: 'http://127.0.0.1', port: '1', path: '/jsonrpc', token: '', dir: '' }),
    ...overrides,
  });
  return { job, emitted, deliveries };
}

/** The envelope the userscript's GM_xmlhttpRequest posts for one file. */
function addUriObservation(id, name) {
  return {
    kind: 'http',
    id,
    url: 'http://localhost:6800/jsonrpc',
    method: 'POST',
    headers: {},
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'aria2.addUri',
      params: [
        [`https://d.pcs.baidu.com/file/${name}?token=x`],
        {
          out: name,
          header: ['User-Agent: pan.baidu.com', 'Cookie: BDUSS=abc'],
        },
      ],
    }),
  };
}

/** @param {Job} job @param {number} ms */
function waitForFlush(job, ms = 1600) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  // 1. 文件夹多文件：三个 addUri 只投递一次，三个文件都在
  {
    const { job, emitted, deliveries } = makeJob();
    job.handle(addUriObservation(1, 'a.bin'));
    job.handle(addUriObservation(2, 'b.bin'));
    job.handle(addUriObservation(3, 'c.bin'));
    assert.strictEqual(emitted[0], 'linked', '拿到第一个直链就该是「已拿到链接」');
    await waitForFlush(job);
    assert.strictEqual(deliveries.length, 1, '三个文件应合并成一次投递，不是三次');
    assert.strictEqual(deliveries[0].length, 3, '投递的文件应包含全部三个');
    assert.notStrictEqual(emitted[0], 'delivering', '先有「已拿到链接」，再去推下载器');
    assert.strictEqual(job.state.phase, 'downloading');
    assert.strictEqual(job.state.progress.length, 3, '进度应三条');
    assert.strictEqual(job.gids.length, 3);
    job.stopPolling();
  }

  // 2. 同一个文件被推两次（重试按钮连点）不该重复投递
  {
    const { job, deliveries } = makeJob();
    job.handle(addUriObservation(1, 'same.bin'));
    job.handle(addUriObservation(2, 'same.bin'));
    await waitForFlush(job);
    assert.strictEqual(deliveries.length, 1);
    assert.strictEqual(deliveries[0].length, 1, '同一个直链只算一个文件');
    job.stopPolling();
  }

  // 3. 百度大文件、没开自动转存：明确说「需要先转存」，不报成网络错误
  {
    const { job } = makeJob();
    job.handle({
      kind: 'dialog',
      text: '获取下载地址失败，服务器说：此文件大小超过可获取限制，需要保存到网盘后于网盘中下载。',
    });
    assert.strictEqual(job.state.phase, 'needs-human');
    assert.strictEqual(job.state.reason, 'transfer');
  }

  // 4. 登录过期：走同一个「需登录」状态；迅雷的登录在应用自己的窗口里，
  //    不应当去拉起 Chrome
  {
    const { job } = makeJob({
      link: { raw: 'https://pan.xunlei.com/s/VNabc', provider: 'xunlei', shareId: 'VNabc', passcode: null },
      allowTransfer: () => false,
    });
    job.handle({ kind: 'dialog', text: '提示：请先登录网盘~代码：凭证已过期' });
    assert.strictEqual(job.state.phase, 'needs-human');
    assert.strictEqual(job.state.reason, 'login');
  }

  // 5. 链接失效
  {
    const { job } = makeJob();
    job.handle({ kind: 'dialog', text: '提示：分享的文件已经被取消' });
    assert.strictEqual(job.state.phase, 'failed');
    assert.strictEqual(job.state.code, 'link-invalid');
  }

  // 6. 验证过的网盘：驱动点不到按钮就是真异常，要报「上游改版」
  {
    const { job } = makeJob();
    job.handle({ kind: 'driver-result', mode: 'share', ok: false, step: 0, verb: 'wait-for', selector: '.x', detail: '超时' });
    assert.strictEqual(job.state.phase, 'failed');
    assert.strictEqual(job.state.code, 'upstream-redesigned');
  }

  // 7. 选择器只是照抄没跑过的网盘：留一个手动窗口，不判死
  {
    const { job } = makeJob({
      link: { raw: 'https://drive.uc.cn/s/abc123', provider: 'uc', shareId: 'abc123', passcode: null },
    });
    job.handle({ kind: 'driver-result', mode: 'share', ok: false, step: 0, verb: 'wait-for', selector: '.x', detail: '超时' });
    assert.strictEqual(job.state.phase, 'needs-human');
    assert.strictEqual(job.state.reason, 'manual');
    assert(job.state.message.includes('下载助手'), '手动兜底要告诉用户点哪里');
  }
}

main().then(
  () => console.log('check:job OK'),
  (error) => {
    console.error(`check:job FAILED: ${error.message}`);
    process.exit(1);
  },
);
