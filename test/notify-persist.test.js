/**
 * Connection notices must survive a restart.
 *
 * Two faults made them useless in practice:
 *
 * - the recipient list lived only in memory, so the "connected" notice at
 *   startup had nobody to go to — the one moment a notice matters most;
 * - a restart kills the process without closing the socket, so the disconnect
 *   notice was never sent at all.
 *
 * These tests pin both.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../index.js';
import { encodeFrame } from '../lib/feishu/ws.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/** A context whose home is a temp dir, so persistence is observable. */
function makeHome() {
  return mkdtempSync(join(tmpdir(), 'dfo-home-'));
}

function stubContext({ routes = [], store = new Map(), home } = {}) {
  const server = { register(route) { routes.push(route); return () => {}; } };
  const credentials = {
    async readRecord(key) { return store.get(key) ?? null; },
    async modifyRecord(key, produce) { store.set(key, await produce()); },
  };
  const cleanups = [];
  return {
    routes,
    cleanups,
    logger: silent,
    get(name) {
      if (name === 'webServer') return server;
      if (name === 'credentials') return credentials;
      if (name === 'homePaths') return { homeDir: home };
      return undefined;
    },
    inject(names, callback) {
      const list = Array.isArray(names) ? names : [names];
      if (list.includes('credentials')) return callback();
      if (list.every((n) => n === 'webServer')) return callback({ webServer: server });
      return () => {};
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return () => cleanup();
    },
    on() { return () => {}; },
    fiber: { entry: null },
  };
}

/** A platform that records every private card. */
function platform(notices) {
  return async (url, init) => {
    const text = String(url);
    const json = (body) => ({
      ok: true, status: 200,
      headers: new Map([['content-type', 'application/json']]),
      async json() { return body; },
    });
    if (text.includes('tenant_access_token')) return json({ code: 0, tenant_access_token: 't', expire: 7200 });
    if (text.includes('/bot/v3/info')) return json({ code: 0, bot: { app_name: 'bot', activate_status: 2 } });
    if (text.includes('app_slash_commands')) return json({ code: 0, items: [] });
    if (text.includes('callback/ws/endpoint')) return json({ code: 0, data: { URL: 'wss://x/?service_id=1' } });
    if (text.includes('/im/v1/messages')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const card = JSON.parse(body.content ?? '{}');
      notices.push({ receive: body.receive_id, title: card.header?.title?.content ?? '' });
      return json({ code: 0, message_id: `om_${notices.length}` });
    }
    return json({ code: 0 });
  };
}

/** A socket that opens and can be dropped. */
class FakeSocket {
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
  removeEventListener(type, handler) { this.#listeners.get(type)?.delete(handler); }
  deliver(data) {
    for (const handler of this.#listeners.get('message') ?? []) handler({ data });
  }
  close() {
    this.readyState = 3;
    for (const handler of this.#listeners.get('close') ?? []) handler({});
  }
  send() {}
}

/** One inbound message frame. */
function messageFrame(openId, text) {
  const id = `om_${Math.random().toString(36).slice(2, 8)}`;
  return encodeFrame({
    SeqID: 1, LogID: 1, service: 1, method: 1,
    headers: [
      { key: 'type', value: 'event' },
      { key: 'event_type', value: 'im.message.receive_v1' },
      { key: 'message_id', value: id },
      { key: 'sum', value: '1' },
      { key: 'seq', value: '0' },
      { key: 'trace_id', value: `t_${id}` },
    ],
    payload: new TextEncoder().encode(JSON.stringify({
      header: { event_type: 'im.message.receive_v1' },
      event: {
        message: {
          message_id: id, chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text',
          content: JSON.stringify({ text }),
        },
        sender: { sender_id: { open_id: openId } },
      },
    })),
  });
}

/** Run apply against a working platform, then tear it down. */
async function run({ home, store, run: body }) {
  const notices = [];
  const routes = [];
  const sockets = [];
  const store2 = store ?? new Map([
    ['dsh-feishu-only/app', { kind: 'grant', payload: { appId: 'cli_x', secret: 'S' } }],
  ]);
  const ctx = stubContext({ routes, store: store2, home });
  const originalFetch = globalThis.fetch;
  const originalWS = globalThis.WebSocket;
  globalThis.fetch = platform(notices);
  globalThis.WebSocket = class extends FakeSocket {
    constructor() { super(); sockets.push(this); }
  };
  try {
    await apply(ctx, { enabled: true, appId: 'cli_x', brand: 'feishu', syncMenu: false });
    return await body({ ctx, routes, sockets, notices, store: store2 });
  } finally {
    for (const cleanup of ctx.cleanups) {
      try { cleanup(); } catch { /* already down */ }
    }
    for (const socket of sockets) socket.close();
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWS;
  }
}

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

test('an operator is remembered on disk, so a restart can still notify them', async () => {
  const home = makeHome();
  await run({
    home,
    run: async ({ sockets }) => {
      await settle();
      sockets.at(-1).deliver(messageFrame('ou_user', '你好'));
      await settle();
    },
  });
  const file = join(home, 'feishu-only.operators.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(saved.operators.ou_user, 'the operator survived the process');
  assert.ok(Number.isFinite(saved.operators.ou_user.lastSeen));
});

test('the connected notice reaches an operator remembered from a previous run', async () => {
  // This is the case that mattered: a fresh process connects before anyone has
  // spoken to it, and must still be able to say "I am back".
  const home = makeHome();
  writeFileSync(
    join(home, 'feishu-only.operators.json'),
    JSON.stringify({ version: 1, operators: { ou_known: { lastSeen: Date.now() - 1000 } } }),
    'utf8',
  );
  await run({
    home,
    run: async ({ notices }) => {
      await settle(400);
      assert.ok(
        notices.some((n) => n.receive === 'ou_known' && /已连接/u.test(n.title)),
        'the startup notice was delivered to the remembered operator',
      );
    },
  });
});

test('an unreadable operator file does not break the launch', async () => {
  const home = makeHome();
  writeFileSync(join(home, 'feishu-only.operators.json'), 'not json at all', 'utf8');
  await run({
    home,
    run: async ({ routes, notices }) => {
      await settle(300);
      // The bridge still started and connected; only the notice target is lost.
      assert.equal(notices.length, 0, 'no notice without a readable recipient');
      assert.ok(routes.length > 0, 'the plugin is up');
    },
  });
});

test('the exit hook is registered and removed with the plugin', async () => {
  const home = makeHome();
  const before = process.listenerCount('beforeExit');
  const signalsBefore = process.listenerCount('SIGTERM');
  await run({
    home,
    run: async ({ ctx }) => {
      await settle(200);
      assert.equal(process.listenerCount('beforeExit'), before + 1, 'beforeExit is hooked');
      assert.equal(process.listenerCount('SIGTERM'), signalsBefore + 1, 'SIGTERM is hooked');
      for (const cleanup of ctx.cleanups) {
        try { cleanup(); } catch { /* already down */ }
      }
      ctx.cleanups.length = 0;
      assert.equal(process.listenerCount('SIGTERM'), signalsBefore, 'and removed on teardown');
    },
  });
});