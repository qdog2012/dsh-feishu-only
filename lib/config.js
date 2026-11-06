/**
 * Plugin configuration.
 *
 * The Loader validates a row's `config` against the plugin's exported `Config`.
 * This plugin ships no peer dependencies, so it declares a schema using the
 * shape Cordis already understands for plain JSON Schema style objects rather
 * than importing `@deepseek-ai/schemastery`.
 *
 * @module dsh-feishu-only/lib/config
 */

/** Version reported by `/status` and `/update`. */
export const PLUGIN_VERSION = '0.1.0';

/**
 * Field metadata, kept separate from validation so the settings surface and the
 * resolver read one source of truth.
 */
export const CONFIG_FIELDS = Object.freeze([
  {
    key: 'enabled',
    type: 'boolean',
    default: false,
    title: '启用飞书长连接',
    description: '扫码创建或连接机器人成功后会打开。关闭后不再接收消息，但已有的机器人身份和凭据会保留。',
  },
  {
    key: 'appId',
    type: 'string',
    default: '',
    title: 'App ID',
    description: '机器人应用的 App ID（以 cli_ 开头）。扫码创建后自动写入，也可以手工填写。',
    secret: false,
  },
  {
    key: 'appSecret',
    type: 'string',
    default: '',
    title: 'App Secret',
    description: '推荐用扫描或“连接已有机器人”写入凭据库；这里手填的值会保存在 profile 配置里。',
    secret: true,
  },
  {
    key: 'brand',
    type: 'string',
    enum: ['feishu', 'lark'],
    default: 'feishu',
    title: '平台',
    description: 'feishu 为飞书（中国版），lark 为 Lark（国际版）。',
  },
  {
    key: 'groupRequireMention',
    type: 'boolean',
    default: true,
    title: '群聊需要 @ 机器人',
    description: '开启后在群聊里必须明确提及机器人才处理消息，避免把日常聊天误识别为任务。',
  },
  {
    key: 'rejectInputWhileRunning',
    type: 'boolean',
    default: true,
    title: '执行中拒绝补充需求',
    description: '开启时任务执行中会拒绝新的补充需求并提示先结束；关闭则尝试作为当前轮次的补充输入提交。',
  },
  {
    key: 'defaultWorkspace',
    type: 'string',
    default: '',
    title: '默认工作目录',
    description: '新任务的默认工作目录。留空时由 Harness 的默认目录决定。',
  },
  {
    key: 'agentPreset',
    type: 'string',
    default: '',
    title: 'Agent 预设',
    description: '新任务使用的 Agent 预设。留空时使用当前 profile 的默认预设。',
  },
  {
    key: 'compactTimeoutMs',
    type: 'number',
    default: 60_000,
    title: '压缩等待时限（毫秒）',
    description: '等待上下文压缩结果的时限。超时显示“结果待确认”，不当作失败。',
  },
  {
    key: 'capacityRetryMs',
    type: 'number',
    default: 10_000,
    title: '容量重试间隔（毫秒）',
    description:
      '模型容量不足时，对飞书发起的任务固定间隔重试，不设次数上限。等待会显示在进度卡片上，可用 /stop 结束。',
  },
  {
    key: 'syncMenu',
    type: 'boolean',
    default: true,
    title: '同步飞书指令菜单',
    description:
      '连接成功后把本插件的指令注册到飞书“/”面板，并清理其它插件遗留的无效项。需要应用具备“应用指令”权限。',
  },
  {
    key: 'notifyConnection',
    type: 'boolean',
    default: true,
    title: '连接状态通知',
    description:
      '机器人连上或断开时，向最近与之对话的账号发一条通知。断开通知在恢复后才有意义：通知由连接方发送，断开瞬间没有可用通道。',
  },
  {
    key: 'previewTimeoutMs',
    type: 'number',
    default: 60_000,
    title: '预览转换时限（毫秒）',
    description: '单次预览转换的时限。',
  },
  {
    key: 'previewMaxBytes',
    type: 'number',
    default: 30 * 1024 * 1024,
    title: '预览大小上限（字节）',
    description: '允许生成预览的文件大小上限。',
  },
  {
    key: 'downloadMaxBytes',
    type: 'number',
    default: 100 * 1024 * 1024,
    title: '原文件上传上限（字节）',
    description: '允许上传为飞书附件的大小上限。',
  },
]);

/**
 * Build the exported `Config` schema object.
 *
 * The Loader accepts a JSON-Schema-shaped object for a plugin's `Config`; this
 * keeps the package dependency-free, which is what lets it install into any
 * profile.
 */
export function pluginConfigSchema() {
  const properties = {};
  for (const field of CONFIG_FIELDS) {
    properties[field.key] = {
      type: field.type,
      ...(field.enum ? { enum: field.enum } : {}),
      default: field.default,
      title: field.title,
      description: field.description,
      ...(field.secret ? { 'x-dsh-secret': true } : {}),
    };
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
  };
}

/**
 * Validate and normalize one row's config.
 *
 * Validation is deliberately strict about types and lenient about empty
 * strings, because "unset" must be distinguishable from "set to blank".
 *
 * @param {unknown} raw
 * @returns {ReturnType<typeof resolveConfig>}
 */
export function resolveConfig(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const problems = [];

  const bool = (key, fallback) => {
    const input = value[key];
    if (input === undefined) return fallback;
    if (typeof input !== 'boolean') {
      problems.push(`${key} 需要布尔值`);
      return fallback;
    }
    return input;
  };
  const text = (key, fallback = '') => {
    const input = value[key];
    if (input === undefined || input === null) return fallback;
    if (typeof input !== 'string') {
      problems.push(`${key} 需要字符串`);
      return fallback;
    }
    return input.trim();
  };
  const positive = (key, fallback) => {
    const input = value[key];
    if (input === undefined || input === null) return fallback;
    if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) {
      problems.push(`${key} 需要正数`);
      return fallback;
    }
    return input;
  };
  const nonNegative = (key, fallback) => {
    const input = value[key];
    if (input === undefined || input === null) return fallback;
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
      problems.push(`${key} 需要非负数`);
      return fallback;
    }
    return input;
  };

  const brand = text('brand') || 'feishu';
  if (brand !== 'feishu' && brand !== 'lark') {
    problems.push('brand 只能是 feishu 或 lark');
  }

  const resolved = {
    enabled: bool('enabled', false),
    appId: text('appId'),
    appSecret: text('appSecret'),
    brand: brand === 'lark' ? 'lark' : 'feishu',
    groupRequireMention: bool('groupRequireMention', true),
    rejectInputWhileRunning: bool('rejectInputWhileRunning', true),
    defaultWorkspace: text('defaultWorkspace') || undefined,
    agentPreset: text('agentPreset') || undefined,
    compactTimeoutMs: positive('compactTimeoutMs', 60_000),
    capacityRetryMs: nonNegative('capacityRetryMs', 10_000),
    syncMenu: bool('syncMenu', true),
    notifyConnection: bool('notifyConnection', true),
    previewTimeoutMs: positive('previewTimeoutMs', 60_000),
    previewMaxBytes: positive('previewMaxBytes', 30 * 1024 * 1024),
    downloadMaxBytes: positive('downloadMaxBytes', 100 * 1024 * 1024),
    version: PLUGIN_VERSION,
    botName: text('botName') || undefined,
    problems,
  };
  return resolved;
}