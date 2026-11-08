'use strict';

const Redis = require('ioredis');
const { config } = require('../config');

/**
 * Open a Redis connection. `name` only appears in the logs, which makes it
 * obvious which of the two connections (publisher / subscriber) reported an error.
 */
function createConnection(name) {
  const client = new Redis(config.redis.url);

  client.on('ready', () => console.log(`redis ${name} connected to ${config.redis.url}`));
  client.on('error', (error) => console.error(`redis ${name} error:`, error.message));

  return client;
}

module.exports = { createConnection };
