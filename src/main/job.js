'use strict';

const { BrowserWindow, clipboard, app, shell, session } = require('electron');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { INTERNAL } = require('../shared/protocol');
const { PROVIDERS, getProvider } = require('../shared/providers');
const { buildSource, getSource, normalizeSource, parseSources, sourceKey, sourceViews } = require('../shared/sources');
const { mediaOptions } = require('../shared/media-options');
const aria2 = require('./aria2');
const { createTransfer, resolveEngineId } = require('./engines');
const { readVersion } = require('./engines/ytdlp-transfer');
const { resolveBinary, updateBinary } = require('./ytdlp-binary');
const { status: ffmpegStatus } = require('./ffmpeg');
const { performChromeLogin } = require('./chrome-login');
const { exportSessionCookies } = require('./media-cookies');

const DEBUG = process.env.LINKSWIFT_DEBUG === '1';
if (DEBUG) console.log('[DBG] LINKSWIFT_DEBUG enabled');

/** No bytes for this long, while still downloading, is a stall worth telling the user about. */
const JOB_STALL_AFTER_MS = 60_000;

/**
 * The phases that count as "already working on this link". A finished job does
 * not block the same link from being submitted again.
 *
 * @type {Set<import('../shared/protocol').JobPhase['phase']>}
 */
const ACTIVE_PHASES = new Set([
  'loading',
  'extracting',
  'needs-human',
  'linked',
  'delivering',
  'downloading',
  'paused',
]);

/** @param {unknown} ids @returns {string[]} */
function toIdList(ids) {
  return Array.isArray(ids) ? ids.map((id) => String(id)).filter(Boolean) : [];
}

/**
 * The userscript gates its own setup on these two literals (source lines 220-221,
 * checked at 8306). Seeding them skips the "点我点亮" button entirely, and with it
 * the location.reload() that button ends in.
 */
const INIT_CODE = '865746';
const INIT_LICENSE = 'AGPL3';

/**
 * What the user can do about a failure, in one sentence. The failure code is the
 * only thing that decides it, so the UI never has to read the message text.
 *
 * @type {Partial<Record<import('../shared/protocol').FailureCode, string>>}
 */
const FAILURE_HINTS = {
  'upstream-redesigned': '页面结构变了：点重试会重新拉取最新脚本，再跑一遍。',
  'unsupported-provider': '这个网盘目前不支持一键取链。',
  'needs-transfer': '文件需要先转存到你自己的网盘，开启「允许自动转存」后重试。',
  'link-expired': '直链已过期：点重试重新取一次链接。',
  'aria2-down': '下载器没在运行：到设置里看一眼下载器状态，再点继续。',
  'chrome-not-found': '找不到已登录的浏览器：先按提示登录一次。',
  passcode: '提取码不对或缺失：把带 ?pwd= 的完整链接再粘一次。',
  'passcode-wrong': '提取码不对：把带 ?pwd= 的完整链接再粘一次。',
  'rate-limited': '被网盘限流了：等几分钟再重试。',
  network: '网络没通：检查网络后重试。',
  timeout: '等待超时：点重试再跑一次。',
  'link-invalid': '分享链接本身失效了，换一条链接。',
  'file-missing': '要下的文件已经不在这个分享里了。',
  'no-files': '没能勾选到文件：点重试，或到窗口里手动勾一个。',
  'extract-failed': '网盘接口这次没返回直链：点重试，或先打开窗口看看。',
  delivery: '直链拿到了但没投递成功：检查下载器设置后重试。',
};

/**
 * The userscript reports its own failures as dialog text rather than exceptions,
 * so the dialog text is the only signal available. The patterns are the upstream
 * strings, which makes them evidence rather than guesses.
 *
 * @type {Array<[RegExp, { human: import('../shared/protocol').HumanReason }
 *   | { fail: import('../shared/protocol').FailureCode, message: string }]>}
 */
const DIALOG_OUTCOMES = [
  [
    /分享(的文件)?已?经?被?(取消|删除|屏蔽)|链接(已)?失效|来晚了/,
    { fail: 'link-invalid', message: '分享已失效：文件被取消、删除，或链接不完整。' },
  ],
  [
    /请先勾选|请打开文件夹/,
    { fail: 'no-files', message: '没能在页面上勾选到文件。分享页结构可能变了。' },
  ],
  [/请先登录|需要登录|超出游客|31001|登录已过期|凭证已过期|令牌已过期/, { human: 'login' }],
  [/提取码|请输入密码/, { human: 'passcode' }],
  [/验证码|安全验证/, { human: 'captcha' }],
  [/超过\s*50\s*(M|MB|兆)|大小超过可获取限制|保存到网盘/, { transfer: true }],
];

/**
 * What the share page itself says when a driver step finds no button. The page
 * knows why the file is not there, so its words beat guessing "upstream changed".
 *
 * @type {Array<[RegExp, { code: import('../shared/protocol').FailureCode, message: string }]>}
 */
const PAGE_OUTCOMES = [
  [
    // 迅雷 renders "失效时间：永久有效" on a healthy share, so a bare 失效 must
    // not count; the wording has to say the share is gone.
    /分享(的)?(文件|内容)?[^。\n]{0,12}(已|被)(取消|删除|屏蔽)|分享已失效|链接(已)?失效|链接(不存在|无效)|来晚了|页面不存在|分享(已)?过期/i,
    { code: 'link-invalid', message: '分享已失效：文件被取消、删除，或链接不完整。' },
  ],
  [
    /文件.*(不存在|已删除|已被删除)|内容.*(违规|屏蔽)/,
    { code: 'file-missing', message: '文件不存在，可能已被分享者删除或屏蔽。' },
  ],
  [
    /提取码(错误|不正确)|密码(错误|不正确)/,
    { code: 'passcode-wrong', message: '提取码不对，请检查后重新粘贴。' },
  ],
  [
    /超过\s*50\s*(M|MB|兆)|文件(过大|太大)|需(要|先)[^。]{0,12}转存|请[^。]{0,12}保存到网盘/,
    {
      code: 'needs-transfer',
      message: '这个文件超过 50MB，百度不允许直接从分享页取直链，需要先转存到你自己的网盘。',
    },
  ],
  [
    /访问.*频繁|操作.*频繁|请稍后|限流/,
    { code: 'rate-limited', message: '网盘暂时限流了这个账号，等几分钟再试。' },
  ],
];

/**
 * Maps aria2 error code and messages to user-facing descriptions.
 *
 * @param {string | null | undefined} code
 * @param {string | null | undefined} rawMessage
 * @returns {{ message: string, detail: string }}
 */
function describeAria2Error(code, rawMessage) {
  const msg = String(rawMessage || '');
  const c = String(code || '');

  let message = '下载失败。';
  if (msg.includes('412') || c === '412') {
    message = '412：网盘拒绝请求，可能是登录 Cookie 失效或链接已过期。';
  } else if (msg.includes('403') || c === '403') {
    message =
      '403：网盘拒绝下载。要么直链过期，要么这个直链要求登录态（UC 和夸克的下载地址不带账号 Cookie 就会这样）。先点「登录网盘」，再点「重新取链」。';
  } else if (c === '22') {
    if (msg.includes('412')) {
      message = '412：网盘拒绝请求，可能是登录 Cookie 失效或链接已过期。';
    } else if (msg.includes('403')) {
      message =
        '403：网盘拒绝下载。要么直链过期，要么这个直链要求登录态（UC 和夸克的下载地址不带账号 Cookie 就会这样）。先点「登录网盘」，再点「重新取链」。';
    } else {
      message = msg ? `HTTP 请求失败（${msg}）` : '下载服务器返回 HTTP 错误，可能是 Cookie 或直链失效。';
    }
  } else if (c === '6' || c === '2' || c === '19' || /network|timeout|connect|resolve/i.test(msg)) {
    message = '网络错误：无法连接到下载服务器，请检查网络。';
  } else if (c === '9') {
    message = '磁盘空间不足。';
  } else if (c === '3') {
    message = '404：下载资源不存在或已被删除。';
  } else if (msg) {
    message = msg;
  } else if (c) {
    message = `aria2 错误（错误码 ${c}）。`;
  }

  const detailLines = [];
  if (c) detailLines.push(`errorCode: ${c}`);
  if (msg) detailLines.push(`errorMessage: ${msg}`);

  return { message, detail: detailLines.join('\n') };
}

/**
 * Pull the files out of the aria2.addUri body the userscript builds.
 *
 * The parameter list is not fixed-position: the script unshifts its RPC token
 * onto the front when a secret is configured. Find the pieces by shape.
 *
 * @param {string | null} body
 * @returns {import('../shared/protocol').ExtractedFile[] | null}
 */
function extractFromAria2Body(body) {
  if (!body) return null;

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || parsed.method !== 'aria2.addUri' || !Array.isArray(parsed.params)) return null;

  const uris = parsed.params.find((entry) => Array.isArray(entry));
  const options = parsed.params.find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
  if (!Array.isArray(uris) || uris.length === 0) return null;

  const headerLines = Array.isArray(options?.header) ? options.header : [];
  /** @type {Record<string, string>} */
  const headers = {};
  for (const line of headerLines) {
    if (typeof line !== 'string') continue;
    const separator = line.indexOf(':');
    if (separator > 0) headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }

  const files = [];
  for (const url of uris) {
    let name = options?.out;
    if (!name) {
      try {
        name = path.basename(new URL(String(url)).pathname) || 'download';
      } catch {
        name = 'download';
      }
    }
    const file = {
      url: String(url),
      name: String(name),
      headers,
    };
    files.push(aria2.validateExtractedFile(file));
  }
  return files;
}

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024; // 32 MiB

function parseIpv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255 || (parts[i].length > 1 && parts[i].startsWith('0'))) {
      return null;
    }
    num = (num << 8) | n;
  }
  return num >>> 0;
}

function cidrToMask(bits) {
  return bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0);
}

function parseCidr(cidr) {
  const [ipStr, bitsStr] = cidr.split('/');
  const ip = parseIpv4(ipStr);
  const bits = parseInt(bitsStr, 10);
  const mask = cidrToMask(bits);
  return { network: (ip & mask) >>> 0, mask };
}

/**
 * Full classification table based on IANA IPv4 Special-Purpose Address Registry.
 * Any address in these ranges is not globally reachable on the public Internet.
 */
