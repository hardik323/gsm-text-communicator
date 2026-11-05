const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../lib/store');
const { RequestManager, STATUS } = require('../lib/requests');
const { createSmsGateClient, createInboxWatcher } = require('../lib/smsgate');

const quiet = { info() {}, warn() {}, error() {}, log() {} };

function makeConfig(overrides = {}) {
  return {
    GATEWAY_SIM_SENDER_NUMBER: '+15550002222',
    GATEWAY_SIM_DESTINATION_NUMBER: '+15550001111',
    RESPONSE_TIMEOUT_MS: 15 * 60 * 1000,
    CLAIM_LEASE_MS: 60 * 1000,
    SEND_MAX_ATTEMPTS: 3,
    ...overrides,
  };
}

function setup(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smsgate-'));
  const config = makeConfig(overrides);
  const store = new Store(path.join(dir, 'state.json'), quiet);
  const requests = new RequestManager({ store, config, log: quiet });
  return { config, store, requests };
}

// Stand-in for the Android app's local server.
async function startFakeApp({ inbox = [] } = {}) {
  const state = { sent: [], auth: [], inbox, missing: new Set(), inboxUrl: null };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      state.auth.push(req.headers.authorization || '');

      if (req.method === 'POST' && (req.url === '/messages' || req.url === '/message')) {
        if (state.missing.has(req.url)) {
          res.writeHead(404, { 'content-type': 'application/json' });
          return res.end('{"message":"not found"}');
        }
        state.sent.push({ url: req.url, body: JSON.parse(raw || '{}') });
        res.writeHead(201, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: `msg-${state.sent.length}` }));
      }

      if (req.method === 'GET' && req.url.startsWith('/inbox')) {
        state.inboxUrl = req.url;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(state.inbox));
      }

      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"status":"ok"}');
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{}');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, state, close: () => new Promise((resolve) => server.close(resolve)) };
}

const clientFor = (app) =>
  createSmsGateClient({ baseUrl: app.baseUrl, username: 'user', password: 'pass', log: quiet });

test('sends /location through the app API with basic auth', async () => {
  const app = await startFakeApp();
  try {
    const client = clientFor(app);
    const result = await client.sendMessage('+15550001111', '/location 12345');

    assert.strictEqual(result.id, 'msg-1');
    assert.strictEqual(app.state.sent.length, 1);
    assert.strictEqual(app.state.sent[0].url, '/messages');
    assert.strictEqual(app.state.sent[0].body.textMessage.text, '/location 12345');
    assert.deepStrictEqual(app.state.sent[0].body.phoneNumbers, ['+15550001111']);
    assert.strictEqual(
      app.state.auth[0],
      `Basic ${Buffer.from('user:pass').toString('base64')}`,
      'credentials must be sent as basic auth',
    );
  } finally {
    await app.close();
  }
});

test('falls back to the legacy /message route when /messages is missing', async () => {
  const app = await startFakeApp();
  try {
    app.state.missing.add('/messages');
    const result = await clientFor(app).sendMessage('+15550001111', '/location 9');

    assert.strictEqual(result.id, 'msg-1');
    assert.strictEqual(app.state.sent[0].url, '/message');
  } finally {
    await app.close();
  }
});

test('send failures surface with the HTTP status', async () => {
  const app = await startFakeApp();
  try {
    app.state.missing.add('/message');
    const broken = createSmsGateClient({
      baseUrl: `${app.baseUrl}/nope`,
      username: 'u',
      password: 'p',
      log: quiet,
    });
    await assert.rejects(() => broken.sendMessage('+15550001111', 'x'), /HTTP 404/);
  } finally {
    await app.close();
  }
});

test('polls the inbox with the SMS filter and limit', async () => {
  const app = await startFakeApp();
  try {
    await clientFor(app).listInbox({ limit: 20 });
    assert.match(app.state.inboxUrl, /type=SMS/);
    assert.match(app.state.inboxUrl, /limit=20/);
  } finally {
    await app.close();
  }
});

test('a reply SMS from the destination is routed to the right chat', async () => {
  const now = new Date().toISOString();
  const app = await startFakeApp({
    inbox: [
      {
        id: 'in-1',
        type: 'SMS',
        sender: '+15550001111',
        recipient: '+15550002222',
        contentPreview: '12345 is at 48.1372, 11.5756',
        createdAt: now,
      },
    ],
  });

  try {
    const { config, requests } = setup();
    const created = requests.create({ chatId: 42, username: 'alice', requestedNumber: '12345' });
    requests.markResult({ requestId: created.id, status: 'sent' });

    const replies = [];
    const watcher = createInboxWatcher({
      client: clientFor(app),
      requests,
      config,
      events: { onReply: (request) => replies.push(request) },
      log: quiet,
    });

    const delivered = await watcher.pollOnce();

    assert.strictEqual(delivered.length, 1);
    assert.strictEqual(replies.length, 1);
    assert.strictEqual(replies[0].chatId, 42);
    assert.match(replies[0].reply.body, /48\.1372/);
    assert.strictEqual(requests.requests[0].status, STATUS.ANSWERED);
  } finally {
    await app.close();
  }
});

test('replies from other senders are ignored and repeats are not redelivered', async () => {
  const now = new Date().toISOString();
  const app = await startFakeApp({
    inbox: [
      { id: 'other', type: 'SMS', sender: '+15559998888', contentPreview: '999 here', createdAt: now },
      { id: 'mine', type: 'SMS', sender: '+15550001111', contentPreview: '999 here', createdAt: now },
    ],
  });

  try {
    const { config, requests } = setup();
    const created = requests.create({ chatId: 7, username: null, requestedNumber: '999' });
    requests.markResult({ requestId: created.id, status: 'sent' });

    const replies = [];
    const watcher = createInboxWatcher({
      client: clientFor(app),
      requests,
      config,
      events: { onReply: (request) => replies.push(request) },
      log: quiet,
    });

    const first = await watcher.pollOnce();
    assert.strictEqual(first.length, 1, 'only the destination number counts');
    assert.strictEqual(replies.length, 1);

    const second = await watcher.pollOnce();
    assert.strictEqual(second.length, 0, 'the same SMS must not be answered twice');
  } finally {
    await app.close();
  }
});

test('messages older than the reply window are ignored', async () => {
  const app = await startFakeApp({
    inbox: [
      {
        id: 'old-1',
        type: 'SMS',
        sender: '+15550001111',
        contentPreview: '12345 from yesterday',
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      },
    ],
  });

  try {
    const { config, requests } = setup();
    const created = requests.create({ chatId: 3, username: null, requestedNumber: '12345' });
    requests.markResult({ requestId: created.id, status: 'sent' });

    const watcher = createInboxWatcher({
      client: clientFor(app),
      requests,
      config,
      events: {},
      log: quiet,
    });

    assert.strictEqual((await watcher.pollOnce()).length, 0);
    assert.strictEqual(requests.requests[0].status, STATUS.SENT);
  } finally {
    await app.close();
  }
});

test('an unreachable app does not crash the poller', async () => {
  const { config, requests } = setup();
  const watcher = createInboxWatcher({
    client: createSmsGateClient({
      baseUrl: 'http://127.0.0.1:1',
      username: 'u',
      password: 'p',
      log: quiet,
    }),
    requests,
    config,
    events: {},
    log: quiet,
  });

  assert.deepStrictEqual(await watcher.pollOnce(), []);
});
