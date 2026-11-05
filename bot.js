const TelegramBot = require('node-telegram-bot-api');

const config = require('./config');
const { Store } = require('./lib/store');
const { RequestManager, STATUS } = require('./lib/requests');
const { createGateway } = require('./lib/gateway');
const { createSmsGateClient, createInboxWatcher } = require('./lib/smsgate');

const missing = config.missingRequired();
if (missing.length > 0) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
  console.error('   Copy .env.example to .env and fill them in.');
  process.exit(1);
}

// smsgate -> talk to the "SMS Gateway for Android" app directly (no build needed)
// local   -> queue work for the bundled android-gateway phone (phone polls us)
const USE_SMSGATE = config.SMS_PROVIDER === 'smsgate';

const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
const store = new Store(config.DATA_FILE);
const requests = new RequestManager({ store, config });

const smsgate = USE_SMSGATE
  ? createSmsGateClient({
      baseUrl: config.SMSGATE_URL,
      username: config.SMSGATE_USERNAME,
      password: config.SMSGATE_PASSWORD,
    })
  : null;

const TELEGRAM_MAX_LENGTH = 3500;

function truncate(text, max = TELEGRAM_MAX_LENGTH) {
  const value = String(text || '');
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function who(request) {
  return request.username ? `@${request.username}` : `chat ${request.chatId}`;
}

function seconds(ms) {
  return Math.max(1, Math.round(ms / 1000));
}

// --- Reply / failure notifications -------------------------------------------
const events = {
  onReply(request) {
    const elapsed = (request.answeredAt || Date.now()) - (request.sentAt || request.createdAt);
    const roundTrip = `${seconds(elapsed)}s`;

    console.log(`📩 Reply for ${request.requestedNumber} (${who(request)}) after ${roundTrip}.`);

    bot
      .sendMessage(
        request.chatId,
        `📩 Reply for /location ${request.requestedNumber}\n\n${truncate(request.reply.body)}\n\n` +
          `⏱ ${roundTrip} · ${new Date(request.answeredAt).toLocaleString()}`,
      )
      .catch((err) => console.error(`Failed to notify chat ${request.chatId}: ${err.message}`));
  },

  onSendFailed(request) {
    bot
      .sendMessage(
        request.chatId,
        `❌ Could not send the SMS for /location ${request.requestedNumber} ` +
          `after ${request.attempts} attempt(s).\nReason: ${request.lastError || 'unknown error'}`,
      )
      .catch((err) => console.error(`Failed to notify chat ${request.chatId}: ${err.message}`));
  },

  onUnmatchedInbound(outcome) {
    console.warn(`⚠️  Dropped inbound SMS from ${outcome.inbound.from}: ${outcome.reason}`);
  },
};

// --- Sending (smsgate backend only) ------------------------------------------
// With the local backend the SMS is queued and the phone picks it up instead.
async function deliver(request) {
  if (!USE_SMSGATE) return;

  for (let attempt = 1; attempt <= config.SEND_MAX_ATTEMPTS; attempt += 1) {
    try {
      const sent = await smsgate.sendMessage(request.to, request.smsBody);
      const result = requests.markResult({ requestId: request.id, status: 'sent' });
      if (result && result.request) {
        result.request.providerMessageId = (sent && (sent.id || sent.messageId)) || null;
        store.save();
      }
      return;
    } catch (error) {
      console.warn(
        `Attempt ${attempt}/${config.SEND_MAX_ATTEMPTS} failed for ` +
          `${request.requestedNumber}: ${error.message}`,
      );

      const result = requests.markResult({
        requestId: request.id,
        status: 'failed',
        error: error.message,
      });
      if (!result) return;

      if (result.request.status === STATUS.FAILED) {
        events.onSendFailed(result.request);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
}

// --- Telegram ----------------------------------------------------------------
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const username = msg.from && msg.from.username ? msg.from.username : null;

  if (text) {
    console.log(`Received message from ${chatId}: ${text}`);
  }

  const [rawCommand, ...args] = text.split(/\s+/);
  // Supports the "/location@YourBot" form used in groups.
  const command = (rawCommand || '').split('@')[0].toLowerCase();

  if (command !== '/location') {
    // Keep the original echo behaviour for plain chat text.
    if (text && !text.startsWith('/')) {
      bot.sendMessage(chatId, `You said: ${text}`);
    }
    return;
  }

  if (args.length !== 1) {
    bot.sendMessage(chatId, '❌ Invalid format. Use `/location {number}`.');
    return;
  }

  const requestedNumber = args[0];
  if (!/^[0-9]+$/.test(requestedNumber)) {
    bot.sendMessage(chatId, '❌ The number must be numeric.');
    return;
  }

  const request = requests.create({ chatId, username, requestedNumber });

  const pending = requests.requests.filter(
    (r) => r.chatId === chatId && [STATUS.QUEUED, STATUS.SENDING, STATUS.SENT].includes(r.status),
  ).length;

  console.log(
    `📍 Queued /location ${requestedNumber} -> ${request.to} (request ${request.id}, ${who(request)}, ` +
      `${pending} pending in this chat).`,
  );

  const waitNote = `Waiting up to ${config.RESPONSE_TIMEOUT_MINUTES} min for the reply…`;
  const extra = pending > 1 ? ` (${pending} requests pending in this chat.)` : '';

  bot
    .sendMessage(
      chatId,
      `📤 Sending \`/location ${requestedNumber}\` over SMS.\n${waitNote}${extra}`,
      { parse_mode: 'Markdown' },
    )
    .catch(() => {
      // Markdown can fail on odd input; retry as plain text.
      bot.sendMessage(chatId, `📤 Sending /location ${requestedNumber} over SMS. ${waitNote}${extra}`);
    });

  deliver(request).catch((err) => console.error(`Unexpected send error: ${err.message}`));
});

bot.on('polling_error', (err) => {
  console.error(`Telegram polling error: ${err.message}`);
});

// --- Reply-timeout sweeper ---------------------------------------------------
setInterval(() => {
  for (const request of requests.expireStale()) {
    console.log(`⌛ Request ${request.id} (${request.requestedNumber}) timed out.`);
    bot
      .sendMessage(
        request.chatId,
        `⌛ No reply for /location ${request.requestedNumber} within ` +
          `${config.RESPONSE_TIMEOUT_MINUTES} min. The phone did not answer in time.`,
      )
      .catch((err) => console.error(`Failed to notify chat ${request.chatId}: ${err.message}`));
  }
}, 15 * 1000).unref();

// --- Backend startup ---------------------------------------------------------
let server = null;

if (USE_SMSGATE) {
  console.log('Telegram bot is running.');
  console.log(`SMS backend: "SMS Gateway for Android" at ${smsgate.base}`);
  console.log(
    `Replies accepted from ${config.GATEWAY_SIM_DESTINATION_NUMBER} · ` +
      `timeout ${config.RESPONSE_TIMEOUT_MINUTES} min · polling every ${config.SMSGATE_POLL_SECONDS}s`,
  );

  const watcher = createInboxWatcher({ client: smsgate, requests, config, events });

  smsgate
    .health()
    .then(() => console.log('✅ SMS Gateway app is reachable.'))
    .catch((err) =>
      console.error(`⚠️  Cannot reach the SMS Gateway app at ${smsgate.base}: ${err.message}`),
    );

  watcher.pollOnce().catch(() => {});
  setInterval(() => watcher.pollOnce().catch(() => {}), config.SMSGATE_POLL_MS).unref();
} else {
  const app = createGateway({ requests, config, events });
  server = app.listen(config.GATEWAY_PORT, config.GATEWAY_HOST, () => {
    console.log('Telegram bot is running.');
    console.log(`Gateway API listening on http://${config.GATEWAY_HOST}:${config.GATEWAY_PORT}`);
    console.log(
      `SIM ${config.GATEWAY_SIM_SENDER_NUMBER} -> ${config.GATEWAY_SIM_DESTINATION_NUMBER} · ` +
        `timeout ${config.RESPONSE_TIMEOUT_MINUTES} min`,
    );
  });

  server.on('error', (err) => {
    console.error(`❌ Gateway server failed to start: ${err.message}`);
    process.exit(1);
  });
}

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down…`);
  if (server) {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
