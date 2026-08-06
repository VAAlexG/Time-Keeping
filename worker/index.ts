import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import { verifyPassword } from '../server/auth';
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
import type { Env } from './env';
import {
  clearLoginFailures,
  createSession,
  destroySession,
  isLoginBlocked,
  readSession,
  recordLoginFailure,
  removeExpiredSecurityRecords,
  requestIdentifier,
  type SessionRecord,
} from './session';

type AppContext = {
  Bindings: Env;
  Variables: { session: SessionRecord };
};

const passwordSchema = z.object({ password: z.string().min(1).max(256) });
const workSchema = z.object({
  projectName: z.string().trim().min(1, 'Choose or enter a project').max(120),
  notes: z.string().trim().max(2000).default(''),
});
const entrySchema = workSchema.extend({
  startLocal: z.string().min(1),
  endLocal: z.string().min(1),
});
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const idSchema = z.string().uuid();

function parseCompletedEntry(input: z.infer<typeof entrySchema>) {
  const startAt = parseLocalDateTime(input.startLocal);
  const endAt = parseLocalDateTime(input.endLocal);
  if (endAt <= startAt) throw new Error('Clock-out time must be after clock-in time.');
  return { projectName: input.projectName, notes: input.notes, startAt, endAt };
}

async function parseJson(context: Context<AppContext>) {
  try {
    return await context.req.json();
  } catch {
    return undefined;
  }
}

const app = new Hono<AppContext>();
app.use('*', secureHeaders());
app.use('/api/*', bodyLimit({ maxSize: 24 * 1024 }));
app.use('/api/*', async (context, next) => {
  context.header('Cache-Control', 'no-store');
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

app.get('/api/session', async (context) => {
  const session = await readSession(context, { rolling: true });
  return context.json(
    session ? { authenticated: true, csrfToken: session.csrfToken } : { authenticated: false },
  );
});

app.post('/api/login', async (context) => {
  const identifier = requestIdentifier(context);
  if (await isLoginBlocked(context.env.DB, identifier)) {
    return context.json(
      { error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' },
      429,
    );
  }
  const parsed = passwordSchema.safeParse(await parseJson(context));
  if (!parsed.success) return context.json({ error: 'A password is required.' }, 400);
  if (!context.env.APP_PASSWORD_HASH)
    return context.json({ error: 'Authentication is not configured.' }, 503);
  if (!(await verifyPassword(parsed.data.password, context.env.APP_PASSWORD_HASH))) {
    await recordLoginFailure(context.env.DB, identifier);
    return context.json({ error: 'The password is incorrect.' }, 401);
  }
  await clearLoginFailures(context.env.DB, identifier);
  const existing = await readSession(context);
  if (existing) await destroySession(context, existing);
  const session = await createSession(context);
  return context.json({ authenticated: true, csrfToken: session.csrfToken });
});

const protectedApi = new Hono<AppContext>();
protectedApi.use('*', async (context, next) => {
  const session = await readSession(context, { rolling: true });
  if (!session) return context.json({ error: 'Sign in is required.' }, 401);
  context.set('session', session);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(context.req.method)) {
    if (context.req.header('x-csrf-token') !== session.csrfToken) {
      return context.json(
        { error: 'Your session security token is invalid. Refresh and try again.' },
        403,
      );
    }
  }
  await next();
});

protectedApi.post('/logout', async (context) => {
  await destroySession(context, context.get('session'));
  return context.body(null, 204);
});

protectedApi.get('/projects', async (context) => {
  return context.json({ projects: await new D1TimeStore(context.env.DB).listProjects() });
});

protectedApi.get('/dashboard', async (context) => {
  const current = new Date();
  const store = new D1TimeStore(context.env.DB, () => current);
  const localToday = brisbaneNow(current).toISODate()!;
  const todayRange = getDayRange(localToday);
  const week = getWeekRange(undefined, current);
  const [active, todayEntries, weekEntries, projects] = await Promise.all([
    store.getActiveEntry(),
    store.listEntries(todayRange),
    store.listEntries({ from: week.from, to: week.to }),
    store.listProjects(),
  ]);
  const projectTotals = [...new Set(weekEntries.map((entry) => entry.projectName))].map(
    (projectName) => ({
      projectName,
      totalMs: weekEntries
        .filter((entry) => entry.projectName === projectName)
        .reduce((sum, entry) => sum + overlapMs(entry, week.from, week.to, current), 0),
    }),
  );
  return context.json({
    active: active ? { ...active, durationMs: durationMs(active, current) } : null,
    projects,
    today: {
      date: localToday,
      entries: todayEntries,
      totalMs: todayEntries.reduce(
        (sum, entry) => sum + overlapMs(entry, todayRange.from, todayRange.to, current),
        0,
      ),
    },
    week: {
      start: week.weekStart,
      end: week.weekEnd,
      entries: weekEntries,
      totalMs: weekEntries.reduce(
        (sum, entry) => sum + overlapMs(entry, week.from, week.to, current),
        0,
      ),
      projectTotals,
    },
  });
});

protectedApi.get('/entries', async (context) => {
  const current = brisbaneNow();
  const fromText = context.req.query('from') ?? current.minus({ days: 89 }).toISODate()!;
  const toText = context.req.query('to') ?? current.toISODate()!;
  if (!dateSchema.safeParse(fromText).success || !dateSchema.safeParse(toText).success) {
    return context.json({ error: 'Dates must use YYYY-MM-DD format.' }, 400);
  }
  const from = parseLocalDate(fromText);
  const toInclusive = parseLocalDate(toText);
  if (toInclusive < from)
    return context.json({ error: 'The end date must not precede the start date.' }, 400);
  if (toInclusive.diff(from, 'days').days > 366) {
    return context.json({ error: 'Choose a range of 366 days or less.' }, 400);
  }
  const projectId = context.req.query('projectId');
  if (projectId && !idSchema.safeParse(projectId).success) {
    return context.json({ error: 'Invalid project filter.' }, 400);
  }
  const range = {
    from: from.toUTC().toJSDate(),
    to: toInclusive.plus({ days: 1 }).toUTC().toJSDate(),
  };
  const store = new D1TimeStore(context.env.DB);
  const entries = await store.listEntries({ ...range, projectId });
  const projectTotals = [...new Set(entries.map((entry) => entry.projectName))].map(
    (projectName) => ({
      projectName,
      totalMs: entries
        .filter((entry) => entry.projectName === projectName)
        .reduce((sum, entry) => sum + overlapMs(entry, range.from, range.to), 0),
    }),
  );
  return context.json({
    entries,
    totalMs: entries.reduce((sum, entry) => sum + overlapMs(entry, range.from, range.to), 0),
    projectTotals,
  });
});

protectedApi.post('/clock-in', async (context) => {
  const parsed = workSchema.safeParse(await parseJson(context));
  if (!parsed.success)
    return context.json(
      { error: 'Check the project and notes.', details: parsed.error.flatten() },
      400,
    );
  try {
    const entry = await new D1TimeStore(context.env.DB).clockIn(
      parsed.data.projectName,
      parsed.data.notes,
      new Date(),
    );
    return context.json({ entry }, 201);
  } catch (error) {
    if (error instanceof Error && error.message === 'ACTIVE_TIMER_EXISTS') {
      return context.json(
        { error: 'A timer is already running. Clock it out before starting another.' },
        409,
      );
    }
    throw error;
  }
});

protectedApi.post('/clock-out', async (context) => {
  const entry = await new D1TimeStore(context.env.DB).clockOut(new Date());
  return entry
    ? context.json({ entry })
    : context.json({ error: 'There is no running timer to clock out.' }, 409);
});

protectedApi.post('/entries', async (context) => {
  const parsed = entrySchema.safeParse(await parseJson(context));
  if (!parsed.success)
    return context.json(
      { error: 'Check the entry details.', details: parsed.error.flatten() },
      400,
    );
  try {
    const entry = await new D1TimeStore(context.env.DB).createEntry(
      parseCompletedEntry(parsed.data),
    );
    return context.json({ entry }, 201);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Clock-out')) {
      return context.json({ error: error.message }, 400);
    }
    throw error;
  }
});

protectedApi.put('/entries/:id', async (context) => {
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
      entryId.data,
      parseCompletedEntry(parsed.data),
    );
    return entry
      ? context.json({ entry })
      : context.json({ error: 'Completed entry not found.' }, 404);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Clock-out')) {
      return context.json({ error: error.message }, 400);
    }
    throw error;
  }
});

