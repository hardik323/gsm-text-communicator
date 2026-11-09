'use strict';

/**
 * Pub/sub for replies that the bot should forward to Telegram.
 *
 * When a nodal reply arrives and is matched to a request, the reply reactor
 * publishes one message here. `bot.js` subscribes and sends the Telegram user
 * the human-readable version of what we got.
 *
 * Redis pub/sub is fire-and-forget, so a publish while nobody is listening is
 * lost — the database row is the durable record of every response.
 */

const { config } = require('../config');
const { createConnection } = require('./redis');

const CHANNEL = config.redis.botResponseChannel;

// A subscribed connection cannot run normal commands, so publishing gets its
// own connection. If nothing in the process needs to publish, the connection
// is still fine to keep idle and subscribe.
const getPublisher = () =>
  (globalThis.__botResponsePublisher ??= createConnection('botpublisher'));

/**
 * Announce one reply. Resolves to the number of subscribers that received it.
 * `channel` is mostly for tests that inject a different channel name.
 */
function publishBotResponse(request, channel) {
  const ch = channel || CHANNEL;
  return getPublisher().publish(ch, JSON.stringify(toPayload(request)));
}

/**
 * Handle every reply on the channel. Anything that is not JSON is ignored.
 * Returns an unsubscribe function.
 */
async function subscribe(handler) {
  const sub = getPublisher();
  sub.on('message', (channel, message) => {
    if (channel !== CHANNEL) return;

    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      console.warn(`[${CHANNEL}] ignored a message that is not JSON`);
      return;
    }

    handler(payload, message);
  });

  await sub.subscribe(CHANNEL);
  return () => sub.unsubscribe(CHANNEL);
}

function close() {
  if (globalThis.__botResponsePublisher) {
    globalThis.__botResponsePublisher.quit().catch(() => {});
    globalThis.__botResponsePublisher = null;
  }
  return Promise.resolve();
}

/**
 * One reply, serialised for the channel. The caller already stamped the row
 * in the database, so this is only for the Telegram reply.
 */
function toPayload(request) {
  let payload;
  try {
    payload = JSON.parse(request.Response || '{}');
  } catch {
    payload = {};
  }

  return Object.assign({}, payload, {
    Id: request.Id,
    QueryNumber: request.QueryNumber,
    ChatId: String(request.ChatId),
    UserId: String(request.UserId),
    location_information: payload.location_information || null,
    receivedAt:
      request.LastStatusChangeDateTime instanceof Date
        ? request.LastStatusChangeDateTime.toISOString()
        : request.LastStatusChangeDateTime,
  });
}

module.exports = { CHANNEL, toPayload, publishBotResponse, subscribe, close };
