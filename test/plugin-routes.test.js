import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../index.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * A stub Cordis context that records the routes the plugin registers.
 *
 * This exists because the HTTP surface is the only part of `apply` that runs
 * without a bot credential, and a scoping mistake there throws only when a
 * handler is actually invoked — which a load-only check would never catch.
 */
function stubContext({ routes = [], credentials = null, webServerAvailable = true } = {}) {
  const webServer = {
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
      // A cold start means `get('webServer')` is undefined: the carrier
      // activates after this plugin. Tests use `inject` to model readiness.
      if (name === 'webServer') return webServerAvailable ? webServer : undefined;
      if (name === 'credentials') return credentials;
      return undefined;
    },
    /**
     * Cordis' inject contract: run the callback now if every service is
     * present, otherwise when it becomes available. The stub runs it eagerly
     * so registration is observable, which is the behaviour the routes need.
     */
    inject(names, callback) {
      const dependencies = Array.isArray(names) ? names : [names];
      const available = dependencies.every((name) => (
        name === 'webServer' ? webServerAvailable : false
      ));
      if (available) {
        callback({
          webServer,
          get: (name) => (name === 'webServer' ? webServer : undefined),
        });
      }
      return () => {};
    },
    effect(_fn) {},
    on() {
      return () => {};
    },
    fiber: { entry: null },
  };
}

async function load(options) {
  const routes = [];
  const ctx = stubContext({ routes, ...options });
  await apply(ctx, { enabled: false });
  const find = (suffix) => routes.find((route) => route.path.endsWith(suffix));
  return { routes, ctx, find };
}

test('every HTTP route registers under the plugin prefix', async () => {
  const { routes } = await load();
  const paths = routes.map((route) => route.path).sort();
  assert.deepEqual(paths, [
    '/plugins/dsh-feishu-only/connect',
    '/plugins/dsh-feishu-only/diagnose',
    '/plugins/dsh-feishu-only/disconnect',
    '/plugins/dsh-feishu-only/menu',
    '/plugins/dsh-feishu-only/qr',
    '/plugins/dsh-feishu-only/qr-image',
    '/plugins/dsh-feishu-only/qr/cancel',
    '/plugins/dsh-feishu-only/status',
    '/plugins/dsh-feishu-only/verify',
  ]);
});

test('the status route answers with the connection snapshot', async () => {
  const { find } = await load();
  const response = await find('/status').resource(new Request('http://x/plugins/dsh-feishu-only/status'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.connected, false);
  assert.equal(body.connection.messages, 'stopped');
  assert.ok(body.capabilities, 'the capability probe is reported');
});

test('the verify route reports the robot layer as not ready before connecting', async () => {
  // This handler is the regression guard for the scoping defect: it reaches a
  // helper declared outside the registration block.
  const { find } = await load();
  const response = await find('/verify').resource(new Request('http://x/plugins/dsh-feishu-only/verify'));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.checks[0].name, '机器人层');
  assert.match(body.checks[0].detail, /尚未连接/u);
});

test('the qr route starts idle and returns a JSON snapshot', async () => {
  const { find } = await load();
  const response = await find('/qr').resource(new Request('http://x/plugins/dsh-feishu-only/qr'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.registration.state, 'idle');
  assert.equal(body.registration.qrCodeUrl, null);
});

test('the connect route rejects a request without credentials', async () => {
  const { find } = await load();
  const response = await find('/connect').resource(
    new Request('http://x/plugins/dsh-feishu-only/connect'),
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /appId/u);
});

test('the connect route rejects a credential pair it cannot verify', async () => {
  // No network is reachable from this test, so verification must fail closed
  // rather than reporting success.
  const { find } = await load();
  const response = await find('/connect').resource(
    new Request('http://x/plugins/dsh-feishu-only/connect?appId=cli_x&appSecret=s'),
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.ok(body.error, 'the failure reason is surfaced');
});

test('responses carry a no-store cache header', async () => {
  const { find } = await load();
  const response = await find('/status').resource(new Request('http://x/plugins/dsh-feishu-only/status'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type'), /application\/json/u);
});

test('teardown disposers remove every registered route', async () => {
  const routes = [];
  const disposers = [];
  const ctx = stubContext({ routes });
  ctx.effect = (fn) => {
    const result = fn();
    if (typeof result === 'function') disposers.push(result);
    return () => {};
  };
  await apply(ctx, { enabled: false });
  assert.equal(routes.length, 9);
  for (const dispose of disposers) dispose();
  assert.equal(routes.length, 0);
});

test('routes are declared through ctx.inject, not a one-shot service read', async () => {
  // Regression guard: `apply` runs before the HTTP carrier activates on a cold
  // start, so `ctx.get('webServer')` is undefined. Reading it once left every
  // route unregistered after a restart while the client page still mounted.
  const routes = [];
  const ctx = stubContext({ routes });
  const injected = [];
  const originalInject = ctx.inject;
  ctx.inject = (names, callback) => {
    injected.push(Array.isArray(names) ? names : [names]);
    return originalInject(names, callback);
  };
  await apply(ctx, { enabled: false });
  assert.ok(
    injected.some((names) => names.includes('webServer')),
    'webServer must be injected so registration waits for the carrier',
  );
  assert.equal(routes.length, 9, 'and the routes still register once it is ready');
});

test('re-injecting the carrier replaces routes instead of duplicating them', async () => {
  const routes = [];
  const ctx = stubContext({ routes });
  let rerun;
  const originalInject = ctx.inject;
  ctx.inject = (names, callback) => {
    if (Array.isArray(names) && names.includes('webServer')) rerun = callback;
    return originalInject(names, callback);
  };
  await apply(ctx, { enabled: false });
  assert.equal(routes.length, 9);

  // The service is replaced; Cordis calls the inject callback again.
  rerun({ webServer: { register: (route) => { routes.push(route); return () => {}; } } });
  assert.equal(routes.length, 9, 'the previous generation was released first');
});

test('the qr-image route refuses a URL it did not issue', async () => {
  // Without this guard the endpoint would be an open QR generator.
  const { find } = await load();
  const route = find('/qr-image');
  const response = await route.resource(new Request(
    `http://x/plugins/dsh-feishu-only/qr-image?url=${encodeURIComponent('https://evil.example/anything')}`,
  ));
  assert.equal(response.status, 404);
});

test('the qr-image route refuses a missing url', async () => {
  const { find } = await load();
  const response = await find('/qr-image').resource(
    new Request('http://x/plugins/dsh-feishu-only/qr-image'),
  );
  assert.equal(response.status, 404);
});

test('the disconnect route requires explicit confirmation', async () => {
  const { find } = await load();
  const response = await find('/disconnect').resource(
    new Request('http://x/plugins/dsh-feishu-only/disconnect'),
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /confirm/u);
});