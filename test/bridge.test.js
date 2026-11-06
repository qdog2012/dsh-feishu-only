import test from 'node:test';
import assert from 'node:assert/strict';

import { FeishuBridge } from '../lib/bridge.js';
import { InteractionState } from '../lib/state.js';

/**
 * A recording stand-in for the Feishu API, so a test can assert what the user
 * actually receives instead of what the bridge intended to send.
 */
class FakeApi {
  cards = [];
  texts = [];
  patched = [];
  images = [];

  async sendCard(chatId, payload, options = {}) {
    this.cards.push({ chatId, payload, options });
    return { message_id: `om_${this.cards.length}` };
  }

  async sendText(chatId, text) {
    this.texts.push({ chatId, text });
    return { message_id: `om_t${this.texts.length}` };
  }

  async patchCard(messageId, payload) {
    this.patched.push({ messageId, payload });
    return { ok: true };
  }

  async sendImage(chatId, imageKey) {
    this.images.push({ chatId, imageKey });
    return { ok: true };
  }

  async sendPrivateCard(openId, payload) {
    this.cards.push({ chatId: openId, payload, private: true });
    return { message_id: `om_p${this.cards.length}` };
  }

  async downloadResource() {
    // A 1x1 transparent PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    return { data: new Uint8Array(png), contentType: 'image/png', disposition: '' };
  }

  async uploadImage() {
    return 'img_key_1';
  }

  async uploadFile() {
    return 'file_key_1';
  }

  async sendFile() {
    return { ok: true };
  }

  get lastCard() {
    return this.cards.at(-1)?.payload ?? null;
  }

  get lastText() {
    return this.texts.at(-1)?.text ?? null;
  }
}

/** A recording stand-in for the Host capabilities. */
class FakeHarness {
  available = {
    agents: true,
    sessions: true,
    agentLoop: true,
    sessionController: true,
    approval: true,
    userQuestions: true,
    goals: true,
    permissionPresets: true,
    compaction: true,
    sessionTitle: true,
    sessionQuery: true,
    skills: true,
    sessionProjections: true,
  };

  tasks = [];
  prompts = [];
  cancels = [];
  created = [];
  goals = new Map();
  models = new Map();
  sessionEvents = [];
  /** The reply `/last` returns; tests replace it per case. */
  lastReplyValue = { ok: true, value: null };

  agent(sessionId) {
    return { id: sessionId };
  }

  session(sessionId) {
    const harness = this;
    return {
      id: sessionId,
      header: { cwd: 'D:/work' },
      get seq() {
        return harness.sessionEvents.length + 1;
      },
      snapshotEvents() {
        return harness.sessionEvents;
      },
    };
  }

  async ensureAgent() {
    return { ok: true, value: { id: 'agent' } };
  }

  async listTasks() {
    return { ok: true, value: this.tasks };
  }

  async searchTasks(keyword) {
    const needle = keyword.toLowerCase();
    return {
      ok: true,
      value: this.tasks
        .filter((task) => (task.title ?? '').toLowerCase().includes(needle))
        .map((task) => ({ sessionId: task.sessionId, title: task.title, snippet: task.title })),
    };
  }

  async createTask({ chatId, cwd }) {
    const sessionId = `feishu-${chatId}`;
    this.created.push({ chatId, cwd, sessionId });
    this.tasks = [{ sessionId, title: null, cwd: cwd ?? null, running: false, updatedAt: Date.now() }, ...this.tasks];
    return { ok: true, value: sessionId };
  }

  async taskState() {
    return { ok: true, value: { running: false, pendingInput: [] } };
  }

  async prompt(sessionId, content, options) {
    this.prompts.push({ sessionId, content, options });
    return { ok: true, value: { accepted: true } };
  }

  async cancelTurn(sessionId) {
    this.cancels.push(sessionId);
    return { ok: true };
  }

  goalOf(sessionId) {
    return this.goals.get(sessionId) ?? null;
  }

