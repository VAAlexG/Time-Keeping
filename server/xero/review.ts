import { catalogueIsStale } from './catalog';
import { audit, connection } from './oauth';
import { sha256 } from './crypto';
import {
  requireId,
  requireReviewer,
  text,
  XeroProblem,
  type Actor,
  type ReviewItem,
  type ReviewPreview,
  type ReviewWarning,
  type TimePayload,
  type XProject,
  type XTask,
  type XUser,
  type XeroEnv,
} from './types';

interface ReviewRow {
  id: string;
  revision: number;
  user_id: string;
  work_type: string;
  client_id: string | null;
  job_id: string | null;
  billable: number;
  notes: string;
  client_description: string;
  start_at: number;
  end_at: number | null;
  locked_at: number | null;
  close_period_id: string | null;
  segment_root_id: string | null;
  segment_index: number;
  user_email: string;
  user_name: string;
  client_name: string | null;
  client_external_id: string | null;
  job_name: string | null;
  job_external_id: string | null;
  contact_id: string | null;
  contact_name_snapshot: string | null;
  client_link_revision: number | null;
  contact_json: string | null;
  contact_fetched_at: number | null;
  contact_catalogue_revision: number | null;
  xero_user_id: string | null;
  xero_email_snapshot: string | null;
  user_link_revision: number | null;
  project_id: string | null;
  task_id: string | null;
  project_name_snapshot: string | null;
  task_name_snapshot: string | null;
  task_charge_type_snapshot: string | null;
  task_rate_currency_snapshot: string | null;
  task_rate_value_snapshot: number | null;
  selection_revision: number | null;
  project_json: string | null;
  project_fetched_at: number | null;
  project_catalogue_revision: number | null;
  task_json: string | null;
  task_fetched_at: number | null;
  task_catalogue_revision: number | null;
  user_json: string | null;
  user_fetched_at: number | null;
  user_catalogue_revision: number | null;
  lineage_duration_before_ms: number;
}

const ENTRY_LIMIT = 200;

const SAFE_REVIEW_RESET_ERROR_CODES = [
  'PAYLOAD_HASH_MISMATCH',
  'PAYLOAD_INVALID',
  'INTERNAL_NOTE_GUARD',
  'REVIEW_CONTEXT_CHANGED',
  'PREWRITE_RETRY_WINDOW_EXPIRED',
  'DUPLICATE_CHECK_FAILED',
  'ENDPOINT',
  'WRITE_GUARD',
  'TENANT_MISMATCH',
] as const;

/**
 * SQL predicate for outcomes which prove that this app did not create a Xero
 * time entry. The alias is deliberately restricted because this text is used
 * inside two internal, parameter-free SQL guards.
 */
export function safeReviewResetOutboxSql(alias: 'o' | 'cancel_o' = 'o'): string {
  const errors = SAFE_REVIEW_RESET_ERROR_CODES.map((code) => `'${code}'`).join(',');
  return `(
    ${alias}.remote_time_entry_id IS NULL
    AND (
      ${alias}.state IN ('queued','retry_wait')
      OR (
        ${alias}.state='needs_attention'
        AND ${alias}.last_error_code IN (${errors})
      )
      OR (
        ${alias}.state='failed'
        AND (
          ${alias}.last_error_code IN (${errors})
          OR (
            ${alias}.last_error_code GLOB 'XERO_HTTP_4[0-9][0-9]'
            AND ${alias}.last_error_code NOT IN ('XERO_HTTP_408','XERO_HTTP_429')
          )
        )
      )
    )
  )`;
}

export function roundDurationToWholeMinutes(exactDurationMs: number): {
  roundedMinutes: number;
  roundingDeltaSeconds: number;
} {
  if (!Number.isSafeInteger(exactDurationMs) || exactDurationMs <= 0) {
    throw new XeroProblem('DURATION', 'The entry duration must be positive.');
  }
  const roundedMinutes = Math.max(1, Math.round(exactDurationMs / 60_000));
  if (roundedMinutes > 59_940) {
    throw new XeroProblem(
      'DURATION',
      'The rounded entry duration must be between 1 and 59,940 minutes.',
    );
  }
  return {
    roundedMinutes,
    roundingDeltaSeconds: roundedMinutes * 60 - exactDurationMs / 1000,
  };
}

/**
 * Allocates rounding at the lineage boundary rather than rounding every
 * Friday/midnight split independently. The cumulative-difference method is
 * deterministic and guarantees that allocations add up to the rounded total.
 */
export function roundLineageSegmentToWholeMinutes(
  exactDurationMs: number,
  lineageDurationBeforeMs: number,
): { roundedMinutes: number; roundingDeltaSeconds: number } {
  if (
    !Number.isSafeInteger(exactDurationMs) ||
    exactDurationMs <= 0 ||
    !Number.isSafeInteger(lineageDurationBeforeMs) ||
    lineageDurationBeforeMs < 0
  ) {
    throw new XeroProblem('DURATION', 'The lineage duration must be a positive safe duration.');
  }
  const roundedBefore = Math.round(lineageDurationBeforeMs / 60_000);
  const roundedThrough = Math.round((lineageDurationBeforeMs + exactDurationMs) / 60_000);
  const roundedMinutes = roundedThrough - roundedBefore;
  if (roundedMinutes > 59_940) {
    throw new XeroProblem('DURATION', 'The rounded segment exceeds Xero’s duration limit.');
  }
  return {
    roundedMinutes,
    roundingDeltaSeconds: roundedMinutes * 60 - exactDurationMs / 1000,
  };
}

