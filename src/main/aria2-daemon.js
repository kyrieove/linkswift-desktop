'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');

const aria2 = require('./aria2');

/**
 * The aria2 that ships with the app.
 *
 * The point of running one here instead of asking the user to install aria2 and
 * fill in an RPC address: paste a link and the download starts, and every
 * download keeps its `.aria2` control file plus an entry in the session file, so
 * a download that was halfway through when the app quit continues from where it
 * stopped on the next start.
 *
 * Ownership rules, in order:
 *   1. an aria2 already answering on our persisted port with our secret is
 *      adopted, not duplicated (that is a child orphaned by a crash, and it may
 *      still be writing the session file)
 *   2. otherwise our own child is spawned on a free port
 */

const DEFAULT_PORT = 6800;
const READY_TIMEOUT_MS = 20000;

/** @param {string} file @param {unknown} fallback */
function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') return { ...fallback, ...parsed };
  } catch {}
  return { ...fallback };
}

/** @param {number} port @returns {Promise<boolean>} */
function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/** @returns {Promise<number>} */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

class Aria2Daemon {
  /**
   * @param {{ userDataDir: string, binaryPath: string | null }} options
   */
  constructor({ userDataDir, binaryPath }) {
    this.userDataDir = userDataDir;
    this.binaryPath = binaryPath;
    this.statePath = path.join(userDataDir, 'aria2-local.json');
    this.dataDir = path.join(userDataDir, 'aria2');
    this.sessionPath = path.join(this.dataDir, 'session.txt');
    this.logPath = path.join(this.dataDir, 'aria2.log');

    this.state = readJson(this.statePath, { port: DEFAULT_PORT, secret: randomBytes(16).toString('hex') });
    // The secret has to survive the process, or a second launch cannot tell its
    // own orphaned aria2 from a stranger's and starts a duplicate.
    if (!fs.existsSync(this.statePath)) {
      try {
        fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
        this.persistState();
      } catch (error) {
        console.error(`[aria2] cannot persist the local RPC secret: ${error.message}`);
      }
    }
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null;
    /** @type {string | null} */
    this.version = null;
    /** @type {string | null} */
    this.error = null;
    this.adopted = false;
    this.stopping = false;
    /** @type {string | null} */
    this.dir = null;
  }

  /** The RPC endpoint of the bundled aria2, in the same shape as a user config. */
  config() {
    return {
      domain: 'http://127.0.0.1',
      port: String(this.state.port),
      path: '/jsonrpc',
      token: this.state.secret,
      dir: '',
    };
  }

  status() {
    return {
      mode: 'builtin',
      running: Boolean(this.version),
      port: this.state.port,
      version: this.version,
      error: this.error,
      adopted: this.adopted,
      dir: this.dir,
      sessionPath: this.sessionPath,
      logPath: this.logPath,
    };
  }

  /**
   * Start if not already serving. Idempotent: the settings screen and the app
   * boot both call it.
   *
   * @param {{ dir?: string }} options
   * @returns {Promise<ReturnType<Aria2Daemon['status']>>}
   */
  async start({ dir } = {}) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.error = null;
    const target = this.config();
    const wantedDir = dir && dir.trim() ? dir.trim() : this.defaultDir();
    try {
      fs.mkdirSync(wantedDir, { recursive: true });
    } catch (error) {
      this.error = `无法创建下载目录 ${wantedDir}：${error.message}`;
      return this.status();
    }

    if (this.child && this.child.exitCode === null) {
      this.dir = wantedDir;
      return this.status();
    }

    const adopted = await aria2.getVersion(target, 1500).catch(() => null);
    if (adopted) {
      this.version = adopted.version;
      this.adopted = true;
      this.dir = wantedDir;
      return this.status();
    }

    this.adopted = false;
    if (!(await portFree(this.state.port))) {
      this.state.port = await findFreePort();
      this.persistState();
    }
    // Recompute: the endpoint above still points at the port we just abandoned.
    const endpoint = this.config();

    const binary = this.resolveBinary();
    if (!binary) {
      this.error = '找不到内置 aria2c.exe，请重新安装或改用外部下载器';
      return this.status();
    }

    const args = this.buildArgs(wantedDir);
    let stderr = '';
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    child.on('exit', (code) => {
      if (this.child === child) {
        this.child = null;
        this.version = null;
        if (code !== 0 && !this.stopping) {
          this.error = `aria2 退出了（代码 ${code}）${stderr ? `：${stderr.trim().split('\n').pop()}` : ''}`;
        }
      }
    });
    child.on('error', (error) => {
      this.error = `无法启动 aria2：${error.message}`;
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const info = await aria2.getVersion(endpoint, 1500).catch(() => null);
      if (info) {
        this.version = info.version;
        this.dir = wantedDir;
        return this.status();
      }
      if (this.error) return this.status();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    this.error = `aria2 在 ${READY_TIMEOUT_MS / 1000} 秒内没有响应 RPC${stderr ? `：${stderr.trim().split('\n').pop()}` : ''}`;
    return this.status();
  }

  /** Ask aria2 to save its session, then stop the child. Throws if it refuses to exit. */
  async stop() {
    const config = this.config();
    const child = this.child;
    const stillRunning = () => Boolean(child) && child.exitCode === null && child.signalCode === null;
    this.stopping = true;
    try {
      if (child) {
        await aria2.call(config, 'aria2.saveSession', []).catch(() => {});
        await aria2.call(config, 'aria2.shutdown', []).catch(() => {});
        const deadline = Date.now() + 5000;
        while (stillRunning() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (stillRunning()) {
          child.kill();
          const killDeadline = Date.now() + 3000;
          while (stillRunning() && Date.now() < killDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      }
    } finally {
      this.child = null;
      this.version = null;
      this.stopping = false;
    }
    if (stillRunning()) throw new Error(`aria2 process ${child.pid} is still running after stop()`);
  }

  /** @returns {string} */
  defaultDir() {
    return path.join(require('electron').app.getPath('downloads'), 'LinkSwift');
  }

  /** @returns {string | null} */
  resolveBinary() {
    const candidates = [
      this.binaryPath,
      process.platform === 'win32' ? 'aria2c.exe' : 'aria2c',
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (!candidate.includes(path.sep)) return candidate;
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** @param {string} dir @returns {string[]} */
  buildArgs(dir) {
    const args = [
      '--enable-rpc=true',
      // Loopback only: the RPC secret travels in clear text over plain HTTP.
      '--rpc-listen-all=false',
      `--rpc-listen-port=${this.state.port}`,
      `--rpc-secret=${this.state.secret}`,
      // Resume whatever file is already on disk, which is what makes a restart
      // continue instead of starting over.
      '--continue=true',
      `--save-session=${this.sessionPath}`,
      '--save-session-interval=5',
      `--dir=${dir}`,
      '--retry-wait=10',
      '--max-tries=10',
      '--timeout=60',
      '--connect-timeout=20',
      '--split=16',
      '--max-connection-per-server=16',
      '--min-split-size=1M',
      '--summary-interval=0',
      `--log=${this.logPath}`,
      '--log-level=warn',
      '--console-log-level=warn',
      // A user-level %USERPROFILE%\.aria2\aria2.conf would silently override the
      // options above, including the RPC secret.
      '--no-conf=true',
    ];
    if (this.sessionExists()) args.push(`--input-file=${this.sessionPath}`);
    return args;
  }

  sessionExists() {
    try {
      return fs.statSync(this.sessionPath).size > 0;
    } catch {
      return false;
    }
  }

  persistState() {
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf8');
  }
}

module.exports = { Aria2Daemon, DEFAULT_PORT };
