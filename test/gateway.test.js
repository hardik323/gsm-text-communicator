const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../lib/store');
const { RequestManager, STATUS, numbersMatch } = require('../lib/requests');
const { createGateway } = require('../lib/gateway');

const quietLog = { info() {}, warn() {}, error() {}, log() {} };

function makeConfig(overrides = {}) {
  return {
    GATEWAY_SIM_SENDER_NUMBER: '+15550002222',
    GATEWAY_SIM_DESTINATION_NUMBER: '+15550001111',
    GATEWAY_TOKEN: 'test-token',
    CLAIM_LEASE_MS: 200,
    RESPONSE_TIMEOUT_MS: 60 * 60 * 1000,
    SEND_MAX_ATTEMPTS: 2,
    GATEWAY_PORT: 0,
    ...overrides,
  };
}

function setup(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-bot-'));
  const config = makeConfig(overrides);
  const store = new Store(path.join(dir, 'state.json'), quietLog);
  const requests = new RequestManager({ store, config, log: quietLog });
  return { store, requests, config, dir };
}

async function withServer(requests, config, fn) {
  const events = { replies: [], failed: [] };
  const app = createGateway({
    requests,
    config,
    events: {
      onReply: (r) => events.replies.push(r),
      onSendFailed: (r) => events.failed.push(r),
    },
    log: quietLog,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body, token = config.GATEWAY_TOKEN) => {
    const res = await fetch(base + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gateway-token': token },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  try {
    await fn({ post, events, base });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('full round trip: telegram request -> SMS -> reply routed back', async () => {
  const { requests, config } = setup();

  await withServer(requests, config, async ({ post, events }) => {
    const created = requests.create({ chatId: 42, username: 'alice', requestedNumber: '12345' });
    assert.strictEqual(created.status, STATUS.QUEUED);
    assert.strictEqual(created.smsBody, '/location 12345');
    assert.strictEqual(created.to, '+15550001111');

    const claim = await post('/gateway/outbox/claim', {});
    assert.strictEqual(claim.status, 200);
    assert.strictEqual(claim.json.sms.requestId, created.id);
    assert.strictEqual(claim.json.sms.body, '/location 12345');
    assert.strictEqual(claim.json.sms.to, '+15550001111');

    // Leased, so a second poll from the same phone gets nothing.
    const second = await post('/gateway/outbox/claim', {});
    assert.strictEqual(second.json.sms, null);

    await post('/gateway/outbox/result', { requestId: created.id, status: 'sent' });
    assert.strictEqual(requests.requests[0].status, STATUS.SENT);

    const inbound = await post('/gateway/inbound', {
      from: '+15550001111',
      body: '12345 is at 48.1372, 11.5756',
      receivedAt: Date.now(),
      messageId: 'm1',
    });
    assert.strictEqual(inbound.json.matched, true);
    assert.strictEqual(events.replies.length, 1);
    assert.strictEqual(events.replies[0].chatId, 42);
    assert.strictEqual(events.replies[0].status, STATUS.ANSWERED);
    assert.match(events.replies[0].reply.body, /48\.1372/);
  });
});

test('two chats waiting at once each get their own answer', async () => {
  const { requests, config } = setup();

  await withServer(requests, config, async ({ post, events }) => {
    const first = requests.create({ chatId: 1, username: 'alice', requestedNumber: '111' });
    const second = requests.create({ chatId: 2, username: 'bob', requestedNumber: '222' });

    await post('/gateway/outbox/claim', {});
    await post('/gateway/outbox/claim', {});
    await post('/gateway/outbox/result', { requestId: first.id, status: 'sent' });
    await post('/gateway/outbox/result', { requestId: second.id, status: 'sent' });

    // The reply clearly belongs to 222, even though 111 is older.
    await post('/gateway/inbound', { from: '15550001111', body: '222: Berlin', messageId: 'a' });
    assert.strictEqual(requests.requests.find((r) => r.id === second.id).status, STATUS.ANSWERED);
    assert.strictEqual(requests.requests.find((r) => r.id === first.id).status, STATUS.SENT);

    // The remaining reply goes to the other chat.
    await post('/gateway/inbound', { from: '15550001111', body: 'nothing useful here', messageId: 'b' });
    assert.strictEqual(requests.requests.find((r) => r.id === first.id).status, STATUS.ANSWERED);

    assert.deepStrictEqual(events.replies.map((r) => r.chatId).sort(), [1, 2]);
  });
});

test('replies from other numbers and repeats are ignored', async () => {
  const { requests, config } = setup();

  await withServer(requests, config, async ({ post }) => {
    const created = requests.create({ chatId: 7, requestedNumber: '999' });
    await post('/gateway/outbox/claim', {});
    await post('/gateway/outbox/result', { requestId: created.id, status: 'sent' });

    const stranger = await post('/gateway/inbound', { from: '+15559998888', body: '999', messageId: 'x' });
    assert.strictEqual(stranger.json.matched, false);
    assert.strictEqual(requests.requests[0].status, STATUS.SENT);

    const ok = await post('/gateway/inbound', { from: '+15550001111', body: '999 here', messageId: 'y' });
    assert.strictEqual(ok.json.matched, true);

    const repeat = await post('/gateway/inbound', { from: '+15550001111', body: '999 here', messageId: 'y' });
    assert.strictEqual(repeat.json.duplicate, true);
  });
});

test('failed sends are retried and then reported', async () => {
  const { requests, config } = setup();

  await withServer(requests, config, async ({ post, events }) => {
    const created = requests.create({ chatId: 3, requestedNumber: '555' });
    await post('/gateway/outbox/claim', {});

    await post('/gateway/outbox/result', { requestId: created.id, status: 'failed', error: 'no service' });
    assert.strictEqual(requests.requests[0].status, STATUS.QUEUED, 'retried after first failure');

    await post('/gateway/outbox/claim', {});
    await post('/gateway/outbox/result', { requestId: created.id, status: 'failed', error: 'no service' });
    assert.strictEqual(requests.requests[0].status, STATUS.FAILED);
    assert.strictEqual(events.failed.length, 1);
  });
});

test('an abandoned claim is handed out again after the lease', async () => {
  const { requests, config } = setup();

  const created = requests.create({ chatId: 4, requestedNumber: '777' });
  assert.ok(requests.claimNext());
  assert.strictEqual(requests.claimNext(), null);

  // Simulate the phone dying mid-send.
  requests.requests[0].claimedAt = Date.now() - 5000;
  const again = requests.claimNext();
  assert.strictEqual(again.requestId, created.id);
});

test('unanswered requests expire after the timeout', async () => {
  const { requests } = setup();
  const created = requests.create({ chatId: 5, requestedNumber: '888' });
  requests.requests[0].expiresAt = Date.now() - 1;

  const expired = requests.expireStale();
  assert.strictEqual(expired.length, 1);
  assert.strictEqual(expired[0].id, created.id);
  assert.strictEqual(requests.requests[0].status, STATUS.EXPIRED);
  assert.strictEqual(requests.expireStale().length, 0, 'does not expire twice');
});

test('gateway routes reject a wrong or missing token', async () => {
  const { requests, config } = setup();

  await withServer(requests, config, async ({ post, base }) => {
    assert.strictEqual((await post('/gateway/outbox/claim', {}, 'nope')).status, 401);
    assert.strictEqual((await post('/gateway/inbound', { from: 'x', body: 'y' }, '')).status, 401);
    const health = await fetch(`${base}/health`);
    assert.strictEqual(health.status, 200);
  });
});

test('pending requests survive a restart', () => {
  const { requests, config, dir } = setup();
  const created = requests.create({ chatId: 9, requestedNumber: '1212' });

  const reloadedStore = new Store(path.join(dir, 'state.json'), quietLog);
  const reloaded = new RequestManager({ store: reloadedStore, config, log: quietLog });

  assert.strictEqual(reloaded.requests.length, 1);
  assert.strictEqual(reloaded.requests[0].id, created.id);
  assert.strictEqual(reloaded.claimNext().requestId, created.id);
});

test('numbersMatch tolerates formatting differences', () => {
  assert.ok(numbersMatch('+49 151 1234 5678', '015112345678'), 'country code and leading zero');
  assert.ok(numbersMatch('+15550001111', '5550001111'), 'missing country code');
  assert.ok(numbersMatch('+15550001111', '+15550001111'), 'identical');
  assert.ok(!numbersMatch('+15550001111', '+15550002222'), 'different subscribers');
  assert.ok(!numbersMatch('', '+15550001111'), 'missing value');
  assert.ok(numbersMatch('12345', '12345'), 'short code compared exactly');
  assert.ok(!numbersMatch('12345', '54321'), 'different short code');
});

test('a reply from the destination matches even when formats differ', () => {
  const { requests, config } = setup({ GATEWAY_SIM_DESTINATION_NUMBER: '+49 151 1234 5678' });
  const created = requests.create({ chatId: 11, requestedNumber: '4242' });
  requests.claimNext();
  requests.markResult({ requestId: created.id, status: 'sent' });

  const outcome = requests.handleInbound({
    from: '015112345678',
    body: '4242 parked at the depot',
    receivedAt: Date.now(),
    messageId: 'fmt-1',
  });

  assert.ok(outcome.request, `expected a match, got ${JSON.stringify(outcome)}`);
  assert.strictEqual(outcome.request.chatId, 11);
});
