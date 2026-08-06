import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const migrationDir = path.resolve(process.cwd(), 'migrations');

  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename varchar(255) PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort();
  for (const filename of files) {
    const exists = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [
      filename,
    ]);
    if (exists.rowCount) continue;
    const sql = await readFile(path.join(migrationDir, filename), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
        [filename],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
