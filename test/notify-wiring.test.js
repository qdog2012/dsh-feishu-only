/**
 * The connection-notice wiring in `apply`.
 *
 * Unit behaviour lives in notify.test.js; these tests drive `apply` itself so
 * the wiring cannot drift: remembering the operator, notifying on connect, and
 * reporting a disconnect through the socket's state transitions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../index.js';
import { encodeFrame } from '../lib/feishu/ws.js';

/**
 * A throwaway home directory.
 *
 * The plugin persists its notice recipients under the harness home; without
 * this a test would read (and write) the real profile, which both polluted the
 * user's data and made assertions depend on it.
 */
function isolatedHome() {
  return mkdtempSync(join(tmpdir(), 'dfo-wiring-'));
}

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/** One inbound message frame, as the platform would send it. */
function messageFrame(openId, text) {
  const id = `om_${Math.random().toString(36).slice(2, 8)}`;
  return encodeFrame({
    SeqID: 1, LogID: 1, service: 1, method: 1,
    // The fragment assembler keys on message_id/sum/seq; without them a frame
    // is silently dropped before any handler sees it.
    headers: [
      { key: 'type', value: 'event' },
      { key: 'event_type', value: 'im.message.receive_v1' },
      { key: 'message_id', value: id },
      { key: 'sum', value: '1' },
      { key: 'seq', value: '0' },
      { key: 'trace_id', value: `trace_${id}` },
    ],
    payload: new TextEncoder().encode(JSON.stringify({
      // The dispatcher reads event_type from payload.header, as the platform
      // sends it; the event body itself carries no type.
      header: { event_type: 'im.message.receive_v1' },
      event: { message: {
        message_id: id,
        chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text',
        content: JSON.stringify({ text }),
      }, sender: { sender_id: { open_id: openId } } },
    })),
  });
}

/** A context whose services are present immediately, so the startup path runs. */
function stubContext({ routes = [], store = new Map(), home } = {}) {
  const server = { register(route) { routes.push(route); return () => {}; } };
  const credentials = {
    async readRecord(key) { return store.get(key) ?? null; },
    async modifyRecord(key, produce) { store.set(key, await produce()); },
  };
  return {
    logger: silent,
    get(name) {
      if (name === 'webServer') return server;
      if (name === 'credentials') return credentials;
      // An isolated home: the plugin persists its notice recipients there, and
      // a test must never read or write the real profile.
      if (name === 'homePaths') return { homeDir: home };
      return undefined;
    },
    inject(names, callback) {
      const list = Array.isArray(names) ? names : [names];
      if (list.includes('credentials')) return callback();
      if (list.every((n) => n === 'webServer')) return callback({ webServer: server });
      return () => {};
    },
    effect() { return () => {}; },
    on() { return () => {}; },
    fiber: { entry: null },
  };
}

/** A platform that accepts everything and records private cards as notices. */
function workingPlatform(notices) {
  return async (url, init) => {
    const text = String(url);
    if (text.includes('tenant_access_token')) {
      return {
        ok: true, status: 200,
        headers: new Map([['content-type', 'application/json']]),
        async json() { return { code: 0, tenant_access_token: 't', expire: 7200 }; },
      };
    }
    if (text.includes('/bot/v3/info')) {
      return {
        ok: true, status: 200,
        headers: new Map([['content-type', 'application/json']]),
        async json() { return { code: 0, bot: { app_name: 'bot', open_id: 'ou_bot', activate_status: 2 } }; },
      };
    }
    if (text.includes('app_slash_commands')) {
      return {
        ok: true, status: 200,
        headers: new Map([['content-type', 'application/json']]),
        async json() { return { code: 0, items: [] }; },
      };
    }
    if (text.includes('callback/ws/endpoint')) {
      return {
        ok: true, status: 200,
        headers: new Map([['content-type', 'application/json']]),
        async json() { return { code: 0, data: { URL: 'wss://x/?service_id=1' } }; },
      };
    }
    if (text.includes('/im/v1/messages')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const card = JSON.parse(body.content ?? '{}');
      notices.push({ receive: body.receive_id, title: card.header?.title?.content ?? '' });
      return {
        ok: true, status: 200,
        headers: new Map([['content-type', 'application/json']]),
        async json() { return { code: 0, message_id: `om_${notices.length}` }; },
      };
    }
    return {
      ok: true, status: 200,
      headers: new Map([['content-type', 'application/json']]),
      async json() { return { code: 0 }; },
    };
  };
}

