'use strict';

/**
 * Verify the aria2 delivery path against a real aria2 daemon.
 *
 *   node tools/probe/probe-aria2.js
 */

const path = require('node:path');
const fs = require('node:fs');

const aria2 = require('../../src/main/aria2');

const CONFIG = {
  domain: 'http://localhost',
  port: '6800',
  path: '/jsonrpc',
  token: 'probe-secret',
  dir: '',
};

const REPORT = path.join(require('node:os').tmpdir(), 'linkswift-aria2-report.json');

async function main() {
  const report = {};

  try {
    report.getVersion = await aria2.getVersion(CONFIG);
  } catch (error) {
    report.getVersion = `FAILED: ${error.message}`;
  }

  try {
    report.addUriGid = await aria2.addUri(CONFIG, {
      url: 'https://raw.githubusercontent.com/hmjz100/LinkSwift/dev/README.md',
      name: 'probe-readme.md',
      headers: { 'User-Agent': 'probe-agent', Referer: 'https://github.com/' },
    });
  } catch (error) {
    report.addUri = `FAILED: ${error.message}`;
  }

  // A wrong secret must be refused, or the token wiring is not actually applied.
  try {
    await aria2.getVersion({ ...CONFIG, token: 'wrong-token' });
    report.wrongToken = 'UNEXPECTEDLY ACCEPTED';
  } catch (error) {
    report.wrongToken = `correctly rejected: ${error.message.slice(0, 70)}`;
  }

  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  fs.writeFileSync(REPORT, JSON.stringify({ fatal: String(error.stack || error) }, null, 2), 'utf8');
  process.exitCode = 1;
});
