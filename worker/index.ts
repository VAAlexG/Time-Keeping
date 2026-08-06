import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
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
import type { User } from '../server/types';
import {
  isAdminEmail,
  isAllowedEmail,
  verifyAccessIdentity,
  type IdentityVerifier,
} from './access';
import { csrfToken, validCsrf } from './csrf';
import type { Env } from './env';

type AppContext = {
  Bindings: Env;
  Variables: { actor: User };
};

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

function projectTotals(
  entries: Awaited<ReturnType<D1TimeStore['listEntries']>>,
  from: Date,
  to: Date,
  now = new Date(),
) {
  return [...new Set(entries.map((entry) => entry.projectName))].map((projectName) => ({
    projectName,
    totalMs: entries
      .filter((entry) => entry.projectName === projectName)
      .reduce((sum, entry) => sum + overlapMs(entry, from, to, now), 0),
  }));
}

function requireAdmin(context: Context<AppContext>): Response | undefined {
  if (context.get('actor').role !== 'admin') {
    return context.json({ error: 'Administrator reporting access is required.' }, 403);
  }
}

export function createApp(identityVerifier: IdentityVerifier = verifyAccessIdentity) {
  const app = new Hono<AppContext>();
  app.use('*', secureHeaders());
  app.use('/api/*', bodyLimit({ maxSize: 24 * 1024 }));
  app.use('/api/*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    let identity;
    try {
      identity = await identityVerifier(context.req.raw, context.env);
    } catch (error) {
      console.warn(error instanceof Error ? error.message : 'Access identity verification failed');
      return context.json(
        { error: 'Microsoft sign-in through Cloudflare Access is required.' },
        401,
      );
    }
    if (!isAllowedEmail(identity.email, context.env.ALLOWED_EMAIL_DOMAIN)) {
      return context.json(
        { error: 'This Microsoft account is not permitted to use Timekeeper.' },
        403,
      );
    }
    const actor = await new D1TimeStore(context.env.DB).upsertUser({
      accessSubject: identity.subject,
      entraObjectId: identity.entraObjectId,
      email: identity.email,
      displayName: identity.displayName,
      role: isAdminEmail(identity.email, context.env.ADMIN_EMAILS) ? 'admin' : 'employee',
    });
    context.set('actor', actor);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(context.req.method) && !validCsrf(context)) {
      return context.json(
        { error: 'Your request security token is invalid. Refresh and try again.' },
        403,
      );
    }
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
      user: {
        id: actor.id,
        email: actor.email,
        displayName: actor.displayName,
        role: actor.role,
      },
      logoutUrl: '/cdn-cgi/access/logout',
    });
  });

  app.get('/api/projects', async (context) => {
    return context.json({ projects: await new D1TimeStore(context.env.DB).listProjects() });
  });

  app.get('/api/users', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const users = await new D1TimeStore(context.env.DB).listUsers();
    return context.json({
      users: users.map(({ id, email, displayName, role }) => ({ id, email, displayName, role })),
    });
  });

  app.get('/api/dashboard', async (context) => {
    const current = new Date();
    const actor = context.get('actor');
    const store = new D1TimeStore(context.env.DB, () => current);
    const localToday = brisbaneNow(current).toISODate()!;
    const todayRange = getDayRange(localToday);
    const week = getWeekRange(undefined, current);
    const [active, todayEntries, weekEntries, projects] = await Promise.all([
      store.getActiveEntry(actor.id),
      store.listEntries({ ...todayRange, userId: actor.id }),
      store.listEntries({ from: week.from, to: week.to, userId: actor.id }),
      store.listProjects(),
    ]);
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
        projectTotals: projectTotals(weekEntries, week.from, week.to, current),
      },
    });
  });

  app.get('/api/entries', async (context) => {
    const current = brisbaneNow();
    const actor = context.get('actor');
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
    const requestedUserId = context.req.query('userId');
    if (projectId && !idSchema.safeParse(projectId).success) {
      return context.json({ error: 'Invalid project filter.' }, 400);
    }
    if (requestedUserId && !idSchema.safeParse(requestedUserId).success) {
      return context.json({ error: 'Invalid employee filter.' }, 400);
    }
    if (requestedUserId && actor.role !== 'admin') {
      return context.json({ error: 'Administrator reporting access is required.' }, 403);
    }
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
      projectId,
      userId,
    });
    return context.json({
      entries,
      totalMs: entries.reduce((sum, entry) => sum + overlapMs(entry, range.from, range.to), 0),
      projectTotals: projectTotals(entries, range.from, range.to),
    });
  });

  app.post('/api/clock-in', async (context) => {
    const parsed = workSchema.safeParse(await parseJson(context));
    if (!parsed.success)
      return context.json(
        { error: 'Check the project and notes.', details: parsed.error.flatten() },
        400,
      );
    try {
      const entry = await new D1TimeStore(context.env.DB).clockIn(
        context.get('actor').id,
        parsed.data.projectName,
        parsed.data.notes,
        new Date(),
      );
      return context.json({ entry }, 201);
    } catch (error) {
      if (error instanceof Error && error.message === 'ACTIVE_TIMER_EXISTS') {
        return context.json(
          { error: 'You already have a timer running. Clock it out before starting another.' },
          409,
        );
      }
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
      const entry = await new D1TimeStore(context.env.DB).createEntry(
        context.get('actor').id,
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
      if (error instanceof Error && error.message.includes('Clock-out')) {
        return context.json({ error: error.message }, 400);
      }
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

  app.get('/api/reports/weekly.xlsx', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
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

  app.post('/api/reports/test-email', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
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

  app.all('/api/*', (context) => context.json({ error: 'API route not found.' }, 404));
  app.all('*', (context) => context.env.ASSETS.fetch(context.req.raw));

  app.onError((error, context) => {
    console.error(error instanceof Error ? error.message : 'Unknown Worker error');
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

export default {
  fetch: app.fetch,
  scheduled(controller, env, context) {
    context.waitUntil(runScheduledReport(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