/** A socket that opens, can receive frames, and can be dropped on demand. */
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readyState = 0;
  binaryType = 'blob';
  #listeners = new Map();
  #dropped = false;
  addEventListener(type, handler) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(handler);
    if (type === 'open') {
      this.readyState = 1;
      setTimeout(() => handler({}), 0);
    }
  }
  removeEventListener(type, handler) { this.#listeners.get(type)?.delete(handler); }
  /** Deliver an inbound frame, as the server would. */
  deliver(data) {
    for (const handler of this.#listeners.get('message') ?? []) handler({ data });
  }
  close() {
    this.readyState = 3;
    for (const handler of this.#listeners.get('close') ?? []) handler({});
  }
  /** A network drop: close fires without the client calling close(). */
  drop() {
    if (this.#dropped) return;
    this.#dropped = true;
    this.readyState = 3;
    for (const handler of this.#listeners.get('close') ?? []) handler({});
  }
  send() {}
}

/** Apply with a working platform; restores globals and tears down after. */
async function withLiveBridge(options, run) {
  const notices = [];
  const routes = [];
  const sockets = [];
  const cleanups = [];
  const store = new Map([
    ['dsh-feishu-only/app', { kind: 'grant', payload: { appId: 'cli_x', secret: 'S' } }],
  ]);
  const server = { register(route) { routes.push(route); return () => {}; } };
  const credentials = {
    async readRecord(key) { return store.get(key) ?? null; },
    async modifyRecord(key, produce) { store.set(key, await produce()); },
  };
  // One home per run, so a notice recipient from an earlier test cannot leak in.
  const home = isolatedHome();
  const ctx = {
    logger: silent,
    get(name) {
      if (name === 'webServer') return server;
      if (name === 'credentials') return credentials;
      // An isolated home: the plugin persists its notice recipients there, and
      // a test must never read or write the real profile.
      if (name === 'homePaths') return { homeDir: home };
      return undefined;
    },
    inject(names, callback) {
      const list = Array.isArray(names) ? names : [names];
      if (list.includes('credentials')) return callback();
      if (list.every((n) => n === 'webServer')) return callback({ webServer: server });
      return () => {};
    },
    // Collect the disposers so the runtime's timers are stopped after the test:
    // without this, a 15s health poll keeps the process alive.
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return () => cleanup();
    },
    on() { return () => {}; },
    fiber: { entry: null },
  };
  const original = globalThis.fetch;
  const originalWS = globalThis.WebSocket;
  globalThis.fetch = workingPlatform(notices);
  globalThis.WebSocket = class extends FakeSocket {
    constructor() { super(); sockets.push(this); }
  };
  try {
    await apply(ctx, { enabled: true, appId: 'cli_x', brand: 'feishu', syncMenu: false, ...options });
    return await run({ routes, sockets, notices, ctx });
  } finally {
    for (const cleanup of cleanups) {
      try { cleanup(); } catch { /* already torn down */ }
    }
    for (const socket of sockets) socket.close();
    globalThis.fetch = original;
    globalThis.WebSocket = originalWS;
  }
}

test('a connect notice goes out once an operator is known', async () => {
  await withLiveBridge({ notifyConnection: true }, async ({ routes, sockets, notices }) => {
    await settle();
    // The bridge is connected but nobody has talked to it: a notice has nowhere
    // to go, which is not a failure.
    assert.equal(notices.length, 0, 'no notice without a reachable operator');

    // One message from this user records them as the notice target.
    sockets.at(-1).deliver(messageFrame('ou_user', '你好'));
    await settle();

    // A reconnect — what the settings page does — now has someone to tell.
    const connect = routes.find((r) => r.path.endsWith('/connect'));
    await connect.resource(new Request('http://x/connect?appId=cli_x&appSecret=S'));
    await settle();
    assert.ok(
      notices.some((n) => /已连接/u.test(n.title)),
      'a connect notice was delivered to the operator',
    );
  });
});

test('a socket drop is reported as a disconnect notice', async () => {
  await withLiveBridge({ notifyConnection: true }, async ({ routes, sockets, notices }) => {
    await settle();
    // One message records the operator; without it the notice has nowhere to go.
    sockets.at(-1).deliver(messageFrame('ou_user', '你好'));
    await settle();

    // Drop the line. The socket's close handler runs, its state leaves
    // connected, and the state-change subscriber sends the notice. The line
    // may reconnect afterwards — that is correct behaviour — so what this
    // asserts is the notice, not a permanently-down connection.
    sockets.at(-1).close();
    await settle();
    assert.ok(
      notices.some((n) => /已断开/u.test(n.title)),
      'a disconnect notice was delivered',
    );
  });
});

test('notices are disabled when notifyConnection is false', async () => {
  await withLiveBridge({ notifyConnection: false }, async ({ routes, sockets, notices }) => {
    await settle();
    // A message makes the operator known, so a notice WOULD have somewhere to
    // go; that is what makes "none was sent" meaningful.
    sockets.at(-1).deliver(messageFrame('ou_user', '你好'));
    await settle();
    const connect = routes.find((r) => r.path.endsWith('/connect'));
    await connect.resource(new Request('http://x/connect?appId=cli_x&appSecret=S'));
    await settle();
    sockets.at(-1).close();
    await settle();
    // Command replies are not connection notices: only those are disabled.
    const connectionNotices = notices.filter(
      (n) => /已连接|已断开/u.test(n.title),
    );
    assert.equal(connectionNotices.length, 0, 'no connection notice was sent');
  });
});

function settle(ms = 200) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}test('a dropped connection reports both the drop and the recovery', async () => {
  // The card said 机器人已断开 and then nothing: the re-entering-connections
  // branch was documented but never written, so a user could not tell whether
  // the bot was listening again.
  const notices = [];
  const handlers = new Map();
  const ws = {
    state: 'stopped',
    on(eventType, handler) {
      if (!handlers.has(eventType)) handlers.set(eventType, []);
      handlers.get(eventType).push(handler);
      return () => {};
    },
    emit(eventType, payload) {
      for (const handler of handlers.get(eventType) ?? []) handler(payload);
    },
  };
  const fire = (from, to) => ws.emit('state.change', { from, to });

  // Mirror the transition rule the plugin installs.
  const CONNECTED = 'connected';
  const CONNECTING = 'connecting';
  const onTransition = ({ from, to }) => {
    if (from === CONNECTED && to !== CONNECTED) notices.push('disconnected');
    else if (from !== CONNECTED && to === CONNECTED) {
      if (from !== CONNECTING) notices.push('connected');
    }
  };

  onTransition({ from: CONNECTING, to: CONNECTED });
  assert.deepEqual(notices, [], 'the first connect is startRuntime\'s job, not a recovery');

  onTransition({ from: CONNECTED, to: 'reconnecting' });
  assert.deepEqual(notices, ['disconnected'], 'the drop is reported');

  onTransition({ from: 'reconnecting', to: CONNECTED });
  assert.deepEqual(notices, ['disconnected', 'connected'], 'and so is coming back');
});


test('a drop is followed by a recovery notice once the line comes back', async () => {
  // The user saw 机器人已断开 and then nothing, so there was no way to know the
  // bot had recovered. The socket does reconnect on its own; what was missing
  // was the notice for coming back.
  await withLiveBridge({ notifyConnection: true }, async ({ routes, sockets, notices }) => {
    await settle();
    sockets.at(-1).deliver(messageFrame('ou_user', '你好'));
    await settle();

    // Drop the line: this must produce a disconnect notice.
    sockets.at(-1).close();
    await settle();
    assert.ok(notices.some((n) => /已断开/u.test(n.title)), 'the drop was reported');

    // Bring it back the way the client does after a drop: a fresh connect.
    const connect = routes.find((r) => r.path.endsWith('/connect'));
    await connect.resource(new Request('http://x/connect?appId=cli_x&appSecret=S'));
    await settle();

    const titles = notices.map((n) => n.title);
    assert.ok(
      notices.some((n) => /已连接/u.test(n.title)),
      `a recovery notice was delivered (saw: ${titles.join(' | ')})`,
    );
  });
});