export function brisbaneWorkDate(epochMs: number): string {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Brisbane',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = get('year');
  const month = get('month');
  const day = get('day');
  if (!year || !month || !day) {
    throw new XeroProblem('DATE', 'The work date could not be determined.');
  }
  return `${year}-${month}-${day}`;
}

export function localBillableConflictsWithChargeType(
  billable: boolean,
  chargeType: XTask['chargeType'],
): boolean {
  return billable
    ? chargeType === 'NON_CHARGEABLE'
    : chargeType === 'TIME' || chargeType === 'FIXED';
}

async function loadRows(
  db: D1Database,
  tenantId: string,
  entryIds: string[],
): Promise<Map<string, ReviewRow>> {
  const rows = await db
    .prepare(
      `SELECT e.id,e.revision,e.user_id,e.work_type,e.client_id,e.job_id,e.billable,
              e.notes,e.client_description,e.start_at,e.end_at,e.locked_at,
              e.close_period_id,e.segment_root_id,e.segment_index,
              u.email AS user_email,u.display_name AS user_name,
              c.name AS client_name,c.external_id AS client_external_id,
              j.name AS job_name,j.external_id AS job_external_id,
              cl.contact_id,cl.contact_name_snapshot,
              cl.revision AS client_link_revision,
              cc.data_json AS contact_json,cc.fetched_at AS contact_fetched_at,
              cc.catalogue_revision AS contact_catalogue_revision,
              ul.xero_user_id,ul.xero_email_snapshot,
              ul.revision AS user_link_revision,
              es.project_id,es.task_id,es.project_name_snapshot,
              es.task_name_snapshot,es.task_charge_type_snapshot,
              es.task_rate_currency_snapshot,es.task_rate_value_snapshot,
              es.selection_revision,
              pc.data_json AS project_json,pc.fetched_at AS project_fetched_at,
              pc.catalogue_revision AS project_catalogue_revision,
              tc.data_json AS task_json,tc.fetched_at AS task_fetched_at,
              tc.catalogue_revision AS task_catalogue_revision,
              uc.data_json AS user_json,uc.fetched_at AS user_fetched_at,
              uc.catalogue_revision AS user_catalogue_revision,
              COALESCE((
                SELECT SUM(prior.end_at-prior.start_at)
                FROM time_entries prior
                WHERE prior.segment_root_id=e.segment_root_id
                  AND prior.segment_index<e.segment_index
                  AND prior.end_at IS NOT NULL
                  AND prior.end_at>prior.start_at
              ),0) AS lineage_duration_before_ms
       FROM time_entries e
       JOIN users u ON u.id=e.user_id
       LEFT JOIN clients c ON c.id=e.client_id
       LEFT JOIN jobs j ON j.id=e.job_id
       LEFT JOIN xero_projects_client_links cl
         ON cl.tenant_id=? AND cl.client_id=e.client_id
       LEFT JOIN xero_projects_user_links ul
         ON ul.tenant_id=? AND ul.user_id=e.user_id
       LEFT JOIN xero_projects_catalog cc
         ON cc.tenant_id=? AND cc.kind='contact' AND cc.resource_id=cl.contact_id AND cc.active=1
       LEFT JOIN xero_projects_entry_selections es
         ON es.tenant_id=? AND es.entry_id=e.id
       LEFT JOIN xero_projects_catalog pc
         ON pc.tenant_id=? AND pc.kind='project' AND pc.resource_id=es.project_id AND pc.active=1
       LEFT JOIN xero_projects_catalog tc
         ON tc.tenant_id=? AND tc.kind='task' AND tc.resource_id=es.task_id AND tc.active=1
       LEFT JOIN xero_projects_catalog uc
         ON uc.tenant_id=? AND uc.kind='user' AND uc.resource_id=ul.xero_user_id AND uc.active=1
       WHERE e.id IN (${entryIds.map(() => '?').join(',')})`,
    )
    .bind(tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, ...entryIds)
    .all<ReviewRow>();
  return new Map(rows.results.map((row) => [row.id, row]));
}

function blocking(
  entryId: string,
  code: string,
  message: string,
): { entryId: string; code: string; message: string } {
  return { entryId, code, message };
}

async function duplicateWarning(db: D1Database, entryId: string): Promise<boolean> {
  return Boolean(
    await db
      .prepare(
        `SELECT o.id
         FROM xero_projects_upload_outbox o
         JOIN xero_projects_approvals a ON a.id=o.approval_id
         WHERE o.entry_id=? AND a.state='approved' AND o.state<>'cancelled'
         LIMIT 1`,
      )
      .bind(entryId)
      .first(),
  );
}

