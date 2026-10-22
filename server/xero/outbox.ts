import { sha256 } from './crypto';
import { projectPages, xeroRequest } from './api';
import { audit, connection } from './oauth';
import {
  requireId,
  requireReviewer,
  XeroProblem,
  type Actor,
  type TimePayload,
  type UploadRow,
  type XeroEnv,
  type XTime,
} from './types';

const LEASE_MS = 60_000;
const AUTOMATIC_RETRY_WINDOW_MS = 6 * 60_000;
const PRE_WRITE_TRANSIENT_CODES = new Set([
  'REFRESH_BUSY',
  'RATE_LIMIT',
  'AUTH_EXPIRED',
  'NETWORK',
  'CONNECTION_CHANGED',
]);

function retryDelayMs(attempt: number, requestedSeconds = 0): number {
  const exponential = Math.min(120_000, 2 ** Math.min(attempt, 7) * 1000);
  return Math.max(exponential, Math.max(0, requestedSeconds) * 1000);
}

function extractTime(value: unknown): XTime | null {
  if (!value || typeof value !== 'object') return null;
  const object = value as Record<string, unknown>;
  const candidate =
    (object.timeEntry as unknown) ??
    (Array.isArray(object.items) ? object.items[0] : undefined) ??
    value;
  if (!candidate || typeof candidate !== 'object') return null;
  const time = candidate as Record<string, unknown>;
  if (typeof time.timeEntryId !== 'string') return null;
  return time as unknown as XTime;
}

export function billingLabel(status: string | null): string {
  switch (status) {
    case 'ACTIVE':
      return 'Recorded in Xero — not invoiced';
    case 'LOCKED':
      return 'Locked in Xero — not payment proof';
    case 'INVOICED':
      return 'Invoiced in Xero — not payment proof';
    case 'UNKNOWN':
      return 'Recorded in Xero — status, invoicing and payment unknown';
    default:
      return status
        ? `Xero status: ${status} — payment unknown`
        : 'Xero status unknown — payment unknown';
  }
}

function remoteStatus(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : 'UNKNOWN';
}

function sameId(left: unknown, right: string): boolean {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
}

