import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCommand, looksLikeCommand, COMMAND_NAMES } from '../lib/commands/parse.js';

test('every documented command name parses to a command', () => {
  for (const name of COMMAND_NAMES) {
    const parsed = parseCommand(`/${name}`);
    assert.equal(parsed.kind, 'command', `/${name} should parse as a command`);
    assert.equal(parsed.name, name);
  }
});

test('plain messages are not commands', () => {
  assert.equal(parseCommand('帮我看一下这个报错').kind, 'none');
  assert.equal(parseCommand('见 https://example.com/a/b').kind, 'none');
  assert.equal(parseCommand('比例是 1/2').kind, 'none');
  assert.equal(looksLikeCommand(' /help'), true);
  assert.equal(looksLikeCommand('text /help'), false);
});

test('an unknown slash command is reported, never treated as task input', () => {
  const parsed = parseCommand('/deploy now');
  assert.equal(parsed.kind, 'unknown');
  assert.equal(parsed.name, 'deploy');
});

test('/task variants', () => {
  assert.deepEqual(pick(parseCommand('/task')), { action: 'list' });
  assert.deepEqual(pick(parseCommand('/task page 3')), { action: 'list', page: 3 });
  assert.deepEqual(pick(parseCommand('/task 2')), { action: 'select', index: 2 });
  assert.deepEqual(pick(parseCommand('/task current')), { action: 'current' });
  assert.deepEqual(pick(parseCommand('/task create 修复登录')), { action: 'create', text: '修复登录' });
  assert.deepEqual(pick(parseCommand('/task search 登录')), { action: 'search', text: '登录' });
  assert.deepEqual(pick(parseCommand('/task search page 2')), { action: 'searchPage', page: 2 });
  assert.equal(parseCommand('/task page').action, 'invalid');
  assert.equal(parseCommand('/task 0').action, 'invalid');
  assert.equal(parseCommand('/task create').action, 'invalid');
});

test('/history paging', () => {
  assert.deepEqual(pick(parseCommand('/history')), { action: 'show' });
  assert.deepEqual(pick(parseCommand('/history page 2')), { action: 'show', page: 2 });
  assert.equal(parseCommand('/history page x').action, 'invalid');
});

test('/goal forms', () => {
  assert.deepEqual(pick(parseCommand('/goal')), { action: 'show' });
  assert.deepEqual(pick(parseCommand('/goal set 发布 v1')), { action: 'set', text: '发布 v1' });
  assert.deepEqual(pick(parseCommand('/goal clear')), { action: 'clear' });
  assert.equal(parseCommand('/goal set').action, 'invalid');
});

test('/project paging', () => {
  assert.deepEqual(pick(parseCommand('/project')), { action: 'list' });
  assert.deepEqual(pick(parseCommand('/project page 2')), { action: 'list', page: 2 });
  assert.equal(parseCommand('/project page 0').action, 'invalid');
});

test('settings commands accept an index and reject anything else', () => {
  for (const name of ['model', 'reasoning', 'permission', 'mode']) {
    assert.deepEqual(pick(parseCommand(`/${name}`)), { action: 'show' });
    assert.deepEqual(pick(parseCommand(`/${name} 2`)), { action: 'select', index: 2 });
    assert.equal(parseCommand(`/${name} abc`).action, 'invalid');
  }
});

function pick(parsed) {
  const { action, page, index, text } = parsed;
  return {
    action,
    ...(page === undefined ? {} : { page }),
    ...(index === undefined ? {} : { index }),
    ...(text === undefined ? {} : { text }),
  };
}