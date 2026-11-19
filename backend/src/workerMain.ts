import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { PostgresVideoStore } from './db/postgresVideoStore.js';
import { BullJobQueue } from './queue/jobQueue.js';
import { S3Storage } from './storage/s3Storage.js';
import { loadWorkerConfig } from './worker/processVideo.js';
import { startWorker } from './worker/worker.js';
import { FfmpegProcessor, assertMediaToolsAvailable } from './worker/media/ffmpegProcessor.js';
import { loadProcessingConfig } from './worker/media/processingConfig.js';

const processing = loadProcessingConfig();
await assertMediaToolsAvailable(processing); // fail at startup, not on the first video

const pool = createPool();
await migrate(pool);

const storage = S3Storage.fromEnv();
await storage.ensureBucket();

const queue = new BullJobQueue();
const worker = startWorker({
  deps: {
    store: new PostgresVideoStore(pool),
    queue,
    processor: new FfmpegProcessor(storage, processing),
    config: loadWorkerConfig(),
  },
  // Transcoding already uses every CPU core, so one job at a time is the sensible default.
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 1),
});

console.log('Worker started');

async function shutdown() {
  await worker.close();
  await queue.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);