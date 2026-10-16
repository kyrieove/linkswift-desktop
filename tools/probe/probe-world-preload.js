'use strict';

const { webFrame, ipcRenderer } = require('electron');

/**
 * From the preload's isolated world, compare what it sees with what the page's
 * main world sees, sampled over time.
 *
 * This decides whether an isolated-world DOM query can see nodes the page inserts
 * after load, which is what the driver depends on.
 */
(async function main() {
  const report = { samples: [] };

  const isolatedCounts = () => {
    const count = (selector) => {
      try {
        return document.querySelectorAll(selector).length;
      } catch {
        return 'invalid';
      }
    };
    return {
      ready: document.readyState,
      hasRoot: Boolean(document.documentElement),
      bodyLength: document.body ? document.body.innerHTML.length : -1,
      plButton: count('.pl-button'),
      plButtonMode: count('.pl-button-mode'),
      xButtonBox: count('.x-button-box'),
    };
  };

  const mainCounts = async () => {
    try {
      const raw = await webFrame.executeJavaScript(`JSON.stringify({
        href: location.href,
        ready: document.readyState,
        bodyLength: document.body ? document.body.innerHTML.length : -1,
        plButton: document.querySelectorAll('.pl-button').length,
        plButtonMode: document.querySelectorAll('.pl-button-mode').length,
        xButtonBox: document.querySelectorAll('.x-button-box').length,
      })`);
      return JSON.parse(raw);
    } catch (error) {
      return `threw: ${error.message}`;
    }
  };

  for (let attempt = 0; attempt < 7; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    report.samples.push({
      at: (attempt + 1) * 3000,
      isolated: isolatedCounts(),
      main: await mainCounts(),
    });
  }

  ipcRenderer.send('world-report', report);
})();
