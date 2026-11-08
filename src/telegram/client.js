'use strict';

const TelegramBot = require('node-telegram-bot-api');

/**
 * Create the polling bot and a `send` helper that never throws: a failed reply
 * is logged, because one undeliverable message must not kill the process.
 */
function createTelegramClient(token) {
  const bot = new TelegramBot(token, { polling: true });

  const send = (chatId, text, replyTo) =>
    bot
      .sendMessage(chatId, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}),
      })
      .catch((error) => console.warn(`could not reply in chat ${chatId}:`, error.message));

  return { bot, send };
}

module.exports = { createTelegramClient };
