import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';

import {
  bridgeAddons,
  encodeAddons,
  registerFeishuApp,
  RegistrationSession,
  REGISTRATION_STATE,
} from '../lib/feishu/registration.js';

/** A scripted stand-in for the accounts host. */
function fakeRegistrationServer(script) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, init) => {
    const body = new URLSearchParams(init.body);
    calls.push({ url, body: Object.fromEntries(body) });
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    return {
      ok: step.status ? step.status < 400 : true,
      status: step.status ?? 200,
      json: async () => step.body,
    };
  };
  return { fetchImpl, calls };
}

function beginResponse(overrides = {}) {
  return {
    device_code: 'dev_1',
    verification_uri: 'https://accounts.feishu.cn/page/launcher',
    verification_uri_complete: 'https://accounts.feishu.cn/page/launcher?user_code=AB-12',
    user_code: 'AB-12',
    interval: 1,
    expires_in: 600,
    ...overrides,
  };
}

const fastSleep = async () => {};

test('the requested addons cover exactly the capabilities this bridge implements', () => {
  const addons = bridgeAddons();
  assert.equal(addons.preset, false, 'preset:false keeps the granted set explicit');
  assert.ok(addons.scopes.tenant.includes('im:message'));
  assert.ok(addons.scopes.tenant.includes('im:message:send_as_bot'));
  assert.ok(addons.scopes.tenant.includes('im:resource'));
  assert.ok(addons.events.items.tenant.includes('im.message.receive_v1'));
  assert.ok(addons.callbacks.items.includes('card.action.trigger'));
});

test('addons are gzip+base64url encoded so the confirm page can read them', () => {
  const addons = bridgeAddons();
  const encoded = encodeAddons(addons);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/u, 'base64url without padding');
  const decoded = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64url')).toString('utf8'));
  assert.deepEqual(decoded, addons);
});

test('a successful scan returns the app credentials', async () => {
  const { fetchImpl, calls } = fakeRegistrationServer([
    { body: beginResponse() },
    { body: { error: 'authorization_pending' }, status: 400 },
    { body: { client_id: 'cli_new', client_secret: 'secret_new', user_info: { open_id: 'ou_x', tenant_brand: 'feishu' } } },
  ]);
  const qr = [];
  const result = await registerFeishuApp({
    fetchImpl,
    sleepImpl: fastSleep,
    onQrCode: (info) => qr.push(info),
  });

  assert.equal(result.appId, 'cli_new');
  assert.equal(result.appSecret, 'secret_new');
  assert.equal(result.brand, 'feishu');
  assert.equal(calls[0].body.action, 'begin');
  assert.equal(calls[1].body.action, 'poll');
  assert.equal(calls[1].body.device_code, 'dev_1');

  assert.equal(qr.length, 1);
  const url = new URL(qr[0].url);
  assert.equal(url.searchParams.get('from'), 'sdk');
  assert.equal(url.searchParams.get('tp'), 'sdk');
  assert.equal(url.searchParams.get('source'), 'dsh-feishu-only');
  assert.ok(url.searchParams.get('addons'), 'the capability manifest travels on the QR URL');
  assert.equal(url.searchParams.get('user_code'), 'AB-12', 'the original query is preserved');
});

test('the QR reports an expiry so the UI can show a countdown', async () => {
  const { fetchImpl } = fakeRegistrationServer([
    { body: beginResponse({ expires_in: 300 }) },
  ]);
  const qr = [];
  const before = Date.now();
  // Stop before the first poll: the QR is emitted during `begin`, so there is
  // no need to run a polling loop at all.
  const controller = new AbortController();
  const pending = registerFeishuApp({
    fetchImpl,
    signal: controller.signal,
    sleepImpl: () => new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
      }, { once: true });
    }),
    onQrCode: (info) => qr.push(info),
  }).catch(() => {});
  controller.abort();
  await pending;
  assert.ok(qr[0].expiresAt >= before + 300_000 - 5_000);
  assert.ok(qr[0].expiresAt <= before + 300_000 + 5_000);
});