const NON_PUBLIC_IPV4_CIDRS = [
  '0.0.0.0/8',          // RFC 1122 This host on this network
  '10.0.0.0/8',         // RFC 1918 Private-Use
  '100.64.0.0/10',      // RFC 6598 Shared Address Space (CGNAT)
  '127.0.0.0/8',        // RFC 1122 Loopback
  '169.254.0.0/16',     // RFC 3927 Link-Local
  '172.16.0.0/12',      // RFC 1918 Private-Use
  '192.0.0.0/24',       // RFC 6890 IETF Protocol Assignments
  '192.0.2.0/24',       // RFC 5737 Documentation (TEST-NET-1)
  '192.88.99.0/24',     // RFC 7526 6to4 Relay Anycast
  '192.168.0.0/16',     // RFC 1918 Private-Use
  '198.18.0.0/15',      // RFC 2544 Benchmarking
  '198.51.100.0/24',    // RFC 5737 Documentation (TEST-NET-2)
  '203.0.113.0/24',     // RFC 5737 Documentation (TEST-NET-3)
  '224.0.0.0/4',        // RFC 5771 Multicast
  '240.0.0.0/4',        // RFC 1112 Reserved for Future Use
  '255.255.255.255/32', // RFC 919 Limited Broadcast
].map(parseCidr);

function isPrivateIpv4(ip) {
  const num = parseIpv4(ip);
  if (num === null) return true;
  for (const { network, mask } of NON_PUBLIC_IPV4_CIDRS) {
    if (((num & mask) >>> 0) === network) return true;
  }
  return false;
}

function isAllowedPublicIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const trimmed = ip.trim().toLowerCase();

  // IPv4 check
  if (net.isIPv4(trimmed)) {
    return !isPrivateIpv4(trimmed);
  }

  // IPv6 check
  if (net.isIPv6(trimmed)) {
    // IPv4-mapped IPv6 (::ffff:0:0/96, e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
    if (trimmed.startsWith('::ffff:')) {
      const rest = trimmed.slice(7);
      if (net.isIPv4(rest)) {
        return !isPrivateIpv4(rest);
      }
      const parts = rest.split(':');
      if (parts.length === 2) {
        const p1 = parseInt(parts[0], 16);
        const p2 = parseInt(parts[1], 16);
        if (!Number.isNaN(p1) && !Number.isNaN(p2)) {
          const ipv4Str = `${(p1 >> 8) & 0xff}.${p1 & 0xff}.${(p2 >> 8) & 0xff}.${p2 & 0xff}`;
          if (net.isIPv4(ipv4Str)) {
            return !isPrivateIpv4(ipv4Str);
          }
        }
      }
      return false;
    }

    if (trimmed === '::1' || trimmed === '::') return false; // Loopback / unspecified
    if (/^f[cd][0-9a-f]{2}:/i.test(trimmed)) return false; // Unique local (fc00::/7)
    if (/^fe[89ab][0-9a-f]:/i.test(trimmed)) return false; // Link-local (fe80::/10)
    if (/^ff[0-9a-f]{2}:/i.test(trimmed)) return false; // Multicast (ff00::/8)
    if (/^2001:0?db8:/i.test(trimmed)) return false; // Documentation (2001:db8::/32)
    if (/^100::/i.test(trimmed)) return false; // Discard prefix (100::/64)

    return true;
  }

  return false;
}

function isPrivateIp(ip) {
  return !isAllowedPublicIp(ip);
}

async function validateProxyTargetUrl(targetUrl, allowLocalFixture) {
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    throw new Error(`禁止代理非 http/https 协议目标: ${targetUrl.protocol}`);
  }

  if (allowLocalFixture) {
    return null;
  }

  const hostname = targetUrl.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('禁止访问 localhost 目标 (SSRF 防御)');
  }

  let cleanHost = hostname;
  if (cleanHost.startsWith('[') && cleanHost.endsWith(']')) {
    cleanHost = cleanHost.slice(1, -1);
  }

  if (net.isIP(cleanHost)) {
    if (!isAllowedPublicIp(cleanHost)) {
      throw new Error(`禁止访问私有或本地网络目标 (SSRF 防御): ${hostname}`);
    }
    return cleanHost;
  }

  let addresses;
  try {
    addresses = await dns.promises.lookup(hostname, { all: true });
  } catch (err) {
    throw new Error(`DNS 解析失败: ${hostname} (${err.message})`);
  }

  if (!addresses || addresses.length === 0) {
    throw new Error(`DNS 解析无结果: ${hostname}`);
  }

  for (const addr of addresses) {
    if (!isAllowedPublicIp(addr.address)) {
      throw new Error(`禁止访问私有或本地网络目标 (SSRF 防御): ${hostname} -> ${addr.address}`);
    }
  }

  return addresses[0].address;
}

/**
 * @param {{ url: string, method: string, headers: Record<string, string> }} options
 * @param {string | null} body
 * @param {string | null} [pinnedIp]
 * @returns {Promise<{ statusCode: number, statusMessage: string, rawHeaders: string[], headers: Record<string, string | string[] | undefined>, setCookie: string[], buffer: Buffer }>}
 */
function hop(options, body, pinnedIp) {
  return new Promise((resolve, reject) => {
    const target = new URL(options.url);
    const transport = target.protocol === 'https:' ? https : http;

    const requestOptions = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method,
      headers: {
        ...options.headers,
        // Without an explicit length Node falls back to chunked encoding, and
        // quark's API answers a chunked POST with 400.
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };

    if (pinnedIp) {
      requestOptions.lookup = (hostname, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        const family = pinnedIp.includes(':') ? 6 : 4;
        if (opts && typeof opts === 'object' && opts.all) {
          callback(null, [{ address: pinnedIp, family }]);
        } else {
          callback(null, pinnedIp, family);
        }
      };
    }

    const request = transport.request(requestOptions, (response) => {
      let totalBytes = 0;
      let destroyed = false;
      const chunks = [];
      response.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          if (!destroyed) {
            destroyed = true;
            response.destroy();
            request.destroy();
            reject(new Error('响应体积超出 32 MiB 上限'));
          }
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', (err) => {
        if (!destroyed) reject(err);
      });
      response.on('aborted', () => {
        if (!destroyed) reject(new Error('响应连接中断'));
      });
      response.on('end', () => {
        if (destroyed) return;
        const rawSetCookie = response.headers['set-cookie'];
        const setCookie = Array.isArray(rawSetCookie)
          ? rawSetCookie
          : rawSetCookie ? [rawSetCookie] : [];
        resolve({
          statusCode: response.statusCode ?? 0,
          statusMessage: response.statusMessage ?? '',
          rawHeaders: response.rawHeaders ?? [],
          headers: response.headers ?? {},
          setCookie,
          buffer: Buffer.concat(chunks),
        });
      });
    });

    request.on('error', reject);
    request.setTimeout(30000, () => request.destroy(new Error('请求超时')));
    if (body) request.write(body);
    request.end();
  });
}

/**
 * @param {string} headerStr
 * @param {string} currentUrl
 */
function parseSetCookie(headerStr, currentUrl) {
  const parts = headerStr.split(';').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const first = parts[0];
  const eqIdx = first.indexOf('=');
  if (eqIdx === -1) return null;
  const name = first.slice(0, eqIdx).trim();
  const value = first.slice(eqIdx + 1).trim();

  const details = {
    url: currentUrl,
    name,
    value,
    secure: false,
    httpOnly: false,
  };

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const pEq = part.indexOf('=');
    const attrName = (pEq === -1 ? part : part.slice(0, pEq)).trim().toLowerCase();
    const attrVal = pEq === -1 ? '' : part.slice(pEq + 1).trim();

    if (attrName === 'domain' && attrVal) {
      details.domain = attrVal.replace(/^\./, '');
    } else if (attrName === 'path' && attrVal) {
      details.path = attrVal;
    } else if (attrName === 'secure') {
      details.secure = true;
    } else if (attrName === 'httponly') {
      details.httpOnly = true;
    } else if (attrName === 'max-age' && attrVal) {
      const maxAge = parseInt(attrVal, 10);
      if (!Number.isNaN(maxAge)) {
        details.expirationDate = Math.floor(Date.now() / 1000) + maxAge;
      }
    } else if (attrName === 'expires' && attrVal && details.expirationDate === undefined) {
      const exp = Date.parse(attrVal);
      if (!Number.isNaN(exp)) {
        details.expirationDate = Math.floor(exp / 1000);
      }
    }
  }

  return details;
}

function hostMatchesPattern(hostname, pattern) {
  const normHost = hostname.toLowerCase();
  const normPat = pattern.toLowerCase();
  if (normPat.startsWith('*.')) {
    const root = normPat.slice(2);
    return normHost === root || normHost.endsWith('.' + root);
  }
  return normHost === normPat || normHost.endsWith('.' + normPat);
}

function validateProviderPolicy(targetUrl, providerId, allowLocalFixture) {
  if (allowLocalFixture && (targetUrl.hostname === '127.0.0.1' || targetUrl.hostname === 'localhost')) {
    return { attachCookies: true };
  }
  if (!providerId) {
    return { attachCookies: false };
  }
  const provider = getProvider(providerId);
  if (!provider) {
    throw new Error(`未知网盘 provider: ${providerId}`);
  }

  const hostname = targetUrl.hostname.toLowerCase();

  // Check if target matches another known provider's authenticated hosts
  for (const [otherId, otherProv] of Object.entries(PROVIDERS)) {
    if (otherId === provider.id) continue;
    const matchesOther = (otherProv.authenticatedHosts || []).some((h) => hostMatchesPattern(hostname, h));
    if (matchesOther) {
      throw new Error(`禁止跨网盘访问: 目标 ${hostname} 属于 ${otherProv.label}，非当前网盘 (${provider.label})`);
    }
  }

  const authHosts = provider.authenticatedHosts || [];
  const extraHosts = provider.extraRequestHosts || [];

  const isAuth = authHosts.some((h) => hostMatchesPattern(hostname, h));
  const isExtra = extraHosts.some((h) => hostMatchesPattern(hostname, h));

  if (!isAuth && !isExtra) {
    throw new Error(`目标域名不在当前网盘 (${provider.label}) 允许范围内: ${hostname}`);
  }

  return { attachCookies: isAuth };
}

/**
 * Node's fetch refuses to send forbidden header names such as Referer and
 * Origin, and the netdisk APIs need both. Use the raw HTTP client instead.
 *
 * @param {{ url: string, method: string, headers: Record<string, string>, body: string | null, provider?: string, allowLocalFixture?: boolean }} request
 * @param {import('electron').Session} [ses]
 * @returns {Promise<{ ok: boolean, status: number, statusText: string, text: string, headers: string, finalUrl: string }>}
 */
