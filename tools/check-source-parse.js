'use strict';

const assert = require('node:assert');

const { parseSources, buildSource, normalizeSource, sourceViews, SOURCES } = require('../src/shared/sources');
const { parseShareLinks } = require('../src/shared/providers');

/**
 * The source registry, checked on the kinds of link a user actually pastes.
 *
 * The netdisk cases have to keep working exactly as before: they are the app's
 * original job. The media and direct cases are the new ones.
 */
function main() {
  // 1. The four netdisks still parse, and still produce the same shape.
  const netdisk = [
    { url: 'https://pan.quark.cn/s/abc123', provider: 'quark', shareId: 'abc123' },
    { url: 'https://pan.baidu.com/s/1abcdef', provider: 'baidu', shareId: 'abcdef' },
    { url: 'https://drive.uc.cn/s/abc123', provider: 'uc', shareId: 'abc123' },
    { url: 'https://pan.xunlei.com/s/VNabc', provider: 'xunlei', shareId: 'VNabc' },
  ];
  for (const item of netdisk) {
    const source = buildSource(item.url, '');
    assert(source, `网盘链接要能认出来：${item.url}`);
    assert.strictEqual(source.kind, 'netdisk');
    assert.strictEqual(source.provider, item.provider);
    assert.strictEqual(source.shareId, item.shareId);
  }

  // 2. The old parser and the new one agree on the netdisks.
  const old = parseShareLinks('https://pan.quark.cn/s/abc123 https://pan.baidu.com/s/1abcdef');
  const fresh = parseSources('https://pan.quark.cn/s/abc123 https://pan.baidu.com/s/1abcdef');
  assert.strictEqual(old.length, 2);
  assert.strictEqual(fresh.length, 2);
  assert.strictEqual(fresh[0].shareId, old[0].shareId);
  assert.strictEqual(fresh[1].shareId, old[1].shareId);

  // 3. A video page is a media source, and yt-dlp is its engine.
  const media = buildSource('https://www.youtube.com/watch?v=aqz-KE-bpKQ', '');
  assert(media, '视频页面要能认出来');
  assert.strictEqual(media.kind, 'media');
  assert.strictEqual(media.url, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  const mediaSpec = SOURCES.find((spec) => spec.id === 'media');
  assert.strictEqual(mediaSpec.engine, 'yt-dlp', '媒体默认走 yt-dlp');

  // 4. A plain file address is a direct source, and aria2 is its engine.
  const direct = buildSource('https://example.com/downloads/archive.zip', '');
  assert(direct, '文件直链要能认出来');
  assert.strictEqual(direct.kind, 'direct');
  const directSpec = SOURCES.find((spec) => spec.id === 'direct');
  assert.strictEqual(directSpec.engine, 'aria2', '直链默认走 aria2');

  // 5. A media file extension belongs to yt-dlp, not to the direct source.
  const clip = buildSource('https://example.com/movie.mp4', '');
  assert.strictEqual(clip.kind, 'media', '媒体扩展名归 yt-dlp');

  // 6. A share text with several links keeps them apart, and one bad link
  //    does not take the others down.
  const mixed = parseSources(
    [
      '夸克分享：https://pan.quark.cn/s/abc123 提取码: c81v',
      '视频：https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      '文件：https://example.com/a.zip',
    ].join('\n'),
  );
  assert.strictEqual(mixed.length, 3, '三条链接要各成一源');
  assert.deepStrictEqual(
    mixed.map((item) => item.kind),
    ['netdisk', 'media', 'direct'],
  );
  assert.strictEqual(mixed[0].passcode, 'c81v', '写在旁边的提取码要认出来');

  // 7. The same link twice is one source.
  const twice = parseSources('https://www.youtube.com/watch?v=aqz https://www.youtube.com/watch?v=aqz');
  assert.strictEqual(twice.length, 1, '重复的链接只算一个');

  // 8. Something that is not a link at all is nothing.
  assert.strictEqual(parseSources('今天天气不错').length, 0);
  assert.strictEqual(buildSource('not a url', ''), null);

  // 9. A record written before this change has no `kind`. It is a netdisk.
  const oldRecord = { raw: 'https://pan.quark.cn/s/abc123', provider: 'quark', shareId: 'abc123', passcode: null };
  const restored = normalizeSource(oldRecord);
  assert(restored, '老记录要能读回来');
  assert.strictEqual(restored.kind, 'netdisk');
  assert.strictEqual(restored.provider, 'quark');
  assert.strictEqual(restored.shareId, 'abc123');

  // 10. The view the renderer draws from is serializable and complete.
  const views = sourceViews();
  assert.strictEqual(views.length, SOURCES.length);
  for (const view of views) {
    assert(typeof view.id === 'string' && view.id.length > 0);
    assert(typeof view.label === 'string' && view.label.length > 0);
    assert(['netdisk', 'media', 'direct'].includes(view.kind));
    assert(['aria2', 'yt-dlp'].includes(view.engine), `引擎名要认得：${view.engine}`);
    assert(view.capability && typeof view.capability.grade === 'string');
    assert(JSON.parse(JSON.stringify(views)).length === views.length, '视图要能序列化');
  }
  assert(views.some((view) => view.id === 'media'));
  assert(views.some((view) => view.id === 'direct'));

  // 11. The view carries everything the renderer needs to draw a source, so
  //     the interface has no table of its own to keep in step.
  for (const view of views) {
    assert(/^#[0-9a-f]{6}$/i.test(view.color), `颜色要是十六进制：${view.color}`);
    assert(view.desc.length > 0, `${view.id} 要有一句说明`);
    assert(Array.isArray(view.badges), `${view.id} 的徽标要是一个数组`);
    assert(view.capability.grade.length > 0, `${view.id} 要有能力等级`);
    if (view.kind === 'netdisk') {
      assert(['cookie', 'window'].includes(view.loginKind), `登录方式要认得：${view.loginKind}`);
    } else {
      assert.strictEqual(view.loginKind, null, `${view.id} 没有网盘登录这一项`);
    }
  }
  assert.strictEqual(views.find((view) => view.id === 'xunlei').loginKind, 'window');
  assert.strictEqual(views.find((view) => view.id === 'quark').loginKind, 'cookie');
  assert(views.find((view) => view.id === 'xunlei').badges.includes('需转存 / 手动取链'));
  assert.strictEqual(views.find((view) => view.id === 'quark').badges.length, 0);

  console.log('check:source-parse OK');
}

main();
