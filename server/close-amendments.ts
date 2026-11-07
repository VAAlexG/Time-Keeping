import { saveCloseReportVersion } from './close-report';

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60_000;

export type CloseAmendmentStatus = 'open' | 'finalizing' | 'closed' | 'revoked';

interface WindowRow {
  id: string;
  close_period_id: string;
  user_id: string;
  user_email: string;
  user_display_name: string;
  status: CloseAmendmentStatus;
  reason: string;
  opened_by_user_id: string;
  finalized_by_user_id: string | null;
  coverage_from: number;
  cutoff_at: number;
  opened_at: number;
  expires_at: number | null;
  finalizing_at: number | null;
  finalize_reason: string | null;
  closed_at: number | null;
  report_id: string | null;
  draft_entry_count: number;
  draft_total_ms: number;
}

interface ReportRow {
  id: string;
  version: number;
  entry_count: number;
  total_ms: number;
  created_at: number;
}

export interface CloseAmendmentWindow {
  id: string;
  closePeriodId: string;
  userId: string;
  userEmail: string;
  userDisplayName: string;
  status: CloseAmendmentStatus;
  reason: string;
  coverageFrom: string;
  cutoffAt: string;
  openedAt: string;
  expiresAt: string | null;
  finalizingAt: string | null;
  closedAt: string | null;
  draftEntryCount: number;
  draftTotalMs: number;
  reportId: string | null;
}

export interface CloseAmendmentReportSummary {
  id: string;
  version: number;
  entryCount: number;
  totalMs: number;
  createdAt: string;
}

export class CloseAmendmentProblem extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 503 = 409,
  ) {
    super(message);
    this.name = 'CloseAmendmentProblem';
  }
}

const WINDOW_SELECT = `SELECT w.id, w.close_period_id, w.user_id,
  u.email AS user_email, u.display_name AS user_display_name,
  w.status, w.reason, w.opened_by_user_id, w.finalized_by_user_id,
  p.coverage_from, p.cutoff_at, w.opened_at, w.expires_at,
  w.finalizing_at, w.finalize_reason, w.closed_at, w.report_id,
  COUNT(e.id) AS draft_entry_count,
  COALESCE(SUM(CASE WHEN e.end_at IS NOT NULL THEN e.end_at - e.start_at ELSE 0 END), 0)
    AS draft_total_ms
 FROM close_amendment_windows w
 JOIN close_periods p ON p.id = w.close_period_id
 JOIN users u ON u.id = w.user_id
 LEFT JOIN time_entries e ON e.amendment_window_id = w.id`;

const iso = (value: number) => new Date(value).toISOString();
const optionalIso = (value: number | null) => (value === null ? null : iso(value));

function windowFromRow(row: WindowRow): CloseAmendmentWindow {
  return {
    id: row.id,
    closePeriodId: row.close_period_id,
    userId: row.user_id,
    userEmail: row.user_email,
    userDisplayName: row.user_display_name,
    status: row.status,
    reason: row.reason,
    coverageFrom: iso(row.coverage_from),
    cutoffAt: iso(row.cutoff_at),
    openedAt: iso(row.opened_at),
    expiresAt: optionalIso(row.expires_at),
    finalizingAt: optionalIso(row.finalizing_at),
    closedAt: optionalIso(row.closed_at),
    draftEntryCount: row.draft_entry_count,
    draftTotalMs: row.draft_total_ms,
    reportId: row.report_id,
  };
}

function reportFromRow(row: ReportRow): CloseAmendmentReportSummary {
  return {
    id: row.id,
    version: row.version,
    entryCount: row.entry_count,
    totalMs: row.total_ms,
    createdAt: iso(row.created_at),
  };
}

function normalizeReason(value: string, purpose: string): string {
  const normalized = value.trim();
  if (normalized.length < 5 || normalized.length > 1000)
    throw new CloseAmendmentProblem(
      'AMENDMENT_REASON_REQUIRED',
      `A ${purpose} reason between 5 and 1,000 characters is required.`,
      400,
    );
  return normalized;
}

