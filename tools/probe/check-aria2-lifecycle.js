'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { Aria2Daemon } = require('../../src/main/aria2-daemon');
const aria2 = require('../../src/main/aria2');

/**
 * The acceptance case for "quit halfway through, reopen, carry on".
 *
 * A local server trickles a file slowly enough that the download is guaranteed
 * to still be running when it is interrupted. The probe then drives the real
 * daemon and the real RPC client through pause, resume, shutdown and restart,
 * and checks the bytes that landed rather than the states reported along the way.
 */

const SIZE = 32 * 1024 * 1024;
const BINARY = path.join(__dirname, '..', '..', 'resources', 'aria2', 'aria2c.exe');
const payload = crypto.randomBytes(SIZE);
const digest = crypto.createHash('sha256').update(payload).digest('hex');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Range-capable, deliberately slow: 16 KiB per 50 ms is about 320 KiB/s per
 *  connection, and the daemon opens up to 16 of them. */
function startServer() {
  const server = http.createServer((request, response) => {
    const range = /bytes=(\d+)-(\d*)/.exec(String(request.headers.range || ''));
    let start = 0;
    let end = SIZE - 1;
    if (range) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), SIZE - 1);
    }
    const slice = payload.subarray(start, end + 1);
    response.writeHead(range ? 206 : 200, {
      'Content-Length': slice.length,
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${SIZE}` } : {}),
    });
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= slice.length) {
        clearInterval(timer);
        response.end();
        return;
      }
      response.write(slice.subarray(offset, offset + 16 * 1024));
      offset += 16 * 1024;
    }, 50);
    request.on('close', () => clearInterval(timer));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function waitFor(label, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待「${label}」超时`);
    await sleep(250);
  }
}

