import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import { importCatalogCsv, syncFromFyi } from '../server/catalog-sync';
import { D1TimeStore } from '../server/d1-store';
import { createResendSender, sendWeeklyReport } from '../server/email';
import { buildWeeklyWorkbook } from '../server/report';
import {
  BRISBANE_ZONE,
  brisbaneNow,
  durationMs,
  getDayRange,
  getWeekRange,
  overlapMs,
  parseLocalDate,
  parseLocalDateTime,
  previousWeekStart,
} from '../server/time';
import type { TimeEntry, User, WorkClassificationInput } from '../server/types';
import {
  isAdminEmail,
  isAllowedEmail,
  verifyAccessIdentity,
  type IdentityVerifier,
} from './access';
import { csrfToken, validCsrf } from './csrf';
import type { Env } from './env';

type AppContext = { Bindings: Env; Variables: { actor: User } };
const clientWorkSchema = z.object({
  workType: z.literal('client'),
  clientId: z.string().uuid(),
  jobId: z.string().uuid().optional(),
  billable: z.boolean(),
  notes: z.string().trim().max(2000).default(''),
});
const internalWorkSchema = z.object({
  workType: z.literal('internal'),
  internalActivityId: z.string().uuid(),
  billable: z.literal(false).optional().default(false),
  notes: z.string().trim().max(2000).default(''),
});
const workSchema = z.discriminatedUnion('workType', [clientWorkSchema, internalWorkSchema]);
const entrySchema = z.intersection(
  workSchema,
  z.object({ startLocal: z.string().min(1), endLocal: z.string().min(1) }),
);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const idSchema = z.string().uuid();

function classification(input: z.infer<typeof workSchema>): WorkClassificationInput {
  return input.workType === 'client'
    ? {
        workType: 'client',
        clientId: input.clientId,
        ...(input.jobId ? { jobId: input.jobId } : {}),
        billable: input.billable,
      }
    : { workType: 'internal', internalActivityId: input.internalActivityId, billable: false };
}
function parseCompletedEntry(input: z.infer<typeof entrySchema>) {
  const startAt = parseLocalDateTime(input.startLocal);
  const endAt = parseLocalDateTime(input.endLocal);
  if (endAt <= startAt) throw new Error('Clock-out time must be after clock-in time.');
  return { ...classification(input), notes: input.notes, startAt, endAt };
}
async function parseJson(context: Context<AppContext>) {
  try {
    return await context.req.json();
  } catch {
    return undefined;
  }
}
function requireAdmin(context: Context<AppContext>): Response | undefined {
  if (context.get('actor').role !== 'admin')
    return context.json({ error: 'Administrator access is required.' }, 403);
}
function classificationError(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const messages: Record<string, string> = {
    INVALID_CLIENT_JOB: 'Choose a job belonging to the selected client.',
    INACTIVE_CLIENT_JOB: 'This client or job is archived and cannot be used for new time.',
    INVALID_CLIENT: 'Choose a valid client.',
    INACTIVE_CLIENT: 'This client is archived and cannot be used for new time.',
    INVALID_INTERNAL_ACTIVITY: 'Choose a valid internal activity.',
    INACTIVE_INTERNAL_ACTIVITY: 'This internal activity is inactive.',
  };
  return messages[error.message] ?? null;
}
function totals(entries: TimeEntry[], from: Date, to: Date, now = new Date()) {
  const duration = (entry: TimeEntry) => overlapMs(entry, from, to, now);
  const sum = (values: TimeEntry[]) => values.reduce((total, entry) => total + duration(entry), 0);
  const group = (key: (entry: TimeEntry) => string | null) => {
    const result = new Map<string, number>();
    for (const entry of entries) {
      const label = key(entry);
      if (label) result.set(label, (result.get(label) ?? 0) + duration(entry));
    }
    return [...result]
      .map(([name, totalMs]) => ({ name, totalMs }))
      .sort((a, b) => b.totalMs - a.totalMs);
  };
  const clientMs = sum(entries.filter((entry) => entry.workType === 'client'));
  const internalMs = sum(entries.filter((entry) => entry.workType === 'internal'));
  const billableMs = sum(entries.filter((entry) => entry.billable));
  const classifiedMs = clientMs + internalMs;
  return {
    totalMs: sum(entries),
    clientMs,
    internalMs,
    billableMs,
    nonBillableMs: sum(entries.filter((entry) => !entry.billable)),
    utilisationPercent: classifiedMs ? Math.round((billableMs / classifiedMs) * 1000) / 10 : 0,
    clientTotals: group((entry) => entry.clientName),
    jobTotals: group((entry) => entry.jobName ?? entry.activityName ?? entry.projectName),
  };
}

