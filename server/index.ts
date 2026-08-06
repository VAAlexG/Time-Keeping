import path from 'node:path';
import express from 'express';
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import { createApp } from './app';
import { createPool } from './db';
import { runMigrations } from './migrations';
import { PgTimeStore } from './pg-store';

async function main(): Promise<void> {
  const passwordHash = process.env.APP_PASSWORD_HASH;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!passwordHash) throw new Error('APP_PASSWORD_HASH is required');
  if (!sessionSecret || sessionSecret.length < 32)
    throw new Error('SESSION_SECRET must contain at least 32 characters');
  const pool = createPool();
  await runMigrations(pool);
  const PgSession = connectPgSimple(session);
  const app = createApp({
    store: new PgTimeStore(pool),
    sessionStore: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: false }),
    passwordHash,
    sessionSecret,
    production: process.env.NODE_ENV === 'production',
  });
  const clientDir = path.resolve(process.cwd(), 'dist/client');
  app.use(express.static(clientDir, { index: false, maxAge: '1y', immutable: true }));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port, () => console.log(`Timekeeper listening on port ${port}`));
  const shutdown = () => server.close(() => pool.end().finally(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
