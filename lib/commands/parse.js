/**
 * Slash-command parsing.
 *
 * The bridge keeps a fixed, documented command surface: a slash command is a
 * control operation, a plain message is task input, and an unknown slash
 * command returns help instead of being forwarded to the model.
 *
 * @module dsh-feishu-only/lib/commands/parse
 */

/** The 16 primary commands from the interaction reference, plus `/current`. */
export const COMMAND_NAMES = Object.freeze([
  'help',
  'project',
  'task',
  'current',
  'history',
  'last',
  'plugin',
  'permission',
  'model',
  'reasoning',
  'mode',
  'compact',
  'goal',
  'stop',
  'status',
  'restart',
  'update',
]);

const COMMAND_SET = new Set(COMMAND_NAMES);

/** Every accepted form of every command, used by `/help` and by the parser. */
export const COMMAND_FORMS = Object.freeze({
  help: ['/help'],
  project: ['/project', '/project page <页码>'],
  task: [
    '/task',
    '/task page <页码>',
    '/task <序号>',
    '/task create <标题>',
    '/task current',
    '/task search <关键词>',
    '/task search page <页码>',
  ],
  // Feishu's "/" panel only accepts a bare command token, so the most-used
  // sub-command also exists standalone to stay reachable from the menu.
  current: ['/current'],
  history: ['/history', '/history page <页码>'],
  last: ['/last'],
  plugin: ['/plugin'],
  permission: ['/permission', '/permission <序号>'],
  model: ['/model', '/model <序号>'],
  reasoning: ['/reasoning', '/reasoning <序号>'],
  mode: ['/mode', '/mode <序号>'],
  compact: ['/compact'],
  goal: ['/goal', '/goal set <目标>', '/goal clear'],
  stop: ['/stop'],
  status: ['/status'],
  restart: ['/restart'],
  update: ['/update'],
});

/**
 * @typedef {{ kind: 'command', name: string, action: string, args: string[], raw: string, index?: number, page?: number, text?: string }} ParsedCommand
 * @typedef {{ kind: 'unknown', name: string, raw: string }} UnknownCommand
 * @typedef {{ kind: 'none' }} NoCommand
 */

/**
 * Whether a message looks like a slash command at all.
 *
 * Only a leading `/` counts; a URL or a fraction mid-sentence must stay a
 * normal task message.
 */
export function looksLikeCommand(text) {
  if (typeof text !== 'string') return false;
  return /^\s*\//u.test(text);
}

function parsePositiveInteger(token) {
  if (typeof token !== 'string' || !/^\d+$/u.test(token)) return undefined;
  const value = Number(token);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Parse one message into a command or "not a command".
 *
 * @param {string} text the message text.
 * @returns {ParsedCommand | UnknownCommand | NoCommand}
 */
export function parseCommand(text) {
  if (!looksLikeCommand(text)) return { kind: 'none' };
  const raw = text.trim();
  const withoutSlash = raw.slice(1);
  const tokens = withoutSlash.split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return { kind: 'unknown', name: '', raw };

  const name = tokens[0].toLowerCase();
  const rest = tokens.slice(1);
  if (!COMMAND_SET.has(name)) return { kind: 'unknown', name, raw };

  const base = { kind: 'command', name, raw };

  switch (name) {
    case 'help':
    case 'current':
    case 'last':
    case 'plugin':
    case 'compact':
    case 'stop':
    case 'status':
    case 'restart':
    case 'update':
      return { ...base, action: 'default', args: rest };

    case 'project': {
      if (rest.length === 0) return { ...base, action: 'list', args: [] };
      if (rest[0].toLowerCase() === 'page') {
        const page = parsePositiveInteger(rest[1]);
        if (page === undefined) return { ...base, action: 'invalid', args: rest };
        return { ...base, action: 'list', page, args: rest };
      }
      return { ...base, action: 'invalid', args: rest };
    }

    case 'task': {
      if (rest.length === 0) return { ...base, action: 'list', args: [] };
      const head = rest[0].toLowerCase();

      if (head === 'page') {
        const page = parsePositiveInteger(rest[1]);
        if (page === undefined) return { ...base, action: 'invalid', args: rest };
        return { ...base, action: 'list', page, args: rest };
      }
      if (head === 'current') return { ...base, action: 'current', args: rest.slice(1) };
      if (head === 'create') {
        const title = rest.slice(1).join(' ').trim();
        if (!title) return { ...base, action: 'invalid', args: rest };
        return { ...base, action: 'create', text: title, args: rest };
      }
      if (head === 'search') {
        const tail = rest.slice(1);
        if (tail.length === 0) return { ...base, action: 'search', text: '', args: rest };
        if (tail[0].toLowerCase() === 'page') {
          const page = parsePositiveInteger(tail[1]);
          if (page === undefined) return { ...base, action: 'invalid', args: rest };
          return { ...base, action: 'searchPage', page, args: rest };
        }
        return { ...base, action: 'search', text: tail.join(' ').trim(), args: rest };
      }
      const index = parsePositiveInteger(head);
      if (index !== undefined) return { ...base, action: 'select', index, args: rest };
      return { ...base, action: 'invalid', args: rest };
    }

    case 'history': {
      if (rest.length === 0) return { ...base, action: 'show', args: [] };
      if (rest[0].toLowerCase() === 'page') {
        const page = parsePositiveInteger(rest[1]);
        if (page === undefined) return { ...base, action: 'invalid', args: rest };
        return { ...base, action: 'show', page, args: rest };
      }
      return { ...base, action: 'invalid', args: rest };
    }

    case 'permission':
    case 'model':
    case 'reasoning':
    case 'mode': {
      if (rest.length === 0) return { ...base, action: 'show', args: [] };
      const index = parsePositiveInteger(rest[0]);
      if (index === undefined) return { ...base, action: 'invalid', args: rest };
      return { ...base, action: 'select', index, args: rest };
    }

    case 'goal': {
      if (rest.length === 0) return { ...base, action: 'show', args: [] };
      const head = rest[0].toLowerCase();
      if (head === 'set') {
        const objective = rest.slice(1).join(' ').trim();
        if (!objective) return { ...base, action: 'invalid', args: rest };
        return { ...base, action: 'set', text: objective, args: rest };
      }
      if (head === 'clear') return { ...base, action: 'clear', args: rest.slice(1) };
      return { ...base, action: 'invalid', args: rest };
    }

    default:
      return { ...base, action: 'default', args: rest };
  }
}

/**
 * Split free text into the leading instruction and trailing goal, so
 * `/goal set 修复登录` reaches a handler that also accepts the plain form.
 */
export function commandUsage(name) {
  return COMMAND_FORMS[name] ?? [];
}