export function createApp(identityVerifier: IdentityVerifier = verifyAccessIdentity) {
  const app = new Hono<AppContext>();
  app.use('*', secureHeaders());
  app.use('/api/*', bodyLimit({ maxSize: 1024 * 1024 }));
  app.use('/api/*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    let identity;
    try {
      identity = await identityVerifier(context.req.raw, context.env);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'access_verification_failed',
          message: error instanceof Error ? error.message : 'unknown',
        }),
      );
      return context.json(
        { error: 'Microsoft sign-in through Cloudflare Access is required.' },
        401,
      );
    }
    if (!isAllowedEmail(identity.email, context.env.ALLOWED_EMAIL_DOMAIN))
      return context.json(
        { error: 'This Microsoft account is not permitted to use Timekeeper.' },
        403,
      );
    const actor = await new D1TimeStore(context.env.DB).upsertUser({
      accessSubject: identity.subject,
      entraObjectId: identity.entraObjectId,
      email: identity.email,
      displayName: identity.displayName,
      role: isAdminEmail(identity.email, context.env.ADMIN_EMAILS) ? 'admin' : 'employee',
    });
    context.set('actor', actor);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(context.req.method) && !validCsrf(context))
      return context.json(
        { error: 'Your request security token is invalid. Refresh and try again.' },
        403,
      );
    await next();
  });

  app.get('/api/health', async (context) => {
    await context.env.DB.prepare('SELECT 1').first();
    return context.json({
      status: 'ok',
      runtime: 'cloudflare-workers',
      database: 'd1',
      timezone: BRISBANE_ZONE,
    });
  });
  app.get('/api/session', (context) => {
    const actor = context.get('actor');
    return context.json({
      authenticated: true,
      csrfToken: csrfToken(context),
      user: { id: actor.id, email: actor.email, displayName: actor.displayName, role: actor.role },
      logoutUrl: '/cdn-cgi/access/logout',
    });
  });
  app.get('/api/users', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const users = await new D1TimeStore(context.env.DB).listUsers();
    return context.json({
      users: users.map(({ id, email, displayName, role }) => ({ id, email, displayName, role })),
    });
  });
  app.get('/api/catalog', async (context) => {
    const store = new D1TimeStore(context.env.DB);
    const search = context.req.query('search')?.slice(0, 100);
    const clientId = context.req.query('clientId');
    if (clientId && !idSchema.safeParse(clientId).success)
      return context.json({ error: 'Invalid client.' }, 400);
    const [clients, jobs, internalActivities] = await Promise.all([
      store.listClients({ activeOnly: true, search }),
      store.listJobs(clientId, true),
      store.listInternalActivities(true),
    ]);
    return context.json({ clients, jobs, internalActivities });
  });

  app.get('/api/dashboard', async (context) => {
    const current = new Date();
    const actor = context.get('actor');
    const store = new D1TimeStore(context.env.DB, () => current);
    const localToday = brisbaneNow(current).toISODate()!;
    const todayRange = getDayRange(localToday);
    const week = getWeekRange(undefined, current);
    const [active, todayEntries, weekEntries, clients, jobs, internalActivities] =
      await Promise.all([
        store.getActiveEntry(actor.id),
        store.listEntries({ ...todayRange, userId: actor.id }),
        store.listEntries({ from: week.from, to: week.to, userId: actor.id }),
        store.listClients({ activeOnly: true }),
        store.listJobs(undefined, true),
        store.listInternalActivities(true),
      ]);
    return context.json({
      active: active ? { ...active, durationMs: durationMs(active, current) } : null,
      catalog: { clients, jobs, internalActivities },
      today: {
        date: localToday,
        entries: todayEntries,
        ...totals(todayEntries, todayRange.from, todayRange.to, current),
      },
      week: {
        start: week.weekStart,
        end: week.weekEnd,
        entries: weekEntries,
        ...totals(weekEntries, week.from, week.to, current),
      },
    });
  });

  app.get('/api/entries', async (context) => {
    const current = brisbaneNow();
    const actor = context.get('actor');
    const fromText = context.req.query('from') ?? current.minus({ days: 89 }).toISODate()!;
    const toText = context.req.query('to') ?? current.toISODate()!;
    if (!dateSchema.safeParse(fromText).success || !dateSchema.safeParse(toText).success)
      return context.json({ error: 'Dates must use YYYY-MM-DD format.' }, 400);
    const from = parseLocalDate(fromText);
    const toInclusive = parseLocalDate(toText);
    if (toInclusive < from)
      return context.json({ error: 'The end date must not precede the start date.' }, 400);
    if (toInclusive.diff(from, 'days').days > 366)
      return context.json({ error: 'Choose a range of 366 days or less.' }, 400);
    const requestedUserId = context.req.query('userId');
    if (requestedUserId && !idSchema.safeParse(requestedUserId).success)
      return context.json({ error: 'Invalid employee filter.' }, 400);
    if (requestedUserId && actor.role !== 'admin')
      return context.json({ error: 'Administrator access is required.' }, 403);
    const workType = context.req.query('workType');
    if (workType && !['client', 'internal', 'legacy'].includes(workType))
      return context.json({ error: 'Invalid work type.' }, 400);
    const billableText = context.req.query('billable');
    if (billableText && !['true', 'false'].includes(billableText))
      return context.json({ error: 'Invalid billable filter.' }, 400);
    const range = {
      from: from.toUTC().toJSDate(),
      to: toInclusive.plus({ days: 1 }).toUTC().toJSDate(),
    };
    const userId =
      actor.role === 'admin' && context.req.query('scope') === 'all'
        ? requestedUserId || undefined
        : actor.id;
    const entries = await new D1TimeStore(context.env.DB).listEntries({
      ...range,
      userId,
      clientId: context.req.query('clientId'),
      jobId: context.req.query('jobId'),
      internalActivityId: context.req.query('internalActivityId'),
      workType: workType as 'client' | 'internal' | 'legacy' | undefined,
      billable: billableText ? billableText === 'true' : undefined,
    });
    return context.json({ entries, ...totals(entries, range.from, range.to) });
  });

  app.post('/api/clock-in', async (context) => {
    const parsed = workSchema.safeParse(await parseJson(context));
    if (!parsed.success)
      return context.json(
        {
          error: 'Choose a valid client and optional job, or an internal activity.',
          details: parsed.error.flatten(),
        },
        400,
      );
    try {
      const entry = await new D1TimeStore(context.env.DB).clockIn(
        context.get('actor').id,
        classification(parsed.data),
        parsed.data.notes,
        new Date(),
      );
      return context.json({ entry }, 201);
    } catch (error) {
      if (error instanceof Error && error.message === 'ACTIVE_TIMER_EXISTS')
        return context.json({ error: 'You already have a timer running.' }, 409);
      const message = classificationError(error);
      if (message) return context.json({ error: message }, 400);
      throw error;
    }
  });
  app.post('/api/clock-out', async (context) => {
    const entry = await new D1TimeStore(context.env.DB).clockOut(
      context.get('actor').id,
      new Date(),
    );
    return entry
      ? context.json({ entry })
      : context.json({ error: 'You do not have a running timer to clock out.' }, 409);
  });
  app.post('/api/entries', async (context) => {
    const parsed = entrySchema.safeParse(await parseJson(context));
    if (!parsed.success)
      return context.json(
        { error: 'Check the entry details.', details: parsed.error.flatten() },
        400,
      );
    try {
      return context.json(
        {
          entry: await new D1TimeStore(context.env.DB).createEntry(
            context.get('actor').id,
            parseCompletedEntry(parsed.data),
          ),
        },
        201,
      );
    } catch (error) {
      const message = classificationError(error) ?? (error instanceof Error ? error.message : null);
      if (message) return context.json({ error: message }, 400);
      throw error;
    }
  });
  app.put('/api/entries/:id', async (context) => {
    const entryId = idSchema.safeParse(context.req.param('id'));
    if (!entryId.success) return context.json({ error: 'Invalid entry.' }, 400);
    const parsed = entrySchema.safeParse(await parseJson(context));
    if (!parsed.success)
      return context.json(
        { error: 'Check the entry details.', details: parsed.error.flatten() },
        400,
      );
    try {
      const entry = await new D1TimeStore(context.env.DB).updateEntry(
        context.get('actor').id,
        entryId.data,
        parseCompletedEntry(parsed.data),
      );
      return entry
        ? context.json({ entry })
        : context.json({ error: 'Completed entry not found.' }, 404);
    } catch (error) {
      const message = classificationError(error) ?? (error instanceof Error ? error.message : null);
      if (message) return context.json({ error: message }, 400);
      throw error;
    }
  });
  app.delete('/api/entries/:id', async (context) => {
    const entryId = idSchema.safeParse(context.req.param('id'));
    if (!entryId.success) return context.json({ error: 'Invalid entry.' }, 400);
    const deleted = await new D1TimeStore(context.env.DB).deleteEntry(
      context.get('actor').id,
      entryId.data,
    );
    return deleted ? context.body(null, 204) : context.json({ error: 'Entry not found.' }, 404);
  });

  app.get('/api/admin/practice', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const store = new D1TimeStore(context.env.DB);
    const [clients, jobs, internalActivities, latestSync] = await Promise.all([
      store.listClients(),
      store.listJobs(),
      store.listInternalActivities(),
      store.latestSync(),
    ]);
    return context.json({
      clients,
      jobs,
      internalActivities,
      latestSync,
      fyiConfigured: Boolean(context.env.FYI_ACCESS_ID && context.env.FYI_ACCESS_SECRET),
    });
  });
  app.post('/api/admin/fyi-sync', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    if (!context.env.FYI_ACCESS_ID || !context.env.FYI_ACCESS_SECRET)
      return context.json({ error: 'FYI integration credentials are not configured.' }, 503);
    const counts = await syncFromFyi(
      new D1TimeStore(context.env.DB),
      {
        baseUrl: context.env.FYI_API_BASE_URL || 'https://api-ap-southeast-2.fyi.app/external',
        accessId: context.env.FYI_ACCESS_ID,
        accessSecret: context.env.FYI_ACCESS_SECRET,
        applicationId: context.env.FYI_APPLICATION_ID,
      },
      'manual',
    );
    return context.json({ counts });
  });
  app.post('/api/admin/catalog-import', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const csv = await context.req.text();
    if (!csv.trim()) return context.json({ error: 'Choose a non-empty CSV file.' }, 400);
    try {
      return context.json({ counts: await importCatalogCsv(new D1TimeStore(context.env.DB), csv) });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (
        message.startsWith('CSV ') ||
        message.startsWith('Duplicate or missing ') ||
        message.startsWith('Job ')
      )
        return context.json({ error: message }, 400);
      throw error;
    }
  });
  app.post('/api/admin/internal-activities', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const parsed = z
      .object({
        id: idSchema.optional(),
        name: z.string().trim().min(1).max(120),
        active: z.boolean(),
      })
      .safeParse(await parseJson(context));
    if (!parsed.success) return context.json({ error: 'Check the internal activity.' }, 400);
    return context.json({
      activity: await new D1TimeStore(context.env.DB).saveInternalActivity(parsed.data),
    });
  });
  app.put('/api/admin/jobs/:id/billable-default', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const id = idSchema.safeParse(context.req.param('id'));
    const body = z.object({ billable: z.boolean() }).safeParse(await parseJson(context));
    if (!id.success || !body.success) return context.json({ error: 'Invalid job setting.' }, 400);
    const job = await new D1TimeStore(context.env.DB).setJobBillableDefault(
      id.data,
      body.data.billable,
    );
    return job ? context.json({ job }) : context.json({ error: 'Job not found.' }, 404);
  });
  app.get('/api/admin/exceptions', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const now = new Date();
    const range = {
      from: new Date(now.getTime() - 90 * 86_400_000),
      to: new Date(now.getTime() + 1),
    };
    const entries = await new D1TimeStore(context.env.DB).listEntries(range);
    const runningThreshold = Number(context.env.RUNNING_TIMER_ALERT_HOURS || '12') * 3_600_000;
    const longThreshold = Number(context.env.LONG_ENTRY_ALERT_HOURS || '16') * 3_600_000;
    const exceptions = entries.flatMap((entry) => {
      const elapsed =
        (entry.endAt ? Date.parse(entry.endAt) : now.getTime()) - Date.parse(entry.startAt);
      const reasons = [
        !entry.endAt && elapsed > runningThreshold ? 'Running timer over threshold' : null,
        entry.endAt && elapsed > longThreshold ? 'Unusually long entry' : null,
        entry.legacy ? 'Legacy classification' : null,
        entry.workType !== 'legacy' && !entry.activityName && !entry.jobName
          ? 'Missing classification'
          : null,
      ].filter(Boolean);
      return reasons.length ? [{ entry, reasons }] : [];
    });
    return context.json({ exceptions });
  });

  app.get('/api/reports/weekly.xlsx', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const requested = context.req.query('weekStart');
    if (requested && !dateSchema.safeParse(requested).success)
      return context.json({ error: 'Invalid week date.' }, 400);
    const range = getWeekRange(requested);
    const report = await buildWeeklyWorkbook(new D1TimeStore(context.env.DB), range.weekStart);
    return new Response(Uint8Array.from(report.buffer).buffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${report.filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  });
  app.post('/api/reports/test-email', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const parsed = z
      .object({ weekStart: dateSchema.optional() })
      .safeParse((await parseJson(context)) ?? {});
    if (!parsed.success) return context.json({ error: 'Invalid week date.' }, 400);
    if (!context.env.REPORT_TEST_RECIPIENT)
      return context.json({ error: 'REPORT_TEST_RECIPIENT is not configured.' }, 503);
    const result = await sendWeeklyReport({
      store: new D1TimeStore(context.env.DB),
      mailer: createResendSender(context.env.RESEND_API_KEY),
      from: context.env.EMAIL_FROM,
      recipient: context.env.REPORT_TEST_RECIPIENT,
      weekStart: getWeekRange(parsed.data.weekStart ?? previousWeekStart()).weekStart,
      type: 'test',
    });
    return context.json(result);
  });
  app.all('/api/*', (context) => context.json({ error: 'API route not found.' }, 404));
  app.all('*', (context) => context.env.ASSETS.fetch(context.req.raw));
  app.onError((error, context) => {
    console.error(
      JSON.stringify({
        event: 'worker_error',
        message: error instanceof Error ? error.message : 'unknown',
      }),
    );
    return context.json({ error: 'Something went wrong. Please try again.' }, 500);
  });
  return app;
}

