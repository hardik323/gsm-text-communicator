'use strict';

/**
 * Integration tests: these write to the real database (DATABASE_URL in .env)
 * and delete what they created. If Postgres is not running they are skipped
 * with a warning instead of failing.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma, disconnect } = require('../src/db/prisma');
const { saveRequest } = require('../src/db/locationRequests');
const { Status } = require('../src/constants/status');

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

  it('refuses a status outside 1..7', async () => {
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
