'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PKG = require('../package.json');

/** Steps resolved from package.json scripts, so a new check script cannot be silently skipped. */
const SCRIPT_STEPS = [
  'check:share-link',
  'check:source-parse',
  'check:media-settings',
  'check:media-cookies',
  'check:job',
  'check:aria2',
  'check:ytdlp-args',
  'check:ytdlp-progress',
  'check:ytdlp-errors',
  'check:download-security',
  'check:proxy-security',
  'check:ipc-security',
  'check:lifecycle',
  'check:ytdlp-lifecycle',
  'check:archive',
  'check:provider-health',
  'check:brand',
  'check:runner',
  'check:negative',
  'probe:ui',
];

function getSrcFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

/** One `node --check` per file: Node only parses its first positional argument. */
function buildSyntaxSteps(files) {
  return files.map((file) => ({
    name: `syntax:${path.relative(ROOT, file).split(path.sep).join('/')}`,
    command: process.execPath,
    args: ['--check', file],
    env: {},
  }));
}

function buildScriptStep(name, electronExe) {
  const script = PKG.scripts[name];
  if (typeof script !== 'string') throw new Error(`package.json is missing the "${name}" script`);
  const [bin, ...rest] = script.trim().split(/\s+/);
  if (bin !== 'node' && bin !== 'electron') throw new Error(`unsupported runner in "${name}": ${script}`);
  if (!rest.length || rest.some((arg) => arg.startsWith('-'))) {
    throw new Error(`"${name}" must be a plain "<runner> <file>" script: ${script}`);
  }
  const isElectron = bin === 'electron';
  return {
    name,
    command: isElectron ? electronExe : process.execPath,
    args: rest.map((arg) => path.resolve(ROOT, arg)),
    env: isElectron ? getElectronEnv() : {},
  };
}

function spawnStep({ name, command, args, env, spawnFn = spawn }) {
  return new Promise((resolve, reject) => {
    const childEnv = env !== undefined ? env : process.env;
    const child = spawnFn(command, args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: false,
      env: childEnv,
    });

    child.on('error', (err) => {
      reject(new Error(`[${name}] spawn error: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`[${name}] killed with signal ${signal}`));
      } else if (code !== 0) {
        reject(new Error(`[${name}] exited with non-zero code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

function getElectronEnv(baseEnv = process.env) {
  const env = Object.assign({}, baseEnv);
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function buildSteps(options = {}) {
  const electronExe = options.electronExe || require('electron');
  const srcFiles = options.srcFiles || getSrcFiles(path.join(ROOT, 'src'));
  return [...buildSyntaxSteps(srcFiles), ...SCRIPT_STEPS.map((name) => buildScriptStep(name, electronExe))];
}

async function runAllChecks(options = {}) {
  const spawnFn = options.spawnFn || spawn;

  for (const step of buildSteps(options)) {
    console.log(`\n=== Running check: ${step.name} ===`);
    await spawnStep({
      name: step.name,
      command: step.command,
      args: step.args,
      env: step.env,
      spawnFn,
    });
  }
}

if (require.main === module) {
  runAllChecks().then(
    () => {
      console.log('\nAll checks PASSED.');
      process.exit(0);
    },
    (err) => {
      console.error(`\nCheck FAILED: ${err.message}`);
      process.exit(1);
    }
  );
}

module.exports = {
  runAllChecks,
  spawnStep,
  getElectronEnv,
  getSrcFiles,
  buildSyntaxSteps,
  buildSteps,
};
