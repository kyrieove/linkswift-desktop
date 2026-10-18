'use strict';

const { BrowserWindow, clipboard, app, shell, session } = require('electron');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { INTERNAL } = require('../shared/protocol');
const { PROVIDERS, getProvider, parseShareLink } = require('../shared/providers');
const aria2 = require('./aria2');
const { performChromeLogin } = require('./chrome-login');

const DEBUG = process.env.LINKSWIFT_DEBUG === '1';
if (DEBUG) console.log('[DBG] LINKSWIFT_DEBUG enabled');

/**
 * The userscript gates its own setup on these two literals (source lines 220-221,
 * checked at 8306). Seeding them skips the "点我点亮" button entirely, and with it
 * the location.reload() that button ends in.
 */
const INIT_CODE = '865746';
const INIT_LICENSE = 'AGPL3';

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
    /分享.*(取消|失效|删除|过期)|链接.*(失效|不存在|错误|无效)|来晚了|页面不存在/i,
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
    const separator = line.indexOf(':');
    if (separator > 0) headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }

  return uris.map((url) => ({
    url: String(url),
    name: options?.out || path.basename(new URL(String(url)).pathname) || 'download',
    headers,
  }));
}

/**
 * @param {{ url: string, method: string, headers: Record<string, string> }} options
 * @param {string | null} body
 * @returns {Promise<{ statusCode: number, statusMessage: string, rawHeaders: string[], headers: Record<string, string | string[] | undefined>, setCookie: string[], buffer: Buffer }>}
 */
