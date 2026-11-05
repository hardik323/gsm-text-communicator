// lib/smsgate.js
// Client for the free "SMS Gateway for Android" app
// (https://sms-gate.app — github.com/capcom6/android-sms-gateway, Apache-2.0)
// running in **Local Server** mode: http://<phone-ip>:8080 with Basic auth.
//
//   POST /messages  { textMessage: { text }, phoneNumbers: [to] }  -> queued on the phone
//   GET  /inbox?type=SMS&limit=50                                  -> received messages
//   GET  /health
const { numbersMatch } = require('./requests');

const REQUEST_TIMEOUT_MS = 20_000;

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function createSmsGateClient({ baseUrl, username, password, log = console }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const authorization = basicAuth(username, password);

  async function call(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(base + path, {
        method,
        headers: { authorization, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        const error = new Error(
          `SMS Gateway ${method} ${path} failed: HTTP ${response.status} ${text.slice(0, 200)}`,
        );
        error.status = response.status;
        throw error;
      }
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  // Current releases expose /messages; older builds only have /message.
  async function sendMessage(to, text) {
    const payload = { textMessage: { text }, phoneNumbers: [to] };
    try {
      return await call('/messages', { method: 'POST', body: payload });
    } catch (error) {
      if (error.status !== 404) throw error;
      return call('/message', { method: 'POST', body: payload });
    }
  }

  async function listInbox({ limit = 50, since } = {}) {
    const params = new URLSearchParams({ type: 'SMS', limit: String(limit) });
    if (since) params.set('from', since instanceof Date ? since.toISOString() : String(since));

    const items = await call(`/inbox?${params.toString()}`);
    if (!Array.isArray(items)) {
      log.warn?.('⚠️  SMS Gateway returned an unexpected inbox payload (expected an array).');
      return [];
    }
    return items;
  }

  const health = () => call('/health');

  return { sendMessage, listInbox, health, base };
}

/**
 * Polls the app's inbox and feeds replies to the RequestManager.
 * Only messages from GATEWAY_SIM_DESTINATION_NUMBER are considered, and
 * messages older than the current reply window are ignored so a restart never
 * answers an old SMS.
 */
function createInboxWatcher({ client, requests, config, events = {}, log = console }) {
  const notBefore = Date.now() - config.RESPONSE_TIMEOUT_MS;
  let inFlight = false;

  async function pollOnce() {
    if (inFlight) return [];
    inFlight = true;
    try {
      const items = await client.listInbox({ limit: 50 });
      const delivered = [];

      // The app returns newest first; oldest first makes matching predictable.
      for (const item of [...items].reverse()) {
        const createdAt = Date.parse(item.createdAt) || 0;
        if (createdAt && createdAt < notBefore) continue;
        if (!numbersMatch(item.sender, config.GATEWAY_SIM_DESTINATION_NUMBER)) continue;

        const outcome = requests.handleInbound({
          from: item.sender,
          body: String(item.contentPreview || ''),
          receivedAt: createdAt || Date.now(),
          // The app's ids are content-based, so include the timestamp too.
          messageId: `smsgate:${item.id}:${item.createdAt || ''}`,
        });

        if (outcome.request) {
          delivered.push(outcome.request);
          events.onReply?.(outcome.request);
        }
      }

      return delivered;
    } catch (error) {
      log.warn?.(`⚠️  Could not read the SMS Gateway inbox: ${error.message}`);
      return [];
    } finally {
      inFlight = false;
    }
  }

  return { pollOnce };
}

module.exports = { createSmsGateClient, createInboxWatcher };
