'use strict';

/**
 * Entry point: the receiver for texts arriving at the gateway phone's SIM.
 *
 * Run it with `bun webhook`, then point the SMS Gateway app's webhook (or
 * `POST /3rdparty/v1/webhooks` with the same URL) at `WEBHOOK_URL` — a
 * public HTTPS URL serving this process, e.g. a tunnel. With `WEBHOOK_URL`
 * set, the receiver registers itself with the gateway on start-up
 * (`registerWithGateway`). Incoming texts are republished on the
 * `MessagesReceived` Redis channel for programme.js.
 */

const { config } = require('./src/config');
const { publishMessagesReceived, close } = require('./src/queue/messagesReceived');
const { createWebhookServer } = require('./src/webhooks/server');
const { registerWebhook } = require('./src/sms/gateway/client');

/**
 * Register this receiver with the gateway, when both an URL and the gateway
 * credentials are configured. Everything is a parameter so the decision can
 * be tested without the network.
 */
async function registerWithGateway({
  url = config.webhook.url,
  configured = Boolean(config.sms.username && config.sms.password),
  register = registerWebhook,
} = {}) {
  if (!url) return null;
  if (!configured) {
    console.warn('WEBHOOK_URL is set but SMS_GATEWAY_USERNAME/PASSWORD are not — skipping registration.');
    return null;
  }

  try {
    const webhook = await register({ url });
    console.log(`registered webhook ${webhook.id || ''} (${webhook.url}, ${webhook.event}) with the SMS gateway`);
    return webhook;
  } catch (error) {
    console.error('could not register the webhook with the SMS gateway:', error.message);
    return null;
  }
}

if (require.main === module) {
  const app = createWebhookServer({ publish: publishMessagesReceived });
  const server = app.listen(config.webhook.port, config.webhook.host, () => {
    console.log(`SMS webhook receiver on http://${config.webhook.host}:${config.webhook.port}/webhook`);
    console.log('Point the SMS Gateway app (Settings → Webhooks) at this URL, or set WEBHOOK_URL in .env.');
  });

  registerWithGateway();

  process.on('SIGINT', async () => {
    server.close();
    await close();
    process.exit(0);
  });
}

module.exports = { registerWithGateway };
