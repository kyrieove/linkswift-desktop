'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { INVOKE, PUSH } = require('../shared/protocol');

/**
 * The renderer's whole view of the host. Everything else stays in the main
 * process: no Node, no filesystem, no network from the UI.
 */
contextBridge.exposeInMainWorld('linkswift', {
  submit: (rawLink) => ipcRenderer.invoke(INVOKE.submit, rawLink),
  cancel: (jobId) => ipcRenderer.invoke(INVOKE.cancel, jobId),
  pause: (jobId) => ipcRenderer.invoke(INVOKE.pause, jobId),
  resume: (jobId) => ipcRenderer.invoke(INVOKE.resume, jobId),
  retry: (jobId) => ipcRenderer.invoke(INVOKE.retry, jobId),
  listJobs: () => ipcRenderer.invoke(INVOKE.listJobs),
  getSettings: () => ipcRenderer.invoke(INVOKE.getSettings),
  setSettings: (settings) => ipcRenderer.invoke(INVOKE.setSettings, settings),
  revealWindow: (jobId) => ipcRenderer.invoke(INVOKE.revealWindow, jobId),
  login: (jobId) => ipcRenderer.invoke(INVOKE.login, jobId),
  continueAfterLogin: (jobId) => ipcRenderer.invoke(INVOKE.continueAfterLogin, jobId),
  testAria2: (config) => ipcRenderer.invoke(INVOKE.testAria2, config),
  aria2Status: () => ipcRenderer.invoke(INVOKE.aria2Status),
  restartAria2: () => ipcRenderer.invoke(INVOKE.restartAria2),
  openDownloadDir: (jobId) => ipcRenderer.invoke(INVOKE.openDownloadDir, jobId),
  chooseDirectory: () => ipcRenderer.invoke(INVOKE.chooseDirectory),
  archiveJobs: (ids) => ipcRenderer.invoke(INVOKE.archiveJobs, ids),
  unarchiveJobs: (ids) => ipcRenderer.invoke(INVOKE.unarchiveJobs, ids),
  purgeJobs: (ids) => ipcRenderer.invoke(INVOKE.purgeJobs, ids),
  providerHealth: () => ipcRenderer.invoke(INVOKE.providerHealth),
  onJobEvent: (handler) => {
    ipcRenderer.on(PUSH.jobEvent, (_event, job) => handler(job));
  },
});
