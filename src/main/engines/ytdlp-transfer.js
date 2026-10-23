'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

/**
 * yt-dlp 作为传输引擎。
 *
 * yt-dlp 一个进程干三件事：解析地址、把字节搬回来、跑 ffmpeg 后处理。
 * 这三件事不能拆开，所以媒体这一路整条由它负责，界面只从它的输出里读进度。
 *
 * ## 输出契约
 *
 * 上游明确说过不要去解析普通 stdout（格式随时会变），要用它提供的模板选项。
 * 这里用两处：
 *
 *   --progress-template   进度，每行一次更新，走 stdout
 *   --print-to-file       阶段信号（解析完了、文件落位了），走文件
 *
 * 为什么阶段信号不用 `--print`：`--print` 会隐含 `--quiet`，而 `--quiet` 会把
 * `--progress-template` 一起关掉。实测过，`--print` + `--progress-template`
 * 只能活下来一个。`--print-to-file` 不隐含 `--quiet`，两个都能用。
 *
 * 进度用制表符分隔，不用 JSON：`%(progress.total_bytes_estimate)j` 在值为空时
 * 渲染成裸的 `NA`，整行不是合法 JSON，`JSON.parse` 直接抛错。制表符方案实测
 * 路径原样输出，Windows 的反斜杠不会被转义。
 */

const PROGRESS_PREFIX = 'PROGRESS';
const SIGNAL_PREFIX = 'YTPRINT';

/** 进度字段顺序固定，解析端按位置取。 */
const PROGRESS_FIELDS = [
  '%(progress.status)s',
  '%(progress.downloaded_bytes)s',
  '%(progress.total_bytes)s',
  '%(progress.total_bytes_estimate)s',
  '%(progress.speed)s',
  '%(progress.eta)s',
  '%(progress.filename)s',
];

/** @returns {string} */
function progressTemplate() {
  return `download:${PROGRESS_PREFIX}\t${PROGRESS_FIELDS.join('\t')}`;
}

/**
 * yt-dlp 的输出模板里 `%` 是占位符，路径里的百分号要写成 `%%`。
 * @param {string} value
 * @returns {string}
 */
function escapeTemplate(value) {
  return String(value).replace(/%/g, '%%');
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toNumber(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || text === 'NA') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/**
 * 解析一行进度。
 *
 * @param {string} line
 * @returns {{ status: string, downloadedLength: number | null, totalLength: number | null,
 *   estimate: number | null, downloadSpeed: number | null, eta: number | null,
 *   filename: string | null } | null}
 */
function parseProgressLine(line) {
  if (typeof line !== 'string') return null;
  if (!line.startsWith(`${PROGRESS_PREFIX}\t`)) return null;
  const parts = line.split('\t');
  const rest = parts.slice(1);
  return {
    status: rest[0] || 'downloading',
    downloadedLength: toNumber(rest[1]),
    totalLength: toNumber(rest[2]),
    estimate: toNumber(rest[3]),
    downloadSpeed: toNumber(rest[4]),
    eta: toNumber(rest[5]),
    // 文件名是最后一个字段。路径里理论上可以有制表符，所以剩下的都归它。
    filename: rest.length > 6 ? rest.slice(6).join('\t') : null,
  };
}

/**
 * 把 stderr 里的错误翻译成一个失败码和一句能执行的话。
 *
 * @param {string} stderr
 * @param {number | null} exitCode
 * @returns {{ code: import('../../shared/protocol').FailureCode, message: string, hint: string } | null}
 */
function classifyError(stderr, exitCode) {
  const text = String(stderr || '');
  const rules = [
    {
      code: 'media-auth',
      re: /sign in to confirm|private video|members-only|this live event will begin|login required|join this channel|account.*not.*available/i,
      message: '这个地址需要登录才能下载。',
      hint: '点「打开窗口」在应用里登录一次，登录态会写进应用的会话，然后点「重试」。',
    },
    {
      code: 'media-geo',
      re: /geo-restricted|not available in your country|blocked it in your country|geo restricted/i,
      message: '这个地址在当前网络不可用。',
      hint: 'yt-dlp 说是地域限制，需要代理才能拿到。',
    },
    {
      code: 'media-unsupported',
      re: /unsupported url/i,
      message: 'yt-dlp 不认识这个地址。',
      hint: '换一个支持这个站点的地址，或者把扩展名写全。',
    },
    {
      code: 'media-unsupported',
      re: /requested format is not available|no video formats found/i,
      message: '这个视频没有该画质。',
      hint: '换一个画质再试，或让 yt-dlp 自己挑。',
    },
    {
      code: 'rate-limited',
      re: /http error 429|too many requests/i,
      message: '被对方限流了。',
      hint: '等一会儿再点「重试」。',
    },
    {
      code: 'media-merge',
      re: /ffmpeg|ffprobe|unable to merge|you have requested merging of multiple formats/i,
      message: '缺少 ffmpeg，合并和音频提取做不了。',
      hint: '装一个 ffmpeg 并把它的路径填到设置里，或者关掉需要 ffmpeg 的选项。',
    },
    {
      code: 'network',
      re: /unable to download webpage|connection reset|connection refused|timed out|network is unreachable|read timed out|http error 5\d\d/i,
      message: '网络没通。',
      hint: '检查网络后点「重试」。',
    },
  ];
  for (const rule of rules) {
    if (rule.re.test(text)) {
      return { code: rule.code, message: rule.message, hint: rule.hint };
    }
  }
  if (!text.trim() && exitCode !== 0) {
    return {
      code: 'media-error',
      message: `yt-dlp 退出了，退出码 ${exitCode}。`,
      hint: '点「复制诊断」把详情带走。',
    };
  }
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) || '';
  return {
    code: 'media-error',
    message: firstLine.slice(0, 200) || `yt-dlp 退出了，退出码 ${exitCode}。`,
    hint: '点「复制诊断」把详情带走。',
  };
}