  async createGoal(sessionId, objective) {
    const goal = { objective, phase: 'active', activation: 'armed', roundsStarted: 0, maxGoalRounds: 20 };
    this.goals.set(sessionId, goal);
    return { ok: true, value: goal };
  }

  async updateGoal(sessionId, action) {
    if (action === 'clear') {
      this.goals.delete(sessionId);
      return { ok: true, value: {} };
    }
    return { ok: true, value: this.goals.get(sessionId) };
  }

  permissionOf() {
    return 'danger-full-access';
  }

  modelOf(sessionId) {
    return this.models.get(sessionId) ?? { provider: 'p', model: 'm', reasoningEffort: 'high' };
  }

  async modelCatalog() {
    return {
      ok: true,
      value: {
        groups: [{
          id: 'p',
          name: 'Provider',
          models: [
            { id: 'm', name: 'Model', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } },
            { id: 'm2', name: 'Model 2' },
          ],
        }],
      },
    };
  }

  async selectModel(sessionId, selection) {
    this.models.set(sessionId, { provider: 'p', model: 'm', ...selection });
    return { ok: true, value: selection };
  }

  async lastReply() {
    return this.lastReplyValue;
  }

  history() {
    return {
      ok: true,
      value: [{
        turn: 1,
        startSeq: 1,
        endSeq: 4,
        time: Date.now(),
        status: '已完成',
        turns: [
          { role: 'user', text: '需求' },
          { role: 'assistant', text: '答复' },
        ],
      }],
    };
  }

  async forkTask() {
    return { ok: true, value: 'feishu-forked' };
  }

  async listSkills() {
    return { ok: true, value: [{ name: 'demo-skill', description: '示例技能' }] };
  }

  async compact() {
    return { ok: true, value: { summarySeq: 3 } };
  }
}

