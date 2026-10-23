'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 会话 cookie → Netscape cookie 文件。
 *
 * yt-dlp 读不到 Electron 的分区，它只认 `--cookies <file>` 给的 Netscape 格式
 * 文件。所以用户在这个应用自己的窗口里登录完，cookie 留在会话里，要交给
 * yt-dlp 就得先导出成文件。
 *
 * 格式照 yt-dlp 自己的读法写（`yt_dlp/cookies.py` 的 `YoutubeDLCookieJar`）：
 *
 *   # Netscape HTTP Cookie File
 *   <domain> \t <flag> \t <path> \t <secure> \t <expiration> \t <name> \t <value>
 *
 * 七列，少一列 yt-dlp 会把整条丢掉。`#HttpOnly_` 是黏在 domain 那一列前面的
 * 前缀，不是单独一列。`expiration` 是 Unix 秒数，0 表示会话 cookie。domain
 * 前面带点表示这个 cookie 也发给子域，Python 的 MozillaCookieJar 靠这一点判断，
 * 所以带点的域名和 TRUE 这一列要配套写。
 */

/**
 * @typedef {object} SessionCookie
 * @property {string} name
 * @property {string} value
 * @property {string} [domain]
 * @property {string} [path]
 * @property {boolean} [secure]
 * @property {boolean} [httpOnly]
 * @property {boolean} [hostOnly]
 * @property {boolean} [session]
 * @property {number} [expirationDate]
 */

/**
 * @typedef {object} CookieSession
 * @property {{ get: (filter: { url: string }) => Promise<SessionCookie[]> }} cookies
 */

/** yt-dlp 的读法认的第一行。 */
const NETSCAPE_HEADER = '# Netscape HTTP Cookie File';

/** httpOnly 的标记，黏在 domain 那一列前面。 */
const HTTPONLY_PREFIX = '#HttpOnly_';

/**
 * cookie 名和值里不能有制表符或换行。这一行是按制表符分列的，没有转义机制，
 * 带一个进去整行就废了，所以这样的 cookie 直接丢掉。
 *
 * @param {string} text
 * @returns {boolean}
 */
function isPlainField(text) {
  return !/[\t\r\n]/.test(text);
}

/**
 * domain 那一列和 flag 那一列。
 *
 * flag 是 TRUE 表示这个 cookie 也发给子域。Electron 给的 domain 带不带前导点
 * 两种情况都有，所以以 `hostOnly` 为准，没有这个标记时才看前导点。
 *
 * @param {SessionCookie} cookie
 * @returns {{ domain: string, flag: string } | null}
 */
function domainFields(cookie) {
  const raw = String(cookie.domain ?? '').trim();
  const bare = raw.replace(/^\.+/, '');
  if (!bare) return null;
  const hostOnly = typeof cookie.hostOnly === 'boolean' ? cookie.hostOnly : !raw.startsWith('.');
  return {
    domain: hostOnly ? bare : `.${bare}`,
    flag: hostOnly ? 'FALSE' : 'TRUE',
  };
}

/**
 * 一条 cookie 写成一行。
 *
 * @param {SessionCookie} cookie
 * @returns {string | null} 写不进去的 cookie 返回 null
 */
function cookieLine(cookie) {
  const name = String(cookie.name ?? '');
  const value = String(cookie.value ?? '');
  if (!name || !isPlainField(name) || !isPlainField(value)) return null;
  const cookiePath = String(cookie.path || '/');
  if (!isPlainField(cookiePath)) return null;
  const fields = domainFields(cookie);
  if (!fields) return null;
  // 会话 cookie 没有过期时间，写 0。
  const expires = cookie.session || !cookie.expirationDate ? '0' : String(Math.floor(cookie.expirationDate));
  const domain = cookie.httpOnly ? HTTPONLY_PREFIX + fields.domain : fields.domain;
  return [domain, fields.flag, cookiePath, cookie.secure ? 'TRUE' : 'FALSE', expires, name, value].join('\t');
}

/**
 * 把一批 cookie 拼成 Netscape 格式的全文。
 *
 * @param {SessionCookie[]} cookies
 * @returns {string}
 */
function buildJar(cookies) {
  const lines = [NETSCAPE_HEADER, '# Written by Unidownload for yt-dlp. Do not edit.'];
  for (const cookie of cookies || []) {
    const line = cookieLine(cookie);
    if (line) lines.push(line);
  }
  return lines.join('\n') + '\n';
}

/**
 * 把会话里某个地址的 cookie 导出成 Netscape 格式文件。
 *
 * 文件里是活的登录凭证，所以写在应用自己的 userData 目录里，只给当前用户读。
 * 没有 cookie 就不写文件：调用方拿不到路径，也就不会给 yt-dlp 传 `--cookies`。
 *
 * @param {{ session: CookieSession, url: string, userDataDir: string, fileName?: string }} input
 * @returns {Promise<string | null>} 文件路径；没有 cookie 时是 null
 */
async function exportSessionCookies({ session, url, userDataDir, fileName }) {
  if (!session || !session.cookies || !url || !userDataDir) return null;
  let cookies = [];
  try {
    cookies = await session.cookies.get({ url });
  } catch {
    return null;
  }
  if (!Array.isArray(cookies) || !cookies.length) return null;

  const dir = path.resolve(userDataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, fileName || 'media-cookies.txt');
  fs.writeFileSync(file, buildJar(cookies), { encoding: 'utf8', mode: 0o600 });
  try {
    // 文件已经存在时 writeFileSync 不改权限，所以再 chmod 一次。
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows 上只有只读位，改不了也不影响。
  }
  return file;
}

module.exports = { exportSessionCookies, buildJar, NETSCAPE_HEADER, HTTPONLY_PREFIX };
