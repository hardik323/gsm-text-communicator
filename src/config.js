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
    messageChannel: envText('REDIS_MESSAGE_CHANNEL', 'MessagesReceived'),
    botResponseChannel: envText('REDIS_BOT_RESPONSE_CHANNEL', 'BotResponse'),
  },

  // API Express telecom operator detection. programme.js asks it which
  // carrier owns a query number, stores the answer in locationRequests.TSP,
  // then picks that carrier's nodal number and message format out of the
  // `Tsp` table.
  telecom: {
    apiKey: envText('APIEXPRESS_API_KEY', ''),
    operatorUrl: envText('APIEXPRESS_URL', 'https://api.apiexpress.in/v1/telecom/operator'),
    timeoutMs: envNumber('APIEXPRESS_TIMEOUT_MS', 8000),
  },

  // How long we wait for the carrier's location reply before a request is
  // declared timed out, and how often the sweeper checks.
  timeouts: {
    nodalResponseMinutes: envNumber('NODAL_RESPONSE_TIMEOUT_MINUTES', 15),
    sweepMs: envNumber('NODAL_SWEEP_MS', 30 * 1000),
  },

  sms: {
    // SMS Gateway for Android (free, open-source). The phone's own SIM number
    // is the SMS sender; these are the gateway account credentials shown on
    // the app's Home tab.
    username: envText('SMS_GATEWAY_USERNAME', ''),
    password: envText('SMS_GATEWAY_PASSWORD', ''),
    // Cloud: https://api.sms-gate.app. Local phone: http://<device_ip>:8080.
    // Private server: https://your-domain.com/api.
    baseUrl: envText('SMS_GATEWAY_BASE_URL', 'https://api.sms-gate.app').replace(/\/$/, ''),
    // Fallback only: the lookup SMS normally goes to the nodal number of the
    // carrier found by the operator API, from the `Tsp` table. This is used
    // only when the operator has not been detected.
    nodalNumber: envText('NODAL_NUMBER', ''),
    // 1-based SIM slot in the gateway phone (1..3). 0 = gateway default.
    simNumber: envNumber('SMS_SIM_NUMBER', 0),
    // Gateway device id; empty = the gateway picks any linked device.
    deviceId: envText('SMS_DEVICE_ID', ''),
    // Nodal numbers are service codes (e.g. 27277), not E.164 phone numbers,
    // and the API rejects them unless phone validation is skipped.
    skipPhoneValidation: /^(1|true|yes)$/i.test(envText('SMS_SKIP_PHONE_VALIDATION', 'true')),
  },

  webhook: {
    host: envText('WEBHOOK_HOST', '127.0.0.1'),
    port: envNumber('WEBHOOK_PORT', 3001),
    // Public HTTPS URL of this receiver, e.g. https://…/webhook. When set,
    // `bun webhook` registers it with the gateway on startup.
    url: envText('WEBHOOK_URL', ''),
  },

  dashboard: {
    host: envText('DASHBOARD_HOST', '127.0.0.1'),
    port: envNumber('DASHBOARD_PORT', 3000),
  },
};

module.exports = { config };
