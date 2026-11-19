import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrate } from '../src/db/migrate.js';
import { S3Storage } from '../src/storage/s3Storage.js';
import { api, startApp, pool, MB } from './helpers/apiHarness.js';

const storage = S3Storage.fromEnv({ ...process.env, S3_BUCKET: 'cineai-test' });
let app: ReturnType<typeof startApp>;

async function putPart(url: string, bytes: number) {
  const res = await fetch(url, { method: 'PUT', body: Buffer.alloc(bytes, 1) });
  expect(res.status, `part upload failed: ${await res.clone().text()}`).toBe(200);
}

beforeAll(async () => {
  await migrate(pool);
  await storage.ensureBucket();
  app = startApp(storage);
});

afterAll(async () => {
  app.close();
  await pool.end();
});

describe('real storage: an upload that survives a drop', () => {
  test('resumes from the stored parts and completes', async () => {
    const creator = randomUUID();
    const created = await api(app.base, 'POST', '/videos', {
      creator,
      key: randomUUID(),
      body: { filename: 'pilot.mp4', sizeBytes: 12 * MB, contentType: 'video/mp4' }, // 5 + 5 + 2
    });
    expect(created.status).toBe(201);
    const id = created.body.video.id as string;
    const first = created.body.upload.missingParts as { partNumber: number; size: number; url: string }[];

    // The browser sends parts 1 and 2, then the network dies before part 3.
    await putPart(first[0]!.url, first[0]!.size);
    await putPart(first[1]!.url, first[1]!.size);

    // Completing now must be refused.
    const early = await api(app.base, 'POST', `/videos/${id}/complete`, { creator });
    expect(early.status).toBe(409);
    expect(early.body.details.missingParts).toEqual([3]);

    // Back online: ask storage what exists.
    const resume = await api(app.base, 'GET', `/videos/${id}/parts`, { creator });
    expect(resume.body.upload.uploadedParts.map((p: any) => p.partNumber)).toEqual([1, 2]);
    const missing = resume.body.upload.missingParts as { partNumber: number; size: number; url: string }[];
    expect(missing.map((p) => p.partNumber)).toEqual([3]);

    // Send only the missing part, then complete.
    await putPart(missing[0]!.url, missing[0]!.size);
    const done = await api(app.base, 'POST', `/videos/${id}/complete`, { creator });
    expect(done.status).toBe(200);
    expect(done.body.video.status).toBe('uploaded');
    expect(await storage.objectExists(`uploads/${id}/master`)).toBe(true);
  });
});