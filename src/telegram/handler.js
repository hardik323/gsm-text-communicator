'use strict';

const { config } = require('../config');
const { parseLocationCommand } = require('./command');
const { acceptedText, wrongText, duplicateText, failedText, blockedText } = require('../constants/messages');
const { blockLeft, noteWrong, noteAccepted } = require('../security/spamGuard');
const { saveRequest, findOpenRequest } = require('../db/locations');
const { CHANNEL, publishLocationRequest } = require('../queue/locationRequests');
const { replyFor } = require('./repliedMessage');

/**
 * Build the message handler.
 *
 * Order matters: validate -> block check -> save -> acknowledge -> publish.
 * The user is only told "accepted" once the row exists, and a Redis failure
 * after that point is logged instead of breaking the reply.
 */
function createMessageHandler({ send }) {
  return async function handleMessage(message) {
    const chatId = message.chat && message.chat.id;
    if (!chatId) return;

    // A blocked chat gets no reply at all, not even for a valid command.
    if (blockLeft(chatId) > 0) return;

    const parsed = parseLocationCommand(message.text);

    if (!parsed.ok) {
      if (noteWrong(chatId) === 'blocked') {
        console.warn(`chat ${chatId} blocked for ${Math.round(config.spam.blockMs / 1000)}s (spam)`);
        await send(chatId, blockedText(config.spam.blockMs), message.message_id);
        return;
      }
      await send(chatId, wrongText(parsed.reason), message.message_id);
      return;
    }

    noteAccepted(chatId);

    const userId = message.from && message.from.id ? message.from.id : chatId;

    // The same number from the same user and chat while one is still open is
    // a repeat, not a new request — say so and do nothing else.
    const existing = await findOpenRequest({ userId, chatId, queryNumber: parsed.number });
    if (existing) {
      await send(chatId, duplicateText(parsed.number, existing.Status, existing.CreatedDateTime));
      return;
    }

    let request;
    try {
      request = await saveRequest({ userId, chatId, queryNumber: parsed.number });
    } catch (error) {
      // A duplicate can still slip in between the check and the insert (two
      // identical messages arriving at once). The unique index turns that into
      // a P2002; treat it exactly like the check above.
      if (error.code === 'P2002') {
        const raced = await findOpenRequest({ userId, chatId, queryNumber: parsed.number });
        if (raced) {
          await send(chatId, duplicateText(parsed.number, raced.Status, raced.CreatedDateTime));
          return;
        }
      }
      console.error(`could not save request for ${parsed.number}:`, error.message);
      await send(chatId, failedText(), message.message_id);
      return;
    }

    console.log(`request ${request.Id} saved for ${parsed.number} (chat ${chatId}, status ${request.Status})`);
    await send(chatId, acceptedText(parsed.number));

    // The database row is the durable record, so a Redis hiccup here must not
    // turn an accepted request into an error for the user.
    publishLocationRequest(request)
      .then((receivers) => console.log(`published ${request.Id} to "${CHANNEL}" (${receivers} listener(s))`))
      .catch((error) => console.warn(`could not publish ${request.Id} to "${CHANNEL}":`, error.message));
  };
}

/**
 * Build a handler that listens for replies from the carrier on the
 * `BotResponse` channel and forwards them to the Telegram user who made the
 * original request.
 *
 * `send` is the same Telegram send helper the message handler uses, so this
 * works whether the bot is polling or webhook-driven.
 */
function createReplyHandler({ send }) {
  return async function handleReply(payload, _message) {
    const queryNumber = payload && payload.QueryNumber;
    const chatId = payload && payload.ChatId;

    if (!queryNumber || !chatId) {
      console.warn('[BotResponse] dropped a reply without a query number or chat id');
      return;
    }

    const text = replyFor(queryNumber, payload);
    await send(chatId, text).catch((error) =>
      console.error(`[BotResponse] could not send the reply to chat ${chatId}:`, error.message),
    );
  };
}

module.exports = { createMessageHandler, createReplyHandler };
