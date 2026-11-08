'use strict';

const { prisma } = require('./prisma');
const { Status } = require('../constants/status');

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

module.exports = { saveRequest };
