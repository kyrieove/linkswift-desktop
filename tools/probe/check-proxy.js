'use strict';

const { app, session } = require('electron');
const http = require('node:http');
const assert = require('node:assert');
const { proxyRequest } = require('../../src/main/job');

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  let server;
  try {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/echo') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          res.setHeader('Set-Cookie', 'sid=new; Path=/');
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(
            JSON.stringify({
              cookie: req.headers['cookie'] || '',
              method: req.method,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        });
        return;
      }

      if (url.pathname === '/r1') {
        res.writeHead(302, { Location: '/echo' });
        res.end();
        return;
      }

      if (url.pathname === '/frag') {
        const addr = server.address();
        res.writeHead(302, {
          Location: `http://127.0.0.1:${addr.port}/login_success#access_token=abc&`,
        });
        res.end();
        return;
      }

      if (url.pathname === '/post307') {
        res.writeHead(307, { Location: '/echo' });
        res.end();
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve);
      server.on('error', reject);
    });

    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const ses = session.fromPartition('check-proxy');
    await ses.clearStorageData({ storages: ['cookies'] });

    await ses.cookies.set({
      url: baseUrl,
      name: 'seed',
      value: '1',
    });

    // (1) request to /echo sends seed=1
    const res1 = await proxyRequest(
      {
        url: `${baseUrl}/echo`,
        method: 'GET',
        headers: {},
      },
      ses,
    );
    const data1 = JSON.parse(res1.text);
    assert.match(data1.cookie, /\bseed=1\b/);

    // (3) after (1) session has cookie sid=new
    const cookiesAfter1 = await ses.cookies.get({ url: baseUrl });
    const sidCookie = cookiesAfter1.find((c) => c.name === 'sid');
    assert(sidCookie && sidCookie.value === 'new', 'session should have cookie sid=new');

    // (2) caller Cookie: seed=9 overrides to seed=9 while another session cookie is still sent
    const res2 = await proxyRequest(
      {
        url: `${baseUrl}/echo`,
        method: 'GET',
        headers: { Cookie: 'seed=9' },
      },
      ses,
    );
    const data2 = JSON.parse(res2.text);
    assert.match(data2.cookie, /\bseed=9\b/);
    assert.doesNotMatch(data2.cookie, /\bseed=1\b/);
    assert.match(data2.cookie, /\bsid=new\b/);

    // (4) /r1 → status 200, finalUrl ends with /echo
    const res4 = await proxyRequest(
      {
        url: `${baseUrl}/r1`,
        method: 'GET',
        headers: {},
      },
      ses,
    );
    assert.strictEqual(res4.status, 200);
    assert(
      res4.finalUrl && res4.finalUrl.endsWith('/echo'),
      `finalUrl should end with /echo, got ${res4.finalUrl}`,
    );

    // (5) /frag → finalUrl includes access_token=abc, status 200
    const res5 = await proxyRequest(
      {
        url: `${baseUrl}/frag`,
        method: 'GET',
        headers: {},
      },
      ses,
    );
    assert.strictEqual(res5.status, 200);
    assert(
      res5.finalUrl && res5.finalUrl.includes('access_token=abc'),
      `finalUrl should include access_token=abc, got ${res5.finalUrl}`,
    );

    // (6) /post307 with method POST body x=1 reaches /echo still POST (have /echo also return method)
    const res6 = await proxyRequest(
      {
        url: `${baseUrl}/post307`,
        method: 'POST',
        headers: {},
        body: 'x=1',
      },
      ses,
    );
    assert.strictEqual(res6.status, 200);
    const data6 = JSON.parse(res6.text);
    assert.strictEqual(data6.method, 'POST');
    assert.strictEqual(data6.body, 'x=1');

    console.log('check-proxy OK');
    server.close();
    app.exit(0);
  } catch (err) {
    console.error(err);
    if (server) server.close();
    app.exit(1);
  }
});
