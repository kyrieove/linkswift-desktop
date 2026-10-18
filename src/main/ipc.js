'use strict';

const { dialog, shell } = require('electron');
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
  bus.handle(INVOKE.pause, (_event, jobId) => manager.pause(String(jobId)));
  bus.handle(INVOKE.resume, (_event, jobId) => manager.resume(String(jobId)));
  bus.handle(INVOKE.retry, (_event, jobId) => manager.retry(String(jobId)));
  bus.handle(INVOKE.listJobs, () => manager.list());
  bus.handle(INVOKE.getSettings, () => manager.store.getSettings());
  bus.handle(INVOKE.setSettings, async (_event, settings) => {
    const saved = manager.store.setSettings(settings ?? {});
    // Switching between the bundled binary and an outside aria2 has to take
    // effect now, not on the next launch.
    if (saved.aria2Mode === 'builtin' && !manager.aria2Status().running) {
      await manager.daemon.start({ dir: saved.aria2.dir });
    }
    return saved;
  });
  bus.handle(INVOKE.chooseDirectory, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  bus.handle(INVOKE.revealWindow, (_event, jobId) => manager.reveal(String(jobId)));
  bus.handle(INVOKE.archiveJobs, (_event, ids) => manager.archiveJobs(ids));
  bus.handle(INVOKE.unarchiveJobs, (_event, ids) => manager.unarchiveJobs(ids));
  bus.handle(INVOKE.purgeJobs, (_event, ids) => manager.purgeJobs(ids));
  bus.handle(INVOKE.providerHealth, () => manager.providerHealth());
  bus.handle(INVOKE.login, (_event, jobId) => manager.login(String(jobId)));
  bus.handle(INVOKE.continueAfterLogin, (_event, jobId) => manager.continueAfterLogin(String(jobId)));
  bus.handle(INVOKE.aria2Status, () => manager.aria2Status());
  bus.handle(INVOKE.restartAria2, async () => {
    const settings = manager.store.getSettings();
    if (settings.aria2Mode !== 'builtin') return manager.aria2Status();
    await manager.daemon.stop();
    await manager.daemon.start({ dir: settings.aria2.dir });
    return manager.aria2Status();
  });

  bus.handle(INVOKE.testAria2, async (_event, config) => {
    const target = config ?? manager.aria2Config();
    try {
      const info = await aria2.getVersion(target);
      return { ok: true, message: `连上了，aria2 ${info.version}` };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  bus.handle(INVOKE.openDownloadDir, async () => {
    const settings = manager.store.getSettings();
    const dir = settings.aria2.dir?.trim() || manager.daemon.defaultDir();
    const error = await shell.openPath(dir);
    return error || null;
  });
}

module.exports = { registerIpc };
