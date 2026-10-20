'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { proxyRequest } = require('../src/main/job');

console.log('=== Running check: check:proxy-security ===');

async function main() {
  // 1. Production mode (default allowLocalFixture: false) must reject loopback, private IPs, metadata IP, and non-http schemes
  const ssrfTargets = [
    'http://127.0.0.1:12345/api',
    'http://localhost:12345/api',
    'http://10.0.0.1/admin',
    'http://172.16.0.1/secret',
    'http://192.168.1.1/router',
    'http://169.254.169.254/latest/meta-data',
    'file:///etc/passwd',
    'ftp://example.com/file',
  ];

  for (const url of ssrfTargets) {
    let rejected = false;
    try {
      await proxyRequest({ url, method: 'GET', headers: {}, body: null });
    } catch (err) {
      rejected = true;
    }
    assert.strictEqual(rejected, true, `SSRF target must be rejected: ${url}`);
  }

  // 2. Cross-origin redirect credential stripping
  let serverAHeaders = null;
  let serverBHeaders = null;

  const serverB = http.createServer((req, res) => {
    serverBHeaders = req.headers;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Server B OK');
  });

  const serverA = http.createServer((req, res) => {
    serverAHeaders = req.headers;
    const addrB = serverB.address();
    res.writeHead(302, {
      Location: `http://127.0.0.1:${addrB.port}/target`,
    });
    res.end();
  });

  await new Promise((resolve) => serverB.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => serverA.listen(0, '127.0.0.1', resolve));

  const addrA = serverA.address();
  const addrB = serverB.address();

  try {
    const res = await proxyRequest(
      {
        url: `http://127.0.0.1:${addrA.port}/entry`,
        method: 'POST',
        headers: {
          Cookie: 'session=secret123',
          Authorization: 'Bearer auth_token_secret',
          'Proxy-Authorization': 'Basic proxy_secret',
          Origin: 'http://legit-origin.com',
          Referer: 'http://legit-origin.com/page',
          'X-Custom': 'kept-header',
        },
        body: 'test-body',
        allowLocalFixture: true,
      }
    );

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 200);

    // Verify Server A received the initial headers
    assert.ok(serverAHeaders['cookie']);
    assert.ok(serverAHeaders['authorization']);

    // Verify Server B (different origin/port) had sensitive credentials stripped
    assert.strictEqual(serverBHeaders['cookie'], undefined, 'Cookie must be stripped on cross-origin redirect');
    assert.strictEqual(serverBHeaders['authorization'], undefined, 'Authorization must be stripped on cross-origin redirect');
    assert.strictEqual(serverBHeaders['proxy-authorization'], undefined, 'Proxy-Authorization must be stripped on cross-origin redirect');
    assert.strictEqual(serverBHeaders['origin'], undefined, 'Origin must be stripped on cross-origin redirect');
    assert.strictEqual(serverBHeaders['referer'], undefined, 'Referer must be stripped on cross-origin redirect');
    assert.strictEqual(serverBHeaders['x-custom'], 'kept-header', 'Safe custom headers should be retained');
  } finally {
    serverA.close();
    serverB.close();
  }

  // 3. Response body > 32 MiB size limit rejection
  const bigServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    const chunk = Buffer.alloc(1024 * 1024, 'a'); // 1 MiB chunk
    // Send 33 MiB
    for (let i = 0; i < 33; i++) {
      res.write(chunk);
    }
    res.end();
  });

  await new Promise((resolve) => bigServer.listen(0, '127.0.0.1', resolve));
  const bigAddr = bigServer.address();

  try {
    let bigRejected = false;
    try {
      await proxyRequest({
        url: `http://127.0.0.1:${bigAddr.port}/big`,
        method: 'GET',
        headers: {},
        body: null,
        allowLocalFixture: true,
      });
    } catch (err) {
      bigRejected = true;
      assert.ok(err.message.includes('上限') || err.message.includes('超限') || err.message.includes('limit') || err.message.includes('32'));
    }
    assert.strictEqual(bigRejected, true, 'Oversized (>32 MiB) response must be rejected');
  } finally {
    bigServer.close();
  }

  console.log('check:proxy-security OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
