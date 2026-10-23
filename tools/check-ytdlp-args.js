'use strict';

const assert = require('node:assert');

const { buildArgs } = require('../src/main/engines/ytdlp-transfer');

/**
 * The yt-dlp command line, checked as a contract.
 *
 * Every assertion here is a rule the engine has to keep. Most of them exist
 * because the obvious thing is wrong: `--print` looks like the right way to get
 * the stage signals, but it implies `--quiet`, and `--quiet` switches the
 * progress template off as well. Measured, 2026-10-22.
 */
function main() {
  const base = { url: 'https://example.com/watch?v=abc', dir: 'C:\\Downloads\\LinkSwift' };
  const args = buildArgs(base);

  // 1. The flags that make the run deterministic and safe to embed.
  for (const flag of [
    '--ignore-config',
    '--no-color',
    '--no-update',
    '--newline',
    '--no-warnings',
    '--continue',
    '--no-simulate',
    '--no-abort-on-error',
    '--progress-template',
  ]) {
    assert(args.includes(flag), `命令行里必须有 ${flag}`);
  }

  // 2. The switches upstream marks as remote-code-execution risks. Never.
  const joined = args.join(' ');
  for (const banned of ['--exec', 'allow-unsafe-ext', 'allow-unsafe-exec-expansion', '--downloader']) {
    assert(!joined.includes(banned), `命令行里不能出现 ${banned}`);
  }

  // 3. The output name is built from the title, not from the id. The generic
  //    extractor turns a signed URL into the id, which makes an unusable name.
  const outIndex = args.indexOf('-o');
  assert(outIndex >= 0, '必须有 -o');
  const out = args[outIndex + 1];
  assert(out.includes('%(title)'), '输出名要带标题');
  assert(out.includes('%(ext)'), '输出名要带扩展名');
  assert(out.startsWith('C:\\Downloads\\LinkSwift'), '输出名要落在下载目录里');

  // 4. A percent sign in the path is a placeholder to yt-dlp, so it has to be
  //    escaped or the path breaks.
  const percent = buildArgs({ ...base, dir: 'C:\\100%\\Downloads' });
  const percentOut = percent[percent.indexOf('-o') + 1];
  assert(percentOut.includes('100%%'), '路径里的百分号要写成 %%');

  // 5. The stage signals go to a file. `--print` would imply `--quiet`, and
  //    `--quiet` takes the progress template down with it.
  const withSignal = buildArgs({ ...base, signalFile: 'C:\\Temp\\signals.txt' });
  assert(withSignal.includes('--print-to-file'), '阶段信号要用 --print-to-file');
  assert(!withSignal.includes('--print'), '不能用 --print，它会隐含 --quiet 并关掉进度');
  assert(!withSignal.includes('--quiet'), '命令行里不能有 --quiet');

  // 6. The media knobs only appear when they are switched on.
  assert(!args.includes('--extract-audio'), '没开就不该有音频提取');
  assert(!args.includes('--embed-thumbnail'), '没开就不该有封面嵌入');
  assert(!args.includes('--write-subs'), '没开就不该有字幕');
  assert(!args.includes('--format'), '没设画质就不该有 --format');
  assert(!args.includes('--ffmpeg-location'), '没指路径就不该有 --ffmpeg-location');

  const media = buildArgs({
    ...base,
    options: {
      format: 'bv*+ba/b',
      audioFormat: 'mp3',
      audioQuality: '0',
      mergeFormat: 'mp4',
      embedThumbnail: true,
      embedMetadata: true,
      writeSubs: true,
      subLangs: 'zh,en',
      ffmpegPath: 'C:\\ffmpeg\\bin',
    },
  });
  assert.strictEqual(media[media.indexOf('--format') + 1], 'bv*+ba/b', '画质要传给 yt-dlp');
  assert(media.includes('--extract-audio'), '开了音频提取就要有 --extract-audio');
  assert.strictEqual(media[media.indexOf('--audio-format') + 1], 'mp3', '音频格式要传给 yt-dlp');
  assert(media.includes('--embed-thumbnail'), '开了封面嵌入就要有 --embed-thumbnail');
  assert(media.includes('--embed-metadata'), '开了元数据嵌入就要有 --embed-metadata');
  assert(media.includes('--write-subs'), '开了字幕就要有 --write-subs');
  assert.strictEqual(media[media.indexOf('--sub-langs') + 1], 'zh,en', '字幕语言要传给 yt-dlp');
  assert(media.includes('--merge-output-format'), '开了合并格式就要有 --merge-output-format');
  assert(media.includes('--ffmpeg-location'), '指了 ffmpeg 路径就要传过去');

  // 7. One video by default. A playlist is a deliberate choice.
  assert(args.includes('--no-playlist'), '默认只下一个视频');
  const playlist = buildArgs({ ...base, options: { playlist: true } });
  assert(playlist.includes('--yes-playlist'), '要整个播放列表时得显式打开');

  // 8. The address goes last, behind `--`, so a leading dash cannot be read
  //    as an option.
  assert.strictEqual(args[args.length - 2], '--', '地址前要有 --');
  assert.strictEqual(args[args.length - 1], base.url, '地址放在最后');

  // 9. The cookie file is only passed when there is one.
  const withCookies = buildArgs({ ...base, options: { cookiesFile: 'C:\\Temp\\cookies.txt' } });
  assert(withCookies.includes('--cookies'), '有 cookie 文件就要传过去');
  assert.strictEqual(withCookies[withCookies.indexOf('--cookies') + 1], 'C:\\Temp\\cookies.txt');

  console.log('check:ytdlp-args OK');
}

main();
