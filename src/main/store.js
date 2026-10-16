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
  aria2: {
    domain: 'http://localhost',
    port: '6800',
    path: '/jsonrpc',
    token: '',
    dir: '',
  },
  allowTransfer: false,
};

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
    };
    writeJson(this.settingsFile, this.settings);
    return this.getSettings();
  }

  /** @param {string} key */
  getValue(key) {
    return this.values[key];
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
