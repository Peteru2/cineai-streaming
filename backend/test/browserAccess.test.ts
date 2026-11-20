import { describe, test, expect, beforeAll } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { S3Storage } from '../src/storage/s3Storage.js';

const ORIGIN = 'http://127.0.0.1:5173';
const BUCKET = 'cineai-test';
const base = `${process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000'}/${BUCKET}`;
const storage = S3Storage.fromEnv({ ...process.env, S3_BUCKET: BUCKET });

// Node's fetch can refuse to set an Origin header, so use plain http.
function send(method: string, url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = http.request(url, { method, headers }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    },
  );
}

beforeAll(async () => {
  await storage.ensureBucket();
  await storage.configureBrowserAccess([ORIGIN]);
});

describe('what a browser needs from storage', () => {
  test('streaming output (hls/) is readable without credentials', async () => {
    const key = `hls/${randomUUID()}/probe.txt`;
    await storage.putObject(key, Buffer.from('hello'), 'text/plain');

    const res = await send('GET', `${base}/${key}`);
    expect(res.status).toBe(200);
    expect(res.body).toBe('hello');
  });

  test('masters (uploads/) are NOT readable without credentials', async () => {
    const key = `uploads/${randomUUID()}/master`;
    await storage.putObject(key, Buffer.from('secret master'), 'video/mp4');

    const res = await send('GET', `${base}/${key}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain('secret master');
  });

  test('CORS preflight for a part upload (PUT) is allowed from the frontend origin', async () => {
    const res = await send('OPTIONS', `${base}/uploads/${randomUUID()}/master?partNumber=1`, {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'PUT',
    });
    expect(res.status).toBeLessThan(300);
    expect([ORIGIN, '*']).toContain(res.headers['access-control-allow-origin']);
    expect(String(res.headers['access-control-allow-methods'])).toContain('PUT');
  });

  test('segment reads carry the CORS header the player needs', async () => {
    const key = `hls/${randomUUID()}/probe.txt`;
    await storage.putObject(key, Buffer.from('x'), 'text/plain');

    const res = await send('GET', `${base}/${key}`, { Origin: ORIGIN });
    expect([ORIGIN, '*']).toContain(res.headers['access-control-allow-origin']);
  });
});