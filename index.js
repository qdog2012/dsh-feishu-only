/**
 * dsh-feishu-only — a Feishu (Lark) bot bridge for DeepSeek Harness.
 *
 * One Host plugin row owns the whole integration:
 *  - long-connection transport for message events and card callbacks,
 *  - scan-to-create onboarding for the bot app,
 *  - the documented slash-command surface,
 *  - card-driven task navigation, progress, approvals and questions,
 *  - preview and original-file delivery.
 *
 * The plugin depends on nothing outside Node's standard library, so it loads in
 * any profile without peer packages. Every Host capability it uses is optional:
 * when a service is missing the bridge says so instead of throwing.
 *
 * Onboarding and status are exposed over a handful of read/write HTTP routes so
 * the Harness Web UI can show a QR code and run the three-layer verification
 * without shipping a separate client bundle.
 *
 * @module dsh-feishu-only
 */

import { FeishuApi } from './lib/feishu/api.js';
import { FeishuLongConnection, WS_STATE } from './lib/feishu/ws.js';
import { RegistrationSession, REGISTRATION_STATE, bridgeAddons } from './lib/feishu/registration.js';
import { InteractionState } from './lib/state.js';
import { HarnessAdapter } from './lib/harness.js';
import { InteractionBridge } from './lib/interactions.js';
import { FeishuBridge } from './lib/bridge.js';
import { PreviewService } from './lib/preview.js';
import { qrSvg } from './lib/qr.js';
import { MENU, describeMenuError, syncSlashMenu } from './lib/menu.js';
import { pluginConfigSchema, resolveConfig, PLUGIN_VERSION } from './lib/config.js';

/**
 * The plugin's declared configuration schema.
 *
 * Exposed as a plain JSON-Schema document for tooling and the settings surface.
 * The Loader's own `Config` export expects a schemastery instance, which this
 * zero-dependency package cannot import, so validation happens in `apply` and
 * reports precise problems instead of a schema mismatch.
 */
export const configSchema = pluginConfigSchema();

/**
 * Plugin entry point.
 *
 * @param {any} ctx the Cordis plugin context.
 * @param {any} rawConfig the row's `config` object.
 */
