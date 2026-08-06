import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

const COOKIE_NAME = 'timekeeper.csrf';

function randomToken(bytes = 24): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function csrfToken(context: Context): string {
  const existing = getCookie(context, COOKIE_NAME);
  if (existing) return existing;
  const token = randomToken();
  setCookie(context, COOKIE_NAME, token, {
    httpOnly: true,
    secure: new URL(context.req.url).protocol === 'https:',
    sameSite: 'Strict',
    path: '/',
  });
  return token;
}

export function validCsrf(context: Context): boolean {
  const cookie = getCookie(context, COOKIE_NAME);
  const header = context.req.header('x-csrf-token');
  if (!cookie || !header || cookie.length !== header.length) return false;
  let difference = 0;
  for (let index = 0; index < cookie.length; index += 1) {
    difference |= cookie.charCodeAt(index) ^ header.charCodeAt(index);
  }
  return difference === 0;
}
