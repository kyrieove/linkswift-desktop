'use strict';

const assert = require('node:assert');

const { Job, JobManager } = require('../src/main/job');

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

  // 6. 验证过的网盘：驱动点不到按钮就是真异常，要报「上游改版」，并保留是哪一步
  {
    const { job } = makeJob();
    job.handle({ kind: 'driver-result', mode: 'share', ok: false, step: 2, verb: 'wait-for', selector: '.x-button-box', detail: '超时' });
    assert.strictEqual(job.state.phase, 'failed');
    assert.strictEqual(job.state.code, 'upstream-redesigned');
    assert.strictEqual(job.state.step, 2, '失败的步骤序号要留在任务上');
    assert.strictEqual(job.state.verb, 'wait-for', '失败的动词要留在任务上');
    assert.strictEqual(job.state.selector, '.x-button-box', '失败的选择器要留在任务上');
    assert(
      typeof job.state.hint === 'string' && job.state.hint.includes('重试'),
      `失败要带一句能执行的提示：${job.state.hint}`,
    );
    assert(job.state.message.includes('第 3 步'), '消息里要写清第几步');
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

  // 7b. 迅雷的分享页根本没有 aria2 入口，只能转存；没开自动转存就停在「需先转存」
  {
    const { job } = makeJob({
      link: { raw: 'https://pan.xunlei.com/s/VNabc', provider: 'xunlei', shareId: 'VNabc', passcode: null },
      allowTransfer: () => false,
    });
    job.handle({ kind: 'injected', href: 'https://pan.xunlei.com/s/VNabc', provider: 'xunlei' });
    assert.strictEqual(job.state.phase, 'needs-human');
    assert.strictEqual(job.state.reason, 'transfer');
  }

  // 8. 文件夹里一个文件挂了，其余继续；全部停下来才算这个任务失败
  {
    const aria2 = require('../src/main/aria2');
    const realFindGid = aria2.findGid;
    const statuses = { 'gid-a': 'active', 'gid-b': 'error' };
    aria2.findGid = async (_config, gid) => ({
      gid,
      status: statuses[gid],
      totalLength: '100',
      completedLength: statuses[gid] === 'complete' ? '100' : '10',
      downloadSpeed: '0',
      connections: '1',
      errorCode: statuses[gid] === 'error' ? '22' : undefined,
      errorMessage:
        statuses[gid] === 'error' ? 'The response status is not successful. status=403' : undefined,
    });

    const { job } = makeJob();
    job.files = [
      { name: 'a.bin', url: 'https://example.com/a', headers: {} },
      { name: 'b.bin', url: 'https://example.com/b', headers: {} },
    ];
    job.gids = [
      { file: job.files[0], gid: 'gid-a' },
      { file: job.files[1], gid: 'gid-b' },
    ];
    job.progress = job.gids.map(({ file, gid }) => ({
      gid,
      name: file.name,
      status: 'waiting',
      totalLength: 0,
      completedLength: 0,
      downloadSpeed: 0,
      connections: 0,
      errorCode: null,
      errorMessage: null,
    }));
    job.aria2Config = { domain: 'http://127.0.0.1', port: '1', path: '/jsonrpc', token: '', dir: '' };
    job.settled = false;
    job.startPolling();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.strictEqual(job.state.phase, 'downloading', '还有一个在下载，任务就不该判失败');

    statuses['gid-a'] = 'complete';
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.strictEqual(job.state.phase, 'failed');
    assert(
      job.state.message.includes('1 个文件下载失败') && job.state.message.includes('1 个已完成'),
      `失败信息应数清完成与失败：${job.state.message}`,
    );
    assert.strictEqual(job.state.progress.filter((p) => p.status === 'complete').length, 1);
    job.stopPolling();
    aria2.findGid = realFindGid;
  }

  // 9. 60 秒没有字节增长就标停滞，字节一涨立刻清掉；不只是速度为零
  {
    const aria2 = require('../src/main/aria2');
    const realFindGid = aria2.findGid;
    let completed = '100';
    aria2.findGid = async (_config, gid) => ({
      gid,
      status: 'active',
      totalLength: '1000',
      completedLength: completed,
      downloadSpeed: '0',
      connections: '1',
    });

    const { job } = makeJob();
    job.files = [{ name: 'slow.bin', url: 'https://example.com/slow', headers: {} }];
    job.gids = [{ file: job.files[0], gid: 'gid-slow' }];
    job.progress = [
      {
        gid: 'gid-slow',
        name: 'slow.bin',
        status: 'waiting',
        totalLength: 0,
        completedLength: 0,
        downloadSpeed: 0,
        connections: 0,
        errorCode: null,
        errorMessage: null,
      },
    ];
    job.aria2Config = { domain: 'http://127.0.0.1', port: '1', path: '/jsonrpc', token: '', dir: '' };
    job.lastArrived = 100;
    job.lastArrivedAt = Date.now() - 61_000;
    job.startPolling();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.strictEqual(job.snapshot().stalled, true, '61 秒没有字节增长就该标停滞');
    assert.strictEqual(job.state.phase, 'downloading', '停滞只是提示，不改状态');

    completed = '200';
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.strictEqual(job.snapshot().stalled, undefined, '字节一涨就清掉停滞标记');
    job.stopPolling();
    aria2.findGid = realFindGid;
  }

  // 10. 重试先拉一次上游脚本：「上游改版」正是旧脚本造成的，沿用旧脚本的
  //     重试等于原样再失败一次
  {
    let script = { source: '// ==UserScript==\n// @version 1.0.0\n', version: '1.0.0', origin: 'cache' };
    const retried = [];
    const manager = makeManager({
      userscript: {
        get: () => script,
        refresh: async () => {
          script = { source: '// ==UserScript==\n// @version 1.0.1\n', version: '1.0.1', origin: 'upstream' };
          return script;
        },
      },
      buildJob: (options) => (options.id ? makeOldJob() : makeStubJob(options, retried)),
    });

    const result = await manager.retry('job-old');
    assert.strictEqual(retried.length, 1, '重试要重建一条任务');
    assert.strictEqual(retried[0].script.version, '1.0.1', '重建时用刚拉到的脚本，而不是旧的那份');
    assert.strictEqual(result.scriptVersion, '1.0.1', '返回里带本次脚本版本');
    assert.strictEqual(result.scriptOrigin, 'upstream', '返回里带本次脚本来源');
    assert(result.message.includes('1.0.1'), `重试要说明用了哪版脚本：${result.message}`);
    assert(!manager.jobs.has('job-old'), '旧任务要被换掉，不是并排留下两条');
  }

  // 11. 上游拉不到：版本不变，并在 detail 里写明用的是缓存版本
  {
    const script = { source: '// ==UserScript==\n// @version 1.0.0\n', version: '1.0.0', origin: 'cache' };
    const created = [];
    const manager = makeManager({
      userscript: { get: () => script, refresh: async () => script },
      buildJob: (options) => (options.id ? makeOldJob() : makeStubJob(options, created)),
    });

    const result = await manager.retry('job-old');
    assert.strictEqual(result.scriptVersion, '1.0.0', '拉不到新脚本时版本不变');
    assert.strictEqual(result.scriptOrigin, 'cache');
    assert(result.message.includes('缓存版本'), `拉不到新脚本要说明：${result.message}`);
    assert(created.some((entry) => String(entry.detail).includes('缓存版本')), '任务上也要留下这句说明');
  }
}

