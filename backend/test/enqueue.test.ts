import { test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { PostgresVideoStore } from '../src/db/postgresVideoStore.js';
import { enqueueUploadedVideo } from '../src/worker/enqueue.js';
import { FakeQueue } from './helpers/fakeQueue.js';

const pool = createPool();
const store = new PostgresVideoStore(pool);

beforeAll(async () => {
  await migrate(pool);
});

afterAll(async () => {
  await pool.end();
});

test('five simultaneous signals queue the video exactly once', async () => {
  const { video } = await store.createVideo({
    creatorId: randomUUID(),
    filename: 'pilot.mp4',
    sizeBytes: 1000,
    contentType: 'video/mp4',
    idempotencyKey: randomUUID(),
  });
  await store.compareAndSetStatus(video.id, 'uploading', 'uploaded');

  const queue = new FakeQueue();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => enqueueUploadedVideo(store, queue, video.id)),
  );

  expect(results.filter((r) => r === 'applied')).toHaveLength(1);
  expect(queue.jobs).toEqual([{ videoId: video.id, attempt: 1, delayMs: 0 }]);
  expect((await store.getVideo(video.id))?.status).toBe('queued');
});