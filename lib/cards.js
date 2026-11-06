/**
 * Feishu card builders.
 *
 * Feishu renders "schema 2.0" cards: a card is a JSON document with
 * `schema: '2.0'`, a `body.elements` list, and optional `header`. Buttons carry
 * a `value` object, which is what `card.action.trigger` hands back to the bot,
 * so every interactive control here is identified by a stable `value.id`.
 *
 * The builders below produce the card inventory from the interaction reference:
 * help, project, task list, current task, settings, history, goal, pending-image,
 * progress, approval, question, result, preview and update cards.
 *
 * @module dsh-feishu-only/lib/cards
 */

/** Card schema version understood by the current clients. */
const CARD_SCHEMA = '2.0';

const MAX_MARKDOWN_CHARS = 4000;
const MAX_ELEMENTS = 45;

/**
 * Rounds per history page.
 *
 * Must equal `PAGE_SIZE.history` in `state.js`: the bridge slices the rounds and
 * this card numbers them, so a divergence would misnumber every page after the
 * first. It is not imported because `cards.js` is deliberately dependency-free;
 * a test asserts the two agree.
 */
const HISTORY_PAGE_SIZE = 10;

/** Collapse a card-text payload to what Feishu will render reliably. */
export function clampText(text, limit = MAX_MARKDOWN_CHARS) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 20)}\n\n…（内容过长，已截断）`;
}

const TONE = {
  neutral: 'grey',
  info: 'blue',
  success: 'green',
  warning: 'orange',
  error: 'red',
};

/**
 * A rich-text block.
 *
 * Feishu schema 2.0 has no `markdown` element: rich text is a `div` whose
 * `text` is a `lark_md` object. Emitting `{ tag: 'markdown' }` made the whole
 * card invalid, so the platform rejected the message and the bot looked dead.
 */
function markdown(content, extra = {}) {
  return { tag: 'div', text: { tag: 'lark_md', content }, ...extra };
}

function divider() {
  return { tag: 'hr' };
}

/**
 * A row of columns.
 *
 * Schema 2.0 requires every column to declare `width: 'weighted'` with a
 * numeric `weight`; the `auto` width of schema 1.0 is rejected with
 * `invalid width` and the whole card fails.
 */
function columnSet(columns) {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: 'default',
    columns: columns.map((column) => ({
      weight: 1,
      ...column,
      width: 'weighted',
    })),
  };
}

function button({
  text,
  id,
  type = 'default',
  extra = {},
  disabled = false,
  confirmation,
}) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    // A button inside a column fills it; `width` is a button-level field and
    // `auto` would again be a schema 1.0 value.
    width: 'fill',
    ...(disabled ? { disabled: true } : {}),
    // A confirmation dialog takes plain_text objects, not bare strings: the
    // platform rejects the whole card when either is a string.
    ...(confirmation
      ? {
          confirm: {
            title: { tag: 'plain_text', content: confirmation.title },
            text: { tag: 'plain_text', content: confirmation.text },
          },
        }
      : {}),
    behaviors: [{ type: 'callback', value: { id, ...extra } }],
  };
}

function buttonRow(buttons) {
  return columnSet(buttons.map((item) => ({
    tag: 'column',
    elements: [item],
  })));
}

/**
 * Build a card from a normalized shape.
 *
 * @param {{
 *   title?: string,
 *   subtitle?: string,
 *   template?: keyof typeof TONE | 'blue' | 'wathet' | 'turquoise' | 'green' | 'yellow' | 'orange' | 'red' | 'carmine' | 'violet' | 'purple' | 'indigo' | 'grey' | 'default',
 *   elements?: object[],
 *   note?: string,
 * }} spec
 */
export function card({ title, subtitle, template = 'blue', elements = [], note }) {
  const body = [...elements];
  if (note) {
    // Schema 2.0 renders a footnote as a `div` carrying plain text; the
    // `note` element of schema 1.0 is not part of this schema.
    body.push({ tag: 'div', text: { tag: 'plain_text', content: clampText(note, 800) } });
  }
  const safe = body.slice(0, MAX_ELEMENTS);
  return {
    schema: CARD_SCHEMA,
    config: { update_multi: true, wide_screen_mode: true },
    ...(title
      ? {
          header: {
            title: { tag: 'plain_text', content: clampText(title, 200) },
            template,
            ...(subtitle ? { subtitle: { tag: 'plain_text', content: clampText(subtitle, 200) } } : {}),
          },
        }
      : {}),
    body: { elements: safe },
  };
}

// ------------------------------------------------------------------ help card

/** The `/help` card: a short feature map plus one-click entry buttons. */
export function helpCard({ version, botName }) {
  return card({
    title: '🤖 飞书 × DeepSeek Harness',
    subtitle: botName ? `当前机器人：${botName}` : undefined,
    template: 'blue',
    elements: [
      markdown(
        [
          '**先选任务，再发需求。** 普通消息是任务输入，斜杠指令是控制操作。',
          '',
          '**任务**',
          '`/task` 浏览与切换任务 · `/task create <标题>` 新建 · `/task current` 核对当前 · `/task search <关键词>` 搜索',
          '`/history` 按轮次查看历史 · `/last` 只读获取最新回复',
          '',
          '**设置**（从下一轮开始生效）',
          '`/model` 模型 · `/reasoning` 推理强度 · `/permission` 权限模式 · `/mode` 工作模式 · `/compact` 压缩上下文',
          '',
          '**运行控制**',
          '`/goal` 目标 · `/stop` 结束当前轮次 · `/status` 连接与运行状态 · `/plugin` 扩展能力 · `/update` 检查更新',
          '',
          '**输入**',
          '文字直接发送；只发图片时会先暂存，等你补充说明；文件会保存到任务工作区后再提交。',
        ].join('\n'),
      ),
      divider(),
      buttonRow([
        button({ text: '📋 任务列表', id: 'task.list', type: 'primary' }),
        button({ text: '📚 历史', id: 'history.show' }),
        button({ text: '⚙️ 设置', id: 'settings.show' }),
      ]),
    ],
    note: version ? `版本 ${version}` : undefined,
  });
}

// ----------------------------------------------------------------- task cards

/** Format one task row for a numbered list. */
/**
 * A task list row as a button label.
 *
 * The card used to print every task as text and repeat them as
 * "选择 1 / 选择 2" buttons, so the same list appeared twice and the button did
 * not say what it would select. The label now carries the task itself.
 *
 * The sequence number stays in the label because `/task <序号>` accepts it, and
 * the marker is the only cue for the current or running task inside a button,
 * where no second line of grey text is available.
 */
function taskButtonLabel(index, task) {
  const markers = [];
  if (task.isCurrent) markers.push('当前');
  if (task.running) markers.push('执行中');
  const raw = task.title?.trim() || '未命名任务';
  // A button label has no second line, so `clampText`'s multi-line truncation
  // notice would be rendered as part of the label. Cut it inline instead.
  const title = raw.length <= 60 ? raw : `${raw.slice(0, 59)}…`;
  const marker = markers.length > 0 ? ` [${markers.join('·')}]` : '';
  return `${index}. ${title}${marker}`;
}

/**
 * The `/task` card: current-task summary plus one page of selectable tasks.
 *
 * Numbers are a snapshot: `pageKey` travels with the card so a stale button
 * press cannot select a task that has moved.
 */
export function taskListCard({
  currentTask,
  tasks,
  page,
  totalPages,
  total,
  pageKey,
  emptyHint,
}) {
  const elements = [];
  if (currentTask) {
    const lines = [
      `**当前任务：**${currentTask.title?.trim() || '未命名任务'}`,
      currentTask.project ? `<font color='grey'>项目：${currentTask.project}</font>` : '',
      `<font color='grey'>设置：${currentTask.settings}</font>`,
      `<font color='grey'>状态：${currentTask.status}</font>`,
      `<font color='grey'>目标：${currentTask.goal}</font>`,
    ].filter(Boolean);
    elements.push(markdown(lines.join('\n')));
    elements.push(divider());
  } else {
    elements.push(markdown('**当前没有选中任务。** 选择一个任务，或新建一个后再发送需求。'));
    elements.push(divider());
  }

  if (tasks.length === 0) {
    elements.push(markdown(emptyHint ?? '没有可用的任务。'));
  } else {
    elements.push(markdown(`**任务**（第 ${page}/${totalPages} 页，共 ${total} 个）`));
    // One task per row: a full-width button shows the whole title, where a
    // shared row truncated most of them.
    for (const [offset, task] of tasks.entries()) {
      const index = (page - 1) * 10 + offset + 1;
      elements.push(buttonRow([button({
        text: taskButtonLabel(index, task),
        id: 'task.select',
        extra: { pageKey, index },
        type: task.isCurrent ? 'primary' : 'default',
      })]));
    }
  }

  const nav = [];
  if (page > 1) nav.push({ text: '⬅️ 上一页', id: 'task.page', extra: { page: page - 1 } });
  nav.push({ text: '🔄 刷新', id: 'task.list' });
  if (page < totalPages) nav.push({ text: '下一页 ➡️', id: 'task.page', extra: { page: page + 1 } });
  elements.push(divider());
  elements.push(buttonRow([
    ...nav.map((item) => button(item)),
    button({ text: '➕ 新建任务', id: 'task.create', type: 'primary' }),
  ]));
  if (tasks.length > 0) {
    elements.push(markdown(
      `<font color='grey'>点击任务即可切换，也可发送 \`/task <序号>\`。序号仅对本次列表有效（快照 ${pageKey}）。</font>`,
    ));
  }
  return card({ title: '📋 任务', template: 'blue', elements });
}

