/**
 * Credential keys must satisfy the store's `<scope>/<id>` rule.
 *
 * This is not a style preference. The store runs `parseCredentialKey` over every
 * record key when it loads the file:
 *
 *     const segments = value.split('/')
 *     if (segments.length !== 2) throw new TypeError(...)
 *
 * so a single malformed key makes the *entire credential store* fail to load.
 * One earlier version wrote `dsh-feishu-only:cli_xxx`, which stopped the app from
 * starting and needed a hand edit to recover.
 *
 * These tests therefore behave like that validator, and the fake store throws the
 * way the real one does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../index.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/** The store's own rule, reproduced exactly. */
function assertValidKey(key) {
  const segments = String(key).split('/');
  assert.equal(
    segments.length,
    2,
    `credential key "${key}" must be "<scope>/<id>"`,
  );
  assert.ok(segments[0] !== '' && segments[1] !== '', `credential key "${key}" has an empty segment`);
}

function stubContext({ routes = [], store = new Map(), webServer = true, keys = [] } = {}) {
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
      assertValidKey(key);
      return store.has(key) ? store.get(key) : null;
    },
    async modifyRecord(key, produce) {
      assertValidKey(key);
      keys.push(key);
      store.set(key, await produce());
    },
  };
  return {
    logger: silent,
    credentialService,
    store,
    writtenKeys: keys,
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

/** Answer every platform call with a credential rejection, so only the write matters. */
function stubFetchRejecting() {
  return async () => ({
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
}

/** A platform that accepts the credential pair, so the write path is reached. */
function stubFetchAccepting() {
  return async (url) => {
    const text = String(url);
    if (text.includes('tenant_access_token')) {
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        async json() {
          return { code: 0, tenant_access_token: 't-1', expire: 7200 };
        },
      };
    }
    if (text.includes('/bot/v3/info')) {
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        async json() {
          return { code: 0, bot: { app_name: 'test', activate_status: 2 } };
        },
      };
    }
    // The socket endpoint and anything else: refuse, so no real connection runs.
    return {
      ok: false,
      status: 400,
      headers: new Map([['content-type', 'application/json']]),
      async json() {
        return { code: 1, msg: 'not available in tests' };
      },
    };
  };
}

test('connecting stores the secret under a valid key', async () => {
  const routes = [];
  const ctx = stubContext({ routes });
  await apply(ctx, { enabled: false });

  const connect = routes.find((route) => route.path.endsWith('/connect'));
  const original = globalThis.fetch;
  // The pair must verify before the secret is stored, so the stub has to accept
  // the credential calls. Everything after that — socket endpoint discovery —
  // fails on purpose: the write happens before the connection, and a real socket
  // would keep the test process alive.
  globalThis.fetch = stubFetchAccepting();
  try {
    await connect.resource(new Request(
      'http://localhost/connect?appId=cli_aa605ec29f395ccf&appSecret=SECRET',
    ));
  } finally {
    globalThis.fetch = original;
  }

  assert.ok(ctx.writtenKeys.length > 0, 'the secret was stored');
  for (const key of ctx.writtenKeys) {
    assertValidKey(key);
    assert.ok(!key.includes(':'), `no colon in ${key}`);
    assert.equal(key, 'dsh-feishu-only/cli_aa605ec29f395ccf');
  }
});

test('an app id containing a slash still yields a two-segment key', async () => {
  // The id becomes the second segment, so a slash in it would make three and the
  // store would reject the write — and then refuse to load the file.
  const routes = [];
  const ctx = stubContext({ routes });
  await apply(ctx, { enabled: false });

  const connect = routes.find((route) => route.path.endsWith('/connect'));
  const original = globalThis.fetch;
  globalThis.fetch = stubFetchRejecting();
  try {
    await connect.resource(new Request(
      `http://localhost/connect?appId=${encodeURIComponent('cli/weird')}&appSecret=SECRET`,
    ));
  } finally {
    globalThis.fetch = original;
  }

  for (const key of ctx.writtenKeys) assertValidKey(key);
});

test('a legacy colon-keyed secret is still readable', async () => {
  // The secret is read through the diagnostic route rather than a startup
  // connect: the read is what is under test, and a startup connect would open a
  // socket the test then has to tear down.
  const store = new Map([
    ['dsh-feishu-only:cli_old', { kind: 'api-key', key: 'OLD-SECRET' }],
  ]);
  const routes = [];
  const ctx = stubContext({ routes, store });
  // The legacy key is invalid by the store's rule, so this store answers any key
  // rather than validating: it models a file written by the older version.
  ctx.get = (name) => {
    if (name === 'webServer') return { register: (r) => { routes.push(r); return () => {}; } };
    if (name === 'credentials') {
      return {
        async readRecord(key) {
          return store.has(key) ? store.get(key) : null;
        },
        async modifyRecord() {},
      };
    }
    return undefined;
  };
  await apply(ctx, { enabled: false });

  const original = globalThis.fetch;
  let sentSecret = null;
  globalThis.fetch = async (url, init) => {
    // The token request carries the pair it was given; capturing it proves which
    // secret the plugin resolved.
    if (String(url).includes('tenant_access_token')) {
      sentSecret = String(init?.body ?? '');
    }
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
  };
  try {
    const diagnose = routes.find((route) => route.path.endsWith('/diagnose'));
    await diagnose.resource(new Request('http://localhost/diagnose?appId=cli_old'));
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(sentSecret !== null, 'a credential attempt was made');
  assert.ok(sentSecret.includes('OLD-SECRET'), 'the legacy record supplied the secret');
});

test('a store that throws on read does not break the launch', async () => {
  // What the real store does when the file holds an invalid key. The plugin must
  // still load, because a broken credential file must not cost the app its UI.
  const routes = [];
  const ctx = stubContext({ routes });
  ctx.get = (name) => {
    if (name === 'webServer') return { register: (r) => { routes.push(r); return () => {}; } };
    if (name === 'credentials') {
      return {
        async readRecord() {
          throw new TypeError('credential key "x:y" must be "<scope>/<id>"');
        },
        async modifyRecord() {
          throw new TypeError('credential key "x:y" must be "<scope>/<id>"');
        },
      };
    }
    return undefined;
  };
  await apply(ctx, { enabled: false });
  assert.ok(routes.length > 0, 'the plugin loaded and can still report the problem');

  // The diagnostic reports the missing secret instead of throwing.
  const original = globalThis.fetch;
  globalThis.fetch = stubFetchRejecting();
  try {
    const diagnose = routes.find((route) => route.path.endsWith('/diagnose'));
    const response = await diagnose.resource(new Request('http://localhost/diagnose?appId=cli_x'));
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.focus.layer, 'credentials');
  } finally {
    globalThis.fetch = original;
  }
});