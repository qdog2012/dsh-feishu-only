/**
 * Diagnostics tests.
 *
 * The value of a diagnostic is not that it can report success — it is that it
 * names the *first broken layer* and the action that fixes it. These tests
 * drive each layer into failure in turn, because a report that blames the wrong
 * layer is worse than no report at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CHECK, LAYERS, diagnose } from '../lib/diagnostics.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** Replace `fetch` for the duration of one call, recording every request. */
async function withFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const record = { url: String(url), init };
    calls.push(record);
    return handler(record, calls.length);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['content-type', 'application/json']]),
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

/** A WebSocket implementation that opens but never sends anything. */
function silentSocket() {
  return class {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    readyState = 0;
    binaryType = 'blob';
    #listeners = new Map();
    addEventListener(type, handler) {
      if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
      this.#listeners.get(type).add(handler);
      if (type === 'open') {
        this.readyState = 1;
        setTimeout(() => handler({}), 0);
      }
    }
    removeEventListener(type, handler) {
      this.#listeners.get(type)?.delete(handler);
    }
    close() {
      this.readyState = 3;
    }
    send() {}
  };
}

test('missing credentials fail the first layer and stop there', async () => {
  // Probing further with no token would produce a wall of derived failures.
  const report = await diagnose({ logger: quiet });
  assert.equal(report.ok, false);
  assert.equal(report.focus.layer, 'credentials');
  assert.match(report.focus.detail, /缺少/u);
  assert.equal(report.checks.length, 1, 'no later layer is attempted');
});

test('a rejected secret names the credential layer with the platform code', async () => {
  await withFetch(
    () => jsonResponse({ code: 10003, msg: 'invalid param' }),
    async () => {
      const report = await diagnose({ appId: 'cli_x', appSecret: 'bad', logger: quiet });
      assert.equal(report.focus.layer, 'credentials');
      assert.match(report.focus.detail, /10003/u);
      assert.match(report.focus.hint, /App ID/u);
    },
  );
});

test('a missing secret is distinguished from a wrong one', async () => {
  const report = await diagnose({ appId: 'cli_x', logger: quiet });
  assert.equal(report.focus.layer, 'credentials');
  assert.match(report.focus.detail, /App Secret/u);
});

test('a working credential moves the failure to the next real problem', async () => {
  await withFetch(
    (request) => {
      if (request.url.includes('tenant_access_token')) {
        return jsonResponse({
          code: 0,
          tenant_access_token: 't-1',
          expire: 7200,
        });
      }
      if (request.url.includes('/bot/v3/info')) {
        return jsonResponse({ code: 0, bot: { app_name: '测试机器人', activate_status: 2 } });
      }
      if (request.url.includes('app_slash_commands')) {
        return jsonResponse({ code: 99991672, msg: 'Access denied. scopes required' });
      }
      return jsonResponse({ code: 0 });
    },
    async () => {
      const report = await diagnose({ appId: 'cli_x', appSecret: 'ok', logger: quiet });
      const byLayer = Object.fromEntries(report.checks.map((check) => [check.layer, check]));
      assert.equal(byLayer.credentials.verdict, CHECK.OK);
      assert.equal(byLayer.app.verdict, CHECK.OK);
      // The menu permission is a warning, not the reason the bot is silent.
      assert.equal(byLayer.menu.verdict, CHECK.WARNING);
      assert.match(byLayer.menu.detail, /指令/u);
    },
  );
});

test('a socket that cannot open fails the socket layer', async () => {
  await withFetch(
    (request) => {
      if (request.url.includes('tenant_access_token')) {
        return jsonResponse({ code: 0, tenant_access_token: 't-1', expire: 7200 });
      }
      if (request.url.includes('/bot/v3/info')) {
        return jsonResponse({ code: 0, bot: { app_name: 'b', activate_status: 2 } });
      }
      if (request.url.includes('app_slash_commands')) {
        return jsonResponse({ code: 0, items: [] });
      }
      // Endpoint discovery succeeds, the socket is what fails.
      return jsonResponse({ code: 0, data: { URL: 'wss://example.invalid/?service_id=1' } });
    },
    async () => {
      const report = await diagnose({
        appId: 'cli_x',
        appSecret: 'ok',
        logger: quiet,
        WebSocketImpl: class {
          static OPEN = 1;
          static CONNECTING = 0;
          readyState = 0;
          addEventListener(type, handler) {
            if (type === 'error') setTimeout(() => handler({}), 0);
          }
          close() {}
          send() {}
        },
      });
      const socket = report.checks.find((check) => check.layer === 'socket');
      assert.equal(socket.verdict, CHECK.FAILED);
      assert.match(report.focus.hint, /长连接/u);
    },
  );
});

test('a socket that opens but stays silent is a warning, not a pass', async () => {
  // "Connected" alone does not prove events flow; saying OK here would hide the
  // exact fault this diagnostic exists to find.
  await withFetch(
    (request) => {
      if (request.url.includes('tenant_access_token')) {
        return jsonResponse({ code: 0, tenant_access_token: 't-1', expire: 7200 });
      }
      if (request.url.includes('/bot/v3/info')) {
        return jsonResponse({ code: 0, bot: { app_name: 'b', activate_status: 2 } });
      }
      if (request.url.includes('app_slash_commands')) {
        return jsonResponse({ code: 0, items: [] });
      }
      return jsonResponse({ code: 0, data: { URL: 'wss://example.invalid/?service_id=1' } });
    },
    async () => {
      const report = await diagnose({
        appId: 'cli_x',
        appSecret: 'ok',
        logger: quiet,
        WebSocketImpl: silentSocket(),
      });
      const socket = report.checks.find((check) => check.layer === 'socket');
      assert.equal(socket.verdict, CHECK.WARNING);
      assert.match(socket.detail, /没有收到/u);
    },
  );
});

test('the harness layer is reported even when the network layers fail', async () => {
  const report = await diagnose({
    appId: 'cli_x',
    appSecret: 'ok',
    logger: quiet,
    harness: { available: { agents: false, sessions: true } },
  });
  const capabilities = report.checks.find((check) => check.layer === 'capabilities');
  assert.ok(capabilities, 'the local capability is always probed');
  assert.equal(capabilities.verdict, CHECK.FAILED);
});

test('every layer in a report has a name and a known verdict', async () => {
  const report = await diagnose({ logger: quiet });
  for (const check of report.checks) {
    assert.ok(LAYERS.some((layer) => layer.key === check.layer), `${check.layer} is declared`);
    assert.ok(typeof check.name === 'string' && check.name.length > 0, 'has a display name');
    assert.ok(
      [CHECK.OK, CHECK.FAILED, CHECK.SKIPPED, CHECK.WARNING].includes(check.verdict),
      `${check.verdict} is a known verdict`,
    );
  }
});

test('the focus is a failure before any warning', async () => {
  const report = await diagnose({
    appId: 'cli_x',
    appSecret: 'ok',
    logger: quiet,
    harness: { available: { agents: true, sessions: true } },
  });
  if (report.focus) {
    const verdicts = report.checks.map((check) => check.verdict);
    if (verdicts.includes(CHECK.FAILED)) {
      assert.equal(report.focus.verdict, CHECK.FAILED, 'a failure outranks a warning');
    }
  }
});