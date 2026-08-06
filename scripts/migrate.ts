import { createPool } from '../server/db';
import { runMigrations } from '../server/migrations';

const pool = createPool();
try {
  await runMigrations(pool);
  console.log('Database migrations are up to date.');
} finally {
  await pool.end();
}
