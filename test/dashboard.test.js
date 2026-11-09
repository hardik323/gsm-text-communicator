'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { serializeRequest, fingerprint } = require('../src/dashboard/server');

const row = (overrides = {}) => ({
  Id: 'caf184bd-0439-42c1-a0f6-384810661f2a',
  UserId: 8248190184n,
  ChatId: -1001234567890n,
  QueryNumber: '+919876543210',
  TSP: null,
  NodalResponse: null,
  Status: 1,
  CreatedDateTime: new Date('2026-11-09T03:00:00Z'),
  LastStatusChangeDateTime: new Date('2026-11-09T03:00:00Z'),
  ...overrides,
});

describe('serializeRequest', () => {
  it('turns bigint ids into strings and dates into ISO', () => {
    const out = serializeRequest(row());

    assert.equal(out.UserId, '8248190184');
    assert.equal(out.ChatId, '-1001234567890');
    assert.equal(out.CreatedDateTime, '2026-11-09T03:00:00.000Z');
    assert.equal(out.StatusName, 'CREATED');
  });

  it('keeps TSP and the nodal response', () => {
    const out = serializeRequest(row({ TSP: 'Jio', NodalResponse: 'tower 12', Status: 6 }));

    assert.equal(out.TSP, 'Jio');
    assert.equal(out.NodalResponse, 'tower 12');
    assert.equal(out.StatusName, 'NODAL_RESPONSE_FOUND');
  });

  it('labels a status outside the enum as UNKNOWN', () => {
    assert.equal(serializeRequest(row({ Status: 99 })).StatusName, 'UNKNOWN');
  });
});

describe('fingerprint', () => {
  const snapshot = (overrides = {}) => ({
    total: 1,
    counts: { 1: 1 },
    requests: [serializeRequest(row())],
    ...overrides,
  });

  it('is identical for identical snapshots', () => {
    assert.equal(fingerprint(snapshot()), fingerprint(snapshot()));
  });

  it('changes when a status changes', () => {
    const changed = snapshot({ counts: { 1: 0, 2: 1 }, requests: [serializeRequest(row({ Status: 2 }))] });
    assert.notEqual(fingerprint(snapshot()), fingerprint(changed));
  });

  it('changes when the total changes', () => {
    assert.notEqual(fingerprint(snapshot()), fingerprint(snapshot({ total: 2 })));
  });
});
