'use strict';

/**
 * Integration tests: these talk to a real Redis (REDIS_URL in .env).
 * If Redis is not running the tests are skipped with a warning instead of
 * failing, so the unit suite stays useful on its own.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { config } = require('../src/config');
const { Status } = require('../src/constants/status');
const { CHANNEL, subscribe, publishLocationRequest, publisher, close } = require('../src/queue/locationRequests');

const received = [];
let available = false;

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

const request = (Id, Status_, extra = {}) => ({
  Id,
  UserId: 8248190184n,
  ChatId: -1001234567890n,
  QueryNumber: '+919876543210',
  Status: Status_,
  CreatedDateTime: new Date('2026-11-09T03:00:00Z'),
  ...extra,
});

before(async () => {
  try {
    await Promise.race([
      publisher.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);
    available = true;
  } catch {
    console.warn('\n[queue tests] Redis not reachable on ' + config.redis.url + ' — skipping integration tests\n');
    return;
  }

  await subscribe((payload) => received.push(payload));
  await wait(300);
});

after(async () => {
  await close();
});

describe('LocationRequests channel', () => {
  it('uses the configured channel name', () => {
    assert.equal(CHANNEL, config.redis.channel);
  });

  it('delivers a created request to a subscriber', async () => {
    if (!available) return;

    const receivers = await publishLocationRequest(request('it-created-1', Status.CREATED));
    assert.equal(receivers, 1);

    const message = await waitFor((p) => p.Id === 'it-created-1');
    assert.ok(message, 'created request should arrive');
    assert.equal(message.Status, Status.CREATED);
    assert.equal(message.QueryNumber, '+919876543210');
  });

  it('sends bigint ids as strings and the date as ISO', async () => {
    if (!available) return;

    await publishLocationRequest(request('it-shape-1', Status.CREATED));
    const message = await waitFor((p) => p.Id === 'it-shape-1');

    assert.equal(typeof message.UserId, 'string');
    assert.equal(typeof message.ChatId, 'string');
    assert.equal(message.ChatId, '-1001234567890');
    assert.equal(typeof message.Status, 'number');
    assert.equal(message.CreatedDateTime, '2026-11-09T03:00:00.000Z');
  });

  it('ignores requests that are not created', async () => {
    if (!available) return;

    await publishLocationRequest(request('it-status-2', Status.TSP_REQUESTED));
    await publishLocationRequest(request('it-status-6', Status.NODAL_RESPONSE_FOUND));
    await wait(600);

    assert.equal(received.some((p) => p.Id === 'it-status-2'), false);
    assert.equal(received.some((p) => p.Id === 'it-status-6'), false);
  });

  it('ignores a message that is not JSON', async () => {
    if (!available) return;

    await publisher.publish(CHANNEL, 'not json at all');
    await wait(300);

    assert.equal(received.some((p) => p === 'not json at all'), false);
  });
});
