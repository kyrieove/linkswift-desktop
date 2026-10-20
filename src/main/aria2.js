'use strict';

const { createHash } = require('node:crypto');

/**
 * aria2 JSON-RPC client.
 *
 * The request shape mirrors what the userscript builds at its own sendTo.aria2,
 * so the app and the script agree on what a "push to aria2" looks like.
 *
 * @typedef {import('../shared/protocol').Aria2Config} Aria2Config
 */

/** @param {Aria2Config} config */
function endpoint(config) {
  const domain = config.domain.replace(/\/+$/, '');
  return `${domain}:${config.port}${config.path || '/jsonrpc'}`;
}

/**
 * aria2 wants the RPC secret as the first positional parameter, spelled
 * `token:<secret>`.
 * @param {Aria2Config} config
 * @param {unknown[]} params
 */
function withToken(config, params) {
  return config.token ? [`token:${config.token}`, ...params] : params;
}

/**
 * @param {Aria2Config} config
 * @param {string} method
 * @param {unknown[]} params
 * @param {number} [timeoutMs]
 * @returns {Promise<unknown>}
 */
async function call(config, method, params, timeoutMs = 15000) {
  const body = {
    id: createHash('md5').update(`${method}${Date.now()}`).digest('hex'),
    jsonrpc: '2.0',
    method,
    params: withToken(config, params),
  };

  let response;
  try {
    response = await fetch(endpoint(config), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`连接 aria2 失败（${endpoint(config)}）：${error.message}`);
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`aria2 返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }

  if (parsed.error) {
    throw new Error(`aria2 拒绝了请求：${parsed.error.message ?? JSON.stringify(parsed.error)}`);
  }
  return parsed.result;
}

/** @param {Aria2Config} config @param {number} [timeoutMs] */
async function getVersion(config, timeoutMs) {
  const result = await call(config, 'aria2.getVersion', [], timeoutMs);
  return /** @type {{ version: string }} */ (result);
}

const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f\x7f]/;

/**
 * Validates that the extracted file has a safe http/https URL and a non-traversal single filename.
 *
 * @param {import('../shared/protocol').ExtractedFile} file
 * @returns {import('../shared/protocol').ExtractedFile}
 */
function validateExtractedFile(file) {
  if (!file || typeof file !== 'object') {
    throw new Error('下载文件信息无效');
  }

  // 1. URL 校验
  if (typeof file.url !== 'string' || !file.url.trim()) {
    throw new Error('下载 URL 不能为空');
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(file.url.trim());
  } catch {
    throw new Error(`非法下载 URL 格式: ${file.url}`);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`非法下载协议 (仅支持 http/https): ${parsedUrl.protocol}`);
  }

  // 2. 文件名校验
  if (typeof file.name !== 'string' || !file.name.trim()) {
    throw new Error('下载文件名不能为空');
  }
  const name = file.name;
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`非法文件名 (禁止路径遍历): ${name}`);
  }
  if (/^[a-zA-Z]:/.test(name)) {
    throw new Error(`非法文件名 (禁止绝对盘符路径): ${name}`);
  }
  if (ILLEGAL_FILENAME_CHARS.test(name)) {
    throw new Error(`非法文件名 (包含非法或控制字符): ${name}`);
  }
  if (WINDOWS_RESERVED_NAMES.test(name)) {
    throw new Error(`非法文件名 (Windows 保留设备名): ${name}`);
  }
  if (/[ .]$/.test(name)) {
    throw new Error(`非法文件名 (末尾不能有空格或句点): ${name}`);
  }

  return {
    url: file.url.trim(),
    name: file.name,
    headers: file.headers || {},
  };
}

/**
 * Builds the aria2 options object for a file download.
 *
 * @param {import('../shared/protocol').ExtractedFile} file
 * @returns {Record<string, any>}
 */
function buildAddUriOptions(file) {
  const safeFile = validateExtractedFile(file);
  const options = { out: safeFile.name };
  if (safeFile.headers) {
    for (const [name, value] of Object.entries(safeFile.headers)) {
      const lower = name.toLowerCase();
      if (lower === 'user-agent') options['user-agent'] = value;
      if (lower === 'referer') options.referer = value;
      // Without the login cookie quark's download server answers 412.
      if (lower === 'cookie') options.header = [`Cookie: ${value}`];
    }
  }
  // aria2 opens one connection per server by default, and quark throttles each
  // connection: measured 0.10 MiB/s with 1, 8.6 MiB/s with 16. Not for baidu,
  // which polices multi-connection downloads.
  if (safeFile.url) {
    try {
      const parsedUrl = new URL(safeFile.url);
      if (
        parsedUrl.hostname.endsWith('.quark.cn') ||
        parsedUrl.hostname.endsWith('.baidu.com') ||
        parsedUrl.hostname.endsWith('.baidupcs.com')
      ) {
        options.split = '16';
        options['max-connection-per-server'] = '16';
        // aria2 will not make a piece smaller than 20 MiB by default, so a 100 MiB
        // file gets 5 connections instead of 16 and a 24 MiB file gets one.
        // Measured on a quark link: 1 connection 1.3 MiB/s, 4 connections
        // 3.6 MiB/s, 16 connections 4.3 MiB/s.
        options['min-split-size'] = '1M';
      }
      if (!options.referer) options.referer = parsedUrl.origin + '/';
    } catch {
      // ignore invalid URL
    }
  }

  return options;
}

/**
 * @param {Aria2Config} config
 * @param {import('../shared/protocol').ExtractedFile} file
 * @returns {Promise<string>} the aria2 GID
 */
async function addUri(config, file) {
  const options = buildAddUriOptions(file);
  if (config.dir) options.dir = config.dir;

  return /** @type {string} */ (await call(config, 'aria2.addUri', [[file.url], options]));
}

/**
 * @param {Aria2Config} config
 * @param {string} gid
 * @returns {Promise<{
 *   gid: string,
 *   status: string,
 *   totalLength: string,
 *   completedLength: string,
 *   downloadSpeed: string,
 *   connections: string,
 *   errorCode?: string,
 *   errorMessage?: string
 * }>}
 */
async function tellStatus(config, gid) {
  const keys = [
    'gid',
    'status',
    'totalLength',
    'completedLength',
    'downloadSpeed',
    'connections',
    'errorCode',
    'errorMessage',
  ];
  const result = await call(config, 'aria2.tellStatus', [gid, keys]);
  return /** @type {any} */ (result);
}

/**
 * @param {Aria2Config} config
 * @param {string} gid
 * @returns {Promise<{ gid: string, status: string, totalLength: string, completedLength: string, downloadSpeed: string, connections: string, errorCode?: string, errorMessage?: string } | null>}
 *   null when aria2 has never heard of this GID, which is how a lost session shows up.
 */
async function findGid(config, gid) {
  try {
    return await tellStatus(config, gid);
  } catch (error) {
    if (/GID|not found|is not found/i.test(String(error.message))) return null;
    throw error;
  }
}

/**
 * aria2 pauses HTTP downloads only when asked with forcePause; plain pause also
 * works but refuses a download that is still queued.
 *
 * A download that has just been added is not pausable for the moment it takes
 * aria2 to open the file, which arrives as "cannot be paused now"; retrying is
 * the whole fix, and a user clicking 暂停 immediately would otherwise see it.
 *
 * @param {Aria2Config} config
 * @param {string} gid
 */
async function pause(config, gid) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await call(config, 'aria2.forcePause', [gid]);
      return;
    } catch (error) {
      const retryable = /cannot be paused|not found|GID/i.test(String(error.message));
      if (!retryable || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

/**
 * @param {Aria2Config} config
 * @param {string} gid
 */
async function unpause(config, gid) {
  try {
    await call(config, 'aria2.unpause', [gid]);
  } catch (error) {
    // Older builds only know forceUnpause; one of the two always exists.
    if (/method.*not found|未知|not found/i.test(String(error.message))) {
      await call(config, 'aria2.forceUnpause', [gid]);
      return;
    }
    throw error;
  }
}

/**
 * Cancel for real: drop the download and its result so the same GID cannot be
 * resumed by a later tellStopped.
 *
 * @param {Aria2Config} config
 * @param {string} gid
 */
async function remove(config, gid) {
  await call(config, 'aria2.forceRemove', [gid]).catch(() => {});
  await call(config, 'aria2.removeDownloadResult', [gid]).catch(() => {});
}

module.exports = {
  getVersion,
  addUri,
  endpoint,
  validateExtractedFile,
  buildAddUriOptions,
  tellStatus,
  findGid,
  pause,
  unpause,
  remove,
  call,
};
