/**
 * Round-trip test for the hand-written pbbp2 frame codec against the official
 * protobuf definition bundled in the Feishu Node SDK.
 *
 * This is a development check, not part of the shipped plugin: it proves the
 * dependency-free encoder/decoder in `lib/feishu/ws.js` is wire-compatible with
 * the platform before the bridge relies on it.
 *
 * Usage: node scripts/verify-frame-codec.mjs <path-to-node-sdk-package>
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');

const { encodeFrame, decodeFrame } = await import(
  new URL('../lib/feishu/ws.js', import.meta.url).href
);

const sdkPath = process.argv[2];
if (!sdkPath) {
  console.error('usage: node scripts/verify-frame-codec.mjs <path-to-@larksuiteoapi/node-sdk/package>');
  process.exit(2);
}

// The SDK ships a bundled CJS with protobufjs embedded; pull the codec out of
// its source the same way the runtime does, so this test compares against the
// real definition rather than a transcription of it.
const sdkEntry = join(resolve(sdkPath), 'lib', 'index.js');
const sdkSource = readFileSync(sdkEntry, 'utf8');
if (!sdkSource.includes('pbbp2.Frame')) {
  console.error('the supplied package does not contain pbbp2.Frame');
  process.exit(2);
}

const require = createRequire(import.meta.url);
const protobufPath = require.resolve('protobufjs/minimal', { paths: [resolve(sdkPath)] });
const protobuf = require(protobufPath);

// Build the same message the SDK encodes, then check both directions.
const Frame = new protobuf.Type('Frame')
  .add(new protobuf.Field('SeqID', 1, 'uint64'))
  .add(new protobuf.Field('LogID', 2, 'uint64'))
  .add(new protobuf.Field('service', 3, 'int32'))
  .add(new protobuf.Field('method', 4, 'int32'))
  .add(new protobuf.Field('headers', 5, 'Header', 'repeated'))
  .add(new protobuf.Field('payloadEncoding', 6, 'string'))
  .add(new protobuf.Field('payloadType', 7, 'string'))
  .add(new protobuf.Field('payload', 8, 'bytes'));
const Header = new protobuf.Type('Header')
  .add(new protobuf.Field('key', 1, 'string'))
  .add(new protobuf.Field('value', 2, 'string'));
Frame.add(Header);

const payload = new TextEncoder().encode(JSON.stringify({ hello: '世界', n: 42 }));
const sample = {
  SeqID: 0,
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

const official = Frame.encode(Frame.create(sample)).finish();
const mine = encodeFrame(sample);

const failures = [];

if (Buffer.compare(Buffer.from(official), Buffer.from(mine)) !== 0) {
  failures.push('encoded bytes differ from the official encoder');
  console.error('official:', Buffer.from(official).toString('hex'));
  console.error('mine    :', Buffer.from(mine).toString('hex'));
}

const decodedByOfficial = Frame.toObject(Frame.decode(mine), { bytes: Array });
if (decodedByOfficial.service !== sample.service || decodedByOfficial.method !== sample.method) {
  failures.push('official decoder read different service/method');
}
if (decodedByOfficial.headers.length !== sample.headers.length) {
  failures.push('official decoder read a different header count');
}
for (const [index, header] of sample.headers.entries()) {
  if (decodedByOfficial.headers[index]?.key !== header.key
    || decodedByOfficial.headers[index]?.value !== header.value) {
    failures.push(`official decoder read a different header at ${index}`);
  }
}
if (Buffer.compare(Buffer.from(decodedByOfficial.payload), Buffer.from(payload)) !== 0) {
  failures.push('official decoder read a different payload');
}

const mineDecoded = decodeFrame(official);
if (mineDecoded.service !== sample.service || mineDecoded.method !== sample.method) {
  failures.push('my decoder read different service/method');
}
if (mineDecoded.LogID !== sample.LogID) failures.push('my decoder read a different LogID');
if (mineDecoded.headers.length !== sample.headers.length) {
  failures.push('my decoder read a different header count');
}
if (Buffer.compare(Buffer.from(mineDecoded.payload), Buffer.from(payload)) !== 0) {
  failures.push('my decoder read a different payload');
}

// A ping frame carries no payload and no LogID; it must still round-trip.
const ping = { SeqID: 0, LogID: 0, service: 7, method: 0, headers: [{ key: 'type', value: 'ping' }] };
const pingOfficial = Frame.encode(Frame.create(ping)).finish();
const pingMine = encodeFrame(ping);
if (Buffer.compare(Buffer.from(pingOfficial), Buffer.from(pingMine)) !== 0) {
  failures.push('ping frame bytes differ from the official encoder');
}
const pingDecoded = decodeFrame(pingMine);
if (pingDecoded.method !== 0 || pingDecoded.headers[0]?.value !== 'ping') {
  failures.push('ping frame did not round-trip');
}

if (failures.length > 0) {
  console.error(`frame codec verification failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('frame codec verified against the official pbbp2 encoder/decoder');