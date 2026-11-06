import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeFrame, decodeFrame, FeishuLongConnection } from '../lib/feishu/ws.js';
import { FeishuBridge } from '../lib/bridge.js';
import { InteractionState } from '../lib/state.js';

/**
 * End-to-end from the wire to the bridge.
 *
 * Every other test starts from a JS object; this one starts from the bytes a
 * Feishu server actually sends — a pbbp2 frame carrying a JSON event — so the
 * frame codec, the fragment assembler, the dispatcher and the bridge are proven
 * to agree on the same contract.
 */

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/** A WebSocket stand-in that lets a test push inbound frames. */
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  sent = [];
  #listeners = new Map();

  addEventListener(name, handler) {
    const set = this.#listeners.get(name) ?? new Set();
    set.add(handler);
    this.#listeners.set(name, set);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.#emit('close', {});
  }

  /** Simulate a successful handshake. */
  open() {
    this.readyState = 1;
    this.#emit('open', {});
  }

  /** Deliver one inbound binary frame. */
  deliver(frame) {
    this.#emit('message', { data: frame });
  }

  #emit(name, event) {
    for (const handler of this.#listeners.get(name) ?? []) handler(event);
  }
}

/** A recording Feishu API. */
class FakeApi {
  cards = [];
  texts = [];

  async sendCard(chatId, payload) {
    this.cards.push({ chatId, payload });
    return { message_id: `om_${this.cards.length}` };
  }

  async sendText(chatId, text) {
    this.texts.push({ chatId, text });
    return {};
  }

  async patchCard() {
    return { ok: true };
  }

  async sendPrivateCard(openId, payload) {
    this.cards.push({ chatId: openId, payload });
    return { message_id: 'om_p' };
  }

  async downloadResource() {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    return { data: new Uint8Array(png), contentType: 'image/png' };
  }
}

/** A minimal harness whose only task is the one the test creates. */
class FakeHarness {
  available = { agents: true, sessions: true };
  prompts = [];

  agent(id) {
    return { id };
  }

  async listTasks() {
    return { ok: true, value: [] };
  }

  async createTask({ chatId }) {
    return { ok: true, value: `feishu-${chatId}` };
  }

  async taskState() {
    return { ok: true, value: { running: false } };
  }

  async prompt(sessionId, content, options) {
    this.prompts.push({ sessionId, content, options });
    return { ok: true, value: { accepted: true } };
  }

  goalOf() {
    return null;
  }

  permissionOf() {
    return null;
  }

  modelOf() {
    return null;
  }

  async lastReply() {
    return { ok: true, value: null };
  }

  history() {
    return { ok: true, value: [] };
  }

  async listSkills() {
    return { ok: true, value: [] };
  }
}

/** Build the JSON body a `im.message.receive_v1` frame carries. */
function messageEventBody({ messageId = 'om_wire_1', text = '/help', chatType = 'p2p' } = {}) {
  return {
    schema: '2.0',
    header: {
      event_id: 'ev_1',
      event_type: 'im.message.receive_v1',
      create_time: String(Date.now()),
      token: '',
      app_id: 'cli_x',
      tenant_key: 'tk',
    },
    event: {
      sender: { sender_id: { open_id: 'ou_wire' }, sender_type: 'user', tenant_key: 'tk' },
      message: {
        message_id: messageId,
        chat_id: 'oc_wire',
        chat_type: chatType,
        message_type: 'text',
        content: JSON.stringify({ text }),
        mentions: [],
        create_time: String(Date.now()),
      },
    },
  };
}

/** Wrap an event body in one pbbp2 data frame. */
function eventFrame(body, { seq = 0, sum = 1, messageId = 'frame_1' } = {}) {
  return encodeFrame({
    SeqID: 0,
    LogID: 0,
    service: 12345,
    method: 1,
    headers: [
      { key: 'type', value: 'event' },
      { key: 'message_id', value: messageId },
      { key: 'sum', value: String(sum) },
      { key: 'seq', value: String(seq) },
      { key: 'trace_id', value: 'trace_1' },
    ],
    payload: new TextEncoder().encode(JSON.stringify(body)),
  });
}

/**
 * Wire a connection, socket and bridge together exactly as the plugin does.
 *
 * The returned `dispose` releases the connection: its keepalive timer would
 * otherwise hold the test process open, which is also the guarantee a real
 * unload depends on.
 */
