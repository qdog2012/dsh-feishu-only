import test from 'node:test';
import assert from 'node:assert/strict';

import {
  approvalCard,
  card,
  clampText,
  currentTaskCard,
  formatDuration,
  helpCard,
  previewCard,
  progressCard,
  questionCard,
  resultCard,
  settingsCard,
  stagedImagesCard,
  taskListCard,
} from '../lib/cards.js';

/** Every button in a card, flattened out of column sets and forms. */
function buttonsOf(payload) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.tag === 'button') found.push(node);
    for (const value of Object.values(node)) walk(value);
  };
  walk(payload);
  return found;
}

function buttonIds(payload) {
  return buttonsOf(payload).map((button) => button.behaviors?.[0]?.value?.id);
}

test('every card is schema 2.0 with a body and an updatable config', () => {
  const payload = card({ title: 'T', elements: [] });
  assert.equal(payload.schema, '2.0');
  assert.equal(payload.config.update_multi, true);
  assert.ok(Array.isArray(payload.body.elements));
  assert.equal(payload.header.title.content, 'T');
});

test('help advertises the documented entry points', () => {
  const payload = helpCard({ version: '1.0.0', botName: '机器人' });
  assert.equal(payload.header.subtitle.content, '当前机器人：机器人');
  const ids = buttonIds(payload);
  assert.deepEqual(ids, ['task.list', 'history.show', 'settings.show']);
  const text = JSON.stringify(payload);
  for (const command of ['/task', '/history', '/last', '/model', '/goal', '/stop', '/status']) {
    assert.ok(text.includes(command), `${command} should be mentioned in help`);
  }
});

test('the task list carries a snapshot key on every select button', () => {
  const payload = taskListCard({
    currentTask: { title: '当前任务', settings: '模型 A', status: '空闲', goal: '未设置' },
    tasks: [
      { sessionId: 's1', title: '一', isCurrent: true },
      { sessionId: 's2', title: '二', running: true },
    ],
    page: 1,
    totalPages: 1,
    total: 2,
    pageKey: 'snap-1',
  });
  const selectButtons = buttonsOf(payload).filter((button) => button.behaviors[0].value.id === 'task.select');
  assert.equal(selectButtons.length, 2);
  for (const button of selectButtons) {
    assert.equal(button.behaviors[0].value.pageKey, 'snap-1');
  }
  assert.deepEqual(
    selectButtons.map((button) => button.behaviors[0].value.index),
    [1, 2],
  );
  const text = JSON.stringify(payload);
  assert.ok(text.includes('**当前**'), 'the current task must be marked');
  assert.ok(text.includes('执行中'), 'a running task must be marked');
});

test('the task list offers paging only when there is another page', () => {
  const base = { currentTask: null, tasks: [{ sessionId: 's1', title: 'x' }], total: 30, pageKey: 'k' };
  const first = taskListCard({ ...base, page: 1, totalPages: 3 });
  assert.ok(buttonIds(first).includes('task.page'));
  const last = taskListCard({ ...base, page: 3, totalPages: 3 });
  assert.ok(buttonIds(last).includes('task.page'));
  const only = taskListCard({ ...base, page: 1, totalPages: 1 });
  assert.ok(!buttonIds(only).includes('task.page'));
});

test('selecting a task without any current task still explains the state', () => {
  const payload = taskListCard({ currentTask: null, tasks: [], page: 1, totalPages: 1, total: 0, pageKey: 'k' });
  const text = JSON.stringify(payload);
  assert.ok(text.includes('当前没有选中任务'));
  assert.ok(text.includes('新建任务'));
});

test('the current-task card shows every setting that decides the next round', () => {
  const payload = currentTaskCard({
    task: {
      id: 's1',
      title: '修复登录',
      project: 'D:/proj',
      model: 'p/m',
      reasoning: 'high',
      permission: 'danger-full-access',
      mode: '普通模式',
      status: '空闲',
      goal: '未设置',
      context: '1200 tokens',
    },
  });
  const text = JSON.stringify(payload);
  for (const fact of ['修复登录', 'p/m', 'high', 'danger-full-access', '1200 tokens']) {
    assert.ok(text.includes(fact), `${fact} should be shown`);
  }
});

test('the settings card marks the current option and pages', () => {
  const payload = settingsCard({
    kind: 'model',
    title: '🧠 模型',
    current: 'a/b',
    options: [
      { label: 'A/B', selected: true, value: { provider: 'a', model: 'b' } },
      { label: 'C/D', selected: false, value: { provider: 'c', model: 'd' } },
    ],
    page: 1,
    totalPages: 2,
    note: '从下一轮生效',
  });
  const text = JSON.stringify(payload);
  assert.ok(text.includes('✅'));
  assert.ok(text.includes('从下一轮生效'));
  const ids = buttonIds(payload);
  assert.ok(ids.includes('settings.page'));
  assert.equal(ids.filter((id) => id === 'settings.select').length, 2);
  const select = buttonsOf(payload).find((button) => button.behaviors[0].value.id === 'settings.select');
  assert.equal(select.behaviors[0].value.kind, 'model');
  assert.equal(select.behaviors[0].value.index, 1);
});

