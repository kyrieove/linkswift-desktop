'use strict';

/**
 * 媒体设置 → yt-dlp 参数。
 *
 * 纯函数，两边都用得上：主进程拿它拼命令行，检查脚本拿它断言参数映射。
 * 放在 shared 下，因为它描述的是「用户设了什么」到「yt-dlp 收什么」这件事，
 * 与谁来调用无关。
 */

/**
 * @param {Record<string, any>} settings
 * @returns {Record<string, any>}
 */
function mediaOptions(settings = {}) {
  const media = settings.media || {};
  return {
    format: media.format || '',
    audioFormat: media.audioFormat || '',
    audioQuality: media.audioQuality || '',
    mergeFormat: media.mergeFormat || '',
    embedThumbnail: Boolean(media.embedThumbnail),
    embedMetadata: Boolean(media.embedMetadata),
    writeSubs: Boolean(media.writeSubs),
    subLangs: media.subLangs || '',
    playlist: Boolean(media.playlist),
    ffmpegPath: media.ffmpegPath || '',
    // The cookie file is written by the media login flow, not by a setting.
    cookiesFile: '',
  };
}

module.exports = { mediaOptions };
