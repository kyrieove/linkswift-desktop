'use strict';

const aria2 = require('../aria2');

/**
 * aria2 作为传输引擎。
 *
 * 这一层只做一件事：把「把字节搬回来」这件事包成和 yt-dlp 一样的形状，
 * 让 `Job` 不必知道 GID 是什么，也不必知道进度从哪儿来。
 *
 * 引擎接口：
 *
 *   status()              引擎在不在、什么版本
 *   start(target)         开始搬，产出一次运行
 *   progress(run)         当前进度行
 *   pause(run)            暂停
 *   resume(run)           继续
 *   retry(run)            失败后重新投递
 *   cancel(run)           取消
 *
 * @typedef {object} TransferRun
 * @property {import('../../shared/protocol').EngineId} engine
 * @property {Array<{ file: import('../../shared/protocol').ExtractedFile, runId: string }>} runs
 * @property {import('../../shared/protocol').Aria2Config | null} [config]
 *
 * @typedef {object} TransferProgress
 * @property {import('../../shared/protocol').DownloadProgress[]} rows
 * @property {boolean} lost  引擎自己把这份下载弄丢了，需要重新投递
 */

/**
 * @param {import('../../shared/protocol').ExtractedFile} file
 * @param {string} runId
 * @returns {import('../../shared/protocol').DownloadProgress}
 */
function waitingRow(file, runId) {
  return {
    engine: 'aria2',
    runId,
    gid: runId,
    name: file.name,
    status: 'waiting',
    totalLength: 0,
    completedLength: 0,
    downloadSpeed: 0,
    connections: 0,
    errorCode: null,
    errorMessage: null,
  };
}

class Aria2Transfer {
  /**
   * @param {{ config: () => import('../../shared/protocol').Aria2Config | null }} options
   */
  constructor({ config }) {
    this.id = 'aria2';
    this.config = config;
  }

  /** @returns {Promise<{ running: boolean, version?: string, error?: string }>} */
  async status() {
    const config = this.config();
    if (!config) return { running: false, error: '没有可用的 aria2 配置' };
    try {
      const info = await aria2.getVersion(config, 2000);
      return { running: true, version: info.version };
    } catch (error) {
      return { running: false, error: error.message };
    }
  }

  /**
   * @param {{ files?: import('../../shared/protocol').ExtractedFile[] }} target
   * @returns {Promise<TransferRun>}
   */
  async start(target) {
    const files = target?.files || [];
    const config = this.config();
    if (!config) throw new Error('没有可用的 aria2 配置');
    const runs = [];
    for (const file of files) {
      runs.push({ file, runId: await aria2.addUri(config, file) });
    }
    return { engine: 'aria2', runs, config };
  }

  /**
   * @param {TransferRun} run
   * @returns {Promise<TransferProgress>}
   */
  async progress(run) {
    const rows = [];
    for (const item of run.runs) {
      const status = await aria2.findGid(run.config, item.runId);
      // aria2 忘了这个 GID，说明它的会话丢了。这不是进度，是需要重新投递。
      if (!status) return { rows, lost: true };
      rows.push({
        engine: 'aria2',
        runId: item.runId,
        gid: item.runId,
        name: item.file.name,
        status: status.status,
        totalLength: parseInt(status.totalLength || '0', 10),
        completedLength: parseInt(status.completedLength || '0', 10),
        downloadSpeed: parseInt(status.downloadSpeed || '0', 10),
        connections: parseInt(status.connections || '0', 10),
        errorCode: status.errorCode || null,
        errorMessage: status.errorMessage || null,
      });
    }
    return { rows, lost: false };
  }

  /** @param {TransferRun} run */
  async pause(run) {
    if (!run.config) return;
    for (const item of run.runs) await aria2.pause(run.config, item.runId).catch(() => {});
  }

  /** @param {TransferRun} run */
  async resume(run) {
    if (!run.config) return;
    for (const item of run.runs) await aria2.unpause(run.config, item.runId).catch(() => {});
  }

  /**
   * 把没下完的重新推一遍。已经完成的不能再推，否则会多出一份 `.1` 副本。
   *
   * @param {TransferRun} run
   * @param {TransferProgress} [previous] 上一次的进度，用来认出哪些已经完成
   * @returns {Promise<TransferRun>}
   */
  async retry(run, previous) {
    if (!run.config) throw new Error('没有可用的 aria2 配置');
    const runs = [];
    for (let index = 0; index < run.runs.length; index += 1) {
      const item = run.runs[index];
      const row = previous?.rows?.[index];
      if (row?.status === 'complete') {
        runs.push(item);
        continue;
      }
      runs.push({ file: item.file, runId: await aria2.addUri(run.config, item.file) });
    }
    return { ...run, runs };
  }

  /** @param {TransferRun} run */
  async cancel(run) {
    if (!run.config) return;
    for (const item of run.runs) await aria2.remove(run.config, item.runId).catch(() => {});
  }

  /**
   * @param {TransferRun} run
   * @returns {import('../../shared/protocol').DownloadProgress[]}
   */
  static rowsFor(run) {
    return run.runs.map((item) => waitingRow(item.file, item.runId));
  }
}

module.exports = { Aria2Transfer };