async function proxyRequest({ url, method, headers, body, provider, allowLocalFixture = false }, ses) {
  const MAX_HOPS = 10;
  let currentUrl = new URL(url);
  let currentMethod = method;
  let currentHeaders = { ...(headers ?? {}) };
  let currentBody = body;

  let callerCookie = null;
  if (headers) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'cookie') {
        callerCookie = headers[key];
        break;
      }
    }
  }

  for (let hopCount = 0; hopCount < MAX_HOPS; hopCount++) {
    const policy = validateProviderPolicy(currentUrl, provider, allowLocalFixture);
    const pinnedIp = await validateProxyTargetUrl(currentUrl, allowLocalFixture);
    const hopHeaders = { ...currentHeaders };

    if (ses && policy.attachCookies) {
      for (const key of Object.keys(hopHeaders)) {
        if (key.toLowerCase() === 'cookie') {
          delete hopHeaders[key];
        }
      }

      const jar = await ses.cookies.get({ url: currentUrl.href });
      const cookieMap = new Map();
      for (const cookie of jar) {
        cookieMap.set(cookie.name, cookie.value);
      }

      if (callerCookie && typeof callerCookie === 'string') {
        const parts = callerCookie.split(';');
        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx !== -1) {
            const name = trimmed.slice(0, eqIdx).trim();
            const value = trimmed.slice(eqIdx + 1).trim();
            cookieMap.set(name, value);
          }
        }
      }

      if (cookieMap.size > 0) {
        const pairs = [];
        for (const [name, val] of cookieMap.entries()) {
          pairs.push(`${name}=${val}`);
        }
        hopHeaders['Cookie'] = pairs.join('; ');
      }
    }

    const hopResult = await hop(
      {
        url: currentUrl.href,
        method: currentMethod,
        headers: hopHeaders,
      },
      currentBody,
      pinnedIp,
    );

    if (ses && hopResult.setCookie.length > 0) {
      for (const raw of hopResult.setCookie) {
        try {
          const details = parseSetCookie(raw, currentUrl.href);
          if (details) {
            await ses.cookies.set(details);
          }
        } catch {
          // skip silently on failure
        }
      }
    }

    const statusCode = hopResult.statusCode;
    const location = hopResult.headers['location'];

    if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
      const locStr = Array.isArray(location) ? location[0] : location;
      const next = new URL(locStr, currentUrl);

      validateProviderPolicy(next, provider, allowLocalFixture);

      if (next.origin !== currentUrl.origin) {
        callerCookie = null;
        for (const k of Object.keys(currentHeaders)) {
          const lk = k.toLowerCase();
          if (
            lk === 'cookie' ||
            lk === 'authorization' ||
            lk === 'proxy-authorization' ||
            lk === 'origin' ||
            lk === 'referer'
          ) {
            delete currentHeaders[k];
          }
        }
      }

      if (next.hash) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: '',
          headers: '',
          finalUrl: next.href,
        };
      }

      if (hopCount === MAX_HOPS - 1) {
        throw new Error('重定向过多');
      }

      if (statusCode === 301 || statusCode === 302 || statusCode === 303) {
        currentMethod = 'GET';
        currentBody = null;
        for (const k of Object.keys(currentHeaders)) {
          const lk = k.toLowerCase();
          if (lk === 'content-length' || lk === 'content-type') {
            delete currentHeaders[k];
          }
        }
      }

      currentUrl = next;
      continue;
    }

    const headerLines = [];
    for (let index = 0; index < hopResult.rawHeaders.length; index += 2) {
      headerLines.push(`${hopResult.rawHeaders[index]}: ${hopResult.rawHeaders[index + 1]}`);
    }

    return {
      ok: true,
      status: hopResult.statusCode,
      statusText: hopResult.statusMessage,
      text: hopResult.buffer.toString('utf8'),
      headers: headerLines.join('\r\n'),
      finalUrl: currentUrl.href,
    };
  }

  throw new Error('重定向过多');
}

/**
 * 从地址里取文件名。取不到就返回 null，让调用方报错而不是写一个乱名字。
 *
 * @param {string} raw
 * @returns {string | null}
 */
function fileNameFromUrl(raw) {
  try {
    const url = new URL(raw);
    const name = path.basename(decodeURIComponent(url.pathname)).trim();
    return name && name !== '.' && name !== '..' ? name : null;
  } catch {
    return null;
  }
}

