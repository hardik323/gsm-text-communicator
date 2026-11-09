'use strict';

/**
 * Tests for the webhook receiver: a real HTTP server on an ephemeral port,
 * with `publish` stubbed so no Redis is needed.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { createWebhookServer } = require('../src/webhooks/server');

const published = [];
let server = null;
let base = '';

before(async () => {
  const app = createWebhookServer({
    publish: async (message) => {
      published.push(message);
    },
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));

async function post(path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('webhook receiver', () => {
  it('answers health checks', async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });

  it('publishes a normalised sms:received event', async () => {
    published.length = 0;
    const response = await post('/webhook', {
      deviceId: 'dev-1',
      event: 'sms:received',
      id: 'env-1',
      payload: { message: 'Tower A', sender: '+1555', simNumber: 2 },
    });

    assert.equal(response.status, 200);
    assert.equal(published.length, 1);
    assert.equal(published[0].Message, 'Tower A');
    assert.equal(published[0].Sender, '+1555');
    assert.equal(published[0].SimNumber, 2);
  });

  it('acknowledges other gateway events without publishing', async () => {
    published.length = 0;
    const response = await post('/webhook', { event: 'system:ping', payload: {} });

    assert.equal(response.status, 200);
    assert.equal(published.length, 0);
  });

  it('rejects payloads that carry no event', async () => {
    const response = await post('/webhook', { hello: 'world' });
    assert.equal(response.status, 400);
  });

  it('returns 500 when the queue is unavailable', async () => {
    const failing = createWebhookServer({
      publish: async () => {
        throw new Error('redis down');
      },
    });
    await new Promise((resolve) => {
      const s = failing.listen(0, '127.0.0.1', async () => {
        const url = `http://127.0.0.1:${s.address().port}/webhook`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'sms:received', payload: { message: 'x' } }),
        });
        assert.equal(response.status, 500);
        s.close(() => resolve());
      });
    });
  });
});
