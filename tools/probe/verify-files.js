'use strict';

// Compare the aria2-reported sizes of one job against the bytes on disk.
//   node tools/probe/verify-files.js <jobsDir> <jobId> <downloadDir>
// Prints counts only; never prints full direct links.

const fs = require('node:fs');
const path = require('node:path');

const [, , jobsDir, jobId, downloadDir] = process.argv;
const jobs = JSON.parse(fs.readFileSync(jobsDir, 'utf8'));
const job = jobs.find((entry) => entry.id === jobId);
if (!job) {
  console.error(`job ${jobId} not found`);
  process.exit(2);
}

const progress = job.state.progress || [];
let matched = 0;
let mismatched = 0;
let missing = 0;
const examples = [];
const downloadRoot = path.resolve(downloadDir);

for (const entry of progress) {
  // Remote-supplied names must stay inside the download directory; a name with
  // ".." would otherwise be read from somewhere else and then reported missing.
  const file = path.resolve(downloadRoot, entry.name || '');
  if (file !== downloadRoot && !file.startsWith(downloadRoot + path.sep)) {
    mismatched += 1;
    if (examples.length < 3) examples.push(`${entry.name}: outside the download directory`);
    continue;
  }
  let size = null;
  try {
    size = fs.statSync(file).size;
  } catch {
    size = null;
  }
  if (size === null) {
    missing += 1;
    if (examples.length < 3) examples.push(`${entry.name}: missing`);
  } else if (size === entry.totalLength) {
    matched += 1;
  } else {
    mismatched += 1;
    if (examples.length < 3) examples.push(`${entry.name}: disk ${size} vs aria2 ${entry.totalLength}`);
  }
}

const control = progress
  .map((entry) => path.resolve(downloadRoot, `${entry.name}.aria2`))
  .filter((file) => file.startsWith(downloadRoot + path.sep) && fs.existsSync(file));

console.log(
  JSON.stringify(
    {
      jobId,
      phase: job.state.phase,
      files: progress.length,
      matched,
      mismatched,
      missing,
      leftoverAria2ControlFiles: control.length,
      totalBytes: progress.reduce((sum, entry) => sum + (entry.totalLength || 0), 0),
      examples,
    },
    null,
    2
  )
);
