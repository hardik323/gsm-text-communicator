'use strict';

/**
 * Request lifecycle, matching the CHECK constraint on "locationRequests"."Status".
 *
 * The numbers ARE the contract: they are stored in the database and sent over
 * Redis, so never renumber an existing value — add a new one at the end.
 *
 *   1 created               accepted from Telegram, row written
 *   2 TSP_REQUESTED         handed to the TSP / carrier
 *   3 TSP_FOUND             carrier located
 *   4 TSP_NOT_FOUND         carrier could not be located
 *   5 LOCATION_REQUESTED    location lookup started
 *   6 NODAL_RESPONSE_FOUND  nodal reply received
 *   7 NODAL_RESPONSE_TIMEOUT nodal reply never arrived
 *   8 FAILED                processing failed (terminal)
 */
const Status = Object.freeze({
  CREATED: 1,
  TSP_REQUESTED: 2,
  TSP_FOUND: 3,
  TSP_NOT_FOUND: 4,
  LOCATION_REQUESTED: 5,
  NODAL_RESPONSE_FOUND: 6,
  NODAL_RESPONSE_TIMEOUT: 7,
  FAILED: 8,
});

/** Reverse lookup: 1 -> 'CREATED'. */
const StatusName = Object.freeze(
  Object.fromEntries(Object.entries(Status).map(([name, value]) => [value, name])),
);

const VALID_STATUSES = Object.freeze(Object.values(Status));

/**
 * Statuses that mean "still in progress". A repeated /location for the same
 * number is only a duplicate while its request is in one of these.
 */
const OPEN_STATUSES = Object.freeze([Status.CREATED, Status.TSP_REQUESTED, Status.LOCATION_REQUESTED]);

function isStatus(value) {
  return VALID_STATUSES.includes(Number(value));
}

/**
 * Accepts 1, '1', 'created', 'Tsp-Requested' — returns the number,
 * or undefined when the value is not a known status.
 */
function parseStatus(value) {
  if (typeof value === 'number') return isStatus(value) ? value : undefined;

  const text = String(value === undefined || value === null ? '' : value).trim();
  if (/^\d+$/.test(text)) return isStatus(text) ? Number(text) : undefined;

  const key = text.toUpperCase().replace(/[\s-]+/g, '_');
  return Object.prototype.hasOwnProperty.call(Status, key) ? Status[key] : undefined;
}

module.exports = { Status, StatusName, VALID_STATUSES, OPEN_STATUSES, isStatus, parseStatus };
