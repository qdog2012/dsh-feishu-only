/**
 * Connection lifecycle notifications, delivered to Feishu.
 *
 * The bridge is invisible when it is working: a restart, a dropped socket, a
 * recovered line all happen silently, and the only symptom the user gets is
 * that messages stop being answered. A one-line notice on connect and on
 * disconnect closes that gap — but only to whoever is watching, which means only
 * to an operator the bot can already reach.
 *
 * Delivery is best-effort by design: a notification that itself triggered
 * retries or reconnection logic would turn an outage report into a loop, so
 * failures here are logged and dropped.
 *
 * @module dsh-feishu-only/lib/notify
 */

import { card } from './cards.js';

/** Enough history to suppress flapping, not enough to hide a real outage. */
const MIN_INTERVAL_MS = 60_000;

/**
 * Send one connection notice.
 *
 * @param {{
 *   api: import('./feishu/api.js').FeishuApi,
 *   logger?: Console,
 * }} services
 * @param {{ openId: string, event: 'connected'|'disconnected', reason?: string|null }} notice
 */
export async function sendConnectionNotice({ api, logger = console }, { openId, event, reason }) {
  if (!api?.sendPrivateCard || !openId) return false;
  const title = event === 'connected' ? '🟢 机器人已连接' : '🔌 机器人已断开';
  const lines = [
    event === 'connected'
      ? '长连接已建立，可以正常收发消息。'
      : '长连接已断开，消息将无法送达，恢复后会再通知。',
  ];
  if (reason) lines.push(`<font color='grey'>原因：${clamp(reason)}</font>`);
  lines.push(`<font color='grey'>${new Date().toLocaleString('zh-CN')}</font>`);
  try {
    const payload = card({
      title,
      template: event === 'connected' ? 'green' : 'orange',
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } }],
    });
    await api.sendPrivateCard(openId, payload);
    return true;
  } catch (error) {
    logger.warn?.(`[feishu] connection notice not delivered: ${error?.message ?? error}`);
    return false;
  }
}

/**
 * Who should receive connection notices.
 *
 * The bot's own open id is not reachable (code 230013), so the candidates are
 * the operator who last interacted with the bridge — remembered per connection —
 * falling back to the id the connection was configured for, if any.
 *
 * @param {Map<string, {lastSeen: number}>} seen keyed by open id.
 * @returns {string|null}
 */
export function noticeTarget(seen) {
  if (!seen || typeof seen.size !== 'number' || seen.size === 0) return null;
  let best = null;
  let bestSeen = -1;
  for (const [openId, entry] of seen) {
    const at = Number(entry?.lastSeen ?? 0);
    if (Number.isFinite(at) && at > bestSeen) { bestSeen = at; best = openId; }
  }
  return best ?? null;
}

/**
 * Whether a notice should be suppressed as flapping.
 *
 * Applies to recovery notices only: a reconnect within a minute of the previous
 * notice is almost always the same incident restated. A disconnect is never
 * suppressed — it is the one notice worth getting immediately, because the
 * window between a drop and its notice is exactly when messages go missing.
 */
export function shouldSuppress(lastSentAt, now = Date.now(), event = 'connected') {
  if (event !== 'connected') return false;
  return Number.isFinite(lastSentAt) && now - lastSentAt < MIN_INTERVAL_MS;
}

function clamp(value) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text.length <= 200 ? text : `${text.slice(0, 199)}…`;
}