/**
 * A JobManager with no window and no aria2. Everything crossed is the real
 * JobManager (retry order, submit, the jobs map); only the two collaborators
 * that would open a window or a socket are swapped.
 *
 * @param {{ userscript?: object, buildJob?: (options: any) => any }} [overrides]
 */
function makeManager(overrides = {}) {
  const manager = new JobManager({
    store: { getSettings: () => ({ aria2Mode: 'external', allowTransfer: false, aria2: {} }) },
    userscript: overrides.userscript ?? { get: () => ({ version: '1.0.0', origin: 'cache', source: '' }) },
    vendor: {},
    resources: {},
    partition: 'persist:check-job',
    preloadPath: '',
    emit: () => {},
    daemon: { config: () => ({}) },
    tasks: { remove: () => {}, save: () => {}, all: () => [] },
    health: { record: () => {} },
  });
  const old = makeOldJob();
  manager.jobs.set(old.id, old);
  manager.buildJob = overrides.buildJob ?? (() => makeStubJob({}, []));
  return manager;
}

/** The failed job retry throws away. */
function makeOldJob() {
  return {
    id: 'job-old',
    link: { raw: 'https://pan.quark.cn/s/qk_retry', provider: 'quark', shareId: 'qk_retry', passcode: null },
    state: { phase: 'failed', code: 'upstream-redesigned', message: '页面变了' },
    stopPolling: () => {},
    close: () => {},
  };
}

/** A job just after it was built: no window, so `prepare` and `load` only record. */
function makeStubJob({ link, script }, created) {
  return {
    id: 'job-new-' + Math.random().toString(36).slice(2, 8),
    link,
    scriptVersion: script?.version,
    scriptOrigin: script?.origin,
    state: { phase: 'loading' },
    setState(state) {
      this.state = state;
      if (created) created.push({ script, detail: state.detail });
    },
    snapshot() {
      return { id: this.id, link: this.link, scriptVersion: this.scriptVersion, scriptOrigin: this.scriptOrigin };
    },
    prepare() {
      return -1;
    },
    load() {},
  };
}

main().then(
  () => console.log('check:job OK'),
  (error) => {
    console.error(`check:job FAILED: ${error.message}`);
    process.exit(1);
  },
);
