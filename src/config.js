'use strict';

/**
 * Every configurable value lives here, read once from .env at startup.
 * Anything that is *not* configuration (message wording, status codes) belongs
 * in constants/.
 */

require('dotenv').config();

function envNumber(name, fallback) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(`${name} must be a positive number, using ${fallback}`);
    return fallback;
  }
  return Math.round(value);
}

function envText(name, fallback) {
  return (process.env[name] || fallback).trim();
}

const config = {
  telegram: {
    token: envText('TELEGRAM_BOT_TOKEN', ''),
  },

  spam: {
    maxWrong: envNumber('MAX_WRONG', 3),
    windowMs: envNumber('WRONG_WINDOW_SECONDS', 60) * 1000,
    blockMs: envNumber('BLOCK_SECONDS', 60) * 1000,
  },

  numbers: {
    minDigits: envNumber('MIN_DIGITS', 7),
    maxDigits: envNumber('MAX_DIGITS', 15),
  },

  redis: {
    url: envText('REDIS_URL', 'redis://127.0.0.1:6379'),
    channel: envText('REDIS_CHANNEL', 'LocationRequests'),
  },
};

module.exports = { config };
