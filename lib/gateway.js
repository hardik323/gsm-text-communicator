// lib/gateway.js
// HTTP API used by the Android gateway phone.
//
//   POST /gateway/outbox/claim   -> { sms: { requestId, to, body } | null }
//   POST /gateway/outbox/result  -> send report from the phone
//   POST /gateway/inbound        -> an SMS that arrived on the phone
//   GET  /health                 -> liveness probe
//
// Every /gateway/* route requires the shared token in the "x-gateway-token"
// header, because this endpoint is reachable from the public internet.
const crypto = require('crypto');
const express = require('express');

function createGateway({ requests, config, events = {}, log = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  const expected = config.GATEWAY_TOKEN || '';

  const requireToken = (req, res, next) => {
    const provided = String(req.get('x-gateway-token') || '');
    const providedBuf = Buffer.from(provided);
    const expectedBuf = Buffer.from(expected);
    const ok =
      expectedBuf.length > 0 &&
      providedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(providedBuf, expectedBuf);
    if (!ok) return res.status(401).json({ error: 'unauthorized' });
    return next();
  };

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      sender: config.GATEWAY_SIM_SENDER_NUMBER,
    });
  });

  app.post('/gateway/outbox/claim', requireToken, (req, res) => {
    const sms = requests.claimNext();
    res.json({ sms });
  });

  app.post('/gateway/outbox/result', requireToken, (req, res) => {
    const { requestId, status, error } = req.body || {};
    if (!requestId || (status !== 'sent' && status !== 'failed')) {
      return res.status(400).json({ error: 'requestId and status ("sent" or "failed") are required' });
    }

    const result = requests.markResult({ requestId, status, error });
    if (!result) return res.status(404).json({ error: 'unknown requestId' });

    if (result.changed && result.request.status === 'failed') {
      events.onSendFailed?.(result.request);
    }

    return res.json({ ok: true, status: result.request.status });
  });

  app.post('/gateway/inbound', requireToken, (req, res) => {
    const { from, body, receivedAt, messageId } = req.body || {};
    if (!from || typeof body !== 'string') {
      return res.status(400).json({ error: 'from and body are required' });
    }

    const outcome = requests.handleInbound({
      from,
      body,
      receivedAt: Number(receivedAt) || Date.now(),
      messageId: messageId || null,
    });

    if (outcome.duplicate) {
      log.info?.(`↩️  Duplicate inbound SMS ignored (${messageId}).`);
      return res.json({ ok: true, duplicate: true });
    }

    if (outcome.ignored) {
      log.warn?.(`⚠️  Unmatched inbound SMS from ${from}: ${outcome.reason}`);
      events.onUnmatchedInbound?.(outcome);
      return res.json({ ok: true, matched: false, reason: outcome.reason });
    }

    events.onReply?.(outcome.request);
    return res.json({ ok: true, matched: true, requestId: outcome.request.id });
  });

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log.error?.(`Gateway error: ${err.message}`);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

module.exports = { createGateway };