async function windowById(db: D1Database, id: string): Promise<CloseAmendmentWindow | null> {
  const row = await db
    .prepare(`${WINDOW_SELECT} WHERE w.id = ? GROUP BY w.id LIMIT 1`)
    .bind(id)
    .first<WindowRow>();
  return row ? windowFromRow(row) : null;
}

async function reportById(db: D1Database, id: string): Promise<CloseAmendmentReportSummary | null> {
  const row = await db
    .prepare(
      `SELECT id, version, entry_count, total_ms, created_at
       FROM report_versions WHERE id = ?`,
    )
    .bind(id)
    .first<ReportRow>();
  return row ? reportFromRow(row) : null;
}

async function reportByWindow(
  db: D1Database,
  id: string,
): Promise<CloseAmendmentReportSummary | null> {
  const row = await db
    .prepare(
      `SELECT id, version, entry_count, total_ms, created_at
       FROM report_versions WHERE amendment_window_id = ? LIMIT 1`,
    )
    .bind(id)
    .first<ReportRow>();
  return row ? reportFromRow(row) : null;
}

export async function getCurrentCloseAmendment(
  db: D1Database,
  userId: string,
  now = new Date(),
): Promise<CloseAmendmentWindow | null> {
  const row = await db
    .prepare(
      `${WINDOW_SELECT}
       WHERE w.user_id = ? AND (
         w.status = 'finalizing' OR
         (w.status = 'open' AND (w.expires_at IS NULL OR w.expires_at >= ?))
       )
       GROUP BY w.id ORDER BY w.opened_at DESC LIMIT 1`,
    )
    .bind(userId, now.getTime())
    .first<WindowRow>();
  return row ? windowFromRow(row) : null;
}

export async function listCloseAmendmentAdminData(db: D1Database): Promise<{
  periods: Array<{
    id: string;
    coverageFrom: string;
    cutoffAt: string;
    entryCount: number;
    totalMs: number;
    status: string;
    latestReportVersion: number;
  }>;
  users: Array<{ id: string; email: string; displayName: string }>;
  windows: CloseAmendmentWindow[];
}> {
  const [periodRows, userRows, windowRows] = await Promise.all([
    db
      .prepare(
        `SELECT p.id, p.coverage_from, p.cutoff_at, p.entry_count, p.total_ms, p.status,
          MAX(r.version) AS latest_report_version
         FROM close_periods p JOIN report_versions r ON r.close_period_id = p.id
         WHERE p.status IN ('closed', 'report_failed')
           AND NOT EXISTS (
             SELECT 1 FROM locked_entry_corrections c
             WHERE c.close_period_id = p.id AND c.revised_report_id IS NULL
           )
         GROUP BY p.id ORDER BY p.cutoff_at DESC LIMIT 52`,
      )
      .all<{
        id: string;
        coverage_from: number;
        cutoff_at: number;
        entry_count: number;
        total_ms: number;
        status: string;
        latest_report_version: number;
      }>(),
    db
      .prepare('SELECT id, email, display_name FROM users ORDER BY display_name, email')
      .all<{ id: string; email: string; display_name: string }>(),
    db
      .prepare(`${WINDOW_SELECT} GROUP BY w.id ORDER BY w.opened_at DESC LIMIT 100`)
      .all<WindowRow>(),
  ]);
  return {
    periods: periodRows.results.map((row) => ({
      id: row.id,
      coverageFrom: iso(row.coverage_from),
      cutoffAt: iso(row.cutoff_at),
      entryCount: row.entry_count,
      totalMs: row.total_ms,
      status: row.status,
      latestReportVersion: row.latest_report_version,
    })),
    users: userRows.results.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
    })),
    windows: windowRows.results.map(windowFromRow),
  };
}