/**
 * 拼出 yt-dlp 的命令行。纯函数，方便检查。
 *
 * @param {{ url: string, dir: string, options?: Record<string, any>, signalFile?: string | null }} input
 * @returns {string[]}
 */
function buildArgs({ url, dir, options = {}, signalFile }) {
  const args = [
    // 用户机器上的 yt-dlp 配置文件不参与，行为要确定。
    '--ignore-config',
    '--no-color',
    // 90 天过期提醒会混进输出，而且更新由应用自己管，不让 yt-dlp 自更新。
    '--no-update',
    // 进度一行一次更新，不靠 \r 覆盖同一行。
    '--newline',
    '--no-warnings',
    // .part 续传。暂停就是杀进程，继续就是带这个参数重开。
    '--continue',
    // --print 隐含 --simulate，这里显式关掉。
    '--no-simulate',
    // 播放列表里一条失败不该让整批停掉。
    '--no-abort-on-error',
    '--progress-template',
    progressTemplate(),
  ];

  if (signalFile) {
    // 阶段信号走文件，不走 stdout，这样进度模板还能活着。
    args.push(
      '--print-to-file',
      `before_dl:${SIGNAL_PREFIX}\tbefore_dl\t%(id)s\t%(title)s\t%(ext)s`,
      escapeTemplate(signalFile),
    );
    args.push(
      '--print-to-file',
      `after_move:${SIGNAL_PREFIX}\tafter_move\t%(filepath)s`,
      escapeTemplate(signalFile),
    );
  }

  // 输出名只由 yt-dlp 自己拼，标题截断到 150 字符；路径里的百分号要转义。
  args.push('-o', path.join(escapeTemplate(dir), '%(title).150s [%(id)s].%(ext)s'));

  if (options.playlist) args.push('--yes-playlist');
  else args.push('--no-playlist');

  if (options.format) args.push('--format', String(options.format));
  if (options.audioFormat) {
    args.push('--extract-audio');
    args.push('--audio-format', String(options.audioFormat));
    if (options.audioQuality) args.push('--audio-quality', String(options.audioQuality));
  }
  if (options.mergeFormat) args.push('--merge-output-format', String(options.mergeFormat));
  if (options.embedThumbnail) args.push('--embed-thumbnail');
  if (options.embedMetadata) args.push('--embed-metadata');
  if (options.writeSubs) {
    args.push('--write-subs');
    if (options.subLangs) args.push('--sub-langs', String(options.subLangs));
  }
  if (options.cookiesFile) args.push('--cookies', String(options.cookiesFile));
  if (options.ffmpegPath) args.push('--ffmpeg-location', String(options.ffmpegPath));

  args.push('--', url);
  return args;
}

/**
 * 读一个 yt-dlp 可执行文件的版本号。
 *
 * @param {string} binary
 * @returns {Promise<string>}
 */
function readVersion(binary) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('error', (error) => reject(new Error(`跑不了 ${binary}：${error.message}`)));
    child.on('close', (code) => {
      const version = out.trim();
      if (code !== 0 || !version) {
        reject(new Error(`${binary} 没有报出版本号（退出码 ${code}）`));
        return;
      }
      resolve(version);
    });
  });
}

