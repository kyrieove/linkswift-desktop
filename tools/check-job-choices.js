'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { Job, JobManager } = require('../src/main/job');
const aria2 = require('../src/main/aria2');
const { Aria2Transfer } = require('../src/main/engines/aria2-transfer');

/**
 * 用户挑哪几个文件，以及每个任务自己的下载目录。
 *
 * 没有网盘、没有窗口、没有真的 aria2：这里只关心两件事，多文件分享停下来等
 * 用户，以及目录从任务传到 aria2 的那一段。
 */

const GLOBAL_DIR = 'C:/global-downloads';
const FILE_A = { name: 'a.bin', url: 'https://example.com/a.bin', headers: {} };
const FILE_B = { name: 'b.bin', url: 'https://example.com/b.bin', headers: {} };

let passed = 0;
/** @param {string} name @param {() => void | Promise<void>} body */
async function check(name, body) {
  await body();
  passed += 1;
  console.log(`  ok  ${name}`);
}

/** flush() 里那条 async 链要走完才能看到结果。 */
function tick(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 一个 Job，配的全是桩：引擎、投递、状态回调都不碰真的东西。
 *
 * @param {Record<string, any>} [overrides]
 */
function makeJob(overrides = {}) {
  const deliveries = [];
  const started = [];
  const transfer = {
    id: 'aria2',
    finished: false,
    paused: false,
    error: null,
    async start(target) {
      started.push(target);
      return { engine: 'aria2', runs: [], config: null, dir: target.dir };
    },
    async progress() {
      return { rows: [], lost: false };
    },
    async pause() {},
    async resume() {},
    async retry(run) {
      return run;
    },
    async cancel() {},
  };
  const job = new Job({
    link: {
      kind: 'netdisk',
      raw: 'https://pan.quark.cn/s/pick',
      provider: 'quark',
      shareId: 'pick',
      passcode: null,
    },
    transfer,
    deliver: async (files) => {
      deliveries.push(files);
      return { delivery: 'engine', files };
    },
    emit: () => {},
    onDone: () => {},
    persist: () => {},
    allowTransfer: () => false,
    config: () => ({ domain: 'http://127.0.0.1', port: '1', path: '/jsonrpc', token: '', dir: GLOBAL_DIR }),
    downloadDir: () => GLOBAL_DIR,
    ...overrides,
  });
  return { job, deliveries, started };
}

/**
 * 一个假 aria2：收下 JSON-RPC 请求，把发过去的 options 记下来。
 */
function startFakeAria2() {
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = JSON.parse(body);
      calls.push(parsed);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: `gid-${calls.length}` }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        calls,
        config: {
          domain: 'http://127.0.0.1',
          port: String(server.address().port),
          path: '/jsonrpc',
          token: '',
          dir: GLOBAL_DIR,
        },
      });
    });
  });
}

