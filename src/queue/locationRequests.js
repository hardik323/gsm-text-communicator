'use strict';

/**
 * Pub/sub for new location requests.
 *
 * Redis pub/sub is fire-and-forget: a message published while nobody is
 * subscribed is lost. The database row is the durable record.
 */

const { config } = require('../config');
const { Status } = require('../constants/status');
const { createConnection } = require('./redis');

const CHANNEL = config.redis.channel;
const STATUS_CREATED = Status.CREATED;

// A subscribed connection cannot run normal commands, so publishing gets its
// own connection.
const publisher = createConnection('publisher');
const subscriber = createConnection('subscriber');

/** BigInt ids are not JSON-serialisable, so they travel as strings. */
function toPayload(request) {
  return {
    Id: request.Id,
    UserId: String(request.UserId),
    ChatId: String(request.ChatId),
    QueryNumber: request.QueryNumber,
    Status: request.Status,
    CreatedDateTime:
      request.CreatedDateTime instanceof Date ? request.CreatedDateTime.toISOString() : request.CreatedDateTime,
  };
}

/** Announce one request. Resolves to the number of subscribers that received it. */
function publishLocationRequest(request) {
  return publisher.publish(CHANNEL, JSON.stringify(toPayload(request)));
}

/**
 * Handle every request on the channel whose status is "created".
 * Anything else (already processed, unparseable) is ignored.
 * Returns an unsubscribe function.
 */
async function subscribe(handler) {
  subscriber.on('message', (channel, message) => {
    if (channel !== CHANNEL) return;

    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      console.warn(`[${CHANNEL}] ignored a message that is not JSON`);
      return;
    }

    if (Number(payload.Status) !== STATUS_CREATED) {
      console.log(`[${CHANNEL}] skipped ${payload.Id || 'unknown'}: status ${payload.Status} is not created`);
      return;
    }

    handler(payload, message);
  });

  await subscriber.subscribe(CHANNEL);
  return () => subscriber.unsubscribe(CHANNEL);
}

function close() {
  return Promise.allSettled([publisher.quit(), subscriber.quit()]);
}

module.exports = { CHANNEL, STATUS_CREATED, toPayload, publishLocationRequest, subscribe, close, publisher, subscriber };
