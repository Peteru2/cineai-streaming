import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { PostgresVideoStore } from '../src/db/postgresVideoStore.js';
import { masterKey } from '../src/storage/keys.js';
import { runWatchdogOnce, type WatchdogConfig } from '../src/worker/watchdog.js';
import { FakeQueue } from './helpers/fakeQueue.js';
import { FakeStorage } from './helpers/fakeStorage.js';

const pool = createPool();
const store = new PostgresVideoStore(pool);

const config: WatchdogConfig = {
  stallSeconds: 120,
  maxAttempts: 3,
  uploadedGraceSeconds: 60,
  queuedGraceSeconds: 300,
  reconcileAfterSeconds: 300,
  abandonAfterSeconds: 86_400,
  intervalMs: 60_000,
  batchSize: 10_000, // the shared test database also holds leftovers from other tests
};

class FlakyQueue extends FakeQueue {
  failFor = '';
  async enqueue(videoId: string, attempt: number, delayMs = 0): Promise<void> {
    if (videoId === this.failFor) throw new Error('redis is down');
    return super.enqueue(videoId, attempt, delayMs);
  }
}

async function newVideo(): Promise<string> {
  const { video } = await store.createVideo({
    creatorId: randomUUID(),
    filename: 'pilot.mp4',
    sizeBytes: 1000,
    contentType: 'video/mp4',
    idempotencyKey: randomUUID(),
  });
  return video.id;
}

async function queuedVideo(): Promise<string> {
  const id = await newVideo();
  await store.compareAndSetStatus(id, 'uploading', 'uploaded');
  await store.compareAndSetStatus(id, 'uploaded', 'queued');
  return id;
}

// Pretend time has passed, since tests cannot wait minutes.
async function ago(id: string, column: 'updated_at' | 'heartbeat_at', seconds: number) {
  await pool.query(`UPDATE videos SET ${column} = now() - make_interval(secs => $2) WHERE id = $1`, [
    id,
    seconds,
  ]);
}

const statusOf = async (id: string) => (await store.getVideo(id))?.status;

async function eventsOf(id: string) {
  const res = await pool.query(
    `SELECT to_status, reason FROM video_events WHERE video_id = $1 ORDER BY id`,
    [id],
  );
  return res.rows as { to_status: string; reason: string | null }[];
}

function run(storage = new FakeStorage(), queue: FakeQueue = new FakeQueue()) {
  return { storage, queue, go: () => runWatchdogOnce({ store, storage, queue, config }) };
}

const ticketsFor = (queue: FakeQueue, id: string) => queue.jobs.filter((j) => j.videoId === id);

