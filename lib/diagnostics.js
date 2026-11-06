/**
 * Connection diagnostics.
 *
 * When the bot does not answer, the question is *which layer* is broken:
 * credentials, bot capability, the long connection, event subscription, or the
 * ability to reach the operator. Guessing from a single error message wastes
 * time, and a "not connected" answer is useless when the connection is exactly
 * what cannot be established.
 *
 * So each layer is probed independently, in order, and every probe reports its
 * own verdict even when an earlier one failed. A run therefore always names the
 * first broken layer — which is the only layer worth fixing.
 *
 * Nothing here sends a message to a user; the probes are read-only calls plus a
 * socket that is closed again before returning.
 *
 * @module dsh-feishu-only/lib/diagnostics
 */

import { FeishuApi } from './feishu/api.js';
import { FeishuLongConnection } from './feishu/ws.js';

/** Verdicts a single probe can return. */
export const CHECK = Object.freeze({
  OK: 'ok',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  WARNING: 'warning',
});

/**
 * What each layer means, so the UI can say it once instead of per probe.
 */
export const LAYERS = Object.freeze([
  { key: 'credentials', name: '凭据', purpose: 'App ID 与 App Secret 能换到 tenant token' },
  { key: 'app', name: '应用信息', purpose: '应用可读，机器人身份可确认' },
  { key: 'socket', name: '长连接', purpose: '能建立 WebSocket，且服务端有应答' },
  { key: 'events', name: '事件订阅', purpose: '事件订阅方式为长连接，消息事件会送达' },
  { key: 'menu', name: '指令菜单', purpose: '飞书“/”面板能登记本插件的指令' },
  { key: 'capabilities', name: '执行端', purpose: 'Harness 的 agent/session 服务可用' },
]);

/** A hint attached to a failure, keyed by the layer that failed. */
const HINTS = {
  credentials: '检查 App ID / App Secret 是否复制完整；如刚重置过密钥，需要重新填写。',
  app: '在飞书开放平台确认应用已创建、机器人能力已开启，并已发布一个版本。',
  socket: '确认「事件订阅」的订阅方式是“使用长连接接收事件”，而不是请求地址。',
  events: '在开放平台 → 事件与回调 → 事件订阅，添加 im.message.receive_v1 并选择长连接。',
  menu: '添加应用指令权限 application:app_slash_command:read 与 write，然后发布版本。',
  capabilities: '执行端服务缺失：确认 Harness 本身已正常加载 agent 与 session 服务。',
};

/**
 * Run every probe.
 *
 * @param {{
 *   appId?: string,
 *   appSecret?: string,
 *   brand?: string,
 *   logger?: Console,
 *   harness?: { available?: Record<string, boolean> },
 *   timeoutMs?: number,
 * }} options
 */
