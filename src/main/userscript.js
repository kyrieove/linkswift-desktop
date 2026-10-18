'use strict';

const fs = require('node:fs');
const path = require('node:path');

const UPSTREAM_URL =
  'https://raw.githubusercontent.com/hmjz100/LinkSwift/dev/' +
  '%EF%BC%88%E6%94%B9%EF%BC%89%E7%BD%91%E7%9B%98%E7%9B%B4%E9%93%BE%E4%B8%8B%E8%BD%BD%E5%8A%A9%E6%89%8B.user.js';

/**
 * Keeps the userscript fresh without ever leaving the app without one.
 *
 * Three sources, tried in order. The last one ships inside the repository, so a
 * user who is offline or behind a block still gets a working app.
 *
 *   1. the upstream file over the network
 *   2. the copy cached in userData from a previous successful fetch
 *   3. resources/userscript.user.js committed to this repository
 */
class UserscriptSource {
  /**
   * @param {{ userDataDir: string, bundledPath: string }} options
   */
  constructor({ userDataDir, bundledPath }) {
    this.cachePath = path.join(userDataDir, 'userscript.cache.js');
    this.bundledPath = bundledPath;
    /** @type {{ source: string, version: string, origin: string } | null} */
    this.current = null;
  }

  /**
   * Refresh in the background. Never throws: a failed refresh keeps whatever
   * version is already loaded.
   * @returns {Promise<{ source: string, version: string, origin: string }>}
   */
  async refresh() {
    try {
      const response = await fetch(UPSTREAM_URL, { redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const raw = await response.text();
      if (!raw.includes('==UserScript==')) throw new Error('response is not a userscript');
      const source = patchSource(raw);
      fs.writeFileSync(this.cachePath, source, 'utf8');
      this.current = { source, version: parseVersion(source), origin: 'upstream' };
    } catch (error) {
      console.error(`[userscript] refresh failed: ${error.message}`);
      if (!this.current) this.current = this.loadFallback();
    }
    return this.current;
  }

  /** @returns {{ source: string, version: string, origin: string }} */
  loadFallback() {
    for (const [file, origin] of [
      [this.cachePath, 'cache'],
      [this.bundledPath, 'bundled'],
    ]) {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        if (raw.includes('==UserScript==')) {
          const source = patchSource(raw);
          return { source, version: parseVersion(source), origin };
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error(`[userscript] cannot read ${file}: ${error.message}`);
        }
      }
    }
    throw new Error('no userscript available: refresh failed and no cache or bundled copy exists');
  }

  /** @returns {{ source: string, version: string, origin: string }} */
  get() {
    if (!this.current) this.current = this.loadFallback();
    return this.current;
  }
}

/**
 * @param {string} source
 * @returns {string}
 */
function parseVersion(source) {
  return source.match(/^\/\/\s*@version\s+(\S+)/m)?.[1] ?? '0.0.0';
}

const XUNLEI_TOKEN_URL = 'https://xluser-ssl.xunlei.com/v1/auth/token';
const XUNLEI_ANCHOR = 'getLink: "https://api-pan.xunlei.com/drive/v1/files/",';

/**
 * Upstream references `config.$xunlei.api.getAccessToken` when it refreshes an
 * expired 迅雷 credential, but never defines it, so the refresh posts to
 * `undefined` and every expired session dies there. The endpoint is the one the
 * web client itself uses, and the request it builds (client_id, grant_type
 * refresh_token, x-device-* headers) is already the right shape for it.
 *
 * @param {string} source
 * @returns {string}
 */
function patchSource(source) {
  if (source.includes(XUNLEI_TOKEN_URL)) return source;
  if (!source.includes(XUNLEI_ANCHOR)) return source;
  return source.replace(XUNLEI_ANCHOR, `getAccessToken: "${XUNLEI_TOKEN_URL}",\n${XUNLEI_ANCHOR}`);
}

module.exports = { UserscriptSource, UPSTREAM_URL, parseVersion, patchSource };