/** A minimal Cordis-like context exposing only what the bridge reads. */
function fakeContext(services = {}) {
  return {
    get(name) {
      return services[name];
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
}

function makeBridge({ api = new FakeApi(), harness = new FakeHarness(), config = {} } = {}) {
  const state = new InteractionState({ logger: silent });
  const interactions = {
    resolveApproval: () => ({ ok: true }),
    resolveQuestion: () => ({ ok: true }),
    cancelQuestion: () => ({ ok: true }),
    install: () => () => {},
  };
  const bridge = new FeishuBridge({
    ctx: fakeContext(),
    config: {
      version: '0.1.0',
      groupRequireMention: true,
      rejectInputWhileRunning: true,
      defaultWorkspace: 'D:/work',
      ...config,
    },
    api,
    state,
    harness,
    logger: silent,
    interactions,
    preview: null,
  });
  return { bridge, state, api, harness };
}

/** Build one inbound text message event. */
function messageEvent(text, { chatType = 'p2p', mentions = [], messageId = `om_${Math.random()}` } = {}) {
  const message = {
    message_id: messageId,
    chat_id: 'oc_1',
    chat_type: chatType,
    message_type: 'text',
    content: JSON.stringify({ text }),
    mentions,
    create_time: String(Date.now()),
  };
  return {
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
    message,
  };
}

const silent = { info() {}, warn() {}, error() {}, debug() {} };

// --------------------------------------------------------------------- tests

test('/help renders the help card without needing a task', async () => {
  const { bridge, api } = makeBridge();
  await bridge.onMessage(messageEvent('/help'));
  assert.ok(api.cards.length >= 1);
  assert.match(api.lastCard.header.title.content, /DeepSeek Harness/u);
});

test('an unknown command is answered, never executed as a task', async () => {
  const { bridge, api, harness } = makeBridge();
  await bridge.onMessage(messageEvent('/deploy production'));
  assert.equal(harness.prompts.length, 0);
  assert.match(JSON.stringify(api.lastCard), /未知指令/u);
});

test('plain text without a selected task refuses to guess a target', async () => {
  const { bridge, api, harness } = makeBridge();
  await bridge.onMessage(messageEvent('帮我改一下这个文件'));
  assert.equal(harness.prompts.length, 0);
  assert.match(JSON.stringify(api.lastCard), /先选择任务/u);
});

test('/task create selects the new task, and the next message goes to it', async () => {
  const { bridge, harness, state } = makeBridge();
  await bridge.onMessage(messageEvent('/task create 重构登录'));
  assert.equal(state.currentTask('ou_user').title, '重构登录');

  await bridge.onMessage(messageEvent('开始吧'));
  assert.equal(harness.prompts.length, 1);
  assert.equal(harness.prompts[0].sessionId, state.currentTask('ou_user').sessionId);
  const textPart = harness.prompts[0].content.find((part) => part.type === 'text');
  assert.equal(textPart.text, '开始吧');
});

test('/task lists the numbered snapshot and /task <n> selects from it', async () => {
  const harness = new FakeHarness();
  harness.tasks = [
    { sessionId: 's1', title: '任务一', running: false, updatedAt: 2 },
    { sessionId: 's2', title: '任务二', running: true, updatedAt: 1 },
  ];
  const { bridge, api, state } = makeBridge({ harness });

  await bridge.onMessage(messageEvent('/task'));
  const payload = JSON.stringify(api.lastCard);
  assert.ok(payload.includes('任务一'));
  assert.ok(payload.includes('任务二'));

  await bridge.onMessage(messageEvent('/task 2'));
  assert.equal(state.currentTask('ou_user').sessionId, 's2');
});

test('/task <n> without a snapshot asks for a fresh list', async () => {
  const { bridge, api } = makeBridge();
  await bridge.onMessage(messageEvent('/task 1'));
  assert.match(api.lastText ?? '', /没有可用的任务列表快照/u);
});

test('/task <n> beyond the snapshot size is rejected', async () => {
  const harness = new FakeHarness();
  harness.tasks = [{ sessionId: 's1', title: 'only', running: false, updatedAt: 1 }];
  const { bridge, api, state } = makeBridge({ harness });
  await bridge.onMessage(messageEvent('/task'));
  await bridge.onMessage(messageEvent('/task 9'));
  assert.equal(state.currentTask('ou_user'), null);
  assert.match(api.lastText ?? '', /序号 9 不在/u);
});

test('/task current reports the facts that decide the next round', async () => {
  const harness = new FakeHarness();
  harness.tasks = [{ sessionId: 's1', title: '任务', running: false, updatedAt: 1 }];
  const { bridge, api } = makeBridge({ harness });
  await bridge.onMessage(messageEvent('/task'));
  await bridge.onMessage(messageEvent('/task 1'));
  await bridge.onMessage(messageEvent('/task current'));
  const payload = JSON.stringify(api.lastCard);
  assert.ok(payload.includes('danger-full-access'));
  assert.ok(payload.includes('p/m'));
});

test('a group message without a mention is ignored entirely', async () => {
  const { bridge, api, harness } = makeBridge();
  await bridge.onMessage(messageEvent('日常聊天', { chatType: 'group' }));
  assert.equal(api.cards.length, 0);
  assert.equal(harness.prompts.length, 0);
});

test('a redelivered platform message runs only once', async () => {
  const { bridge, harness } = makeBridge();
  await bridge.onMessage(messageEvent('/task create 去重'));
  await bridge.onMessage(messageEvent('只执行一次', { messageId: 'om_fixed' }));
  await bridge.onMessage(messageEvent('只执行一次', { messageId: 'om_fixed' }));
  assert.equal(harness.prompts.length, 1);
});

test('a running task refuses supplementary input when configured to', async () => {
  const harness = new FakeHarness();
  harness.taskState = async () => ({ ok: true, value: { running: true, pendingInput: [] } });
  const { bridge, api, state } = makeBridge({ harness });
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '运行中的任务' });
  await bridge.onMessage(messageEvent('补充一句'));
  assert.equal(harness.prompts.length, 0);
  assert.match(JSON.stringify(api.lastCard), /正在执行/u);
});

