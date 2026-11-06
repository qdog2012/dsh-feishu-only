/**
 * Feishu "scan to create an app" onboarding.
 *
 * Feishu exposes an RFC 8628 style device-authorization variant on the
 * accounts host: `begin` returns a verification URL plus a device code, and
 * `poll` yields the freshly provisioned `client_id` / `client_secret` once the
 * user finishes the flow in their Feishu client. The user's QR scan is what
 * creates and publishes the app, so no developer-console visit is required.
 *
 * @module dsh-feishu-only/lib/feishu/registration
 */

import { gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';

const FEISHU_ACCOUNTS = 'https://accounts.feishu.cn';
const LARK_ACCOUNTS = 'https://accounts.larksuite.com';
const REGISTRATION_PATH = '/oauth/v1/app/registration';
const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRY_SECONDS = 600;
const SLOW_DOWN_STEP_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 60;

/**
 * Encode an `addons` request as the confirm page expects it:
 * JSON -> gzip -> base64url without padding.
 *
 * The page reads `addons` to show (and grant) exactly the scopes, events and
 * callbacks the integration needs, so the created app needs no console edits.
 */
export function encodeAddons(addons) {
  const json = JSON.stringify(addons);
  const gzipped = gzipSync(Buffer.from(json, 'utf8'));
  return gzipped
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

/**
 * Build the addon manifest for this bridge.
 *
 * `preset: false` is deliberate: the flow then shows only these declarations
 * instead of an undocumented server-side default template, so the granted
 * capability set matches what the plugin actually implements.
 *
 * @param {{ extraScopes?: string[] }} [options]
 */
export function bridgeAddons({ extraScopes = [] } = {}) {
  const tenantScopes = [
    'im:message',
    'im:message:send_as_bot',
    'im:message:readonly',
    'im:message.p2p_msg:readonly',
    'im:message.group_at_msg:readonly',
    'im:resource',
    'im:chat:read',
    'im:chat:create',
    ...extraScopes,
  ];
  return {
    preset: false,
    scopes: { tenant: [...new Set(tenantScopes)] },
    events: { items: { tenant: ['im.message.receive_v1', 'im.chat.access_event.bot_p2p_chat_entered_v1'] } },
    callbacks: { items: ['card.action.trigger'] },
  };
}

function accountsOrigin(brand) {
  return brand === 'lark' ? LARK_ACCOUNTS : FEISHU_ACCOUNTS;
}

async function postRegistration(origin, params, signal, fetchImpl = fetch) {
  const body = new URLSearchParams(params).toString();
  const response = await fetchImpl(`${origin}${REGISTRATION_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  // RFC 8628 outcomes (authorization_pending, slow_down, …) arrive as HTTP 400
  // with a JSON body, so parse first and only then look at the status.
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    throw new Error(`app registration failed: HTTP ${response.status}`);
  }
  return parsed;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('registration aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('registration aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Terminal registration failures surfaced to the caller by code. */
export const REGISTRATION_STATE = Object.freeze({
  STARTING: 'starting',
  WAITING: 'waiting',
  SLOW_DOWN: 'slow_down',
  SUCCEEDED: 'succeeded',
  EXPIRED: 'expired',
  DENIED: 'denied',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

/**
 * Run one scan-to-create session.
 *
 * Resolves with `{ appId, appSecret, userInfo, brand }` after the user
 * authorizes; rejects on expiry, denial, cancellation or transport failure.
 * `onQrCode` receives the verification URL before the first poll so the caller
 * can render a QR for every platform.
 *
 * @param {{
 *   brand?: 'feishu' | 'lark',
 *   appName?: string,
 *   appDescription?: string,
 *   avatarUrls?: string[],
 *   addons?: object,
 *   source?: string,
 *   createOnly?: boolean,
 *   signal?: AbortSignal,
 *   onQrCode?: (info: { url: string, expiresAt: number, userCode?: string }) => void,
 *   onState?: (state: string, detail?: object) => void,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>,
 * }} [options]
 */
export async function registerFeishuApp(options = {}) {
  const {
    brand = 'feishu',
    appName,
    appDescription,
    avatarUrls,
    addons = bridgeAddons(),
    source = 'dsh-feishu-only',
    createOnly = false,
    signal,
    onQrCode,
    onState = () => {},
    now = Date.now,
    sleepImpl = sleep,
    fetchImpl = fetch,
  } = options;

  let origin = accountsOrigin(brand);
  const begin = await postRegistration(origin, {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  }, signal, fetchImpl);

  if (!begin?.device_code || !begin?.verification_uri_complete) {
    const detail = begin?.error_description ?? begin?.error ?? 'missing device_code';
    throw Object.assign(new Error(`app registration begin failed: ${detail}`), {
      code: begin?.error ?? 'begin_failed',
    });
  }

  const intervalSeconds = Number.isFinite(begin.interval)
    ? clampInterval(begin.interval)
    : DEFAULT_INTERVAL_SECONDS;
  const expirySeconds = Number.isFinite(begin.expires_in)
    ? begin.expires_in : DEFAULT_EXPIRY_SECONDS;
  const expiresAt = now() + expirySeconds * 1000;

  const qrUrl = new URL(begin.verification_uri_complete);
  // Marks that the scan came from an SDK-style integration; the landing page
  // only prints these, but the platform uses them for attribution.
  qrUrl.searchParams.set('from', 'sdk');
  qrUrl.searchParams.set('tp', 'sdk');
  qrUrl.searchParams.set('source', source);
  if (appName) qrUrl.searchParams.set('name', appName);
  if (appDescription) qrUrl.searchParams.set('desc', appDescription);
  for (const avatar of avatarUrls ?? []) {
    if (typeof avatar === 'string' && avatar) qrUrl.searchParams.append('avatar', avatar);
  }
  if (addons && Object.keys(addons).length > 0) {
    qrUrl.searchParams.set('addons', encodeAddons(addons));
  }
  if (createOnly) qrUrl.searchParams.set('createOnly', 'true');

  onQrCode?.({ url: qrUrl.toString(), expiresAt, userCode: begin.user_code });
  onState(REGISTRATION_STATE.WAITING, { expiresAt });

  let intervalMs = intervalSeconds * 1000;
  let domainSwitched = false;

  while (true) {
    if (signal?.aborted) {
      onState(REGISTRATION_STATE.CANCELLED);
      throw Object.assign(new Error('app registration cancelled'), { code: 'cancelled' });
    }
    if (now() >= expiresAt) {
      onState(REGISTRATION_STATE.EXPIRED);
      throw Object.assign(new Error('the authorization QR code expired'), { code: 'expired_token' });
    }

    let poll;
    try {
      // The wait itself is abortable: a cancellation must end the loop here,
      // not escape as a raw sleep error the caller cannot classify.
      await sleepImpl(intervalMs, signal);
      poll = await postRegistration(origin, {
        action: 'poll',
        device_code: begin.device_code,
      }, signal, fetchImpl);
    } catch (error) {
      if (signal?.aborted) {
        onState(REGISTRATION_STATE.CANCELLED);
        throw Object.assign(new Error('app registration cancelled'), { code: 'cancelled' });
      }
      throw error;
    }

    if (poll?.client_id && poll?.client_secret) {
      const detectedBrand = poll?.user_info?.tenant_brand === 'lark' ? 'lark' : brand;
      onState(REGISTRATION_STATE.SUCCEEDED, { appId: poll.client_id, brand: detectedBrand });
      return {
        appId: poll.client_id,
        appSecret: poll.client_secret,
        userInfo: poll.user_info ?? {},
        brand: detectedBrand,
      };
    }

    // A Lark tenant answers on the Feishu host first; switch once and re-poll
    // immediately instead of waiting out another interval.
    if (poll?.user_info?.tenant_brand === 'lark' && !domainSwitched) {
      origin = accountsOrigin('lark');
      domainSwitched = true;
      onState(REGISTRATION_STATE.WAITING, { brand: 'lark' });
      continue;
    }

    switch (poll?.error) {
      case 'authorization_pending':
        onState(REGISTRATION_STATE.WAITING, { expiresAt });
        break;
      case 'slow_down':
        intervalMs = Math.min(MAX_INTERVAL_SECONDS, intervalMs / 1000 + SLOW_DOWN_STEP_SECONDS) * 1000;
        onState(REGISTRATION_STATE.SLOW_DOWN, { intervalSeconds: intervalMs / 1000 });
        break;
      case 'access_denied':
        onState(REGISTRATION_STATE.DENIED);
        throw Object.assign(
          new Error(poll.error_description ?? 'the user declined the authorization'),
          { code: 'access_denied' },
        );
      case 'expired_token':
        onState(REGISTRATION_STATE.EXPIRED);
        throw Object.assign(
          new Error(poll.error_description ?? 'the authorization request expired'),
          { code: 'expired_token' },
        );
      case undefined:
      case '':
        // No error and no credentials: treat as pending rather than failing.
        onState(REGISTRATION_STATE.WAITING, { expiresAt });
        break;
      default:
        onState(REGISTRATION_STATE.FAILED, { error: poll.error });
        throw Object.assign(
          new Error(poll.error_description ?? `app registration failed: ${poll.error}`),
          { code: poll.error },
        );
    }
  }
}

function clampInterval(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_INTERVAL_SECONDS;
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(1, value));
}

/**
 * A cancellable registration handle, so the web page can start and abort one
 * attempt without owning the polling loop.
 */
export class RegistrationSession {
  #controller = new AbortController();
  #id = randomUUID();
  #state = REGISTRATION_STATE.STARTING;
  #qr = null;
  #result = null;
  #error = null;
  #done = null;
  #promise;

  constructor(options = {}) {
    this.options = options;
    this.#promise = registerFeishuApp({
      ...options,
      signal: this.#controller.signal,
      onQrCode: (info) => {
        this.#qr = info;
        options.onQrCode?.(info);
      },
      onState: (state, detail) => {
        this.#state = state;
        options.onState?.(state, detail);
      },
    }).then(
      (result) => {
        this.#result = result;
        this.#done = 'succeeded';
        return result;
      },
      (error) => {
        this.#error = error;
        this.#done = 'failed';
        throw error;
      },
    );
    // Mark handled so an unobserved attempt can never surface as an unhandled
    // rejection; callers still await `completed` to observe the outcome.
    this.#promise.catch(() => {});
  }

  get id() {
    return this.#id;
  }

  get state() {
    return this.#state;
  }

  get qrCode() {
    return this.#qr;
  }

  get completed() {
    return this.#promise;
  }

  get outcome() {
    if (this.#done === 'succeeded') return { status: 'succeeded', result: this.#result };
    if (this.#done === 'failed') return { status: 'failed', error: this.#error };
    return { status: 'pending', state: this.#state, qrCode: this.#qr };
  }

  cancel() {
    this.#controller.abort();
  }
}