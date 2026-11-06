/**
 * Minimal Feishu/Lark OpenAPI client.
 *
 * Only the endpoints this bridge needs are implemented, so the plugin carries
 * no third-party SDK dependency: `fetch` and the tenant token cache are enough.
 *
 * @module dsh-feishu-only/lib/feishu/api
 */

/** Feishu (China) OpenAPI origin. */
export const FEISHU_ORIGIN = 'https://open.feishu.cn';
/** Lark (international) OpenAPI origin. */
export const LARK_ORIGIN = 'https://open.larksuite.com';

/** Resolve the OpenAPI origin for a brand. */
export function originFor(brand) {
  return brand === 'lark' ? LARK_ORIGIN : FEISHU_ORIGIN;
}

/** A rejected Feishu API call: carries the platform `code` and request identity. */
export class FeishuApiError extends Error {
  constructor(operation, code, message, { status, logId, path } = {}) {
    super(`${operation} failed: ${message}${code === undefined ? '' : ` (code ${code})`}`);
    this.name = 'FeishuApiError';
    this.code = code;
    this.status = status;
    this.logId = logId;
    this.path = path;
  }
}

/** Transport-level failure that never produced a platform response. */
export class FeishuTransportError extends Error {
  constructor(operation, cause) {
    super(`${operation} failed: ${cause?.message ?? String(cause)}`, { cause });
    this.name = 'FeishuTransportError';
    this.code = 'transport';
  }
}

const MAX_ERROR_BODY = 2048;

async function readErrorBody(response) {
  try {
    const text = await response.text();
    return text.length > MAX_ERROR_BODY ? `${text.slice(0, MAX_ERROR_BODY)}…` : text;
  } catch {
    return '';
  }
}

/**
 * One tenant access token cache per app.
 *
 * The token is refreshed 60 seconds before expiry; concurrent callers share a
 * single in-flight refresh so a burst of messages cannot stampede the endpoint.
 */
class TenantTokenCache {
  #appId;
  #appSecret;
  #brand;
  #fetch;
  #token = null;
  #expiresAt = 0;
  #pending = null;

  constructor({ appId, appSecret, brand, fetchImpl }) {
    this.#appId = appId;
    this.#appSecret = appSecret;
    this.#brand = brand;
    this.#fetch = fetchImpl;
  }

  invalidate() {
    this.#token = null;
    this.#expiresAt = 0;
    this.#pending = null;
  }

  async get() {
    if (this.#token && Date.now() < this.#expiresAt) return this.#token;
    if (this.#pending) return this.#pending;
    const pending = this.#refresh().finally(() => {
      if (this.#pending === pending) this.#pending = null;
    });
    this.#pending = pending;
    return pending;
  }

  async #refresh() {
    const url = `${originFor(this.#brand)}/open-apis/auth/v3/tenant_access_token/internal`;
    let response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: this.#appId, app_secret: this.#appSecret }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new FeishuTransportError('tenant_access_token', error);
    }
    if (!response.ok) {
      throw new FeishuApiError(
        'tenant_access_token',
        undefined,
        await readErrorBody(response),
        { status: response.status, path: url },
      );
    }
    const body = await response.json();
    if (body?.code !== 0 || !body?.tenant_access_token) {
      throw new FeishuApiError(
        'tenant_access_token',
        body?.code,
        body?.msg ?? 'no tenant_access_token in response',
        { path: url },
      );
    }
    const ttlSeconds = Number.isFinite(body.expire) ? body.expire : 7200;
    this.#token = body.tenant_access_token;
    this.#expiresAt = Date.now() + Math.max(60, ttlSeconds - 60) * 1000;
    return this.#token;
  }
}

/**
 * Feishu OpenAPI client bound to one app credential pair.
 *
 * Every method returns the platform `data` payload; a non-zero `code` rejects
 * with {@link FeishuApiError} so callers never branch on raw bodies.
 */
export class FeishuApi {
  #appId;
  #brand;
  #fetch;
  #tokens;
  #logger;

  constructor({ appId, appSecret, brand = 'feishu', fetchImpl = fetch, logger = null }) {
    if (!appId || !appSecret) throw new TypeError('FeishuApi requires appId and appSecret');
    this.#appId = appId;
    this.#brand = brand;
    this.#fetch = fetchImpl;
    this.#logger = logger;
    this.#tokens = new TenantTokenCache({ appId, appSecret, brand, fetchImpl });
  }

  get appId() {
    return this.#appId;
  }

  get brand() {
    return this.#brand;
  }

  /** Drop the cached tenant token, e.g. after the platform reports it invalid. */
  invalidateToken() {
    this.#tokens.invalidate();
  }

