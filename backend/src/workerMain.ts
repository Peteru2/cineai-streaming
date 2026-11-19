import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { PostgresVideoStore } from './db/postgresVideoStore.js';
import { BullJobQueue } from './queue/jobQueue.js';
import { PlaceholderProcessor } from './worker/processor.js';
import { loadWorkerConfig } from './worker/processVideo.js';
import { startWorker } from './worker/worker.js';

const pool = createPool();
await migrate(pool);

const queue = new BullJobQueue();
const worker = startWorker({
  deps: {
    store: new PostgresVideoStore(pool),
    queue,
    processor: new PlaceholderProcessor(),
    config: loadWorkerConfig(),
  },
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
});

console.log('Worker started');

async function shutdown() {
  await worker.close(); // lets running jobs finish first
  await queue.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);