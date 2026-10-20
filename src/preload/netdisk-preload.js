'use strict';

const { ipcRenderer, webFrame } = require('electron');
const { INTERNAL, BRIDGE } = require('../shared/protocol');
const { buildShimSource } = require('./main-world');
const { runDriver } = require('./driver');

/**
 * The preload for the hidden netdisk window.
 *
 * It runs in the isolated world, installs jQuery, SweetAlert2, js-md5 and the
 * GM_* shim into the page's main world, runs the userscript there, and relays
 * observations up to the main process and driver commands back down. It never
 * commands the page except through the step table in shared/providers.js.
 */

/**
 * registerPreloadScript with type 'frame' runs in every frame. Netdisk share
 * pages embed many iframes, and injecting an 810 KB userscript into each one
 * would be both slow and wrong.
 */
function isTopFrame() {
  try {
    return process.isMainFrame !== false;
  } catch {
    return window.top === window;
  }
}

function providerFor(hostname) {
  const { PROVIDERS } = require('../shared/providers');
  return Object.values(PROVIDERS).find((provider) => {
    try {
      return provider.matches(new URL(`https://${hostname}/`));
    } catch {
      return false;
    }
  });
}

/** @param {unknown} payload */
function toPage(payload) {
  window.postMessage({ [BRIDGE.marker]: true, from: BRIDGE.fromHost, .../** @type {object} */ (payload) }, '*');
}

/**
 * At the first preload tick the document tree does not exist yet, and every
 * library that touches documentElement throws if injected then. Waiting for the
 * root element still beats the page's own scripts, because those live inside the
 * root element and are parsed after it is created.
 */
async function waitForDocumentElement(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!document.documentElement) {
    if (Date.now() > deadline) throw new Error('文档根节点一直没出现');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * The userscript reports its own failures as SweetAlert dialogs rather than
 * exceptions. The dialog text is therefore the only signal that a human is
 * needed, for example a login wall or a missing extraction code.
 *
 * @param {(observation: object) => void} report
 */
function watchDialogs(report) {
  const seen = new Set();
  const observer = new MutationObserver(() => {
    const node = document.querySelector('.swal2-html-container, .swal2-title');
    const text = node?.textContent?.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    report({ kind: 'dialog', text });
  });
  // document.documentElement is still null at document-start, so observe the
  // document itself.
  observer.observe(document, { childList: true, subtree: true, characterData: true });
}

async function run() {
  if (!isTopFrame()) return;

  const provider = providerFor(location.hostname);
  if (!provider) return;

  /** @type {{ values: object, resources: Record<string, string>, vendor: Record<string, string>, userscript: string, scriptVersion: string, appVersion: string }} */
  let payload;
  try {
    payload = ipcRenderer.sendSync(INTERNAL.boot, { providerId: provider.id, href: location.href });
  } catch (error) {
    console.error('[linkswift] boot handshake failed', error);
    return;
  }
  if (!payload || !payload.vendor) return;

  const report = (observation) => ipcRenderer.send(INTERNAL.observation, observation);

  watchDialogs(report);
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data[BRIDGE.marker] !== true || data.from !== BRIDGE.fromPage) return;
    report(data);
  });

  await waitForDocumentElement();

  const steps = [
    ['jquery', payload.vendor.jquery],
    ['sweetalert2', payload.vendor.sweetalert2],
    ['js-md5', payload.vendor.md5],
    [
      'gm-shim',
      buildShimSource({
        marker: BRIDGE.marker,
        fromPage: BRIDGE.fromPage,
        fromHost: BRIDGE.fromHost,
        values: payload.values,
        resources: payload.resources,
        scriptVersion: payload.scriptVersion,
        appVersion: payload.appVersion,
      }),
    ],
    ['userscript', payload.userscript],
  ];

  for (const [name, source] of steps) {
    if (!source) {
      report({ kind: 'script-error', message: `注入 ${name} 时缺少源码`, stack: null });
      return;
    }
    try {
      await webFrame.executeJavaScript(source);
    } catch (error) {
      // The userscript is one IIFE. If it throws, nothing else reports it.
      report({
        kind: 'script-error',
        message: `注入 ${name} 失败：${error.message}`,
        stack: error.stack ?? null,
      });
      return;
    }
  }
  report({ kind: 'injected', href: location.href, provider: provider.id });

  ipcRenderer.on(INTERNAL.command, async (_event, command) => {
    if (command.kind === 'storage-changed') {
      toPage({ kind: 'storage-changed', key: command.key, value: command.value });
      return;
    }

    // The page's GM_xmlhttpRequest waits on this. Without the relay the request
    // never settles and the userscript sits on its loading dialog forever.
    if (command.kind === 'http-response') {
      toPage(command);
      return;
    }

    if (command.kind === 'run-driver') {
      // Which frame is this preload running in? A driver in a subframe queries the
      // wrong document and finds nothing.
      const where = await webFrame
        .executeJavaScript(
          `JSON.stringify({ href: location.href, top: window.top === window, bodyLength: document.body ? document.body.innerHTML.length : -1 })`,
        )
        .catch((error) => `threw: ${error.message}`);
      report({ kind: 'driver-frame', where, isMainFrame: process.isMainFrame });

      const mode = command.mode === 'transfer' ? 'transfer' : 'share';
      let result;
      try {
        result = await runDriver(provider, command.passcode ?? null, mode);
      } catch (error) {
        result = { ok: false, step: -1, verb: 'driver', selector: null, detail: error.message };
      }
      report({ kind: 'driver-result', mode, ...result });
    }
  });
}

// A throw anywhere in here would otherwise leave the page silently un-injected.
(async function boot() {
  try {
    await run();
  } catch (error) {
    ipcRenderer.send(INTERNAL.observation, {
      kind: 'script-error',
      message: `preload 启动失败：${error.message}`,
      stack: error.stack ?? null,
    });
  }
})();
