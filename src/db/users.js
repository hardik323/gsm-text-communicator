'use strict';

/**
 * Dashboard user store. Right now the only operations are:
 *   - look up a user by username
 *   - create a user (only at the console / during provisioning)
 *   - change a user's password
 *
 * There is no login endpoint here — the dashboard owns its session cookie.
 */

const { prisma } = require('../db/prisma');

// Prisma may not have generated the `User` model yet on the client instance;
// in that case we cannot create users until the migration is applied and the
// client is regenerated. Fail fast with a clear message in that case.
if (!prisma || !prisma.user) {
  throw new Error('prisma.user is not available; run `bun x prisma generate` after applying migrations');
}

/** The rough roles the dashboard understands. Not an enum on purpose. */
const ROLES = new Set(['admin', 'viewer']);

function isValidRole(role) {
  return typeof role === 'string' && ROLES.has(role);
}

async function findByUsername(username) {
  if (!username) return null;
  return prisma.user.findUnique({ where: { Username: username } });
}

async function create({ username, password, role = 'viewer' }) {
  if (!username || !password) throw new Error('username and password are required');
  if (!isValidRole(role)) throw new Error('unsupported role');

  const hash = await require('../auth/bcrypt').hash(password);
  return prisma.user.create({ data: { Username: username, PasswordHash: hash, Role: role } });
}

async function changePassword({ username, oldPassword, newPassword }) {
  if (!username || !newPassword) throw new Error('username and new password are required');

  const user = await findByUsername(username);
  if (!user) throw new Error('no such user');

  // Old password is optional for provisioning paths; when it is supplied it
  // must match so a caller cannot clobber someone else's password.
  if (oldPassword) {
    const ok = await require('../auth/bcrypt').verify(oldPassword, user.PasswordHash);
    if (!ok) throw new Error('incorrect current password');
  }

  const hash = await require('../auth/bcrypt').hash(newPassword);
  return prisma.user.update({
    where: { Id: user.Id },
    data: { PasswordHash: hash, LastChangedDateTime: new Date() },
  });
}

module.exports = { ROLES, isValidRole, findByUsername, create, changePassword };
