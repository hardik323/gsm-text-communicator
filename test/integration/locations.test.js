'use strict';

/**
 * Integration tests: these write to the real database (DATABASE_URL in .env)
 * and delete what they created. If Postgres is not running they are skipped
 * with a warning instead of failing.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma, disconnect } = require('../../src/db/prisma');
const {
  saveRequest,
  findOpenRequest,
  setStatus,
  setTsp,
  findOpenRequests,
  closeStaleRequests,
} = require('../../src/db/locations');
const { recordNodalResponse } = require('../../src/sms/replies/records');
const { Status } = require('../../src/constants/status');
const { CHANNEL: BOT_RESPONSE_CHANNEL, publishBotResponse, subscribe: subscribeBotResponse, close: closeBotResponse } = require('../../src/queue/botResponse');

let botSubscriber = null;

const created = [];
let available = false;

before(async () => {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    available = true;
  } catch {
    console.warn('\n[db tests] PostgreSQL not reachable — skipping integration tests\n');
  }

  if (available) {
    botSubscriber = await subscribeBotResponse((payload) => {
      publishedBotResponses.push(payload);
    });
  }
});

after(async () => {
  if (created.length) {
    await prisma.locationRequests.deleteMany({ where: { Id: { in: created } } }).catch(() => {});
  }
  await disconnect();
});

describe('locationRequests table', () => {
  it('stores a new request as created, with timestamps', async () => {
    if (!available) return;

    const row = await saveRequest({ userId: 8248190184, chatId: 8248190184, queryNumber: '9876543210' });
    created.push(row.Id);

    assert.equal(row.Status, Status.CREATED);
    assert.equal(row.QueryNumber, '9876543210');
    assert.ok(row.CreatedDateTime instanceof Date);
    assert.ok(row.LastStatusChangeDateTime instanceof Date);
  });

  it('keeps negative group chat ids intact', async () => {
    if (!available) return;

    const row = await saveRequest({ userId: 8248190184, chatId: -1001234567890, queryNumber: '+919876543210' });
    created.push(row.Id);

    assert.equal(row.ChatId, -1001234567890n);
    assert.equal(row.QueryNumber, '+919876543210');
  });

  it('refuses a status outside 1..8', async () => {
    if (!available) return;

    const row = await saveRequest({ userId: 1, chatId: 1, queryNumber: '9876543210' });
    created.push(row.Id);

    await assert.rejects(
      () => prisma.locationRequests.update({ where: { Id: row.Id }, data: { Status: 99 } }),
      /check|constraint/i,
    );
  });

  it('does not accept an empty query number', async () => {
    if (!available) return;

    await assert.rejects(() => saveRequest({ userId: 1, chatId: 1, queryNumber: '' }));
  });
});

describe('findOpenRequest', () => {
  // Every test gets a fresh key, because an open row would make the next
  // insert with the same key fail the unique index.
  let n = 0;
  const key = () => ({
    userId: 424242,
    chatId: -424242,
    queryNumber: `1777777${String(++n).padStart(3, '0')}`,
  });

  it('finds a request that is still in progress', async () => {
    if (!available) return;

    const row = await saveRequest(key());
    created.push(row.Id);

    const found = await findOpenRequest({ userId: 424242, chatId: -424242, queryNumber: row.QueryNumber });
    assert.ok(found, 'expected the open row to be found');
    assert.equal(found.Id, row.Id);
  });

  it('ignores closed requests and other people\'s', async () => {
    if (!available) return;

    const k = key();
    const row = await saveRequest(k);
    created.push(row.Id);

    // Finished work is not "in progress" any more.
    await prisma.locationRequests.update({ where: { Id: row.Id }, data: { Status: Status.TSP_FOUND } });
    assert.equal(await findOpenRequest(k), null);

    // A different number, user or chat does not count either.
    await prisma.locationRequests.update({ where: { Id: row.Id }, data: { Status: Status.CREATED } });
    assert.equal(await findOpenRequest({ ...k, queryNumber: '1888888888' }), null);
    assert.equal(await findOpenRequest({ ...k, userId: 1 }), null);
    assert.equal(await findOpenRequest({ ...k, chatId: 1 }), null);
  });

  it('rejects a second open request with the same key', async () => {
    if (!available) return;

    const k = key();
    const row = await saveRequest(k);
    created.push(row.Id);

    await assert.rejects(() => saveRequest(k), /unique/i);
  });
});

describe('setStatus', () => {
  it('moves a request to LOCATION_REQUESTED and stamps the change', async () => {
    if (!available) return;

    const row = await saveRequest({ userId: 444333222, chatId: -444333222, queryNumber: '9000000006' });
    created.push(row.Id);
    const before = row.LastStatusChangeDateTime;

    const updated = await setStatus(row.Id, Status.LOCATION_REQUESTED);
    assert.equal(updated.Status, Status.LOCATION_REQUESTED);
    assert.ok(updated.LastStatusChangeDateTime >= before, 'the change timestamp should not go backwards');
  });
});

describe('setTsp', () => {
  it('stores the identified operator together with the status', async () => {
    if (!available) return;

    const row = await saveRequest({ userId: 777111000, chatId: -777111000, queryNumber: '9000000010' });
    created.push(row.Id);
    assert.equal(row.TSP, null);

    const requested = await setTsp(row.Id, null, Status.TSP_REQUESTED);
    assert.equal(requested.Status, Status.TSP_REQUESTED);

    const found = await setTsp(row.Id, 'Airtel', Status.TSP_FOUND);
    assert.equal(found.TSP, 'Airtel');
    assert.equal(found.Status, Status.TSP_FOUND);
    assert.ok(found.LastStatusChangeDateTime >= requested.LastStatusChangeDateTime);
  });
});

describe('findOpenRequests', () => {
  it('lists only requests still waiting on a reply', async () => {
    if (!available) return;

    const row = await saveRequest({ userId: 777111001, chatId: -777111001, queryNumber: '9000000011' });
    created.push(row.Id);
    await setStatus(row.Id, Status.LOCATION_REQUESTED);

    const list = await findOpenRequests();
    assert.ok(list.some((r) => r.Id === row.Id), 'the awaiting request should be listed');

    // Once it has finished, it must drop out of the list.
    await setStatus(row.Id, Status.NODAL_RESPONSE_FOUND);
    const after = await findOpenRequests();
    assert.equal(after.some((r) => r.Id === row.Id), false);
  });
});

describe('closeStaleRequests', () => {
  const QUARTER_HOUR = 15 * 60 * 1000;
  const SWEEP = 30 * 1000;

  it('marks a request that waited too long for a location reply as NODAL_RESPONSE_TIMEOUT', async () => {
    if (!available) return;

    const row = await saveRequest({ userId: 777111002, chatId: -777111002, queryNumber: '9000000012' });
    created.push(row.Id);
    await setStatus(row.Id, Status.LOCATION_REQUESTED);

    // Not overdue yet.
    assert.equal(await closeStaleRequests({ waitMs: QUARTER_HOUR, sweepMs: SWEEP }), 0);

    // Force the last change to an hour ago: now it is overdue.
    await prisma.locationRequests.update({
      where: { Id: row.Id },
      data: { LastStatusChangeDateTime: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const count = await closeStaleRequests({ waitMs: QUARTER_HOUR, sweepMs: SWEEP });
    assert.ok(count >= 1, 'the overdue request should be timed out');

    const after = await prisma.locationRequests.findUnique({ where: { Id: row.Id } });
    assert.equal(after.Status, Status.NODAL_RESPONSE_TIMEOUT);
  });

  it('marks a request whose operator lookup never returned as FAILED', async () => {
    if (!available) return;

    const row = await saveRequest({ userId: 777111004, chatId: -777111004, queryNumber: '9000000014' });
    created.push(row.Id);
    await setTsp(row.Id, null, Status.TSP_REQUESTED);

    // The reply clock is 15 minutes, so a fresh request is untouched — the
    // operator clock is one sweep interval, so a stuck one is closed fast.
    assert.equal(await closeStaleRequests({ waitMs: QUARTER_HOUR, sweepMs: SWEEP }), 0);

    await prisma.locationRequests.update({
      where: { Id: row.Id },
      data: { LastStatusChangeDateTime: new Date(Date.now() - 2 * 60 * 1000) },
    });
    const count = await closeStaleRequests({ waitMs: QUARTER_HOUR, sweepMs: SWEEP });
    assert.ok(count >= 1, 'the stuck operator lookup should be closed');

    const after = await prisma.locationRequests.findUnique({ where: { Id: row.Id } });
    assert.equal(after.Status, Status.FAILED);
  });

  it('does not touch a request that already finished', async () => {
    if (!available) return;

    const row = await saveRequest({ userId: 777111003, chatId: -777111003, queryNumber: '9000000013' });
    created.push(row.Id);
    await setStatus(row.Id, Status.NODAL_RESPONSE_FOUND);
    await prisma.locationRequests.update({
      where: { Id: row.Id },
      data: { LastStatusChangeDateTime: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    await closeStaleRequests({ waitMs: QUARTER_HOUR, sweepMs: SWEEP });
    const after = await prisma.locationRequests.findUnique({ where: { Id: row.Id } });
    assert.equal(after.Status, Status.NODAL_RESPONSE_FOUND);
  });
});

describe('recordNodalResponse', () => {
  // Numbers no other suite (or the user) uses, so the assertions are stable.
  it('attaches the reply to the open request it belongs to, and builds the BotResponse payload', async () => {
    if (!available) return;

    const row = await saveRequest({ userId: 555444333, chatId: -555444333, queryNumber: '9000000007' });
    created.push(row.Id);

    // Leave the publish function out, so this test never talks to Redis.
    const updated = await recordNodalResponse({
      candidates: ['919000000007'],
      text: 'Tower A near 91-9000000007',
    });

    assert.ok(updated, 'the open request should match by trailing digits');
    assert.equal(updated.Id, row.Id);

    // The reply reactor stores the carrier's raw reply in NodalResponse and
    // the structured JSON (query_number, chatId, userId, location_information)
    // in Response, which is what the BotResponse channel publishes.
    assert.equal(updated.NodalResponse, 'Tower A near 91-9000000007');
    assert.equal(updated.Response, JSON.stringify({
      query_number: '9000000007',
      chatId: String(row.ChatId),
      userId: String(row.UserId),
      location_information: { raw: 'Tower A near 91-9000000007', snippet: 'Tower A near 91-9000000007' },
    }));
    assert.equal(updated.Status, Status.NODAL_RESPONSE_FOUND);
  });

  it('leaves closed requests and unmatched numbers alone', async () => {
    if (!available) return;

    const row = await saveRequest({ userId: 555444334, chatId: -555444334, queryNumber: '9000000008' });
    created.push(row.Id);

    // Close it: no longer a candidate.
    await prisma.locationRequests.update({ where: { Id: row.Id }, data: { Status: Status.TSP_FOUND } });
    assert.equal(await recordNodalResponse({ candidates: ['919000000008'], text: 'late reply' }), null);
    const unchanged = await prisma.locationRequests.findUnique({ where: { Id: row.Id } });
    assert.equal(unchanged.NodalResponse, null);
    assert.equal(unchanged.Status, Status.TSP_FOUND);

    // Number that no open request has.
    assert.equal(await recordNodalResponse({ candidates: ['919000000099'], text: 'other' }), null);

    // No numbers in the text at all.
    assert.equal(await recordNodalResponse({ candidates: [], text: 'no numbers' }), null);
  });
});