class Job {
  /**
   * @param {{
   *   id?: string,
   *   createdAt?: number,
   *   link: import('../shared/protocol').Source,
   *   deliver: (files: import('../shared/protocol').ExtractedFile[]) => Promise<{
   *     delivery: string,
   *     files: import('../shared/protocol').ExtractedFile[],
   *     run?: import('./engines/aria2-transfer').TransferRun,
   *     config?: import('../shared/protocol').Aria2Config,
   *   }>,
   *   transfer?: import('./engines/aria2-transfer').Aria2Transfer | import('./engines/ytdlp-transfer').YtDlpTransfer,
   *   emit: (job: Job) => void,
   *   onDone: (contentsId: number) => void,
   *   persist?: (job: Job) => void,
   *   allowTransfer?: () => boolean,
   *   config?: () => import('../shared/protocol').Aria2Config | null,
   *   settings?: () => import('../shared/protocol').Settings,
   *   downloadDir?: () => string,
   *   partition?: string,
   *   script?: { source: string, version: string, origin: string } | null,
   *   session?: import('electron').Session,
   * }} options
   */
  constructor({
    id,
    createdAt,
    link,
    deliver,
    transfer,
    emit,
    onDone,
    persist,
    allowTransfer,
    config,
    settings,
    downloadDir,
    partition,
    script,
    session,
  }) {
    this.id = id ?? randomUUID();
    this.createdAt = createdAt ?? Date.now();
    this.link = link;
    this.deliver = deliver;
    this.transfer = transfer ?? null;
    this.emit = emit;
    this.onDone = onDone;
    this.persist = persist ?? (() => {});
    this.allowTransfer = allowTransfer ?? (() => false);
    this.config = config ?? (() => null);
    this.settings = settings ?? (() => ({}));
    this.downloadDir = downloadDir ?? (() => '');
    this.partition = partition;
    this.session = session;

    /** @type {import('../shared/protocol').JobPhase} */
    this.state = { phase: 'loading' };
    /** @type {BrowserWindow | null} */
    this.window = null;
    this.contentsId = -1;
    this.settled = false;
    /** @type {NodeJS.Timeout | null} */
    this.pollTimer = null;
    /** @type {NodeJS.Timeout | null} */
    this.flushTimer = null;
    /** @type {NodeJS.Timeout | null} */
    this.loginWatch = null;
    /** @type {import('../shared/protocol').ExtractedFile[]} */
    this.pendingFiles = [];
    /** @type {import('../shared/protocol').ExtractedFile[]} */
    this.files = [];
    /** @type {import('./engines/aria2-transfer').TransferRun | null} */
    this.run = null;
    /** @type {import('../shared/protocol').DownloadProgress[]} */
    this.progress = [];
    /** @type {import('../shared/protocol').Aria2Config | null} */
    this.aria2Config = null;
    this.readded = false;
    this.delivering = false;
    /** Bytes seen at the last tick, and when they last grew; drives `stalled`. */
    this.lastArrived = 0;
    this.lastArrivedAt = Date.now();
    // The userscript this job actually runs on, kept on the job so a failure can
    // name the version that produced it instead of the one on disk now.
    this.scriptVersion = script?.version;
    this.scriptOrigin = script?.origin;
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** @returns {import('../shared/protocol').Job} */
  snapshot() {
    const snapshot = { id: this.id, link: this.link, state: this.state, createdAt: this.createdAt };
    if (this.stalled) snapshot.stalled = true;
    if (this.scriptVersion) snapshot.scriptVersion = this.scriptVersion;
    if (this.scriptOrigin) snapshot.scriptOrigin = this.scriptOrigin;
    return snapshot;
  }

  /** @param {import('../shared/protocol').JobPhase} state */
  setState(state) {
    const changed = state.phase !== this.state.phase;
    this.state = state;
    this.emit(this);
    // The progress numbers tick once a second; only a phase change is worth a
    // disk write, except for the two terminal states.
    if (changed || state.phase === 'done' || state.phase === 'failed') this.persist(this);
  }

  /**
   * @param {import('../shared/protocol').FailureCode} code
   * @param {string} message
   * @param {string} [detail]
   */
  fail(code, message, detail) {
    if (this.settled) return;
    this.stopPolling();
    this.settled = true;
    // A cancelled job is over on purpose; its half-built progress is noise.
    const withProgress = this.progress.length > 0 && code !== 'cancelled';
    this.setState({
      phase: 'failed',
      code,
      message,
      detail,
      ...(this.files.length ? { files: this.files } : {}),
      ...(withProgress ? { progress: this.progress } : {}),
    });
    if (!DEBUG) this.close();
  }

  /**
   * Fail with the driver's own report attached, so the UI can say which step of
   * the page script broke instead of only "上游改版". The step is 1-based on
   * screen: the driver counts from zero.
   *
   * @param {import('../shared/protocol').FailureCode} code
   * @param {string} message
   * @param {string} detail
   * @param {{ step?: number, verb?: string, selector?: string }} report
   */
  failStep(code, message, detail, report) {
    const hasStep = Number.isInteger(report?.step);
    if (!hasStep) {
      this.fail(code, message, detail);
      return;
    }
    if (this.settled) return;
    this.stopPolling();
    this.settled = true;
    const withProgress = this.progress.length > 0 && code !== 'cancelled';
    this.setState({
      phase: 'failed',
      code,
      message,
      detail,
      step: report.step,
      verb: report.verb,
      ...(report.selector ? { selector: report.selector } : {}),
      hint: FAILURE_HINTS[code] ?? '页面没按预期走，点重试会重新拉取最新脚本再试。',
      ...(this.files.length ? { files: this.files } : {}),
      ...(withProgress ? { progress: this.progress } : {}),
    });
    if (!DEBUG) this.close();
  }

  /**
   * @param {import('../shared/protocol').HumanReason} reason
   * @param {{ message?: string, detail?: string }} [extra]
   */
  needsHuman(reason, extra = {}) {
    if (this.settled) return;
    if (this.state.phase === 'needs-human' && this.state.reason === reason) return;
    this.setState({ phase: 'needs-human', reason, ...extra });
    if (reason === 'login') {
      const provider = getProvider(this.link.provider);
      // A media or direct job has no netdisk provider, so there is no Chrome
      // login to import. The app's own window takes the site instead.
      if (provider?.loginKind === 'window') this.openLoginPage(provider);
      else if (provider) this.handleChromeLogin();
      else this.openMediaWindow();
      return;
    }
    this.window?.show();
    this.window?.focus();
  }

  /**
   * 迅雷 keeps its credentials in the page's localStorage, so the only place a
   * login can happen is a window of ours. Point that window at the provider's own
   * sign-in page instead of the share page, and watch for the credential to
   * appear rather than asking the user to report back.
   *
   * @param {import('../shared/providers').Provider} provider
   */
  async openLoginPage(provider) {
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    try {
      await win.loadURL(provider.loginUrl || this.link.raw);
    } catch (error) {
      if (DEBUG) console.log(`[DBG job ${this.id}] login page failed: ${error.message}`);
    }
    win.show();
    win.focus();

    this.stopLoginWatch();
    const deadline = Date.now() + 5 * 60 * 1000;
    this.loginWatch = setInterval(async () => {
      if (this.settled || !this.window || this.window.isDestroyed() || Date.now() > deadline) {
        this.stopLoginWatch();
        return;
      }
      let signedIn = false;
      try {
        signedIn = await this.window.webContents.executeJavaScript(
          `(function () {
            try {
              return Object.keys(localStorage).some(function (key) {
                return key.indexOf('credentials_') === 0;
              });
            } catch (error) {
              return false;
            }
          })()`,
        );
      } catch {
        // The page is mid-navigation; the next tick looks again.
      }
      if (signedIn) {
        this.stopLoginWatch();
        this.resumeAfterLogin();
      }
    }, 2000);
  }

  stopLoginWatch() {
    if (this.loginWatch) {
      clearInterval(this.loginWatch);
      this.loginWatch = null;
    }
  }

  /** Navigate back to the share page and start the extraction over. */
  async resumeAfterLogin() {
    this.stopLoginWatch();
    if (this.settled) return;
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    this.setState({ phase: 'loading' });
    try {
      await win.loadURL(this.link.raw);
    } catch (error) {
      if (error.code === 'ERR_ABORTED' || /ERR_ABORTED/.test(error.message)) return;
      this.fail('network', `登录后重新打开分享页失败：${error.message}`);
    }
  }

  async handleChromeLogin() {
    try {
      this.loginAbortController = new AbortController();
      await performChromeLogin(this.link.provider, this.session, {
        signal: this.loginAbortController.signal,
      });
      if (this.settled) return;

      // Chrome login succeeded: cookies imported. Resume loading the share page.
      this.setState({ phase: 'loading' });
      if (this.window && !this.window.isDestroyed()) {
        try {
          await this.window.loadURL(this.link.raw);
        } catch (error) {
          if (error.code !== 'ERR_ABORTED' && !/ERR_ABORTED/.test(error.message)) {
            this.fail('network', `加载分享页失败：${error.message}`);
          }
        }
      }
    } catch (err) {
      if (this.settled) return;
      if (err.name === 'AbortError') return;
      if (err.code === 'CHROME_NOT_FOUND') {
        this.fail('chrome-not-found', '未找到 Chrome', err.message);
      } else if (err.code === 'LOGIN_TIMEOUT') {
        this.fail('timeout', err.message);
      } else {
        this.fail('failed', err.message);
      }
    } finally {
      this.loginAbortController = null;
    }
  }

  reveal() {
    this.window?.show();
    this.window?.focus();
  }

  /**
   * 媒体任务的登录窗口。
   *
   * 用应用自己的分区，所以用户在这里过完验证，cookie 就留在会话里，
   * 下一次尝试可以直接导出给 yt-dlp。网盘那一套浏览器能力，顺手变成媒体的登录能力。
   */
  async openMediaWindow() {
    if (!this.window || this.window.isDestroyed()) {
      this.window = new BrowserWindow({
        show: true,
        width: 1100,
        height: 800,
        title: '登录 · 媒体下载',
        webPreferences: {
          partition: this.partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          backgroundThrottling: false,
        },
      });
      this.contentsId = this.window.webContents.id;
    }
    try {
      await this.window.loadURL(this.link.url);
    } catch (error) {
      if (DEBUG) console.log(`[DBG job ${this.id}] media window failed: ${error.message}`);
    }
    this.window.show();
    this.window.focus();
  }

  close() {
    this.stopLoginWatch();
    if (this.loginAbortController) {
      try {
        this.loginAbortController.abort();
      } catch {}
      this.loginAbortController = null;
    }
    if (this.window) {
      const win = this.window;
      this.window = null;
      if (!win.isDestroyed()) {
        win.removeAllListeners('closed');
        win.destroy();
      }
    }
    this.onDone(this.contentsId);
  }

  /**
   * Create the window and return its webContents id synchronously, so the caller
   * can route observations before the first one arrives. The submitter may have
   * refreshed the page script since the job was built; the window reads it when
   * it boots, so the job records that same version here.
   *
   * @param {string} partition
   * @param {string} preloadPath
   * @param {{ source: string, version: string, origin: string }} [script]
   * @returns {number}
   */
  prepare(partition, preloadPath, script) {
    // Only a job that has not loaded a page yet can switch: the window keeps the
    // script it was booted with.
    if (script) {
      this.scriptVersion = script.version;
      this.scriptOrigin = script.origin;
    }
    const provider = getProvider(this.link.provider);
    if (!provider) {
      this.fail('unsupported-provider', `暂不支持这个网盘：${this.link.provider}`);
      return -1;
    }

    this.window = new BrowserWindow({
      show: false,
      width: 1100,
      height: 800,
      title: `${provider.label} · ${this.link.shareId}`,
      webPreferences: {
        partition,
        // The preload is registered once on the session, not here. Registering it in
        // both places runs two instances that race each other.
        contextIsolation: true,
        nodeIntegration: false,
        // The preload needs Node to require its own modules. The page still cannot
        // reach it, because contextIsolation is on.
        sandbox: false,
        // A window that is shown and then hidden throttles page timers to about
        // 1 Hz, which stalls the script's polling. Measured; see DESIGN.md 4.3.
        backgroundThrottling: false,
      },
    });

    this.contentsId = this.window.webContents.id;

    this.window.on('closed', () => {
      if (!this.settled && (this.state.phase === 'loading' || this.state.phase === 'extracting' || this.state.phase === 'needs-human')) {
        this.fail('cancelled', '窗口被关闭，任务已取消');
      }
    });

    return this.contentsId;
  }

  async load() {
    if (!this.window) return;
    if (this.link.provider === 'baidu') {
      try {
        const cookies = await this.session.cookies.get({ name: 'BDUSS' });
        if (cookies.length === 0) {
          this.needsHuman('login');
          return;
        }
      } catch {}
    }
    try {
      await this.window.loadURL(this.link.raw);
    } catch (error) {
      // A share link that redirects aborts the first navigation, which Electron
      // reports as ERR_ABORTED even though the page loads fine. Only a genuine
      // failure is worth failing on; everything else is caught by the driver's
      // wait-for timeout, which reports the real symptom.
      if (error.code === 'ERR_ABORTED' || /ERR_ABORTED/.test(error.message)) return;
      // Accepting a job destroys its window while that navigation is still
      // pending, and the rejection lands as ERR_FAILED on a download that is
      // already running. Only a job still waiting for its page can fail here.
      if (this.state.phase !== 'loading' || !this.window || this.window.isDestroyed()) {
        if (DEBUG) console.log(`[DBG job ${this.id}] ignored late navigation failure: ${error.message}`);
        return;
      }
      // An empty message with a bare Chromium code reads like a crash; say what
      // is known and leave the code for the diagnosis block.
      const reason = error.message || `浏览器加载失败（错误码 ${error.code ?? '未知'}）`;
      this.fail('network', `加载分享页失败：${reason}。网络正常时，多半是这个分享链接不完整。`);
    }
  }

  /** @param {any} observation */
  handle(observation) {
    if (DEBUG) {
      console.log(`[DBG job ${this.id}] observation:`, observation);
    }
    if (this.settled) return;

    switch (observation.kind) {
      case 'injected':
        // A page we navigated to for a human, such as a drive listing after a
        // transfer or a provider's own login page, is not a share page: running
        // the share steps on it only produces a bogus failure.
        if (this.state.phase === 'needs-human') return;
        // 迅雷's share page has no aria2 mode at all: the only way to a direct link
        // is to save the file into the user's drive first.
        if (getProvider(this.link.provider)?.transferOnly) {
          this.setState({ phase: 'extracting' });
          this.handleTransferNeed();
          return;
        }
        this.setState({ phase: 'extracting' });
        this.window?.webContents.send(INTERNAL.command, {
          kind: 'run-driver',
          provider: this.link.provider,
          passcode: this.link.passcode,
        });
        return;

      case 'dialog': {
        const outcome = DIALOG_OUTCOMES.find(([pattern]) => pattern.test(observation.text))?.[1];
        if (outcome?.human) this.needsHuman(outcome.human, { detail: observation.text });
        else if (outcome?.fail) this.fail(outcome.fail, outcome.message, observation.text);
        else if (outcome?.transfer) this.handleTransferNeed(observation.text);
        return;
      }

      case 'driver-result':
        if (!observation.ok) {
          this.failDriver(observation);
          return;
        }
        if (observation.mode === 'transfer') {
          this.afterTransfer();
          return;
        }
        this.scheduleFlush(400);
        return;

      case 'http':
        this.handleHttp(observation).catch((err) => {
          console.error(`[job ${this.id}] handleHttp error:`, err);
          this.fail('http-error', err.message);
        });
        return;

      case 'script-error':
        console.error(`[job ${this.id}] userscript error: ${observation.message}`);
        return;

      case 'open-tab':
        this.handleOpenTab(observation.url);
        return;

      default:
        return;
    }
  }

  /**
   * A share file over 50MB has no direct link at all. Where the provider has a
   * save-into-my-drive step and the user allowed it, do that from here; otherwise
   * say what would unblock it instead of reporting a network fault.
   *
   * @param {string} [detail]
   */
  handleTransferNeed(detail) {
    const provider = getProvider(this.link.provider);
    if (!provider?.transferSteps?.length) {
      this.fail(
        'needs-transfer',
        `${provider?.label ?? this.link.provider} 不允许直接取这个大文件的直链，需要先转存到你自己的网盘。`,
        detail,
      );
      return;
    }
    if (!this.allowTransfer()) {
      this.needsHuman('transfer', { detail });
      return;
    }
    this.beginTransfer();
  }

  beginTransfer() {
    if (!this.window || this.window.isDestroyed()) {
      this.fail('needs-transfer', '转存需要页面还开着，但窗口已经关闭。请重新提交这个链接。');
      return;
    }
    this.setState({ phase: 'extracting' });
    this.window.webContents.send(INTERNAL.command, {
      kind: 'run-driver',
      provider: this.link.provider,
      passcode: this.link.passcode,
      mode: 'transfer',
    });
  }

  /**
   * The file is in the user's drive now, and the share page can never hand out
   * its direct link. Move the window to the drive, where the script is live, and
   * leave the one click that the app cannot make on its own.
   */
  async afterTransfer() {
    const provider = getProvider(this.link.provider);
    const target = provider?.driveUrl;
    this.needsHuman('manual', {
      message: '已把文件保存到你的网盘。窗口已切到「我的网盘」，选中这个文件，点「下载助手」→「Aria2 下载」，剩下的交给程序。',
    });
    if (!target || !this.window || this.window.isDestroyed()) return;
    try {
      await this.window.loadURL(target);
      this.window.show();
      this.window.focus();
    } catch (error) {
      console.warn(`[job ${this.id}] cannot open the drive page: ${error.message}`);
    }
  }

  /**
   * A failed step only means a button was not there. Read the page and let its
   * own words pick the failure, instead of blaming the upstream script for every
   * miss, which is what made a broken share link look like a redesign.
   *
   * @param {any} observation
   */
  async failDriver(observation) {
    const step = `第 ${observation.step + 1} 步：${observation.verb}`;
    let pageText = '';
    try {
      const win = this.window;
      if (win && !win.isDestroyed()) {
        pageText = String(
          await win.webContents.executeJavaScript('document.body ? document.body.innerText : ""'),
        );
      }
    } catch {
      // A closed window has no page to read; the selector detail still ships.
    }

    const excerpt = pageText.replace(/\s+/g, ' ').trim().slice(0, 400);
    if (/请先登录|需要登录|登录后|登录.*(失效|过期|已退出)|重新登录/.test(excerpt)) {
      this.needsHuman('login');
      return;
    }
    if (/安全验证|验证码|滑块/.test(excerpt)) {
      this.needsHuman('captcha');
      return;
    }

    const detail = [
      observation.selector ? `选择器：${observation.selector}` : '',
      observation.detail || '',
      `页面文字：${excerpt || '读不到'}`,
    ]
      .filter(Boolean)
      .join('\n');

    const provider = getProvider(this.link.provider);
    const experimental = Boolean(provider?.experimental);
    const outcome = PAGE_OUTCOMES.find(([pattern]) => pattern.test(excerpt))?.[1];
    if (outcome?.code === 'needs-transfer') {
      this.handleTransferNeed(detail);
      return;
    }
    // A page that says the file is gone says so in its own words. A page that is
    // merely missing a button proves nothing on a provider whose selectors were
    // transcribed instead of measured.
    const definitive =
      outcome && ['link-invalid', 'file-missing', 'passcode-wrong'].includes(outcome.code);
    const report = { step: observation.step, verb: observation.verb, selector: observation.selector };
    if (outcome && (!experimental || definitive)) {
      this.failStep(outcome.code, `${outcome.message}（${step}）`, detail, report);
      return;
    }
    // The file list and the script's own buttons are on screen, so the page is
    // fine; it was the link fetch behind the dialog that came back empty.
    if (/下载助手|Aria2 下载|保存到网盘/.test(excerpt)) {
      this.failStep(
        'extract-failed',
        `页面正常打开了，但脚本没弹出取链结果，通常是网盘接口临时拒绝；点「打开窗口」看看，或稍后重试（${step}）`,
        detail,
        report,
      );
      return;
    }
    // A provider whose selectors were transcribed rather than observed gets one
    // more chance: keep the window up, let the user make the click, and catch the
    // aria2 push from here either way.
    if (experimental) {
      this.needsHuman('manual', {
        message: `自动点击没找到地方点（${step}）。窗口已经打开，请在里面点「下载助手」→「Aria2 下载」→「推送地址到 Aria2 下载器」，程序会接住后面的下载。`,
        detail,
      });
      return;
    }
    this.failStep('upstream-redesigned', `页面上没找到该点的东西，上游可能改版了（${step}）`, detail, report);
  }

  /**
   * Every request the userscript makes funnels through GM_xmlhttpRequest. Two
   * kinds matter: the aria2.addUri push, which carries the direct link and is
   * the point of the whole app, and everything else, which is a netdisk API call
   * that has to reach the network for real.
   *
   * @param {any} observation
   */
  async handleHttp(observation) {
    let files = null;
    try {
      files = extractFromAria2Body(observation.body);
    } catch (err) {
      this.reply(observation.id, {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: JSON.stringify({
          id: observation.id,
          jsonrpc: '2.0',
          error: { code: -32602, message: err.message },
        }),
        headers: '',
        error: err.message,
      });
      this.fail('invalid-download-file', err.message);
      return;
    }

    if (files) {
      // The app owns delivery, so answer as if aria2 took the job. The script
      // only checks that the RPC reply has a result.
      this.reply(observation.id, {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: JSON.stringify({ id: observation.id, jsonrpc: '2.0', result: `linkswift-${this.id}` }),
        headers: '',
      });
      this.queueFiles(files);
      return;
    }

    try {
      const response = await proxyRequest(
        {
          url: observation.url,
          method: observation.method,
          headers: observation.headers ?? {},
          body: observation.body,
          provider: this.link?.provider,
        },
        this.session,
      );
      if (observation.url.includes('openapi.baidu.com')) {
        console.log(`[openapi] proxy ${observation.method} ${observation.url} -> ${response.status} finalUrl: ${response.finalUrl} text: ${typeof response?.text === 'string' ? response.text.slice(0, 500) : ''}`);
      } else if (DEBUG) {
        const preview = typeof response?.text === 'string' ? response.text.slice(0, 300) : '';
        console.log(`[DBG job ${this.id}] proxy ${observation.method} ${observation.url} -> ${response.status} ${preview}`);
      }
      this.reply(observation.id, response);
    } catch (error) {
      if (observation.url.includes('openapi.baidu.com')) {
        console.log(`[openapi] proxy ${observation.method} ${observation.url} -> error: ${error.message}`);
      } else if (DEBUG) {
        console.log(`[DBG job ${this.id}] proxy ${observation.method} ${observation.url} -> error: ${error.message}`);
      }
      this.reply(observation.id, {
        ok: false,
        status: null,
        statusText: '',
        text: null,
        headers: '',
        error: error.message,
      });
    }
  }

  /**
   * @param {number} id
   * @param {object} payload
   */
  reply(id, payload) {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send(INTERNAL.command, { kind: 'http-response', id, ...payload });
  }

  /**
   * The userscript opens two kinds of tab: the baidu OAuth page, which is
   * legitimate, and its aria2 manager shortcuts, which embed the RPC address and
   * token in a third-party URL. Refuse the second kind.
   *
   * @param {string} url
   */
  handleOpenTab(url) {
    if (/openapi\.baidu\.com/.test(url)) {
      this.needsHuman('login');
      return;
    }
    console.warn(`[job ${this.id}] refused a tab that would leak the aria2 token: ${url}`);
  }

  /**
   * 媒体来源。地址交给 yt-dlp，解析、下载、后处理都在它那边跑。
   *
   * 这一路没有浏览器页面，所以没有取链步骤，直接进引擎。
   */
  async startMedia() {
    if (!this.transfer) {
      this.fail('media-tool-missing', '这个来源要用 yt-dlp，但没找到它的可执行文件。在设置里指定路径试试。');
      return;
    }
    this.setState({ phase: 'extracting' });
    try {
      // 登录态只能靠 cookie 文件带过去，所以起进程之前先导一次。
      await this.exportMediaCookies();
      const run = await this.transfer.start({ url: this.link.url, dir: this.downloadDir() });
      this.run = run;
      this.setState({ phase: 'downloading', files: [], progress: [] });
      this.startPolling();
    } catch (error) {
      this.fail('media-tool-missing', error.message);
    }
  }

  /**
   * 把会话里的 cookie 导出给 yt-dlp。
   *
   * yt-dlp 读不到 Electron 的分区，它只认 `--cookies <file>` 给的 Netscape 格式
   * 文件。用户在这个应用自己的窗口里登录完，cookie 留在会话里，只有导出成
   * 文件交给它，下一次尝试才带得上登录态。
   *
   * 每跑一次都重新导：用户在窗口里刚登录过的那一次，要能带上。没有 cookie
   * 就不写文件，也不传这个参数。
   *
   * @returns {Promise<string | null>} cookie 文件的路径，没有 cookie 时是 null
   */
  async exportMediaCookies() {
    // 只有 yt-dlp 引擎有 options，别的引擎没有 cookie 参数可设。
    if (!this.session || !this.transfer || !this.transfer.options) return null;
    try {
      const file = await exportSessionCookies({
        session: this.session,
        url: this.link.url,
        userDataDir: app.getPath('userData'),
        fileName: `media-cookies-${this.id}.txt`,
      });
      this.transfer.options.cookiesFile = file || '';
      return file;
    } catch (error) {
      if (DEBUG) console.log(`[DBG job ${this.id}] cookie export failed: ${error.message}`);
      this.transfer.options.cookiesFile = '';
      return null;
    }
  }

  /**
   * 直链来源。一个普通的文件地址，文件名从地址里取。
   */
  async startDirect() {
    const name = fileNameFromUrl(this.link.url);
    if (!name) {
      this.fail('media-unsupported', `这个地址看不出文件名：${this.link.url}`);
      return;
    }
    const file = { name, url: this.link.url, headers: {} };
    this.setState({ phase: 'linked', files: [file] });
    await this.deliverNow([file]);
  }

  /**
   * The script pushes each file of a folder with its own aria2.addUri, so the
   * pushes arrive one at a time and stop when the window goes away. Collect them
   * for a moment and deliver once, or a folder downloads only its first file.
   *
   * @param {import('../shared/protocol').ExtractedFile[]} files
   */
  queueFiles(files) {
    if (this.settled) return;
    const validated = [];
    for (const file of files) {
      validated.push(aria2.validateExtractedFile(file));
    }
    for (const file of validated) {
      if (!this.pendingFiles.some((queued) => queued.url === file.url)) this.pendingFiles.push(file);
    }
    if (this.state.phase === 'loading' || this.state.phase === 'extracting') {
      this.setState({ phase: 'linked', files: this.pendingFiles.slice() });
    }
    this.scheduleFlush(1500);
  }

  /** @param {number} ms */
  scheduleFlush(ms) {
    if (this.settled) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, ms);
  }

