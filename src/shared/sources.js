'use strict';

/**
 * 来源注册表。
 *
 * 一个来源回答两件事：这条链接是什么，以及该由谁来下载。
 *
 * 过去「网盘」这两件事都塞在 `shared/providers.js` 的一条记录里，于是
 * 「解析出的地址」和「怎么把字节搬回来」被绑死成 aria2 加网盘这一种组合。
 * 现在拆成两层：
 *
 *   providers.js   网盘专属知识。分享页怎么点、凭证在哪、哪些域名带 cookie。
 *   sources.js     来源身份。加一个来源就是加一条记录，不用改别处的分支。
 *
 * 每条来源自己声明默认引擎（`engine`），所以 aria2 只是一个可选项，不是架构前提。
 * 用户可以在设置里覆盖某一类来源用哪个引擎。
 */

const { PROVIDERS, extractShareUrls } = require('./providers');

/**
 * 来源类别的显示名与图标。
 *
 * 四家网盘是四个来源，但属于同一个类别。界面上按类别给一个入口，
 * 免得侧栏排出一串「夸克 / 百度 / UC / 迅雷」按钮。
 *
 * 图标也住在这里。注册表之外的界面不该再有一张来源对照表。
 */
const KIND_LABELS = {
  netdisk: '网盘',
  media: '媒体',
  direct: '直链',
};

const KIND_ICONS = {
  netdisk: 'cloud',
  media: 'video',
  direct: 'link',
};

/**
 * @typedef {object} SourceSpec
 * @property {string} id
 * @property {string} label
 * @property {'netdisk' | 'media' | 'direct'} kind
 * @property {import('./protocol').EngineId} engine  这一类来源默认用哪个引擎
 * @property {import('./protocol').EngineId[]} engines  这一类来源真正能用的引擎
 * @property {(url: URL) => boolean} matches
 * @property {(url: URL) => { target: string, passcode?: string | null } | null} parse
 * @property {{ grade: string, note: string }} capability  设置页显示的能力等级
 * @property {boolean} [experimental]  驱动失手时降级成人工窗口，而不是「上游改版」
 * @property {string} color  来源色点
 * @property {string} desc  来源页上的一句话说明
 * @property {'cookie' | 'window'} [loginKind]  网盘怎么登录
 * @property {import('./providers').Provider} [netdisk]  网盘专属配方
 */

/** 媒体扩展名。带这些扩展名的地址交给 yt-dlp，它知道怎么拼文件名。 */
const MEDIA_EXT = /\.(mkv|mp4|webm|mov|avi|flv|m4v|m3u8|mpd|ts|m4a|mp3|flac|wav|opus|aac|ogg|oga|wma|wav|flac|mka)$/i;

/** 直链扩展名。带这些扩展名的地址直接用 aria2 搬，省掉 yt-dlp 的一次解析。 */
const DIRECT_EXT =
  /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|iso|dmg|pdf|epub|apk|exe|msi|deb|rpm|docx?|xlsx?|pptx?|csv|txt|json|xml|html?|css|js|mjs|cjs|ts|tsx|py|go|rs|java|jar|class|bin|img|iso|ova|ovf|vmdk|sav|txt)$/i;

/**
 * 百度写「提取码: c81v」，夸克写「提取码：c81v」。
 * @type {RegExp}
 */
const PASSCODE_LABEL = /(?:提取码|密码|访问码|pwd|passcode)\s*[:：=]?\s*([A-Za-z0-9]{4,12})/i;

/**
 * @param {string} value
 * @returns {string | null}
 */
function readPasscode(value) {
  if (typeof value !== 'string') return null;
  const match = PASSCODE_LABEL.exec(value);
  return match ? match[1] : null;
}

/**
 * 网盘来源。取链配方照旧住在 providers.js，这里只负责身份。
 *
 * @type {SourceSpec}
 */
function netdiskSpec(provider) {
  return {
    id: provider.id,
    label: provider.label,
    kind: 'netdisk',
    // 网盘的直链靠 aria2 才划算：多线程分片，cookie 也能带。
    engine: 'aria2',
    // yt-dlp 只会按普通网页解析一个分享页，拿不到网盘那条取链流程。
    engines: ['aria2'],
    matches: (url) => provider.matches(url),
    parse: (url) => {
      const shareId = provider.parseShareId(url);
      return shareId ? { target: shareId } : null;
    },
    capability: provider.capability || { grade: '未记录', note: '' },
    ...(provider.experimental ? { experimental: true } : {}),
    color: provider.color || '#94a3b8',
    desc: provider.desc || '',
    badges: provider.badges || [],
    ...(provider.loginKind ? { loginKind: provider.loginKind } : {}),
    netdisk: provider,
  };
}

/**
 * 媒体来源。一个视频网站页面，交给 yt-dlp 解析、下载、后处理。
 *
 * @type {SourceSpec}
 */
const MEDIA_SOURCE = {
  id: 'media',
  label: '媒体',
  kind: 'media',
  // 后处理（音视频合并、提取音频、嵌封面）只在 yt-dlp 的进程里成立。
  engine: 'yt-dlp',
  // aria2 不会解析页面，给它一个视频站地址只会拿到一个空的任务。
  engines: ['yt-dlp'],
  matches: (url) => {
    if (DIRECT_EXT.test(url.pathname)) return false;
    return true;
  },
  parse: (url) => ({ target: url.href }),
  capability: { grade: '解析 + 下载 + 后处理', note: '需要 yt-dlp' },
  color: '#ec4899',
  desc: '视频网站页面 · 内置 yt-dlp 解析下载 · 音视频合并与音频提取',
};

