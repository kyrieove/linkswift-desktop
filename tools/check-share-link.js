'use strict';

const assert = require('node:assert');
const { parseShareLink, parseShareLinks } = require('../src/shared/providers');

// 1. 百度分享文案原样粘贴（用户报告的那段），提取码在句尾
{
  const text =
    '通过网盘分享的文件：支持v1.15.7.rar\n链接: https://pan.baidu.com/s/1LBO1Kp3yHPYVFxukMC7YFQ 提取码: c81v';
  const link = parseShareLink(text);
  assert(link, '整段分享文案应能解析');
  assert.strictEqual(link.provider, 'baidu');
  assert.strictEqual(link.passcode, 'c81v', '提取码应从句尾读出来');
  assert.strictEqual(
    link.raw,
    'https://pan.baidu.com/s/1LBO1Kp3yHPYVFxukMC7YFQ?pwd=c81v',
    '导航用的地址应是干净链接，且带上提取码',
  );
}

// 2. 单行输入框会剥掉换行，文案和链接会粘在一起
{
  const link = parseShareLink(
    '支持v1.15.7.rar链接: https://pan.baidu.com/s/1LBO1Kp3yHPYVFxukMC7YFQ提取码: c81v',
  );
  assert(link, '没有空格的粘连文案应能解析');
  assert.strictEqual(link.passcode, 'c81v');
  assert.strictEqual(link.raw, 'https://pan.baidu.com/s/1LBO1Kp3yHPYVFxukMC7YFQ?pwd=c81v');
}

// 3. 夸克分享文案，提取码用全角冒号
{
  const link = parseShareLink(
    '我用夸克网盘分享了「B站@热心网友033-通用版V5.0.zip」链接：https://pan.quark.cn/s/32a5d87a6d67 提取码：c81v',
  );
  assert(link, '夸克分享文案应能解析');
  assert.strictEqual(link.provider, 'quark');
  assert.strictEqual(link.shareId, '32a5d87a6d67');
  assert.strictEqual(link.passcode, 'c81v');
  assert.strictEqual(link.raw, 'https://pan.quark.cn/s/32a5d87a6d67', '夸克不理解 pwd 参数，不该加');
}

// 4. 干净的裸链接保持原样
{
  const link = parseShareLink('https://pan.quark.cn/s/32a5d87a6d67');
  assert.strictEqual(link.passcode, null, '没有提取码时不应编一个');
  assert.strictEqual(link.raw, 'https://pan.quark.cn/s/32a5d87a6d67');
}

// 5. 链接自带 pwd 参数时以它为提取码
{
  const link = parseShareLink('https://pan.baidu.com/s/1LBO1Kp3yHPYVFxukMC7YFQ?pwd=8k2m');
  assert.strictEqual(link.passcode, '8k2m');
  assert.strictEqual(link.raw, 'https://pan.baidu.com/s/1LBO1Kp3yHPYVFxukMC7YFQ?pwd=8k2m');
}

// 6. 中文标点紧贴链接时不该被算进地址
{
  const link = parseShareLink('看看这个https://pan.quark.cn/s/32a5d87a6d67。');
  assert.strictEqual(link.provider, 'quark');
  assert.strictEqual(link.shareId, '32a5d87a6d67');
}

// 7. 没有受支持的链接 → null
{
  assert.strictEqual(parseShareLink('not a link at all'), null);
  assert.strictEqual(parseShareLink('https://example.com/s/1abc'), null);
  assert.strictEqual(parseShareLink(''), null);
}

// 8. UC 与迅雷的分享链接
{
  const uc = parseShareLink('https://drive.uc.cn/s/9f8e7d6c5b4a3f2e1d0c?public=1');
  assert(uc, 'UC 分享链接应能解析');
  assert.strictEqual(uc.provider, 'uc');
  assert.strictEqual(uc.shareId, '9f8e7d6c5b4a3f2e1d0c');

  const xunlei = parseShareLink('https://pan.xunlei.com/s/VNabc123-_xyz?pwd=7x9k');
  assert(xunlei, '迅雷分享链接应能解析');
  assert.strictEqual(xunlei.provider, 'xunlei');
  assert.strictEqual(xunlei.shareId, 'VNabc123-_xyz');
  assert.strictEqual(xunlei.passcode, '7x9k');
}