async function wire(t) {
  const socket = new FakeSocket();
  const api = new FakeApi();
  const harness = new FakeHarness();
  const state = new InteractionState({ logger: silent });

  const bridge = new FeishuBridge({
    ctx: {
      get: () => undefined,
      logger: silent,
    },
    config: {
      version: '0.1.0',
      groupRequireMention: true,
      rejectInputWhileRunning: true,
    },
    api,
    state,
    harness,
    logger: silent,
    interactions: { install: () => () => {} },
    preview: null,
  });

  const connection = new FeishuLongConnection({
    appId: 'cli_x',
    appSecret: 'secret',
    fetchImpl: async (url) => {
      if (String(url).includes('/callback/ws/endpoint')) {
        return {
          ok: true,
          json: async () => ({
            code: 0,
            data: {
              URL: 'wss://example.invalid/ws?device_id=d1&service_id=12345',
              ClientConfig: { PingInterval: 120, ReconnectCount: 3, ReconnectInterval: 5 },
            },
          }),
        };
      }
      return { ok: false, json: async () => ({ code: 1, msg: 'unexpected' }) };
    },
    WebSocketImpl: class {
      constructor() {
        // Hand back the shared fake so the test can drive it.
        queueMicrotask(() => socket.open());
        return socket;
      }
    },
    logger: silent,
  });

  connection.on('im.message.receive_v1', async ({ event }) => {
    await bridge.onMessage(event);
    return undefined;
  });

  await connection.start();
 t?.after?.(async () => {
    await connection.dispose();
    bridge.dispose();
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  return { connection, socket, api, harness, bridge, state, settle };
}

test('a real message frame reaches the bridge and produces a reply', async (t) => {
  const { socket, api, settle } = await wire(t);
  socket.deliver(eventFrame(messageEventBody({ text: '/help' })));
  await settle();
  assert.equal(api.cards.length, 1, 'the help card was sent in response to a real frame');
  assert.match(api.cards[0].chatId, /oc_wire/u);
});

test('the bridge acknowledges the frame back over the socket', async (t) => {
  const { socket, settle } = await wire(t);
  const sentBefore = socket.sent.length;
  socket.deliver(eventFrame(messageEventBody({ text: '/help' })));
  await settle();
  // The acknowledgement is a control-plane reply on the same socket.
  assert.ok(socket.sent.length > sentBefore, 'the frame was acknowledged');
});

test('a group message without a mention is dropped at the wire boundary too', async (t) => {
  const { socket, api, harness, settle } = await wire(t);
  socket.deliver(eventFrame(messageEventBody({ text: '日常聊天', chatType: 'group' })));
  await settle();
  assert.equal(api.cards.length, 0);
  assert.equal(harness.prompts.length, 0);
});

test('a fragmented event is reassembled before it is dispatched', async (t) => {
  const { socket, api, settle } = await wire(t);
  const body = messageEventBody({ text: '/status' });
  const json = JSON.stringify(body);
  const half = Math.floor(json.length / 2);

  // `sum: 2` means two frames carry one event; each half is not valid JSON.
  const bytes = new TextEncoder().encode(json);
  const first = encodeFrame({
    SeqID: 0, LogID: 0, service: 12345, method: 1,
    headers: [
      { key: 'type', value: 'event' },
      { key: 'message_id', value: 'frag_1' },
      { key: 'sum', value: '2' },
      { key: 'seq', value: '0' },
    ],
    payload: bytes.subarray(0, half),
  });
  const second = encodeFrame({
    SeqID: 0, LogID: 0, service: 12345, method: 1,
    headers: [
      { key: 'type', value: 'event' },
      { key: 'message_id', value: 'frag_1' },
      { key: 'sum', value: '2' },
      { key: 'seq', value: '1' },
    ],
    payload: bytes.subarray(half),
  });

  socket.deliver(first);
  await settle();
  assert.equal(api.cards.length, 0, 'half an event must not be dispatched');

  socket.deliver(second);
  await settle();
  assert.equal(api.cards.length, 1, 'the reassembled event is dispatched');
});

test('a control ping frame on the socket is handled without touching the bridge', async (t) => {
  const { socket, api, settle } = await wire(t);
  const ping = encodeFrame({
    SeqID: 0, LogID: 0, service: 12345, method: 0,
    headers: [{ key: 'type', value: 'ping' }],
  });
  socket.deliver(ping);
  await settle();
  assert.equal(api.cards.length, 0);
});

test('a malformed frame does not crash the connection', async (t) => {
  const { socket, api, settle } = await wire(t);
  socket.deliver(new Uint8Array([0xff, 0xff, 0xff]));
  await settle();
  assert.equal(api.cards.length, 0);
  // The connection must still work afterwards.
  socket.deliver(eventFrame(messageEventBody({ text: '/help', messageId: 'om_after' })));
  await settle();
  assert.equal(api.cards.length, 1);
});

test('a card action callback travels the same connection and returns a toast', async (t) => {
  const { connection, socket, settle } = await wire(t);
  const received = [];
  connection.on('card.action.trigger', async ({ event }) => {
    received.push(event);
    return { toast: { type: 'success', content: '已切换任务' } };
  });

  const body = {
    schema: '2.0',
    header: { event_id: 'ev_card', event_type: 'card.action.trigger', token: '', app_id: 'cli_x' },
    event: {
      operator: { open_id: 'ou_wire', user_id: 'u1' },
      action: { tag: 'button', value: { id: 'task.list' } },
      context: { open_message_id: 'om_card', open_chat_id: 'oc_wire' },
    },
  };
  socket.deliver(encodeFrame({
    SeqID: 0, LogID: 0, service: 12345, method: 1,
    headers: [
      { key: 'type', value: 'event' },
      { key: 'message_id', value: 'card_1' },
      { key: 'sum', value: '1' },
      { key: 'seq', value: '0' },
    ],
    payload: new TextEncoder().encode(JSON.stringify(body)),
  }));
  await settle();

  assert.equal(received.length, 1, 'the callback reached its handler');
  assert.equal(received[0].action.value.id, 'task.list');
  assert.equal(received[0].operator.open_id, 'ou_wire');

  // The acknowledgement the platform receives must carry the handler's toast,
  // because that is what the user sees after pressing the button. It is a
  // pbbp2 frame — binary protobuf, not JSON — so it is decoded as such.
  const acks = socket.sent
    .filter((bytes) => bytes instanceof Uint8Array)
    .map((bytes) => decodeFrame(bytes))
    .filter((frame) => frame.method === 1 && frame.payload?.length > 0);
  assert.ok(acks.length > 0, 'an acknowledgement frame was sent');

  const payload = JSON.parse(new TextDecoder().decode(acks.at(-1).payload));
  assert.equal(payload.code, 200);
  const decoded = JSON.parse(Buffer.from(payload.data, 'base64').toString('utf8'));
  assert.deepEqual(decoded.toast, { type: 'success', content: '已切换任务' });
});