export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const logger = ctx.logger ?? console;

  if (config.problems.length > 0) {
    // A row whose config cannot be understood must not boot half-configured:
    // say exactly which field is wrong.
    throw new TypeError(`dsh-feishu-only 配置无效：${config.problems.join('；')}`);
  }

  const state = new InteractionState({ logger });
  const harness = new HarnessAdapter({ ctx, logger });

  /** The live connection bundle, created once credentials are usable. */
  let runtime = null;
  /** The single in-flight onboarding attempt, if any. */
  let registration = null;
  /** Last successful bot identity read from the platform. */
  let botInfo = null;
  /** Why the last connection attempt failed, for `/status` and the settings page. */
  let lastError = null;
  /** Outcome of the last slash-menu reconcile, surfaced through `/status`. */
  let menuReport = null;

  /**
   * A small ring of recent inbound/outbound outcomes.
   *
   * When the bot appears to ignore a message, the useful question is "did we
   * receive it, and did the reply fail?" — that cannot be answered from the
   * outside, so the last few outcomes are kept and exposed through `/status`.
   */
  const diagnostics = [];
  const noteDiagnostic = (entry) => {
    diagnostics.push({ at: new Date().toISOString(), ...entry });
    if (diagnostics.length > 12) diagnostics.shift();
  };

  // ------------------------------------------------------------------ runtime

  /**
   * Start the connection for one credential pair and wire every handler.
   *
   * Bot identity is verified BEFORE the socket opens: a credential pair that
   * cannot read its own identity is not a usable connection, and reporting that
   * early is more useful than a socket that reconnects forever.
   */
  async function startRuntime({ appId, appSecret, brand }) {
    await stopRuntime();
    lastError = null;
    const api = new FeishuApi({ appId, appSecret, brand, logger });

    let bridge = null;
    const interactions = new InteractionBridge({
      ctx,
      state,
      api,
      logger,
      retryWaitMs: config.capacityRetryMs,
      taskLookup: (sessionId) => bridge?.knownTasks().find((task) => task.sessionId === sessionId) ?? null,
      operatorsFor: (sessionId) => bridge?.operatorsForTask(sessionId) ?? [],
      deliver: async (openId, payload) => api.sendPrivateCard(openId, payload),
    });

    const previewService = new PreviewService({ ctx, api, harness, config, logger });

    bridge = new FeishuBridge({
      ctx,
      config: { ...config, appId, brand },
      api,
      state,
      harness,
      logger,
      interactions,
      preview: previewService,
      onDiagnostic: noteDiagnostic,
    });

    const ws = new FeishuLongConnection({ appId, appSecret, brand, logger });
    const disposers = [];

    disposers.push(ws.on('im.message.receive_v1', async ({ event }) => {
      bridge.updateHealth({ ws: ws.state });
      const message = event?.message;
      noteDiagnostic({
        kind: 'inbound',
        chat: message?.chat_id,
        type: message?.message_type,
        chatType: message?.chat_type,
        text: typeof message?.content === 'string' ? message.content.slice(0, 60) : undefined,
      });
      await bridge.onMessage(event);
      return undefined;
    }));

    disposers.push(ws.on('im.chat.access_event.bot_p2p_chat_entered_v1', async () => undefined));

    disposers.push(ws.on('card.action.trigger', async ({ event }) => bridge.onCardAction(event)));

    disposers.push(interactions.install());

    const healthTimer = setInterval(() => {
      bridge.updateHealth({ ws: ws.state });
    }, 15_000);
    healthTimer.unref?.();

    const shutdown = () => {
      clearInterval(healthTimer);
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // A listener already removed needs no further action.
        }
      }
      bridge.dispose();
    };

    try {
      botInfo = await api.botInfo();
      bridge.updateHealth({ bot: 'ok' });
    } catch (error) {
      shutdown();
      lastError = `凭据校验失败：${error?.message ?? error}`;
      throw new Error(lastError, { cause: error });
    }

    try {
      await ws.start();
      bridge.updateHealth({ ws: WS_STATE.CONNECTED });
    } catch (error) {
      shutdown();
      lastError = `长连接建立失败：${error?.message ?? error}。`
        + '请确认应用已发布、机器人能力已开启，事件订阅与回调订阅都设置为“使用长连接接收”。';
      throw new Error(lastError, { cause: error });
    }

    runtime = {
      appId,
      brand,
      api,
      ws,
      bridge,
      interactions,
      preview: previewService,
      dispose: shutdown,
    };
    logger.info?.(`[feishu] bridge is live for app ${appId} (${brand})`);

    // Publish the `/` menu in the background: it is discoverability, not a
    // prerequisite for receiving messages, so a failure here must not keep the
    // bridge down. The result is reported once through `/status`.
    if (config.syncMenu) {
      void syncSlashMenu(api, { logger })
        .then((report) => {
          menuReport = report;
          if (report.failed.length > 0) {
            lastError = `菜单同步未完成：${report.failed[0].error}`;
          }
        })
        .catch((error) => {
          lastError = `菜单同步失败：${describeMenuError(error)}`;
          logger.warn?.(`[feishu] ${lastError}`);
        });
    }
    return runtime;
  }

  async function stopRuntime() {
    if (!runtime) return;
    const current = runtime;
    runtime = null;
    try {
      await current.ws.dispose();
    } catch (error) {
      logger.warn?.(`[feishu] connection did not close cleanly: ${error?.message ?? error}`);
    }
    current.dispose();
  }

  // -------------------------------------------------------------- bootstrapping

  if (config.enabled) {
    const secret = config.appSecret || await readStoredSecret(ctx, config.appId);
    if (!config.appId || !secret) {
      logger.warn?.('[feishu] the bridge is enabled but has no App ID/Secret; open the settings page to connect a bot');
    } else {
      await startRuntime({ appId: config.appId, appSecret: secret, brand: config.brand });
    }
  }

  // -------------------------------------------------------------- HTTP surface

  // The helpers live outside the registration block because the handlers they
  // serve (`connectWithCredentials`, `verifyConnected`) are also called from
  // elsewhere; scoping them to the block left them undefined at call time.
  const base = '/plugins/dsh-feishu-only';
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

  const routeDisposers = [];
  // `ctx.get('webServer')` is undefined during a cold start: the HTTP carrier
  // activates after this plugin's `apply` runs. `ctx.inject` defers the
  // registration until the service exists (and re-runs it if it is replaced),
  // which is what makes the routes survive a restart.
  ctx.inject(['webServer'], (routeCtx) => {
    const webServer = routeCtx.webServer;
    if (!webServer?.register) return;
    // This callback re-runs when the service is replaced, so release the
    // previous generation's routes first instead of stacking duplicates.
    while (routeDisposers.length > 0) {
      const dispose = routeDisposers.pop();
      try {
        dispose();
      } catch {
        // A route from a dead service needs no further action.
      }
    }
    routeDisposers.push(webServer.register({
      kind: 'exact',
      path: `${base}/status`,
      resource: async () => json(buildStatus()),
    }));

    routeDisposers.push(webServer.register({
      kind: 'exact',
      path: `${base}/qr`,
      resource: async (request) => {
        const url = new URL(request.url);
        // A `resource` route answers GET/HEAD only, so the start signal travels
        // as a query flag rather than a method. Starting is idempotent: while an
        // attempt is live the existing QR is returned instead of spawning a
        // second device authorization.
        const wantsStart = url.searchParams.get('start') === '1';
        if (wantsStart && !isRegistrationLive()) {
          try {
            return json({ ok: true, registration: await beginRegistration() });
          } catch (error) {
            return json({ ok: false, error: error?.message ?? String(error) }, 500);
          }
        }
        return json({ ok: true, registration: registrationSnapshot() });
      },
    }));

    routeDisposers.push(webServer.register({
      kind: 'exact',
      path: `${base}/qr/cancel`,
      resource: async (request) => {
        const url = new URL(request.url);
        if (url.searchParams.get('cancel') === '1') registration?.cancel();
        return json({ ok: true, registration: registrationSnapshot() });
      },
    }));

    routeDisposers.push(webServer.register({
      kind: 'exact',
      path: `${base}/connect`,
      resource: async (request) => {
        const url = new URL(request.url);
        const appId = url.searchParams.get('appId') ?? '';
        const appSecret = url.searchParams.get('appSecret') ?? '';
        const brand = url.searchParams.get('brand') === 'lark' ? 'lark' : config.brand;
        if (!appId || !appSecret) {
          return json({ ok: false, error: '需要 appId 与 appSecret 查询参数' }, 400);
        }
        return connectWithCredentials({ appId, appSecret, brand });
      },
    }));

    routeDisposers.push(webServer.register({
      kind: 'exact',
      path: `${base}/qr-image`,
      resource: async (request) => {
        const url = new URL(request.url);
        const target = url.searchParams.get('url') ?? '';
        // Only the verification URL this plugin actually issued is rendered, so
        // the endpoint cannot be used as a general "make me a QR" service.
        const issued = registration?.qrCode?.url;
        if (!target || !issued || target !== issued) {
          return new Response('unknown registration', {
            status: 404,
            headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
          });
        }
        try {
          const svg = qrSvg(target, { scale: 6, border: 4 });
          return new Response(svg, {
            headers: {
              'content-type': 'image/svg+xml; charset=utf-8',
              'cache-control': 'no-store',
            },
          });
        } catch (error) {
          return new Response(`cannot render QR: ${error?.message ?? error}`, {
            status: 500,
            headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
          });
        }
      },
    }));

    routeDisposers.push(webServer.register({
      kind: 'exact',
      path: `${base}/menu`,
      resource: async (request) => {
        const url = new URL(request.url);
        if (!runtime) return json({ ok: false, error: '尚未连接机器人' }, 400);
        if (url.searchParams.get('sync') === '1') {
          try {
            const report = await syncSlashMenu(runtime.api, { logger });
            return json({ ok: report.failed.length === 0, report });
          } catch (error) {
            return json({ ok: false, error: describeMenuError(error) }, 500);
          }
        }
        try {
          const items = await runtime.api.listSlashCommands();
          return json({ ok: true, items, wanted: MENU.map((item) => item.command) });
        } catch (error) {
          return json({ ok: false, error: describeMenuError(error) }, 400);
        }
      },
    }));

    routeDisposers.push(webServer.register({
      kind: 'exact',
      path: `${base}/verify`,
      resource: async () => verifyConnected(),
    }));

    routeDisposers.push(webServer.register({
      kind: 'exact',
      path: `${base}/disconnect`,
      resource: async (request) => {
        const url = new URL(request.url);
        if (url.searchParams.get('confirm') !== '1') {
          return json({ ok: false, error: '需要 confirm=1' }, 400);
        }
        // Disconnecting drops the live connection and the stored secret but
        // keeps the app identity, so reconnecting needs no re-entry of the ID.
        registration?.cancel();
        registration = null;
        await stopRuntime();
        await clearStoredSecret(ctx, config.appId);
        await saveConfig({ enabled: false });
        botInfo = null;
        lastError = null;
        return json({ ok: true, ...buildStatus() });
      },
    }));
  });

  function buildStatus() {
    return {
      ok: true,
      version: PLUGIN_VERSION,
      enabled: config.enabled,
      connected: Boolean(runtime),
      appId: mask(config.appId),
      secretConfigured: Boolean(config.appSecret) || Boolean(runtime),
      brand: config.brand,
      bot: botInfo
        ? {
            name: botInfo.name,
            openId: mask(botInfo.openId),
            activateStatus: botInfo.activateStatus,
          }
        : null,
      connection: {
        bot: botInfo ? 'ok' : lastError ? 'error' : 'unknown',
        messages: runtime ? runtime.ws.state : WS_STATE.STOPPED,
      },
      lastError,
      capabilities: harness.available,
      registration: registrationSnapshot(),
      recent: [...diagnostics],
      /** Set once a reply was rejected for out-of-scope availability. */
      availabilityWarning: availabilityWarning(),
      /** The `/` menu reconcile result, or null before it ran. */
      menu: menuReport,
    };
  }

  /**
   * Turn the recurring "bot has NO availability to this user" failure into an
   * instruction, because the platform error alone does not say what to change.
   */
  function availabilityWarning() {
    const hit = [...diagnostics].reverse().find((entry) => entry.code === 230013);
    if (!hit) return null;
    return '飞书拒绝向这个用户发送消息（230013）：机器人可用范围不含该账号。'
      + '请在飞书开放平台 → 应用发布 → 版本管理与发布 → 可用范围 中加入该用户，然后发布新版本。';
  }

  function registrationSnapshot() {
    if (!registration) return { state: 'idle', qrCodeUrl: null, expiresAt: null };
    const outcome = registration.outcome;
    return {
      state: registration.state,
      attempt: registration.id,
      qrCodeUrl: registration.qrCode?.url ?? null,
      expiresAt: registration.qrCode?.expiresAt ?? null,
      ...(outcome.status === 'failed' ? { error: outcome.error?.message ?? String(outcome.error) } : {}),
    };
  }

  /** Whether an attempt is still waiting for the user, so `start` is a no-op. */
  function isRegistrationLive() {
    if (!registration) return false;
    // A failed or cancelled attempt must never block the next one: only an
    // attempt that is genuinely still waiting for the user is live.
    if (registration.outcome.status === 'failed') return false;
    return registration.state === REGISTRATION_STATE.STARTING
      || registration.state === REGISTRATION_STATE.WAITING
      || registration.state === REGISTRATION_STATE.SLOW_DOWN;
  }

  async function beginRegistration() {
    // A fresh attempt supersedes an old one without touching a live connection:
    // regenerating the QR never drops an already-established bot.
    if (registration && registration.state !== REGISTRATION_STATE.SUCCEEDED) registration.cancel();
    const session = new RegistrationSession({
      brand: config.brand,
      appName: config.botName,
      addons: bridgeAddons(),
      source: 'dsh-feishu-only',
      logger,
    });
    registration = session;
    session.completed.then(async (result) => {
      const stored = await writeStoredSecret(ctx, result.appId, result.appSecret);
      await saveConfig({ appId: result.appId, enabled: true, brand: result.brand });
      if (!stored) {
        logger.warn?.('[feishu] the credential store refused the app secret; it must be entered again after a restart');
      }
      try {
        await startRuntime({ appId: result.appId, appSecret: result.appSecret, brand: result.brand });
      } catch (error) {
        lastError = error?.message ?? String(error);
        logger.error?.(`[feishu] the new app could not be connected: ${lastError}`);
      }
    }, (error) => {
      logger.warn?.(`[feishu] onboarding ended without credentials: ${error?.message ?? error}`);
    });

    // Wait only for the QR code, never for the user's scan: the page polls.
    const deadline = Date.now() + 15_000;
    while (!session.qrCode && !session.outcome.error && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!session.qrCode) {
      throw new Error(session.outcome.error?.message ?? '没有取得授权二维码，请稍后重试');
    }
    return registrationSnapshot();
  }

  async function connectWithCredentials(payload) {
    const appId = typeof payload?.appId === 'string' ? payload.appId.trim() : '';
    const appSecret = typeof payload?.appSecret === 'string' ? payload.appSecret.trim() : '';
    const brand = payload?.brand === 'lark' ? 'lark' : config.brand;
    if (!appId || !appSecret) return json({ ok: false, error: '需要 App ID 与 App Secret' }, 400);
    try {
      // Verifying capabilities is part of connecting: the manual fallback must
      // not accept a credential pair it never proved usable.
      const probe = new FeishuApi({ appId, appSecret, brand, logger });
      const info = await probe.botInfo();
      await writeStoredSecret(ctx, appId, appSecret);
      await saveConfig({ appId, enabled: true, brand });
      await startRuntime({ appId, appSecret, brand });
      botInfo = info;
      return json({ ok: true, bot: { name: info.name, activateStatus: info.activateStatus } });
    } catch (error) {
      return json({ ok: false, error: error?.message ?? String(error) }, 400);
    }
  }

  async function verifyConnected() {
    if (!runtime) {
      return json({
        ok: false,
        checks: [{ name: '机器人层', ok: false, detail: '尚未连接任何机器人。' }],
      }, 400);
    }
    const connected = runtime.ws.state === WS_STATE.CONNECTED;
    const checks = [
      {
        name: '机器人层',
        ok: botInfo !== null,
        detail: botInfo ? `已认证为 ${botInfo.name ?? runtime.appId}` : '机器人身份未确认',
      },
      {
        name: '消息层',
        ok: connected,
        detail: connected ? '长连接已建立，可以接收消息事件' : `连接状态：${runtime.ws.state}`,
      },
      {
        name: '交互层',
        ok: connected,
        detail: connected
          ? '卡片回调通道已就绪（请在飞书中点击任意卡片按钮完成验证）'
          : '卡片回调依赖长连接，当前不可用',
      },
      {
        name: '执行端',
        ok: Boolean(harness.available.agents && harness.available.sessions),
        detail: harness.available.agents ? '执行端服务可用' : '未检测到执行端服务',
      },
    ];
    return json({ ok: checks.every((check) => check.ok), checks });
  }

  /**
   * Persist the plugin's own config through the profile's config editor.
   *
   * Rewriting the profile patch by hand is forbidden: the editor keeps other
   * rows, comments and `!!js` expressions intact.
   */
  async function saveConfig(patch) {
    const entry = ctx.fiber?.entry;
    const editor = ctx.get?.('configEditor');
    if (!entry || !editor?.edit) {
      logger.warn?.('[feishu] configuration cannot be saved in this profile; the values apply to this session only');
      return false;
    }
    try {
      await editor.edit(entry, (current) => ({ ...current, ...patch }));
      return true;
    } catch (error) {
      logger.error?.(`[feishu] saving the configuration failed: ${error?.message ?? error}`);
      return false;
    }
  }

  // ------------------------------------------------------------------ teardown

  ctx.effect(() => () => {
    for (const dispose of routeDisposers) {
      try {
        dispose();
      } catch {
        // A route already removed needs no further action.
      }
    }
    registration?.cancel();
    void stopRuntime();
    state.clear();
  }, 'dsh-feishu-only.teardown()');
}

/** Read the app secret from the credential service. */
async function readStoredSecret(ctx, appId) {
  const credentials = ctx.get?.('credentials');
  if (!credentials?.readRecord || !appId) return null;
  try {
    const record = await credentials.readRecord(credentialKey(appId));
    if (record?.kind === 'api-key' && typeof record.key === 'string' && record.key) return record.key;
    if (record?.kind === 'grant' && typeof record.payload?.secret === 'string') return record.payload.secret;
  } catch {
    // A missing credential store simply means no stored secret.
  }
  return null;
}

async function writeStoredSecret(ctx, appId, secret) {
  const credentials = ctx.get?.('credentials');
  if (!credentials?.modifyRecord || !appId || !secret) return false;
  try {
    await credentials.modifyRecord(credentialKey(appId), async () => ({ kind: 'api-key', key: secret }));
    return true;
  } catch {
    return false;
  }
}

function credentialKey(appId) {
  return `dsh-feishu-only:${appId}`;
}

/** Show only enough of an identifier to recognize it. */
function mask(value) {
  if (typeof value !== 'string' || !value) return null;
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}