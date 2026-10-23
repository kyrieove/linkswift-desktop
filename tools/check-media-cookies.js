'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { exportSessionCookies } = require('../src/main/media-cookies');

/**
 * 媒体登录的 cookie 导出，断言的是文件本身。
 *
 * yt-dlp 读不到 Electron 的分区，只认 `--cookies <file>` 给的 Netscape 格式
 * 文件。格式不能自己发挥：七列，少一列 yt-dlp 会把整条丢掉；`#HttpOnly_` 黏在
 * domain 那一列前面，不是单独一列；domain 前面的点决定这个 cookie 发不发子域。
 *
 * 这里没有 Electron 也没有网络。会话是假的，文件是真的，写完逐字比对。
 */

const ROOT = path.join(__dirname, '..');
const URL = 'https://example.com/watch?v=1';

/** 一批假的 cookie，覆盖域、子域、httpOnly、会话 cookie 和过期时间。 */
const COOKIES = [
  {
    name: 'SID',
    value: 'abc123',
    domain: '.example.com',
    path: '/',
    secure: true,
    httpOnly: false,
    hostOnly: false,
    session: false,
    expirationDate: 1767225600,
  },
  {
    name: 'pref',
    value: 'zh-CN',
    domain: 'example.com',
    path: '/',
    secure: false,
    httpOnly: false,
    hostOnly: true,
    session: true,
  },
  {
    name: 'token',
    value: 'hidden',
    domain: '.example.com',
    path: '/api',
    secure: true,
    httpOnly: true,
    hostOnly: false,
    session: false,
    expirationDate: 1767225600,
  },
  {
    // 没有 hostOnly 标记的老 cookie：看域名有没有前导点。
    name: 'legacy',
    value: 'old',
    domain: '.legacy.test',
    path: '/',
    secure: false,
    httpOnly: false,
    session: true,
  },
];

/** 期望写出来的文件全文，一个字都不能差。 */
const EXPECTED = [
  '# Netscape HTTP Cookie File',
  '# Written by Unidownload for yt-dlp. Do not edit.',
  '.example.com\tTRUE\t/\tTRUE\t1767225600\tSID\tabc123',
  'example.com\tFALSE\t/\tFALSE\t0\tpref\tzh-CN',
  '#HttpOnly_.example.com\tTRUE\t/api\tTRUE\t1767225600\ttoken\thidden',
  '.legacy.test\tTRUE\t/\tFALSE\t0\tlegacy\told',
  '',
].join('\n');

/**
 * @param {import('../src/main/media-cookies').SessionCookie[]} cookies
 */
function fakeSession(cookies) {
  return {
    cookies: {
      async get(filter) {
        assert.ok(filter && filter.url, '要按地址取 cookie');
        return cookies;
      },
    },
  };
}

/** @param {string} child @param {string} parent */
function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * 假的 userData 目录。刻意放在系统临时目录外面：这个检查要证明导出落在给定的
 * 目录里，而不是模块自己挑了个临时目录。
 */
function makeUserDataDir() {
  return fs.mkdtempSync(path.join(ROOT, '.tmp-media-cookies-'));
}

let passed = 0;
/** @param {string} name @param {() => any} body */
async function check(name, body) {
  await body();
  passed += 1;
  console.log(`  ok  ${name}`);
}

