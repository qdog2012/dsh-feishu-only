import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeFrame, decodeFrame } from '../lib/feishu/ws.js';

test('a data frame round-trips through the encoder and decoder', () => {
  const payload = new TextEncoder().encode(JSON.stringify({ hello: '世界', n: 42 }));
  const frame = {
    SeqID: 7,
    LogID: 3,
    service: 12345,
    method: 1,
    headers: [
      { key: 'type', value: 'event' },
      { key: 'message_id', value: 'msg-1' },
      { key: 'sum', value: '1' },
      { key: 'seq', value: '0' },
      { key: 'trace_id', value: 'trace-abc' },
    ],
    payload,
  };
  const decoded = decodeFrame(encodeFrame(frame));
  assert.equal(decoded.SeqID, 7);
  assert.equal(decoded.LogID, 3);
  assert.equal(decoded.service, 12345);
  assert.equal(decoded.method, 1);
  assert.deepEqual(decoded.headers, frame.headers);
  assert.deepEqual(new Uint8Array(decoded.payload), payload);
});

test('a control (ping) frame carries no payload', () => {
  const frame = { SeqID: 0, LogID: 0, service: 9, method: 0, headers: [{ key: 'type', value: 'ping' }] };
  const decoded = decodeFrame(encodeFrame(frame));
  assert.equal(decoded.method, 0);
  assert.equal(decoded.service, 9);
  assert.equal(decoded.headers[0].value, 'ping');
});

test('protobuf field order is stable and matches the platform schema', () => {
  // Golden bytes: SeqID(1)=0, LogID(2)=3, service(3)=12345, method(4)=1,
  // then one Header{key:"type", value:"ping"} with no payload.
  const encoded = encodeFrame({
    SeqID: 0,
    LogID: 3,
    service: 12345,
    method: 1,
    headers: [{ key: 'type', value: 'ping' }],
  });
  assert.deepEqual([...encoded], [
    0x08, 0x00, // field 1 varint 0
    0x10, 0x03, // field 2 varint 3
    0x18, 0xb9, 0x60, // field 3 varint 12345
    0x20, 0x01, // field 4 varint 1
    0x2a, 0x0c, // field 5, length 12
    0x0a, 0x04, 0x74, 0x79, 0x70, 0x65, //   Header.key = "type"
    0x12, 0x04, 0x70, 0x69, 0x6e, 0x67, //   Header.value = "ping"
  ]);
});

test('unknown fields are skipped rather than breaking decoding', () => {
  const base = encodeFrame({ SeqID: 0, LogID: 0, service: 1, method: 1, headers: [] });
  // Append an unknown length-delimited field 15 ("x") the way a newer server
  // might, then decode: the known fields must still be read.
  const extra = new Uint8Array([...base, 0x7a, 0x01, 0x78]);
  const decoded = decodeFrame(extra);
  assert.equal(decoded.service, 1);
  assert.equal(decoded.method, 1);
});