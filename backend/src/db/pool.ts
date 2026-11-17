import pg from 'pg';

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://cineai:cineai@localhost:5432/cineai';

export function createPool(): pg.Pool {
  return new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
}