import { DateTime } from 'luxon';

import { saveCloseReportVersion, sha256Hex, type SavedCloseReport } from './close-report';
import { BRISBANE_ZONE, fridayCutoffsBetween, latestFridayCutoff } from './time';

const WEEK_MS = 7 * 24 * 60 * 60_000;
const MIN_REASON_LENGTH = 5;

interface CloseControlRow {
  activated_at: number | null;
  closed_through: number;
}

interface PeriodRow {
  id: string;
  coverage_from: number;
  cutoff_at: number;
  kind: CloseKind;
  status: 'closing' | 'closed' | 'report_failed';
  reason: string;
  initiated_by_user_id: string | null;
  suppress_delivery: number;
  entry_count: number;
  total_ms: number;
  closed_at: number | null;
  created_at: number;
}

interface CloseEntryRow {
  id: string;
  user_id: string;
  project_id: string;
  notes: string;
  client_description: string;
  start_at: number;
  end_at: number | null;
  active_guard: number | null;
  created_at: number;
  work_type: 'client' | 'internal' | 'legacy';
  client_id: string | null;
  job_id: string | null;
  internal_activity_id: string | null;
  billable: number;
  client_name_snapshot: string | null;
  client_external_id_snapshot: string | null;
  client_code_snapshot: string | null;
  job_name_snapshot: string | null;
  job_external_id_snapshot: string | null;
  job_code_snapshot: string | null;
  activity_name_snapshot: string | null;
  legacy_project_name_snapshot: string | null;
  revision: number;
  segment_root_id: string | null;
  segment_parent_id: string | null;
  segment_index: number;
  original_start_at: number | null;
  original_end_at: number | null;
}

export type CloseKind = 'initial' | 'scheduled' | 'recovery' | 'manual';

export interface FridayClosePeriod {
  id: string;
  coverageFrom: string;
  cutoffAt: string;
  kind: CloseKind;
  status: PeriodRow['status'];
  reason: string;
  suppressDelivery: boolean;
  entryCount: number;
  totalMs: number;
  closedAt: string | null;
}

export interface FridayCloseResult {
  period: FridayClosePeriod;
  report: SavedCloseReport | null;
  idempotent: boolean;
}

export interface FridayClosePreview {
  coverageFrom: string;
  cutoffAt: string;
  kind: CloseKind;
  entryCount: number;
  totalMs: number;
  crossingEntries: number;
  runningContinuations: number;
  willActivate: boolean;
  historicalEmailSuppressed: boolean;
  /** SHA-256 of every source row and report-visible value covered by this close. */
  sourceHash: string;
  activationBaseline?: { coverageFrom: string; cutoffAt: string };
}

const iso = (milliseconds: number) => new Date(milliseconds).toISOString();

function periodFromRow(row: PeriodRow): FridayClosePeriod {
  return {
    id: row.id,
    coverageFrom: iso(row.coverage_from),
    cutoffAt: iso(row.cutoff_at),
    kind: row.kind,
    status: row.status,
    reason: row.reason,
    suppressDelivery: Boolean(row.suppress_delivery),
    entryCount: row.entry_count,
    totalMs: row.total_ms,
    closedAt: row.closed_at === null ? null : iso(row.closed_at),
  };
}

async function control(db: D1Database): Promise<CloseControlRow> {
  const row = await db
    .prepare('SELECT activated_at, closed_through FROM close_control WHERE id = 1')
    .first<CloseControlRow>();
  if (!row) throw new Error('Friday close control is not initialised');
  return row;
}

async function latestPeriod(db: D1Database): Promise<PeriodRow | null> {
  return db
    .prepare(
      `SELECT id, coverage_from, cutoff_at, kind, status, reason, initiated_by_user_id,
        suppress_delivery,
        entry_count, total_ms, closed_at, created_at
       FROM close_periods WHERE status IN ('closed', 'report_failed')
       ORDER BY cutoff_at DESC LIMIT 1`,
    )
    .first<PeriodRow>();
}

async function periodAt(db: D1Database, cutoff: number): Promise<PeriodRow | null> {
  return db
    .prepare(
      `SELECT id, coverage_from, cutoff_at, kind, status, reason, initiated_by_user_id,
        suppress_delivery,
        entry_count, total_ms, closed_at, created_at
       FROM close_periods WHERE cutoff_at = ? LIMIT 1`,
    )
    .bind(cutoff)
    .first<PeriodRow>();
}

/**
 * Fingerprint the exact source rows that a close will turn into report rows.
 * The SQL JSON array fixes field order and preserves null/string distinctions,
 * while the outer order is deterministic. Including both source and clipped
 * timestamps binds crossing/running entries to the segment the report will show.
 */
async function closeSourceHash(
  db: D1Database,
  coverageFrom: number,
  cutoffAt: number,
): Promise<string> {
  const rows = await db
    .prepare(
      `SELECT json_array(
         COALESCE(e.segment_root_id, e.id),
         CASE
           WHEN e.start_at < ? OR (e.start_at = ? AND e.segment_parent_id IS NOT NULL) THEN 0
           ELSE e.revision
         END,
         e.user_id, u.email, u.display_name,
         e.work_type, e.client_id, e.client_name_snapshot,
         e.client_external_id_snapshot, e.client_code_snapshot,
         e.job_id, e.job_name_snapshot, e.job_external_id_snapshot,
         e.job_code_snapshot, e.internal_activity_id, e.activity_name_snapshot,
         e.legacy_project_name_snapshot, e.billable, e.client_description, e.notes,
         CAST(MAX(e.start_at, ?) AS INTEGER),
         CAST(MIN(COALESCE(e.end_at, ?), ?) AS INTEGER),
         xs.tenant_id, xs.project_id, xs.project_name_snapshot,
         xs.task_id, xs.task_name_snapshot, xs.task_charge_type_snapshot,
         xs.task_rate_currency_snapshot, xs.task_rate_value_snapshot,
         xs.selection_revision
       ) AS state_json
       FROM time_entries e
       JOIN users u ON u.id = e.user_id
       LEFT JOIN xero_projects_entry_selections xs ON xs.entry_id = e.id
       WHERE e.locked_at IS NULL AND e.start_at < ?
         AND COALESCE(e.end_at, ?) > ?
       ORDER BY MAX(e.start_at, ?), COALESCE(e.segment_root_id, e.id), e.id`,
    )
    .bind(
      coverageFrom,
      coverageFrom,
      coverageFrom,
      cutoffAt,
      cutoffAt,
      cutoffAt,
      cutoffAt,
      coverageFrom,
      coverageFrom,
    )
    .all<{ state_json: string }>();
  return sha256Hex(
    JSON.stringify({
      schemaVersion: 1,
      coverageFrom,
      cutoffAt,
      entries: rows.results.map((row) => row.state_json),
    }),
  );
}

async function firstCoverage(db: D1Database, cutoff: number): Promise<number> {
  const row = await db
    .prepare('SELECT MIN(start_at) AS first_start FROM time_entries WHERE start_at < ?')
    .bind(cutoff)
    .first<{ first_start: number | null }>();
  return row?.first_start !== null && row?.first_start !== undefined
    ? Math.min(row.first_start, cutoff - 1)
    : cutoff - WEEK_MS;
}

/**
 * Effective lock used by every mutating endpoint. Once activated, the Friday
 * boundary applies even if the scheduled close job has not yet materialised it.
 */
export async function effectiveLockedThrough(
  db: D1Database,
  now = new Date(),
): Promise<Date | null> {
  const state = await control(db);
  if (state.activated_at === null) return null;
  return new Date(Math.max(state.closed_through, latestFridayCutoff(now).getTime()));
}

