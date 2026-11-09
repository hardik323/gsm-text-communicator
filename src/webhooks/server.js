'use strict';

/**
 * The receiver for SMS Gateway webhook callbacks.
 *
 * The gateway app POSTs the raw envelope; we normalise it and publish the
 * result on the `MessagesReceived` Redis channel, which programme.js listens
 * to. The world can reach this server only through the tunnel the operator
 * sets up for WEBHOOK_URL, so there is no token to check — the gateway's
 * only access control is that the URL is not publicised.
 */

const express = require('express');
const { parseSmsReceivedEvent } = require('../sms/gateway/client');

/**
 * Build the app. `publish` is awaited so a Redis failure surfaces as a 500
 * (and the gateway retries) instead of silently swallowing the message.
 */
function createWebhookServer({ publish }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.post('/webhook', async (req, res) => {
    const message = parseSmsReceivedEvent(req.body && typeof req.body === 'object' ? req.body : {});
    if (!message) {
      if (req.body && req.body.event) {
        console.log(`webhook ignored event "${req.body.event}"`);
        return res.json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'expected an sms:received payload' });
    }

    try {
      await publish(message);
    } catch (error) {
      console.error('webhook could not publish the received message:', error.message);
      return res.status(500).json({ ok: false, error: 'queue unavailable' });
    }

    console.log(`[webhook] received SMS from ${message.Sender}: ${message.Message.slice(0, 80)}`);
    return res.json({ ok: true });
  });

  return app;
}

module.exports = { createWebhookServer };