async function main() {
  console.log('check:job-choices');

  await check('两个文件的任务不自己投出去，停在「选文件」', async () => {
    const { job, deliveries } = makeJob();
    job.queueFiles([FILE_A, FILE_B]);
    job.flush();
    assert.strictEqual(deliveries.length, 0, '用户还没选，不能投递');
    assert.strictEqual(job.state.phase, 'picking', '多文件分享要停下来问用户');
    assert.deepStrictEqual(
      job.state.files.map((file) => file.name),
      ['a.bin', 'b.bin'],
      '待选的文件要带在任务上',
    );
    assert.strictEqual(job.pendingFiles.length, 2, '待选列表要留着，不能清掉');
    job.stopPolling();
  });

  await check('只有一个文件的任务直接下，不问用户', async () => {
    const { job, deliveries } = makeJob();
    job.queueFiles([FILE_A]);
    job.flush();
    await tick();
    assert.notStrictEqual(job.state.phase, 'picking', '单文件不该进选文件');
    assert.strictEqual(deliveries.length, 1, '单文件要投递一次');
    assert.deepStrictEqual(
      deliveries[0].map((file) => file.name),
      ['a.bin'],
    );
    job.stopPolling();
  });

  await check('选了其中一个，就只下那一个', async () => {
    const { job, deliveries } = makeJob();
    job.queueFiles([FILE_A, FILE_B]);
    job.flush();
    const result = await job.chooseFiles([FILE_B.url]);
    assert.strictEqual(result.ok, true, `选文件要成功：${result.message}`);
    assert.strictEqual(result.delivered, 1, '只交付了一个文件');
    assert.strictEqual(result.message, '已选择 1 个文件');
    assert.strictEqual(deliveries.length, 1, '只投递一次');
    assert.deepStrictEqual(
      deliveries[0].map((file) => file.name),
      ['b.bin'],
      '交付的正是用户选的那个',
    );
    assert.strictEqual(job.state.phase, 'downloading');
    job.stopPolling();
  });

  await check('一个都不选就拒绝，任务还在等', async () => {
    const { job, deliveries } = makeJob();
    job.queueFiles([FILE_A, FILE_B]);
    job.flush();
    const result = await job.chooseFiles([]);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.delivered, 0);
    assert.strictEqual(result.message, '至少要选一个文件');
    assert.strictEqual(job.state.phase, 'picking', '拒绝之后不能改状态');
    assert.strictEqual(job.state.files.length, 2, '待选的文件还在');
    assert.strictEqual(deliveries.length, 0, '拒绝之后不能投递');
    job.stopPolling();
  });

  await check('不在选文件状态的任务不能选', async () => {
    const { job } = makeJob();
    const result = await job.chooseFiles([FILE_A.url]);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.delivered, 0);
    assert.strictEqual(result.message, '这个任务现在不在选文件的状态');
  });

  await check('选过之后再选一次会被拒绝', async () => {
    const { job, deliveries } = makeJob();
    job.queueFiles([FILE_A, FILE_B]);
    job.flush();
    await job.chooseFiles([FILE_A.url]);
    const again = await job.chooseFiles([FILE_B.url]);
    assert.strictEqual(again.ok, false, '选完一次就结束了');
    assert.strictEqual(again.message, '这个任务现在不在选文件的状态');
    assert.strictEqual(deliveries.length, 1, '不能投第二次');
    job.stopPolling();
  });

  await check('任务有自己的目录时用它自己的，没有就用全局的', () => {
    const own = makeJob({ dir: 'D:/jobs/one' }).job;
    assert.strictEqual(own.targetDir(), 'D:/jobs/one');
    const global = makeJob().job;
    assert.strictEqual(global.targetDir(), GLOBAL_DIR);
    const blank = makeJob({ dir: '   ' }).job;
    assert.strictEqual(blank.targetDir(), GLOBAL_DIR, '只有空白的目录才算没指定');
  });

  await check('投递时用的是这个任务自己的目录', async () => {
    const { job, started } = makeJob({ dir: 'D:/jobs/one' });
    job.queueFiles([FILE_A]);
    job.flush();
    await tick();
    assert.strictEqual(started.length, 1);
    assert.strictEqual(started[0].dir, 'D:/jobs/one', '引擎拿到的是任务自己的目录');
    job.stopPolling();
  });

  await check('aria2 的目录：这次给了就用这次的，没给就用全局的', async () => {
    const fake = await startFakeAria2();
    try {
      await aria2.addUri(fake.config, FILE_A, 'D:/jobs/one');
      assert.strictEqual(fake.calls[0].params[1].dir, 'D:/jobs/one');
      await aria2.addUri(fake.config, FILE_A);
      assert.strictEqual(fake.calls[1].params[1].dir, GLOBAL_DIR, '没给就用全局目录');
    } finally {
      fake.server.close();
    }
  });

  await check('引擎把目录交给 aria2，重投也用同一个', async () => {
    const fake = await startFakeAria2();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-dir-'));
    try {
      const transfer = new Aria2Transfer({ config: () => fake.config });
      const run = await transfer.start({ files: [FILE_A], dir });
      assert.strictEqual(fake.calls[0].params[1].dir, dir, 'aria2 收到的是这个任务的目录');
      assert.strictEqual(run.dir, dir, '运行记录里要带着目录');
      assert.ok(fs.existsSync(dir), '目录要先建好');
      await transfer.retry(run);
      assert.strictEqual(fake.calls[1].params[1].dir, dir, '重投要落回同一个目录');
    } finally {
      fake.server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('目录建不出来时报一条错，而不是崩掉', async () => {
    const fake = await startFakeAria2();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-dir-'));
    try {
      const blocker = path.join(dir, 'blocker');
      fs.writeFileSync(blocker, '这里本来是个文件', 'utf8');
      const transfer = new Aria2Transfer({ config: () => fake.config });
      await assert.rejects(
        () => transfer.start({ files: [FILE_A], dir: blocker }),
        (error) => {
          assert.ok(error instanceof Error, '要抛一个普通的错误');
          assert.ok(
            error.message.includes(blocker),
            `错误里要写清楚是哪个目录：${error.message}`,
          );
          return true;
        },
      );
      assert.strictEqual(fake.calls.length, 0, '目录都没有就不该往 aria2 送');
    } finally {
      fake.server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('找不到的任务给一句话，不抛异常', async () => {
    const manager = new JobManager({
      store: { getSettings: () => ({}) },
      userscript: { get: () => ({ version: '1.0.0', origin: 'cache', source: '' }) },
      vendor: {},
      resources: {},
      partition: 'persist:check-job-choices',
      preloadPath: '',
      emit: () => {},
      daemon: { config: () => ({}) },
      tasks: { all: () => [{ id: 'archived-1' }], remove: () => {}, save: () => {} },
      health: { record: () => {} },
    });
    const missing = await manager.chooseFiles('nope', [FILE_A.url]);
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.delivered, 0);
    assert.strictEqual(missing.message, '找不到这个任务');
    const archived = await manager.chooseFiles('archived-1', [FILE_A.url]);
    assert.strictEqual(archived.ok, false);
    assert.strictEqual(archived.message, '这个任务现在不在选文件的状态');
  });

  console.log(`OK: ${passed} job-choice cases`);
}

main().then(
  () => console.log('check:job-choices OK'),
  (error) => {
    console.error(`check:job-choices FAILED: ${error.message}`);
    process.exit(1);
  },
);