protectedApi.delete('/entries/:id', async (context) => {
  const entryId = idSchema.safeParse(context.req.param('id'));
  if (!entryId.success) return context.json({ error: 'Invalid entry.' }, 400);
  const deleted = await new D1TimeStore(context.env.DB).deleteEntry(entryId.data);
  return deleted ? context.body(null, 204) : context.json({ error: 'Entry not found.' }, 404);
});

protectedApi.get('/reports/weekly.xlsx', async (context) => {
  const requested = context.req.query('weekStart');
  if (requested && !dateSchema.safeParse(requested).success) {
    return context.json({ error: 'Invalid week date.' }, 400);
  }
  const range = getWeekRange(requested);
  const report = await buildWeeklyWorkbook(new D1TimeStore(context.env.DB), range.weekStart);
  const workbookBody = Uint8Array.from(report.buffer).buffer;
  return new Response(workbookBody, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${report.filename}"`,
      'Cache-Control': 'no-store',
    },
  });
});

protectedApi.post('/reports/test-email', async (context) => {
  const body = (await parseJson(context)) as { weekStart?: unknown } | undefined;
  const parsed = z.object({ weekStart: dateSchema.optional() }).safeParse(body ?? {});
  if (!parsed.success) return context.json({ error: 'Invalid week date.' }, 400);
  if (!context.env.REPORT_TEST_RECIPIENT) {
    return context.json({ error: 'REPORT_TEST_RECIPIENT is not configured.' }, 503);
  }
  const weekStart = getWeekRange(parsed.data.weekStart ?? previousWeekStart()).weekStart;
  const result = await sendWeeklyReport({
    store: new D1TimeStore(context.env.DB),
    mailer: createResendSender(context.env.RESEND_API_KEY),
    from: context.env.EMAIL_FROM,
    recipient: context.env.REPORT_TEST_RECIPIENT,
    weekStart,
    type: 'test',
  });
  return context.json(result);
});

app.route('/api', protectedApi);
app.all('/api/*', (context) => context.json({ error: 'API route not found.' }, 404));
app.all('*', (context) => context.env.ASSETS.fetch(context.req.raw));

app.onError((error, context) => {
  console.error(error instanceof Error ? error.message : 'Unknown Worker error');
  return context.json({ error: 'Something went wrong. Please try again.' }, 500);
});

export async function runScheduledReport(env: Env, scheduledTime = Date.now()) {
  await removeExpiredSecurityRecords(env.DB, scheduledTime);
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

export default {
  fetch: app.fetch,
  scheduled(controller, env, context) {
    context.waitUntil(runScheduledReport(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