function sameInstant(left: unknown, right: string): boolean {
  if (left === right) return true;
  if (typeof left !== 'string') return false;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

function assertReadableRemoteTime(remote: XTime, expectedProjectId: string): void {
  requireId(remote.timeEntryId, 'Xero time entry');
  if (
    !sameId(remote.projectId, expectedProjectId) ||
    typeof remote.userId !== 'string' ||
    typeof remote.taskId !== 'string' ||
    typeof remote.dateUtc !== 'string' ||
    !Number.isFinite(Date.parse(remote.dateUtc)) ||
    !Number.isInteger(remote.duration) ||
    remote.duration < 1 ||
    (remote.description !== undefined &&
      remote.description !== null &&
      typeof remote.description !== 'string')
  ) {
    throw new XeroProblem('RESPONSE', 'Xero returned an incomplete time entry.', 502);
  }
  requireId(remote.userId, 'Xero Projects user');
  requireId(remote.taskId, 'Xero task');
}

/** Any expired in-flight POST is ambiguous and must never be auto-retried. */
export async function quarantineExpiredUploadLeases(
  db: D1Database,
  now = Date.now(),
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE xero_projects_upload_outbox
       SET state='needs_attention',lease_token=NULL,lease_until=0,
           last_error_code='LEASE_EXPIRED',
           last_error_message='The upload worker stopped before recording Xero’s response. Reconcile in Xero before retrying.',
           updated_at=?
       WHERE state='leased' AND lease_until<=?`,
    )
    .bind(now, now)
    .run();
  return result.meta.changes ?? 0;
}

export async function claimUpload(env: XeroEnv, now = Date.now()): Promise<UploadRow | null> {
  const current = await connection(env.DB);
  if (!current?.connected || current.paused) return null;
  await quarantineExpiredUploadLeases(env.DB, now);
  const lease = crypto.randomUUID();
  return env.DB.prepare(
    `UPDATE xero_projects_upload_outbox
       SET state='leased',attempts=attempts+1,
           first_attempt_at=COALESCE(first_attempt_at,?),last_attempt_at=?,
           lease_token=?,lease_until=?,updated_at=?
       WHERE id=(
         SELECT o.id FROM xero_projects_upload_outbox o
         JOIN xero_projects_approvals a
           ON a.id=o.approval_id AND a.state='approved'
         WHERE o.tenant_id=? AND o.state IN ('queued','retry_wait')
           AND o.next_attempt_at<=? AND o.lease_until<=?
         ORDER BY o.created_at,o.id LIMIT 1
       )
       RETURNING *`,
  )
    .bind(now, now, lease, now + LEASE_MS, now, current.tenant_id, now, now)
    .first<UploadRow>();
}

/**
 * The duplicate scan can span many paginated requests. Renew the lease with a
 * compare-and-swap immediately before the POST, but never revive an expired or
 * transferred lease.
 */
async function renewUploadLease(db: D1Database, row: UploadRow, now: number): Promise<boolean> {
  if (!row.lease_token) return false;
  const renewed = await db
    .prepare(
      `UPDATE xero_projects_upload_outbox
       SET lease_until=?,updated_at=?
       WHERE id=? AND state='leased' AND lease_token=? AND lease_until>?
       RETURNING id`,
    )
    .bind(now + LEASE_MS, now, row.id, row.lease_token, now)
    .first<{ id: string }>();
  return renewed?.id === row.id;
}

async function releaseLostPreWriteLease(
  db: D1Database,
  row: UploadRow,
  now: number,
): Promise<'retry_wait' | 'failed' | 'needs_attention' | 'queued'> {
  const released = await db
    .prepare(
      `UPDATE xero_projects_upload_outbox
       SET state='retry_wait',next_attempt_at=?,lease_token=NULL,lease_until=0,
           last_error_code='LEASE_LOST_BEFORE_WRITE',
           last_error_message='The upload lease expired before the Xero write. No upload was attempted.',
           updated_at=?
       WHERE id=? AND state='leased' AND lease_token=?`,
    )
    .bind(now + 30_000, now, row.id, row.lease_token)
    .run();
  if (released.meta.changes === 1) return 'retry_wait';

  // Another worker or the expired-lease quarantine already owns the outcome.
  // Do not overwrite it and, critically, do not issue the POST.
  const current = await db
    .prepare('SELECT state FROM xero_projects_upload_outbox WHERE id=?')
    .bind(row.id)
    .first<{ state: UploadRow['state'] }>();
  return current?.state === 'failed' ||
    current?.state === 'needs_attention' ||
    current?.state === 'retry_wait'
    ? current.state
    : 'queued';
}

async function quarantineLocalCommitRace(
  db: D1Database,
  row: UploadRow,
  remoteTimeEntryId: string,
  now: number,
): Promise<boolean> {
  const evidence = JSON.stringify({
    returnedTimeEntryId: remoteTimeEntryId,
    reason: 'provider_response_received_but_lease_commit_failed',
  });
  await db.batch([
    db
      .prepare(
        `UPDATE xero_projects_upload_outbox
         SET state='needs_attention',lease_token=NULL,lease_until=0,
             remote_drift_json=?,last_error_code='LOCAL_COMMIT_RACE',
             last_error_message='Xero returned a created time entry, but the upload lease changed before the local acceptance commit. Reconcile this entry before retrying.',
             updated_at=?
         WHERE id=? AND NOT (
           state='provider_accepted'
           AND lower(COALESCE(remote_time_entry_id,''))=lower(?)
         )`,
      )
      .bind(evidence, now, row.id, remoteTimeEntryId),
    audit(
      db,
      {
        id: 'system',
        email: 'system@timekeeper.local',
        displayName: 'Xero upload worker',
        role: 'system',
      },
      'upload_local_commit_race',
      row.id,
      { remoteTimeEntryId },
      now,
    ),
  ]);
  const current = await db
    .prepare(
      `SELECT state,remote_time_entry_id
       FROM xero_projects_upload_outbox WHERE id=?`,
    )
    .bind(row.id)
    .first<{ state: UploadRow['state']; remote_time_entry_id: string | null }>();
  return (
    current?.state === 'provider_accepted' &&
    sameId(current.remote_time_entry_id, remoteTimeEntryId)
  );
}

async function releaseBeforeWrite(
  db: D1Database,
  row: UploadRow,
  code: string,
  message: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE xero_projects_upload_outbox
       SET state='queued',attempts=MAX(0,attempts-1),
           first_attempt_at=CASE WHEN attempts=1 THEN NULL ELSE first_attempt_at END,
           last_attempt_at=CASE WHEN attempts=1 THEN NULL ELSE last_attempt_at END,
           next_attempt_at=?,lease_token=NULL,lease_until=0,
           last_error_code=?,last_error_message=?,updated_at=?
       WHERE id=? AND state='leased' AND lease_token=?`,
    )
    .bind(now + 30_000, code, message, now, row.id, row.lease_token)
    .run();
}

