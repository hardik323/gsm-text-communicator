'use strict';

/**
 * Entry point: the read-only web dashboard.
 *
 *   bun dashboard.js    then open http://127.0.0.1:3000
 *
 * It reads locations requests straight from Postgres and pushes updates to
 * the browser over Server-Sent Events whenever a row appears or its status
 * changes. No writes, no authentication — it is a local tool, so it binds to
 * 127.0.0.1 by default (DASHBOARD_HOST) and should not be exposed publicly.
 */

const { createDashboard } = require('./src/dashboard/server');

if (require.main === module) {
  const { start, stop } = createDashboard();
  start();

  process.on('SIGINT', async () => {
    await stop();
    process.exit(0);
  });
}
