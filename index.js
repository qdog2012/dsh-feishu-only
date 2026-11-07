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
import { diagnose } from './lib/diagnostics.js';
import { noticeTarget, sendConnectionNotice, shouldSuppress } from './lib/notify.js';
import { pluginConfigSchema, resolveConfig, PLUGIN_VERSION } from './lib/config.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Identifies this module instance.
 *
 * Evaluated once when the module is first imported, so a running process keeps
 * reporting the same value no matter how often the plugin is disabled, enabled
 * or reinstalled. It exists to make "did the reload take effect?" answerable
 * from the outside.
 */
const BUILD_ID = `${PLUGIN_VERSION}+${Date.now().toString(36)}`;

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

  // A field this plugin cannot understand must disable the bridge, not the
  // app. Throwing here aborted `apply`, which took the whole Harness down on a
  // launch — a plugin may never be able to do that. The problem is reported
  // through the logger and `/status` instead, and the settings page still
  // loads so the value can be corrected.
  if (config.problems.length > 0) {
    const summary = `dsh-feishu-only 配置无效：${config.problems.join('；')}`;
    logger.warn?.(`[feishu] ${summary}`);
    config.enabled = false;
    config.problems = Object.freeze([...config.problems]);
  }

  /**
   * Where the task each user last selected is remembered.
   *
   * Without this a restart forgot the selection, so the next message had
   * nowhere to go and the user had to pick a task again — the one piece of
   * bridge state that is genuinely a user preference rather than a live fact.
   */
  const selectionFile = () => {
    try {
      const home = ctx.get?.('homePaths')?.homeDir
        ?? process.env.DSH_HOME
        ?? join(homedir(), '.dsh');
      return join(home, 'feishu-only.selection.json');
    } catch {
      return null;
    }
  };

  /** Write the current selections. Debounced by the caller's rarity. */
  let selectionWrite = Promise.resolve();
  const persistSelection = () => {
    const file = selectionFile();
    if (!file) return;
    const entries = {};
    for (const { userId, task } of state.currentTaskEntries()) {
      if (!userId || !task?.sessionId) continue;
      entries[userId] = {
        sessionId: task.sessionId,
        label: task.label ?? null,
        cwd: task.cwd ?? null,
      };
    }
    // Serialized so two quick selections cannot interleave into a half-written
    // file; each write carries the full map anyway.
    selectionWrite = selectionWrite
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify({ version: 1, selections: entries }, null, 2), 'utf8');
      })
      .catch((error) => {
        logger.warn?.(`[feishu] could not save the task selection: ${error?.message ?? error}`);
      });
  };

  async function loadSelection() {
    const file = selectionFile();
    if (!file) return;
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      let restored = 0;
      for (const [userId, entry] of Object.entries(parsed?.selections ?? {})) {
        if (!userId || typeof entry?.sessionId !== 'string' || !entry.sessionId) continue;
        state.restoreCurrentTask(userId, {
          sessionId: entry.sessionId,
          label: typeof entry.label === 'string' ? entry.label : null,
          cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
        });
        restored += 1;
      }
      if (restored > 0) logger.debug?.(`[feishu] restored ${restored} task selection(s)`);
    } catch (error) {
      // A missing or unreadable file only means the user picks a task again.
      if (error?.code !== 'ENOENT') {
        logger.warn?.(`[feishu] could not read the task selection: ${error?.message ?? error}`);
      }
    }
  }

  const state = new InteractionState({ logger, onCurrentTaskChange: () => persistSelection() });
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
   * Whether a usable secret exists in the store.
   *
   * Reported separately from `runtime` on purpose: "connected" and "a secret is
   * stored" are different facts, and conflating them made a stored-but-unused
   * secret look missing.
   */
  let secretOnDisk = null;

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
   * Operators the bridge has seen, keyed by open id with the time they last
   * spoke.
   *
   * This lives at `apply` scope and is persisted, because the notice that
   * matters most — "I am connected again" — is sent at startup, before anyone
   * has had a chance to talk to the bot. Without persistence the first connect
   * after every restart has no recipient, which is exactly when a notice is
   * wanted.
   */
  const operators = new Map();
  const rememberOperator = (openId) => {
    if (!openId) return;
    const already = operators.has(openId);
    operators.set(openId, { lastSeen: Date.now() });
    // Only the first sighting of a person is worth a disk write; a message per
    // second must not turn into a write per second.
    if (!already) void persistOperators();
  };
  /** When the last notice went out, for flap suppression. */
  let lastNoticeAt = NaN;

  /** Where the notice recipients survive a restart. */
  const operatorsFile = () => {
    try {
      const home = ctx.get?.('homePaths')?.homeDir
        ?? process.env.DSH_HOME
        ?? join(homedir(), '.dsh');
      return join(home, 'feishu-only.operators.json');
    } catch {
      return null;
    }
  };

  async function loadOperators() {
    const file = operatorsFile();
    if (!file) return;
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [openId, entry] of Object.entries(parsed?.operators ?? {})) {
        const lastSeen = Number(entry?.lastSeen);
        if (typeof openId === 'string' && openId && Number.isFinite(lastSeen)) {
          operators.set(openId, { lastSeen });
        }
      }
      if (operators.size > 0) {
        logger.debug?.(`[feishu] loaded ${operators.size} operator(s) for connection notices`);
      }
    } catch (error) {
      // A missing or unreadable file only costs the first notice after a
      // restart; it must never affect startup.
      if (error?.code !== 'ENOENT') {
        logger.warn?.(`[feishu] could not read the operator list: ${error?.message ?? error}`);
      }
    }
  }

  async function persistOperators() {
    const file = operatorsFile();
    if (!file) return;
    try {
      const plain = {};
      for (const [openId, entry] of operators) plain[openId] = { lastSeen: entry.lastSeen };
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ version: 1, operators: plain }, null, 2), 'utf8');
    } catch (error) {
      logger.warn?.(`[feishu] could not save the operator list: ${error?.message ?? error}`);
    }
  }

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

    /** Best-effort, never throws: a notice must not feed back into the bridge. */
    const notify = (event, reason) => {
      if (!config.notifyConnection) {
        noteDiagnostic({ kind: 'notice-skipped', why: 'notifyConnection off' });
        return;
      }
      const openId = noticeTarget(operators);
      if (!openId) {
        // Not a failure — but it is invisible unless recorded, and "no notice
        // arrived" is otherwise indistinguishable from "the notice was never
        // attempted". The first start after a fresh install has no one to tell.
        noteDiagnostic({ kind: 'notice-skipped', why: 'no operator known yet', event });
        logger.debug?.('[feishu] no operator to notify yet');
        return;
      }
      if (shouldSuppress(lastNoticeAt, Date.now(), event)) {
        noteDiagnostic({ kind: 'notice-skipped', why: 'suppressed', event });
        logger.debug?.('[feishu] connection notice suppressed as flapping');
        return;
      }
      lastNoticeAt = Date.now();
      noteDiagnostic({ kind: 'notice-sent', event, to: openId });
      void sendConnectionNotice({ api, logger }, { openId, event, reason })
        .then((ok) => noteDiagnostic({ kind: ok ? 'notice-delivered' : 'notice-failed', event }))
        .catch(() => noteDiagnostic({ kind: 'notice-failed', event }));
    };

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
      rememberOperator(event?.sender?.sender_id?.open_id ?? message?.sender_id?.open_id);
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

    // Connection transitions, straight from the socket: connected -> anything
    // else is a disconnect worth reporting, and re-entering connected after a
    // drop is a recovery worth reporting too.
    disposers.push(ws.on('state.change', ({ from, to }) => {
      if (from === WS_STATE.CONNECTED && to !== WS_STATE.CONNECTED) {
        notify('disconnected', `连接状态：${to}`);
      }
    }));

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
      try {
        await ws.dispose();
      } catch {
        // Nothing was opened yet, so there is nothing to close.
      }
      shutdown();
      lastError = `凭据校验失败：${error?.message ?? error}`;
      throw new Error(lastError, { cause: error });
    }

    try {
      await ws.start();
      bridge.updateHealth({ ws: WS_STATE.CONNECTED });
      notify('connected');
    } catch (error) {
      // `start()` schedules a reconnect before it throws, so the socket must be
      // disposed too: otherwise every failed attempt leaves a timer that retries
      // forever in the background, and a failure looks like a half-open bridge.
      notify('disconnected', error?.message ?? String(error));
      try {
        await ws.dispose();
      } catch {
        // A socket that never opened needs no further cleanup.
      }
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

  // Restore the remembered selection regardless of `enabled`: it is what the next
  // message needs, and the settings page should show the same state.
  void loadSelection();

  if (config.enabled) {
    // Connecting is started, never awaited: awaiting it made plugin loading
    // depend on a network round trip and a socket handshake, so the app showed
    // no UI until Feishu answered. The bridge is not a precondition for the rest
    // of the app, so the attempt runs in the background and reports its outcome
    // through `/status` like any other connection.
    const startupConfig = { appId: config.appId, brand: config.brand };
    const attemptStartup = async () => {
      try {
        // Load the notice recipients before connecting: the "connected" notice
        // is sent as soon as the socket opens, so the list must already be
        // there. Reading it here also keeps a failure off the launch path.
        await loadOperators();
        const inline = Boolean(config.appSecret);
        const secret = config.appSecret || await readStoredSecret(ctx, startupConfig.appId);
        noteDiagnostic({
          kind: 'startup',
          appId: startupConfig.appId || null,
          inlineSecret: inline,
          secretFound: Boolean(secret),
        });
        if (!startupConfig.appId || !secret) {
          logger.warn?.('[feishu] the bridge is enabled but has no App ID/Secret; open the settings page to connect a bot');
          return;
        }
        await startRuntime({ appId: startupConfig.appId, appSecret: secret, brand: startupConfig.brand });
        noteDiagnostic({ kind: 'startup-connected', appId: startupConfig.appId });
      } catch (error) {
        lastError = lastError ?? `启动连接失败：${error?.message ?? error}`;
        noteDiagnostic({
          kind: 'startup-failed',
          appId: startupConfig.appId || null,
          error: String(error?.message ?? error).slice(0, 300),
        });
        logger.warn?.(`[feishu] startup connect failed (the plugin stays loaded): ${error?.message ?? error}`);
      }
    };

    // A cold start runs this plugin's `apply` before the credentials service has
    // activated, so a one-shot `ctx.get` finds nothing, the secret reads as
    // absent, and the bridge never connects — even though the record is on disk
    // and the service is up a moment later. `ctx.inject` waits for it (and runs
    // again if it is ever replaced), the same fix the HTTP routes needed for
    // `webServer`.
    if (config.appSecret) {
      // The secret is inline, so no service is needed and nothing is gained by
      // waiting for one.
      void attemptStartup();
    } else {
      ctx.inject(['credentials'], attemptStartup);
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
      resource: async () => {
        // Ask the store rather than trusting the last known value: a secret may
        // have been added or removed while this process was running, and
        // `secretConfigured` must describe the store now.
        if (config.appId) {
          try {
            secretOnDisk = Boolean(await readStoredSecret(ctx, config.appId));
          } catch {
            secretOnDisk = null;
          }
        }
        return json(buildStatus());
      },
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
      path: `${base}/diagnose`,
      resource: async (request) => {
        const url = new URL(request.url);
        // The diagnostic can run without a live connection, which is the point:
        // it names the layer that is broken instead of reporting "not connected".
        const appId = url.searchParams.get('appId') || config.appId || '';
        const stored = config.appSecret || await readStoredSecret(ctx, appId);
        const appSecret = url.searchParams.get('appSecret') || stored || '';
        try {
          const report = await diagnose({
            appId,
            appSecret,
            brand: config.brand,
            logger,
            harness,
          });
          return json(report, report.ok ? 200 : 400);
        } catch (error) {
          // A thrown probe is a bug in the probe, not a verdict; still answer
          // with a well-formed failure so the page can render it.
          return json({
            ok: false,
            appId,
            checks: [],
            focus: {
              layer: 'credentials',
              verdict: 'failed',
              detail: String(error?.message ?? error).slice(0, 300),
              hint: '诊断本身出错，请查看 Harness 日志。',
            },
          }, 500);
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
      secretConfigured: Boolean(config.appSecret) || Boolean(runtime) || secretOnDisk,
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
      /** Configuration fields this plugin could not understand, if any. */
      configProblems: [...config.problems],
      capabilities: harness.available,
      registration: registrationSnapshot(),
      recent: [...diagnostics],
      /** Set once a reply was rejected for out-of-scope availability. */
      availabilityWarning: availabilityWarning(),
      /** The `/` menu reconcile result, or null before it ran. */
      menu: menuReport,
      /**
       * The module's own build id.
       *
       * A loaded ES module keeps its value forever, so comparing this across a
       * reload attempt answers "did the running code actually change?" — which
       * is otherwise invisible from outside the process.
       */
      build: BUILD_ID,
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
      const stored = await writeStoredSecret(ctx, result.appId, result.appSecret, logger);
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
      await writeStoredSecret(ctx, appId, appSecret, logger);
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

  // ---------------------------------------------------------------- exit notice

  /**
   * Tell the operator the bot is going away.
   *
   * A restart is the one disconnect nobody can be told about afterwards, and
   * the socket does not close politely — the process is killed. So the notice
   * is sent from the exit hook itself, with a short deadline: the app is
   * shutting down and must not wait on the network.
   *
   * `beforeExit` cannot await, so the send is started and the process is given
   * a moment to flush it. Signal handlers run first when the OS is asked to
   * terminate, which covers the usual restart path.
   */
  let exitNoticeSent = false;
  const sendExitNotice = (reason) => {
    if (exitNoticeSent) return;
    exitNoticeSent = true;
    const current = runtime;
    const openId = noticeTarget(operators);
    if (!current || !openId || !config.notifyConnection) {
      noteDiagnostic({ kind: 'exit-notice-skipped', hasRuntime: Boolean(current), hasOperator: Boolean(openId) });
      return;
    }
    noteDiagnostic({ kind: 'exit-notice-sent', to: openId, reason });
    void sendConnectionNotice(
      { api: current.api, logger },
      { openId, event: 'disconnected', reason },
    );
  };

  const onSignal = (signal) => {
    sendExitNotice(`应用正在退出（${signal}）`);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(signal, onSignal);
    } catch {
      // A runtime without this signal simply does not offer it.
    }
  }
  process.on('beforeExit', () => sendExitNotice('应用已退出'));
  ctx.effect(() => () => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
      try {
        process.off(signal, onSignal);
      } catch {
        // Nothing was registered for this signal.
      }
    }
  }, 'dsh-feishu-only.exit-hooks()');
}

/** Read the app secret from the credential service. */
async function readStoredSecret(ctx, appId) {
  const credentials = ctx.get?.('credentials');
  if (!credentials?.readRecord || !appId) return null;

  // One fixed key holds the record. Keys written by earlier versions are still
  // tried, because a secret the user already entered must not have to be
  // entered again — and reading an invalid key only costs a caught throw.
  const legacyKeys = [
    `dsh-feishu-only/${legacyIdSegment(appId)}`,
    `dsh-feishu-only:${appId}`,
  ];
  for (const key of [CREDENTIAL_KEY, ...legacyKeys]) {
    try {
      const stored = readBridgeRecord(await credentials.readRecord(key));
      if (!stored) continue;
      // A record that names its app id is only used for that app; one that does
      // not predates the field and is used for any app.
      if (stored.appId !== null && stored.appId !== appId) continue;
      return stored.secret;
    } catch {
      // A missing record, an invalid legacy key, or a store that cannot answer
      // all mean "no stored secret"; the caller falls back to asking the user.
    }
  }
  return null;
}

/**
 * The id segment earlier versions wrote into the key.
 *
 * Kept only so those records can still be found. It is lossy on purpose — that
 * lossiness is why the app id moved into the value — so it is never used for a
 * write.
 */
function legacyIdSegment(appId) {
  return String(appId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^[^a-z]+/u, '') || 'app';
}

async function writeStoredSecret(ctx, appId, secret, logger = console) {
  const credentials = ctx.get?.('credentials');
  if (!credentials?.modifyRecord || !appId || !secret) return false;
  try {
    // A grant record: its payload is arbitrary JSON, so it carries the app id
    // alongside the secret without tripping the api-key field whitelist.
    await credentials.modifyRecord(CREDENTIAL_KEY, async () => ({
      kind: 'grant',
      payload: { appId, secret },
    }));
    return true;
  } catch (error) {
    logger.warn?.(`[feishu] could not store the secret: ${error?.message ?? error}`);
    return false;
  }
}

/**
 * The credential record for this bridge.
 *
 * One fixed key, with the app id stored **in the value**.
 *
 * Two store rules make key-based addressing a trap, and both are enforced over
 * the whole file when it loads:
 *
 * - a key must be exactly two segments, each matching `/^[a-z][a-z0-9-]*$/` —
 *   a Feishu id like `cli_aa605ec29f395ccf` fails the underscore rule;
 * - an `api-key` record accepts only `kind`, `key` and `env`, and an unknown
 *   field is an error, not a warning.
 *
 * So the key is the constant `dsh-feishu-only/app` (always valid), and the
 * record is a **grant**: its `payload` is arbitrary JSON, which is where the app
 * id and the secret live. An `api-key` record cannot carry the app id without
 * failing the second rule.
 */
const CREDENTIAL_KEY = 'dsh-feishu-only/app';

/**
 * Read one bridge record, whichever shape it was written in.
 *
 * @returns {{appId: string|null, secret: string}|null}
 */
function readBridgeRecord(record) {
  if (!record || typeof record !== 'object') return null;
  // The current shape: a grant payload.
  if (record.kind === 'grant') {
    const payload = record.payload;
    if (payload && typeof payload === 'object' && typeof payload.secret === 'string') {
      return {
        appId: typeof payload.appId === 'string' ? payload.appId : null,
        secret: payload.secret,
      };
    }
    return null;
  }
  // Written by earlier versions, before the app id moved into the value.
  if (record.kind === 'api-key' && typeof record.key === 'string') {
    return { appId: null, secret: record.key };
  }
  return null;
}

/** Show only enough of an identifier to recognize it. */
function mask(value) {
  if (typeof value !== 'string' || !value) return null;
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}