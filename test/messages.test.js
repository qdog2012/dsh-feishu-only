import test from 'node:test';
import assert from 'node:assert/strict';

import {
  admitsGroupMessage,
  normalizeCardAction,
  normalizeMessageEvent,
  readQuestionAnswers,
} from '../lib/feishu/messages.js';

function textEvent({ text = 'hello', chatType = 'p2p', mentions = [], senderType = 'user' } = {}) {
  return {
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: senderType },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: chatType,
      message_type: 'text',
      content: JSON.stringify({ text }),
      mentions,
      create_time: '1700000000000',
    },
  };
}

test('a private text message normalizes to task input', () => {
  const message = normalizeMessageEvent(textEvent({ text: '修一下这个 bug' }));
  assert.equal(message.ok, true);
  assert.equal(message.text, '修一下这个 bug');
  assert.equal(message.chatType, 'p2p');
  assert.equal(message.senderOpenId, 'ou_user');
});

test('the bot\'s own messages are ignored to prevent an echo loop', () => {
  assert.deepEqual(normalizeMessageEvent(textEvent({ senderType: 'app' })), { ok: false, reason: 'self' });
});

test('unsupported message types are reported, not forwarded', () => {
  const event = textEvent();
  event.message.message_type = 'sticker';
  const message = normalizeMessageEvent(event);
  assert.equal(message.ok, false);
  assert.match(message.reason, /^unsupported:/u);
});

test('mentions are stripped from the text but still drive admission', () => {
  const event = textEvent({
    text: '@_user_1 你好',
    chatType: 'group',
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Bot' }],
  });
  const message = normalizeMessageEvent(event);
  assert.equal(message.text, '你好');
  assert.equal(message.mentionedBot, true);
  assert.equal(admitsGroupMessage(message, { requireMention: true }), true);
});

test('a group message without a mention is ignored by default', () => {
  const message = normalizeMessageEvent(textEvent({ text: '随便聊聊', chatType: 'group' }));
  assert.equal(admitsGroupMessage(message, { requireMention: true }), false);
  assert.equal(admitsGroupMessage(message, { requireMention: false }), true);
});

test('private chats always admit', () => {
  const message = normalizeMessageEvent(textEvent());
  assert.equal(admitsGroupMessage(message, { requireMention: true }), true);
});

test('a rich-text post yields both text and image keys', () => {
  const event = textEvent();
  event.message.message_type = 'post';
  event.message.content = JSON.stringify({
    zh_cn: {
      title: '标题',
      content: [[{ tag: 'text', text: '看一下这张图' }, { tag: 'img', image_key: 'img_1' }]],
    },
  });
  const message = normalizeMessageEvent(event);
  assert.equal(message.text, '看一下这张图');
  assert.deepEqual(message.imageKeys, ['img_1']);
});

test('an image-only message exposes its image key', () => {
  const event = textEvent();
  event.message.message_type = 'image';
  event.message.content = JSON.stringify({ image_key: 'img_only' });
  const message = normalizeMessageEvent(event);
  assert.equal(message.text, '');
  assert.deepEqual(message.imageKeys, ['img_only']);
});

test('a file message exposes key and name', () => {
  const event = textEvent();
  event.message.message_type = 'file';
  event.message.content = JSON.stringify({ file_key: 'file_1', file_name: '报告.pdf' });
  const message = normalizeMessageEvent(event);
  assert.equal(message.fileKey, 'file_1');
  assert.equal(message.fileName, '报告.pdf');
});

test('a card sent by a user is not task input', () => {
  const event = textEvent();
  event.message.message_type = 'interactive';
  assert.deepEqual(normalizeMessageEvent(event), { ok: false, reason: 'interactive' });
});

test('card actions normalize the operator and the button value', () => {
  const action = normalizeCardAction({
    operator: { open_id: 'ou_op', name: '张三' },
    action: { tag: 'button', value: { id: 'task.select', pageKey: 'p1', index: 2 } },
    context: { open_message_id: 'om_card', open_chat_id: 'oc_1' },
  });
  assert.equal(action.ok, true);
  assert.equal(action.operatorOpenId, 'ou_op');
  assert.equal(action.messageId, 'om_card');
  assert.equal(action.chatId, 'oc_1');
  assert.deepEqual(action.value, { id: 'task.select', pageKey: 'p1', index: 2 });
});

test('form answers prefer custom text over a selection', () => {
  const questions = [
    { id: 'color', options: [{ label: '红' }, { label: '蓝' }] },
    { id: 'size', options: [{ label: '大' }, { label: '小' }] },
  ];
  const answers = readQuestionAnswers({ q_color: '1', c_color: '', q_size: '0', c_size: '中号' }, questions);
  assert.deepEqual(answers[0], { id: 'color', selected: ['蓝'] });
  assert.deepEqual(answers[1], { id: 'size', selected: [], custom: '中号' });
});

test('a multi-select answer maps every index back to its label', () => {
  const questions = [{ id: 'tags', options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }], multiSelect: true }];
  const answers = readQuestionAnswers({ q_tags: ['0', '2'] }, questions);
  assert.deepEqual(answers[0].selected, ['甲', '丙']);
});