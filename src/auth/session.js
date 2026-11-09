'use strict';

/**
 * Minimal session for the dashboard: a signed cookie carries the username.
 * The dashboard does not need a database-backed session table for localhost
 * use, and a random NAME_KEY means a random attacker cannot forge a cookie
 * without access to this process's environment.
 */

const crypto = require('crypto');

const COOKIE_NAME = 'geopulse_session';
const SESSION_MS = 24 * 60 * 60 * 1000; // one day

let nameKey = null;

/** Call once at startup; the key comes from .env so it survives restarts. */
function initSession() {
  if (!nameKey) {
    nameKey = (process.env.SESSION_NAME_KEY || crypto.randomBytes(32).toString('base64')).trim();
  }
}

function signedValue(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, t: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', nameKey).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function unsignCookie(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', nameKey).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof obj.u !== 'string' || !obj.u) return null;
    if (Date.now() - obj.t > SESSION_MS) return null;
    return obj.u;
  } catch {
    return null;
  }
}

module.exports = { initSession, COOKIE_NAME, signedValue, unsignCookie };
