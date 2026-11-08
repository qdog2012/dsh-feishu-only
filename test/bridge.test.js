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
  /**
   * Directory browsing and project creation.
   *
   * The real adapter reads `directoryPicker` and `workspaceRegistry` from the
   * context; the fake holds them directly so a test states what the deployment
   * can do rather than what the adapter does with it.
   */
  directoryListing = null;
  browsedPaths = [];
  createdProjects = [];

  async browseDirectory(path) {
    this.browsedPaths.push(path ?? null);
    if (!this.directoryListing) {
      return { ok: false, reason: '当前部署没有提供目录浏览能力。' };
    }
    const listing = typeof this.directoryListing === 'function'
      ? this.directoryListing(path)
      : this.directoryListing;
    return { ok: true, value: listing };
  }

  async createProject(path, title) {
    this.createdProjects.push({ path, title });
    if (this.projectCreateFails) return { ok: false, reason: this.projectCreateFails };
    return { ok: true, value: { id: 'w1', path, title } };
  }
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
  /** Whether a live agent exists; false models a task that has never run. */
  agentAvailable = true;

  agent(sessionId) {
    // A task that has never run in this process has no live agent; tests that
    // exercise that set `agentAvailable = false`.
    return this.agentAvailable === false ? null : { id: sessionId };
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

/**
 * Every button value in a card, wherever it sits.
 *
 * Shared rather than redefined per test: several tests need to find a button by
 * its callback id, and a local copy silently breaks when a test forgets it.
 */
function collect(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, found);
    return found;
  }
  if (node.tag === 'button') found.push(node.behaviors?.[0]?.value);
  for (const value of Object.values(node)) collect(value, found);
  return found;
}