const app = createApp();
export async function runScheduledReport(env: Env, scheduledTime = Date.now()) {
  const now = new Date(scheduledTime);
  return sendWeeklyReport({
    store: new D1TimeStore(env.DB, () => now),
    mailer: createResendSender(env.RESEND_API_KEY),
    from: env.EMAIL_FROM,
    recipient: env.WEEKLY_REPORT_RECIPIENT,
    weekStart: previousWeekStart(now),
    type: 'scheduled',
    now,
  });
}
export async function runScheduledFyiSync(env: Env) {
  if (!env.FYI_ACCESS_ID || !env.FYI_ACCESS_SECRET) {
    console.warn(JSON.stringify({ event: 'fyi_sync_skipped', reason: 'not_configured' }));
    return null;
  }
  return syncFromFyi(
    new D1TimeStore(env.DB),
    {
      baseUrl: env.FYI_API_BASE_URL || 'https://api-ap-southeast-2.fyi.app/external',
      accessId: env.FYI_ACCESS_ID,
      accessSecret: env.FYI_ACCESS_SECRET,
      applicationId: env.FYI_APPLICATION_ID,
    },
    'scheduled',
  );
}
export default {
  fetch: app.fetch,
  scheduled(controller, env, context) {
    if (controller.cron === '5 14 * * SUN')
      context.waitUntil(runScheduledReport(env, controller.scheduledTime));
    else context.waitUntil(runScheduledFyiSync(env));
  },
} satisfies ExportedHandler<Env>;
