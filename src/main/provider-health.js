'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * The last real outcome per netdisk, for the settings page.
 *
 * One row per provider, written only when a job actually reaches a terminal
 * phase. Nothing here is a capability claim and nothing here is a credential:
 * a provider, a timestamp, whether it worked, and on failure the code and the
 * one sentence the UI already shows.
 *
 * @typedef {import('../shared/protocol').ProviderHealth} ProviderHealth
 */

class ProviderHealthStore {
  /** @param {string} userDataDir */
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'provider-health.json');
    /** @type {Record<string, ProviderHealth>} */
    this.entries = this.read();
  }

  /** @param {ProviderHealth} outcome */
  record(outcome) {
    if (!outcome || typeof outcome.provider !== 'string' || !outcome.provider) return;
    const entry = { provider: outcome.provider, at: Number(outcome.at) || Date.now(), ok: Boolean(outcome.ok) };
    if (!entry.ok) {
      if (outcome.code) entry.code = outcome.code;
      if (outcome.hint) entry.hint = outcome.hint;
    }
    this.entries[entry.provider] = entry;
    this.write();
  }

  /**
   * Four rows, always, so the settings page has no "missing row" case to render.
   * @param {string[]} providers
   * @returns {Array<ProviderHealth & { verified: boolean }>}
   */
  view(providers) {
    return providers.map((provider) => {
      const entry = this.entries[provider];
      return entry ? { ...entry, verified: true } : { provider, at: 0, ok: false, verified: false };
    });
  }

  /** @returns {ProviderHealth[]} */
  all() {
    return Object.values(this.entries);
  }

  write() {
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.entries, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error(`[health] cannot write ${this.file}: ${error.message}`);
    }
  }

  /** A broken file means "nothing verified yet", never an invented result. */
  read() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`[health] cannot read ${this.file}: ${error.message}`);
      return {};
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      console.error(`[health] ${this.file} is not an object, treating every provider as unverified`);
    } catch (error) {
      console.error(`[health] ${this.file} is not valid JSON: ${error.message}`);
    }
    return {};
  }
}

module.exports = { ProviderHealthStore };
