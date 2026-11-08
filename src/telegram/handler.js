'use strict';

const { config } = require('../config');
const { parseLocationCommand } = require('./command');
const { acceptedText, wrongText, failedText, blockedText } = require('../constants/messages');
const { blockLeft, noteWrong, noteAccepted } = require('../security/spamGuard');
const { saveRequest } = require('../db/locationRequests');
const { CHANNEL, publishLocationRequest } = require('../queue/locationRequests');

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

    let request;
    try {
      request = await saveRequest({
        userId: message.from && message.from.id ? message.from.id : chatId,
        chatId,
        queryNumber: parsed.number,
      });
    } catch (error) {
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

module.exports = { createMessageHandler };
