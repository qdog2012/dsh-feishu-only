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

function markdown(content, extra = {}) {
  return { tag: 'markdown', content, ...extra };
}

function divider() {
  return { tag: 'hr' };
}

function columnSet(columns) {
  return { tag: 'column_set', columns };
}

function button({
  text,
  id,
  type = 'default',
  extra = {},
  width = 'auto',
  disabled = false,
  confirmation,
}) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    width,
    ...(disabled ? { disabled: true } : {}),
    ...(confirmation ? { confirm: confirmation } : {}),
    behaviors: [{ type: 'callback', value: { id, ...extra } }],
  };
}

function buttonRow(buttons) {
  return columnSet(buttons.map((item) => ({
    tag: 'column',
    width: 'auto',
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
    body.push({ tag: 'note', elements: [{ tag: 'plain_text', content: clampText(note, 800) }] });
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
function taskRow(index, task, { current }) {
  const markers = [];
  if (current) markers.push('**当前**');
  if (task.running) markers.push('🟢 执行中');
  const marker = markers.length > 0 ? ` · ${markers.join(' · ')}` : '';
  const title = task.title?.trim() || '未命名任务';
  return `**${index}.** ${title}${marker}\n<font color='grey'>${task.caption ?? ''}</font>`;
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
    elements.push(markdown(`**可选任务**（第 ${page}/${totalPages} 页，共 ${total} 个）`));
    for (const [offset, task] of tasks.entries()) {
      const index = (page - 1) * 10 + offset + 1;
      elements.push(markdown(taskRow(index, task, { current: task.isCurrent })));
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
      `<font color='grey'>发送 \`/task <序号>\` 选择，或直接点击下方“选择”按钮。序号仅对本次列表有效（快照 ${pageKey}）。</font>`,
    ));
    elements.push(buttonRow(tasks.slice(0, 10).map((task, offset) => button({
      text: `选择 ${(page - 1) * 10 + offset + 1}`,
      id: 'task.select',
      extra: { pageKey, index: (page - 1) * 10 + offset + 1 },
    }))));
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
function historyRound(index, round) {
  const lines = [`**第 ${index} 轮** · ${round.time}${round.status ? ` · ${round.status}` : ''}`];
  for (const turn of round.turns) {
    if (turn.role === 'user') lines.push(`🙋 **你：**${clampText(turn.text, 500)}`);
    else if (turn.role === 'assistant') lines.push(`🤖 **执行端：**${clampText(turn.text, 900)}`);
    else lines.push(`<font color='grey'>🔧 ${turn.text}</font>`);
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
  elements.push(markdown(`**任务：**${task.title?.trim() || '未命名任务'}\n<font color='grey'>第 ${page}/${totalPages} 页 · 每页 5 轮</font>`));
  elements.push(divider());
  if (rounds.length === 0) {
    elements.push(markdown('这个任务还没有可显示的历史。'));
  } else {
    for (const [offset, round] of rounds.entries()) {
      const absolute = (page - 1) * 5 + offset + 1;
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
 * The question card: one card may hold several questions.
 *
 * All questions live inside ONE `form` so every answer submits together
 * through a `form_submit` button: the platform then hands the whole
 * `form_value` map to the callback, which is the only way a card can collect
 * structured input. Options render as a dropdown or a multi-select, and every
 * question also carries a free-text input because custom text wins over a
 * selected option.
 */
export function questionCard({ task, questions, cancelId, expiresAt }) {
  const formElements = [];
  for (const [index, question] of questions.entries()) {
    const heading = question.header ? `**${question.header}**` : `**问题 ${index + 1}**`;
    formElements.push(markdown([
      heading,
      question.question,
      question.detail ? `<font color='grey'>${clampText(question.detail, 700)}</font>` : '',
      question.multiSelect ? `<font color='grey'>可多选；自定义答案优先。</font>` : '',
    ].filter(Boolean).join('\n')));
    if (Array.isArray(question.options) && question.options.length > 0) {
      formElements.push({
        tag: question.multiSelect ? 'multi_select_static' : 'select_static',
        name: `q_${question.id}`,
        placeholder: {
          tag: 'plain_text',
          content: question.multiSelect ? '可选择多个' : '请选择',
        },
        options: question.options.map((option, optionIndex) => ({
          text: { tag: 'plain_text', content: clampText(option.label, 100) },
          value: String(optionIndex),
        })),
      });
    }
    formElements.push({
      tag: 'input',
      name: `c_${question.id}`,
      placeholder: {
        tag: 'plain_text',
        content: question.options?.length ? '或填写自定义答案（填写后以文字为准）' : '填写答案',
      },
      max_length: 500,
    });
  }
  formElements.push(buttonRow([
    button({ text: '📨 提交答案', id: 'question.submit', type: 'primary' }),
  ]));

  const elements = [
    markdown([
      `**任务：**${task?.title?.trim() || '未命名任务'}`,
      `<font color='grey'>请在这张卡片上作答并点“提交答案”。在聊天里直接发数字或文字不会作答。</font>`,
    ].join('\n')),
    divider(),
    {
      tag: 'form',
      name: 'question_form',
      elements: formElements,
    },
    divider(),
    buttonRow([button({ text: '取消', id: cancelId ?? 'question.cancel' })]),
  ];
  if (expiresAt) {
    elements.push(markdown(`<font color='grey'>请在 ${formatClock(expiresAt)} 前提交。</font>`));
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
export function previewCard({ title, description, imageKey, note, downloadId, failed }) {
  const elements = [];
  if (imageKey) {
    elements.push({ tag: 'img', img_key: imageKey, alt: { tag: 'plain_text', content: title ?? '预览' } });
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