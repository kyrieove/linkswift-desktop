'use strict';

/**
 * Per-netdisk knowledge: how to read a share link, and how to drive the page
 * until the userscript extracts links.
 *
 * Everything provider-specific lives in this one table. Adding a netdisk means
 * adding one entry, not branching somewhere in the job runner.
 *
 * @typedef {{ do: 'wait-for', selector: Selector, timeoutMs: number }
 *   | { do: 'click', selector: Selector, optional?: boolean }
 *   | { do: 'click-all', selector: Selector, optional?: boolean }
 *   | { do: 'click-text', text: string | string[], optional?: boolean, timeoutMs?: number }
 *   | { do: 'ensure-selection', selected: Selector, unselected: Selector, optional?: boolean }
 *   | { do: 'enter-folders', rowName: Selector, timeoutMs: number, maxDepth?: number }
 *   | { do: 'ensure-anchor', ancestor: string, addClass: string, create: string }
 *   | { do: 'fill', selector: Selector, value: string, optional?: boolean }
 *   | { do: 'sleep', ms: number }} Step
 *
 * @typedef {string | string[]} Selector  Candidates, tried in order
 */

/**
 * @typedef {object} Provider
 * @property {string} id
 * @property {string} label
 * @property {(url: URL) => boolean} matches
 * @property {(url: URL) => string | null} parseShareId
 * @property {string} pageAnchor  Where the userscript injects its own button
 * @property {string | null} passcodeParam  Query parameter that unlocks the share, if any
 * @property {Step[]} steps
 * @property {Step[]} [transferSteps]  Run when the share refuses a large file
 * @property {string} [driveUrl]  The account's own drive, for the post-transfer step
 * @property {'cookie' | 'window'} [loginKind]  How this provider authenticates
 * @property {string} [loginUrl]  Where a window-login provider signs in
 * @property {boolean} [experimental]  A driver miss degrades to a manual window
 */

/**
 * The script's own push button inside its result dialog. A share with more than
 * one file also renders a "全部推送" button that pushes every file; it must win,
 * or a folder downloads only the file whose row button the driver clicked.
 *
 * The pushes are serialized by the script one file at a time, so the trailing
 * sleep keeps the page alive until the last one reaches the app.
 */
const SEND_STEPS = [
  {
    do: 'wait-for',
    selector: ['button[action="all"][type="sendto.aria2"]', 'button[action="sendto"][type="aria2"]'],
    timeoutMs: 60000,
  },
  {
    do: 'click',
    selector: ['button[action="all"][type="sendto.aria2"]', 'button[action="sendto"][type="aria2"]'],
  },
  { do: 'sleep', ms: 2000 },
];

/** @type {Step[]} */
const QUARK_STEPS = [
  // The script's own menu entry. Its presence proves the script booted and that
  // detectPage() has already run for the share page.
  { do: 'wait-for', selector: '.pl-button-mode[data-mode="aria2"]', timeoutMs: 30000 },
  // A passcode box, on the shares that need one. A share link without a pwd= has
  // none, and the step is optional so that is not a failure.
  {
    do: 'fill',
    selector: ['.share-password input', 'input[placeholder*="密码"]', 'input[placeholder*="提取码"]'],
    value: '{passcode}',
    optional: true,
  },
  { do: 'sleep', ms: 800 },
  // A share can point at a folder rather than a file. The userscript refuses to
  // extract while the selection holds a folder, so descend until files are on
  // screen. Verified on a live page: a share whose top row is a folder needs this.
  {
    do: 'enter-folders',
    rowName: ['.ant-table-row .filename-text', '.ant-table-row [class*="filename-text"]'],
    timeoutMs: 20000,
  },
  // A share page arrives with its files already selected, verified on a live page.
  // Only touch the checkboxes when nothing is selected, or the click would
  // deselect what the page chose.
  {
    do: 'ensure-selection',
    selected: ['.file-list .ant-checkbox-wrapper-checked', '.file-list .ant-table-row-selected'],
    // The header box selects every row. Prefer it, and fall back to the rows.
    unselected: [
      '.file-list .ant-table-thead .ant-checkbox-wrapper',
      '.file-list .ant-table-row .ant-checkbox-wrapper:not(.ant-checkbox-wrapper-checked)',
    ],
  },
  { do: 'sleep', ms: 500 },
  { do: 'click', selector: '.pl-button-mode[data-mode="aria2"]' },
  // The script then fetches the link and shows a dialog; its push button is what
  // sends aria2.addUri, which the app intercepts.
  ...SEND_STEPS,
];