async function previewRange(input: {
  db: D1Database;
  coverageFrom: number;
  cutoffAt: number;
  kind: CloseKind;
  willActivate: boolean;
  historicalEmailSuppressed?: boolean;
}): Promise<FridayClosePreview> {
  const [row, sourceHash] = await Promise.all([
    input.db
      .prepare(
        `SELECT COUNT(*) AS entry_count,
        COALESCE(SUM(MIN(COALESCE(end_at, ?), ?) - MAX(start_at, ?)), 0) AS total_ms,
        COALESCE(SUM(CASE WHEN start_at < ? AND (end_at IS NULL OR end_at > ?) THEN 1 ELSE 0 END), 0) AS crossing_entries,
        COALESCE(SUM(CASE WHEN start_at < ? AND end_at IS NULL THEN 1 ELSE 0 END), 0) AS running_continuations
       FROM time_entries
       WHERE locked_at IS NULL AND start_at < ? AND COALESCE(end_at, ?) > ?`,
      )
      .bind(
        input.cutoffAt,
        input.cutoffAt,
        input.coverageFrom,
        input.cutoffAt,
        input.cutoffAt,
        input.cutoffAt,
        input.cutoffAt,
        input.cutoffAt,
        input.coverageFrom,
      )
      .first<{
        entry_count: number;
        total_ms: number;
        crossing_entries: number;
        running_continuations: number;
      }>(),
    closeSourceHash(input.db, input.coverageFrom, input.cutoffAt),
  ]);
  return {
    coverageFrom: iso(input.coverageFrom),
    cutoffAt: iso(input.cutoffAt),
    kind: input.kind,
    entryCount: row?.entry_count ?? 0,
    totalMs: row?.total_ms ?? 0,
    crossingEntries: row?.crossing_entries ?? 0,
    runningContinuations: row?.running_continuations ?? 0,
    willActivate: input.willActivate,
    historicalEmailSuppressed: input.historicalEmailSuppressed ?? input.kind === 'initial',
    sourceHash,
  };
}

export async function previewFridayClose(input: {
  db: D1Database;
  cutoff?: Date;
  kind?: Exclude<CloseKind, 'initial'>;
  now?: Date;
}): Promise<FridayClosePreview> {
  const now = input.now ?? new Date();
  const cutoff = input.cutoff ?? latestFridayCutoff(now);
  if (cutoff.getTime() > now.getTime()) throw new Error('A close cutoff cannot be in the future');
  const state = await control(input.db);
  if (state.activated_at === null) {
    const initialCutoff = latestFridayCutoff(now).getTime();
    const baselineCoverage = await firstCoverage(input.db, initialCutoff);
    if ((input.kind ?? 'manual') === 'manual' && cutoff.getTime() > initialCutoff) {
      const preview = await previewRange({
        db: input.db,
        coverageFrom: initialCutoff,
        cutoffAt: cutoff.getTime(),
        kind: 'manual',
        willActivate: true,
        historicalEmailSuppressed: true,
      });
      preview.activationBaseline = {
        coverageFrom: iso(baselineCoverage),
        cutoffAt: iso(initialCutoff),
      };
      return preview;
    }
    return previewRange({
      db: input.db,
      coverageFrom: baselineCoverage,
      cutoffAt: initialCutoff,
      kind: 'initial',
      willActivate: true,
    });
  }
  if (cutoff.getTime() <= state.closed_through)
    throw new Error('The requested cutoff is already closed');
  return previewRange({
    db: input.db,
    coverageFrom: state.closed_through,
    cutoffAt: cutoff.getTime(),
    kind: input.kind ?? 'manual',
    willActivate: false,
  });
}

async function entriesNeedingSegments(
  db: D1Database,
  coverageFrom: number,
  cutoffAt: number,
): Promise<CloseEntryRow[]> {
  const result = await db
    .prepare(
      `SELECT id, user_id, project_id, notes, client_description, start_at, end_at,
        active_guard, created_at, work_type, client_id, job_id, internal_activity_id,
        billable, client_name_snapshot, client_external_id_snapshot, client_code_snapshot,
        job_name_snapshot, job_external_id_snapshot, job_code_snapshot,
        activity_name_snapshot, legacy_project_name_snapshot, revision, segment_root_id,
        segment_parent_id, segment_index, original_start_at, original_end_at
       FROM time_entries
       WHERE locked_at IS NULL AND start_at >= ? AND start_at < ?
         AND (end_at IS NULL OR end_at > ?)
       ORDER BY start_at, id`,
    )
    .bind(coverageFrom, cutoffAt, coverageFrom)
    .all<CloseEntryRow>();
  return result.results.filter((entry) => splitBoundaries(entry, cutoffAt).length > 0);
}

function splitBoundaries(entry: CloseEntryRow, cutoffAt: number): number[] {
  const segmentEnd = Math.min(entry.end_at ?? cutoffAt, cutoffAt);
  const boundaries: number[] = [];
  let midnight = DateTime.fromMillis(entry.start_at, { zone: 'utc' })
    .setZone(BRISBANE_ZONE)
    .startOf('day')
    .plus({ days: 1 });
  while (midnight.toMillis() < segmentEnd) {
    boundaries.push(midnight.toUTC().toMillis());
    midnight = midnight.plus({ days: 1 });
  }
  if (entry.end_at === null || entry.end_at > cutoffAt) {
    if (boundaries.at(-1) !== cutoffAt) boundaries.push(cutoffAt);
  }
  return boundaries;
}

function segmentInsertStatement(
  db: D1Database,
  entry: CloseEntryRow,
  segment: {
    id: string;
    parentId: string;
    index: number;
    startAt: number;
    endAt: number | null;
    locked: boolean;
    periodId: string;
  },
  timestamp: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO time_entries
       (id, project_id, notes, start_at, end_at, active_guard, created_at, updated_at,
        user_id, work_type, client_id, job_id, internal_activity_id, billable,
        client_name_snapshot, client_external_id_snapshot, client_code_snapshot,
        job_name_snapshot, job_external_id_snapshot, job_code_snapshot,
        activity_name_snapshot, legacy_project_name_snapshot, client_description,
        revision, locked_at, close_period_id, segment_root_id, segment_parent_id,
        segment_index, original_start_at, original_end_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         1, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      segment.id,
      entry.project_id,
      entry.notes,
      segment.startAt,
      segment.endAt,
      segment.endAt === null ? 1 : null,
      entry.created_at,
      timestamp,
      entry.user_id,
      entry.work_type,
      entry.client_id,
      entry.job_id,
      entry.internal_activity_id,
      entry.billable,
      entry.client_name_snapshot,
      entry.client_external_id_snapshot,
      entry.client_code_snapshot,
      entry.job_name_snapshot,
      entry.job_external_id_snapshot,
      entry.job_code_snapshot,
      entry.activity_name_snapshot,
      entry.legacy_project_name_snapshot,
      entry.client_description,
      segment.locked ? timestamp : null,
      segment.locked ? segment.periodId : null,
      entry.segment_root_id ?? entry.id,
      segment.parentId,
      segment.index,
      entry.original_start_at ?? entry.start_at,
      entry.original_end_at ?? entry.end_at,
    );
}

