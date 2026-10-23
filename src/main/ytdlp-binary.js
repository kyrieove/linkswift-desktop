'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

/**
 * 内置 yt-dlp 二进制的位置、版本与更新。
 *
 * 更新策略照抄 `userscript.js` 的三段式：拉取最新 → 校验 → 换文件 → 记录版本。
 * 有意不调 yt-dlp 自己的 `-U`：上游发行说明第一条就提醒旧版可执行文件存在
 * 中间人攻击风险，明确建议手动下载替换。而且 `-U` 要安装目录可写。
 *
 * 许可证：Windows 上唯一自包含的产物是 PyInstaller 打的 `yt-dlp.exe`，上游说它
 * 含 GPLv3+ 代码，整体按 GPLv3+ 授权。本仓库是 AGPL-3.0-or-later，与之兼容，
 * 义务是随二进制分发 `THIRD_PARTY_LICENSES.txt`，并把署名写进 NOTICE。
 */

const RELEASE_REPOS = {
  stable: 'yt-dlp/yt-dlp',
  nightly: 'yt-dlp/yt-dlp-nightly-builds',
  master: 'yt-dlp/yt-dlp-master-builds',
};

const WINDOWS_ASSET = 'yt-dlp.exe';
const SUMS_ASSET = 'SHA2-256SUMS';

/**
 * @typedef {object} BinaryLocation
 * @property {string} path
 * @property {'custom' | 'bundled' | 'path' | 'missing'} origin
 */

/**
 * 在 PATH 里找一个 yt-dlp。
 * @returns {string | null}
 */
function findOnPath() {
  const raw = process.env.PATH || '';
  const dirs = raw.split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? ['yt-dlp.exe', 'yt-dlp.cmd', 'yt-dlp.bat'] : ['yt-dlp'];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // 目录不可读就跳过。
      }
    }
  }
  return null;
}

/**
 * 找到要用的那个 yt-dlp。顺序是：用户指定的、内置的、PATH 上的。
 *
 * @param {{ resourcesDir?: string, customPath?: string }} options
 * @returns {BinaryLocation}
 */
function resolveBinary({ resourcesDir, customPath } = {}) {
  const custom = String(customPath || '').trim();
  if (custom) {
    if (fs.existsSync(custom)) return { path: custom, origin: 'custom' };
    return { path: custom, origin: 'missing' };
  }
  if (resourcesDir) {
    const bundled = path.join(resourcesDir, 'ytdlp', WINDOWS_ASSET);
    try {
      if (fs.existsSync(bundled)) return { path: bundled, origin: 'bundled' };
    } catch {
      // 读不到就往下找。
    }
  }
  const onPath = findOnPath();
  if (onPath) return { path: onPath, origin: 'path' };
  return { path: '', origin: 'missing' };
}

/**
 * 从发行说明的 SHA2-256SUMS 里取出某个文件名校验值。
 *
 * @param {string} sumsText
 * @param {string} fileName
 * @returns {string | null}
 */
function parseSums(sumsText, fileName) {
  for (const line of String(sumsText || '').split('\n')) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match && match[2].trim() === fileName) return match[1].toLowerCase();
  }
  return null;
}

/**
 * @param {Buffer} buffer
 * @returns {string}
 */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 查某个频道的最新发行版。
 *
 * @param {'stable' | 'nightly' | 'master'} channel
 * @returns {Promise<{ tag: string, assets: Record<string, { url: string, size: number }> }>}
 */
async function fetchRelease(channel) {
  const repo = RELEASE_REPOS[channel] || RELEASE_REPOS.stable;
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { 'User-Agent': 'linkswift-desktop' },
  });
  if (!response.ok) {
    throw new Error(`查 ${repo} 的发行版失败：HTTP ${response.status}`);
  }
  const release = await response.json();
  const assets = {};
  for (const asset of release.assets || []) {
    assets[asset.name] = { url: asset.browser_download_url, size: asset.size };
  }
  return { tag: release.tag_name, assets };
}

/**
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
async function download(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'linkswift-desktop' } });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * 更新内置的那份 yt-dlp。下载、校验、换文件、回滚。
 *
 * @param {{ binaryPath: string, channel?: 'stable' | 'nightly' | 'master' }} options
 * @returns {Promise<{ version: string, previous: string | null, path: string }>}
 */
async function updateBinary({ binaryPath, channel = 'stable' }) {
  if (!binaryPath) throw new Error('没有可更新的 yt-dlp 路径');
  const release = await fetchRelease(channel);
  const asset = release.assets[WINDOWS_ASSET];
  const sums = release.assets[SUMS_ASSET];
  if (!asset) throw new Error(`发行版 ${release.tag} 里没有 ${WINDOWS_ASSET}`);
  if (!sums) throw new Error(`发行版 ${release.tag} 里没有 ${SUMS_ASSET}，没法校验`);

  const [binary, sumsText] = await Promise.all([
    download(asset.url),
    download(sums.url).then((buffer) => buffer.toString('utf8')),
  ]);

  const expected = parseSums(sumsText, WINDOWS_ASSET);
  if (!expected) throw new Error(`${SUMS_ASSET} 里没有 ${WINDOWS_ASSET} 的校验值`);
  const actual = sha256(binary);
  if (actual !== expected) {
    throw new Error(`校验不过：期望 ${expected}，实际 ${actual}`);
  }

  // 换文件时先写临时文件，再改名。写坏了旧的还在。
  const tmp = `${binaryPath}.new`;
  fs.writeFileSync(tmp, binary);
  const backup = `${binaryPath}.old`;
  try {
    if (fs.existsSync(binaryPath)) fs.renameSync(binaryPath, backup);
    fs.renameSync(tmp, binaryPath);
  } catch (error) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // 临时文件清不掉就算了。
    }
    if (fs.existsSync(backup) && !fs.existsSync(binaryPath)) {
      try {
        fs.renameSync(backup, binaryPath);
      } catch {
        // 回滚也失败就交给下一次更新。
      }
    }
    throw error;
  }
  try {
    if (fs.existsSync(backup)) fs.unlinkSync(backup);
  } catch {
    // 旧文件删不掉不影响新版本。
  }

  return { version: release.tag, previous: null, path: binaryPath };
}

module.exports = {
  RELEASE_REPOS,
  WINDOWS_ASSET,
  SUMS_ASSET,
  resolveBinary,
  findOnPath,
  parseSums,
  sha256,
  fetchRelease,
  updateBinary,
};
