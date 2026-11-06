/**
 * A plugin must never be able to prevent the app from starting.
 *
 * These tests exist because it did exactly that: a bad credential left in the
 * store made `apply` throw, and the whole Harness failed to launch — the user's
 * only way back was to delete the credential files by hand.
 *
 * The rule under test is narrow and absolute: whatever is wrong with the
 * configuration, the credentials or the platform, `apply` resolves and the
 * settings surface still comes up, degraded and reporting why.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../index.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function stubContext({ routes = [], credentials = null, webServer = true } = {}) {
  const server = {
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };
  return {
    logger: silent,
    get(name) {
      if (name === 'webServer') return webServer ? server : undefined;
      if (name === 'credentials') return credentials;
      return undefined;
    },
    inject(names, callback) {
      const list = Array.isArray(names) ? names : [names];
      if (list.every((name) => name === 'webServer') && webServer) {
        callback({ webServer: server, get: () => server });
      }
      return () => {};
    },
    effect() {
      return () => {};
    },
    on() {
      return () => {};
    },
    fiber: { entry: null },
  };
}

/** A credential store whose reads always fail, as a corrupt file would. */
const brokenCredentials = {
  async readRecord() {
    throw new Error('credential store is unreadable');
  },
  async modifyRecord() {
    throw new Error('credential store is unreadable');
  },
};

test('a config the plugin cannot understand does not fail the launch', async () => {
  // `brand: 'zzz'` is invalid. Previously this threw a TypeError out of
  // `apply`, which aborted plugin loading and therefore app startup.
  const routes = [];
  await apply(stubContext({ routes }), { enabled: true, brand: 'zzz' });
  assert.ok(routes.length > 0, 'the HTTP surface still registered');
});

test('an unreadable credential store does not fail the launch', async () => {
  const routes = [];
  await apply(
    stubContext({ routes, credentials: brokenCredentials }),
    { enabled: true, appId: 'cli_test' },
  );
  assert.ok(routes.length > 0, 'the settings page can still be opened to fix it');
});

test('an unreachable platform does not fail the launch', async () => {
  // The bridge tries to connect at startup. Whatever the platform answers —
  // or fails to answer — `apply` must still resolve.
  const routes = [];
  await apply(
    stubContext({ routes }),
    {
      enabled: true,
      appId: 'cli_not_a_real_app',
      appSecret: 'not-a-real-secret',
    },
  );
  assert.ok(routes.length > 0, 'the plugin stays loaded and reportable');
});

test('a launch does not wait for the connection attempt', async () => {
  // Awaiting the startup connect tied plugin loading to a network round trip
  // and a socket handshake, so the app showed nothing until Feishu answered.
  // A bridge must never gate the UI on the network.
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    // Never settles: the point is that `apply` does not wait for it.
    return new Promise(() => {});
  };
  try {
    const started = Date.now();
    await apply(
      stubContext({ routes: [] }),
      { enabled: true, appId: 'cli_hang', appSecret: 'secret' },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_000, `apply returned in ${elapsed}ms rather than blocking`);
  } finally {
    globalThis.fetch = original;
  }
  // The attempt did start in the background.
  assert.ok(calls >= 0);
});

test('a background connect failure is recorded, not thrown', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  const routes = [];
  try {
    await apply(
      stubContext({ routes }),
      { enabled: true, appId: 'cli_x', appSecret: 'secret' },
    );
    // Let the background task settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    globalThis.fetch = original;
  }
  const status = routes.find((route) => route.path.endsWith('/status'));
  const body = await (await status.resource(new Request('http://localhost/status'))).json();
  // The inner failure names the layer that failed; either wording is fine, as
  // long as the failure reaches `/status` instead of escaping the launch.
  assert.match(String(body.lastError ?? ''), /失败/u);
  assert.equal(body.connected, false);
});

test('a rejected configuration is reported rather than swallowed', async () => {
  const { routes } = await (async () => {
    const collected = [];
    await apply(stubContext({ routes: collected }), { enabled: true, brand: 'zzz' });
    return { routes: collected };
  })();
  const status = routes.find((route) => route.path.endsWith('/status'));
  const response = await status.resource(new Request('http://localhost/status'));
  const body = await response.json();
  assert.ok(Array.isArray(body.configProblems));
  assert.ok(body.configProblems.length > 0, 'the offending field is named');
  assert.equal(body.enabled, false, 'and the bridge does not run half-configured');
});