async function cancelledApprovalForExactPreview(
  db: D1Database,
  preview: ReviewPreview,
): Promise<string | null> {
  const keys = preview.items.map((item) => item.idempotencyKey);
  if (!keys.length) return null;
  const placeholders = keys.map(() => '?').join(',');
  const matches = await db
    .prepare(
      `SELECT a.id
       FROM xero_projects_approvals a
       WHERE a.tenant_id=? AND a.state='cancelled' AND a.preview_hash=?
         AND (SELECT COUNT(*) FROM xero_projects_approval_items i
              WHERE i.approval_id=a.id)=?
         AND NOT EXISTS (
           SELECT 1 FROM xero_projects_approval_items i
           WHERE i.approval_id=a.id AND i.idempotency_key NOT IN (${placeholders})
         )
         AND (SELECT COUNT(*) FROM xero_projects_upload_outbox o
              WHERE o.approval_id=a.id)=?
         AND NOT EXISTS (
           SELECT 1 FROM xero_projects_upload_outbox o
           WHERE o.approval_id=a.id
             AND (
               o.state<>'cancelled'
               OR o.remote_time_entry_id IS NOT NULL
               OR NOT (
                 (o.attempts=0 AND o.first_attempt_at IS NULL)
                 OR o.last_error_code='REVIEW_REQUIRED_NO_WRITE'
               )
             )
         )
       ORDER BY a.cancelled_at DESC
       LIMIT 2`,
    )
    .bind(preview.tenantId, preview.previewHash, keys.length, ...keys, keys.length)
    .all<{ id: string }>();
  if (matches.results.length > 1) {
    throw new XeroProblem(
      'DUPLICATE_APPROVAL',
      'More than one cancelled approval matches this review. An administrator must reconcile it.',
      409,
    );
  }
  return matches.results[0]?.id ?? null;
}

function currentReviewItemGuard(
  db: D1Database,
  item: ReviewItem,
  now: number,
): D1PreparedStatement {
  const lineageDurationBeforeMs = Number(item.sourceSnapshot.lineageDurationBeforeMs);
  if (!Number.isSafeInteger(lineageDurationBeforeMs) || lineageDurationBeforeMs < 0) {
    throw new XeroProblem('SOURCE_CHANGED', 'The reviewed split lineage is invalid.', 409);
  }
  return db
    .prepare(
      `UPDATE xero_projects_transaction_guard
       SET asserted=CASE WHEN EXISTS (
         SELECT 1
         FROM time_entries e
         JOIN xero_projects_connection cn
           ON cn.id=1 AND cn.tenant_id=? AND cn.mapping_revision=?
         JOIN xero_projects_entry_selections es
           ON es.entry_id=e.id AND es.tenant_id=cn.tenant_id
          AND es.selection_revision=? AND es.project_id=? AND es.task_id=?
         JOIN xero_projects_client_links cl
           ON cl.tenant_id=cn.tenant_id AND cl.client_id=?
          AND cl.contact_id=? AND cl.revision=?
         JOIN xero_projects_user_links ul
           ON ul.tenant_id=cn.tenant_id AND ul.user_id=?
          AND ul.xero_user_id=? AND ul.revision=?
         JOIN xero_projects_catalog cc
           ON cc.tenant_id=cn.tenant_id AND cc.kind='contact'
          AND cc.resource_id=cl.contact_id AND cc.active=1
          AND cc.catalogue_revision=? AND cc.fetched_at>=?
         JOIN xero_projects_catalog pc
           ON pc.tenant_id=cn.tenant_id AND pc.kind='project'
          AND pc.resource_id=es.project_id AND pc.active=1
          AND pc.catalogue_revision=? AND pc.fetched_at>=?
         JOIN xero_projects_catalog tc
           ON tc.tenant_id=cn.tenant_id AND tc.kind='task'
          AND tc.resource_id=es.task_id AND tc.parent_id=es.project_id AND tc.active=1
          AND tc.catalogue_revision=? AND tc.fetched_at>=?
         JOIN xero_projects_catalog uc
           ON uc.tenant_id=cn.tenant_id AND uc.kind='user'
          AND uc.resource_id=ul.xero_user_id AND uc.active=1
          AND uc.catalogue_revision=? AND uc.fetched_at>=?
         WHERE e.id=? AND e.revision=? AND e.end_at IS NOT NULL
           AND lower(json_extract(cc.data_json,'$.ContactID'))=cl.contact_id
           AND json_extract(cc.data_json,'$.ContactStatus')='ACTIVE'
           AND COALESCE((
             SELECT SUM(prior.end_at-prior.start_at)
             FROM time_entries prior
             WHERE prior.segment_root_id=e.segment_root_id
               AND prior.segment_index<e.segment_index
               AND prior.end_at IS NOT NULL AND prior.end_at>prior.start_at
           ),0)=?
       ) THEN 1 ELSE 0 END
       WHERE id=1`,
    )
    .bind(
      item.tenantId,
      item.mappingRevision,
      item.selectionRevision,
      item.projectId,
      item.taskId,
      item.clientId,
      item.contactId,
      item.clientLinkRevision,
      item.userId,
      item.xeroUserId,
      item.userLinkRevision,
      item.contactCatalogueRevision,
      now - 24 * 60 * 60_000,
      item.projectCatalogueRevision,
      now - 24 * 60 * 60_000,
      item.taskCatalogueRevision,
      now - 24 * 60 * 60_000,
      item.userCatalogueRevision,
      now - 24 * 60 * 60_000,
      item.entryId,
      item.sourceRevision,
      lineageDurationBeforeMs,
    );
}

