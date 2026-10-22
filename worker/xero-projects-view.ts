import { DateTime } from 'luxon';
import {
  connection,
  previewReview,
  safeReviewResetOutboxSql,
  type Actor,
  type ConnectionChoice,
  type ReviewPreview,
  type XProject,
  type XTask,
  type XUser,
} from '../server/xero/index';
import type { User } from '../server/types';
import type { Env } from './env';

const BRISBANE = 'Australia/Brisbane';

type CatalogRow = {
  kind: 'project' | 'task' | 'user' | 'contact';
  resource_id: string;
  parent_id: string;
  data_json: string;
  active: number;
  fetched_at: number;
};

type ReviewRow = {
  entry_id: string;
  entry_revision: number;
  employee_id: string;
  employee_name: string;
  client_name: string | null;
  job_name: string | null;
  start_at: number;
  end_at: number;
  locked_at: number;
  client_description: string;
  billable: number;
  contact_id: string | null;
  contact_name: string | null;
  xero_user_id: string | null;
  project_id: string | null;
  project_name: string | null;
  task_id: string | null;
  task_name: string | null;
  charge_type: 'TIME' | 'FIXED' | 'NON_CHARGEABLE' | null;
  rate_currency: string | null;
  rate_value: number | null;
  selection_revision: number | null;
  connection_connected: number | null;
  contact_active: number | null;
  contact_fetched_at: number | null;
  contact_json: string | null;
  project_active: number | null;
  project_fetched_at: number | null;
  project_json: string | null;
  task_active: number | null;
  task_fetched_at: number | null;
  task_json: string | null;
  user_active: number | null;
  user_fetched_at: number | null;
  user_json: string | null;
  lineage_duration_before_ms: number;
  review_ready: number;
  approval_id: string | null;
  approval_state: 'approved' | 'cancelled' | null;
  approved_by_name: string | null;
  approved_at: number | null;
  outbox_id: string | null;
  outbox_state:
    | 'queued'
    | 'leased'
    | 'retry_wait'
    | 'provider_accepted'
    | 'failed'
    | 'needs_attention'
    | 'cancelled'
    | null;
  remote_time_entry_id: string | null;
  remote_status: string | null;
  billing_label: string | null;
  last_status_checked_at: number | null;
  last_error_code: string | null;
  source_drift: number | null;
  remote_drift_json: string | null;
  can_return_to_review: number;
};

export function xeroActor(user: User): Actor {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
  };
}

