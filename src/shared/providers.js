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
 * @property {Step[]} steps
 */

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
];

/** @type {Step[]} */
const BAIDU_STEPS = [
  // Current share pages expose .x-button-box but no longer expose the nested
  // toolbar classes the upstream userscript watches. Restore that mount point.
  { do: 'ensure-anchor', ancestor: '.x-button-box', addClass: 'module-share-top-bar', create: '<div class="g-dropdown-button tools-more"></div>' },
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
];

/** @type {Record<string, Provider>} */
const PROVIDERS = {
  quark: {
    id: 'quark',
    label: '夸克网盘',
    matches: (url) => /(^|\.)quark\.cn$/.test(url.hostname),
    parseShareId: (url) => url.pathname.match(/^\/(?:s|share)\/([A-Za-z0-9]+)/)?.[1] ?? null,
    pageAnchor: '.share-btns',
    steps: QUARK_STEPS,
  },
  baidu: {
    id: 'baidu',
    label: '百度网盘',
    matches: (url) => /(^|\.)baidu\.com$/.test(url.hostname),
    parseShareId: (url) =>
      url.pathname.match(/^\/s\/1?([A-Za-z0-9_-]+)/)?.[1] ?? url.searchParams.get('surl') ?? null,
    pageAnchor: '.module-share-top-bar .x-button-box .g-dropdown-button.tools-more',
    steps: BAIDU_STEPS,
  },
};

/**
 * Parse a pasted share link at the boundary. Anything unrecognised returns null
 * rather than a half-filled object.
 *
 * @param {string} raw
 * @returns {import('./protocol').ShareLink | null}
 */
function parseShareLink(raw) {
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  const provider = Object.values(PROVIDERS).find((p) => p.matches(url));
  if (!provider) return null;

  const shareId = provider.parseShareId(url);
  if (!shareId) return null;

  return {
    raw: raw.trim(),
    provider: provider.id,
    shareId,
    passcode: url.searchParams.get('pwd') || null,
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
