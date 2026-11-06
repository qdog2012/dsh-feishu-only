import test from 'node:test';
import assert from 'node:assert/strict';

import {
  approvalCard,
  card,
  clampText,
  currentTaskCard,
  emptyResultCard,
  formatDuration,
  goalCard,
  helpCard,
  historyCard,
  pluginCard,
  previewCard,
  progressCard,
  questionCard,
  resultCard,
  settingsCard,
  stagedImagesCard,
  statusCard,
  taskListCard,
  taskSearchCard,
  updateCard,
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
});

test('a task is selected by its own title, not by a separate index list', () => {
  // The card used to print every task as text and then offer "选择 1 / 选择 2"
  // buttons: the same list twice, and the button did not say what it selected.
  const payload = taskListCard({
    currentTask: null,
    tasks: [
      { sessionId: 's1', title: '重构卡片系统', isCurrent: true },
      { sessionId: 's2', title: '修复长连接丢帧', running: true },
      { sessionId: 's3', title: '普通任务' },
    ],
    page: 1,
    totalPages: 1,
    total: 3,
    pageKey: 'snap-1',
  });
  const select = buttonsOf(payload).filter((button) => button.behaviors[0].value.id === 'task.select');
  assert.equal(select.length, 3, 'one button per task');
  assert.deepEqual(select.map((button) => button.text.content), [
    '1. 重构卡片系统 [当前]',
    '2. 修复长连接丢帧 [执行中]',
    '3. 普通任务',
  ]);

  // The titles must appear exactly once, inside the buttons.
  const text = JSON.stringify(payload);
  for (const title of ['重构卡片系统', '修复长连接丢帧', '普通任务']) {
    const occurrences = text.split(title).length - 1;
    assert.equal(occurrences, 1, `${title} is not repeated as body text`);
  }
  assert.ok(!text.includes('选择 1'), 'no separate numbered button row');
  assert.ok(!text.includes('选择 2'));
});

test('history is paginated ten rounds at a time', () => {
  // The bridge slices by `PAGE_SIZE.history` and the card numbers the rows; if
  // they disagree every page after the first is misnumbered.
  const rounds = Array.from({ length: 10 }, (_, index) => ({
    time: '00:00', status: '完成',
    turns: [{ role: 'user', text: `u${index}` }],
  }));
  const payload = historyCard({
    task: { title: 't' }, rounds, page: 2, totalPages: 3, pageKey: 'k',
  });
  const text = JSON.stringify(payload);
  assert.ok(text.includes('每页 10 轮'), 'the card states the page size');
  // Page 2 starts at round 11.
  assert.ok(text.includes('第 11 轮'), 'numbering continues across pages');
  assert.ok(text.includes('第 20 轮'));
});

test('the card page size matches the bridge page size', async () => {
  const { PAGE_SIZE } = await import('../lib/state.js');
  assert.equal(PAGE_SIZE.history, 10);
  const payload = historyCard({
    task: { title: 't' },
    rounds: [{ time: '00:00', status: '完成', turns: [] }],
    page: 1, totalPages: 1, pageKey: 'k',
  });
  assert.ok(JSON.stringify(payload).includes(`每页 ${PAGE_SIZE.history} 轮`));
});

test('each task occupies its own row', () => {
  // A full-width button shows the whole title; sharing a row truncated most.
  const payload = taskListCard({
    currentTask: null,
    tasks: [
      { sessionId: 's1', title: '一' },
      { sessionId: 's2', title: '二' },
      { sessionId: 's3', title: '三' },
    ],
    page: 1,
    totalPages: 1,
    total: 3,
    pageKey: 'k',
  });
  const rows = payload.body.elements.filter((element) => element.tag === 'column_set');
  const selectRows = rows.filter((row) => row.columns.length === 1
    && row.columns[0].elements[0]?.behaviors?.[0]?.value?.id === 'task.select');
  assert.equal(selectRows.length, 3, 'one row per task');
  for (const row of selectRows) {
    assert.equal(row.columns.length, 1, 'a task button is never paired');
  }
});

test('the current task is the primary button', () => {
  const payload = taskListCard({
    currentTask: null,
    tasks: [
      { sessionId: 's1', title: 'a', isCurrent: true },
      { sessionId: 's2', title: 'b' },
    ],
    page: 1,
    totalPages: 1,
    total: 2,
    pageKey: 'k',
  });
  const select = buttonsOf(payload).filter((button) => button.behaviors[0].value.id === 'task.select');
  assert.equal(select[0].type, 'primary');
  assert.equal(select[1].type, 'default');
});

