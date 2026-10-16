'use strict';

const { BrowserWindow, clipboard, app, shell } = require('electron');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { INTERNAL } = require('../shared/protocol');
const { getProvider, parseShareLink } = require('../shared/providers');
const aria2 = require('./aria2');

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
    /请先勾选|请打开文件夹/,
    { fail: 'no-files', message: '没能在页面上勾选到文件。分享页结构可能变了。' },
  ],
  [/请先登录|需要登录|超出游客|31001/, { human: 'login' }],
  [/提取码|请输入密码/, { human: 'passcode' }],
  [/验证码|安全验证/, { human: 'captcha' }],
];

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
 * Node's fetch refuses to send forbidden header names such as Referer and
 * Origin, and the netdisk APIs need both. Use the raw HTTP client instead.
 *
 * @param {{ url: string, method: string, headers: Record<string, string>, body: string | null }} request
 * @returns {Promise<{ ok: boolean, status: number, statusText: string, text: string, headers: string }>}
 */
function proxyRequest({ url, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;

    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          ...headers,
          // Without an explicit length Node falls back to chunked encoding, and
          // quark's API answers a chunked POST with 400.
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const headerLines = [];
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            headerLines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
          }
          resolve({
            // A received response is a success for GM_xmlhttpRequest whatever the
            // status; onerror is for network-level failure only. Routing a 4xx to
            // onerror hides the body from the userscript and skips its own handling
            // of API error codes such as quark's 23018.
            ok: true,
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? '',
            text: Buffer.concat(chunks).toString('utf8'),
            headers: headerLines.join('\r\n'),
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

class Job {
  /**
   * @param {{
   *   link: import('../shared/protocol').ShareLink,
   *   deliver: (files: import('../shared/protocol').ExtractedFile[]) => Promise<void>,
   *   emit: (job: Job) => void,
   *   onDone: (contentsId: number) => void,
   * }} options
   */
  constructor({ link, deliver, emit, onDone }) {
    this.id = randomUUID();
    this.link = link;
    this.deliver = deliver;
    this.emit = emit;
    this.onDone = onDone;

    /** @type {import('../shared/protocol').JobPhase} */
    this.state = { phase: 'loading' };
    /** @type {BrowserWindow | null} */
    this.window = null;
    this.contentsId = -1;
    this.settled = false;
  }

  /** @returns {import('../shared/protocol').Job} */
  snapshot() {
    return { id: this.id, link: this.link, state: this.state };
  }

  /** @param {import('../shared/protocol').JobPhase} state */
  setState(state) {
    this.state = state;
    this.emit(this);
  }

  /**
   * @param {import('../shared/protocol').FailureCode} code
   * @param {string} message
   * @param {string} [detail]
   */
  fail(code, message, detail) {
    if (this.settled) return;
    this.settled = true;
    this.setState({ phase: 'failed', code, message, detail });
    this.close();
  }

  /** @param {import('../shared/protocol').HumanReason} reason */
  needsHuman(reason) {
    if (this.settled) return;
    if (this.state.phase === 'needs-human' && this.state.reason === reason) return;
    this.setState({ phase: 'needs-human', reason });
    // The user has to log in or type a code in the real page, so show it.
    this.window?.show();
  }

  reveal() {
    this.window?.show();
    this.window?.focus();
  }

  close() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
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
      if (!this.settled) this.fail('cancelled', '窗口被关闭，任务已取消');
    });

    return this.contentsId;
  }

  async load() {
    if (!this.window) return;
    try {
      await this.window.loadURL(this.link.raw);
    } catch (error) {
      // A share link that redirects aborts the first navigation, which Electron
      // reports as ERR_ABORTED even though the page loads fine. Only a genuine
      // failure is worth failing on; everything else is caught by the driver's
      // wait-for timeout, which reports the real symptom.
      if (error.code === 'ERR_ABORTED' || /ERR_ABORTED/.test(error.message)) return;
      this.fail('network', `加载分享页失败：${error.message}`);
    }
  }

  /** @param {any} observation */
  handle(observation) {
    if (this.settled) return;

    switch (observation.kind) {
      case 'injected':
        this.setState({ phase: 'extracting' });
        this.window?.webContents.send(INTERNAL.command, {
          kind: 'run-driver',
          provider: this.link.provider,
          passcode: this.link.passcode,
        });
        return;

      case 'dialog': {
        const outcome = DIALOG_OUTCOMES.find(([pattern]) => pattern.test(observation.text))?.[1];
        if (outcome?.human) this.needsHuman(outcome.human);
        else if (outcome?.fail) this.fail(outcome.fail, outcome.message, observation.text);
        return;
      }

      case 'driver-result':
        if (!observation.ok) {
          this.fail(
            'upstream-redesigned',
            `页面上没找到该点的东西，上游可能改版了（第 ${observation.step + 1} 步：${observation.verb}）`,
            observation.selector ? `选择器：${observation.selector}\n${observation.detail}` : observation.detail,
          );
        }
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
      await this.accept(files);
      return;
    }

    try {
      const response = await proxyRequest({
        url: observation.url,
        method: observation.method,
        headers: observation.headers ?? {},
        body: observation.body,
      });
      this.reply(observation.id, response);
    } catch (error) {
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

  /** @param {import('../shared/protocol').ExtractedFile[]} files */
  async accept(files) {
    if (this.settled) return;
    this.settled = true;
    this.setState({ phase: 'delivering' });
    try {
      await this.deliver(files);
      this.setState({ phase: 'done', files });
    } catch (error) {
      this.setState({ phase: 'failed', code: 'delivery', message: error.message });
    }
    this.close();
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
   * }} options
   */
  constructor({ store, userscript, vendor, resources, partition, preloadPath, emit }) {
    this.store = store;
    this.userscript = userscript;
    this.vendor = vendor;
    this.resources = resources;
    this.partition = partition;
    this.preloadPath = preloadPath;
    this.emit = emit;

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

  buildBoot() {
    const script = this.userscript.get();
    const settings = this.store.getSettings();

    // Seed before the snapshot. The userscript merges its own defaults over
    // whatever it finds, and for primitives it keeps what it found.
    this.store.setValue('setting_init', {
      code: INIT_CODE,
      license: INIT_LICENSE,
      version: script.version,
    });
    this.store.setValue('setting_aria2_rpc', [
      {
        domain: settings.aria2.domain,
        port: settings.aria2.port,
        path: settings.aria2.path,
        token: settings.aria2.token,
        dir: settings.aria2.dir,
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
    if (!link) return { ok: false, message: '看不懂这个链接。只支持夸克和百度的分享链接。' };

    const job = new Job({
      link,
      deliver: (files) => this.deliver(files),
      emit: (updated) => this.emit(updated.snapshot()),
      onDone: (contentsId) => this.byContents.delete(contentsId),
    });

    this.jobs.set(job.id, job);
    this.emit(job.snapshot());

    const contentsId = job.prepare(this.partition, this.preloadPath);
    if (contentsId >= 0) this.byContents.set(contentsId, job);
    job.load();

    return { ok: true, jobId: job.id };
  }

  /** @param {string} jobId */
  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || job.settled) return;
    // Settle through fail so the renderer receives a terminal state. Closing the
    // window alone would leave the row showing whatever phase it was in.
    job.fail('cancelled', '任务已取消。');
  }

  /** @param {string} jobId */
  reveal(jobId) {
    this.jobs.get(jobId)?.reveal();
  }

  /** @param {import('../shared/protocol').ExtractedFile[]} files */
  async deliver(files) {
    const settings = this.store.getSettings();

    if (settings.delivery === 'clipboard') {
      clipboard.writeText(files.map((file) => file.url).join('\r\n'));
      return;
    }

    if (settings.delivery === 'browser') {
      for (const file of files) await shell.openExternal(file.url);
      return;
    }

    for (const file of files) await aria2.addUri(settings.aria2, file);
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
