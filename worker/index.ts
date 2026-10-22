import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import { importCatalogCsv, syncFromFyi } from '../server/catalog-sync';
import { buildClientTimePdf } from '../server/client-report';
import {
  createResendReportSender,
  processReportDeliveryOutbox,
  sha256Hex,
} from '../server/close-report';
import { D1TimeStore } from '../server/d1-store';
import {
  correctLockedEntry,
  previewFridayClose,
  runManualFridayClose,
  runScheduledFridayCloses,
  type FridayClosePreview,
} from '../server/friday-close';
import { D1PriorityStore } from '../server/priority-store';
import { D1ScheduleStore } from '../server/schedule';
import { createResendSender, sendWeeklyReport } from '../server/email';
import { finalizeWeeklyReport } from '../server/finalize-report';
import { buildWeeklyWorkbook } from '../server/report';
import { D1FinalizedReportStore } from '../server/report-archive';
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
  approveReview,
  beginConnection,
  cancelApproval,
  connection as xeroProjectsConnection,
  disconnectConnection,
  finishConnection,
  mapClient,
  mapUser,
  mapWork,
  processUploadBatch,
  reconcileUpload,
  refreshAcceptedStatuses,
  refreshCatalogue,
  saveControls,
  saveEntrySelection,
  selectOrganisation,
  unmapClient,
  unmapUser,
  unmapWork,
  validatedEntrySelectionSnapshot,
  XeroProblem,
} from '../server/xero/index';
import {
  isAdminEmail,
  isAllowedEmail,
  verifyAccessIdentity,
  type IdentityVerifier,
} from './access';
import { csrfToken, validCsrf } from './csrf';
import type { Env } from './env';
import {
  billingReviewData,
  billingReviewPreview,
  projectsSetupData,
  projectsWorkOptions,
  xeroActor,
} from './xero-projects-view';

type AppContext = { Bindings: Env; Variables: { actor: User } };
const practiceOnlyText = {
  clientDescription: z.string().trim().max(2000).default(''),
  internalNote: z.string().trim().max(2000).optional(),
  // Backwards-compatible request field. It is always treated as practice-only.
  notes: z.string().trim().max(2000).optional(),
};
const clientWorkSchema = z.object({
  workType: z.literal('client'),
  clientId: z.string().uuid(),
  jobId: z.string().uuid().optional(),
  xeroProjectId: z.string().uuid().optional(),
  xeroTaskId: z.string().uuid().optional(),
  billable: z.boolean(),
  ...practiceOnlyText,
});
const internalWorkSchema = z.object({
  workType: z.literal('internal'),
  internalActivityId: z.string().uuid(),
  billable: z.literal(false).optional().default(false),
  ...practiceOnlyText,
});
const workSchema = z.discriminatedUnion('workType', [clientWorkSchema, internalWorkSchema]);
const projectSelectionSchema = z
  .object({
    xeroProjectId: z.string().uuid().optional(),
    xeroTaskId: z.string().uuid().optional(),
  })
  .superRefine((value, context) => {
    if (Boolean(value.xeroProjectId) !== Boolean(value.xeroTaskId)) {
      context.addIssue({
        code: 'custom',
        message: 'Choose both a Xero project and task, or leave both blank.',
      });
    }
  });
const entrySchema = z.intersection(
  workSchema,
  z.union([
    z.object({
      startLocal: z.string().min(1),
      endLocal: z.string().min(1),
      expectedRevision: z.number().int().positive().optional(),
    }),
    z.object({
      workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      durationMinutes: z.number().int().min(1).max(10_080),
      expectedRevision: z.number().int().positive().optional(),
    }),
  ]),
);
const correctionSchema = z.intersection(
  entrySchema,
  z.object({
    correctionReason: z.string().trim().min(5).max(1000),
    expectedRevision: z.number().int().positive(),
  }),
);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const idSchema = z.string().uuid();
const priorityAssigneeSchema = z.enum(['alex', 'brendon', 'suzie']);
const priorityItemSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(2000).default(''),
  assignee: priorityAssigneeSchema,
  priority: z.number().int().min(1).max(10),
});
const priorityUpdateSchema = priorityItemSchema.extend({ completed: z.boolean() });
const scheduleSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    description: z.string().trim().max(2000).default(''),
    assignee: priorityAssigneeSchema,
    recurrenceType: z.enum(['weekly', 'fortnightly', 'monthly', 'yearly']),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
    startDate: dateSchema,
    monthlyDay: z.number().int().min(1).max(31).nullable().default(null),
    yearlyMonth: z.number().int().min(1).max(12).nullable().default(null),
    yearlyDay: z.number().int().min(1).max(31).nullable().default(null),
    dueTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .default(null),
  })
  .superRefine((value, context) => {
    if (['weekly', 'fortnightly'].includes(value.recurrenceType) && !value.weekdays.length)
      context.addIssue({ code: 'custom', path: ['weekdays'], message: 'Choose a weekday.' });
    if (value.recurrenceType === 'monthly' && !value.monthlyDay)
      context.addIssue({ code: 'custom', path: ['monthlyDay'], message: 'Choose a day.' });
    if (value.recurrenceType === 'yearly' && (!value.yearlyMonth || !value.yearlyDay))
      context.addIssue({ code: 'custom', path: ['yearlyDay'], message: 'Choose a date.' });
  });

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
  const startAt = parseLocalDateTime(
    'startLocal' in input ? input.startLocal : `${input.workDate}T${input.startTime}`,
  );
  const endAt =
    'endLocal' in input
      ? parseLocalDateTime(input.endLocal)
      : new Date(startAt.getTime() + input.durationMinutes * 60_000);
  if (endAt <= startAt) throw new Error('Clock-out time must be after clock-in time.');
  const internalNote = input.internalNote ?? input.notes ?? '';
  return {
    ...classification(input),
    notes: internalNote,
    internalNote,
    clientDescription: input.clientDescription,
    expectedRevision: input.expectedRevision,
    startAt,
    endAt,
  };
}
async function parseJson(context: Context<AppContext>) {
  try {
    return await context.req.json();
  } catch {
    return undefined;
  }
}

type CloseActivationBaseline = {
  periodStart: string;
  periodEnd: string;
  entryCount: number;
  totalMs: number;
  runningTimersToSplit: number;
  completedEntriesToSplit: number;
  historicalEmailSuppressed: boolean;
  sourceHash: string;
};

function closeActivationBaseline(preview: FridayClosePreview): CloseActivationBaseline {
  return {
    periodStart: preview.coverageFrom,
    periodEnd: preview.cutoffAt,
    entryCount: preview.entryCount,
    totalMs: preview.totalMs,
    runningTimersToSplit: preview.runningContinuations,
    completedEntriesToSplit: Math.max(0, preview.crossingEntries - preview.runningContinuations),
    historicalEmailSuppressed: preview.historicalEmailSuppressed,
    sourceHash: preview.sourceHash,
  };
}

