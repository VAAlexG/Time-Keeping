import ExcelJS from 'exceljs';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../server/auth';
import { brisbaneNow, getWeekRange } from '../server/time';
import worker, { runScheduledReport } from '../worker';
import type { Env } from '../worker/env';

let passwordHash = '';

beforeAll(async () => {
  passwordHash = await hashPassword('test-password', new Uint8Array(16).fill(7));
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM weekly_report_deliveries'),
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM login_attempts'),
    env.DB.prepare('DELETE FROM time_entries'),
    env.DB.prepare('DELETE FROM projects'),
  ]);
  vi.restoreAllMocks();
});

function bindings(): Env {
  return {
    DB: env.DB,
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    APP_PASSWORD_HASH: passwordHash,
    RESEND_API_KEY: 're_test_key',
    EMAIL_FROM: 'Timekeeper <reports@example.com>',
    WEEKLY_REPORT_RECIPIENT: 'weekly@example.com',
    REPORT_TEST_RECIPIENT: 'test@example.com',
  };
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://timekeeper.example${path}`, init),
    bindings(),
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function login(ip = '203.0.113.10') {
  const response = await call('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ password: 'test-password' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrfToken: string };
  return {
    csrf: body.csrfToken,
    cookie: response.headers.get('set-cookie')!.split(';')[0],
  };
}

function authenticatedHeaders(session: { csrf: string; cookie: string }, json = true) {
  return {
    Cookie: session.cookie,
    'X-CSRF-Token': session.csrf,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

describe('Cloudflare Worker authentication', () => {
  it('protects routes, recovers the D1 session, and logs out', async () => {
    expect((await call('/api/dashboard')).status).toBe(401);
    const session = await login();
    const recovered = await call('/api/session', { headers: { Cookie: session.cookie } });
    expect(await recovered.json()).toEqual({ authenticated: true, csrfToken: session.csrf });
    expect((await call('/api/dashboard', { headers: { Cookie: session.cookie } })).status).toBe(
      200,
    );
    expect(
      (
        await call('/api/logout', {
          method: 'POST',
          headers: authenticatedHeaders(session, false),
        })
      ).status,
    ).toBe(204);
    expect((await call('/api/dashboard', { headers: { Cookie: session.cookie } })).status).toBe(
      401,
    );
  });

  it('rate limits repeated incorrect passwords in D1', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await call('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.55' },
        body: JSON.stringify({ password: 'wrong' }),
      });
      expect(response.status).toBe(401);
    }
    const blocked = await call('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.55' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    expect(blocked.status).toBe(429);
  });
});

describe('Cloudflare Worker timekeeping workflow', () => {
  it('clocks in and out and enforces one active timer in D1', async () => {
    const session = await login();
    const started = await call('/api/clock-in', {
      method: 'POST',
      headers: authenticatedHeaders(session),
      body: JSON.stringify({ projectName: 'Coding project', notes: 'Worker migration' }),
    });
    expect(started.status).toBe(201);
    const second = await call('/api/clock-in', {
      method: 'POST',
      headers: authenticatedHeaders(session),
      body: JSON.stringify({ projectName: 'Accounting' }),
    });
    expect(second.status).toBe(409);
    await env.DB.prepare(
      'UPDATE time_entries SET start_at = start_at - 3600000 WHERE active_guard = 1',
    ).run();
    const stopped = await call('/api/clock-out', {
      method: 'POST',
      headers: authenticatedHeaders(session, false),
    });
    expect(stopped.status).toBe(200);
    expect(((await stopped.json()) as { entry: { endAt: string } }).entry.endAt).toBeTruthy();
  });

  it('completes add, edit, totals, and authenticated Excel download end to end', async () => {
    const session = await login();
    const localDate = brisbaneNow().toISODate()!;
    const invalid = await call('/api/entries', {
      method: 'POST',
      headers: authenticatedHeaders(session),
      body: JSON.stringify({
        projectName: 'Accounting',
        notes: '',
        startLocal: `${localDate}T12:00`,
        endLocal: `${localDate}T11:00`,
      }),
    });
    expect(invalid.status).toBe(400);
    const created = await call('/api/entries', {
      method: 'POST',
      headers: authenticatedHeaders(session),
      body: JSON.stringify({
        projectName: 'Accounting',
        notes: 'Initial entry',
        startLocal: `${localDate}T10:00`,
        endLocal: `${localDate}T12:00`,
      }),
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { entry: { id: string } }).entry.id;
    const edited = await call(`/api/entries/${id}`, {
      method: 'PUT',
      headers: authenticatedHeaders(session),
      body: JSON.stringify({
        projectName: 'Client accounts',
        notes: 'Reviewed and corrected',
        startLocal: `${localDate}T10:00`,
        endLocal: `${localDate}T12:15`,
      }),
    });
    expect(edited.status).toBe(200);
    const dashboard = (await (
      await call('/api/dashboard', { headers: { Cookie: session.cookie } })
    ).json()) as { today: { totalMs: number }; week: { projectTotals: unknown[] } };
    expect(dashboard.today.totalMs).toBe(135 * 60_000);
    expect(dashboard.week.projectTotals).toEqual([
      { projectName: 'Client accounts', totalMs: 135 * 60_000 },
    ]);

    const weekStart = getWeekRange(localDate).weekStart;
    const report = await call(`/api/reports/weekly.xlsx?weekStart=${weekStart}`, {
      headers: { Cookie: session.cookie },
    });
    expect(report.status).toBe(200);
    expect(report.headers.get('content-type')).toMatch(/spreadsheetml/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await report.arrayBuffer()) as unknown as ExcelJS.Buffer);
    expect(workbook.getWorksheet('Weekly time report')?.getCell('A1').value).toBe(
      'Weekly Time Report',
    );

    const deleted = await call(`/api/entries/${id}`, {
      method: 'DELETE',
      headers: authenticatedHeaders(session, false),
    });
    expect(deleted.status).toBe(204);
    const afterDelete = (await (
      await call('/api/dashboard', { headers: { Cookie: session.cookie } })
    ).json()) as { today: { totalMs: number } };
    expect(afterDelete.today.totalMs).toBe(0);
  });
});

describe('Cloudflare report delivery', () => {
  it('keeps test and scheduled delivery idempotency separate', async () => {
    const session = await login();
    const resend = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'email_123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const testSend = await call('/api/reports/test-email', {
      method: 'POST',
      headers: authenticatedHeaders(session),
      body: JSON.stringify({}),
    });
    expect(testSend.status).toBe(200);
    expect((await testSend.json()) as { sent: boolean }).toMatchObject({ sent: true });
    const repeated = await call('/api/reports/test-email', {
      method: 'POST',
      headers: authenticatedHeaders(session),
      body: JSON.stringify({}),
    });
    expect(await repeated.json()).toMatchObject({ sent: false, reason: 'already-sent' });

    await runScheduledReport(bindings());
    expect(resend).toHaveBeenCalledTimes(2);
    const deliveries = await env.DB.prepare(
      'SELECT delivery_type, status FROM weekly_report_deliveries ORDER BY delivery_type',
    ).all<{ delivery_type: string; status: string }>();
    expect(deliveries.results).toEqual([
      { delivery_type: 'scheduled', status: 'sent' },
      { delivery_type: 'test', status: 'sent' },
    ]);
  });
});