/** The `/task current` card: everything that decides what will run next. */
export function currentTaskCard({ task }) {
  if (!task) {
    return card({
      title: '📋 当前任务',
      template: 'grey',
      elements: [
        markdown('还没有选中任务。\n\n发送 `/task` 选择一个，或 `/task create <标题>` 新建。'),
        buttonRow([button({ text: '📋 任务列表', id: 'task.list', type: 'primary' })]),
      ],
    });
  }
  const elements = [
    markdown([
      `**标题：**${task.title?.trim() || '未命名任务'}`,
      `**项目：**${task.project ?? '未绑定项目'}`,
      `**任务 ID：**\`${task.id}\``,
      '',
      `**模型：**${task.model}`,
      `**推理强度：**${task.reasoning}`,
      `**权限模式：**${task.permission}`,
      `**工作模式：**${task.mode}`,
      '',
      `**运行状态：**${task.status}`,
      `**目标：**${task.goal}`,
      `**上下文：**${task.context}`,
    ].join('\n')),
    divider(),
    buttonRow([
      button({ text: '📚 历史', id: 'history.show' }),
      button({ text: '🔄 刷新', id: 'task.current' }),
      button({ text: '🧹 压缩上下文', id: 'task.compact' }),
    ]),
  ];
  if (task.lastResult) {
    elements.push(divider());
    elements.push(markdown(`**最近回复**\n${clampText(task.lastResult, 1200)}`));
  }
  return card({ title: '📋 当前任务', template: 'blue', elements });
}

