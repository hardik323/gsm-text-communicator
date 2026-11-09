'use strict';

/**
 * Incoming SMS replies: matching them to the request they answer, recording
 * the reply as `NodalResponse`, reading the location we got, writing any notes
 * to `Comments`, and publishing the structured result to the BotResponse
 * channel so the bot can tell the user.
 *
 * The `locationRequests` table module owns the row; this owns the matching
 * and notes.
 */

const { prisma } = require('../../db/prisma');
const { Status } = require('../../constants/status');
const { nationalNumber, fullNumber } = require('../../numbers');
const { findOpenRequests, findById, markResponseFound } = require('../../db/locations');
const { publishBotResponse } = require('../../queue/botResponse');
const { config } = require('../../config');

const BOT_RESPONSE_CHANNEL = config.redis.botResponseChannel;

/**
 * Attach the reply that arrived by SMS to its request, and return the
 * updated row — or null when no open request matches.
 *
 * When a candidate matches an open request, the reply counts as location
 * information, so the request is closed as NODAL_RESPONSE_FOUND. Otherwise it
 * is left alone; the timeout sweep handles requests with no reply.
 *
 * `publish` is optional: the real module always publishes to the BotResponse
 * channel, but tests can stub it out to avoid hitting Redis.
 */
async function recordNodalResponse({ candidates, text, publish } = {}) {
  if (!candidates || candidates.length === 0) return null;

  const open = await findOpenRequests({ limit: 50 }); // newest first

  for (const candidate of candidates) {
    const tail = nationalNumber(candidate);
    const match = open.find((row) => nationalNumber(row.QueryNumber) === tail);
    if (!match) continue;

    const location = readLocationInfo(text);
    const notes = notesForReply(text, location);

    await markResponseFound(match.Id, {
      response: JSON.stringify({
        query_number: match.QueryNumber,
        chatId: String(match.ChatId),
        userId: String(match.UserId),
        location_information: location,
      }),
      comments: notes,
    });

    const updated = await findById(match.Id);
    if (updated) {
      (publish || publishBotResponse)(updated).catch((error) =>
        console.error(`[${BOT_RESPONSE_CHANNEL}] could not publish response for ${match.Id}:`, error.message),
      );
    }

    return updated;
  }

  return null;
}

/**
 * The carrier sometimes replies with "Location of 919876543210 is Tower A" and
 * sometimes with a raw provider message that does not mention a tower. We keep
 * the full text but also extract any obvious location snippet so the user gets
 * something readable.
 */
function readLocationInfo(text) {
  const raw = String(text || '').trim();
  if (!raw) return { raw: '', snippet: '' };

  // Try to pull anything that looks like a place name after "is" or after a
  // colon on its own line.
  const afterIs = raw.match(/\bis\b\s+(.+)$/i);
  const afterColon = raw.split('\n').find((line) => /^:\s*/i.test(line));
  const snippet =
    (afterIs ? afterIs[1].trim() : '') ||
    (afterColon ? afterColon.replace(/^:\s*/i, '').trim() : '') ||
    raw;

  return { raw, snippet };
}

/**
 * Human notes about what the reply looked like. Used to fill the `Comments`
 * column when something worth recording happened (no numbers in the text,
 * the reply did not look like a real location, and so on).
 */
function notesForReply(text, location) {
  const raw = String(text || '').trim();
  if (!raw) return 'Received an empty reply';

  const candidates = (location.raw ? [location.raw] : []);
  if (candidates.length === 0) {
    return 'SMS arrived but did not look like a location reply';
  }

  return '';
}

module.exports = { recordNodalResponse, readLocationInfo };
