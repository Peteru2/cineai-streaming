import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { BullJobQueue, redisConnection } from '../src/queue/jobQueue.js';
import { S3Storage } from '../src/storage/s3Storage.js';
import { masterManifestKey, posterKey } from '../src/storage/keys.js';
import { enqueueUploadedVideo } from '../src/worker/enqueue.js';
import { startWorker } from '../src/worker/worker.js';
import { FfmpegProcessor } from '../src/worker/media/ffmpegProcessor.js';
import { loadProcessingConfig } from '../src/worker/media/processingConfig.js';
import { api, pool, store } from './helpers/apiHarness.js';
import { waitFor } from './helpers/waitFor.js';
import { migrate } from '../src/db/migrate.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('end to end', () => {
  test('a real video is uploaded, processed and made ready to stream', async () => {
    await migrate(pool);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cineai-e2e-'));
    const source = path.join(dir, 'in.mp4');
    const gen = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source,
    ]);
    expect(gen.status, gen.stderr.toString()).toBe(0);
    const bytes = readFileSync(source);

    const storage = S3Storage.fromEnv({ ...process.env, S3_BUCKET: 'cineai-test' });
    await storage.ensureBucket();

    const queueName = `video-processing-e2e-${randomUUID()}`;
    const queue = new BullJobQueue(redisConnection(), queueName);
    const worker = startWorker({
      deps: {
        store,
        queue,
        processor: new FfmpegProcessor(storage, loadProcessingConfig({ FFMPEG_PRESET: 'ultrafast' })),
        config: { maxAttempts: 3, heartbeatMs: 1000, retryDelayMs: 500 },
      },
      queueName,
      connection: redisConnection(),
      concurrency: 1,
    });
    const server = createApp({
      store,
      storage,
      config: loadConfig({}),
      onUploaded: async (videoId) => {
        await enqueueUploadedVideo(store, queue, videoId);
      },
    }).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const creator = randomUUID();
      const created = await api(base, 'POST', '/videos', {
        creator,
        key: randomUUID(),
        body: { filename: 'e2e.mp4', sizeBytes: bytes.length, contentType: 'video/mp4' },
      });
      expect(created.status).toBe(201);
      const id = created.body.video.id as string;

      // The "browser": send the chunk straight to storage with the signed URL.
      const part = created.body.upload.missingParts[0];
      const put = await fetch(part.url, { method: 'PUT', body: bytes });
      expect(put.status).toBe(200);

      const completed = await api(base, 'POST', `/videos/${id}/complete`, { creator });
      expect(completed.status).toBe(200);

      // Wait for the worker. Fail fast, with the reason, if processing fails.
      await waitFor(async () => {
        const video = await store.getVideo(id);
        if (video?.status === 'failed') throw new Error(`processing failed: ${video.failureReason}`);
        return video?.status === 'ready';
      }, 90_000, 250);

      expect(await storage.objectExists(masterManifestKey(id))).toBe(true);
      expect(await storage.objectExists(posterKey(id))).toBe(true);

      const playlistFile = path.join(dir, 'master.m3u8');
      await storage.downloadToFile(masterManifestKey(id), playlistFile);
      expect(readFileSync(playlistFile, 'utf8')).toContain('#EXT-X-STREAM-INF');

      const events = await pool.query(
        `SELECT to_status FROM video_events WHERE video_id = $1 ORDER BY id`,
        [id],
      );
      expect(events.rows.map((r) => r.to_status)).toEqual([
        'uploading', 'uploaded', 'queued', 'processing', 'ready',
      ]);

      const watch = await api(base, 'GET', `/watch/${id}`);
      expect(watch.status).toBe(200);
      expect(watch.body.manifestUrl).toContain(`/hls/${id}/master.m3u8`);
    } finally {
      await worker.close();
      await queue.close();
      server.close();
      rmSync(dir, { recursive: true, force: true });
      await pool.end();
    }
  }, 120_000);
});