'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ProviderHealthStore } = require('../src/main/provider-health');

/**
 * What the settings page is allowed to claim about a netdisk.
 *
 * Only the last real outcome on this machine, one row per provider. Reading a
 * corrupt file must degrade to "未验证" rather than to an invented answer.
 */

const PROVIDERS = ['quark', 'baidu', 'uc', 'xunlei'];

/** @param {(store: ProviderHealthStore, dir: string) => void} body */
function withStore(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-health-'));
  try {
    body(new ProviderHealthStore(dir), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let passed = 0;
function check(name, body) {
  body();
  passed += 1;
  console.log(`  ok  ${name}`);
}

console.log('check:provider-health');

check('an unknown provider is "未验证" until something really ran', () => {
  withStore((store) => {
    const view = store.view(PROVIDERS);
    assert.strictEqual(view.length, 4);
    for (const entry of view) assert.strictEqual(entry.verified, false, `${entry.provider} starts unverified`);
  });
});

check('two outcomes for one provider leave only the newer one', () => {
  withStore((store) => {
    store.record({ provider: 'baidu', at: 1000, ok: false, code: 'needs-transfer', hint: '文件超过 50MB' });
    store.record({ provider: 'baidu', at: 2000, ok: true });
    const view = store.view(PROVIDERS);
    const baidu = view.find((entry) => entry.provider === 'baidu');
    assert.strictEqual(baidu.verified, true);
    assert.strictEqual(baidu.ok, true, 'the newer success wins');
    assert.strictEqual(baidu.at, 2000);
    assert.strictEqual(baidu.code, undefined, 'a success carries no failure code');
    assert.strictEqual(store.all().length, 1, 'one row per provider');
  });
});

check('a corrupt file degrades to all unverified instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkswift-health-'));
  try {
    fs.writeFileSync(path.join(dir, 'provider-health.json'), '{ this is not json', 'utf8');
    const store = new ProviderHealthStore(dir);
    const view = store.view(PROVIDERS);
    assert.strictEqual(view.filter((entry) => entry.verified).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('nothing but the outcome is persisted', () => {
  withStore((store, dir) => {
    store.record({ provider: 'quark', at: 3000, ok: true });
    const raw = fs.readFileSync(path.join(dir, 'provider-health.json'), 'utf8');
    for (const forbidden of ['cookie', 'token', 'Cookie', 'Token', 'url']) {
      assert.ok(!raw.includes(forbidden), `provider-health.json must not contain "${forbidden}"`);
    }
  });
});

console.log(`OK: ${passed} provider-health cases`);