async function main() {
  console.log('check:media-cookies');

  await check('导出出来的文件逐字符合 Netscape 格式', async () => {
    const dir = makeUserDataDir();
    try {
      const file = await exportSessionCookies({
        session: fakeSession(COOKIES),
        url: URL,
        userDataDir: dir,
        fileName: 'media-cookies-test.txt',
      });
      assert.ok(file, '有 cookie 就要给出文件路径');
      const content = fs.readFileSync(file, 'utf8');
      assert.strictEqual(content, EXPECTED, '文件内容要与 Netscape 格式逐字一致');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('每一列都对：域名、flag、路径、secure、过期时间、名和值', async () => {
    const dir = makeUserDataDir();
    try {
      const file = await exportSessionCookies({
        session: fakeSession(COOKIES),
        url: URL,
        userDataDir: dir,
        fileName: 'media-cookies-test.txt',
      });
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const data = lines.slice(2).map((line) => line.split('\t'));
      for (const row of data) {
        assert.strictEqual(row.length, 7, `每行都要是七列：${row.join('|')}`);
      }
      const sid = data[0];
      assert.strictEqual(sid[0], '.example.com', '子域 cookie 的域名带前导点');
      assert.strictEqual(sid[1], 'TRUE', '子域 cookie 的 flag 是 TRUE');
      assert.strictEqual(sid[2], '/', '路径原样写');
      assert.strictEqual(sid[3], 'TRUE', 'secure 写成 TRUE');
      assert.strictEqual(sid[4], '1767225600', '过期时间是 Unix 秒数');
      assert.strictEqual(sid[5], 'SID', '名字原样写');
      assert.strictEqual(sid[6], 'abc123', '值原样写');

      const pref = data[1];
      assert.strictEqual(pref[0], 'example.com', 'host-only 的域名不带点');
      assert.strictEqual(pref[1], 'FALSE', 'host-only 的 flag 是 FALSE');
      assert.strictEqual(pref[4], '0', '会话 cookie 的过期时间是 0');

      const token = data[2];
      assert.strictEqual(token[0], '#HttpOnly_.example.com', 'httpOnly 的前缀黏在域名那一列前面');
      assert.strictEqual(token[2], '/api', '路径原样写');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('值里的制表符和换行不会写坏文件', async () => {
    const dir = makeUserDataDir();
    try {
      const file = await exportSessionCookies({
        session: fakeSession([
          ...COOKIES,
          { name: 'tabbed', value: 'a\tb', domain: '.example.com', path: '/', secure: true, hostOnly: false },
          { name: 'broken', value: 'a\nb', domain: '.example.com', path: '/', secure: true, hostOnly: false },
        ]),
        url: URL,
        userDataDir: dir,
        fileName: 'media-cookies-test.txt',
      });
      const content = fs.readFileSync(file, 'utf8');
      assert.ok(!content.includes('tabbed'), '带制表符的值要丢掉');
      assert.ok(!content.includes('broken'), '带换行的值要丢掉');
      const lines = content.split('\n').filter(Boolean);
      assert.strictEqual(lines.length, 6, '剩下的行数不能被带坏的值改变');
      for (const line of lines.slice(2)) {
        assert.strictEqual(line.split('\t').length, 7, `每行都要是七列：${line}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('没有 cookie 就不写文件', async () => {
    const dir = makeUserDataDir();
    try {
      const file = await exportSessionCookies({
        session: fakeSession([]),
        url: URL,
        userDataDir: dir,
        fileName: 'media-cookies-test.txt',
      });
      assert.strictEqual(file, null, '没有 cookie 就没有文件路径');
      assert.deepStrictEqual(fs.readdirSync(dir), [], '目录里不该多出文件');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('文件落在给定的 userData 目录里，不在系统临时目录', async () => {
    const dir = makeUserDataDir();
    try {
      assert.ok(!isInside(os.tmpdir(), dir), '测试用的 userData 目录不能放在系统临时目录里');
      const file = await exportSessionCookies({
        session: fakeSession(COOKIES),
        url: URL,
        userDataDir: dir,
        fileName: 'media-cookies-test.txt',
      });
      assert.ok(isInside(dir, file), 'cookie 文件要落在给定的 userData 目录里');
      assert.ok(!isInside(os.tmpdir(), file), 'cookie 文件不能落在系统临时目录里');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('文件只有当前用户能读', async () => {
    if (process.platform === 'win32') return;
    const dir = makeUserDataDir();
    try {
      const file = await exportSessionCookies({
        session: fakeSession(COOKIES),
        url: URL,
        userDataDir: dir,
        fileName: 'media-cookies-test.txt',
      });
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, '权限要是 0600');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log(`OK: ${passed} media-cookie cases`);
}

main().then(
  () => console.log('check:media-cookies OK'),
  (error) => {
    console.error(`check:media-cookies FAILED: ${error.message}`);
    process.exit(1);
  },
);
