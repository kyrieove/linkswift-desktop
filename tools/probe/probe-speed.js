'use strict';

/**
 * Measure one direct link through aria2 with a given option set.
 *
 *   node tools/probe/probe-speed.js --url "<direct url>" [--seconds 20] [--out name.zip]
 *        [--header "Key: value"]... [--option key=value]...
 *
 * Prints one JSON line per second plus a summary, and always cleans up the
 * download and its file so the next run starts from zero.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RPC = 'http://127.0.0.1:6800/jsonrpc';
const TOKEN = 'linkswift-local-check';

const args = process.argv.slice(2);
/** @param {string} name */
const values = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === `--${name}`) out.push(args[i + 1]);
  }
  return out;
};
const single = (name, fallback) => values(name)[0] ?? fallback;

const url = single('url');
if (!url) {
  console.error('缺少 --url');
  process.exit(2);
}
const seconds = Number(single('seconds', '20'));
const out = single('out', `speed-${Date.now()}.bin`);
const dir = single('dir', path.join(os.tmpdir(), 'linkswift-speed'));

/** @type {Record<string, unknown>} */
const options = { out, dir };
for (const header of values('header')) {
  options.header = [...(Array.isArray(options.header) ? options.header : []), header];
}
for (const pair of values('option')) {
  const index = pair.indexOf('=');
  options[pair.slice(0, index)] = pair.slice(index + 1);
}

async function rpc(method, params = []) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'speed', method, params: [`token:${TOKEN}`, ...params] }),
  });
  const data = await response.json();
  if (data.error) throw new Error(`${method}: ${data.error.message}`);
  return data.result;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, out);
  for (const suffix of ['', '.aria2']) {
    if (fs.existsSync(filePath + suffix)) fs.rmSync(filePath + suffix, { force: true });
  }

  const gid = await rpc('aria2.addUri', [[url], options]);
  const samples = [];
  const keys = ['status', 'completedLength', 'totalLength', 'downloadSpeed', 'connections', 'errorCode'];

  // Wall clock as this probe sees it, so the summary can separate "what aria2
  // reports" from "bytes that actually landed per real second".
  let lastDone = 0;
  let lastWall = Date.now();

  for (let tick = 0; tick < seconds; tick += 1) {
    await sleep(1000);
    const status = await rpc('aria2.tellStatus', [gid, keys]);
    const now = Date.now();
    const done = Number(status.completedLength);
    const real = Math.round((done - lastDone) / ((now - lastWall) / 1000));
    lastDone = done;
    lastWall = now;
    samples.push({
      tick,
      status: status.status,
      done,
      total: Number(status.totalLength),
      speed: Number(status.downloadSpeed),
      real,
      conns: Number(status.connections),
      error: status.errorCode || null,
    });
    console.log(JSON.stringify(samples[samples.length - 1]));
    if (status.status === 'error' || status.status === 'complete' || status.status === 'removed') break;
  }

  const final = samples[samples.length - 1] || { done: 0, conns: 0, speed: 0 };
  const steady = samples.filter((s) => s.tick >= 3 && s.status === 'active');
  const avg = steady.length > 0 ? Math.round(steady.reduce((sum, s) => sum + s.speed, 0) / steady.length) : 0;
  const avgReal = steady.length > 0 ? Math.round(steady.reduce((sum, s) => sum + s.real, 0) / steady.length) : 0;
  const peak = samples.reduce((max, s) => Math.max(max, s.speed), 0);
  // Cookie values are live credentials; the summary is meant to be pasted around.
  const shown = {
    ...options,
    header: Array.isArray(options.header)
      ? options.header.map((line) => (/^cookie:/i.test(line) ? 'Cookie: ***' : line))
      : options.header,
  };
  console.log(
    'SUMMARY ' +
      JSON.stringify({
        options: shown,
        seconds: samples.length,
        connections: Math.max(...samples.map((s) => s.conns), 0),
        peakKiBps: Math.round(peak / 1024),
        steadyKiBps: Math.round(avg / 1024),
        steadyRealKiBps: Math.round(avgReal / 1024),
        downloadedMiB: Number((final.done / 1048576).toFixed(2)),
        status: final.status || final.status,
      }),
  );

  try {
    await rpc('aria2.remove', [gid]);
  } catch {}
  try {
    await rpc('aria2.removeDownloadResult', [gid]);
  } catch {}
  await sleep(300);
  for (const suffix of ['', '.aria2']) {
    if (fs.existsSync(filePath + suffix)) fs.rmSync(filePath + suffix, { force: true });
  }
})().catch((error) => {
  console.error('probe 失败:', error.message);
  process.exit(1);
});
