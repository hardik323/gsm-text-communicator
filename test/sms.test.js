'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { config } = require('../src/config');
const { sendSms, registerWebhook, parseSmsReceivedEvent } = require('../src/sms/gateway/client');
const { fullNumber, extractNumberCandidates } = require('../src/numbers');

describe('fullNumber', () => {
  it('prefixes a bare national number with 91', () => {
    assert.equal(fullNumber('9876543210'), '919876543210');
  });

  it('keeps an already-international number bare', () => {
    assert.equal(fullNumber('919876543210'), '919876543210');
    assert.equal(fullNumber('+91 98765-43210'), '919876543210');
    assert.equal(fullNumber('+919876543210'), '919876543210');
  });

  it('strips a leading zero', () => {
    assert.equal(fullNumber('09876543210'), '919876543210');
  });
});

describe('extractNumberCandidates', () => {
  it('finds numbers echoed in a reply', () => {
    assert.deepEqual(extractNumberCandidates('Location of 91-98765 43210 is Tower A'), ['919876543210']);
    assert.deepEqual(extractNumberCandidates('+91 98765-43210 ok'), ['919876543210']);
  });

  it('ignores short digit runs', () => {
    assert.deepEqual(extractNumberCandidates('code 12345 only'), []);
    assert.deepEqual(extractNumberCandidates('no digits here'), []);
  });

  it('deduplicates', () => {
    assert.deepEqual(extractNumberCandidates('919876543210 and 9876543210'), ['919876543210']);
  });
});

describe('sendSms', () => {
  const fakeFetch = (calls, replyBody, status = 202) => async (url, options) => {
    calls.push({ url, options });
    return { ok: status < 300, status, text: async () => JSON.stringify(replyBody) };
  };

  it('posts the gateway message shape with basic auth', async () => {
    const calls = [];
    const reply = { id: 'msg-1', state: 'Pending', recipients: [{ phoneNumber: '5599', state: 'Pending' }] };
    const result = await sendSms({ to: '27277', text: '919876543210', fetchImpl: fakeFetch(calls, reply) });

    assert.equal(result.id, 'msg-1');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, new RegExp(`^${config.sms.baseUrl}/3rdparty/v1/messages`));
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(
      calls[0].options.headers.Authorization,
      `Basic ${Buffer.from(`${config.sms.username}:${config.sms.password}`).toString('base64')}`,
    );
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      phoneNumbers: ['27277'],
      textMessage: { text: '919876543210' },
    });
  });

  it('throws on a non-2xx reply', async () => {
    await assert.rejects(
      () => sendSms({ to: '27277', text: '1', fetchImpl: fakeFetch([], { error: 'nope' }, 401) }),
      /401/,
    );
  });
});

describe('registerWebhook', () => {
  it('registers an sms:received webhook', async () => {
    const calls = [];
    const reply = { id: 'wh-1', url: 'https://example.com/webhook', event: 'sms:received' };
    const fake = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 201, text: async () => JSON.stringify(reply) };
    };

    const webhook = await registerWebhook({ url: 'https://example.com/webhook', fetchImpl: fake });

    assert.equal(webhook.id, 'wh-1');
    assert.equal(calls[0].url, `${config.sms.baseUrl}/3rdparty/v1/webhooks`);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      url: 'https://example.com/webhook',
      event: 'sms:received',
    });
  });

  it('requires a url', async () => {
    await assert.rejects(() => registerWebhook({}), /url is required/);
  });
});

describe('parseSmsReceivedEvent', () => {
  const envelope = (payload) => ({
    deviceId: 'dev-1',
    event: 'sms:received',
    id: 'env-1',
    payload,
    webhookId: 'wh-1',
  });

  it('normalises the documented payload', () => {
    const message = parseSmsReceivedEvent(
      envelope({
        messageId: 'm-1',
        message: 'Tower A, 91-9876543210',
        sender: '+1555',
        recipient: '+919999999999',
        receivedAt: '2026-11-09T04:00:00.000Z',
        simNumber: 1,
      }),
    );

    assert.deepEqual(message, {
      Id: 'env-1',
      DeviceId: 'dev-1',
      Sender: '+1555',
      Recipient: '+919999999999',
      Message: 'Tower A, 91-9876543210',
      ReceivedAt: '2026-11-09T04:00:00.000Z',
      SimNumber: 1,
    });
  });

  it('falls back to phoneNumber for older payloads', () => {
    const message = parseSmsReceivedEvent(envelope({ message: 'hi', phoneNumber: '6505551212' }));
    assert.equal(message.Sender, '6505551212');
    assert.equal(message.SimNumber, null);
  });

  it('returns null for other events and malformed input', () => {
    assert.equal(parseSmsReceivedEvent({ event: 'sms:delivered', payload: {} }), null);
    assert.equal(parseSmsReceivedEvent({ event: 'sms:received' }), null);
    assert.equal(parseSmsReceivedEvent(null), null);
    assert.equal(parseSmsReceivedEvent(undefined), null);
  });
});
