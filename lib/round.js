/**
 * One execution round's live tracker.
 *
 * A round owns exactly one progress card. The tracker consumes session events
 * and produces two separate things, which the reference insists must not be
 * conflated: the progress state rendered into that card, and the final answer
 * delivered as its own message.
 *
 * Internal reasoning is never surfaced: `progress` carries user-facing
 * statements only.
 *
 * @module dsh-feishu-only/lib/round
 */

import { textFromContent } from './harness.js';

/** Tool names rendered with a human label. */
const TOOL_LABELS = {
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  glob: '查找文件',
  grep: '搜索内容',
  bash: '执行命令',
  pwsh: '执行命令',
  pwsh_sandbox: '执行命令',
  web_search: '搜索网页',
  web_fetch: '读取网页',
  todo_write: '更新计划',
  task: '创建子任务',
  subagent: '委派子任务',
  workflow: '编排子任务',
  ask_user_question: '询问用户',
  goal_create: '设置目标',
};

function toolLabel(name) {
  return TOOL_LABELS[name] ?? name ?? '工具';
}

/** Truncate one progress line so the card stays readable. */
function oneLine(text, limit = 160) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1)}…`;
}

/**
 * Tracks one execution round for one task.
 */
export class RoundTracker {
  /** @type {string} */
  taskId;
  /** @type {number|null} */
  turn = null;
  /** @type {'starting'|'running'|'waiting'|'done'|'failed'|'stopped'|'retrying'} */
  phase = 'starting';
  /** The newest user-facing statement about what is happening. */
  progress = '';
  /** Rendered tool lines, newest last. */
  toolLines = [];
  /** Resources produced this round. */
  resources = [];
  /** A concrete reason when the round ends abnormally. */
  detail = null;
  startedAt = Date.now();
  finishedAt = null;
  active = true;
  /** The final answer text, once one is committed. */
  finalText = null;
  /** Seq of the final assistant message, used for delivery dedupe. */
  finalSeq = null;
  /** Whether any assistant text was produced at all. */
  producedText = false;
  /** Card coordinates, filled in by the bridge once the card is sent. */
  cardMessageId = null;
  #promptText = null;
  #toolCallNames = new Map();
  #pendingToolText = '';
  #lastSeq = -1;
  #assistantText = '';
  #failed = false;
  #retryNote = null;

  constructor({ taskId, promptText = null, afterSeq = -1 }) {
    this.taskId = taskId;
    this.#promptText = promptText;
    this.#lastSeq = afterSeq;
    if (promptText) this.progress = `已提交需求：${oneLine(promptText, 80)}`;
  }

  /** The card phase name. */
  get phaseLabel() {
    return this.phase;
  }

  /** Whether the round has already settled. */
  get finished() {
    return !this.active;
  }

  /**
   * Consume session events.
   *
   * @param {readonly any[]} events
   * @returns {{ changed: boolean, final?: { text: string, seq: number }, ended?: { phase: string, detail: string|null } }}
   */
  consume(events) {
    if (!this.active) return { changed: false };
    const ordered = [...events]
      .filter((event) => (event?.seq ?? -1) > this.#lastSeq)
      .sort((left, right) => (left?.seq ?? 0) - (right?.seq ?? 0));
    if (ordered.length === 0) return { changed: false };

    let changed = false;
    let final = null;
    let ended = null;

    for (const event of ordered) {
      this.#lastSeq = event.seq ?? this.#lastSeq;
      switch (event.type) {
        case 'turn/start': {
          this.turn = event.data?.turn ?? this.turn;
          this.phase = 'running';
          changed = true;
          break;
        }
        case 'user/message': {
          const text = textFromContent(event.data?.message?.content);
          // The prompt echo is not progress; anything else is a supplement.
          if (text && this.#promptText && !text.includes(oneLine(this.#promptText, 40))) {
            this.progress = `已收到补充需求：${oneLine(text, 80)}`;
            changed = true;
          }
          break;
        }
        case 'assistant/message': {
          const text = textFromContent(event.data?.message?.content);
          if (!text) break;
          this.producedText = true;
          this.#assistantText = text;
          this.progress = oneLine(text, 120);
          this.finalText = text;
          this.finalSeq = event.seq ?? null;
          changed = true;
          break;
        }
        case 'tool/call': {
          const name = event.data?.name ?? '工具';
          const callId = event.data?.callId;
          if (callId) this.#toolCallNames.set(callId, name);
          const line = `${toolLabel(name)}…`;
          this.toolLines = [...this.toolLines, line].slice(-12);
          this.#pendingToolText = line;
          this.#collectResources(event.data?.arguments, name);
          this.phase = 'running';
          changed = true;
          break;
        }
        case 'tool/result': {
          const callId = event.data?.message?.toolCallId ?? event.data?.callId;
          const name = this.#toolCallNames.get(callId);
          const isError = event.data?.message?.isError === true || Boolean(event.data?.error);
          const label = toolLabel(name);
          const line = isError ? `${label} 失败` : `${label} 完成`;
          if (this.toolLines.length > 0) {
            this.toolLines = [...this.toolLines.slice(0, -1), line];
          } else {
            this.toolLines = [line];
          }
          if (isError && event.data?.error?.reason) {
            this.detail = `工具失败：${oneLine(event.data.error.reason, 120)}`;
          }
          changed = true;
          break;
        }
        case 'turn/end': {
          const reason = event.data?.reason?.kind ?? 'completed';
          this.finishedAt = Date.now();
          this.active = false;
          switch (reason) {
            case 'completed':
              this.phase = 'done';
              break;
            case 'aborted': {
              const cause = event.data?.reason?.reason?.kind;
              this.phase = cause === 'user' ? 'stopped' : 'stopped';
              this.detail = cause === 'user' ? '已按你的要求停止。' : `已中止（${cause ?? '未知原因'}）。`;
              break;
            }
            case 'error': {
              this.phase = 'failed';
              this.#failed = true;
              const failure = event.data?.reason?.error;
              this.detail = failure?.message
                ? `执行失败：${oneLine(failure.message, 200)}`
                : '执行失败。';
              break;
            }
            case 'max-tokens':
              this.phase = 'done';
              this.detail = '达到模型输出上限，本轮回复被截断。';
              break;
            case 'blocked':
              this.phase = 'failed';
              this.detail = '本轮被阻止，未执行。';
              break;
            case 'interrupted':
              this.phase = 'stopped';
              this.detail = '本轮被中断。';
              break;
            default:
              this.phase = 'done';
              this.detail = `本轮结束（${reason}）。`;
              break;
          }
          if (this.phase === 'done' && this.finalText) {
            final = { text: this.finalText, seq: this.finalSeq ?? this.#lastSeq };
          }
          ended = { phase: this.phase, detail: this.detail };
          changed = true;
          break;
        }
        case 'approval/asked': {
          this.phase = 'waiting';
          this.progress = `等待审批：${event.data?.toolName ?? '操作'}`;
          changed = true;
          break;
        }
        case 'approval/decided': {
          this.phase = this.progress.startsWith('等待审批') ? 'running' : this.phase;
          const outcome = event.data?.outcome;
          this.progress = outcome === 'allowed-once' ? '审批通过，继续执行'
            : outcome === 'rejected' ? '你拒绝了该操作'
              : '审批未通过，继续处理';
          changed = true;
          break;
        }
        case 'goal/changed': {
          this.progress = '目标已更新';
          changed = true;
          break;
        }
        case 'compaction/start': {
          this.progress = '正在压缩上下文…';
          this.phase = 'running';
          changed = true;
          break;
        }
        case 'compaction/end': {
          this.progress = '上下文已压缩';
          changed = true;
          break;
        }
        default:
          break;
      }
    }
    return { changed, ...(final ? { final } : {}), ...(ended ? { ended } : {}) };
  }

  /**
   * Record a capacity-style retry wait.
   *
   * Only the bridge's own retry policy calls this, and it always comes with an
   * explicit attempt count so the card can show the wait reason.
   */
  noteRetry({ attempt, reason }) {
    this.phase = 'retrying';
    this.#retryNote = `等待重试（第 ${attempt} 次）：${reason}`;
    this.detail = this.#retryNote;
  }

  /** Clear a retry wait once the retry was submitted. */
  clearRetry() {
    this.#retryNote = null;
    this.detail = null;
    this.phase = 'running';
  }

  /** Mark the round as waiting for an approval or a question. */
  noteWaiting(reason) {
    this.phase = 'waiting';
    this.progress = reason;
  }

  /** Whether the round failed (as opposed to stopping or completing). */
  get failed() {
    return this.#failed;
  }

  /** Note a produced resource (file path) for the progress card. */
  #collectResources(argumentsText, toolName) {
    if (typeof argumentsText !== 'string' || argumentsText.length === 0) return;
    // Only write-flavored tools produce resources worth listing; reading a
    // file is progress, not an artifact.
    if (!['write', 'edit', 'patch'].includes(toolName)) return;
    try {
      const args = JSON.parse(argumentsText);
      const path = args?.file_path ?? args?.path ?? args?.target;
      if (typeof path === 'string' && path) {
        this.resources = [...this.resources, `\`${path.split(/[\\/]/u).pop()}\``].slice(-8);
      }
    } catch {
      // A partially streamed argument blob has no parsable path yet.
    }
  }
}

/**
 * Decide whether a turn error is a model-capacity condition worth retrying.
 *
 * The reference allows one specific retry policy: Feishu-originated tasks only,
 * fixed interval, no attempt cap, with explicit cancel and dedupe protection.
 * Everything else must surface as a real failure.
 */
export function isCapacityError(error) {
  const text = `${error?.code ?? ''} ${error?.message ?? ''}`.toLowerCase();
  if (!text.trim()) return false;
  return text.includes('capacity')
    || text.includes('overloaded')
    || text.includes('rate_limit')
    || text.includes('rate limit')
    || text.includes('too many requests')
    || text.includes('429')
    || text.includes('server_busy')
    || text.includes('service_unavailable')
    || text.includes('503');
}