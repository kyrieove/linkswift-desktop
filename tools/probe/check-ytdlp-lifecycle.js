'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { YtDlpTransfer } = require('../../src/main/engines/ytdlp-transfer');

/**
 * yt-dlp end to end, against a local server. No network.
 *
 * The same shape as `check-aria2-lifecycle`: download half way, stop, come
 * back, and check the bytes on disk are the bytes that were served. That is
 * the claim the media path makes, so it has to be proven with bytes and not
 * with a status message.
 */

const PAYLOAD = Buffer.alloc(768 * 1024, 0x5a);
const CHUNK = 8 * 1024;
const CHUNK_MS = 40;

function bundledBinary() {
  return path.join(__dirname, '..', '..', 'resources', 'ytdlp', 'yt-dlp.exe');
}

/**
 * A server that hands the payload out slowly and understands Range, so a
 * resumed download asks for the rest instead of the whole thing again.
 */
function startServer() {
  const server = http.createServer((req, res) => {
    const match = req.headers.range ? /bytes=(\d+)-/.exec(req.headers.range) : null;
    const start = match ? Number(match[1]) : 0;
    const headers = {
      'Content-Type': 'video/mp4',
      'Content-Length': String(PAYLOAD.length - start),
      'Accept-Ranges': 'bytes',
    };
    if (match) headers['Content-Range'] = `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`;
    res.writeHead(match ? 206 : 200, headers);

    let offset = start;
    const timer = setInterval(() => {
      if (offset >= PAYLOAD.length) {
        clearInterval(timer);
        res.end();
        return;
      }
      const slice = PAYLOAD.subarray(offset, offset + CHUNK);
      offset += slice.length;
      res.write(slice);
    }, CHUNK_MS);
    res.on('close', () => clearInterval(timer));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The file yt-dlp wrote, ignoring the half-finished one. */
function finishedFile(dir) {
  const names = fs
    .readdirSync(dir)
    .filter((name) => !name.endsWith('.part') && !name.endsWith('.ytdl'));
  return names.length ? path.join(dir, names[0]) : null;
}

/** @param {YtDlpTransfer} transfer */
async function waitUntil(transfer, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await transfer.progress();
    if (predicate(rows)) return rows;
    await sleep(100);
  }
  throw new Error('等超时了');
}

async function main() {
  const binary = bundledBinary();
  assert(fs.existsSync(binary), `找不到内置的 yt-dlp：${binary}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-ytdlp-'));
  const server = await startServer();
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/sample.mp4`;

  try {
    // 1. A plain download: progress grows, and the bytes on disk are right.
    {
      const dir = path.join(tmp, 'plain');
      fs.mkdirSync(dir, { recursive: true });
      const transfer = new YtDlpTransfer({ binary, options: {} });
      await transfer.start({ url, dir });

      const rows = await waitUntil(transfer, (list) => list.some((row) => row.completedLength > 0));
      assert(rows.length > 0, '要有进度行');
      assert.strictEqual(rows[0].engine, 'yt-dlp');
      assert(rows[0].name.endsWith('.mp4'), `文件名要带扩展名：${rows[0].name}`);

      await waitUntil(transfer, () => transfer.finished);
      assert.strictEqual(transfer.error, null, `不该报错：${JSON.stringify(transfer.error)}`);

      const file = finishedFile(dir);
      assert(file, '下载目录里要有成品文件');
      const written = fs.readFileSync(file);
      assert.strictEqual(written.length, PAYLOAD.length, '长度要对');
      assert(written.equals(PAYLOAD), '内容要逐字节一致');
      assert(fs.readdirSync(dir).every((name) => !name.endsWith('.part')), '不该留下 .part');
    }

    // 2. Pause stops the bytes, resume finishes them, and the file is still
    //    exactly what the server sent.
    {
      const dir = path.join(tmp, 'paused');
      fs.mkdirSync(dir, { recursive: true });
      const transfer = new YtDlpTransfer({ binary, options: {} });
      await transfer.start({ url, dir });

      await waitUntil(transfer, (list) => list.some((row) => row.completedLength > 0));
      await transfer.pause();
      // Let the pipe drain, so the baseline is the state the pause settled on.
      await sleep(300);
      const paused = await transfer.progress();
      assert.strictEqual(paused.rows[0].status, 'paused', '暂停后状态要是 paused');

      const afterPause = paused.rows[0].completedLength;
      await sleep(600);
      const still = await transfer.progress();
      assert.strictEqual(
        still.rows[0].completedLength,
        afterPause,
        '暂停之后字节不该再涨',
      );
      assert(
        still.rows[0].status === 'paused',
        `暂停之后状态要还是 paused：${still.rows[0].status}`,
      );
      assert(
        fs.readdirSync(dir).some((name) => name.endsWith('.part')),
        '暂停之后 .part 要留在原地',
      );

      await transfer.resume();
      await waitUntil(transfer, () => transfer.finished);
      assert.strictEqual(transfer.error, null, `续传不该报错：${JSON.stringify(transfer.error)}`);

      const file = finishedFile(dir);
      assert(file, '续传之后要有成品文件');
      const written = fs.readFileSync(file);
      assert.strictEqual(written.length, PAYLOAD.length, '续传之后长度要对');
      assert(written.equals(PAYLOAD), '续传之后内容要逐字节一致');
    }

    // 3. Cancel throws the half-finished file away.
    {
      const dir = path.join(tmp, 'cancelled');
      fs.mkdirSync(dir, { recursive: true });
      const transfer = new YtDlpTransfer({ binary, options: {} });
      await transfer.start({ url, dir });
      await waitUntil(transfer, (list) => list.some((row) => row.completedLength > 0));
      await transfer.cancel();
      const names = fs.readdirSync(dir);
      assert(
        names.every((name) => !name.endsWith('.part')),
        `取消之后不该留下 .part：${names.join(', ')}`,
      );
    }

    console.log('check:ytdlp-lifecycle OK');
  } finally {
    server.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // 临时目录清不掉不影响结论。
    }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`check:ytdlp-lifecycle FAILED: ${error.message}`);
    process.exit(1);
  },
);
