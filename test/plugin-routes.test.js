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
function stubContext({ routes = [], credentials = null } = {}) {
  return {
    logger: silent,
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            routes.push(route);
            return () => {
              const index = routes.indexOf(route);
              if (index >= 0) routes.splice(index, 1);
            };
          },
        };
      }
      if (name === 'credentials') return credentials;
      return undefined;
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
    '/plugins/dsh-feishu-only/qr',
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
  assert.equal(routes.length, 5);
  for (const dispose of disposers) dispose();
  assert.equal(routes.length, 0);
});