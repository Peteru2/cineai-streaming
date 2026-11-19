import { vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createPool } from '../../src/db/pool.js';
import { PostgresVideoStore } from '../../src/db/postgresVideoStore.js';
import type { ObjectStorage } from '../../src/storage/objectStorage.js';

export const MB = 1024 * 1024;

export const pool = createPool();
export const store = new PostgresVideoStore(pool);

export function startApp(storage: ObjectStorage, overrides: Partial<Config> = {}) {
  const onUploaded = vi.fn(async (_videoId: string) => {});
  const config: Config = { ...loadConfig({}), partSizeBytes: 5 * MB, ...overrides };
  const server = createApp({ store, storage, config, onUploaded }).listen(0);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, onUploaded, close: () => server.close() };
}

export async function api(
  base: string,
  method: string,
  path: string,
  opts: { creator?: string; body?: unknown; key?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.creator) headers['x-creator-id'] = opts.creator;
  if (opts.key) headers['idempotency-key'] = opts.key;

  const res = await fetch(base + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: (await res.json()) as any };
}