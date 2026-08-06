import { randomBytes } from 'node:crypto';
import compression from 'compression';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import session, { type Store as SessionStore } from 'express-session';
import helmet from 'helmet';
import { z } from 'zod';
import { verifyPassword } from './auth';
import { buildWeeklyWorkbook } from './report';
import type { TimeStore } from './types';
import {
  BRISBANE_ZONE,
  brisbaneNow,
  durationMs,
  getDayRange,
  getWeekRange,
  overlapMs,
  parseLocalDate,
  parseLocalDateTime,
} from './time';

const passwordSchema = z.object({ password: z.string().min(1).max(256) });
const workSchema = z.object({
  projectName: z.string().trim().min(1, 'Choose or enter a project').max(120),
  notes: z.string().trim().max(2000).default(''),
});
const entrySchema = workSchema.extend({
  startLocal: z.string().min(1),
  endLocal: z.string().min(1),
});
const idSchema = z.string().uuid();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function csrfToken(): string {
  return randomBytes(24).toString('base64url');
}

function apiError(res: Response, status: number, message: string, details?: unknown): void {
  res.status(status).json({ error: message, details });
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.authenticated) return apiError(res, 401, 'Sign in is required.');
  next();
}

function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.csrfToken || req.get('x-csrf-token') !== req.session.csrfToken) {
    return apiError(res, 403, 'Your session security token is invalid. Refresh and try again.');
  }
  next();
}

function parseCompletedEntry(input: z.infer<typeof entrySchema>) {
  const startAt = parseLocalDateTime(input.startLocal);
  const endAt = parseLocalDateTime(input.endLocal);
  if (endAt <= startAt) throw new Error('Clock-out time must be after clock-in time.');
  return { projectName: input.projectName, notes: input.notes, startAt, endAt };
}

export interface AppOptions {
  store: TimeStore;
  sessionStore?: SessionStore;
  passwordHash: string;
  sessionSecret: string;
  production?: boolean;
  now?: () => Date;
}

