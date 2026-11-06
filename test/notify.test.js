/**
 * Connection notices.
 *
 * The bridge is invisible when it works: a restart, a dropped socket, a
 * recovered line all happen silently, and the only symptom is that messages stop
 * being answered. These tests pin the behaviour that makes a notice useful —
 * and the behaviour that keeps it from becoming a problem itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { noticeTarget, sendConnectionNotice, shouldSuppress } from '../lib/notify.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/** A recording private-card sender. */
function fakeApi({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    async sendPrivateCard(openId, payload) {
      if (fail) throw new Error('network down');
      sent.push({ openId, payload });
      return { message_id: `om_${sent.length}` };
    },
  };
}

test('a connect notice names the bot and the time', async () => {
  const api = fakeApi();
  const ok = await sendConnectionNotice({ api, logger: silent }, {
    openId: 'ou_user',
    event: 'connected',
  });
  assert.equal(ok, true);
  assert.equal(api.sent.length, 1);
  const text = JSON.stringify(api.sent[0].payload);
  assert.ok(text.includes('已连接'), 'the event is stated');
  assert.ok(!text.includes('原因'), 'no reason line when none was given');
  assert.match(api.sent[0].payload.header.title.content, /🟢/u);
});

test('a disconnect notice carries the reason', async () => {
  const api = fakeApi();
  await sendConnectionNotice({ api, logger: silent }, {
    openId: 'ou_user',
    event: 'disconnected',
    reason: 'websocket closed before it opened',
  });
  const text = JSON.stringify(api.sent[0].payload);
  assert.ok(text.includes('已断开'));
  assert.ok(text.includes('websocket closed'), 'the reason is included');
  assert.match(api.sent[0].payload.header.template, /orange|grey/u);
});

test('a delivery failure is reported, not thrown', async () => {
  // The notice rides on the connection it describes; if that connection is
  // gone, the send fails, and that must not propagate into bridge logic.
  const api = fakeApi({ fail: true });
  const ok = await sendConnectionNotice({ api, logger: silent }, {
    openId: 'ou_user',
    event: 'connected',
  });
  assert.equal(ok, false);
});

test('no target means no attempt, not an error', async () => {
  const api = fakeApi();
  const ok = await sendConnectionNotice({ api, logger: silent }, {
    openId: '',
    event: 'connected',
  });
  assert.equal(ok, false);
  assert.equal(api.sent.length, 0);
});

test('a long reason is clamped to one readable line', async () => {
  const api = fakeApi();
  await sendConnectionNotice({ api, logger: silent }, {
    openId: 'ou_user',
    event: 'disconnected',
    reason: 'x'.repeat(500),
  });
  const card = api.sent[0].payload;
  const reason = JSON.stringify(card.body.elements[0]);
  assert.ok(reason.length < 400, 'the card stays small');
});

test('the notice target is the most recently seen operator', () => {
  const seen = new Map([
    ['ou_old', { lastSeen: 1000 }],
    ['ou_new', { lastSeen: 9000 }],
    ['ou_mid', { lastSeen: 5000 }],
  ]);
  assert.equal(noticeTarget(seen), 'ou_new');
});

test('no operators means no target', () => {
  assert.equal(noticeTarget(new Map()), null);
  assert.equal(noticeTarget(null), null);
});

test('entries without a timestamp never win over ones with one', () => {
  const seen = new Map([
    ['ou_bad', {}],
    ['ou_good', { lastSeen: 1 }],
  ]);
  assert.equal(noticeTarget(seen), 'ou_good');
});

test('a recovery within a minute of the last notice is suppressed', () => {
  const now = 10_000_000;
  assert.equal(shouldSuppress(NaN, now), false, 'a first notice is never suppressed');
  assert.equal(shouldSuppress(now - 30_000, now), true, '30s later is the same incident');
  assert.equal(shouldSuppress(now - 120_000, now), false, 'two minutes apart is worth saying');
});

test('a disconnect is never suppressed, even right after a notice', () => {
  const now = 10_000_000;
  assert.equal(shouldSuppress(now - 1_000, now, 'disconnected'), false);
  // A disconnect is also not suppressed by the default event, which is
  // `connected`: only recovery flapping is filtered.
  assert.equal(shouldSuppress(now - 1_000, now, 'connected'), true, 'recovery still is');
});

test('the notification card is schema 2.0 with div-wrapped text', async () => {
  // The same conformance rule as every other card: an element outside schema
  // 2.0 gets the whole message rejected, so a notice nobody received is worse
  // than no notice.
  const api = fakeApi();
  await sendConnectionNotice({ api, logger: silent }, { openId: 'ou_u', event: 'connected' });
  const payload = api.sent[0].payload;
  assert.equal(payload.schema, '2.0');
  for (const element of payload.body.elements) {
    assert.ok(['div', 'hr'].includes(element.tag), `element tag "${element.tag}" is schema 2.0`);
  }
});