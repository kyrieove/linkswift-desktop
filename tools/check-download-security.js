'use strict';

const assert = require('node:assert');
const { buildAddUriOptions, validateExtractedFile } = require('../src/main/aria2');

console.log('=== Running check: check:download-security ===');

// 1. validateExtractedFile must exist
assert.strictEqual(
  typeof validateExtractedFile,
  'function',
  'validateExtractedFile must be exported as a function from src/main/aria2.js'
);

// 2. Reject path traversal and illegal filenames
const illegalFiles = [
  { url: 'https://example.com/file', name: '../../outside.txt' },
  { url: 'https://example.com/file', name: '..\\outside.txt' },
  { url: 'https://example.com/file', name: 'C:\\outside.txt' },
  { url: 'https://example.com/file', name: '/etc/passwd' },
  { url: 'https://example.com/file', name: 'CON' },
  { url: 'https://example.com/file', name: 'prn.txt' },
  { url: 'https://example.com/file', name: 'aux' },
  { url: 'https://example.com/file', name: 'NUL.tar' },
  { url: 'https://example.com/file', name: 'COM1' },
  { url: 'https://example.com/file', name: 'LPT1' },
  { url: 'https://example.com/file', name: 'bad\x00name.zip' },
  { url: 'https://example.com/file', name: 'badname.zip ' },
  { url: 'https://example.com/file', name: 'badname.zip.' },
  { url: 'https://example.com/file', name: '.' },
  { url: 'https://example.com/file', name: '..' },
  { url: 'https://example.com/file', name: '' },
  { url: 'file:///etc/passwd', name: 'archive.zip' },
  { url: 'ftp://example.com/file', name: 'archive.zip' },
  { url: 'javascript:alert(1)', name: 'archive.zip' },
  { url: '', name: 'archive.zip' },
];

for (const illegal of illegalFiles) {
  assert.throws(
    () => validateExtractedFile(illegal),
    (err) => err && err.message && (err.message.includes('文件名') || err.message.includes('URL') || err.message.includes('非法') || err.message.includes('安全')),
    `Expected validateExtractedFile to reject illegal input: ${JSON.stringify(illegal)}`
  );
}

// 3. buildAddUriOptions must enforce validateExtractedFile
for (const illegal of illegalFiles) {
  assert.throws(
    () => buildAddUriOptions(illegal),
    `Expected buildAddUriOptions to reject illegal input: ${JSON.stringify(illegal)}`
  );
}

// 4. Valid files must pass cleanly
const validFiles = [
  { url: 'https://example.com/download/archive.zip', name: 'archive.zip' },
  { url: 'http://cdn.example.com/data.tar.gz', name: 'data.tar.gz' },
  { url: 'https://example.com/file', name: 'my document (final).pdf' },
  { url: 'https://pan.quark.cn/s/abc', name: 'video.mp4' },
];

for (const valid of validFiles) {
  const checked = validateExtractedFile(valid);
  assert.strictEqual(checked.name, valid.name);
  assert.strictEqual(checked.url, valid.url);
  const opts = buildAddUriOptions(valid);
  assert.strictEqual(opts.out, valid.name);
}

console.log('check:download-security OK');
