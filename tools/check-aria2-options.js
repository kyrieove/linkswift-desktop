'use strict';

const assert = require('node:assert');
const { buildAddUriOptions } = require('../src/main/aria2');

// 1. 带 Cookie 的 headers → options.header 含 "Cookie: ..."
{
  const file = {
    name: 'test.zip',
    url: 'https://example.com/test.zip',
    headers: {
      Cookie: 'session_token=abc123xyz',
    },
  };
  const options = buildAddUriOptions(file);
  assert(Array.isArray(options.header), 'options.header 应为数组');
  assert(
    options.header.includes('Cookie: session_token=abc123xyz'),
    'options.header 应包含完整的 Cookie 头',
  );
}

// 2. 夸克域名 → split 和 max-connection-per-server 都是 '16'
{
  const file = {
    name: 'quark_file.bin',
    url: 'https://download.quark.cn/file/quark_file.bin',
    headers: {},
  };
  const options = buildAddUriOptions(file);
  assert.strictEqual(options.split, '16', '夸克域名 split 应为 16');
  assert.strictEqual(
    options['max-connection-per-server'],
    '16',
    '夸克域名 max-connection-per-server 应为 16',
  );
}

// 3. 百度域名 → 不设这两项（百度是否开 16 连接留给后续实测）
{
  const file = {
    name: 'baidu_file.bin',
    url: 'https://d.pcs.baidu.com/file/baidu_file.bin',
    headers: {},
  };
  const options = buildAddUriOptions(file);
  assert.strictEqual(options.split, undefined, '百度域名不应预先设置 split');
  assert.strictEqual(
    options['max-connection-per-server'],
    undefined,
    '百度域名不应预先设置 max-connection-per-server',
  );
}

// 4. UA、Referer 被正确转发
{
  const file = {
    name: 'test2.zip',
    url: 'https://example.com/files/test2.zip',
    headers: {
      'User-Agent': 'CustomUA/2.0',
      Referer: 'https://example.com/referer-page',
    },
  };
  const options = buildAddUriOptions(file);
  assert.strictEqual(options['user-agent'], 'CustomUA/2.0', 'User-Agent 应正确转发');
  assert.strictEqual(options.referer, 'https://example.com/referer-page', 'Referer 应正确转发');
  assert.strictEqual(options.out, 'test2.zip', 'out 文件名应保留');
}

// 补充：默认 referer 回退到 origin
{
  const file = {
    name: 'test3.zip',
    url: 'https://example.com/files/test3.zip',
    headers: {},
  };
  const options = buildAddUriOptions(file);
  assert.strictEqual(options.referer, 'https://example.com/', '未指定 Referer 时应回退到 origin');
}

console.log('check:aria2 OK');
