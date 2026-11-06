/**
 * The Feishu `/` command menu.
 *
 * A chat's `/` panel lists the slash commands an app registered, so it is the
 * only discoverable entry point for this bridge's commands. Typing a command
 * manually still works, but a user who never reads the docs finds the surface
 * only here.
 *
 * Two facts shape this module:
 *
 *  - Feishu only accepts a plain command token (no parameter placeholders), so
 *    the menu lists the command names and their usage lives in the description.
 *  - The panel is ordered by creation time, so a deliberate order requires
 *    creating one command per second. Registering in parallel silently degrades
 *    to the platform's tie-break.
 *
 * A different plugin may have registered its own commands on the same app. Those
 * are left alone unless they are explicitly claimed as stale, because deleting
 * another integration's menu entries is not this bridge's decision.
 *
 * @module dsh-feishu-only/lib/menu
 */

/** Feishu's own icon for an agent app; also the default for these commands. */
const DEFAULT_ICON = 'ai-agent_outlined';
/** Feishu orders the panel by creation second, so go slower than that. */
const CREATE_INTERVAL_MS = 1_100;

/**
 * The menu this bridge publishes, in the order users should meet it.
 *
 * `usage` becomes the description, because the panel shows a one-line hint and
 * cannot take parameters in the name.
 */
export const MENU = Object.freeze([
  { command: 'help', usage: '查看全部指令与入口' },
  { command: 'status', usage: '机器人、消息连接、执行端状态' },
  { command: 'task', usage: '浏览与切换任务；/task create <标题> 新建' },
  { command: 'current', usage: '查看当前任务的全部设置' },
  { command: 'project', usage: '项目列表，按项目新建任务' },
  { command: 'history', usage: '按轮次查看历史' },
  { command: 'last', usage: '只读获取最新回复' },
  { command: 'model', usage: '切换模型，从下一轮生效' },
  { command: 'reasoning', usage: '切换推理强度' },
  { command: 'permission', usage: '切换权限模式' },
  { command: 'mode', usage: '切换工作模式（普通/计划）' },
  { command: 'compact', usage: '压缩上下文' },
  { command: 'goal', usage: '设置或清除目标；/goal set <目标>' },
  { command: 'stop', usage: '结束当前任务的本轮执行' },
  { command: 'plugin', usage: '查看已启用插件与可调用技能' },
  { command: 'restart', usage: '说明重启执行端的影响范围' },
  { command: 'update', usage: '查看插件版本与更新方式' },
]);

/**
 * Menu entries another integration left behind.
 *
 * These are the names `@xmanrui/dsh-im` registers. Serving them from this
 * bridge is misleading — pressing one asks for a command that does not exist —
 * so they are replaced by this bridge's own set.
 *
 * This list documents the known set; the reconcile below also retires any
 * registered command that is not in {@link MENU}, so entries added by a future
 * version of another plugin are cleaned up without a code change.
 */
export const STALE_COMMANDS = Object.freeze([
  'cancel', 'version', 'repair', 'batch', 'steer', 'send',
  'permissionlist', 'preset', 'presetlist', 'reasoninglist', 'models',
  'session', 'conv', 'workspace', 'unwatch', 'watch', 'watchlist',
  'archived', 'ws', 'sessionlist', 'clear', 'menu', 'new',
]);

/**
 * Reconcile the app's menu with {@link MENU}.
 *
 * Idempotent: existing entries with the right description are left untouched,
 * so a restart does not churn the panel.
 *
 * @param {import('./feishu/api.js').FeishuApi} api
 * @param {{ logger?: Console, intervalMs?: number, icon?: string, dryRun?: boolean, adoptStale?: boolean }} [options]
 * @returns {Promise<{ created: string[], kept: string[], removed: string[], failed: Array<{command: string, error: string}>, skipped: string[] }>}
 */
export async function syncSlashMenu(api, options = {}) {
  const {
    logger = console,
    intervalMs = CREATE_INTERVAL_MS,
    icon = DEFAULT_ICON,
    dryRun = false,
    adoptStale = true,
  } = options;

  const report = { created: [], kept: [], replaced: [], removed: [], failed: [], skipped: [] };
  let existing;
  try {
    existing = await api.listSlashCommands();
  } catch (error) {
    const message = describeMenuError(error);
    return { ...report, failed: [{ command: '*', error: message }] };
  }

  const byCommand = new Map(existing.map((item) => [item.command, item]));

  // Retire entries this bridge cannot serve. Both the documented leftovers and
// anything else registered under a name we do not own are removed: a command in
// the panel that the parser rejects is a dead button for the user.
  if (adoptStale) {
    const wanted = new Set(MENU.map((item) => item.command));
    for (const entry of [...byCommand.values()]) {
      if (wanted.has(entry.command)) continue;
      if (dryRun) {
        report.removed.push(entry.command);
        continue;
      }
      try {
        await api.deleteSlashCommand(entry.commandId);
        report.removed.push(entry.command);
        byCommand.delete(entry.command);
      } catch (error) {
        report.failed.push({ command: entry.command, error: describeMenuError(error) });
      }
    }
  }

  // Create in reverse so the panel reads in `MENU` order (newest first).
  const wanted = new Map(MENU.map((item) => [item.command, item.usage]));
  for (const item of [...MENU].reverse()) {
    const current = byCommand.get(item.command);

    // A same-named command registered by another integration stays registered
    // but describes *its* behaviour. The API has no update, so a wrong hint is
    // replaced: leaving it would tell the user this command does something it
    // does not.
    if (current && !sameDescription(current.description, item.usage)) {
      if (dryRun) {
        report.replaced.push(item.command);
        continue;
      }
      try {
        await api.deleteSlashCommand(current.commandId);
        byCommand.delete(item.command);
        report.replaced.push(item.command);
      } catch (error) {
        report.failed.push({ command: item.command, error: describeMenuError(error) });
        continue;
      }
    } else if (current) {
      report.kept.push(item.command);
      continue;
    }

    if (dryRun) {
      report.created.push(item.command);
      continue;
    }
    try {
      await api.createSlashCommand({ command: item.command, description: item.usage, icon });
      report.created.push(item.command);
      // Respect the platform's one-second ordering resolution.
      if (intervalMs > 0) await sleep(intervalMs);
    } catch (error) {
      const message = describeMenuError(error);
      // "already exists" is success for a reconcile, not a failure.
      if (/already exist|duplicate/i.test(message)) {
        report.skipped.push(item.command);
        continue;
      }
      report.failed.push({ command: item.command, error: message });
    }
  }

  logger.info?.(
    `[feishu] slash menu: ${report.created.length} created, ${report.replaced.length} replaced, `
    + `${report.kept.length} kept, ${report.removed.length} removed, ${report.failed.length} failed`,
  );
  return report;
}

/**
 * Whether a registered hint already says what this bridge wants.
 *
 * Compared loosely: a same idea with different punctuation is not worth a
 * delete-and-recreate, which costs the entry its position in the panel.
 */
function sameDescription(left, right) {
  const normalize = (value) => String(value ?? '').replace(/\s+/gu, '').trim();
  return normalize(left) === normalize(right);
}

/** Turn a platform refusal into an instruction rather than a bare code. */
export function describeMenuError(error) {
  const message = String(error?.message ?? error);
  if (error?.code === 99991672 || error?.code === 99991640
    || /app_slash_command|Access denied|permission/i.test(message)) {
    return '缺少「应用指令」权限：请在飞书开放平台为该应用添加 '
      + 'application:app_slash_command:read 与 application:app_slash_command:write，并发布版本。';
  }
  return message;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}