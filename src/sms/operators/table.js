'use strict';

/**
 * The `Tsp` table: the carriers the gateway phone can query, and for each the
 * nodal number to text and the `RequestFormat` to build the message from.
 *
 * One row per carrier. Providers come from `providers.js` (`DEFAULT_PROVIDERS`)
 * and are seeded on programme start-up with `ensureProviders`: a missing row
 * is inserted, an existing one — including one an operator edited by hand —
 * is never overwritten.
 */

const { prisma: sharedPrisma } = require('../../db/prisma');

/**
 * Build the table accessors. The client is a parameter so tests can pass a
 * stub; the real one is shared with the `locationRequests` accessors.
 */
function createProvidersTable({ db = sharedPrisma } = {}) {
  /** All active providers, in a stable order. */
  function listProviders() {
    return db.Tsp.findMany({
      where: { IsActive: true },
      orderBy: { Provider: 'asc' },
    });
  }

  /**
   * Force a row to the given values. For migrations and seed corrections
   * only — the bot never calls this, so an operator's own numbers survive.
   */
  function upsertProvider(provider) {
    return db.Tsp.upsert({
      where: { Provider: provider.Provider },
      update: {
        NodalNumber: provider.NodalNumber,
        RequestFormat: provider.RequestFormat,
        LastStatusChangeDateTime: new Date(),
      },
      create: {
        Provider: provider.Provider,
        NodalNumber: provider.NodalNumber,
        RequestFormat: provider.RequestFormat,
        IsActive: provider.IsActive === undefined ? true : provider.IsActive,
      },
    });
  }

  /** Remove a provider. Manual cleanup and test use only. */
  function removeProvider(provider) {
    return db.Tsp.delete({ where: { Provider: provider } });
  }

  /**
   * Fill in whatever providers are missing, and never touch the rest. An
   * operator-edited number, format or active flag is left exactly as they set
   * it on every restart.
   */
  async function ensureProviders(providers) {
    const result = { inserted: 0, kept: 0 };

    for (const provider of providers) {
      const existing = await db.Tsp.findUnique({ where: { Provider: provider.Provider } });
      if (existing) {
        result.kept += 1;
        continue;
      }

      await db.Tsp.create({
        data: {
          Provider: provider.Provider,
          NodalNumber: provider.NodalNumber,
          RequestFormat: provider.RequestFormat || '91{query_number}',
          IsActive: provider.IsActive === undefined ? true : provider.IsActive,
        },
      });
      result.inserted += 1;
    }

    return result;
  }

  return { listProviders, ensureProviders, upsertProvider, removeProvider };
}

const { listProviders, ensureProviders, upsertProvider, removeProvider } = createProvidersTable();

module.exports = { createProvidersTable, listProviders, ensureProviders, upsertProvider, removeProvider };
