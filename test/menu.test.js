import test from 'node:test';
import assert from 'node:assert/strict';

import { MENU, STALE_COMMANDS, describeMenuError, syncSlashMenu } from '../lib/menu.js';
import { COMMAND_NAMES, parseCommand } from '../lib/commands/parse.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/** A recording slash-command API. */
function fakeApi({ existing = [], failCreate = [], failDelete = [] } = {}) {
  const state = { created: [], deleted: [], hints: new Map() };
  let nextId = 1;
  return {
    state,
    async listSlashCommands() {
      return [
        ...existing.map((item) => ({ ...item, description: item.description ?? '' })),
        ...state.created.map((command) => ({
          commandId: `new_${command}`,
          command,
          description: state.hints.get(command) ?? '',
        })),
      ];
    },
    async createSlashCommand({ command, description }) {
      if (failCreate.includes(command)) throw new Error('refused');
      state.created.push(command);
      state.hints.set(command, description ?? '');
      nextId += 1;
      return `id_${nextId}`;
    },
    async deleteSlashCommand(commandId) {
      const name = existing.find((item) => item.commandId === commandId)?.command;
      if (failDelete.includes(name)) throw new Error('refused');
      state.deleted.push(commandId);
    },
  };
}

test('every menu command actually parses as a command', () => {
  // The menu is the discoverable surface: a name here that the parser rejects
  // would show the user a "unknown command" card.
  for (const item of MENU) {
    const parsed = parseCommand(`/${item.command}`);
    assert.equal(parsed.kind, 'command', `/${item.command} must be a command`);
    assert.notEqual(parsed.action, 'invalid', `/${item.command} must accept no arguments`);
  }
});

test('every menu command is backed by the parser command list', () => {
  for (const item of MENU) {
    assert.ok(
      COMMAND_NAMES.includes(item.command),
      `/${item.command} is in the menu but not in COMMAND_NAMES`,
    );
  }
});

test('menu commands are unique and carry a usage hint', () => {
  const seen = new Set();
  for (const item of MENU) {
    assert.ok(!seen.has(item.command), `duplicate menu command: ${item.command}`);
    seen.add(item.command);
    assert.ok(typeof item.usage === 'string' && item.usage.length > 0, `${item.command} needs a hint`);
    // Feishu accepts a bare token only: no spaces, slashes or angle brackets.
    assert.match(item.command, /^[a-z][a-z0-9_]*$/u, `${item.command} must be a plain token`);
  }
});

test('stale commands from the other integration are listed for removal', () => {
  // These are the entries @xmanrui/dsh-im registered; pressing one from our
  // bot must not be possible.
  for (const command of ['cancel', 'version', 'repair', 'batch', 'steer', 'send']) {
    assert.ok(STALE_COMMANDS.includes(command), `${command} should be retired`);
    assert.ok(!MENU.some((item) => item.command === command), `${command} is not ours`);
  }
});

test('a fresh app gets every menu command created', async () => {
  const api = fakeApi();
  const report = await syncSlashMenu(api, { logger: silent, intervalMs: 0 });
  assert.equal(report.created.length, MENU.length);
  assert.equal(report.failed.length, 0);
  assert.equal(report.removed.length, 0);
  // Creation happens in reverse so the newest-first panel reads in MENU order.
  assert.equal(api.state.created[0], MENU.at(-1).command);
  assert.equal(api.state.created.at(-1), MENU[0].command);
});

test('a second sync is a no-op: nothing is created twice', async () => {
  const api = fakeApi();
  await syncSlashMenu(api, { logger: silent, intervalMs: 0 });
  const createdAfterFirst = api.state.created.length;
  const report = await syncSlashMenu(api, { logger: silent, intervalMs: 0 });
  assert.equal(report.created.length, 0, 'idempotent');
  assert.equal(report.kept.length, MENU.length);
  assert.equal(api.state.created.length, createdAfterFirst);
});

test('leftover entries from the other integration are removed', async () => {
  const api = fakeApi({
    existing: STALE_COMMANDS.map((command) => ({ commandId: `old_${command}`, command })),
  });
  const report = await syncSlashMenu(api, { logger: silent, intervalMs: 0 });
  assert.deepEqual([...report.removed].sort(), [...STALE_COMMANDS].sort());
  assert.equal(api.state.deleted.length, STALE_COMMANDS.length);
});

