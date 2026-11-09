'use strict';

/**
 * Integration tests through the real message handler: a fake `send` records
 * the replies, while the handler talks to the real database (and Redis for the
 * publish). Skipped with a warning when Postgres is not running.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma, disconnect } = require('../../src/db/prisma');
const { createMessageHandler } = require('../../src/telegram/handler');
const { close: closeQueue } = require('../../src/queue/locationRequests');
const { Status } = require('../../src/constants/status');

const USER = 777777001;
const CHAT = -777777001;
const NUMBER = '9000000001';

const created = [];
let available = false;

const sent = [];
const handle = createMessageHandler({
  send: async (chatId, text) => {
    sent.push({ chatId, text });
  },
});

const message = (text) => ({ chat: { id: CHAT }, from: { id: USER }, text });

async function rowCount() {
  return prisma.locationRequests.count({ where: { UserId: BigInt(USER) } });
}

async function latestRow() {
  return prisma.locationRequests.findFirst({
    where: { UserId: BigInt(USER) },
    orderBy: { CreatedDateTime: 'desc' },
  });
}

before(async () => {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    available = true;
  } catch {
    console.warn('\n[handler tests] PostgreSQL not reachable — skipping integration tests\n');
  }

  if (available) {
    // A crashed earlier run may have left rows behind; start clean.
    await prisma.locationRequests.deleteMany({ where: { UserId: BigInt(USER) } });
  }
});

after(async () => {
  if (created.length) {
    await prisma.locationRequests.deleteMany({ where: { Id: { in: created } } }).catch(() => {});
  }
  await Promise.allSettled([disconnect(), closeQueue()]);
});

describe('message handler', () => {
  it('accepts the first /location and stores it as created', async () => {
    if (!available) return;

    sent.length = 0;
    await handle(message(`/location ${NUMBER}`));

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Command accepted/);
    assert.match(sent[0].text, new RegExp(NUMBER));

    const row = await latestRow();
    created.push(row.Id);
    assert.equal(row.Status, Status.CREATED);
    assert.equal(row.QueryNumber, NUMBER);
  });

  it('says the request is already in progress for an identical repeat', async () => {
    if (!available) return;

    const before = await rowCount();
    sent.length = 0;
    await handle(message(`/location ${NUMBER}`));

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Already in progress/);
    assert.match(sent[0].text, new RegExp(NUMBER));
    assert.match(sent[0].text, /No need to send it again/);
    assert.equal(await rowCount(), before, 'no second row should be created');
  });

  it('accepts the same command again once the first request has finished', async () => {
    if (!available) return;

    const first = await latestRow();
    await prisma.locationRequests.update({ where: { Id: first.Id }, data: { Status: Status.TSP_FOUND } });

    sent.length = 0;
    await handle(message(`/location ${NUMBER}`));

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Command accepted/);

    const second = await latestRow();
    created.push(second.Id);
    assert.notEqual(second.Id, first.Id);
    assert.equal(second.Status, Status.CREATED);
  });

  it('does not let a different number be answered as a repeat', async () => {
    if (!available) return;

    sent.length = 0;
    await handle(message('/location 9000000002'));

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Command accepted/);
    created.push((await latestRow()).Id);
  });
});
