import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

const COOKIE_NAME = 'timekeeper.sid';
const SESSION_AGE_MS = 12 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export interface SessionRecord {
  tokenHash: string;
  csrfToken: string;
  expiresAt: number;
}

type WorkerContext = Context<any>;

function randomToken(bytes = 32): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cookieOptions(context: WorkerContext) {
  return {
    httpOnly: true,
    secure: new URL(context.req.url).protocol === 'https:',
    sameSite: 'Strict' as const,
    path: '/',
    maxAge: SESSION_AGE_MS / 1000,
  };
}

export async function readSession(
  context: WorkerContext,
  options: { rolling?: boolean } = {},
): Promise<SessionRecord | null> {
  const token = getCookie(context, COOKIE_NAME);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = (await context.env.DB.prepare(
    'SELECT token_hash, csrf_token, expires_at FROM sessions WHERE token_hash = ?',
  )
    .bind(tokenHash)
    .first()) as { token_hash: string; csrf_token: string; expires_at: number } | null;
  const now = Date.now();
  if (!row || row.expires_at <= now) {
    if (row)
      await context.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
        .bind(tokenHash)
        .run();
    deleteCookie(context, COOKIE_NAME, { path: '/' });
    return null;
  }
  let expiresAt = row.expires_at;
  if (options.rolling && expiresAt - now < SESSION_AGE_MS / 2) {
    expiresAt = now + SESSION_AGE_MS;
    await context.env.DB.prepare(
      'UPDATE sessions SET expires_at = ?, updated_at = ? WHERE token_hash = ?',
    )
      .bind(expiresAt, now, tokenHash)
      .run();
    setCookie(context, COOKIE_NAME, token, cookieOptions(context));
  }
  return { tokenHash, csrfToken: row.csrf_token, expiresAt };
}

export async function createSession(context: WorkerContext): Promise<SessionRecord> {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const csrfToken = randomToken(24);
  const now = Date.now();
  const expiresAt = now + SESSION_AGE_MS;
  await context.env.DB.prepare(
    `INSERT INTO sessions (token_hash, csrf_token, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(tokenHash, csrfToken, expiresAt, now, now)
    .run();
  setCookie(context, COOKIE_NAME, token, cookieOptions(context));
  return { tokenHash, csrfToken, expiresAt };
}

export async function destroySession(
  context: WorkerContext,
  session: SessionRecord,
): Promise<void> {
  await context.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
    .bind(session.tokenHash)
    .run();
  deleteCookie(context, COOKIE_NAME, { path: '/' });
}

export function requestIdentifier(context: WorkerContext): string {
  return (
    context.req.header('cf-connecting-ip') ??
    context.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

export async function isLoginBlocked(
  db: D1Database,
  identifier: string,
  now = Date.now(),
): Promise<boolean> {
  const row = await db
    .prepare('SELECT blocked_until FROM login_attempts WHERE identifier = ?')
    .bind(identifier)
    .first<{ blocked_until: number | null }>();
  return Boolean(row?.blocked_until && row.blocked_until > now);
}

export async function recordLoginFailure(
  db: D1Database,
  identifier: string,
  now = Date.now(),
): Promise<void> {
  const row = await db
    .prepare('SELECT attempt_count, window_started_at FROM login_attempts WHERE identifier = ?')
    .bind(identifier)
    .first<{ attempt_count: number; window_started_at: number }>();
  const withinWindow = row && row.window_started_at > now - ATTEMPT_WINDOW_MS;
  const count = withinWindow ? row.attempt_count + 1 : 1;
  const windowStartedAt = withinWindow ? row.window_started_at : now;
  const blockedUntil = count >= MAX_ATTEMPTS ? now + ATTEMPT_WINDOW_MS : null;
  await db
    .prepare(
      `INSERT INTO login_attempts
       (identifier, attempt_count, window_started_at, blocked_until, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(identifier) DO UPDATE SET
         attempt_count = excluded.attempt_count,
         window_started_at = excluded.window_started_at,
         blocked_until = excluded.blocked_until,
         updated_at = excluded.updated_at`,
    )
    .bind(identifier, count, windowStartedAt, blockedUntil, now)
    .run();
}

export async function clearLoginFailures(db: D1Database, identifier: string): Promise<void> {
  await db.prepare('DELETE FROM login_attempts WHERE identifier = ?').bind(identifier).run();
}

export async function removeExpiredSecurityRecords(
  db: D1Database,
  now = Date.now(),
): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    db
      .prepare(
        'DELETE FROM login_attempts WHERE updated_at < ? AND (blocked_until IS NULL OR blocked_until < ?)',
      )
      .bind(now - 24 * 60 * 60 * 1000, now),
  ]);
}