async function markNeedsAttention(
  db: D1Database,
  row: UploadRow,
  code: string,
  message: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE xero_projects_upload_outbox
       SET state='needs_attention',lease_token=NULL,lease_until=0,
           last_error_code=?,last_error_message=?,updated_at=?
       WHERE id=? AND state='leased' AND lease_token=?`,
    )
    .bind(code, message.slice(0, 1000), now, row.id, row.lease_token)
    .run();
}

async function retryPreWriteFailure(
  db: D1Database,
  row: UploadRow,
  problem: XeroProblem,
  now: number,
): Promise<'retry_wait' | 'needs_attention'> {
  const firstAttemptAt = row.first_attempt_at ?? now;
  const delay = retryDelayMs(row.attempts, problem.retryAfterSeconds);
  if (now + delay <= firstAttemptAt + AUTOMATIC_RETRY_WINDOW_MS) {
    await db
      .prepare(
        `UPDATE xero_projects_upload_outbox
           SET state='retry_wait',next_attempt_at=?,lease_token=NULL,lease_until=0,
               last_error_code=?,last_error_message=?,updated_at=?
         WHERE id=? AND state='leased' AND lease_token=?`,
      )
      .bind(now + delay, problem.code, problem.message.slice(0, 1000), now, row.id, row.lease_token)
      .run();
    return 'retry_wait';
  }
  await markNeedsAttention(
    db,
    row,
    'PREWRITE_RETRY_WINDOW_EXPIRED',
    'The six-minute safe retry window expired before Xero accepted a write. Review the connection before retrying.',
    now,
  );
  return 'needs_attention';
}

async function uploadContextIsCurrent(
  db: D1Database,
  row: UploadRow,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1
         FROM xero_projects_approval_items i
         JOIN time_entries e ON e.id=i.entry_id AND e.revision=i.source_revision
         JOIN xero_projects_entry_selections s
           ON s.entry_id=i.entry_id AND s.tenant_id=i.tenant_id
          AND s.selection_revision=i.selection_revision
          AND s.project_id=i.project_id AND s.task_id=i.task_id
         JOIN xero_projects_connection c
           ON c.id=1 AND c.connected=1 AND c.tenant_id=i.tenant_id
          AND c.mapping_revision=i.mapping_revision
         JOIN xero_projects_client_links cl
           ON cl.tenant_id=i.tenant_id AND cl.client_id=i.client_id
          AND cl.revision=i.client_link_revision
          AND cl.contact_id=json_extract(i.mapping_snapshot_json,'$.contactId')
         JOIN xero_projects_catalog cc
           ON cc.tenant_id=i.tenant_id AND cc.kind='contact'
          AND cc.resource_id=cl.contact_id AND cc.active=1
          AND cc.catalogue_revision=
              json_extract(i.mapping_snapshot_json,'$.contactCatalogueRevision')
         JOIN xero_projects_user_links ul
           ON ul.tenant_id=i.tenant_id AND ul.user_id=i.user_id
          AND ul.xero_user_id=i.xero_user_id AND ul.revision=i.user_link_revision
         JOIN xero_projects_catalog pc
           ON pc.tenant_id=i.tenant_id AND pc.kind='project'
          AND pc.resource_id=i.project_id AND pc.active=1
          AND pc.catalogue_revision=i.project_catalogue_revision
         JOIN xero_projects_catalog tc
           ON tc.tenant_id=i.tenant_id AND tc.kind='task'
          AND tc.resource_id=i.task_id AND tc.parent_id=i.project_id AND tc.active=1
          AND tc.catalogue_revision=i.task_catalogue_revision
         JOIN xero_projects_catalog uc
           ON uc.tenant_id=i.tenant_id AND uc.kind='user'
          AND uc.resource_id=i.xero_user_id AND uc.active=1
          AND uc.catalogue_revision=i.user_catalogue_revision
         WHERE i.id=? AND i.tenant_id=?
           AND cc.fetched_at>=? AND pc.fetched_at>=? AND tc.fetched_at>=? AND uc.fetched_at>=?
           AND lower(json_extract(cc.data_json,'$.ContactID'))=cl.contact_id
           AND json_extract(cc.data_json,'$.ContactStatus')='ACTIVE'
           AND json_extract(pc.data_json,'$.contactId')=cl.contact_id
           AND json_extract(pc.data_json,'$.status')='INPROGRESS'
           AND json_extract(tc.data_json,'$.projectId')=i.project_id
           AND json_extract(tc.data_json,'$.chargeType')=
               json_extract(i.mapping_snapshot_json,'$.taskChargeType')
           AND json_extract(tc.data_json,'$.rate.currency')=
               json_extract(i.mapping_snapshot_json,'$.taskRate.currency')
           AND json_extract(tc.data_json,'$.rate.value')=
               json_extract(i.mapping_snapshot_json,'$.taskRate.value')
           AND COALESCE((
             SELECT SUM(prior.end_at-prior.start_at)
             FROM time_entries current_entry
             JOIN time_entries prior
               ON prior.segment_root_id=current_entry.segment_root_id
              AND prior.segment_index<current_entry.segment_index
              AND prior.end_at IS NOT NULL AND prior.end_at>prior.start_at
             WHERE current_entry.id=i.entry_id
           ),0)=json_extract(i.source_snapshot_json,'$.lineageDurationBeforeMs')
       ) THEN 1 ELSE 0 END AS current_context`,
    )
    .bind(
      row.approval_item_id,
      row.tenant_id,
      now - 24 * 60 * 60_000,
      now - 24 * 60 * 60_000,
      now - 24 * 60 * 60_000,
      now - 24 * 60 * 60_000,
    )
    .first<{ current_context: number }>();
  return result?.current_context === 1;
}