async function reactivateCancelledApproval(
  env: XeroEnv,
  actor: Actor,
  preview: ReviewPreview,
  acknowledgedWarnings: string[],
  now: number,
): Promise<string | null> {
  const approvalId = await cancelledApprovalForExactPreview(env.DB, preview);
  if (!approvalId) return null;
  const statements = preview.items.map((item) => currentReviewItemGuard(env.DB, item, now));
  statements.push(
    env.DB.prepare(
      `UPDATE xero_projects_transaction_guard
         SET asserted=CASE WHEN EXISTS (
           SELECT 1 FROM xero_projects_approvals a
           WHERE a.id=? AND a.tenant_id=? AND a.state='cancelled' AND a.preview_hash=?
             AND (SELECT COUNT(*) FROM xero_projects_approval_items i
                  WHERE i.approval_id=a.id)=?
             AND (SELECT COUNT(*) FROM xero_projects_upload_outbox o
                  WHERE o.approval_id=a.id)=?
             AND NOT EXISTS (
               SELECT 1 FROM xero_projects_upload_outbox o
               WHERE o.approval_id=a.id
                 AND (
                   o.state<>'cancelled'
                   OR o.remote_time_entry_id IS NOT NULL
                   OR NOT (
                     (o.attempts=0 AND o.first_attempt_at IS NULL)
                     OR o.last_error_code='REVIEW_REQUIRED_NO_WRITE'
                   )
                 )
             )
         ) THEN 1 ELSE 0 END WHERE id=1`,
    ).bind(
      approvalId,
      preview.tenantId,
      preview.previewHash,
      preview.items.length,
      preview.items.length,
    ),
    env.DB.prepare(
      `UPDATE xero_projects_approvals
         SET state='approved',cancelled_by_user_id=NULL,cancelled_by_email=NULL,
             cancelled_at=NULL,cancellation_reason=NULL,
             approved_by_user_id=?,approved_by_email=?,approved_at=?,warnings_json=?
         WHERE id=? AND state='cancelled'`,
    ).bind(
      actor.id,
      actor.email,
      now,
      JSON.stringify({
        warnings: preview.warnings,
        acknowledged: acknowledgedWarnings,
      }),
      approvalId,
    ),
    env.DB.prepare(
      `UPDATE xero_projects_upload_outbox AS o
         SET state='queued',attempts=0,first_attempt_at=NULL,last_attempt_at=NULL,
             next_attempt_at=?,lease_token=NULL,lease_until=0,
             last_error_code=NULL,last_error_message=NULL,updated_at=?
         WHERE approval_id=? AND state='cancelled'
           AND remote_time_entry_id IS NULL
           AND ((attempts=0 AND first_attempt_at IS NULL)
                OR last_error_code='REVIEW_REQUIRED_NO_WRITE')`,
    ).bind(now, now, approvalId),
    audit(
      env.DB,
      actor,
      'approval_reapproved',
      approvalId,
      {
        previewHash: preview.previewHash,
        entryIds: preview.items.map((item) => item.entryId),
        acknowledgedWarnings,
      },
      now,
    ),
  );
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('xero_projects_transaction_guard') ||
        error.message.includes('asserted = 1'))
    ) {
      throw new XeroProblem(
        'SOURCE_CHANGED',
        'The cancelled approval or one of its source entries changed. Preview it again.',
        409,
      );
    }
    throw error;
  }
  return approvalId;
}

