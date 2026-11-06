import test from 'node:test';
import assert from 'node:assert/strict';

import { InteractionBridge } from '../lib/interactions.js';
import { InteractionState } from '../lib/state.js';
import { RoundTracker } from '../lib/round.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Install the bridge and return its `agent/request-error` listener plus the
 * state it reads, so a test can drive one capacity failure end to end.
 */
function install({ retryWaitMs = 5, roundActive = true } = {}) {
  const listeners = new Map();
  const ctx = {
    on(name, handler) {
      listeners.set(name, handler);
      return () => listeners.delete(name);
    },
  };
  const state = new InteractionState({ logger: silent });
  if (roundActive) {
    const tracker = new RoundTracker({ taskId: 's1' });
    tracker.consume([{ type: 'turn/start', seq: 1, data: { turn: 1 } }]);
    state.registerRound('s1', tracker);
  }
  const bridge = new InteractionBridge({
    ctx,
    state,
    api: {},
    logger: silent,
    retryWaitMs,
    taskLookup: () => ({ label: '任务' }),
    operatorsFor: () => [{ openId: 'ou_user', chatId: 'oc_private' }],
    deliver: async () => ({ message_id: 'om' }),
  });
  bridge.install();
  return { bridge, state, listeners, ctx };
}

function capacityFailure({ signal } = {}) {
  return {
    agent: { id: 's1' },
    turn: 1,
    step: 1,
    provider: 'p',
    failure: { message: 'model capacity exceeded', code: 'capacity' },
    signal: signal ?? new AbortController().signal,
  };
}

test('a capacity failure on a tracked task is retried', async () => {
  const { listeners } = install();
  const handler = listeners.get('agent/request-error');
  let delegated = false;
  const action = await handler(capacityFailure(), async () => {
    delegated = true;
    return undefined;
  });
  assert.deepEqual(action, { kind: 'retry' }, 'the bridge owns recovery');
  assert.equal(delegated, false, 'a claimed retry must not delegate');
});

test('an untracked task is never retried: observation is not authorization', async () => {
  const { listeners } = install({ roundActive: false });
  let delegated = false;
  const action = await listeners.get('agent/request-error')(capacityFailure(), async () => {
    delegated = true;
    return undefined;
  });
  assert.equal(action, undefined);
  assert.equal(delegated, true, 'the failure stays terminal for a task we do not own');
});

test('a non-capacity failure is not retried', async () => {
  const { listeners } = install();
  const payload = capacityFailure();
  payload.failure = { message: 'invalid api key', code: 'auth' };
  let delegated = false;
  const action = await listeners.get('agent/request-error')(payload, async () => {
    delegated = true;
    return undefined;
  });
  assert.equal(action, undefined);
  assert.equal(delegated, true);
});

test('an aborted turn is not retried', async () => {
  const controller = new AbortController();
  controller.abort();
  const { listeners } = install();
  let delegated = false;
  const action = await listeners.get('agent/request-error')(capacityFailure({ signal: controller.signal }), async () => {
    delegated = true;
    return undefined;
  });
  assert.equal(action, undefined);
  assert.equal(delegated, true);
});

test('the wait is published on the progress card with its attempt count', async () => {
  const { listeners, state } = install({ retryWaitMs: 30 });
  const tracker = state.round('s1');
  const pending = listeners.get('agent/request-error')(capacityFailure(), async () => undefined);

  // The card must explain the wait immediately, not only once it ends.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(tracker.phase, 'retrying');
  assert.match(tracker.detail, /第 1 次/u);
  assert.match(tracker.detail, /容量/u);

  await pending;
  assert.equal(tracker.phase, 'retrying', 'the phase stays visible until the retry resumes');
});

test('a cancelled turn ends the wait and never retries', async () => {
  const controller = new AbortController();
  const { listeners, state } = install({ retryWaitMs: 5_000 });
  const tracker = state.round('s1');
  const pending = listeners.get('agent/request-error')(
    capacityFailure({ signal: controller.signal }),
    async () => undefined,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  const action = await pending;

  assert.equal(action, undefined, 'a stop must end the retry schedule');
  assert.equal(tracker.phase, 'running', 'and clear the wait state');
  assert.equal(tracker.detail, null);
});

test('a superseded round does not receive a retry', async () => {
  const { listeners, state } = install({ retryWaitMs: 40 });
  const tracker = state.round('s1');
  const pending = listeners.get('agent/request-error')(capacityFailure(), async () => undefined);

  // A new round replaces the tracker while the wait is in flight.
  const replacement = new RoundTracker({ taskId: 's1' });
  replacement.consume([{ type: 'turn/start', seq: 2, data: { turn: 2 } }]);
  state.registerRound('s1', replacement);
  tracker.active = false;

  const action = await pending;
  assert.equal(action, undefined, 'a stale wait must not retry into the new round');
});

test('a second capacity failure reports its own attempt number', async () => {
  const { listeners, state } = install({ retryWaitMs: 1 });
  const handler = listeners.get('agent/request-error');
  const tracker = state.round('s1');

  await handler(capacityFailure(), async () => undefined);
  const second = handler(capacityFailure(), async () => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(tracker.detail, /第 2 次/u);
  await second;
});