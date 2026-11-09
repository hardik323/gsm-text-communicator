'use strict';

/**
 * Entry point: the consumer side of the queue.
 *
 *   `LocationRequests` — a new request arrived (status 1, CREATED)
 *
 *     1. The row is marked TSP_REQUESTED and API Express is asked which
 *        operator owns the number (`src/sms/operators/detect.js`).
 *     2. The answer is stored in `TSP` with status TSP_FOUND, the matching
 *        carrier's row is read from the `Tsp` table (`table.js`), and one
 *        SMS goes out to its nodal number, formatted with its RequestFormat
 *        (`providers.js`). The gateway phone's own SIM is the sender.
 *     3. The row moves to LOCATION_REQUESTED and waits for the reply.
 *
 *   `MessagesReceived` — a text arrived at that SIM
 *
 *     The number echoed in the reply is matched against the open requests
 *     (`src/sms/replies/records.js`): a match means the location information
 *     is here, so the reply is saved as NodalResponse and the row moves to
 *     NODAL_RESPONSE_FOUND. No match yet is normal — the reply can arrive
 *     before the lookup SMS is recorded — so the sweeper below re-checks.
 *
 *   The sweeper runs every NODAL_SWEEP_MS — a request whose SMS went out but
 *   which gets no location reply within NODAL_RESPONSE_TIMEOUT_MINUTES (15)
 *   becomes NODAL_RESPONSE_TIMEOUT; one whose operator lookup never returned
 *   at all becomes FAILED. So a row can never sit in progress for ever.
 *
 * Everything below the entry point is wired through `createFlow`, so tests
 * can drive the whole flow with stubbed collaborators. Run it with
 * `bun programme.js` (or `bun run programme`) alongside `bun webhook` and
 * `bun start`.
 */

const { config } = require('./src/config');
const { Status } = require('./src/constants/status');
const {
  CHANNEL,
  subscribe: subscribeRequests,
  close: closeRequests,
} = require('./src/queue/locationRequests');
const {
  CHANNEL: MESSAGES_CHANNEL,
  subscribe: subscribeMessages,
  close: closeMessages,
} = require('./src/queue/messagesReceived');
const {
  isConfigured: smsGatewayConfigured,
  sendSms,
} = require('./src/sms/gateway/client');
const {
  isConfigured: operatorApiConfigured,
  detectOperator,
  findProvider,
} = require('./src/sms/operators/detect');
const {
  DEFAULT_PROVIDERS,
  buildProviderMessage,
} = require('./src/sms/operators/providers');
const {
  listProviders,
  ensureProviders,
} = require('./src/sms/operators/table');
const {
  setStatus,
  setTsp,
  closeStaleRequests,
} = require('./src/db/locations');
const { recordNodalResponse } = require('./src/sms/replies/records');
const { extractNumberCandidates } = require('./src/numbers');

/**
 * The flow, with its collaborators injected. One instance per process; the
 * entry point exports the real one, tests build their own with stubs.
 */
