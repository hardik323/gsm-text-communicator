'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { config } = require('../src/config');
const { blockLeft, noteWrong, noteAccepted, chats } = require('../src/security/spamGuard');

let nextChat = 1;
const freshChat = () => `chat-${nextChat++}`;

describe('spam guard', () => {
  it('counts wrong commands up to the configured limit', () => {
    const chat = freshChat();
    for (let i = 0; i < config.spam.maxWrong; i += 1) {
      assert.equal(noteWrong(chat), 'counted', `message ${i + 1} should be counted`);
    }
    assert.equal(blockLeft(chat), 0);
  });

  it('blocks on the message after the limit', () => {
    const chat = freshChat();
    for (let i = 0; i < config.spam.maxWrong; i += 1) noteWrong(chat);

    assert.equal(noteWrong(chat), 'blocked');
    assert.ok(blockLeft(chat) > 0);
    assert.ok(blockLeft(chat) <= config.spam.blockMs);
  });

  it('keeps chats independent', () => {
    const blocked = freshChat();
    const innocent = freshChat();
    for (let i = 0; i <= config.spam.maxWrong; i += 1) noteWrong(blocked);

    assert.ok(blockLeft(blocked) > 0);
    assert.equal(blockLeft(innocent), 0);
    assert.equal(noteWrong(innocent), 'counted');
  });

  it('releases the chat automatically when the block expires', () => {
    const chat = freshChat();
    for (let i = 0; i <= config.spam.maxWrong; i += 1) noteWrong(chat);
    assert.ok(blockLeft(chat) > 0);

    chats.get(chat).blockedUntil = Date.now() - 1;
    assert.equal(blockLeft(chat), 0);
  });

  it('restarts the count after a block expires', () => {
    const chat = freshChat();
    for (let i = 0; i <= config.spam.maxWrong; i += 1) noteWrong(chat);
    chats.get(chat).blockedUntil = Date.now() - 1;
    blockLeft(chat);

    assert.equal(noteWrong(chat), 'counted');
  });

  it('clears the history when a valid command arrives', () => {
    const chat = freshChat();
    noteWrong(chat);
    noteWrong(chat);
    noteAccepted(chat);

    assert.equal(noteWrong(chat), 'counted');
    assert.equal(chats.get(chat).wrong.length, 1);
  });

  it('forgets wrong commands older than the window', () => {
    const chat = freshChat();
    for (let i = 0; i < config.spam.maxWrong; i += 1) noteWrong(chat);

    const stale = Date.now() - config.spam.windowMs - 1000;
    chats.get(chat).wrong = chats.get(chat).wrong.map(() => stale);

    assert.equal(noteWrong(chat), 'counted');
    assert.equal(chats.get(chat).wrong.length, 1);
  });

  it('reports zero for a chat it has never seen', () => {
    assert.equal(blockLeft('never-seen'), 0);
  });
});
