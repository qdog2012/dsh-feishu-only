/**
 * Harness session adapter.
 *
 * The bridge drives DSH through the Host services it can reach from a plugin:
 * `ctx.agents`/`ctx.agentLoop` for agent lifetime, `ctx.sessions` for the log,
 * and the session-controller-shaped operations exposed by the loaded profile.
 * All of it is optional so the plugin degrades to a clear message instead of
 * crashing on a profile that does not ship a capability.
 *
 * @module dsh-feishu-only/lib/harness
 */

import { randomUUID } from 'node:crypto';

/** A stable, resumable task id derived from a Feishu conversation. */
export function sessionIdForChat(chatId) {
  const safe = String(chatId).replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 40);
  return `feishu-${safe || randomUUID().slice(0, 8)}`;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Join the visible text of one message payload. */
export function textFromContent(content) {
  return (Array.isArray(content) ? content : [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/** Join the reasoning blocks of one message payload. */
export function reasoningFromContent(content) {
  return (Array.isArray(content) ? content : [])
    .filter((part) => part?.type === 'reasoning' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/**
 * A task as the bridge understands it: one DSH session plus the presentation
 * facts the cards need.
 */
export class HarnessTask {
  constructor({ sessionId, title, cwd }) {
    this.sessionId = sessionId;
    this.title = title ?? null;
    this.cwd = cwd ?? null;
    this.createdAt = Date.now();
    this.lastActivityAt = this.createdAt;
    this.running = false;
    this.blank = true;
  }

  get id() {
    return this.sessionId;
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  /** A short label for list rows and the current-task header. */
  get label() {
    return nonEmpty(this.title) ?? this.sessionId;
  }
}

/**
 * Adapter over the Host capabilities the bridge needs.
 *
 * Every method returns `{ ok: true, value }` or `{ ok: false, reason }` so
 * command handlers can render a precise message instead of throwing.
 */
export class HarnessAdapter {
  #ctx;
  #logger;
  #agentFactories = new Map();

  constructor({ ctx, logger = console }) {
    this.#ctx = ctx;
    this.#logger = logger;
  }

  get available() {
    return {
      agents: typeof this.#ctx.get?.('agents') !== 'undefined',
      sessions: typeof this.#ctx.get?.('sessions') !== 'undefined',
      agentLoop: typeof this.#ctx.get?.('agentLoop') !== 'undefined',
      sessionController: typeof this.#ctx.get?.('sessionController') !== 'undefined',
      approval: typeof this.#ctx.get?.('approval') !== 'undefined',
      userQuestions: typeof this.#ctx.get?.('userQuestions') !== 'undefined',
      goals: typeof this.#ctx.get?.('goals') !== 'undefined',
      permissionPresets: typeof this.#ctx.get?.('permissionPresets') !== 'undefined',
      compaction: typeof this.#ctx.get?.('compaction') !== 'undefined',
      sessionTitle: typeof this.#ctx.get?.('sessionTitle') !== 'undefined',
      sessionQuery: typeof this.#ctx.get?.('sessionQuery') !== 'undefined',
      skills: typeof this.#ctx.get?.('skills') !== 'undefined',
      sessionProjections: typeof this.#ctx.get?.('sessionProjections') !== 'undefined',
    };
  }

  /** Look up a live agent by session id. */
  agent(sessionId) {
    try {
      return this.#ctx.get?.('agents')?.get(sessionId) ?? null;
    } catch {
      return null;
    }
  }

  /** Look up the live session object. */
  session(sessionId) {
    try {
      return this.#ctx.get?.('sessions')?.get(sessionId) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve an agent for a session, resuming a cold session when the Host
   * offers a resume path.
   */
  async ensureAgent(sessionId) {
    const existing = this.agent(sessionId);
    if (existing) return { ok: true, value: existing };
    const controller = this.#ctx.get?.('sessionController');
    if (!controller?.resolveAgent) {
      return { ok: false, reason: '当前部署没有提供会话恢复能力（sessionController 不可用）。' };
    }
    try {
      const result = await controller.resolveAgent(sessionId);
      if (result?.agent) return { ok: true, value: result.agent };
      return { ok: false, reason: describeSessionError(result?.error) };
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
  }

  /**
   * Create a task (DSH session) for a conversation.
   *
   * @param {{ chatId: string, cwd?: string, agentPreset?: string }} request
   */
  async createTask({ chatId, cwd, agentPreset }) {
    const controller = this.#ctx.get?.('sessionController');
    if (!controller?.create) {
      return { ok: false, reason: '当前部署没有提供新建会话能力。' };
    }
    try {
      const value = await controller.create({
        sessionId: sessionIdForChat(chatId),
        ...(cwd ? { cwd } : {}),
        ...(agentPreset ? { agentPreset } : {}),
      });
      return { ok: true, value: value?.sessionId ?? sessionIdForChat(chatId) };
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
  }

  /**
   * List visible tasks without resuming their agents.
   *
   * @param {AbortSignal} [signal]
   */
  async listTasks(signal) {
    const controller = this.#ctx.get?.('sessionController');
    const sessions = this.#ctx.get?.('sessions');
    const rows = [];
    if (controller?.list) {
      try {
        const value = await controller.list({}, signal ?? new AbortController().signal);
        for (const item of value?.items ?? []) {
          if (!item?.sessionId) continue;
          rows.push({
            sessionId: item.sessionId,
            running: item.running === true,
            blank: item.blank === true,
            cwd: item.cwd ?? null,
            title: item.projections?.values?.title ?? null,
            updatedAt: item.updatedAt ?? 0,
            parentSessionId: item.parentSessionId ?? null,
            origin: item.origin ?? null,
          });
        }
        return { ok: true, value: rows };
      } catch (error) {
        return { ok: false, reason: error?.message ?? String(error) };
      }
    }
    if (sessions?.list) {
      try {
        for (const session of sessions.list()) {
          rows.push({
            sessionId: session.id,
            running: this.agent(session.id)?.status === 'running',
            blank: false,
            cwd: session.header?.cwd ?? null,
            title: this.#ctx.get?.('sessionTitle')?.get(session)?.title ?? null,
            updatedAt: session.header?.createdAt ?? 0,
            parentSessionId: session.header?.parentSession ?? null,
            origin: session.header?.origin ?? null,
          });
        }
        return { ok: true, value: rows };
      } catch (error) {
        return { ok: false, reason: error?.message ?? String(error) };
      }
    }
    return { ok: false, reason: '当前部署没有提供任务列表能力。' };
  }

  /** Search tasks by free text. */
  async searchTasks(keyword, signal) {
    const query = this.#ctx.get?.('sessionQuery');
    if (!query?.searchSessions) {
      // Fall back to filtering the visible list by title, so `/task search`
      // still works on deployments without a full-text backend.
      const listed = await this.listTasks(signal);
      if (!listed.ok) return listed;
      const needle = keyword.toLowerCase();
      const hits = listed.value
        .filter((row) => (row.title ?? '').toLowerCase().includes(needle))
        .map((row) => ({ sessionId: row.sessionId, title: row.title, snippet: row.title ?? '' }));
      return { ok: true, value: hits };
    }
    try {
      const page = await query.searchSessions({ query: keyword, limit: 50 }, { signal });
      const hits = (page?.items ?? []).map((item) => ({
        sessionId: item.sessionId ?? item.record?.sessionId ?? item.header?.id,
        title: item.projections?.values?.title ?? item.title ?? null,
        snippet: item.bestMatch?.snippet ?? item.snippet ?? '',
      })).filter((hit) => hit.sessionId);
      return { ok: true, value: hits };
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
  }

  /** Read the goal of a task. */
  goalOf(sessionId) {
    const goals = this.#ctx.get?.('goals');
    const agent = this.agent(sessionId);
    if (!goals || !agent) return null;
    try {
      return goals.get(agent) ?? null;
    } catch {
      return null;
    }
  }

  /** Read the permission preset currently in force for a task. */
  permissionOf(sessionId) {
    const presets = this.#ctx.get?.('permissionPresets');
    const session = this.session(sessionId);
    if (!presets || !session) return null;
    try {
      return presets.current(session);
    } catch {
      return null;
    }
  }

  /** Read the model selection recorded for a task. */
  modelOf(sessionId) {
    const sessions = this.#ctx.get?.('sessions');
    const session = sessions?.get?.(sessionId);
    if (!session) return null;
    try {
      const header = session.requestHeader?.();
      if (header?.config?.provider && header?.config?.model) {
        return {
          provider: header.config.provider,
          model: header.config.model,
          reasoningEffort: header.config.reasoningEffort ?? null,
        };
      }
    } catch {
      // A session with no request yet simply has no recorded selection.
    }
    return null;
  }

  /**
   * The model catalog offered to `/model`, filtered to routable models.
   */
  /**
   * List a directory for the picker.
   *
   * Two services can do this and they are not interchangeable:
   *
   * - `directoryPickerController` is the wire surface built for a *Remote*
   *   caller's in-app browser. It is what a plugin like this one should use.
   * - `directoryPicker` is the abstract local-UI seam, and it only exists when
   *   a concrete picker plugin is loaded. Its `native` variant opens a window on
   *   the Host desktop, which a Feishu user cannot see.
   *
   * The controller is tried first, then a browse-capable picker, then a plain
   * filesystem listing: a chat must still be able to pick a directory on a
   * deployment that ships neither picker.
   *
   * @param {string} [path] defaults to the user's home.
   */
  async browseDirectory(path) {
    const controller = this.#ctx.get?.('directoryPickerController');
    if (typeof controller?.list === 'function') {
      try {
        const listing = await controller.list(path, new AbortController().signal);
        if (listing?.entries) return { ok: true, value: listing };
      } catch {
        // The controller exists but this composition refuses the browse verb
        // ("a verb the composition cannot serve is refused rather than
        // approximated"). That is not a dead end: fall through to the next
        // source instead of reporting a failure the user cannot act on.
      }
    }

    const picker = this.#ctx.get?.('directoryPicker');
    const capability = picker?.capability?.();
    if (capability?.kind === 'browse' && typeof capability.list === 'function') {
      try {
        const listing = await capability.list(path);
        if (listing?.entries) return { ok: true, value: listing };
      } catch {
        // Same reasoning: try the filesystem rather than give up.
      }
    }

    return this.#browseByFilesystem(path);
  }

  /**
   * Last-resort directory listing.
   *
   * The controller and the picker are both optional services; the filesystem is
   * not. Without this, a deployment shipping neither would leave the user with
   * no way to name a directory at all, which is a worse outcome than a listing
   * that skips hidden-file filtering subtleties.
   */
  async #browseByFilesystem(path) {
    try {
      const { readdir, stat } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const { join, resolve, dirname, parse, sep } = await import('node:path');
      const home = homedir();
      const target = resolve(String(path || home));
      const info = await stat(target);
      if (!info.isDirectory()) {
        return { ok: false, reason: `不是目录：${target}` };
      }
      const dirents = await readdir(target, { withFileTypes: true });
      const entries = dirents
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          path: join(target, entry.name),
          hidden: entry.name.startsWith('.'),
        }))
        // Hidden directories are noise in a chat list; keep the plain ones first.
        .sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name));
      const crumbs = [];
      let cursor = target;
      const root = parse(target).root;
      while (cursor !== root && crumbs.length < 16) {
        crumbs.unshift({ name: cursor.split(sep).filter(Boolean).at(-1) ?? cursor, path: cursor });
        cursor = dirname(cursor);
      }
      crumbs.unshift({ name: root, path: root });
      return {
        ok: true,
        value: { path: target, home, crumbs, entries, truncated: false },
        source: 'filesystem',
      };
    } catch (error) {
      return {
        ok: false,
        reason: `无法读取目录 ${path ?? ''}：${error?.message ?? error}`,
      };
    }
  }

  /**
   * Register a project for an existing directory.
   *
   * The registry canonicalizes through `realpath` and rejects a relative,
   * missing or non-directory path, so the error is surfaced rather than
   * pre-validated here.
   *
   * @param {string} path
   * @param {string} [title]
   */
  async createProject(path, title) {
    const registry = this.#ctx.get?.('workspaceRegistry');
    if (!registry?.create) {
      return { ok: false, reason: '当前部署没有提供项目登记能力。' };
    }
    try {
      const workspace = await registry.create(path, title);
      return { ok: true, value: { id: workspace.id, path: workspace.path, title: workspace.title } };
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
  }

  async modelCatalog() {
    const controller = this.#ctx.get?.('sessionController');
    if (!controller?.modelCatalog) {
      return { ok: false, reason: '当前部署没有提供模型目录。' };
    }
    try {
      const catalog = await controller.modelCatalog();
      return { ok: true, value: catalog };
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
  }

  /** Change the model of one task. Takes effect from the next round. */
  async selectModel(sessionId, selection) {
    const controller = this.#ctx.get?.('sessionController');
    if (!controller?.selectModel) {
      return { ok: false, reason: '当前部署没有提供模型切换能力。' };
    }
    try {
      const value = await controller.selectModel({ sessionId, ...selection });
      return { ok: true, value: value?.selected ?? selection };
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
  }

  /** Rename a task. */
  async renameTask(sessionId, title) {
    const controller = this.#ctx.get?.('sessionController');
    const titleService = this.#ctx.get?.('sessionTitle');
    const session = this.session(sessionId);
    try {
      if (titleService && session) return { ok: true, value: titleService.rename(session, title) };
      if (controller?.rename) return { ok: true, value: await controller.rename({ sessionId, title }) };
      return { ok: false, reason: '当前部署没有提供重命名能力。' };
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
  }

  /** Read the runtime state of one task. */
  async taskState(sessionId) {
    const controller = this.#ctx.get?.('sessionController');
    const agent = this.agent(sessionId);
    if (controller?.state) {
      try {
        return { ok: true, value: await controller.state({ sessionId }, new AbortController().signal) };
      } catch {
        // Fall through to the agent's own status.
      }
    }
    return {
      ok: true,
      value: {
        active: Boolean(agent),
        running: agent?.status === 'running',
        queue: null,
        pendingInput: [],
      },
    };
  }

  /** Cancel the running turn of one task without dropping its queue. */
  async cancelTurn(sessionId) {
    const controller = this.#ctx.get?.('sessionController');
    if (controller?.cancel) {
      try {
        controller.cancel({ sessionId });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error?.message ?? String(error) };
      }
    }
    const agent = this.agent(sessionId);
    if (agent?.cancel) {
      try {
        agent.cancel({ kind: 'user' });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error?.message ?? String(error) };
      }
    }
    return { ok: false, reason: '当前部署没有提供取消执行的能力。' };
  }

  /**
   * Submit one user prompt to a task.
   *
   * `mode: 'queue'` accepts the message while a turn is running; `steer`
   * attempts to add it to the live turn. The caller decides which to use.
   */
  async prompt(sessionId, content, { mode = 'queue', requestId } = {}) {
    const controller = this.#ctx.get?.('sessionController');
    if (!controller?.prompt) {
      const agent = this.agent(sessionId);
      if (!agent?.inject) return { ok: false, reason: '当前部署没有提供提交需求的能力。' };
      try {
        agent.inject({
          id: randomUUID(),
          role: 'user',
          source: { kind: 'user' },
          content,
        });
        return { ok: true, value: { accepted: true } };
      } catch (error) {
        return { ok: false, reason: error?.message ?? String(error) };
      }
    }
    try {
      const value = await controller.prompt({
        requestId: requestId ?? randomUUID(),
        sessionId,
        mode,
        content,
        clientTimeZone: safeTimeZone(),
      }, new AbortController().signal);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
  }

  /**
   * Compact the context of one task.
   *
   * A long compaction can outlive the caller's wait; the caller renders the
   * "result pending confirmation" state instead of treating a timeout as a
   * failure.
   */
  async compact(sessionId, signal) {
    const compaction = this.#ctx.get?.('compaction');
    const session = this.session(sessionId);
    const agent = this.agent(sessionId);
    if (!compaction || !session || !agent) {
      return { ok: false, reason: '当前部署没有提供上下文压缩能力。' };
    }
    try {
      const result = await compaction.compactNow(
        {
          session,
          options: {},
          runMaintenance: (task) => task(signal ?? new AbortController().signal),
        },
        signal ?? new AbortController().signal,
      );
      return { ok: true, value: result };
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
  }

  /** Read the current goal phase for the goal service of a task. */
  goalService() {
    return this.#ctx.get?.('goals') ?? null;
  }

  /** Create a goal and start it. */
  async createGoal(sessionId, objective) {
    const goals = this.goalService();
    const agent = this.agent(sessionId);
    if (!goals || !agent) return { ok: false, reason: '当前部署没有提供目标能力。' };
    try {
      return { ok: true, value: goals.create(agent, { objective }) };
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
  }

  /** Pause, resume, complete or clear the goal of a task. */
  async updateGoal(sessionId, action) {
    const goals = this.goalService();
    const agent = this.agent(sessionId);
    if (!goals || !agent) return { ok: false, reason: '当前部署没有提供目标能力。' };
    try {
      const current = goals.get(agent);
      if (!current) return { ok: false, reason: '当前任务没有目标。' };
      const ref = { id: current.id, revision: current.revision };
      switch (action) {
        case 'pause':
          return { ok: true, value: goals.pause(agent, ref) };
        case 'resume':
          return { ok: true, value: goals.resume(agent, ref) };
        case 'clear':
          return { ok: true, value: goals.clear(agent, ref) };
        default:
          return { ok: false, reason: `未知目标操作：${action}` };
      }
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
  }

  /**
   * Read the last displayable reply of a task.
   *
   * Read-only by contract: this never starts a turn and never writes history.
   * Preference order is: the last final answer of a completed round, then the
   * last complete outbound message of that round with a note that no final
   * answer exists, then nothing.
   */
  async lastReply(sessionId) {
    const sessions = this.#ctx.get?.('sessions');
    const session = sessions?.get?.(sessionId);
    if (!session) return { ok: true, value: null, note: '任务不在运行中，且无法读取其历史。' };
    try {
      const events = session.snapshotEvents?.() ?? [];
      return { ok: true, value: extractLastReply(events) };
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
  }

  /**
   * Read history grouped by execution round.
   */
  history(sessionId, { limit = 200 } = {}) {
    const sessions = this.#ctx.get?.('sessions');
    const session = sessions?.get?.(sessionId);
    if (!session) return { ok: true, value: [] };
    try {
      const events = (session.snapshotEvents?.() ?? []).slice(-limit);
      return { ok: true, value: groupRounds(events) };
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
  }

  /** Create a branch of a task at one round boundary. */
  async forkTask(sessionId, boundarySeq) {
    const controller = this.#ctx.get?.('sessionController');
    if (!controller?.fork) return { ok: false, reason: '当前部署没有提供分支能力。' };
    try {
      const value = await controller.fork({
        sessionId,
        ...(Number.isSafeInteger(boundarySeq) ? { atSeq: boundarySeq } : {}),
      });
      return { ok: true, value: value?.sessionId };
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
  }

  /** List skills the agent can load. */
  async listSkills(scope) {
    const skills = this.#ctx.get?.('skills');
    if (!skills?.list) return { ok: true, value: [] };
    try {
      return { ok: true, value: await skills.list({ scope }) };
    } catch {
      return { ok: true, value: [] };
    }
  }
}

function safeTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function describeSessionError(error) {
  const code = error?.code ?? 'unknown';
  switch (code) {
    case 'session/not-found':
      return '任务不存在或已被删除。';
    case 'session/agent-busy':
      return '任务正在被另一个入口使用。';
    case 'session/writer-held':
      return '任务被另一个进程持有。';
    default:
      return error?.message ?? '无法恢复任务。';
  }
}

/**
 * Extract the newest displayable reply from a session event log.
 *
 * Finality is decided by the turn, not by arrival order: a message is a final
 * answer only when the turn that produced it has actually ended. A message
 * inside an open turn is a streaming artifact, so the helper falls back to the
 * newest *closed* round before reporting an unfinished one.
 *
 * @param {readonly any[]} events
 * @returns {{ seq: number, text: string, hasFinal: boolean, turn: number|null } | null}
 */
export function extractLastReply(events) {
  const ordered = [...events].sort((left, right) => (left?.seq ?? 0) - (right?.seq ?? 0));
  const rounds = [];
  let open = null;

  for (const event of ordered) {
    switch (event?.type) {
      case 'turn/start': {
        open = { turn: event.data?.turn ?? null, messages: [] };
        break;
      }
      case 'assistant/message': {
        const text = textFromContent(event.data?.message?.content);
        if (!text) break;
        const record = { seq: event.seq ?? 0, text, turn: event.data?.turn ?? open?.turn ?? null };
        if (open) open.messages.push(record);
        // A message with no open turn still counts as a complete statement.
        else rounds.push({ closed: true, record });
        break;
      }
      case 'turn/end': {
        if (!open) break;
        const last = open.messages.at(-1);
        if (last) rounds.push({ closed: true, record: last });
        open = null;
        break;
      }
      default:
        break;
    }
  }

  const finished = rounds.filter((round) => round.closed).at(-1);
  if (finished) return { ...finished.record, hasFinal: true };
  const unfinished = open?.messages.at(-1);
  if (unfinished) return { ...unfinished, hasFinal: false };
  return null;
}

/**
 * Group a session log into execution rounds.
 *
 * The reference organizes history by what the user did, not by raw events:
 * each round contains the user's request and the outbound messages it caused.
 */
export function groupRounds(events) {
  const ordered = [...events].sort((left, right) => (left?.seq ?? 0) - (right?.seq ?? 0));
  const rounds = [];
  let current = null;

  for (const event of ordered) {
    if (event?.type === 'turn/start') {
      const turn = event.data?.turn ?? rounds.length + 1;
      current = {
        turn,
        startSeq: event.seq,
        endSeq: event.seq,
        time: event.time ?? Date.now(),
        status: '执行中',
        turns: [],
      };
      rounds.push(current);
      continue;
    }
    if (!current) {
      current = {
        turn: null,
        startSeq: event?.seq ?? 0,
        endSeq: event?.seq ?? 0,
        time: event?.time ?? Date.now(),
        status: '未开始',
        turns: [],
      };
      rounds.push(current);
    }
    current.endSeq = event?.seq ?? current.endSeq;
    current.time = event?.time ?? current.time;

    if (event?.type === 'user/message') {
      const text = textFromContent(event.data?.message?.content);
      if (text) current.turns.push({ role: 'user', text });
      continue;
    }
    if (event?.type === 'assistant/message') {
      const text = textFromContent(event.data?.message?.content);
      if (text) {
        // A round may emit one assistant message per step; only the last one is
        // the answer. Replacing rather than appending keeps the archive to what
        // was actually said to the user.
        const previous = current.turns.findLastIndex((turn) => turn.role === 'assistant');
        if (previous >= 0) current.turns.splice(previous, 1);
        current.turns.push({ role: 'assistant', text });
      }
      continue;
    }
    if (event?.type === 'tool/call') {
      // Tool calls are recorded as nothing: `/history` shows the request and the
      // final reply, and a round's process lives in the progress card while it
      // runs, not in the archive. Keeping them here only grew the payload.
      continue;
    }
    if (event?.type === 'turn/end') {
      const kind = event.data?.reason?.kind;
      current.status = kind === 'completed' ? '已完成'
        : kind === 'aborted' ? '已中止'
          : kind === 'error' ? '执行失败'
            : kind === 'blocked' ? '被阻止'
              : kind === 'max-tokens' ? '达到输出上限'
                : kind ?? '已结束';
      current.endSeq = event.seq ?? current.endSeq;
    }
  }
  return rounds.filter((round) => round.turns.length > 0);
}