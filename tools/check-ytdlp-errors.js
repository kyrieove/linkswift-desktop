'use strict';

const assert = require('node:assert');

const { classifyError } = require('../src/main/engines/ytdlp-transfer');

/**
 * The stderr of a failed yt-dlp, turned into a code and one sentence the user
 * can act on. Every line below is a real message shape, measured or quoted from
 * yt-dlp's own output on 2026-10-22.
 */
function main() {
  const cases = [
    {
      text: "ERROR: [youtube] aqz-KE-bpKQ: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.",
      code: 'media-auth',
    },
    {
      text: 'ERROR: [BiliBili] 1GJ411x7h7: This video may be deleted or geo-restricted. You might want to try a VPN or a proxy server (with --proxy)',
      code: 'media-geo',
    },
    {
      text: 'ERROR: Unsupported URL: https://example.com/page',
      code: 'media-unsupported',
    },
    {
      text: 'ERROR: [youtube] aqz: Requested format is not available. Use --list-formats to see what is available',
      code: 'media-unsupported',
    },
    {
      text: 'ERROR: unable to download video data: HTTP Error 429: Too Many Requests',
      code: 'rate-limited',
    },
    {
      text: 'ERROR: ffprobe/ffmpeg not found. Please provide the path using --ffmpeg-location',
      code: 'media-merge',
    },
    {
      text: 'ERROR: Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>',
      code: 'network',
    },
  ];

  for (const item of cases) {
    const result = classifyError(item.text, 1);
    assert(result, `这段 stderr 要能分类：${item.text.slice(0, 60)}`);
    assert.strictEqual(result.code, item.code, `分类错了：${item.text.slice(0, 60)}`);
    assert(result.message.length > 0, '要有一句说明');
    assert(result.hint.length > 0, '要有一句能执行的话');
  }

  // 1. Nothing recognizable still fails, and says so.
  const unknown = classifyError('ERROR: something nobody has seen before', 1);
  assert.strictEqual(unknown.code, 'media-error');
  assert(unknown.message.includes('something nobody has seen'), '要带上原始那一句');

  // 2. No stderr at all still fails, because the exit code says so.
  const silent = classifyError('', 2);
  assert.strictEqual(silent.code, 'media-error');
  assert(silent.message.includes('2'), '退出码要写出来');

  // 3. A login problem is the one the user can fix, so it has to be the one
  //    that says what to do.
  const auth = classifyError(cases[0].text, 1);
  assert(auth.hint.includes('登录'), '登录问题要告诉用户去登录');

  console.log('check:ytdlp-errors OK');
}

main();
