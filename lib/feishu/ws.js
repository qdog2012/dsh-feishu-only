/**
 * Feishu long-connection (WebSocket) transport.
 *
 * Feishu's long connection carries two independent subscriptions: events
 * (`im.message.receive_v1`, ...) and card callbacks (`card.action.trigger`).
 * Both arrive on the same socket, so one connection serves the whole bridge
 * and no public callback URL is required.
 *
 * The wire format is Feishu's `pbbp2.Frame` protobuf. Encoding is implemented
 * here rather than pulled from a protobuf runtime, because the message is tiny
 * and this keeps the plugin dependency-free:
 *
 *   message Frame {
 *     uint64  SeqID           = 1;
 *     uint64  LogID           = 2;
 *     int32   service         = 3;
 *     int32   method          = 4;
 *     repeated Header headers = 5;  // { string key = 1; string value = 2; }
 *     string  payloadEncoding = 6;
 *     string  payloadType     = 7;
 *     bytes   payload         = 8;
 *   }
 *
 * @module dsh-feishu-only/lib/feishu/ws
 */

import { originFor } from './api.js';

/** Frame `method` values; control frames are pings, data frames carry events. */
const FRAME_METHOD_CONTROL = 0;
const FRAME_METHOD_DATA = 1;

/** `type` header values inside a frame. */
const MESSAGE_TYPE_EVENT = 'event';
const MESSAGE_TYPE_PING = 'ping';
const MESSAGE_TYPE_PONG = 'pong';

const WS_ENDPOINT_PATH = '/callback/ws/endpoint';
const USER_AGENT = 'dsh-feishu-only/0.1 (+https://github.com/qdog2012/dsh-feishu-only)';

// ---------------------------------------------------------------- protobuf io

/** Encode one varint. */
function writeVarint(bytes, value) {
  let remaining = BigInt(value);
  if (remaining < 0n) remaining += 1n << 64n;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
}

function writeTag(bytes, field, wireType) {
  writeVarint(bytes, (field << 3) | wireType);
}

function writeBytesField(bytes, field, data) {
  writeTag(bytes, field, 2);
  writeVarint(bytes, data.length);
  for (const byte of data) bytes.push(byte);
}

function writeStringField(bytes, field, text) {
  writeBytesField(bytes, field, new TextEncoder().encode(text));
}

/** Encode a `pbbp2.Frame`. */
export function encodeFrame({
  SeqID = 0,
  LogID = 0,
  service = 0,
  method = FRAME_METHOD_DATA,
  headers = [],
  payload,
} = {}) {
  const bytes = [];
  // Fields 1-4 are non-optional in the platform schema, so they are written
  // even at their default value: that keeps this encoder byte-identical to the
  // reference implementation rather than merely semantically equivalent.
  writeTag(bytes, 1, 0);
  writeVarint(bytes, SeqID);
  writeTag(bytes, 2, 0);
  writeVarint(bytes, LogID);
  writeTag(bytes, 3, 0);
  writeVarint(bytes, service);
  writeTag(bytes, 4, 0);
  writeVarint(bytes, method);
  for (const header of headers) {
    const headerBytes = [];
    writeStringField(headerBytes, 1, header.key);
    writeStringField(headerBytes, 2, header.value);
    writeBytesField(bytes, 5, headerBytes);
  }
  if (payload) writeBytesField(bytes, 8, payload);
  return new Uint8Array(bytes);
}

class Reader {
  #buffer;
  #offset = 0;

  constructor(buffer) {
    this.#buffer = buffer;
  }

  get done() {
    return this.#offset >= this.#buffer.length;
  }