/** Builds a fresh preview; nothing in this function queues a Xero write. */
export async function previewReview(
  env: XeroEnv,
  actor: Actor,
  entryIdInputs: string[],
  now = Date.now(),
): Promise<ReviewPreview> {
  requireReviewer(actor, env);
  if (
    !Array.isArray(entryIdInputs) ||
    !entryIdInputs.length ||
    entryIdInputs.length > ENTRY_LIMIT
  ) {
    throw new XeroProblem(
      'REVIEW_SELECTION',
      `Choose between 1 and ${ENTRY_LIMIT} completed entries.`,
    );
  }
  const entryIds = [...new Set(entryIdInputs.map((id) => requireId(id, 'entry')))].sort();
  if (entryIds.length !== entryIdInputs.length) {
    throw new XeroProblem('REVIEW_SELECTION', 'The review selection contains a duplicate entry.');
  }
  const current = await connection(env.DB);
  if (!current?.connected || !current.tenant_id || current.cutover_at === null) {
    throw new XeroProblem(
      'REVIEW_SETUP',
      'Connect Xero, confirm the organisation and set a cutover date before review.',
      409,
    );
  }
  const rows = await loadRows(env.DB, current.tenant_id, entryIds);
  const items: ReviewItem[] = [];
  const warnings: ReviewWarning[] = [];
  const blockingIssues: ReviewPreview['blockingIssues'] = [];

  for (const entryId of entryIds) {
    const row = rows.get(entryId);
    if (!row) {
      blockingIssues.push(blocking(entryId, 'ENTRY_MISSING', 'The time entry no longer exists.'));
      continue;
    }
    if (row.end_at === null || row.end_at <= row.start_at) {
      blockingIssues.push(blocking(entryId, 'ENTRY_RUNNING', 'Stop this timer before review.'));
      continue;
    }
    if (row.locked_at === null) {
      blockingIssues.push(
        blocking(entryId, 'ENTRY_NOT_LOCKED', 'Only closed and locked time can be approved.'),
      );
    }
    if (row.work_type !== 'client' || !row.client_id) {
      blockingIssues.push(
        blocking(
          entryId,
          'NOT_CLIENT_WORK',
          'Only client work with a selected client can be uploaded to Xero Projects; the FYI project/activity may remain blank.',
        ),
      );
    }
    if (row.start_at < current.cutover_at) {
      blockingIssues.push(
        blocking(
          entryId,
          'BEFORE_CUTOVER',
          'This entry starts before the configured Xero cutover.',
        ),
      );
      warnings.push({
        code: 'CUTOVER_EXCLUDED',
        entryId,
        message: 'Entry excluded by the Xero cutover date.',
      });
    }
    if (!row.contact_id || row.client_link_revision === null) {
      blockingIssues.push(
        blocking(entryId, 'CLIENT_UNMAPPED', 'Map the Timekeeper client to a Xero contact.'),
      );
    }
    if (!row.xero_user_id || row.user_link_revision === null) {
      blockingIssues.push(
        blocking(entryId, 'USER_UNMAPPED', 'Map the employee to a Xero Projects user.'),
      );
    }
    if (!row.project_id || !row.task_id || row.selection_revision === null) {
      blockingIssues.push(
        blocking(
          entryId,
          'ENTRY_SELECTION_MISSING',
          'Choose and save the Xero project and task on this entry.',
        ),
      );
    }
    if (!row.contact_json || !row.project_json || !row.task_json || !row.user_json) {
      blockingIssues.push(
        blocking(
          entryId,
          'CATALOGUE_MISSING',
          'Refresh the catalogue; a mapped contact, project, task or user is missing or archived.',
        ),
      );
    }
    if (
      row.contact_fetched_at !== null &&
      row.project_fetched_at !== null &&
      row.task_fetched_at !== null &&
      row.user_fetched_at !== null &&
      (catalogueIsStale(row.contact_fetched_at, now) ||
        catalogueIsStale(row.project_fetched_at, now) ||
        catalogueIsStale(row.task_fetched_at, now) ||
        catalogueIsStale(row.user_fetched_at, now))
    ) {
      blockingIssues.push(
        blocking(
          entryId,
          'CATALOGUE_STALE',
          'Refresh the Xero catalogue before approval; one or more mapped records are over 24 hours old.',
        ),
      );
    }
    if (await duplicateWarning(env.DB, entryId)) {
      blockingIssues.push(
        blocking(
          entryId,
          'ALREADY_APPROVED',
          'This exact source entry already belongs to a non-cancelled Xero approval.',
        ),
      );
      warnings.push({
        code: 'POSSIBLE_DUPLICATE',
        entryId,
        message: 'A non-cancelled Xero approval already exists for this entry.',
      });
    }
    if (blockingIssues.some((issue) => issue.entryId === entryId)) {
      continue;
    }

    const contact = JSON.parse(row.contact_json!) as {
      ContactID?: string;
      ContactStatus?: string;
    };
    const project = JSON.parse(row.project_json!) as XProject;
    const task = JSON.parse(row.task_json!) as XTask;
    const xeroUser = JSON.parse(row.user_json!) as XUser;
    if (
      contact.ContactID?.toLowerCase() !== row.contact_id ||
      contact.ContactStatus !== 'ACTIVE' ||
      project.contactId !== row.contact_id ||
      project.status !== 'INPROGRESS' ||
      task.projectId !== row.project_id ||
      xeroUser.userId !== row.xero_user_id
    ) {
      blockingIssues.push(
        blocking(
          entryId,
          'MAPPING_STALE',
          'A mapped Xero relationship is no longer active or consistent.',
        ),
      );
      continue;
    }

    const exactDurationMs = row.end_at! - row.start_at;
    const { roundedMinutes, roundingDeltaSeconds } = roundLineageSegmentToWholeMinutes(
      exactDurationMs,
      row.lineage_duration_before_ms,
    );
    if (roundedMinutes < 1) {
      blockingIssues.push(
        blocking(
          entryId,
          'LINEAGE_ROUNDING_ZERO',
          'This split segment receives zero whole minutes after lineage-aware rounding and cannot be uploaded to Xero by itself.',
        ),
      );
      continue;
    }
    const itemWarnings: ReviewWarning[] = [];
    if (roundingDeltaSeconds !== 0) {
      itemWarnings.push({
        code: 'ROUNDING_APPLIED',
        entryId,
        message: `Exact duration will be rounded by ${roundingDeltaSeconds.toFixed(3)} seconds to ${roundedMinutes} whole minute${roundedMinutes === 1 ? '' : 's'}.`,
      });
    }
    if (!row.client_description.trim()) {
      itemWarnings.push({
        code: 'DESCRIPTION_EMPTY',
        entryId,
        message: 'The client-facing Xero description is empty.',
      });
    }
    if (
      task.rate.currency !== row.task_rate_currency_snapshot ||
      task.rate.value !== row.task_rate_value_snapshot ||
      task.chargeType !== row.task_charge_type_snapshot
    ) {
      itemWarnings.push({
        code: 'RATE_CHANGED',
        entryId,
        message: 'The Xero task rate or charge type changed after it was mapped.',
      });
    }
    if (task.rate.value === 0) {
      itemWarnings.push({
        code: 'ZERO_RATE',
        entryId,
        message: 'The selected Xero task currently has a zero rate.',
      });
    }
    const locallyBillable = Boolean(row.billable);
    const billableChargeMismatch = localBillableConflictsWithChargeType(
      locallyBillable,
      task.chargeType,
    );
    if (billableChargeMismatch) {
      itemWarnings.push({
        code: 'BILLABLE_CHARGE_MISMATCH',
        entryId,
        message: locallyBillable
          ? 'Timekeeper classifies this entry as billable, but the selected Xero task is non-chargeable. Confirm that this business classification is intentional.'
          : `Timekeeper classifies this entry as non-billable, but the selected Xero task is ${task.chargeType === 'FIXED' ? 'fixed-price' : 'time-chargeable'}. Confirm that this business classification is intentional.`,
      });
    }
    warnings.push(...itemWarnings);

    const workDate = brisbaneWorkDate(row.start_at);
    const payload: TimePayload = {
      userId: row.xero_user_id!,
      taskId: row.task_id!,
      dateUtc: `${workDate}T00:00:00.000Z`,
      duration: roundedMinutes,
      // Deliberately excludes notes/internalNote.
      description: row.client_description.trim(),
    };
    const payloadJson = JSON.stringify(payload);
    const payloadHash = await sha256(payloadJson);
    const idempotencyKey = `tk-${await sha256(
      [
        current.tenant_id,
        entryId,
        row.revision,
        row.selection_revision,
        current.mapping_revision,
        row.contact_catalogue_revision,
        row.project_catalogue_revision,
        row.task_catalogue_revision,
        row.user_catalogue_revision,
        row.lineage_duration_before_ms,
        locallyBillable,
        payloadHash,
      ].join(':'),
    )}`;
    const sourceSnapshot = {
      entryId,
      sourceRevision: row.revision,
      selectionRevision: row.selection_revision!,
      userId: row.user_id,
      userEmail: row.user_email,
      userName: row.user_name,
      clientId: row.client_id,
      clientName: row.client_name,
      clientExternalId: row.client_external_id,
      jobId: row.job_id,
      jobName: row.job_name,
      jobExternalId: row.job_external_id,
      billable: Boolean(row.billable),
      startAt: row.start_at,
      endAt: row.end_at,
      closePeriodId: row.close_period_id,
      segmentRootId: row.segment_root_id,
      segmentIndex: row.segment_index,
      lineageDurationBeforeMs: row.lineage_duration_before_ms,
      clientDescription: row.client_description,
      internalNote: row.notes,
    };
    const mappingSnapshot = {
      tenantId: current.tenant_id,
      tenantName: current.tenant_name,
      globalMappingRevision: current.mapping_revision,
      clientLinkRevision: row.client_link_revision,
      contactId: row.contact_id,
      contactName: row.contact_name_snapshot,
      contactCatalogueRevision: row.contact_catalogue_revision,
      userLinkRevision: row.user_link_revision,
      xeroUserId: row.xero_user_id,
      xeroUserEmail: row.xero_email_snapshot,
      selectionRevision: row.selection_revision,
      projectId: row.project_id,
      projectName: project.name,
      taskId: row.task_id,
      taskName: task.name,
      taskChargeType: task.chargeType,
      taskRate: task.rate,
      projectCatalogueRevision: row.project_catalogue_revision,
      taskCatalogueRevision: row.task_catalogue_revision,
      userCatalogueRevision: row.user_catalogue_revision,
    };
    items.push({
      entryId,
      sourceRevision: row.revision,
      selectionRevision: row.selection_revision!,
      clientId: row.client_id!,
      clientLinkRevision: row.client_link_revision!,
      contactId: row.contact_id!,
      contactCatalogueRevision: row.contact_catalogue_revision!,
      userId: row.user_id,
      userLinkRevision: row.user_link_revision!,
      projectCatalogueRevision: row.project_catalogue_revision!,
      taskCatalogueRevision: row.task_catalogue_revision!,
      userCatalogueRevision: row.user_catalogue_revision!,
      tenantId: current.tenant_id,
      projectId: row.project_id!,
      taskId: row.task_id!,
      xeroUserId: row.xero_user_id!,
      exactDurationMs,
      billable: locallyBillable,
      roundedMinutes,
      roundingDeltaSeconds,
      clientDescription: row.client_description,
      internalNote: row.notes,
      workDate,
      sourceSnapshot,
      mappingSnapshot,
      mappingRevision: current.mapping_revision,
      payload,
      payloadJson,
      payloadHash,
      idempotencyKey,
      warnings: itemWarnings,
    });
  }

  const previewHash = await sha256(
    JSON.stringify({
      tenantId: current.tenant_id,
      items: items.map((item) => ({
        entryId: item.entryId,
        sourceRevision: item.sourceRevision,
        billable: item.billable,
        mappingRevision: item.mappingRevision,
        selectionRevision: item.selectionRevision,
        lineageDurationBeforeMs: item.sourceSnapshot.lineageDurationBeforeMs,
        mappingSnapshot: item.mappingSnapshot,
        payloadHash: item.payloadHash,
        idempotencyKey: item.idempotencyKey,
        warnings: item.warnings.map((warning) => warning.code),
      })),
      blockingIssues,
    }),
  );
  return {
    tenantId: current.tenant_id,
    generatedAt: now,
    previewHash,
    ready: !blockingIssues.length && items.length === entryIds.length,
    items,
    warnings,
    blockingIssues,
  };
}

