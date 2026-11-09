'use strict';

/**
 * Idempotent seed for dashboard users. Safe to run more than once: existing
 * users are never touched unless you pass --reset, which clears every user
 * before re-creating the two admin accounts.
 *
 * This is not a normal runtime path. The dashboard is the only consumer of the
 * `users` table, and this script is a one-off setup step.
 */

const { config } = require('../src/config');
const { prisma } = require('../src/db/prisma');
const { create, ROLES } = require('../src/db/users');

// Prisma generates a fresh client each time it is required in a fresh process.
// If the `User` model does not show up here, the client is stale; regenerate
// and try again.
if (!prisma || !prisma.user) {
  console.error('prisma.user is not available; run `bun x prisma generate` after applying migrations');
  process.exit(1);
}

async function seed(force) {
  if (force) {
    await prisma.user.deleteMany();
    console.log('deleted all existing dashboard users');
  }

  const users = [
    { username: 'ramesh', password: 'ramesh', role: 'admin' },
    { username: 'hardik', password: 'hardik', role: 'admin' },
  ];

  let created = 0;
  for (const user of users) {
    try {
      await create(user);
      created++;
      console.log(`created user "${user.username}" (${user.role})`);
    } catch (error) {
      if (error.message && error.message.includes('Unique')) {
        console.log(`user "${user.username}" already exists, skipping`);
        continue;
      }
      throw error;
    }
  }

  console.log(`seed done: ${created} user(s) created`);
}

if (require.main === module) {
  seed(process.argv.includes('--reset')).then(
    () => disconnect().then(() => process.exit(0)),
    (error) => {
      console.error(error && error.message);
      process.exit(1);
    },
  );
}