test('images alone are staged, then submitted together with the next text', async () => {
  const { bridge, api, harness, state } = makeBridge();
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  const imageEvent = messageEvent('', { messageId: 'om_img' });
  imageEvent.message.message_type = 'image';
  imageEvent.message.content = JSON.stringify({ image_key: 'img_1' });

  await bridge.onMessage(imageEvent);
  assert.equal(harness.prompts.length, 0, 'an image must wait for its instruction');
  assert.match(JSON.stringify(api.lastCard), /等待图片说明|暂存/u);
  assert.equal(state.stagedImages('ou_user').items.length, 1);

  await bridge.onMessage(messageEvent('这是截图', { messageId: 'om_text' }));
  assert.equal(harness.prompts.length, 1);
  const parts = harness.prompts[0].content;
  assert.ok(parts.some((part) => part.type === 'image'), 'the staged image is attached');
  assert.ok(parts.some((part) => part.type === 'text' && part.text === '这是截图'));
  assert.equal(state.stagedImages('ou_user'), null, 'the batch is consumed once');
});

test('staged images are not carried into a different task', async () => {
  const { bridge, api, harness, state } = makeBridge();
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务一' });
  const imageEvent = messageEvent('', { messageId: 'om_img2' });
  imageEvent.message.message_type = 'image';
  imageEvent.message.content = JSON.stringify({ image_key: 'img_1' });
  await bridge.onMessage(imageEvent);

  // Select another task, then send text: the old images must not follow.
  state.setCurrentTask('ou_user', { sessionId: 's2', label: '任务二' });
  await bridge.onMessage(messageEvent('新任务的需求', { messageId: 'om_text2' }));

  // The batch is dropped rather than silently delivered to the new task, and
  // the user is told why so the input is never lost without a trace.
  assert.equal(harness.prompts.length, 0, 'a stale image batch must not reach the new task');
  assert.match(api.lastText ?? '', /任务已经切换|没有提交/u);
  assert.equal(state.stagedImages('ou_user'), null);
});

test('/stop cancels the turn and explains the scope', async () => {
  const { bridge, api, harness, state } = makeBridge();
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  await bridge.onMessage(messageEvent('/stop'));
  assert.deepEqual(harness.cancels, ['s1']);
  const payload = JSON.stringify(api.lastCard);
  assert.ok(payload.includes('不会退出整个执行端'));
});

test('/status keeps the three states separate', async () => {
  const { bridge, api } = makeBridge();
  bridge.updateHealth({ bot: 'ok', ws: 'connected' });
  await bridge.onMessage(messageEvent('/status'));
  const payload = JSON.stringify(api.lastCard);
  assert.ok(payload.includes('机器人服务'));
  assert.ok(payload.includes('消息连接'));
  assert.ok(payload.includes('执行端'));
  assert.ok(payload.includes('不等于'));
});

test('/last is read-only and reports an unfinished turn instead of streaming text', async () => {
  const { bridge, api, harness, state } = makeBridge();
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  harness.lastReplyValue = { ok: true, value: { seq: 5, text: '片段', hasFinal: false } };
  const promptsBefore = harness.prompts.length;
  await bridge.onMessage(messageEvent('/last'));
  assert.equal(harness.prompts.length, promptsBefore, 'reading the last reply must not submit anything');
  assert.match(JSON.stringify(api.lastCard), /还在执行|尚未产生最终答复/u);
});

test('/last does not resend an already delivered answer', async () => {
  const { bridge, api, harness, state } = makeBridge();
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  harness.lastReplyValue = { ok: true, value: { seq: 7, text: '答复正文', hasFinal: true } };
  await bridge.onMessage(messageEvent('/last'));
  assert.match(JSON.stringify(api.lastCard), /答复正文/u);
  await bridge.onMessage(messageEvent('/last'));
  assert.match(JSON.stringify(api.lastCard), /已经发送过/u);
});

