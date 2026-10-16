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
  getSettings: () => ipcRenderer.invoke(INVOKE.getSettings),
  setSettings: (settings) => ipcRenderer.invoke(INVOKE.setSettings, settings),
  revealWindow: (jobId) => ipcRenderer.invoke(INVOKE.revealWindow, jobId),
  testAria2: (config) => ipcRenderer.invoke(INVOKE.testAria2, config),
  onJobEvent: (handler) => {
    ipcRenderer.on(PUSH.jobEvent, (_event, job) => handler(job));
  },
});