function copyXeroSelectionStatement(
  db: D1Database,
  sourceEntryId: string,
  targetEntryId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO xero_projects_entry_selections
       (entry_id, tenant_id, project_id, task_id, project_name_snapshot,
        task_name_snapshot, task_charge_type_snapshot, task_rate_currency_snapshot,
        task_rate_value_snapshot, project_catalogue_revision, task_catalogue_revision,
        selection_revision, selected_by_user_id, selected_at)
       SELECT ?, tenant_id, project_id, task_id, project_name_snapshot,
        task_name_snapshot, task_charge_type_snapshot, task_rate_currency_snapshot,
        task_rate_value_snapshot, project_catalogue_revision, task_catalogue_revision,
        selection_revision, selected_by_user_id, selected_at
       FROM xero_projects_entry_selections WHERE entry_id = ?`,
    )
    .bind(targetEntryId, sourceEntryId);
}

async function existingSavedReport(
  db: D1Database,
  periodId: string,
): Promise<SavedCloseReport | null> {
  const row = await db
    .prepare(
      `SELECT id, version, snapshot_json, snapshot_sha256
       FROM report_versions WHERE close_period_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .bind(periodId)
    .first<{ id: string; version: number; snapshot_json: string; snapshot_sha256: string }>();
  if (!row) return null;
  const result = await db
    .prepare(
      `SELECT format, filename, content, content_sha256
       FROM report_artifacts WHERE report_id = ? ORDER BY format`,
    )
    .bind(row.id)
    .all<{
      format: 'pdf' | 'csv' | 'xlsx';
      filename: string;
      content: ArrayBuffer;
      content_sha256: string;
    }>();
  if ((await sha256Hex(row.snapshot_json)) !== row.snapshot_sha256)
    throw new Error('Saved report snapshot failed its integrity check');
  const expectedFormats = new Set(['pdf', 'csv', 'xlsx']);
  if (
    result.results.length !== expectedFormats.size ||
    result.results.some((artifact) => !expectedFormats.delete(artifact.format))
  )
    throw new Error('Saved report artifacts are incomplete or duplicated');
  const verifiedArtifacts = await Promise.all(
    result.results.map(async (artifact) => {
      const content = new Uint8Array(artifact.content);
      if ((await sha256Hex(content)) !== artifact.content_sha256)
        throw new Error(`Saved ${artifact.format.toUpperCase()} report failed its integrity check`);
      return {
        format: artifact.format,
        filename: artifact.filename,
        content,
        sha256: artifact.content_sha256,
      };
    }),
  );
  return {
    id: row.id,
    closePeriodId: periodId,
    version: row.version,
    snapshot: JSON.parse(row.snapshot_json) as SavedCloseReport['snapshot'],
    snapshotSha256: row.snapshot_sha256,
    artifacts: verifiedArtifacts,
  };
}

async function ensureReport(input: {
  db: D1Database;
  period: PeriodRow;
  recipients: string[];
  now: Date;
}): Promise<SavedCloseReport> {
  const existing = await existingSavedReport(input.db, input.period.id);
  if (existing) {
    if (input.period.status === 'report_failed')
      await input.db
        .prepare("UPDATE close_periods SET status = 'closed', updated_at = ? WHERE id = ?")
        .bind(input.now.getTime(), input.period.id)
        .run();
    return existing;
  }
  try {
    const report = await saveCloseReportVersion({
      db: input.db,
      periodId: input.period.id,
      recipients: input.recipients,
      suppressDelivery: Boolean(input.period.suppress_delivery),
      now: input.now,
    });
    if (input.period.status === 'report_failed') {
      await input.db
        .prepare("UPDATE close_periods SET status = 'closed', updated_at = ? WHERE id = ?")
        .bind(input.now.getTime(), input.period.id)
        .run();
    }
    return report;
  } catch (error) {
    await input.db
      .prepare("UPDATE close_periods SET status = 'report_failed', updated_at = ? WHERE id = ?")
      .bind(input.now.getTime(), input.period.id)
      .run();
    throw error;
  }
}

