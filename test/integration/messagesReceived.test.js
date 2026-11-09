'use strict';

/**
 * Integration tests: these talk to a real Redis (REDIS_URL in .env).
 * If Redis is not running the tests are skipped with a warning instead of
 * failing, so the unit suite stays useful on its own.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { config } = require('../../src/config');
const { CHANNEL, publishMessagesReceived, subscribe, close } = require('../../src/queue/messagesReceived');
const { createConnection } = require('../../src/queue/redis');

const received = [];
let available = false;
let rawPublisher = null;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = received.find(predicate);
    if (hit) return hit;
    await wait(50);
  }
  return undefined;
}

before(async () => {
  rawPublisher = createConnection('test-publisher');
  try {
    await Promise.race([
      rawPublisher.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);
    available = true;
  } catch {
    console.warn('\n[MessagesReceived tests] Redis not reachable — skipping integration tests\n');
    return;
  }

  await subscribe((payload) => received.push(payload));
  await wait(300);
});

after(async () => {
  await Promise.allSettled([close(), rawPublisher && rawPublisher.quit()]);
});

describe('MessagesReceived channel', () => {
  it('uses the configured channel name', () => {
    assert.equal(CHANNEL, config.redis.messageChannel);
  });

  it('delivers a published message to a subscriber', async () => {
    if (!available) return;

    const receivers = await publishMessagesReceived({ Id: 'it-msg-1', Message: 'Tower A' });
    assert.ok(receivers >= 1, `expected at least 1 receiver, got ${receivers}`);

    const message = await waitFor((p) => p.Id === 'it-msg-1');
    assert.ok(message, 'published message should arrive');
    assert.equal(message.Message, 'Tower A');
  });

  it('ignores a message that is not JSON', async () => {
    if (!available) return;

    await rawPublisher.publish(CHANNEL, 'not json at all');
    await wait(300);

    assert.equal(received.some((p) => p === 'not json at all'), false);
  });
});
