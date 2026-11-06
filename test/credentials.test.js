/**
 * Credential storage must not be able to break the app.
 *
 * The store validates every record key when it loads the file:
 *
 *     const segments = value.split('/')
 *     if (segments.length !== 2) throw new TypeError(...)
 *     for (const segment of segments)
 *       if (!/^[a-z][a-z0-9-]*$/.test(segment)) throw new TypeError(...)
 *
 * One key breaking either rule makes the *entire* credential store fail to load,
 * and the app fails to start with it. That happened twice while this bridge put
 * the Feishu app id in the key: `cli_aa605ec29f395ccf` contains `_`, which Feishu
 * allows and that pattern rejects.
 *
 * The fix is structural, not a mapping: the key is a constant and the app id
 * lives in the value. These tests pin that, and pin that a record cannot be
 * mistaken for a different app's.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The plugin persists notice recipients under the harness home; a test must
 *  use its own so it neither reads nor writes the real profile. */
function isolatedHome() {
  return mkdtempSync(join(tmpdir(), 'dfo-cred-'));
}

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/** The store's own rules, transcribed. */
const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/u;

function assertValidKey(key) {
  const segments = String(key).split('/');
  assert.equal(segments.length, 2, `credential key "${key}" must be "<scope>/<id>"`);
  for (const segment of segments) {
    assert.match(
      segment,
      KEY_SEGMENT_PATTERN,
      `credential key segment "${segment}" must match ${KEY_SEGMENT_PATTERN}`,
    );
  }
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
      // A store that refuses invalid keys is the realistic one: it throws when
      // the file is loaded if any key is malformed.
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
      if (name === 'homePaths') return { homeDir: isolatedHome() };
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
    throw new Error('no socket in tests');
  };
}

/** Answer every platform call with a credential rejection. */
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

/** Run one connect request with a stubbed platform. */
async function connectWith(appId, secret = 'SECRET') {
  const routes = [];
  const ctx = stubContext({ routes });
  await apply(ctx, { enabled: false });
  const connect = routes.find((route) => route.path.endsWith('/connect'));
  const original = globalThis.fetch;
  globalThis.fetch = stubFetchAccepting();
  try {
    await connect.resource(new Request(
      `http://localhost/connect?appId=${encodeURIComponent(appId)}&appSecret=${secret}`,
    ));
  } finally {
    globalThis.fetch = original;
  }
  return ctx;
}

test('the stored key is a constant, independent of the app id', async () => {
  const first = await connectWith('cli_aa605ec29f395ccf');
  const second = await connectWith('cli_a1b2c3d4e5f67890');

  assert.equal(first.writtenKeys.length, 1);
  assert.equal(second.writtenKeys.length, 1);
  assert.equal(
    first.writtenKeys[0],
    second.writtenKeys[0],
    'two different apps use the same record slot',
  );
  for (const key of first.writtenKeys) assertValidKey(key);
});

test('a Feishu app id with underscores never reaches the key', async () => {
  // The exact id shape that broke the launch.
  const ctx = await connectWith('cli_aa605ec29f395ccf');
  for (const key of ctx.writtenKeys) {
    assertValidKey(key);
    assert.ok(!key.includes('_'), `the app id was not put in the key: ${key}`);
    assert.ok(!key.includes('cli_'), 'and no fragment of it either');
  }
});

test('the app id is stored verbatim in the value', async () => {
  const ctx = await connectWith('cli_aa605ec29f395ccf', 'the-secret');
  const record = [...ctx.store.values()][0];
  // A grant record: the api-key field whitelist would reject the extra field.
  assert.equal(record.kind, 'grant');
  assert.equal(record.payload.appId, 'cli_aa605ec29f395ccf', 'the id round-trips exactly');
  assert.equal(record.payload.secret, 'the-secret');
});

test('a record is only used for the app it names', async () => {
  // Two apps share one slot, so the value has to say which one it belongs to.
  const store = new Map([
    ['dsh-feishu-only/app', { kind: 'grant', payload: { appId: 'cli_a', secret: 'SECRET-A' } }],
  ]);
  const routes = [];
  const ctx = stubContext({ routes, store });
  await apply(ctx, { enabled: false });

  const original = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('tenant_access_token')) sent = String(init?.body ?? '');
    return {
      ok: false, status: 400,
      headers: new Map([['content-type', 'application/json']]),
      async json() { return { code: 10003, msg: 'invalid' }; },
      async text() { return '{}'; },
    };
  };
  try {
    const diagnose = routes.find((route) => route.path.endsWith('/diagnose'));
    await diagnose.resource(new Request('http://localhost/diagnose?appId=cli_b'));
  } finally {
    globalThis.fetch = original;
  }
  // App B must not borrow app A's secret.
  assert.ok(sent === null || !sent.includes('SECRET-A'), 'the other app\'s secret is not used');
});

test('a legacy record without an app id is still accepted', async () => {
  const store = new Map([
    ['dsh-feishu-only/app', { kind: 'api-key', key: 'OLD-SECRET' }],
  ]);
  const routes = [];
  const ctx = stubContext({ routes, store });
  await apply(ctx, { enabled: false });

  const original = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('tenant_access_token')) sent = String(init?.body ?? '');
    return {
      ok: false, status: 400,
      headers: new Map([['content-type', 'application/json']]),
      async json() { return { code: 10003, msg: 'invalid' }; },
      async text() { return '{}'; },
    };
  };
  try {
    const diagnose = routes.find((route) => route.path.endsWith('/diagnose'));
    await diagnose.resource(new Request('http://localhost/diagnose?appId=cli_any'));
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(sent !== null && sent.includes('OLD-SECRET'), 'the upgrade keeps the existing secret');
});

test('a colon-keyed record from an even older version is still readable', async () => {
  // That key is invalid by the store's rule, so a real store throws when asked.
  // The reader must survive the throw and try the next candidate.
  const routes = [];
  const ctx = stubContext({ routes });
  ctx.get = (name) => {
    if (name === 'webServer') return { register: (r) => { routes.push(r); return () => {}; } };
    if (name === 'credentials') {
      return {
        async readRecord(key) {
          if (key.includes(':')) return { kind: 'api-key', key: 'ANCIENT-SECRET' };
          return null;
        },
        async modifyRecord() {},
      };
    }
    return undefined;
  };
  await apply(ctx, { enabled: false });

  const original = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('tenant_access_token')) sent = String(init?.body ?? '');
    return {
      ok: false, status: 400,
      headers: new Map([['content-type', 'application/json']]),
      async json() { return { code: 10003, msg: 'invalid' }; },
      async text() { return '{}'; },
    };
  };
  try {
    const diagnose = routes.find((route) => route.path.endsWith('/diagnose'));
    await diagnose.resource(new Request('http://localhost/diagnose?appId=cli_old'));
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(sent !== null && sent.includes('ANCIENT-SECRET'));
});

test('a store that throws on read does not break the launch', async () => {
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