'use strict';

const { createHash } = require('node:crypto');

/**
 * aria2 JSON-RPC client.
 *
 * The request shape mirrors what the userscript builds at its own sendTo.aria2,
 * so the app and the script agree on what a "push to aria2" looks like.
 *
 * @typedef {import('../shared/protocol').Aria2Config} Aria2Config
 */

/** @param {Aria2Config} config */
function endpoint(config) {
  const domain = config.domain.replace(/\/+$/, '');
  return `${domain}:${config.port}${config.path || '/jsonrpc'}`;
}

/**
 * aria2 wants the RPC secret as the first positional parameter, spelled
 * `token:<secret>`.
 * @param {Aria2Config} config
 * @param {unknown[]} params
 */
function withToken(config, params) {
  return config.token ? [`token:${config.token}`, ...params] : params;
}

/**
 * @param {Aria2Config} config
 * @param {string} method
 * @param {unknown[]} params
 * @returns {Promise<unknown>}
 */
async function call(config, method, params) {
  const body = {
    id: createHash('md5').update(`${method}${Date.now()}`).digest('hex'),
    jsonrpc: '2.0',
    method,
    params: withToken(config, params),
  };

  let response;
  try {
    response = await fetch(endpoint(config), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new Error(`连接 aria2 失败（${endpoint(config)}）：${error.message}`);
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`aria2 返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }

  if (parsed.error) {
    throw new Error(`aria2 拒绝了请求：${parsed.error.message ?? JSON.stringify(parsed.error)}`);
  }
  return parsed.result;
}

/** @param {Aria2Config} config */
async function getVersion(config) {
  const result = await call(config, 'aria2.getVersion', []);
  return /** @type {{ version: string }} */ (result);
}

/**
 * @param {Aria2Config} config
 * @param {import('../shared/protocol').ExtractedFile} file
 * @returns {Promise<string>} the aria2 GID
 */
async function addUri(config, file) {
  const options = { out: file.name };
  if (config.dir) options.dir = config.dir;
  for (const [name, value] of Object.entries(file.headers)) {
    const lower = name.toLowerCase();
    if (lower === 'user-agent') options['user-agent'] = value;
    if (lower === 'referer') options.referer = value;
  }
  if (!options.referer) options.referer = new URL(file.url).origin + '/';

  return /** @type {string} */ (await call(config, 'aria2.addUri', [[file.url], options]));
}

module.exports = { getVersion, addUri, endpoint };
