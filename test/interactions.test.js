import test from 'node:test';
import assert from 'node:assert/strict';

import { InteractionBridge } from '../lib/interactions.js';
import { InteractionState } from '../lib/state.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/** Capture the two waterfall listeners so a test can drive them directly. */
function install({ deliver, operators = [{ openId: 'ou_user', chatId: 'oc_private' }] } = {}) {
  const listeners = new Map();
  const ctx = {
    on(name, handler) {
      listeners.set(name, handler);
      return () => listeners.delete(name);
    },
  };
  const state = new InteractionState({ logger: silent });
  const deliverCalls = [];
  const bridge = new InteractionBridge({
    ctx,
    state,
    api: {},
    logger: silent,
    taskLookup: () => ({ label: '任务' }),
    operatorsFor: () => operators,
    deliver: async (openId, payload) => {
      deliverCalls.push({ openId, payload });
      if (deliver) return deliver(openId, payload);
      return { message_id: 'om_card' };
    },
  });
  bridge.install();
  return { bridge, state, listeners, deliverCalls };
}

function approvalEvent({ signal } = {}) {
  return {
    agent: { id: 's1' },
    toolName: 'bash',
    callId: 'c1',
    reason: '需要写入工作区',
    ...(signal ? { signal } : {}),
  };
}

function questionEvent({ signal } = {}) {
  return {
    agent: { id: 's1' },
    questions: [{
      id: 'env',
      question: '发布到哪个环境？',
      options: [{ label: '测试' }, { label: '生产' }],
    }],
    ...(signal ? { signal } : {}),
  };
}

function nextReturning(value) {
  return async () => value;
}

test('an approval is delivered to the private chat and waits for a decision', async () => {
  const { listeners, deliverCalls, bridge, state } = install();
  const handler = listeners.get('approval/request');
  const pending = handler(approvalEvent(), nextReturning('unavailable'));

  // Let the delivery settle, then read the pending record.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(deliverCalls.length, 1);
  assert.equal(deliverCalls[0].openId, 'ou_user', 'approvals go to the operator privately');

  const pendingRecords = state.pendingForSession('s1');
  assert.equal(pendingRecords.length, 1);
  const id = pendingRecords[0].id;
  bridge.resolveApproval({ id, decision: 'allowed-once', operatorOpenId: 'ou_user' });
  assert.equal(await pending, 'allowed-once');
});