  flush() {
    if (this.settled || this.delivering || !this.pendingFiles.length) return;
    const files = this.pendingFiles.slice();
    this.pendingFiles = [];
    this.delivering = true;
    this.deliverNow(files).finally(() => {
      this.delivering = false;
    });
  }

  /**
   * Attach the session's cookies for the file's own host before handing the URL
   * to aria2.
   *
   * Some netdisks hand out a CDN link whose OSS callback answers
   * `require login [auth not found]` unless the account cookie comes along, and
   * the userscript does not always forward one (UC in particular sends none).
   * Chromium does the matching, so only cookies that belong to that URL are ever
   * sent, and nothing leaks to a host the session has no cookies for.
   *
   * @param {import('../shared/protocol').ExtractedFile[]} files
   * @returns {Promise<import('../shared/protocol').ExtractedFile[]>}
   */
  async withCookies(files) {
    if (!this.session) return files;
    return Promise.all(
      files.map(async (file) => {
        let jar = [];
        try {
          jar = await this.session.cookies.get({ url: file.url });
        } catch {
          return file;
        }
        if (!jar.length) return file;
        const headers = file.headers || {};
        const existing = Object.entries(headers).find(([key]) => key.toLowerCase() === 'cookie')?.[1];
        const present = new Set(
          String(existing || '')
            .split(';')
            .map((pair) => pair.split('=')[0].trim())
            .filter(Boolean),
        );
        const extra = jar
          .filter((cookie) => !present.has(cookie.name))
          .map((cookie) => `${cookie.name}=${cookie.value}`);
        if (!extra.length) return file;
        const merged = existing ? `${existing}; ${extra.join('; ')}` : extra.join('; ');
        return { ...file, headers: { ...headers, Cookie: merged } };
      }),
    );
  }

