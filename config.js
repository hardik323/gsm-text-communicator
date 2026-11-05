// config.js
// Loads environment variables from .env file using dotenv
const path = require('path');
const dotenv = require('dotenv');

const result = dotenv.config();

if (result.error) {
  console.warn('⚠️  No .env file found or failed to load environment variables.');
}

function readNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(`⚠️  ${name} must be a positive number, using ${fallback}.`);
    return fallback;
  }
  return value;
}

// Which SMS backend to use:
//   smsgate -> the "SMS Gateway for Android" app (no custom code on the phone)
//   local   -> the bundled android-gateway app in this repository
const PROVIDERS = ['smsgate', 'local'];
const rawProvider = (process.env.SMS_PROVIDER || 'smsgate').trim().toLowerCase();
const SMS_PROVIDER = PROVIDERS.includes(rawProvider) ? rawProvider : 'smsgate';
if (rawProvider && !PROVIDERS.includes(rawProvider)) {
  console.warn(`⚠️  SMS_PROVIDER must be one of ${PROVIDERS.join(', ')}, using smsgate.`);
}

const config = {
  // --- Telegram -------------------------------------------------------------
  TELEGRAM_BOT_TOKEN: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),

  // --- SMS backend selection ------------------------------------------------
  SMS_PROVIDER,

  // SMS Gateway for Android app (local server mode, e.g. http://192.168.31.50:8080)
  SMSGATE_URL: (process.env.SMSGATE_URL || '').trim().replace(/\/+$/, ''),
  SMSGATE_USERNAME: (process.env.SMSGATE_USERNAME || '').trim(),
  SMSGATE_PASSWORD: (process.env.SMSGATE_PASSWORD || '').trim(),
  // How often to poll the app's inbox for replies
  SMSGATE_POLL_SECONDS: readNumber('SMSGATE_POLL_SECONDS', 5),

  // --- GSM gateway SIMs -----------------------------------------------------
  // The SIM inside the Android gateway phone.
  GATEWAY_SIM_SENDER_NUMBER: (process.env.GATEWAY_SIM_SENDER_NUMBER || '').trim(),
  // The device that answers "/location {number}" queries.
  GATEWAY_SIM_DESTINATION_NUMBER: (process.env.GATEWAY_SIM_DESTINATION_NUMBER || '').trim(),

  // --- Gateway HTTP API (used by the Android app) ---------------------------
  // Shared secret; the phone sends it in the "x-gateway-token" header.
  GATEWAY_TOKEN: (process.env.GATEWAY_TOKEN || '').trim(),
  GATEWAY_HOST: (process.env.GATEWAY_HOST || '0.0.0.0').trim(),
  GATEWAY_PORT: readNumber('GATEWAY_PORT', 8080),

  // --- Behaviour ------------------------------------------------------------
  // How long we wait for the reply SMS before giving up on a request.
  RESPONSE_TIMEOUT_MINUTES: readNumber('RESPONSE_TIMEOUT_MINUTES', 5),
  // How long a claimed SMS stays "in flight" before it can be handed out again.
  CLAIM_LEASE_SECONDS: readNumber('CLAIM_LEASE_SECONDS', 60),
  // How many times a failing SMS is retried before the request is failed.
  SEND_MAX_ATTEMPTS: readNumber('SEND_MAX_ATTEMPTS', 3),

  DATA_FILE: (process.env.DATA_FILE || '').trim() || path.join(__dirname, 'data', 'state.json'),
};

config.RESPONSE_TIMEOUT_MS = Math.round(config.RESPONSE_TIMEOUT_MINUTES * 60 * 1000);
config.CLAIM_LEASE_MS = Math.round(config.CLAIM_LEASE_SECONDS * 1000);

config.SMSGATE_POLL_MS = Math.round(config.SMSGATE_POLL_SECONDS * 1000);

// Variables the bot cannot run without (depends on the chosen backend).
config.missingRequired = () => {
  const required = ['TELEGRAM_BOT_TOKEN', 'GATEWAY_SIM_DESTINATION_NUMBER'];
  if (config.SMS_PROVIDER === 'smsgate') {
    required.push('SMSGATE_URL', 'SMSGATE_USERNAME', 'SMSGATE_PASSWORD');
  } else {
    required.push('GATEWAY_SIM_SENDER_NUMBER', 'GATEWAY_TOKEN');
  }
  return required.filter((key) => !config[key]);
};

module.exports = config;