async function closePreviewHash(input: {
  preview: FridayClosePreview;
  recipients: string[];
  activationBaseline: CloseActivationBaseline | null;
}): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      cutoff: input.preview.cutoffAt,
      periodStart: input.preview.coverageFrom,
      periodEnd: input.preview.cutoffAt,
      entryCount: input.preview.entryCount,
      totalMs: input.preview.totalMs,
      runningTimersToSplit: input.preview.runningContinuations,
      completedEntriesToSplit: Math.max(
        0,
        input.preview.crossingEntries - input.preview.runningContinuations,
      ),
      sourceHash: input.preview.sourceHash,
      recipients: input.recipients,
      activationBaseline: input.activationBaseline,
    }),
  );
}
function requireAdmin(context: Context<AppContext>): Response | undefined {
  if (context.get('actor').role !== 'admin')
    return context.json({ error: 'Administrator access is required.' }, 403);
}
function canViewReports(actor: User, env: Env): boolean {
  return actor.role === 'admin' || isAdminEmail(actor.email, env.REPORT_VIEWER_EMAILS);
}
function canReviewBilling(actor: User, env: Env): boolean {
  return actor.role === 'admin' || isAdminEmail(actor.email, env.XERO_REVIEWER_EMAILS ?? '');
}
function requireBillingReview(context: Context<AppContext>): Response | undefined {
  if (!canReviewBilling(context.get('actor'), context.env))
    return context.json({ error: 'Billing reviewer access is required.' }, 403);
}
function requireReportAccess(context: Context<AppContext>): Response | undefined {
  if (!canViewReports(context.get('actor'), context.env))
    return context.json({ error: 'Report access is required.' }, 403);
}
function projectFailure(context: Context<AppContext>, error: unknown): Response {
  if (error instanceof XeroProblem) {
    if (error.retryAfterSeconds > 0) context.header('Retry-After', String(error.retryAfterSeconds));
    context.status(error.status as 400);
    return context.json({ error: error.message, code: error.code });
  }
  console.error(
    JSON.stringify({
      event: 'xero_projects_error',
      message: error instanceof Error ? error.message : 'unknown',
    }),
  );
  return context.json({ error: 'The Xero Projects request could not be completed.' }, 500);
}

async function saveRequestedProjectSelection(
  context: Context<AppContext>,
  entryId: string,
  input: unknown,
  expectedSourceRevision: number,
) {
  const selection = projectSelectionSchema.parse(input);
  if (!selection.xeroProjectId || !selection.xeroTaskId) return null;
  const current = await context.env.DB.prepare(
    `SELECT s.project_id, s.task_id, s.selection_revision, e.revision AS source_revision
       FROM xero_projects_entry_selections s
       JOIN time_entries e ON e.id=s.entry_id
       WHERE s.entry_id = ?`,
  )
    .bind(entryId)
    .first<{
      project_id: string;
      task_id: string;
      selection_revision: number;
      source_revision: number;
    }>();
  if (current && current.source_revision !== expectedSourceRevision) {
    throw new XeroProblem(
      'SOURCE_CHANGED',
      'The entry changed before its Xero selection could be saved. Reload and try again.',
      409,
    );
  }
  if (current?.project_id === selection.xeroProjectId && current.task_id === selection.xeroTaskId) {
    return current;
  }
  return saveEntrySelection(context.env, xeroActor(context.get('actor')), {
    entryId,
    projectId: selection.xeroProjectId,
    taskId: selection.xeroTaskId,
    expectedSourceRevision,
    ...(current ? { expectedSelectionRevision: current.selection_revision } : {}),
  });
}