  /** @param {import('../shared/protocol').ExtractedFile[]} files */
  async deliverNow(files) {
    this.files = files;
    this.close();
    this.setState({ phase: 'delivering', files });
    try {
      const result = await this.deliver(await this.withCookies(files), this.transfer);
      // A cancel that arrives while the pushes are in flight has to undo them,
      // or the row says 已取消 while the downloader keeps downloading.
      if (this.settled) {
        if (this.transfer && this.run) await this.transfer.cancel(this.run).catch(() => {});
        return;
      }
      if (!result || result.delivery !== 'engine') {
        // Clipboard and browser delivery hand the link over and stop there.
        this.settled = true;
        this.setState({ phase: 'done', files });
        return;
      }
      if (!this.transfer) throw new Error('没有可用的传输引擎');
      const run = await this.transfer.start({
        files: result.files,
        url: this.link.url,
        dir: this.downloadDir(),
      });
      this.run = run;
      this.aria2Config = run.config ?? null;
      const { rows } = await this.transfer.progress(run);
      this.progress = rows;
      this.setState({ phase: 'downloading', files, progress: rows });
      this.startPolling();
    } catch (error) {
      this.settled = true;
      this.setState({
        phase: 'failed',
        code: error.code === 'aria2-down' ? 'aria2-down' : 'delivery',
        message: error.message,
        files,
      });
    }
  }

  /**
   * Push every file that is not already on disk. Pushing a finished file again
   * would download a second renamed copy of it, which is worse than the failure
   * being resumed.
   */
  async resubmit() {
    if (!this.transfer || !this.run) throw new Error('这个任务没有可重投的传输');
    this.run = await this.transfer.retry(this.run, { rows: this.progress });
    const { rows } = await this.transfer.progress(this.run);
    this.progress = rows;
  }

  /**
   * The last real outcome for this netdisk, for the settings page. Only terminal
   * phases say anything; a job still running has no verdict yet.
   *
   * @returns {{ provider: string, ok: boolean, code?: string, hint?: string } | null}
   */
  healthOutcome() {
    // Only a netdisk has a row in the capability table. A media job has no
    // netdisk to be healthy or not.
    if (this.link.kind !== 'netdisk') return null;
    const state = this.state;
    if (state.phase === 'done') return { provider: this.link.provider, ok: true };
    if (state.phase !== 'failed') return null;
    if (state.code === 'cancelled') return null;
    return {
      provider: this.link.provider,
      ok: false,
      code: state.code,
      hint: state.hint ?? state.message,
    };
  }

  /** aria2 may have lost the GID across its own restart; push the URI once more. */
  async readd() {
    if (this.readded || !this.transfer || !this.run || !this.files.length) {
      this.settled = true;
      this.stopPolling();
      this.setState({
        phase: 'failed',
        code: 'link-expired',
        message: 'aria2 里找不到这个任务了，直链可能已经过期。点「重新取链」重新解析一次这个分享链接。',
        files: this.files,
        progress: this.progress,
      });
      return false;
    }
    this.readded = true;
    try {
      await this.resubmit();
      return true;
    } catch (error) {
      this.settled = true;
      this.stopPolling();
      this.setState({
        phase: 'failed',
        code: 'link-expired',
        message: `重新提交直链失败（${error.message}）。点「重新取链」重新解析一次这个分享链接。`,
        files: this.files,
        progress: this.progress,
      });
      return false;
    }
  }

  startPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    const tick = async () => {
      if (this.settled || !this.transfer || !this.run) return;
      try {
        const { rows, lost } = await this.transfer.progress(this.run);
        // The engine forgot the download. aria2 lost its session; the job has
        // to push the link again before it can be called a failure.
        if (lost) {
          await this.readd();
          return;
        }
        if (rows.length) {
          this.progress = rows;
          // A media job learns its file names from the engine, because only
          // yt-dlp knows what it wrote.
          if (this.transfer.id !== 'aria2') {
            this.files = rows.map((row) => ({ name: row.name, url: row.runId, headers: {} }));
          }
        }

        // A finished engine is over. yt-dlp is a process, so its exit is the
        // signal; aria2 reports per file and never sets this. A paused engine
        // is not over: it waits to be continued.
        if (this.transfer.finished && !this.transfer.paused) {
          const error = this.transfer.error;
          this.stopPolling();
          // A login problem is not a failure. The user can solve it in the
          // app's own window, and the job runs again afterwards.
          if (error && error.code === 'media-auth') {
            this.settled = false;
            this.needsHuman('login', { message: error.message, detail: error.hint });
            return;
          }
          this.settled = true;
          if (error) {
            this.setState({
              phase: 'failed',
              code: error.code,
              message: error.message,
              detail: error.hint,
              files: this.files,
              progress: this.progress,
            });
            return;
          }
          this.setState({ phase: 'done', files: this.files, progress: this.progress });
          // 媒体任务登录用的窗口在自己的分区里，任务结束了就得收掉，
          // 否则它会一直留在桌面上，直到应用退出。
          this.close();
          return;
        }

        const finished = this.progress.filter(
          (item) => item.status === 'complete' || item.status === 'error',
        );
        const broken = this.progress.filter((item) => item.status === 'error');

        // A folder with forty files must not die because one of them 403'd. The
        // job is only over once every file has stopped.
        if (this.progress.length > 0 && finished.length === this.progress.length) {
          this.stopPolling();
          this.settled = true;
          if (!broken.length) {
            this.setState({ phase: 'done', files: this.files, progress: this.progress });
            return;
          }
          const described = describeAria2Error(broken[0].errorCode, broken[0].errorMessage);
          const okCount = this.progress.length - broken.length;
          this.setState({
            phase: 'failed',
            code: 'delivery',
            message: `${broken.length} 个文件下载失败${okCount ? `，${okCount} 个已完成` : ''}。${described.message}`,
            detail: described.detail,
            files: this.files,
            progress: this.progress,
          });
          return;
        }

        // A job with no progress rows yet is not paused, it has not started.
        const paused = this.progress.length > 0 && this.progress.every((item) => item.status === 'paused');
        // A queue that is merely waiting has no speed either, so stalling is
        // judged on bytes actually arriving, not on the speed figure.
        const arrived = this.progress.reduce((sum, item) => sum + item.completedLength, 0);
        if (arrived !== this.lastArrived) {
          this.lastArrived = arrived;
          this.lastArrivedAt = Date.now();
          this.stalled = false;
        } else if (Date.now() - this.lastArrivedAt >= JOB_STALL_AFTER_MS) {
          this.stalled = true;
        }
        this.setState({
          phase: paused ? 'paused' : 'downloading',
          files: this.files,
          progress: this.progress.slice(),
        });
      } catch (error) {
        if (DEBUG) console.warn(`[DBG job ${this.id}] progress error: ${error.message}`);
      }
    };

    tick();
    this.pollTimer = setInterval(tick, 1000);
  }

  /** @returns {Promise<boolean>} */
  async pause() {
    if (!this.transfer || !this.run) return false;
    if (this.state.phase !== 'downloading') return false;
    await this.transfer.pause(this.run);
    this.setState({ phase: 'paused', files: this.files, progress: this.progress.slice() });
    return true;
  }

  /**
   * Two different things resume. A paused download continues in place; an
   * errored one is pushed again, and the engine continues from the bytes it
   * already has.
   *
   * @returns {Promise<boolean>}
   */
  async resume() {
    if (this.state.phase === 'paused') {
      if (!this.transfer || !this.run) return false;
      await this.transfer.resume(this.run);
      this.setState({ phase: 'downloading', files: this.files, progress: this.progress.slice() });
      return true;
    }
    // A job waiting on the user runs again. The netdisk path answers its own
    // login by reloading the share page, so this is the media path.
    if (this.state.phase === 'needs-human') {
      if (!this.transfer || !this.run) return false;
      this.settled = false;
      try {
        // 用户刚在窗口里登录过，重新导一次 cookie，yt-dlp 这才带得上登录态。
        await this.exportMediaCookies();
        await this.transfer.retry(this.run);
        this.setState({ phase: 'downloading', files: this.files, progress: this.progress });
        this.startPolling();
        return true;
      } catch (error) {
        this.settled = true;
        this.setState({ phase: 'failed', code: 'delivery', message: error.message, files: this.files });
        return false;
      }
    }
    if (this.state.phase !== 'failed') return false;
    if (!this.transfer || !this.run) return false;

    this.settled = false;
    this.readded = false;
    try {
      await this.resubmit();
      this.setState({ phase: 'downloading', files: this.files, progress: this.progress });
      this.startPolling();
      return true;
    } catch (error) {
      this.settled = true;
      this.setState({ phase: 'failed', code: 'delivery', message: error.message, files: this.files });
      return false;
    }
  }

  async cancel() {
    if (this.settled) return;
    this.stopPolling();
    if (this.transfer && this.run) await this.transfer.cancel(this.run).catch(() => {});
    this.fail('cancelled', '任务已取消。');
  }

  /**
   * A UC or quark download link is signed for a logged-in client: fetching it
   * without the account cookie answers 403 "require login", which looks exactly
   * like an expired link. Give the user the login that fixes it.
   *
   * @returns {Promise<{ ok: boolean, message: string }>}
   */
  async loginNow() {
    // A media job has no netdisk to sign into. The app's own window takes the
    // site, and the session keeps the cookie the next attempt needs.
    if (this.link.kind !== 'netdisk') {
      await this.openMediaWindow();
      return {
        ok: true,
        message: '在这个窗口里登录或过验证，登录态会留在应用的会话里，然后点「重试」。',
      };
    }
    const provider = getProvider(this.link.provider);
    if (!provider) return { ok: false, message: `不认识这个网盘：${this.link.provider}` };
    if (provider.loginKind !== 'cookie') {
      this.window?.show();
      this.window?.focus();
      return {
        ok: false,
        message: `${provider.label} 的登录在应用自己的窗口里，点「打开窗口」登录一次。`,
      };
    }
    try {
      await performChromeLogin(this.link.provider, this.session, {});
      return { ok: true, message: `已把 ${provider.label} 的登录态同步进来，点「重新取链」再试一次。` };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }
}

