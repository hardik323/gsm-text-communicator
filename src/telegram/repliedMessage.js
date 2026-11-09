'use strict';

/**
 * One human-readable Telegram message built from a matched reply.
 * Kept in its own module so the wording can move here without touching the
 * handler or the bot loop.
 *
 * The wording lives here so it only has to be changed in one place when the
 * carrier reply is ever formatted differently.
 */

/**
 * Human reply for `queryNumber` from the `BotResponse` payload.
 *
 * The payload is created by the reply reactor in `src/sms/replies/records.js`
 * and mirrors the `location_information` field we store. When the carrier
 * reply did not look like a location, we tell the user we got something but
 * could not read a place from it.
 */
function replyFor(queryNumber, payload) {
  const location =
    payload && payload.location_information ? payload.location_information : null;

  if (!location) {
    return (
      `We received a reply for ${queryNumber}, but no usable location ` +
      `information came with it.`
    );
  }

  const snippet = String(location.snippet || '').trim();
  if (snippet) {
    return `Location for ${queryNumber}:\n${snippet}`;
  }

  if (location.raw) {
    return `Location for ${queryNumber}:\n${location.raw}`;
  }

  return `We received a reply for ${queryNumber}, but could not read a location from it.`;
}

module.exports = { replyFor };
