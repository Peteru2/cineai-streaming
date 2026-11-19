import pg from 'pg';

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://cineai:cineai@127.0.0.1:5433/cineai';

export function createPool(): pg.Pool {
  return new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
}