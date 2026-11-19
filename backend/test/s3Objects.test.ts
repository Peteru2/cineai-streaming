import { test, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { S3Storage } from '../src/storage/s3Storage.js';
import { ObjectNotFoundError } from '../src/storage/objectStorage.js';

const storage = S3Storage.fromEnv({ ...process.env, S3_BUCKET: 'cineai-test' });

beforeAll(async () => {
  await storage.ensureBucket();
});

test('putObject then downloadToFile returns the same bytes', async () => {
  const key = `tests/${randomUUID()}.bin`;
  const data = Buffer.from('hello streaming');
  await storage.putObject(key, data, 'application/octet-stream', 'public, max-age=60');

  const file = path.join(os.tmpdir(), randomUUID());
  await storage.downloadToFile(key, file);
  expect(readFileSync(file).equals(data)).toBe(true);
  rmSync(file);
});

test('downloading a missing object throws ObjectNotFoundError', async () => {
  const file = path.join(os.tmpdir(), randomUUID());
  await expect(storage.downloadToFile(`tests/${randomUUID()}`, file)).rejects.toThrow(
    ObjectNotFoundError,
  );
});