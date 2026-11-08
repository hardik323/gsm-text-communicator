'use strict';

const { config } = require('../config');

/**
 * Per-chat spam guard.
 *
 * A chat that sends more than `maxWrong` rejected messages inside the window is
 * ignored for `blockMs`, then released automatically.
 */

// chatId -> { wrong: [timestamps], blockedUntil: timestamp }
const chats = new Map();

function chatState(chatId) {
  if (!chats.has(chatId)) chats.set(chatId, { wrong: [], blockedUntil: 0 });
  return chats.get(chatId);
}

/** Milliseconds left on this chat's block, or 0 when it is free. */
function blockLeft(chatId) {
  const state = chats.get(chatId);
  if (!state || !state.blockedUntil) return 0;

  const left = state.blockedUntil - Date.now();
  if (left > 0) return left;

  state.blockedUntil = 0;
  state.wrong = [];
  return 0;
}

/** Count one wrong command. Returns 'blocked' when this one crosses the line. */
function noteWrong(chatId) {
  const state = chatState(chatId);
  const now = Date.now();

  state.wrong = state.wrong.filter((time) => now - time < config.spam.windowMs);
  state.wrong.push(now);

  if (state.wrong.length > config.spam.maxWrong) {
    state.wrong = [];
    state.blockedUntil = now + config.spam.blockMs;
    return 'blocked';
  }
  return 'counted';
}

/** A valid command clears the chat's history. */
function noteAccepted(chatId) {
  const state = chatState(chatId);
  state.wrong = [];
  state.blockedUntil = 0;
}

module.exports = { blockLeft, noteWrong, noteAccepted, chats };
