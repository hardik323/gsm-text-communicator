// lib/requests.js
// The pending-request state machine.
//
// Lifecycle: queued -> sending -> sent -> answered
//                       \-> queued (retry) / failed
//            any open state -> expired (no reply before the timeout)
const STATUS = Object.freeze({
  QUEUED: 'queued',
  SENDING: 'sending',
  SENT: 'sent',
  ANSWERED: 'answered',
  FAILED: 'failed',
  EXPIRED: 'expired',
});

// States that are still waiting for an SMS reply.
const OPEN_STATUSES = new Set([STATUS.QUEUED, STATUS.SENDING, STATUS.SENT]);

function normalizeNumber(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

// Compares two phone numbers ignoring formatting, a leading zero and a country
// code, so "+49 151 1234 5678" and "015112345678" match. Short numbers (short
// codes) are compared exactly.
function numbersMatch(a, b) {
  const left = normalizeNumber(a);
  const right = normalizeNumber(b);
  if (!left || !right) return false;
  if (left === right) return true;

  const size = Math.min(left.length, right.length);
  if (size < 7) return false;

  // The national significant number: at most the last 10 digits.
  const tail = Math.min(size, 10);
  return left.slice(-tail) === right.slice(-tail);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function newId(now) {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

class RequestManager {
  constructor({ store, config, log = console }) {
    this.store = store;
    this.config = config;
    this.log = log;
  }

  get requests() {
    return this.store.state.requests;
  }

  // Queue one "/location {number}" SMS for the gateway phone.
  create({ chatId, username, requestedNumber }) {
    const now = Date.now();
    const request = {
      id: newId(now),
      chatId,
      username: username || null,
      requestedNumber,
      // Body which is handed to the phone verbatim.
      smsBody: `/location ${requestedNumber}`,
      to: this.config.GATEWAY_SIM_DESTINATION_NUMBER,
      from: this.config.GATEWAY_SIM_SENDER_NUMBER,
      status: STATUS.QUEUED,
      attempts: 0,
      createdAt: now,
      claimedAt: null,
      sentAt: null,
      answeredAt: null,
      expiresAt: now + this.config.RESPONSE_TIMEOUT_MS,
      lastError: null,
      reply: null,
    };

    this.requests.push(request);
    this.store.trim();
    this.store.save();
    return request;
  }

  // The phone asks for work. Returns the oldest available SMS and locks it
  // with a lease so a crashed phone does not block it forever.
  claimNext() {
    const now = Date.now();
    const leaseMs = this.config.CLAIM_LEASE_MS;

    const request = this.requests.find((r) => {
      if (r.status === STATUS.QUEUED) return true;
      if (r.status === STATUS.SENDING && r.claimedAt && now - r.claimedAt > leaseMs) return true;
      return false;
    });
    if (!request) return null;

    request.status = STATUS.SENDING;
    request.claimedAt = now;
    this.store.save();

    return { requestId: request.id, to: request.to, body: request.smsBody };
  }

  // The phone reports how the send went.
  markResult({ requestId, status, error }) {
    const request = this.requests.find((r) => r.id === requestId);
    if (!request) return null;

    // Terminal states are never reopened by a late phone report.
    if (!OPEN_STATUSES.has(request.status)) {
      return { request, changed: false };
    }

    if (status === 'sent') {
      request.status = STATUS.SENT;
      request.sentAt = Date.now();
      request.claimedAt = null;
      request.lastError = null;
      this.store.save();
      return { request, changed: true };
    }

    request.attempts += 1;
    request.claimedAt = null;
    request.lastError = String(error || 'send failed').slice(0, 300);
    request.status = request.attempts >= this.config.SEND_MAX_ATTEMPTS ? STATUS.FAILED : STATUS.QUEUED;
    this.store.save();
    return { request, changed: true };
  }

  // An SMS arrived on the gateway phone.
  handleInbound({ from, body, receivedAt, messageId }) {
    const cleanBody = String(body || '').trim();

    // The phone may deliver the same SMS twice (reboot, retry); drop repeats.
    if (messageId) {
      if (this.store.state.seenInbound.includes(messageId)) return { duplicate: true };
      this.store.state.seenInbound.push(messageId);
    }

    if (!numbersMatch(from, this.config.GATEWAY_SIM_DESTINATION_NUMBER)) {
      this.store.save();
      return {
        ignored: true,
        reason: 'sender is not GATEWAY_SIM_DESTINATION_NUMBER',
        inbound: { from, body: cleanBody, receivedAt },
      };
    }

    const open = this.requests.filter((r) => OPEN_STATUSES.has(r.status) && !r.reply);
    if (open.length === 0) {
      this.store.save();
      return {
        ignored: true,
        reason: 'no pending request to match this reply to',
        inbound: { from, body: cleanBody, receivedAt },
      };
    }

    // Prefer a pending request whose number appears in the reply, so several
    // people waiting at the same time still get the right answer. Otherwise
    // fall back to the oldest request.
    const byNumber = open.find((r) =>
      new RegExp(`(^|\\D)${escapeRegex(r.requestedNumber)}(\\D|$)`).test(cleanBody),
    );
    const request = byNumber || [...open].sort((a, b) => a.createdAt - b.createdAt)[0];

    request.status = STATUS.ANSWERED;
    request.answeredAt = Date.now();
    request.reply = {
      from,
      body: cleanBody,
      receivedAt: Number(receivedAt) || Date.now(),
      messageId: messageId || null,
    };
    this.store.save();

    return { request };
  }

  // Fail every request whose reply window has passed.
  expireStale(now = Date.now()) {
    const expired = [];
    for (const request of this.requests) {
      if (OPEN_STATUSES.has(request.status) && request.expiresAt <= now) {
        request.status = STATUS.EXPIRED;
        expired.push(request);
      }
    }
    if (expired.length > 0) this.store.save();
    return expired;
  }
}

module.exports = { RequestManager, STATUS, numbersMatch, normalizeNumber };
