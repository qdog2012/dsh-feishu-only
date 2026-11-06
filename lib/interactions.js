/**
 * Approval and question bridging.
 *
 * The reference keeps two interactions strictly apart:
 *
 *  - An **approval** answers "may this operation run?" and resolves to one of
 *    `allowed-once` / `rejected` / `cancelled` / `unavailable`.
 *  - A **question** answers "what did the user choose or type?" and returns the
 *    complete answer set to the original request.
 *
 * Both are delivered to the operator's PRIVATE chat, because they may carry
 * sensitive scope information that must not land in a group. A failed private
 * delivery is never treated as a grant: approvals fail closed.
 *
 * @module dsh-feishu-only/lib/interactions
 */

import { approvalCard, questionCard, clampText } from './cards.js';
import { randomUUID } from 'node:crypto';

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const QUESTION_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Bridges `approval/request` and `user-questions/request` waterfalls to cards.
 */
export class InteractionBridge {
  #ctx;
  #state;
  #api;
  #logger;
  #taskLookup;
  #operatorsFor;
  #deliver;

  /**
   * @param {{
   *   ctx: any,
   *   state: import('./state.js').InteractionState,
   *   api: import('./feishu/api.js').FeishuApi,
   *   logger?: Console,
   *   taskLookup: (sessionId: string) => any,
   *   operatorsFor: (sessionId: string) => Array<{ openId: string, userId: string, chatId: string }>,
   *   deliver: (chatId: string, card: object, options?: object) => Promise<any>,
   * }} options
   */
  constructor({ ctx, state, api, logger = console, taskLookup, operatorsFor, deliver }) {
    this.#ctx = ctx;
    this.#state = state;
    this.#api = api;
    this.#logger = logger;
    this.#taskLookup = taskLookup;
    this.#operatorsFor = operatorsFor;
    this.#deliver = deliver;
  }

