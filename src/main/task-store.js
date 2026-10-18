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

const MAX_RECORDS = 500;

/** Only settled jobs may be archived or purged; a running one has a window to lose. */
const SETTLED_PHASES = new Set(['done', 'failed']);

class TaskStore {
  /**
   * @param {string} userDataDir
   * @param {{ limit?: number }} [options]  How many records the main list keeps
   */
  constructor(userDataDir, options = {}) {
    this.file = path.join(userDataDir, 'jobs.json');
    this.archiveFile = path.join(userDataDir, 'jobs-archive.jsonl');
    this.limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : MAX_RECORDS;
    /** @type {Array<Record<string, any>>} */
    this.records = this.read();
    this.timer = null;
    this.trim();
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
    else {
      // Keep the archive flag: archive() owns it, and a later persist of the same
      // job must not silently pull it back into the main list.
      if (this.records[index].archivedAt) entry.archivedAt = this.records[index].archivedAt;
      this.records[index] = entry;
    }
    this.records.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
    this.trim();
    this.scheduleWrite();
  }

  /** Mark settled jobs as archived so they leave the main list. @param {string[]} ids */
  archive(ids) {
    let archived = 0;
    for (const record of this.records) {
      if (!ids.includes(record.id) || record.archivedAt) continue;
      const phase = record.state?.phase;
      if (phase !== undefined && !SETTLED_PHASES.has(phase)) continue;
      record.archivedAt = Date.now();
      archived += 1;
    }
    if (archived) this.scheduleWrite();
    return archived;
  }

  /** @param {string[]} ids */
  unarchive(ids) {
    let restored = 0;
    for (const record of this.records) {
      if (!ids.includes(record.id) || !record.archivedAt) continue;
      delete record.archivedAt;
      restored += 1;
    }
    if (restored) this.scheduleWrite();
    return restored;
  }

  /** Delete settled jobs outright. @param {string[]} ids */
  removeMany(ids) {
    const before = this.records.length;
    this.records = this.records.filter((record) => {
      if (!ids.includes(record.id)) return true;
      const phase = record.state?.phase;
      return phase !== undefined && !SETTLED_PHASES.has(phase);
    });
    const removed = before - this.records.length;
    if (removed) this.scheduleWrite();
    return removed;
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

  /**
   * Move everything past the limit into the append-only archive.
   *
   * An append that fails keeps the record in the main file: losing a download
   * history entry is worse than a list that is one row too long.
   * @returns {number} how many records moved
   */
  trim() {
    if (this.records.length <= this.limit) return 0;
    const overflow = this.records.slice(this.limit);
    const moved = [];
    for (const record of overflow) {
      if (this.appendArchive(record)) moved.push(record);
    }
    const movedIds = new Set(moved.map((record) => record.id));
    this.records = this.records.filter((record) => !movedIds.has(record.id));
    if (moved.length) this.scheduleWrite();
    return moved.length;
  }

  /** @param {Record<string, any>} record @returns {boolean} */
  appendArchive(record) {
    try {
      fs.appendFileSync(this.archiveFile, `${JSON.stringify(record)}\n`, 'utf8');
      return true;
    } catch (error) {
      console.error(`[tasks] cannot append to ${this.archiveFile}: ${error.message}`);
      return false;
    }
  }

  /** @returns {Array<Record<string, any>>} the archived records, newest first */
  readArchive() {
    let text;
    try {
      text = fs.readFileSync(this.archiveFile, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`[tasks] cannot read ${this.archiveFile}: ${error.message}`);
      return [];
    }
    const records = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.id) records.push(parsed);
      } catch (error) {
        console.error(`[tasks] skipping a broken archive line: ${error.message}`);
      }
    }
    return records.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
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

module.exports = { TaskStore, MAX_RECORDS };