/** The `/task search` result card. */
export function taskSearchCard({ keyword, results, page, totalPages, pageKey }) {
  const elements = [markdown(`搜索关键词：**${keyword}**`)];
  if (results.length === 0) {
    elements.push(markdown('没有匹配的任务。换个关键词，或发送 `/task` 浏览全部任务。'));
  } else {
    elements.push(markdown(`**结果**（第 ${page}/${totalPages} 页）`));
    for (const [offset, hit] of results.entries()) {
      const index = offset + 1;
      elements.push(markdown([
        `**${index}.** ${hit.title?.trim() || '未命名任务'}${hit.isCurrent ? ' · **当前**' : ''}`,
        `<font color='grey'>${hit.snippet ?? ''}</font>`,
      ].join('\n')));
    }
  }
  const nav = [];
  if (page > 1) nav.push({ text: '⬅️ 上一页', id: 'task.search', extra: { page: page - 1 } });
  if (page < totalPages) nav.push({ text: '下一页 ➡️', id: 'task.search', extra: { page: page + 1 } });
  if (nav.length > 0) elements.push(buttonRow(nav.map((item) => button(item))));
  if (results.length > 0) {
    elements.push(buttonRow(results.map((hit, offset) => button({
      text: `选择 ${offset + 1}`,
      id: 'task.select',
      extra: { pageKey, index: offset + 1 },
    }))));
  }
  return card({ title: '🔍 任务搜索', template: 'blue', elements });
}

