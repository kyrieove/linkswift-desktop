'use strict';

// Remove the probe jobs this session created from the real store so the user's
// history is not cluttered by test submissions. Only ids passed on the command
// line are touched; everything else is left exactly as it was.
//   node tools/probe/prune-test-jobs.js <jobs.json> <jobId> [<jobId> ...]

const fs = require('node:fs');

const [, , file, ...ids] = process.argv;
if (!file || !ids.length) {
  console.error('usage: node tools/probe/prune-test-jobs.js <jobs.json> <jobId> [...]');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`jobs file not found: ${file}`);
  process.exit(2);
}

const jobs = JSON.parse(fs.readFileSync(file, 'utf8'));
const before = jobs.length;
const kept = jobs.filter((job) => !ids.includes(job.id));
const removed = before - kept.length;

if (removed !== ids.length) {
  console.error(`expected to remove ${ids.length}, matched ${removed}; aborting without writing`);
  process.exit(1);
}

fs.writeFileSync(file, JSON.stringify(kept, null, 2), 'utf8');
console.log(JSON.stringify({ before, after: kept.length, removed }));
