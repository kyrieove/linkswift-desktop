'use strict';

/**
 * The GM_* layer that the userscript expects to find as page globals.
 *
 * This function is serialized with toString() and executed in the page's main
 * world, so it must not reference anything outside its own body. Everything it
 * needs arrives in `boot`.
 *
 * It talks to the preload over window.postMessage, which is the only channel
 * that crosses the context-isolation boundary. See DESIGN.md 4.4.
 *
 * @param {{
 *   marker: string,
 *   fromPage: string,
 *   fromHost: string,
 *   values: Record<string, unknown>,
 *   resources: Record<string, string>,
 *   scriptVersion: string,
 *   appVersion: string,
 * }} boot
 */
function installLinkSwiftShim(boot) {
  if (window.__linkswiftShimInstalled) return { installed: false };
  window.__linkswiftShimInstalled = true;

  const values = new Map(Object.entries(boot.values || {}));
  const resources = boot.resources || {};
  const pending = new Map();
  const lastHeaders = new Map();
  let nextId = 1;

  function post(message) {
    const envelope = { from: boot.fromPage, kind: message.kind };
    envelope[boot.marker] = true;
    for (const key of Object.keys(message)) envelope[key] = message[key];
    window.postMessage(envelope, '*');
  }

  function reportError(error) {
    post({ kind: 'script-error', message: String(error), stack: (error && error.stack) || null });
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data[boot.marker] !== true || data.from !== boot.fromHost) return;

    if (data.kind === 'http-response') {
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      entry(data);
    } else if (data.kind === 'storage-changed') {
      values.set(data.key, data.value);
    }
  });

  window.GM_info = {
    script: {
      name: 'LinkSwift',
      namespace: 'github.com/hmjz100',
      version: boot.scriptVersion,
      author: 'Hmjz100、油小猴',
      description: '网盘直链下载助手',
    },
    scriptHandler: 'LinkSwift Desktop',
    version: boot.appVersion,
  };

  window.GM_registerMenuCommand = function (name) {
    post({ kind: 'menu-command', name: String(name) });
    return String(name);
  };

  window.GM_getValue = function (key, fallback) {
    return values.has(key) ? values.get(key) : fallback;
  };

  window.GM_setValue = function (key, value) {
    values.set(key, value);
    post({ kind: 'storage-set', key: String(key), value: value });
  };

  window.GM_deleteValue = function (key) {
    values.delete(key);
    post({ kind: 'storage-delete', key: String(key) });
  };

  window.GM_getResourceText = function (name) {
    return Object.prototype.hasOwnProperty.call(resources, name) ? resources[name] : '';
  };

  window.GM_setClipboard = function (text) {
    post({ kind: 'clipboard', text: String(text) });
    return true;
  };

  window.GM_openInTab = function (url) {
    post({ kind: 'open-tab', url: String(url) });
    return { close: function () {}, closed: false };
  };

  // The userscript copies the returned object's own function properties onto its
  // promise, so abort and friends must be own properties, not prototype methods.
  window.GM_xmlhttpRequest = function (option) {
    const id = nextId++;

    function abort() {
      pending.delete(id);
    }

    function getAllResponseHeaders() {
      const entry = lastHeaders.get(id);
      return entry || '';
    }

    const handle = { abort: abort, getAllResponseHeaders: getAllResponseHeaders };

    function parseResponse(text, type) {
      if (text === null || text === undefined) return '';
      if (type !== 'json') return text;
      try {
        return JSON.parse(text);
      } catch (error) {
        return text;
      }
    }

    function settle(data) {
      if (data.headers) lastHeaders.set(id, data.headers);
      const response = {
        responseText: data.text === null || data.text === undefined ? '' : data.text,
        // A real GM_xmlhttpRequest hands back a parsed object for responseType
        // 'json'. The script's own decode path mangles any body with non-ASCII
        // text (escape() then JSON.parse) and ends up with a string.
        response: parseResponse(data.text, option.responseType),
        status: data.status === null || data.status === undefined ? 0 : data.status,
        statusText: data.statusText || '',
        readyState: 4,
        finalUrl: data.finalUrl || option.url,
        responseHeaders: data.headers || '',
      };

      try {
        if (typeof option.onreadystatechange === 'function') option.onreadystatechange(response);
      } catch (error) {
        reportError(error);
      }

      try {
        if (data.ok) {
          if (typeof option.onload === 'function') option.onload(response);
        } else if (typeof option.onerror === 'function') {
          // Carry the body through. Without it a rejected request is undiagnosable
          // from the userscript's own error message.
          option.onerror({ error: data.error || 'request failed', status: response.status, response: response });
        }
      } catch (error) {
        reportError(error);
      }
    }

    pending.set(id, settle);

    try {
      if (typeof option.onloadstart === 'function') option.onloadstart();
    } catch (error) {
      reportError(error);
    }

    post({
      kind: 'http',
      id: id,
      url: String(option.url),
      method: String(option.method || 'GET').toUpperCase(),
      body: option.data === undefined || option.data === null ? null : String(option.data),
      headers: option.headers || {},
    });

    return handle;
  };

  post({ kind: 'shim-ready', href: location.href });

  return { installed: true };
}

/**
 * @param {Parameters<typeof installLinkSwiftShim>[0]} boot
 * @returns {string} source to hand to webFrame.executeJavaScript
 */
function buildShimSource(boot) {
  return `(${installLinkSwiftShim.toString()})(${JSON.stringify(boot)});`;
}

module.exports = { buildShimSource };
