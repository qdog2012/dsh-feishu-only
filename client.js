/**
 * Feishu bot settings section for the Harness Web UI.
 *
 * The page is the front door for onboarding: it starts a scan-to-create
 * device authorization, shows the verification QR, or accepts an existing
 * App ID / Secret. It talks to this plugin's own Host routes, so it depends on
 * no Harness Client package beyond `react` and the locale/slots services.
 *
 * @module dsh-feishu-only/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-feishu-only',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-feishu-only';
    const API = '/plugins/dsh-feishu-only';

    // ------------------------------------------------------------------ texts

    const zh = {
      title: '飞书机器人',
      subtitle: '把飞书聊天接入 DeepSeek Harness：扫码创建机器人，或填写已有的 App ID / Secret。',
      statusTitle: '当前状态',
      botLayer: '机器人',
      messageLayer: '消息连接',
      executorLayer: '执行端',
      layerReady: '就绪',
      layerNotReady: '未就绪',
      notConnected: '尚未连接',
      unknown: '未知',
      refresh: '刷新',
      connecting: '连接中…',
      connected: '已连接',
      disconnected: '未连接',
      reconnect: '重新连接',
      disconnect: '断开连接',
      disconnectConfirm: '断开后会停止接收飞书消息，App ID 会保留，Secret 需要重新填写。确认断开？',

      createTitle: '① 扫码创建新机器人',
      createBlurb:
        '用飞书手机客户端扫码，飞书会按本插件需要的权限创建并发布应用；授权完成后这里会自动完成连接。',
      createStart: '生成授权二维码',
      createRestart: '重新生成二维码',
      qrWaiting: '等待扫码…',
      qrScanned: '已授权，正在连接…',
      qrExpired: '二维码已过期，请重新生成。',
      qrCancelled: '已取消。',
      qrOpenLink: '无法扫码？打开授权链接',
      qrExpiresAt: '有效期至',
      qrCancel: '取消',

      manualTitle: '② 连接已有机器人',
      manualBlurb:
        '已有机器人应用时填入凭据。保存前会先验证它能否读到自身身份，验证失败的凭据不会被保存。',
      appIdLabel: 'App ID',
      appIdPlaceholder: 'cli_xxxxxxxxxxxxxxxx',
      appSecretLabel: 'App Secret',
      appSecretPlaceholder: '粘贴 App Secret',
      appSecretNote: 'Secret 保存在凭据库中，不会回显在本页或配置文件中。',
      brandLabel: '平台',
      brandFeishu: '飞书（中国版）',
      brandLark: 'Lark（国际版）',
      save: '保存并连接',
      saving: '验证中…',
      saved: '已连接',
      required: '请填写 App ID 与 App Secret。',

      verifyTitle: '接入检查',
      verify: '检查接入',
      verifying: '检查中…',
      diagnose: '诊断连接',
      diagnosing: '诊断中…',
      diagnoseClean: '各层均通过，未发现问题。',
      layerCredentials: '凭据',
      helpTitle: '需要平台配置时',
      helpBody:
        '机器人能力、消息权限、事件订阅与卡片回调都必须开启，并且“事件配置”和“回调配置”两处都要设为“使用长连接接收”。扫码创建的应用已自动配置好这些。',
      helpDocs: '打开飞书开放平台',

      errorPrefix: '出错了',
      advancedTitle: '高级设置',
      advancedHint: '这些项在插件配置里修改，保存后从下一轮生效。',
    };

    const en = {
      title: 'Feishu bot',
      subtitle: 'Connect Feishu chats to DeepSeek Harness by scanning a QR code or entering an existing App ID / Secret.',
      statusTitle: 'Current status',
      botLayer: 'Bot',
      messageLayer: 'Messages',
      executorLayer: 'Executor',
      layerReady: 'Ready',
      layerNotReady: 'Not ready',
      notConnected: 'Not connected',
      unknown: 'Unknown',
      refresh: 'Refresh',
      connecting: 'Connecting…',
      connected: 'Connected',
      disconnected: 'Disconnected',
      reconnect: 'Reconnect',
      disconnect: 'Disconnect',
      disconnectConfirm: 'Disconnecting stops Feishu messages. The App ID is kept; the Secret must be entered again. Continue?',

      createTitle: '1. Create a bot by scanning',
      createBlurb:
        'Scan with the Feishu mobile app. Feishu creates and publishes an app with exactly the scopes this bridge uses, and the connection completes here automatically.',
      createStart: 'Generate authorization QR',
      createRestart: 'Generate a new QR',
      qrWaiting: 'Waiting for the scan…',
      qrScanned: 'Authorized, connecting…',
      qrExpired: 'The QR code expired. Generate a new one.',
      qrCancelled: 'Cancelled.',
      qrOpenLink: 'Cannot scan? Open the authorization link',
      qrExpiresAt: 'Expires at',
      qrCancel: 'Cancel',

      manualTitle: '2. Connect an existing bot',
      manualBlurb:
        'Enter the credentials of an app you already have. They are verified against the bot identity before they are saved, so a pair that cannot be used is rejected.',
      appIdLabel: 'App ID',
      appIdPlaceholder: 'cli_xxxxxxxxxxxxxxxx',
      appSecretLabel: 'App Secret',
      appSecretPlaceholder: 'Paste the App Secret',
      appSecretNote: 'The secret is stored in the credential store and is never echoed here or in the profile file.',
      brandLabel: 'Platform',
      brandFeishu: 'Feishu (China)',
      brandLark: 'Lark (international)',
      save: 'Save and connect',
      saving: 'Verifying…',
      saved: 'Connected',
      required: 'Enter both the App ID and the App Secret.',

      verifyTitle: 'Connection checks',
      verify: 'Run checks',
      verifying: 'Checking…',
      diagnose: 'Diagnose',
      diagnosing: 'Diagnosing…',
      diagnoseClean: 'Every layer passed; nothing looks wrong.',
      layerCredentials: 'Credentials',
      helpTitle: 'If you configure the app yourself',
      helpBody:
        'The bot capability, message scopes, the message event and the card callback must all be enabled, and BOTH the event and callback subscriptions must use the long connection. An app created by the QR flow is already configured.',
      helpDocs: 'Open the Feishu developer console',

      errorPrefix: 'Something went wrong',
      advancedTitle: 'Advanced',
      advancedHint: 'These are plugin config fields; changes apply from the next round.',
    };

    // ----------------------------------------------------------------- styles

    const CSS = `
.dfo-page { display: flex; flex-direction: column; gap: 20px; padding: 4px 2px 32px; max-width: 760px; }
.dfo-page h2 { margin: 0; font-size: 17px; font-weight: 600; color: var(--dsw-alias-text-primary); }
.dfo-page p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-text-secondary); }
.dfo-card {
  display: flex; flex-direction: column; gap: 14px; padding: 16px 18px;
  border: 1px solid var(--dsw-alias-border-subtle); border-radius: 10px;
  background: var(--dsw-alias-bg-elevated, transparent);
}
.dfo-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dfo-card-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-text-primary); margin: 0; }
.dfo-sub { font-size: 12px; color: var(--dsw-alias-text-tertiary); }
.dfo-rows { display: flex; flex-direction: column; gap: 8px; }
.dfo-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; }
.dfo-row-label { color: var(--dsw-alias-text-secondary); }
.dfo-row-value { color: var(--dsw-alias-text-primary); display: flex; align-items: center; gap: 6px; }
.dfo-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dfo-dot-ok { background: var(--dsw-alias-state-success, #2ea043); }
.dfo-dot-bad { background: var(--dsw-alias-state-danger, #d1242f); }
.dfo-dot-warn { background: var(--dsw-alias-state-warning, #bf8700); }
.dfo-dot-idle { background: var(--dsw-alias-text-tertiary, #8b949e); }
.dfo-btn {
  appearance: none; border: 1px solid var(--dsw-alias-border-subtle);
  background: var(--dsw-alias-bg-subtle, transparent); color: var(--dsw-alias-text-primary);
  font: inherit; font-size: 13px; padding: 6px 14px; border-radius: 8px; cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.dfo-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-hover, rgba(127,127,127,0.12)); }
.dfo-btn:disabled { opacity: 0.55; cursor: default; }
.dfo-btn-primary {
  background: var(--dsw-alias-accent-primary, #3370ff);
  border-color: var(--dsw-alias-accent-primary, #3370ff);
  color: var(--dsw-alias-text-on-accent, #fff);
}
.dfo-btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
.dfo-btn-danger { color: var(--dsw-alias-state-danger, #d1242f); }
.dfo-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dfo-field { display: flex; flex-direction: column; gap: 6px; }
.dfo-label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-text-secondary); }
.dfo-input {
  font: inherit; font-size: 13px; padding: 7px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-subtle);
  background: var(--dsw-alias-bg-input, var(--dsw-alias-bg-base, transparent));
  color: var(--dsw-alias-text-primary); width: 100%; box-sizing: border-box;
}
.dfo-input:focus { outline: 2px solid var(--dsw-alias-accent-primary, #3370ff); outline-offset: 0; }
.dfo-select { max-width: 220px; }
.dfo-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.dfo-qr-wrap { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 8px 0; }
.dfo-qr {
  width: 208px; height: 208px; border-radius: 10px; background: #fff; padding: 8px;
  border: 1px solid var(--dsw-alias-border-subtle); display: block;
}
.dfo-note {
  font-size: 12px; line-height: 1.6; color: var(--dsw-alias-text-tertiary);
  border-left: 2px solid var(--dsw-alias-border-subtle); padding-left: 10px;
}
.dfo-alert {
  font-size: 12.5px; line-height: 1.6; padding: 9px 12px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-subtle);
}
.dfo-alert-error { color: var(--dsw-alias-state-danger, #d1242f); border-color: currentColor; }
.dfo-alert-ok { color: var(--dsw-alias-state-success, #2ea043); border-color: currentColor; }
.dfo-alert-info { color: var(--dsw-alias-text-secondary); }
.dfo-alert-warn { color: var(--dsw-alias-state-warning, #bf8700); border-color: currentColor; }
.dfo-diagnosis { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.dfo-steps { margin: 0; padding-left: 18px; font-size: 12.5px; line-height: 1.8; color: var(--dsw-alias-text-secondary); }
.dfo-link { color: var(--dsw-alias-accent-primary, #3370ff); text-decoration: none; font-size: 12.5px; }
.dfo-link:hover { text-decoration: underline; }
`;

    function ensureStyles() {
      if (typeof document === 'undefined') return () => {};
      const selector = `style[data-plugin-css="${NS}"]`;
      let tag = document.querySelector(selector);
      if (!tag) {
        tag = document.createElement('style');
        tag.dataset.plugin = NS;
        tag.dataset.pluginCss = NS;
        document.head.appendChild(tag);
      }
      tag.textContent = CSS;
      return () => tag.remove();
    }

    // -------------------------------------------------------------- utilities

    async function getJson(path) {
      const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
      const body = await response.json().catch(() => ({}));
      return { ok: response.ok, status: response.status, body };
    }

    /**
     * Render a QR code without a library.
     *
     * The Host returns a verification URL; rather than shipping a QR encoder in
     * the client, the page asks the Host for the SVG so the encoder lives once.
     */
    function Qr({ src, alt }) {
      return h('img', { className: 'dfo-qr', src, alt });
    }

    function Row({ label, value, tone }) {
      return h('div', { className: 'dfo-row' },
        h('span', { className: 'dfo-row-label' }, label),
        h('span', { className: 'dfo-row-value' },
          h('span', { className: `dfo-dot dfo-dot-${tone}` }),
          value));
    }

    function Alert({ kind, children }) {
      if (!children) return null;
      return h('div', { className: `dfo-alert dfo-alert-${kind}` }, children);
    }

    // ------------------------------------------------------------------- page

    function FeishuSettingsPage({ t }) {
      const [status, setStatus] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [verification, setVerification] = React.useState(null);
      const [qrSvg, setQrSvg] = React.useState(null);
      /** Report from the layered diagnostic, or null before it ran. */
      const [diagnosis, setDiagnosis] = React.useState(null);

      const [appId, setAppId] = React.useState('');
      const [appSecret, setAppSecret] = React.useState('');
      const [brand, setBrand] = React.useState('feishu');

      const refresh = React.useCallback(async () => {
        try {
          const { body } = await getJson(`${API}/status`);
          if (body && body.ok) setStatus(body);
        } catch {
          // A failed poll keeps the last known state instead of blanking the page.
        }
      }, []);

      // Poll while a registration is waiting so the page follows the scan.
      React.useEffect(() => {
        let alive = true;
        void refresh();
        const timer = setInterval(async () => {
          if (!alive) return;
          try {
            const { body } = await getJson(`${API}/status`);
            if (!alive || !body?.ok) return;
            setStatus(body);
          } catch {
            // Keep the last state.
          }
        }, 3000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [refresh]);

      const registration = status?.registration ?? { state: 'idle' };
      const waiting = ['starting', 'waiting', 'slow_down'].includes(registration.state);

      // Fetch the QR image whenever the Host reports a new verification URL.
      React.useEffect(() => {
        if (!registration.qrCodeUrl) {
          setQrSvg(null);
          return;
        }
        let alive = true;
        void (async () => {
          try {
            const response = await fetch(
              `${API}/qr-image?url=${encodeURIComponent(registration.qrCodeUrl)}`,
              { cache: 'no-store', credentials: 'same-origin' },
            );
            if (!response.ok) return;
            const svg = await response.text();
            if (alive) setQrSvg(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
          } catch {
            // Without an image the link below is still a working fallback.
          }
        })();
        return () => {
          alive = false;
        };
      }, [registration.qrCodeUrl]);

      const startRegistration = async () => {
        setError(null);
        setNotice(null);
        setBusy('qr');
        try {
          const { body } = await getJson(`${API}/qr?start=1`);
          if (!body?.ok) setError(body?.error ?? 'unknown');
          else setStatus((prev) => ({ ...(prev ?? {}), registration: body.registration }));
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(null);
        }
      };

      const cancelRegistration = async () => {
        setBusy('cancel');
        try {
          await getJson(`${API}/qr/cancel?cancel=1`);
          await refresh();
        } finally {
          setBusy(null);
        }
      };

      const connect = async (event) => {
        event.preventDefault();
        setError(null);
        setNotice(null);
        if (!appId.trim() || !appSecret.trim()) {
          setError(t('required'));
          return;
        }
        setBusy('save');
        try {
          const query = new URLSearchParams({
            appId: appId.trim(),
            appSecret: appSecret.trim(),
            brand,
          });
          const { body } = await getJson(`${API}/connect?${query.toString()}`);
          if (!body?.ok) {
            setError(body?.error ?? 'unknown');
            return;
          }
          // The secret is never kept in page state after a successful save.
          setAppSecret('');
          setNotice(t('saved'));
          await refresh();
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(null);
        }
      };

      const runVerify = async () => {
        setBusy('verify');
        setVerification(null);
        try {
          const { body } = await getJson(`${API}/verify`);
          setVerification(body);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(null);
        }
      };

      /**
       * Run the layered diagnostic.
       *
       * Unlike `verify`, this works before a connection exists — that is the
       * case it is for — and it names the first broken layer so the user knows
       * which console setting to change.
       */
      const runDiagnose = async () => {
        setBusy('diagnose');
        setDiagnosis(null);
        try {
          const query = new URLSearchParams();
          const formId = (appId ?? '').trim();
          const formSecret = (appSecret ?? '').trim();
          if (formId) query.set('appId', formId);
          if (formSecret) query.set('appSecret', formSecret);
          const suffix = query.toString() ? `?${query.toString()}` : '';
          const { body } = await getJson(`${API}/diagnose${suffix}`);
          setDiagnosis(body);
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(null);
        }
      };

      const disconnect = async () => {
        if (typeof window !== 'undefined' && !window.confirm(t('disconnectConfirm'))) return;
        setBusy('disconnect');
        try {
          await getJson(`${API}/disconnect?confirm=1`);
          setVerification(null);
          await refresh();
        } finally {
          setBusy(null);
        }
      };

      const connected = status?.connected === true;
      const messagesOk = status?.connection?.messages === 'connected';

      return h('div', { className: 'dfo-page' },
        h('div', null,
          h('h2', null, t('title')),
          h('p', { style: { marginTop: 6 } }, t('subtitle'))),

        // ------------------------------------------------------------ status
        h('section', { className: 'dfo-card' },
          h('div', { className: 'dfo-card-head' },
            h('h3', { className: 'dfo-card-title' }, t('statusTitle')),
            h('div', { className: 'dfo-actions' },
              h('button', {
                className: 'dfo-btn', type: 'button',
                onClick: () => void refresh(), disabled: busy !== null,
              }, t('refresh')))),
          h('div', { className: 'dfo-rows' },
            h(Row, {
              label: t('botLayer'),
              value: connected
                ? (status?.bot?.name ?? t('connected'))
                : (status?.lastError ? t('layerNotReady') : t('notConnected')),
              tone: connected ? 'ok' : (status?.lastError ? 'bad' : 'idle'),
            }),
            h(Row, {
              label: t('messageLayer'),
              value: messagesOk ? t('connected') : (status?.connection?.messages ?? t('unknown')),
              tone: messagesOk ? 'ok' : 'idle',
            }),
            h(Row, {
              label: t('executorLayer'),
              value: status?.capabilities?.agents ? t('layerReady') : t('layerNotReady'),
              tone: status?.capabilities?.agents ? 'ok' : 'bad',
            }),
            status?.appId
              ? h(Row, { label: t('appIdLabel'), value: status.appId, tone: 'idle' })
              : null),
          status?.lastError ? h(Alert, { kind: 'error' }, status.lastError) : null,
          status?.availabilityWarning
            ? h(Alert, { kind: 'error' }, status.availabilityWarning)
            : null,
          h('div', { className: 'dfo-actions' },
            h('button', {
              className: 'dfo-btn', type: 'button', disabled: busy !== null,
              onClick: () => void runVerify(),
            }, busy === 'verify' ? t('verifying') : t('verify')),
            h('button', {
              className: 'dfo-btn', type: 'button', disabled: busy !== null,
              onClick: () => void runDiagnose(),
            }, busy === 'diagnose' ? t('diagnosing') : t('diagnose')),
            connected
              ? h('button', {
                  className: 'dfo-btn dfo-btn-danger', type: 'button',
                  disabled: busy !== null, onClick: () => void disconnect(),
                }, t('disconnect'))
              : null),
          verification
            ? h('div', { className: 'dfo-rows' },
                (verification.checks ?? []).map((check) => h(Row, {
                  key: check.name,
                  label: check.name,
                  value: check.detail,
                  tone: check.ok ? 'ok' : 'bad',
                })))
            : null,
          // The diagnostic works before a connection exists, and names the
          // first broken layer so the fix is a specific console change.
          diagnosis
            ? h('div', { className: 'dfo-diagnosis' },
                diagnosis.focus
                  ? h(Alert, {
                      kind: diagnosis.focus.verdict === 'failed' ? 'error' : 'info',
                    },
                      `${diagnosis.focus.layer === 'credentials' ? t('layerCredentials')
                        : (diagnosis.checks.find((c) => c.layer === diagnosis.focus.layer)?.name
                          ?? diagnosis.focus.layer)}：${diagnosis.focus.detail}`
                      + (diagnosis.focus.hint ? ` — ${diagnosis.focus.hint}` : ''))
                  : h(Alert, { kind: 'info' }, t('diagnoseClean')),
                h('div', { className: 'dfo-rows' },
                  (diagnosis.checks ?? []).map((check) => h(Row, {
                    key: check.layer,
                    label: check.name,
                    value: check.detail,
                    tone: check.verdict === 'ok' ? 'ok'
                      : check.verdict === 'warning' ? 'warn' : 'bad',
                  }))))
            : null),

        // ------------------------------------------------------------ QR flow
        h('section', { className: 'dfo-card' },
          h('h3', { className: 'dfo-card-title' }, t('createTitle')),
          h('p', null, t('createBlurb')),
          waiting
            ? h('div', { className: 'dfo-qr-wrap' },
                qrSvg ? h(Qr, { src: qrSvg, alt: t('createTitle') }) : null,
                h('p', { className: 'dfo-sub' },
                  registration.state === 'waiting' || registration.state === 'slow_down'
                    ? t('qrWaiting')
                    : t('connecting')),
                registration.expiresAt
                  ? h('p', { className: 'dfo-sub' },
                      `${t('qrExpiresAt')} ${new Date(registration.expiresAt).toLocaleTimeString()}`)
                  : null,
                registration.qrCodeUrl
                  ? h('a', {
                      className: 'dfo-link', href: registration.qrCodeUrl,
                      target: '_blank', rel: 'noreferrer noopener',
                    }, t('qrOpenLink'))
                  : null,
                h('button', {
                  className: 'dfo-btn', type: 'button', disabled: busy !== null,
                  onClick: () => void cancelRegistration(),
                }, t('qrCancel')))
            : h('div', { className: 'dfo-actions' },
                h('button', {
                  className: 'dfo-btn dfo-btn-primary', type: 'button',
                  disabled: busy !== null, onClick: () => void startRegistration(),
                }, busy === 'qr' ? t('connecting')
                  : (registration.state === 'succeeded' ? t('createRestart') : t('createStart')))),
          registration.state === 'expired'
            ? h(Alert, { kind: 'error' }, t('qrExpired'))
            : registration.state === 'cancelled'
              ? h(Alert, { kind: 'ok' }, t('qrCancelled'))
              : registration.error
                ? h(Alert, { kind: 'error' }, registration.error)
                : null),
        error ? h(Alert, { kind: 'error' }, `${t('errorPrefix')}: ${error}`) : null,
        notice ? h(Alert, { kind: 'ok' }, notice) : null,

        // -------------------------------------------------------------- manual
        h('section', { className: 'dfo-card' },
          h('h3', { className: 'dfo-card-title' }, t('manualTitle')),
          h('p', null, t('manualBlurb')),
          h('form', { onSubmit: connect, style: { display: 'contents' } },
            h('div', { className: 'dfo-field' },
              h('label', { className: 'dfo-label', htmlFor: 'dfo-appid' }, t('appIdLabel')),
              h('input', {
                id: 'dfo-appid', className: 'dfo-input', type: 'text',
                value: appId, placeholder: t('appIdPlaceholder'),
                autoComplete: 'off', spellCheck: false,
                onChange: (event) => setAppId(event.target.value),
              })),
            h('div', { className: 'dfo-field' },
              h('label', { className: 'dfo-label', htmlFor: 'dfo-secret' }, t('appSecretLabel')),
              h('input', {
                id: 'dfo-secret', className: 'dfo-input', type: 'password',
                value: appSecret, placeholder: t('appSecretPlaceholder'),
                autoComplete: 'new-password', spellCheck: false,
                onChange: (event) => setAppSecret(event.target.value),
              }),
              h('p', { className: 'dfo-sub' }, t('appSecretNote'))),
            h('div', { className: 'dfo-field' },
              h('label', { className: 'dfo-label', htmlFor: 'dfo-brand' }, t('brandLabel')),
              h('select', {
                id: 'dfo-brand', className: 'dfo-input dfo-select', value: brand,
                onChange: (event) => setBrand(event.target.value),
              },
                h('option', { value: 'feishu' }, t('brandFeishu')),
                h('option', { value: 'lark' }, t('brandLark')))),
            h('div', { className: 'dfo-actions' },
              h('button', {
                className: 'dfo-btn dfo-btn-primary', type: 'submit',
                disabled: busy !== null,
              }, busy === 'save' ? t('saving') : t('save'))))),

        // ---------------------------------------------------------------- help
        h('section', { className: 'dfo-card' },
          h('h3', { className: 'dfo-card-title' }, t('helpTitle')),
          h('p', null, t('helpBody')),
          h('a', {
            className: 'dfo-link', href: 'https://open.feishu.cn/app',
            target: '_blank', rel: 'noreferrer noopener',
          }, t('helpDocs'))));
    }

    // ------------------------------------------------------------------ apply

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-feishu-only: dictionaries');
        ctx.effect(() => ensureStyles(), 'dsh-feishu-only: styles');
        const t = ctx.locale.bind(NS);

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: NS,
          order: 18,
          label: () => t('title'),
          locale: NS,
        }, () => h(FeishuSettingsPage, { t })));
      },
    };
  },
});