export async function openCloseAmendmentWindow(input: {
  db: D1Database;
  closePeriodId: string;
  userId: string;
  actorUserId: string;
  reason: string;
  expiresAt?: Date;
  now?: Date;
}): Promise<CloseAmendmentWindow> {
  const now = input.now ?? new Date();
  const timestamp = now.getTime();
  const openReason = normalizeReason(input.reason, 'window-opening');
  const expiresAt = input.expiresAt?.getTime() ?? timestamp + DEFAULT_WINDOW_MS;
  if (!Number.isFinite(expiresAt) || expiresAt <= timestamp)
    throw new CloseAmendmentProblem(
      'AMENDMENT_EXPIRY_INVALID',
      'The amendment window expiry must be in the future.',
      400,
    );

  const [period, user] = await Promise.all([
    input.db
      .prepare(
        `SELECT p.id FROM close_periods p
         WHERE p.id = ? AND p.status IN ('closed', 'report_failed')
           AND EXISTS (SELECT 1 FROM report_versions r WHERE r.close_period_id = p.id)
           AND NOT EXISTS (
             SELECT 1 FROM locked_entry_corrections c
             WHERE c.close_period_id = p.id AND c.revised_report_id IS NULL
           )`,
      )
      .bind(input.closePeriodId)
      .first<{ id: string }>(),
    input.db
      .prepare('SELECT id FROM users WHERE id = ?')
      .bind(input.userId)
      .first<{ id: string }>(),
  ]);
  if (!period)
    throw new CloseAmendmentProblem(
      'AMENDMENT_PERIOD_NOT_PUBLISHED',
      'Choose a published closed period without a pending locked-entry correction.',
      400,
    );
  if (!user)
    throw new CloseAmendmentProblem('AMENDMENT_USER_NOT_FOUND', 'Employee not found.', 404);

  const existingRows = await input.db
    .prepare(
      `SELECT id, close_period_id, user_id, status, expires_at,
        (SELECT COUNT(*) FROM time_entries e WHERE e.amendment_window_id = w.id) AS entry_count
       FROM close_amendment_windows w
       WHERE (user_id = ? OR close_period_id = ?) AND status IN ('open', 'finalizing')
       ORDER BY opened_at DESC LIMIT 2`,
    )
    .bind(input.userId, input.closePeriodId)
    .all<{
      id: string;
      close_period_id: string;
      user_id: string;
      status: 'open' | 'finalizing';
      expires_at: number | null;
      entry_count: number;
    }>();
  for (const existing of existingRows.results) {
    const live = existing.status === 'finalizing' || (existing.expires_at ?? Infinity) >= timestamp;
    if (
      live &&
      existing.close_period_id === input.closePeriodId &&
      existing.user_id === input.userId
    )
      return (await windowById(input.db, existing.id))!;
    if (live && existing.close_period_id === input.closePeriodId)
      throw new CloseAmendmentProblem(
        'AMENDMENT_PERIOD_ALREADY_ACTIVE',
        'This closed period already has an active amendment window for another employee.',
      );
    if (live)
      throw new CloseAmendmentProblem(
        'AMENDMENT_USER_ALREADY_ACTIVE',
        'This employee already has an active amendment window for another closed period.',
      );
    if (existing.entry_count)
      throw new CloseAmendmentProblem(
        'AMENDMENT_WINDOW_EXPIRED',
        'An expired window still has draft time. Finalize it before opening another window.',
      );
  }

  const id = crypto.randomUUID();
  const details = JSON.stringify({
    closePeriodId: input.closePeriodId,
    userId: input.userId,
    reason: openReason,
    expiresAt: iso(expiresAt),
  });
  const statements: D1PreparedStatement[] = [];
  for (const existing of existingRows.results) {
    statements.push(
      input.db
        .prepare(
          `UPDATE close_transaction_guard
           SET asserted = CASE WHEN EXISTS (
             SELECT 1 FROM close_amendment_windows w
             WHERE w.id = ? AND w.status = 'open' AND w.expires_at < ?
               AND NOT EXISTS (SELECT 1 FROM time_entries e WHERE e.amendment_window_id = w.id)
           ) THEN 1 ELSE 0 END WHERE id = 1`,
        )
        .bind(existing.id, timestamp),
      input.db
        .prepare(
          `UPDATE close_amendment_windows
           SET status = 'revoked', closed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'open'`,
        )
        .bind(timestamp, timestamp, existing.id),
      input.db
        .prepare(
          `INSERT INTO close_amendment_audit
           (id, window_id, actor_user_id, action, entry_id, details_json, created_at)
           VALUES (?, ?, ?, 'window.revoked', NULL, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          existing.id,
          input.actorUserId,
          JSON.stringify({ reason: 'Expired without draft entries; replaced.' }),
          timestamp,
        ),
    );
  }
  statements.push(
    input.db
      .prepare(
        `INSERT INTO close_amendment_windows
         (id, close_period_id, user_id, status, reason, opened_by_user_id,
          opened_at, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.closePeriodId,
        input.userId,
        openReason,
        input.actorUserId,
        timestamp,
        expiresAt,
        timestamp,
        timestamp,
      ),
    input.db
      .prepare(
        `INSERT INTO close_amendment_audit
         (id, window_id, actor_user_id, action, entry_id, details_json, created_at)
         VALUES (?, ?, ?, 'window.opened', NULL, ?, ?)`,
      )
      .bind(crypto.randomUUID(), id, input.actorUserId, details, timestamp),
    input.db
      .prepare(
        `INSERT INTO close_audit
         (id, actor_user_id, action, entity_id, details_json, created_at)
         VALUES (?, ?, 'amendment.opened', ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), input.actorUserId, id, details, timestamp),
  );
  try {
    await input.db.batch(statements);
  } catch (error) {
    const concurrentRows = await input.db
      .prepare(
        `SELECT id, close_period_id, user_id FROM close_amendment_windows
         WHERE (user_id = ? OR close_period_id = ?)
           AND status IN ('open', 'finalizing') LIMIT 2`,
      )
      .bind(input.userId, input.closePeriodId)
      .all<{ id: string; close_period_id: string; user_id: string }>();
    const same = concurrentRows.results.find(
      (row) => row.close_period_id === input.closePeriodId && row.user_id === input.userId,
    );
    if (same) return (await windowById(input.db, same.id))!;
    if (concurrentRows.results.some((row) => row.close_period_id === input.closePeriodId))
      throw new CloseAmendmentProblem(
        'AMENDMENT_PERIOD_ALREADY_ACTIVE',
        'This closed period already has an active amendment window for another employee.',
      );
    if (concurrentRows.results.length)
      throw new CloseAmendmentProblem(
        'AMENDMENT_USER_ALREADY_ACTIVE',
        'This employee already has an active amendment window for another closed period.',
      );
    if (error instanceof Error && error.message.includes('AMENDMENT_PERIOD_NOT_PUBLISHED'))
      throw new CloseAmendmentProblem(
        'AMENDMENT_CORRECTION_CONFLICT',
        'A locked-entry correction is already pending for this period. Finish that report first.',
      );
    throw error;
  }
  return (await windowById(input.db, id))!;
}

async function finishFinalizingWindow(input: {
  db: D1Database;
  windowId: string;
  recipients: string[];
  now: Date;
}): Promise<{ window: CloseAmendmentWindow; report: CloseAmendmentReportSummary }> {
  const state = await input.db
    .prepare(
      `SELECT w.id, w.close_period_id, w.status, w.finalized_by_user_id,
        w.finalize_reason, w.report_id, p.suppress_delivery
       FROM close_amendment_windows w
       JOIN close_periods p ON p.id = w.close_period_id
       WHERE w.id = ?`,
    )
    .bind(input.windowId)
    .first<{
      id: string;
      close_period_id: string;
      status: CloseAmendmentStatus;
      finalized_by_user_id: string | null;
      finalize_reason: string | null;
      report_id: string | null;
      suppress_delivery: number;
    }>();
  if (!state)
    throw new CloseAmendmentProblem(
      'AMENDMENT_WINDOW_NOT_FOUND',
      'Amendment window not found.',
      404,
    );
  if (state.status === 'closed' && state.report_id) {
    const report = await reportById(input.db, state.report_id);
    if (!report)
      throw new CloseAmendmentProblem(
        'AMENDMENT_REPORT_MISSING',
        'The revised report record could not be found.',
        503,
      );
    return { window: (await windowById(input.db, state.id))!, report };
  }
  if (state.status !== 'finalizing' || !state.finalized_by_user_id || !state.finalize_reason)
    throw new CloseAmendmentProblem(
      'AMENDMENT_STATE_CONFLICT',
      'This amendment window is not ready to finalize.',
    );

  let report = await reportByWindow(input.db, state.id);
  if (!report) {
    try {
      const saved = await saveCloseReportVersion({
        db: input.db,
        periodId: state.close_period_id,
        recipients: input.recipients,
        suppressDelivery: Boolean(state.suppress_delivery),
        correctionReason: `Late-entry amendment: ${state.finalize_reason}`.slice(0, 1000),
        createdByUserId: state.finalized_by_user_id,
        amendmentWindowId: state.id,
        now: input.now,
      });
      report = {
        id: saved.id,
        version: saved.version,
        entryCount: saved.snapshot.totals.entryCount,
        totalMs: saved.snapshot.totals.totalMs,
        createdAt: saved.snapshot.generatedAt,
      };
    } catch {
      // A concurrent finalizer may have committed the uniquely linked report
      // after our preflight. Converge on that row instead of creating v+1.
      report = await reportByWindow(input.db, state.id);
      if (!report)
        throw new CloseAmendmentProblem(
          'AMENDMENT_REPORT_PENDING',
          'The entries are safely locked, but the revised report is still being prepared. Recovery will retry automatically.',
          503,
        );
    }
  }

  const timestamp = input.now.getTime();
  const details = JSON.stringify({ reportId: report.id, reportVersion: report.version });
  try {
    await input.db.batch([
      input.db
        .prepare(
          `UPDATE close_transaction_guard
           SET asserted = CASE WHEN EXISTS (
             SELECT 1 FROM close_amendment_windows w
             JOIN report_versions r ON r.id = ? AND r.amendment_window_id = w.id
             WHERE w.id = ? AND w.status = 'finalizing' AND w.report_id IS NULL
           ) THEN 1 ELSE 0 END WHERE id = 1`,
        )
        .bind(report.id, state.id),
      input.db
        .prepare(
          `UPDATE close_amendment_windows
           SET status = 'closed', report_id = ?, closed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'finalizing' AND report_id IS NULL`,
        )
        .bind(report.id, timestamp, timestamp, state.id),
      input.db
        .prepare(
          `INSERT INTO close_amendment_audit
           (id, window_id, actor_user_id, action, entry_id, details_json, created_at)
           SELECT ?, id, finalized_by_user_id, 'window.closed', NULL, ?, ?
           FROM close_amendment_windows
           WHERE id = ? AND status = 'closed' AND report_id = ?`,
        )
        .bind(crypto.randomUUID(), details, timestamp, state.id, report.id),
      input.db
        .prepare(
          `INSERT INTO close_audit
           (id, actor_user_id, action, entity_id, details_json, created_at)
           SELECT ?, finalized_by_user_id, 'amendment.closed', id, ?, ?
           FROM close_amendment_windows
           WHERE id = ? AND status = 'closed' AND report_id = ?`,
        )
        .bind(crypto.randomUUID(), details, timestamp, state.id, report.id),
    ]);
  } catch (error) {
    const concurrent = await windowById(input.db, state.id);
    if (concurrent?.status !== 'closed' || concurrent.reportId !== report.id) throw error;
  }
  return { window: (await windowById(input.db, state.id))!, report };
}

export async function finalizeCloseAmendmentWindow(input: {
  db: D1Database;
  windowId: string;
  actorUserId: string;
  reason: string;
  recipients: string[];
  now?: Date;
}): Promise<{ window: CloseAmendmentWindow; report: CloseAmendmentReportSummary }> {
  const now = input.now ?? new Date();
  const finalizeReason = normalizeReason(input.reason, 'finalization');
  const state = await input.db
    .prepare(
      `SELECT w.id, w.close_period_id, w.user_id, w.status, w.report_id,
        COUNT(e.id) AS draft_count,
        COALESCE(SUM(CASE WHEN e.end_at IS NOT NULL THEN e.end_at - e.start_at ELSE 0 END), 0)
          AS draft_total_ms
       FROM close_amendment_windows w
       LEFT JOIN time_entries e ON e.amendment_window_id = w.id
       WHERE w.id = ? GROUP BY w.id`,
    )
    .bind(input.windowId)
    .first<{
      id: string;
      close_period_id: string;
      user_id: string;
      status: CloseAmendmentStatus;
      report_id: string | null;
      draft_count: number;
      draft_total_ms: number;
    }>();
  if (!state)
    throw new CloseAmendmentProblem(
      'AMENDMENT_WINDOW_NOT_FOUND',
      'Amendment window not found.',
      404,
    );
  if (state.status === 'revoked')
    throw new CloseAmendmentProblem(
      'AMENDMENT_WINDOW_REVOKED',
      'This amendment window has been revoked.',
    );
  if (state.status === 'closed' || state.status === 'finalizing')
    return finishFinalizingWindow({
      db: input.db,
      windowId: state.id,
      recipients: input.recipients,
      now,
    });
  if (!state.draft_count)
    throw new CloseAmendmentProblem(
      'AMENDMENT_NO_DRAFT_ENTRIES',
      'Add at least one completed time entry before finalizing this window.',
      400,
    );

  const timestamp = now.getTime();
  const details = JSON.stringify({
    reason: finalizeReason,
    draftEntryCount: state.draft_count,
    draftTotalMs: state.draft_total_ms,
  });
  try {
    await input.db.batch([
      input.db
        .prepare(
          `UPDATE close_transaction_guard
           SET asserted = CASE WHEN EXISTS (
             SELECT 1 FROM close_amendment_windows w
             JOIN close_periods p ON p.id = w.close_period_id
             WHERE w.id = ? AND w.status = 'open'
               AND p.status IN ('closed', 'report_failed')
               AND EXISTS (SELECT 1 FROM report_versions r WHERE r.close_period_id = p.id)
               AND NOT EXISTS (
                 SELECT 1 FROM locked_entry_corrections c
                 WHERE c.close_period_id = p.id AND c.revised_report_id IS NULL
               )
               AND (SELECT COUNT(*) FROM time_entries e
                    WHERE e.amendment_window_id = w.id) = ?
               AND (SELECT COALESCE(SUM(e.end_at - e.start_at), 0)
                    FROM time_entries e WHERE e.amendment_window_id = w.id) = ?
               AND NOT EXISTS (
                 SELECT 1 FROM time_entries e
                 WHERE e.amendment_window_id = w.id
                   AND (e.user_id <> w.user_id OR e.locked_at IS NOT NULL
                     OR e.close_period_id IS NOT NULL OR e.end_at IS NULL
                     OR e.end_at <= e.start_at OR e.start_at < p.coverage_from
                     OR e.end_at > p.cutoff_at
                     OR date(e.start_at / 1000, 'unixepoch', '+10 hours') <>
                        date((e.end_at - 1) / 1000, 'unixepoch', '+10 hours'))
               )
           ) THEN 1 ELSE 0 END WHERE id = 1`,
        )
        .bind(state.id, state.draft_count, state.draft_total_ms),
      input.db
        .prepare(
          `UPDATE close_amendment_windows
           SET status = 'finalizing', finalized_by_user_id = ?, finalizing_at = ?,
             finalize_reason = ?, updated_at = ?
           WHERE id = ? AND status = 'open'`,
        )
        .bind(input.actorUserId, timestamp, finalizeReason, timestamp, state.id),
      input.db
        .prepare(
          `UPDATE time_entries
           SET locked_at = ?, close_period_id = ?, revision = revision + 1, updated_at = ?
           WHERE amendment_window_id = ? AND locked_at IS NULL AND close_period_id IS NULL`,
        )
        .bind(timestamp, state.close_period_id, timestamp, state.id),
      input.db
        .prepare(
          `UPDATE close_periods
           SET entry_count = (SELECT COUNT(*) FROM time_entries WHERE close_period_id = ?),
             total_ms = (SELECT COALESCE(SUM(end_at - start_at), 0)
                         FROM time_entries WHERE close_period_id = ?),
             source_revision = source_revision + 1, updated_at = ?
           WHERE id = ? AND status IN ('closed', 'report_failed')`,
        )
        .bind(state.close_period_id, state.close_period_id, timestamp, state.close_period_id),
      input.db
        .prepare(
          `UPDATE report_delivery_outbox
           SET state = 'needs_attention', lease_token = NULL, lease_until = 0,
             last_error = 'Superseded by late-entry amendment', updated_at = ?
           WHERE report_id IN (
             SELECT id FROM report_versions WHERE close_period_id = ?
           ) AND state IN ('queued', 'leased', 'failed')`,
        )
        .bind(timestamp, state.close_period_id),
      input.db
        .prepare(
          `INSERT INTO close_amendment_audit
           (id, window_id, actor_user_id, action, entry_id, details_json, created_at)
           VALUES (?, ?, ?, 'window.finalizing', NULL, ?, ?)`,
        )
        .bind(crypto.randomUUID(), state.id, input.actorUserId, details, timestamp),
      input.db
        .prepare(
          `INSERT INTO close_audit
           (id, actor_user_id, action, entity_id, details_json, created_at)
           VALUES (?, ?, 'amendment.finalizing', ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), input.actorUserId, state.id, details, timestamp),
    ]);
  } catch {
    const concurrent = await windowById(input.db, state.id);
    if (concurrent?.status !== 'finalizing' && concurrent?.status !== 'closed')
      throw new CloseAmendmentProblem(
        'AMENDMENT_CONFLICT',
        'The amendment drafts changed while finalization started. Reload and try again.',
      );
  }
  return finishFinalizingWindow({
    db: input.db,
    windowId: state.id,
    recipients: input.recipients,
    now,
  });
}

export async function recoverFinalizingCloseAmendments(input: {
  db: D1Database;
  recipients: string[];
  now?: Date;
}): Promise<{
  recovered: Array<{ window: CloseAmendmentWindow; report: CloseAmendmentReportSummary }>;
  failed: Array<{ windowId: string; code: string }>;
}> {
  const now = input.now ?? new Date();
  const rows = await input.db
    .prepare(
      `SELECT id FROM close_amendment_windows
       WHERE status = 'finalizing' ORDER BY finalizing_at LIMIT 20`,
    )
    .all<{ id: string }>();
  const recovered: Array<{
    window: CloseAmendmentWindow;
    report: CloseAmendmentReportSummary;
  }> = [];
  const failed: Array<{ windowId: string; code: string }> = [];
  for (const row of rows.results) {
    try {
      recovered.push(
        await finishFinalizingWindow({
          db: input.db,
          windowId: row.id,
          recipients: input.recipients,
          now,
        }),
      );
    } catch (error) {
      failed.push({
        windowId: row.id,
        code: error instanceof CloseAmendmentProblem ? error.code : 'AMENDMENT_RECOVERY_FAILED',
      });
    }
  }
  return { recovered, failed };
}
