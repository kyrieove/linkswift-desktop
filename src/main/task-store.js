'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * The job list as it survives a restart.
 *
 * Only jobs that got as far as a direct link are worth keeping: an extraction
 * that never finished has no window to come back to, and re-running it is the
 * same as pasting the link again. What matters here is the aria2 GID, because
 * that is the handle onto a half-finished file on disk.
 *
 * jobs.json holds netdisk direct links, so it lives in userData next to the GM
 * values and never next to the executable.
 */

const MAX_RECORDS = 40;

class TaskStore {
  /** @param {string} userDataDir */
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'jobs.json');
    /** @type {Array<Record<string, any>>} */
    this.records = this.read();
    this.timer = null;
  }

  /** @returns {Array<Record<string, any>>} newest first */
  all() {
    return this.records.slice();
  }

  /** @param {Record<string, any>} record */
  save(record) {
    const entry = { ...record, updatedAt: Date.now() };
    const index = this.records.findIndex((existing) => existing.id === entry.id);
    if (index === -1) this.records.unshift(entry);
    else this.records[index] = entry;
    this.records = this.records
      .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
      .slice(0, MAX_RECORDS);
    this.scheduleWrite();
  }

  /** @param {string} id */
  remove(id) {
    const before = this.records.length;
    this.records = this.records.filter((record) => record.id !== id);
    if (this.records.length !== before) {
      this.scheduleWrite();
      return true;
    }
    return false;
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.write();
  }

  scheduleWrite() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, 400);
  }

  write() {
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error(`[tasks] cannot write ${this.file}: ${error.message}`);
    }
  }

  /** @returns {Array<Record<string, any>>} */
  read() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`[tasks] cannot read ${this.file}: ${error.message}`);
      return [];
    }
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.filter((record) => record && record.id) : [];
    } catch (error) {
      console.error(`[tasks] ${this.file} is not valid JSON: ${error.message}`);
      return [];
    }
  }
}

module.exports = { TaskStore };