/**
 * Owns every in-flight job and the IPC surface the preloads talk to.
 */
class JobManager {
  /**
   * @param {{
   *   store: import('./store').Store,
   *   userscript: import('./userscript').UserscriptSource,
   *   vendor: Record<string, string>,
   *   resources: Record<string, string>,
   *   resourcesDir?: string,
   *   partition: string,
   *   preloadPath: string,
   *   emit: (job: import('../shared/protocol').Job) => void,
   *   daemon: import('./aria2-daemon').Aria2Daemon,
   *   tasks: import('./task-store').TaskStore,
   *   health: import('./provider-health').ProviderHealthStore,
   * }} options
   */
  constructor({
    store,
    userscript,
    vendor,
    resources,
    resourcesDir,
    partition,
    preloadPath,
    emit,
    daemon,
    tasks,
    health,
  }) {
    this.store = store;
    this.userscript = userscript;
    this.vendor = vendor;
    this.resources = resources;
    this.resourcesDir = resourcesDir;
    this.partition = partition;
    this.preloadPath = preloadPath;
    this.emit = emit;
    this.daemon = daemon;
    this.tasks = tasks;
    this.health = health;

    /** @type {Map<string, Job>} */
    this.jobs = new Map();
    /** @type {Map<number, Job>} */
    this.byContents = new Map();
  }

  /**
   * Validates that an incoming IPC event belongs to an authorized netdisk window and frame.
   *
   * @param {import('electron').IpcMainEvent} event
   * @returns {boolean}
   */
  authorizeNetdiskEvent(event) {
    if (!event || !event.sender) return false;
    const job = this.byContents.get(event.sender.id);
    if (!job) return false;
    if (!job.window || (typeof job.window.isDestroyed === 'function' && job.window.isDestroyed())) {
      return false;
    }
    if (job.window.webContents && event.sender !== job.window.webContents) {
      return false;
    }
    if (!event.senderFrame || event.senderFrame.parent !== null || !event.senderFrame.url) {
      return false;
    }
    try {
      const parsed = new URL(event.senderFrame.url);
      if (parsed.protocol !== 'https:') return false;
      const provider = getProvider(job.link?.provider);
      if (!provider || !provider.matches(parsed)) return false;
    } catch {
      return false;
    }
    return true;
  }

  /** @param {import('electron').IpcMain} ipcMain */
  register(ipcMain) {
    ipcMain.on(INTERNAL.boot, (event, arg) => {
      if (!this.authorizeNetdiskEvent(event)) {
        event.returnValue = null;
        return;
      }
      const job = this.byContents.get(event.sender.id);
      const providerId = job?.link?.provider || arg?.providerId;
      event.returnValue = this.buildBoot(providerId);
    });

    ipcMain.on(INTERNAL.observation, (event, observation) => {
      if (!this.authorizeNetdiskEvent(event)) {
        return;
      }
      const job = this.byContents.get(event.sender.id);
      if (job) job.handle(observation);
      else if (observation.kind === 'http') this.replyToOrphan(event, observation);
    });
  }

  /** The aria2 every new download goes to: the bundled one, or the user's own. */
  aria2Config() {
    const settings = this.store.getSettings();
    if (settings.aria2Mode === 'external') return settings.aria2;
    const config = this.daemon.config();
    // The bundled aria2 keeps running across a settings change, so the download
    // directory is passed per download instead of only at spawn time.
    return { ...config, dir: settings.aria2.dir?.trim() || this.daemon.dir || '' };
  }

  aria2Status() {
    const settings = this.store.getSettings();
    if (settings.aria2Mode === 'external') {
      return { mode: 'external', running: true, port: null, version: null, error: null };
    }
    return this.daemon.status();
  }

  buildBoot(providerId) {
    const script = this.userscript.get();
    const config = this.aria2Config();

    // Seed before the snapshot. The userscript merges its own defaults over
    // whatever it finds, and for primitives it keeps what it found.
    this.store.setValue('setting_init', {
      code: INIT_CODE,
      license: INIT_LICENSE,
      version: script.version,
    });
    // Virtual RPC configuration: isolate real daemon token from webpage context
    this.store.setValue('setting_aria2_rpc', [
      {
        domain: 'http://127.0.0.1',
        port: 6800,
        path: '/jsonrpc',
        token: '',
        dir: '',
        default: true,
      },
    ]);

    const values = this.store.getScopedValues(providerId);

    return {
      values,
      resources: this.resources,
      vendor: this.vendor,
      userscript: script.source,
      scriptVersion: script.version,
      appVersion: app.getVersion(),
    };
  }

  /**
   * One paste can carry several links, one of them bad, or one that is already
   * being worked on. Each entry answers for itself so a bad link cannot hold the
   * others back.
   *
   * @param {string} raw
   * @param {{ script?: { source: string, version: string, origin: string } }} [options]
   *   The exact page script to run on, for a retry that just refreshed it.
   * @returns {{ ok: boolean, jobs: Array<{ raw: string, jobId?: string, duplicateOf?: string, error?: string }> }}
   */
  submit(raw, { script } = {}) {
    const text = String(raw ?? '');
    const sources = parseSources(text);
    if (!sources.length) {
      const names = Object.values(PROVIDERS).map((provider) => provider.label).join('、');
      return {
        ok: false,
        jobs: [
          {
            raw: text.trim().slice(0, 200),
            error: `看不懂这个链接。目前支持：${names}，以及视频网站页面和普通文件直链。`,
          },
        ],
      };
    }

    const results = [];
    for (const source of sources) {
      const existing = this.findActive(source);
      if (existing) {
        results.push({ raw: source.raw, duplicateOf: existing.id });
        continue;
      }
      const job = this.buildJob({ link: source, script });
      this.jobs.set(job.id, job);
      this.emit(job.snapshot());

      if (source.kind === 'netdisk') {
        const contentsId = job.prepare(this.partition, this.preloadPath, script);
        if (contentsId >= 0) this.byContents.set(contentsId, job);
        job.load();
      } else if (source.kind === 'media') {
        // A media page needs no browser dance: yt-dlp reads it by itself.
        job.startMedia();
      } else {
        job.startDirect();
      }
      results.push({ raw: source.raw, jobId: job.id });
    }
    return { ok: results.some((entry) => entry.jobId), jobs: results };
  }

  /**
   * The job already working on this exact source, if any. A finished job does
   * not count: the link may be worth downloading again, and its files are already
   * on disk under their own names.
   *
   * @param {import('../shared/protocol').Source} source
   */
  findActive(source) {
    const key = sourceKey(source);
    for (const job of this.jobs.values()) {
      if (sourceKey(job.link) !== key) continue;
      if (ACTIVE_PHASES.has(job.state.phase)) return job;
    }
    return null;
  }

  /** @param {string[]} ids */
  archiveJobs(ids) {
    const list = toIdList(ids);
    const archived = this.tasks.archive(list);
    for (const id of list) this.emitArchived(id);
    return { ok: true, archived };
  }

  /** @param {string[]} ids */
  unarchiveJobs(ids) {
    const list = toIdList(ids);
    const restored = this.tasks.unarchive(list);
    for (const id of list) this.emitArchived(id);
    return { ok: true, restored };
  }

  /** @param {string[]} ids */
  purgeJobs(ids) {
    const removed = this.tasks.removeMany(toIdList(ids));
    return { ok: true, removed };
  }

  /** Push the settled job again so the renderer sees its new archive state. */
  emitArchived(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const record = this.tasks.all().find((entry) => entry.id === jobId);
    this.emit({ ...job.snapshot(), archivedAt: record?.archivedAt });
  }

  /** @returns {ReturnType<import('./provider-health').ProviderHealthStore['view']>} */
  providerHealth() {
    return this.health.view(Object.keys(PROVIDERS));
  }

  /** The source registry, for the renderer to draw its lists from. */
  sources() {
    return sourceViews();
  }

  /** Where yt-dlp is and what version it is. */
  async ytdlpStatus() {
    const settings = this.store.getSettings();
    const binary = this.ytdlpBinary(settings);
    if (!binary) {
      return { running: false, path: '', version: null, error: '未找到 yt-dlp 可执行文件' };
    }
    try {
      const version = await readVersion(binary);
      return { running: true, path: binary, version, error: null };
    } catch (error) {
      return { running: false, path: binary, version: null, error: error.message };
    }
  }