export async function diagnose(options = {}) {
  const {
    appId = '',
    appSecret = '',
    brand = 'feishu',
    logger = console,
    harness = null,
    timeoutMs = 12_000,
    WebSocketImpl = undefined,
  } = options;

  const checks = [];
  const record = (layer, verdict, detail, extra = {}) => {
    checks.push({ layer, verdict, detail, ...extra });
    return verdict === CHECK.OK || verdict === CHECK.WARNING;
  };

  // ---------------------------------------------------------------- credentials

  if (!appId || !appSecret) {
    record('credentials', CHECK.FAILED, !appId ? '缺少 App ID' : '缺少 App Secret');
    return finish(checks, { appId, brand, harness });
  }

  const api = new FeishuApi({ appId, appSecret, brand, logger });
  let token;
  try {
    token = await api.tenantToken();
    record('credentials', CHECK.OK, '凭据有效，已取得 tenant access token');
  } catch (error) {
    record('credentials', CHECK.FAILED, describe(error));
    // Every later probe needs a token, so stop here rather than repeat it.
    return finish(checks, { appId, brand, harness });
  }

  // ---------------------------------------------------------------------- app

  let bot = null;
  try {
    bot = await api.botInfo();
    const activated = bot?.activateStatus === 2;
    record(
      'app',
      activated ? CHECK.OK : CHECK.WARNING,
      activated
        ? `机器人 ${bot.name ?? appId} 已启用`
        : `机器人 ${bot.name ?? appId} 存在，但激活状态为 ${bot?.activateStatus ?? '未知'}`,
      { bot: { name: bot?.name ?? null, openId: bot?.openId ?? null, activateStatus: bot?.activateStatus ?? null } },
    );
  } catch (error) {
    record('app', CHECK.FAILED, describe(error));
  }

  // ------------------------------------------------------------------- socket

  // The socket probe is the one that distinguishes "cannot connect" from
  // "connected but silent", so it reports whether a frame ever arrived.
  let frames = 0;
  let controlFrames = 0;
  let socketError = null;
  const conn = new FeishuLongConnection({
    appId,
    appSecret,
    brand,
    logger: silentLogger(),
    ...(WebSocketImpl ? { WebSocketImpl } : {}),
  });
  conn.setConnectTimeout?.(timeoutMs);
  try {
    await conn.start();
    // Give the server a moment to answer the client's first ping: a socket that
    // opens but never carries a frame is a different fault from one that cannot
    // open at all.
    await sleep(2_500);
    const status = conn.status ?? {};
    frames = Number(status.frames ?? 0);
    controlFrames = Number(status.controlFrames ?? 0);
    if (frames > 0) {
      record('socket', CHECK.OK, `长连接已建立，收到 ${frames} 个控制帧（其中 pong ${status.pongs ?? 0} 个）`);
    } else {
      record(
        'socket',
        CHECK.WARNING,
        '长连接已建立，但 2.5 秒内没有收到任何控制帧；服务端可能尚未下发',
      );
    }
  } catch (error) {
    socketError = error;
    record('socket', CHECK.FAILED, describe(error));
  } finally {
    try {
      await conn.dispose();
    } catch {
      // Disposal of a failed socket needs no further action.
    }
  }

  // -------------------------------------------------------------------- events

  // Feishu does not expose "which events are subscribed" through the API, so
  // the verdict here is derived: a working socket plus a readable app means the
  // remaining requirement is the subscription mode itself, which only the
  // console can confirm. Saying so is more useful than a fake pass.
  if (socketError) {
    record('events', CHECK.SKIPPED, '长连接未建立，无法判断事件订阅是否生效');
  } else if (frames > 0) {
    record(
      'events',
      CHECK.WARNING,
      '长连接可通信；请确认订阅方式为“使用长连接接收事件”，并已添加 im.message.receive_v1',
    );
  } else {
    record('events', CHECK.SKIPPED, '长连接没有应答，事件能否送达无法判断');
  }

  // --------------------------------------------------------------------- menu

  try {
    const items = await api.listSlashCommands();
    record('menu', CHECK.OK, `已登记 ${items.length} 个指令`, { menuCount: items.length });
  } catch (error) {
    const code = error?.code;
    if (code === 99991672 || code === 99991640) {
      record('menu', CHECK.WARNING, '缺少应用指令权限；指令菜单不会出现在飞书里');
    } else {
      record('menu', CHECK.WARNING, describe(error));
    }
  }

  return finish(checks, { appId, brand, harness, bot, token });
}

/** Assemble the report, including which layer to fix first. */
function finish(checks, { appId = '', brand = 'feishu', harness = null } = {}) {
  // A harness capability probe needs no network, so it always runs.
  if (harness) {
    const available = harness.available ?? {};
    const ok = Boolean(available.agents && available.sessions);
    checks.push({
      layer: 'capabilities',
      verdict: ok ? CHECK.OK : CHECK.FAILED,
      detail: ok ? '执行端服务可用' : '缺少 agent 或 session 服务',
    });
  }

  const broken = checks.find((check) => check.verdict === CHECK.FAILED);
  const firstWarning = checks.find((check) => check.verdict === CHECK.WARNING);
  const focus = broken ?? firstWarning ?? null;

  return {
    ok: !broken,
    appId,
    brand,
    checkedAt: new Date().toISOString(),
    /** The layer worth fixing first, or null when everything passed. */
    focus: focus
      ? {
          layer: focus.layer,
          verdict: focus.verdict,
          detail: focus.detail,
          hint: HINTS[focus.layer] ?? '',
        }
      : null,
    checks: checks.map((check) => ({
      ...check,
      name: LAYERS.find((layer) => layer.key === check.layer)?.name ?? check.layer,
    })),
  };
}

/** Wait, without keeping the process alive for it. */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** A logger that keeps a probe's reconnect chatter out of the app log. */
function silentLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

/** Turn a platform error into one readable sentence. */
function describe(error) {
  const code = error?.code ? `${error.code} ` : '';
  const message = String(error?.message ?? error).replace(/\s+/gu, ' ').trim();
  return `${code}${message}`.slice(0, 300);
}