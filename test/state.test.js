import test from 'node:test';
import assert from 'node:assert/strict';

import { InteractionState, PAGE_SIZE, Snapshot } from '../lib/state.js';

test('page sizes match the interaction reference', () => {
  assert.equal(PAGE_SIZE.task, 10);
  assert.equal(PAGE_SIZE.project, 10);
  assert.equal(PAGE_SIZE.search, 10);
  assert.equal(PAGE_SIZE.history, 5);
});

test('the current task is stored per user, so switching chats keeps the target', () => {
  const state = new InteractionState({ logger: silent });
  state.setCurrentTask('ou_a', { sessionId: 's1' });
  state.setCurrentTask('ou_b', { sessionId: 's2' });
  assert.equal(state.currentTask('ou_a').sessionId, 's1');
  assert.equal(state.currentTask('ou_b').sessionId, 's2');
  assert.equal(state.currentTask('ou_c'), null);
  state.setCurrentTask('ou_a', null);
  assert.equal(state.currentTask('ou_a'), null);
});

test('a numbered snapshot resolves only its own items', () => {
  const state = new InteractionState({ logger: silent });
  const snapshot = state.recordSnapshot({
    kind: 'task',
    items: [{ sessionId: 'a' }, { sessionId: 'b' }],
    userId: 'ou_a',
    chatId: 'oc_1',
  });
  assert.equal(snapshot.resolve(1).sessionId, 'a');
  assert.equal(snapshot.resolve(2).sessionId, 'b');
  assert.equal(snapshot.resolve(3), undefined);
  assert.equal(snapshot.resolve(0), undefined);
});

test('recording a newer snapshot retires the older one for the same query', () => {
  const state = new InteractionState({ logger: silent });
  const first = state.recordSnapshot({ kind: 'task', items: [{ id: 1 }], userId: 'ou_a', chatId: 'c' });
  const second = state.recordSnapshot({ kind: 'task', items: [{ id: 2 }], userId: 'ou_a', chatId: 'c' });
  assert.equal(state.snapshot(first.id), null, 'the stale snapshot must not resolve');
  assert.equal(state.snapshot(second.id).size, 1);
  assert.equal(state.latestSnapshot('ou_a', 'task').id, second.id);
});

test('snapshots are per user and per kind', () => {
  const state = new InteractionState({ logger: silent });
  const mine = state.recordSnapshot({ kind: 'task', items: [{ id: 'mine' }], userId: 'ou_a', chatId: 'c' });
  state.recordSnapshot({ kind: 'task', items: [{ id: 'theirs' }], userId: 'ou_b', chatId: 'c' });
  assert.equal(state.latestSnapshot('ou_a', 'task').id, mine.id);
  assert.equal(state.latestSnapshot('ou_a', 'search'), null);
});

test('staged images are bound to their originating task', () => {
  const state = new InteractionState({ logger: silent });
  state.stageImage('ou_a', { taskId: 's1', chatId: 'c', file: { fileKey: 'k1' }, name: 'a.png' });
  state.stageImage('ou_a', { taskId: 's1', chatId: 'c', file: { fileKey: 'k2' }, name: 'b.png' });
  assert.equal(state.stagedImages('ou_a').items.length, 2);

  // Switching tasks drops the old batch instead of carrying it across.
  const switched = state.stageImage('ou_a', { taskId: 's2', chatId: 'c', file: { fileKey: 'k3' }, name: 'c.png' });
  assert.equal(switched.items.length, 1);
  assert.equal(switched.taskId, 's2');
  assert.deepEqual(switched.items[0].file, { fileKey: 'k3' });
});

test('clearing staged images returns the batch once', () => {
  const state = new InteractionState({ logger: silent });
  state.stageImage('ou_a', { taskId: 's1', chatId: 'c', file: { fileKey: 'k1' }, name: 'a.png' });
  const cleared = state.clearStagedImages('ou_a');
  assert.equal(cleared.items.length, 1);
  assert.equal(state.clearStagedImages('ou_a'), null);
});

