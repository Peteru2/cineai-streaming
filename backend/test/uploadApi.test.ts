import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrate } from '../src/db/migrate.js';
import { FakeStorage } from './helpers/fakeStorage.js';
import { api, startApp, pool, store, MB } from './helpers/apiHarness.js';

let storage: FakeStorage;
let app: ReturnType<typeof startApp>;

const createBody = (sizeMb = 12) => ({
  filename: 'pilot.mp4',
  sizeBytes: sizeMb * MB,
  contentType: 'video/mp4',
});

async function createVideo(creator: string, sizeMb = 12) {
  const res = await api(app.base, 'POST', '/videos', {
    creator,
    key: randomUUID(),
    body: createBody(sizeMb),
  });
  expect(res.status).toBe(201);
  return res.body;
}

async function uploadAll(videoId: string) {
  const video = await store.getVideo(videoId);
  const parts = Math.ceil((video!.sizeBytes) / (5 * MB));
  for (let n = 1; n <= parts; n++) {
    const size = n < parts ? 5 * MB : video!.sizeBytes - (parts - 1) * 5 * MB;
    storage.putPart(video!.uploadId!, n, size);
  }
}

beforeAll(async () => {
  await migrate(pool);
});

afterEach(() => app?.close());

afterAll(async () => {
  await pool.end();
});

describe('POST /videos', () => {
  test('rejects a request without a creator', async () => {
    storage = new FakeStorage();
    app = startApp(storage);
    const res = await api(app.base, 'POST', '/videos', { key: randomUUID(), body: createBody() });
    expect(res.status).toBe(401);
  });

  test('creates a video and returns signed URLs for every part', async () => {
    storage = new FakeStorage();
    app = startApp(storage);
    const body = await createVideo(randomUUID(), 12); // 5 + 5 + 2 MB = 3 parts

    expect(body.video.status).toBe('uploading');
    expect(body.upload.totalParts).toBe(3);
    expect(body.upload.missingParts).toHaveLength(3);
    expect(body.upload.missingParts[2].size).toBe(2 * MB);
    expect(body.upload.missingParts[0].url).toContain('http://fake-storage/');
  });

  test('the same idempotency key returns the same video and one storage upload', async () => {
    storage = new FakeStorage();
    app = startApp(storage);
    const creator = randomUUID();
    const key = randomUUID();

    const a = await api(app.base, 'POST', '/videos', { creator, key, body: createBody() });
    const b = await api(app.base, 'POST', '/videos', { creator, key, body: createBody() });

    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.video.id).toBe(a.body.video.id);
    expect(storage.createCount).toBe(1);
  });

  test('ten simultaneous retries with one key still create one upload', async () => {
    storage = new FakeStorage();
    app = startApp(storage);
    const creator = randomUUID();
    const key = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        api(app.base, 'POST', '/videos', { creator, key, body: createBody() }),
      ),
    );

    const ids = new Set(results.map((r) => r.body.video.id));
    expect(ids.size).toBe(1);
    const usable = new Set(storage.uploads.keys());
    expect(usable.size).toBe(1); // extra uploads were aborted
  });

  test('rejects oversized, wrong-type and keyless requests', async () => {
    storage = new FakeStorage();
    app = startApp(storage);
    const creator = randomUUID();

    const big = await api(app.base, 'POST', '/videos', {
      creator,
      key: randomUUID(),
      body: { ...createBody(), sizeBytes: 50 * 1024 * MB },
    });
    expect(big.status).toBe(413);

    const wrongType = await api(app.base, 'POST', '/videos', {
      creator,
      key: randomUUID(),
      body: { ...createBody(), contentType: 'application/zip' },
    });
    expect(wrongType.status).toBe(415);

    const noKey = await api(app.base, 'POST', '/videos', { creator, body: createBody() });
    expect(noKey.status).toBe(400);
  });

  test('the kill switch pauses new uploads but not status checks', async () => {
    storage = new FakeStorage();
    const creator = randomUUID();
    app = startApp(storage);
    const made = await createVideo(creator);
    app.close();

    app = startApp(storage, { uploadsEnabled: false });
    const paused = await api(app.base, 'POST', '/videos', {
      creator,
      key: randomUUID(),
      body: createBody(),
    });
    expect(paused.status).toBe(503);
    expect(paused.body.error).toBe('uploads_paused');

    const status = await api(app.base, 'GET', `/videos/${made.video.id}`, { creator });
    expect(status.status).toBe(200);
  });
});