async function exactRemoteMatches(
  env: XeroEnv,
  row: UploadRow,
  payload: TimePayload,
  fetcher: typeof fetch,
  now: number,
): Promise<XTime[]> {
  const remoteTimes = await projectPages<XTime>(
    env,
    `/Projects/${row.project_id}/Time`,
    row.tenant_id,
    fetcher,
    now,
  );
  for (const remote of remoteTimes) assertReadableRemoteTime(remote, row.project_id);
  const exact = remoteTimes.filter(
    (remote) => Object.keys(remoteDrift(remote, payload)).length === 0,
  );
  if (!exact.length) return [];

  // A known remote ID already settled against another local outbox item is an
  // accounted-for entry, not proof that this distinct local entry is a
  // duplicate. Unknown exact matches remain blocked so an uncertain write can
  // never be repeated automatically.
  const accounted = new Set<string>();
  const ids = exact.map((remote) => requireId(remote.timeEntryId, 'Xero time entry'));
  for (let offset = 0; offset < ids.length; offset += 50) {
    const chunk = ids.slice(offset, offset + 50);
    const known = await env.DB.prepare(
      `SELECT remote_time_entry_id
         FROM xero_projects_upload_outbox
        WHERE tenant_id=? AND id<>? AND state='provider_accepted'
          AND lower(remote_time_entry_id) IN (${chunk.map(() => '?').join(',')})`,
    )
      .bind(row.tenant_id, row.id, ...chunk)
      .all<{ remote_time_entry_id: string }>();
    for (const knownRow of known.results) {
      accounted.add(knownRow.remote_time_entry_id.toLowerCase());
    }
  }
  return exact.filter(
    (remote) => !accounted.has(requireId(remote.timeEntryId, 'Xero time entry').toLowerCase()),
  );
}

async function remoteIdOwner(
  db: D1Database,
  tenantId: string,
  remoteTimeEntryId: string,
  excludingOutboxId: string,
): Promise<string | null> {
  const owner = await db
    .prepare(
      `SELECT id FROM xero_projects_upload_outbox
        WHERE tenant_id=? AND remote_time_entry_id=? AND id<>? LIMIT 1`,
    )
    .bind(tenantId, remoteTimeEntryId, excludingOutboxId)
    .first<{ id: string }>();
  return owner?.id ?? null;
}

async function markRemoteIdConflict(
  db: D1Database,
  row: UploadRow,
  remoteTimeEntryId: string,
  ownerOutboxId: string,
  now: number,
): Promise<void> {
  await markNeedsAttention(
    db,
    row,
    'REMOTE_ID_CONFLICT',
    `Xero returned a time-entry ID already assigned to outbox ${ownerOutboxId}. Reconcile both records before retrying.`,
    now,
  );
  await db
    .prepare(
      `UPDATE xero_projects_upload_outbox
          SET remote_drift_json=?
        WHERE id=? AND state='needs_attention' AND last_error_code='REMOTE_ID_CONFLICT'`,
    )
    .bind(JSON.stringify({ remoteTimeEntryId, ownerOutboxId }), row.id)
    .run();
}