  /**
   * Update the bundled yt-dlp.
   *
   * Never yt-dlp's own self-updater: the upstream release notes warn that older
   * executables are vulnerable to a man-in-the-middle attack and tell you to
   * install a new release by hand. The app does that instead, and verifies the
   * download against the release's own SHA2-256SUMS.
   */
  async updateYtDlp() {
    const settings = this.store.getSettings();
    const binary = this.ytdlpBinary(settings);
    if (!binary) return { ok: false, message: '没有可更新的 yt-dlp 路径' };
    try {
      const result = await updateBinary({
        binaryPath: binary,
        channel: settings.ytdlpChannel || 'stable',
      });
      return { ok: true, message: `yt-dlp 已更新到 ${result.version}`, version: result.version };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }

  /** Where ffmpeg is, and whether it is there at all. */
  async ffmpegStatus() {
    const settings = this.store.getSettings();
    return ffmpegStatus({ configuredPath: settings.media?.ffmpegPath });
  }

  /**
   * @param {{ id?: string, createdAt?: number, link: import('../shared/protocol').Source,
   *   script?: { source: string, version: string, origin: string } }} options
   * @returns {Job}
   */
  buildJob({ id, createdAt, link, script }) {
    const settings = this.store.getSettings();
    // The source says which engine it wants by default; the user can override
    // that per source in the settings.
    const source = getSource(link.kind === 'netdisk' ? link.provider : link.kind);
    const engineId = source ? resolveEngineId(source, settings) : 'aria2';
    const transfer = createTransfer({
      engineId,
      aria2Config: () => this.aria2Config(),
      ytdlp: { binary: this.ytdlpBinary(settings) },
      options: this.mediaOptions(settings),
    });

    return new Job({
      id,
      createdAt,
      link,
      script: script ?? this.userscript.get(),
      transfer,
      deliver: (files, engine) => this.deliver(files, engine),
      emit: (updated) => this.emit(updated.snapshot()),
      onDone: (contentsId) => this.byContents.delete(contentsId),
      persist: (updated) => this.persist(updated),
      allowTransfer: () => Boolean(this.store.getSettings().allowTransfer),
      config: () => this.aria2Config(),
      settings: () => this.store.getSettings(),
      downloadDir: () => this.downloadDir(),
      partition: this.partition,
      session: session.fromPartition(this.partition),
    });
  }

  /** Where every download lands, the same place aria2 puts its files. */
  downloadDir() {
    const settings = this.store.getSettings();
    return settings.aria2.dir?.trim() || this.daemon.defaultDir();
  }

  /** The yt-dlp executable to use: the user's own, the bundled one, or PATH. */
  ytdlpBinary(settings = this.store.getSettings()) {
    return resolveBinary({
      resourcesDir: this.resourcesDir,
      customPath: settings.ytdlpPath,
    }).path;
  }

  /** The media knobs, in the shape the yt-dlp engine wants them. */
  mediaOptions(settings = this.store.getSettings()) {
    return mediaOptions(settings);
  }

  /** @param {Job} job */
  persist(job) {
    const health = job.healthOutcome();
    if (health) this.health.record({ ...health, at: Date.now() });
    if (job.state.phase === 'failed' && job.state.code === 'cancelled') {
      this.tasks.remove(job.id);
      return;
    }
    const files = job.state.files ?? job.files;
    if (!files || !files.length) return;
    this.tasks.save({
      id: job.id,
      createdAt: job.createdAt,
      link: job.link,
      files,
      // The engine's own handles. An old record has `gids` instead; the store
      // reads both.
      runs: job.run ? job.run.runs.map((item) => ({ file: item.file, runId: item.runId })) : [],
      engine: job.run?.engine || 'aria2',
      ...(job.scriptVersion ? { scriptVersion: job.scriptVersion } : {}),
      state:
        job.state.phase === 'downloading' || job.state.phase === 'paused'
          ? { phase: 'downloading', files }
          : job.state,
    });
  }

  /** @returns {import('../shared/protocol').Job[]} */
  list() {
    const archived = new Map(this.tasks.all().map((record) => [record.id, record.archivedAt]));
    return Array.from(this.jobs.values())
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((job) => {
        const snapshot = job.snapshot();
        if (archived.get(job.id)) snapshot.archivedAt = archived.get(job.id);
        return snapshot;
      });
  }

  /**
   * Reattach the jobs from the previous run to the aria2 that just started.
   *
   * A GID aria2 still knows resumes by itself, from the `.aria2` control file and
   * the session file it was handed at startup. A GID it has forgotten is pushed
   * again once; only then does the job become a failure the user resolves with a
   * fresh link.
   *
   * @returns {number} how many jobs came back
   */
  restore() {
    let restored = 0;
    for (const record of this.tasks.all()) {
      if (this.jobs.has(record.id) || !record.link) continue;
      const link = normalizeSource(record.link);
      if (!link) continue;
      const saved = record.state && typeof record.state === 'object' ? record.state : {};
      const files = Array.isArray(record.files) ? record.files : [];

      // A settled job comes back exactly as it was.
      if (saved.phase === 'done' || saved.phase === 'failed') {
        const job = this.buildJob({ id: record.id, createdAt: record.createdAt, link });
        job.files = files;
        job.settled = saved.phase === 'failed';
        job.state = saved;
        this.jobs.set(job.id, job);
        restored += 1;
        this.emit(job.snapshot());
        continue;
      }

      // yt-dlp cannot be reattached to a process that died with the app, but it
      // resumes from its own .part file, so run it again.
      if (link.kind === 'media') {
        const job = this.buildJob({ id: record.id, createdAt: record.createdAt, link });
        job.files = files;
        this.jobs.set(job.id, job);
        restored += 1;
        job.startMedia();
        continue;
      }

      if (!files.length) continue;
      const job = this.buildJob({ id: record.id, createdAt: record.createdAt, link });
      job.files = files;
      // Old records kept aria2 GIDs under `gids`; new ones keep the engine's
      // own handles under `runs`.
      const runs = Array.isArray(record.runs)
        ? record.runs
        : Array.isArray(record.gids)
          ? record.gids.map((entry) => ({ file: entry.file, runId: entry.gid }))
          : [];
      job.run = { engine: record.engine || 'aria2', runs, config: this.aria2Config() };
      this.jobs.set(job.id, job);
      restored += 1;

      if (!this.aria2Status().running) {
        job.settled = true;
        job.state = {
          phase: 'failed',
          code: 'aria2-down',
          message: '上次的下载还在，但 aria2 没起来，没法接着下。检查下载器状态后点「继续」。',
          files: job.files,
        };
        this.emit(job.snapshot());
        continue;
      }

      job.aria2Config = this.aria2Config();
      job.progress = job.run.runs.map(({ file, runId }) => ({
        engine: job.run.engine,
        runId,
        ...(job.run.engine === 'aria2' ? { gid: runId } : {}),
        name: file.name,
        status: 'waiting',
        totalLength: 0,
        completedLength: 0,
        downloadSpeed: 0,
        connections: 0,
        errorCode: null,
        errorMessage: null,
      }));
      job.state = { phase: 'downloading', files: job.files, progress: job.progress.slice() };
      this.emit(job.snapshot());
      job.startPolling();
    }
    return restored;
  }

  /** @param {string} jobId */
  async cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    await job.cancel();
    return true;
  }

  /** @param {string} jobId */
  async pause(jobId) {
    const job = this.jobs.get(jobId);
    return job ? job.pause() : false;
  }

  /** @param {string} jobId */
  async resume(jobId) {
    const job = this.jobs.get(jobId);
    return job ? job.resume() : false;
  }

  /** @param {string} jobId */
  async login(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, message: '这个任务已经不在列表里了。' };
    return job.loginNow();
  }

  /**
   * The manual way out of a page login, for when the app's own credential check
   * does not fire.
   *
   * @param {string} jobId
   */
  async continueAfterLogin(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, message: '这个任务已经不在列表里了。' };
    await job.resumeAfterLogin();
    return { ok: true, message: '已重新打开分享页。' };
  }

  /**
   * Throwing the job away and extracting the share link again is the only fix
   * for an expired direct link, so that is what retry means. The page script is
   * refreshed first: "upstream redesigned" is exactly the failure a stale script
   * causes, and waiting for the next launch would retry with the same stale copy.
   * When the refresh fails the cached version is used, and each new job says so.
   *
   * @param {string} jobId
   * @returns {Promise<{ ok: boolean, jobId?: string, message?: string, jobs?: Array<{ raw: string, jobId?: string }> }>}
   */
  async retry(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, message: '这个任务已经不在列表里了。' };
    const raw = job.link.raw;
    job.stopPolling();
    job.close();
    this.tasks.remove(job.id);
    this.jobs.delete(job.id);

    const script = await this.userscript.refresh();
    const result = this.submit(raw, { script });
    const detail =
      script.origin === 'upstream'
        ? `已重新拉取脚本 v${script.version} 后重试。`
        : `上游脚本没拉到，重试使用缓存版本 v${script.version}（${script.origin}）。`;
    for (const entry of result.jobs) {
      const created = entry.jobId ? this.jobs.get(entry.jobId) : null;
      if (created) created.setState({ ...created.state, detail });
    }
    return { ...result, message: detail, scriptVersion: script.version, scriptOrigin: script.origin };
  }

  /** @param {string} jobId */
  reveal(jobId) {
    this.jobs.get(jobId)?.reveal();
  }

  shutdown() {
    for (const job of this.jobs.values()) job.stopPolling();
    this.tasks.flush();
  }

  /**
   * 出口。剪贴板与浏览器把链接交出去就完事，下载由引擎接手。
   *
   * @param {import('../shared/protocol').ExtractedFile[]} files
   * @param {{ id: string } | null} [transfer]
   * @returns {Promise<
   *   | { delivery: 'clipboard', files: import('../shared/protocol').ExtractedFile[] }
   *   | { delivery: 'browser', files: import('../shared/protocol').ExtractedFile[] }
   *   | { delivery: 'engine', files: import('../shared/protocol').ExtractedFile[] }
   * >}
   */
  async deliver(files, transfer) {
    const validatedFiles = files.map((file) => aria2.validateExtractedFile(file));
    const settings = this.store.getSettings();

    if (settings.delivery === 'clipboard') {
      clipboard.writeText(validatedFiles.map((file) => file.url).join('\r\n'));
      return { delivery: 'clipboard', files: validatedFiles };
    }

    if (settings.delivery === 'browser') {
      for (const file of validatedFiles) await shell.openExternal(file.url);
      return { delivery: 'browser', files: validatedFiles };
    }

    // Only aria2 has a daemon that can be down. yt-dlp is a process, so it is
    // either running or it failed, and the job reports that itself.
    if (transfer?.id === 'aria2') {
      const status = this.aria2Status();
      if (!status.running) {
        const error = new Error(
          status.mode === 'builtin'
            ? `内置 aria2 没有启动成功${status.error ? `：${status.error}` : ''}。设置里点「重启内置下载器」试试。`
            : '外部 aria2 连不上。设置里点「测试连接」看看地址和令牌。',
        );
        error.code = 'aria2-down';
        throw error;
      }
    }

    return { delivery: 'engine', files: validatedFiles };
  }

  /**
   * A window whose job already settled can still have requests in flight.
   * @param {import('electron').IpcMainEvent} event
   * @param {any} observation
   */
  replyToOrphan(event, observation) {
    event.sender.send(INTERNAL.command, {
      kind: 'http-response',
      id: observation.id,
      ok: false,
      status: null,
      statusText: '',
      text: null,
      headers: '',
      error: '任务已结束',
    });
  }
}

module.exports = { JobManager, Job, extractFromAria2Body, proxyRequest, hop };
