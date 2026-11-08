'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { Status, StatusName, VALID_STATUSES, isStatus, parseStatus } = require('../src/constants/status');

describe('status enum', () => {
  it('keeps the agreed numeric values', () => {
    assert.deepEqual(Status, {
      CREATED: 1,
      TSP_REQUESTED: 2,
      TSP_FOUND: 3,
      TSP_NOT_FOUND: 4,
      LOCATION_REQUESTED: 5,
      NODAL_RESPONSE_FOUND: 6,
      NODAL_RESPONSE_TIMEOUT: 7,
    });
  });

  it('exposes exactly seven valid statuses', () => {
    assert.deepEqual(VALID_STATUSES, [1, 2, 3, 4, 5, 6, 7]);
  });

  it('maps numbers back to names', () => {
    assert.equal(StatusName[1], 'CREATED');
    assert.equal(StatusName[7], 'NODAL_RESPONSE_TIMEOUT');
    assert.equal(StatusName[42], undefined);
  });

  it('isStatus accepts numbers and numeric strings', () => {
    assert.equal(isStatus(1), true);
    assert.equal(isStatus('7'), true);
    assert.equal(isStatus(0), false);
    assert.equal(isStatus(8), false);
    assert.equal(isStatus('created'), false);
  });

  it('parseStatus accepts numbers, numeric strings and names', () => {
    assert.equal(parseStatus(1), 1);
    assert.equal(parseStatus('6'), 6);
    assert.equal(parseStatus('created'), 1);
    assert.equal(parseStatus('Tsp-Requested'), 2);
    assert.equal(parseStatus('nodal response timeout'), 7);
  });

  it('parseStatus returns undefined for unknown values', () => {
    assert.equal(parseStatus(99), undefined);
    assert.equal(parseStatus('nope'), undefined);
    assert.equal(parseStatus(undefined), undefined);
    assert.equal(parseStatus(null), undefined);
  });
});
