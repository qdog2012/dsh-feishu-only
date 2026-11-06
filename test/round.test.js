import test from 'node:test';
import assert from 'node:assert/strict';

import { isCapacityError, RoundTracker } from '../lib/round.js';
import { extractLastReply, groupRounds, textFromContent } from '../lib/harness.js';

function assistant(seq, text, turn = 1) {
  return {
    type: 'assistant/message',
    seq,
    time: seq,
    data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] }, stream: [] },
  };
}

function toolCall(seq, { name = 'bash', callId = 'c1', args = '{}' } = {}) {
  return { type: 'tool/call', seq, time: seq, data: { turn: 1, step: 1, callId, name, arguments: args } };
}

function toolResult(seq, { callId = 'c1', error } = {}) {
  return {
    type: 'tool/result',
    seq,
    time: seq,
    data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, content: [] }, ...(error ? { error } : {}) },
  };
}

test('a completed round exposes its final answer', () => {
  const tracker = new RoundTracker({ taskId: 's1' });
  const result = tracker.consume([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    assistant(2, '最终答复'),
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
  assert.equal(tracker.finished, true);
  assert.equal(tracker.phase, 'done');
  assert.deepEqual(result.final, { text: '最终答复', seq: 2 });
});

test('an aborted round reports stopped and produces no final answer', () => {
  const tracker = new RoundTracker({ taskId: 's1' });
  const result = tracker.consume([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
  ]);
  assert.equal(tracker.phase, 'stopped');
  assert.equal(result.final, undefined);
  assert.equal(tracker.detail, '已按你的要求停止。');
});

test('an errored round surfaces the failure reason', () => {
  const tracker = new RoundTracker({ taskId: 's1' });
  tracker.consume([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    {
      type: 'turn/end',
      seq: 2,
      data: { turn: 1, reason: { kind: 'error', error: { message: '模型容量不足', code: 'capacity' } } },
    },
  ]);
  assert.equal(tracker.phase, 'failed');
  assert.equal(tracker.failed, true);
  assert.ok(tracker.detail.includes('模型容量不足'));
});

test('tool calls render as user-facing progress, not raw arguments', () => {
  const tracker = new RoundTracker({ taskId: 's1' });
  tracker.consume([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    toolCall(2, { name: 'bash', callId: 'c1', args: '{"command":"rm -rf /tmp/x"}' }),
  ]);
  assert.deepEqual(tracker.toolLines, ['执行命令…']);
  assert.ok(!JSON.stringify(tracker.toolLines).includes('rm -rf'));

  tracker.consume([toolResult(3, { callId: 'c1' })]);
  assert.deepEqual(tracker.toolLines, ['执行命令 完成']);
});

test('a failed tool records the error reason on the card detail', () => {
  const tracker = new RoundTracker({ taskId: 's1' });
  tracker.consume([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    toolCall(2, { callId: 'c9', name: 'read' }),
    toolResult(3, { callId: 'c9', error: { name: 'FsError', code: 'ENOENT', reason: '文件不存在' } }),
  ]);
  assert.deepEqual(tracker.toolLines, ['读取文件 失败']);
  assert.ok(tracker.detail.includes('文件不存在'));
});

test('write tools record produced resources by basename only', () => {
  const tracker = new RoundTracker({ taskId: 's1' });
  tracker.consume([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    toolCall(2, { name: 'write', args: JSON.stringify({ file_path: 'C:/work/reports/final.md' }) }),
  ]);
  assert.deepEqual(tracker.resources, ['`final.md`']);
});

test('reading a file is progress, not a produced resource', () => {
  const tracker = new RoundTracker({ taskId: 's1' });
  tracker.consume([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    toolCall(2, { name: 'read', args: JSON.stringify({ file_path: 'C:/work/a.md' }) }),
  ]);
  assert.deepEqual(tracker.resources, []);
});

test('approval events move the round into a waiting phase', () => {
  const tracker = new RoundTracker({ taskId: 's1' });
  tracker.consume([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'approval/asked', seq: 2, data: { id: 'a1', toolName: 'bash' } },
  ]);
  assert.equal(tracker.phase, 'waiting');
  assert.ok(tracker.progress.includes('等待审批'));
  tracker.consume([{ type: 'approval/decided', seq: 3, data: { id: 'a1', outcome: 'allowed-once' } }]);
  assert.equal(tracker.phase, 'running');
  assert.ok(tracker.progress.includes('审批通过'));
});

test('events are consumed exactly once, in seq order', () => {
  const tracker = new RoundTracker({ taskId: 's1' });
  const events = [
    { type: 'turn/start', seq: 5, data: { turn: 1 } },
    assistant(6, '第一段'),
  ];
  tracker.consume(events);
  const again = tracker.consume(events);
  assert.equal(again.changed, false);
});

test('a retry wait is explicit and cancellable', () => {
  const tracker = new RoundTracker({ taskId: 's1' });
  tracker.noteRetry({ attempt: 3, reason: '模型容量不足' });
  assert.equal(tracker.phase, 'retrying');
  assert.ok(tracker.detail.includes('第 3 次'));
  tracker.clearRetry();
  assert.equal(tracker.phase, 'running');
  assert.equal(tracker.detail, null);
});

test('capacity errors are recognised and ordinary failures are not', () => {
  assert.equal(isCapacityError({ code: 'capacity_exceeded' }), true);
  assert.equal(isCapacityError({ message: 'HTTP 429 Too Many Requests' }), true);
  assert.equal(isCapacityError({ message: 'overloaded' }), true);
  assert.equal(isCapacityError({ message: 'service_unavailable' }), true);
  assert.equal(isCapacityError({ message: 'file not found' }), false);
  assert.equal(isCapacityError({ code: 'invalid_request' }), false);
  assert.equal(isCapacityError(null), false);
});

test('the last reply prefers a final answer over a streaming fragment', () => {
  const reply = extractLastReply([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    assistant(2, '旧的最终答复'),
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 4, data: { turn: 2 } },
    assistant(5, '还没写完的片段', 2),
  ]);
  assert.equal(reply.text, '旧的最终答复');
  assert.equal(reply.hasFinal, true);
});