  varint() {
    let result = 0n;
    let shift = 0n;
    while (this.#offset < this.#buffer.length) {
      const byte = this.#buffer[this.#offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }
    return result;
  }

  tag() {
    const value = this.varint();
    return { field: Number(value >> 3n), wireType: Number(value & 7n) };
  }

  bytes() {
    const length = Number(this.varint());
    const slice = this.#buffer.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return slice;
  }

  skip(wireType) {
    switch (wireType) {
      case 0:
        this.varint();
        break;
      case 1:
        this.#offset += 8;
        break;
      case 2:
        this.bytes();
        break;
      case 5:
        this.#offset += 4;
        break;
      default:
        throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
  }
}

/** Decode a `pbbp2.Frame` into plain fields. */
export function decodeFrame(buffer) {
  const reader = new Reader(buffer);
  const frame = { SeqID: 0, LogID: 0, service: 0, method: 0, headers: [], payload: null };
  const decoder = new TextDecoder();
  while (!reader.done) {
    const { field, wireType } = reader.tag();
    switch (field) {
      case 1:
        frame.SeqID = Number(reader.varint());
        break;
      case 2:
        frame.LogID = Number(reader.varint());
        break;
      case 3:
        frame.service = Number(reader.varint());
        break;
      case 4:
        frame.method = Number(reader.varint());
        break;
      case 5: {
        const headerReader = new Reader(reader.bytes());
        const header = { key: '', value: '' };
        while (!headerReader.done) {
          const tag = headerReader.tag();
          if (tag.field === 1) header.key = decoder.decode(headerReader.bytes());
          else if (tag.field === 2) header.value = decoder.decode(headerReader.bytes());
          else headerReader.skip(tag.wireType);
        }
        frame.headers.push(header);
        break;
      }
      case 8:
        frame.payload = reader.bytes();
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }
  return frame;
}

function headerValue(frame, key) {
  return frame.headers.find((header) => header.key === key)?.value;
}

/**
 * Coerce one inbound WebSocket payload into bytes.
 *
 * A browser or Node WebSocket may deliver a binary frame as an ArrayBuffer, a
 * typed-array view, or a Blob depending on `binaryType`. Handling all three
 * here means a runtime that ignores the `binaryType` assignment still works.
 *
 * @param {unknown} raw the `event.data` value.
 * @returns {Promise<Uint8Array|null>}
 */
async function toBytes(raw) {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (typeof Blob !== 'undefined' && raw instanceof Blob) {
    return new Uint8Array(await raw.arrayBuffer());
  }
  if (typeof raw === 'string') return new TextEncoder().encode(raw);
  // Some implementations nest the payload under `data`.
  if (typeof raw === 'object' && 'data' in raw) return toBytes(raw.data);
  return null;
}

// -------------------------------------------------------------- fragment merge

/**
 * Reassemble events split across several frames.
 *
 * Long messages and cards arrive as `sum` fragments keyed by `message_id`;
 * each frame carries one `seq`. The merged payload is emitted only once every
 * fragment is present, and stale assemblies are dropped on a timer so a lost
 * fragment cannot pin memory.
 */
class FragmentAssembler {
  #pending = new Map();
  #ttlMs;
  #now;

  constructor({ ttlMs = 60_000, now = Date.now } = {}) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  /**
   * Add one fragment.
   *
   * @returns {{ payload: Uint8Array, traceId?: string } | null} the merged
   *   payload when every fragment is present, otherwise `null`.
   */
  push({ messageId, sum, seq, data, traceId }) {
    this.#evictExpired();
    if (!Number.isFinite(sum) || sum <= 1) return { payload: data, traceId };
    if (typeof messageId !== 'string' || !messageId || !Number.isFinite(seq)) return null;
    let entry = this.#pending.get(messageId);
    if (!entry) {
      entry = { parts: new Map(), total: sum, startedAt: this.#now(), traceId };
      this.#pending.set(messageId, entry);
    }
    entry.parts.set(seq, data);
    if (entry.parts.size < entry.total) return null;
    this.#pending.delete(messageId);
    const parts = [];
    for (let index = 0; index < entry.total; index += 1) {
      const part = entry.parts.get(index);
      if (!part) return null;
      parts.push(part);
    }
    const total = parts.reduce((length, part) => length + part.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    return { payload: merged, traceId: entry.traceId };
  }

  #evictExpired() {
    if (this.#pending.size === 0) return;
    const now = this.#now();
    for (const [key, entry] of this.#pending) {
      if (now - entry.startedAt > this.#ttlMs) this.#pending.delete(key);
    }
  }
}

// ------------------------------------------------------------------- transport

/** Connection states surfaced to `/status`. */
export const WS_STATE = Object.freeze({
  STOPPED: 'stopped',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  FAILED: 'failed',
});

/**
 * One long-connection client for an app.
 *
 * Handles endpoint discovery, ping/pong keepalive, fragment reassembly,
 * acknowledgement frames, and reconnection with exponential backoff.
 */
export class FeishuLongConnection {
  #appId;
  #appSecret;
  #brand;
  #origin;
  #fetch;
  #logger;
  #WebSocketImpl;
  #handlers = new Map();
  #assembler = new FragmentAssembler();
  #socket = null;
  #pingTimer = null;
  #reconnectTimer = null;
  #attempt = 0;
  #state = WS_STATE.STOPPED;
  #serviceId = 0;
  #pingIntervalMs = 120_000;
  #reconnectCount = 3;
  #reconnectIntervalMs = 5_000;
  #disposed = false;
  #connecting = null;
  #lastError = null;
  #connectedAt = null;

  /**
   * @param {{
   *   appId: string,
   *   appSecret: string,
   *   brand?: 'feishu' | 'lark',
   *   fetchImpl?: typeof fetch,
   *   WebSocketImpl?: typeof WebSocket,
   *   logger?: { info: Function, warn: Function, error: Function, debug?: Function },
   * }} options
   */
  constructor({
    appId,
    appSecret,
    brand = 'feishu',
    fetchImpl = fetch,
    WebSocketImpl = globalThis.WebSocket,
    logger = console,
  }) {
    if (!appId || !appSecret) throw new TypeError('FeishuLongConnection requires appId and appSecret');
    if (typeof WebSocketImpl !== 'function') {
      throw new TypeError('this runtime has no WebSocket implementation');
    }
    this.#appId = appId;
    this.#appSecret = appSecret;
    this.#brand = brand;
    this.#origin = originFor(brand);
    this.#fetch = fetchImpl;
    this.#WebSocketImpl = WebSocketImpl;
    this.#logger = logger;
  }

  get state() {
    return this.#state;
  }

  /** A `/status`-shaped snapshot of connection health. */
  get status() {
    return {
      state: this.#state,
      connectedAt: this.#connectedAt,
      lastError: this.#lastError,
      reconnectAttempts: this.#attempt,
    };
  }

  /**
   * Register an event handler.
   *
   * @param {string} eventType e.g. `im.message.receive_v1` or `card.action.trigger`.
   * @param {(event: { event: any, headers: Record<string,string>, eventType: string }) => Promise<unknown>|unknown} handler
   * @returns {() => void} disposer.
   */
  on(eventType, handler) {
    let set = this.#handlers.get(eventType);
    if (!set) {
      set = new Set();
      this.#handlers.set(eventType, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.#handlers.delete(eventType);
    };
  }

  /** Open the connection. Resolves once the socket is usable. */
  async start() {
    if (this.#disposed) throw new Error('connection disposed');
    if (this.#state === WS_STATE.CONNECTED) return;
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#connect().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  /** Close the connection and stop reconnecting. */
  async stop() {
    this.#stopPingLoop();
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#setState(WS_STATE.STOPPED);
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // A socket already closing needs no further action.
      }
    }
  }

  /** Stop for good: no reconnection, no further handler dispatch. */
  async dispose() {
    this.#disposed = true;
    this.#handlers.clear();
    await this.stop();
  }

  async #connect() {
    this.#setState(this.#attempt > 0 ? WS_STATE.RECONNECTING : WS_STATE.CONNECTING);
    let endpoint;
    try {
      endpoint = await this.#discoverEndpoint();
    } catch (error) {
      this.#fail(error);
      throw error;
    }
    if (this.#disposed) throw new Error('connection disposed');

    await new Promise((resolve, reject) => {
      let settled = false;
      const socket = new this.#WebSocketImpl(endpoint.url);
      // Node's WebSocket hands binary frames over as a Blob by default, and a
      // Blob has no byteLength — every inbound frame, including the server's
      // pong and every message event, was silently dropped as unreadable.
      // Ask for ArrayBuffer so frames arrive as bytes.
      try {
        socket.binaryType = 'arraybuffer';
      } catch {
        // A non-standard implementation may reject the assignment; the
        // decoder still converts a Blob when it sees one.
      }
      this.#socket = socket;

      socket.addEventListener('open', () => {
        settled = true;
        this.#attempt = 0;
        this.#lastError = null;
        this.#connectedAt = Date.now();
        this.#setState(WS_STATE.CONNECTED);
        this.#startPingLoop();
        this.#logger.debug?.('[feishu] long connection established');
        resolve();
      }, { once: true });

      socket.addEventListener('message', (event) => {
        void this.#handleMessage(event.data);
      });

      socket.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          reject(new Error('websocket connection failed'));
          return;
        }
        this.#logger.warn('[feishu] long connection error');
      });

      socket.addEventListener('close', () => {
        this.#stopPingLoop();
        if (this.#socket === socket) this.#socket = null;
        if (!settled) {
          settled = true;
          reject(new Error('websocket closed before it opened'));
          return;
        }
        if (this.#disposed || this.#state === WS_STATE.STOPPED) return;
        this.#scheduleReconnect();
      });
    }).catch((error) => {
      this.#fail(error);
      throw error;
    });
  }

  async #discoverEndpoint() {
    const url = new URL(WS_ENDPOINT_PATH, this.#origin);
    let response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', locale: 'zh', 'user-agent': USER_AGENT },
        body: JSON.stringify({ AppID: this.#appId, AppSecret: this.#appSecret }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new Error(`long-connection endpoint discovery failed: ${error.message}`, { cause: error });
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`long-connection endpoint discovery returned HTTP ${response.status}`);
    }
    if (body?.code !== 0 || !body?.data?.URL) {
      throw new Error(
        `long-connection endpoint discovery failed: ${body?.msg ?? `code ${body?.code}`}`
        + ' (check App ID/Secret and that the app has long-connection events enabled)',
      );
    }
    const connectUrl = new URL(body.data.URL);
    const clientConfig = body.data.ClientConfig ?? {};
    this.#serviceId = Number(connectUrl.searchParams.get('service_id') ?? 0) || 0;
    if (Number.isFinite(clientConfig.PingInterval) && clientConfig.PingInterval > 0) {
      this.#pingIntervalMs = clientConfig.PingInterval * 1000;
    }
    if (Number.isFinite(clientConfig.ReconnectCount)) {
      this.#reconnectCount = clientConfig.ReconnectCount;
    }
    if (Number.isFinite(clientConfig.ReconnectInterval) && clientConfig.ReconnectInterval > 0) {
      this.#reconnectIntervalMs = clientConfig.ReconnectInterval * 1000;
    }
    return { url: connectUrl.toString() };
  }

  #startPingLoop() {
    this.#stopPingLoop();
    const tick = () => {
      if (this.#socket?.readyState !== 1) return;
      this.#sendFrame({
        SeqID: 0,
        LogID: 0,
        service: this.#serviceId,
        method: FRAME_METHOD_CONTROL,
        headers: [{ key: 'type', value: MESSAGE_TYPE_PING }],
      });
      this.#pingTimer = setTimeout(tick, this.#pingIntervalMs);
    };
    this.#pingTimer = setTimeout(tick, this.#pingIntervalMs);
  }

  #stopPingLoop() {
    if (this.#pingTimer !== null) {
      clearTimeout(this.#pingTimer);
      this.#pingTimer = null;
    }
  }

  #scheduleReconnect() {
    this.#setState(WS_STATE.RECONNECTING);
    if (this.#reconnectTimer !== null) return;
    this.#attempt += 1;
    const base = this.#reconnectIntervalMs;
    const backoff = Math.min(base * 2 ** Math.min(this.#attempt - 1, 5), 60_000);
    const jitter = Math.floor(Math.random() * 500);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#disposed) return;
      void this.start().catch((error) => {
        this.#logger.warn(`[feishu] reconnect attempt ${this.#attempt} failed: ${error.message}`);
        if (!this.#disposed) this.#scheduleReconnect();
      });
    }, backoff + jitter);
  }

  #fail(error) {
    this.#lastError = error?.message ?? String(error);
    this.#setState(WS_STATE.FAILED);
    this.#logger.warn(`[feishu] ${this.#lastError}`);
    if (!this.#disposed) this.#scheduleReconnect();
  }

  #setState(state) {
    this.#state = state;
  }

  #sendFrame(frame) {
    const socket = this.#socket;
    if (!socket || socket.readyState !== 1) return;
    try {
      socket.send(encodeFrame(frame));
    } catch (error) {
      this.#logger.warn(`[feishu] failed to send frame: ${error.message}`);
    }
  }

  async #handleMessage(raw) {
    let frame;
    try {
      const bytes = await toBytes(raw);
      if (!bytes || bytes.length === 0) {
        this.#logger.warn('[feishu] dropped an empty inbound frame');
        return;
      }
      frame = decodeFrame(bytes);
    } catch (error) {
      this.#logger.warn(`[feishu] could not decode frame: ${error.message}`);
      return;
    }

    if (frame.method === FRAME_METHOD_CONTROL) {
      this.#handleControl(frame);
      return;
    }
    if (frame.method === FRAME_METHOD_DATA) {
      await this.#handleData(frame);
    }
  }

  #handleControl(frame) {
    const type = headerValue(frame, 'type');
    if (type === MESSAGE_TYPE_PONG && frame.payload) {
      try {
        const pong = JSON.parse(new TextDecoder().decode(frame.payload));
        if (Number.isFinite(pong?.PingInterval) && pong.PingInterval > 0) {
          this.#pingIntervalMs = pong.PingInterval * 1000;
        }
      } catch {
        // A malformed pong only costs the interval hint.
      }
    }
  }

  async #handleData(frame) {
    if (headerValue(frame, 'type') !== MESSAGE_TYPE_EVENT) return;
    const merged = this.#assembler.push({
      messageId: headerValue(frame, 'message_id'),
      sum: Number(headerValue(frame, 'sum')),
      seq: Number(headerValue(frame, 'seq')),
      data: frame.payload ?? new Uint8Array(),
      traceId: headerValue(frame, 'trace_id'),
    });
    if (!merged) return;

    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(merged.payload));
    } catch (error) {
      this.#logger.warn(`[feishu] event payload was not JSON: ${error.message}`);
      return;
    }

    const eventType = payload?.header?.event_type ?? payload?.event?.type ?? '';
    const result = await this.#dispatch(eventType, payload);

    const responsePayload = { code: 200 };
    if (result !== undefined) {
      responsePayload.data = Buffer.from(JSON.stringify(result)).toString('base64');
    }
    this.#sendFrame({
      ...frame,
      headers: [...frame.headers, { key: 'biz_rt', value: '0' }],
      payload: new TextEncoder().encode(JSON.stringify(responsePayload)),
    });
  }

  async #dispatch(eventType, payload) {
    const handlers = this.#handlers.get(eventType);
    if (!handlers || handlers.size === 0) {
      // Card callbacks the bridge ignores still need a well-formed response,
      // otherwise the platform reports a failed callback to the user.
      if (eventType === 'card.action.trigger') return { toast: { type: 'info', content: '暂不支持该操作' } };
      return undefined;
    }
    const headers = payload?.header ?? {};
    let result;
    for (const handler of [...handlers]) {
      try {
        const value = await handler({ event: payload?.event ?? {}, headers, eventType, payload });
        if (value !== undefined) result = value;
      } catch (error) {
        this.#logger.error(`[feishu] handler for ${eventType} failed: ${error?.stack ?? error}`);
        if (eventType === 'card.action.trigger') {
          result = { toast: { type: 'error', content: '处理失败，请稍后重试' } };
        }
      }
    }
    return result;
  }
}