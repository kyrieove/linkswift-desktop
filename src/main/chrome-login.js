'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync, spawn } = require('node:child_process');
const net = require('node:net');
const { app } = require('electron');

/**
 * Locate Chrome executable on Windows:
 * 1. Registry HKLM and HKCU App Paths\chrome.exe
 * 2. Common install paths in Program Files, Program Files (x86), LocalAppData
 * 3. Fallbacks on macOS / Linux
 *
 * @returns {string | null}
 */
function findChromeExecutable() {
  if (process.platform === 'win32') {
    for (const root of ['HKLM', 'HKCU']) {
      try {
        const out = execSync(
          `reg query "${root}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve`,
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
        );
        const match = out.match(/REG_SZ\s+([^\r\n]+)/);
        if (match && fs.existsSync(match[1].trim())) {
          return match[1].trim();
        }
      } catch {}
    }

    const candidates = [
      process.env.PROGRAMFILES &&
        path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['PROGRAMFILES(X86)'] &&
        path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env.LOCALAPPDATA &&
        path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env.PROGRAMW6432 &&
        path.join(process.env.PROGRAMW6432, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ].filter(Boolean);

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  } else if (process.platform === 'darwin') {
    const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(p)) return p;
  } else {
    const candidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

/**
 * Allocate an available TCP port.
 *
 * @returns {Promise<number>}
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on('error', reject);
  });
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let msgId = 0;

/**
 * Connect to Chrome's browser target WebSocket.
 *
 * @param {number} port
 * @param {number} deadline
 * @param {AbortSignal} [signal]
 * @returns {Promise<WebSocket>}
 */
async function connectBrowserWs(port, deadline, signal) {
  let wsUrl = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Aborted');
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        const json = await res.json();
        if (json.webSocketDebuggerUrl) {
          wsUrl = json.webSocketDebuggerUrl;
          break;
        }
      }
    } catch {}
    await sleep(400);
  }
  if (!wsUrl) return null;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));
    const ws = new WebSocket(wsUrl);
    const onAbort = () => {
      try {
        ws.close();
      } catch {}
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    ws.onopen = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve(ws);
    };
    ws.onerror = (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    };
  });
}

/**
 * Send a CDP command and wait for response.
 *
 * @param {WebSocket} ws
 * @param {string} method
 * @param {object} [params]
 * @returns {Promise<any>}
 */
function sendCdpCommand(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`CDP ${method} timed out`));
    }, 5000);

    function onMessage(event) {
      try {
        const data = JSON.parse(event.data);
        if (data.id === id) {
          cleanup();
          if (data.error) {
            reject(new Error(data.error.message || JSON.stringify(data.error)));
          } else {
            resolve(data.result);
          }
        }
      } catch (e) {
        cleanup();
        reject(e);
      }
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    function cleanup() {
      clearTimeout(timeout);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', onError);
    }

    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/**
 * Write matching cookies into Electron partition session.
 * Preserves domain, path, secure, httpOnly, expirationDate.
 *
 * @param {any[]} cookies
 * @param {(domain: string) => boolean} domainMatch
 * @param {import('electron').Session} targetSession
 * @returns {Promise<number>}
 */
async function importCookiesToSession(cookies, domainMatch, targetSession) {
  const matching = cookies.filter((c) => c && c.domain && domainMatch(c.domain));
  for (const c of matching) {
    const cleanDomain = c.domain.replace(/^\./, '');
    const isSecure = Boolean(c.secure);
    const protocol = isSecure ? 'https:' : 'http:';
    const cPath = c.path || '/';
    const url = `${protocol}//${cleanDomain}${cPath}`;

    const details = {
      url,
      name: c.name,
      value: c.value,
      path: cPath,
      secure: isSecure,
      httpOnly: Boolean(c.httpOnly),
    };

    if (c.domain.startsWith('.')) {
      details.domain = cleanDomain;
    }
    if (c.expires && c.expires > 0) {
      details.expirationDate = c.expires;
    }
    if (c.sameSite) {
      const s = String(c.sameSite).toLowerCase();
      if (s === 'strict') details.sameSite = 'strict';
      else if (s === 'lax') details.sameSite = 'lax';
      else if (s === 'none') details.sameSite = 'no_restriction';
    }

    try {
      await targetSession.cookies.set(details);
    } catch (err) {
      console.warn(`[chrome-login] failed to set cookie ${c.name}: ${err.message}`);
    }
  }
  await targetSession.cookies.flushStore();
  return matching.length;
}

/**
 * Close Chrome gracefully via CDP Browser.close, fallback to kill.
 *
 * @param {WebSocket | null} ws
 * @param {import('node:child_process').ChildProcess} child
 */
async function closeChrome(ws, child) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      await sendCdpCommand(ws, 'Browser.close').catch(() => {});
    }
  } catch {}
  try {
    if (ws) ws.close();
  } catch {}

  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (child.exitCode !== null) break;
    await sleep(150);
  }
  if (child.exitCode === null) {
    try {
      child.kill();
    } catch {}
  }
}

