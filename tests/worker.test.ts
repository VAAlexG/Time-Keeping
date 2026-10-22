import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { brisbaneNow, getWeekRange } from '../server/time';
import worker, { createApp, runScheduledFinalization, runScheduledReport } from '../worker';
import type { AccessIdentity } from '../worker/access';
import type { Env } from '../worker/env';

const ALEX = 'alexg@versatileaccounting.com.au';
const BRENDON = 'brendong@versatileaccounting.com.au';
const EMPLOYEE = 'employee@versatileaccounting.com.au';
const SUZIE = 'suzieg@versatileaccounting.com.au';
const CLIENT_ID = '10000000-0000-4000-8000-000000000001';
const JOB_ID = '20000000-0000-4000-8000-000000000001';
const CLIENT_WORK = {
  workType: 'client',
  clientId: CLIENT_ID,
  jobId: JOB_ID,
  billable: true,
} as const;

const app = createApp(async (request): Promise<AccessIdentity> => {
  const email = request.headers.get('x-test-email');
  if (!email) throw new Error('missing test identity');
  return {
    subject: `subject:${email}`,
    entraObjectId: `oid:${email}`,
    email,
    displayName: email.split('@')[0],
  };
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM schedule_occurrences').run();
  await env.DB.prepare('DELETE FROM schedule_templates').run();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM weekly_report_deliveries'),
    env.DB.prepare('DELETE FROM finalized_weekly_reports'),
    env.DB.prepare('DELETE FROM priority_items'),
    env.DB.prepare('DELETE FROM time_entries'),
    env.DB.prepare('DELETE FROM jobs'),
    env.DB.prepare('DELETE FROM clients'),
    env.DB.prepare('DELETE FROM sync_runs'),
    env.DB.prepare('DELETE FROM users'),
    env.DB.prepare('DELETE FROM projects'),
  ]);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO clients (id, external_id, source, name, active, created_at, updated_at, synced_at)
      VALUES (?, 'fyi-client-1', 'fyi', 'Northbridge Joinery', 1, ?, ?, ?)`,
    ).bind(CLIENT_ID, now, now, now),
    env.DB.prepare(
      `INSERT INTO jobs (id, external_id, client_id, source, name, active, default_billable, created_at, updated_at, synced_at)
      VALUES (?, 'fyi-job-1', ?, 'fyi', 'Annual accounts', 1, 1, ?, ?, ?)`,
    ).bind(JOB_ID, CLIENT_ID, now, now, now),
  ]);
  vi.restoreAllMocks();
});

function bindings(): Env {
  return {
    DB: env.DB,
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
    ACCESS_AUD: 'test-audience',
    ALLOWED_EMAIL_DOMAIN: 'versatileaccounting.com.au',
    ADMIN_EMAILS: `${ALEX},${BRENDON}`,
    REPORT_VIEWER_EMAILS: `${SUZIE},${ALEX}`,
    RESEND_API_KEY: 're_test_key',
    EMAIL_FROM: 'Timekeeper <reports@example.com>',
    WEEKLY_REPORT_RECIPIENT: 'weekly@example.com',
    REPORT_TEST_RECIPIENT: 'test@example.com',
    XERO_CLIENT_ID: 'test-xero-client',
    XERO_CLIENT_SECRET: 'test-xero-secret',
  };
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request(`https://timekeeper.example${path}`, init),
    bindings(),
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function signIn(email: string) {
  const response = await call('/api/session', { headers: { 'X-Test-Email': email } });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    csrfToken: string;
    user: { id: string; email: string; role: string };
  };
  return {
    email,
    user: body.user,
    csrf: body.csrfToken,
    cookie: response.headers.get('set-cookie')!.split(';')[0],
  };
}