beforeAll(async () => {
  await migrate(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('dead workers (F7, F8)', () => {
  test('a worker that went quiet loses the video, which is re-queued with the next attempt', async () => {
    const id = await queuedVideo();
    await store.claimForProcessing(id); // attempt 1
    await ago(id, 'heartbeat_at', 600);

    const { queue, go } = run();
    await go();

    expect(await statusOf(id)).toBe('queued');
    expect(ticketsFor(queue, id)).toEqual([{ videoId: id, attempt: 2, delayMs: 0 }]);
    expect((await eventsOf(id)).at(-1)?.reason).toContain('stopped responding');
  });

  test('a worker with a fresh heartbeat is left alone', async () => {
    const id = await queuedVideo();
    await store.claimForProcessing(id);

    const { queue, go } = run();
    await go();

    expect(await statusOf(id)).toBe('processing');
    expect(ticketsFor(queue, id)).toHaveLength(0);
  });

  test('a stall on the last attempt ends in failed with a reason, and no new ticket', async () => {
    const id = await queuedVideo();
    await store.claimForProcessing(id);
    await store.completeProcessing(id, 1, 'queued');
    await store.claimForProcessing(id);
    await store.completeProcessing(id, 2, 'queued');
    await store.claimForProcessing(id); // attempt 3
    await ago(id, 'heartbeat_at', 600);

    const { queue, go } = run();
    await go();

    const video = await store.getVideo(id);
    expect(video?.status).toBe('failed');
    expect(video?.failureReason).toContain('no attempts are left');
    expect(ticketsFor(queue, id)).toHaveLength(0);
  });

  test('a heartbeat that arrives first beats the watchdog', async () => {
    const id = await queuedVideo();
    await store.claimForProcessing(id);
    await ago(id, 'heartbeat_at', 600); // the watchdog's scan would see it as stale

    expect(await store.heartbeat(id, 1)).toBe(true); // the worker was only slow
    // The watchdog now acts on its old, stale view:
    expect(await store.expireStalled(id, 1, config.stallSeconds, 'queued', 'x')).toBe(false);
    expect(await statusOf(id)).toBe('processing');
  });

  test('two watchdogs at once take the video once', async () => {
    const id = await queuedVideo();
    await store.claimForProcessing(id);
    await ago(id, 'heartbeat_at', 600);

    const queue = new FakeQueue();
    const storage = new FakeStorage();
    await Promise.all([
      runWatchdogOnce({ store, storage, queue, config }),
      runWatchdogOnce({ store, storage, queue, config }),
    ]);

    expect(await statusOf(id)).toBe('queued');
    expect(ticketsFor(queue, id)).toHaveLength(1);
  });
});

describe('uploads (F3, F4)', () => {
  test('a lost completion is recovered: the file exists, so the video moves on', async () => {
    const id = await newVideo();
    await ago(id, 'updated_at', 600);

    const { storage, queue, go } = run();
    storage.completedKeys.add(masterKey(id)); // storage finished, the status never moved
    await go();

    expect(await statusOf(id)).toBe('queued');
    expect(ticketsFor(queue, id)).toEqual([{ videoId: id, attempt: 1, delayMs: 0 }]);
    expect((await eventsOf(id)).map((e) => e.to_status)).toEqual(['uploading', 'uploaded', 'queued']);
  });

  test('an upload that is merely in progress is left alone', async () => {
    const id = await newVideo();
    await ago(id, 'updated_at', 600); // old enough to be checked, not old enough to abandon

    await run().go();

    expect(await statusOf(id)).toBe('uploading');
  });

  test('an upload nobody finished is abandoned and its storage freed', async () => {
    const id = await newVideo();
    const { storage, go } = run();
    const uploadId = await storage.createMultipartUpload(masterKey(id));
    await store.setUploadIdIfEmpty(id, uploadId);
    await ago(id, 'updated_at', 2 * 86_400);

    await go();

    expect(await statusOf(id)).toBe('abandoned');
    expect(storage.uploads.has(uploadId)).toBe(false);
    expect((await eventsOf(id)).at(-1)?.reason).toContain('not finished within 24 hours');
  });
});

describe('dropped hand-offs', () => {
  test('an uploaded video with no ticket gets queued', async () => {
    const id = await newVideo();
    await store.compareAndSetStatus(id, 'uploading', 'uploaded');
    await ago(id, 'updated_at', 300);

    const { queue, go } = run();
    await go();

    expect(await statusOf(id)).toBe('queued');
    expect(ticketsFor(queue, id)).toHaveLength(1);
  });

  test('a queued video with a lost ticket gets a new ticket', async () => {
    const id = await queuedVideo();
    await ago(id, 'updated_at', 600);

    const { queue, go } = run();
    await go();

    expect(await statusOf(id)).toBe('queued');
    expect(ticketsFor(queue, id)).toEqual([{ videoId: id, attempt: 1, delayMs: 0 }]);
  });

  test('a freshly queued video is not touched', async () => {
    const id = await queuedVideo();

    const { queue, go } = run();
    await go();

    expect(ticketsFor(queue, id)).toHaveLength(0);
  });
});

describe('resilience', () => {
  test('one video that fails to be handled does not stop the others', async () => {
    const broken = await queuedVideo();
    const healthy = await queuedVideo();
    await ago(broken, 'updated_at', 600);
    await ago(healthy, 'updated_at', 600);

    const queue = new FlakyQueue();
    queue.failFor = broken;
    const report = await runWatchdogOnce({ store, storage: new FakeStorage(), queue, config });

    expect(report.errors).toBeGreaterThanOrEqual(1);
    expect(ticketsFor(queue, healthy)).toHaveLength(1);
  });
});