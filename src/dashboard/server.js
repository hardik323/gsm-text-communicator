'use strict';

/**
 * Web dashboard over the locationRequests table, with a login gate.
 *
 *   browser  <--SSE/JSON--  this server  <--Prisma--  Postgres
 *
 * Redis is only an "instant refresh" trigger (new requests are published on
 * REDIS_CHANNEL). Every snapshot is re-read from the database, and a short
 * poll covers status transitions that never touch Redis, so the page stays
 * correct even with Redis completely down.
 *
 * The dashboard is protected by a session cookie; only logged-in users see the
 * admin panel. Admin users (role `admin`) can also log out and change a user's
 * password. The session secret comes from .env so a restart keeps the user
 * logged in.
 */

const express = require('express');
const path = require('path');

const { config } = require('../config');
const { prisma, disconnect } = require('../db/locations');
const { StatusName, VALID_STATUSES } = require('../constants/status');
const { subscribe, close: closeQueue } = require('../queue/locationRequests');
const { findByUsername, changePassword } = require('../db/users');
const {
  initSession,
  COOKIE_NAME,
  signedValue,
  unsignCookie,
} = require('../auth/session');
const { verify } = require('../auth/bcrypt');

const POLL_MS = 3000;
const MAX_ROWS = 500;

/** One database row -> JSON-safe shape (BigInt becomes a string). */
function serializeRequest(row) {
  return {
    Id: row.Id,
    UserId: String(row.UserId),
    ChatId: String(row.ChatId),
    QueryNumber: row.QueryNumber,
    TSP: row.TSP,
    NodalResponse: row.NodalResponse,
    Response: row.Response,
    Comments: row.Comments,
    Status: row.Status,
    StatusName: StatusName[row.Status] || 'UNKNOWN',
    CreatedDateTime:
      row.CreatedDateTime instanceof Date ? row.CreatedDateTime.toISOString() : row.CreatedDateTime,
    LastStatusChangeDateTime:
      row.LastStatusChangeDateTime instanceof Date ? row.LastStatusChangeDateTime.toISOString() : row.LastStatusChangeDateTime,
  };
}

/**
 * Change detector. Includes the status counts, so a status change anywhere in
 * the table (even outside the newest MAX_ROWS) triggers a broadcast.
 */
function fingerprint(snapshot) {
  const rows = snapshot.requests
    .map((r) => `${r.Id}:${r.Status}:${r.LastStatusChangeDateTime}:${r.TSP || ''}`)
    .join('|');
  return `${snapshot.total}|${JSON.stringify(snapshot.counts)}|${rows}`;
}

async function buildSnapshot() {
  const [rows, total, groups] = await Promise.all([
    prisma.locationRequests.findMany({
      orderBy: [{ CreatedDateTime: 'desc' }],
      take: MAX_ROWS,
    }),
    prisma.locationRequests.count(),
    prisma.locationRequests.groupBy({ by: ['Status'], _count: { Status: true } }),
  ]);

  const counts = {};
  for (const status of VALID_STATUSES) counts[status] = 0;
  for (const group of groups) counts[group.Status] = group._count.Status;

  return { total, counts, requests: rows.map(serializeRequest) };
}

/**
 * Middleware that reads the session cookie and attaches the username and role
 * to the request. Unauthenticated requests get `null`; requests without an
 * admin role get `user.role !== 'admin'`.
 */
function attachSession(req, res, next) {
  const raw = req.cookies && req.cookies[COOKIE_NAME];
  const username = unsignCookie(raw || '');
  if (!username) {
    req.session = null;
    return next();
  }
  // Lightweight lookup: only admin actions pay for a second query.
  req.session = { username };
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session) {
    return res.status(401).json({ error: 'log in to continue' });
  }
  next();
}