test('an interaction is claimed exactly once', () => {
  const state = new InteractionState({ logger: silent });
  const record = state.addPendingInteraction('approval', { sessionId: 's1', userId: 'ou_a' });
  const first = state.claimPendingInteraction(record.id, { userId: 'ou_a' });
  assert.equal(first.ok, true);
  const second = state.claimPendingInteraction(record.id, { userId: 'ou_a' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'claimed');
});

test('an interaction cannot be claimed by a different operator', () => {
  const state = new InteractionState({ logger: silent });
  const record = state.addPendingInteraction('question', { sessionId: 's1', userId: 'ou_a' });
  const claim = state.claimPendingInteraction(record.id, { userId: 'ou_other' });
  assert.equal(claim.ok, false);
  assert.equal(claim.reason, 'forbidden');
  // The rightful operator can still claim it.
  assert.equal(state.claimPendingInteraction(record.id, { userId: 'ou_a' }).ok, true);
});

test('an unknown interaction reports missing rather than throwing', () => {
  const state = new InteractionState({ logger: silent });
  const claim = state.claimPendingInteraction('nope', { userId: 'ou_a' });
  assert.equal(claim.ok, false);
  assert.equal(claim.reason, 'missing');
});

test('result delivery is idempotent per session and key', () => {
  const state = new InteractionState({ logger: silent });
  assert.equal(state.markResultDelivered('s1', 's1:42'), true);
  assert.equal(state.markResultDelivered('s1', 's1:42'), false);
  assert.equal(state.wasResultDelivered('s1', 's1:42'), true);
  assert.equal(state.markResultDelivered('s1', 's1:43'), true);
  assert.equal(state.markResultDelivered('s2', 's2:42'), true);
});

test('a redelivered platform message is dropped', () => {
  const state = new InteractionState({ logger: silent });
  assert.equal(state.rememberMessage('om_1'), true);
  assert.equal(state.rememberMessage('om_1'), false);
  assert.equal(state.rememberMessage('om_2'), true);
  assert.equal(state.rememberMessage(''), true, 'an absent id is never deduplicated');
});

test('rounds are tracked one per task and finished once', () => {
  const state = new InteractionState({ logger: silent });
  state.registerRound('s1', { active: true, phase: 'running' });
  assert.equal(state.round('s1').phase, 'running');
  const finished = state.finishRound('s1', { phase: 'done' });
  assert.equal(finished.active, false);
  assert.deepEqual(finished.outcome, { phase: 'done' });
});

test('clear() drops every piece of state', () => {
  const state = new InteractionState({ logger: silent });
  state.setCurrentTask('ou_a', { sessionId: 's1' });
  state.recordSnapshot({ kind: 'task', items: [{}], userId: 'ou_a', chatId: 'c' });
  state.stageImage('ou_a', { taskId: 's1', chatId: 'c', file: {}, name: 'a' });
  state.addPendingInteraction('approval', { sessionId: 's1' });
  state.registerRound('s1', { active: true });
  state.markResultDelivered('s1', 'k');
  state.rememberMessage('om_1');
  state.clear();
  assert.equal(state.currentTask('ou_a'), null);
  assert.equal(state.latestSnapshot('ou_a', 'task'), null);
  assert.equal(state.stagedImages('ou_a'), null);
  assert.equal(state.round('s1'), null);
  assert.equal(state.wasResultDelivered('s1', 'k'), false);
  assert.equal(state.rememberMessage('om_1'), true);
});

test('an expired snapshot no longer resolves', (t) => {
  const snapshot = new Snapshot({ kind: 'task', items: [{}], userId: 'ou_a', chatId: 'c' });
  t.mock.method(Date, 'now', () => snapshot.createdAt + 2 * 60 * 60 * 1000);
  assert.equal(snapshot.stale, true);
});

const silent = { info() {}, warn() {}, error() {}, debug() {} };