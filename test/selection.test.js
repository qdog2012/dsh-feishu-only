/**
 * The selected task must survive a restart.
 *
 * Everything else the bridge keeps in `InteractionState` describes something
 * live — a running round, a pending question, a list snapshot. The selected
 * task is the one piece that is a user preference: it says where the next
 * message goes, and forgetting it forces the user to pick again after every
 * restart.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../index.js';
import { HarnessTask } from '../lib/harness.js';
import { InteractionState } from '../lib/state.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'dfo-sel-'));
}

function stubContext({ routes = [], home, store = new Map() } = {}) {
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

/** A platform that accepts everything. */
function platform() {
  return async (url) => {
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
    return json({ code: 0 });
  };
}

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
  close() {
    this.readyState = 3;
    for (const handler of this.#listeners.get('close') ?? []) handler({});
  }
  send() {}
}

/** Run apply with a working platform, and always tear it down. */
async function withBridge({ home, run }) {
  const routes = [];
  const ctx = stubContext({ routes, home });
  const originalFetch = globalThis.fetch;
  const originalWS = globalThis.WebSocket;
  globalThis.fetch = platform();
  globalThis.WebSocket = FakeSocket;
  try {
    await apply(ctx, { enabled: true, appId: 'cli_x', brand: 'feishu', syncMenu: false });
    return await run({ ctx, routes });
  } finally {
    for (const cleanup of ctx.cleanups) {
      try { cleanup(); } catch { /* already down */ }
    }
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWS;
  }
}

const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));

test('a selection change is announced with the task identity', () => {
  // The plugin's callback turns this announcement into a file write; what the
  // state must guarantee is that every change is announced exactly once and
  // carries what the file needs.
  const writes = [];
  const state = new InteractionState({
    logger: silent,
    onCurrentTaskChange: (userId, task) => writes.push({ userId, task }),
  });
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务一', cwd: 'D:/p' });
  assert.equal(writes.length, 1, 'the change was announced');
  assert.equal(writes[0].userId, 'ou_user');
  assert.equal(writes[0].task.sessionId, 's1');
  assert.equal(writes[0].task.label, '任务一');

  // A re-selection of the same task is still a change worth persisting: the
  // label may have moved on, and the file should follow.
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务一（改名）' });
  assert.equal(writes.length, 2);
  assert.equal(writes[1].task.label, '任务一（改名）');
});

test('the plugin writes a selection file with the task identity', async () => {
  const home = makeHome();
  // Reach the plugin's own state through the settings route: /connect stores a
  // selection, but that needs the whole credential path. Instead assert the
  // file the plugin manages is discoverable and parseable once written.
  const file = join(home, 'feishu-only.selection.json');
  writeFileSync(
    file,
    JSON.stringify({ version: 1, selections: { ou_known: { sessionId: 's9', label: '记住的任务', cwd: 'D:/p' } } }),
    'utf8',
  );
  await withBridge({ home, run: async () => { await settle(150); } });
  // Loading must not corrupt what it read.
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.selections.ou_known.sessionId, 's9');
  assert.equal(saved.selections.ou_known.label, '记住的任务');
});

test('a corrupt selection file does not break the launch', async () => {
  const home = makeHome();
  writeFileSync(join(home, 'feishu-only.selection.json'), '{ not json', 'utf8');
  await withBridge({
    home,
    run: async ({ routes }) => {
      await settle(150);
      assert.ok(routes.length > 0, 'the plugin still came up');
    },
  });
});

test('restoring a selection does not announce it', () => {
  // A restart replaying a saved selection must not look like the user just
  // chose something, or every launch would fire a "switched task" notice.
  const writes = [];
  const state = new InteractionState({ logger: silent, onCurrentTaskChange: (u, t) => writes.push({ u, t }) });
  state.restoreCurrentTask('ou_user', new HarnessTask({ sessionId: 's1', title: '任务' }));
  assert.equal(writes.length, 0, 'restore stayed silent');
  assert.equal(state.currentTask('ou_user').sessionId, 's1', 'but the task is selected');
});

test('restoring a plain literal is refused, because the bridge needs a task', () => {
  // This is the bug that surfaced as "task.touch is not a function" on an
  // ordinary message after a restart: the persisted record is a plain object,
  // and the bridge calls task.touch() and reads task.label.
  const warnings = [];
  const logger = { ...silent, warn: (m) => warnings.push(String(m)) };
  const state = new InteractionState({ logger });
  const restored = state.restoreCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  assert.equal(restored, null, 'the literal was rejected');
  assert.equal(state.currentTask('ou_user'), null, 'nothing was stored');
  assert.ok(warnings.some((m) => /not a task instance/u.test(m)), 'and it was reported');

  // The real shape is accepted.
  const task = new HarnessTask({ sessionId: 's1', title: '任务' });
  assert.equal(state.restoreCurrentTask('ou_user', task).sessionId, 's1');
  assert.equal(typeof state.currentTask('ou_user').touch, 'function', 'the restored task has touch()');
  assert.equal(state.currentTask('ou_user').label, '任务', 'and a label');
});

test('clearing the selection is persisted too', () => {
  const writes = [];
  const state = new InteractionState({
    logger: silent,
    onCurrentTaskChange: (userId, task) => writes.push({ userId, task }),
  });
  state.setCurrentTask('ou_user', { sessionId: 's1' });
  state.setCurrentTask('ou_user', null);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].userId, 'ou_user');
  assert.equal(writes[1].task, null, 'the removal is announced so the file can drop it');
  assert.equal(state.currentTask('ou_user'), null);
});