'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Persisted state, in two separate files on purpose.
 *
 *   settings.json    what the user configured in the UI.
 *   gm-values.json   the userscript's own GM_getValue store. It holds netdisk
 *                    login tokens, so it stays inside app.getPath('userData')
 *                    and is never written next to the executable.
 *
 * @typedef {import('../shared/protocol').Settings} Settings
 */

/** @type {Settings} */
const DEFAULT_SETTINGS = {
  delivery: 'aria2',
  // The app ships aria2 and starts it itself; a user who already runs one can
  // point the app at that instead.
  aria2Mode: 'builtin',
  aria2: {
    domain: 'http://localhost',
    port: '6800',
    path: '/jsonrpc',
    token: '',
    dir: '',
  },
  allowTransfer: false,
  autoSubmit: false,
  // How many jobs the main list keeps; older ones move to jobs-archive.jsonl.
  archiveLimit: 500,
};

/** Bounds for `archiveLimit`, so a hand-edited settings file cannot freeze the list. */
const ARCHIVE_LIMIT_MIN = 100;
const ARCHIVE_LIMIT_MAX = 2000;

/** Explicit allowlist of audited, non-sensitive global configuration keys */
const GLOBAL_ALLOWED_KEYS = new Set([
  'setting_init',
  'setting_aria2_rpc',
  'setting_ui_theme',
  'setting_theme_color',
  'setting_config_version',
  'setting_curl_terminal',
]);

const SENSITIVE_PATTERNS = [
  'token',
  'auth',
  'pass',
  'secret',
  'cookie',
  'session',
  'credential',
  'key',
];

function isSensitiveKey(key) {
  const lower = key.toLowerCase();
  return SENSITIVE_PATTERNS.some((pattern) => lower.includes(pattern));
}

function isGlobalKey(key) {
  if (isSensitiveKey(key)) return false;
  return GLOBAL_ALLOWED_KEYS.has(key);
}

function isProviderKey(key, providerId) {
  if (!providerId) return false;
  const p = providerId.toLowerCase();
  const lower = key.toLowerCase();
  return (
    lower.startsWith(`${p}_`) ||
    lower.startsWith(`${p}:`) ||
    lower.startsWith(`${p}.`) ||
    lower.includes(`_${p}_`) ||
    lower.startsWith(`theme_${p}`)
  );
}

/** @param {unknown} value */
function clampArchiveLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < ARCHIVE_LIMIT_MIN || number > ARCHIVE_LIMIT_MAX) {
    return DEFAULT_SETTINGS.archiveLimit;
  }
  return Math.floor(number);
}

/**
 * @param {string} file
 * @param {unknown} fallback
 */
function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`[store] cannot read ${file}: ${error.message}`);
    }
    return fallback;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    console.error(`[store] ${file} is not an object, ignoring it`);
  } catch (error) {
    console.error(`[store] ${file} is not valid JSON: ${error.message}`);
  }
  return fallback;
}

/**
 * Write through a temporary file so a crash mid-write cannot truncate the store.
 * @param {string} file
 * @param {unknown} value
 */
function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

class Store {
  /** @param {string} userDataDir */
  constructor(userDataDir) {
    this.settingsFile = path.join(userDataDir, 'settings.json');
    this.valuesFile = path.join(userDataDir, 'gm-values.json');

    fs.mkdirSync(userDataDir, { recursive: true });

    this.settings = { ...DEFAULT_SETTINGS, ...readJson(this.settingsFile, {}) };
    this.settings.aria2 = { ...DEFAULT_SETTINGS.aria2, ...this.settings.aria2 };
    this.settings.archiveLimit = clampArchiveLimit(this.settings.archiveLimit);

    /** @type {Record<string, unknown>} */
    this.values = readJson(this.valuesFile, {});
  }

  /** @returns {Settings} */
  getSettings() {
    return JSON.parse(JSON.stringify(this.settings));
  }

  /**
   * @param {Partial<Settings>} patch
   * @returns {Settings}
   */
  setSettings(patch) {
    this.settings = {
      ...this.settings,
      ...patch,
      aria2: { ...this.settings.aria2, ...(patch.aria2 ?? {}) },
      archiveLimit: clampArchiveLimit(patch.archiveLimit ?? this.settings.archiveLimit),
    };
    writeJson(this.settingsFile, this.settings);
    return this.getSettings();
  }

  /** @param {string} key */
  getValue(key) {
    return this.values[key];
  }

  /**
   * Return a snapshot of GM values strictly scoped to the specified provider.
   *
   * Only non-sensitive global settings and provider-specific keys are returned.
   * Credentials from other providers are never exposed.
   *
   * @param {string} [providerId]
   * @returns {Record<string, unknown>}
   */
  getScopedValues(providerId) {
    const scoped = {};
    for (const [key, value] of Object.entries(this.values)) {
      if (isGlobalKey(key)) {
        scoped[key] = value;
      } else if (providerId && isProviderKey(key, providerId)) {
        scoped[key] = value;
      }
    }
    return JSON.parse(JSON.stringify(scoped));
  }

  /**
   * Synchronous on purpose. The userscript writes a token and then reloads or
   * navigates, and the next page has to read the value back.
   * @param {string} key
   * @param {unknown} value
   */
  setValue(key, value) {
    this.values[key] = value;
    writeJson(this.valuesFile, this.values);
  }

  /** @param {string} key */
  deleteValue(key) {
    delete this.values[key];
    writeJson(this.valuesFile, this.values);
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
