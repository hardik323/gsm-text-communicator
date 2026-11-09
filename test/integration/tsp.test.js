'use strict';

/**
 * Integration tests: these write to the real database (DATABASE_URL in .env).
 * If Postgres is not running they are skipped with a warning instead of
 * failing. No Tsp rows may be left behind, so every test provider is removed
 * again.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma, disconnect } = require('../../src/db/prisma');
const { listProviders, ensureProviders, removeProvider } = require('../../src/sms/operators/table');
const { DEFAULT_PROVIDERS, buildProviderMessage } = require('../../src/sms/operators/providers');

const TEST_PROVIDERS = [
  { Provider: 'TestTelA', NodalNumber: '088001 12112', RequestFormat: '91{query_number}' },
  { Provider: 'TestTelB', NodalNumber: '070212 65165', RequestFormat: '91{query_number}' },
];

let available = false;

before(async () => {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    available = true;
  } catch {
    console.warn('\n[tsp tests] PostgreSQL not reachable — skipping integration tests\n');
  }

  if (available) {
    // A crashed earlier run may have left rows behind; start clean.
    for (const p of TEST_PROVIDERS) {
      await removeProvider(p.Provider).catch(() => {});
    }
  }
});

after(async () => {
  if (available) {
    for (const p of TEST_PROVIDERS) {
      await removeProvider(p.Provider).catch(() => {});
    }
  }
  await disconnect();
});

describe('Tsp table', () => {
  it('holds the four providers from DEFAULT_PROVIDERS', () => {
    assert.deepEqual(
      DEFAULT_PROVIDERS.map((p) => p.Provider).sort(),
      ['Airtel', 'BSNL', 'Idea', 'JIO'],
    );
    for (const p of DEFAULT_PROVIDERS) {
      assert.match(p.NodalNumber, /^\d{6} \d{5}$/, `${p.Provider} nodal number`);
    }
    const byProvider = Object.fromEntries(DEFAULT_PROVIDERS.map((p) => [p.Provider, p]));
    assert.equal(byProvider.Airtel.RequestFormat, '91{query_number}');
    assert.equal(byProvider.JIO.RequestFormat, '91{query_number}');
    assert.equal(byProvider.Idea.RequestFormat, 'CELL 91{query_number}');
    assert.equal(byProvider.BSNL.RequestFormat, 'Getloc 91****');
  });

  it('creates missing providers and keeps everything active', async () => {
    if (!available) return;

    const result = await ensureProviders(TEST_PROVIDERS);
    assert.equal(result.inserted, 2);

    const active = await listProviders();
    const inserted = active.filter((p) => p.Provider.startsWith('TestTel'));
    assert.equal(inserted.length, 2);
    assert.equal(inserted[0].NodalNumber, '088001 12112');
    assert.ok(inserted.every((p) => p.IsActive === true));
    assert.ok(inserted.every((p) => p.CreatedDateTime instanceof Date));
  });

  it('does not overwrite an operator-edit on rerun', async () => {
    if (!available) return;

    await prisma.Tsp.update({
      where: { Provider: 'TestTelA' },
      data: { NodalNumber: '99999 00000', IsActive: false },
    });
    const result = await ensureProviders(TEST_PROVIDERS);
    assert.equal(result.kept, 2);

    const row = await prisma.Tsp.findUnique({ where: { Provider: 'TestTelA' } });
    assert.equal(row.NodalNumber, '99999 00000');
    assert.equal(row.IsActive, false);
  });

  it('builds each provider\'s lookup message', () => {
    assert.equal(buildProviderMessage('91{query_number}', '9876543210'), '919876543210');
    assert.equal(buildProviderMessage('CELL 91{query_number}', '9876543210'), 'CELL 919876543210');
    assert.equal(buildProviderMessage('Getloc 91****', '9876543210'), 'Getloc 91****');
    assert.equal(buildProviderMessage(undefined, '+91 98765-43210'), '919876543210');
  });
});
