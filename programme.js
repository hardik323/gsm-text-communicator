'use strict';

/**
 * Entry point: the consumer side of the queue.
 *
 * Subscribes to the LocationRequests channel and prints every request whose
 * status is created (1). Run it with `bun programme.js` and then send a
 * /location command to the bot to watch a message arrive.
 */

const { CHANNEL, subscribe, close } = require('./src/queue/locationRequests');

if (require.main === module) {
  subscribe((payload) => console.log(`[${CHANNEL}]`, payload))
    .then(() => console.log(`Listening on "${CHANNEL}".`))
    .catch((error) => {
      console.error('could not subscribe:', error.message);
      process.exit(1);
    });

  process.on('SIGINT', async () => {
    await close();
    process.exit(0);
  });
}
