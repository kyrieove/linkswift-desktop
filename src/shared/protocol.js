'use strict';

/**
 * The contract between the three actors: the renderer UI, the main process, and
 * the preload that lives in the hidden netdisk window.
 *
 * Naming rules used throughout.
 *   Job          one attempt to turn one pasted share link into direct links.
 *   Phase        the single state a job is in. A job is in exactly one phase.
 *   Observation  something the page reported. The page never commands.
 *   Command      something the host told the page to do.
 *
 * @typedef {'quark' | 'baidu'} ProviderId
 * @typedef {'aria2' | 'clipboard' | 'browser'} DeliveryTarget
 * @typedef {'login' | 'passcode' | 'captcha' | 'unknown-page'} HumanReason
 * @typedef {'upstream-redesigned' | 'unsupported-provider' | 'network' | 'delivery' | 'timeout' | 'cancelled' | 'no-files'} FailureCode
 */

/**
 * @typedef {object} Aria2Config
 * @property {string} domain  Includes the scheme, for example http://localhost
 * @property {string} port
 * @property {string} path    Usually /jsonrpc
 * @property {string} token   Empty when the RPC secret is unset
 * @property {string} dir     Empty means the aria2 default
 */

/**
 * @typedef {object} Settings
 * @property {DeliveryTarget} delivery
 * @property {Aria2Config} aria2
 * @property {boolean} allowTransfer  Lets the baidu flow write into the user's drive
 */

/**
 * @typedef {object} ShareLink
 * @property {string} raw
 * @property {ProviderId} provider
 * @property {string} shareId
 * @property {string | null} passcode
 */

/**
 * @typedef {object} ExtractedFile
 * @property {string} name
 * @property {string} url
 * @property {Record<string, string>} headers  Already split into name/value pairs
 */

/**
 * The job state machine. Illegal states are not representable: a job carries
 * files only in `done`, and a reason only in `needs-human`.
 *
 * @typedef {{ phase: 'loading' }
 *   | { phase: 'needs-human', reason: HumanReason }
 *   | { phase: 'extracting' }
 *   | { phase: 'delivering' }
 *   | { phase: 'done', files: ExtractedFile[] }
 *   | { phase: 'failed', code: FailureCode, message: string, detail?: string }} JobPhase
 */

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {ShareLink} link
 * @property {JobPhase} state
 */

/**
 * Renderer to main, over ipcRenderer.invoke.
 */
const INVOKE = {
  submit: 'linkswift:submit',
  cancel: 'linkswift:cancel',
  getSettings: 'linkswift:settings:get',
  setSettings: 'linkswift:settings:set',
  revealWindow: 'linkswift:window:reveal',
  testAria2: 'linkswift:aria2:test',
};

/**
 * Main to renderer, over webContents.send.
 */
const PUSH = {
  jobEvent: 'linkswift:job:event',
};

/**
 * Preload to main. `boot` is synchronous because GM_getValue, GM_setValue and
 * GM_getResourceText must answer before the userscript body runs.
 */
const INTERNAL = {
  boot: 'linkswift:boot',
  observation: 'linkswift:observation',
  command: 'linkswift:command',
  storageChanged: 'linkswift:storage:changed',
};

/**
 * The envelope that crosses the context-isolation boundary in both directions.
 * Both worlds receive every message, so `from` decides who handles it.
 */
const BRIDGE = {
  marker: '__linkswift__',
  fromPage: 'page',
  fromHost: 'host',
};

/**
 * What the page reports upward. The page never asks the host a question it
 * cannot answer from this list.
 *
 * @typedef {{ kind: 'ready', href: string, provider: ProviderId | null }
 *   | { kind: 'http', id: number, url: string, method: string, body: string | null }
 *   | { kind: 'clipboard', text: string }
 *   | { kind: 'open-tab', url: string }
 *   | { kind: 'storage-set', key: string, value: unknown }
 *   | { kind: 'storage-delete', key: string }
 *   | { kind: 'script-error', message: string, stack: string | null }
 *   | { kind: 'driver-failed', step: string, selector: string | null, detail: string }} Observation
 */

/**
 * What the host sends downward.
 *
 * @typedef {{ kind: 'http-response', id: number, ok: boolean, status: number | null, text: string | null, error: string | null }
 *   | { kind: 'storage-changed', key: string, value: unknown }
 *   | { kind: 'run-driver', provider: ProviderId, passcode: string | null }} Command
 */

/**
 * @param {string} raw
 * @returns {boolean}
 */
function isSupported(raw) {
  return raw.startsWith('http://') || raw.startsWith('https://');
}

module.exports = { INVOKE, PUSH, INTERNAL, BRIDGE, isSupported };
