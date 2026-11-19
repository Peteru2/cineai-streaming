import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FfmpegProcessor } from '../src/worker/media/ffmpegProcessor.js';
import { loadProcessingConfig } from '../src/worker/media/processingConfig.js';
import { PermanentProcessingError } from '../src/worker/processor.js';
import { hlsPrefix, masterKey } from '../src/storage/keys.js';
import type { VideoRecord } from '../src/db/postgresVideoStore.js';
import { FakeStorage } from './helpers/fakeStorage.js';

const hasTools =
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

let tmp: string;

function ffmpeg(args: string[]) {
  const res = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
  expect(res.status, res.stderr?.toString()).toBe(0);
}

function makeVideo(file: string, width: number, height: number, withAudio: boolean) {
  const args = ['-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=25`];
  if (withAudio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100');
  args.push('-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (withAudio) args.push('-c:a', 'aac');
  ffmpeg([...args, file]);
}

const fakeVideo = (id: string): VideoRecord => ({
  id,
  creatorId: 'c',
  filename: 'f.mp4',
  sizeBytes: 1,
  contentType: 'video/mp4',
  status: 'processing',
  uploadId: null,
  attempts: 1,
  failureReason: null,
  createdAt: new Date(),
});

function setup(source: Buffer | null) {
  const storage = new FakeStorage();
  const id = randomUUID();
  if (source) storage.objects.set(masterKey(id), source);
  const processor = new FfmpegProcessor(storage, loadProcessingConfig({ FFMPEG_PRESET: 'ultrafast' }));
  const keys = () =>
    [...storage.objects.keys()].filter((k) => k.startsWith(hlsPrefix(id))).map((k) => k.slice(hlsPrefix(id).length + 1));
  return { storage, id, processor, keys };
}

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'cineai-test-'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!hasTools)('FfmpegProcessor with real FFmpeg', () => {
  test('turns a 720p master into a quality ladder with constant frame rate', async () => {
    const file = path.join(tmp, 'a.mp4');
    makeVideo(file, 1280, 720, true);
    const { storage, id, processor, keys } = setup(readFileSync(file));

    await processor.process(fakeVideo(id), new AbortController().signal);

    const names = keys();
    expect(names).toContain('master.m3u8');
    expect(names).toContain('poster.jpg');
    for (const rung of ['720p', '480p', '360p']) expect(names).toContain(`${rung}/index.m3u8`);
    expect(names.some((n) => n.startsWith('1080p'))).toBe(false); // never upscaled
    expect(names.filter((n) => n.startsWith('720p/seg_')).length).toBeGreaterThanOrEqual(2);

    const master = storage.objects.get(`${hlsPrefix(id)}/master.m3u8`)!.toString();
    expect(master.match(/#EXT-X-STREAM-INF/g)).toHaveLength(3);

    const playlist = storage.objects.get(`${hlsPrefix(id)}/360p/index.m3u8`)!.toString();
    expect(playlist).toContain('#EXT-X-ENDLIST');

    // The source was 25 fps; every output segment must be 30 fps.
    const segment = path.join(tmp, 'segment.ts');
    writeFileSync(segment, storage.objects.get(`${hlsPrefix(id)}/360p/seg_00000.ts`)!);
    const probe = spawnSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate',
      '-of', 'default=noprint_wrappers=1:nokey=1', segment,
    ]);
    const output = probe.stdout.toString().trim();
    const rates = output.split(/\s+/).filter(Boolean);
    expect(rates.length, `ffprobe printed "${output}"`).toBeGreaterThan(0);
    for (const rate of rates) {
      const [n, d] = rate.split('/').map(Number);
      expect(n! / d!, `ffprobe printed "${rate}"`).toBeCloseTo(30, 0);
    }
  }, 120_000);

  test('a video with no audio track still works', async () => {
    const file = path.join(tmp, 'silent.mp4');
    makeVideo(file, 640, 360, false);
    const { id, processor, keys } = setup(readFileSync(file));

    await processor.process(fakeVideo(id), new AbortController().signal);

    expect(keys()).toContain('master.m3u8');
    expect(keys()).toContain('360p/index.m3u8');
  }, 60_000);

  test('random bytes are a permanent error, not a retry', async () => {
    const { id, processor } = setup(Buffer.from('this is definitely not a video '.repeat(200)));
    await expect(processor.process(fakeVideo(id), new AbortController().signal)).rejects.toThrow(
      PermanentProcessingError,
    );
  }, 30_000);

  test('an audio-only file is a permanent error', async () => {
    const file = path.join(tmp, 'audio.m4a');
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:a', 'aac', file]);
    const { id, processor } = setup(readFileSync(file));
    await expect(processor.process(fakeVideo(id), new AbortController().signal)).rejects.toThrow(
      /no video track/,
    );
  }, 30_000);

  test('a missing master is a permanent error', async () => {
    const { id, processor } = setup(null);
    await expect(processor.process(fakeVideo(id), new AbortController().signal)).rejects.toThrow(
      PermanentProcessingError,
    );
  }, 30_000);

  test('a stopped worker stops FFmpeg and publishes no manifest', async () => {
    const file = path.join(tmp, 'long.mp4');
    makeVideo(file, 1280, 720, true);
    const { id, processor, keys } = setup(readFileSync(file));

    const controller = new AbortController();
    const running = processor.process(fakeVideo(id), controller.signal);
    setTimeout(() => controller.abort(), 100);

    await expect(running).rejects.toThrow();
    expect(keys()).not.toContain('master.m3u8');
  }, 60_000);
});