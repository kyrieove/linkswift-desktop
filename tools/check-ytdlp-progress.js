'use strict';

const assert = require('node:assert');

const { parseProgressLine } = require('../src/main/engines/ytdlp-transfer');

/**
 * The progress channel, checked against lines a real yt-dlp produced.
 *
 * The lines below were captured on this machine on 2026-10-22, running
 * yt-dlp 2026.08.19 against a GitHub release asset. They are not invented:
 * the shape of a missing value is `NA`, and the path arrives with single
 * backslashes, which is why the contract is tab-separated rather than JSON.
 */
function main() {
  const first =
    'PROGRESS\tdownloading\t1024\t1595\tNA\tNA\tNA\tC:\\Users\\ASUS\\AppData\\Local\\Temp\\ytdlp-probe\\b.unknown_video';
  const second =
    'PROGRESS\tdownloading\t1595\t1595\tNA\t698175.2118555625\t0\tC:\\Users\\ASUS\\AppData\\Local\\Temp\\ytdlp-probe\\b.unknown_video';
  const last =
    'PROGRESS\tfinished\t1595\t1595\tNA\t32142.03636084099\tNA\tC:\\Users\\ASUS\\AppData\\Local\\Temp\\ytdlp-probe\\b.unknown_video';

  const a = parseProgressLine(first);
  assert(a, '进度行要能解析出来');
  assert.strictEqual(a.status, 'downloading');
  assert.strictEqual(a.downloadedLength, 1024);
  assert.strictEqual(a.totalLength, 1595);
  assert.strictEqual(a.estimate, null, 'NA 要变成 null');
  assert.strictEqual(a.downloadSpeed, null, 'NA 要变成 null');
  assert.strictEqual(a.eta, null, 'NA 要变成 null');
  assert.strictEqual(
    a.filename,
    'C:\\Users\\ASUS\\AppData\\Local\\Temp\\ytdlp-probe\\b.unknown_video',
    'Windows 路径要原样拿到，不能被转义',
  );
  assert(!a.filename.includes('\\\\'), '路径里不能有双反斜杠');

  const b = parseProgressLine(second);
  assert.strictEqual(b.status, 'downloading');
  assert.strictEqual(b.downloadedLength, 1595);
  assert.strictEqual(b.totalLength, 1595);
  assert.strictEqual(b.downloadSpeed, 698175.2118555625, '速度要是数字');
  assert.strictEqual(b.eta, 0, '0 是真的 0，不是缺失');

  const c = parseProgressLine(last);
  assert.strictEqual(c.status, 'finished');
  assert.strictEqual(c.downloadedLength, 1595);
  assert.strictEqual(c.downloadSpeed, 32142.03636084099);

  // 1. A total that is only an estimate still gives a total.
  const estimated = parseProgressLine('PROGRESS\tdownloading\t10\tNA\t999\t1\t2\tC:\\tmp\\x.mp4');
  assert.strictEqual(estimated.totalLength, null, 'total 是 NA 时不该编一个数出来');
  assert.strictEqual(estimated.estimate, 999, '估计值要单独拿到');

  // 2. A file name with a tab in it belongs to the last field, so the split
  //    takes the tail whole.
  const tabbed = parseProgressLine('PROGRESS\tdownloading\t1\t2\tNA\tNA\tNA\tC:\\a\\b\tc.mp4');
  assert.strictEqual(tabbed.filename, 'C:\\a\\b\tc.mp4', '文件名是最后一个字段，剩下的都归它');

  // 3. Lines that are not progress are not progress.
  for (const line of [
    '[download] Destination: C:\\tmp\\out.mp4',
    '[generic] Extracting URL: https://example.com',
    '',
    'PROGRESS',
    'PROGRESSX\tdownloading\t1',
  ]) {
    assert.strictEqual(parseProgressLine(line), null, `非进度行要返回 null：${line}`);
  }

  console.log('check:ytdlp-progress OK');
}

main();