// 9. 迅雷补丁：上游缺少的 getAccessToken 只补一次，且补在正确的位置
{
  const { patchSource } = require('../src/main/userscript');
  const sample = 'const config = {\n\t$xunlei: {\n\t\tapi: {\n\t\t\tgetLink: "https://api-pan.xunlei.com/drive/v1/files/",\n\t\t}\n\t}\n};';
  const once = patchSource(sample);
  assert(
    once.includes('getAccessToken: "https://xluser-ssl.xunlei.com/v1/auth/token"'),
    '迅雷刷新令牌的地址应被补进去',
  );
  assert.strictEqual(patchSource(once), once, '补过一次之后不应再补');
  assert.strictEqual(patchSource('no anchor here'), 'no anchor here', '没有锚点时原样返回');
}

// 10. 一次粘贴里有多条链接：三条都切出来，每条带自己的提取码，重复的只留一条
{
  const text = [
    '一次给你三条：',
    '夸克 https://pan.quark.cn/s/aaaaaaaaaaaa 提取码：aaaa',
    '百度 https://pan.baidu.com/s/1LBO1Kp3yHPYVFxukMC7YFQ?pwd=8k2m',
    'UC https://drive.uc.cn/s/9f8e7d6c5b4a3f2e1d0c?public=1',
    '重复的又贴了一次 https://pan.quark.cn/s/aaaaaaaaaaaa',
  ].join('\n');

  const links = parseShareLinks(text);
  assert.strictEqual(links.length, 3, `三条链接应各切出一条，实际 ${links.length}`);
  assert.deepStrictEqual(links.map((link) => link.provider), ['quark', 'baidu', 'uc']);
  assert.strictEqual(links[0].passcode, 'aaaa', '提取码跟在谁后面就属于谁');
  assert.strictEqual(links[1].passcode, '8k2m');

  // A paste with one unsupported link still returns the supported ones.
  const mixed = parseShareLinks('https://example.com/s/1abc 和 https://pan.quark.cn/s/32a5d87a6d67');
  assert.deepStrictEqual(mixed.map((link) => link.provider), ['quark']);
  assert.deepStrictEqual(parseShareLinks('一个字都没有'), []);
}

// 11. 处理中的同一链接去重，已完成的不挡路
{
  const { JobManager } = require('../src/main/job');
  const manager = new JobManager({
    store: { getSettings: () => ({ allowTransfer: false }) },
    userscript: {},
    vendor: {},
    resources: {},
    partition: 'test',
    preloadPath: 'x',
    emit: () => {},
    daemon: {},
    tasks: { save: () => {}, remove: () => {}, all: () => [], archive: () => 0, unarchive: () => 0, removeMany: () => 0 },
    health: { record: () => {} },
  });
  // Building a real job opens a window; this case is about the de-duplication rule.
  manager.buildJob = ({ link }) => ({
    id: `job-${link.shareId}`,
    link,
    createdAt: Date.now(),
    state: { phase: 'extracting' },
    prepare: () => -1,
    load: () => {},
    snapshot() {
      return { id: this.id, link: this.link, state: this.state, createdAt: this.createdAt };
    },
  });

  const url = 'https://pan.quark.cn/s/32a5d87a6d67';
  const first = manager.submit(url);
  assert.strictEqual(first.jobs.length, 1);
  assert(first.jobs[0].jobId, '第一条应建成任务');

  const second = manager.submit(url);
  assert.strictEqual(second.jobs[0].duplicateOf, first.jobs[0].jobId, '处理中的同一链接应判重');
  assert.strictEqual(second.ok, false, '全是重复时不算新建成功');

  // Once it is done, the same link is allowed again: the direct link may be stale.
  manager.jobs.get(first.jobs[0].jobId).state = { phase: 'done', files: [] };
  const third = manager.submit(url);
  assert(third.jobs[0].jobId, '已完成的任务不该挡住重新提交');
  assert.notStrictEqual(third.jobs[0].jobId, undefined);

  const bad = manager.submit('不是链接');
  assert.strictEqual(bad.ok, false);
  assert(bad.jobs[0].error.includes('看不懂'), '无法识别的输入要单独说明');
}

console.log('check:share-link OK');