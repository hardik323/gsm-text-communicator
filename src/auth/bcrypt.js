'use strict';

/**
 * One place for password hashes so the dashboard does not wire bcrypt
 * directly into its handlers. The cost is kept low because the dashboard is
 * only ever reachable from localhost in the intended deployment.
 */

const bcrypt = require('bcrypt');

const ROUNDS = 10;

async function hash(pwd) {
  return bcrypt.hash(pwd, ROUNDS);
}

async function verify(pwd, hash) {
  if (!pwd || !hash) return false;
  try {
    return bcrypt.compare(pwd, hash);
  } catch {
    return false;
  }
}

module.exports = { hash, verify };