test('an unlisted foreign command is also retired, not just the known ones', async () => {
  // The panel is a promise that every entry works. A name this bridge does not
  // serve is a dead button regardless of which plugin added it.
  const api = fakeApi({
    existing: [
      { commandId: 'old_something', command: 'somethingFromAnotherPlugin' },
      { commandId: 'old_help', command: 'help', description: MENU.find((m) => m.command === 'help').usage },
    ],
  });
  const report = await syncSlashMenu(api, { logger: silent, intervalMs: 0 });
  assert.deepEqual(report.removed, ['somethingFromAnotherPlugin']);
  assert.ok(report.kept.includes('help'), 'our own entry is kept');
});

test('stale removal can be declined', async () => {
  const api = fakeApi({
    existing: STALE_COMMANDS.map((command) => ({ commandId: `old_${command}`, command })),
  });
  const report = await syncSlashMenu(api, { logger: silent, intervalMs: 0, adoptStale: false });
  assert.equal(report.removed.length, 0);
  assert.equal(api.state.deleted.length, 0);
});

test('a failed create is reported and does not stop the rest', async () => {
  const api = fakeApi({ failCreate: ['goal'] });
  const report = await syncSlashMenu(api, { logger: silent, intervalMs: 0 });
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].command, 'goal');
  assert.equal(report.created.length, MENU.length - 1, 'the others still registered');
});

test('an "already exists" answer counts as kept, not failed', async () => {
  const api = {
    async listSlashCommands() {
      return [];
    },
    async createSlashCommand() {
      throw new Error('command already exists');
    },
    async deleteSlashCommand() {},
  };
  const report = await syncSlashMenu(api, { logger: silent, intervalMs: 0 });
  assert.equal(report.failed.length, 0);
  assert.equal(report.skipped.length, MENU.length);
});

test('a missing scope becomes an instruction rather than a bare code', async () => {
  const api = {
    async listSlashCommands() {
      const error = new Error('Access denied. One of the following scopes is required');
      error.code = 99991672;
      throw error;
    },
  };
  const report = await syncSlashMenu(api, { logger: silent, intervalMs: 0 });
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].error, /应用指令/u);
  assert.match(report.failed[0].error, /app_slash_command/u);
});

test('describeMenuError keeps an unrelated message intact', () => {
  assert.equal(describeMenuError(new Error('network down')), 'network down');
});

test('a same-named entry with a foreign hint is replaced, not kept', async () => {
  // The other integration registers `help`, `model`, `stop`… with its own
  // wording. Keeping them would advertise behaviour this bridge does not have,
  // and the API has no update, so the entry is recreated.
  const api = fakeApi({
    existing: [
      { commandId: 'old_help', command: 'help', description: '查看帮助' },
      { commandId: 'old_model', command: 'model', description: '查看或切换当前模型' },
    ],
  });
  const report = await syncSlashMenu(api, { logger: silent, intervalMs: 0 });
  assert.deepEqual(report.replaced, ['model', 'help'], 'newest-first creation order');
  assert.ok(api.state.deleted.includes('old_help'));
  assert.ok(api.state.created.includes('help'), 'and recreated with our own hint');
});

test('a same-named entry already carrying our hint is kept', async () => {
  const api = fakeApi({
    existing: [{ commandId: 'ok_help', command: 'help', description: MENU.find((m) => m.command === 'help').usage }],
  });
  const report = await syncSlashMenu(api, { logger: silent, intervalMs: 0 });
  assert.deepEqual(report.replaced, []);
  assert.ok(report.kept.includes('help'));
});

test('a dry run reports the plan without touching the app', async () => {
  const api = fakeApi({
    existing: STALE_COMMANDS.map((command) => ({ commandId: `old_${command}`, command })),
  });
  const report = await syncSlashMenu(api, { logger: silent, intervalMs: 0, dryRun: true });
  assert.equal(report.created.length, MENU.length);
  assert.equal(report.removed.length, STALE_COMMANDS.length);
  assert.equal(api.state.created.length, 0, 'nothing was created');
  assert.equal(api.state.deleted.length, 0, 'nothing was deleted');
});