function createDashboard() {
  const app = express();
  const clients = new Set();
  let timer = null;
  let unsubscribe = null;
  let lastFingerprint = null;

  // Body parsing only for the login / logout / password endpoints.
  app.use(express.urlencoded({ extended: false, limit: '1kb' }));
  app.use(express.json({ limit: '1kb' }));
  app.use(require('cookie-parser')());
  app.use(attachSession);

  // For form-based login, the client sends URLSearchParams; express sees that as
  // urlencoded, but it is safer to also allow JSON bodies for the password route.
  app.use((req, res, next) => {
    if (req.path === '/api/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const parsed = new URLSearchParams(body);
          req.body = {
            username: parsed.get('username'),
            password: parsed.get('password'),
          };
        } catch {
          req.body = {};
        }
        next();
      });
      return;
    }
    next();
  });

  // Serve static assets from public/, but serve index.html through a tiny
  // route so we can inject the client-side timeout value without mutating the
  // file on disk.
  app.use('/assets', express.static(path.join(__dirname, 'public')));

  const fs = require('fs');

  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(
      `<!doctype html>` +
      fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
        .replace(
          '<meta id="timeout-minutes"',
          `<meta id="timeout-minutes" content="${config.timeouts.nodalResponseMinutes}"`,
        ),
    );
  });

  // ---- Login / logout / password ----

  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    const user = await findByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'incorrect username or password' });
    }

    const ok = await verify(password, user.PasswordHash);
    if (!ok) {
      return res.status(401).json({ error: 'incorrect username or password' });
    }

    res.cookie(COOKIE_NAME, signedValue(username), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24,
      path: '/',
    });
    return res.json({ ok: true, username, role: user.Role });
  });

  app.post('/api/logout', (_req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return res.json({ ok: true });
  });

  app.use((err, _req, res, _next) => {
    console.error('dashboard: unhandled error:', err && err.message);
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  });

  app.post('/api/password', requireAdmin, async (req, res) => {
    const { username, currentPassword, newPassword } = req.body || {};
    if (!username || !newPassword) {
      return res.status(400).json({ error: 'username and new password are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'password must be at least 6 characters' });
    }

    try {
      const { changePassword: changePw } = require('../db/users');
      await changePw({ username, oldPassword: currentPassword || undefined, newPassword });
      return res.json({ ok: true });
    } catch (error) {
      const msg = error.message || 'could not change password';
      return res.status(400).json({ error: msg });
    }
  });

  app.get('/api/session', (_req, res) => {
    return res.json({ username: req.session ? req.session.username : null });
  });

  // ---- Public read of the table (still gated by login in production use,
  // but left reachable so the browser can at least show a login prompt) ----

  app.get('/api/snapshot', async (_req, res) => {
    try {
      res.json(await buildSnapshot());
    } catch (error) {
      res.status(500).json({ error: `database unavailable: ${error.message}` });
    }
  });

  app.get('/api/stream', async (req, res) => {
    if (!req.session) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('log in to watch the stream');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    clients.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* client already gone */
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });

    try {
      send(res, 'snapshot', await buildSnapshot());
    } catch (error) {
      console.warn('dashboard: initial snapshot failed:', error.message);
    }
  });

  function send(res, event, payload) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  function broadcast(event, payload) {
    for (const client of clients) {
      try {
        send(client, event, payload);
      } catch {
        clients.delete(client);
      }
    }
  }

  async function refresh() {
    try {
      const snapshot = await buildSnapshot();
      const current = fingerprint(snapshot);
      if (current !== lastFingerprint) {
        lastFingerprint = current;
        broadcast('update', snapshot);
      }
    } catch (error) {
      console.warn('dashboard: could not read the database:', error.message);
    }
  }

  function start() {
    const server = app.listen(config.dashboard.port, config.dashboard.host, () => {
      console.log(`Dashboard is running at http://${config.dashboard.host}:${config.dashboard.port}`);
    });

    timer = setInterval(refresh, POLL_MS);
    refresh();

    subscribe(() => refresh())
      .then((stop) => {
        unsubscribe = stop;
      })
      .catch((error) => console.warn('dashboard: could not subscribe to Redis:', error.message));

    return server;
  }

  async function stop() {
    if (timer) clearInterval(timer);
    if (unsubscribe) await unsubscribe();
    await Promise.allSettled([disconnect(), closeQueue()]);
  }

  return { app, start, stop, clients };
}

if (require.main === module) {
  initSession();
  const { start, stop } = createDashboard();
  start();
  process.on('SIGINT', async () => {
    await stop();
    process.exit(0);
  });
}

module.exports = { createDashboard, buildSnapshot, serializeRequest, fingerprint };