function headers(session: Awaited<ReturnType<typeof signIn>>, json = true) {
  return {
    'X-Test-Email': session.email,
    Cookie: session.cookie,
    'X-CSRF-Token': session.csrf,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

describe('Cloudflare Access authentication and authorization', () => {
  it('protects API routes, provisions users, and enforces the company domain', async () => {
    expect((await call('/api/dashboard')).status).toBe(401);
    expect(
      (
        await call('/api/session', {
          headers: { 'X-Test-Email': 'person@outside.example' },
        })
      ).status,
    ).toBe(403);

    const employee = await signIn(EMPLOYEE);
    expect(employee.user).toMatchObject({ email: EMPLOYEE, role: 'employee' });
    expect((await call('/api/dashboard', { headers: headers(employee, false) })).status).toBe(200);
    expect((await call('/api/users', { headers: headers(employee, false) })).status).toBe(403);

    const admin = await signIn(ALEX);
    expect(admin.user.role).toBe('admin');
    const users = await call('/api/users', { headers: headers(admin, false) });
    expect(((await users.json()) as { users: unknown[] }).users).toHaveLength(2);
  });

  it('requires a same-origin CSRF token for mutations', async () => {
    await signIn(EMPLOYEE);
    const response = await call('/api/clock-in', {
      method: 'POST',
      headers: { 'X-Test-Email': EMPLOYEE, 'Content-Type': 'application/json' },
      body: JSON.stringify(CLIENT_WORK),
    });
    expect(response.status).toBe(403);
  });
});

describe('employee timekeeping isolation', () => {
  it('records internal work as non-billable and rejects mismatched client jobs', async () => {
    const employee = await signIn(EMPLOYEE);
    const date = brisbaneNow().toISODate()!;
    const internal = await call('/api/entries', {
      method: 'POST',
      headers: headers(employee),
      body: JSON.stringify({
        workType: 'internal',
        internalActivityId: '00000000-0000-4000-8000-000000000002',
        billable: false,
        notes: 'Training session',
        startLocal: `${date}T09:00`,
        endLocal: `${date}T10:00`,
      }),
    });
    expect(internal.status).toBe(201);
    expect((await internal.json()) as { entry: unknown }).toMatchObject({
      entry: { workType: 'internal', activityName: 'Training', billable: false },
    });
    const invalid = await call('/api/entries', {
      method: 'POST',
      headers: headers(employee),
      body: JSON.stringify({
        ...CLIENT_WORK,
        clientId: '30000000-0000-4000-8000-000000000001',
        notes: '',
        startLocal: `${date}T10:00`,
        endLocal: `${date}T11:00`,
      }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: 'Choose a job belonging to the selected client.',
    });
  });

  it('allows client time to be recorded before an upstream job is available', async () => {
    const employee = await signIn(EMPLOYEE);
    const response = await call('/api/clock-in', {
      method: 'POST',
      headers: headers(employee),
      body: JSON.stringify({
        workType: 'client',
        clientId: CLIENT_ID,
        billable: true,
        notes: 'Job to be assigned later',
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      entry: {
        workType: 'client',
        clientName: 'Northbridge Joinery',
        jobId: null,
        jobName: null,
        billable: true,
      },
    });
  });

  it('enforces one active timer per employee while allowing different employees to run timers', async () => {
    const alex = await signIn(ALEX);
    const employee = await signIn(EMPLOYEE);
    for (const session of [alex, employee]) {
      const started = await call('/api/clock-in', {
        method: 'POST',
        headers: headers(session),
        body: JSON.stringify({ ...CLIENT_WORK, notes: 'Access migration' }),
      });
      expect(started.status).toBe(201);
    }
    const duplicate = await call('/api/clock-in', {
      method: 'POST',
      headers: headers(alex),
      body: JSON.stringify(CLIENT_WORK),
    });
    expect(duplicate.status).toBe(409);
    await env.DB.prepare('UPDATE time_entries SET start_at = start_at - 3600000').run();
    expect(
      (
        await call('/api/clock-out', {
          method: 'POST',
          headers: headers(alex, false),
        })
      ).status,
    ).toBe(200);
    const employeeDashboard = (await (
      await call('/api/dashboard', { headers: headers(employee, false) })
    ).json()) as { active: { userId: string } | null };
    expect(employeeDashboard.active?.userId).toBe(employee.user.id);
  });

  it('allows employees to add, edit, and delete only their own entries', async () => {
    const alex = await signIn(ALEX);
    const employee = await signIn(EMPLOYEE);
    const date = brisbaneNow().toISODate()!;
    const created = await call('/api/entries', {
      method: 'POST',
      headers: headers(employee),
      body: JSON.stringify({
        ...CLIENT_WORK,
        notes: 'Initial entry',
        startLocal: `${date}T10:00`,
        endLocal: `${date}T12:00`,
      }),
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { entry: { id: string } }).entry.id;
    const blocked = await call(`/api/entries/${id}`, {
      method: 'DELETE',
      headers: headers(alex, false),
    });
    expect(blocked.status).toBe(404);
    const edited = await call(`/api/entries/${id}`, {
      method: 'PUT',
      headers: headers(employee),
      body: JSON.stringify({
        ...CLIENT_WORK,
        notes: 'Reviewed and corrected',
        startLocal: `${date}T10:00`,
        endLocal: `${date}T12:15`,
      }),
    });
    expect(edited.status).toBe(200);
    const dashboard = (await (
      await call('/api/dashboard', { headers: headers(employee, false) })
    ).json()) as { today: { totalMs: number } };
    expect(dashboard.today.totalMs).toBe(135 * 60_000);
    expect(
      (
        await call(`/api/entries/${id}`, {
          method: 'DELETE',
          headers: headers(employee, false),
        })
      ).status,
    ).toBe(204);
  });
});

describe('shared team priorities', () => {
  it('allows the team to add, reprioritise, complete, reassign, and remove items', async () => {
    const alex = await signIn(ALEX);
    const employee = await signIn(EMPLOYEE);
    const created = await call('/api/priorities', {
      method: 'POST',
      headers: headers(alex),
      body: JSON.stringify({
        title: 'Finalise the client onboarding checklist',
        description: 'Confirm every onboarding document has been received and reviewed.',
        assignee: 'brendon',
        priority: 9,
      }),
    });
    expect(created.status).toBe(201);
    const item = (await created.json()) as {
      item: { id: string; completed: boolean; createdByName: string };
    };
    expect(item.item).toMatchObject({ completed: false, createdByName: 'alexg' });

    const listed = await call('/api/priorities', { headers: headers(employee, false) });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      items: [
        {
          id: item.item.id,
          description: 'Confirm every onboarding document has been received and reviewed.',
          assignee: 'brendon',
          priority: 9,
        },
      ],
    });

    const updated = await call(`/api/priorities/${item.item.id}`, {
      method: 'PUT',
      headers: headers(employee),
      body: JSON.stringify({
        title: 'Finalise the client onboarding checklist',
        description: 'Send the completed checklist to the client manager.',
        assignee: 'suzie',
        priority: 10,
        completed: true,
      }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      item: {
        description: 'Send the completed checklist to the client manager.',
        assignee: 'suzie',
        priority: 10,
        completed: true,
      },
    });

    const removed = await call(`/api/priorities/${item.item.id}`, {
      method: 'DELETE',
      headers: headers(alex, false),
    });
    expect(removed.status).toBe(204);
    expect(await (await call('/api/priorities', { headers: headers(alex, false) })).json()).toEqual(
      {
        items: [],
      },
    );
  });

  it('validates assignees and priority range', async () => {
    const alex = await signIn(ALEX);
    const response = await call('/api/priorities', {
      method: 'POST',
      headers: headers(alex),
      body: JSON.stringify({ title: 'Invalid item', assignee: 'someone-else', priority: 11 }),
    });
    expect(response.status).toBe(400);
  });
});

describe('recurring schedule', () => {
  it('restricts access and preserves independently completed occurrences', async () => {
    const suzie = await signIn(SUZIE);
    const employee = await signIn(EMPLOYEE);
    expect(
      (await call(`/api/schedule?weekStart=2026-08-17`, { headers: headers(employee, false) }))
        .status,
    ).toBe(403);
    const created = await call('/api/schedule/templates', {
      method: 'POST',
      headers: headers(suzie),
      body: JSON.stringify({
        title: 'WAM Meats',
        description: 'Complete Monday processing',
        assignee: 'suzie',
        recurrenceType: 'weekly',
        weekdays: [1],
        startDate: '2026-08-17',
        monthlyDay: null,
        yearlyMonth: null,
        yearlyDay: null,
        dueTime: '15:00',
      }),
    });
    expect(created.status).toBe(201);
    const listed = await call('/api/schedule?weekStart=2026-08-17', {
      headers: headers(suzie, false),
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      occurrences: Array<{ id: string; title: string; completed: boolean }>;
    };
    expect(body.occurrences.some((item) => item.title === 'WAM Meats')).toBe(true);
    const occurrence = body.occurrences.find((item) => item.title === 'WAM Meats')!;
    const completed = await call(`/api/schedule/occurrences/${occurrence.id}`, {
      method: 'PUT',
      headers: headers(suzie),
      body: JSON.stringify({ completed: true }),
    });
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      occurrence: { completed: true, completedByName: 'suzieg' },
    });
  });
});

describe('administrator reporting and delivery', () => {
  it('binds manual-close confirmation to the exact reviewed preview', async () => {
    const admin = await signIn(ALEX);
    const previewResponse = await call('/api/close/preview', {
      method: 'POST',
      headers: headers(admin),
      body: '{}',
    });
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json()) as {
      cutoff: string;
      previewHash: string;
      confirmationPhrase: string;
      activationBaseline: { entryCount: number; runningTimersToSplit: number } | null;
    };
    expect(preview.previewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.confirmationPhrase).toContain(preview.cutoff);
    if (preview.activationBaseline) {
      expect(preview.activationBaseline.entryCount).toBeGreaterThanOrEqual(0);
      expect(preview.activationBaseline.runningTimersToSplit).toBeGreaterThanOrEqual(0);
    }

    const cutoff = Date.parse(preview.cutoff);
    const created = await call('/api/entries', {
      method: 'POST',
      headers: headers(admin),
      body: JSON.stringify({
        ...CLIENT_WORK,
        notes: 'Added after the reviewed close preview',
        startLocal: new Date(cutoff - 20 * 60_000).toISOString(),
        endLocal: new Date(cutoff - 10 * 60_000).toISOString(),
      }),
    });
    expect(created.status).toBe(201);

    const staleClose = await call('/api/close', {
      method: 'POST',
      headers: headers(admin),
      body: JSON.stringify({
        cutoff: preview.cutoff,
        previewHash: preview.previewHash,
        confirmation: preview.confirmationPhrase,
        reason: 'Authorised route-level stale-preview test',
      }),
    });
    expect(staleClose.status).toBe(409);
    expect(await staleClose.json()).toMatchObject({
      error: 'The close preview changed or the confirmation did not match. Preview it again.',
    });
  });

  it('generates client PDFs for report viewers and validates access and inputs', async () => {
    const employee = await signIn(EMPLOYEE);
    const suzie = await signIn(SUZIE);
    const date = '2026-08-20';
    const created = await call('/api/entries', {
      method: 'POST',
      headers: headers(employee),
      body: JSON.stringify({
        ...CLIENT_WORK,
        notes: 'Reconciled supplier invoices and prepared the payment batch.',
        startLocal: `${date}T09:00`,
        endLocal: `${date}T11:15`,
      }),
    });
    expect(created.status).toBe(201);
    const path = `/api/reports/client.pdf?clientId=${CLIENT_ID}&from=${date}&to=${date}`;
    expect((await call(path, { headers: headers(employee, false) })).status).toBe(403);
    const response = await call(path, { headers: headers(suzie, false) });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toContain(
      'client-time-northbridge-joinery-2026-08-20-to-2026-08-20.pdf',
    );
    const document = await PDFDocument.load(await response.arrayBuffer());
    expect(document.getTitle()).toBe('Detailed time - Northbridge Joinery');

    const reversed = await call(
      `/api/reports/client.pdf?clientId=${CLIENT_ID}&from=2026-08-21&to=2026-08-20`,
      { headers: headers(suzie, false) },
    );
    expect(reversed.status).toBe(400);
    const empty = await call(
      `/api/reports/client.pdf?clientId=${CLIENT_ID}&from=2026-08-01&to=2026-08-01`,
      { headers: headers(suzie, false) },
    );
    expect(empty.status).toBe(422);
  });

  it('consolidates every employee, grants Suzie report-only access, and blocks other employees', async () => {
    const admin = await signIn(ALEX);
    const employee = await signIn(EMPLOYEE);
    const brendon = await signIn(BRENDON);
    const suzie = await signIn(SUZIE);
    const date = brisbaneNow().toISODate()!;
    for (const session of [employee, brendon]) {
      expect(
        (
          await call('/api/entries', {
            method: 'POST',
            headers: headers(session),
            body: JSON.stringify({
              ...CLIENT_WORK,
              notes: session.email,
              startLocal: `${date}T10:00`,
              endLocal: `${date}T11:00`,
            }),
          })
        ).status,
      ).toBe(201);
    }
    const weekStart = getWeekRange(date).weekStart;
    expect(
      (
        await call(`/api/reports/weekly.xlsx?weekStart=${weekStart}`, {
          headers: headers(employee, false),
        })
      ).status,
    ).toBe(403);
    const response = await call(`/api/reports/weekly.xlsx?weekStart=${weekStart}`, {
      headers: headers(suzie, false),
    });
    expect(response.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      Buffer.from(await response.arrayBuffer()) as unknown as ExcelJS.Buffer,
    );
    const sheet = workbook.getWorksheet('Weekly time report')!;
    const employeeValues = sheet.getColumn(2).values.map(String);
    expect(employeeValues).toContain('employee (employee@versatileaccounting.com.au)');
    expect(employeeValues).toContain('brendong (brendong@versatileaccounting.com.au)');
    expect(workbook.getWorksheet('Team priorities')).toBeDefined();
    expect(
      (
        await call('/api/reports/test-email', {
          method: 'POST',
          headers: headers(suzie),
          body: JSON.stringify({ weekStart }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(`/api/reports/weekly.xlsx?weekStart=${weekStart}`, {
          headers: headers(admin, false),
        })
      ).status,
    ).toBe(200);
  });

  it('keeps test and scheduled delivery idempotency separate', async () => {
    const admin = await signIn(ALEX);
    const resend = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'email_123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const testSend = await call('/api/reports/test-email', {
      method: 'POST',
      headers: headers(admin),
      body: JSON.stringify({}),
    });
    expect(testSend.status).toBe(200);
    const repeated = await call('/api/reports/test-email', {
      method: 'POST',
      headers: headers(admin),
      body: JSON.stringify({}),
    });
    expect(await repeated.json()).toMatchObject({ sent: false, reason: 'already-sent' });

    await runScheduledReport(bindings());
    expect(resend).toHaveBeenCalledTimes(2);
  });

  it('routes the restored Sunday cron to the completed Monday-Sunday report', async () => {
    const resend = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'weekly_email_123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const context = createExecutionContext();
    worker.scheduled(
      createScheduledController({
        cron: '5 14 * * SUN',
        scheduledTime: new Date('2026-08-23T14:05:00.000Z'),
      }),
      bindings(),
      context,
    );
    await waitOnExecutionContext(context);

    expect(resend).toHaveBeenCalledTimes(1);
    const message = JSON.parse(String(resend.mock.calls[0][1]?.body)) as {
      subject: string;
      to: string[];
    };
    expect(message.subject).toBe('Time report: 2026-08-17 to 2026-08-23');
    expect(message.to).toEqual([ALEX, BRENDON, SUZIE]);
  });

  it('finalizes one immutable weekly report and exposes it to report viewers', async () => {
    const suzie = await signIn(SUZIE);
    const resend = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'final_email_123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const fridayFinalization = Date.parse('2026-08-28T10:30:00.000Z');
    const first = await runScheduledFinalization(bindings(), fridayFinalization);
    const repeated = await runScheduledFinalization(bindings(), fridayFinalization);
    expect(first).toMatchObject({ finalized: true, emailed: true, weekStart: '2026-08-24' });
    expect(repeated).toMatchObject({ finalized: false, emailed: false, weekStart: '2026-08-24' });
    expect(resend).toHaveBeenCalledTimes(1);
    const emailBody = JSON.parse(String(resend.mock.calls[0][1]?.body)) as { to: string[] };
    expect(emailBody.to).toEqual([ALEX, BRENDON, SUZIE]);

    const list = await call('/api/reports/finalized', { headers: headers(suzie, false) });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      reports: [{ weekStart: '2026-08-24', emailStatus: 'sent' }],
    });
    const download = await call('/api/reports/finalized/2026-08-24', {
      headers: headers(suzie, false),
    });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('time-report-2026-08-24');
    expect(download.headers.get('cache-control')).toBe('no-store');
    expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(5000);
  });
});
