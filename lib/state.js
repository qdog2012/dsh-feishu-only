/**
 * In-memory interaction state.
 *
 * Everything here is process-local bookkeeping that must survive a reconnect
 * but never a restart: which task a user is on, the numbered snapshot a list
 * button refers to, staged images, tracked rounds and pending interactions.
 *
 * @module dsh-feishu-only/lib/state
 */

import { randomUUID } from 'node:crypto';

/** Page sizes mandated by the interaction reference. */
export const PAGE_SIZE = Object.freeze({ task: 10, project: 10, search: 10, history: 10, settings: 10 });

const STAGED_IMAGE_TTL_MS = 30 * 60 * 1000;
const SNAPSHOT_TTL_MS = 60 * 60 * 1000;
const PENDING_INTERACTION_TTL_MS = 15 * 60 * 1000;

function nowMs() {
  return Date.now();
}

/**
 * A numbered snapshot of one list a user was shown.
 *
 * Numbers are meaningful only against this snapshot: refreshing or re-paging
 * replaces it, so an old button or an old `/task 3` can never resolve to a
 * different task by accident.
 */
class Snapshot {
  #id = randomUUID();
  #kind;
  #items;
  #userId;
  #chatId;
  #query;
  #createdAt = nowMs();

  constructor({ kind, items, userId, chatId, query }) {
    this.#kind = kind;
    this.#items = items;
    this.#userId = userId;
    this.#chatId = chatId;
    this.#query = query ?? null;
  }

  get id() {
    return this.#id;
  }

  get kind() {
    return this.#kind;
  }

  get owner() {
    return this.#userId;
  }

  get createdAt() {
    return this.#createdAt;
  }

  get stale() {
    return nowMs() - this.#createdAt > SNAPSHOT_TTL_MS;
  }

  /** Resolve a 1-based number against this snapshot. */
  resolve(index) {
    if (!Number.isSafeInteger(index) || index < 1) return undefined;
    return this.#items[index - 1];
  }

  get size() {
    return this.#items.length;
  }