function confirmationAuditStatement(
  db: D1Database,
  input: {
    periodId: string;
    actorUserId?: string | null;
    sourceHash: string;
    timestamp: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO close_audit (id, actor_user_id, action, entity_id, details_json, created_at)
       SELECT ?, ?, 'close.confirmation', ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM close_periods
         WHERE id = ? AND status = 'closing' AND created_at = ?
       )`,
    )
    .bind(
      crypto.randomUUID(),
      input.actorUserId ?? null,
      input.periodId,
      JSON.stringify({ sourceHash: input.sourceHash }),
      input.timestamp,
      input.periodId,
      input.timestamp,
    );
}

async function recordedConfirmationSourceHash(
  db: D1Database,
  periodId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT json_extract(details_json, '$.sourceHash') AS source_hash
       FROM close_audit
       WHERE entity_id = ? AND action = 'close.confirmation'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(periodId)
    .first<{ source_hash: string | null }>();
  return row?.source_hash ?? null;
}

async function closeOne(input: {
  db: D1Database;
  coverageFrom: number;
  cutoffAt: number;
  kind: CloseKind;
  reason: string;
  actorUserId?: string | null;
  suppressDelivery: boolean;
  recipients: string[];
  now: Date;
  /** Exact preview state authorised by an administrator, when this is a manual action. */
  expectedSourceHash?: string;
}): Promise<FridayCloseResult> {
  if (input.coverageFrom >= input.cutoffAt) throw new Error('Close coverage must precede cutoff');
  const timestamp = input.now.getTime();
  let periodId: string = crypto.randomUUID();
  let reclaimedClosingPeriod = false;
  let present = await periodAt(input.db, input.cutoffAt);
  if (present) {
    if (present.status === 'closing') {
      if (timestamp - present.created_at < 5 * 60_000)
        throw new Error('This close is already in progress');
      // Reclaim the stale marker in place. The closing row is the first-activation
      // write fence, so deleting it before inserting a replacement would briefly
      // reopen the historic period to concurrent writes.
      const reclaimStatement = input.db
        .prepare(
          `UPDATE close_periods
           SET coverage_from = ?, kind = ?, reason = ?, initiated_by_user_id = ?,
               suppress_delivery = ?, entry_count = 0, total_ms = 0,
               closed_at = NULL, created_at = ?, updated_at = ?
           WHERE id = ? AND status = 'closing' AND created_at = ?`,
        )
        .bind(
          input.coverageFrom,
          input.kind,
          input.reason,
          input.actorUserId ?? null,
          input.suppressDelivery ? 1 : 0,
          timestamp,
          timestamp,
          present.id,
          present.created_at,
        );
      const reclaimResults = input.expectedSourceHash
        ? await input.db.batch([
            reclaimStatement,
            confirmationAuditStatement(input.db, {
              periodId: present.id,
              actorUserId: input.actorUserId,
              sourceHash: input.expectedSourceHash,
              timestamp,
            }),
          ])
        : [await reclaimStatement.run()];
      const reclaimed = reclaimResults[0];
      if (!reclaimed.meta.changes) throw new Error('This close changed while being recovered');
      periodId = present.id;
      reclaimedClosingPeriod = true;
      present = null;
    }
    if (present) {
      if (input.expectedSourceHash)
        throw new Error('The close preview changed because this cutoff was already closed');
      const report = await ensureReport({
        db: input.db,
        period: present,
        recipients: input.recipients,
        now: input.now,
      });
      const refreshed = (await periodAt(input.db, input.cutoffAt))!;
      return { period: periodFromRow(refreshed), report, idempotent: true };
    }
  }

  if (!reclaimedClosingPeriod) {
    const insertStatement = input.db
      .prepare(
        `INSERT OR IGNORE INTO close_periods
         (id, coverage_from, cutoff_at, kind, status, reason, initiated_by_user_id,
          suppress_delivery, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'closing', ?, ?, ?, ?, ?)`,
      )
      .bind(
        periodId,
        input.coverageFrom,
        input.cutoffAt,
        input.kind,
        input.reason,
        input.actorUserId ?? null,
        input.suppressDelivery ? 1 : 0,
        timestamp,
        timestamp,
      );
    const insertResults = input.expectedSourceHash
      ? await input.db.batch([
          insertStatement,
          confirmationAuditStatement(input.db, {
            periodId,
            actorUserId: input.actorUserId,
            sourceHash: input.expectedSourceHash,
            timestamp,
          }),
        ])
      : [await insertStatement.run()];
    const inserted = insertResults[0];
    if (!inserted.meta.changes) {
      const concurrent = await periodAt(input.db, input.cutoffAt);
      if (!concurrent || concurrent.status === 'closing')
        throw new Error('This close is already in progress');
      if (input.expectedSourceHash)
        throw new Error('The close preview changed because this cutoff was already closed');
      const report = await ensureReport({
        db: input.db,
        period: concurrent,
        recipients: input.recipients,
        now: input.now,
      });
      return { period: periodFromRow(concurrent), report, idempotent: true };
    }
  }

  // The marker above is the database write fence. Only validate the exact
  // authorised source state after that fence exists, so an edit cannot win
  // between validation and the close transaction. The audit record makes the
  // same validation recoverable if the Worker stops after acquiring the fence.
  const confirmedSourceHash =
    input.expectedSourceHash ?? (await recordedConfirmationSourceHash(input.db, periodId));
  if (confirmedSourceHash) {
    const actualSourceHash = await closeSourceHash(input.db, input.coverageFrom, input.cutoffAt);
    if (actualSourceHash !== confirmedSourceHash) {
      const mismatchTimestamp = input.now.getTime();
      await input.db.batch([
        input.db
          .prepare("DELETE FROM close_periods WHERE id = ? AND status = 'closing'")
          .bind(periodId),
        input.db
          .prepare(
            `INSERT INTO close_audit
             (id, actor_user_id, action, entity_id, details_json, created_at)
             VALUES (?, ?, 'close.confirmation_mismatch', ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            input.actorUserId ?? null,
            periodId,
            JSON.stringify({ expectedSourceHash: confirmedSourceHash, actualSourceHash }),
            mismatchTimestamp,
          ),
      ]);
      throw new Error('The close preview source entries changed. Preview it again.');
    }
  }

  // A batch failure deliberately leaves the closing marker in place as a
  // fail-closed fence; stale recovery will reclaim that same row in place.
  {
    const splitEntries = await entriesNeedingSegments(input.db, input.coverageFrom, input.cutoffAt);
    const statements: D1PreparedStatement[] = [
      input.db
        .prepare(
          `UPDATE close_transaction_guard
           SET asserted = CASE WHEN
             EXISTS (SELECT 1 FROM close_periods WHERE id = ? AND status = 'closing')
             AND EXISTS (
               SELECT 1 FROM close_control WHERE id = 1 AND (
                 closed_through = ? OR
                 (? = 'initial' AND activated_at IS NULL AND closed_through = 0)
               )
             )
             THEN 1 ELSE 0 END
             , write_scope = 'close'
             , write_period_id = ?
           WHERE id = 1`,
        )
        .bind(periodId, input.coverageFrom, input.kind, periodId),
    ];
    for (const entry of splitEntries) {
      const boundaries = splitBoundaries(entry, input.cutoffAt);
      const firstBoundary = boundaries[0];
      statements.push(
        input.db
          .prepare(
            `UPDATE close_transaction_guard
             SET asserted = CASE WHEN EXISTS (
               SELECT 1 FROM time_entries
               WHERE id = ? AND revision = ? AND start_at = ? AND end_at IS ?
                 AND locked_at IS NULL AND active_guard IS ?
             ) THEN 1 ELSE 0 END
             WHERE id = 1`,
          )
          .bind(entry.id, entry.revision, entry.start_at, entry.end_at, entry.active_guard),
      );
      // Updating first releases the per-user active-entry uniqueness guard.
      statements.push(
        input.db
          .prepare(
            `UPDATE time_entries
             SET end_at = ?, active_guard = NULL, updated_at = ?, locked_at = ?,
                 close_period_id = ?, revision = revision + 1,
                 segment_root_id = COALESCE(segment_root_id, id),
                 original_start_at = COALESCE(original_start_at, start_at),
                 original_end_at = COALESCE(original_end_at, end_at)
             WHERE id = ? AND revision = ? AND locked_at IS NULL AND start_at < ?
               AND (end_at IS NULL OR end_at > ?)`,
          )
          .bind(
            firstBoundary,
            timestamp,
            timestamp,
            periodId,
            entry.id,
            entry.revision,
            firstBoundary,
            firstBoundary,
          ),
      );
      let parentId = entry.id;
      let segmentStart = firstBoundary;
      let index = entry.segment_index + 1;
      for (let boundaryIndex = 1; boundaryIndex <= boundaries.length; boundaryIndex += 1) {
        const segmentEnd =
          boundaryIndex < boundaries.length ? boundaries[boundaryIndex] : entry.end_at;
        const segmentId = crypto.randomUUID();
        const locked = segmentStart < input.cutoffAt;
        statements.push(
          segmentInsertStatement(
            input.db,
            entry,
            {
              id: segmentId,
              parentId,
              index,
              startAt: segmentStart,
              endAt: segmentEnd,
              locked,
              periodId,
            },
            timestamp,
          ),
          copyXeroSelectionStatement(input.db, entry.id, segmentId),
        );
        parentId = segmentId;
        segmentStart = segmentEnd ?? input.cutoffAt;
        index += 1;
      }
    }
    statements.push(
      input.db
        .prepare(
          `UPDATE time_entries
           SET locked_at = ?, close_period_id = ?, revision = revision + 1,
               updated_at = ?, segment_root_id = COALESCE(segment_root_id, id),
               original_start_at = COALESCE(original_start_at, start_at),
               original_end_at = COALESCE(original_end_at, end_at)
           WHERE locked_at IS NULL AND start_at >= ? AND start_at < ?
             AND end_at IS NOT NULL AND end_at <= ?`,
        )
        .bind(timestamp, periodId, timestamp, input.coverageFrom, input.cutoffAt, input.cutoffAt),
      input.db
        .prepare(
          `UPDATE close_periods
           SET status = 'closed',
               entry_count = (SELECT COUNT(*) FROM time_entries WHERE close_period_id = ?),
               total_ms = (SELECT COALESCE(SUM(end_at - start_at), 0)
                           FROM time_entries WHERE close_period_id = ?),
               closed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'closing'`,
        )
        .bind(periodId, periodId, timestamp, timestamp, periodId),
      input.db
        .prepare(
          `UPDATE close_control SET activated_at = COALESCE(activated_at, ?),
             closed_through = MAX(closed_through, ?), updated_at = ? WHERE id = 1`,
        )
        .bind(timestamp, input.cutoffAt, timestamp),
      input.db
        .prepare(
          `INSERT INTO close_audit (id, actor_user_id, action, entity_id, details_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          input.actorUserId ?? null,
          `close.${input.kind}`,
          periodId,
          JSON.stringify({
            coverageFrom: iso(input.coverageFrom),
            cutoffAt: iso(input.cutoffAt),
            reason: input.reason,
            splitEntries: splitEntries.length,
            suppressDelivery: input.suppressDelivery,
          }),
          timestamp,
        ),
      input.db.prepare(
        `UPDATE close_transaction_guard
         SET write_scope = NULL, write_period_id = NULL
         WHERE id = 1`,
      ),
    );
    await input.db.batch(statements);
  }

  const period = (await periodAt(input.db, input.cutoffAt))!;
  const report = await ensureReport({
    db: input.db,
    period,
    recipients: input.recipients,
    now: input.now,
  });
  return {
    period: periodFromRow((await periodAt(input.db, input.cutoffAt))!),
    report,
    idempotent: false,
  };
}

export async function activateFridayClose(input: {
  db: D1Database;
  recipients: string[];
  actorUserId?: string | null;
  expectedSourceHash?: string;
  now?: Date;
}): Promise<FridayCloseResult | null> {
  const now = input.now ?? new Date();
  const state = await control(input.db);
  if (state.activated_at !== null) return null;
  const cutoffAt = latestFridayCutoff(now).getTime();
  return closeOne({
    db: input.db,
    coverageFrom: await firstCoverage(input.db, cutoffAt),
    cutoffAt,
    kind: 'initial',
    reason: 'Initial Friday-close activation baseline',
    actorUserId: input.actorUserId,
    suppressDelivery: true,
    recipients: input.recipients,
    expectedSourceHash: input.expectedSourceHash,
    now,
  });
}

/**
 * Resume close markers that survived a Worker interruption. A marker proves a
 * close was already initiated; merely running recovery against a fresh schema
 * therefore cannot activate Friday locking by itself.
 */
async function recoverInterruptedCloses(input: {
  db: D1Database;
  recipients: string[];
  now: Date;
}): Promise<FridayCloseResult[]> {
  const staleBefore = input.now.getTime() - 5 * 60_000;
  const rows = await input.db
    .prepare(
      `SELECT id, coverage_from, cutoff_at, kind, status, reason, initiated_by_user_id,
        suppress_delivery, entry_count, total_ms, closed_at, created_at
       FROM close_periods
       WHERE status = 'closing' AND created_at <= ?
       ORDER BY cutoff_at, created_at, id`,
    )
    .bind(staleBefore)
    .all<PeriodRow>();
  const recovered: FridayCloseResult[] = [];
  for (const period of rows.results) {
    const state = await control(input.db);
    if (state.activated_at === null && period.kind !== 'initial') continue;
    if (state.activated_at !== null && period.coverage_from !== state.closed_through)
      throw new Error('Interrupted close no longer follows the last closed cutoff');
    recovered.push(
      await closeOne({
        db: input.db,
        coverageFrom: period.coverage_from,
        cutoffAt: period.cutoff_at,
        kind: period.kind,
        reason: period.reason,
        actorUserId: period.initiated_by_user_id,
        suppressDelivery: Boolean(period.suppress_delivery),
        recipients: input.recipients,
        now: input.now,
      }),
    );
  }
  return recovered;
}

/** Recover every missed Friday in order. Repeated calls are idempotent. */
export async function runScheduledFridayCloses(input: {
  db: D1Database;
  recipients: string[];
  /** Initial activation is an explicit rollout action; cron callers must leave this false. */
  activateIfNeeded?: boolean;
  now?: Date;
}): Promise<FridayCloseResult[]> {
  const now = input.now ?? new Date();
  await recoverFailedCloseReports({ ...input, now });
  await recoverPendingCorrectionReports({ ...input, now });
  const results = await recoverInterruptedCloses({ ...input, now });
  let state = await control(input.db);
  if (state.activated_at === null) {
    if (!input.activateIfNeeded) return results;
    const initial = await activateFridayClose({ ...input, now });
    if (initial) return [...results, initial];
    state = await control(input.db);
  }
  const latest = latestFridayCutoff(now);
  const boundaries = fridayCutoffsBetween(
    new Date(state.closed_through),
    new Date(latest.getTime() + 1),
  );
  let coverageFrom = state.closed_through;
  for (const boundary of boundaries) {
    results.push(
      await closeOne({
        db: input.db,
        coverageFrom,
        cutoffAt: boundary.getTime(),
        kind: boundary.getTime() === latest.getTime() ? 'scheduled' : 'recovery',
        reason:
          boundary.getTime() === latest.getTime()
            ? 'Scheduled Friday 20:00 close'
            : 'Recovered missed Friday close',
        suppressDelivery: false,
        recipients: input.recipients,
        now,
      }),
    );
    coverageFrom = boundary.getTime();
  }
  return results;
}

export async function recoverFailedCloseReports(input: {
  db: D1Database;
  recipients: string[];
  now?: Date;
}): Promise<SavedCloseReport[]> {
  const now = input.now ?? new Date();
  const rows = await input.db
    .prepare(
      `SELECT id, coverage_from, cutoff_at, kind, status, reason, initiated_by_user_id,
        suppress_delivery,
        entry_count, total_ms, closed_at, created_at
       FROM close_periods WHERE status = 'report_failed' ORDER BY cutoff_at`,
    )
    .all<PeriodRow>();
  const reports: SavedCloseReport[] = [];
  for (const period of rows.results)
    reports.push(await ensureReport({ db: input.db, period, recipients: input.recipients, now }));
  return reports;
}

/** Rebuild a revised immutable report after a correction committed but rendering/storage failed. */
export async function recoverPendingCorrectionReports(input: {
  db: D1Database;
  recipients: string[];
  now?: Date;
}): Promise<SavedCloseReport[]> {
  const now = input.now ?? new Date();
  const rows = await input.db
    .prepare(
      `SELECT c.id, c.close_period_id, c.actor_user_id, c.reason, c.created_at,
        p.suppress_delivery
       FROM locked_entry_corrections c
       JOIN close_periods p ON p.id = c.close_period_id
       WHERE c.revised_report_id IS NULL
       ORDER BY c.close_period_id, c.created_at, c.id`,
    )
    .all<{
      id: string;
      close_period_id: string;
      actor_user_id: string;
      reason: string;
      created_at: number;
      suppress_delivery: number;
    }>();
  const byPeriod = new Map<string, typeof rows.results>();
  for (const row of rows.results) {
    const pending = byPeriod.get(row.close_period_id) ?? [];
    pending.push(row);
    byPeriod.set(row.close_period_id, pending);
  }
  const reports: SavedCloseReport[] = [];
  for (const [periodId, corrections] of byPeriod) {
    const latest = corrections.at(-1)!;
    reports.push(
      await saveCloseReportVersion({
        db: input.db,
        periodId,
        recipients: input.recipients,
        correctionReason: corrections
          .map((item) => item.reason)
          .join('; ')
          .slice(0, 1000),
        createdByUserId: latest.actor_user_id,
        suppressDelivery: Boolean(latest.suppress_delivery),
        correctionIdsToLink: corrections.map((item) => item.id),
        now,
      }),
    );
  }
  return reports;
}

export async function runManualFridayClose(input: {
  db: D1Database;
  recipients: string[];
  actorUserId: string;
  cutoff: Date;
  confirmationCutoff: string;
  expectedSourceHash?: string;
  expectedActivationSourceHash?: string;
  reason: string;
  now?: Date;
}): Promise<{ activation: FridayCloseResult | null; close: FridayCloseResult }> {
  const now = input.now ?? new Date();
  if (input.reason.trim().length < MIN_REASON_LENGTH)
    throw new Error('A manual close reason of at least 5 characters is required');
  if (input.cutoff.getTime() > now.getTime())
    throw new Error('A manual cutoff cannot be in the future');
  if (input.confirmationCutoff !== input.cutoff.toISOString())
    throw new Error('Manual close confirmation no longer matches the cutoff');
  const activation = await activateFridayClose({
    db: input.db,
    recipients: input.recipients,
    actorUserId: input.actorUserId,
    expectedSourceHash: input.expectedActivationSourceHash,
    now,
  });
  const state = await control(input.db);
  if (input.cutoff.getTime() <= state.closed_through)
    throw new Error('The requested cutoff is already closed');
  const close = await closeOne({
    db: input.db,
    coverageFrom: state.closed_through,
    cutoffAt: input.cutoff.getTime(),
    kind: 'manual',
    reason: input.reason.trim(),
    actorUserId: input.actorUserId,
    suppressDelivery: false,
    recipients: input.recipients,
    expectedSourceHash: input.expectedSourceHash,
    now,
  });
  return { activation, close };
}

export interface LockedEntryCorrectionPatch {
  notes?: string;
  clientDescription?: string;
  startAt?: Date;
  endAt?: Date;
  billable?: boolean;
  workType?: 'client' | 'internal' | 'legacy';
  clientId?: string | null;
  jobId?: string | null;
  internalActivityId?: string | null;
  clientName?: string | null;
  clientExternalId?: string | null;
  clientCode?: string | null;
  jobName?: string | null;
  jobExternalId?: string | null;
  jobCode?: string | null;
  activityName?: string | null;
}

export interface LockedCorrectionXeroSelection {
  tenantId: string;
  projectId: string;
  taskId: string;
  projectName: string;
  taskName: string;
  taskChargeType: string;
  taskRateCurrency: string;
  taskRateValue: number;
  projectCatalogueRevision: number;
  taskCatalogueRevision: number;
  currentSelectionRevision: number | null;
}

interface ExistingXeroSelection {
  tenant_id: string;
  selection_revision: number;
}

interface CorrectionEntryRow extends CloseEntryRow {
  locked_at: number;
  close_period_id: string;
  updated_at: number;
}

export async function correctLockedEntry(input: {
  db: D1Database;
  entryId: string;
  expectedRevision: number;
  actorUserId: string;
  reason: string;
  patch: LockedEntryCorrectionPatch;
  /** A server-validated replacement, null to clear, undefined to preserve unless classification changed. */
  xeroSelection?: LockedCorrectionXeroSelection | null;
  reportRecipients: string[];
  now?: Date;
}): Promise<{
  correctionId: string;
  entryRevision: number;
  report: SavedCloseReport | null;
  reportPending: boolean;
}> {
  const now = input.now ?? new Date();
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON_LENGTH || reason.length > 1000)
    throw new Error('A correction reason between 5 and 1,000 characters is required');
  const before = await input.db
    .prepare(
      `SELECT id, user_id, project_id, notes, client_description, start_at, end_at,
        active_guard, created_at, updated_at, work_type, client_id, job_id,
        internal_activity_id, billable, client_name_snapshot, client_external_id_snapshot,
        client_code_snapshot, job_name_snapshot, job_external_id_snapshot, job_code_snapshot,
        activity_name_snapshot, legacy_project_name_snapshot, revision, locked_at,
        close_period_id, segment_root_id, segment_parent_id, segment_index,
        original_start_at, original_end_at
       FROM time_entries WHERE id = ? AND locked_at IS NOT NULL`,
    )
    .bind(input.entryId)
    .first<CorrectionEntryRow>();
  if (!before) throw new Error('Locked entry not found');
  if (before.revision !== input.expectedRevision) throw new Error('ENTRY_REVISION_CONFLICT');
  if (before.end_at === null) throw new Error('A locked entry must be complete');
  const existingSelection = await input.db
    .prepare(
      'SELECT tenant_id, selection_revision FROM xero_projects_entry_selections WHERE entry_id = ?',
    )
    .bind(before.id)
    .first<ExistingXeroSelection>();
  const period = await input.db
    .prepare('SELECT coverage_from, cutoff_at, suppress_delivery FROM close_periods WHERE id = ?')
    .bind(before.close_period_id)
    .first<{ coverage_from: number; cutoff_at: number; suppress_delivery: number }>();
  if (!period) throw new Error('Close period not found');

  const after = {
    ...before,
    notes: input.patch.notes === undefined ? before.notes : input.patch.notes.trim(),
    client_description:
      input.patch.clientDescription === undefined
        ? before.client_description
        : input.patch.clientDescription.trim(),
    start_at: input.patch.startAt?.getTime() ?? before.start_at,
    end_at: input.patch.endAt?.getTime() ?? before.end_at,
    billable: input.patch.billable === undefined ? before.billable : input.patch.billable ? 1 : 0,
    work_type: input.patch.workType ?? before.work_type,
    client_id: input.patch.clientId === undefined ? before.client_id : input.patch.clientId,
    job_id: input.patch.jobId === undefined ? before.job_id : input.patch.jobId,
    internal_activity_id:
      input.patch.internalActivityId === undefined
        ? before.internal_activity_id
        : input.patch.internalActivityId,
    client_name_snapshot:
      input.patch.clientName === undefined ? before.client_name_snapshot : input.patch.clientName,
    client_external_id_snapshot:
      input.patch.clientExternalId === undefined
        ? before.client_external_id_snapshot
        : input.patch.clientExternalId,
    client_code_snapshot:
      input.patch.clientCode === undefined ? before.client_code_snapshot : input.patch.clientCode,
    job_name_snapshot:
      input.patch.jobName === undefined ? before.job_name_snapshot : input.patch.jobName,
    job_external_id_snapshot:
      input.patch.jobExternalId === undefined
        ? before.job_external_id_snapshot
        : input.patch.jobExternalId,
    job_code_snapshot:
      input.patch.jobCode === undefined ? before.job_code_snapshot : input.patch.jobCode,
    activity_name_snapshot:
      input.patch.activityName === undefined
        ? before.activity_name_snapshot
        : input.patch.activityName,
    revision: before.revision + 1,
    updated_at: now.getTime(),
  };
  if (after.notes.length > 2000 || after.client_description.length > 2000)
    throw new Error('Descriptions and notes must be at most 2,000 characters');
  if (
    after.start_at < period.coverage_from ||
    after.end_at > period.cutoff_at ||
    after.end_at <= after.start_at
  )
    throw new Error('A correction must remain inside its locked close period');
  const startDay = DateTime.fromMillis(after.start_at, { zone: 'utc' })
    .setZone(BRISBANE_ZONE)
    .toISODate();
  const endDay = DateTime.fromMillis(after.end_at - 1, { zone: 'utc' })
    .setZone(BRISBANE_ZONE)
    .toISODate();
  if (startDay !== endDay)
    throw new Error('A locked correction must remain within one Brisbane calendar day');
  if (after.work_type === 'internal') {
    after.billable = 0;
    if (!after.internal_activity_id) throw new Error('Internal work requires an activity');
  }
  if (after.work_type === 'client' && !after.client_id)
    throw new Error('Client work requires a client');
  const classificationChanged =
    before.work_type !== after.work_type ||
    before.client_id !== after.client_id ||
    before.job_id !== after.job_id;
  const selectionAction =
    input.xeroSelection === undefined
      ? classificationChanged
        ? null
        : undefined
      : input.xeroSelection;
  if (selectionAction && after.work_type !== 'client')
    throw new Error('A Xero project/task selection can be applied only to client work');
  if (
    selectionAction &&
    selectionAction.currentSelectionRevision !== (existingSelection?.selection_revision ?? null)
  )
    throw new Error('XERO_SELECTION_CONFLICT');

  const correctionId = crypto.randomUUID();
  const token = crypto.randomUUID();
  const timestamp = now.getTime();
  const toRevision = before.revision + 1;
  const beforeJson = JSON.stringify(before);
  const afterJson = JSON.stringify(after);
  const lineageDurationChanged = after.end_at - after.start_at !== before.end_at - before.start_at;
  const affectedEntryIdsSql = `
    SELECT affected.id
    FROM time_entries affected
    JOIN time_entries corrected ON corrected.id = ?
    WHERE affected.id = corrected.id
       OR (? = 1
           AND COALESCE(affected.segment_root_id, affected.id) =
               COALESCE(corrected.segment_root_id, corrected.id)
           AND affected.segment_index > corrected.segment_index)`;
  const affectedApprovalIdsSql = `
    SELECT i.approval_id
    FROM xero_projects_approval_items i
    WHERE i.entry_id IN (${affectedEntryIdsSql})`;
  const unsafeUpload = await input.db
    .prepare(
      `SELECT o.id FROM xero_projects_upload_outbox o
       WHERE o.approval_id IN (${affectedApprovalIdsSql}) AND (
         o.state = 'leased' OR
         o.state NOT IN ('queued', 'provider_accepted', 'cancelled') OR
         (o.attempts > 0 AND o.state NOT IN ('provider_accepted', 'cancelled'))
       ) LIMIT 1`,
    )
    .bind(before.id, Number(lineageDurationChanged))
    .first<{ id: string }>();
  if (unsafeUpload)
    throw new Error(
      'XERO_UPLOAD_RECONCILIATION_REQUIRED: reconcile the attempted or in-flight upload before correcting this entry',
    );
  const details = JSON.stringify({
    correctionId,
    reason,
    fromRevision: before.revision,
    toRevision,
    lineageDurationChanged,
    segmentRootId: before.segment_root_id ?? before.id,
    segmentIndex: before.segment_index,
    xeroSelection:
      selectionAction === undefined
        ? { action: 'preserved', revision: existingSelection?.selection_revision ?? null }
        : selectionAction === null
          ? { action: 'cleared', revision: existingSelection?.selection_revision ?? null }
          : {
              action: existingSelection ? 'replaced' : 'created',
              fromRevision: existingSelection?.selection_revision ?? null,
              projectId: selectionAction.projectId,
              taskId: selectionAction.taskId,
            },
  });
  const selectionGuard: D1PreparedStatement[] = [];
  const selectionWrite: D1PreparedStatement[] = [];
  if (selectionAction !== undefined) {
    selectionGuard.push(
      existingSelection
        ? input.db
            .prepare(
              `UPDATE close_transaction_guard
               SET asserted = CASE WHEN EXISTS (
                 SELECT 1 FROM xero_projects_entry_selections
                 WHERE entry_id = ? AND tenant_id = ? AND selection_revision = ?
               ) THEN 1 ELSE 0 END WHERE id = 1`,
            )
            .bind(before.id, existingSelection.tenant_id, existingSelection.selection_revision)
        : input.db
            .prepare(
              `UPDATE close_transaction_guard
               SET asserted = CASE WHEN NOT EXISTS (
                 SELECT 1 FROM xero_projects_entry_selections WHERE entry_id = ?
               ) THEN 1 ELSE 0 END WHERE id = 1`,
            )
            .bind(before.id),
    );
    if (selectionAction === null) {
      if (existingSelection)
        selectionWrite.push(
          input.db
            .prepare(
              `DELETE FROM xero_projects_entry_selections
               WHERE entry_id = ? AND selection_revision = ?`,
            )
            .bind(before.id, existingSelection.selection_revision),
        );
    } else if (existingSelection) {
      selectionWrite.push(
        input.db
          .prepare(
            `UPDATE xero_projects_entry_selections
             SET tenant_id = ?, project_id = ?, task_id = ?, project_name_snapshot = ?,
               task_name_snapshot = ?, task_charge_type_snapshot = ?,
               task_rate_currency_snapshot = ?, task_rate_value_snapshot = ?,
               project_catalogue_revision = ?, task_catalogue_revision = ?,
               selection_revision = selection_revision + 1, selected_by_user_id = ?, selected_at = ?
             WHERE entry_id = ? AND selection_revision = ?`,
          )
          .bind(
            selectionAction.tenantId,
            selectionAction.projectId,
            selectionAction.taskId,
            selectionAction.projectName,
            selectionAction.taskName,
            selectionAction.taskChargeType,
            selectionAction.taskRateCurrency,
            selectionAction.taskRateValue,
            selectionAction.projectCatalogueRevision,
            selectionAction.taskCatalogueRevision,
            input.actorUserId,
            timestamp,
            before.id,
            existingSelection.selection_revision,
          ),
      );
    } else {
      selectionWrite.push(
        input.db
          .prepare(
            `INSERT INTO xero_projects_entry_selections
             (entry_id, tenant_id, project_id, task_id, project_name_snapshot,
              task_name_snapshot, task_charge_type_snapshot, task_rate_currency_snapshot,
              task_rate_value_snapshot, project_catalogue_revision, task_catalogue_revision,
              selection_revision, selected_by_user_id, selected_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .bind(
            before.id,
            selectionAction.tenantId,
            selectionAction.projectId,
            selectionAction.taskId,
            selectionAction.projectName,
            selectionAction.taskName,
            selectionAction.taskChargeType,
            selectionAction.taskRateCurrency,
            selectionAction.taskRateValue,
            selectionAction.projectCatalogueRevision,
            selectionAction.taskCatalogueRevision,
            input.actorUserId,
            timestamp,
          ),
      );
    }
  }
  try {
    await input.db.batch([
      input.db
        .prepare(
          `UPDATE close_transaction_guard
         SET asserted = CASE WHEN NOT EXISTS (
           SELECT 1 FROM xero_projects_upload_outbox o
           WHERE o.approval_id IN (${affectedApprovalIdsSql}) AND (
             o.state = 'leased' OR
             o.state NOT IN ('queued', 'provider_accepted', 'cancelled') OR
             (o.attempts > 0 AND o.state NOT IN ('provider_accepted', 'cancelled'))
           )
         ) THEN 1 ELSE 0 END
         WHERE id = 1`,
        )
        .bind(before.id, Number(lineageDurationChanged)),
      ...selectionGuard,
      input.db
        .prepare(
          `INSERT INTO locked_entry_write_tokens (entry_id, expected_revision, token, expires_at)
         VALUES (?, ?, ?, ?)`,
        )
        // The trigger compares against D1's wall clock, not the report/correction clock.
        .bind(before.id, before.revision, token, Date.now() + 60_000),
      input.db
        .prepare(
          `UPDATE time_entries SET notes = ?, client_description = ?, start_at = ?, end_at = ?,
          updated_at = ?, work_type = ?, client_id = ?, job_id = ?, internal_activity_id = ?,
          billable = ?, client_name_snapshot = ?, client_external_id_snapshot = ?,
          client_code_snapshot = ?, job_name_snapshot = ?, job_external_id_snapshot = ?,
          job_code_snapshot = ?, activity_name_snapshot = ?, revision = revision + 1
         WHERE id = ? AND revision = ? AND locked_at IS NOT NULL`,
        )
        .bind(
          after.notes,
          after.client_description,
          after.start_at,
          after.end_at,
          timestamp,
          after.work_type,
          after.client_id,
          after.job_id,
          after.internal_activity_id,
          after.billable,
          after.client_name_snapshot,
          after.client_external_id_snapshot,
          after.client_code_snapshot,
          after.job_name_snapshot,
          after.job_external_id_snapshot,
          after.job_code_snapshot,
          after.activity_name_snapshot,
          before.id,
          before.revision,
        ),
      input.db
        .prepare(
          `UPDATE close_transaction_guard
         SET asserted = CASE WHEN EXISTS (
           SELECT 1 FROM time_entries WHERE id = ? AND revision = ?
             AND locked_at = ? AND close_period_id = ?
         ) THEN 1 ELSE 0 END
         WHERE id = 1`,
        )
        .bind(before.id, toRevision, before.locked_at, before.close_period_id),
      ...selectionWrite,
      input.db
        .prepare(
          `INSERT INTO locked_entry_corrections
         (id, entry_id, close_period_id, actor_user_id, reason, from_revision,
          to_revision, before_json, after_json, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM time_entries WHERE id = ? AND revision = ?)`,
        )
        .bind(
          correctionId,
          before.id,
          before.close_period_id,
          input.actorUserId,
          reason,
          before.revision,
          toRevision,
          beforeJson,
          afterJson,
          timestamp,
          before.id,
          toRevision,
        ),
      input.db
        .prepare(
          `UPDATE close_periods
         SET total_ms = (SELECT COALESCE(SUM(end_at - start_at), 0)
                         FROM time_entries WHERE close_period_id = ?),
             source_revision = source_revision + 1, updated_at = ?
         WHERE id = ? AND EXISTS (SELECT 1 FROM locked_entry_corrections WHERE id = ?)`,
        )
        .bind(before.close_period_id, timestamp, before.close_period_id, correctionId),
      input.db
        .prepare(
          `UPDATE report_delivery_outbox
         SET state = 'needs_attention', lease_token = NULL, lease_until = 0,
             last_error = 'Superseded by a locked-entry correction before delivery', updated_at = ?
         WHERE report_id IN (SELECT id FROM report_versions WHERE close_period_id = ?)
           AND state IN ('queued', 'failed', 'leased')
           AND EXISTS (SELECT 1 FROM locked_entry_corrections WHERE id = ?)`,
        )
        .bind(timestamp, before.close_period_id, correctionId),
      input.db
        .prepare(
          `UPDATE xero_projects_upload_outbox
         SET state = 'cancelled', lease_token = NULL, lease_until = 0,
             last_error_code = 'SOURCE_CORRECTED',
             last_error_message = 'An entry or earlier lineage segment was corrected before upload', updated_at = ?
         WHERE approval_id IN (${affectedApprovalIdsSql})
           AND state = 'queued' AND attempts = 0
           AND EXISTS (SELECT 1 FROM locked_entry_corrections WHERE id = ?)`,
        )
        .bind(timestamp, before.id, Number(lineageDurationChanged), correctionId),
      input.db
        .prepare(
          `UPDATE xero_projects_upload_outbox
         SET source_drift = 1, remote_drift_json = ?,
             last_error_code = 'SOURCE_CORRECTED',
             last_error_message = 'The source entry or an earlier lineage segment was corrected; reconcile this Xero time entry',
             updated_at = ?
         WHERE entry_id IN (${affectedEntryIdsSql}) AND state = 'provider_accepted'
           AND EXISTS (SELECT 1 FROM locked_entry_corrections WHERE id = ?)`,
        )
        .bind(details, timestamp, before.id, Number(lineageDurationChanged), correctionId),
      input.db
        .prepare(
          `UPDATE xero_projects_approvals
         SET state = 'cancelled', cancelled_by_user_id = ?, cancelled_at = ?,
             cancellation_reason = 'Source entry or earlier lineage segment corrected before upload'
         WHERE state = 'approved'
           AND id IN (${affectedApprovalIdsSql})
           AND NOT EXISTS (
             SELECT 1 FROM xero_projects_upload_outbox o
             WHERE o.approval_id = xero_projects_approvals.id AND o.state = 'provider_accepted'
           )
           AND EXISTS (SELECT 1 FROM locked_entry_corrections WHERE id = ?)`,
        )
        .bind(
          input.actorUserId,
          timestamp,
          before.id,
          Number(lineageDurationChanged),
          correctionId,
        ),
      input.db
        .prepare(
          `INSERT INTO close_audit (id, actor_user_id, action, entity_id, details_json, created_at)
         SELECT ?, ?, 'entry.corrected', ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM locked_entry_corrections WHERE id = ?)`,
        )
        .bind(crypto.randomUUID(), input.actorUserId, before.id, details, timestamp, correctionId),
    ]);
  } catch (error) {
    const currentEntry = await input.db
      .prepare('SELECT revision FROM time_entries WHERE id = ?')
      .bind(before.id)
      .first<{ revision: number }>();
    if (currentEntry?.revision !== before.revision) throw new Error('ENTRY_REVISION_CONFLICT');
    if (selectionAction !== undefined) {
      const currentSelection = await input.db
        .prepare(
          'SELECT tenant_id, selection_revision FROM xero_projects_entry_selections WHERE entry_id = ?',
        )
        .bind(before.id)
        .first<ExistingXeroSelection>();
      if (
        currentSelection?.tenant_id !== existingSelection?.tenant_id ||
        (currentSelection?.selection_revision ?? null) !==
          (existingSelection?.selection_revision ?? null)
      )
        throw new Error('XERO_SELECTION_CONFLICT');
    }
    throw error;
  }

  const saved = await input.db
    .prepare('SELECT id FROM locked_entry_corrections WHERE id = ?')
    .bind(correctionId)
    .first<{ id: string }>();
  if (!saved) throw new Error('ENTRY_REVISION_CONFLICT');
  try {
    const report = await saveCloseReportVersion({
      db: input.db,
      periodId: before.close_period_id,
      recipients: input.reportRecipients,
      correctionReason: reason,
      createdByUserId: input.actorUserId,
      suppressDelivery: Boolean(period.suppress_delivery),
      correctionIdsToLink: [correctionId],
      now,
    });
    return { correctionId, entryRevision: toRevision, report, reportPending: false };
  } catch {
    // The correction and upload invalidation already committed. Leave the null
    // report link as a durable recovery marker instead of implying a rollback.
    try {
      await input.db
        .prepare(
          `INSERT INTO close_audit (id, actor_user_id, action, entity_id, details_json, created_at)
           VALUES (?, ?, 'correction.report_pending', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          input.actorUserId,
          correctionId,
          JSON.stringify({ closePeriodId: before.close_period_id }),
          timestamp,
        )
        .run();
    } catch {
      // The correction row itself remains the authoritative recovery marker.
    }
    return { correctionId, entryRevision: toRevision, report: null, reportPending: true };
  }
}

/** Useful for admin status pages without coupling them to D1 row names. */
export async function fridayCloseStatus(
  db: D1Database,
  now = new Date(),
): Promise<{
  activatedAt: string | null;
  closedThrough: string | null;
  effectiveLockedThrough: string | null;
  latestPeriod: FridayClosePeriod | null;
}> {
  const state = await control(db);
  const effective = await effectiveLockedThrough(db, now);
  const period = await latestPeriod(db);
  return {
    activatedAt: state.activated_at === null ? null : iso(state.activated_at),
    closedThrough: state.closed_through ? iso(state.closed_through) : null,
    effectiveLockedThrough: effective?.toISOString() ?? null,
    latestPeriod: period ? periodFromRow(period) : null,
  };
}

export function assertFridayCutoff(cutoff: Date): void {
  const local = DateTime.fromJSDate(cutoff, { zone: 'utc' }).setZone(BRISBANE_ZONE);
  if (
    local.weekday !== 5 ||
    local.hour !== 20 ||
    local.minute !== 0 ||
    local.second !== 0 ||
    local.millisecond !== 0
  )
    throw new Error('Scheduled cutoff must be Friday 20:00 Australia/Brisbane');
}
