import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

// Any fixed number works, as long as every process uses the same one.
const MIGRATION_LOCK_ID = 727001;

// Runs every .sql file in order. A database-wide lock makes sure only one
// process migrates at a time; the others wait and then find nothing to do.
export async function migrate(pool: Pool): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  const client = await pool.connect(); // the lock belongs to this one connection
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    for (const file of files) {
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await client.query(sql);
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    } finally {
      client.release();
    }
  }
}