  /** Exchange app credentials for a tenant token (cached). */
  async tenantToken() {
    return this.#tokens.get();
  }

  /**
   * Perform one authenticated OpenAPI call.
   *
   * @param {string} operation human label used in error messages.
   * @param {string} path `/open-apis/...` path including any query string.
   * @param {{ method?: string, body?: unknown, query?: Record<string, string|number|boolean|undefined>, form?: FormData, signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<any>} the platform `data` payload.
   */
  async request(operation, path, options = {}) {
    const {
      method = 'GET',
      body,
      query,
      form,
      signal,
      timeoutMs = 30_000,
    } = options;
    const token = await this.tenantToken();
    const url = new URL(path, originFor(this.#brand));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }

    const headers = { authorization: `Bearer ${token}` };
    let payload;
    if (form) {
      payload = form;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8';
      payload = JSON.stringify(body);
    }

    const timeout = AbortSignal.timeout(timeoutMs);
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        body: payload,
        signal: composed,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new FeishuTransportError(operation, error);
    }

    let parsed;
    try {
      parsed = await response.json();
    } catch {
      if (!response.ok) {
        throw new FeishuApiError(operation, undefined, `HTTP ${response.status}`, {
          status: response.status,
          path: url.pathname,
        });
      }
      throw new FeishuApiError(operation, undefined, 'response was not JSON', {
        status: response.status,
        path: url.pathname,
      });
    }

    const code = parsed?.code;
    if (code !== 0 && code !== undefined) {
      // 99991663/99991661: tenant token expired or invalid — drop it so the
      // next attempt refreshes instead of replaying a dead credential.
      if (code === 99991663 || code === 99991661) this.#tokens.invalidate();
      throw new FeishuApiError(operation, code, parsed?.msg ?? `HTTP ${response.status}`, {
        status: response.status,
        logId: parsed?.log_id ?? response.headers.get('x-tt-logid') ?? undefined,
        path: url.pathname,
      });
    }
    if (!response.ok) {
      throw new FeishuApiError(operation, undefined, `HTTP ${response.status}`, {
        status: response.status,
        path: url.pathname,
      });
    }
    return parsed?.data ?? parsed;
  }

  // ---------------------------------------------------------------- bot info

  /** Read the bot identity of this app (validates the credential pair). */
  async botInfo() {
    const data = await this.request('bot info', '/open-apis/bot/v3/info/', { timeoutMs: 15_000 });
    const bot = data?.bot ?? data ?? {};
    return {
      appId: this.#appId,
      name: bot.app_name ?? bot.bot_name ?? null,
      openId: bot.open_id ?? null,
      activateStatus: bot.activate_status ?? null,
      avatarUrl: bot.avatar_url ?? null,
    };
  }

  // ------------------------------------------------------------------ messages

  /** Send an interactive (card) message to a chat. */
  async sendCard(chatId, card, options = {}) {
    return this.request('send card', '/open-apis/im/v1/messages', {
      method: 'POST',
      query: { receive_id_type: 'chat_id' },
      body: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
        ...(options.uuid ? { uuid: options.uuid } : {}),
      },
      signal: options.signal,
    });
  }