test('/goal set saves the goal and states that it starts a round', async () => {
  const { bridge, api, harness, state } = makeBridge();
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  await bridge.onMessage(messageEvent('/goal set 完成迁移'));
  assert.equal(harness.goalOf('s1').objective, '完成迁移');
  assert.ok(harness.prompts.length >= 1, 'setting a goal submits the starting input');
  const payload = JSON.stringify(api.cards);
  assert.ok(payload.includes('启动输入'));
});

test('/goal clear removes the goal and says so', async () => {
  const harness = new FakeHarness();
  harness.goals.set('s1', { objective: '旧目标', phase: 'active' });
  const { bridge, api, state } = makeBridge({ harness });
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  await bridge.onMessage(messageEvent('/goal clear'));
  assert.equal(harness.goals.has('s1'), false);
  assert.match(JSON.stringify(api.lastCard), /不再推进/u);
});

test('/model shows options and /model <n> applies the selection', async () => {
  const { bridge, api, harness, state } = makeBridge();
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  await bridge.onMessage(messageEvent('/model'));
  assert.match(JSON.stringify(api.lastCard), /Provider \/ Model/u);

  await bridge.onMessage(messageEvent('/model 2'));
  assert.deepEqual(harness.models.get('s1'), { provider: 'p', model: 'm2' });
  assert.match(JSON.stringify(api.lastCard), /下一轮开始生效/u);
});

test('/model without a task asks for one first', async () => {
  const { bridge, api } = makeBridge();
  await bridge.onMessage(messageEvent('/model'));
  assert.match(api.lastText ?? '', /请先选择一个任务/u);
});