  get items() {
    return [...this.#items];
  }

  matches(userId, kind, query) {
    if (this.#userId !== userId) return false;
    if (this.#kind !== kind) return false;
    if ((this.#query ?? null) !== (query ?? null)) return false;
    return true;
  }
}

/**
 * All cross-message state for the bridge.
 *
 * Keyed by `userKey`, which is the platform's `open_id`: the reference keeps
 * the current task per user so switching chats does not silently change the
 * execution target, and every write records the chat it happened in.
 */
export class InteractionState {
  #currentTaskByUser = new Map();
  #snapshots = new Map();
  #stagedImages = new Map();
  #pendingInteractions = new Map();
  #rounds = new Map();
  #deliveredResults = new Map();
  #recentMessages = new Map();
  #logger;
  /** Called after the current task changes, so a caller can persist it. */
  #onCurrentTaskChange;

  /**
   * @param {{ logger?: Console, onCurrentTaskChange?: (userId: string, task: object|null) => void }} [options]
   */
  constructor({ logger = console, onCurrentTaskChange = null } = {}) {
    this.#logger = logger;
    this.#onCurrentTaskChange = typeof onCurrentTaskChange === 'function' ? onCurrentTaskChange : null;
  }

  // ------------------------------------------------------------ current task

  /** Read the task a user is currently driving, if any. */
  currentTask(userId) {
    return this.#currentTaskByUser.get(userId) ?? null;
  }

  /**
   * Every remembered selection, for persistence.
   *
   * @returns {Array<{userId: string, task: object}>}
   */
  currentTaskEntries() {
    return [...this.#currentTaskByUser.entries()].map(([userId, task]) => ({ userId, task }));
  }

  /**
   * Restore a selection without announcing it.
   *
   * This exists for startup: replaying a persisted selection must not look like
   * the user just chose something, or every restart would trigger a "switched
   * task" notice.
   *
   * The task must be a real task object, not the persisted record. A plain
   * literal has no `touch()` and no `label` getter, and the bridge calls both on
   * the next message — so accepting one here trades a startup error for a
   * confusing runtime one. Rejecting it loudly is the cheaper failure.
   */
  restoreCurrentTask(userId, task) {
    if (!userId || !task?.sessionId) return null;
    if (typeof task.touch !== 'function') {
      this.#logger.warn?.(
        `[feishu] refusing to restore a task for ${userId}: the object is not a task instance`,
      );
      return null;
    }
    this.#currentTaskByUser.set(userId, task);
    return task;
  }

  /**
   * Select the task a user will drive next.
   *
   * Only the interaction/tracking target changes; a task that is already
   * running keeps running.
   */
  setCurrentTask(userId, task) {
    if (!task) {
      this.#currentTaskByUser.delete(userId);
      this.#onCurrentTaskChange?.(userId, null);
      return null;
    }
    this.#currentTaskByUser.set(userId, task);
    // Persisting on every change is what makes the selection survive a restart;
    // a selection changes rarely, so this is not a hot path.
    this.#onCurrentTaskChange?.(userId, task);
    return task;
  }

  // -------------------------------------------------------------- snapshots

  /** Record a numbered list and return its snapshot id. */
  recordSnapshot({ kind, items, userId, chatId, query }) {
    this.#pruneSnapshots();
    const snapshot = new Snapshot({ kind, items, userId, chatId, query });
    this.#snapshots.set(snapshot.id, snapshot);
    // Retain the newest snapshot per (user, kind, query) so a paginated button
    // press or a `/task <n>` right after the list still resolves.
    for (const [id, existing] of this.#snapshots) {
      if (id !== snapshot.id && existing.matches(userId, kind, query)) {
        this.#snapshots.delete(id);
      }
    }
    return snapshot;
  }

  /** Read the newest snapshot for a user/kind, ignoring expiry. */
  latestSnapshot(userId, kind, query = null) {
    this.#pruneSnapshots();
    let newest = null;
    for (const snapshot of this.#snapshots.values()) {
      if (!snapshot.matches(userId, kind, query)) continue;
      if (!newest || snapshot.createdAt > newest.createdAt) newest = snapshot;
    }
    return newest;
  }

  /** Read one snapshot by id (used by card callbacks). */
  snapshot(id) {
    if (typeof id !== 'string') return null;
    const snapshot = this.#snapshots.get(id);
    if (!snapshot) return null;
    if (snapshot.stale) {
      this.#snapshots.delete(id);
      return null;
    }
    return snapshot;
  }

  /**
   * Read one snapshot on behalf of an operator.
   *
   * A card click must be authorized by ownership, not by the text the card
   * displays: another user pressing this button gets nothing.
   */
  snapshotFor(id, userId) {
    const snapshot = this.snapshot(id);
    if (!snapshot) return null;
    if (snapshot.owner !== userId) return null;
    return snapshot;
  }

  #pruneSnapshots() {
    for (const [id, snapshot] of this.#snapshots) {
      if (snapshot.stale) this.#snapshots.delete(id);
    }
  }

  // ---------------------------------------------------------- staged images

  /**
   * Stage one image for the next text message.
   *
   * The batch is bound to the originating task, so switching tasks while
   * images wait can never send them somewhere else.
   */
  stageImage(userId, { taskId, chatId, file, name }) {
    const key = userId;
    let staged = this.#stagedImages.get(key);
    if (!staged) {
      staged = { items: [], taskId, chatId, updatedAt: nowMs() };
      this.#stagedImages.set(key, staged);
    }
    if (staged.taskId !== taskId) {
      // A different task means the old batch is no longer deliverable.
      staged.items = [];
      staged.taskId = taskId;
      staged.chatId = chatId;
    }
    staged.items.push({ file, name, addedAt: nowMs() });
    staged.updatedAt = nowMs();
    return staged;
  }

  /** Read the staged batch for a user, expiring old entries. */
  stagedImages(userId) {
    const staged = this.#stagedImages.get(userId);
    if (!staged) return null;
    if (nowMs() - staged.updatedAt > STAGED_IMAGE_TTL_MS) {
      this.#stagedImages.delete(userId);
      return null;
    }
    return staged;
  }

  /** Drop a staged batch (after submit or cancel). */
  clearStagedImages(userId) {
    const staged = this.#stagedImages.get(userId) ?? null;
    this.#stagedImages.delete(userId);
    return staged;
  }

  // ---------------------------------------------------- pending interactions

  /**
   * Track a pending approval or question so a stale card cannot answer twice.
   *
   * @param {string} kind `approval` or `question`.
   * @param {{ sessionId: string, userId?: string, callId?: string, cardMessageId?: string, payload?: any }} entry
   */
  addPendingInteraction(kind, entry) {
    this.#pruneInteractions();
    const id = entry.id ?? randomUUID();
    const record = {
      id,
      kind,
      ...entry,
      createdAt: nowMs(),
      state: 'pending',
    };
    this.#pendingInteractions.set(id, record);
    return record;
  }

  /** Read one pending interaction without claiming it. */
  pendingInteraction(id) {
    this.#pruneInteractions();
    return this.#pendingInteractions.get(id) ?? null;
  }

  /**
   * Claim a pending interaction exactly once.
   *
   * @returns {{ ok: true, record: object } | { ok: false, reason: string, record: object|null }}
   */
  claimPendingInteraction(id, { userId, sessionId } = {}) {
    this.#pruneInteractions();
    const record = this.#pendingInteractions.get(id);
    if (!record) return { ok: false, reason: 'missing', record: null };
    if (record.state !== 'pending') return { ok: false, reason: record.state, record };
    if (entryUserMismatch(record, userId)) return { ok: false, reason: 'forbidden', record };
    if (entrySessionMismatch(record, sessionId)) return { ok: false, reason: 'forbidden', record };
    record.state = 'claimed';
    record.claimedAt = nowMs();
    record.claimedBy = userId;
    return { ok: true, record };
  }

  /** Overwrite the state of a claimed interaction (`answered`, `cancelled`). */
  settlePendingInteraction(id, state) {
    const record = this.#pendingInteractions.get(id);
    if (!record) return null;
    record.state = state;
    record.settledAt = nowMs();
    return record;
  }

  /** Every pending interaction for one session, newest first. */
  pendingForSession(sessionId) {
    this.#pruneInteractions();
    return [...this.#pendingInteractions.values()]
      .filter((record) => record.sessionId === sessionId && record.state === 'pending')
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  #pruneInteractions() {
    const now = nowMs();
    for (const [id, record] of this.#pendingInteractions) {
      if (record.state === 'pending' && now - record.createdAt > PENDING_INTERACTION_TTL_MS) {
        record.state = 'expired';
      }
      // Keep settled records briefly so a late duplicate click gets a clear
      // "already answered" answer instead of "unknown".
      if (record.state !== 'pending' && now - (record.settledAt ?? record.claimedAt ?? record.createdAt) > 10 * 60 * 1000) {
        this.#pendingInteractions.delete(id);
      }
    }
  }

  // ----------------------------------------------------------------- rounds

  /**
   * Register the round currently being tracked for a task.
   *
   * One round has exactly one progress card; re-selecting the same task reuses
   * this record instead of producing a second card.
   */
  registerRound(taskId, round) {
    this.#rounds.set(taskId, round);
    return round;
  }

  round(taskId) {
    return this.#rounds.get(taskId) ?? null;
  }

  finishRound(taskId, outcome) {
    const round = this.#rounds.get(taskId);
    if (!round) return null;
    round.active = false;
    round.outcome = outcome;
    round.finishedAt = nowMs();
    return round;
  }

  // -------------------------------------------------------- result dedupe

  /**
   * Whether this exact result was already delivered.
   *
   * Delivery must be idempotent: a reconnect that replays events, or a
   * `/last`, must not send the same final answer twice.
   */
  markResultDelivered(sessionId, key) {
    let set = this.#deliveredResults.get(sessionId);
    if (!set) {
      set = new Set();
      this.#deliveredResults.set(sessionId, set);
    }
    if (set.has(key)) return false;
    set.add(key);
    // Bound the memory footprint per session.
    if (set.size > 200) {
      const oldest = set.values().next().value;
      set.delete(oldest);
    }
    return true;
  }

  wasResultDelivered(sessionId, key) {
    return this.#deliveredResults.get(sessionId)?.has(key) ?? false;
  }

  // ------------------------------------------------------- message dedupe

  /**
   * Remember an inbound platform message id.
   *
   * Feishu can redeliver an event when an acknowledgement is lost; without
   * this guard a redelivery would start a second execution.
   */
  rememberMessage(messageId) {
    if (typeof messageId !== 'string' || !messageId) return true;
    if (this.#recentMessages.has(messageId)) return false;
    this.#recentMessages.set(messageId, nowMs());
    if (this.#recentMessages.size > 2000) {
      const oldest = this.#recentMessages.keys().next().value;
      this.#recentMessages.delete(oldest);
    }
    return true;
  }

  /** Drop all state (plugin unload). */
  clear() {
    this.#currentTaskByUser.clear();
    this.#snapshots.clear();
    this.#stagedImages.clear();
    this.#pendingInteractions.clear();
    this.#rounds.clear();
    this.#deliveredResults.clear();
    this.#recentMessages.clear();
  }
}

function entryUserMismatch(record, userId) {
  if (!record.userId) return false;
  if (!userId) return false;
  return record.userId !== userId;
}

function entrySessionMismatch(record, sessionId) {
  if (!record.sessionId) return false;
  if (!sessionId) return false;
  return record.sessionId !== sessionId;
}

export { Snapshot };