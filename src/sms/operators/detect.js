'use strict';

/**
 * Operator detection for a query number, via API Express.
 *
 *   POST https://api.apiexpress.in/v1/telecom/operator
 *   Authorization: Bearer <APIEXPRESS_API_KEY>
 *   { "mobile": "9876543210" }
 *
 *   200 OK  { "status": "success", "mobile": "9876543210", "operator": "Airtel",
 *             "circle": "Maharashtra", "connection": "prepaid", "ported": false }
 *
 * programme.js stores the answer in locationRequests.TSP, then picks the
 * matching row out of the `Tsp` table (`findProvider`, below) — its nodal
 * number is the receiver of the lookup SMS and its RequestFormat is the
 * message body.
 */

const { config } = require('../../config');
const { nationalNumber } = require('../../numbers');

/** True when an API key is set, so the call can be made at all. */
function isConfigured() {
  return Boolean(config.telecom.apiKey);
}

/** API Express wants the bare 10-digit number, no country code or spaces. */
function toMobile(queryNumber) {
  return nationalNumber(queryNumber);
}

/**
 * Ask API Express which operator owns the number.
 * Resolves with { operator, circle, connection, ported, raw }, or with
 * { operator: null, … } when the API answered but could not identify the
 * number. Rejects on transport/HTTP errors, so the caller can decide whether
 * to fall back or leave the request alone.
 */
async function detectOperator(queryNumber, { fetchImpl = fetch, apiKey, url, timeoutMs } = {}) {
  const mobile = toMobile(queryNumber);
  if (!mobile) throw new Error('no usable mobile number in the query');

  const key = apiKey !== undefined ? apiKey : config.telecom.apiKey;
  const endpoint = url || config.telecom.operatorUrl;
  const timeout = timeoutMs || config.telecom.timeoutMs;

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ mobile }),
    signal: AbortSignal.timeout(timeout),
  });
  const reply = await response.text();

  if (!response.ok) {
    throw new Error(`operator API responded ${response.status}: ${reply.slice(0, 160)}`);
  }

  let data;
  try {
    data = JSON.parse(reply);
  } catch {
    throw new Error(`operator API did not return JSON: ${reply.slice(0, 160)}`);
  }

  return {
    operator: data.operator ? String(data.operator).trim() : null,
    circle: data.circle ? String(data.circle).trim() : null,
    connection: data.connection ? String(data.connection).trim() : null,
    ported: data.ported === undefined ? null : Boolean(data.ported),
    raw: data,
  };
}

/**
 * Names we write in the `Tsp` table, mapped from what the API returns.
 * API Express reports "Vi (Vodafone Idea)" and "Jio", never plain "Idea",
 * so those two spellings need to land on the row that exists.
 */
const OPERATOR_ALIASES = [
  { names: ['jio', 'reliance jio', 'reliance'], provider: 'JIO' },
  { names: ['airtel', 'bharti airtel', 'bharti'], provider: 'Airtel' },
  { names: ['vi', 'vodafone idea', 'vodafone', 'idea', 'vi (vodafone idea)'], provider: 'Idea' },
  { names: ['bsnl'], provider: 'BSNL' },
  { names: ['mtnl'], provider: 'MTNL' },
];

/** The `Tsp` provider name for an operator name the API returned, or null. */
function providerForOperator(operator) {
  const name = String(operator || '').trim().toLowerCase();
  if (!name) return null;
  for (const alias of OPERATOR_ALIASES) {
    if (alias.names.includes(name)) return alias.provider;
  }
  return null;
}

/**
 * Pick the `Tsp` row to send the SMS to, given the operator the API found.
 * Returns null when the operator is unknown or has no row, so the caller
 * can fall back (the env nodal number) or leave the request alone.
 */
function findProvider(providers, operatorName) {
  if (!providers || providers.length === 0) return null;
  const provider = providerForOperator(operatorName);
  if (!provider) return null;
  return providers.find((row) => String(row.Provider).toLowerCase() === provider.toLowerCase()) || null;
}

module.exports = { isConfigured, toMobile, detectOperator, providerForOperator, findProvider, OPERATOR_ALIASES };