async function validateRequestedProjectSelection(context: Context<AppContext>, input: unknown) {
  const work = workSchema.parse(input);
  if (work.workType !== 'client' || !work.xeroProjectId || !work.xeroTaskId) return null;
  if (context.env.XERO_ENABLED !== 'true') return null;
  const current = await xeroProjectsConnection(context.env.DB);
  if (!current?.connected) return null;
  return validatedEntrySelectionSnapshot(context.env, {
    clientId: work.clientId,
    projectId: work.xeroProjectId,
    taskId: work.xeroTaskId,
  });
}
function canManageSchedule(actor: User): boolean {
  return [
    'alexg@versatileaccounting.com.au',
    'brendong@versatileaccounting.com.au',
    'suzieg@versatileaccounting.com.au',
  ].includes(actor.email.toLowerCase());
}
function requireScheduleAccess(context: Context<AppContext>): Response | undefined {
  if (!canManageSchedule(context.get('actor')))
    return context.json(
      { error: 'Schedule access is restricted to Alex, Brendon and Suzie.' },
      403,
    );
}
function emailList(value: string): string[] {
  return value
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}
function reportRecipientList(env: Env): string[] {
  const configured = emailList(env.WEEKLY_REPORT_RECIPIENTS ?? '');
  return configured.length
    ? [...new Set(configured)]
    : [...new Set([...emailList(env.ADMIN_EMAILS), ...emailList(env.REPORT_VIEWER_EMAILS)])];
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
    LOCKED_PERIOD:
      'That time falls in a closed period. An administrator must use the audited correction flow.',
    LOCKED_ENTRY: 'This entry is locked. An administrator must use the audited correction flow.',
    LOCK_BOUNDARY_SPLIT_REQUIRED: 'The timer crossed a Friday close and is being reconciled.',
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
      user: {
        id: actor.id,
        email: actor.email,
        displayName: actor.displayName,
        role: actor.role,
        canViewReports: canViewReports(actor, context.env),
        canManageSchedule: canManageSchedule(actor),
        canReviewBilling: canReviewBilling(actor, context.env),
      },
      logoutUrl: '/cdn-cgi/access/logout',
    });
  });
  app.get('/api/users', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const users = await new D1TimeStore(context.env.DB).listUsers();
    return context.json({
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        canViewReports: canViewReports(user, context.env),
        canManageSchedule: canManageSchedule(user),
        canReviewBilling: canReviewBilling(user, context.env),
      })),
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

  app.get('/api/projects/catalog', async (context) => {
    const clientId = idSchema.safeParse(context.req.query('clientId'));
    const jobText = context.req.query('jobId');
    const jobId = jobText ? idSchema.safeParse(jobText) : null;
    if (!clientId.success || (jobId && !jobId.success))
      return context.json({ error: 'Choose a valid client and job.' }, 400);
    try {
      return context.json(
        await projectsWorkOptions(
          context.env,
          clientId.data,
          jobId?.success ? jobId.data : undefined,
        ),
      );
    } catch (error) {
      return projectFailure(context, error);
    }
  });

  app.get('/api/projects/setup', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    try {
      return context.json(await projectsSetupData(context.env));
    } catch (error) {
      return projectFailure(context, error);
    }
  });

  app.put('/api/projects/setup', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const parsed = z
      .object({ enabled: z.boolean(), cutoverDate: dateSchema.nullable() })
      .safeParse(await parseJson(context));
    if (!parsed.success || !parsed.data.cutoverDate)
      return context.json(
        { error: 'Choose a cutover date before changing upload eligibility.' },
        400,
      );
    try {
      const cutoverAt = parseLocalDate(parsed.data.cutoverDate).toUTC().toMillis();
      return context.json(
        await saveControls(context.env, xeroActor(context.get('actor')), {
          cutoverAt,
          paused: !parsed.data.enabled,
        }),
      );
    } catch (error) {
      return projectFailure(context, error);
    }
  });

  app.post('/api/projects/oauth/start', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    try {
      return context.json(
        await beginConnection(
          context.env,
          xeroActor(context.get('actor')),
          new URL(context.req.url).origin,
        ),
      );
    } catch (error) {
      return projectFailure(context, error);
    }
  });

  app.get('/api/projects/oauth/callback', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    try {
      await finishConnection(
        context.env,
        xeroActor(context.get('actor')),
        new URL(context.req.url),
      );
      return context.redirect('/?view=projects&xero=select-organisation');
    } catch (error) {
      return projectFailure(context, error);
    }
  });

  app.post('/api/projects/organisation', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const parsed = z
      .object({
        tenantId: idSchema,
        confirmation: z.string().trim().min(1).max(240),
      })
      .safeParse(await parseJson(context));
    if (!parsed.success)
      return context.json({ error: 'Choose and confirm the intended Xero organisation.' }, 400);
    try {
      return context.json(
        await selectOrganisation(
          context.env,
          xeroActor(context.get('actor')),
          parsed.data.tenantId,
          parsed.data.confirmation,
        ),
      );
    } catch (error) {
      return projectFailure(context, error);
    }
  });

  app.post('/api/projects/catalog/refresh', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    try {
      return context.json(await refreshCatalogue(context.env, xeroActor(context.get('actor'))));
    } catch (error) {
      return projectFailure(context, error);
    }
  });

  app.post('/api/projects/pause', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const parsed = z.object({ paused: z.boolean() }).safeParse(await parseJson(context));
    if (!parsed.success)
      return context.json({ error: 'Choose whether processing is paused.' }, 400);
    try {
      const current = await xeroProjectsConnection(context.env.DB);
      if (current?.cutover_at === null || current?.cutover_at === undefined)
        return context.json({ error: 'Set the cutover date before enabling processing.' }, 409);
      return context.json(
        await saveControls(context.env, xeroActor(context.get('actor')), {
          cutoverAt: current.cutover_at,
          paused: parsed.data.paused,
        }),
      );
    } catch (error) {
      return projectFailure(context, error);
    }
  });

  app.post('/api/projects/disconnect', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const parsed = z.object({ confirmation: z.literal(true) }).safeParse(await parseJson(context));
    if (!parsed.success)
      return context.json(
        { error: 'Confirm that Xero Projects processing will be disconnected.' },
        400,
      );
    try {
      return context.json(
        await disconnectConnection(context.env, xeroActor(context.get('actor')), true),
      );
    } catch (error) {
      return projectFailure(context, error);
    }
  });

  app.put('/api/projects/mappings/client/:localId', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const localId = idSchema.safeParse(context.req.param('localId'));
    const parsed = z
      .object({ xeroContactId: idSchema.nullable() })
      .safeParse(await parseJson(context));
    if (!localId.success || !parsed.success)
      return context.json({ error: 'Choose a valid Timekeeper client and Xero contact.' }, 400);
    try {
      if (parsed.data.xeroContactId === null)
        return context.json(
          await unmapClient(context.env, xeroActor(context.get('actor')), localId.data),
        );
      return context.json(
        await mapClient(
          context.env,
          xeroActor(context.get('actor')),
          localId.data,
          parsed.data.xeroContactId,
        ),
      );
    } catch (error) {
      return projectFailure(context, error);
    }
  });

  app.put('/api/projects/mappings/work/:localId', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const localId = idSchema.safeParse(context.req.param('localId'));
    const parsed = z
      .object({ xeroProjectId: idSchema.nullable(), xeroTaskId: idSchema.nullable() })
      .superRefine((value, issue) => {
        if (Boolean(value.xeroProjectId) !== Boolean(value.xeroTaskId))
          issue.addIssue({ code: 'custom', message: 'Choose both a project and task.' });
      })
      .safeParse(await parseJson(context));
    if (!localId.success || !parsed.success)
      return context.json({ error: 'Choose a valid local job, Xero project, and task.' }, 400);
    try {
      if (parsed.data.xeroProjectId === null && parsed.data.xeroTaskId === null)
        return context.json(
          await unmapWork(context.env, xeroActor(context.get('actor')), localId.data),
        );
      await mapWork(
        context.env,
        xeroActor(context.get('actor')),
        localId.data,
        parsed.data.xeroProjectId!,
        parsed.data.xeroTaskId!,
      );
      return context.json({ saved: true });
    } catch (error) {
      return projectFailure(context, error);
    }
  });

  app.put('/api/projects/mappings/user/:localId', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const localId = idSchema.safeParse(context.req.param('localId'));
    const parsed = z
      .object({
        xeroUserId: idSchema.nullable(),
        acknowledgeDifferentEmail: z.boolean().optional().default(false),
      })
      .safeParse(await parseJson(context));
    if (!localId.success || !parsed.success)
      return context.json({ error: 'Choose a valid employee and Xero Projects user.' }, 400);
    try {
      if (parsed.data.xeroUserId === null)
        return context.json(
          await unmapUser(context.env, xeroActor(context.get('actor')), localId.data),
        );
      await mapUser(
        context.env,
        xeroActor(context.get('actor')),
        localId.data,
        parsed.data.xeroUserId,
        parsed.data.acknowledgeDifferentEmail,
      );
      return context.json({ saved: true });
    } catch (error) {
      return projectFailure(context, error);
    }
  });

  app.get('/api/projects/review', async (context) => {
    const denied = requireBillingReview(context);
    if (denied) return denied;
    const query = z
      .object({
        state: z
          .enum([
            'eligible',
            'blocked',
            'approved',
            'cancelled',
            'not_queued',
            'queued',
            'sending',
            'accepted',
            'failed',
            'needs_attention',
          ])
          .optional(),
        search: z.string().trim().max(100).optional(),
        page: z.coerce.number().int().min(1).max(1_000_000).default(1),
        pageSize: z.coerce.number().int().min(10).max(100).default(50),
      })
      .safeParse({
        state: context.req.query('state') || undefined,
        search: context.req.query('search') || undefined,
        page: context.req.query('page') || 1,
        pageSize: context.req.query('pageSize') || 50,
      });
    if (!query.success) return context.json({ error: 'Invalid billing review filters.' }, 400);
    try {
      return context.json(await billingReviewData(context.env, query.data));
    } catch (error) {
      return projectFailure(context, error);
    }
  });

  app.get('/api/projects/review/:entryId/preview', async (context) => {
    const denied = requireBillingReview(context);
    if (denied) return denied;
    const entryId = idSchema.safeParse(context.req.param('entryId'));
    if (!entryId.success) return context.json({ error: 'Invalid time entry.' }, 400);
    try {
      const preview = await billingReviewPreview(context.env, context.get('actor'), entryId.data);
      return preview
        ? context.json(preview)
        : context.json({ error: 'The locked client entry was not found.' }, 404);
    } catch (error) {
      return projectFailure(context, error);
    }
  });

  app.post('/api/projects/review/:entryId/approve', async (context) => {
    const denied = requireBillingReview(context);
    if (denied) return denied;
    const entryId = idSchema.safeParse(context.req.param('entryId'));
    const parsed = z
      .object({
        expectedPreviewHash: z.string().regex(/^[0-9a-f]{64}$/i),
        acknowledgedWarnings: z.array(z.string().min(1).max(80)).max(20),
      })
      .passthrough()
      .safeParse(await parseJson(context));
    if (!entryId.success || !parsed.success)
      return context.json({ error: 'Reload and review the exact payload before approval.' }, 400);
    try {
      return context.json(
        await approveReview(context.env, xeroActor(context.get('actor')), {
          entryIds: [entryId.data],
          expectedPreviewHash: parsed.data.expectedPreviewHash,
          acknowledgedWarnings: parsed.data.acknowledgedWarnings,
        }),
      );
    } catch (error) {
      return projectFailure(context, error);
    }
  });

  app.post('/api/projects/review/approvals/:approvalId/cancel', async (context) => {
    const denied = requireBillingReview(context);
    if (denied) return denied;
    const approvalId = idSchema.safeParse(context.req.param('approvalId'));
    const parsed = z
      .object({ reason: z.string().trim().min(1).max(500) })
      .safeParse(await parseJson(context));
    if (!approvalId.success || !parsed.success)
      return context.json(
        { error: 'Give a reason for returning this no-write approval to review.' },
        400,
      );
    try {
      await cancelApproval(
        context.env,
        xeroActor(context.get('actor')),
        approvalId.data,
        parsed.data.reason,
      );
      return context.json({ cancelled: true });
    } catch (error) {
      return projectFailure(context, error);
    }
  });

  app.post('/api/projects/outbox/process', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    try {
      return context.json(await processUploadBatch(context.env, 10));
    } catch (error) {
      return projectFailure(context, error);
    }
  });

  app.post('/api/projects/outbox/:outboxId/reconcile', async (context) => {
    const denied = requireBillingReview(context);
    if (denied) return denied;
    const outboxId = idSchema.safeParse(context.req.param('outboxId'));
    const parsed = z
      .discriminatedUnion('outcome', [
        z.object({
          outcome: z.literal('found'),
          remoteTimeEntryId: idSchema,
        }),
        z.object({ outcome: z.literal('not_found') }),
      ])
      .safeParse(await parseJson(context));
    if (!outboxId.success || !parsed.success)
      return context.json(
        { error: 'Choose a valid upload and confirmed reconciliation outcome.' },
        400,
      );
    try {
      await reconcileUpload(
        context.env,
        xeroActor(context.get('actor')),
        outboxId.data,
        parsed.data,
      );
      return context.json({ reconciled: true });
    } catch (error) {
      return projectFailure(context, error);
    }
  });

  app.post('/api/projects/billing/refresh', async (context) => {
    const denied = requireBillingReview(context);
    if (denied) return denied;
    try {
      return context.json(await refreshAcceptedStatuses(context.env, 50));
    } catch (error) {
      return projectFailure(context, error);
    }
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
    const selection = projectSelectionSchema.safeParse(parsed.data);
    if (!selection.success)
      return context.json(
        { error: 'Choose both a Xero project and task, or leave both blank.' },
        400,
      );
    try {
      await validateRequestedProjectSelection(context, parsed.data);
    } catch (error) {
      return projectFailure(context, error);
    }
    try {
      const entry = await new D1TimeStore(context.env.DB).clockIn(
        context.get('actor').id,
        classification(parsed.data),
        parsed.data.internalNote ?? parsed.data.notes ?? '',
        new Date(),
        parsed.data.clientDescription,
      );
      let xeroWarning: string | null = null;
      try {
        await saveRequestedProjectSelection(context, entry.id, parsed.data, entry.revision);
      } catch (error) {
        xeroWarning =
          error instanceof XeroProblem ? error.message : 'The Xero selection was not saved.';
      }
      return context.json({ entry, xeroWarning }, 201);
    } catch (error) {
      if (error instanceof Error && error.message === 'ACTIVE_TIMER_EXISTS')
        return context.json({ error: 'You already have a timer running.' }, 409);
      const message = classificationError(error);
      if (message) return context.json({ error: message }, 400);
      throw error;
    }
  });
  app.post('/api/clock-out', async (context) => {
    const now = new Date();
    const store = new D1TimeStore(context.env.DB, () => now);
    let entry;
    try {
      entry = await store.clockOut(context.get('actor').id, now);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'LOCK_BOUNDARY_SPLIT_REQUIRED')
        throw error;
      await runScheduledFridayCloses({
        db: context.env.DB,
        recipients: reportRecipientList(context.env),
        now,
      });
      entry = await store.clockOut(context.get('actor').id, now);
    }
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
    const selection = projectSelectionSchema.safeParse(parsed.data);
    if (!selection.success)
      return context.json(
        { error: 'Choose both a Xero project and task, or leave both blank.' },
        400,
      );
    try {
      await validateRequestedProjectSelection(context, parsed.data);
    } catch (error) {
      return projectFailure(context, error);
    }
    try {
      const entry = await new D1TimeStore(context.env.DB).createEntry(
        context.get('actor').id,
        parseCompletedEntry(parsed.data),
      );
      let xeroWarning: string | null = null;
      try {
        await saveRequestedProjectSelection(context, entry.id, parsed.data, entry.revision);
      } catch (error) {
        xeroWarning =
          error instanceof XeroProblem ? error.message : 'The Xero selection was not saved.';
      }
      return context.json({ entry, xeroWarning }, 201);
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
    const selection = projectSelectionSchema.safeParse(parsed.data);
    if (!selection.success)
      return context.json(
        { error: 'Choose both a Xero project and task, or leave both blank.' },
        400,
      );
    try {
      await validateRequestedProjectSelection(context, parsed.data);
    } catch (error) {
      return projectFailure(context, error);
    }
    try {
      const entry = await new D1TimeStore(context.env.DB).updateEntry(
        context.get('actor').id,
        entryId.data,
        parseCompletedEntry(parsed.data),
      );
      if (!entry) return context.json({ error: 'Completed entry not found.' }, 404);
      let xeroWarning: string | null = null;
      try {
        await saveRequestedProjectSelection(context, entry.id, parsed.data, entry.revision);
      } catch (error) {
        xeroWarning =
          error instanceof XeroProblem ? error.message : 'The Xero selection was not saved.';
      }
      return context.json({ entry, xeroWarning });
    } catch (error) {
      const message = classificationError(error) ?? (error instanceof Error ? error.message : null);
      if (message) return context.json({ error: message }, 400);
      throw error;
    }
  });
  app.post('/api/entries/:id/corrections', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const entryId = idSchema.safeParse(context.req.param('id'));
    const parsed = correctionSchema.safeParse(await parseJson(context));
    if (!entryId.success || !parsed.success)
      return context.json(
        { error: 'Check the corrected entry, revision, and mandatory reason.' },
        400,
      );
    const requestedSelection = projectSelectionSchema.safeParse(parsed.data);
    if (!requestedSelection.success)
      return context.json(
        { error: 'Choose both a Xero project and task, or leave both blank.' },
        400,
      );
    const completed = parseCompletedEntry(parsed.data);
    const patch: Parameters<typeof correctLockedEntry>[0]['patch'] = {
      notes: completed.internalNote,
      clientDescription: completed.clientDescription,
      startAt: completed.startAt,
      endAt: completed.endAt,
      billable: completed.billable,
      workType: completed.workType,
    };
    if (completed.workType === 'client') {
      const client = await context.env.DB.prepare(
        `SELECT id, external_id, name, client_code, active FROM clients WHERE id = ?`,
      )
        .bind(completed.clientId)
        .first<{
          id: string;
          external_id: string;
          name: string;
          client_code: string | null;
          active: number;
        }>();
      if (!client?.active) return context.json({ error: 'Choose an active client.' }, 400);
      Object.assign(patch, {
        clientId: client.id,
        clientName: client.name,
        clientExternalId: client.external_id,
        clientCode: client.client_code,
        internalActivityId: null,
        activityName: null,
      });
      if (completed.jobId) {
        const job = await context.env.DB.prepare(
          `SELECT id, external_id, name, job_code, active
           FROM jobs WHERE id = ? AND client_id = ?`,
        )
          .bind(completed.jobId, completed.clientId)
          .first<{
            id: string;
            external_id: string;
            name: string;
            job_code: string | null;
            active: number;
          }>();
        if (!job?.active)
          return context.json({ error: 'Choose an active job belonging to the client.' }, 400);
        Object.assign(patch, {
          jobId: job.id,
          jobName: job.name,
          jobExternalId: job.external_id,
          jobCode: job.job_code,
        });
      } else {
        Object.assign(patch, {
          jobId: null,
          jobName: null,
          jobExternalId: null,
          jobCode: null,
        });
      }
    } else {
      const activity = await context.env.DB.prepare(
        'SELECT id, name, active FROM internal_activities WHERE id = ?',
      )
        .bind(completed.internalActivityId)
        .first<{ id: string; name: string; active: number }>();
      if (!activity?.active)
        return context.json({ error: 'Choose an active internal activity.' }, 400);
      Object.assign(patch, {
        clientId: null,
        jobId: null,
        internalActivityId: activity.id,
        clientName: null,
        clientExternalId: null,
        clientCode: null,
        jobName: null,
        jobExternalId: null,
        jobCode: null,
        activityName: activity.name,
        billable: false,
      });
    }
    let xeroSelection: Parameters<typeof correctLockedEntry>[0]['xeroSelection'];
    if (completed.workType !== 'client') {
      xeroSelection = null;
    } else if (requestedSelection.data.xeroProjectId && requestedSelection.data.xeroTaskId) {
      const currentConnection = await xeroProjectsConnection(context.env.DB);
      if (context.env.XERO_ENABLED === 'true' && currentConnection?.connected) {
        try {
          xeroSelection = await validatedEntrySelectionSnapshot(context.env, {
            entryId: entryId.data,
            clientId: completed.clientId,
            projectId: requestedSelection.data.xeroProjectId,
            taskId: requestedSelection.data.xeroTaskId,
          });
        } catch (error) {
          return projectFailure(context, error);
        }
      } else {
        const current = await context.env.DB.prepare(
          `SELECT project_id, task_id FROM xero_projects_entry_selections WHERE entry_id = ?`,
        )
          .bind(entryId.data)
          .first<{ project_id: string; task_id: string }>();
        if (
          current?.project_id !== requestedSelection.data.xeroProjectId ||
          current.task_id !== requestedSelection.data.xeroTaskId
        ) {
          return context.json(
            { error: 'Reconnect Xero Projects before changing this locked selection.' },
            409,
          );
        }
        // Preserve an unchanged historical selection while the integration is paused.
        xeroSelection = undefined;
      }
    } else {
      xeroSelection = null;
    }
    try {
      const result = await correctLockedEntry({
        db: context.env.DB,
        entryId: entryId.data,
        expectedRevision: parsed.data.expectedRevision,
        actorUserId: context.get('actor').id,
        reason: parsed.data.correctionReason,
        patch,
        xeroSelection,
        reportRecipients: reportRecipientList(context.env),
      });
      return context.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to correct locked time.';
      const conflict = message.includes('CONFLICT') || message.includes('not found');
      return context.json({ error: message }, conflict ? 409 : 400);
    }
  });
  app.delete('/api/entries/:id', async (context) => {
    const entryId = idSchema.safeParse(context.req.param('id'));
    if (!entryId.success) return context.json({ error: 'Invalid entry.' }, 400);
    try {
      const deleted = await new D1TimeStore(context.env.DB).deleteEntry(
        context.get('actor').id,
        entryId.data,
      );
      return deleted ? context.body(null, 204) : context.json({ error: 'Entry not found.' }, 404);
    } catch (error) {
      const message = classificationError(error);
      if (message) return context.json({ error: message }, 409);
      throw error;
    }
  });

  app.get('/api/priorities', async (context) => {
    return context.json({ items: await new D1PriorityStore(context.env.DB).list() });
  });
  app.post('/api/priorities', async (context) => {
    const parsed = priorityItemSchema.safeParse(await parseJson(context));
    if (!parsed.success)
      return context.json({ error: 'Add a task, assignee, and priority from 1 to 10.' }, 400);
    const item = await new D1PriorityStore(context.env.DB).create({
      ...parsed.data,
      createdByUserId: context.get('actor').id,
    });
    return context.json({ item }, 201);
  });
  app.put('/api/priorities/:id', async (context) => {
    const itemId = idSchema.safeParse(context.req.param('id'));
    if (!itemId.success) return context.json({ error: 'Invalid priority item.' }, 400);
    const parsed = priorityUpdateSchema.safeParse(await parseJson(context));
    if (!parsed.success)
      return context.json({ error: 'Check the task, assignee, and priority.' }, 400);
    const item = await new D1PriorityStore(context.env.DB).update(itemId.data, parsed.data);
    return item ? context.json({ item }) : context.json({ error: 'Priority item not found.' }, 404);
  });
  app.delete('/api/priorities/:id', async (context) => {
    const itemId = idSchema.safeParse(context.req.param('id'));
    if (!itemId.success) return context.json({ error: 'Invalid priority item.' }, 400);
    const deleted = await new D1PriorityStore(context.env.DB).delete(itemId.data);
    return deleted
      ? context.body(null, 204)
      : context.json({ error: 'Priority item not found.' }, 404);
  });

  app.get('/api/schedule', async (context) => {
    const denied = requireScheduleAccess(context);
    if (denied) return denied;
    const weekStart = context.req.query('weekStart');
    if (!weekStart || !dateSchema.safeParse(weekStart).success)
      return context.json({ error: 'Choose a valid week.' }, 400);
    const store = new D1ScheduleStore(context.env.DB);
    const [templates, occurrences] = await Promise.all([
      store.listTemplates(),
      store.listOccurrences(weekStart),
    ]);
    return context.json({ templates, occurrences });
  });
  app.post('/api/schedule/templates', async (context) => {
    const denied = requireScheduleAccess(context);
    if (denied) return denied;
    const parsed = scheduleSchema.safeParse(await parseJson(context));
    if (!parsed.success) return context.json({ error: 'Check the schedule details.' }, 400);
    const template = await new D1ScheduleStore(context.env.DB).create(
      parsed.data,
      context.get('actor').id,
    );
    return context.json({ template }, 201);
  });
  app.put('/api/schedule/templates/:id', async (context) => {
    const denied = requireScheduleAccess(context);
    if (denied) return denied;
    const id = idSchema.safeParse(context.req.param('id'));
    const parsed = scheduleSchema.safeParse(await parseJson(context));
    if (!id.success || !parsed.success)
      return context.json({ error: 'Check the schedule details.' }, 400);
    const template = await new D1ScheduleStore(context.env.DB).update(id.data, parsed.data);
    return template
      ? context.json({ template })
      : context.json({ error: 'Schedule not found.' }, 404);
  });
  app.delete('/api/schedule/templates/:id', async (context) => {
    const denied = requireScheduleAccess(context);
    if (denied) return denied;
    const id = idSchema.safeParse(context.req.param('id'));
    if (!id.success) return context.json({ error: 'Invalid schedule.' }, 400);
    return (await new D1ScheduleStore(context.env.DB).archive(id.data))
      ? context.body(null, 204)
      : context.json({ error: 'Schedule not found.' }, 404);
  });
  app.put('/api/schedule/occurrences/:id', async (context) => {
    const denied = requireScheduleAccess(context);
    if (denied) return denied;
    const id = idSchema.safeParse(context.req.param('id'));
    const parsed = z.object({ completed: z.boolean() }).safeParse(await parseJson(context));
    if (!id.success || !parsed.success) return context.json({ error: 'Invalid occurrence.' }, 400);
    const actor = context.get('actor');
    const occurrence = await new D1ScheduleStore(context.env.DB).setCompleted(
      id.data,
      parsed.data.completed,
      { id: actor.id, displayName: actor.displayName },
    );
    return occurrence
      ? context.json({ occurrence })
      : context.json({ error: 'Occurrence not found.' }, 404);
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

  app.post('/api/close/preview', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const now = new Date();
    const preview = await previewFridayClose({
      db: context.env.DB,
      cutoff: now,
      kind: 'manual',
      now,
    });
    const recipients = reportRecipientList(context.env);
    let activationBaseline: CloseActivationBaseline | null = null;
    if (preview.willActivate) {
      const baselinePreview = preview.activationBaseline
        ? await previewFridayClose({
            db: context.env.DB,
            cutoff: new Date(preview.activationBaseline.cutoffAt),
            kind: 'manual',
            now,
          })
        : preview;
      activationBaseline = closeActivationBaseline(baselinePreview);
    }
    const previewHash = await closePreviewHash({ preview, recipients, activationBaseline });
    const confirmationPhrase = `CLOSE ${preview.cutoffAt} ${previewHash.slice(0, 12).toUpperCase()}`;
    return context.json({
      cutoff: preview.cutoffAt,
      previewHash,
      confirmationPhrase,
      periodStart: preview.coverageFrom,
      periodEnd: preview.cutoffAt,
      timezone: BRISBANE_ZONE,
      entryCount: preview.entryCount,
      runningTimersToSplit: preview.runningContinuations,
      completedEntriesToSplit: Math.max(0, preview.crossingEntries - preview.runningContinuations),
      recipients,
      activationBaseline,
      warnings: [
        'This creates an immutable confidential PDF, CSV and Excel report.',
        'Accepted copies are queued independently for each configured recipient.',
        ...(preview.willActivate
          ? ['Earlier history will be baseline-locked without historical email delivery.']
          : []),
      ],
    });
  });
  app.post('/api/close', async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const parsed = z
      .object({
        cutoff: z.string().datetime({ offset: true }),
        reason: z.string().trim().min(5).max(1000),
        previewHash: z.string().regex(/^[a-f0-9]{64}$/),
        confirmation: z.string().min(1).max(160),
      })
      .safeParse(await parseJson(context));
    if (!parsed.success)
      return context.json(
        {
          error:
            'Use the exact preview confirmation and provide a reason of at least 5 characters.',
        },
        400,
      );
    const cutoff = new Date(parsed.data.cutoff);
    try {
      const now = new Date();
      const preview = await previewFridayClose({
        db: context.env.DB,
        cutoff,
        kind: 'manual',
        now,
      });
      const recipients = reportRecipientList(context.env);
      let activationBaseline: CloseActivationBaseline | null = null;
      if (preview.willActivate) {
        const baselinePreview = preview.activationBaseline
          ? await previewFridayClose({
              db: context.env.DB,
              cutoff: new Date(preview.activationBaseline.cutoffAt),
              kind: 'manual',
              now,
            })
          : preview;
        activationBaseline = closeActivationBaseline(baselinePreview);
      }
      const currentHash = await closePreviewHash({ preview, recipients, activationBaseline });
      const expectedConfirmation = `CLOSE ${preview.cutoffAt} ${currentHash
        .slice(0, 12)
        .toUpperCase()}`;
      if (
        parsed.data.previewHash !== currentHash ||
        parsed.data.confirmation !== expectedConfirmation
      ) {
        return context.json(
          {
            error: 'The close preview changed or the confirmation did not match. Preview it again.',
          },
          409,
        );
      }
      const result = await runManualFridayClose({
        db: context.env.DB,
        recipients,
        actorUserId: context.get('actor').id,
        cutoff,
        confirmationCutoff: cutoff.toISOString(),
        expectedSourceHash: preview.sourceHash,
        expectedActivationSourceHash: activationBaseline?.sourceHash,
        reason: parsed.data.reason,
      });
      return context.json(result);
    } catch (error) {
      return context.json(
        { error: error instanceof Error ? error.message : 'Unable to close this period.' },
        409,
      );
    }
  });

  app.get('/api/reports/weekly.xlsx', async (context) => {
    const denied = requireReportAccess(context);
    if (denied) return denied;
    const requested = context.req.query('weekStart');
    if (requested && !dateSchema.safeParse(requested).success)
      return context.json({ error: 'Invalid week date.' }, 400);
    const range = getWeekRange(requested);
    const report = await buildWeeklyWorkbook(
      new D1TimeStore(context.env.DB),
      range.weekStart,
      new Date(),
      await new D1PriorityStore(context.env.DB).list(),
      await new D1ScheduleStore(context.env.DB).listOccurrences(range.weekStart),
    );
    return new Response(Uint8Array.from(report.buffer).buffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${report.filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  });
  app.get('/api/reports/client.pdf', async (context) => {
    const denied = requireReportAccess(context);
    if (denied) return denied;
    const parsed = z.object({ clientId: idSchema, from: dateSchema, to: dateSchema }).safeParse({
      clientId: context.req.query('clientId'),
      from: context.req.query('from'),
      to: context.req.query('to'),
    });
    if (!parsed.success)
      return context.json({ error: 'Choose a valid client, start date and end date.' }, 400);
    const from = parseLocalDate(parsed.data.from);
    const toInclusive = parseLocalDate(parsed.data.to);
    if (toInclusive < from)
      return context.json({ error: 'The end date must not precede the start date.' }, 400);
    if (toInclusive.diff(from, 'days').days > 366)
      return context.json({ error: 'Choose a range of 366 days or less.' }, 400);

    const store = new D1TimeStore(context.env.DB);
    const client = (await store.listClients()).find((item) => item.id === parsed.data.clientId);
    if (!client) return context.json({ error: 'Client not found.' }, 404);
    const range = {
      from: from.toUTC().toJSDate(),
      to: toInclusive.plus({ days: 1 }).toUTC().toJSDate(),
    };
    const entries = (
      await store.listEntries({
        ...range,
        clientId: client.id,
        workType: 'client',
        billable: true,
      })
    ).filter((entry) => entry.endAt !== null);
    if (!entries.length)
      return context.json(
        { error: 'No completed billable time was found for this client and date range.' },
        422,
      );

    const logoResponse = await context.env.ASSETS.fetch(
      new Request(new URL('/brand/va-logo.png', context.req.url)),
    );
    const logo =
      logoResponse.ok && logoResponse.headers.get('content-type')?.startsWith('image/png')
        ? new Uint8Array(await logoResponse.arrayBuffer())
        : undefined;
    const report = await buildClientTimePdf({
      client,
      entries,
      ...range,
      fromDate: parsed.data.from,
      toDate: parsed.data.to,
      logo,
    });
    return new Response(Uint8Array.from(report.buffer).buffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${report.filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  });
  app.get('/api/reports/finalized', async (context) => {
    const denied = requireReportAccess(context);
    if (denied) return denied;
    return context.json({ reports: await new D1FinalizedReportStore(context.env.DB).list() });
  });
  app.get('/api/reports/finalized/:weekStart', async (context) => {
    const denied = requireReportAccess(context);
    if (denied) return denied;
    const weekStart = context.req.param('weekStart');
    if (!dateSchema.safeParse(weekStart).success)
      return context.json({ error: 'Invalid report week.' }, 400);
    const report = await new D1FinalizedReportStore(context.env.DB).get(weekStart);
    if (!report) return context.json({ error: 'Finalized report not found.' }, 404);
    const content = Uint8Array.from(report.content).buffer;
    return new Response(content, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${report.filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  });
  app.get('/api/reports/closed', async (context) => {
    const denied = requireReportAccess(context);
    if (denied) return denied;
    const reports = await context.env.DB.prepare(
      `SELECT r.id, r.version, r.supersedes_report_id, r.snapshot_sha256,
        r.entry_count, r.total_ms, r.correction_reason, r.created_at,
        p.coverage_from, p.cutoff_at, p.kind,
        COALESCE(SUM(CASE WHEN d.state IN ('queued','leased') THEN 1 ELSE 0 END),0) AS queued,
        COALESCE(SUM(CASE WHEN d.state='provider_accepted' THEN 1 ELSE 0 END),0) AS provider_accepted,
        COALESCE(SUM(CASE WHEN d.state='failed' THEN 1 ELSE 0 END),0) AS failed,
        COALESCE(SUM(CASE WHEN d.state='needs_attention' THEN 1 ELSE 0 END),0) AS needs_attention,
        COUNT(d.id) AS deliveries
       FROM report_versions r
       JOIN close_periods p ON p.id=r.close_period_id
       LEFT JOIN report_delivery_outbox d ON d.report_id=r.id
       GROUP BY r.id
       ORDER BY p.cutoff_at DESC, r.version DESC
       LIMIT 100`,
    ).all<{
      id: string;
      version: number;
      supersedes_report_id: string | null;
      snapshot_sha256: string;
      entry_count: number;
      total_ms: number;
      correction_reason: string;
      created_at: number;
      coverage_from: number;
      cutoff_at: number;
      kind: string;
      queued: number;
      provider_accepted: number;
      failed: number;
      needs_attention: number;
      deliveries: number;
    }>();
    return context.json({
      reports: reports.results.map((row) => ({
        id: row.id,
        version: row.version,
        supersedesReportId: row.supersedes_report_id,
        snapshotSha256: row.snapshot_sha256,
        entryCount: row.entry_count,
        totalMs: row.total_ms,
        correctionReason: row.correction_reason,
        createdAt: new Date(row.created_at).toISOString(),
        coverageFrom: new Date(row.coverage_from).toISOString(),
        cutoffAt: new Date(row.cutoff_at).toISOString(),
        kind: row.kind,
        delivery: {
          queued: row.queued,
          providerAccepted: row.provider_accepted,
          failed: row.failed,
          needsAttention: row.needs_attention,
          total: row.deliveries,
        },
      })),
    });
  });
  app.get('/api/reports/closed/:reportId/:format', async (context) => {
    const denied = requireReportAccess(context);
    if (denied) return denied;
    const reportId = idSchema.safeParse(context.req.param('reportId'));
    const format = z.enum(['pdf', 'csv', 'xlsx']).safeParse(context.req.param('format'));
    if (!reportId.success || !format.success)
      return context.json({ error: 'Invalid report artifact.' }, 400);
    const artifact = await context.env.DB.prepare(
      `SELECT filename, content, content_sha256
       FROM report_artifacts WHERE report_id=? AND format=?`,
    )
      .bind(reportId.data, format.data)
      .first<{ filename: string; content: ArrayBuffer; content_sha256: string }>();
    if (!artifact) return context.json({ error: 'Report artifact not found.' }, 404);
    const content = new Uint8Array(artifact.content);
    if ((await sha256Hex(content)) !== artifact.content_sha256)
      return context.json({ error: 'This saved report failed its integrity check.' }, 409);
    const contentTypes = {
      pdf: 'application/pdf',
      csv: 'text/csv; charset=utf-8',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    } as const;
    return new Response(content, {
      headers: {
        'Content-Type': contentTypes[format.data],
        'Content-Disposition': `attachment; filename="${artifact.filename.replaceAll('"', '')}"`,
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
      weekStart: getWeekRange(parsed.data.weekStart).weekStart,
      type: 'test',
      priorities: await new D1PriorityStore(context.env.DB).list(),
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
  const weekStart = previousWeekStart(now);
  const recipients = reportRecipientList(env);
  return sendWeeklyReport({
    store: new D1TimeStore(env.DB, () => now),
    mailer: createResendSender(env.RESEND_API_KEY),
    from: env.EMAIL_FROM,
    recipient: recipients.length ? recipients : env.WEEKLY_REPORT_RECIPIENT,
    weekStart,
    type: 'scheduled',
    now,
    priorities: await new D1PriorityStore(env.DB, () => now).list(),
    schedule: await new D1ScheduleStore(env.DB, () => now).listOccurrences(weekStart),
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
export async function runScheduledFinalization(env: Env, scheduledTime = Date.now()) {
  return finalizeWeeklyReport({
    db: env.DB,
    mailer: createResendSender(env.RESEND_API_KEY),
    from: env.EMAIL_FROM,
    recipients: reportRecipientList(env),
    now: new Date(scheduledTime),
  });
}
export async function runScheduledScheduleGeneration(env: Env) {
  return new D1ScheduleStore(env.DB).generateAll();
}
export async function runScheduledFridayClose(env: Env, scheduledTime = Date.now()) {
  return runScheduledFridayCloses({
    db: env.DB,
    recipients: reportRecipientList(env),
    now: new Date(scheduledTime),
  });
}
export async function runScheduledReportDeliveries(env: Env, scheduledTime = Date.now()) {
  return processReportDeliveryOutbox({
    db: env.DB,
    mailer: createResendReportSender(env.RESEND_API_KEY),
    from: env.EMAIL_FROM,
    now: new Date(scheduledTime),
  });
}
export async function runScheduledReportRecovery(env: Env, scheduledTime = Date.now()) {
  const recovery = runScheduledFridayCloses({
    db: env.DB,
    recipients: reportRecipientList(env),
    now: new Date(scheduledTime),
  });
  const [result] = await Promise.allSettled([recovery]);
  if (result.status === 'rejected')
    console.error(
      JSON.stringify({
        event: 'friday_close_recovery_failed',
        message: result.reason instanceof Error ? result.reason.message : 'unknown',
      }),
    );
  return result;
}
export async function runScheduledXeroProjects(env: Env, scheduledTime = Date.now()) {
  if (env.XERO_ENABLED !== 'true') return { skipped: true as const, reason: 'disabled' as const };
  const current = await xeroProjectsConnection(env.DB);
  if (!current?.connected) return { skipped: true as const, reason: 'disconnected' as const };
  if (current.paused) return { skipped: true as const, reason: 'paused' as const };
  const now = scheduledTime;
  const [uploads, statuses] = await Promise.allSettled([
    processUploadBatch(env, 10, fetch, now),
    refreshAcceptedStatuses(env, 25, fetch, now),
  ]);
  if (uploads.status === 'rejected')
    console.error(
      JSON.stringify({
        event: 'xero_projects_upload_batch_failed',
        message: uploads.reason instanceof Error ? uploads.reason.message : 'unknown',
      }),
    );
  if (statuses.status === 'rejected')
    console.error(
      JSON.stringify({
        event: 'xero_projects_status_batch_failed',
        message: statuses.reason instanceof Error ? statuses.reason.message : 'unknown',
      }),
    );
  return { skipped: false as const, uploads, statuses };
}
export async function runScheduledXeroCatalogue(env: Env, scheduledTime = Date.now()) {
  if (env.XERO_ENABLED !== 'true') return { skipped: true as const, reason: 'disabled' as const };
  const current = await xeroProjectsConnection(env.DB);
  if (!current?.connected) return { skipped: true as const, reason: 'disconnected' as const };
  const result = await refreshCatalogue(
    env,
    {
      id: 'system:xero-catalogue',
      email: 'automation@versatileaccounting.com.au',
      displayName: 'Xero catalogue automation',
      role: 'admin',
    },
    fetch,
    scheduledTime,
  );
  return { skipped: false as const, result };
}
export async function runScheduledDurableOutboxes(env: Env, scheduledTime = Date.now()) {
  await runScheduledReportRecovery(env, scheduledTime);
  return Promise.allSettled([
    runScheduledReportDeliveries(env, scheduledTime),
    runScheduledXeroProjects(env, scheduledTime),
  ]);
}
export default {
  fetch: app.fetch,
  scheduled(controller, env, context) {
    if (controller.cron === '0 10 * * FRI')
      context.waitUntil(runScheduledFridayClose(env, controller.scheduledTime));
    else if (controller.cron === '5 14 * * SUN')
      context.waitUntil(runScheduledReport(env, controller.scheduledTime));
    else if (controller.cron === '5 14 * * *')
      context.waitUntil(runScheduledScheduleGeneration(env));
    else if (controller.cron === '15 16 * * *')
      context.waitUntil(
        Promise.allSettled([
          runScheduledFyiSync(env),
          runScheduledXeroCatalogue(env, controller.scheduledTime),
        ]),
      );
    else context.waitUntil(runScheduledDurableOutboxes(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
