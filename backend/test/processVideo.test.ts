import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { PostgresVideoStore } from '../src/db/postgresVideoStore.js';
import { processVideo, type ProcessDeps, type WorkerConfig } from '../src/worker/processVideo.js';
import { PermanentProcessingError, type VideoProcessor } from '../src/worker/processor.js';
import { FakeQueue } from './helpers/fakeQueue.js';
import { sleep, waitFor } from './helpers/waitFor.js';

const pool = createPool();
const store = new PostgresVideoStore(pool);
const config: WorkerConfig = { maxAttempts: 3, heartbeatMs: 30, retryDelayMs: 1000 };

async function makeQueuedVideo(): Promise<string> {
  const { video } = await store.createVideo({
    creatorId: randomUUID(),
    filename: 'pilot.mp4',
    sizeBytes: 1000,
    contentType: 'video/mp4',
    idempotencyKey: randomUUID(),
  });
  await store.compareAndSetStatus(video.id, 'uploading', 'uploaded');
  await store.compareAndSetStatus(video.id, 'uploaded', 'queued');
  return video.id;
}

function deps(processor: VideoProcessor, queue = new FakeQueue()): ProcessDeps {
  return { store, queue, processor, config };
}

beforeAll(async () => {
  await migrate(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('processVideo', () => {
  test('a successful job ends in ready, with the full audit trail', async () => {
    const id = await makeQueuedVideo();
    const processor: VideoProcessor = { process: vi.fn(async () => {}) };

    expect(await processVideo(deps(processor), id)).toBe('ready');

    const video = await store.getVideo(id);
    expect(video?.status).toBe('ready');
    expect(video?.attempts).toBe(1);

    const events = await pool.query(
      `SELECT to_status FROM video_events WHERE video_id = $1 ORDER BY id`,
      [id],
    );
    expect(events.rows.map((r) => r.to_status)).toEqual([
      'uploading', 'uploaded', 'queued', 'processing', 'ready',
    ]);
  });

  test('duplicate tickets for one video cause only one run', async () => {
    const id = await makeQueuedVideo();
    const process = vi.fn(async () => {
      await sleep(100);
    });
    const processor: VideoProcessor = { process };

    const outcomes = await Promise.all([
      processVideo(deps(processor), id),
      processVideo(deps(processor), id),
      processVideo(deps(processor), id),
    ]);

    expect(outcomes.filter((o) => o === 'ready')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'skipped')).toHaveLength(2);
    expect(process).toHaveBeenCalledTimes(1);
  });

  test('a temporary error sends the video back to the queue, then it succeeds', async () => {
    const id = await makeQueuedVideo();
    const queue = new FakeQueue();
    let calls = 0;
    const processor: VideoProcessor = {
      process: async () => {
        calls++;
        if (calls === 1) throw new Error('worker hiccup');
      },
    };

    expect(await processVideo(deps(processor, queue), id)).toBe('retry_scheduled');
    expect((await store.getVideo(id))?.status).toBe('queued');
    expect(queue.jobs).toEqual([{ videoId: id, attempt: 2, delayMs: 1000 }]);

    expect(await processVideo(deps(processor, queue), id)).toBe('ready');
    expect((await store.getVideo(id))?.attempts).toBe(2);
  });

  test('after three failed attempts the video is failed with a reason', async () => {
    const id = await makeQueuedVideo();
    const queue = new FakeQueue();
    const processor: VideoProcessor = {
      process: async () => {
        throw new Error('encoder crashed');
      },
    };

    const outcomes = [];
    for (let i = 0; i < 3; i++) outcomes.push(await processVideo(deps(processor, queue), id));

    expect(outcomes).toEqual(['retry_scheduled', 'retry_scheduled', 'failed']);
    const video = await store.getVideo(id);
    expect(video?.status).toBe('failed');
    expect(video?.attempts).toBe(3);
    expect(video?.failureReason).toContain('Gave up after 3 attempts');
    expect(queue.jobs).toHaveLength(2); // no fourth try is scheduled
  });

  test('a permanent error fails immediately without retrying', async () => {
    const id = await makeQueuedVideo();
    const queue = new FakeQueue();
    const processor: VideoProcessor = {
      process: async () => {
        throw new PermanentProcessingError('audio track corrupted');
      },
    };

    expect(await processVideo(deps(processor, queue), id)).toBe('failed');
    const video = await store.getVideo(id);
    expect(video?.status).toBe('failed');
    expect(video?.failureReason).toBe('audio track corrupted');
    expect(video?.attempts).toBe(1);
    expect(queue.jobs).toHaveLength(0);
  });

  test('a worker that lost its lease stops and overwrites nothing', async () => {
    const id = await makeQueuedVideo();
    const processor: VideoProcessor = {
      process: (_video, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('stopped')));
        }),
    };

    const running = processVideo(deps(processor), id);
    await waitFor(async () => (await store.getVideo(id))?.status === 'processing');

    // Simulate the watchdog taking the job away from a worker it believes is dead.
    await pool.query(`UPDATE videos SET status = 'queued' WHERE id = $1`, [id]);

    expect(await running).toBe('lost');
    expect((await store.getVideo(id))?.status).toBe('queued'); // not overwritten
  });
});

describe('the attempt number as a lease token', () => {
  test('a stale attempt cannot heartbeat or finish a video someone else now owns', async () => {
    const id = await makeQueuedVideo();

    const first = await store.claimForProcessing(id);
    expect(first?.attempts).toBe(1);
    expect(await store.completeProcessing(id, 1, 'queued')).toBe(true); // watchdog-style requeue

    const second = await store.claimForProcessing(id);
    expect(second?.attempts).toBe(2);

    expect(await store.heartbeat(id, 1)).toBe(false); // the old worker, waking up late
    expect(await store.heartbeat(id, 2)).toBe(true);
    expect(await store.completeProcessing(id, 1, 'ready')).toBe(false);
    expect((await store.getVideo(id))?.status).toBe('processing');
    expect(await store.completeProcessing(id, 2, 'ready')).toBe(true);
  });

  test('a heartbeat moves the timestamp forward', async () => {
    const id = await makeQueuedVideo();
    await store.claimForProcessing(id);

    const read = async () =>
      (await pool.query(`SELECT heartbeat_at FROM videos WHERE id = $1`, [id])).rows[0]
        .heartbeat_at as Date;

    const before = await read();
    await sleep(20);
    await store.heartbeat(id, 1);
    expect((await read()).getTime()).toBeGreaterThan(before.getTime());
  });
});