async function markRemoteDuplicate(
  db: D1Database,
  row: UploadRow,
  remoteIds: string[],
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE xero_projects_upload_outbox
       SET state='needs_attention',lease_token=NULL,lease_until=0,
           remote_drift_json=?,last_error_code='REMOTE_DUPLICATE_FOUND',
           last_error_message='Matching time already exists in Xero. Reconcile it before any upload.',
           updated_at=?
       WHERE id=? AND state='leased' AND lease_token=?`,
    )
    .bind(
      JSON.stringify({ possibleDuplicateTimeEntryIds: remoteIds }),
      now,
      row.id,
      row.lease_token,
    )
    .run();
}

export async function processNextUpload(
  env: XeroEnv,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  clock: () => number = Date.now,
): Promise<null | {
  id: string;
  state: 'provider_accepted' | 'retry_wait' | 'failed' | 'needs_attention' | 'queued';
  remoteTimeEntryId?: string;
}> {
  const wallStartedAt = clock();
  const operationNow = (): number => now + Math.max(0, clock() - wallStartedAt);
  const row = await claimUpload(env, now);
  if (!row) return null;
  if ((await sha256(row.payload_json)) !== row.payload_hash) {
    await markNeedsAttention(
      env.DB,
      row,
      'PAYLOAD_HASH_MISMATCH',
      'The saved immutable payload failed its integrity check.',
      now,
    );
    return { id: row.id, state: 'needs_attention' };
  }
  let payload: TimePayload;
  try {
    payload = JSON.parse(row.payload_json) as TimePayload;
  } catch {
    await markNeedsAttention(
      env.DB,
      row,
      'PAYLOAD_INVALID',
      'The saved payload is not valid JSON.',
      now,
    );
    return { id: row.id, state: 'needs_attention' };
  }
  if ('internalNote' in (payload as unknown as Record<string, unknown>)) {
    await markNeedsAttention(
      env.DB,
      row,
      'INTERNAL_NOTE_GUARD',
      'The payload contains a forbidden internal-note field.',
      now,
    );
    return { id: row.id, state: 'needs_attention' };
  }
  if (!(await uploadContextIsCurrent(env.DB, row, now))) {
    await markNeedsAttention(
      env.DB,
      row,
      'REVIEW_CONTEXT_CHANGED',
      'The source entry, tenant, mapping, catalogue, task charge type or rate changed after approval. Review again before upload.',
      now,
    );
    return { id: row.id, state: 'needs_attention' };
  }
  let remoteMatches: XTime[];
  try {
    remoteMatches = await exactRemoteMatches(env, row, payload, fetcher, now);
  } catch (error) {
    const problem =
      error instanceof XeroProblem
        ? error
        : new XeroProblem('DUPLICATE_CHECK_FAILED', 'Unexpected duplicate-check failure.', 503);
    if (PRE_WRITE_TRANSIENT_CODES.has(problem.code)) {
      const state = await retryPreWriteFailure(env.DB, row, problem, now);
      return { id: row.id, state };
    }
    await markNeedsAttention(
      env.DB,
      row,
      'DUPLICATE_CHECK_FAILED',
      'Xero could not be checked completely for matching time. No upload was attempted; review before retrying.',
      now,
    );
    return { id: row.id, state: 'needs_attention' };
  }
  if (remoteMatches.length) {
    let remoteIds: string[];
    try {
      remoteIds = remoteMatches.map((remote) => requireId(remote.timeEntryId, 'Xero time entry'));
    } catch {
      await markNeedsAttention(
        env.DB,
        row,
        'DUPLICATE_CHECK_FAILED',
        'Xero returned an unreadable matching time entry. No upload was attempted.',
        now,
      );
      return { id: row.id, state: 'needs_attention' };
    }
    await markRemoteDuplicate(env.DB, row, remoteIds, now);
    return { id: row.id, state: 'needs_attention' };
  }
  const writeNow = operationNow();
  if (!(await renewUploadLease(env.DB, row, writeNow))) {
    const state = await releaseLostPreWriteLease(env.DB, row, writeNow);
    return { id: row.id, state };
  }
  try {
    const response = await xeroRequest<unknown>(env, `/Projects/${row.project_id}/Time`, {
      tenantId: row.tenant_id,
      method: 'POST',
      payload: row.payload_json,
      idempotencyKey: row.idempotency_key,
      fetcher,
      now: writeNow,
    });
    const remote = extractTime(response);
    if (!remote) {
      await markNeedsAttention(
        env.DB,
        row,
        'AMBIGUOUS_RESPONSE',
        'Xero accepted a response that did not contain a readable time-entry identifier. Reconcile before retrying.',
        now,
      );
      return { id: row.id, state: 'needs_attention' };
    }
    try {
      assertReadableRemoteTime(remote, row.project_id);
    } catch {
      await markNeedsAttention(
        env.DB,
        row,
        'AMBIGUOUS_RESPONSE',
        'Xero returned an incomplete created time entry. Reconcile it before any retry.',
        now,
      );
      return { id: row.id, state: 'needs_attention' };
    }
    if (Object.keys(remoteDrift(remote, payload)).length) {
      await markNeedsAttention(
        env.DB,
        row,
        'AMBIGUOUS_RESPONSE',
        'Xero returned created time that did not match the approved payload. Reconcile it before any retry.',
        now,
      );
      return { id: row.id, state: 'needs_attention' };
    }
    const status = remoteStatus(remote.status);
    const remoteTimeEntryId = requireId(remote.timeEntryId, 'Xero time entry');
    const existingOwner = await remoteIdOwner(env.DB, row.tenant_id, remoteTimeEntryId, row.id);
    if (existingOwner) {
      await markRemoteIdConflict(env.DB, row, remoteTimeEntryId, existingOwner, now);
      return { id: row.id, state: 'needs_attention' };
    }
    const commitNow = operationNow();
    try {
      const accepted = await env.DB.prepare(
        `UPDATE xero_projects_upload_outbox
           SET state='provider_accepted',lease_token=NULL,lease_until=0,
               remote_time_entry_id=?,remote_status_raw=?,billing_label=?,
               last_status_checked_at=?,remote_drift_json=NULL,
               last_error_code=NULL,last_error_message=NULL,
               updated_at=?
           WHERE id=? AND state='leased' AND lease_token=? AND lease_until>?`,
      )
        .bind(
          remoteTimeEntryId,
          status,
          billingLabel(status),
          commitNow,
          commitNow,
          row.id,
          row.lease_token,
          commitNow,
        )
        .run();
      if (accepted.meta.changes !== 1) {
        const alreadyAccepted = await quarantineLocalCommitRace(
          env.DB,
          row,
          remoteTimeEntryId,
          commitNow,
        );
        if (!alreadyAccepted) return { id: row.id, state: 'needs_attention' };
      }
    } catch (error) {
      const racedOwner = await remoteIdOwner(env.DB, row.tenant_id, remoteTimeEntryId, row.id);
      if (!racedOwner) throw error;
      await markRemoteIdConflict(env.DB, row, remoteTimeEntryId, racedOwner, now);
      return { id: row.id, state: 'needs_attention' };
    }
    return {
      id: row.id,
      state: 'provider_accepted',
      remoteTimeEntryId,
    };
  } catch (error) {
    const problem =
      error instanceof XeroProblem
        ? error
        : new XeroProblem(
            'UNEXPECTED',
            'Unexpected upload failure. Reconcile before retrying.',
            503,
          );
    if (['PAUSED', 'RECONNECT', 'CONFIGURATION', 'DISABLED'].includes(problem.code)) {
      await releaseBeforeWrite(env.DB, row, problem.code, problem.message, now);
      return { id: row.id, state: 'queued' };
    }
    if (PRE_WRITE_TRANSIENT_CODES.has(problem.code)) {
      const state = await retryPreWriteFailure(env.DB, row, problem, now);
      return { id: row.id, state };
    }
    if (problem.code === 'AMBIGUOUS_WRITE' || problem.code === 'UNEXPECTED') {
      await markNeedsAttention(env.DB, row, problem.code, problem.message, now);
      return { id: row.id, state: 'needs_attention' };
    }
    await env.DB.prepare(
      `UPDATE xero_projects_upload_outbox
         SET state='failed',lease_token=NULL,lease_until=0,
             last_error_code=?,last_error_message=?,updated_at=?
         WHERE id=? AND state='leased' AND lease_token=?`,
    )
      .bind(problem.code, problem.message.slice(0, 1000), now, row.id, row.lease_token)
      .run();
    return { id: row.id, state: 'failed' };
  }
}

export async function processUploadBatch(
  env: XeroEnv,
  limit = 10,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ processed: number; states: Record<string, number> }> {
  const boundedLimit = Math.max(1, Math.min(25, Math.floor(limit)));
  const wallStartedAt = Date.now();
  const states: Record<string, number> = {};
  let processed = 0;
  for (; processed < boundedLimit; processed += 1) {
    const itemNow = now + Math.max(0, Date.now() - wallStartedAt);
    const result = await processNextUpload(env, fetcher, itemNow);
    if (!result) break;
    states[result.state] = (states[result.state] ?? 0) + 1;
  }
  return { processed, states };
}

export async function reconcileUpload(
  env: XeroEnv,
  actor: Actor,
  outboxIdInput: string,
  input:
    | { outcome: 'found'; remoteTimeEntryId: string; remoteStatus?: string }
    | { outcome: 'not_found' },
  now = Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<void> {
  requireReviewer(actor, env);
  const outboxId = requireId(outboxIdInput, 'outbox item');
  const current = await env.DB.prepare(
    `SELECT * FROM xero_projects_upload_outbox
       WHERE id=? AND state='needs_attention'`,
  )
    .bind(outboxId)
    .first<UploadRow>();
  if (!current) {
    throw new XeroProblem(
      'RECONCILE_STATE',
      'Only an upload needing attention can be reconciled.',
      409,
    );
  }
  if (input.outcome === 'found') {
    const remoteId = requireId(input.remoteTimeEntryId, 'Xero time entry');
    const existingOwner = await remoteIdOwner(env.DB, current.tenant_id, remoteId, current.id);
    if (existingOwner) {
      throw new XeroProblem(
        'REMOTE_ID_CONFLICT',
        `That Xero time entry is already assigned to outbox ${existingOwner}.`,
        409,
      );
    }
    const response = await xeroRequest<unknown>(
      env,
      `/Projects/${current.project_id}/Time/${remoteId}`,
      { tenantId: current.tenant_id, fetcher, now },
    );
    const remote = extractTime(response);
    if (!remote || remote.projectId !== current.project_id) {
      throw new XeroProblem(
        'RECONCILE_MISMATCH',
        'The selected Xero time entry does not belong to the expected project.',
        409,
      );
    }
    const payload = JSON.parse(current.payload_json) as TimePayload;
    const drift = remoteDrift(remote, payload);
    if (Object.keys(drift).length) {
      throw new XeroProblem(
        'RECONCILE_MISMATCH',
        'The selected Xero time entry does not exactly match the immutable approved payload.',
        409,
      );
    }
    const status = remoteStatus(remote.status);
    try {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE xero_projects_upload_outbox
             SET state='provider_accepted',remote_time_entry_id=?,remote_status_raw=?,
                 billing_label=?,last_status_checked_at=?,remote_drift_json=NULL,
                 last_error_code=NULL,last_error_message=NULL,updated_at=?
           WHERE id=? AND state='needs_attention'`,
        ).bind(remoteId, status, billingLabel(status), now, now, outboxId),
        audit(
          env.DB,
          actor,
          'upload_reconciled_found',
          outboxId,
          { remoteTimeEntryId: remoteId, remoteStatus: status },
          now,
        ),
      ]);
    } catch (error) {
      const racedOwner = await remoteIdOwner(env.DB, current.tenant_id, remoteId, current.id);
      if (!racedOwner) throw error;
      throw new XeroProblem(
        'REMOTE_ID_CONFLICT',
        `That Xero time entry is already assigned to outbox ${racedOwner}.`,
        409,
      );
    }
    return;
  }
  const payload = JSON.parse(current.payload_json) as TimePayload;
  let matches: XTime[];
  try {
    matches = await exactRemoteMatches(env, current, payload, fetcher, now);
  } catch {
    throw new XeroProblem(
      'DUPLICATE_CHECK_FAILED',
      'Xero could not be checked completely. The upload remains blocked.',
      503,
    );
  }
  if (matches.length) {
    throw new XeroProblem(
      'REMOTE_DUPLICATE_FOUND',
      'Matching time still exists in Xero. Reconcile that remote entry instead of retrying.',
      409,
    );
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE xero_projects_upload_outbox
         SET state='queued',first_attempt_at=NULL,next_attempt_at=?,lease_token=NULL,
             lease_until=0,remote_drift_json=NULL,last_error_code=NULL,
             last_error_message=NULL,updated_at=?
         WHERE id=? AND state='needs_attention'`,
    ).bind(now, now, outboxId),
    audit(
      env.DB,
      actor,
      'upload_reconciled_not_found',
      outboxId,
      { preservedIdempotencyKey: current.idempotency_key },
      now,
    ),
  ]);
}

/** Called by the audited locked-entry correction flow before saving a revision. */
export async function invalidateWhollyUnsentForEntry(
  env: XeroEnv,
  actor: Actor,
  entryIdInput: string,
  correctionReason: string,
  now = Date.now(),
): Promise<number> {
  requireReviewer(actor, env);
  const entryId = requireId(entryIdInput, 'entry');
  const reason = correctionReason.trim();
  if (!reason || reason.length > 500) {
    throw new XeroProblem(
      'CORRECTION_REASON',
      'Give a correction reason of no more than 500 characters.',
    );
  }
  const result = await env.DB.prepare(
    `UPDATE xero_projects_upload_outbox
       SET state='cancelled',last_error_code='SOURCE_CORRECTED',
           last_error_message=?,updated_at=?
       WHERE entry_id=? AND state='queued' AND attempts=0`,
  )
    .bind(
      `Cancelled before upload because the locked source entry was corrected: ${reason}`.slice(
        0,
        1000,
      ),
      now,
      entryId,
    )
    .run();
  const invalidated = result.meta.changes ?? 0;
  await audit(
    env.DB,
    actor,
    'unsent_uploads_invalidated_for_correction',
    entryId,
    { reason, invalidated },
    now,
  ).run();
  return invalidated;
}

function remoteDrift(remote: XTime, payload: TimePayload): Record<string, unknown> {
  const drift: Record<string, unknown> = {};
  if (!sameId(remote.userId, payload.userId)) drift.userId = remote.userId;
  if (!sameId(remote.taskId, payload.taskId)) drift.taskId = remote.taskId;
  if (remote.duration !== payload.duration) drift.duration = remote.duration;
  if ((remote.description ?? '') !== payload.description) {
    drift.description = remote.description ?? '';
  }
  if (!sameInstant(remote.dateUtc, payload.dateUtc)) drift.dateUtc = remote.dateUtc;
  return drift;
}

export async function refreshAcceptedStatuses(
  env: XeroEnv,
  limit = 25,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ checked: number; failed: number }> {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = await env.DB.prepare(
    `SELECT * FROM xero_projects_upload_outbox
       WHERE state='provider_accepted' AND remote_time_entry_id IS NOT NULL
       ORDER BY COALESCE(last_status_checked_at,0),created_at
       LIMIT ?`,
  )
    .bind(boundedLimit)
    .all<UploadRow>();
  let checked = 0;
  let failed = 0;
  for (const row of rows.results) {
    try {
      const response = await xeroRequest<unknown>(
        env,
        `/Projects/${row.project_id}/Time/${row.remote_time_entry_id}`,
        { tenantId: row.tenant_id, fetcher, now },
      );
      const remote = extractTime(response);
      if (!remote) {
        throw new XeroProblem('RESPONSE', 'Xero returned an unreadable time entry.', 502);
      }
      const payload = JSON.parse(row.payload_json) as TimePayload;
      const drift = remoteDrift(remote, payload);
      const source = await env.DB.prepare(
        `SELECT e.revision,i.source_revision,
                COALESCE((
                  SELECT SUM(prior.end_at-prior.start_at)
                    FROM time_entries prior
                   WHERE prior.segment_root_id=e.segment_root_id
                     AND prior.segment_index<e.segment_index
                     AND prior.end_at IS NOT NULL AND prior.end_at>prior.start_at
                ),0) AS lineage_duration_before_ms,
                CAST(json_extract(i.source_snapshot_json,'$.lineageDurationBeforeMs') AS INTEGER)
                  AS saved_lineage_duration_before_ms
           FROM xero_projects_approval_items i
           JOIN time_entries e ON e.id=i.entry_id
           WHERE i.id=?`,
      )
        .bind(row.approval_item_id)
        .first<{
          revision: number;
          source_revision: number;
          lineage_duration_before_ms: number;
          saved_lineage_duration_before_ms: number | null;
        }>();
      const status = remoteStatus(remote.status);
      await env.DB.prepare(
        `UPDATE xero_projects_upload_outbox
           SET remote_status_raw=?,billing_label=?,last_status_checked_at=?,
               source_drift=?,remote_drift_json=?,last_error_code=NULL,
               last_error_message=NULL,updated_at=? WHERE id=?`,
      )
        .bind(
          status,
          billingLabel(status),
          now,
          Number(
            Boolean(
              source &&
              (source.revision !== source.source_revision ||
                source.lineage_duration_before_ms !==
                  (source.saved_lineage_duration_before_ms ?? 0)),
            ),
          ),
          Object.keys(drift).length ? JSON.stringify(drift) : null,
          now,
          row.id,
        )
        .run();
      checked += 1;
    } catch (error) {
      failed += 1;
      const problem =
        error instanceof XeroProblem
          ? error
          : new XeroProblem('UNEXPECTED', 'Unexpected status refresh failure.');
      if (problem.code === 'XERO_HTTP_404') {
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE xero_projects_upload_outbox
               SET state='needs_attention',remote_status_raw=NULL,
                   billing_label='Missing in Xero — reconciliation required',
                   remote_drift_json=?,last_error_code=?,last_error_message=?,updated_at=?
             WHERE id=? AND state='provider_accepted'`,
          ).bind(
            JSON.stringify({ missing: true }),
            problem.code,
            problem.message.slice(0, 1000),
            now,
            row.id,
          ),
          audit(
            env.DB,
            {
              id: 'system:xero-status-refresh',
              email: 'system@timekeeper.local',
              displayName: 'Xero status refresh',
              role: 'system',
            },
            'remote_time_entry_missing',
            row.id,
            {
              remoteTimeEntryId: row.remote_time_entry_id,
              projectId: row.project_id,
              tenantId: row.tenant_id,
              previousRawStatus: row.remote_status_raw,
            },
            now,
          ),
        ]);
      } else {
        await env.DB.prepare(
          `UPDATE xero_projects_upload_outbox
             SET last_error_code=?,last_error_message=?,updated_at=?
             WHERE id=?`,
        )
          .bind(problem.code, problem.message.slice(0, 1000), now, row.id)
          .run();
      }
    }
  }
  return { checked, failed };
}