test('a long task title is clamped so the button stays readable', () => {
  const payload = taskListCard({
    currentTask: null,
    tasks: [{ sessionId: 's1', title: '标'.repeat(200) }],
    page: 1,
    totalPages: 1,
    total: 1,
    pageKey: 'k',
  });
  const select = buttonsOf(payload).find((button) => button.behaviors[0].value.id === 'task.select');
  assert.ok(select.text.content.length < 100, 'the label is bounded');
  assert.ok(select.text.content.endsWith('…'), 'and marked as truncated');
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

test('the question card offers a callback button per option plus a text entry', () => {
  // A `form` container cannot be used: the platform rejects a submit button
  // whose behavior type it does not recognise, so answers travel as ordinary
  // callbacks like every other action in this bridge.
  const payload = questionCard({
    task: { title: 't' },
    questions: [
      { id: 'q1', question: '选哪个环境？', options: [{ label: '测试' }, { label: '生产' }] },
      { id: 'q2', question: '补充说明', options: undefined },
    ],
    cancelId: 'question.cancel:9',
    pendingId: 'p1',
  });

  const ids = buttonIds(payload);
  assert.ok(ids.includes('question.answer'), 'options are answer buttons');
  assert.ok(ids.includes('question.freeText'), 'each question accepts free text');
  assert.ok(ids.includes('question.cancel:9'));

  const answerButtons = buttonsOf(payload)
    .filter((button) => button.behaviors[0].value.id === 'question.answer');
  assert.equal(answerButtons.length, 2, 'one button per option');
  assert.deepEqual(
    answerButtons.map((button) => button.text.content),
    ['测试', '生产'],
  );
  for (const button of answerButtons) {
    assert.equal(button.behaviors[0].value.pendingId, 'p1', 'the pending answer set is addressed');
    assert.equal(button.behaviors[0].value.questionId, 'q1');
  }

  const text = JSON.stringify(payload);
  assert.ok(text.includes('自由文本') || text.includes('填写文字'), 'the text path is explained');
  assert.ok(!text.includes('"tag":"form"'), 'no form container is emitted');
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

// ------------------------------------------------------ schema 2.0 conformance

/**
 * The element tags Feishu schema 2.0 accepts inside `body.elements` and their
 * nested containers.
 *
 * A `{ tag: 'markdown' }` element is schema 1.0 only. Emitting it made Feishu
 * reject the entire card, so the bot sent nothing and appeared offline; that is
 * why this is asserted for every card the bridge can produce rather than for
 * one sample.
 */
const ALLOWED_TAGS = new Set([
  'div', 'hr', 'img', 'column_set', 'column', 'button', 'form', 'input',
  'select_static', 'multi_select_static', 'plain_text', 'lark_md', 'note', 'markdown',
]);

/** Tags that must never appear in a schema 2.0 body. */
const FORBIDDEN_TAGS = new Set(['markdown']);

function collectTags(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const item of node) collectTags(item, found);
    return found;
  }
  if (typeof node.tag === 'string') found.push(node.tag);
  for (const value of Object.values(node)) collectTags(value, found);
  return found;
}

/** Every card the bridge can send, built with the minimum viable arguments. */
function everyCard() {
  return {
    help: helpCard({ version: '1', botName: 'b' }),
    taskList: taskListCard({
      currentTask: { title: 't', settings: 's', status: 'idle', goal: 'g' },
      tasks: [{ sessionId: 's1', title: 'a', isCurrent: true }],
      page: 1, totalPages: 2, total: 11, pageKey: 'k',
    }),
    taskSearch: taskSearchCard({
      keyword: 'k', results: [{ title: 'a', snippet: 's' }], page: 1, totalPages: 1, pageKey: 'k',
    }),
    current: currentTaskCard({
      task: {
        id: 's1', title: 't', project: 'p', model: 'm', reasoning: 'high',
        permission: 'never', mode: 'normal', status: 'idle', goal: 'g', context: 'c',
      },
    }),
    settings: settingsCard({
      kind: 'model', title: 't', current: 'c',
      options: [{ label: 'a', selected: true, value: {} }], note: 'n',
    }),
    plugins: pluginCard({ plugins: [{ title: 'p', description: 'd' }], skills: [{ name: 's', description: 'd' }] }),
    history: historyCard({
      task: { title: 't' }, pageKey: 'k', page: 1, totalPages: 1,
      rounds: [{ time: '00:00', status: 'done', turns: [{ role: 'user', text: 'u' }, { role: 'assistant', text: 'a' }] }],
    }),
    goal: goalCard({
      task: { title: 't' },
      goal: { objective: 'o', phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 5 },
    }),
    staged: stagedImagesCard({ task: { title: 't' }, count: 2, files: ['2'] }),
    progress: progressCard({
      task: { title: 't' }, phase: 'running', turn: 1,
      toolLines: ['a'], progress: 'p', resources: ['r'], startedAt: Date.now(),
    }),
    result: resultCard({ task: { title: 't' }, text: 'answer', resources: ['r'], turn: 1 }),
    emptyResult: emptyResultCard({ task: { title: 't' }, reason: 'none' }),
    approval: approvalCard({
      task: { title: 't' }, toolName: 'bash', reason: 'r', detail: 'd',
      scopeNote: 's', allowOnceId: 'a1', rejectId: 'r1', expiresAt: Date.now(),
    }),
    question: questionCard({
      task: { title: 't' },
      questions: [
        { id: 'q1', question: '?', options: [{ label: 'a' }, { label: 'b' }] },
        { id: 'q2', question: '?', multiSelect: true, options: [{ label: 'a' }] },
      ],
      cancelId: 'c',
      pendingId: 'p1',
    }),
    preview: previewCard({ title: 't', description: 'd', imageKey: 'k', downloadId: 'x', note: 'n' }),
    update: updateCard({ currentVersion: '1', targetVersion: '2', state: 's', confirmId: 'c' }),
    status: statusCard({ bot: 'b', ws: 'w', tasks: 't', execution: 'e' }),
  };
}

test('no card uses an element tag outside schema 2.0', () => {
  for (const [name, payload] of Object.entries(everyCard())) {
    for (const tag of collectTags(payload)) {
      assert.ok(ALLOWED_TAGS.has(tag), `${name}: unknown element tag "${tag}"`);
      assert.ok(!FORBIDDEN_TAGS.has(tag), `${name}: schema 1.0 tag "${tag}" would fail the send`);
    }
  }
});

test('every card is a well-formed schema 2.0 document', () => {
  for (const [name, payload] of Object.entries(everyCard())) {
    assert.equal(payload.schema, '2.0', `${name}: schema`);
    assert.ok(payload.body && Array.isArray(payload.body.elements), `${name}: body.elements`);
    assert.ok(payload.body.elements.length > 0, `${name}: the body is not empty`);
    if (payload.header) {
      assert.equal(payload.header.title.tag, 'plain_text', `${name}: header title tag`);
      assert.ok(payload.header.template, `${name}: header template`);
    }
  }
});

test('rich text is always a div wrapping lark_md', () => {
  for (const [name, payload] of Object.entries(everyCard())) {
    const texts = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.tag === 'div' && node.text) texts.push(node.text.tag);
      Object.values(node).forEach(walk);
    };
    walk(payload);
    for (const tag of texts) {
      assert.ok(tag === 'lark_md' || tag === 'plain_text', `${name}: div text tag was "${tag}"`);
    }
  }
});

