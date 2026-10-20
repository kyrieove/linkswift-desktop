'use strict';

const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const { app } = require('electron');
const { Store } = require('../src/main/store');
const { UserscriptSource } = require('../src/main/userscript');
const { loadVendor } = require('../src/main/vendor');
const { JobManager } = require('../src/main/job');
const { registerIpc } = require('../src/main/ipc');
const { authorizeUiEvent } = require('../src/main/ipc-auth');
const { INVOKE, INTERNAL } = require('../src/shared/protocol');

console.log('=== Running check: check:ipc-security ===');

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  try {
    const tmpDir = path.join(os.tmpdir(), 'test-ipc-' + Date.now());
    const store = new Store(tmpDir);
    const userscript = new UserscriptSource({
      userDataDir: tmpDir,
      bundledPath: path.join(__dirname, '..', 'resources', 'userscript.user.js'),
    });
    const { vendor, resources } = loadVendor(path.join(__dirname, '..'));

    const MARKER_TOKEN = 'SUPER_SECRET_MARKER_TOKEN_XYZ';
    const fakeDaemon = {
      config: () => ({
        domain: 'http://127.0.0.1',
        port: 6800,
        path: '/jsonrpc',
        token: MARKER_TOKEN,
        dir: tmpDir,
      }),
      status: () => ({ running: true }),
    };

    const jm = new JobManager({
      store,
      userscript,
      vendor,
      resources,
      partition: 'test-partition',
      preloadPath: 'fake-preload.js',
      emit: () => {},
      daemon: fakeDaemon,
    });

    // 1. [F-004] RPC Token Isolation & Provider-Scoped GM Values
    store.setValue('quark_social_token', 'quark_secret_token_123');
    store.setValue('baidu_access_token', 'baidu_secret_token_456');

    // 1.1 Virtual RPC token must NOT leak real daemon token
    const baseBoot = jm.buildBoot();
    const serialized = JSON.stringify(baseBoot);
    assert.strictEqual(
      serialized.includes(MARKER_TOKEN),
      false,
      'F-004: buildBoot() must not expose real daemon RPC token to webpage context'
    );
    assert.strictEqual(
      baseBoot.values.setting_aria2_rpc[0].token,
      '',
      'F-004: virtual RPC token must be empty'
    );

    // 1.2 Quark boot only receives Quark values + global settings, never Baidu tokens
    const quarkBoot = jm.buildBoot('quark');
    assert.strictEqual(
      quarkBoot.values.quark_social_token,
      'quark_secret_token_123',
      'Quark boot must expose quark_social_token'
    );
    assert.strictEqual(
      quarkBoot.values.baidu_access_token,
      undefined,
      'Quark boot must NOT expose baidu_access_token'
    );
    assert.ok(quarkBoot.values.setting_init, 'Quark boot must include global setting_init');

    // 1.3 Baidu boot only receives Baidu values + global settings, never Quark tokens
    const baiduBoot = jm.buildBoot('baidu');
    assert.strictEqual(
      baiduBoot.values.baidu_access_token,
      'baidu_secret_token_456',
      'Baidu boot must expose baidu_access_token'
    );
    assert.strictEqual(
      baiduBoot.values.quark_social_token,
      undefined,
      'Baidu boot must NOT expose quark_social_token'
    );

    // 1.4 [F-004] Generic sensitive setting keys must NOT be exposed as global
    store.setValue('setting_rpc_token', 'legacy-secret-token');
    store.setValue('setting_auth_token', 'legacy-auth-token');
    store.setValue('config.session_token', 'session-token-xyz');
    store.setValue('setting_ui_theme', 'dark');

    const quarkBoot2 = jm.buildBoot('quark');
    assert.strictEqual(
      quarkBoot2.values['setting_rpc_token'],
      undefined,
      'setting_rpc_token must NOT be exposed'
    );
    assert.strictEqual(
      quarkBoot2.values['setting_auth_token'],
      undefined,
      'setting_auth_token must NOT be exposed'
    );
    assert.strictEqual(
      quarkBoot2.values['config.session_token'],
      undefined,
      'config.session_token must NOT be exposed'
    );
    assert.strictEqual(
      quarkBoot2.values['setting_ui_theme'],
      'dark',
      'Allowed non-sensitive setting_ui_theme must be preserved'
    );

    const baiduBoot2 = jm.buildBoot('baidu');
    assert.strictEqual(
      baiduBoot2.values['setting_rpc_token'],
      undefined,
      'setting_rpc_token must NOT be exposed to baidu'
    );

    // 2. [F-005] authorizeUiEvent Unit Tests (Exact origin, fail-closed)
    const fakeUiWebContents = { id: 1001, isDestroyed: () => false };
    const expectedFileUrl = 'file:///app/src/renderer/index.html';

    // 2.1 Positive: Exact file URL, sender matches, top frame
    assert.strictEqual(
      authorizeUiEvent(
        { sender: fakeUiWebContents, senderFrame: { parent: null, url: 'file:///app/src/renderer/index.html' } },
        fakeUiWebContents,
        expectedFileUrl
      ),
      true,
      'Exact file URL and sender must be authorized'
    );

    // 2.2 Negative: Remote evil URL containing index.html substring
    assert.strictEqual(
      authorizeUiEvent(
        { sender: fakeUiWebContents, senderFrame: { parent: null, url: 'https://evil.example/index.html' } },
        fakeUiWebContents,
        expectedFileUrl
      ),
      false,
      'Remote URL containing index.html substring must be rejected'
    );

    // 2.3 Negative: Child iframe
    assert.strictEqual(
      authorizeUiEvent(
        { sender: fakeUiWebContents, senderFrame: { parent: {}, url: 'file:///app/src/renderer/index.html' } },
        fakeUiWebContents,
        expectedFileUrl
      ),
      false,
      'Child frame must be rejected'
    );

    // 2.4 Negative: Missing senderFrame
    assert.strictEqual(
      authorizeUiEvent(
        { sender: fakeUiWebContents, senderFrame: null },
        fakeUiWebContents,
        expectedFileUrl
      ),
      false,
      'Missing senderFrame must be rejected'
    );

    // 2.5 Negative: Sender webContents mismatch
    assert.strictEqual(
      authorizeUiEvent(
        { sender: { id: 9999, isDestroyed: () => false }, senderFrame: { parent: null, url: expectedFileUrl } },
        fakeUiWebContents,
        expectedFileUrl
      ),
      false,
      'Sender mismatch must be rejected'
    );

    // 3. [F-005] IPC Sender Validation for renderer INVOKE handlers
    const handlers = new Map();
    const mockBus = {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
      on: () => {},
    };

    const isAuthorizedUi = (event) => authorizeUiEvent(event, fakeUiWebContents, expectedFileUrl);
    registerIpc(mockBus, jm, { authorizeUiSender: isAuthorizedUi });

    // Test unauthorized sender on INVOKE.submit
    const fakeEventUnauthorized = {
      sender: { id: 9999 },
      senderFrame: { parent: null, url: 'https://malicious.com/' },
    };

    const submitHandler = handlers.get(INVOKE.submit);
    assert.ok(submitHandler, 'INVOKE.submit handler must be registered');

    let unauthorizedBlocked = false;
    try {
      await submitHandler(fakeEventUnauthorized, 'https://pan.quark.cn/s/123');
    } catch (err) {
      unauthorizedBlocked = true;
      assert.ok(err.message.includes('Forbidden') || err.message.includes('未授权') || err.message.includes('sender'));
    }
    assert.strictEqual(unauthorizedBlocked, true, 'Unauthorized sender must be rejected on INVOKE handler');

    // Test authorized sender on INVOKE.getSettings
    const fakeEventAuthorized = {
      sender: fakeUiWebContents,
      senderFrame: { parent: null, url: expectedFileUrl },
    };
    const getSettingsHandler = handlers.get(INVOKE.getSettings);
    const settings = await getSettingsHandler(fakeEventAuthorized);
    assert.ok(settings && typeof settings === 'object', 'Authorized UI sender must succeed');

    // 4. [F-005] Netdisk Window Event Validation in JobManager
    const dummyJob = {
      window: { isDestroyed: () => false, webContents: { id: 555 } },
      link: { provider: 'quark' },
    };
    jm.byContents.set(555, dummyJob);

    // 4.1 Missing senderFrame -> must reject
    assert.strictEqual(
      jm.authorizeNetdiskEvent({ sender: dummyJob.window.webContents, senderFrame: null }),
      false,
      'Netdisk event without senderFrame must be rejected'
    );

    // 4.2 Missing frame url -> must reject
    assert.strictEqual(
      jm.authorizeNetdiskEvent({ sender: dummyJob.window.webContents, senderFrame: { parent: null, url: '' } }),
      false,
      'Netdisk event without frame url must be rejected'
    );

    // 4.3 Frame url matching another provider (baidu instead of quark) -> must reject
    assert.strictEqual(
      jm.authorizeNetdiskEvent({ sender: dummyJob.window.webContents, senderFrame: { parent: null, url: 'https://pan.baidu.com/s/123' } }),
      false,
      'Netdisk event with cross-provider url must be rejected'
    );

    // 4.4 Destroyed window -> must reject
    const destroyedJob = {
      window: { isDestroyed: () => true, webContents: { id: 666 } },
      link: { provider: 'quark' },
    };
    jm.byContents.set(666, destroyedJob);
    assert.strictEqual(
      jm.authorizeNetdiskEvent({ sender: destroyedJob.window.webContents, senderFrame: { parent: null, url: 'https://pan.quark.cn/s/123' } }),
      false,
      'Netdisk event with destroyed window must be rejected'
    );

    // 4.5 Authorized netdisk event -> must succeed
    assert.strictEqual(
      jm.authorizeNetdiskEvent({ sender: dummyJob.window.webContents, senderFrame: { parent: null, url: 'https://pan.quark.cn/s/123' } }),
      true,
      'Legitimate netdisk event must be authorized'
    );

    console.log('check:ipc-security OK');
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
