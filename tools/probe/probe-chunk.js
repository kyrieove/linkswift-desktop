'use strict';

/**
 * Measure how a direct link behaves under heavy range-request concurrency.
 *
 *   node tools/probe/probe-chunk.js --url "<direct url>" [--seconds 15]
 *        [--connections 64] [--chunk 4M] [--header "Key: value"]...
 *
 * The bytes are read and discarded: the point is the arrival rate and the HTTP
 * statuses, not a file on disk. Uses http.Agent with maxSockets = connections,
 * because Node's fetch pool would silently serialize the requests and make a
 * 256-connection test into a 6-connection test.
 */

const http = require('node:http');
const https = require('node:https');

const args = process.argv.slice(2);
/** @param {string} name */
const values = (name) => {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}`) out.push(args[index + 1]);
  }
  return out;
};
const single = (name, fallback) => values(name)[0] ?? fallback;

const url = single('url');
if (!url) {
  console.error('缺少 --url');
  process.exit(2);
}
const seconds = Number(single('seconds', '15'));
const connections = Number(single('connections', '16'));
const chunkArg = single('chunk', '4M');

const chunkSize = (() => {
  const match = /^(\d+(?:\.\d+)?)\s*([KM]?)$/i.exec(String(chunkArg).trim());
  if (!match) return 4 * 1024 * 1024;
  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === 'K') return Math.round(value * 1024);
  if (unit === 'M') return Math.round(value * 1024 * 1024);
  return Math.round(value);
})();

/** @type {Record<string, string>} */
const headers = { Accept: '*/*' };
for (const line of values('header')) {
  const index = line.indexOf(':');
  if (index > 0) headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
}

const target = new URL(url);
const transport = target.protocol === 'https:' ? https : http;
const agent = new transport.Agent({ keepAlive: true, maxSockets: connections });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One range request; resolves with the byte count and status.
 * @param {string} url
 * @param {number} start
 * @param {number} end
 * @param {number} deadline
 */
function requestRange(url, start, end, deadline, onBytes) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status, count, error) => {
      if (settled) return;
      settled = true;
      resolve({ status, count, error });
    };

    const req = transport.request(
      url,
      { method: 'GET', headers: { ...headers, Range: `bytes=${start}-${end}` }, agent },
      (res) => {
        const status = res.statusCode || 0;
        if (status !== 206 && status !== 200) {
          res.resume();
          finish(status, 0, null);
          return;
        }
        let count = 0;
        res.on('data', (chunk) => {
          count += chunk.length;
          onBytes(chunk.length);
          if (Date.now() >= deadline) req.destroy();
        });
        res.on('end', () => finish(status, count, null));
        res.on('error', (error) => finish(status, count, error.message));
      },
    );
    req.on('error', (error) => finish(0, 0, error.code || error.message));
    const timer = setTimeout(() => req.destroy(), Math.max(100, deadline - Date.now()));
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

(async () => {
  // The share direct link answers 302 first; the signed target is what serves ranges.
  let effective = url;
  let contentRange = '';
  let status = 0;
  for (let hop = 0; hop < 6; hop += 1) {
    const hopResult = await new Promise((resolve) => {
      const req = transport.request(
        effective,
        { method: 'GET', headers: { ...headers, Range: 'bytes=0-0' }, agent },
        (res) => {
          contentRange = res.headers['content-range'] || '';
          res.resume();
          resolve({ status: res.statusCode || 0, location: res.headers.location });
        },
      );
      req.on('error', (error) => resolve({ status: 0, location: null, error: error.message }));
      req.end();
    });
    status = hopResult.status;
    if (status >= 300 && status < 400 && hopResult.location) {
      effective = new URL(hopResult.location, effective).href;
      continue;
    }
    break;
  }

  if (status !== 206 && status !== 200) {
    console.log('SUMMARY ' + JSON.stringify({ error: '首个请求被拒绝', status, effective: effective.slice(0, 80) }));
    process.exit(1);
  }
  const total = Number((/bytes\s+\d+-\d+\/(\d+)/i.exec(contentRange) || [])[1] || 0);
  if (!total) {
    console.log('SUMMARY ' + JSON.stringify({ error: '拿不到文件总长度', status, contentRange }));
    process.exit(1);
  }
  const sizeProbe = total;

  let bytes = 0;
  let errors = 0;
  let requests = 0;
  /** @type {Map<number, number>} */
  const statuses = new Map();
  let nextStart = 0;
  let stop = false;
  const started = Date.now();
  const deadline = started + seconds * 1000;

  const worker = async () => {
    while (!stop && Date.now() < deadline) {
      const start = nextStart;
      if (start >= sizeProbe) return;
      const end = Math.min(start + chunkSize - 1, sizeProbe - 1);
      nextStart = end + 1;
      requests += 1;
      const result = await requestRange(effective, start, end, deadline, (count) => {
        bytes += count;
      });
      statuses.set(result.status, (statuses.get(result.status) || 0) + 1);
      // A destroy at the deadline surfaces as an error; that is the test ending,
      // not a refusal, so it must not count against the link.
      if (result.error && Date.now() < deadline) errors += 1;
      if (Date.now() >= deadline) {
        stop = true;
        return;
      }
    }
  };

  let lastBytes = 0;
  let lastAt = started;
  let peak = 0;
  const samples = [];
  const sampler = setInterval(() => {
    const now = Date.now();
    const rate = Math.round((bytes - lastBytes) / ((now - lastAt) / 1000) / 1024);
    peak = Math.max(peak, rate);
    samples.push(rate);
    console.log(JSON.stringify({ second: samples.length, KiBps: rate, decodedKiB: Math.round(bytes / 1024) }));
    lastBytes = bytes;
    lastAt = now;
  }, 1000);

  await Promise.all(Array.from({ length: connections }, worker));
  clearInterval(sampler);
  stop = true;
  agent.destroy();

  const elapsed = (Date.now() - started) / 1000;
  const steady = samples.slice(2);
  const steadyAvg = steady.length ? Math.round(steady.reduce((sum, value) => sum + value, 0) / steady.length) : 0;
  console.log(
    'SUMMARY ' +
      JSON.stringify({
        connections,
        chunkMiB: Number((chunkSize / 1048576).toFixed(2)),
        seconds: Number(elapsed.toFixed(1)),
        totalMiB: Number((sizeProbe / 1048576).toFixed(2)),
        decodedMiB: Number((bytes / 1048576).toFixed(2)),
        peakKiBps: peak,
        steadyKiBps: steadyAvg,
        requests,
        errors,
        statuses: Object.fromEntries([...statuses.entries()]),
      }),
  );
})().catch((error) => {
  console.error('probe 失败:', error.message);
  process.exit(1);
});
