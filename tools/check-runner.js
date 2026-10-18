'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  spawnStep,
  getElectronEnv,
  runAllChecks,
  getSrcFiles,
  buildSyntaxSteps,
  buildSteps,
} = require('./run-checks');

// 1. Verify getElectronEnv strips ELECTRON_RUN_AS_NODE
{
  const testEnv = {
    PATH: 'some-path',
    ELECTRON_RUN_AS_NODE: '1',
    OTHER: 'value',
  };
  const cleaned = getElectronEnv(testEnv);
  assert.strictEqual(cleaned.ELECTRON_RUN_AS_NODE, undefined, 'ELECTRON_RUN_AS_NODE must be removed');
  assert.strictEqual(cleaned.PATH, 'some-path', 'Other env variables should remain');
  assert.strictEqual(cleaned.OTHER, 'value', 'Other env variables should remain');
  assert.strictEqual(testEnv.ELECTRON_RUN_AS_NODE, '1', 'Original env object must not be mutated');
}

// 2. Verify spawnStep propagates non-zero exit code
async function testExitCodePropagation() {
  let sawError = false;
  try {
    await spawnStep({
      name: 'deliberate-fail',
      command: process.execPath,
      args: ['-e', 'process.exit(42)'],
      env: {},
    });
  } catch (err) {
    sawError = true;
    assert(err.message.includes('deliberate-fail'), 'Error message should include child step name');
    assert(err.message.includes('42'), 'Error message should include exit code 42');
  }
  assert.strictEqual(sawError, true, 'Failing child step must reject');
}

// 3. Verify spawnStep propagates child spawn error
async function testSpawnErrorPropagation() {
  const fakeSpawn = () => {
    const ee = new EventEmitter();
    process.nextTick(() => ee.emit('error', new Error('ENOENT fake error')));
    return ee;
  };

  let sawError = false;
  try {
    await spawnStep({
      name: 'non-existent-step',
      command: 'non-existent-command-xyz',
      args: [],
      env: {},
      spawnFn: fakeSpawn,
    });
  } catch (err) {
    sawError = true;
    assert(err.message.includes('non-existent-step'), 'Error message should include child step name');
    assert(err.message.includes('ENOENT fake error'), 'Error message should include spawn error details');
  }
  assert.strictEqual(sawError, true, 'Spawn error must reject');
}

// 4. Verify runAllChecks passes cleaned ELECTRON_RUN_AS_NODE env to electron step
async function testElectronStepEnvInjection() {
  const recordedSteps = [];
  const fakeSpawn = (command, args, options) => {
    recordedSteps.push({ command, args, options });
    const ee = new EventEmitter();
    process.nextTick(() => ee.emit('close', 0, null));
    return ee;
  };

  const oldEnv = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';

  try {
    await runAllChecks({
      spawnFn: fakeSpawn,
      electronExe: 'fake-electron-path',
    });
  } finally {
    if (oldEnv === undefined) {
      delete process.env.ELECTRON_RUN_AS_NODE;
    } else {
      process.env.ELECTRON_RUN_AS_NODE = oldEnv;
    }
  }

  const electronStep = recordedSteps.find((s) => s.command === 'fake-electron-path');
  assert(electronStep, 'probe:ui step using electron executable must be invoked');
  assert.strictEqual(
    electronStep.options.env.ELECTRON_RUN_AS_NODE,
    undefined,
    'probe:ui step must not have ELECTRON_RUN_AS_NODE in env'
  );
  assert.strictEqual(electronStep.options.shell, false, 'shell must be false');
}

// 5. Verify the syntax stage checks every source file instead of only the first one
async function testSyntaxStageCatchesSecondBrokenFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-check-syntax-'));
  try {
    const goodFile = path.join(dir, 'a-good.js');
    const brokenFile = path.join(dir, 'b-broken.js');
    fs.writeFileSync(goodFile, 'const fine = 1;\n', 'utf8');
    fs.writeFileSync(brokenFile, 'const broken = ;\n', 'utf8');

    const steps = buildSyntaxSteps([goodFile, brokenFile]);
    assert.strictEqual(steps.length, 2, 'syntax stage must emit one step per file');

    const failures = [];
    for (const step of steps) {
      try {
        await spawnStep(step);
      } catch (err) {
        failures.push(err.message);
      }
    }

    assert.strictEqual(failures.length, 1, `only the broken file must fail, got: ${JSON.stringify(failures)}`);
    assert(failures[0].includes('b-broken.js'), 'the failing step must name the second, broken file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 6. Verify every src file gets its own step and every scripted check is wired in
function testStepsCoverSourceAndScripts() {
  const srcFiles = getSrcFiles(path.join(__dirname, '..', 'src'));
  assert(srcFiles.length > 10, `expected the full src tree, got ${srcFiles.length} files`);
  assert(
    srcFiles.some((file) => file.endsWith(path.join('renderer', 'renderer.js'))),
    'renderer.js must be part of the syntax stage'
  );

  const steps = buildSteps({ electronExe: 'fake-electron-path' });
  const syntaxSteps = steps.filter((step) => step.name.startsWith('syntax:'));
  assert.strictEqual(syntaxSteps.length, srcFiles.length, 'one syntax step per source file');
  assert.strictEqual(
    new Set(syntaxSteps.map((step) => step.args[1])).size,
    srcFiles.length,
    'each syntax step must pass its own file path'
  );

  const pkg = require('../package.json');
  for (const [name, script] of Object.entries(pkg.scripts || {})) {
    // Every check/probe script in package.json must be reachable from the one
    // `npm run check` entry, or a suite could sit in the repo and never run.
    if (!/^(check|probe):/.test(name)) continue;
    if (name === 'probe:ui') {
      assert.strictEqual(script.trim(), 'electron tools/probe/probe-ui.js', 'probe:ui must launch the UI probe');
    }
    if (['check:lifecycle', 'check:runner', 'check:negative', 'check:brand'].includes(name) || name === 'probe:ui') {
      assert(steps.some((step) => step.name === name), `step "${name}" must be derived from package.json`);
    }
  }
  assert(
    steps.some((step) => step.name === 'check:negative'),
    'the negative controls must stay wired into npm run check'
  );
}

async function run() {
  await testExitCodePropagation();
  await testSpawnErrorPropagation();
  await testElectronStepEnvInjection();
  await testSyntaxStageCatchesSecondBrokenFile();
  testStepsCoverSourceAndScripts();
  console.log('check:runner OK');
}

run().catch((err) => {
  console.error('check:runner FAILED:', err);
  process.exit(1);
});
