'use strict';

const fs = require('node:fs');
const path = require('node:path');
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
 * @param {{ authorizeUiSender?: (event: import('electron').IpcMainInvokeEvent) => boolean }} [options]
 */
function registerIpc(bus, manager, options = {}) {
  const authorizeUiSender = options.authorizeUiSender || null;

  function checkedHandle(channel, handler) {
    bus.handle(channel, async (event, ...args) => {
      if (authorizeUiSender && !authorizeUiSender(event)) {
        throw new Error(`Forbidden IPC sender on ${channel}`);
      }
      return handler(event, ...args);
    });
  }

  checkedHandle(INVOKE.submit, (_event, rawLink) => manager.submit(String(rawLink ?? '')));
  checkedHandle(INVOKE.cancel, (_event, jobId) => manager.cancel(String(jobId)));
  checkedHandle(INVOKE.pause, (_event, jobId) => manager.pause(String(jobId)));
  checkedHandle(INVOKE.resume, (_event, jobId) => manager.resume(String(jobId)));
  checkedHandle(INVOKE.retry, (_event, jobId) => manager.retry(String(jobId)));
  checkedHandle(INVOKE.listJobs, () => manager.list());
  checkedHandle(INVOKE.getSettings, () => manager.store.getSettings());
  checkedHandle(INVOKE.setSettings, async (_event, settings) => {
    const saved = manager.store.setSettings(settings ?? {});
    // Switching between the bundled binary and an outside aria2 has to take
    // effect now, not on the next launch.
    if (saved.aria2Mode === 'builtin' && !manager.aria2Status().running) {
      await manager.daemon.start({ dir: saved.aria2.dir });
    }
    return saved;
  });
  checkedHandle(INVOKE.chooseDirectory, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  checkedHandle(INVOKE.chooseFile, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  checkedHandle(INVOKE.revealWindow, (_event, jobId) => manager.reveal(String(jobId)));
  checkedHandle(INVOKE.archiveJobs, (_event, ids) => manager.archiveJobs(ids));
  checkedHandle(INVOKE.unarchiveJobs, (_event, ids) => manager.unarchiveJobs(ids));
  checkedHandle(INVOKE.purgeJobs, (_event, ids) => manager.purgeJobs(ids));
  checkedHandle(INVOKE.providerHealth, () => manager.providerHealth());
  checkedHandle(INVOKE.sources, () => manager.sources());
  checkedHandle(INVOKE.ytdlpStatus, () => manager.ytdlpStatus());
  checkedHandle(INVOKE.ytdlpUpdate, () => manager.updateYtDlp());
  checkedHandle(INVOKE.ffmpegStatus, () => manager.ffmpegStatus());
  checkedHandle(INVOKE.login, (_event, jobId) => manager.login(String(jobId)));
  checkedHandle(INVOKE.continueAfterLogin, (_event, jobId) => manager.continueAfterLogin(String(jobId)));
  checkedHandle(INVOKE.aria2Status, () => manager.aria2Status());
  checkedHandle(INVOKE.restartAria2, async () => {
    const settings = manager.store.getSettings();
    if (settings.aria2Mode !== 'builtin') return manager.aria2Status();
    await manager.daemon.stop();
    await manager.daemon.start({ dir: settings.aria2.dir });
    return manager.aria2Status();
  });

  checkedHandle(INVOKE.testAria2, async (_event, config) => {
    const target = config ?? manager.aria2Config();
    try {
      const info = await aria2.getVersion(target);
      return { ok: true, message: `连上了，aria2 ${info.version}` };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  checkedHandle(INVOKE.openDownloadDir, async (_event, jobId) => {
    const settings = manager.store.getSettings();
    const dir = settings.aria2.dir?.trim() || manager.daemon.defaultDir();
    if (jobId) {
      const job = manager.jobs.get(String(jobId)) || manager.tasks.all().find((t) => t.id === String(jobId));
      const files = job?.state?.files ?? job?.files;
      if (Array.isArray(files) && files.length > 0 && files[0]?.name) {
        const filePath = path.join(dir, files[0].name);
        try {
          if (fs.existsSync(filePath)) {
            shell.showItemInFolder(filePath);
            return null;
          }
        } catch {
          // ignore fs errors and fall back to openPath
        }
      }
    }
    const error = await shell.openPath(dir);
    return error || null;
  });
}

module.exports = { registerIpc };