function makeBridge({ api = new FakeApi(), harness = new FakeHarness(), config = {}, services = {} } = {}) {
  const state = new InteractionState({ logger: silent });
  const interactions = {
    resolveApproval: () => ({ ok: true }),
    resolveQuestion: () => ({ ok: true }),
    cancelQuestion: () => ({ ok: true }),
    install: () => () => {},
  };
  const bridge = new FeishuBridge({
    ctx: fakeContext(services),
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

test('a message sent during a running turn is appended as a supplement', async () => {
  // Rejecting made the bot feel deaf: a follow-up sent while it worked was
  // thrown away. It now joins the turn in progress via `steer`.
  const harness = new FakeHarness();
  harness.taskState = async () => ({ ok: true, value: { running: true, pendingInput: [] } });
  const { bridge, api, state } = makeBridge({ harness });
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '运行中的任务' });
  await bridge.onMessage(messageEvent('补充一句'));

  assert.equal(harness.prompts.length, 1, 'the message was submitted, not dropped');
  assert.equal(harness.prompts[0].options.mode, 'steer', 'and steered into the live turn');
  assert.equal(harness.prompts[0].content.at(-1).text, '补充一句');
  const card = JSON.stringify(api.lastCard);
  assert.match(card, /已追加为补充输入/u);
  assert.match(card, /补充一句/u);
});

test('an image batch during a running turn is not split into a steer', async () => {
  // Images are staged and submitted as one batch; steering would break the
  // batch, so those must take the normal path instead.
  const harness = new FakeHarness();
  harness.taskState = async () => ({ ok: true, value: { running: true, pendingInput: [] } });
  const { bridge, state } = makeBridge({ harness });
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  const event = messageEvent('', { messageId: 'om_img2' });
  event.message.message_type = 'image';
  event.message.content = JSON.stringify({ image_key: 'img_1' });
  await bridge.onMessage(event);
  const modes = harness.prompts.map((p) => p.options?.mode);
  assert.ok(!modes.includes('steer'), 'an image batch is never steered');
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
test('the project list is one button per project, labelled with the project', async () => {
  const workspaces = [
    { id: 'w1', title: '飞书插件', path: 'D:/p/feishu' },
    { id: 'w2', title: '另一个项目', path: 'D:/p/other' },
  ];
  const { bridge, api } = makeBridge({
    services: { workspaceRegistry: { list: () => workspaces } },
  });
  await bridge.onMessage(messageEvent('/project'));

  const payload = JSON.stringify(api.lastCard);
  // A separate numbered text list plus "选择 N" buttons repeated every name;
  // the label must carry the project itself.
  assert.ok(!payload.includes('选择 1'), 'no separate numbered button');
  assert.ok(payload.includes('1. 飞书插件'), 'the title is the button label');
  assert.ok(payload.includes('2. 另一个项目'));
  // Each title appears once: inside its button, not repeated as body text.
  for (const title of ['飞书插件', '另一个项目']) {
    assert.equal(payload.split(title).length - 1, 1, title + ' appears exactly once');
  }
  // Schema 2.0 only: a markdown element would get the card rejected.
  assert.ok(!payload.includes('\\"tag\\":\\"markdown\\"'), 'no schema 1.0 element');
});

test('/mode explains that a task must run once before the mode can switch', async () => {
  // planMode.set needs a live Agent, and an agent exists only after the task
  // has actually run in this process. The old message said "unsupported",
  // which was both wrong and a dead end.
  const { bridge, api } = makeBridge();
  const state = bridge;
  void state;
  // With no current task the command asks for one first.
  await bridge.onMessage(messageEvent('/mode'));
  assert.match(api.lastText ?? '', /请先选择一个任务/u);
});

test('/mode reports what actually happened to the switch', async () => {
  // The service answers committed / queued / cancelled / noop, and the card
  // must not reduce them all to "takes effect next round".
  const { readFileSync } = await import('node:fs');
  const outcomes = {
    committed: '从下一轮开始生效',
    queued: '本轮下一个步骤生效',
    noop: '已经是这个模式',
    cancelled: '相互抵消',
  };
  // Guard the copy: each outcome has its own sentence in the bridge.
  const source = readFileSync('lib/bridge.js', 'utf8');
  for (const [outcome, phrase] of Object.entries(outcomes)) {
    assert.ok(source.includes(phrase), outcome + ' has its own wording');
  }
});

test('/mode reports an unknown state instead of guessing 普通模式', async () => {
  // planMode.get needs a live Agent, which a task that has never run has not.
  // The card used to mark 普通模式 selected in that case - a guess.
  const harness = new FakeHarness();
  harness.agentAvailable = false;
  const { bridge, api, state } = makeBridge({
    harness,
    services: { planMode: { get: () => ({ active: false }), set: () => 'committed' } },
  });
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  await bridge.onMessage(messageEvent('/mode'));
  const text = JSON.stringify(api.lastCard);
  assert.match(text, /未知（任务还没执行过）/u);
  // Neither option may be marked current when the state is unknown.
  assert.doesNotMatch(text, /普通模式[^*"]*✅/u);
});

test('/mode shows a pending switch on the card', async () => {
  // planMode.set can answer "queued": the new state is selected but not yet in
  // effect. Reporting only active would show the old state as if nothing had
  // happened.
  const { bridge, api, state } = makeBridge({
    services: { planMode: { get: () => ({ active: false, pending: true }), set: () => 'queued' } },
  });
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  await bridge.onMessage(messageEvent('/mode'));
  assert.match(JSON.stringify(api.lastCard), /排队/u);
});
test('the new-task button opens a form instead of telling the user to type', async () => {
  // The button used to reply "send /task create <title>", which is exactly the
  // command the button was meant to replace.
  const { bridge, api } = makeBridge();
  await bridge.onCardAction({
    operator: { open_id: 'ou_user' },
    action: { tag: 'button', value: { id: 'task.create' } },
    context: { open_message_id: 'om_1', open_chat_id: 'oc_1' },
  });
  const card = JSON.stringify(api.lastCard);
  assert.match(card, /"tag":"form"/u);
  assert.match(card, /"tag":"input"/u);
  assert.ok(!card.includes("/task create"), "the card must not instruct a command");
});

test('submitting the new-task form creates and selects the task', async () => {
  const { bridge, api, state } = makeBridge();
  await bridge.onCardAction({
    operator: { open_id: 'ou_user' },
    action: {
      tag: 'button',
      form_value: { title: '修复登录超时' },
      value: { id: 'task.create.submit' },
    },
    context: { open_message_id: 'om_2', open_chat_id: 'oc_1' },
  });
  const current = state.currentTask('ou_user');
  assert.ok(current, 'a task became current');
  assert.equal(current.title, '修复登录超时', 'the typed title is used');
  const card = JSON.stringify(api.lastCard);
  assert.match(card, /已创建任务/u);
  assert.match(card, /修复登录超时/u);
});

test('an empty new-task submission creates nothing', async () => {
  const { bridge, state } = makeBridge();
  await bridge.onCardAction({
    operator: { open_id: 'ou_user' },
    action: { tag: 'button', form_value: { title: '   ' }, value: { id: 'task.create.submit' } },
    context: { open_message_id: 'om_3', open_chat_id: 'oc_1' },
  });
  assert.equal(state.currentTask('ou_user'), null, 'a blank title does not create a task');
});
test('/task search without a keyword asks in a form, not a syntax line', async () => {
  const { bridge, api, state } = makeBridge();
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  await bridge.onMessage(messageEvent('/task search'));
  const card = JSON.stringify(api.lastCard);
  assert.match(card, /"tag":"form"/u, "a form is shown");
  assert.match(card, /task\.search\.submit/u, "and it submits a search");
  assert.ok(!card.includes("请提供搜索关键词"), "no syntax instruction");
});

test('submitting the search form runs the search', async () => {
  const { bridge, api, state } = makeBridge();
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  await bridge.onCardAction({
    operator: { open_id: 'ou_user' },
    action: { tag: 'button', form_value: { value: '重构' }, value: { id: 'task.search.submit' } },
    context: { open_message_id: 'om_s', open_chat_id: 'oc_1' },
  });
  const card = JSON.stringify(api.lastCard);
  assert.match(card, /重构/u, "the keyword reached the search");
});

test('an unusable setting argument shows the chooser instead of usage text', async () => {
  // "/model 5" on a fresh process (no snapshot) must offer the list, not
  // explain the accepted syntax.
  const { bridge, api, state } = makeBridge();
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  await bridge.onMessage(messageEvent('/mode 9'));
  const card = JSON.stringify(api.lastCard);
  assert.match(card, /工作模式/u, "the mode chooser is shown");
  assert.ok(!card.includes("只接受序号"), "no syntax instruction");
});

test('/goal without an argument asks for the goal in a form', async () => {
  const { bridge, api, state } = makeBridge();
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  await bridge.onMessage(messageEvent('/goal'));
  // "/goal" alone means show the current goal.
  const shown = JSON.stringify(api.lastCard);
  assert.match(shown, /目标/u);
  // "/goal set" with no text asks for it.
  await bridge.onMessage(messageEvent('/goal set'));
  const asked = JSON.stringify(api.lastCard);
  assert.match(asked, /"tag":"form"/u, "a form asks for the goal");
  assert.match(asked, /goal\.set\.submit/u);
});
test('the task list 新建任务 button opens a form, end to end', async () => {
  // The whole chain, not just the dispatcher branch: the list must offer the
  // button, pressing it must render a form, and submitting must create.
  const { bridge, api, state } = makeBridge();
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  await bridge.onMessage(messageEvent('/task'));
  const listCard = JSON.stringify(api.lastCard);
  const button = collect(api.lastCard).find((v) => v?.id === 'task.create');
  assert.ok(button, 'the task list offers the new-task button');
  assert.ok(listCard.includes('新建任务'));

  await bridge.onCardAction({
    operator: { open_id: 'ou_user' },
    action: { tag: 'button', value: { id: 'task.create' } },
    context: { open_message_id: 'om_l', open_chat_id: 'oc_1' },
  });
  const form = JSON.stringify(api.lastCard);
  assert.match(form, /"tag":"form"/u, 'pressing it renders a form');
  assert.match(form, /"tag":"input"/u, 'with a title field');
  assert.match(form, /task\.create\.submit/u, 'and a submit action');
});

test('the project list creates in one press but names the task after the project', async () => {
  // Project rows create immediately, so the task takes the project title.
  // This is the one creation path that never asks for a name.
  const { bridge, api, state } = makeBridge({
    services: { workspaceRegistry: { list: () => [{ id: 'w1', title: '飞书插件', path: 'D:/p/f' }] } },
  });
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  await bridge.onMessage(messageEvent('/project'));
  const button = collect(api.lastCard).find((v) => v?.id === 'project.select');
  assert.ok(button, 'a project row is a button');
  await bridge.onCardAction({
    operator: { open_id: 'ou_user' },
    action: { tag: 'button', value: { id: 'project.select', pageKey: button.pageKey, index: 1 } },
    context: { open_message_id: 'om_p', open_chat_id: 'oc_1' },
  });
  const current = state.currentTask('ou_user');
  assert.equal(current.title, '飞书插件', 'the task is named after the project');
});
test('新建项目 starts by picking a path, then asks for a name', async () => {
  // Two steps, in this order: the directory is chosen among real directories,
  // the name is free text. Asking both at once would mean typing a path from
  // memory.
  const harness = new FakeHarness();
  harness.directoryListing = {
    path: 'D:/work',
    home: 'D:/work',
    crumbs: [],
    entries: [{ name: 'dsh-feishu-only', path: 'D:/work/dsh-feishu-only', hidden: false }],
    truncated: false,
  };
  const { bridge, api, state } = makeBridge({ harness });
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  await bridge.onMessage(messageEvent('/project'));
  const create = collect(api.lastCard).find((v) => v?.id === 'project.create');
  assert.ok(create, 'the project list offers 新建项目');

  await bridge.onCardAction({
    operator: { open_id: 'ou_user' },
    action: { tag: 'button', value: { id: 'project.create' } },
    context: { open_message_id: 'om_c', open_chat_id: 'oc_1' },
  });
  const picker = JSON.stringify(api.lastCard);
  assert.match(picker, /选择路径/u, 'the path picker is shown first');
  assert.match(picker, /dsh-feishu-only/u, 'and lists real subdirectories');

  // Choosing the current directory proceeds to the name form.
  await bridge.onCardAction({
    operator: { open_id: 'ou_user' },
    action: { tag: 'button', value: { id: 'project.dir.pick', path: 'D:/work' } },
    context: { open_message_id: 'om_d', open_chat_id: 'oc_1' },
  });
  const naming = JSON.stringify(api.lastCard);
  assert.match(naming, /"tag":"form"/u, 'the name form is shown second');
  assert.match(naming, /project\.create\.submit/u, 'and it submits a project');
  assert.match(naming, /项目名称/u, 'asking for the project name');
});

test('choosing a subdirectory browses into it instead of using it', async () => {
  // Entering a directory is usually how you reach the one you want, so a
  // subdirectory button must navigate, not commit.
  const harness = new FakeHarness();
  harness.directoryListing = (path) => ({
    path: path ?? 'D:/work',
    home: 'D:/work',
    crumbs: [],
    entries: path === 'D:/work/dsh-feishu-only'
      ? []
      : [{ name: 'dsh-feishu-only', path: 'D:/work/dsh-feishu-only', hidden: false }],
    truncated: false,
  });
  const { bridge, api, state } = makeBridge({ harness });
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  await bridge.onCardAction({
    operator: { open_id: 'ou_user' },
    action: { tag: 'button', value: { id: 'project.create' } },
    context: { open_message_id: 'om_e', open_chat_id: 'oc_1' },
  });
  await bridge.onCardAction({
    operator: { open_id: 'ou_user' },
    action: { tag: 'button', value: { id: 'project.dir', path: 'D:/work/dsh-feishu-only' } },
    context: { open_message_id: 'om_f', open_chat_id: 'oc_1' },
  });
  assert.ok(harness.browsedPaths.includes('D:/work/dsh-feishu-only'), 'the subdirectory was listed');
  const card = JSON.stringify(api.lastCard);
  assert.match(card, /选择路径/u, 'still picking, not naming');
  assert.match(card, /没有子目录/u, 'and the empty level is stated');
});

test('creating a project also opens its first task', async () => {
  // A registered project with nowhere to type is not useful; the same press
  // opens the task that will run in it.
  const harness = new FakeHarness();
  const { bridge, api, state } = makeBridge({ harness });
  await bridge.onCardAction({
    operator: { open_id: 'ou_user' },
    action: {
      tag: 'button',
      value: { id: 'project.create.submit', path: 'D:/work/new' },
      form_value: { title: '新项目' },
    },
    context: { open_message_id: 'om_g', open_chat_id: 'oc_1' },
  });
  assert.equal(harness.createdProjects.length, 1, 'the project was registered');
  assert.equal(harness.createdProjects[0].path, 'D:/work/new');
  assert.equal(harness.createdProjects[0].title, '新项目');
  const current = state.currentTask('ou_user');
  assert.ok(current, 'a task became current');
  assert.equal(current.title, '新项目', 'named after the project');
  assert.match(JSON.stringify(api.lastCard), /项目已创建/u);
});

test('browsing falls back to the filesystem when no picker service exists', async () => {
  // directoryPickerController and directoryPicker are both optional services.
  // A deployment shipping neither must still be able to pick a directory, or
  // creating a project becomes impossible - which is exactly what happened:
  // the button answered "当前部署没有提供目录浏览能力".
  const { HarnessAdapter } = await import('../lib/harness.js');
  const ctx = { get: () => undefined };
  const adapter = new HarnessAdapter({ ctx, logger: silent });
  const listed = await adapter.browseDirectory();
  assert.equal(listed.ok, true, 'a listing was produced without any picker');
  assert.equal(listed.source, 'filesystem', 'and it says where it came from');
  assert.ok(listed.value.path, 'the current directory is reported');
  assert.ok(Array.isArray(listed.value.entries), 'with entries');
  assert.ok(Array.isArray(listed.value.crumbs), 'and its ancestry');
});

test('the controller is preferred over the filesystem, because it is the remote seam', async () => {
  // directoryPickerController exists specifically for a Remote caller's in-app
  // browser, so it must win over the generic fallback.
  const { HarnessAdapter } = await import('../lib/harness.js');
  const asked = [];
  const ctx = {
    get: (name) => (name === 'directoryPickerController'
      ? {
          list: async (path) => {
            asked.push(path ?? null);
            return {
              path: path ?? 'D:/from-controller',
              home: 'D:/from-controller',
              crumbs: [],
              entries: [{ name: 'child', path: 'D:/from-controller/child', hidden: false }],
              truncated: false,
            };
          },
        }
      : undefined),
  };
  const adapter = new HarnessAdapter({ ctx, logger: silent });
  const listed = await adapter.browseDirectory('D:/explicit');
  assert.equal(listed.ok, true);
  assert.equal(listed.source, undefined, 'not the filesystem fallback');
  assert.deepEqual(asked, ['D:/explicit'], 'the requested path was used');
  assert.equal(listed.value.entries[0].name, 'child');
});

test('a directory that does not exist is reported, not listed empty', async () => {
  const { HarnessAdapter } = await import('../lib/harness.js');
  const adapter = new HarnessAdapter({ ctx: { get: () => undefined }, logger: silent });
  const listed = await adapter.browseDirectory('D:/definitely-not-a-real-dir-xyz');
  assert.equal(listed.ok, false);
  assert.match(listed.reason, /无法读取目录/u);
});

test('a path can be typed instead of walking the tree', async () => {
  // A deep tree is slow to walk one level at a time, and a sibling directory
  // needs a trip through the parent. Typing the path is the direct route.
  const harness = new FakeHarness();
  harness.directoryListing = (path) => ({
    path: path ?? 'D:/work',
    home: 'D:/work',
    crumbs: [],
    entries: [],
    truncated: false,
  });
  const { bridge, api, state } = makeBridge({ harness });
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  await bridge.onCardAction({
    operator: { open_id: 'ou_user' },
    action: { tag: 'button', value: { id: 'project.create' } },
    context: { open_message_id: 'om_i', open_chat_id: 'oc_1' },
  });
  await bridge.onCardAction({
    operator: { open_id: 'ou_user' },
    action: {
      tag: 'button',
      value: { id: 'project.dir.goto' },
      form_value: { path: 'D:/nick/project' },
    },
    context: { open_message_id: 'om_j', open_chat_id: 'oc_1' },
  });
  assert.ok(harness.browsedPaths.includes('D:/nick/project'), 'the typed path was browsed');
  assert.match(JSON.stringify(api.lastCard), /选择路径/u, 'and the picker shows it');
});

test('a typed path is trimmed, and quoted paths are accepted', async () => {
  // Paths pasted from Explorer often arrive quoted, and a trailing space is
  // invisible but breaks the lookup.
  const harness = new FakeHarness();
  harness.directoryListing = { path: 'D:/x', home: 'D:/x', crumbs: [], entries: [], truncated: false };
  const { bridge, state } = makeBridge({ harness });
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  await bridge.onCardAction({
    operator: { open_id: 'ou_user' },
    action: {
      tag: 'button',
      value: { id: 'project.dir.goto' },
      form_value: { path: '  "D:\\nick\\project"  ' },
    },
    context: { open_message_id: 'om_k', open_chat_id: 'oc_1' },
  });
  assert.ok(harness.browsedPaths.includes('D:\\nick\\project'), 'quotes and spaces were stripped');
});

test('an empty typed path does nothing', async () => {
  const harness = new FakeHarness();
  const { bridge, state } = makeBridge({ harness });
  state.setCurrentTask('ou_user', { sessionId: 's1', label: '任务' });
  const toast = await bridge.onCardAction({
    operator: { open_id: 'ou_user' },
    action: {
      tag: 'button',
      value: { id: 'project.dir.goto' },
      form_value: { path: '   ' },
    },
    context: { open_message_id: 'om_l', open_chat_id: 'oc_1' },
  });
  assert.equal(harness.browsedPaths.length, 0, 'nothing was browsed');
  assert.match(JSON.stringify(toast ?? {}), /请先填写路径/u);
});

test('a controller that refuses the browse verb falls through to the filesystem', async () => {
  // This is the case that broke in production: the service exists, but the
  // composition refuses the verb ("a verb the composition cannot serve is
  // refused rather than approximated"). Returning that error left the user
  // with a button that could never work.
  const { HarnessAdapter } = await import('../lib/harness.js');
  const ctx = {
    get: (name) => (name === 'directoryPickerController'
      ? { list: async () => { throw new Error('browse is not available in this composition'); } }
      : undefined),
  };
  const adapter = new HarnessAdapter({ ctx, logger: silent });
  const listed = await adapter.browseDirectory();
  assert.equal(listed.ok, true, 'a listing was still produced');
  assert.equal(listed.source, 'filesystem', 'by falling back');
});

test('a controller returning an unusable value falls through too', async () => {
  // null is a legal answer from some seams, so it must not be trusted blindly.
  const { HarnessAdapter } = await import('../lib/harness.js');
  const ctx = { get: (n) => (n === 'directoryPickerController' ? { list: async () => null } : undefined) };
  const adapter = new HarnessAdapter({ ctx, logger: silent });
  const listed = await adapter.browseDirectory();
  assert.equal(listed.ok, true);
  assert.equal(listed.source, 'filesystem');
});

test('a working controller is still preferred and its result used', async () => {
  // The fallback must not shadow a service that works.
  const { HarnessAdapter } = await import('../lib/harness.js');
  const ctx = {
    get: (name) => (name === 'directoryPickerController'
      ? { list: async () => ({ path: 'D:/c', home: 'D:/c', crumbs: [], entries: [{ name: 'a', path: 'D:/c/a', hidden: false }], truncated: false }) }
      : undefined),
  };
  const adapter = new HarnessAdapter({ ctx, logger: silent });
  const listed = await adapter.browseDirectory();
  assert.equal(listed.ok, true);
  assert.equal(listed.source, undefined, 'not the fallback');
  assert.equal(listed.value.entries[0].name, 'a');
});