test('the progress card reports phase, tools, resources and offers a stop', () => {
  const payload = progressCard({
    task: { title: '跑测试' },
    phase: 'running',
    turn: 3,
    toolLines: ['执行命令…'],
    progress: '正在运行测试',
    resources: ['`out.txt`'],
    startedAt: Date.now() - 5000,
  });
  const text = JSON.stringify(payload);
  assert.ok(text.includes('执行中'));
  assert.ok(text.includes('第 3 轮'));
  assert.ok(text.includes('执行命令'));
  assert.ok(text.includes('out.txt'));
  assert.ok(buttonIds(payload).includes('round.stop'));
});

test('the progress card never claims completion for a failed round', () => {
  const payload = progressCard({
    task: { title: 'x' },
    phase: 'failed',
    toolLines: [],
    progress: '',
    resources: [],
    detail: '模型返回错误',
    startedAt: Date.now(),
  });
  assert.equal(payload.header.template, 'red');
  assert.ok(JSON.stringify(payload).includes('模型返回错误'));
});

test('the approval card separates one-off from session scope and requires a button press', () => {
  const payload = approvalCard({
    task: { title: 't' },
    toolName: 'bash',
    reason: '需要写入工作区',
    detail: 'rm -rf build',
    scopeNote: '本任务始终允许的范围与执行端一致',
    allowOnceId: 'approval.allow:1',
    allowSessionId: null,
    rejectId: 'approval.reject:1',
  });
  const ids = buttonIds(payload);
  assert.deepEqual(ids, ['approval.allow:1', 'approval.reject:1']);
  const text = JSON.stringify(payload);
  assert.ok(text.includes('bash'));
  assert.ok(text.includes('范围'));
  // Nothing in the card payload can grant by itself: a decision is a button id.
  assert.ok(!text.includes('"granted"'));
});

test('the question card groups every question into one submittable form', () => {
  const payload = questionCard({
    task: { title: 't' },
    questions: [
      { id: 'q1', question: '选哪个环境？', options: [{ label: '测试' }, { label: '生产' }] },
      { id: 'q2', question: '补充说明', options: undefined },
      { id: 'q3', question: '多选', options: [{ label: '甲' }, { label: '乙' }], multiSelect: true },
    ],
    cancelId: 'question.cancel:9',
  });
  const forms = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.tag === 'form') forms.push(node);
    Object.values(node).forEach(walk);
  };
  walk(payload);
  assert.equal(forms.length, 1, 'all questions submit together');

  const fields = forms[0].elements.flatMap((element) => (element && typeof element === 'object' && element.name ? [element] : []));
  const names = fields.map((field) => field.name);
  assert.ok(names.includes('q_q1') && names.includes('c_q1'));
  assert.ok(names.includes('c_q2'), 'a free-text question still gets an input');
  assert.ok(names.includes('q_q3'));
  assert.equal(fields.find((field) => field.name === 'q_q3').tag, 'multi_select_static');
  assert.equal(fields.find((field) => field.name === 'q_q1').tag, 'select_static');

  const text = JSON.stringify(payload);
  assert.ok(text.includes('不会作答'), 'the card warns that chatting does not answer it');
  assert.ok(buttonIds(payload).includes('question.submit'));
  assert.ok(buttonIds(payload).includes('question.cancel:9'));
});

test('the result card is independent from progress and offers a read-only refetch', () => {
  const payload = resultCard({ task: { title: 't' }, text: '答案正文', turn: 2 });
  const text = JSON.stringify(payload);
  assert.ok(text.includes('答案正文'));
  assert.ok(text.includes('第 2 轮'));
  assert.ok(buttonIds(payload).includes('result.last'));
});

test('a staged-image card states the count and how to continue', () => {
  const payload = stagedImagesCard({ task: { title: 't' }, count: 3, files: ['3 张'] });
  const text = JSON.stringify(payload);
  assert.ok(text.includes('3'));
  assert.ok(text.includes('发送文字'));
  assert.ok(buttonIds(payload).includes('staged.cancel'));
});

test('a preview card offers download separately from the rendering', () => {
  const payload = previewCard({
    title: '📄 报告.docx',
    description: '已转换',
    imageKey: 'img_1',
    downloadId: 'preview.download:/tmp/a.docx',
    note: '预览不等于上传附件',
  });
  const ids = buttonIds(payload);
  assert.deepEqual(ids, ['preview.download:/tmp/a.docx']);
  assert.equal(payload.body.elements[0].img_key, 'img_1');
  assert.ok(JSON.stringify(payload).includes('不等于'));
});

test('a failed preview explains why instead of showing a misleading button', () => {
  const payload = previewCard({ title: '无法预览', failed: '路径不存在' });
  assert.equal(payload.header.template, 'orange');
  assert.equal(buttonsOf(payload).length, 0);
});

test('long text is clamped and marked as truncated', () => {
  const long = 'x'.repeat(50_000);
  const clamped = clampText(long, 4000);
  assert.ok(clamped.length < 4100);
  assert.ok(clamped.includes('截断'));
  assert.equal(clampText('short'), 'short');
});

test('durations read naturally', () => {
  assert.equal(formatDuration(9_000), '9s');
  assert.equal(formatDuration(127_000), '2m 07s');
  assert.equal(formatDuration(3_723_000), '1h 02m 03s');
});