// -------------------------------------------------------------- settings cards

/**
 * The `/model`, `/reasoning`, `/permission`, `/mode` card.
 *
 * `kind` decides which command applies a selection, so one card layout serves
 * every setting without inventing per-setting callbacks.
 */
export function settingsCard({ kind, title, current, options, note, page = 1, totalPages = 1 }) {
  const elements = [
    markdown(`**当前：**${current}`),
    divider(),
  ];
  for (const [offset, option] of options.entries()) {
    const index = (page - 1) * 10 + offset + 1;
    const selected = option.selected ? ' ✅' : '';
    elements.push(markdown([
      `**${index}.** ${option.label}${selected}`,
      option.description ? `<font color='grey'>${option.description}</font>` : '',
    ].filter(Boolean).join('\n')));
  }
  const nav = [];
  if (page > 1) nav.push({ text: '⬅️ 上一页', id: 'settings.page', extra: { kind, page: page - 1 } });
  if (page < totalPages) nav.push({ text: '下一页 ➡️', id: 'settings.page', extra: { kind, page: page + 1 } });
  if (nav.length > 0) elements.push(buttonRow(nav.map((item) => button(item))));
  elements.push(buttonRow(options.slice(0, 10).map((option, offset) => button({
    text: option.selected ? `✅ ${option.label}` : option.label,
    id: 'settings.select',
    extra: { kind, index: (page - 1) * 10 + offset + 1 },
    type: option.selected ? 'primary' : 'default',
  }))));
  elements.push(markdown(`<font color='grey'>${note}</font>`));
  return card({ title, template: 'blue', elements });
}

/** The `/plugin` card: enabled plugins and skills the agent can call. */
export function pluginCard({ plugins, skills }) {
  const elements = [];
  elements.push(markdown(`**已启用插件（${plugins.length}）**`));
  if (plugins.length === 0) elements.push(markdown('<font color=\'grey\'>没有已启用的扩展插件。</font>'));
  for (const plugin of plugins) {
    elements.push(markdown(`• **${plugin.title}**${plugin.description ? `\n<font color='grey'>${plugin.description}</font>` : ''}`));
  }
  if (skills.length > 0) {
    elements.push(divider());
    elements.push(markdown(`**可调用技能（${skills.length}）**`));
    for (const skill of skills.slice(0, 20)) {
      elements.push(markdown(`• \`${skill.name}\` — ${skill.description ?? ''}`));
    }
    elements.push(markdown(
      `<font color='grey'>技能名属于动态内容，可直接在普通任务消息里点名使用，不是机器人固定指令。</font>`,
    ));
  }
  return card({ title: '🧩 扩展能力', template: 'indigo', elements });
}

// --------------------------------------------------------------- history card

/** One execution round inside the history card. */
/**
 * Render one round as a compact entry.
 *
 * History is for reading what was said, not for auditing how it was produced,
 * so tool calls and intermediate assistant chatter are left out: only the user's
 * request and the round's final assistant reply remain.
 *
 * "Final" means the last assistant turn in the round, because a round may emit
 * several assistant messages (one per step) and only the last one is the answer.
 */
