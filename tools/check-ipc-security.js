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

    // 1. [F-004] RPC Token Isolation: buildBoot() MUST NOT contain the real secret token
    const bootPayload = jm.buildBoot();
    const serialized = JSON.stringify(bootPayload);
    assert.strictEqual(
      serialized.includes(MARKER_TOKEN),
      false,
      'F-004: buildBoot() must not expose real daemon RPC token to webpage context'
    );

    // 2. [F-005] IPC Sender Validation for renderer INVOKE handlers
    const handlers = new Map();
    const mockBus = {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
      on: () => {},
    };

    // UI authorization predicate
    const authorizedUiSenderId = 1001;
    const isAuthorizedUi = (event) => {
      return (
        event &&
        event.sender &&
        event.sender.id === authorizedUiSenderId &&
        event.senderFrame &&
        event.senderFrame.parent === null &&
        event.senderFrame.url &&
        event.senderFrame.url.includes('index.html')
      );
    };

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
      sender: { id: authorizedUiSenderId },
      senderFrame: { parent: null, url: 'file:///app/src/renderer/index.html' },
    };
    const getSettingsHandler = handlers.get(INVOKE.getSettings);
    const settings = await getSettingsHandler(fakeEventAuthorized);
    assert.ok(settings && typeof settings === 'object', 'Authorized UI sender must succeed');

    // 3. [F-005] Netdisk Window Event Validation in JobManager.register
    const netdiskEvents = new Map();
    const mockIpcMain = {
      on: (channel, listener) => {
        netdiskEvents.set(channel, listener);
      },
    };

    jm.register(mockIpcMain);
    const bootListener = netdiskEvents.get(INTERNAL.boot);
    const obsListener = netdiskEvents.get(INTERNAL.observation);
    assert.ok(bootListener, 'INTERNAL.boot listener must be registered');
    assert.ok(obsListener, 'INTERNAL.observation listener must be registered');

    // Unauthorized sender on INTERNAL.boot must return null
    const bootEventUnauthorized = {
      returnValue: 'initial',
      sender: { id: 7777 },
      senderFrame: { parent: null, url: 'https://evil.com/' },
    };
    bootListener(bootEventUnauthorized);
    assert.strictEqual(
      bootEventUnauthorized.returnValue,
      null,
      'INTERNAL.boot from unauthorized sender must return null'
    );

    console.log('check:ipc-security OK');
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
