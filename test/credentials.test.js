/**
 * The credential key must be storable.
 *
 * A colon in a YAML mapping key is a real hazard: `a:b:` parses as a nested map
 * under `a`, not as the key `a:b`. Storing a secret under
 * `dsh-feishu-only:cli_xxx` therefore wrote a structure the store could not read
 * back, and the resulting unreadable credential file made the app fail to start.
 *
 * These tests pin the key format and the reader's tolerance for the old one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../index.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function stubContext({ routes = [], store = new Map(), webServer = true } = {}) {
  const server = {
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };
  const credentialService = {
    async readRecord(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async modifyRecord(key, producer) {
      // A key with a colon is what corrupted the file; refuse it the way a
      // strict store would, so a regression shows up here.
      if (String(key).includes(':')) {
        throw new Error(`invalid credential key: ${key}`);
      }
      store.set(key, await producer());
    },
    /** Every key written, for assertions. */
    keys() {
      return [...store.keys()];
    },
  };
  return {
    logger: silent,
    credentialService,
    store,
    get(name) {
      if (name === 'webServer') return webServer ? server : undefined;
      if (name === 'credentials') return credentialService;
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

test('the credential key contains no colon', async () => {
  const ctx = stubContext();
  await apply(ctx, { enabled: false });

  // Reach the key the same way the plugin does: store a secret through the
  // endpoint that accepts credentials, then inspect what was written.
  const routes = [];
  const ctxWithRoutes = stubContext({ routes });
  await apply(ctxWithRoutes, { enabled: false });
  const connect = routes.find((route) => route.path.endsWith('/connect'));
  assert.ok(connect, 'the connect route exists');

  // A credential pair the platform will reject, but only after the secret has
  // been written — which is the point: the write happens first.
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    headers: new Map([['content-type', 'application/json']]),
    async json() {
      return { code: 10003, msg: 'invalid param' };
    },
    async text() {
      return '{"code":10003}';
    },
  });
  try {
    await connect.resource(new Request(
      'http://localhost/connect?appId=cli_aa605ec29f395ccf&appSecret=SECRET',
    ));
  } finally {
    globalThis.fetch = original;
  }

  const written = ctxWithRoutes.credentialService.keys();
  for (const key of written) {
    assert.ok(!key.includes(':'), `credential key must not contain a colon: ${key}`);
  }
  if (written.length > 0) {
    assert.match(written[0], /^dsh-feishu-only\//u, 'the key uses the slash form');
  }
});

test('a secret stored under the old colon key is still read', async () => {
  const store = new Map([
    ['dsh-feishu-only:cli_old', { kind: 'api-key', key: 'OLD-SECRET' }],
  ]);
  const routes = [];
  const ctx = stubContext({ routes, store });

  const original = globalThis.fetch;
  let tokenRequested = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes('tenant_access_token')) {
      tokenRequested = true;
      return {
        ok: false,
        status: 400,
        headers: new Map([['content-type', 'application/json']]),
        async json() {
          return { code: 10003, msg: 'invalid param' };
        },
        async text() {
          return '{"code":10003}';
        },
      };
    }
    throw new Error('unexpected request');
  };
  try {
    // `enabled` with an appId but no inline secret makes the plugin read the
    // store; reaching the token call proves the old key was found.
    await apply(ctx, { enabled: true, appId: 'cli_old' });
    await new Promise((resolve) => setTimeout(resolve, 80));
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(tokenRequested, 'the old colon key was read, so no secret re-entry is needed');
});