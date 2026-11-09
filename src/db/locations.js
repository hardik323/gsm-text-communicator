'use strict';

/**
 * The `locationRequests` table: one row per `/location` command, with its
 * whole life in the `Status` column. All writes read and write the row; the
 * flow (who moves a row from one status to the next) lives in `programme.js`
 * and in `src/sms/replies/`.
 */

const { prisma } = require('./prisma');
const { Status, OPEN_STATUSES } = require('../constants/status');

/**
 * Insert a new request. Every accepted command starts as created (status 1);
 * CreatedDateTime and LastStatusChangeDateTime come from the database defaults.
 */
function saveRequest({ userId, chatId, queryNumber }) {
  return prisma.locationRequests.create({
    data: {
      UserId: BigInt(userId),
      ChatId: BigInt(chatId),
      QueryNumber: queryNumber,
      Status: Status.CREATED,
    },
  });
}

/**
 * Is there already an in-progress request from this user, in this chat, for
 * this number? Returns the newest matching row, or null.
 */
function findOpenRequest({ userId, chatId, queryNumber }) {
  return prisma.locationRequests.findFirst({
    where: {
      UserId: BigInt(userId),
      ChatId: BigInt(chatId),
      QueryNumber: queryNumber,
      Status: { in: OPEN_STATUSES },
    },
    orderBy: { CreatedDateTime: 'desc' },
  });
}

/**
 * Mark a request as any status, stamping the change. Used by programme.js
 * after the lookup SMS went out (LOCATION_REQUESTED).
 */
function setStatus(id, status) {
  return prisma.locationRequests.update({
    where: { Id: id },
    data: { Status: status, LastStatusChangeDateTime: new Date() },
  });
}

/**
 * Store the operator API Express identified for the number, together with the
 * status it implies (TSP_REQUESTED while the call is in flight, TSP_FOUND
 * once the answer is in, TSP_NOT_FOUND when nobody knows it).
 *
 * TSP is a plain column, so this never overwrites an older answer with
 * scratch data — programme.js only calls it with real API answers.
 */
function setTsp(id, tsp, status) {
  return prisma.locationRequests.update({
    where: { Id: id },
    data: { TSP: tsp, Status: status, LastStatusChangeDateTime: new Date() },
  });
}

/**
 * Attach the reply body and any notes, and move the request to
 * NODAL_RESPONSE_FOUND in one update. `response` is the structured JSON we
 * will also publish to the BotResponse channel; `comments` are human-facing
 * notes and exceptions.
 */
function markResponseFound(id, { response, comments } = {}) {
  return prisma.locationRequests.update({
    where: { Id: id },
    data: {
      NodalResponse: comments || null,
      Response: response || null,
      Status: Status.NODAL_RESPONSE_FOUND,
      LastStatusChangeDateTime: new Date(),
    },
  });
}

/**
 * Fetch a request in every field the BotResponse publisher needs. Returns
 * null when the row does not exist.
 */
function findById(id) {
  return prisma.locationRequests.findUnique({
    where: { Id: id },
  });
}

/**
 * Open requests, newest first — what a reply can be matched against, and
 * what the reply handler scans to find its request.
 */
function findOpenRequests({ statuses = OPEN_STATUSES, limit = 100 } = {}) {
  return prisma.locationRequests.findMany({
    where: { Status: { in: statuses } },
    orderBy: { CreatedDateTime: 'desc' },
    take: limit,
  });
}

/**
 * Requests that have stopped moving, each with the status they close into.
 * Two different clocks apply, because the two situations are different:
 *
 *   LOCATION_REQUESTED — the lookup SMS went out and the carrier never
 *     answered: NODAL_RESPONSE_TIMEOUT.
 *   TSP_REQUESTED — we asked for the operator `sweepMs` ago and the API never
 *     answered, so no SMS could ever be sent: overall FAILED.
 *
 * Both are keyed on LastStatusChangeDateTime, which is stamped on every
 * status change, so "how long has it been sitting in this state?" is exact
 * rather than guessed from CreatedDateTime.
 */
async function findStaleRequests({ waitMs, sweepMs, now = new Date() } = {}) {
  const replyCutoff = new Date(now.getTime() - waitMs);
  const tspCutoff = new Date(now.getTime() - (sweepMs || waitMs));

  const [reply, tsp] = await Promise.all([
    prisma.locationRequests.findMany({
      where: { Status: Status.LOCATION_REQUESTED, LastStatusChangeDateTime: { lt: replyCutoff } },
      orderBy: { CreatedDateTime: 'asc' },
      take: 100,
    }),
    prisma.locationRequests.findMany({
      where: { Status: Status.TSP_REQUESTED, LastStatusChangeDateTime: { lt: tspCutoff } },
      orderBy: { CreatedDateTime: 'asc' },
      take: 100,
    }),
  ]);

  return [
    ...reply.map((row) => ({ row, status: Status.NODAL_RESPONSE_TIMEOUT })),
    ...tsp.map((row) => ({ row, status: Status.FAILED })),
  ];
}

/**
 * Close every stale request and return how many. The status and the cutoff
 * are re-checked in the UPDATE, so a row that moved on in the meantime (a
 * reply arrived, the operator call returned) is never closed.
 */
async function closeStaleRequests({ waitMs, sweepMs, now = new Date() } = {}) {
  const stale = await findStaleRequests({ waitMs, sweepMs, now });
  if (stale.length === 0) return 0;

  const replyCutoff = new Date(now.getTime() - waitMs);
  const tspCutoff = new Date(now.getTime() - (sweepMs || waitMs));

  await prisma.locationRequests.updateMany({
    where: {
      Id: { in: stale.filter((s) => s.status === Status.NODAL_RESPONSE_TIMEOUT).map((s) => s.row.Id) },
      Status: Status.LOCATION_REQUESTED,
      LastStatusChangeDateTime: { lt: replyCutoff },
    },
    data: { Status: Status.NODAL_RESPONSE_TIMEOUT, LastStatusChangeDateTime: now },
  });

  await prisma.locationRequests.updateMany({
    where: {
      Id: { in: stale.filter((s) => s.status === Status.FAILED).map((s) => s.row.Id) },
      Status: Status.TSP_REQUESTED,
      LastStatusChangeDateTime: { lt: tspCutoff },
    },
    data: { Status: Status.FAILED, LastStatusChangeDateTime: now },
  });

  return stale.length;
}

module.exports = {
  saveRequest,
  findOpenRequest,
  setStatus,
  setTsp,
  markResponseFound,
  findById,
  findOpenRequests,
  findStaleRequests,
  closeStaleRequests,
};

/** Convenience re-export so dashboard auth does not depend on prisma/client directly. */
module.exports.prisma = require('./prisma').prisma;
module.exports.disconnect = require('./prisma').disconnect;
