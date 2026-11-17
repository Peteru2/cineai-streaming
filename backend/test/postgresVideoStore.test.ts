import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { PostgresVideoStore, type NewVideo } from '../src/db/postgresVideoStore.js';
import { transitionVideo } from '../src/domain/transition.js';
import { InvalidTransitionError } from '../src/domain/status.js';

const pool = createPool();
const store = new PostgresVideoStore(pool);

function newVideo(overrides: Partial<NewVideo> = {}): NewVideo {
  return {
    creatorId: randomUUID(), // fresh creator per test, so runs never collide
    filename: 'pilot.mp4',
    sizeBytes: 2_000_000_000,
    contentType: 'video/mp4',
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

async function countEvents(videoId: string, toStatus: string): Promise<number> {
  const res = await pool.query(
    `SELECT count(*)::int AS n FROM video_events WHERE video_id = $1 AND to_status = $2`,
    [videoId, toStatus],
  );
  return res.rows[0].n as number;
}

beforeAll(async () => {
  await migrate(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('createVideo', () => {
  test('creates a video in uploading status with a first event', async () => {
    const { video, created } = await store.createVideo(newVideo());
    expect(created).toBe(true);
    expect(video.status).toBe('uploading');
    expect(await countEvents(video.id, 'uploading')).toBe(1);
  });

  test('the same idempotency key returns the same video', async () => {
    const input = newVideo();
    const first = await store.createVideo(input);
    const second = await store.createVideo(input);

    expect(second.created).toBe(false);
    expect(second.video.id).toBe(first.video.id);
    expect(await countEvents(first.video.id, 'uploading')).toBe(1);
  });

  test('the same key from a different creator is a different video', async () => {
    const key = randomUUID();
    const a = await store.createVideo(newVideo({ idempotencyKey: key }));
    const b = await store.createVideo(newVideo({ idempotencyKey: key }));
    expect(a.video.id).not.toBe(b.video.id);
  });
});

describe('compareAndSetStatus against real Postgres', () => {
  test('five simultaneous complete signals apply exactly once', async () => {
    const { video } = await store.createVideo(newVideo());

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        transitionVideo(store, video.id, 'uploading', 'uploaded'),
      ),
    );

    expect(results.filter((r) => r === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r === 'lost_race')).toHaveLength(4);
    expect((await store.getVideo(video.id))?.status).toBe('uploaded');
    expect(await countEvents(video.id, 'uploaded')).toBe(1); // one event, not five
  });

  test('a stale expectation changes nothing and records nothing', async () => {
    const { video } = await store.createVideo(newVideo());
    const result = await transitionVideo(store, video.id, 'queued', 'processing');

    expect(result).toBe('lost_race');
    expect((await store.getVideo(video.id))?.status).toBe('uploading');
    expect(await countEvents(video.id, 'processing')).toBe(0);
  });

  test('an illegal transition is rejected before touching the database', async () => {
    const { video } = await store.createVideo(newVideo());
    await expect(transitionVideo(store, video.id, 'uploading', 'ready')).rejects.toThrow(
      InvalidTransitionError,
    );
    expect((await store.getVideo(video.id))?.status).toBe('uploading');
  });

  test('the database itself refuses a nonsense status', async () => {
    const { video } = await store.createVideo(newVideo());
    await expect(
      pool.query(`UPDATE videos SET status = 'procesing' WHERE id = $1`, [video.id]),
    ).rejects.toThrow();
  });
});