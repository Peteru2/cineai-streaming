import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { PostgresVideoStore } from './db/postgresVideoStore.js';
import { BullJobQueue } from './queue/jobQueue.js';
import { S3Storage } from './storage/s3Storage.js';
import { enqueueUploadedVideo } from './worker/enqueue.js';

const pool = createPool();
await migrate(pool);

const storage = S3Storage.fromEnv();
await storage.ensureBucket();

const origins = (process.env.CORS_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
try {
  await storage.configureBrowserAccess(origins);
  console.log(`Storage is open to browsers from: ${origins.join(', ')}`);
} catch (err) {
  console.warn('Could not set storage CORS and public-read rules; browser upload and playback may fail.', err);
}

const store = new PostgresVideoStore(pool);
const queue = new BullJobQueue();

const app = createApp({
  store,
  storage,
  config: loadConfig(),
  onUploaded: async (videoId) => {
    await enqueueUploadedVideo(store, queue, videoId);
  },
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`API listening on port ${port}`);
});