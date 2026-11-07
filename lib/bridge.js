/**
 * The Feishu bridge: routes inbound messages and card callbacks to commands or
 * to task input, and owns the round lifecycle.
 *
 * @module dsh-feishu-only/lib/bridge
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

import {
  card,
  clampText,
  currentTaskCard,
  emptyResultCard,
  goalCard,
  helpCard,
  historyCard,
  md,
  pluginCard,
  previewCard,
  progressCard,
  resultCard,
  settingsCard,
  stagedImagesCard,
  statusCard,
  taskListCard,
  taskSearchCard,
  updateCard,
} from './cards.js';
import { parseCommand, COMMAND_FORMS } from './commands/parse.js';
import { admitsGroupMessage, normalizeCardAction, normalizeMessageEvent } from './feishu/messages.js';
import { groupRounds, HarnessTask } from './harness.js';
import { RoundTracker } from './round.js';
import { PAGE_SIZE } from './state.js';

const PROGRESS_THROTTLE_MS = 1200;
const ROUND_POLL_MS = 700;
const MAX_PROMPT_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * One conversation-scoped bridge instance.
 */
export class FeishuBridge {
  #ctx;
  #config;
  #api;
  #state;
  #harness;
  #logger;
  #tasks = new Map();
  #operators = new Map();
  #roundTimers = new Map();
  #progressTimers = new Map();
  #disposed = false;
  #health = { bot: 'unknown', ws: 'unknown', lastError: null };
  #interactions;
  #preview;
  #searchQueries = new Map();
  /** Optional sink for recent inbound/outbound outcomes, read by `/status`. */
  #onDiagnostic;
  /** Questions awaiting a free-text reply, keyed by operator open_id. */
  #awaitingText = new Map();
  /** Draft answers per pending question set. */
  #answerDrafts = new Map();

  constructor({ ctx, config, api, state, harness, logger = console, interactions, preview, onDiagnostic }) {
    this.#ctx = ctx;
    this.#config = config;
    this.#api = api;
    this.#state = state;
    this.#harness = harness;
    this.#logger = logger;
    this.#interactions = interactions;
    this.#preview = preview;
    this.#onDiagnostic = typeof onDiagnostic === 'function' ? onDiagnostic : null;
  }

  // ------------------------------------------------------------------ inbound

  /**
   * Handle one `im.message.receive_v1` event.
   *
   * @returns {Promise<void>}
   */
  async onMessage(event) {
    if (this.#disposed) return;
    const message = normalizeMessageEvent(event);
    if (!message) return;
    if (!message.ok) {
      if (message.reason === 'self') return;
      if (typeof message.reason === 'string' && message.reason.startsWith('unsupported:')) {
        await this.#sendTextNotice(
          message.chatId,
          '这个类型的消息暂不作为任务需求处理。请发送文字、图片或文件，并用 /help 查看可用操作。',
        );
      }
      return;
    }

    // Acknowledgement loss can replay an event; one execution per message.
    if (!this.#state.rememberMessage(message.messageId)) return;

    if (!admitsGroupMessage(message, { requireMention: this.#config.groupRequireMention })) {
      return;
    }
    if (!message.senderOpenId) return;

    this.#rememberOperator(message.senderOpenId, message.chatId, message.chatType);

    try {
      await this.#dispatchMessage(message);
    } catch (error) {
      this.#logger.error(`[feishu] message dispatch failed: ${error?.stack ?? error}`);
      await this.#sendTextNotice(message.chatId, `处理这条消息时出错：${oneLine(error?.message ?? error, 200)}`);
    }
  }

  async #dispatchMessage(message) {
    const text = message.text ?? '';

    // A command is a control operation; it never becomes task input.
    const parsed = parseCommand(text);
    if (parsed.kind === 'command') {
      await this.#runCommand(parsed, message);
      return;
    }
    if (parsed.kind === 'unknown') {
      await this.#sendCard(message.chatId, card({
        title: '❔ 未知指令',
        template: 'orange',
        elements: [
          md(`没有 \`/${parsed.name}\` 这个指令。未知指令不会作为需求执行。`),
          { tag: 'hr' },
          md(COMMAND_FORMS.help.map((form) => `\`${form}\``).join(' · ')),
          {
            tag: 'column_set',
            columns: [{
              tag: 'column',
              width: 'auto',
              elements: [{
                tag: 'button',
                text: { tag: 'plain_text', content: '查看帮助' },
                type: 'primary',
                behaviors: [{ type: 'callback', value: { id: 'help.show' } }],
              }],
            }],
          },
        ],
      }));
      return;
    }

