'use strict';

/**
 * The telecom service providers (TSPs) the gateway phone can query: the
 * seed list for the `Tsp` table, plus a formatter that builds each
 * carrier's lookup message.
 *
 * The list is kept in code so it is reviewable, and the database is the live
 * copy — `ensureProviders` (in `table.js`) inserts rows that are missing and
 * never overwrites one an operator has edited.
 */

const { nationalNumber } = require('../../numbers');

const DEFAULT_PROVIDERS = [
  { Provider: 'Airtel', NodalNumber: '088001 12112', RequestFormat: '91{query_number}' },
  { Provider: 'JIO', NodalNumber: '070212 65165', RequestFormat: '91{query_number}' },
  { Provider: 'Idea', NodalNumber: '078248 34221', RequestFormat: 'CELL 91{query_number}' },
  { Provider: 'BSNL', NodalNumber: '094180 99998', RequestFormat: 'Getloc 91****' },
];

/**
 * Format a lookup message from a provider's template, e.g. "CELL 91{query_number}".
 * The number is normalised to its last 10 digits first, so an input of
 * "+91 98765-43210" still yields "919876543210" and a template that already
 * carries the country code never gets it twice.
 */
function buildProviderMessage(format, queryNumber) {
  // The placeholder is the national number (last 10 digits), so an input of
  // "+91 98765-43210" still yields "919876543210" and a template that
  // already carries the country code never gets it twice.
  const number = nationalNumber(queryNumber);
  const tmpl = String(format || '91{query_number}');

  // `format` normally already carries its own "91" ("91{query_number}",
  // "CELL 91{query_number}"), so only prepend one to formats that name the
  // number without that prefix ("{query_number}"). Formats that mask the
  // number and contain no placeholder ("Getloc 91****") are returned as-is.
  const filled = tmpl.split('{query_number}').join(number);
  if (!tmpl.includes('{query_number}')) return filled;
  return /\b91\{query_number\}/.test(tmpl) ? filled : `91${filled}`;
}

module.exports = { DEFAULT_PROVIDERS, buildProviderMessage };
