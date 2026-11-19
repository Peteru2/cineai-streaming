import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Tests always use the local Docker database, never a hosted one.
    env: {
      DATABASE_URL: 'postgres://cineai:cineai@127.0.0.1:5433/cineai',
    },
  },
});