export async function approveReview(
  env: XeroEnv,
  actor: Actor,
  input: {
    entryIds: string[];
    expectedPreviewHash: string;
    acknowledgedWarnings: string[];
  },
  now = Date.now(),
): Promise<{ approvalId: string; itemCount: number; previewHash: string }> {
  requireReviewer(actor, env);
  const preview = await previewReview(env, actor, input.entryIds, now);
  if (!preview.ready) {
    throw new XeroProblem(
      'REVIEW_BLOCKED',
      'Resolve every blocking review issue before approval.',
      409,
    );
  }
  if (input.expectedPreviewHash !== preview.previewHash) {
    throw new XeroProblem(
      'PREVIEW_CHANGED',
      'The reviewed snapshot changed. Preview it again before approval.',
      409,
    );
  }
  const acknowledged = new Set(input.acknowledgedWarnings ?? []);
  const missingAcknowledgements = preview.warnings
    .map((warning) => warning.code)
    .filter((code) => !acknowledged.has(code));
  if (missingAcknowledgements.length) {
    throw new XeroProblem(
      'WARNING_ACKNOWLEDGEMENT',
      `Acknowledge all displayed warning types: ${[...new Set(missingAcknowledgements)].join(', ')}.`,
    );
  }
  const acknowledgedWarningCodes = [...acknowledged].sort();
  const reactivatedApprovalId = await reactivateCancelledApproval(
    env,
    actor,
    preview,
    acknowledgedWarningCodes,
    now,
  );
  if (reactivatedApprovalId) {
    return {
      approvalId: reactivatedApprovalId,
      itemCount: preview.items.length,
      previewHash: preview.previewHash,
    };
  }
  const approvalId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO xero_projects_approvals
         (id,tenant_id,state,preview_hash,snapshot_json,warnings_json,
          approved_by_user_id,approved_by_email,approved_at)
         VALUES(?,?,'approved',?,?,?,?,?,?)`,
    ).bind(
      approvalId,
      preview.tenantId,
      preview.previewHash,
      JSON.stringify({
        tenantId: preview.tenantId,
        items: preview.items.map((item) => ({
          entryId: item.entryId,
          sourceRevision: item.sourceRevision,
          selectionRevision: item.selectionRevision,
          exactDurationMs: item.exactDurationMs,
          billable: item.billable,
          roundedMinutes: item.roundedMinutes,
          roundingDeltaSeconds: item.roundingDeltaSeconds,
          sourceSnapshot: item.sourceSnapshot,
          mappingSnapshot: item.mappingSnapshot,
          payloadHash: item.payloadHash,
          idempotencyKey: item.idempotencyKey,
        })),
      }),
      JSON.stringify({
        warnings: preview.warnings,
        acknowledged: acknowledgedWarningCodes,
      }),
      actor.id,
      actor.email,
      now,
    ),
  ];
  for (const item of preview.items) {
    const approvalItemId = crypto.randomUUID();
    const outboxId = crypto.randomUUID();
    statements.push(
      env.DB.prepare(
        `UPDATE xero_projects_transaction_guard
           SET asserted=CASE WHEN EXISTS (
             SELECT 1
             FROM xero_projects_client_links cl
             JOIN xero_projects_catalog cc
               ON cc.tenant_id=cl.tenant_id AND cc.kind='contact'
              AND cc.resource_id=cl.contact_id AND cc.active=1
             WHERE cl.tenant_id=? AND cl.client_id=? AND cl.contact_id=?
               AND cl.revision=? AND cc.catalogue_revision=?
               AND cc.fetched_at>=?
               AND lower(json_extract(cc.data_json,'$.ContactID'))=cl.contact_id
               AND json_extract(cc.data_json,'$.ContactStatus')='ACTIVE'
           ) THEN 1 ELSE 0 END
           WHERE id=1`,
      ).bind(
        item.tenantId,
        item.clientId,
        item.contactId,
        item.clientLinkRevision,
        item.contactCatalogueRevision,
        now - 24 * 60 * 60_000,
      ),
      env.DB.prepare(
        `INSERT INTO xero_projects_approval_items
           (id,approval_id,tenant_id,entry_id,source_revision,selection_revision,source_snapshot_json,
            client_id,client_link_revision,user_id,user_link_revision,
            project_id,task_id,xero_user_id,project_catalogue_revision,
            task_catalogue_revision,user_catalogue_revision,
            mapping_revision,mapping_snapshot_json,exact_duration_ms,rounded_minutes,
            rounding_delta_seconds,payload_json,payload_hash,idempotency_key,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        approvalItemId,
        approvalId,
        item.tenantId,
        item.entryId,
        item.sourceRevision,
        item.selectionRevision,
        JSON.stringify(item.sourceSnapshot),
        item.clientId,
        item.clientLinkRevision,
        item.userId,
        item.userLinkRevision,
        item.projectId,
        item.taskId,
        item.xeroUserId,
        item.projectCatalogueRevision,
        item.taskCatalogueRevision,
        item.userCatalogueRevision,
        item.mappingRevision,
        JSON.stringify(item.mappingSnapshot),
        item.exactDurationMs,
        item.roundedMinutes,
        item.roundingDeltaSeconds,
        item.payloadJson,
        item.payloadHash,
        item.idempotencyKey,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO xero_projects_upload_outbox
           (id,approval_item_id,approval_id,tenant_id,project_id,entry_id,
            payload_json,payload_hash,idempotency_key,state,next_attempt_at,
            lease_until,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,'queued',?,0,?,?)`,
      ).bind(
        outboxId,
        approvalItemId,
        approvalId,
        item.tenantId,
        item.projectId,
        item.entryId,
        item.payloadJson,
        item.payloadHash,
        item.idempotencyKey,
        now,
        now,
        now,
      ),
    );
  }
  statements.push(
    audit(
      env.DB,
      actor,
      'time_approved',
      approvalId,
      {
        previewHash: preview.previewHash,
        entryIds: preview.items.map((item) => item.entryId),
        acknowledgedWarnings: acknowledgedWarningCodes,
      },
      now,
    ),
  );
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('XERO_SOURCE_CHANGED') ||
        error.message.includes('xero_projects_transaction_guard') ||
        error.message.includes('asserted = 1'))
    ) {
      throw new XeroProblem(
        'SOURCE_CHANGED',
        'A time entry changed during approval. Preview it again.',
        409,
      );
    }
    if (
      error instanceof Error &&
      (error.message.includes('idempotency_key') ||
        error.message.includes('UNIQUE constraint failed'))
    ) {
      throw new XeroProblem(
        'DUPLICATE_APPROVAL',
        'This source revision already has a Xero approval.',
        409,
      );
    }
    throw error;
  }
  return {
    approvalId,
    itemCount: preview.items.length,
    previewHash: preview.previewHash,
  };
}

export async function cancelApproval(
  env: XeroEnv,
  actor: Actor,
  approvalIdInput: string,
  reasonInput: string,
  now = Date.now(),
): Promise<void> {
  requireReviewer(actor, env);
  const approvalId = requireId(approvalIdInput, 'approval');
  const reason = text(reasonInput, 'cancellation reason', 500, true);
  const safeReset = safeReviewResetOutboxSql('o');
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE xero_projects_approvals
         SET state='cancelled',cancelled_by_user_id=?,cancelled_by_email=?,
             cancelled_at=?,cancellation_reason=?
         WHERE id=? AND state='approved'
           AND EXISTS (
             SELECT 1 FROM xero_projects_upload_outbox o
             WHERE o.approval_id=?
           )
           AND NOT EXISTS (
             SELECT 1 FROM xero_projects_upload_outbox o
             WHERE o.approval_id=? AND NOT ${safeReset}
           )`,
    ).bind(actor.id, actor.email, now, reason, approvalId, approvalId, approvalId),
    env.DB.prepare(
      `INSERT INTO xero_projects_audit
         SELECT ?,?,?, 'approval_cancelled', ?,
                json_object(
                  'reason',?,
                  'transition','review_required',
                  'proof','no_xero_write_created',
                  'priorOutcomes',json((
                    SELECT json_group_array(json_object(
                      'state',prior.state,
                      'last_error_code',prior.last_error_code,
                      'attempts',prior.attempts,
                      'first_attempt_at',prior.first_attempt_at
                    ))
                    FROM (
                      SELECT state,last_error_code,attempts,first_attempt_at
                        FROM xero_projects_upload_outbox
                       WHERE approval_id=? ORDER BY id
                    ) prior
                  ))
                ), ?
         WHERE EXISTS (
           SELECT 1 FROM xero_projects_approvals
           WHERE id=? AND state='cancelled' AND cancelled_at=?
         )`,
    ).bind(
      crypto.randomUUID(),
      actor.id,
      actor.email,
      approvalId,
      reason,
      approvalId,
      now,
      approvalId,
      now,
    ),
    env.DB.prepare(
      `UPDATE xero_projects_upload_outbox AS o
          SET state='cancelled',lease_token=NULL,lease_until=0,
              last_error_code='REVIEW_REQUIRED_NO_WRITE',
              last_error_message='Returned to review after Timekeeper proved that no Xero write was created.',
              updated_at=?
         WHERE approval_id=? AND ${safeReset}
           AND EXISTS (
             SELECT 1 FROM xero_projects_approvals
             WHERE id=? AND state='cancelled' AND cancelled_at=?
           )`,
    ).bind(now, approvalId, approvalId, now),
  ]);
  if ((results[0].meta.changes ?? 0) !== 1) {
    throw new XeroProblem(
      'CANNOT_CANCEL',
      'Only an approval with proof that no Xero write was created can be returned to review. Reconcile ambiguous, in-flight or accepted writes instead.',
      409,
    );
  }
}
