'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * ffmpeg 在哪、有没有、什么版本。
 *
 * 音视频合并、提取音频、嵌入封面都要 ffmpeg，仓库里没有打包它。先找用户自己
 * 装的那份，找不到就如实说没有，而不是让 yt-dlp 报一句看不懂的错。
 */

/**
 * @param {string} name
 * @returns {string | null}
 */
function findOnPath(name) {
  const raw = process.env.PATH || '';
  const dirs = raw.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 目录读不了就跳过。
    }
  }
  return null;
}

/**
 * @param {string} binary
 * @param {string[]} args
 * @returns {Promise<string | null>} 输出的第一行，跑不起来就是 null
 */
function firstLine(binary, args) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(out.split('\n')[0]?.trim() || null);
    });
  });
}

/**
 * @param {string} binary
 * @returns {Promise<string | null>}
 */
async function probeFfmpeg(binary) {
  const line = await firstLine(binary, ['-version']);
  if (!line) return null;
  const match = /version\s+(\S+)/i.exec(line);
  return match ? match[1] : line;
}

/**
 * @param {string} binary
 * @returns {Promise<string | null>}
 */
async function probeFfprobe(binary) {
  const line = await firstLine(binary, ['-version']);
  if (!line) return null;
  const match = /version\s+(\S+)/i.exec(line);
  return match ? match[1] : line;
}

/**
 * @param {{ configuredPath?: string }} options
 * @returns {Promise<{ running: boolean, version: string | null, ffprobe: boolean,
 *   path: string, error: string | null }>}
 */
async function status({ configuredPath } = {}) {
  const configured = String(configuredPath || '').trim();
  const candidates = [];
  if (configured) candidates.push(configured);
  const onPath = findOnPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (onPath) candidates.push(onPath);

  for (const candidate of candidates) {
    const version = await probeFfmpeg(candidate);
    if (!version) continue;
    const dir = path.dirname(candidate);
    const probeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
    const probePath = path.join(dir, probeName);
    let ffprobe = false;
    try {
      ffprobe = fs.existsSync(probePath) ? Boolean(await probeFfprobe(probePath)) : false;
    } catch {
      ffprobe = false;
    }
    return { running: true, version, ffprobe, path: candidate, error: null };
  }

  return {
    running: false,
    version: null,
    ffprobe: false,
    path: '',
    error: configured
      ? `找不到 ${configured}`
      : '没有找到 ffmpeg。合并音视频、提取音频、嵌入封面这些功能需要它。',
  };
}

module.exports = { status, findOnPath, probeFfmpeg, probeFfprobe };