/** @type {Step[]} */
const BAIDU_STEPS = [
  // Current share pages expose .x-button-box but no longer expose the nested
  // toolbar classes the upstream userscript watches. Restore that mount point.
  {
    do: 'ensure-anchor',
    ancestor: '.x-button-box',
    addClass: 'module-share-top-bar',
    create: '<div class="g-dropdown-button tools-more"></div>',
    timeoutMs: 30000,
  },
  { do: 'wait-for', selector: '.pl-button-mode[data-mode="aria2"]', timeoutMs: 30000 },
  {
    do: 'fill',
    selector: ['input#accessCode', 'input[placeholder*="提取码"]', 'input[placeholder*="密码"]'],
    value: '{passcode}',
    optional: true,
  },
  { do: 'sleep', ms: 800 },
  // A single-file baidu share renders no checkbox list at all, so a missing list
  // is normal here and the selection step must not fail on it.
  {
    do: 'ensure-selection',
    selected: ['.file-list .checkbox-wrapper.checked', '.file-list .wp-s-file-checked'],
    unselected: [
      '.file-list .wp-s-core-pan .file-list-header input[type="checkbox"]',
      '.file-list .checkbox-wrapper:not(.checked)',
      '.file-list input[type="checkbox"]:not(:checked)',
    ],
    optional: true,
  },
  { do: 'sleep', ms: 500 },
  { do: 'click', selector: '.pl-button-mode[data-mode="aria2"]' },
  ...SEND_STEPS,
];

/**
 * Baidu refuses a direct link for a share file over 50MB. Saving it into the
 * user's own drive is the only way through, and the save dialog is page UI with
 * no stable class, so find its buttons by their words.
 *
 * @type {Step[]}
 */
const BAIDU_TRANSFER_STEPS = [
  { do: 'click-text', text: ['保存到网盘', '保存到我的网盘'], timeoutMs: 20000 },
  { do: 'sleep', ms: 1000 },
  { do: 'click-text', text: ['确定', '确认'], optional: true, timeoutMs: 5000 },
  // The upload progress is server-side; there is no event for it. The drive
  // page below shows the file only after this window has passed.
  { do: 'sleep', ms: 4000 },
];

/** UC shares the PC client's markup with quark, so the steps are the same shape. */
const UC_STEPS = [
  { do: 'wait-for', selector: '.pl-button-mode[data-mode="aria2"]', timeoutMs: 30000 },
  {
    do: 'fill',
    selector: ['input[placeholder*="提取码"]', 'input[placeholder*="密码"]', '.share-password input'],
    value: '{passcode}',
    optional: true,
  },
  { do: 'sleep', ms: 800 },
  {
    do: 'enter-folders',
    rowName: ['.ant-table-row .filename-text', '.ant-table-row [class*="filename-text"]'],
    timeoutMs: 20000,
    optional: true,
  },
  {
    do: 'ensure-selection',
    selected: ['.file-list .ant-checkbox-wrapper-checked', '.file-list .ant-table-row-selected'],
    unselected: [
      '.file-list .ant-table-thead .ant-checkbox-wrapper',
      '.file-list .ant-table-row .ant-checkbox-wrapper:not(.ant-checkbox-wrapper-checked)',
    ],
    optional: true,
  },
  { do: 'sleep', ms: 500 },
  { do: 'click', selector: '.pl-button-mode[data-mode="aria2"]' },
  ...SEND_STEPS,
];

/** 迅雷's share list is Vue, and it has no folder descent the script can follow. */
const XUNLEI_STEPS = [
  { do: 'wait-for', selector: '.pl-button-mode[data-mode="aria2"]', timeoutMs: 30000 },
  {
    do: 'fill',
    selector: ['input[placeholder*="提取码"]', 'input[placeholder*="密码"]'],
    value: '{passcode}',
    optional: true,
  },
  { do: 'sleep', ms: 800 },
  {
    do: 'ensure-selection',
    selected: ['[class*="SourceListItem__item--"][class*="selected"]', '[class*="selected--"]'],
    unselected: [
      '[class*="SourceListItem__checkbox"]',
      '[class*="Share__batchActionBox--"] [type="checkbox"]:not(:checked)',
    ],
    optional: true,
  },
  { do: 'sleep', ms: 500 },
  { do: 'click', selector: '.pl-button-mode[data-mode="aria2"]' },
  ...SEND_STEPS,
];