  /** Send a plain text message to a chat. */
  async sendText(chatId, text, options = {}) {
    return this.request('send text', '/open-apis/im/v1/messages', {
      method: 'POST',
      query: { receive_id_type: 'chat_id' },
      body: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
        ...(options.uuid ? { uuid: options.uuid } : {}),
      },
      signal: options.signal,
    });
  }

  /** Send a raw message type (`image`, `file`, ...) to a chat. */
  async sendMessage(chatId, msgType, content, options = {}) {
    return this.request(`send ${msgType}`, '/open-apis/im/v1/messages', {
      method: 'POST',
      query: { receive_id_type: 'chat_id' },
      body: {
        receive_id: chatId,
        msg_type: msgType,
        content: JSON.stringify(content),
        ...(options.uuid ? { uuid: options.uuid } : {}),
      },
      signal: options.signal,
    });
  }

  /** Update the card of an already-sent interactive message. */
  async patchCard(messageId, card) {
    return this.request('update card', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      body: { content: JSON.stringify(card) },
      timeoutMs: 20_000,
    });
  }

  /** Reply to one message inside its thread (used for preview/delivery only). */
  async replyCard(messageId, card) {
    return this.request('reply card', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      method: 'POST',
      body: { msg_type: 'interactive', content: JSON.stringify(card) },
      timeoutMs: 20_000,
    });
  }

  /** Send an image message by image_key. */
  async sendImage(chatId, imageKey, options = {}) {
    return this.sendMessage(chatId, 'image', { image_key: imageKey }, options);
  }

  /** Send a file message by file_key. */
  async sendFile(chatId, fileKey, options = {}) {
    return this.sendMessage(chatId, 'file', { file_key: fileKey }, options);
  }

  /** Delete (recall) one bot message. */
  async deleteMessage(messageId) {
    return this.request('delete message', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
      timeoutMs: 15_000,
    });
  }

  // ------------------------------------------------------------------ resources

  /** Download a message resource (image or file) as bytes. */
  async downloadResource(messageId, fileKey, type = 'file', signal) {
    const token = await this.tenantToken();
    const url = new URL(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`,
      originFor(this.#brand),
    );
    url.searchParams.set('type', type);
    let response;
    try {
      response = await this.#fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: signal ?? AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new FeishuTransportError('download resource', error);
    }
    if (!response.ok) {
      throw new FeishuApiError('download resource', undefined, await readErrorBody(response), {
        status: response.status,
      });
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? '';
    const disposition = response.headers.get('content-disposition') ?? '';
    return { data: buffer, contentType, disposition };
  }

  /** Upload an image for use in an image message. */
  async uploadImage(data, { name, imageType = 'message', signal } = {}) {
    const form = new FormData();
    form.append('image_type', imageType);
    form.append('image', new Blob([data]), name ?? 'image.png');
    const result = await this.request('upload image', '/open-apis/im/v1/images', {
      method: 'POST',
      form,
      signal,
      timeoutMs: 60_000,
    });
    if (!result?.image_key) throw new FeishuApiError('upload image', undefined, 'no image_key returned');
    return result.image_key;
  }

  /** Upload a file for use in a file message. */
  async uploadFile(data, { name, fileType = 'stream', durationMs, signal } = {}) {
    const form = new FormData();
    form.append('file_type', fileType);
    form.append('file_name', name ?? 'file');
    if (durationMs !== undefined) form.append('duration', String(durationMs));
    form.append('file', new Blob([data]), name ?? 'file');
    const result = await this.request('upload file', '/open-apis/im/v1/files', {
      method: 'POST',
      form,
      signal,
      timeoutMs: 180_000,
    });
    if (!result?.file_key) throw new FeishuApiError('upload file', undefined, 'no file_key returned');
    return result.file_key;
  }

  // --------------------------------------------------------------------- chats

  /** Read one chat's metadata (title, type, member count). */
  async getChat(chatId) {
    const data = await this.request('get chat', `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, {
      timeoutMs: 15_000,
    });
    return data;
  }

  /** Send a "processing" reaction-free notice to a user's private chat. */
  async openPrivateChat(openId) {
    return this.request('open private chat', '/open-apis/im/v1/chats', {
      method: 'POST',
      body: { chat_mode: 'p2p', chat_type: 'p2p' },
      query: { user_id_type: 'open_id' },
    }).catch(() => undefined);
  }

  /** Post a text message to one user's private chat (approvals + questions). */
  async sendPrivateCard(openId, card, options = {}) {
    return this.request('send private card', '/open-apis/im/v1/messages', {
      method: 'POST',
      query: { receive_id_type: 'open_id' },
      body: {
        receive_id: openId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
        ...(options.uuid ? { uuid: options.uuid } : {}),
      },
      signal: options.signal,
      timeoutMs: 20_000,
    });
  }

  // ------------------------------------------------------- slash command menu

  /**
   * List the app's registered slash commands.
   *
   * Feishu shows these in the `/` panel of a chat, so the menu is the only
   * discoverable entry point for the bridge's commands.
   */
  async listSlashCommands() {
    const data = await this.request('list slash commands', SLASH_ENDPOINT, {
      query: { page_size: 100 },
      timeoutMs: 15_000,
    });
    return (data?.items ?? []).map((item) => ({
      commandId: item.command_id,
      command: item.command,
      description: item.description?.default_value ?? '',
    }));
  }

  /**
   * Register one slash command.
   *
   * The description carries the icon key; Feishu stores both in the same
   * object, so a command without a description still gets its icon.
   */
  async createSlashCommand({ command, description, icon }) {
    const body = { command };
    if (description) body.description = { default_value: description };
    if (icon) body.description = { ...(body.description ?? {}), icon: { icon_key: icon } };
    const data = await this.request('create slash command', SLASH_ENDPOINT, {
      method: 'POST',
      body,
      timeoutMs: 15_000,
    });
    return data?.command_id ?? null;
  }

  /** Remove one registered slash command. */
  async deleteSlashCommand(commandId) {
    return this.request(
      'delete slash command',
      `${SLASH_ENDPOINT}/${encodeURIComponent(commandId)}`,
      { method: 'DELETE', timeoutMs: 15_000 },
    );
  }
}

const SLASH_ENDPOINT = '/open-apis/application/v7/app_slash_commands';