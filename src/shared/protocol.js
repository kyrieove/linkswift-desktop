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
 * @typedef {'quark' | 'baidu' | 'uc' | 'xunlei'} ProviderId
 * @typedef {'aria2' | 'clipboard' | 'browser'} DeliveryTarget
 * @typedef {'login' | 'passcode' | 'captcha' | 'unknown-page' | 'manual' | 'transfer'} HumanReason
 * @typedef {'upstream-redesigned' | 'unsupported-provider' | 'network' | 'delivery' | 'timeout' | 'cancelled' | 'no-files' | 'chrome-not-found' | 'link-invalid' | 'file-missing' | 'passcode-wrong' | 'needs-transfer' | 'rate-limited' | 'extract-failed' | 'link-expired' | 'aria2-down'} FailureCode
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
 * @property {'builtin' | 'external'} aria2Mode  builtin runs the bundled aria2
 * @property {boolean} allowTransfer  Lets the baidu flow write into the user's drive
 * @property {boolean} autoSubmit     提交前不再等一次点击：粘贴到分享文案就开跑
 * @property {number} archiveLimit    How many jobs the main list keeps; older ones are archived
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
 * @typedef {object} DownloadProgress
 * @property {string} gid
 * @property {string} name
 * @property {'waiting' | 'active' | 'complete' | 'error' | string} status
 * @property {number} totalLength      Total length in bytes
 * @property {number} completedLength  Completed length in bytes
 * @property {number} downloadSpeed    Bytes per second
 * @property {number} connections      Active connections
 * @property {string | null} [errorCode]
 * @property {string | null} [errorMessage]
 */

/**
 * The job state machine. Illegal states are not representable: a job carries
 * files only once they exist, and a reason only in `needs-human`.
 *
 * `linked` is the moment the direct links are in hand and delivery has not
 * finished yet. It exists so the UI can tell "拿到链接" apart from "下载完成":
 * clipboard and browser delivery never reach `downloading`.
 *
 * @typedef {{ phase: 'loading' }
 *   | { phase: 'needs-human', reason: HumanReason }
 *   | { phase: 'extracting' }
 *   | { phase: 'linked', files: ExtractedFile[] }
 *   | { phase: 'delivering', files: ExtractedFile[] }
 *   | { phase: 'downloading', files: ExtractedFile[], progress: DownloadProgress[] }
 *   | { phase: 'paused', files: ExtractedFile[], progress: DownloadProgress[] }
 *   | { phase: 'done', files: ExtractedFile[], progress?: DownloadProgress[] }
 *   | { phase: 'failed', code: FailureCode, message: string, detail?: string, files?: ExtractedFile[], progress?: DownloadProgress[],
 *       step?: number, verb?: string, selector?: string, hint?: string }} JobPhase
 *
 * `step`, `verb` and `selector` are the driver's own failure report, kept so the
 * UI can say which step of the page script broke instead of only "上游改版".
 * `hint` is the one Chinese sentence built from them.
 */

/**
 * The outcome of one real job for one netdisk, as the settings page shows it.
 * Only what actually happened on this machine: never a guess at what the
 * provider might support.
 *
 * @typedef {object} ProviderHealth
 * @property {ProviderId} provider
 * @property {number} at        When it happened
 * @property {boolean} ok       Whether a link was extracted and delivered
 * @property {FailureCode} [code]  Present only when ok is false
 * @property {string} [hint]    One sentence, present only when ok is false
 */

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {ShareLink} link
 * @property {JobPhase} state
 * @property {number} createdAt
 * @property {boolean} [restored]  Rebuilt from disk after a restart
 * @property {boolean} [stalled]   Downloading with no byte growth for 60s
 * @property {string} [scriptVersion]  Userscript version this job ran on
 * @property {'upstream' | 'cache' | 'bundled'} [scriptOrigin]  Where it came from
 * @property {number} [archivedAt]  User archived it; it left the main list
 */

/**
 * Renderer to main, over ipcRenderer.invoke.
 */
const INVOKE = {
  submit: 'linkswift:submit',
  cancel: 'linkswift:cancel',
  pause: 'linkswift:pause',
  resume: 'linkswift:resume',
  retry: 'linkswift:retry',
  listJobs: 'linkswift:jobs:list',
  getSettings: 'linkswift:settings:get',
  setSettings: 'linkswift:settings:set',
  revealWindow: 'linkswift:window:reveal',
  login: 'linkswift:login',
  continueAfterLogin: 'linkswift:login:continue',
  testAria2: 'linkswift:aria2:test',
  aria2Status: 'linkswift:aria2:status',
  restartAria2: 'linkswift:aria2:restart',
  openDownloadDir: 'linkswift:downloads:open',
  chooseDirectory: 'linkswift:directory:choose',
  archiveJobs: 'linkswift:jobs:archive',
  unarchiveJobs: 'linkswift:jobs:unarchive',
  purgeJobs: 'linkswift:jobs:purge',
  providerHealth: 'linkswift:provider:health',
};

/**
 * Main to renderer, over webContents.send.
 *
 * `jobEvent` carries a whole `Job` as its only argument, never an envelope
 * around one. Every phase change sends the full replacement, so the renderer
 * keeps no state of its own beyond the list of jobs it has seen.
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