describe('resume (GET /videos/:id/parts)', () => {
  test('after a drop, only the missing parts come back', async () => {
    storage = new FakeStorage();
    app = startApp(storage);
    const creator = randomUUID();
    const made = await createVideo(creator, 12); // 3 parts
    const video = await store.getVideo(made.video.id);

    storage.putPart(video!.uploadId!, 1, 5 * MB); // the network died after part 2
    storage.putPart(video!.uploadId!, 2, 5 * MB);

    const res = await api(app.base, 'GET', `/videos/${made.video.id}/parts`, { creator });
    expect(res.status).toBe(200);
    expect(res.body.upload.uploadedParts.map((p: any) => p.partNumber)).toEqual([1, 2]);
    expect(res.body.upload.missingParts.map((p: any) => p.partNumber)).toEqual([3]);
  });

  test('a creator can find their unfinished uploads', async () => {
    storage = new FakeStorage();
    app = startApp(storage);
    const creator = randomUUID();
    const made = await createVideo(creator);

    const res = await api(app.base, 'GET', '/videos?status=uploading', { creator });
    expect(res.body.videos.map((v: any) => v.id)).toContain(made.video.id);
  });

  test("another creator cannot see someone else's upload", async () => {
    storage = new FakeStorage();
    app = startApp(storage);
    const made = await createVideo(randomUUID());

    const res = await api(app.base, 'GET', `/videos/${made.video.id}/parts`, { creator: randomUUID() });
    expect(res.status).toBe(404);
  });
});

describe('POST /videos/:id/complete', () => {
  test('refuses while parts are missing', async () => {
    storage = new FakeStorage();
    app = startApp(storage);
    const creator = randomUUID();
    const made = await createVideo(creator);
    const video = await store.getVideo(made.video.id);
    storage.putPart(video!.uploadId!, 1, 5 * MB);

    const res = await api(app.base, 'POST', `/videos/${made.video.id}/complete`, { creator });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('incomplete');
    expect(res.body.details.missingParts).toEqual([2, 3]);
    expect((await store.getVideo(made.video.id))?.status).toBe('uploading');
  });

  test('refuses when stored bytes do not match the declared size', async () => {
    storage = new FakeStorage();
    app = startApp(storage);
    const creator = randomUUID();
    const made = await createVideo(creator);
    const video = await store.getVideo(made.video.id);
    storage.putPart(video!.uploadId!, 1, 5 * MB);
    storage.putPart(video!.uploadId!, 2, 5 * MB);
    storage.putPart(video!.uploadId!, 3, 1 * MB); // should be 2 MB: a different file

    const res = await api(app.base, 'POST', `/videos/${made.video.id}/complete`, { creator });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('size_mismatch');
  });

  test('completes once everything is stored', async () => {
    storage = new FakeStorage();
    app = startApp(storage);
    const creator = randomUUID();
    const made = await createVideo(creator);
    await uploadAll(made.video.id);

    const res = await api(app.base, 'POST', `/videos/${made.video.id}/complete`, { creator });
    expect(res.status).toBe(200);
    expect(res.body.video.status).toBe('uploaded');
    expect(app.onUploaded).toHaveBeenCalledTimes(1);
  });

  test('five simultaneous complete requests trigger exactly one onUploaded', async () => {
    storage = new FakeStorage();
    app = startApp(storage);
    const creator = randomUUID();
    const made = await createVideo(creator);
    await uploadAll(made.video.id);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api(app.base, 'POST', `/videos/${made.video.id}/complete`, { creator }),
      ),
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.body.video.status === 'uploaded')).toBe(true);
    expect(app.onUploaded).toHaveBeenCalledTimes(1);

    const events = await pool.query(
      `SELECT count(*)::int AS n FROM video_events WHERE video_id = $1 AND to_status = 'uploaded'`,
      [made.video.id],
    );
    expect(events.rows[0].n).toBe(1);
  });

  test('a repeat complete after finishing is a harmless success', async () => {
    storage = new FakeStorage();
    app = startApp(storage);
    const creator = randomUUID();
    const made = await createVideo(creator);
    await uploadAll(made.video.id);

    await api(app.base, 'POST', `/videos/${made.video.id}/complete`, { creator });
    const again = await api(app.base, 'POST', `/videos/${made.video.id}/complete`, { creator });

    expect(again.status).toBe(200);
    expect(app.onUploaded).toHaveBeenCalledTimes(1);
  });
});