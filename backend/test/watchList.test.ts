import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrate } from '../src/db/migrate.js';
import { parseLimit } from '../src/api/playbackRoutes.js';
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

describe('GET /watch (the film list)', () => {
  test('lists ready videos and never lists unfinished ones', async () => {
    app = startApp(new FakeStorage());
    const ready = await readyVideo();
    const unfinished = await newVideo();

    const res = await api(app.base, 'GET', '/watch?limit=48');
    expect(res.status).toBe(200);
    const ids = res.body.films.map((f: { id: string }) => f.id);
    expect(ids).toContain(ready);
    expect(ids).not.toContain(unfinished);
  });

  test('the newest film comes first', async () => {
    app = startApp(new FakeStorage());
    const older = await readyVideo();
    const newer = await readyVideo();

    const res = await api(app.base, 'GET', '/watch?limit=48');
    const ids = res.body.films.map((f: { id: string }) => f.id);
    expect(ids.indexOf(newer)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
  });

  test('each film exposes only public fields', async () => {
    app = startApp(new FakeStorage(), { mediaBaseUrl: 'https://cdn.example.com/media' });
    const id = await readyVideo();

    const res = await api(app.base, 'GET', '/watch?limit=48');
    const film = res.body.films.find((f: { id: string }) => f.id === id);
    expect(Object.keys(film).sort()).toEqual(['createdAt', 'filename', 'id', 'posterUrl']);
    expect(film.posterUrl).toBe(`https://cdn.example.com/media/hls/${id}/poster.jpg`);
  });

  test('the limit is respected, and nonsense limits are handled', async () => {
    app = startApp(new FakeStorage());
    await readyVideo();

    expect((await api(app.base, 'GET', '/watch?limit=1')).body.films).toHaveLength(1);

    const junk = await api(app.base, 'GET', '/watch?limit=abc');
    expect(junk.status).toBe(200);
    expect(junk.body.films.length).toBeLessThanOrEqual(24);

    const huge = await api(app.base, 'GET', '/watch?limit=100000');
    expect(huge.body.films.length).toBeLessThanOrEqual(48);
  });
});

test('parseLimit falls back, bounds and caps', () => {
  expect(parseLimit(undefined)).toBe(24);
  expect(parseLimit('')).toBe(24);
  expect(parseLimit('abc')).toBe(24);
  expect(parseLimit('0')).toBe(24);
  expect(parseLimit('-5')).toBe(24);
  expect(parseLimit('2.5')).toBe(24);
  expect(parseLimit('10')).toBe(10);
  expect(parseLimit('999')).toBe(48);
});