function historyRound(index, round) {
  const lines = [`**第 ${index} 轮** · ${round.time}${round.status ? ` · ${round.status}` : ''}`];
  const turns = Array.isArray(round.turns) ? round.turns : [];
  const asked = turns.filter((turn) => turn.role === 'user' && turn.text?.trim());
  const replies = turns.filter((turn) => turn.role === 'assistant' && turn.text?.trim());
  const lastReply = replies.at(-1);

  if (asked.length > 0) lines.push(`🙋 **你：**${clampText(asked.map((turn) => turn.text).join(' '), 500)}`);
  if (lastReply) {
    lines.push(`🤖 **执行端：**${clampText(lastReply.text, 900)}`);
  } else if (round.status === '执行失败' || round.status === '已中止') {
    lines.push(`<font color='grey'>本轮没有最终回复（${round.status}）。</font>`);
  } else {
    lines.push("<font color='grey'>本轮没有最终回复。</font>");
  }
  return lines.join('\n');
}

/** The `/history` card, paginated by execution round rather than raw events. */
export function historyCard({ task, rounds, page, totalPages, pageKey }) {
  const elements = [];
  if (!task) {
    return card({
      title: '📚 历史',
      template: 'grey',
      elements: [markdown('请先选择一个任务，再查看历史。'), buttonRow([
        button({ text: '📋 任务列表', id: 'task.list', type: 'primary' }),
      ])],
    });
  }
  elements.push(markdown(`**任务：**${task.title?.trim() || '未命名任务'}\n<font color='grey'>第 ${page}/${totalPages} 页 · 每页 ${HISTORY_PAGE_SIZE} 轮</font>`));
  elements.push(divider());
  if (rounds.length === 0) {
    elements.push(markdown('这个任务还没有可显示的历史。'));
  } else {
    for (const [offset, round] of rounds.entries()) {
      const absolute = (page - 1) * HISTORY_PAGE_SIZE + offset + 1;
      elements.push(markdown(historyRound(absolute, round)));
      elements.push(buttonRow([
        button({ text: `🌿 从第 ${absolute} 轮创建分支`, id: 'history.fork', extra: { pageKey, index: absolute } }),
      ]));
      if (offset < rounds.length - 1) elements.push(divider());
    }
  }
  const nav = [];
  if (page > 1) nav.push({ text: '⬅️ 更早', id: 'history.show', extra: { page: page - 1 } });
  if (page < totalPages) nav.push({ text: '较新 ➡️', id: 'history.show', extra: { page: page + 1 } });
  if (nav.length > 0) elements.push(buttonRow(nav.map((item) => button(item))));
  return card({ title: '📚 历史', template: 'blue', elements });
}

// ------------------------------------------------------------------ goal card

/** The `/goal` card: objective, phase and the actions that change it. */
export function goalCard({ task, goal }) {
  const elements = [];
  if (!task) {
    return card({
      title: '🎯 目标',
      template: 'grey',
      elements: [markdown('请先选择一个任务。'), buttonRow([
        button({ text: '📋 任务列表', id: 'task.list', type: 'primary' }),
      ])],
    });
  }
  if (!goal) {
    elements.push(markdown([
      `**任务：**${task.title?.trim() || '未命名任务'}`,
      '',
      '当前没有设置目标。',
      '',
      '用 `/goal set <目标>` 设置并开始推进。设置目标会产生一次新的任务输入。',
    ].join('\n')));
    elements.push(buttonRow([button({ text: '🔄 刷新', id: 'goal.show' })]));
    return card({ title: '🎯 目标', template: 'grey', elements });
  }
  elements.push(markdown([
    `**任务：**${task.title?.trim() || '未命名任务'}`,
    `**目标：**${clampText(goal.objective, 1500)}`,
    '',
    `**阶段：**${goal.phase}`,
    `**激活：**${goal.activation}`,
    `**轮次：**${goal.roundsStarted}/${goal.maxGoalRounds}`,
    goal.blockedReason ? `**受阻原因：**${goal.blockedReason}` : '',
  ].filter(Boolean).join('\n')));
  elements.push(divider());
  elements.push(buttonRow([
    button({ text: '🔄 刷新', id: 'goal.show' }),
    goal.phase === 'active'
      ? button({ text: '⏸️ 暂停', id: 'goal.pause' })
      : button({ text: '▶️ 继续', id: 'goal.resume' }),
    button({
      text: '🗑️ 清除目标',
      id: 'goal.clear',
      type: 'danger',
      confirmation: {
        title: '清除目标？',
        text: '清除后不再推进该目标。',
      },
    }),
  ]));
  return card({ title: '🎯 目标', template: 'violet', elements });
}