test('buttons carry a callback behavior the dispatcher can route', () => {
  for (const [name, payload] of Object.entries(everyCard())) {
    for (const button of buttonsOf(payload)) {
      assert.ok(Array.isArray(button.behaviors), `${name}: button has no behaviors`);
      assert.equal(button.behaviors[0].type, 'callback', `${name}: button is not a callback`);
      assert.ok(button.behaviors[0].value, `${name}: button has no value`);
      assert.equal(typeof button.text.content, 'string', `${name}: button has no label`);
    }
  }
});

test('every column declares a weighted width', () => {
  // Schema 2.0 rejects a column without `width: 'weighted'` + `weight` with
  // "invalid width", which failed every card containing a button row.
  for (const [name, payload] of Object.entries(everyCard())) {
    const columns = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.tag === 'column') columns.push(node);
      Object.values(node).forEach(walk);
    };
    walk(payload);
    for (const column of columns) {
      assert.equal(column.width, 'weighted', `${name}: column width`);
      assert.equal(typeof column.weight, 'number', `${name}: column weight`);
    }
  }
});

test('a confirmation dialog uses plain_text objects on both fields', () => {
  // A bare string on either field makes the platform fail to unmarshal the
  // card ("failed to unmarshal for PlainText").
  const payload = goalCard({
    task: { title: 't' },
    goal: { objective: 'o', phase: 'active', activation: 'armed', roundsStarted: 0, maxGoalRounds: 3 },
  });
  const withConfirm = buttonsOf(payload).filter((button) => button.confirm);
  assert.ok(withConfirm.length > 0, 'the destructive action asks for confirmation');
  for (const button of withConfirm) {
    assert.equal(button.confirm.title.tag, 'plain_text');
    assert.equal(typeof button.confirm.title.content, 'string');
    assert.equal(button.confirm.text.tag, 'plain_text');
    assert.equal(typeof button.confirm.text.content, 'string');
  }
});