/**
 * 杀掉一个进程和它的孩子。
 *
 * PyInstaller 打的单文件 exe 会先起一个引导进程，真正的 Python 跑在它的子进程里。
 * 只杀引导进程，下载还在跑，而且它的输出还会继续往管道里写。Windows 上要用
 * taskkill 把整棵树收掉。
 *
 * @param {import('node:child_process').ChildProcess | null} child
 */
function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      return;
    } catch {
      // taskkill 不可用就退回直接杀。
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // 进程可能已经退了。
  }
}

class YtDlpTransfer {
  /**
   * @param {{ binary: string, options?: Record<string, any> }} options
   */
  constructor({ binary, options = {} }) {
    this.id = 'yt-dlp';
    this.binary = binary;
    this.options = options;
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null;
    /** @type {Map<string, import('../../shared/protocol').DownloadProgress>} */
    this.rowMap = new Map();
    /** @type {import('../../shared/protocol').DownloadProgress[]} */
    this.rows = [];
    this.stderr = '';
    this.exitCode = null;
    /** @type {{ code: string, message: string, hint: string } | null} */
    this.error = null;
    this.finished = false;
    this.paused = false;
    /** @type {string | null} */
    this.signalFile = null;
    /** @type {string | null} */
    this.finalPath = null;
    /** @type {{ id?: string, title?: string, ext?: string } | null} */
    this.meta = null;
    this.url = null;
    this.dir = null;
  }

  /** @returns {Promise<{ running: boolean, version?: string, error?: string }>} */
  async status() {
    if (!this.binary) return { running: false, error: '未找到 yt-dlp 可执行文件' };
    try {
      const version = await readVersion(this.binary);
      return { running: true, version };
    } catch (error) {
      return { running: false, error: error.message };
    }
  }

  /**
   * @param {{ url?: string, dir?: string }} target
   * @returns {Promise<import('./aria2-transfer').TransferRun>}
   */
  async start(target) {
    const url = target?.url;
    const dir = target?.dir;
    if (!url || !dir) throw new Error('yt-dlp 引擎需要地址和下载目录');
    this.url = url;
    this.dir = dir;
    this.rowMap = new Map();
    this.rows = [];
    this.stderr = '';
    this.exitCode = null;
    this.error = null;
    this.finished = false;
    this.paused = false;
    this.finalPath = null;
    this.meta = null;
    this.signalFile = path.join(os.tmpdir(), `linkswift-ytdlp-${randomUUID()}.txt`);
    // --print-to-file 是追加，所以先清空。
    try {
      fs.writeFileSync(this.signalFile, '', 'utf8');
    } catch (error) {
      this.signalFile = null;
    }
    await this.spawn();
    return { engine: 'yt-dlp', runs: [], config: null };
  }

  /** 起一次进程。续传和重试都走这里，靠 `--continue` 接着 `.part` 下。 */
  async spawn() {
    if (!this.binary) throw new Error('未找到 yt-dlp 可执行文件');
    if (!this.url || !this.dir) throw new Error('yt-dlp 引擎还没拿到下载地址');
    const args = buildArgs({
      url: this.url,
      dir: this.dir,
      options: this.options,
      signalFile: this.signalFile,
    });
    const child = spawn(this.binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // Every run gets its own token. A process that was killed still reports its
    // exit later, and that report belongs to the old run, not to the new one.
    const token = randomUUID();
    this.spawnToken = token;
    this.child = child;
    this.finished = false;
    this.exitCode = null;
    this.error = null;
    this.stderr = '';

    child.stdout.setEncoding('utf8');
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        this.handleLine(line);
        index = buffer.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });

    child.on('error', (error) => {
      this.finished = true;
      this.exitCode = null;
      this.error = {
        code: 'media-tool-missing',
        message: `yt-dlp 起不来：${error.message}`,
        hint: '在设置里指定 yt-dlp 的路径，或者重新下载内置的那份。',
      };
    });