function createFlow({
  detect = detectOperator,
  send = sendSms,
  list = listProviders,
  save = setTsp,
  mark = setStatus,
  record = recordNodalResponse,
  sweep = closeStaleRequests,
  apiConfigured = operatorApiConfigured,
  gatewayConfigured = smsGatewayConfigured,
} = {}) {
  let warnedUnconfigured = false;

  /**
   * Work one created request all the way through to a sent SMS (steps 1
   * and 2 above). Nothing is ever guessed: when the operator call was made
   * and failed or explained nothing, the request is left for the sweeper to
   * close as FAILED.
   */
  async function handleCreatedRequest(payload) {
    const { Id, QueryNumber } = payload;

    // --- 1. which carrier owns this number? ---------------------------------
    // `fallbackOk` is true only when the lookup was never attempted (no API
    // key). When the call *was* attempted and failed or explained nothing,
    // we do not guess a recipient, so the request is left for the sweeper.
    let operator = null;
    let fallbackOk = !apiConfigured();
    try {
      await save(Id, null, Status.TSP_REQUESTED).catch(() => {});
      if (apiConfigured()) {
        const answer = await detect(QueryNumber);
        operator = answer.operator;
        fallbackOk = !operator;
      }
    } catch (error) {
      console.error(`[${CHANNEL}] ${Id} operator lookup failed: ${error.message}`);
    }

    if (operator) {
      await save(Id, operator, Status.TSP_FOUND).catch((error) =>
        console.error(`[${CHANNEL}] ${Id} could not store the operator:`, error.message),
      );
    } else if (apiConfigured()) {
      console.warn(`[${CHANNEL}] ${Id} no operator found for ${QueryNumber}; leaving it for the timeout sweep`);
    }

    // --- 2. pick the carrier's row and send one SMS --------------------------
    const providers = await list().catch(() => []);
    const provider = operator ? findProvider(providers, operator) : null;

    // With a carrier we use its own format; without one the message still
    // goes out in the plain international form to the fallback nodal number
    // — but only when falling back is allowed.
    const text = buildProviderMessage(provider ? provider.RequestFormat : '91{query_number}', QueryNumber);
    const to = provider ? provider.NodalNumber : fallbackOk ? config.sms.nodalNumber : null;

    if (!gatewayConfigured()) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        console.warn('SMS gateway is not configured (set SMS_GATEWAY_USERNAME and SMS_GATEWAY_PASSWORD in .env) — requests will be logged but no SMS sent.');
      }
      console.log(`[${CHANNEL}] ${Id} ${QueryNumber} operator=${operator || '?'} (no SMS: gateway not configured)`);
      return;
    }

    if (!to) {
      console.warn(
        `[${CHANNEL}] ${Id} no destination for operator ${operator || 'unknown'}; ` +
          'add it to the `Tsp` table or set NODAL_NUMBER in .env',
      );
      return;
    }

    try {
      const result = await send({ to, text });
      console.log(
        `[${CHANNEL}] ${Id} sent "${text}" to ${provider ? provider.Provider : 'nodal'} ${to} ` +
          `(gateway message ${result.id || '?'}, state ${result.state || '?'})`,
      );
    } catch (error) {
      // The row stays at TSP_FOUND, so a later run can still send it.
      console.error(`[${CHANNEL}] ${Id} could not send the SMS: ${error.message}`);
      return;
    }

    // The SMS is on its way; the request is now with the carrier until the
    // reply comes back (handleReceivedMessage moves it to
    // NODAL_RESPONSE_FOUND, or the sweeper times it out).
    await mark(Id, Status.LOCATION_REQUESTED).catch((error) =>
      console.error(`[${CHANNEL}] ${Id} could not be marked as location requested:`, error.message),
    );
  }

  /**
   * A text arrived at the gateway phone. If the number it mentions belongs
   * to an open request, the location information is here.
   */
  async function handleReceivedMessage(message) {
    console.log(`[${MESSAGES_CHANNEL}] from ${message.Sender || 'unknown'}: ${message.Message}`);

    const candidates = extractNumberCandidates(message.Message);
    const row = await record({ candidates, text: message.Message }).catch((error) => {
      console.error(`[${MESSAGES_CHANNEL}] could not record the reply:`, error.message);
      return null;
    });

    if (row) {
      console.log(
        `[${MESSAGES_CHANNEL}] location found for ${row.QueryNumber} — request ${row.Id} (status ${row.Status})`,
      );
      return;
    }

    // Not necessarily a problem: the reply can arrive for a request we have
    // not sent yet, or the text may not echo a number at all.
    console.log(
      `[${MESSAGES_CHANNEL}] no open request matched ${candidates.join(', ') || 'no number in the text'}; ` +
        'the reply stays unmatched (a later reply may still match)',
    );
  }

  /**
   * One sweep: close every request that stopped moving (see the header).
   * Returns how many rows were closed.
   */
  async function sweepTimeouts() {
    const waitMs = config.timeouts.nodalResponseMinutes * 60 * 1000;
    const count = await sweep({ waitMs, sweepMs: config.timeouts.sweepMs }).catch((error) => {
      console.error(`[timeout sweep] failed:`, error.message);
      return 0;
    });
    if (count) {
      console.log(
        `[timeout sweep] closed ${count} request(s) — no location reply within ` +
          `${config.timeouts.nodalResponseMinutes} minute(s), or no operator answer`,
      );
    }
    return count;
  }

  return { handleCreatedRequest, handleReceivedMessage, sweepTimeouts };
}

// --- clockwork ---------------------------------------------------------------

/**
 * Wire the flow to Redis and the sweeper. Like `createDashboard` and
 * `createWebhookServer`, the entry point only starts it.
 */
/**
 * Wire the flow to Redis and start the sweeper. `flow` and `seed` are
 * parameters so the whole thing can be tested with nothing running.
 */
function createProgramme({ flow = createFlow(), seed } = {}) {
  let timer = null;

  async function start() {
    // Make sure the provider table has the four nodal numbers; an existing
    // row (possibly edited by an operator) is never overwritten.
    const providers = seed || DEFAULT_PROVIDERS;
    const result = await ensureProviders(providers);
    if (result.inserted) console.log(`seeded ${result.inserted} telecom provider(s) into "Tsp"`);

    await subscribeRequests(flow.handleCreatedRequest);
    console.log(`Listening on "${CHANNEL}" (created requests → operator lookup → SMS).`);
    await subscribeMessages(flow.handleReceivedMessage);
    console.log(`Listening on "${MESSAGES_CHANNEL}" (SMS replies → NodalResponse).`);

    timer = setInterval(() => flow.sweepTimeouts(), config.timeouts.sweepMs);
    if (timer.unref) timer.unref();
    console.log(
      `Timing out requests with no location reply after ${config.timeouts.nodalResponseMinutes} minute(s), ` +
        `checked every ${Math.round(config.timeouts.sweepMs / 1000)}s.`,
    );
  }

  async function stop() {
    if (timer) clearInterval(timer);
    await Promise.allSettled([closeRequests(), closeMessages()]);
  }

  return { start, stop };
}

// The real flow, exported for whoever drives the process.
const { handleCreatedRequest, handleReceivedMessage, sweepTimeouts } = createFlow();

if (require.main === module) {
  const { start, stop } = createProgramme();

  start().catch((error) => {
    console.error('could not start programme:', error.message);
    process.exit(1);
  });

  process.on('SIGINT', async () => {
    await stop();
    process.exit(0);
  });
}

module.exports = { createFlow, createProgramme, handleCreatedRequest, handleReceivedMessage, sweepTimeouts };
