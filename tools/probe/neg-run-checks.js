'use strict';

/**
 * Negative controls for the check launcher: prove the launcher turns red when a
 * child fails or a cleanup fails. A launcher that stays green in those cases
 * would make every other check worthless.
 *
 *   node tools/probe/neg-run-checks.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { runAllChecks, buildSteps } = require('../run-checks');

const ELECTRON = 'neg-fake-electron';
const results = [];

/** The launcher logs every step; keep the negative-control output readable. */
function quiet(fn) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = write;
  });
}

function fakeChild(closeCode, signal) {
  return () => {
    const ee = new EventEmitter();
    process.nextTick(() => ee.emit('close', closeCode, signal));
    return ee;
  };
}

async function rejection(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

async function control(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
  }
}

async function run() {
  await control('non-zero child exit fails the run', async () => {
    const err = await rejection(quiet(() => runAllChecks({ spawnFn: fakeChild(3, null), electronExe: ELECTRON })));
    assert(err, 'runAllChecks resolved although a child exited with 3');
    assert(/exited with non-zero code 3/.test(err.message), `unexpected message: ${err.message}`);
  });

  await control('signalled child fails the run', async () => {
    const err = await rejection(quiet(() => runAllChecks({ spawnFn: fakeChild(null, 'SIGTERM'), electronExe: ELECTRON })));
    assert(err, 'runAllChecks resolved although a child was killed');
    assert(/signal SIGTERM/.test(err.message), `unexpected message: ${err.message}`);
  });

  await control('failure of the last step is not swallowed', async () => {
    const total = buildSteps({ electronExe: ELECTRON }).length;
    let seen = 0;
    const spawnFn = () => {
      seen += 1;
      return fakeChild(seen === total ? 5 : 0, null)();
    };
    const err = await rejection(quiet(() => runAllChecks({ spawnFn, electronExe: ELECTRON })));
    assert(err, 'the run stayed green although the last child exited with 5');
    assert(/exited with non-zero code 5/.test(err.message), `unexpected message: ${err.message}`);
  });

  await control('a broken file after a valid one fails the syntax stage', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-neg-syntax-'));
    try {
      const good = path.join(dir, 'a-good.js');
      const broken = path.join(dir, 'b-broken.js');
      fs.writeFileSync(good, 'const fine = 1;\n', 'utf8');
      fs.writeFileSync(broken, 'const broken = ;\n', 'utf8');
      const spawnFn = (command, args) => {
        if (!args.includes(broken)) return fakeChild(0, null)();
        return require('node:child_process').spawn(command, args, { stdio: 'ignore' });
      };
      const err = await rejection(quiet(() => runAllChecks({ spawnFn, electronExe: ELECTRON, srcFiles: [good, broken] })));
      assert(err, 'a second, broken source file did not fail the run');
      assert(/b-broken\.js/.test(err.message), `the failing step must name the file, got: ${err.message}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await control('a probe that leaks its daemon exits non-zero', async () => {
    // The cleanup guarantee is only real if the probe itself turns red. The
    // probe exposes LINKSWIFT_PROBE_LEAK_DAEMON=1 as that negative control and
    // must exit non-zero when it is set; grepping the source would stay green
    // after the behaviour regressed.
    const probe = path.join(__dirname, 'probe-ui.js');
    assert(fs.existsSync(probe), `probe-ui.js must exist at ${probe}`);
    const { spawnSync } = require('node:child_process');
    const electronExe = require('electron');
    const env = Object.assign({}, process.env, { LINKSWIFT_PROBE_LEAK_DAEMON: '1' });
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(electronExe, [probe], { env, timeout: 240000, encoding: 'utf8' });
    assert(
      result.status !== 0,
      `the probe exited ${result.status} with LINKSWIFT_PROBE_LEAK_DAEMON=1; a leaked daemon must fail the run`
    );
  });

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(
    path.join(os.tmpdir(), 'linkswift-neg-check-report.json'),
    JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2),
    'utf8'
  );
  console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  if (failed.length > 0) process.exit(1);
}

if (require.main === module) {
  run().catch((err) => {
    console.error('neg-run-checks FAILED:', err);
    process.exit(1);
  });
}
