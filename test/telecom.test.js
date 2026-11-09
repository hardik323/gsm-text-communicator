'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { toMobile, detectOperator, providerForOperator, findProvider } = require('../src/sms/operators/detect');
const { DEFAULT_PROVIDERS } = require('../src/sms/operators/providers');
const { config } = require('../src/config');

const fakeFetch = (reply, status = 200) => {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return { ok: status < 300, status, text: async () => JSON.stringify(reply) };
  };
  fn.calls = calls;
  return fn;
};

describe('toMobile', () => {
  it('gives API Express a bare 10-digit number', () => {
    assert.equal(toMobile('9876543210'), '9876543210');
    assert.equal(toMobile('+91 98765-43210'), '9876543210');
    assert.equal(toMobile('09876543210'), '9876543210');
    assert.equal(toMobile(''), '');
  });
});

describe('detectOperator', () => {
  it('posts the mobile number with a Bearer key', async () => {
    const fetchImpl = fakeFetch({
      status: 'success',
      mobile: '9876543210',
      operator: 'Airtel',
      circle: 'Maharashtra',
      connection: 'prepaid',
      ported: false,
    });

    const answer = await detectOperator('+91 98765-43210', { fetchImpl, apiKey: 'secret' });

    assert.equal(answer.operator, 'Airtel');
    assert.equal(answer.circle, 'Maharashtra');
    assert.equal(answer.connection, 'prepaid');
    assert.equal(answer.ported, false);

    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, config.telecom.operatorUrl);
    assert.equal(fetchImpl.calls[0].options.method, 'POST');
    assert.equal(fetchImpl.calls[0].options.headers.Authorization, 'Bearer secret');
    assert.deepEqual(JSON.parse(fetchImpl.calls[0].options.body), { mobile: '9876543210' });
  });

  it('reports an unknown operator instead of throwing', async () => {
    const answer = await detectOperator('9000000001', {
      fetchImpl: fakeFetch({ status: 'error', message: 'no such number' }),
      apiKey: 'secret',
    });
    assert.equal(answer.operator, null);
  });

  it('throws on an HTTP error', async () => {
    await assert.rejects(
      () => detectOperator('9876543210', { fetchImpl: fakeFetch({ error: 'bad key' }, 401), apiKey: 'bad' }),
      /401|bad key/,
    );
  });

  it('throws when the API does not answer with JSON', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => 'not json' });
    await assert.rejects(() => detectOperator('9876543210', { fetchImpl, apiKey: 'k' }), /did not return JSON/);
  });
});

describe('providerForOperator', () => {
  it('maps API names onto the rows we have', () => {
    assert.equal(providerForOperator('Jio'), 'JIO');
    assert.equal(providerForOperator('Airtel'), 'Airtel');
    assert.equal(providerForOperator('Vi (Vodafone Idea)'), 'Idea');
    assert.equal(providerForOperator('Vodafone Idea'), 'Idea');
    assert.equal(providerForOperator('Idea'), 'Idea');
    assert.equal(providerForOperator('BSNL'), 'BSNL');
    assert.equal(providerForOperator('MTNL'), 'MTNL');
  });

  it('returns null for unknown or empty operators', () => {
    assert.equal(providerForOperator('Someone Else'), null);
    assert.equal(providerForOperator(''), null);
    assert.equal(providerForOperator(null), null);
  });
});

describe('findProvider', () => {
  it('returns the matching row out of the Tsp table', () => {
    const row = findProvider(DEFAULT_PROVIDERS, 'Vi (Vodafone Idea)');
    assert.equal(row.Provider, 'Idea');
    assert.equal(row.NodalNumber, '078248 34221');
  });

  it('returns null when nothing matches', () => {
    assert.equal(findProvider(DEFAULT_PROVIDERS, 'MTNL'), null);
    assert.equal(findProvider([], 'Airtel'), null);
    assert.equal(findProvider(DEFAULT_PROVIDERS, null), null);
  });
});
