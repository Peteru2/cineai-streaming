import { createPool } from './pool.js';
import { migrate } from './migrate.js';

const pool = createPool();

try {
  await migrate(pool);
  console.log('Migrations applied.');
} catch (error) {
  console.error('Migration failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