/** @type {Record<string, Provider>} */
const PROVIDERS = {
  quark: {
    id: 'quark',
    label: '夸克网盘',
    matches: (url) => /(^|\.)quark\.cn$/.test(url.hostname),
    parseShareId: (url) => url.pathname.match(/^\/(?:s|share)\/([A-Za-z0-9]+)/)?.[1] ?? null,
    pageAnchor: '.share-btns',
    passcodeParam: null,
    loginKind: 'cookie',
    driveUrl: 'https://pan.quark.cn/list',
    steps: QUARK_STEPS,
  },
  baidu: {
    id: 'baidu',
    label: '百度网盘',
    matches: (url) => /(^|\.)baidu\.com$/.test(url.hostname),
    parseShareId: (url) =>
      url.pathname.match(/^\/s\/1?([A-Za-z0-9_-]+)/)?.[1] ?? url.searchParams.get('surl') ?? null,
    pageAnchor: '.module-share-top-bar .x-button-box .g-dropdown-button.tools-more',
    // A share page unlocks itself from ?pwd=, which is how a code gets past the
    // code screen without the driver having to click its submit button.
    passcodeParam: 'pwd',
    loginKind: 'cookie',
    driveUrl: 'https://pan.baidu.com/disk/main#/index?category=all',
    transferSteps: BAIDU_TRANSFER_STEPS,
    steps: BAIDU_STEPS,
  },
  uc: {
    id: 'uc',
    label: 'UC 网盘',
    matches: (url) => /(^|\.)uc\.cn$/.test(url.hostname),
    parseShareId: (url) => url.pathname.match(/^\/(?:s|share)\/([A-Za-z0-9]+)/)?.[1] ?? null,
    pageAnchor: '.file-info-share-buttom',
    passcodeParam: 'pwd',
    loginKind: 'cookie',
    driveUrl: 'https://drive.uc.cn/list',
    // Selectors are transcribed from the script's own mount table; no live share
    // page has been driven yet, so a miss falls back to the manual window.
    experimental: true,
    steps: UC_STEPS,
  },
  xunlei: {
    id: 'xunlei',
    label: '迅雷云盘',
    matches: (url) => /(^|\.)xunlei\.com$/.test(url.hostname),
    parseShareId: (url) => url.pathname.match(/^\/(?:s|share)\/([A-Za-z0-9_-]+)/)?.[1] ?? null,
    pageAnchor: '[class^="Share__batchActionBox--"]',
    passcodeParam: 'pwd',
    // 迅雷 keeps its credentials in localStorage, not in a cookie, so the Chrome
    // cookie import cannot carry a login over; the app's own window has to own it.
    loginKind: 'window',
    loginUrl: 'https://pan.xunlei.com/',
    driveUrl: 'https://pan.xunlei.com/?folderId=',
    experimental: true,
    steps: XUNLEI_STEPS,
  },
};


/**
 * What Baidu and Quark copy to the clipboard is a sentence, and a single-line
 * input strips its newlines, so the URL arrives glued to the words around it.
 * Take the URL out by RFC 3986's own character set: it stops at the first
 * Chinese character, and at the space that follows "链接:".
 */
const URL_CHARS = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
/** Baidu writes "提取码: c81v", Quark "提取码：c81v". */
const PASSCODE_LABEL = /(?:提取码|密码|访问码|pwd|passcode)\s*[:：=]?\s*([A-Za-z0-9]{4,12})/i;

/**
 * @param {string} text
 * @returns {string | null}
 */
function extractShareUrl(text) {
  const start = text.search(/https?:\/\//i);
  if (start < 0) return null;

  let end = start;
  while (end < text.length && URL_CHARS.test(text[end])) end += 1;
  return text.slice(start, end).replace(TRAILING_PUNCTUATION, '');
}

/**
 * Parse a pasted share link at the boundary. Anything unrecognised returns null
 * rather than a half-filled object.
 *
 * @param {string} raw  A bare link, or the whole share text netdisks copy
 * @returns {import('./protocol').ShareLink | null}
 */
function parseShareLink(raw) {
  const text = String(raw ?? '');
  const candidate = extractShareUrl(text);
  if (!candidate) return null;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  const provider = Object.values(PROVIDERS).find((p) => p.matches(url));
  if (!provider) return null;

  const shareId = provider.parseShareId(url);
  if (!shareId) return null;

  const passcode = url.searchParams.get('pwd') || PASSCODE_LABEL.exec(text)?.[1] || null;
  if (passcode && provider.passcodeParam) {
    url.searchParams.set(provider.passcodeParam, passcode);
  }

  return {
    raw: url.href,
    provider: provider.id,
    shareId,
    passcode,
  };
}

/**
 * @param {string} id
 * @returns {Provider | null}
 */
function getProvider(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : null;
}

module.exports = { PROVIDERS, parseShareLink, getProvider };
