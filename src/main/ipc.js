'use strict';

const { INVOKE } = require('../shared/protocol');
const aria2 = require('./aria2');

/**
 * The renderer's whole IPC surface.
 *
 * It lives in its own module rather than inside the entry script so that a probe
 * can register the real handlers without starting the app. Requiring the entry
 * script would open a window as a side effect.
 *
 * @param {import('electron').IpcMain} bus
 * @param {import('./job').JobManager} manager
 */
function registerIpc(bus, manager) {
  bus.handle(INVOKE.submit, (_event, rawLink) => manager.submit(String(rawLink ?? '')));
  bus.handle(INVOKE.cancel, (_event, jobId) => manager.cancel(String(jobId)));
  bus.handle(INVOKE.getSettings, () => manager.store.getSettings());
  bus.handle(INVOKE.setSettings, (_event, settings) => manager.store.setSettings(settings ?? {}));
  bus.handle(INVOKE.revealWindow, (_event, jobId) => manager.reveal(String(jobId)));

  bus.handle(INVOKE.testAria2, async (_event, config) => {
    const target = config ?? manager.store.getSettings().aria2;
    try {
      const info = await aria2.getVersion(target);
      return { ok: true, message: `连上了，aria2 ${info.version}` };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
}

module.exports = { registerIpc };
