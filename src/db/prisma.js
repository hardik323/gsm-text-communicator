'use strict';

const { PrismaClient } = require('@prisma/client');

/** One client for the whole process: Prisma manages its own connection pool. */
const prisma = new PrismaClient();

function disconnect() {
  return prisma.$disconnect();
}

module.exports = { prisma, disconnect };
