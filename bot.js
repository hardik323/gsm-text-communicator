'use strict';

/**
 * Entry point: the Telegram bot.
 *
 *   /location {query_number}  -> validate -> save (status 1) -> acknowledge
 *                             -> publish to the LocationRequests channel
 *   every other message       -> "wrong command" + the correct command
 *   too many wrong in a row   -> ignored for a while
 *
 * Everything it uses lives in src/, one folder per responsibility.
 */

const { config } = require('./src/config');
const { createTelegramClient } = require('./src/telegram/client');
const { createMessageHandler, createReplyHandler } = require('./src/telegram/handler');
const { disconnect: disconnectDb } = require('./src/db/prisma');
const { close: closeQueue } = require('./src/queue/locationRequests');
const {
  CHANNEL: BOT_RESPONSE_CHANNEL,
  subscribe: subscribeReplies,
  close: closeReplies,
} = require('./src/queue/botResponse');

async function main() {
  if (!config.telegram.token) {
    console.error('❌ Missing required environment variable: TELEGRAM_BOT_TOKEN');
    console.error('   Add it to .env, then start the bot again.');
    process.exit(1);
  }

  const { bot, send, telegram } = createTelegramClient(config.telegram.token);

  bot.on('message', createMessageHandler({ send }));
  bot.on('polling_error', (error) => console.error('polling error:', error.message));

  // Listen for the structured reply that the reply reactor publishes when a
  // carrier SMS comes back and is matched to a request.
  const unsubscribeReplies = await subscribeReplies(createReplyHandler({ send }));
  console.log(`Listening on "${BOT_RESPONSE_CHANNEL}" (replies → Telegram user).`);

  console.log('Telegram bot is running.');
  console.log(
    `Waiting for /location {mobile number} · ${config.spam.maxWrong} wrong commands per ${Math.round(
      config.spam.windowMs / 1000,
    )}s, then a ${Math.round(config.spam.blockMs / 60000)} minute block.`,
  );

  // Clean up the reply subscription on shutdown.
  if (bot) {
    bot.once('close', async () => {
      unsubscribeReplies();
      await Promise.allSettled([closeReplies(), disconnectDb(), closeQueue()]);
    });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });

  process.on('SIGINT', async () => {
    await Promise.allSettled([disconnectDb(), closeQueue()]);
    process.exit(0);
  });
}