/**
 * 直链来源。一个普通的文件地址，用 aria2 搬最省事。
 *
 * @type {SourceSpec}
 */
const DIRECT_SOURCE = {
  id: 'direct',
  label: '直链',
  kind: 'direct',
  engine: 'aria2',
  // 一个普通文件地址，两个引擎都吃得下。aria2 更快，yt-dlp 更省事。
  engines: ['aria2', 'yt-dlp'],
  matches: (url) => DIRECT_EXT.test(url.pathname),
  parse: (url) => ({ target: url.href }),
  capability: { grade: '直接下载', note: '多线程' },
  color: '#64748b',
  desc: '普通文件地址 · 交给 aria2 多线程下载 · 支持断点续传',
};

/**
 * 判定顺序有意义。网盘最具体，先判；媒体次之（它的判定最宽）；直链最后。
 *
 * @type {SourceSpec[]}
 */
const SOURCES = [
  ...Object.values(PROVIDERS).map(netdiskSpec),
  MEDIA_SOURCE,
  DIRECT_SOURCE,
];

/**
 * @param {string} id
 * @returns {SourceSpec | null}
 */
function getSource(id) {
  return SOURCES.find((spec) => spec.id === id) ?? null;
}

/**
 * 认一条链接。认不出来返回 null，绝不给半个对象。
 *
 * @param {string} candidate
 * @param {string} text  整段粘贴，用来捞写在链接旁边的提取码
 * @returns {import('./protocol').Source | null}
 */
function buildSource(candidate, text = '') {
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  for (const spec of SOURCES) {
    if (!spec.matches(url)) continue;
    const parsed = spec.parse(url);
    if (!parsed) continue;

    if (spec.kind === 'netdisk') {
      const provider = spec.netdisk;
      const passcode = url.searchParams.get('pwd') || readPasscode(text) || null;
      if (passcode && provider.passcodeParam) {
        url.searchParams.set(provider.passcodeParam, passcode);
      }
      return {
        kind: 'netdisk',
        raw: url.href,
        provider: provider.id,
        shareId: parsed.target,
        passcode,
      };
    }

    return {
      kind: spec.kind,
      raw: url.href,
      url: parsed.target,
    };
  }

  return null;
}

/**
 * 同一来源的同一份东西。已经处理中的重复提交要认出来。
 *
 * @param {import('./protocol').Source} source
 * @returns {string}
 */
function sourceKey(source) {
  if (!source) return '';
  if (source.kind === 'netdisk') return `netdisk:${source.provider}:${source.shareId}`;
  return `${source.kind}:${source.url || source.raw}`;
}

/**
 * 认一段粘贴里的所有链接。认不出来的那条直接丢掉，调用方按条报错。
 *
 * @param {string} text
 * @returns {import('./protocol').Source[]}
 */
function parseSources(text) {
  const sources = [];
  const seen = new Set();
  for (const candidate of extractShareUrls(text)) {
    const source = buildSource(candidate, text);
    if (!source) continue;
    const key = sourceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(source);
  }
  return sources;
}

/**
 * 读回来的记录不一定有 `kind`。老记录只有网盘那四个字段，一律当网盘看。
 *
 * @param {any} link
 * @returns {import('./protocol').Source | null}
 */
function normalizeSource(link) {
  if (!link || typeof link !== 'object') return null;
  if (link.kind === 'media' || link.kind === 'direct') {
    if (!link.url) return null;
    return { kind: link.kind, raw: link.raw || link.url, url: link.url };
  }
  if (link.provider && link.shareId) {
    return {
      kind: 'netdisk',
      raw: link.raw || '',
      provider: link.provider,
      shareId: link.shareId,
      passcode: link.passcode ?? null,
    };
  }
  return null;
}

/**
 * 给渲染进程看的来源视图。只带能序列化的字段。
 *
 * @returns {Array<{ id: string, label: string, kind: string, kindLabel: string,
 *   kindIcon: string, engine: string, engines: string[],
 *   capability: { grade: string, note: string },
 *   experimental: boolean, color: string, desc: string, loginKind: string | null }>}
 */
function sourceViews() {
  return SOURCES.map((spec) => ({
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    kindLabel: KIND_LABELS[spec.kind] || spec.label,
    kindIcon: KIND_ICONS[spec.kind] || 'link',
    engine: spec.engine,
    engines: spec.engines || [spec.engine],
    capability: spec.capability,
    experimental: Boolean(spec.experimental),
    color: spec.color,
    desc: spec.desc,
    badges: spec.badges || [],
    loginKind: spec.loginKind ?? null,
  }));
}

module.exports = {
  SOURCES,
  MEDIA_SOURCE,
  DIRECT_SOURCE,
  KIND_LABELS,
  KIND_ICONS,
  getSource,
  buildSource,
  parseSources,
  normalizeSource,
  sourceKey,
  sourceViews,
  readPasscode,
  MEDIA_EXT,
  DIRECT_EXT,
};
