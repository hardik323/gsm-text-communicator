'use strict';

/**
 * Pub/sub for texts arriving at the gateway phone's SIM — the
 * "MessagesReceived" topic.
 *
 * The webhook receiver (webhook.js) publishes here when the SMS Gateway app
 * reports an incoming text, and programme.js subscribes and matches the reply
 * to the open request it belongs to. Same fire-and-forget shape as
 * LocationRequests: the database row is the durable record.
 */

const { config } = require('../config');
const { createConnection } = require('./redis');

const CHANNEL = config.redis.messageChannel;

// Created lazily so processes that only publish (webhook.js) do not open a
// subscriber connection.
let publisher = null;
let subscriber = null;

const getPublisher = () => (publisher ??= createConnection('messages-publisher'));
const getSubscriber = () => (subscriber ??= createConnection('messages-subscriber'));

/** Announce one received message (already normalised by the gateway client). */
function publishMessagesReceived(message) {
  return getPublisher().publish(CHANNEL, JSON.stringify(message));
}

/**
 * Handle every received message on the channel. Anything that is not JSON
 * is ignored. Returns an unsubscribe function.
 */
async function subscribe(handler) {
  const sub = getSubscriber();
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
  return Promise.allSettled(
    [publisher && publisher.quit(), subscriber && subscriber.quit()].filter(Boolean),
  );
}

module.exports = { CHANNEL, publishMessagesReceived, subscribe, close };
