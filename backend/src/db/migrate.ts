import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

// Runs every .sql file in order. Each file is written to be safe to run twice.
export async function migrate(pool: Pool): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    await pool.query(sql);
  }
}