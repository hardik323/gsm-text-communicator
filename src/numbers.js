'use strict';

/**
 * Phone-number normalisation, shared by the operator lookup, the lookup
 * message formats and the reply matcher. Every other module takes its
 * numbers from here, so a change in what "the same number" means happens in
 * one place.
 *
 * Two shapes matter:
 *   national — the bare 10 digits, e.g. "9876543210" (API Express wants it)
 *   full     — national with the country code, e.g. "919876543210"
 *             (the lookup SMS body and a number echoed in a reply)
 */

/** Digits only, with a leading zero dropped ("09876543210" → "9876543210"). */
function digitsOf(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

/**
 * The last 10 digits of a number: the national number stored in
 * `locationRequests.QueryNumber` and compared against numbers echoed in a
 * reply. Works for every shape the bot accepts ("+91 98765-43210",
 * "09876543210", "919876543210").
 */
function nationalNumber(value) {
  return digitsOf(value).slice(-10);
}

/**
 * The number with the country code: "91" + the national number. Used for the
 * lookup SMS body and to compare numbers found in a reply against what we
 * stored.
 */
function fullNumber(value) {
  return `91${nationalNumber(value)}`;
}

/**
 * Phone-number candidates inside a reply text, in full form, e.g.
 * "Location of 91-98765 43210 is Tower A" → ["919876543210"]. Short digit
 * runs are ignored, and a number echoed twice is reported once.
 *
 * Used to match an incoming reply to the request it answers.
 */
function extractNumberCandidates(text) {
  const raw = String(text || '').match(/\d[\d\s-]*\d|\d/g) || [];
  const seen = new Set();
  const candidates = [];

  for (const chunk of raw) {
    if (chunk.replace(/\D/g, '').length < 7) continue;
    const candidate = fullNumber(chunk);
    if (!seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  }

  return candidates;
}

module.exports = { digitsOf, nationalNumber, fullNumber, extractNumberCandidates };