export function xeroConfigured(env: Env): boolean {
  return Boolean(
    env.XERO_CLIENT_ID && env.XERO_CLIENT_SECRET && env.XERO_REDIRECT_URI && env.XERO_TOKEN_KEY,
  );
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function localDate(value: number | null): string | null {
  return value === null ? null : DateTime.fromMillis(value, { zone: BRISBANE }).toISODate();
}

async function catalogRows(env: Env, tenantId: string | null): Promise<CatalogRow[]> {
  if (!tenantId) return [];
  const result = await env.DB.prepare(
    `SELECT kind,resource_id,parent_id,data_json,active,fetched_at
       FROM xero_projects_catalog WHERE tenant_id=?
       ORDER BY kind,resource_id`,
  )
    .bind(tenantId)
    .all<CatalogRow>();
  return result.results;
}

function catalogData(rows: CatalogRow[]) {
  const contacts = rows
    .filter((row) => row.kind === 'contact')
    .flatMap((row) => {
      const data = parseJson<{ ContactID?: string; Name?: string; ContactStatus?: string }>(
        row.data_json,
      );
      return data?.ContactID && data.Name
        ? [
            {
              id: row.resource_id,
              name: data.Name,
              detail: null,
              active: Boolean(row.active) && data.ContactStatus !== 'ARCHIVED',
            },
          ]
        : [];
    });
  const contactNames = new Map(contacts.map((item) => [item.id, item.name]));
  const projects = rows
    .filter((row) => row.kind === 'project')
    .flatMap((row) => {
      const data = parseJson<XProject>(row.data_json);
      return data
        ? [
            {
              id: row.resource_id,
              name: data.name,
              contactId: data.contactId || null,
              contactName: contactNames.get(data.contactId) ?? null,
              detail: contactNames.get(data.contactId) ?? null,
              active: Boolean(row.active) && data.status === 'INPROGRESS',
            },
          ]
        : [];
    });
  const tasks = rows
    .filter((row) => row.kind === 'task')
    .flatMap((row) => {
      const data = parseJson<XTask>(row.data_json);
      return data
        ? [
            {
              id: row.resource_id,
              projectId: data.projectId,
              name: data.name,
              detail: data.chargeType,
              chargeType: data.chargeType,
              rate: Number.isFinite(data.rate?.value) ? data.rate.value : null,
              currencyCode: data.rate?.currency || null,
              active: Boolean(row.active),
            },
          ]
        : [];
    });
  const users = rows
    .filter((row) => row.kind === 'user')
    .flatMap((row) => {
      const data = parseJson<XUser>(row.data_json);
      return data
        ? [
            {
              id: row.resource_id,
              name: data.name,
              detail: data.email,
              active: Boolean(row.active),
            },
          ]
        : [];
    });
  return { contacts, projects, tasks, users };
}

export async function projectsWorkOptions(env: Env, clientId: string, jobId?: string) {
  if (env.XERO_ENABLED !== 'true') {
    return {
      enabled: false,
      connected: false,
      complete: false,
      refreshedAt: null,
      projects: [],
      tasks: [],
      suggestedProjectId: null,
      suggestedTaskId: null,
      message: 'Xero Projects is disabled. Time will still be saved in Timekeeper.',
    };
  }
  const current = await connection(env.DB);
  if (!current?.connected || !current.tenant_id) {
    return {
      enabled: true,
      connected: false,
      complete: false,
      refreshedAt: null,
      projects: [],
      tasks: [],
      suggestedProjectId: null,
      suggestedTaskId: null,
      message: 'An administrator must connect and refresh Xero Projects.',
    };
  }
  const [rows, clientLink, latestRun, suggested] = await Promise.all([
    catalogRows(env, current.tenant_id),
    env.DB.prepare(
      `SELECT contact_id FROM xero_projects_client_links
       WHERE tenant_id=? AND client_id=?`,
    )
      .bind(current.tenant_id, clientId)
      .first<{ contact_id: string }>(),
    env.DB.prepare(
      `SELECT state,finished_at FROM xero_projects_catalog_runs
       WHERE tenant_id=? ORDER BY started_at DESC LIMIT 1`,
    )
      .bind(current.tenant_id)
      .first<{ state: string; finished_at: number | null }>(),
    jobId
      ? env.DB.prepare(
          `SELECT project_id,task_id FROM xero_projects_work_links
           WHERE tenant_id=? AND job_id=?`,
        )
          .bind(current.tenant_id, jobId)
          .first<{ project_id: string; task_id: string }>()
      : Promise.resolve(null),
  ]);
  const data = catalogData(rows);
  const projects = clientLink
    ? data.projects.filter(
        (project) => project.active && project.contactId === clientLink.contact_id,
      )
    : [];
  const projectIds = new Set(projects.map((project) => project.id));
  const tasks = data.tasks.filter((task) => task.active && projectIds.has(task.projectId));
  const suggestedProjectId =
    suggested && projectIds.has(suggested.project_id) ? suggested.project_id : null;
  const suggestedTaskId =
    suggestedProjectId && tasks.some((task) => task.id === suggested?.task_id)
      ? suggested!.task_id
      : null;
  return {
    enabled: true,
    connected: true,
    complete: latestRun?.state === 'succeeded',
    refreshedAt: iso(latestRun?.finished_at ?? null),
    projects,
    tasks,
    suggestedProjectId,
    suggestedTaskId,
    message: !clientLink
      ? 'This client must be mapped to a Xero contact before project selection.'
      : !projects.length
        ? 'No open Xero Projects were found for this mapped contact.'
        : null,
  };
}

export async function projectsSetupData(env: Env) {
  const current = await connection(env.DB);
  const tenantId = current?.tenant_id ?? null;
  const [rows, clients, jobs, users, latestRun] = await Promise.all([
    catalogRows(env, tenantId),
    env.DB.prepare(
      `SELECT c.id,c.name,l.contact_id,l.contact_name_snapshot,l.revision
       FROM clients c LEFT JOIN xero_projects_client_links l
         ON l.client_id=c.id AND l.tenant_id=?
       WHERE c.active=1 ORDER BY c.name COLLATE NOCASE`,
    )
      .bind(tenantId ?? '')
      .all<{
        id: string;
        name: string;
        contact_id: string | null;
        contact_name_snapshot: string | null;
        revision: number | null;
      }>(),
    env.DB.prepare(
      `SELECT j.id,j.name,c.name AS client_name,l.project_id,l.project_name_snapshot,
              l.task_id,l.task_name_snapshot,l.revision
       FROM jobs j JOIN clients c ON c.id=j.client_id
       LEFT JOIN xero_projects_work_links l ON l.job_id=j.id AND l.tenant_id=?
       WHERE j.active=1 AND c.active=1
       ORDER BY c.name COLLATE NOCASE,j.name COLLATE NOCASE`,
    )
      .bind(tenantId ?? '')
      .all<{
        id: string;
        name: string;
        client_name: string;
        project_id: string | null;
        project_name_snapshot: string | null;
        task_id: string | null;
        task_name_snapshot: string | null;
        revision: number | null;
      }>(),
    env.DB.prepare(
      `SELECT u.id,u.display_name,u.email,l.xero_user_id,l.revision
       FROM users u LEFT JOIN xero_projects_user_links l
         ON l.user_id=u.id AND l.tenant_id=?
       ORDER BY u.display_name COLLATE NOCASE`,
    )
      .bind(tenantId ?? '')
      .all<{
        id: string;
        display_name: string;
        email: string;
        xero_user_id: string | null;
        revision: number | null;
      }>(),
    tenantId
      ? env.DB.prepare(
          `SELECT state,error_code,projects_count,tasks_count,users_count,finished_at
           FROM xero_projects_catalog_runs WHERE tenant_id=?
           ORDER BY started_at DESC LIMIT 1`,
        )
          .bind(tenantId)
          .first<{
            state: string;
            error_code: string | null;
            projects_count: number;
            tasks_count: number;
            users_count: number;
            finished_at: number | null;
          }>()
      : Promise.resolve(null),
  ]);
  const catalog = catalogData(rows);
  const activeProjectIds = new Set(
    catalog.projects.filter((item) => item.active).map((item) => item.id),
  );
  const activeTaskIds = new Set(catalog.tasks.filter((item) => item.active).map((item) => item.id));
  const activeContactIds = new Set(
    catalog.contacts.filter((item) => item.active).map((item) => item.id),
  );
  const activeUserIds = new Set(catalog.users.filter((item) => item.active).map((item) => item.id));
  let choices: ConnectionChoice[] = [];
  if (current?.pending_connections_json) {
    choices = parseJson<ConnectionChoice[]>(current.pending_connections_json) ?? [];
  }
  return {
    configured: xeroConfigured(env),
    enabled: env.XERO_ENABLED === 'true' && Boolean(current?.connected) && !current?.paused,
    processingPaused: !current?.connected || Boolean(current.paused),
    connectionStatus: current?.connected
      ? ('connected' as const)
      : choices.length
        ? ('select_tenant' as const)
        : ('disconnected' as const),
    tenantId,
    tenantName: current?.tenant_name ?? null,
    availableOrganisations: choices.map((choice) => ({
      tenantId: choice.tenantId,
      tenantName: choice.tenantName,
    })),
    cutoverDate: localDate(current?.cutover_at ?? null),
    catalogue: {
      complete: latestRun?.state === 'succeeded',
      refreshedAt: iso(latestRun?.finished_at ?? null),
      error: latestRun?.state === 'failed' ? latestRun.error_code : null,
      contacts: catalog.contacts.filter((item) => item.active).length,
      projects: catalog.projects.filter((item) => item.active).length,
      tasks: catalog.tasks.filter((item) => item.active).length,
      users: catalog.users.filter((item) => item.active).length,
    },
    contactOptions: catalog.contacts,
    projectOptions: catalog.projects.map(({ id, name, detail, active }) => ({
      id,
      name,
      detail,
      active,
    })),
    taskOptions: catalog.tasks.map(({ id, projectId, name, detail, active, chargeType }) => ({
      id,
      projectId,
      name,
      detail,
      active,
      chargeType,
    })),
    userOptions: catalog.users,
    clientMappings: clients.results.map((row) => ({
      localId: row.id,
      localName: row.name,
      xeroContactId: row.contact_id,
      xeroContactName: row.contact_name_snapshot,
      revision: row.revision ?? 0,
      valid: Boolean(row.contact_id && activeContactIds.has(row.contact_id)),
    })),
    workMappings: jobs.results.map((row) => ({
      localId: row.id,
      localName: row.name,
      clientName: row.client_name,
      xeroProjectId: row.project_id,
      xeroProjectName: row.project_name_snapshot,
      xeroTaskId: row.task_id,
      xeroTaskName: row.task_name_snapshot,
      revision: row.revision ?? 0,
      valid: Boolean(
        row.project_id &&
        row.task_id &&
        activeProjectIds.has(row.project_id) &&
        activeTaskIds.has(row.task_id),
      ),
    })),
    userMappings: users.results.map((row) => {
      const remote = catalog.users.find((item) => item.id === row.xero_user_id);
      return {
        localId: row.id,
        localName: row.display_name,
        localEmail: row.email,
        xeroUserId: row.xero_user_id,
        xeroUserName: remote?.name ?? null,
        revision: row.revision ?? 0,
        valid: Boolean(row.xero_user_id && activeUserIds.has(row.xero_user_id)),
      };
    }),
    lastError: latestRun?.state === 'failed' ? latestRun.error_code : null,
  };
}

function syncState(row: ReviewRow) {
  switch (row.outbox_state) {
    case 'queued':
    case 'retry_wait':
      return 'queued' as const;
    case 'leased':
      return 'sending' as const;
    case 'provider_accepted':
      return 'accepted' as const;
    case 'failed':
      return 'failed' as const;
    case 'needs_attention':
      return 'needs_attention' as const;
    default:
      return 'not_queued' as const;
  }
}

function reviewBlockers(row: ReviewRow, cutoverAt: number | null, now: number): string[] {
  const blockers: string[] = [];
  if (!row.connection_connected) blockers.push('Connect and confirm the Xero organisation.');
  if (!row.contact_id) blockers.push('Map the client to a Xero contact.');
  if (!row.xero_user_id) blockers.push('Map the employee to a Xero Projects user.');
  if (!row.project_id || !row.task_id) blockers.push('Choose and save a Xero project and task.');
  if (row.contact_id && !row.contact_active)
    blockers.push('Refresh or replace the inactive Xero contact.');
  if (row.project_id && !row.project_active)
    blockers.push('Refresh or replace the inactive Xero project.');
  if (row.task_id && !row.task_active) blockers.push('Refresh or replace the inactive Xero task.');
  if (row.xero_user_id && !row.user_active)
    blockers.push('Refresh or replace the inactive Xero Projects user.');
  if (cutoverAt === null) blockers.push('Set the Xero cutover date.');
  else if (row.start_at < cutoverAt) blockers.push('This entry is before the Xero cutover date.');

  const freshAfter = now - 24 * 60 * 60_000;
  const fetchedAt = [
    row.contact_fetched_at,
    row.project_fetched_at,
    row.task_fetched_at,
    row.user_fetched_at,
  ];
  if (fetchedAt.some((value) => value === null || value < freshAfter)) {
    blockers.push('Refresh the Xero catalogue; one or more mapped records are over 24 hours old.');
  }

  const contact = row.contact_json
    ? parseJson<{ ContactID?: string; ContactStatus?: string }>(row.contact_json)
    : null;
  const project = row.project_json ? parseJson<XProject>(row.project_json) : null;
  const task = row.task_json ? parseJson<XTask>(row.task_json) : null;
  const user = row.user_json ? parseJson<XUser>(row.user_json) : null;
  if (
    !contact ||
    contact.ContactID?.toLowerCase() !== row.contact_id?.toLowerCase() ||
    contact.ContactStatus !== 'ACTIVE' ||
    !project ||
    project.contactId !== row.contact_id ||
    project.status !== 'INPROGRESS' ||
    !task ||
    task.projectId !== row.project_id ||
    !['TIME', 'FIXED', 'NON_CHARGEABLE'].includes(task.chargeType) ||
    typeof task.rate?.currency !== 'string' ||
    !task.rate.currency.trim() ||
    !Number.isFinite(task.rate.value) ||
    !user ||
    user.userId !== row.xero_user_id
  ) {
    blockers.push(
      'Refresh or correct the Xero mappings; a relationship, status or task rate is invalid.',
    );
  }

  const exactMs = row.end_at - row.start_at;
  const roundedMinutes =
    Math.round((row.lineage_duration_before_ms + exactMs) / 60_000) -
    Math.round(row.lineage_duration_before_ms / 60_000);
  if (roundedMinutes < 1 || roundedMinutes > 59_940) {
    blockers.push('This segment does not have a valid positive whole-minute Xero allocation.');
  }
  if (row.source_drift)
    blockers.push('The locked source changed after approval; review the audit trail.');
  if (row.remote_drift_json)
    blockers.push('The Xero copy differs or is missing; reconcile it first.');
  if (!row.review_ready && !blockers.length) {
    blockers.push('Open the exact preview and resolve the remaining Xero validation issue.');
  }
  return blockers;
}

function reviewDiscrepancies(row: ReviewRow): string[] {
  const discrepancies: string[] = [];
  if (row.source_drift) {
    discrepancies.push('The Timekeeper source entry changed after approval.');
  }
  if (
    row.outbox_state === 'provider_accepted' &&
    row.last_error_code &&
    row.last_error_code !== 'XERO_HTTP_404'
  ) {
    discrepancies.push(
      'The latest Xero status refresh failed; the last confirmed billing status may be stale.',
    );
  }
  if (!row.remote_drift_json) return discrepancies;
  const drift = parseJson<Record<string, unknown>>(row.remote_drift_json);
  if (!drift) {
    discrepancies.push('The saved Xero comparison could not be read.');
    return discrepancies;
  }
  if (drift.missing === true) {
    discrepancies.push('The approved time entry is missing in Xero.');
  }
  const labels: Record<string, string> = {
    userId: 'staff member',
    taskId: 'task / activity',
    duration: 'duration',
    description: 'client-facing description',
    dateUtc: 'work date',
  };
  for (const key of Object.keys(drift).sort()) {
    if (key === 'missing') continue;
    discrepancies.push(`Xero ${labels[key] ?? key} differs from the approved payload.`);
  }
  return discrepancies;
}

function rowToReviewItem(
  row: ReviewRow,
  mappingRevision: number,
  cutoverAt: number | null,
  now: number,
) {
  const blockers = reviewBlockers(row, cutoverAt, now);
  const exactMs = row.end_at - row.start_at;
  const uploadMinutes =
    Math.round((row.lineage_duration_before_ms + exactMs) / 60_000) -
    Math.round(row.lineage_duration_before_ms / 60_000);
  const reviewState =
    row.approval_state === 'approved'
      ? ('approved' as const)
      : !row.review_ready
        ? ('blocked' as const)
        : ('eligible' as const);
  const billingState =
    row.remote_status === 'INVOICED'
      ? ('invoiced' as const)
      : row.remote_status === 'ACTIVE' || row.remote_status === 'LOCKED'
        ? ('not_invoiced' as const)
        : row.outbox_state === 'provider_accepted'
          ? ('unknown' as const)
          : ('unavailable' as const);
  return {
    entryId: row.entry_id,
    entryRevision: row.entry_revision,
    mappingRevision,
    previewHash: '',
    approvalId: row.approval_id,
    outboxId: row.outbox_id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    clientName: row.client_name ?? 'Unclassified client',
    contactId: row.contact_id,
    contactName: row.contact_name,
    projectId: row.project_id,
    projectName: row.project_name,
    taskId: row.task_id,
    taskName: row.task_name,
    workDate: DateTime.fromMillis(row.start_at, { zone: BRISBANE }).toISODate()!,
    startAt: new Date(row.start_at).toISOString(),
    endAt: new Date(row.end_at).toISOString(),
    actualDurationSeconds: exactMs / 1000,
    uploadDurationMinutes: uploadMinutes,
    clientDescription: row.client_description,
    billable: Boolean(row.billable),
    chargeType: row.charge_type,
    rate: row.rate_value,
    currencyCode: row.rate_currency,
    lockedAt: new Date(row.locked_at).toISOString(),
    reviewState,
    syncState: syncState(row),
    billingState,
    remoteStatus: row.remote_status,
    remoteTimeEntryId: row.remote_time_entry_id,
    reviewedByName: row.approved_by_name,
    reviewedAt: iso(row.approved_at),
    statusCheckedAt: iso(row.last_status_checked_at),
    canReturnToReview: Boolean(row.can_return_to_review),
    discrepancies: reviewDiscrepancies(row),
    warnings: row.billing_label
      ? [{ code: 'XERO_STATUS', message: row.billing_label, requiresAcknowledgement: false }]
      : [],
    blockers,
  };
}

const lineageDurationSql = `COALESCE((
  SELECT SUM(prior.end_at-prior.start_at)
    FROM time_entries prior
   WHERE prior.segment_root_id=e.segment_root_id
     AND prior.segment_index<e.segment_index
     AND prior.end_at IS NOT NULL
     AND prior.end_at>prior.start_at
),0)`;

function reviewReadySql(now: number): string {
  const freshAfter = Math.trunc(now - 24 * 60 * 60_000);
  const roundedAllocation = `(
    ROUND((${lineageDurationSql}+(e.end_at-e.start_at))/60000.0)
    - ROUND(${lineageDurationSql}/60000.0)
  )`;
  return `(COALESCE((
    xc.connected=1 AND xc.tenant_id IS NOT NULL AND xc.cutover_at IS NOT NULL
    AND e.start_at>=xc.cutover_at AND e.end_at>e.start_at
    AND cl.contact_id IS NOT NULL AND cl.revision IS NOT NULL
    AND ul.xero_user_id IS NOT NULL AND ul.revision IS NOT NULL
    AND s.project_id IS NOT NULL AND s.task_id IS NOT NULL AND s.selection_revision IS NOT NULL
    AND COALESCE(cc.active,0)=1 AND COALESCE(pc.active,0)=1
    AND COALESCE(tc.active,0)=1 AND COALESCE(uc.active,0)=1
    AND cc.fetched_at>=${freshAfter} AND pc.fetched_at>=${freshAfter}
    AND tc.fetched_at>=${freshAfter} AND uc.fetched_at>=${freshAfter}
    AND CASE WHEN json_valid(cc.data_json)
      THEN lower(json_extract(cc.data_json,'$.ContactID')) END=lower(cl.contact_id)
    AND CASE WHEN json_valid(cc.data_json)
      THEN json_extract(cc.data_json,'$.ContactStatus') END='ACTIVE'
    AND CASE WHEN json_valid(pc.data_json)
      THEN json_extract(pc.data_json,'$.contactId') END=cl.contact_id
    AND CASE WHEN json_valid(pc.data_json)
      THEN json_extract(pc.data_json,'$.status') END='INPROGRESS'
    AND CASE WHEN json_valid(tc.data_json)
      THEN json_extract(tc.data_json,'$.projectId') END=s.project_id
    AND CASE WHEN json_valid(tc.data_json)
      THEN json_extract(tc.data_json,'$.chargeType') END IN ('TIME','FIXED','NON_CHARGEABLE')
    AND CASE WHEN json_valid(tc.data_json)
      THEN trim(json_extract(tc.data_json,'$.rate.currency')) END<>''
    AND CASE WHEN json_valid(tc.data_json)
      THEN json_type(tc.data_json,'$.rate.value') END IN ('integer','real')
    AND CASE WHEN json_valid(uc.data_json)
      THEN json_extract(uc.data_json,'$.userId') END=ul.xero_user_id
    AND ${roundedAllocation} BETWEEN 1 AND 59940
    AND COALESCE(o.source_drift,0)=0 AND o.remote_drift_json IS NULL
  ),0)=1)`;
}

const reviewFromSql = `FROM time_entries e
       JOIN users u ON u.id=e.user_id
       LEFT JOIN xero_projects_connection xc ON xc.id=1
       LEFT JOIN xero_projects_client_links cl
         ON cl.tenant_id=xc.tenant_id AND cl.client_id=e.client_id
       LEFT JOIN xero_projects_user_links ul
         ON ul.tenant_id=xc.tenant_id AND ul.user_id=e.user_id
       LEFT JOIN xero_projects_catalog cc
         ON cc.tenant_id=xc.tenant_id AND cc.kind='contact' AND cc.resource_id=cl.contact_id
       LEFT JOIN xero_projects_entry_selections s ON s.entry_id=e.id AND s.tenant_id=xc.tenant_id
       LEFT JOIN xero_projects_catalog pc
         ON pc.tenant_id=xc.tenant_id AND pc.kind='project' AND pc.resource_id=s.project_id
       LEFT JOIN xero_projects_catalog tc
         ON tc.tenant_id=xc.tenant_id AND tc.kind='task' AND tc.resource_id=s.task_id
       LEFT JOIN xero_projects_catalog uc
         ON uc.tenant_id=xc.tenant_id AND uc.kind='user' AND uc.resource_id=ul.xero_user_id
       LEFT JOIN xero_projects_approval_items ai ON ai.id=(
         SELECT ai2.id FROM xero_projects_approval_items ai2
         JOIN xero_projects_approvals a2 ON a2.id=ai2.approval_id
         WHERE ai2.entry_id=e.id ORDER BY a2.approved_at DESC,ai2.id DESC LIMIT 1
       )
       LEFT JOIN xero_projects_approvals a ON a.id=ai.approval_id
       LEFT JOIN users au ON au.id=a.approved_by_user_id
       LEFT JOIN xero_projects_upload_outbox o ON o.approval_item_id=ai.id`;

type ReviewQueryOptions = {
  entryId?: string;
  state?: string;
  search?: string;
  limit?: number;
  offset?: number;
};

function reviewWhere(
  options: ReviewQueryOptions,
  now: number,
): { sql: string; bindings: unknown[] } {
  const clauses = [`e.work_type='client'`, 'e.end_at IS NOT NULL', 'e.locked_at IS NOT NULL'];
  const bindings: unknown[] = [];
  if (options.entryId) {
    clauses.push('e.id=?');
    bindings.push(options.entryId);
  }
  const search = options.search?.trim().toLowerCase();
  if (search) {
    const escaped = search.replace(/[\\%_]/g, '\\$&');
    clauses.push(`(
      LOWER(u.display_name) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(e.client_name_snapshot,'')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(s.project_name_snapshot,'')) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(s.task_name_snapshot,'')) LIKE ? ESCAPE '\\'
    )`);
    const pattern = `%${escaped}%`;
    bindings.push(pattern, pattern, pattern, pattern);
  }
  switch (options.state) {
    case 'not_queued':
      clauses.push("(o.state IS NULL OR o.state='cancelled')");
      break;
    case 'queued':
      clauses.push("o.state IN ('queued','retry_wait')");
      break;
    case 'sending':
      clauses.push("o.state='leased'");
      break;
    case 'accepted':
      clauses.push("o.state='provider_accepted'");
      break;
    case 'failed':
      clauses.push("o.state='failed'");
      break;
    case 'needs_attention':
      clauses.push("o.state='needs_attention'");
      break;
    case 'approved':
      clauses.push("a.state='approved'");
      break;
    case 'cancelled':
      clauses.push("a.state='cancelled'");
      break;
    case 'blocked':
      clauses.push(`(a.state IS NULL OR a.state='cancelled') AND NOT ${reviewReadySql(now)}`);
      break;
    case 'eligible':
      clauses.push(`(a.state IS NULL OR a.state='cancelled') AND ${reviewReadySql(now)}`);
      break;
  }
  return { sql: clauses.join(' AND '), bindings };
}

async function reviewRows(
  env: Env,
  options: ReviewQueryOptions = {},
  now = Date.now(),
): Promise<ReviewRow[]> {
  const where = reviewWhere(options, now);
  const limitSql = options.limit === undefined ? '' : ' LIMIT ? OFFSET ?';
  const bindings = [...where.bindings];
  if (options.limit !== undefined) bindings.push(options.limit, options.offset ?? 0);
  const result = await env.DB.prepare(
    `SELECT e.id AS entry_id,e.revision AS entry_revision,e.user_id AS employee_id,
            u.display_name AS employee_name,e.client_name_snapshot AS client_name,
            e.job_name_snapshot AS job_name,e.start_at,e.end_at,e.locked_at,
            e.client_description,e.billable,cl.contact_id,cl.contact_name_snapshot AS contact_name,
            ul.xero_user_id,s.project_id,s.project_name_snapshot AS project_name,
            s.task_id,s.task_name_snapshot AS task_name,
            s.task_charge_type_snapshot AS charge_type,
            s.task_rate_currency_snapshot AS rate_currency,
            s.task_rate_value_snapshot AS rate_value,s.selection_revision,
            xc.connected AS connection_connected,
            cc.active AS contact_active,cc.fetched_at AS contact_fetched_at,
            cc.data_json AS contact_json,
            pc.active AS project_active,pc.fetched_at AS project_fetched_at,
            pc.data_json AS project_json,
            tc.active AS task_active,tc.fetched_at AS task_fetched_at,
            tc.data_json AS task_json,
            uc.active AS user_active,uc.fetched_at AS user_fetched_at,
            uc.data_json AS user_json,
            ${lineageDurationSql} AS lineage_duration_before_ms,
            CASE WHEN ${reviewReadySql(now)} THEN 1 ELSE 0 END AS review_ready,
            a.id AS approval_id,a.state AS approval_state,
            COALESCE(au.display_name,a.approved_by_email) AS approved_by_name,a.approved_at,
            o.id AS outbox_id,o.state AS outbox_state,o.remote_time_entry_id,
            o.remote_status_raw AS remote_status,o.billing_label,
            o.last_status_checked_at,o.last_error_code,o.source_drift,o.remote_drift_json,
            CASE WHEN a.state='approved'
              AND EXISTS (
                SELECT 1 FROM xero_projects_upload_outbox cancel_o
                WHERE cancel_o.approval_id=a.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM xero_projects_upload_outbox cancel_o
                WHERE cancel_o.approval_id=a.id
                  AND NOT ${safeReviewResetOutboxSql('cancel_o')}
              )
            THEN 1 ELSE 0 END AS can_return_to_review
       ${reviewFromSql}
       WHERE ${where.sql}
       ORDER BY e.start_at DESC,e.id DESC${limitSql}`,
  )
    .bind(...bindings)
    .all<ReviewRow>();
  return result.results;
}

export async function billingReviewData(
  env: Env,
  options: { state?: string; search?: string; page?: number; pageSize?: number } = {},
) {
  const now = Date.now();
  const current = await connection(env.DB);
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.max(10, Math.min(100, Math.floor(options.pageSize ?? 50)));
  const query = { state: options.state, search: options.search };
  const where = reviewWhere(query, now);
  const readySql = reviewReadySql(now);
  const [aggregate, rows] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN a.state='cancelled' THEN 1 ELSE 0 END) AS cancelled,
              SUM(CASE WHEN a.state='approved' THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN (a.state IS NULL OR a.state='cancelled') AND NOT ${readySql} THEN 1 ELSE 0 END) AS blocked,
              SUM(CASE WHEN (a.state IS NULL OR a.state='cancelled') AND ${readySql} THEN 1 ELSE 0 END) AS eligible,
              SUM(CASE WHEN o.state IS NULL OR o.state='cancelled' THEN 1 ELSE 0 END) AS not_queued,
              SUM(CASE WHEN o.state IN ('queued','retry_wait') THEN 1 ELSE 0 END) AS queued,
              SUM(CASE WHEN o.state='leased' THEN 1 ELSE 0 END) AS sending,
              SUM(CASE WHEN o.state='provider_accepted' THEN 1 ELSE 0 END) AS accepted,
              SUM(CASE WHEN o.state='failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN o.state='needs_attention' THEN 1 ELSE 0 END) AS needs_attention,
              MAX(o.last_status_checked_at) AS last_status_checked_at
         ${reviewFromSql}
        WHERE ${where.sql}`,
    )
      .bind(...where.bindings)
      .first<{
        total: number;
        cancelled: number;
        approved: number;
        blocked: number;
        eligible: number;
        not_queued: number;
        queued: number;
        sending: number;
        accepted: number;
        failed: number;
        needs_attention: number;
        last_status_checked_at: number | null;
      }>(),
    reviewRows(
      env,
      {
        ...query,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      },
      now,
    ),
  ]);
  const total = aggregate?.total ?? 0;
  const items = rows.map((row) =>
    rowToReviewItem(row, current?.mapping_revision ?? 0, current?.cutover_at ?? null, now),
  );
  const counts = {
    eligible: aggregate?.eligible ?? 0,
    blocked: aggregate?.blocked ?? 0,
    approved: aggregate?.approved ?? 0,
    cancelled: aggregate?.cancelled ?? 0,
    not_queued: aggregate?.not_queued ?? 0,
    queued: aggregate?.queued ?? 0,
    sending: aggregate?.sending ?? 0,
    accepted: aggregate?.accepted ?? 0,
    failed: aggregate?.failed ?? 0,
    needs_attention: aggregate?.needs_attention ?? 0,
  };
  return {
    items,
    page,
    pageSize,
    total,
    hasMore: page * pageSize < total,
    counts,
    tenantName: current?.tenant_name ?? null,
    uploadsEnabled: env.XERO_ENABLED === 'true' && Boolean(current?.connected),
    processingPaused: !current?.connected || Boolean(current.paused),
    lastStatusRefreshAt: iso(aggregate?.last_status_checked_at ?? null),
  };
}

function previewWarnings(preview: ReviewPreview) {
  return preview.warnings.map((warning) => ({
    code: warning.code,
    message: warning.message,
    requiresAcknowledgement: true,
  }));
}

export async function billingReviewPreview(env: Env, actor: User, entryId: string) {
  const now = Date.now();
  const current = await connection(env.DB);
  const [row] = await reviewRows(env, { entryId }, now);
  if (!row) return null;
  const base = rowToReviewItem(
    row,
    current?.mapping_revision ?? 0,
    current?.cutover_at ?? null,
    now,
  );
  const preview = await previewReview(env, xeroActor(actor), [entryId], now);
  const exact = preview.items[0];
  const warnings = [...base.warnings, ...previewWarnings(preview)].filter(
    (warning, index, all) =>
      all.findIndex(
        (candidate) => candidate.code === warning.code && candidate.message === warning.message,
      ) === index,
  );
  return {
    ...base,
    entryRevision: exact?.sourceRevision ?? base.entryRevision,
    mappingRevision: exact?.mappingRevision ?? base.mappingRevision,
    previewHash: preview.previewHash,
    workDate: exact?.workDate ?? base.workDate,
    actualDurationSeconds: exact ? exact.exactDurationMs / 1000 : base.actualDurationSeconds,
    uploadDurationMinutes: exact?.roundedMinutes ?? base.uploadDurationMinutes,
    clientDescription: exact?.clientDescription ?? base.clientDescription,
    chargeType:
      (exact?.mappingSnapshot.taskChargeType as ReviewRow['charge_type'] | undefined) ??
      base.chargeType,
    rate:
      typeof (exact?.mappingSnapshot.taskRate as { value?: unknown } | undefined)?.value ===
      'number'
        ? ((exact!.mappingSnapshot.taskRate as { value: number }).value ?? base.rate)
        : base.rate,
    currencyCode:
      typeof (exact?.mappingSnapshot.taskRate as { currency?: unknown } | undefined)?.currency ===
      'string'
        ? ((exact!.mappingSnapshot.taskRate as { currency: string }).currency ?? base.currencyCode)
        : base.currencyCode,
    warnings,
    blockers: preview.blockingIssues.map((issue) => issue.message),
    reviewState:
      base.reviewState === 'approved'
        ? base.reviewState
        : preview.ready
          ? ('eligible' as const)
          : ('blocked' as const),
  };
}