// --------------------------------------------------------- staged image card

/** The card shown while images wait for their instruction text. */
export function stagedImagesCard({ task, count, files }) {
  const elements = [
    markdown([
      `已暂存 **${count}** 张图片，等待你的说明。`,
      '',
      `**将提交到：**${task?.title?.trim() || '未命名任务'}`,
      files.length > 0 ? `**文件：**${files.join('、')}` : '',
      '',
      '发送文字即可把图片和说明一起提交。',
    ].filter(Boolean).join('\n')),
    divider(),
    buttonRow([
      button({
        text: '🗑️ 取消这批图片',
        id: 'staged.cancel',
        type: 'danger',
        confirmation: { title: '取消暂存的图片？', text: '这批图片不会被提交。' },
      }),
    ]),
  ];
  return card({ title: '🖼️ 等待图片说明', template: 'orange', elements });
}

// -------------------------------------------------------------- progress card

const PHASE_LABEL = {
  starting: '启动中',
  running: '执行中',
  waiting: '等待用户',
  retrying: '等待重试',
  done: '已完成',
  failed: '执行失败',
  stopped: '已停止',
};

/**
 * The single card that tracks one execution round.
 *
 * It answers "what is happening now"; the final answer is delivered as its own
 * message so a truncated progress area can never lose the result.
 */
export function progressCard({
  task,
  phase,
  turn,
  toolLines,
  progress,
  resources,
  detail,
  startedAt,
  now,
}) {
  const elements = [];
  const elapsed = startedAt ? formatDuration((now ?? Date.now()) - startedAt) : '';
  elements.push(markdown([
    `**任务：**${task?.title?.trim() || '未命名任务'}`,
    `**阶段：**${PHASE_LABEL[phase] ?? phase}${turn ? ` · 第 ${turn} 轮` : ''}${elapsed ? ` · ${elapsed}` : ''}`,
  ].join('\n')));

  if (progress) {
    elements.push(markdown(`**进展**\n${clampText(progress, 1200)}`));
  }
  if (toolLines.length > 0) {
    elements.push(markdown(`**工具**\n${toolLines.slice(-8).map((line) => `• ${line}`).join('\n')}`));
  }
  if (resources.length > 0) {
    elements.push(markdown(`**本轮资源**\n${resources.slice(-8).map((item) => `• ${item}`).join('\n')}`));
  }
  if (detail) {
    elements.push(markdown(`<font color='grey'>${clampText(detail, 600)}</font>`));
  }
  elements.push(divider());
  elements.push(buttonRow([
    button({ text: '⏹️ 停止', id: 'round.stop', type: 'danger' }),
    button({ text: '📚 历史', id: 'history.show' }),
  ]));
  const template = phase === 'failed' ? 'red' : phase === 'stopped' ? 'grey' : phase === 'done' ? 'green' : 'blue';
  return card({ title: '⏳ 执行进度', template, elements });
}

// -------------------------------------------------------------- approval card

/**
 * The approval card.
 *
 * An approval answers "may this run?", which is deliberately distinct from the
 * question card. Operating scope is stated explicitly, and the session-scope
 * grant is only offered when the executor actually supports it.
 */