  /**
   * Install both waterfall listeners.
   *
   * @returns {() => void} disposer removing them.
   */
  install() {
    const disposers = [];
    disposers.push(this.#ctx.on('approval/request', async (event, next) => {
      try {
        const outcome = await this.#handleApproval(event);
        if (outcome) return outcome;
      } catch (error) {
        this.#logger.warn(`[feishu] approval bridge failed: ${error?.message ?? error}`);
      }
      // Unhandled or failed: let the next answerer decide. The approval service
      // turns "nobody answered" into a fail-closed `unavailable`.
      return next();
    }));

    disposers.push(this.#ctx.on('user-questions/request', async (event, next) => {
      try {
        const answer = await this.#handleQuestions(event);
        if (answer) return answer;
      } catch (error) {
        this.#logger.warn(`[feishu] question bridge failed: ${error?.message ?? error}`);
      }
      return next();
    }));

    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // A listener already removed needs no further action.
        }
      }
    };
  }

  // -------------------------------------------------------------- approvals

  async #handleApproval(event) {
    const agent = event?.agent;
    const sessionId = agent?.id;
    if (!sessionId) return null;
    const task = this.#taskLookup(sessionId);
    // Only Feishu-owned tasks are answered from Feishu; anything else keeps
    // whatever answerer already owns it.
    if (!task) return null;

    const targets = this.#operatorsFor(sessionId);
    if (targets.length === 0) {
      // No private chat was ever established: fail closed, never grant by
      // default because delivery is impossible.
      this.#logger.warn('[feishu] no private chat available for an approval; rejecting');
      return 'rejected';
    }

    const id = randomUUID();
    const expiresAt = Date.now() + APPROVAL_TIMEOUT_MS;
    const record = this.#state.addPendingInteraction('approval', {
      id,
      sessionId,
      userId: targets[0].openId,
      chatId: targets[0].chatId,
      payload: {
        toolName: event.toolName,
        callId: event.callId,
        reason: event.reason,
      },
    });

    const card = approvalCard({
      task,
      toolName: event.toolName ?? '操作',
      reason: event.reason,
      detail: this.#describeApproval(event),
      scopeNote: '允许一次只影响这一次调用；本任务始终允许的生效范围与执行端一致，不会扩展到其它任务。',
      allowOnceId: `approval.allow:${id}`,
      allowSessionId: null,
      rejectId: `approval.reject:${id}`,
      expiresAt,
    });

    let delivered = false;
    for (const target of targets) {
      try {
        await this.#deliver(target.openId, card, { receiveIdType: 'open_id' });
        delivered = true;
        break;
      } catch (error) {
        this.#logger.warn(
          `[feishu] could not deliver an approval to ${target.openId}: ${error?.message ?? error}`,
        );
      }
    }

    if (!delivered) {
      // Delivery failure is a rejection, per the fail-closed rule, and the
      // user is told to start a private chat so the next attempt can work.
      this.#state.settlePendingInteraction(id, 'undeliverable');
      return 'rejected';
    }

    return this.#awaitDecision(id, record, event.signal, APPROVAL_TIMEOUT_MS, 'rejected');
  }

  #describeApproval(event) {
    const display = event?.displayReason;
    if (display && typeof display === 'object') {
      return display.zh ?? display.en ?? Object.values(display)[0] ?? null;
    }
    return null;
  }

  // -------------------------------------------------------------- questions

  async #handleQuestions(request) {
    const agent = request?.agent;
    const sessionId = agent?.id;
    if (!sessionId) return null;
    const task = this.#taskLookup(sessionId);
    if (!task) return null;

    const questions = Array.isArray(request?.questions) ? request.questions : [];
    if (questions.length === 0) return null;

    const targets = this.#operatorsFor(sessionId);
    if (targets.length === 0) {
      // A question has no safe default: leaving the request pending is better
      // than auto-answering it.
      this.#logger.warn('[feishu] no private chat available for a question; leaving the request pending');
      return null;
    }

    const id = randomUUID();
    const expiresAt = Date.now() + QUESTION_TIMEOUT_MS;
    const normalized = questions.map((question, index) => ({
      id: question.id ?? `q${index}`,
      question: question.question ?? '',
      detail: question.detail,
      header: question.header,
      options: Array.isArray(question.options) ? question.options : undefined,
      multiSelect: question.multiSelect === true,
    }));

    const record = this.#state.addPendingInteraction('question', {
      id,
      sessionId,
      userId: targets[0].openId,
      chatId: targets[0].chatId,
      payload: { questions: normalized },
    });

    const card = questionCard({
      task,
      questions: normalized,
      cancelId: `question.cancel:${id}`,
      expiresAt,
    });

    let delivered = false;
    for (const target of targets) {
      try {
        await this.#deliver(target.openId, card, { receiveIdType: 'open_id' });
        delivered = true;
        break;
      } catch (error) {
        this.#logger.warn(
          `[feishu] could not deliver a question to ${target.openId}: ${error?.message ?? error}`,
        );
      }
    }
    if (!delivered) {
      // A failed question card keeps the original request pending; the caller
      // (a browser, say) can still answer it.
      this.#state.settlePendingInteraction(id, 'undeliverable');
      return null;
    }

    const decision = await this.#awaitDecision(id, record, request.signal, QUESTION_TIMEOUT_MS, null);
    if (!decision || typeof decision !== 'object') return null;
    return { answers: decision.answers };
  }

  // ---------------------------------------------------------------- waiting

  /**
   * Wait for a card callback to settle one pending interaction.
   *
   * Resolves with the recorded answer, or the caller-supplied fallback when
   * the wait ends without one. An aborted signal cancels the wait so a stopped
   * turn does not leave a dangling card.
   */
  async #awaitDecision(id, record, signal, timeoutMs, fallback) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        record.resolve = null;
        resolve(value);
      };
      const onAbort = () => {
        this.#state.settlePendingInteraction(id, 'cancelled');
        finish(fallback);
      };
      const timer = setTimeout(() => {
        this.#state.settlePendingInteraction(id, 'expired');
        finish(fallback);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      // The callback path looks the record up by id and calls this hook.
      record.resolve = finish;
    });
  }

  /**
   * Answer one pending approval from a card callback.
   *
   * @param {{ id: string, decision: 'allowed-once'|'rejected', operatorOpenId: string }} request
   * @returns {{ ok: boolean, reason?: string }}
   */
  resolveApproval({ id, decision, operatorOpenId }) {
    const claim = this.#state.claimPendingInteraction(id, { userId: operatorOpenId });
    if (!claim.ok) return { ok: false, reason: claim.reason };
    this.#state.settlePendingInteraction(id, decision === 'allowed-once' ? 'allowed' : 'rejected');
    claim.record.resolve?.(decision);
    return { ok: true };
  }

  /**
   * Answer one pending question set from a card callback.
   */
  resolveQuestion({ id, answers, operatorOpenId }) {
    const claim = this.#state.claimPendingInteraction(id, { userId: operatorOpenId });
    if (!claim.ok) return { ok: false, reason: claim.reason };
    this.#state.settlePendingInteraction(id, 'answered');
    claim.record.resolve?.({ answers });
    return { ok: true };
  }

  /** Cancel one pending question, e.g. when the operator presses "取消". */
  cancelQuestion({ id, operatorOpenId }) {
    const claim = this.#state.claimPendingInteraction(id, { userId: operatorOpenId });
    if (!claim.ok) return { ok: false, reason: claim.reason };
    this.#state.settlePendingInteraction(id, 'cancelled');
    claim.record.resolve?.(null);
    return { ok: true };
  }

  /** Render a settled approval card so the buttons stop being live. */
  settledApprovalCard({ task, toolName, decision, expiresAt }) {
    const label = decision === 'allowed-once' ? '✅ 已允许一次'
      : decision === 'rejected' ? '❌ 已拒绝'
        : '⌛ 已失效';
    return approvalCard({
      task,
      toolName,
      detail: label,
      allowOnceId: `approval.settled:${randomUUID()}`,
      rejectId: `approval.settled:${randomUUID()}`,
      expiresAt,
    });
  }

  /** Render the settled question card. */
  settledQuestionCard({ task, questions, summary }) {
    return questionCard({
      task,
      questions,
      cancelId: `question.settled:${randomUUID()}`,
      expiresAt: null,
    }) && {
      schema: '2.0',
      config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: '✅ 已提交答案' }, template: 'green' },
      body: {
        elements: [
          { tag: 'markdown', content: clampText(summary, 2000) },
        ],
      },
    };
  }
}