export interface BillingReviewRow {
  outboxId: string;
  approvalId: string;
  entryId: string;
  employeeName: string;
  clientName: string | null;
  jobName: string | null;
  projectId: string;
  taskId: string;
  state: UploadRow['state'];
  rawStatus: string | null;
  billingLabel: string;
  lastCheckedAt: number | null;
  statusStale: boolean;
  missingInXero: boolean;
  sourceDrift: boolean;
  remoteDrift: Record<string, unknown> | null;
  exactDurationMs: number;
  uploadedMinutes: number;
  lastErrorCode: string | null;
}

export async function listBillingReview(
  env: XeroEnv,
  actor: Actor,
  input: { limit?: number; staleAfterMs?: number } = {},
  now = Date.now(),
): Promise<BillingReviewRow[]> {
  requireReviewer(actor, env);
  const limit = Math.max(1, Math.min(250, Math.floor(input.limit ?? 100)));
  const staleAfterMs = Math.max(
    60_000,
    Math.min(30 * 24 * 60 * 60_000, input.staleAfterMs ?? 6 * 60 * 60_000),
  );
  const rows = await env.DB.prepare(
    `SELECT o.*,i.exact_duration_ms,i.rounded_minutes,i.source_snapshot_json
       FROM xero_projects_upload_outbox o
       JOIN xero_projects_approval_items i ON i.id=o.approval_item_id
       ORDER BY o.created_at DESC,o.id DESC LIMIT ?`,
  )
    .bind(limit)
    .all<
      UploadRow & {
        exact_duration_ms: number;
        rounded_minutes: number;
        source_snapshot_json: string;
      }
    >();
  return rows.results.map((row) => {
    const source = JSON.parse(row.source_snapshot_json) as {
      userName?: string;
      clientName?: string | null;
      jobName?: string | null;
    };
    let remoteDrift: Record<string, unknown> | null = null;
    if (row.remote_drift_json) {
      try {
        remoteDrift = JSON.parse(row.remote_drift_json) as Record<string, unknown>;
      } catch {
        remoteDrift = { unreadable: true };
      }
    }
    return {
      outboxId: row.id,
      approvalId: row.approval_id,
      entryId: row.entry_id,
      employeeName: source.userName ?? 'Unknown employee',
      clientName: source.clientName ?? null,
      jobName: source.jobName ?? null,
      projectId: row.project_id,
      taskId: (JSON.parse(row.payload_json) as TimePayload).taskId,
      state: row.state,
      rawStatus: row.remote_status_raw,
      billingLabel: row.billing_label ?? billingLabel(row.remote_status_raw),
      lastCheckedAt: row.last_status_checked_at,
      statusStale:
        row.state === 'provider_accepted' &&
        (row.last_status_checked_at === null || now - row.last_status_checked_at > staleAfterMs),
      missingInXero: remoteDrift?.missing === true,
      sourceDrift: Boolean(row.source_drift),
      remoteDrift,
      exactDurationMs: row.exact_duration_ms,
      uploadedMinutes: row.rounded_minutes,
      lastErrorCode: row.last_error_code,
    };
  });
}
