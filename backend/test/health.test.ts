import { test, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';

test('GET /health returns ok', async () => {
  const server = createApp().listen(0); // port 0 = pick any free port
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  } finally {
    server.close();
  }
});