const PROVIDER_CONFIGS = {
  baidu: {
    loginUrl: 'https://pan.baidu.com/',
    keyCookie: 'BDUSS',
    domainMatch: (d) => typeof d === 'string' && d.includes('baidu.com'),
    providerName: '百度',
  },
  quark: {
    loginUrl: 'https://pan.quark.cn/',
    keyCookie: '__puus',
    domainMatch: (d) => typeof d === 'string' && d.includes('quark.cn'),
    providerName: '夸克',
  },
  uc: {
    loginUrl: 'https://drive.uc.cn/',
    keyCookie: '__puus',
    domainMatch: (d) => typeof d === 'string' && d.includes('uc.cn'),
    providerName: 'UC',
  },
};

/** @type {Map<string, Promise<{ ok: boolean, count: number }>>} */
const activeLogins = new Map();

/**
 * Launch Chrome for login and wait for key cookie.
 *
 * @param {string} provider
 * @param {import('electron').Session} targetSession
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: boolean, count: number }>}
 */
function performChromeLogin(provider, targetSession, options = {}) {
  const existing = activeLogins.get(provider);
  if (existing) return existing;

  const promise = doPerformChromeLogin(provider, targetSession, options).finally(() => {
    activeLogins.delete(provider);
  });
  activeLogins.set(provider, promise);
  return promise;
}

/**
 * @param {string} provider
 * @param {import('electron').Session} targetSession
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: boolean, count: number }>}
 */
async function doPerformChromeLogin(provider, targetSession, options = {}) {
  const config = PROVIDER_CONFIGS[provider];
  if (!config) {
    throw new Error(`不支持的网盘登录: ${provider}`);
  }

  const chromePath = findChromeExecutable();
  if (!chromePath) {
    const err = new Error('未找到 Chrome');
    err.code = 'CHROME_NOT_FOUND';
    throw err;
  }

  const port = await getFreePort();
  const profileDir = path.join(app.getPath('appData'), 'linkswift', 'chrome-profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const child = spawn(
    chromePath,
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      config.loginUrl,
    ],
    {
      detached: false,
      stdio: 'ignore',
    },
  );

  console.log(`[chrome-login] Chrome 已打开，请登录${config.providerName}`);

  const TIMEOUT_MS = 300000; // 5 minutes
  const POLL_INTERVAL_MS = 2000;
  const deadline = Date.now() + TIMEOUT_MS;
  const signal = options.signal;

  let ws = null;

  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        const abortErr = new Error('登录已取消');
        abortErr.name = 'AbortError';
        throw abortErr;
      }

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        ws = await connectBrowserWs(port, deadline, signal).catch(() => null);
      }

      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          const res = await sendCdpCommand(ws, 'Storage.getCookies');
          const cookies = res?.cookies || [];
          const hasKey = cookies.some((c) => c && c.name === config.keyCookie && c.value);
          if (hasKey) {
            console.log(`[chrome-login] 检测到关键 Cookie (${config.keyCookie})，正在导入...`);
            const count = await importCookiesToSession(cookies, config.domainMatch, targetSession);
            console.log(
              `[chrome-login] 已导入 ${count} 个 Cookie 到 persist:linkswift，正在关闭 Chrome...`,
            );
            await closeChrome(ws, child);
            return { ok: true, count };
          }
        } catch (e) {
          // CDP command or connection error, wait and retry
        }
      }

      await sleep(POLL_INTERVAL_MS);
    }

    // 5 minutes timeout
    await closeChrome(ws, child);
    const timeoutErr = new Error('登录未完成，重新提交即可');
    timeoutErr.code = 'LOGIN_TIMEOUT';
    throw timeoutErr;
  } catch (err) {
    await closeChrome(ws, child);
    throw err;
  }
}

module.exports = {
  findChromeExecutable,
  getFreePort,
  performChromeLogin,
};