export function approvalCard({
  task,
  toolName,
  reason,
  detail,
  scopeNote,
  allowOnceId,
  allowSessionId,
  rejectId,
  expiresAt,
}) {
  const elements = [
    markdown([
      `**任务：**${task?.title?.trim() || '未命名任务'}`,
      `**操作：**\`${toolName}\``,
      detail ? `**说明：**${detail}` : '',
      reason ? `**原因：**${clampText(reason, 700)}` : '',
    ].filter(Boolean).join('\n')),
  ];
  if (scopeNote) {
    elements.push(markdown(`<font color='grey'>范围：${scopeNote}</font>`));
  }
  if (expiresAt) {
    elements.push(markdown(`<font color='grey'>请在 ${formatClock(expiresAt)} 前决定；超时按拒绝处理。</font>`));
  }
  elements.push(divider());
  const buttons = [
    button({ text: '✅ 允许一次', id: allowOnceId, type: 'primary' }),
    button({ text: '❌ 拒绝', id: rejectId, type: 'danger' }),
  ];
  if (allowSessionId) {
    buttons.splice(1, 0, button({ text: '✅ 本任务始终允许', id: allowSessionId }));
  }
  elements.push(buttonRow(buttons));
  return card({ title: '🔐 操作审批', template: 'orange', elements });
}

// -------------------------------------------------------------- question card

/**
 * The question card.
 *
 * A `form` container looked like the natural fit, but the platform rejects a
 * submit button whose behavior type it does not recognise, and the callback
 * shape for a form submission cannot be verified from here. Options are
 * therefore rendered as ordinary callback buttons — the same mechanism every
 * other card uses — and a free-text answer is collected by the bridge asking
 * the user to reply with the text after pressing the question's text button.
 *
 * `questions` keeps its shape so the bridge's answer mapping is unchanged.
 */
export function questionCard({ task, questions, cancelId, expiresAt, pendingId }) {
  const elements = [
    markdown([
      `**任务：**${task?.title?.trim() || '未命名任务'}`,
      `<font color='grey'>点击下面的选项作答。需要自由文本时点“填写文字”，然后直接回复一条消息。</font>`,
    ].join('\n')),
    divider(),
  ];

  for (const [index, question] of questions.entries()) {
    const heading = question.header ? `**${question.header}**` : `**问题 ${index + 1}**`;
    elements.push(markdown([
      heading,
      question.question,
      question.detail ? `<font color='grey'>${clampText(question.detail, 700)}</font>` : '',
      question.multiSelect ? `<font color='grey'>可多选，逐个点击即可。</font>` : '',
    ].filter(Boolean).join('\n')));

    const options = Array.isArray(question.options) ? question.options : [];
    if (options.length > 0) {
      // One button per option, capped so a long list still renders.
      elements.push(buttonRow(options.slice(0, 5).map((option, optionIndex) => button({
        text: clampText(option.label, 40),
        id: 'question.answer',
        extra: {
          pendingId: pendingId ?? '',
          questionId: question.id,
          value: String(optionIndex),
        },
        type: 'primary',
      }))));
      if (options.length > 5) {
        elements.push(buttonRow(options.slice(5, 10).map((option, offset) => button({
          text: clampText(option.label, 40),
          id: 'question.answer',
          extra: {
            pendingId: pendingId ?? '',
            questionId: question.id,
            value: String(offset + 5),
          },
        }))));
      }
    }
    elements.push(buttonRow([button({
      text: options.length > 0 ? '✏️ 填写文字' : '✏️ 填写答案',
      id: 'question.freeText',
      extra: { pendingId: pendingId ?? '', questionId: question.id },
    })]));
    if (index < questions.length - 1) elements.push(divider());
  }

  elements.push(divider());
  elements.push(buttonRow([button({ text: '取消', id: cancelId ?? 'question.cancel' })]));
  if (expiresAt) {
    elements.push(markdown(`<font color='grey'>请在 ${formatClock(expiresAt)} 前作答。</font>`));
  }
  return card({ title: '❓ 需要你的选择', template: 'turquoise', elements });
}

// ---------------------------------------------------------------- result card