    child.on('close', (code) => {
      // A report from a process that has already been replaced says nothing
      // about the run that is going on now.
      if (this.spawnToken !== token) return;
      this.child = null;
      this.exitCode = code;
      this.finished = true;
      if (this.paused) {
        // A pause is not a failure. The process was killed on purpose, and the
        // next attempt picks the file up from the .part file.
        this.error = null;
        return;
      }
      this.readSignals();
      if (code !== 0) {
        this.error = classifyError(this.stderr, code);
      } else {
        this.applyFinalFile();
      }
    });
  }

  /** @param {string} line */
  handleLine(line) {
    // After a pause the pipe can still hold a few lines. They describe bytes
    // that arrived before the pause, so counting them would make the counter
    // climb while the download is stopped.
    if (this.paused) return;
    const progress = parseProgressLine(line);
    if (!progress) return;
    const key = progress.filename || this.url || 'target';
    const existing = this.rowMap.get(key);
    const total = progress.totalLength ?? progress.estimate ?? existing?.totalLength ?? 0;
    this.rowMap.set(key, {
      engine: 'yt-dlp',
      runId: key,
      name: existing?.name ?? path.basename(key),
      status:
        progress.status === 'finished'
          ? 'complete'
          : progress.status === 'error'
            ? 'error'
            : this.paused
              ? 'paused'
              : 'active',
      totalLength: total,
      completedLength: progress.downloadedLength ?? 0,
      downloadSpeed: progress.downloadSpeed ?? 0,
      // yt-dlp 的原生下载器是单连接的。
      connections: 1,
      errorCode: null,
      errorMessage: null,
    });
    this.rows = [...this.rowMap.values()];
  }

  /** 读阶段信号文件。 */
  readSignals() {
    if (!this.signalFile) return;
    let text = '';
    try {
      text = fs.readFileSync(this.signalFile, 'utf8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      if (!line.startsWith(`${SIGNAL_PREFIX}\t`)) continue;
      const parts = line.split('\t');
      const stage = parts[1];
      if (stage === 'before_dl') {
        this.meta = { id: parts[2], title: parts[3], ext: parts[4] };
      } else if (stage === 'after_move') {
        this.finalPath = parts.slice(2).join('\t') || null;
      }
    }
  }

  /** 下载完了，把中间文件换成最终那个。 */
  applyFinalFile() {
    if (!this.finalPath) return;
    let size = 0;
    try {
      size = fs.statSync(this.finalPath).size;
    } catch {
      size = 0;
    }
    this.rows = [
      {
        engine: 'yt-dlp',
        runId: this.finalPath,
        name: path.basename(this.finalPath),
        status: 'complete',
        totalLength: size,
        completedLength: size,
        downloadSpeed: 0,
        connections: 0,
        errorCode: null,
        errorMessage: null,
      },
    ];
  }

  /** @returns {Promise<{ rows: import('../../shared/protocol').DownloadProgress[], lost: boolean }>} */
  async progress() {
    return { rows: this.rows, lost: false };
  }

  /** yt-dlp 没有真正的暂停。杀掉进程，`.part` 留在原地。 */
  async pause() {
    if (!this.child || this.finished) return;
    this.paused = true;
    await this.stopChild();
    this.rows = this.rows.map((row) =>
      row.status === 'active' ? { ...row, status: 'paused', downloadSpeed: 0 } : row,
    );
  }

  /** 继续 = 带 `--continue` 重开，yt-dlp 从 `.part` 接着下。 */
  async resume() {
    if (this.finished && this.exitCode === 0) return;
    this.paused = false;
    await this.spawn();
  }

  /** 失败后重来一次。`.part` 还在就接着下。 */
  async retry() {
    this.paused = false;
    await this.spawn();
  }

  /** 取消。进程杀掉，半成品清掉。 */
  async cancel() {
    this.paused = true;
    await this.stopChild();
    for (const key of this.rowMap.keys()) {
      for (const suffix of ['.part', '.ytdl']) {
        try {
          fs.unlinkSync(`${key}${suffix}`);
        } catch {
          // 半成品可能已经不在了。
        }
      }
    }
    this.rows = [];
  }

  /**
   * 杀掉进程，等它真的退出了再回来。
   *
   * 等这一下是有必要的：进程退了才轮到它的收尾报告，而那份报告属于这一轮，
   * 下一轮开始之后就不该再算数。
   */
  async stopChild() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('close', done);
      child.once('error', done);
      killTree(child);
      // A process that ignores the signal must not hold the caller hostage.
      setTimeout(done, 5000).unref?.();
    });
  }

  /** @returns {{ name: string, url: string, headers: Record<string, string> } | null} */
  finalFile() {
    if (!this.finalPath) return null;
    return { name: path.basename(this.finalPath), url: this.finalPath, headers: {} };
  }
}

module.exports = {
  YtDlpTransfer,
  buildArgs,
  parseProgressLine,
  classifyError,
  progressTemplate,
  readVersion,
  escapeTemplate,
  PROGRESS_PREFIX,
  SIGNAL_PREFIX,
};
