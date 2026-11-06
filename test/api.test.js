import test from 'node:test';
import assert from 'node:assert/strict';

import { FeishuApi, FeishuApiError, FeishuTransportError, originFor, FEISHU_ORIGIN, LARK_ORIGIN } from '../lib/feishu/api.js';

/** A scripted HTTP stand-in that records every request. */
function mockFetch(script) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const step = typeof script === 'function'
      ? script(String(url), init, calls.length)
      : script[Math.min(index, script.length - 1)];
    index += 1;
    const body = step.body;
    const headers = step.headers ?? {};
    return {
      ok: step.status ? step.status < 400 : true,
      status: step.status ?? 200,
      headers: {
        get(name) {
          return headers[String(name).toLowerCase()] ?? null;
        },
      },
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  return { fetchImpl, calls };
}

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function tokenStep() {
  return { body: { code: 0, tenant_access_token: 't-123', expire: 7200 } };
}

test('origins follow the brand', () => {
  assert.equal(originFor('feishu'), FEISHU_ORIGIN);
  assert.equal(originFor('lark'), LARK_ORIGIN);
  assert.equal(originFor(undefined), FEISHU_ORIGIN);
});

test('the tenant token is fetched once and reused', async () => {
  const { fetchImpl, calls } = mockFetch([tokenStep(), { body: { code: 0, data: { ok: 1 } } }]);
  const api = new FeishuApi({ appId: 'cli', appSecret: 'sec', fetchImpl, logger: silent });
  await api.tenantToken();
  await api.tenantToken();
  assert.equal(calls.filter((call) => call.url.includes('tenant_access_token')).length, 1);
});

test('a non-zero platform code rejects with its code and message', async () => {
  const { fetchImpl } = mockFetch([
    tokenStep(),
    { body: { code: 231001, msg: 'chat not found' } },
  ]);
  const api = new FeishuApi({ appId: 'cli', appSecret: 'sec', fetchImpl, logger: silent });
  await assert.rejects(
    () => api.sendText('oc_1', 'hi'),
    (error) => {
      assert.ok(error instanceof FeishuApiError);
      assert.equal(error.code, 231001);
      assert.match(error.message, /chat not found/u);
      return true;
    },
  );
});

test('an expired tenant token is dropped so the next call refreshes it', async () => {
  let sends = 0;
  const { fetchImpl, calls } = mockFetch((url) => {
    if (String(url).includes('tenant_access_token')) return tokenStep();
    sends += 1;
    return sends === 1
      ? { body: { code: 99991663, msg: 'token expired' } }
      : { body: { code: 0, data: { message_id: 'om_2' } } };
  });
  const api = new FeishuApi({ appId: 'cli', appSecret: 'sec', fetchImpl, logger: silent });
  await assert.rejects(() => api.sendText('oc_1', 'first'));
  await api.sendText('oc_1', 'second');
  assert.equal(calls.filter((call) => call.url.includes('tenant_access_token')).length, 2);
});

test('credentials are sent as JSON to the token endpoint', async () => {
  const { fetchImpl, calls } = mockFetch([tokenStep()]);
  const api = new FeishuApi({ appId: 'cli_abc', appSecret: 'the-secret', fetchImpl, logger: silent });
  await api.tenantToken();
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { app_id: 'cli_abc', app_secret: 'the-secret' });
  assert.match(String(calls[0].init.headers['content-type']), /application\/json/u);
});

test('a transport failure is reported as a transport error', async () => {
  const { fetchImpl } = mockFetch(() => {
    throw new Error('network down');
  });
  const api = new FeishuApi({ appId: 'cli', appSecret: 'sec', fetchImpl, logger: silent });
  await assert.rejects(
    () => api.tenantToken(),
    (error) => error instanceof FeishuTransportError,
  );
});

test('sending a card serializes the card into the message content', async () => {
  const { fetchImpl, calls } = mockFetch([tokenStep(), { body: { code: 0, data: { message_id: 'om_1' } } }]);
  const api = new FeishuApi({ appId: 'cli', appSecret: 'sec', fetchImpl, logger: silent });
  await api.sendCard('oc_9', { schema: '2.0', body: { elements: [] } });
  const sendCall = calls.at(-1);
  assert.match(sendCall.url, /im\/v1\/messages\?receive_id_type=chat_id/u);
  const body = JSON.parse(sendCall.init.body);
  assert.equal(body.receive_id, 'oc_9');
  assert.equal(body.msg_type, 'interactive');
  assert.deepEqual(JSON.parse(body.content), { schema: '2.0', body: { elements: [] } });
  assert.equal(sendCall.init.headers.authorization, 'Bearer t-123');
});

