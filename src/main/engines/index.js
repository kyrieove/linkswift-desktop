'use strict';

const { Aria2Transfer } = require('./aria2-transfer');
const { YtDlpTransfer } = require('./ytdlp-transfer');

/**
 * 引擎注册表。
 *
 * 来源自己声明默认引擎，用户可以在设置里覆盖。aria2 是一个实现，不是前提：
 * 把某个来源指到 yt-dlp 上，只改这一处配置。
 */

/**
 * 选一个来源实际能用的引擎。
 *
 * 来源自己声明默认引擎，用户可以在设置里覆盖。aria2 是一个实现，不是前提：
 * 把某个来源指到 yt-dlp 上，只改这一处配置。
 *
 * 覆盖只在该来源真的支持这个引擎时生效。媒体交给 aria2 会得到一个永远
 * 停在「下载中」的空任务，网盘交给 yt-dlp 会因为没有地址直接报错，
 * 所以这里宁可退回来源自己的默认引擎，也不让用户调出一个跑不动的组合。
 *
 * @param {{ id: string, engine: import('../../shared/protocol').EngineId,
 *   engines?: import('../../shared/protocol').EngineId[] }} source
 * @param {Record<string, any>} [settings]
 * @returns {import('../../shared/protocol').EngineId}
 */
function resolveEngineId(source, settings = {}) {
  const override = settings.engineOverrides?.[source.id];
  if (override !== 'aria2' && override !== 'yt-dlp') return source.engine;
  const supported = source.engines || [source.engine];
  return supported.includes(override) ? override : source.engine;
}

/**
 * @param {{ engineId: import('../../shared/protocol').EngineId,
 *   aria2Config: () => import('../../shared/protocol').Aria2Config | null,
 *   ytdlp: { binary: string },
 *   options?: Record<string, any> }} input
 * @returns {Aria2Transfer | YtDlpTransfer}
 */
function createTransfer({ engineId, aria2Config, ytdlp, options }) {
  if (engineId === 'yt-dlp') {
    return new YtDlpTransfer({ binary: ytdlp?.binary || '', options: options || {} });
  }
  return new Aria2Transfer({ config: aria2Config });
}

module.exports = { Aria2Transfer, YtDlpTransfer, createTransfer, resolveEngineId };
