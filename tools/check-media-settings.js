'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store, DEFAULT_SETTINGS } = require('../src/main/store');
const { mediaOptions } = require('../src/shared/media-options');
const { buildArgs } = require('../src/main/engines/ytdlp-transfer');
const { resolveEngineId } = require('../src/main/engines');
const { SOURCES } = require('../src/shared/sources');

/**
 * The media settings, checked as a round trip.
 *
 * The settings page writes them, the main process reads them and turns them
 * into yt-dlp arguments. This checks both ends of that line, so a field added
 * to one side and forgotten on the other shows up here.
 */
function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-media-'));
  try {
    const store = new Store(dir);

    // 1. The defaults are the ones the docs promise.
    const defaults = store.getSettings();
    assert.strictEqual(defaults.ytdlpPath, '', '默认用内置的 yt-dlp');
    assert.strictEqual(defaults.ytdlpChannel, 'stable');
    assert.deepStrictEqual(defaults.engineOverrides, {}, '默认每个来源用自己的引擎');
    assert.strictEqual(defaults.media.format, '', '默认画质交给 yt-dlp 挑');
    assert.strictEqual(defaults.media.embedThumbnail, false);
    assert.strictEqual(defaults.media.playlist, false);

    // 2. What the settings page sends comes back unchanged.
    const saved = store.setSettings({
      ytdlpPath: 'D:\\tools\\yt-dlp.exe',
      ytdlpChannel: 'nightly',
      engineOverrides: { media: 'aria2', direct: 'yt-dlp' },
      media: {
        format: 'bv*[height<=720]+ba/b[height<=720]',
        audioFormat: 'mp3',
        embedThumbnail: true,
        embedMetadata: true,
        writeSubs: true,
        subLangs: 'zh-Hans,en',
        playlist: true,
        ffmpegPath: 'D:\\ffmpeg\\bin\\ffmpeg.exe',
      },
    });
    assert.strictEqual(saved.ytdlpPath, 'D:\\tools\\yt-dlp.exe');
    assert.strictEqual(saved.ytdlpChannel, 'nightly');
    assert.strictEqual(saved.engineOverrides.media, 'aria2');
    assert.strictEqual(saved.engineOverrides.direct, 'yt-dlp');
    assert.strictEqual(saved.media.audioFormat, 'mp3');
    assert.strictEqual(saved.media.subLangs, 'zh-Hans,en');

    // 3. The file on disk is what the next run reads.
    const reopened = new Store(dir).getSettings();
    assert.strictEqual(reopened.media.format, saved.media.format);
    assert.strictEqual(reopened.engineOverrides.media, 'aria2');

    // 4. A partial patch keeps the other fields.
    const patched = store.setSettings({ ytdlpChannel: 'master' });
    assert.strictEqual(patched.ytdlpChannel, 'master');
    assert.strictEqual(patched.media.audioFormat, 'mp3', '改一项不能抹掉别的');
    assert.strictEqual(patched.engineOverrides.direct, 'yt-dlp');

    // 5. An override taken back to its default is gone, and the others stay.
    const cleared = store.setSettings({ engineOverrides: { direct: null } });
    assert.strictEqual(cleared.engineOverrides.direct, undefined, '改回默认的来源不能留着旧覆盖');
    assert.strictEqual(cleared.engineOverrides.media, 'aria2', '别的来源的覆盖不能被一起抹掉');
    assert.strictEqual(new Store(dir).getSettings().engineOverrides.direct, undefined, '旧覆盖不能写回磁盘');

    // 6. An override the engines cannot run is refused.
    // Media has no extracted files, so aria2 would sit on an empty run and the
    // job would never move. A netdisk share has no address, so yt-dlp would
    // fail on the spot. The settings page only offers what works, and the
    // resolver refuses the rest even if the file was edited by hand.
    const byId = Object.fromEntries(SOURCES.map((spec) => [spec.id, spec]));
    assert.strictEqual(
      resolveEngineId(byId.media, { engineOverrides: { media: 'aria2' } }),
      'yt-dlp',
      '媒体指到 aria2 必须退回 yt-dlp'
    );
    assert.strictEqual(
      resolveEngineId(byId.quark, { engineOverrides: { quark: 'yt-dlp' } }),
      'aria2',
      '网盘指到 yt-dlp 必须退回 aria2'
    );
    assert.strictEqual(
      resolveEngineId(byId.direct, { engineOverrides: { direct: 'yt-dlp' } }),
      'yt-dlp',
      '直链指到 yt-dlp 是允许的'
    );
    assert.strictEqual(
      resolveEngineId(byId.direct, { engineOverrides: { direct: 'aria2' } }),
      'aria2',
      '直链指到 aria2 是允许的'
    );

    // 7. The settings turn into yt-dlp arguments.
    const options = mediaOptions(saved);
    assert.strictEqual(options.format, 'bv*[height<=720]+ba/b[height<=720]');
    assert.strictEqual(options.audioFormat, 'mp3');
    assert.strictEqual(options.embedThumbnail, true);
    assert.strictEqual(options.writeSubs, true);
    assert.strictEqual(options.subLangs, 'zh-Hans,en');
    assert.strictEqual(options.playlist, true);
    assert.strictEqual(options.ffmpegPath, 'D:\\ffmpeg\\bin\\ffmpeg.exe');

    const args = buildArgs({
      url: 'https://example.com/watch?v=abc',
      dir: 'D:\\Downloads',
      options,
    });
    assert.strictEqual(args[args.indexOf('--format') + 1], 'bv*[height<=720]+ba/b[height<=720]');
    assert(args.includes('--extract-audio'));
    assert.strictEqual(args[args.indexOf('--audio-format') + 1], 'mp3');
    assert(args.includes('--embed-thumbnail'));
    assert(args.includes('--embed-metadata'));
    assert(args.includes('--write-subs'));
    assert.strictEqual(args[args.indexOf('--sub-langs') + 1], 'zh-Hans,en');
    assert(args.includes('--yes-playlist'), '开了播放列表就要放开');
    assert.strictEqual(args[args.indexOf('--ffmpeg-location') + 1], 'D:\\ffmpeg\\bin\\ffmpeg.exe');

    // 8. The defaults leave those switches out.
    const plain = buildArgs({
      url: 'https://example.com/watch?v=abc',
      dir: 'D:\\Downloads',
      options: mediaOptions(DEFAULT_SETTINGS),
    });
    assert(!plain.includes('--extract-audio'));
    assert(!plain.includes('--embed-thumbnail'));
    assert(!plain.includes('--write-subs'));
    assert(!plain.includes('--yes-playlist'));
    assert(!plain.includes('--ffmpeg-location'));
    assert(plain.includes('--no-playlist'), '默认只下一个视频');

    console.log('check:media-settings OK');
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 临时目录清不掉不影响结论。
    }
  }
}

main();