test('a private card addresses the operator open_id', async () => {
  const { fetchImpl, calls } = mockFetch([tokenStep(), { body: { code: 0, data: { message_id: 'om_p' } } }]);
  const api = new FeishuApi({ appId: 'cli', appSecret: 'sec', fetchImpl, logger: silent });
  await api.sendPrivateCard('ou_1', { schema: '2.0' });
  assert.match(calls.at(-1).url, /receive_id_type=open_id/u);
  assert.equal(JSON.parse(calls.at(-1).init.body).receive_id, 'ou_1');
});

test('patching a card targets the exact message', async () => {
  const { fetchImpl, calls } = mockFetch([tokenStep(), { body: { code: 0, data: {} } }]);
  const api = new FeishuApi({ appId: 'cli', appSecret: 'sec', fetchImpl, logger: silent });
  await api.patchCard('om_77', { schema: '2.0' });
  assert.match(calls.at(-1).url, /im\/v1\/messages\/om_77$/u);
  assert.equal(calls.at(-1).init.method, 'PATCH');
  assert.deepEqual(JSON.parse(JSON.parse(calls.at(-1).init.body).content), { schema: '2.0' });
});

test('downloading a resource returns bytes and content type', async () => {
  const png = Buffer.from('89504e47', 'hex');
  const { fetchImpl, calls } = mockFetch([
    tokenStep(),
    {
      body: png.toString('utf8'),
      headers: { 'content-type': 'image/png' },
    },
  ]);
  // Replace arrayBuffer with the real bytes for this response.
  const original = fetchImpl;
  const withBytes = async (url, init) => {
    const response = await original(url, init);
    if (String(url).includes('/resources/')) {
      return { ...response, arrayBuffer: async () => png };
    }
    return response;
  };
  const api = new FeishuApi({ appId: 'cli', appSecret: 'sec', fetchImpl: withBytes, logger: silent });
  const result = await api.downloadResource('om_1', 'file_key', 'image');
  assert.equal(result.contentType, 'image/png');
  assert.deepEqual(result.data, new Uint8Array(png));
  assert.match(calls.at(-1).url, /resources\/file_key\?type=image/u);
});

test('uploading an image returns its image_key', async () => {
  const { fetchImpl, calls } = mockFetch([
    tokenStep(),
    { body: { code: 0, data: { image_key: 'img_new' } } },
  ]);
  const api = new FeishuApi({ appId: 'cli', appSecret: 'sec', fetchImpl, logger: silent });
  const key = await api.uploadImage(new Uint8Array([1, 2, 3]), { name: 'a.png' });
  assert.equal(key, 'img_new');
  assert.ok(calls.at(-1).init.body instanceof FormData);
});

test('an upload response without a key rejects', async () => {
  const { fetchImpl } = mockFetch([tokenStep(), { body: { code: 0, data: {} } }]);
  const api = new FeishuApi({ appId: 'cli', appSecret: 'sec', fetchImpl, logger: silent });
  await assert.rejects(() => api.uploadImage(new Uint8Array([1])), /no image_key/u);
});

test('the bot identity is read from the bot endpoint', async () => {
  const { fetchImpl, calls } = mockFetch([
    tokenStep(),
    { body: { code: 0, bot: { app_name: '机器人', open_id: 'ou_bot', activate_status: 2 } } },
  ]);
  const api = new FeishuApi({ appId: 'cli_x', appSecret: 's', fetchImpl, logger: silent });
  const info = await api.botInfo();
  assert.equal(info.name, '机器人');
  assert.equal(info.openId, 'ou_bot');
  assert.equal(info.appId, 'cli_x');
  assert.match(calls.at(-1).url, /bot\/v3\/info/u);
});

test('the lark brand calls the larksuite origin', async () => {
  const { fetchImpl, calls } = mockFetch([tokenStep(), { body: { code: 0, bot: {} } }]);
  const api = new FeishuApi({ appId: 'cli', appSecret: 'sec', brand: 'lark', fetchImpl, logger: silent });
  await api.botInfo();
  assert.ok(calls[0].url.startsWith('https://open.larksuite.com'));
});

test('missing credentials are rejected at construction', () => {
  assert.throws(() => new FeishuApi({ appId: '', appSecret: 'x' }), /requires appId and appSecret/u);
  assert.throws(() => new FeishuApi({ appId: 'x', appSecret: '' }), /requires appId and appSecret/u);
});

test('an invalidateToken forces a refresh on the next call', async () => {
  const { fetchImpl, calls } = mockFetch((url, init, count) => (
    String(url).includes('tenant_access_token')
      ? tokenStep()
      : { body: { code: 0, data: { n: count } } }
  ));
  const api = new FeishuApi({ appId: 'cli', appSecret: 'sec', fetchImpl, logger: silent });
  await api.tenantToken();
  api.invalidateToken();
  await api.tenantToken();
  assert.equal(calls.filter((call) => call.url.includes('tenant_access_token')).length, 2);
});