    // Plain text / rich text / image / file is task input.
    await this.#submitTaskInput(message);
  }

  // ------------------------------------------------------------ task input

  async #submitTaskInput(message) {
    const userId = message.senderOpenId;

    // A free-text question answer takes precedence over task input: the user
    // was told to reply with text, so that text is the answer, not a new prompt.
    const awaiting = this.#awaitingText.get(userId);
    if (awaiting && message.text?.trim()) {
      this.#awaitingText.delete(userId);
      const pending = this.#state.pendingInteraction(awaiting.recordId);
      if (pending) {
        const result = this.#recordAnswer({
          recordId: awaiting.recordId,
          userId,
          pending,
          questionId: awaiting.questionId,
          answer: { selected: [], custom: message.text.trim() },
        });
        await this.#sendTextNotice(message.chatId, result.toast.content);
        return;
      }
      await this.#sendTextNotice(message.chatId, '这个问题已经失效，这条文字没有作为答案提交。');
      return;
    }

    const task = this.#state.currentTask(userId);
    if (!task) {
      await this.#sendCard(message.chatId, card({
        title: '📋 先选择任务',
        template: 'orange',
        elements: [
          {
            tag: 'div',
            text: { tag: 'lark_md', content: [ '还没有选中任务，这条消息没有提交。', '', '任务保存上下文，多轮执行都在同一个任务里继续。', '请先用 `/task` 选择，或 `/task create <标题>` 新建一个。', ].join('\n'), },
          },
          {
            tag: 'column_set',
            columns: [
              {
                tag: 'column',
                width: 'auto',
                elements: [{
                  tag: 'button',
                  text: { tag: 'plain_text', content: '📋 选择任务' },
                  type: 'primary',
                  behaviors: [{ type: 'callback', value: { id: 'task.list' } }],
                }],
              },
              {
                tag: 'column',
                width: 'auto',
                elements: [{
                  tag: 'button',
                  text: { tag: 'plain_text', content: '➕ 新建任务' },
                  type: 'callback',
                  value: { id: 'task.create.hint' },
                  behaviors: [{ type: 'callback', value: { id: 'task.create.hint' } }],
                }],
              },
            ],
          },
        ],
      }));
      return;
    }

    const hasText = Boolean(message.text && message.text.trim());
    const imageKeys = message.imageKeys ?? [];
    const hasFile = Boolean(message.fileKey);

    // Images without any instruction are staged, not submitted: the reference
    // waits for the user's text and then submits both together.
    if (imageKeys.length > 0 && !hasText && !hasFile) {
      await this.#stageImages(task, message, imageKeys);
      return;
    }
    if (imageKeys.length === 0 && !hasText && !hasFile) return;

    await this.#submitPrompt(task, message, { text: message.text ?? '', imageKeys, hasFile });
  }

  async #stageImages(task, message, imageKeys) {
    const userId = message.senderOpenId;
    let batch = null;
    for (const key of imageKeys) {
      batch = this.#state.stageImage(userId, {
        taskId: task.sessionId,
        chatId: message.chatId,
        file: { fileKey: key, messageId: message.messageId },
        name: '图片',
      });
    }
    const count = batch?.items.length ?? imageKeys.length;
    await this.#sendCard(message.chatId, stagedImagesCard({
      task,
      count,
      files: [`共 ${count} 张图片`],
    }));
  }

  /**
   * Submit one prompt to a task, attaching any staged images.
   */
  async #submitPrompt(task, message, { text, imageKeys, hasFile }) {
    const userId = message.senderOpenId;
    const ws = this.#harness.available;

    // A task that is already running: try to supplement it safely rather than
    // silently starting a second round.
    const stateResult = await this.#harness.taskState(task.sessionId);
    const running = stateResult.ok && stateResult.value?.running === true;
    if (running && this.#config.rejectInputWhileRunning) {
      await this.#sendCard(message.chatId, card({
        title: '⏳ 当前任务正在执行',
        template: 'orange',
        elements: [
          {
            tag: 'div',
            text: { tag: 'lark_md', content: [ `**任务：**${task.label}`, '', '这个任务正在执行一轮。当前配置不接受执行中的补充输入。', '你可以等本轮结束再发送，或用 `/stop` 结束当前轮次。', ].join('\n'), },
          },
          {
            tag: 'column_set',
            columns: [
              {
                tag: 'column',
                width: 'auto',
                elements: [{
                  tag: 'button',
                  text: { tag: 'plain_text', content: '⏹️ 停止本轮' },
                  type: 'danger',
                  behaviors: [{ type: 'callback', value: { id: 'round.stop' } }],
                }],
              },
            ],
          },
        ],
      }));
      return;
    }

    const content = [];
    const staged = this.#state.stagedImages(userId);
    const pendingImages = staged && staged.items.length > 0 ? staged : null;

    if (pendingImages) {
      if (pendingImages.taskId !== task.sessionId) {
        // The batch belonged to another task: never send it silently here.
        this.#state.clearStagedImages(userId);
        await this.#sendTextNotice(
          message.chatId,
          '暂存图片所属的任务已经切换，这批图片没有提交。请重新发送图片。',
        );
        return;
      }
      for (const item of pendingImages.items) {
        const uploaded = await this.#prepareImageAttachment(task, item.file, message.chatId);
        if (uploaded) content.push(uploaded);
      }
    }

    for (const imageKey of imageKeys ?? []) {
      const uploaded = await this.#prepareImageAttachment(
        task,
        { fileKey: imageKey, messageId: message.messageId },
        message.chatId,
      );
      if (uploaded) content.push(uploaded);
    }

    let fileNotice = null;
    if (hasFile) {
      const stored = await this.#storeIncomingFile(task, message);
      if (!stored.ok) {
        // A file that could not be stored is reported, never silently dropped.
        await this.#sendTextNotice(message.chatId, `附件没有保存成功：${stored.reason}`);
        return;
      }
      fileNotice = stored.value;
    }

    const promptText = [text?.trim() ?? '', fileNotice ? `\n\n（附件已保存到工作区：${fileNotice.path}）` : '']
      .join('')
      .trim();
    if (promptText) content.push({ type: 'text', text: promptText });
    if (content.length === 0) {
      await this.#sendTextNotice(message.chatId, '这条消息没有可提交的内容。');
      return;
    }

    // The task may have just finished: confirm idle before starting a new round
    // so a Redelivered race cannot run the old request twice.
    const latest = await this.#harness.taskState(task.sessionId);
    if (latest.ok && latest.value?.running === true && this.#state.round(task.sessionId)?.active) {
      await this.#sendTextNotice(message.chatId, '任务刚好开始执行，这条需求没有提交。请稍后重试。');
      return;
    }

    const submitted = await this.#harness.prompt(task.sessionId, content, {
      mode: running ? 'steer' : 'queue',
      requestId: `feishu-${message.messageId ?? randomUUID()}`,
    });
    if (!submitted.ok) {
      await this.#sendCard(message.chatId, card({
        title: '⚠️ 需求没有提交成功',
        template: 'red',
        elements: [
          {
            tag: 'div',
            text: { tag: 'lark_md', content: [ `**任务：**${task.label}`, '', submitted.reason, '', '这条需求没有被排队。可以稍后重试，或先用 `/status` 检查执行端。', ].join('\n'), },
          },
        ],
      }));
      return;
    }

    this.#state.clearStagedImages(userId);
    if (ws.agents === false) {
      this.#logger.warn('[feishu] prompt submitted on a deployment without an agent registry');
    }
    task.touch();
    if (promptText && !task.title) task.title = firstLine(promptText, 40);

    await this.#startRound(task, message.chatId, promptText, userId);
  }

  /**
   * Read one Feishu image and hand it to the Host as prompt content.
   *
   * The image is downloaded into memory and base64-encoded, because the Host
   * admits images through its attachment seam rather than by URL.
   */
  async #prepareImageAttachment(task, file, chatId) {
    try {
      const downloaded = await this.#api.downloadResource(
        file.messageId,
        file.fileKey,
        'image',
      );
      const mediaType = detectImageType(downloaded.data, downloaded.contentType);
      if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) {
        await this.#sendTextNotice(chatId, '这张图片的格式不受支持（仅支持 PNG/JPEG/WebP/GIF）。');
        return null;
      }
      if (downloaded.data.byteLength > MAX_PROMPT_IMAGE_BYTES) {
        await this.#sendTextNotice(chatId, '这张图片超过大小上限，没有提交。');
        return null;
      }
      return {
        type: 'image',
        data: Buffer.from(downloaded.data).toString('base64'),
        mediaType,
        name: `feishu-${file.fileKey.slice(-12)}`,
      };
    } catch (error) {
      this.#logger.warn(`[feishu] image download failed: ${error?.message ?? error}`);
      await this.#sendTextNotice(chatId, '图片下载失败，这条图片没有提交。请重试。');
      return null;
    }
  }

  /**
   * Save one incoming Feishu file into the task workspace.
   *
   * Phase-separated reporting: download failure, format detection failure and
   * write failure each produce their own message, so "downloaded" is never
   * presented as "parsed".
   */
  async #storeIncomingFile(task, message) {
    let downloaded;
    try {
      downloaded = await this.#api.downloadResource(message.messageId, message.fileKey, 'file');
    } catch (error) {
      return { ok: false, reason: `下载失败（${oneLine(error?.message ?? error, 120)}）` };
    }
    if (!downloaded.data || downloaded.data.byteLength === 0) {
      return { ok: false, reason: '下载到的文件是空的' };
    }
    const root = task.cwd ?? this.#config.defaultWorkspace ?? process.cwd();
    const directory = join(root, '.feishu', 'attachments');
    const name = sanitizeFileName(message.fileName ?? `file-${message.messageId}`);
    const target = join(directory, `${Date.now()}-${name}`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(target, downloaded.data);
    } catch (error) {
      return { ok: false, reason: `保存失败（${oneLine(error?.message ?? error, 120)}）` };
    }
    return { ok: true, value: { path: target, name, bytes: downloaded.data.byteLength } };
  }

  // -------------------------------------------------------------- round life

  /**
   * Start tracking one round and open its progress card.
   */
  async #startRound(task, chatId, promptText, userId) {
    const existing = this.#state.round(task.sessionId);
    if (existing?.active) {
      // Re-selecting the same task must reuse the live tracking record rather
      // than creating a second progress card.
      await this.#sendTextNotice(chatId, '这个任务已经在执行，沿用当前的进度卡片。');
      return;
    }

    const tracker = new RoundTracker({
      taskId: task.sessionId,
      promptText,
      afterSeq: this.#lastSeqOf(task.sessionId),
    });
    this.#state.registerRound(task.sessionId, tracker);
    task.running = true;
    this.#health.lastError = null;

    const cardMessage = await this.#sendCard(chatId, this.#progressCardFor(task, tracker));
    if (cardMessage?.message_id) tracker.cardMessageId = cardMessage.message_id;

    this.#scheduleRoundPoll(task, chatId, userId);
  }

  #progressCardFor(task, tracker) {
    return progressCard({
      task,
      phase: tracker.phase,
      turn: tracker.turn,
      toolLines: tracker.toolLines,
      commandOutput: tracker.commandOutput,
      progress: tracker.progress,
      resources: tracker.resources,
      detail: tracker.detail,
      startedAt: tracker.startedAt,
    });
  }

  #lastSeqOf(sessionId) {
    try {
      const session = this.#harness.session(sessionId);
      return session ? Number(session.seq) - 1 : -1;
    } catch {
      return -1;
    }
  }

  #scheduleRoundPoll(task, chatId, userId) {
    if (this.#roundTimers.has(task.sessionId)) return;
    const timer = setInterval(() => {
      void this.#pollRound(task, chatId, userId);
    }, ROUND_POLL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.#roundTimers.set(task.sessionId, timer);
  }

  #stopRoundPoll(sessionId) {
    const timer = this.#roundTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.#roundTimers.delete(sessionId);
    }
    const progressTimer = this.#progressTimers.get(sessionId);
    if (progressTimer) {
      clearTimeout(progressTimer);
      this.#progressTimers.delete(sessionId);
    }
  }

  /**
   * Consume new session events for one round.
   *
   * Progress updates are throttled because a card patch is a network call; the
   * final answer is never throttled.
   */
  async #pollRound(task, chatId, userId) {
    const tracker = this.#state.round(task.sessionId);
    if (!tracker || tracker.finished) {
      this.#stopRoundPoll(task.sessionId);
      return;
    }
    const session = this.#harness.session(task.sessionId);
    if (!session) {
      // The session left the live store (Host restart); stop polling quietly.
      this.#stopRoundPoll(task.sessionId);
      return;
    }
    let events;
    try {
      events = session.snapshotEvents?.() ?? [];
    } catch {
      return;
    }
    const result = tracker.consume(events);
    if (result.changed) this.#scheduleProgressPatch(task, tracker);

    if (result.final) {
      await this.#deliverResult(task, chatId, tracker, result.final);
    }
    if (result.ended) {
      this.#stopRoundPoll(task.sessionId);
      task.running = false;
      await this.#patchProgress(task, tracker);
      if (!result.final) await this.#deliverOutcomeNotice(task, chatId, tracker);
      this.#state.finishRound(task.sessionId, result.ended);
    }
  }

  #scheduleProgressPatch(task, tracker) {
    if (this.#progressTimers.has(task.sessionId)) return;
    const timer = setTimeout(() => {
      this.#progressTimers.delete(task.sessionId);
      void this.#patchProgress(task, tracker);
    }, PROGRESS_THROTTLE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.#progressTimers.set(task.sessionId, timer);
  }

  async #patchProgress(task, tracker) {
    if (!tracker.cardMessageId) return;
    try {
      await this.#api.patchCard(tracker.cardMessageId, this.#progressCardFor(task, tracker));
    } catch (error) {
      // A failed patch must not fail the round: the final answer is separate.
      this.#logger.warn(`[feishu] progress card update failed: ${error?.message ?? error}`);
    }
  }

  /**
   * Deliver the final answer as its own message.
   *
   * Delivery is deduplicated by event seq so a reconnect or a `/last` can never
   * post the same answer twice.
   */
  async #deliverResult(task, chatId, tracker, final) {
    const key = `${task.sessionId}:${final.seq}`;
    if (!this.#state.markResultDelivered(task.sessionId, key)) return;
    const text = final.text?.trim();
    if (!text) {
      await this.#deliverOutcomeNotice(task, chatId, tracker);
      return;
    }
    await this.#sendCard(chatId, resultCard({
      task,
      text,
      turn: tracker.turn,
      resources: tracker.resources,
    }));
  }

  async #deliverOutcomeNotice(task, chatId, tracker) {
    if (tracker.phase === 'done' && !tracker.detail) return;
    const title = tracker.phase === 'failed' ? '⚠️ 执行失败'
      : tracker.phase === 'stopped' ? '⏹️ 已停止'
        : 'ℹ️ 本轮没有文本结果';
    await this.#sendCard(chatId, card({
      title,
      template: tracker.phase === 'failed' ? 'red' : tracker.phase === 'stopped' ? 'grey' : 'blue',
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: [ `**任务：**${task.label}`, '', tracker.detail ?? '本轮结束时没有产生可显示的文本回复。', '', '进度卡片说明的是执行状态；最终答复会作为独立消息发送。', ].join('\n'), },
        },
        {
          tag: 'column_set',
          columns: [{
            tag: 'column',
            width: 'auto',
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: '📚 查看历史' },
              behaviors: [{ type: 'callback', value: { id: 'history.show' } }],
            }],
          }],
        },
      ],
    }));
  }

  // ----------------------------------------------------------------- commands

  async #runCommand(parsed, message) {
    const userId = message.senderOpenId;
    const chatId = message.chatId;
    const task = this.#state.currentTask(userId);
    const invalid = () => this.#sendCard(chatId, card({
      title: `❌ \`/${parsed.name}\` 的用法`,
      template: 'orange',
      elements: [
        md(`可用形式：\n${(COMMAND_FORMS[parsed.name] ?? []).map((form) => `- \`${form}\``).join('\n')}`),
      ],
    }));

    switch (parsed.name) {
      case 'help':
        return this.#sendCard(chatId, helpCard({
          version: this.#config.version,
          botName: this.#config.botName,
        }));

      case 'current':
        // The standalone form of `/task current`, reachable from the "/" menu.
        return this.#sendCard(chatId, currentTaskCard({
          task: task ? await this.#describeTask(task) : null,
        }));

      case 'status':
        return this.#sendStatus(chatId, task);

      case 'project':
        return this.#sendProject(chatId, parsed, userId);

      case 'task':
        return this.#handleTaskCommand(parsed, message, { userId, chatId, task });

      case 'history':
        return this.#sendHistory(chatId, task, parsed.page ?? 1);

      case 'last':
        return this.#sendLast(task, chatId);

      case 'plugin':
        return this.#sendPlugins(chatId, task);

      case 'model':
        return this.#handleSetting(parsed, { userId, chatId, task, kind: 'model' });

      case 'reasoning':
        return this.#handleSetting(parsed, { userId, chatId, task, kind: 'reasoning' });

      case 'permission':
        return this.#handleSetting(parsed, { userId, chatId, task, kind: 'permission' });

      case 'mode':
        return this.#handleSetting(parsed, { userId, chatId, task, kind: 'mode' });

      case 'compact':
        return this.#compact(task, chatId);

      case 'goal':
        return this.#handleGoal(parsed, { userId, chatId, task });

      case 'stop':
        return this.#stop(task, chatId);

      case 'restart':
        return this.#restart(chatId);

      case 'update':
        return this.#update(chatId, invalid);

      default:
        return invalid();
    }
  }

  async #sendStatus(chatId, task) {
    const adapterAvailability = this.#harness.available;
    const wsState = this.#health.ws;
    const botState = this.#health.bot;
    const execution = adapterAvailability.agents && adapterAvailability.sessions
      ? '可用'
      : '不可用（当前插件未检测到执行端服务）';
    const taskText = task
      ? `当前任务「${task.label}」，${this.#state.round(task.sessionId)?.active ? '正在执行' : '空闲'}`
      : '当前没有选中任务';
    await this.#sendCard(chatId, statusCard({
      bot: botState === 'ok' ? '在线' : botState === 'unknown' ? '未知' : `异常（${botState}）`,
      ws: wsState === 'connected' ? '已连接（长连接）'
        : wsState === 'reconnecting' ? '重连中'
          : wsState === 'connecting' ? '连接中'
            : wsState === 'failed' ? '连接失败'
              : '未连接',
      execution,
      tasks: taskText,
    }));
  }

  async #sendProject(chatId, parsed, userId) {
    const workspaces = this.#workspaces();
    if (workspaces.length === 0) {
      await this.#sendCard(chatId, card({
        title: '📁 项目',
        template: 'grey',
        elements: [
          md('当前部署没有登记任何项目（工作区）。\n\n可以直接用 `/task create <标题>` 创建不绑定项目的任务。'),
        ],
      }));
      return;
    }
    const page = parsed.page ?? 1;
    const totalPages = Math.max(1, Math.ceil(workspaces.length / PAGE_SIZE.project));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const slice = workspaces.slice((safePage - 1) * PAGE_SIZE.project, safePage * PAGE_SIZE.project);
    const snapshot = this.#state.recordSnapshot({
      kind: 'project',
      items: slice,
      userId,
      chatId,
    });
    const elements = [
      md(`**项目**（第 ${safePage}/${totalPages} 页，共 ${workspaces.length} 个）`),
    ];
    // One full-width button per project, labelled with the project itself —
    // the same shape the task list uses. A separate numbered text list plus
    // "选择 N" buttons repeated every name and left the user matching numbers.
    for (const [offset, workspace] of slice.entries()) {
      const index = (safePage - 1) * PAGE_SIZE.project + offset + 1;
      const title = workspace.title?.trim() || basename(workspace.path ?? '') || '未命名项目';
      const label = title.length <= 40 ? title : `${title.slice(0, 39)}…`;
      elements.push({
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_spacing: 'default',
        columns: [{
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [{
            tag: 'button',
            text: { tag: 'plain_text', content: `${index}. ${label}` },
            type: 'default',
            width: 'fill',
            behaviors: [{
              type: 'callback',
              value: { id: 'project.select', pageKey: snapshot.id, index },
            }],
          }],
        }],
      });
    }
    const nav = [];
    if (safePage > 1) nav.push({ text: '⬅️ 上一页', id: 'project.page', extra: { page: safePage - 1 } });
    nav.push({ text: '🔄 刷新', id: 'project.list' });
    if (safePage < totalPages) nav.push({ text: '下一页 ➡️', id: 'project.page', extra: { page: safePage + 1 } });
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_spacing: 'default',
      columns: nav.map((item) => ({
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: item.text },
          width: 'fill',
          behaviors: [{ type: 'callback', value: { id: item.id, ...(item.extra ?? {}) } }],
        }],
      })),
    });
    elements.push({
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: '选择项目后会创建一个属于该项目的新任务；已有任务请用 /task 选择。',
      },
    });
    await this.#sendCard(chatId, card({ title: '📁 项目', template: 'blue', elements }));
  }

  #workspaces() {
    try {
      const registry = this.#ctx.get?.('workspaceRegistry');
      if (registry?.list) {
        return registry.list().map((workspace) => ({
          id: workspace.id,
          title: workspace.title ?? basename(workspace.path ?? '') ?? workspace.id,
          path: workspace.path,
        }));
      }
    } catch {
      // A deployment without a workspace registry has no projects.
    }
    return [];
  }

  async #handleTaskCommand(parsed, message, { userId, chatId, task }) {
    switch (parsed.action) {
      case 'list':
        return this.#sendTaskList(chatId, userId, parsed.page ?? 1);

      case 'current':
        return this.#sendCard(chatId, currentTaskCard({ task: task ? await this.#describeTask(task) : null }));

      case 'create': {
        const created = await this.#createTask(userId, chatId, parsed.text);
        if (!created.ok) {
          await this.#sendTextNotice(chatId, `创建任务失败：${created.reason}`);
          return;
        }
        this.#state.setCurrentTask(userId, created.value);
        await this.#sendCard(chatId, card({
          title: '✅ 任务已创建并选中',
          template: 'green',
          elements: [
            {
              tag: 'div',
              text: { tag: 'lark_md', content: [ `**标题：**${created.value.label}`, `**任务 ID：**\`${created.value.sessionId}\``, '', '接下来发送的文字会提交到这个任务。', ].join('\n'), },
            },
          ],
        }));
        return;
      }

      case 'search':
        return this.#sendSearch(chatId, userId, parsed.text ?? '', 1);

      case 'searchPage':
        return this.#sendSearchPage(chatId, userId, parsed.page ?? 1);

      case 'select': {
        const snapshot = this.#state.latestSnapshot(userId, 'task');
        if (!snapshot) {
          await this.#sendTextNotice(chatId, '没有可用的任务列表快照。请先发送 `/task` 获取列表。');
          return;
        }
        const selected = snapshot.resolve(parsed.index);
        if (!selected) {
          await this.#sendTextNotice(chatId, `序号 ${parsed.index} 不在最近一次列表中。请重新发送 \`/task\`。`);
          return;
        }
        await this.#selectTask(userId, chatId, selected.sessionId);
        return;
      }

      default:
        await this.#sendCard(chatId, card({
          title: '❌ `/task` 的用法',
          template: 'orange',
          elements: [{
            tag: 'div',
            text: { tag: 'lark_md', content: COMMAND_FORMS.task.map((form) => `- \`${form}\``).join('\n') },
          }],
        }));
        return;
    }
  }

  async #sendTaskList(chatId, userId, page) {
    const listed = await this.#harness.listTasks();
    if (!listed.ok) {
      await this.#sendTextNotice(chatId, `无法读取任务列表：${listed.reason}`);
      return;
    }
    const rows = listed.value
      .filter((row) => row.origin !== 'subagent')
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    const current = this.#state.currentTask(userId);
    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE.task));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const slice = rows.slice((safePage - 1) * PAGE_SIZE.task, safePage * PAGE_SIZE.task);

    const snapshot = this.#state.recordSnapshot({
      kind: 'task',
      items: slice,
      userId,
      chatId,
    });
    const tasks = slice.map((row) => ({
      sessionId: row.sessionId,
      title: row.title,
      running: row.running,
      isCurrent: current?.sessionId === row.sessionId,
    }));
    await this.#sendCard(chatId, taskListCard({
      currentTask: current ? await this.#describeTask(current) : null,
      tasks,
      page: safePage,
      totalPages,
      total: rows.length,
      pageKey: snapshot.id,
      emptyHint: '还没有任何任务。发送 `/task create <标题>` 新建。',
    }));
  }

  async #sendSearch(chatId, userId, keyword, page) {
    if (!keyword) {
      await this.#sendTextNotice(chatId, '请提供搜索关键词：`/task search <关键词>`。');
      return;
    }
    const found = await this.#harness.searchTasks(keyword);
    if (!found.ok) {
      await this.#sendTextNotice(chatId, `搜索失败：${found.reason}`);
      return;
    }
    const current = this.#state.currentTask(userId);
    const items = found.value.map((hit) => ({ ...hit, isCurrent: current?.sessionId === hit.sessionId }));
    // Remember the query itself so `/task search page <n>` reuses it.
    this.#searchQueries ??= new Map();
    this.#searchQueries.set(userId, { keyword, items });
    await this.#sendSearchPageOf(chatId, userId, keyword, items, page);
  }

  async #sendSearchPage(chatId, userId, page) {
    this.#searchQueries ??= new Map();
    const cached = this.#searchQueries.get(userId);
    if (!cached) {
      await this.#sendTextNotice(chatId, '没有可翻页的搜索结果。请先发送 `/task search <关键词>`。');
      return;
    }
    await this.#sendSearchPageOf(chatId, userId, cached.keyword, cached.items, page);
  }

  async #sendSearchPageOf(chatId, userId, keyword, items, page) {
    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE.search));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const slice = items.slice((safePage - 1) * PAGE_SIZE.search, safePage * PAGE_SIZE.search);
    const snapshot = this.#state.recordSnapshot({
      kind: 'search',
      items: slice,
      userId,
      chatId,
      query: keyword,
    });
    await this.#sendCard(chatId, taskSearchCard({
      keyword,
      results: slice,
      page: safePage,
      totalPages,
      pageKey: snapshot.id,
    }));
  }

  /**
   * Switch the current task.
   *
   * Switching only changes the interaction target: a task that is running keeps
   * running, and if it is idle its latest reply is fetched once.
   */
  async #selectTask(userId, chatId, sessionId) {
    const listed = await this.#harness.listTasks();
    const row = listed.ok ? listed.value.find((item) => item.sessionId === sessionId) : null;
    const task = this.#taskFor(sessionId, row);
    this.#state.setCurrentTask(userId, task);

    const tracker = this.#state.round(sessionId);
    if (tracker?.active) {
      await this.#sendCard(chatId, card({
        title: '✅ 已切换任务',
        template: 'blue',
        elements: [
          {
            tag: 'div',
            text: { tag: 'lark_md', content: [ `**当前任务：**${task.label}`, `**任务 ID：**\`${task.sessionId}\``, '', '这个任务正在执行，下面是当前的执行进度。', ].join('\n'), },
          },
          { tag: 'hr' },
          md(`**阶段：**${tracker.phase}\n${tracker.progress ? `**进展：**${clampText(tracker.progress, 600)}` : ''}`),
        ],
      }));
      return;
    }

    await this.#sendCard(chatId, currentTaskCard({ task: await this.#describeTask(task) }));
    // A freshly selected idle task gets one read-only latest-reply fetch.
    await this.#sendLast(task, chatId, { quiet: true });
  }

  #taskFor(sessionId, row) {
    let task = this.#tasks.get(sessionId);
    if (!task) {
      task = new HarnessTask({
        sessionId,
        title: row?.title ?? null,
        cwd: row?.cwd ?? null,
      });
      this.#tasks.set(sessionId, task);
    }
    if (row?.title) task.title = row.title;
    if (row?.cwd) task.cwd = row.cwd;
    task.running = row?.running === true;
    return task;
  }

  async #describeTask(task) {
    const goal = this.#harness.goalOf(task.sessionId);
    const permission = this.#harness.permissionOf(task.sessionId);
    const model = this.#harness.modelOf(task.sessionId);
    const tracker = this.#state.round(task.sessionId);
    const contextWindow = this.#contextString(task.sessionId);
    // The last reply is deliberately not read here: the current-task card no
    // longer shows it (the answer already arrives as its own result card), so
    // fetching it would be a session-log read per card render for nothing.
    return {
      id: task.sessionId,
      title: task.label,
      project: task.cwd,
      model: model ? `${model.provider}/${model.model}` : '未记录（沿用默认模型）',
      reasoning: model?.reasoningEffort ?? '默认',
      permission: permission ?? '未知',
      mode: '普通模式',
      status: tracker?.active ? `执行中（${tracker.phase}）` : task.running ? '执行中' : '空闲',
      goal: goal ? `${goal.phase}${goal.objective ? ` · ${oneLine(goal.objective, 60)}` : ''}` : '未设置',
      context: contextWindow,
    };
  }

  #contextString(sessionId) {
    try {
      const projections = this.#ctx.get?.('sessionProjections');
      const sessions = this.#ctx.get?.('sessions');
      const session = sessions?.get?.(sessionId);
      if (projections && session) {
        const snapshot = projections.snapshot(session, projections.summaryKeys?.() ?? []);
        const used = snapshot?.values?.contextTokens;
        if (Number.isFinite(used)) return `${used} tokens`;
      }
    } catch {
      // Context pressure is informational only.
    }
    return '未知';
  }

  async #createTask(userId, chatId, title) {
    const created = await this.#harness.createTask({
      chatId: `${chatId}-${randomUUID().slice(0, 6)}`,
      cwd: this.#config.defaultWorkspace,
      agentPreset: this.#config.agentPreset,
    });
    if (!created.ok) return { ok: false, reason: created.reason };
    const task = this.#taskFor(created.value, { title, cwd: this.#config.defaultWorkspace });
    task.title = title;
    return { ok: true, value: task };
  }

  // ------------------------------------------------------------------ history

  async #sendHistory(chatId, task, page) {
    if (!task) {
      await this.#sendCard(chatId, historyCard({ task: null, rounds: [], page: 1, totalPages: 1 }));
      return;
    }
    const history = this.#harness.history(task.sessionId);
    if (!history.ok) {
      await this.#sendTextNotice(chatId, `读取历史失败：${history.reason}`);
      return;
    }
    const rounds = [...history.value].reverse();
    const totalPages = Math.max(1, Math.ceil(rounds.length / PAGE_SIZE.history));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const slice = rounds.slice((safePage - 1) * PAGE_SIZE.history, safePage * PAGE_SIZE.history)
      .map((round) => ({
        ...round,
        time: formatTimestamp(round.time),
      }));
    const snapshot = this.#state.recordSnapshot({
      kind: 'history',
      items: slice,
      userId: undefined,
      chatId,
    });
    await this.#sendCard(chatId, historyCard({
      task,
      rounds: slice,
      page: safePage,
      totalPages,
      pageKey: snapshot.id,
    }));
  }

  /**
   * `/last`: read-only retrieval of the newest displayable reply.
   *
   * Never starts a turn and never writes history.
   */
  async #sendLast(task, chatId, { quiet = false } = {}) {
    if (!task) {
      await this.#sendCard(chatId, emptyResultCard({
        task: null,
        reason: '请先选择一个任务。',
      }));
      return;
    }
    const reply = await this.#harness.lastReply(task.sessionId);
    if (!reply.ok) {
      await this.#sendCard(chatId, emptyResultCard({ task, reason: `无法读取回复：${reply.reason}` }));
      return;
    }
    const value = reply.value;
    if (!value) {
      if (quiet) return;
      await this.#sendCard(chatId, emptyResultCard({
        task,
        reason: reply.note ?? '这个任务还没有可显示的内容。',
      }));
      return;
    }
    if (!value.hasFinal) {
      // A streaming fragment inside an open turn is not a final answer.
      await this.#sendCard(chatId, emptyResultCard({
        task,
        reason: '这一轮还在执行，尚未产生最终答复。执行完成后可以再获取。',
      }));
      return;
    }
    const key = `${task.sessionId}:${value.seq}`;
    if (!quiet && this.#state.wasResultDelivered(task.sessionId, key)) {
      await this.#sendCard(chatId, emptyResultCard({
        task,
        reason: '这条回复已经发送过了。需要更早的结果请查看 /history。',
      }));
      return;
    }
    this.#state.markResultDelivered(task.sessionId, key);
    await this.#sendCard(chatId, resultCard({ task, text: value.text, turn: value.turn }));
  }

  // ----------------------------------------------------------------- helpers

  async #sendPlugins(chatId, task) {
    const plugins = [];
    try {
      const manager = this.#ctx.get?.('pluginManager');
      const listed = manager?.list ? await manager.list() : null;
      for (const entry of listed?.plugins ?? listed?.items ?? []) {
        plugins.push({
          title: entry.title ?? entry.name ?? entry.id ?? '未命名插件',
          description: entry.description ?? '',
        });
      }
    } catch {
      // Plugin inventory is optional.
    }
    const skills = task
      ? await this.#harness.listSkills(this.#harness.agent(task.sessionId))
      : { ok: true, value: [] };
    await this.#sendCard(chatId, pluginCard({
      plugins,
      skills: skills.ok ? skills.value : [],
    }));
  }

  // ---------------------------------------------------------------- settings

  async #handleSetting(parsed, { userId, chatId, task, kind }) {
    if (!task) {
      await this.#sendTextNotice(chatId, '请先选择一个任务，再查看或切换设置。');
      return;
    }
    if (parsed.action === 'show') {
      await this.#sendSettingsCard(chatId, userId, task, kind, 1);
      return;
    }
    if (parsed.action !== 'select') {
      await this.#sendTextNotice(chatId, `\`/${parsed.name}\` 只接受序号：\`/${parsed.name} <序号>\`。`);
      return;
    }
    const snapshot = this.#state.latestSnapshot(userId, `settings:${kind}`);
    if (!snapshot) {
      await this.#sendTextNotice(chatId, '没有可用的设置列表快照。请先发送 `/' + parsed.name + '` 获取选项。');
      return;
    }
    const option = snapshot.resolve(parsed.index);
    if (!option) {
      await this.#sendTextNotice(chatId, `序号 ${parsed.index} 不在最近一次选项列表中。请重新获取。`);
      return;
    }
    await this.#applySetting(task, chatId, kind, option);
  }

  async #sendSettingsCard(chatId, userId, task, kind, page) {
    const model = this.#harness.modelOf(task.sessionId);
    let options = [];
    let current = '未知';
    let title = '⚙️ 设置';
    let note = '设置从下一轮开始生效，不会终止当前轮次。';

    if (kind === 'model') {
      const catalog = await this.#harness.modelCatalog();
      if (!catalog.ok) {
        await this.#sendTextNotice(chatId, `无法读取模型目录：${catalog.reason}`);
        return;
      }
      const all = (catalog.value.groups ?? []).flatMap((group) => (group.models ?? []).map((entry) => ({
        label: `${group.name} / ${entry.name}`,
        description: entry.description ?? '',
        selected: model ? model.provider === group.id && model.model === entry.id : false,
        value: { provider: group.id, model: entry.id },
        id: `${group.id}/${entry.id}`,
      })));
      if (all.length === 0) {
        await this.#sendTextNotice(chatId, '当前部署没有可用模型。');
        return;
      }
      options = all;
      current = model ? `${model.provider}/${model.model}` : '默认模型';
      title = '🧠 模型';
      note = '切换模型只对下一轮生效；当前轮次会继续用原来的模型跑完。列表不是所有历史型号的完整目录。';
    } else if (kind === 'reasoning') {
      const catalog = await this.#harness.modelCatalog();
      if (!catalog.ok) {
        await this.#sendTextNotice(chatId, `无法读取模型目录：${catalog.reason}`);
        return;
      }
      const providerGroup = (catalog.value.groups ?? []).find((group) => group.id === model?.provider);
      const modelEntry = (providerGroup?.models ?? []).find((entry) => entry.id === model?.model);
      const efforts = modelEntry?.reasoning?.efforts ?? [];
      if (efforts.length === 0) {
        await this.#sendTextNotice(chatId, '当前模型没有可切换的推理强度。');
        return;
      }
      options = efforts.map((effort) => ({
        label: effort.name ?? effort.id,
        description: effort.description ?? '',
        selected: model?.reasoningEffort === effort.id
          || (!model?.reasoningEffort && modelEntry?.reasoning?.defaultEffort === effort.id),
        value: { reasoningEffort: effort.id },
      }));
      current = model?.reasoningEffort ?? modelEntry?.reasoning?.defaultEffort ?? '默认';
      title = '🎚️ 推理强度';
      note = '推理强度随模型变化；切换后从下一轮生效。';
    } else if (kind === 'permission') {
      const presets = this.#ctx.get?.('permissionPresets');
      if (!presets?.catalog) {
        await this.#sendTextNotice(chatId, '当前部署没有提供权限模式。');
        return;
      }
      const catalog = presets.catalog();
      const active = this.#harness.permissionOf(task.sessionId);
      options = (catalog.options ?? []).map((option) => ({
        label: option.name ?? option.value,
        description: option.description ?? '',
        selected: option.value === active,
        value: { preset: option.value },
      }));
      current = active ?? '未知';
      title = '🔐 权限模式';
      note = '权限模式决定沙箱范围与审批策略，切换后从下一轮生效，不会终止当前轮次。';
    } else if (kind === 'mode') {
      const planMode = this.#ctx.get?.('planMode');
      const agent = this.#harness.agent(task.sessionId);
      const planState = planMode && agent ? planMode.get(agent) : null;
      options = [
        { label: '普通模式', description: '直接执行', selected: !planState?.active, value: { mode: 'default' } },
        { label: '计划模式', description: '先给出计划再执行', selected: planState?.active === true, value: { mode: 'plan' } },
      ];
      current = planState?.active ? '计划模式' : '普通模式';
      title = '🧭 工作模式';
      note = '工作模式只影响执行方式，不改变任务本身。';
    }

    const totalPages = Math.max(1, Math.ceil(options.length / PAGE_SIZE.settings));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const slice = options.slice((safePage - 1) * PAGE_SIZE.settings, safePage * PAGE_SIZE.settings);
    this.#state.recordSnapshot({
      kind: `settings:${kind}`,
      items: slice,
      userId,
      chatId,
    });
    await this.#sendCard(chatId, settingsCard({
      kind,
      title,
      current,
      options: slice,
      page: safePage,
      totalPages,
      note,
    }));
  }

  async #applySetting(task, chatId, kind, option) {
    let applied = null;
    switch (kind) {
      case 'model':
        applied = await this.#harness.selectModel(task.sessionId, option.value);
        break;
      case 'reasoning': {
        const model = this.#harness.modelOf(task.sessionId);
        if (!model) {
          await this.#sendTextNotice(chatId, '当前任务还没有模型记录，无法单独切换推理强度。');
          return;
        }
        applied = await this.#harness.selectModel(task.sessionId, {
          provider: model.provider,
          model: model.model,
          ...option.value,
        });
        break;
      }
      case 'permission': {
        const presets = this.#ctx.get?.('permissionPresets');
        const session = this.#harness.session(task.sessionId);
        if (!presets?.set || !session) {
          await this.#sendTextNotice(chatId, '当前部署不支持切换权限模式。');
          return;
        }
        try {
          presets.set(session, option.value.preset);
          applied = { ok: true, value: option.value.preset };
        } catch (error) {
          applied = { ok: false, reason: error?.message ?? String(error) };
        }
        break;
      }
      case 'mode': {
        const planMode = this.#ctx.get?.('planMode');
        if (!planMode?.set) {
          await this.#sendTextNotice(chatId, '当前部署不支持切换工作模式。');
          return;
        }
        const agent = this.#harness.agent(task.sessionId);
        if (!agent) {
          // The service needs a live agent, and an agent exists only once this
          // task has actually run in this process. Saying "unsupported" here
          // was wrong and left the user with no way forward.
          await this.#sendTextNotice(
            chatId,
            '这个任务还没有执行过，暂时不能切换工作模式。先给它发一条需求执行一轮，之后就能用 `/mode` 切换。',
          );
          return;
        }
        try {
          // `set` reports what actually happened, and the difference matters:
          // `queued` means the switch applies at the next step of the running
          // turn, `committed` means it is in effect now.
          const outcome = planMode.set(agent, option.value.mode === 'plan');
          applied = { ok: true, value: option.value.mode, outcome };
        } catch (error) {
          applied = { ok: false, reason: error?.message ?? String(error) };
        }
        break;
      }
      default:
        applied = { ok: false, reason: '未知设置项' };
        break;
    }
    if (!applied?.ok) {
      await this.#sendTextNotice(chatId, `设置没有生效：${applied?.reason ?? '未知原因'}`);
      return;
    }
    // `queued` and `committed` mean different things to the user, so the card says
    // which one happened instead of repeating "takes effect next round".
    const effect = applied.outcome === 'queued'
      ? '切换已排队，会在本轮下一个步骤生效。'
      : applied.outcome === 'committed'
        ? '切换已记录，从下一轮开始生效。'
        : applied.outcome === 'cancelled'
          ? '与目标的切换相互抵消，当前状态与所选一致。'
          : applied.outcome === 'noop'
            ? '当前已经是这个模式，无需切换。'
            : '变更从下一轮开始生效，当前轮次不会被强行终止。';
    await this.#sendCard(chatId, card({
      title: '✅ 设置已更新',
      template: 'green',
      elements: [{
        tag: 'div',
        text: { tag: 'lark_md', content: [
          `**新的选择：**${option.label}`,
          '',
          effect,
        ].join('\n') },
      }],
    }));
  }

  // ------------------------------------------------------------------- goals

  async #handleGoal(parsed, { userId, chatId, task }) {
    if (!task) {
      await this.#sendTextNotice(chatId, '请先选择一个任务，再设置目标。');
      return;
    }
    if (parsed.action === 'show') {
      await this.#sendCard(chatId, goalCard({ task, goal: this.#goalView(task.sessionId) }));
      return;
    }
    if (parsed.action === 'invalid') {
      await this.#sendTextNotice(chatId, '用法：`/goal set <目标>` 或 `/goal clear`。');
      return;
    }
    if (parsed.action === 'set') {
      const created = await this.#harness.createGoal(task.sessionId, parsed.text);
      if (!created.ok) {
        await this.#sendTextNotice(chatId, `设置目标失败：${created.reason}`);
        return;
      }
      // Setting a goal produces a new task input so execution actually starts;
      // the side effect is stated rather than hidden.
      const submitted = await this.#harness.prompt(task.sessionId, [{
        type: 'text',
        text: `目标已设置：${parsed.text}\n请围绕这个目标继续推进。`,
      }], { mode: 'queue', requestId: `feishu-goal-${randomUUID()}` });
      if (submitted.ok) await this.#startRound(task, chatId, `目标：${parsed.text}`, userId);
      await this.#sendCard(chatId, card({
        title: '🎯 目标已设置',
        template: 'green',
        elements: [{
          tag: 'div',
          text: { tag: 'lark_md', content: [
            `**目标：**${clampText(parsed.text, 800)}`,
            '',
            submitted.ok
              ? '已同时提交一次启动输入，执行状态请见进度卡片。'
              : `目标已保存，但启动输入没有提交：${submitted.reason}`,
          ].join('\n') },
        }],
      }));
      return;
    }
    if (parsed.action === 'clear') {
      const cleared = await this.#harness.updateGoal(task.sessionId, 'clear');
      if (!cleared.ok) {
        await this.#sendTextNotice(chatId, `清除目标失败：${cleared.reason}`);
        return;
      }
      await this.#sendCard(chatId, card({
        title: '🗑️ 目标已清除',
        template: 'grey',
        elements: [{ tag: 'div',
        text: { tag: 'lark_md', content: '该目标不再推进。任务本身仍然保留。' }}],
      }));
      return;
    }
  }

  #goalView(sessionId) {
    const goal = this.#harness.goalOf(sessionId);
    if (!goal) return null;
    return {
      objective: goal.objective,
      phase: goal.phase,
      activation: goal.activation,
      roundsStarted: goal.roundsStarted ?? 0,
      maxGoalRounds: goal.maxGoalRounds ?? 0,
      blockedReason: goal.blockedReason?.message ?? null,
    };
  }

  // -------------------------------------------------------------- run control

  async #compact(task, chatId) {
    if (!task) {
      await this.#sendTextNotice(chatId, '请先选择一个任务。');
      return;
    }
    const started = Date.now();
    await this.#sendCard(chatId, card({
      title: '🧹 正在压缩上下文',
      template: 'blue',
      elements: [{ tag: 'div',
      text: { tag: 'lark_md', content: `**任务：**${task.label}\n\n压缩可能需要一段时间，完成后会更新这张卡片。` }}],
    }));
    const controller = new AbortController();
    // A long compaction may outlive the caller; a timeout is "result pending",
    // never "failed".
    const result = await withTimeout(
      this.#harness.compact(task.sessionId, controller.signal),
      this.#config.compactTimeoutMs ?? 60_000,
      { ok: false, reason: 'pending' },
    );
    if (result.ok === true) {
      await this.#sendCard(chatId, card({
        title: '✅ 上下文已压缩',
        template: 'green',
        elements: [{
          tag: 'div',
          text: { tag: 'lark_md', content: `**任务：**${task.label}\n**耗时：**${Math.round((Date.now() - started) / 1000)}s` },
        }],
      }));
      return;
    }
    if (result.reason === 'pending') {
      await this.#sendCard(chatId, card({
        title: '⌛ 压缩结果待确认',
        template: 'orange',
        elements: [{
          tag: 'div',
          text: { tag: 'lark_md', content: [
            `**任务：**${task.label}`,
            '',
            '等待确认超时，但压缩可能仍在进行。',
            '请稍后用 `/task current` 或 `/history` 查看结果，不要连续重复提交。',
          ].join('\n') },
        }],
      }));
      return;
    }
    await this.#sendCard(chatId, card({
      title: '⚠️ 压缩失败',
      template: 'red',
      elements: [{ tag: 'div',
      text: { tag: 'lark_md', content: `**任务：**${task.label}\n\n${result.reason}` }}],
    }));
  }

  async #stop(task, chatId) {
    if (!task) {
      await this.#sendTextNotice(chatId, '请先选择一个任务。');
      return;
    }
    const tracker = this.#state.round(task.sessionId);
    const cancelled = await this.#harness.cancelTurn(task.sessionId);
    if (!cancelled.ok) {
      await this.#sendTextNotice(chatId, `停止请求没有被接受：${cancelled.reason}`);
      return;
    }
    if (tracker) {
      tracker.noteWaiting('已收到停止请求，等待执行端确认');
      await this.#patchProgress(task, tracker);
    }
    await this.#sendCard(chatId, card({
      title: '⏹️ 已发出停止请求',
      template: 'orange',
      elements: [{
        tag: 'div',
        text: { tag: 'lark_md', content: [
          `**任务：**${task.label}`,
          '',
          '停止只作用于这个任务的当前轮次，不会退出整个执行端。',
          '收到停止请求不等于执行已经完全停止，最终状态请看进度卡片。',
        ].join('\n') },
      }],
    }));
  }

  async #restart(chatId) {
    await this.#sendCard(chatId, card({
      title: '🔄 重启执行端',
      template: 'orange',
      elements: [{
        tag: 'div',
        text: { tag: 'lark_md', content: [
          '**影响范围：**执行任务的应用或服务。',
          '',
          '重启可能中断多个正在进行的任务，不等同于刷新页面。',
          '这个插件不在飞书侧直接重启执行端：请在 DeepSeek Harness 客户端或服务管理入口操作，重启后飞书会自动重连并恢复跟踪。',
          '',
          '只想结束当前任务请用 `/stop`。',
        ].join('\n') },
      }],
    }));
  }

  async #update(chatId) {
    await this.#sendCard(chatId, updateCard({
      currentVersion: this.#config.version ?? '未知',
      targetVersion: null,
      state: '未接入在线更新源',
      notes: '这个插件不自带更新下载能力。请在 DeepSeek Harness 的插件管理里升级 `dsh-feishu-only`，升级后重新加载插件即可。',
    }));
  }

  // ------------------------------------------------------------- card actions

  /**
   * Handle one `card.action.trigger` callback.
   *
   * Returns the response body the platform expects, so the client shows a toast
   * instead of an error.
   */
  async onCardAction(event) {
    const action = normalizeCardAction(event);
    if (!action.ok) return toast('error', '无法识别操作者');

    this.#rememberOperator(action.operatorOpenId, action.chatId, 'p2p');
    const rawId = String(action.value?.id ?? '');
    const [verb, ...rest] = rawId.split(':');
    const recordId = rest.join(':');
    const pageKey = action.value?.pageKey;
    const index = Number(action.value?.index);
    const userId = action.operatorOpenId;

    try {
      // Interactions are claimed before anything else so a stale card cannot
      // answer a request twice.
      if (verb === 'approval.allow' || verb === 'approval.reject') {
        const decision = verb === 'approval.allow' ? 'allowed-once' : 'rejected';
        const result = this.#interactions.resolveApproval({
          id: recordId,
          decision,
          operatorOpenId: userId,
        });
        if (!result.ok) return explainClaimFailure(result.reason);
        await this.#refreshInteractionCard(action, recordId, decision);
        return toast('success', decision === 'allowed-once' ? '已允许一次' : '已拒绝');
      }

      if (verb === 'question.answer') {
        // One option press. Answers accumulate until every question has one,
        // then the whole set resolves the original request.
        const pending = this.#state.pendingInteraction(recordId);
        if (!pending) return toast('error', '这个问题已经失效或已回答');
        if (pending.userId && pending.userId !== userId) {
          return toast('error', '这个问题不是发给你的');
        }
        const questionId = String(action.value?.questionId ?? '');
        const optionIndex = Number(action.value?.value);
        const question = (pending.payload?.questions ?? []).find((item) => item.id === questionId);
        const option = question?.options?.[optionIndex];
        if (!option) return toast('error', '这个选项已经失效');
        return this.#recordAnswer({ recordId, userId, pending, questionId, answer: { selected: [option.label] } });
      }

      if (verb === 'question.freeText') {
        const pending = this.#state.pendingInteraction(recordId);
        if (!pending) return toast('error', '这个问题已经失效或已回答');
        if (pending.userId && pending.userId !== userId) {
          return toast('error', '这个问题不是发给你的');
        }
        // The next text message from this operator answers that question.
        this.#awaitingText.set(userId, {
          recordId,
          questionId: String(action.value?.questionId ?? ''),
          createdAt: Date.now(),
        });
        return toast('info', '请直接回复一条消息作为答案');
      }

      if (verb === 'question.cancel') {
        this.#awaitingText.delete(userId);
        const result = this.#interactions.cancelQuestion({ id: recordId, operatorOpenId: userId });
        if (!result.ok) return explainClaimFailure(result.reason);
        return toast('info', '已取消');
      }

      const task = this.#state.currentTask(userId);

      switch (verb) {
        case 'help.show':
          await this.#sendCard(action.chatId ?? this.#chatOf(userId), helpCard({ version: this.#config.version }));
          return toast('success', '已打开帮助');

        case 'status.show':
          await this.#sendStatus(action.chatId ?? this.#chatOf(userId), task);
          return toast('success', '已刷新');

        case 'task.list':
          await this.#sendTaskList(action.chatId ?? this.#chatOf(userId), userId, 1);
          return toast('success', '已刷新任务列表');

        case 'task.current':
          await this.#sendCard(
            action.chatId ?? this.#chatOf(userId),
            currentTaskCard({ task: task ? await this.#describeTask(task) : null }),
          );
          return toast('success', '已刷新');

        case 'task.compact':
          await this.#compact(task, action.chatId ?? this.#chatOf(userId));
          return toast('success', '开始压缩');

        case 'task.page':
          await this.#sendTaskList(action.chatId ?? this.#chatOf(userId), userId, Number(action.value?.page) || 1);
          return toast('success', '已翻页');

        case 'task.select': {
          const snapshot = this.#state.snapshotFor(pageKey, userId);
          if (!snapshot) return toast('error', '这个列表已经过期，请重新发送 /task');
          const selected = snapshot.resolve(index);
          if (!selected) return toast('error', '序号不在这个列表中');
          await this.#selectTask(userId, action.chatId ?? this.#chatOf(userId), selected.sessionId);
          return toast('success', '已切换任务');
        }

        case 'task.create': {
          await this.#sendCard(action.chatId ?? this.#chatOf(userId), card({
            title: '➕ 新建任务',
            template: 'blue',
            elements: [{
              tag: 'div',
              text: { tag: 'lark_md', content: '发送 `/task create <标题>` 即可创建并自动选中新任务。' },
            }],
          }));
          return toast('info', '请用 /task create');
        }

        case 'task.create.hint':
          return toast('info', '发送 /task create <标题> 新建任务');

        case 'history.show': {
          const page = Number(action.value?.page) || 1;
          if (task) await this.#sendHistory(action.chatId ?? this.#chatOf(userId), task, page);
          else await this.#sendHistory(action.chatId ?? this.#chatOf(userId), null, 1);
          return toast('success', '已刷新历史');
        }

        case 'history.fork': {
          if (!task) return toast('error', '请先选择任务');
          const snapshot = this.#state.snapshotFor(pageKey, userId);
          const round = snapshot?.resolve(index);
          const forked = await this.#harness.forkTask(task.sessionId, round?.startSeq);
          if (!forked.ok) return toast('error', `创建分支失败：${forked.reason}`);
          const branched = this.#taskFor(forked.value, null);
          this.#state.setCurrentTask(userId, branched);
          await this.#sendCard(action.chatId ?? this.#chatOf(userId), card({
            title: '🌿 已创建分支',
            template: 'green',
            elements: [{
              tag: 'div',
              text: { tag: 'lark_md', content: [
                `已从第 ${index} 轮创建分支：\`${branched.sessionId}\``,
                '',
                '**当前任务已经切换到新分支**，原任务不受影响。',
              ].join('\n') },
            }],
          }));
          return toast('success', '已创建分支并切换');
        }

        case 'goal.show':
          await this.#sendCard(
            action.chatId ?? this.#chatOf(userId),
            goalCard({ task, goal: task ? this.#goalView(task.sessionId) : null }),
          );
          return toast('success', '已刷新');

        case 'goal.pause':
        case 'goal.resume': {
          if (!task) return toast('error', '请先选择任务');
          const action2 = verb === 'goal.pause' ? 'pause' : 'resume';
          const updated = await this.#harness.updateGoal(task.sessionId, action2);
          if (!updated.ok) return toast('error', updated.reason);
          await this.#sendCard(
            action.chatId ?? this.#chatOf(userId),
            goalCard({ task, goal: this.#goalView(task.sessionId) }),
          );
          return toast('success', action2 === 'pause' ? '已暂停' : '已继续');
        }

        case 'goal.clear': {
          if (!task) return toast('error', '请先选择任务');
          const cleared = await this.#harness.updateGoal(task.sessionId, 'clear');
          if (!cleared.ok) return toast('error', cleared.reason);
          return toast('success', '目标已清除');
        }

        case 'result.last':
          await this.#sendLast(task, action.chatId ?? this.#chatOf(userId));
          return toast('success', '已获取最新回复');

        case 'round.stop':
          await this.#stop(task, action.chatId ?? this.#chatOf(userId));
          return toast('success', '已发出停止请求');

        case 'staged.cancel': {
          const cleared = this.#state.clearStagedImages(userId);
          return toast('info', cleared ? `已取消 ${cleared.items.length} 张暂存图片` : '没有暂存图片');
        }

        case 'settings.page': {
          const kind = String(action.value?.kind ?? '');
          if (!task) return toast('error', '请先选择任务');
          await this.#sendSettingsCard(
            action.chatId ?? this.#chatOf(userId),
            userId,
            task,
            kind,
            Number(action.value?.page) || 1,
          );
          return toast('success', '已翻页');
        }

        case 'settings.select': {
          const kind = String(action.value?.kind ?? '');
          if (!task) return toast('error', '请先选择任务');
          const snapshot = this.#state.latestSnapshot(userId, `settings:${kind}`);
          if (!snapshot) return toast('error', '这个选项列表已经过期，请重新获取');
          const option = snapshot.resolve(index);
          if (!option) return toast('error', '序号不在这个列表中');
          await this.#applySetting(task, action.chatId ?? this.#chatOf(userId), kind, option);
          return toast('success', '已切换');
        }

        case 'project.list': {
          const chatId = action.chatId ?? this.#chatOf(userId);
          await this.#sendProject(chatId, { page: 1 }, userId);
          return toast('success', '已刷新项目列表');
        }

        case 'project.page': {
          const chatId = action.chatId ?? this.#chatOf(userId);
          const page = Number(action.value?.page);
          await this.#sendProject(chatId, { page: Number.isFinite(page) ? page : 1 }, userId);
          return toast('success', '已翻页');
        }

        case 'project.select': {
          const snapshot = this.#state.snapshotFor(pageKey, userId);
          if (!snapshot) return toast('error', '这个项目列表已经过期，请重新发送 /project');
          const workspace = snapshot.resolve(index);
          if (!workspace) return toast('error', '序号不在这个列表中');
          const created = await this.#harness.createTask({
            chatId: `proj-${randomUUID().slice(0, 8)}`,
            cwd: workspace.path,
            agentPreset: this.#config.agentPreset,
          });
          if (!created.ok) return toast('error', `创建任务失败：${created.reason}`);
          const newTask = this.#taskFor(created.value, { title: workspace.title, cwd: workspace.path });
          this.#state.setCurrentTask(userId, newTask);
          await this.#sendCard(action.chatId ?? this.#chatOf(userId), card({
            title: '✅ 已在项目中创建任务',
            template: 'green',
            elements: [{
              tag: 'div',
              text: { tag: 'lark_md', content: [
                `**项目：**${workspace.title}`,
                `**任务 ID：**\`${newTask.sessionId}\``,
                '',
                '接下来发送的文字会提交到这个新任务。已有任务请用 `/task` 选择。',
              ].join('\n') },
            }],
          }));
          return toast('success', '已创建并选中');
        }

        case 'preview.show': {
          const path = String(action.value?.path ?? '');
          if (!path) return toast('error', '缺少预览目标');
          await this.#preview?.show({
            chatId: action.chatId ?? this.#chatOf(userId),
            task,
            path,
            downloadId: `preview.download:${path}`,
          });
          return toast('success', '正在生成预览');
        }

        case 'preview.download': {
          const path = String(action.value?.path ?? '');
          if (!path) return toast('error', '缺少下载目标');
          await this.#preview?.download({ chatId: action.chatId ?? this.#chatOf(userId), task, path });
          return toast('success', '正在上传原文件');
        }

        default:
          return toast('info', '这个按钮没有绑定操作');
      }
    } catch (error) {
      this.#logger.error(`[feishu] card action failed: ${error?.stack ?? error}`);
      return toast('error', oneLine(error?.message ?? error, 80));
    }
  }

  /**
   * Record one answer and resolve the request once every question is answered.
   *
   * Answers arrive one at a time (a button press or a text reply), so the draft
   * is held here until the set is complete.
   */
  #recordAnswer({ recordId, userId, pending, questionId, answer }) {
    const questions = pending.payload?.questions ?? [];
    const draft = this.#answerDrafts.get(recordId) ?? new Map();
    draft.set(questionId, answer);
    this.#answerDrafts.set(recordId, draft);

    const missing = questions.filter((question) => !draft.has(question.id));
    if (missing.length > 0) {
      const label = missing[0].header ?? missing[0].question ?? '下一项';
      return toast('success', `已记录，还剩 ${missing.length} 项：${label}`);
    }

    const answers = questions.map((question) => ({
      id: question.id,
      ...(draft.get(question.id) ?? { selected: [] }),
    }));
    const result = this.#interactions.resolveQuestion({
      id: recordId,
      answers,
      operatorOpenId: userId,
    });
    this.#answerDrafts.delete(recordId);
    this.#awaitingText.delete(userId);
    if (!result.ok) return explainClaimFailure(result.reason);
    return toast('success', '答案已提交');
  }

  async #refreshInteractionCard(action, recordId, decision) {
    if (!action.messageId) return;
    const pending = this.#state.pendingInteraction(recordId);
    try {
      await this.#api.patchCard(action.messageId, card({
        title: decision === 'allowed-once' ? '✅ 已允许一次' : '❌ 已拒绝',
        template: decision === 'allowed-once' ? 'green' : 'red',
        elements: [{
          tag: 'div',
          text: { tag: 'lark_md', content: `**操作：**\`${pending?.payload?.toolName ?? '操作'}\`\n\n这张卡片已经处理完毕。` },
        }],
      }));
    } catch {
      // The decision stands even when the card cannot be repainted.
    }
  }

  // ---------------------------------------------------------------- utilities

  #rememberOperator(openId, chatId, chatType) {
    if (!openId) return;
    let entry = this.#operators.get(openId);
    if (!entry) {
      entry = { openId, chats: new Map(), taskIds: new Set() };
      this.#operators.set(openId, entry);
    }
    if (chatId) entry.chats.set(chatId, chatType);
    const current = this.#state.currentTask(openId);
    if (current) entry.taskIds.add(current.sessionId);
  }

  #chatOf(openId) {
    const entry = this.#operators.get(openId);
    if (!entry) return null;
    // Prefer a private chat for system replies.
    for (const [chatId, kind] of entry.chats) {
      if (kind === 'p2p') return chatId;
    }
    return entry.chats.keys().next().value ?? null;
  }

  /** Operators who may receive private interactions for one task. */
  operatorsForTask(sessionId) {
    const targets = [];
    for (const entry of this.#operators.values()) {
      const isOwner = entry.taskIds.has(sessionId)
        || this.#state.currentTask(entry.openId)?.sessionId === sessionId;
      if (!isOwner) continue;
      const privateChat = [...entry.chats.entries()].find(([, kind]) => kind === 'p2p');
      targets.push({
        openId: entry.openId,
        chatId: privateChat?.[0] ?? this.#chatOf(entry.openId),
      });
    }
    return targets;
  }

  /** Note connection health so `/status` can report it separately from tasks. */
  updateHealth({ bot, ws, lastError } = {}) {
    if (bot !== undefined) this.#health.bot = bot;
    if (ws !== undefined) this.#health.ws = ws;
    if (lastError !== undefined) this.#health.lastError = lastError;
  }

  /** Snapshot of every task this bridge knows about. */
  knownTasks() {
    return [...this.#tasks.values()];
  }

  async #sendCard(chatId, payload) {
    if (!chatId) {
      this.#logger.warn('[feishu] cannot send a card: no chat id');
      return null;
    }
    try {
      const sent = await this.#api.sendCard(chatId, payload);
      this.#onDiagnostic?.({ kind: 'card-sent', chat: chatId });
      return sent;
    } catch (error) {
      const detail = error?.code ? `code ${error.code}: ` : '';
      this.#logger.warn(`[feishu] card delivery failed: ${detail}${error?.message ?? error}`);
      this.#onDiagnostic?.({
        kind: 'card-failed',
        chat: chatId,
        code: error?.code ?? null,
        error: String(error?.message ?? error).slice(0, 300),
      });
      // A rejected card must not leave the user staring at silence: fall back
      // to plain text so the command still answers, and say the rich version
      // failed rather than pretending it was never requested.
      const fallback = renderCardAsText(payload);
      if (fallback) {
        try {
          const sent = await this.#api.sendText(
            chatId,
            `${fallback}\n\n（卡片渲染失败，已改用纯文本${detail ? `：${detail}` : ''}）`,
          );
          this.#onDiagnostic?.({ kind: 'text-fallback-sent', chat: chatId });
          return sent;
        } catch (textError) {
          this.#onDiagnostic?.({
            kind: 'text-failed',
            chat: chatId,
            error: String(textError?.message ?? textError).slice(0, 300),
          });
        }
      }
      return null;
    }
  }

  async #sendTextNotice(chatId, text) {
    if (!chatId) return null;
    try {
      return await this.#api.sendText(chatId, text);
    } catch (error) {
      this.#logger.warn(`[feishu] text delivery failed: ${error?.message ?? error}`);
      this.#onDiagnostic?.({
        kind: 'text-failed',
        chat: chatId,
        code: error?.code ?? null,
        error: String(error?.message ?? error).slice(0, 300),
      });
      return null;
    }
  }

  /** Stop every timer and drop state. */
  dispose() {
    this.#disposed = true;
    for (const sessionId of this.#roundTimers.keys()) this.#stopRoundPoll(sessionId);
    for (const sessionId of this.#progressTimers.keys()) this.#stopRoundPoll(sessionId);
    this.#state.clear();
    this.#tasks.clear();
    this.#operators.clear();
  }
}

// ------------------------------------------------------------------- helpers

function toast(type, content) {
  return { toast: { type, content } };
}

function explainClaimFailure(reason) {
  switch (reason) {
    case 'missing':
      return toast('error', '这个请求已经失效');
    case 'claimed':
    case 'answered':
    case 'allowed':
    case 'rejected':
    case 'cancelled':
      return toast('info', '这个请求已经处理过了');
    case 'expired':
      return toast('error', '这个请求已经超时');
    case 'forbidden':
      return toast('error', '这个请求不是发给你的');
    default:
      return toast('error', '无法处理这个请求');
  }
}

function oneLine(text, limit = 120) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/**
 * Flatten a card into readable plain text.
 *
 * This is the fallback when the platform rejects a card: the user still needs
 * the answer, so headers, rich text, notes and button labels are reduced to a
 * text message. Buttons are rendered as their labels only, because a text
 * message cannot carry a callback.
 */
export function renderCardAsText(payload, limit = 3000) {
  const lines = [];
  if (payload?.header?.title?.content) lines.push(`【${payload.header.title.content}】`);
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    switch (node.tag) {
      case 'div':
        if (node.text?.content) lines.push(String(node.text.content));
        return;
      case 'markdown':
        if (node.content) lines.push(String(node.content));
        return;
      case 'button':
        if (node.text?.content) lines.push(`[${node.text.content}]`);
        return;
      case 'img':
        lines.push('[图片]');
        return;
      case 'input':
      case 'select_static':
      case 'multi_select_static':
        return;
      default:
        break;
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(payload?.body?.elements ?? []);
  // Card markdown uses `**bold**` and `<font>`; both are noise in plain text.
  const text = lines
    .join('\n')
    .replace(/<font[^>]*>/gu, '')
    .replace(/<\/font>/gu, '')
    .replace(/\*\*/gu, '')
    .replace(/`/gu, '')
    .trim();
  if (!text) return '';
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function firstLine(text, limit = 40) {
  const first = String(text ?? '').split('\n').find((line) => line.trim()) ?? '';
  return oneLine(first, limit);
}

function formatTimestamp(value) {
  try {
    return new Date(value).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(value).toISOString().slice(5, 16).replace('T', ' ');
  }
}

function sanitizeFileName(name) {
  const base = String(name ?? 'file').replace(/[\\/:*?"<>|]/gu, '_').trim();
  return base.slice(0, 120) || 'file';
}

function detectImageType(bytes, contentType) {
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (SUPPORTED_IMAGE_TYPES.has(declared)) return declared;
  // Sniff the magic number when the header is missing or generic.
  if (bytes.length >= 8) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  }
  return declared || 'application/octet-stream';
}

async function withTimeout(promise, timeoutMs, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export { groupRounds };