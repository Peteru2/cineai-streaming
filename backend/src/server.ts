import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { PostgresVideoStore } from './db/postgresVideoStore.js';
import { S3Storage } from './storage/s3Storage.js';

const pool = createPool();
await migrate(pool);

const storage = S3Storage.fromEnv();
await storage.ensureBucket();

const app = createApp({
  store: new PostgresVideoStore(pool),
  storage,
  config: loadConfig(),
  // The queue arrives in the next step; until then, just log.
  onUploaded: async (videoId) => {
    console.log(`video ${videoId} is uploaded and ready to be queued`);
  },
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`API listening on port ${port}`);
});