test('an open turn with no final answer is flagged as not final', () => {
  const reply = extractLastReply([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    assistant(2, '进行中的文本'),
  ]);
  assert.equal(reply.hasFinal, false);
});

test('no displayable content yields null', () => {
  assert.equal(extractLastReply([{ type: 'turn/start', seq: 1, data: { turn: 1 } }]), null);
  assert.equal(extractLastReply([]), null);
});

test('history groups events into execution rounds', () => {
  const rounds = groupRounds([
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 2,
      time: 1001,
      data: { turn: 1, message: { role: 'user', content: [{ type: 'text', text: '需求一' }] } },
    },
    assistant(3, '答复一'),
    { type: 'turn/end', seq: 4, time: 1002, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 5, time: 2000, data: { turn: 2 } },
    {
      type: 'user/message',
      seq: 6,
      time: 2001,
      data: { turn: 2, message: { role: 'user', content: [{ type: 'text', text: '需求二' }] } },
    },
    { type: 'turn/end', seq: 7, time: 2002, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
  ]);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].status, '已完成');
  assert.equal(rounds[1].status, '已中止');
  assert.deepEqual(rounds[0].turns.map((turn) => turn.role), ['user', 'assistant']);
});

test('rounds without any visible turn are dropped', () => {
  const rounds = groupRounds([{ type: 'turn/start', seq: 1, data: { turn: 1 } }]);
  assert.deepEqual(rounds, []);
});

test('history keeps the request and the final reply, not the process', () => {
  // Tool calls and intermediate assistant messages are how the round was
  // produced; `/history` is for reading what was said.
  const rounds = groupRounds([
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 2,
      data: { turn: 1, message: { role: 'user', content: [{ type: 'text', text: '需求' }] } },
    },
    assistant(3, '中间步骤一'),
    { type: 'tool/call', seq: 4, data: { name: 'bash' } },
    assistant(5, '中间步骤二'),
    { type: 'tool/call', seq: 6, data: { name: 'read' } },
    assistant(7, '最终答复'),
    { type: 'turn/end', seq: 8, data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
  assert.equal(rounds.length, 1);
  assert.deepEqual(rounds[0].turns.map((turn) => turn.role), ['user', 'assistant']);
  assert.equal(rounds[0].turns.at(-1).text, '最终答复', 'only the last assistant message survives');
  assert.ok(
    !JSON.stringify(rounds).includes('bash'),
    'tool calls are not carried into history at all',
  );
});

test('a round that only made tool calls is dropped', () => {
  const rounds = groupRounds([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, data: { name: 'bash' } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
  assert.deepEqual(rounds, [], 'nothing was said, so there is nothing to show');
});

test('visible text is joined and reasoning is excluded', () => {
  const content = [
    { type: 'reasoning', text: '内部推理' },
    { type: 'text', text: '第一行' },
    { type: 'text', text: '第二行' },
    { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
  ];
  assert.equal(textFromContent(content), '第一行\n第二行');
});