test('/compact reports a pending result instead of a failure on timeout', async () => {
  const harness = new FakeHarness();
  harness.compact = () => new Promise(() => {});
  const { bridge, api, state } = makeBridge({ harness, config: { compactTimeoutMs: 20 } });
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  await bridge.onMessage(messageEvent('/compact'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.match(JSON.stringify(api.cards), /结果待确认/u);
});

test('/restart distinguishes itself from stopping a task', async () => {
  const { bridge, api } = makeBridge();
  await bridge.onMessage(messageEvent('/restart'));
  const payload = JSON.stringify(api.lastCard);
  assert.ok(payload.includes('可能中断多个正在进行的任务'));
  assert.ok(payload.includes('/stop'));
});

test('/history renders rounds from the task log', async () => {
  const harness = new FakeHarness();
  const { bridge, api, state } = makeBridge({ harness });
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  await bridge.onMessage(messageEvent('/history'));
  const payload = JSON.stringify(api.lastCard);
  assert.ok(payload.includes('第 1 轮'));
  assert.ok(payload.includes('需求'));
});

test('a task switch to an idle task fetches the latest reply once', async () => {
  const harness = new FakeHarness();
  harness.tasks = [{ sessionId: 's1', title: '任务', running: false, updatedAt: 1 }];
  harness.lastReplyValue = { ok: true, value: { seq: 3, text: '最新答复', hasFinal: true } };
  const { bridge, api } = makeBridge({ harness });
  await bridge.onMessage(messageEvent('/task'));
  await bridge.onMessage(messageEvent('/task 1'));
  const payload = JSON.stringify(api.cards);
  assert.ok(payload.includes('最新答复'));
});

test('a foreign operator cannot resolve another user\'s snapshot', async () => {
  const harness = new FakeHarness();
  harness.tasks = [{ sessionId: 's1', title: '任务', running: false, updatedAt: 1 }];
  const { bridge, api, state } = makeBridge({ harness });
  await bridge.onMessage(messageEvent('/task'));

  const collect = (node, found = []) => {
    if (!node || typeof node !== 'object') return found;
    if (Array.isArray(node)) {
      for (const item of node) collect(item, found);
      return found;
    }
    if (node.tag === 'button') found.push(node.behaviors?.[0]?.value);
    for (const value of Object.values(node)) collect(value, found);
    return found;
  };
  const button = collect(api.lastCard).find((value) => value?.id === 'task.select');
  assert.ok(button, 'the list must expose a select button');

  await bridge.onCardAction({
    operator: { open_id: 'ou_other' },
    action: { tag: 'button', value: { id: 'task.select', pageKey: button.pageKey, index: 1 } },
    context: { open_message_id: 'om_x', open_chat_id: 'oc_1' },
  });
  assert.equal(state.currentTask('ou_other'), null, 'a foreign snapshot must not select anything');
  assert.equal(state.currentTask('ou_user'), null, 'the owner is unaffected');
});

test('a card button press by the owner selects the task', async () => {
  const harness = new FakeHarness();
  harness.tasks = [{ sessionId: 's1', title: '任务', running: false, updatedAt: 1 }];
  const { bridge, api, state } = makeBridge({ harness });
  await bridge.onMessage(messageEvent('/task'));

  const collect = (node, found = []) => {
    if (!node || typeof node !== 'object') return found;
    if (Array.isArray(node)) {
      for (const item of node) collect(item, found);
      return found;
    }
    if (node.tag === 'button') found.push(node.behaviors?.[0]?.value);
    for (const value of Object.values(node)) collect(value, found);
    return found;
  };
  const button = collect(api.lastCard).find((value) => value?.id === 'task.select');

  await bridge.onCardAction({
    operator: { open_id: 'ou_user' },
    action: { tag: 'button', value: { id: 'task.select', pageKey: button.pageKey, index: 1 } },
    context: { open_message_id: 'om_x', open_chat_id: 'oc_1' },
  });
  assert.equal(state.currentTask('ou_user').sessionId, 's1');
});

test('a stale snapshot reports that the list expired', async () => {
  const harness = new FakeHarness();
  harness.tasks = [{ sessionId: 's1', title: '任务', running: false, updatedAt: 1 }];
  const { bridge } = makeBridge({ harness });
  await bridge.onMessage(messageEvent('/task'));

  const result = await bridge.onCardAction({
    operator: { open_id: 'ou_user' },
    action: { tag: 'button', value: { id: 'task.select', pageKey: 'gone', index: 1 } },
    context: { open_message_id: 'om_x', open_chat_id: 'oc_1' },
  });
  assert.match(result.toast.content, /过期|失效/u);
});

test('a rejected card falls back to plain text instead of silence', async () => {
  const api = new FakeApi();
  api.sendCard = async () => {
    const error = new Error('invalid card');
    error.code = 230025;
    throw error;
  };
  const state = new InteractionState({ logger: silent });
  const bridge = new FeishuBridge({
    ctx: fakeContext(),
    config: { version: '0.1.0', groupRequireMention: true, rejectInputWhileRunning: true },
    api,
    state,
    harness: new FakeHarness(),
    logger: silent,
    interactions: { install: () => () => {} },
    preview: null,
  });

  await bridge.onMessage(messageEvent('/help'));

  assert.equal(api.cards.length, 0, 'the card itself was rejected');
  assert.equal(api.texts.length, 1, 'the user still receives an answer');
  assert.match(api.texts[0].text, /DeepSeek Harness/u, 'the help content survives');
  assert.match(api.texts[0].text, /卡片渲染失败/u, 'the fallback is disclosed');
  assert.match(api.texts[0].text, /230025/u, 'the platform code is reported');
});

test('the text fallback drops card-only markup', async () => {
  const { renderCardAsText } = await import('../lib/bridge.js');
  const payload = {
    header: { title: { content: '标题' } },
    body: {
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '**粗体** <font color=\'grey\'>说明</font>' } },
        { tag: 'hr' },
        { tag: 'button', text: { content: '按钮' }, behaviors: [{ type: 'callback', value: { id: 'x' } }] },
        { tag: 'img', img_key: 'k' },
      ],
    },
  };
  const text = renderCardAsText(payload);
  assert.match(text, /标题/u);
  assert.match(text, /粗体/u);
  assert.ok(!text.includes('**'), 'markdown emphasis is stripped');
  assert.ok(!text.includes('<font'), 'font tags are stripped');
  assert.match(text, /\[按钮\]/u, 'a button becomes its label');
  assert.match(text, /\[图片\]/u);
});