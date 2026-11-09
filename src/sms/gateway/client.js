'use strict';

/**
 * Client for SMS Gateway for Android (free, open-source).
 * Docs: https://docs.sms-gate.app — cloud API base is https://api.sms-gate.app
 * with "/3rdparty/v1/..." paths, Basic auth with the gateway username/password
 * from the app's Home tab.
 *
 * This module only talks to the gateway: sending a message, registering a
 * webhook, and normalising an incoming webhook envelope. Which number to
 * text, and what to write, is decided by the operator lookup
 * (`src/sms/operators/`); the phone's own SIM is the SMS sender and
 * `simNumber` picks the slot on dual-SIM phones.
 */

const { config } = require('../../config');

/**
 * True when the gateway phone can be asked to send. The receiver is no longer
 * fixed in .env — it comes from the `Tsp` table for the operator API Express
 * found — so only the gateway account credentials matter here.
 */
function isConfigured() {
  return Boolean(config.sms.username && config.sms.password);
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Basic ${Buffer.from(`${config.sms.username}:${config.sms.password}`).toString('base64')}`,
  };
}

/**
 * Queue one SMS. Resolves with the parsed gateway response
 * ({ id, state, recipients, … }); rejects on a non-2xx reply.
 */
async function sendSms({ to, text, simNumber, deviceId, fetchImpl = fetch } = {}) {
  const body = { phoneNumbers: [to], textMessage: { text } };

  const sim = simNumber !== undefined ? simNumber : config.sms.simNumber;
  if (sim && sim >= 1 && sim <= 3) body.simNumber = sim;

  const device = deviceId !== undefined ? deviceId : config.sms.deviceId;
  if (device) body.deviceId = device;

  const query = new URLSearchParams();
  if (config.sms.skipPhoneValidation) query.set('skipPhoneValidation', 'true');

  const url = `${config.sms.baseUrl}/3rdparty/v1/messages${query.toString() ? `?${query}` : ''}`;
  const response = await fetchImpl(url, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
  const reply = await response.text();

  if (!response.ok) {
    throw new Error(`SMS gateway responded ${response.status} to /messages: ${reply.slice(0, 200)}`);
  }
  return JSON.parse(reply);
}

/** Register (or re-register) a webhook with the gateway. Resolves with the webhook. */
async function registerWebhook({ url, event = 'sms:received', deviceId, fetchImpl = fetch } = {}) {
  if (!url) throw new Error('a webhook url is required');
  const body = { url, event };
  if (deviceId) body.deviceId = deviceId;

  const response = await fetchImpl(`${config.sms.baseUrl}/3rdparty/v1/webhooks`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`SMS gateway responded ${response.status} to /webhooks: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

/**
 * Normalise a gateway webhook envelope into our message shape. Returns null
 * for anything that is not an `sms:received` event (the gateway can also
 * send sms:delivered, system:ping, and so on; we only care about replies).
 *
 * It lives here rather than in the webhook receiver because this is the
 * gateway's own payload format; `src/webhooks/server.js` publishes whatever
 * this returns onto the `MessagesReceived` channel.
 */
function parseSmsReceivedEvent(envelope) {
  if (!envelope || envelope.event !== 'sms:received' || !envelope.payload) return null;

  const p = envelope.payload;
  return {
    Id: envelope.id || p.messageId || null,
    DeviceId: envelope.deviceId || null,
    Sender: p.sender || p.phoneNumber || null,
    Recipient: p.recipient || null,
    Message: p.message || '',
    ReceivedAt: p.receivedAt || new Date().toISOString(),
    SimNumber: p.simNumber ?? null,
  };
}

module.exports = { isConfigured, sendSms, registerWebhook, parseSmsReceivedEvent };

