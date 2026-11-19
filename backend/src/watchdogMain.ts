import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { PostgresVideoStore } from './db/postgresVideoStore.js';
import { BullJobQueue } from './queue/jobQueue.js';
import { S3Storage } from './storage/s3Storage.js';
import { loadWatchdogConfig, startWatchdog } from './worker/watchdog.js';

const pool = createPool();
await migrate(pool);

const queue = new BullJobQueue();
const watchdog = startWatchdog({
  store: new PostgresVideoStore(pool),
  storage: S3Storage.fromEnv(),
  queue,
  config: loadWatchdogConfig(),
});

console.log('Watchdog started');

async function shutdown() {
  await watchdog.stop();
  await queue.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);