test('a rejected approval resolves to rejected', async () => {
  const { listeners, bridge, state } = install();
  const pending = listeners.get('approval/request')(approvalEvent(), nextReturning('unavailable'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const id = state.pendingForSession('s1')[0].id;
  bridge.resolveApproval({ id, decision: 'rejected', operatorOpenId: 'ou_user' });
  assert.equal(await pending, 'rejected');
});

test('an approval that cannot be delivered fails closed', async () => {
  const { listeners } = install({ deliver: async () => { throw new Error('no private chat'); } });
  const outcome = await listeners.get('approval/request')(approvalEvent(), nextReturning('unavailable'));
  assert.equal(outcome, 'rejected', 'delivery failure must never grant');
});

test('an approval with no reachable operator fails closed', async () => {
  const { listeners } = install({ operators: [] });
  const outcome = await listeners.get('approval/request')(approvalEvent(), nextReturning('unavailable'));
  assert.equal(outcome, 'rejected');
});

test('a stale approval card cannot decide twice', async () => {
  const { listeners, bridge, state } = install();
  const pending = listeners.get('approval/request')(approvalEvent(), nextReturning('unavailable'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const id = state.pendingForSession('s1')[0].id;

  assert.equal(bridge.resolveApproval({ id, decision: 'allowed-once', operatorOpenId: 'ou_user' }).ok, true);
  assert.equal(await pending, 'allowed-once');

  const second = bridge.resolveApproval({ id, decision: 'allowed-once', operatorOpenId: 'ou_user' });
  assert.equal(second.ok, false, 'a second press must not decide again');
});

test('an approval cannot be decided by someone else', async () => {
  const { listeners, bridge, state } = install();
  const pending = listeners.get('approval/request')(approvalEvent(), nextReturning('unavailable'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const id = state.pendingForSession('s1')[0].id;

  const foreign = bridge.resolveApproval({ id, decision: 'allowed-once', operatorOpenId: 'ou_other' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, 'forbidden');

  // The rightful operator still can.
  bridge.resolveApproval({ id, decision: 'rejected', operatorOpenId: 'ou_user' });
  assert.equal(await pending, 'rejected');
});

test('aborting the request cancels the approval and never grants it', async () => {
  const controller = new AbortController();
  const { listeners } = install();
  const pending = listeners.get('approval/request')(approvalEvent({ signal: controller.signal }), nextReturning('unavailable'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  assert.equal(await pending, 'rejected', 'an aborted approval resolves to a non-grant');
});

test('a task the bridge does not own is left to the next answerer', async () => {
  const listeners = new Map();
  const ctx = { on(name, handler) { listeners.set(name, handler); return () => {}; } };
  const bridge = new InteractionBridge({
    ctx,
    state: new InteractionState({ logger: silent }),
    api: {},
    logger: silent,
    taskLookup: () => null,
    operatorsFor: () => [],
    deliver: async () => ({}),
  });
  bridge.install();
  const outcome = await listeners.get('approval/request')(approvalEvent(), nextReturning('allowed-once'));
  assert.equal(outcome, 'allowed-once', 'the delegated answerer decides');
});

test('a question card carries every question and answers the original request', async () => {
  const { listeners, deliverCalls, bridge, state } = install();
  const pending = listeners.get('user-questions/request')(questionEvent(), nextReturning({ answers: [] }));
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(deliverCalls.length, 1);
  const cardText = JSON.stringify(deliverCalls[0].payload);
  assert.ok(cardText.includes('发布到哪个环境'));
  assert.ok(cardText.includes('测试'));
  // Answers travel as per-option callbacks; a form container is not used
  // because the platform rejects a submit button whose behavior it does not
  // recognise.
  assert.ok(cardText.includes('question.answer'), 'options are answer buttons');
  assert.ok(cardText.includes('填写文字'), 'each question offers a text path');

  const record = state.pendingForSession('s1')[0];
  const result = bridge.resolveQuestion({
    id: record.id,
    answers: [{ id: 'env', selected: ['生产'] }],
    operatorOpenId: 'ou_user',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(await pending, { answers: [{ id: 'env', selected: ['生产'] }] });
});

test('a question card that cannot be delivered defers to the next answerer', async () => {
  const { listeners, state } = install({ deliver: async () => { throw new Error('blocked'); } });
  const outcome = await listeners.get('user-questions/request')(
    questionEvent(),
    nextReturning({ answers: [] }),
  );
  // The bridge contributes nothing, so the waterfall's default answerer decides
  // — the request is neither auto-answered nor cancelled by the failure.
  assert.deepEqual(outcome, { answers: [] });
  assert.equal(state.pendingForSession('s1').length, 0, 'no bridge-side request is left open');
});

test('a settled question cannot be answered again', async () => {
  const { listeners, bridge, state } = install();
  const pending = listeners.get('user-questions/request')(questionEvent(), nextReturning({ answers: [] }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const id = state.pendingForSession('s1')[0].id;

  assert.equal(bridge.resolveQuestion({ id, answers: [], operatorOpenId: 'ou_user' }).ok, true);
  await pending;
  assert.equal(bridge.resolveQuestion({ id, answers: [], operatorOpenId: 'ou_user' }).ok, false);
});

test('cancelling a question resolves the request without an answer', async () => {
  const { listeners, bridge, state } = install();
  const pending = listeners.get('user-questions/request')(questionEvent(), nextReturning(null));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const id = state.pendingForSession('s1')[0].id;
  assert.equal(bridge.cancelQuestion({ id, operatorOpenId: 'ou_user' }).ok, true);
  assert.equal(await pending, null);
});

test('approval and question cards are distinguishable by shape', async () => {
  const { listeners, deliverCalls } = install();
  void listeners.get('approval/request')(approvalEvent(), nextReturning('unavailable'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  void listeners.get('user-questions/request')(questionEvent(), nextReturning({ answers: [] }));
  await new Promise((resolve) => setTimeout(resolve, 5));

  const [approvalCard, questionCard] = deliverCalls.map((call) => call.payload);
  assert.equal(approvalCard.header.title.content, '🔐 操作审批');
  assert.equal(questionCard.header.title.content, '❓ 需要你的选择');
  // An approval offers a decision; a question offers answer buttons.
  assert.ok(JSON.stringify(approvalCard).includes('允许一次'));
  assert.ok(!JSON.stringify(approvalCard).includes('question.answer'));
  assert.ok(JSON.stringify(questionCard).includes('question.answer'));
});