export function createApp(options: AppOptions): express.Express {
  const app = express();
  const now = options.now ?? (() => new Date());
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(compression());
  app.use(express.json({ limit: '24kb' }));
  app.use(
    session({
      name: 'timekeeper.sid',
      secret: options.sessionSecret,
      store: options.sessionStore,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        secure: Boolean(options.production),
        sameSite: 'strict',
        maxAge: 12 * 60 * 60 * 1000,
      },
    }),
  );

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' },
  });

  app.get('/api/health', (_req, res) => res.json({ status: 'ok', timezone: BRISBANE_ZONE }));
  app.get('/api/session', (req, res) => {
    if (!req.session.authenticated) return res.json({ authenticated: false });
    if (!req.session.csrfToken) req.session.csrfToken = csrfToken();
    res.json({ authenticated: true, csrfToken: req.session.csrfToken });
  });
  app.post('/api/login', loginLimiter, async (req, res, next) => {
    try {
      const parsed = passwordSchema.safeParse(req.body);
      if (!parsed.success) return apiError(res, 400, 'A password is required.');
      if (!(await verifyPassword(parsed.data.password, options.passwordHash))) {
        return apiError(res, 401, 'The password is incorrect.');
      }
      req.session.regenerate((error) => {
        if (error) return next(error);
        req.session.authenticated = true;
        req.session.csrfToken = csrfToken();
        req.session.save((saveError) => {
          if (saveError) return next(saveError);
          res.json({ authenticated: true, csrfToken: req.session.csrfToken });
        });
      });
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', requireAuth);
  app.post('/api/logout', requireCsrf, (req, res, next) => {
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('timekeeper.sid');
      res.status(204).end();
    });
  });

  app.get('/api/projects', async (_req, res, next) => {
    try {
      res.json({ projects: await options.store.listProjects() });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/dashboard', async (_req, res, next) => {
    try {
      const current = now();
      const localToday = brisbaneNow(current).toISODate()!;
      const todayRange = getDayRange(localToday);
      const week = getWeekRange(undefined, current);
      const [active, todayEntries, weekEntries, projects] = await Promise.all([
        options.store.getActiveEntry(),
        options.store.listEntries(todayRange),
        options.store.listEntries({ from: week.from, to: week.to }),
        options.store.listProjects(),
      ]);
      const projectTotals = [...new Set(weekEntries.map((entry) => entry.projectName))].map(
        (projectName) => ({
          projectName,
          totalMs: weekEntries
            .filter((entry) => entry.projectName === projectName)
            .reduce((sum, entry) => sum + overlapMs(entry, week.from, week.to, current), 0),
        }),
      );
      res.json({
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
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/entries', async (req, res, next) => {
    try {
      const current = brisbaneNow(now());
      const fromText =
        typeof req.query.from === 'string'
          ? req.query.from
          : current.minus({ days: 89 }).toISODate()!;
      const toText = typeof req.query.to === 'string' ? req.query.to : current.toISODate()!;
      if (!dateSchema.safeParse(fromText).success || !dateSchema.safeParse(toText).success) {
        return apiError(res, 400, 'Dates must use YYYY-MM-DD format.');
      }
      const from = parseLocalDate(fromText);
      const toInclusive = parseLocalDate(toText);
      if (toInclusive < from)
        return apiError(res, 400, 'The end date must not precede the start date.');
      if (toInclusive.diff(from, 'days').days > 366)
        return apiError(res, 400, 'Choose a range of 366 days or less.');
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (projectId && !idSchema.safeParse(projectId).success)
        return apiError(res, 400, 'Invalid project filter.');
      const range = {
        from: from.toUTC().toJSDate(),
        to: toInclusive.plus({ days: 1 }).toUTC().toJSDate(),
      };
      const entries = await options.store.listEntries({ ...range, projectId });
      const projectTotals = [...new Set(entries.map((entry) => entry.projectName))].map(
        (projectName) => ({
          projectName,
          totalMs: entries
            .filter((entry) => entry.projectName === projectName)
            .reduce((sum, entry) => sum + overlapMs(entry, range.from, range.to, now()), 0),
        }),
      );
      res.json({
        entries,
        totalMs: entries.reduce(
          (sum, entry) => sum + overlapMs(entry, range.from, range.to, now()),
          0,
        ),
        projectTotals,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/clock-in', requireCsrf, async (req, res, next) => {
    try {
      const parsed = workSchema.safeParse(req.body);
      if (!parsed.success)
        return apiError(res, 400, 'Check the project and notes.', parsed.error.flatten());
      const entry = await options.store.clockIn(parsed.data.projectName, parsed.data.notes, now());
      res.status(201).json({ entry });
    } catch (error) {
      if (error instanceof Error && error.message === 'ACTIVE_TIMER_EXISTS') {
        return apiError(
          res,
          409,
          'A timer is already running. Clock it out before starting another.',
        );
      }
      next(error);
    }
  });

  app.post('/api/clock-out', requireCsrf, async (_req, res, next) => {
    try {
      const entry = await options.store.clockOut(now());
      if (!entry) return apiError(res, 409, 'There is no running timer to clock out.');
      res.json({ entry });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/entries', requireCsrf, async (req, res, next) => {
    try {
      const parsed = entrySchema.safeParse(req.body);
      if (!parsed.success)
        return apiError(res, 400, 'Check the entry details.', parsed.error.flatten());
      const entry = await options.store.createEntry(parseCompletedEntry(parsed.data));
      res.status(201).json({ entry });
    } catch (error) {
      if (error instanceof Error && error.message.includes('Clock-out'))
        return apiError(res, 400, error.message);
      next(error);
    }
  });

  app.put('/api/entries/:id', requireCsrf, async (req, res, next) => {
    try {
      const entryId = idSchema.safeParse(req.params.id);
      if (!entryId.success) return apiError(res, 400, 'Invalid entry.');
      const parsed = entrySchema.safeParse(req.body);
      if (!parsed.success)
        return apiError(res, 400, 'Check the entry details.', parsed.error.flatten());
      const entry = await options.store.updateEntry(entryId.data, parseCompletedEntry(parsed.data));
      if (!entry) return apiError(res, 404, 'Completed entry not found.');
      res.json({ entry });
    } catch (error) {
      if (error instanceof Error && error.message.includes('Clock-out'))
        return apiError(res, 400, error.message);
      next(error);
    }
  });

  app.delete('/api/entries/:id', requireCsrf, async (req, res, next) => {
    try {
      const entryId = idSchema.safeParse(req.params.id);
      if (!entryId.success) return apiError(res, 400, 'Invalid entry.');
      if (!(await options.store.deleteEntry(entryId.data)))
        return apiError(res, 404, 'Entry not found.');
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/reports/weekly.xlsx', async (req, res, next) => {
    try {
      const requested = typeof req.query.weekStart === 'string' ? req.query.weekStart : undefined;
      if (requested && !dateSchema.safeParse(requested).success)
        return apiError(res, 400, 'Invalid week date.');
      const range = getWeekRange(requested, now());
      const report = await buildWeeklyWorkbook(options.store, range.weekStart, now());
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', `attachment; filename="${report.filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(report.buffer);
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', (_req, res) => apiError(res, 404, 'API route not found.'));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(error instanceof Error ? error.message : error);
    apiError(res, 500, 'Something went wrong. Please try again.');
  });
  return app;
}
