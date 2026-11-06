/**
 * Inbound Feishu message normalization.
 *
 * Feishu delivers `im.message.receive_v1` events whose `message.content` is a
 * JSON *string* whose shape depends on `message_type`. This module turns every
 * supported shape into one normalized record the bridge can act on, and keeps
 * the platform facts the interaction rules depend on (chat type, whether the
 * bot was mentioned, the operator's open_id).
 *
 * @module dsh-feishu-only/lib/feishu/messages
 */

/** Message types the bridge accepts as task input. */
const SUPPORTED_CONTENT_TYPES = new Set(['text', 'post', 'image', 'file', 'audio', 'media', 'interactive']);

function parseJsonContent(content) {
  if (typeof content !== 'string' || !content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function stripMentionPlaceholders(text, mentions) {
  let result = typeof text === 'string' ? text : '';
  // Feishu inlines mentions as `@_user_1`; drop the placeholder and tidy the
  // whitespace it leaves behind so the model does not see a dangling token.
  for (const mention of mentions ?? []) {
    if (!mention?.key) continue;
    result = result.split(mention.key).join('');
  }
  return result.replace(/[ \t]{2,}/gu, ' ').replace(/^\s+|\s+$/gu, '');
}

/** Flatten a rich-text (`post`) body into text plus its image keys. */
function readPost(content) {
  const locale = content?.zh_cn ?? content?.en_us ?? content?.ja_jp ?? Object.values(content ?? {})[0];
  const blocks = Array.isArray(locale?.content) ? locale.content : [];
  const lines = [];
  const imageKeys = [];
  for (const row of blocks) {
    if (!Array.isArray(row)) continue;
    const parts = [];
    for (const element of row) {
      if (!element) continue;
      switch (element.tag) {
        case 'text':
          parts.push(element.text ?? '');
          break;
        case 'a':
          parts.push(`${element.text ?? ''}${element.href ? ` (${element.href})` : ''}`);
          break;
        case 'at':
          if (element.user_id && element.user_id !== 'all') parts.push(element.text ?? '');
          break;
        case 'img':
          if (element.image_key) imageKeys.push(element.image_key);
          break;
        case 'media':
          if (element.file_key) parts.push(`[媒体 ${element.file_name ?? element.file_key}]`);
          break;
        case 'emotion':
          parts.push(element.emoji_type ? `[${element.emoji_type}]` : '');
          break;
        case 'code_block':
          parts.push(`\n\`\`\`\n${element.text ?? ''}\n\`\`\`\n`);
          break;
        default:
          if (typeof element.text === 'string') parts.push(element.text);
          break;
      }
    }
    lines.push(parts.join(''));
  }
  return {
    text: lines.join('\n').trim(),
    imageKeys,
    title: typeof locale?.title === 'string' ? locale.title : '',
  };
}

/**
 * Normalize one `im.message.receive_v1` payload.
 *
 * @param {any} event the `event` member of the Feishu payload.
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   messageId?: string,
 *   chatId?: string,
 *   chatType?: 'p2p'|'group'|'topic',
 *   senderOpenId?: string,
 *   senderType?: string,
 *   messageType?: string,
 *   text?: string,
 *   imageKeys?: string[],
 *   fileKey?: string,
 *   fileName?: string,
 *   mentions?: any[],
 *   mentionedBot?: boolean,
 *   createTime?: number,
 *   threadId?: string,
 *   rootId?: string,
 *   parentId?: string,
 * } | null}
 */
export function normalizeMessageEvent(event) {
  const message = event?.message;
  if (!message || typeof message !== 'object') return null;

  const sender = event?.sender ?? {};
  const senderType = sender.sender_type ?? sender.senderType ?? 'user';
  // The bot's own messages come back through the same event stream; ignoring
  // them prevents an echo loop.
  if (senderType === 'app' || senderType === 'bot') {
    return { ok: false, reason: 'self' };
  }

  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const chatId = message.chat_id;
  const chatType = message.chat_type ?? 'p2p';
  const messageType = message.message_type ?? 'text';
  const content = parseJsonContent(message.content);

  const base = {
    ok: true,
    messageId: message.message_id,
    chatId,
    chatType,
    senderOpenId: sender?.sender_id?.open_id ?? event?.operator_id?.open_id ?? null,
    senderType,
    messageType,
    mentions,
    createTime: Number(message.create_time) || Date.now(),
    threadId: message.thread_id ?? undefined,
    rootId: message.root_id ?? undefined,
    parentId: message.parent_id ?? undefined,
    imageKeys: [],
    text: '',
  };

  switch (messageType) {
    case 'text': {
      const raw = typeof content?.text === 'string' ? content.text : '';
      base.text = stripMentionPlaceholders(raw, mentions);
      break;
    }
    case 'post': {
      const post = readPost(content);
      base.text = stripMentionPlaceholders(post.text, mentions);
      base.imageKeys = post.imageKeys;
      break;
    }
    case 'image': {
      if (content?.image_key) base.imageKeys = [content.image_key];
      break;
    }
    case 'file': {
      base.fileKey = content?.file_key ?? null;
      base.fileName = content?.file_name ?? null;
      break;
    }
    case 'audio':
    case 'media': {
      base.fileKey = content?.file_key ?? null;
      base.fileName = content?.file_name ?? `${messageType} 附件`;
      base.text = '';
      break;
    }
    case 'interactive': {
      // A card sent back by a user is not a task input; ignore it explicitly
      // rather than forwarding raw card JSON to the model.
      return { ok: false, reason: 'interactive' };
    }
    case 'sticker':
    case 'share_chat':
    case 'share_user':
    case 'system':
    case 'merge_forward':
    case 'todo':
    case 'vote':
    case 'location':
    case 'video_chat':
    case 'hongbao':
    case 'calendar':
    case 'general_calendar':
    case 'share_calendar_event':
      return { ok: false, reason: `unsupported:${messageType}` };
    default:
      if (!SUPPORTED_CONTENT_TYPES.has(messageType)) {
        return { ok: false, reason: `unsupported:${messageType}` };
      }
      break;
  }

  // Whether the bot itself was mentioned decides group-chat admission.
  base.mentionedBot = mentions.some((mention) => mention?.mentioned_type === 'bot'
    || mention?.name?.includes?.('bot')
    || false);
  if (mentions.length > 0 && !base.mentionedBot) {
    // Some tenants do not mark mentioned_type; a mention of *any* app counts.
    base.mentionedBot = mentions.some((mention) => typeof mention?.id === 'object'
      || String(mention?.key ?? '').startsWith('@_'));
  }

  return base;
}

/**
 * Whether a group message should be handled.
 *
 * Private chats accept everything. Group chats require an explicit mention so
 * ordinary conversation is never mistaken for a task.
 */
export function admitsGroupMessage(normalized, { requireMention = true } = {}) {
  if (!normalized?.ok) return false;
  if (normalized.chatType === 'p2p') return true;
  if (!requireMention) return true;
  return normalized.mentionedBot === true;
}

/**
 * Decode a `card.action.trigger` payload into the fields the bridge routes on.
 *
 * @param {any} event
 */
export function normalizeCardAction(event) {
  const operator = event?.operator ?? {};
  const openId = operator.open_id ?? operator.openId ?? null;
  const userId = operator.user_id ?? operator.userId ?? null;
  const action = event?.action ?? {};
  const value = action.value ?? {};
  const context = event?.context ?? {};
  return {
    ok: Boolean(openId),
    operatorOpenId: openId,
    operatorUserId: userId,
    operatorName: operator.name ?? null,
    messageId: context.open_message_id ?? event?.open_message_id ?? null,
    chatId: context.open_chat_id ?? event?.open_chat_id ?? null,
    tag: action.tag ?? 'unknown',
    name: action.name ?? null,
    value,
    formValue: action.form_value ?? event?.action?.form_value ?? null,
    option: action.option ?? null,
    token: event?.token ?? null,
    eventId: event?.event_id ?? null,
  };
}

/**
 * Read a submitted card form into per-question answers.
 *
 * The card names its inputs `q_<questionId>` (selected option values) and
 * `c_<questionId>` (custom text). Custom text wins over a selection, as the
 * interaction contract requires.
 *
 * @param {Record<string, unknown> | null} formValue
 * @param {Array<{ id: string, options?: Array<{ label: string }> }>} questions
 * @returns {Array<{ id: string, selected: string[], custom?: string }>}
 */
export function readQuestionAnswers(formValue, questions) {
  const form = formValue && typeof formValue === 'object' ? formValue : {};
  const answers = [];
  for (const question of questions) {
    const customKey = `c_${question.id}`;
    const optionKey = `q_${question.id}`;
    const rawCustom = form[customKey];
    const custom = typeof rawCustom === 'string' && rawCustom.trim() ? rawCustom.trim() : undefined;

    let selected = [];
    const rawOption = form[optionKey];
    if (Array.isArray(rawOption)) {
      selected = rawOption.map((item) => String(item));
    } else if (rawOption !== undefined && rawOption !== null && rawOption !== '') {
      selected = [String(rawOption)];
    }

    // `select_static` reports the option *value*, which the card set to the
    // option index; map it back to the original label so the model sees words.
    selected = selected.map((value) => {
      const index = Number(value);
      if (Number.isSafeInteger(index) && question.options?.[index]) {
        return question.options[index].label;
      }
      return value;
    });

    answers.push({
      id: question.id,
      selected: custom ? [] : selected,
      ...(custom ? { custom } : {}),
    });
  }
  return answers;
}