function hop(options, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(options.url);
    const transport = target.protocol === 'https:' ? https : http;

    const request = transport.request(
      {
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
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
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
      },
    );

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

/**
 * Node's fetch refuses to send forbidden header names such as Referer and
 * Origin, and the netdisk APIs need both. Use the raw HTTP client instead.
 *
 * @param {{ url: string, method: string, headers: Record<string, string>, body: string | null }} request
 * @param {import('electron').Session} [ses]
 * @returns {Promise<{ ok: boolean, status: number, statusText: string, text: string, headers: string, finalUrl: string }>}
 */
async function proxyRequest({ url, method, headers, body }, ses) {
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
    const hopHeaders = { ...currentHeaders };

    if (ses) {
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

class Job {
  /**
   * @param {{
   *   id?: string,
   *   createdAt?: number,
   *   link: import('../shared/protocol').ShareLink,
   *   deliver: (files: import('../shared/protocol').ExtractedFile[]) => Promise<{
   *     delivery: string,
   *     files: import('../shared/protocol').ExtractedFile[],
   *     gids?: Array<{ file: import('../shared/protocol').ExtractedFile, gid: string }>,
   *     config?: import('../shared/protocol').Aria2Config,
   *   }>,
   *   emit: (job: Job) => void,
   *   onDone: (contentsId: number) => void,
   *   persist?: (job: Job) => void,
   *   allowTransfer?: () => boolean,
   *   session?: import('electron').Session,
   * }} options
   */
  constructor({ id, createdAt, link, deliver, emit, onDone, persist, allowTransfer, config, session }) {
    this.id = id ?? randomUUID();
    this.createdAt = createdAt ?? Date.now();
    this.link = link;
    this.deliver = deliver;
    this.emit = emit;
    this.onDone = onDone;
    this.persist = persist ?? (() => {});
    this.allowTransfer = allowTransfer ?? (() => false);
    this.config = config ?? (() => null);
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
    /** @type {import('../shared/protocol').ExtractedFile[]} */
    this.pendingFiles = [];
    /** @type {import('../shared/protocol').ExtractedFile[]} */
    this.files = [];
    /** @type {Array<{ file: import('../shared/protocol').ExtractedFile, gid: string }>} */
    this.gids = [];
    /** @type {import('../shared/protocol').DownloadProgress[]} */
    this.progress = [];
    /** @type {import('../shared/protocol').Aria2Config | null} */
    this.aria2Config = null;
    this.readded = false;
    this.delivering = false;
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
   * @param {import('../shared/protocol').HumanReason} reason
   * @param {{ message?: string, detail?: string }} [extra]
   */
  needsHuman(reason, extra = {}) {
    if (this.settled) return;
    if (this.state.phase === 'needs-human' && this.state.reason === reason) return;
    this.setState({ phase: 'needs-human', reason, ...extra });
    if (reason === 'login' && getProvider(this.link.provider)?.loginKind === 'cookie') {
      this.handleChromeLogin();
    } else {
      this.window?.show();
      this.window?.focus();
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

  close() {
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
   * can route observations before the first one arrives.
   *
   * @param {string} partition
   * @param {string} preloadPath
   * @returns {number}
   */
  prepare(partition, preloadPath) {
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
        // After a transfer the window is showing the user's own drive, where the
        // script is live but the share steps do not apply.
        if (this.state.phase === 'needs-human' && this.state.reason === 'manual') {
          this.setState(this.state);
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
        this.handleHttp(observation);
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
    if (outcome && (!experimental || definitive)) {
      this.fail(outcome.code, `${outcome.message}（${step}）`, detail);
      return;
    }
    // The file list and the script's own buttons are on screen, so the page is
    // fine; it was the link fetch behind the dialog that came back empty.
    if (/下载助手|Aria2 下载|保存到网盘/.test(excerpt)) {
      this.fail(
        'extract-failed',
        `页面正常打开了，但脚本没弹出取链结果，通常是网盘接口临时拒绝；点「打开窗口」看看，或稍后重试（${step}）`,
        detail,
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
    this.fail('upstream-redesigned', `页面上没找到该点的东西，上游可能改版了（${step}）`, detail);
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
    const files = extractFromAria2Body(observation.body);
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
   * The script pushes each file of a folder with its own aria2.addUri, so the
   * pushes arrive one at a time and stop when the window goes away. Collect them
   * for a moment and deliver once, or a folder downloads only its first file.
   *
   * @param {import('../shared/protocol').ExtractedFile[]} files
   */
  queueFiles(files) {
    if (this.settled) return;
    for (const file of files) {
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

  /** @param {import('../shared/protocol').ExtractedFile[]} files */
  async deliverNow(files) {
    this.files = files;
    this.close();
    this.setState({ phase: 'delivering', files });
    try {
      const result = await this.deliver(files);
      // A cancel that arrives while the pushes are in flight has to undo them,
      // or the row says 已取消 while aria2 keeps downloading.
      if (this.settled) {
        if (result?.delivery === 'aria2' && result.config) {
          for (const { gid } of result.gids ?? []) {
            await aria2.remove(result.config, gid).catch(() => {});
          }
        }
        return;
      }
      if (!result || result.delivery !== 'aria2' || !result.gids?.length) {
        this.settled = true;
        this.setState({ phase: 'done', files });
        return;
      }
      const progressList = result.gids.map(({ file, gid }) => ({
        gid,
        name: file.name,
        status: 'waiting',
        totalLength: 0,
        completedLength: 0,
        downloadSpeed: 0,
        connections: 0,
        errorCode: null,
        errorMessage: null,
      }));
      this.files = files;
      this.gids = result.gids;
      this.progress = progressList;
      this.aria2Config = result.config;
      this.setState({ phase: 'downloading', files, progress: progressList });
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
   *
   * @param {import('../shared/protocol').Aria2Config} config
   */
  async resubmit(config) {
    const gids = [];
    const progress = [];
    for (let index = 0; index < this.files.length; index += 1) {
      const file = this.files[index];
      const existing = this.gids[index];
      if (this.progress[index]?.status === 'complete' && existing) {
        gids.push(existing);
        progress.push(this.progress[index]);
        continue;
      }
      const gid = await aria2.addUri(config, file);
      gids.push({ file, gid });
      progress.push({
        gid,
        name: file.name,
        status: 'waiting',
        totalLength: 0,
        completedLength: 0,
        downloadSpeed: 0,
        connections: 0,
        errorCode: null,
        errorMessage: null,
      });
    }
    this.gids = gids;
    this.progress = progress;
  }

  /** aria2 may have lost the GID across its own restart; push the URI once more. */
  async readd() {
    if (this.readded || !this.aria2Config || !this.files.length) {
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
      await this.resubmit(this.aria2Config);
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
      if (this.settled || !this.aria2Config) return;
      try {
        for (let index = 0; index < this.gids.length; index++) {
          const { gid, file } = this.gids[index];
          const status = await aria2.findGid(this.aria2Config, gid);
          if (!status) {
            await this.readd();
            return;
          }
          if (DEBUG) {
            console.log(
              `[DBG job ${this.id}] tellStatus(${gid}): status=${status.status} ${status.completedLength}/${status.totalLength} speed=${status.downloadSpeed} conn=${status.connections}`,
            );
          }
          this.progress[index] = {
            gid,
            name: file.name,
            status: status.status,
            totalLength: parseInt(status.totalLength || '0', 10),
            completedLength: parseInt(status.completedLength || '0', 10),
            downloadSpeed: parseInt(status.downloadSpeed || '0', 10),
            connections: parseInt(status.connections || '0', 10),
            errorCode: status.errorCode || null,
            errorMessage: status.errorMessage || null,
          };
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

        const paused = this.progress.every((item) => item.status === 'paused');
        this.setState({
          phase: paused ? 'paused' : 'downloading',
          files: this.files,
          progress: this.progress.slice(),
        });
      } catch (error) {
        if (DEBUG) console.warn(`[DBG job ${this.id}] tellStatus error: ${error.message}`);
      }
    };

    tick();
    this.pollTimer = setInterval(tick, 1000);
  }

  /** @returns {Promise<boolean>} */
  async pause() {
    if (!this.aria2Config || !this.gids.length) return false;
    if (this.state.phase !== 'downloading') return false;
    for (const { gid } of this.gids) await aria2.pause(this.aria2Config, gid).catch(() => {});
    this.setState({ phase: 'paused', files: this.files, progress: this.progress.slice() });
    return true;
  }

  /**
   * Two different things resume. A paused download unpauses in place; an errored
   * one is pushed again, and aria2 continues from the bytes the `.aria2` control
   * file already accounts for.
   *
   * @returns {Promise<boolean>}
   */
  async resume() {
    if (this.state.phase === 'paused') {
      if (!this.aria2Config) return false;
      for (const { gid } of this.gids) await aria2.unpause(this.aria2Config, gid).catch(() => {});
      this.setState({ phase: 'downloading', files: this.files, progress: this.progress.slice() });
      return true;
    }
    if (this.state.phase !== 'failed') return false;
    const files = this.state.files ?? [];
    const config = this.aria2Config ?? this.config?.() ?? null;
    if (!files.length || !config) return false;

    this.settled = false;
    this.readded = false;
    this.aria2Config = config;
    this.files = files;
    try {
      await this.resubmit(config);
      this.setState({ phase: 'downloading', files: this.files, progress: this.progress });
      this.startPolling();
      return true;
    } catch (error) {
      this.settled = true;
      this.setState({ phase: 'failed', code: 'delivery', message: error.message, files });
      return false;
    }
  }

  async cancel() {
    if (this.settled) return;
    this.stopPolling();
    if (this.aria2Config) {
      for (const { gid } of this.gids) await aria2.remove(this.aria2Config, gid).catch(() => {});
    }
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
   *   partition: string,
   *   preloadPath: string,
   *   emit: (job: import('../shared/protocol').Job) => void,
   *   daemon: import('./aria2-daemon').Aria2Daemon,
   *   tasks: import('./task-store').TaskStore,
   * }} options
   */
  constructor({ store, userscript, vendor, resources, partition, preloadPath, emit, daemon, tasks }) {
    this.store = store;
    this.userscript = userscript;
    this.vendor = vendor;
    this.resources = resources;
    this.partition = partition;
    this.preloadPath = preloadPath;
    this.emit = emit;
    this.daemon = daemon;
    this.tasks = tasks;

    /** @type {Map<string, Job>} */
    this.jobs = new Map();
    /** @type {Map<number, Job>} */
    this.byContents = new Map();
  }

  /** @param {import('electron').IpcMain} ipcMain */
  register(ipcMain) {
    ipcMain.on(INTERNAL.boot, (event) => {
      event.returnValue = this.buildBoot();
    });

    ipcMain.on(INTERNAL.observation, (event, observation) => {
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

  buildBoot() {
    const script = this.userscript.get();
    const config = this.aria2Config();

    // Seed before the snapshot. The userscript merges its own defaults over
    // whatever it finds, and for primitives it keeps what it found.
    this.store.setValue('setting_init', {
      code: INIT_CODE,
      license: INIT_LICENSE,
      version: script.version,
    });
    this.store.setValue('setting_aria2_rpc', [
      {
        domain: config.domain,
        port: config.port,
        path: config.path,
        token: config.token,
        dir: config.dir,
        default: true,
      },
    ]);

    return {
      values: JSON.parse(JSON.stringify(this.store.values)),
      resources: this.resources,
      vendor: this.vendor,
      userscript: script.source,
      scriptVersion: script.version,
      appVersion: app.getVersion(),
    };
  }

  /**
   * @param {string} raw
   * @returns {{ ok: true, jobId: string } | { ok: false, message: string }}
   */
  submit(raw) {
    const link = parseShareLink(raw);
    if (!link) {
      const names = Object.values(PROVIDERS).map((provider) => provider.label).join('、');
      return { ok: false, message: `看不懂这个链接。目前支持：${names}。` };
    }

    const job = this.buildJob({ link });
    this.jobs.set(job.id, job);
    this.emit(job.snapshot());

    const contentsId = job.prepare(this.partition, this.preloadPath);
    if (contentsId >= 0) this.byContents.set(contentsId, job);
    job.load();

    return { ok: true, jobId: job.id };
  }

  /**
   * @param {{ id?: string, createdAt?: number, link: import('../shared/protocol').ShareLink }} options
   * @returns {Job}
   */
  buildJob({ id, createdAt, link }) {
    return new Job({
      id,
      createdAt,
      link,
      deliver: (files) => this.deliver(files),
      emit: (updated) => this.emit(updated.snapshot()),
      onDone: (contentsId) => this.byContents.delete(contentsId),
      persist: (updated) => this.persist(updated),
      allowTransfer: () => Boolean(this.store.getSettings().allowTransfer),
      config: () => this.aria2Config(),
      session: session.fromPartition(this.partition),
    });
  }

  /** @param {Job} job */
  persist(job) {
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
      gids: job.gids,
      state:
        job.state.phase === 'downloading' || job.state.phase === 'paused'
          ? { phase: 'downloading', files }
          : job.state,
    });
  }

  /** @returns {import('../shared/protocol').Job[]} */
  list() {
    return Array.from(this.jobs.values())
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((job) => job.snapshot());
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
      if (this.jobs.has(record.id) || !record.files?.length || !record.link) continue;
      const job = this.buildJob({ id: record.id, createdAt: record.createdAt, link: record.link });
      job.files = record.files;
      job.gids = Array.isArray(record.gids) ? record.gids : [];
      this.jobs.set(job.id, job);
      restored += 1;

      const saved = record.state && typeof record.state === 'object' ? record.state : {};
      if (saved.phase === 'done' || saved.phase === 'failed') {
        job.settled = saved.phase === 'failed';
        job.state = saved;
        this.emit(job.snapshot());
        continue;
      }

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
      job.progress = job.gids.map(({ file, gid }) => ({
        gid,
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
   * Throwing the job away and extracting the share link again is the only fix
   * for an expired direct link, so that is what retry means.
   *
   * @param {string} jobId
   * @returns {{ ok: boolean, jobId?: string, message?: string }}
   */
  retry(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, message: '这个任务已经不在列表里了。' };
    const raw = job.link.raw;
    job.stopPolling();
    job.close();
    this.tasks.remove(job.id);
    this.jobs.delete(job.id);
    return this.submit(raw);
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
   * @param {import('../shared/protocol').ExtractedFile[]} files
   * @returns {Promise<
   *   | { delivery: 'clipboard', files: import('../shared/protocol').ExtractedFile[] }
   *   | { delivery: 'browser', files: import('../shared/protocol').ExtractedFile[] }
   *   | {
   *       delivery: 'aria2',
   *       files: import('../shared/protocol').ExtractedFile[],
   *       gids: Array<{ file: import('../shared/protocol').ExtractedFile, gid: string }>,
   *       config: import('../shared/protocol').Aria2Config,
   *     }
   * >}
   */
  async deliver(files) {
    const settings = this.store.getSettings();

    if (settings.delivery === 'clipboard') {
      clipboard.writeText(files.map((file) => file.url).join('\r\n'));
      return { delivery: 'clipboard', files };
    }

    if (settings.delivery === 'browser') {
      for (const file of files) await shell.openExternal(file.url);
      return { delivery: 'browser', files };
    }

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

    const config = this.aria2Config();
    const gids = [];
    for (const file of files) {
      gids.push({ file, gid: await aria2.addUri(config, file) });
    }
    return { delivery: 'aria2', files, gids, config };
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

module.exports = { JobManager, Job, extractFromAria2Body, proxyRequest };
