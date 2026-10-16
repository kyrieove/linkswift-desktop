'use strict';

/**
 * Fetch the upstream userscript into resources/, where the app looks for its
 * offline fallback.
 *
 * Run this when you want to bump the version pinned in the repository:
 *   npm run fetch-userscript
 */

const fs = require('node:fs');
const path = require('node:path');

const { UPSTREAM_URL, parseVersion } = require('../src/main/userscript');

const destination = path.join(__dirname, '..', 'resources', 'userscript.user.js');

async function main() {
  console.log(`fetching ${UPSTREAM_URL}`);
  const response = await fetch(UPSTREAM_URL, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const source = await response.text();
  if (!source.includes('==UserScript==')) throw new Error('response is not a userscript');

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, source, 'utf8');

  console.log(`wrote ${destination}`);
  console.log(`  version ${parseVersion(source)}`);
  console.log(`  ${Buffer.byteLength(source, 'utf8')} bytes`);
  console.log(`  ${source.split('\n').length} lines`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