/** The final answer card, independent from the progress card. */
export function resultCard({ task, text, turn, resources = [], note }) {
  const elements = [];
  elements.push(markdown([
    `**任务：**${task?.title?.trim() || '未命名任务'}${turn ? ` · 第 ${turn} 轮` : ''}`,
    '',
    clampText(text || '（本轮没有文本回复）'),
  ].join('\n')));
  if (resources.length > 0) {
    elements.push(divider());
    elements.push(markdown(`**资源**\n${resources.map((item) => `• ${item}`).join('\n')}`));
  }
  elements.push(divider());
  elements.push(buttonRow([
    button({ text: '🔁 重新获取最新回复', id: 'result.last' }),
    button({ text: '📚 历史', id: 'history.show' }),
  ]));
  return card({
    title: '✅ 最终结果',
    template: 'green',
    elements,
    note: note ?? '结果说明与预览截图、原文件下载是三种不同的交付方式。',
  });
}

/** A short "no displayable result" notice. */
export function emptyResultCard({ task, reason }) {
  return card({
    title: '🔁 最新回复',
    template: 'grey',
    elements: [
      markdown([`**任务：**${task?.title?.trim() || '未命名任务'}`, '', reason].join('\n')),
      buttonRow([button({ text: '📚 历史', id: 'history.show' })]),
    ],
  });
}

// --------------------------------------------------------------- preview card

/**
 * A preview card: an image plus the reason it exists.
 *
 * Preview is explicitly not upload: the note says so, so a user never mistakes
 * a screenshot for the original file.
 */
export function previewCard({ title, description, imageKey, note, downloadId, failed, messageOnly }) {
  const elements = [];
  if (imageKey) {
    // Schema 2.0 `img` takes the uploaded key directly; `alt` is optional and
    // omitting it avoids depending on an alt shape that varies by client.
    elements.push({ tag: 'img', img_key: imageKey });
  }
  if (messageOnly) {
    elements.push(markdown('文件已作为独立消息发送，可在飞书中直接打开。'));
  }
  if (description) elements.push(markdown(clampText(description, 1200)));
  if (failed) elements.push(markdown(`<font color='red'>${clampText(failed, 500)}</font>`));
  if (downloadId) {
    elements.push(buttonRow([button({ text: '⬇️ 下载原文件', id: downloadId })]));
  }
  return card({
    title: title ?? '🖼️ 预览',
    template: failed ? 'orange' : 'indigo',
    elements,
    note,
  });
}

// ------------------------------------------------------------- update / status

/** `/update` card: current vs. target version and the confirmation entry. */
export function updateCard({ currentVersion, targetVersion, notes, state, confirmId }) {
  const elements = [markdown([
    `**当前版本：**${currentVersion}`,
    `**目标版本：**${targetVersion ?? '未知'}`,
    `**状态：**${state}`,
  ].join('\n'))];
  if (notes) elements.push(markdown(clampText(notes, 1500)));
  if (confirmId) {
    elements.push(buttonRow([button({ text: '确认更新', id: confirmId, type: 'primary' })]));
  }
  return card({ title: '⬆️ 服务更新', template: 'blue', elements });
}

/** `/status` card: three separate states, never collapsed into one. */
export function statusCard({ bot, ws, tasks, execution }) {
  const rows = [
    `**机器人服务：**${bot}`,
    `**消息连接：**${ws}`,
    `**执行端：**${execution}`,
    '',
    `**任务状态：**${tasks}`,
  ];
  return card({
    title: '🩺 运行状态',
    template: 'blue',
    elements: [
      markdown(rows.join('\n')),
      divider(),
      markdown(
        '<font color=\'grey\'>机器人在线不等于执行端已连接；执行端已连接也不等于某个任务正在执行。</font>',
      ),
      buttonRow([button({ text: '🔄 刷新', id: 'status.show' })]),
    ],
  });
}

// ------------------------------------------------------------------- utilities

/** `1h 02m 03s`, `2m 07s`, `9s`. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

/** `HH:MM` in the local zone. */
export function formatClock(timestamp) {
  try {
    return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(timestamp).toISOString().slice(11, 16);
  }
}

export { TONE };