test('a declined authorization is reported as a denial', async () => {
  const { fetchImpl } = fakeRegistrationServer([
    { body: beginResponse() },
    { body: { error: 'access_denied', error_description: 'user declined' }, status: 400 },
  ]);
  await assert.rejects(
    () => registerFeishuApp({ fetchImpl, sleepImpl: fastSleep }),
    (error) => error.code === 'access_denied',
  );
});

test('an expired authorization is distinguishable from a denial', async () => {
  const { fetchImpl } = fakeRegistrationServer([
    { body: beginResponse() },
    { body: { error: 'expired_token' }, status: 400 },
  ]);
  await assert.rejects(
    () => registerFeishuApp({ fetchImpl, sleepImpl: fastSleep }),
    (error) => error.code === 'expired_token',
  );
});

test('slow_down widens the poll interval instead of failing', async () => {
  const { fetchImpl } = fakeRegistrationServer([
    { body: beginResponse() },
    { body: { error: 'slow_down' }, status: 400 },
    { body: { client_id: 'cli', client_secret: 'sec', user_info: { tenant_brand: 'feishu' } } },
  ]);
  const states = [];
  const result = await registerFeishuApp({
    fetchImpl,
    sleepImpl: fastSleep,
    onState: (state, detail) => states.push({ state, detail }),
  });
  assert.equal(result.appId, 'cli');
  assert.ok(states.some((entry) => entry.state === REGISTRATION_STATE.SLOW_DOWN));
});

test('a Lark tenant is recorded as the lark brand', async () => {
  const { fetchImpl } = fakeRegistrationServer([
    { body: beginResponse() },
    { body: { error: 'authorization_pending' }, status: 400 },
    { body: { client_id: 'cli_lark', client_secret: 'secret_lark', user_info: { tenant_brand: 'lark' } } },
  ]);
  const result = await registerFeishuApp({ fetchImpl, sleepImpl: fastSleep });
  assert.equal(result.brand, 'lark');
  assert.equal(result.userInfo.tenant_brand, 'lark');
});

test('an aborted onboarding reports cancellation, not failure', async () => {
  const controller = new AbortController();
  const { fetchImpl } = fakeRegistrationServer([
    { body: beginResponse() },
    { body: { error: 'authorization_pending' }, status: 400 },
  ]);
  // Park the loop after the first poll so the abort is what ends it.
  const pending = registerFeishuApp({
    fetchImpl,
    signal: controller.signal,
    sleepImpl: (ms, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
        return;
      }
      const timer = setTimeout(resolve, 0);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
      }, { once: true });
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'cancelled');
});

test('a begin response without a device code fails loudly', async () => {
  const { fetchImpl } = fakeRegistrationServer([{ body: { error: 'system_busy' }, status: 500 }]);
  await assert.rejects(
    () => registerFeishuApp({ fetchImpl, sleepImpl: fastSleep }),
    /app registration begin failed/u,
  );
});

/** A sleep that never settles until the caller aborts, so a session parks. */
function parkedSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
      return;
    }
    signal?.addEventListener('abort', () => {
      reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
    }, { once: true });
  });
}

test('a registration session exposes a QR before it completes', async () => {
  const { fetchImpl } = fakeRegistrationServer([
    { body: beginResponse() },
    { body: { error: 'authorization_pending' }, status: 400 },
  ]);
  const session = new RegistrationSession({ fetchImpl, sleepImpl: parkedSleep });
  const deadline = Date.now() + 1000;
  while (!session.qrCode && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(session.qrCode?.url);
  assert.equal(session.outcome.status, 'pending');
  session.cancel();
  await session.completed.catch(() => {});
});

test('a cancelled registration session never resolves credentials', async () => {
  const { fetchImpl } = fakeRegistrationServer([
    { body: beginResponse() },
    { body: { error: 'authorization_pending' }, status: 400 },
  ]);
  const session = new RegistrationSession({ fetchImpl, sleepImpl: parkedSleep });
  const deadline = Date.now() + 1000;
  while (!session.qrCode && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  session.cancel();
  await assert.rejects(session.completed, (error) => error.code === 'cancelled');
  assert.equal(session.outcome.status, 'failed');
});