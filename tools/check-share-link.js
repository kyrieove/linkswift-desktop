'use strict';

const assert = require('node:assert');
const { parseShareLink } = require('../src/shared/providers');

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

console.log('check:share-link OK');
