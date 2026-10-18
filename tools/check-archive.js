'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TaskStore, MAX_RECORDS } = require('../src/main/task-store');

/**
 * The job list on disk: it survives restarts, and it survives being long.
 *
 * No Electron and no network. Every case is a rule that used to lose data (the
 * list was hard-truncated at 40 records) or a rule the archive feature adds.
 */

/** @param {(store: TaskStore, dir: string) => void} body */
function withStore(body, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-archive-'));
  try {
    body(new TaskStore(dir, options), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {number} index @param {Partial<Record<string, any>>} [overrides] */
function record(index, overrides = {}) {
  return {
    id: `job-${index}`,
    createdAt: 1_000_000 + index,
    link: { raw: `https://pan.quark.cn/s/a${index}`, provider: 'quark', shareId: `a${index}`, passcode: null },
    files: [{ name: `file-${index}.bin`, url: 'https://example.invalid/x', headers: {} }],
    gids: [{ file: 0, gid: `gid-${index}` }],
    state: { phase: 'done', files: [{ name: `file-${index}.bin`, url: 'https://example.invalid/x', headers: {} }] },
    ...overrides,
  };
}

let passed = 0;
function check(name, body) {
  body();
  passed += 1;
  console.log(`  ok  ${name}`);
}

console.log('check:archive');

check('default limit keeps its own constant', () => {
  assert.strictEqual(MAX_RECORDS, 500, 'MAX_RECORDS must be 500');
});

check('501 records leave 500 in jobs.json and exactly 1 in the archive', () => {
  withStore((store, dir) => {
    for (let index = 0; index < 501; index += 1) store.save(record(index));
    store.flush();

    const main = JSON.parse(fs.readFileSync(path.join(dir, 'jobs.json'), 'utf8'));
    assert.strictEqual(main.length, 500, `jobs.json should hold 500 records, holds ${main.length}`);

    const archived = fs
      .readFileSync(path.join(dir, 'jobs-archive.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
    assert.strictEqual(archived.length, 1, `archive should hold 1 record, holds ${archived.length}`);
    assert.strictEqual(JSON.parse(archived[0]).id, 'job-0', 'the oldest record is the one archived');
    assert.ok(!main.some((entry) => entry.id === 'job-0'), 'the archived record left the main list');
  });
});

check('archived records keep files and progress', () => {
  withStore((store, dir) => {
    const files = [{ name: 'big.zip', url: 'https://example.invalid/big', headers: {} }];
    const progress = [
      {
        gid: 'gid-big',
        name: 'big.zip',
        status: 'complete',
        totalLength: 10,
        completedLength: 10,
        downloadSpeed: 0,
        connections: 0,
      },
    ];
    store.save(record(0, { state: { phase: 'done', files, progress } }));
    for (let index = 1; index <= 500; index += 1) store.save(record(index));
    store.flush();

    const archivedLine = fs.readFileSync(path.join(dir, 'jobs-archive.jsonl'), 'utf8').trim();
    const archived = JSON.parse(archivedLine);
    assert.strictEqual(archived.id, 'job-0');
    assert.strictEqual(archived.state.files.length, 1, 'files survive archiving');
    assert.strictEqual(archived.state.progress[0].completedLength, 10, 'progress survives archiving');
  });
});

check('old records without the new fields read back unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-archive-'));
  try {
    const legacy = [record(1), record(2)];
    fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify(legacy), 'utf8');
    const store = new TaskStore(dir);
    const all = store.all();
    assert.strictEqual(all.length, 2);
    assert.strictEqual(all[0].archivedAt, undefined, 'a legacy record has no archivedAt');
    assert.deepStrictEqual(all.map((entry) => entry.id).sort(), ['job-1', 'job-2']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('archive() only touches settled jobs and survives a later save', () => {
  withStore((store, dir) => {
    store.save(record(1));
    store.save(record(2, { state: { phase: 'downloading', files: [], progress: [] } }));
    store.flush();

    assert.strictEqual(store.archive(['job-1', 'job-2']), 1, 'only the done job is archived');
    const downloading = store.all().find((entry) => entry.id === 'job-2');
    assert.strictEqual(downloading.archivedAt, undefined, 'a running job is never archived');

    // A later persist of the same job must not silently un-archive it.
    store.save(record(1, { updatedAt: 1 }));
    assert.ok(store.all().find((entry) => entry.id === 'job-1').archivedAt, 'archivedAt survives a save');

    assert.strictEqual(store.unarchive(['job-1']), 1);
    assert.strictEqual(store.all().find((entry) => entry.id === 'job-1').archivedAt, undefined);
  });
});

check('removeMany() refuses to delete a running job', () => {
  withStore((store) => {
    store.save(record(1));
    store.save(record(2, { state: { phase: 'downloading', files: [], progress: [] } }));
    store.flush();
    assert.strictEqual(store.removeMany(['job-1', 'job-2']), 1);
    assert.deepStrictEqual(store.all().map((entry) => entry.id), ['job-2']);
  });
});

check('a broken archive line does not break the rest of the archive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-archive-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'jobs-archive.jsonl'),
      `${JSON.stringify(record(7))}\n{not json\n${JSON.stringify(record(8))}\n`,
      'utf8',
    );
    const store = new TaskStore(dir);
    assert.deepStrictEqual(
      store.readArchive().map((entry) => entry.id),
      ['job-8', 'job-7'],
      'the two good lines come back newest first',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`OK: ${passed} archive cases`);
