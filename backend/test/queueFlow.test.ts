import { test, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { PostgresVideoStore } from '../src/db/postgresVideoStore.js';
import { BullJobQueue, redisConnection } from '../src/queue/jobQueue.js';
import { startWorker } from '../src/worker/worker.js';
import type { VideoProcessor } from '../src/worker/processor.js';
import { waitFor } from './helpers/waitFor.js';

const pool = createPool();
const store = new PostgresVideoStore(pool);

beforeAll(async () => {
  await migrate(pool);
});

afterAll(async () => {
  await pool.end();
});

test('a queued video is picked up by a real worker, even with a duplicate ticket', async () => {
  const queueName = `video-processing-test-${randomUUID()}`;
  const queue = new BullJobQueue(redisConnection(), queueName);
  const process = vi.fn(async () => {});
  const processor: VideoProcessor = { process };

  const worker = startWorker({
    deps: { store, queue, processor, config: { maxAttempts: 3, heartbeatMs: 1000, retryDelayMs: 100 } },
    queueName,
    connection: redisConnection(),
    concurrency: 2,
  });

  try {
    const { video } = await store.createVideo({
      creatorId: randomUUID(),
      filename: 'pilot.mp4',
      sizeBytes: 1000,
      contentType: 'video/mp4',
      idempotencyKey: randomUUID(),
    });
    await store.compareAndSetStatus(video.id, 'uploading', 'uploaded');
    await store.compareAndSetStatus(video.id, 'uploaded', 'queued');

    await queue.enqueue(video.id, 1);
    await queue.enqueue(video.id, 1); // duplicate ticket

    await waitFor(async () => (await store.getVideo(video.id))?.status === 'ready', 15_000);
    expect(process).toHaveBeenCalledTimes(1);
  } finally {
    await worker.close();
    await queue.close();
  }
}, 30_000);