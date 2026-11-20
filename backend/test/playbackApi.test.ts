import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { FakeStorage } from './helpers/fakeStorage.js';
import { api, startApp, pool, store } from './helpers/apiHarness.js';

let app: ReturnType<typeof startApp>;

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

async function readyVideo(): Promise<string> {
  const id = await newVideo();
  await store.compareAndSetStatus(id, 'uploading', 'uploaded');
  await store.compareAndSetStatus(id, 'uploaded', 'queued');
  const claimed = await store.claimForProcessing(id);
  await store.completeProcessing(id, claimed!.attempts, 'ready');
  return id;
}

beforeAll(async () => {
  await migrate(pool);
});

afterEach(() => app?.close());

afterAll(async () => {
  await pool.end();
});

describe('GET /watch/:id', () => {
  test('a video that is not ready cannot be played, and says why', async () => {
    app = startApp(new FakeStorage());
    const id = await newVideo();

    const res = await api(app.base, 'GET', `/watch/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_ready');
    expect(res.body.details.status).toBe('uploading');
  });

  test('a ready video returns playlist and poster URLs on the media host', async () => {
    app = startApp(new FakeStorage(), { mediaBaseUrl: 'https://cdn.example.com/media' });
    const id = await readyVideo();

    const res = await api(app.base, 'GET', `/watch/${id}`); // no creator header: viewers are anonymous
    expect(res.status).toBe(200);
    expect(res.body.manifestUrl).toBe(`https://cdn.example.com/media/hls/${id}/master.m3u8`);
    expect(res.body.posterUrl).toBe(`https://cdn.example.com/media/hls/${id}/poster.jpg`);
  });

  test('unknown and malformed IDs are 404', async () => {
    app = startApp(new FakeStorage());
    expect((await api(app.base, 'GET', `/watch/${randomUUID()}`)).status).toBe(404);
    expect((await api(app.base, 'GET', '/watch/not-a-uuid')).status).toBe(404);
  });
});

test('the media base URL has no trailing slash', () => {
  expect(loadConfig({ MEDIA_BASE_URL: 'https://x.example.com/m///' }).mediaBaseUrl).toBe(
    'https://x.example.com/m',
  );
});