/** @param {string} gid */
async function completed(config, gid) {
  const status = await aria2.findGid(config, gid);
  return status ? Number(status.completedLength || 0) : 0;
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-aria2-'));
  const downloadDir = path.join(userDataDir, 'downloads');
  fs.mkdirSync(downloadDir, { recursive: true });

  const local = await startServer();
  const url = `http://127.0.0.1:${local.port}/probe.bin`;

  let daemon = new Aria2Daemon({ userDataDir, binaryPath: BINARY });
  try {
    const status = await daemon.start({ dir: downloadDir });
    assert(status.running, `内置 aria2 应能启动：${status.error || ''}`);
    console.log(`内置 aria2 ${status.version} 起在 ${status.port}`);

    const config = daemon.config();
    const file = { name: 'probe.bin', url, headers: {} };
    const gid = await aria2.addUri(config, file);
    console.log(`已提交下载，GID ${gid}`);

    // 1. 下载跑起来
    const started = await waitFor('下载开始', async () => {
      const done = await completed(config, gid);
      return done > SIZE * 0.05 ? done : 0;
    }, 30000);
    console.log(`已下载 ${(started / 1024 / 1024).toFixed(2)} MiB，暂停`);

    // 2. 暂停
    await aria2.pause(config, gid);
    const paused = await waitFor('状态变为 paused', async () => {
      const state = await aria2.findGid(config, gid);
      return state && state.status === 'paused' ? state : null;
    }, 15000);
    const pausedAt = Number(paused.completedLength || 0);
    assert(pausedAt > 0, '暂停时应该已经有下载完成的字节');

    // 3. 继续（同一进程内的暂停/继续）
    await aria2.unpause(config, gid);
    await sleep(1200);
    const resumed = await aria2.findGid(config, gid);
    assert(
      resumed && resumed.status !== 'paused',
      `继续后不该还是暂停：${resumed && resumed.status}`,
    );

    // 4. 重来一次暂停，然后优雅退出（等价于关掉应用）
    await aria2.pause(config, gid);
    await waitFor('再次暂停', async () => {
      const state = await aria2.findGid(config, gid);
      return state && state.status === 'paused';
    }, 15000);
    const beforeQuit = await completed(config, gid);
    await daemon.stop();
    assert(!daemon.status().running, '退出后内置 aria2 应已停止');
    console.log(`退出前已下载 ${(beforeQuit / 1024 / 1024).toFixed(2)} MiB`);

    // 5. 重开：新实例、同一份 userData，应当接管上次的会话并找回同一个 GID
    daemon = new Aria2Daemon({ userDataDir, binaryPath: BINARY });
    const restarted = await daemon.start({ dir: downloadDir });
    assert(restarted.running, `重启内置 aria2 失败：${restarted.error || ''}`);
    const config2 = daemon.config();

    const found = await waitFor('会话里找回 GID', async () => aria2.findGid(config2, gid), 20000);
    assert(found, '重启后应能在 aria2 会话里找回原来的任务');
    console.log(`重启后找回 GID，状态 ${found.status}`);

    // A download reloaded from the session arrives paused, and aria2 reports
    // its length as 0 until it is resumed; the bytes come back from the
    // `.aria2` control file at that point.
    if (found.status === 'paused') {
      await aria2.unpause(config2, gid);
      console.log('重启后是暂停态，已继续');
    }

    const carried = await waitFor('接着已下载的字节继续', async () => {
      const state = await aria2.findGid(config2, gid);
      if (!state) return 0;
      const done = Number(state.completedLength || 0);
      return done > beforeQuit * 0.5 ? done : 0;
    }, 30000);
    assert(
      carried >= beforeQuit * 0.9,
      `重启后应接着已下载的字节继续（退出前 ${beforeQuit}，重启后 ${carried}）`,
    );
    console.log(`接着从 ${(carried / 1024 / 1024).toFixed(2)} MiB 继续，未从头再来`);

    // 6. 下完并核对字节
    await waitFor('下载完成', async () => {
      const state = await aria2.findGid(config2, gid);
      return state && state.status === 'complete';
    }, 120000);

    const saved = path.join(downloadDir, 'probe.bin');
    const actual = fs.readFileSync(saved);
    assert.strictEqual(actual.length, SIZE, `落盘大小应为 ${SIZE}，实际 ${actual.length}`);
    const actualDigest = crypto.createHash('sha256').update(actual).digest('hex');
    assert.strictEqual(actualDigest, digest, '落盘内容应与源文件一致');
    assert(!fs.existsSync(`${saved}.aria2`), '完成后不应残留 .aria2 控制文件');
    console.log('暂停 → 继续 → 退出 → 重启 → 下完，字节一致，无 .aria2 残留');

    // 7. 第二种中断：下载正在跑的时候直接退出（用户关窗口就是这个），
    //    重启后 aria2 自己就能接着下，不需要点任何东西。
    const gid2 = await aria2.addUri(config2, {
      name: 'probe-active.bin',
      url: `${url}?second=1`,
      headers: {},
    });
    const running = await waitFor('第二个下载跑起来', async () => {
      const state = await aria2.findGid(config2, gid2);
      return state && Number(state.completedLength || 0) > SIZE * 0.05 ? state : null;
    }, 30000);
    const activeBeforeQuit = Number(running.completedLength || 0);
    await daemon.stop();
    console.log(`下载中退出，已下 ${(activeBeforeQuit / 1024 / 1024).toFixed(2)} MiB`);

    daemon = new Aria2Daemon({ userDataDir, binaryPath: BINARY });
    const third = await daemon.start({ dir: downloadDir });
    assert(third.running, `再次重启失败：${third.error || ''}`);
    const config3 = daemon.config();

    const autoResumed = await waitFor('aria2 自动接着下', async () => {
      const state = await aria2.findGid(config3, gid2);
      if (!state) return 0;
      const done = Number(state.completedLength || 0);
      return done > activeBeforeQuit * 0.5 ? done : 0;
    }, 30000);
    assert(
      autoResumed >= activeBeforeQuit * 0.9,
      `未暂停的下载重启后应自动接着下（退出前 ${activeBeforeQuit}，重启后 ${autoResumed}）`,
    );
    await waitFor('第二个下载完成', async () => {
      const state = await aria2.findGid(config3, gid2);
      return state && state.status === 'complete';
    }, 120000);
    const second = fs.readFileSync(path.join(downloadDir, 'probe-active.bin'));
    assert.strictEqual(second.length, SIZE, '第二个文件的大小应一致');
    assert.strictEqual(
      crypto.createHash('sha256').update(second).digest('hex'),
      digest,
      '第二个文件的内容应一致',
    );
    console.log('下载中退出 → 重启 → 自动接着下 → 下完，字节一致');
  } finally {
    await daemon.stop().catch(() => {});
    local.server.close();
    // Windows may still hold the log file for a moment after the child exits;
    // a leftover temp directory is not a test failure.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(300);
      }
    }
  }
}

main().then(
  () => {
    console.log('check:lifecycle OK');
    process.exit(0);
  },
  (error) => {
    console.error(`check:lifecycle FAILED: ${error.message}`);
    process.exit(1);
  },
);
