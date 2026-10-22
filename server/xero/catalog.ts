import { activeContactPages, projectPages, xeroRequest } from './api';
import { audit, connection } from './oauth';
import { latestFridayCutoff } from '../time';
import {
  enabled,
  requireAdmin,
  requireId,
  XeroProblem,
  type Actor,
  type CatalogueKind,
  type CatalogueRecord,
  type XProject,
  type XTask,
  type XUser,
  type XeroEnv,
} from './types';

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export async function tenant(env: XeroEnv): Promise<string> {
  enabled(env);
  const current = await connection(env.DB);
  if (!current?.connected || !current.tenant_id) {
    throw new XeroProblem('RECONNECT', 'Connect and confirm the practice Xero organisation.', 503);
  }
  return current.tenant_id;
}

export async function cached<T>(
  db: D1Database,
  tenantId: string,
  kind: CatalogueKind,
  id: string,
): Promise<CatalogueRecord<T>> {
  const row = await db
    .prepare(
      `SELECT data_json,fetched_at,catalogue_revision
       FROM xero_projects_catalog
       WHERE tenant_id=? AND kind=? AND resource_id=? AND active=1`,
    )
    .bind(tenantId, kind, id)
    .first<{
      data_json: string;
      fetched_at: number;
      catalogue_revision: number;
    }>();
  if (!row) {
    throw new XeroProblem(
      'CATALOGUE',
      'Refresh the catalogue and choose a current project, task or staff member.',
      409,
    );
  }
  return {
    data: JSON.parse(row.data_json) as T,
    fetchedAt: row.fetched_at,
    catalogueRevision: row.catalogue_revision,
  };
}

export async function listCatalogue<T>(
  env: XeroEnv,
  kind: CatalogueKind,
  input: { parentId?: string; search?: string; limit?: number } = {},
): Promise<
  { id: string; parentId: string; data: T; fetchedAt: number; catalogueRevision: number }[]
> {
  const tenantId = await tenant(env);
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
  const search = (input.search ?? '').trim().toLowerCase().slice(0, 120);
  const parentId = input.parentId ? requireId(input.parentId, 'parent') : null;
  const rows = await env.DB.prepare(
    `SELECT resource_id,parent_id,data_json,fetched_at,catalogue_revision
       FROM xero_projects_catalog
       WHERE tenant_id=? AND kind=? AND active=1
         AND (? IS NULL OR parent_id=?)
         AND (?='' OR lower(data_json) LIKE '%' || ? || '%')
       ORDER BY lower(data_json),resource_id LIMIT ?`,
  )
    .bind(tenantId, kind, parentId, parentId, search, search, limit)
    .all<{
      resource_id: string;
      parent_id: string;
      data_json: string;
      fetched_at: number;
      catalogue_revision: number;
    }>();
  return rows.results.map((row) => ({
    id: row.resource_id,
    parentId: row.parent_id,
    data: JSON.parse(row.data_json) as T,
    fetchedAt: row.fetched_at,
    catalogueRevision: row.catalogue_revision,
  }));
}

export interface ValidatedEntrySelectionSnapshot {
  tenantId: string;
  projectId: string;
  taskId: string;
  projectName: string;
  taskName: string;
  taskChargeType: XTask['chargeType'];
  taskRateCurrency: string;
  taskRateValue: number;
  projectCatalogueRevision: number;
  taskCatalogueRevision: number;
  currentSelectionRevision: number | null;
}

/** Read-only validator used before ordinary saves and audited locked corrections. */
export async function validatedEntrySelectionSnapshot(
  env: XeroEnv,
  input: {
    clientId: string;
    projectId: string;
    taskId: string;
    entryId?: string;
  },
): Promise<ValidatedEntrySelectionSnapshot> {
  const tenantId = await tenant(env);
  const clientId = requireId(input.clientId, 'client');
  const projectId = requireId(input.projectId, 'project');
  const taskId = requireId(input.taskId, 'task');
  const entryId = input.entryId ? requireId(input.entryId, 'entry') : null;
  const link = await env.DB.prepare(
    `SELECT l.contact_id,
              (SELECT selection_revision FROM xero_projects_entry_selections
               WHERE entry_id=?) AS selection_revision
       FROM clients c
       JOIN xero_projects_client_links l
         ON l.tenant_id=? AND l.client_id=c.id
       WHERE c.id=? AND c.active=1`,
  )
    .bind(entryId, tenantId, clientId)
    .first<{ contact_id: string; selection_revision: number | null }>();
  if (!link) {
    throw new XeroProblem(
      'CLIENT_MAPPING',
      'Map the active client to a Xero contact before selecting project work.',
    );
  }
  const projectRecord = await cached<XProject>(env.DB, tenantId, 'project', projectId);
  const taskRecord = await cached<XTask>(env.DB, tenantId, 'task', taskId);
  const project = projectRecord.data;
  const task = taskRecord.data;
  if (project.contactId !== link.contact_id || project.status !== 'INPROGRESS') {
    throw new XeroProblem(
      'PROJECT_RELATIONSHIP',
      'The project must be open and belong to the corrected client’s mapped Xero contact.',
    );
  }
  if (task.projectId !== projectId) {
    throw new XeroProblem('TASK_RELATIONSHIP', 'The task must belong to the selected project.');
  }
  return {
    tenantId,
    projectId,
    taskId,
    projectName: project.name,
    taskName: task.name,
    taskChargeType: task.chargeType,
    taskRateCurrency: task.rate.currency,
    taskRateValue: task.rate.value,
    projectCatalogueRevision: projectRecord.catalogueRevision,
    taskCatalogueRevision: taskRecord.catalogueRevision,
    currentSelectionRevision: link.selection_revision,
  };
}

export async function listProjectOptionsForClient(
  env: XeroEnv,
  clientIdInput: string,
  search = '',
  limit = 100,
): Promise<{ id: string; name: string; contactId: string }[]> {
  const tenantId = await tenant(env);
  const clientId = requireId(clientIdInput, 'client');
  const link = await env.DB.prepare(
    `SELECT contact_id FROM xero_projects_client_links
       WHERE tenant_id=? AND client_id=?`,
  )
    .bind(tenantId, clientId)
    .first<{ contact_id: string }>();
  if (!link) return [];
  const rows = await listCatalogue<XProject>(env, 'project', {
    parentId: link.contact_id,
    search,
    limit,
  });
  return rows
    .filter((row) => row.data.status === 'INPROGRESS')
    .map((row) => ({
      id: row.id,
      name: row.data.name,
      contactId: row.data.contactId,
    }));
}

export async function listTaskOptionsForProject(
  env: XeroEnv,
  projectIdInput: string,
  search = '',
  limit = 100,
): Promise<
  {
    id: string;
    name: string;
    chargeType: XTask['chargeType'];
    rate: { currency: string; value: number };
  }[]
> {
  const projectId = requireId(projectIdInput, 'project');
  const rows = await listCatalogue<XTask>(env, 'task', {
    parentId: projectId,
    search,
    limit,
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.data.name,
    chargeType: row.data.chargeType,
    rate: row.data.rate,
  }));
}

async function stageRows(
  db: D1Database,
  runId: string,
  tenantId: string,
  kind: 'project' | 'task' | 'user' | 'contact',
  rows: { id: string; parent: string; data: unknown }[],
  now: number,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += 50) {
    await db.batch(
      rows.slice(offset, offset + 50).map((row) =>
        db
          .prepare(
            `INSERT INTO xero_projects_catalog_staging
             (run_id,tenant_id,kind,resource_id,parent_id,data_json,fetched_at)
             VALUES(?,?,?,?,?,?,?)`,
          )
          .bind(runId, tenantId, kind, row.id, row.parent, JSON.stringify(row.data), now),
      ),
    );
  }
}

function assertProject(value: XProject): void {
  requireId(value.projectId, 'project');
  requireId(value.contactId, 'contact');
  if (
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    !['INPROGRESS', 'CLOSED'].includes(value.status)
  ) {
    throw new XeroProblem('RESPONSE', 'Xero returned an invalid project.', 502);
  }
}

function assertTask(value: XTask, projectId: string): void {
  requireId(value.taskId, 'task');
  if (
    value.projectId !== projectId ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    !['TIME', 'FIXED', 'NON_CHARGEABLE'].includes(value.chargeType) ||
    typeof value.rate?.currency !== 'string' ||
    !Number.isFinite(value.rate.value)
  ) {
    throw new XeroProblem('RESPONSE', 'Xero returned an invalid task, relationship or rate.', 502);
  }
}

/**
 * Refreshes every project, every project's complete task list, and all
 * Projects users. Staging keeps a failed/partial run from becoming active.
 */
export async function refreshCatalogue(
  env: XeroEnv,
  actor: Actor,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<{
  runId: string;
  projects: number;
  tasks: number;
  users: number;
  contacts: number;
  catalogueRevision: number;
}> {
  requireAdmin(actor);
  const tenantId = await tenant(env);
  const lease = crypto.randomUUID();
  const leaseClaim = await env.DB.prepare(
    `UPDATE xero_projects_connection
       SET catalogue_lease_token=?,catalogue_lease_until=?,updated_at=?
       WHERE id=1 AND tenant_id=? AND catalogue_lease_until<=?
       RETURNING catalogue_revision`,
  )
    .bind(lease, now + 60 * 60_000, now, tenantId, now)
    .first<{ catalogue_revision: number }>();
  if (!leaseClaim) {
    throw new XeroProblem('CATALOGUE_BUSY', 'Another catalogue refresh is running.', 409);
  }
  const runId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO xero_projects_catalog_runs
       (id,tenant_id,state,started_at) VALUES(?,?,'running',?)`,
  )
    .bind(runId, tenantId, now)
    .run();
  try {
    const projects = await projectPages<XProject>(env, '/Projects', tenantId, fetcher, now);
    const users = await projectPages<XUser>(env, '/ProjectsUsers', tenantId, fetcher, now);
    const contacts = await activeContactPages<{
      ContactID: string;
      Name: string;
      ContactStatus: string;
    }>(env, tenantId, fetcher, now);
    for (const project of projects) assertProject(project);
    for (const user of users) {
      requireId(user.userId, 'Projects user');
      if (
        typeof user.name !== 'string' ||
        typeof user.email !== 'string' ||
        !user.email.includes('@')
      ) {
        throw new XeroProblem('RESPONSE', 'A Projects user is missing a valid identity.', 502);
      }
    }
    for (const contact of contacts) {
      requireId(contact.ContactID, 'contact');
      if (
        typeof contact.Name !== 'string' ||
        !contact.Name.trim() ||
        contact.ContactStatus !== 'ACTIVE'
      ) {
        throw new XeroProblem('RESPONSE', 'Xero returned an invalid or non-active contact.', 502);
      }
    }
    const tasks: XTask[] = [];
    for (const project of projects) {
      const projectTasks = await projectPages<XTask>(
        env,
        `/Projects/${project.projectId}/Tasks`,
        tenantId,
        fetcher,
        now,
      );
      for (const task of projectTasks) assertTask(task, project.projectId);
      tasks.push(...projectTasks);
    }

    await stageRows(
      env.DB,
      runId,
      tenantId,
      'project',
      projects.map((project) => ({
        id: project.projectId,
        parent: project.contactId,
        data: project,
      })),
      now,
    );
    await stageRows(
      env.DB,
      runId,
      tenantId,
      'task',
      tasks.map((task) => ({
        id: task.taskId,
        parent: task.projectId,
        data: task,
      })),
      now,
    );
    await stageRows(
      env.DB,
      runId,
      tenantId,
      'user',
      users.map((user) => ({ id: user.userId, parent: '', data: user })),
      now,
    );
    await stageRows(
      env.DB,
      runId,
      tenantId,
      'contact',
      contacts.map((contact) => ({
        id: contact.ContactID,
        parent: '',
        // Deliberately minimise Accounting contact data. The source response
        // can contain bank, tax, address, phone and balance fields that this
        // timekeeping integration must never persist.
        data: {
          ContactID: contact.ContactID,
          Name: contact.Name,
          ContactStatus: contact.ContactStatus,
        },
      })),
      now,
    );

    const revision = leaseClaim.catalogue_revision + 1;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE xero_projects_transaction_guard
           SET asserted=CASE WHEN EXISTS(
             SELECT 1 FROM xero_projects_connection
             WHERE id=1 AND tenant_id=? AND catalogue_lease_token=?
               AND catalogue_lease_until>? AND catalogue_revision=?
           ) THEN 1 ELSE 0 END WHERE id=1`,
      ).bind(tenantId, lease, now, leaseClaim.catalogue_revision),
      ...(['project', 'task', 'user', 'contact'] as const).map((kind) =>
        env.DB.prepare(
          `INSERT INTO xero_projects_catalog
               (tenant_id,kind,resource_id,parent_id,data_json,active,fetched_at,catalogue_revision)
             SELECT tenant_id,kind,resource_id,parent_id,data_json,1,fetched_at,?
             FROM xero_projects_catalog_staging
             WHERE run_id=? AND kind=?
             ON CONFLICT(tenant_id,kind,resource_id) DO UPDATE SET
               parent_id=excluded.parent_id,
               data_json=excluded.data_json,
               active=1,
               fetched_at=excluded.fetched_at,
               catalogue_revision=excluded.catalogue_revision`,
        ).bind(revision, runId, kind),
      ),
      ...(['project', 'task', 'user', 'contact'] as const).map((kind) =>
        env.DB.prepare(
          `UPDATE xero_projects_catalog SET active=0,catalogue_revision=?
             WHERE tenant_id=? AND kind=? AND resource_id NOT IN
               (SELECT resource_id FROM xero_projects_catalog_staging
                WHERE run_id=? AND kind=?)`,
        ).bind(revision, tenantId, kind, runId, kind),
      ),
      env.DB.prepare(
        `UPDATE xero_projects_connection
           SET catalogue_revision=?,catalogue_lease_token=NULL,
               catalogue_lease_until=0,updated_at=?
           WHERE id=1 AND tenant_id=? AND catalogue_lease_token=?`,
      ).bind(revision, now, tenantId, lease),
      env.DB.prepare(
        `UPDATE xero_projects_catalog_runs
           SET state='succeeded',projects_count=?,tasks_count=?,users_count=?,contacts_count=?,finished_at=?
           WHERE id=?`,
      ).bind(projects.length, tasks.length, users.length, contacts.length, now, runId),
      env.DB.prepare('DELETE FROM xero_projects_catalog_staging WHERE run_id=?').bind(runId),
      audit(
        env.DB,
        actor,
        'catalogue_refreshed',
        tenantId,
        {
          runId,
          projects: projects.length,
          tasks: tasks.length,
          users: users.length,
          contacts: contacts.length,
          catalogueRevision: revision,
        },
        now,
      ),
    ]);
    return {
      runId,
      projects: projects.length,
      tasks: tasks.length,
      users: users.length,
      contacts: contacts.length,
      catalogueRevision: revision,
    };
  } catch (error) {
    const code = error instanceof XeroProblem ? error.code : 'UNEXPECTED';
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE xero_projects_catalog_runs
           SET state='failed',error_code=?,finished_at=? WHERE id=?`,
      ).bind(code, now, runId),
      env.DB.prepare('DELETE FROM xero_projects_catalog_staging WHERE run_id=?').bind(runId),
    ]);
    throw error;
  } finally {
    await env.DB.prepare(
      `UPDATE xero_projects_connection
         SET catalogue_lease_token=NULL,catalogue_lease_until=0
         WHERE id=1 AND catalogue_lease_token=?`,
    )
      .bind(lease)
      .run();
  }
}

export async function mapClient(
  env: XeroEnv,
  actor: Actor,
  clientIdInput: string,
  contactIdInput: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ clientName: string; contactName: string }> {
  requireAdmin(actor);
  const clientId = requireId(clientIdInput, 'client');
  const contactId = requireId(contactIdInput, 'contact');
  const tenantId = await tenant(env);
  const client = await env.DB.prepare('SELECT id,name FROM clients WHERE id=? AND active=1')
    .bind(clientId)
    .first<{ id: string; name: string }>();
  if (!client) {
    throw new XeroProblem('CLIENT', 'Choose an active Timekeeper client.');
  }
  const body = await xeroRequest<{
    Contacts?: { ContactID: string; Name: string; ContactStatus: string }[];
  }>(env, `/Contacts/${contactId}`, {
    tenantId,
    accounting: true,
    fetcher,
    now,
  });
  const contact = body.Contacts?.find(
    (value) => value.ContactID.toLowerCase() === contactId && value.ContactStatus === 'ACTIVE',
  );
  if (!contact) {
    throw new XeroProblem(
      'CONTACT',
      'Choose an active Xero contact in the connected organisation.',
    );
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO xero_projects_client_links
         (tenant_id,client_id,contact_id,contact_name_snapshot,revision,mapped_by_user_id,mapped_at)
         VALUES(?,?,?,?,1,?,?)
         ON CONFLICT(tenant_id,client_id) DO UPDATE SET
           contact_id=excluded.contact_id,
           contact_name_snapshot=excluded.contact_name_snapshot,
           revision=xero_projects_client_links.revision+1,
           mapped_by_user_id=excluded.mapped_by_user_id,
           mapped_at=excluded.mapped_at`,
    ).bind(tenantId, clientId, contactId, contact.Name, actor.id, now),
    env.DB.prepare(
      `INSERT INTO xero_projects_catalog
         (tenant_id,kind,resource_id,parent_id,data_json,active,fetched_at,catalogue_revision)
         VALUES(?,'contact',?,'',?,1,?,COALESCE((SELECT catalogue_revision FROM xero_projects_connection WHERE id=1),0))
         ON CONFLICT(tenant_id,kind,resource_id) DO UPDATE SET
           data_json=excluded.data_json,active=1,fetched_at=excluded.fetched_at`,
    ).bind(
      tenantId,
      contactId,
      JSON.stringify({
        ContactID: contact.ContactID,
        Name: contact.Name,
        ContactStatus: contact.ContactStatus,
      }),
      now,
    ),
    env.DB.prepare(
      `UPDATE xero_projects_connection
         SET mapping_revision=mapping_revision+1,updated_at=? WHERE id=1`,
    ).bind(now),
    audit(
      env.DB,
      actor,
      'client_mapping',
      clientId,
      { contactId, contactName: contact.Name, clientName: client.name },
      now,
    ),
  ]);
  return { clientName: client.name, contactName: contact.Name };
}

export async function mapUser(
  env: XeroEnv,
  actor: Actor,
  userIdInput: string,
  xeroUserIdInput: string,
  acknowledgeDifferentEmail = false,
  now = Date.now(),
): Promise<void> {
  requireAdmin(actor);
  const userId = requireId(userIdInput, 'employee');
  const xeroUserId = requireId(xeroUserIdInput, 'Projects user');
  const tenantId = await tenant(env);
  const local = await env.DB.prepare('SELECT id,email,display_name FROM users WHERE id=?')
    .bind(userId)
    .first<{ id: string; email: string; display_name: string }>();
  const remote = (await cached<XUser>(env.DB, tenantId, 'user', xeroUserId)).data;
  if (!local) {
    throw new XeroProblem('EMPLOYEE', 'Choose an existing employee.');
  }
  if (local.email.toLowerCase() !== remote.email.toLowerCase() && !acknowledgeDifferentEmail) {
    throw new XeroProblem(
      'EMAIL_MISMATCH',
      'The emails differ. Verify both identities and acknowledge the mapping.',
    );
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO xero_projects_user_links
         (tenant_id,user_id,xero_user_id,xero_email_snapshot,revision,mapped_by_user_id,mapped_at)
         VALUES(?,?,?,?,1,?,?)
         ON CONFLICT(tenant_id,user_id) DO UPDATE SET
           xero_user_id=excluded.xero_user_id,
           xero_email_snapshot=excluded.xero_email_snapshot,
           revision=xero_projects_user_links.revision+1,
           mapped_by_user_id=excluded.mapped_by_user_id,
           mapped_at=excluded.mapped_at`,
    ).bind(tenantId, userId, xeroUserId, remote.email, actor.id, now),
    env.DB.prepare(
      `UPDATE xero_projects_connection
         SET mapping_revision=mapping_revision+1,updated_at=? WHERE id=1`,
    ).bind(now),
    audit(
      env.DB,
      actor,
      'employee_mapping',
      userId,
      {
        xeroUserId,
        localEmail: local.email,
        xeroEmail: remote.email,
        acknowledgeDifferentEmail,
      },
      now,
    ),
  ]);
}

async function unmap(
  env: XeroEnv,
  actor: Actor,
  table: 'xero_projects_client_links' | 'xero_projects_user_links' | 'xero_projects_work_links',
  column: 'client_id' | 'user_id' | 'job_id',
  localIdInput: string,
  action: string,
  now: number,
): Promise<{ removed: boolean }> {
  requireAdmin(actor);
  const localId = requireId(localIdInput);
  const tenantId = await tenant(env);
  const result = await env.DB.prepare(`DELETE FROM ${table} WHERE tenant_id=? AND ${column}=?`)
    .bind(tenantId, localId)
    .run();
  const removed = (result.meta.changes ?? 0) === 1;
  if (removed) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE xero_projects_connection
           SET mapping_revision=mapping_revision+1,updated_at=? WHERE id=1`,
      ).bind(now),
      audit(env.DB, actor, action, localId, { tenantId, historicalSnapshotsPreserved: true }, now),
    ]);
  }
  return { removed };
}

export function unmapClient(
  env: XeroEnv,
  actor: Actor,
  clientId: string,
  now = Date.now(),
): Promise<{ removed: boolean }> {
  return unmap(
    env,
    actor,
    'xero_projects_client_links',
    'client_id',
    clientId,
    'client_mapping_removed',
    now,
  );
}

export function unmapUser(
  env: XeroEnv,
  actor: Actor,
  userId: string,
  now = Date.now(),
): Promise<{ removed: boolean }> {
  return unmap(
    env,
    actor,
    'xero_projects_user_links',
    'user_id',
    userId,
    'employee_mapping_removed',
    now,
  );
}

export function unmapWork(
  env: XeroEnv,
  actor: Actor,
  jobId: string,
  now = Date.now(),
): Promise<{ removed: boolean }> {
  return unmap(
    env,
    actor,
    'xero_projects_work_links',
    'job_id',
    jobId,
    'work_mapping_removed',
    now,
  );
}

export async function mapWork(
  env: XeroEnv,
  actor: Actor,
  jobIdInput: string,
  projectIdInput: string,
  taskIdInput: string,
  now = Date.now(),
): Promise<void> {
  requireAdmin(actor);
  const jobId = requireId(jobIdInput, 'job');
  const projectId = requireId(projectIdInput, 'project');
  const taskId = requireId(taskIdInput, 'task');
  const tenantId = await tenant(env);
  const job = await env.DB.prepare(
    `SELECT j.id,j.client_id,j.name,c.active AS client_active,j.active AS job_active,
              l.contact_id
       FROM jobs j
       JOIN clients c ON c.id=j.client_id
       LEFT JOIN xero_projects_client_links l
         ON l.tenant_id=? AND l.client_id=j.client_id
       WHERE j.id=?`,
  )
    .bind(tenantId, jobId)
    .first<{
      id: string;
      client_id: string;
      name: string;
      client_active: number;
      job_active: number;
      contact_id: string | null;
    }>();
  if (!job || !job.client_active || !job.job_active) {
    throw new XeroProblem('JOB', 'Choose an active client job.');
  }
  if (!job.contact_id) {
    throw new XeroProblem('CLIENT_MAPPING', 'Map this job’s client to a Xero contact first.');
  }
  const projectRecord = await cached<XProject>(env.DB, tenantId, 'project', projectId);
  const taskRecord = await cached<XTask>(env.DB, tenantId, 'task', taskId);
  const project = projectRecord.data;
  const task = taskRecord.data;
  if (project.contactId !== job.contact_id || project.status !== 'INPROGRESS') {
    throw new XeroProblem(
      'PROJECT_RELATIONSHIP',
      'The project must be open and belong to the client’s mapped Xero contact.',
    );
  }
  if (task.projectId !== projectId) {
    throw new XeroProblem(
      'TASK_RELATIONSHIP',
      'The task must belong to the selected active project.',
    );
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO xero_projects_work_links
         (tenant_id,job_id,project_id,task_id,project_name_snapshot,task_name_snapshot,
          task_charge_type_snapshot,task_rate_currency_snapshot,task_rate_value_snapshot,
          revision,mapped_by_user_id,mapped_at)
         VALUES(?,?,?,?,?,?,?,?,?,1,?,?)
         ON CONFLICT(tenant_id,job_id) DO UPDATE SET
           project_id=excluded.project_id,task_id=excluded.task_id,
           project_name_snapshot=excluded.project_name_snapshot,
           task_name_snapshot=excluded.task_name_snapshot,
           task_charge_type_snapshot=excluded.task_charge_type_snapshot,
           task_rate_currency_snapshot=excluded.task_rate_currency_snapshot,
           task_rate_value_snapshot=excluded.task_rate_value_snapshot,
           revision=xero_projects_work_links.revision+1,
           mapped_by_user_id=excluded.mapped_by_user_id,mapped_at=excluded.mapped_at`,
    ).bind(
      tenantId,
      jobId,
      projectId,
      taskId,
      project.name,
      task.name,
      task.chargeType,
      task.rate.currency,
      task.rate.value,
      actor.id,
      now,
    ),
    env.DB.prepare(
      `UPDATE xero_projects_connection
         SET mapping_revision=mapping_revision+1,updated_at=? WHERE id=1`,
    ).bind(now),
    audit(
      env.DB,
      actor,
      'work_mapping',
      jobId,
      {
        projectId,
        taskId,
        projectName: project.name,
        taskName: task.name,
        rate: task.rate,
      },
      now,
    ),
  ]);
}

export async function suggestedSelectionForJob(
  env: XeroEnv,
  jobIdInput: string,
): Promise<{
  projectId: string;
  taskId: string;
  projectName: string;
  taskName: string;
} | null> {
  const jobId = requireId(jobIdInput, 'job');
  const tenantId = await tenant(env);
  const row = await env.DB.prepare(
    `SELECT l.project_id,l.task_id,p.data_json AS project_json,
              t.data_json AS task_json
       FROM xero_projects_work_links l
       JOIN xero_projects_catalog p
         ON p.tenant_id=l.tenant_id AND p.kind='project'
        AND p.resource_id=l.project_id AND p.active=1
       JOIN xero_projects_catalog t
         ON t.tenant_id=l.tenant_id AND t.kind='task'
        AND t.resource_id=l.task_id AND t.active=1
       WHERE l.tenant_id=? AND l.job_id=?`,
  )
    .bind(tenantId, jobId)
    .first<{
      project_id: string;
      task_id: string;
      project_json: string;
      task_json: string;
    }>();
  if (!row) return null;
  const project = JSON.parse(row.project_json) as XProject;
  const task = JSON.parse(row.task_json) as XTask;
  return {
    projectId: row.project_id,
    taskId: row.task_id,
    projectName: project.name,
    taskName: task.name,
  };
}

/**
 * Persists the project/task actually selected for an entry. The job mapping is
 * only a suggested default; review always reads this explicit snapshot.
 */
export async function saveEntrySelection(
  env: XeroEnv,
  actor: Actor,
  input: {
    entryId: string;
    projectId: string;
    taskId: string;
    expectedSourceRevision: number;
    expectedSelectionRevision?: number;
  },
  now = Date.now(),
): Promise<{
  entryId: string;
  selectionRevision: number;
  projectId: string;
  taskId: string;
  projectName: string;
  taskName: string;
  chargeType: string;
  rate: { currency: string; value: number };
}> {
  enabled(env);
  const entryId = requireId(input.entryId, 'entry');
  const projectId = requireId(input.projectId, 'project');
  const taskId = requireId(input.taskId, 'task');
  const tenantId = await tenant(env);
  const logicalFridayCutoff = latestFridayCutoff(new Date(now)).getTime();
  const entry = await env.DB.prepare(
    `SELECT e.id,e.user_id,e.revision,e.work_type,e.client_id,e.job_id,e.start_at,e.locked_at,l.contact_id,
              s.selection_revision,
              CASE
                WHEN c.activated_at IS NULL THEN COALESCE((
                  SELECT MAX(p.cutoff_at) FROM close_periods p
                  WHERE p.status IN ('closing','closed','report_failed')
                ), -9223372036854775808)
                ELSE MAX(c.closed_through, COALESCE((
                  SELECT MAX(p.cutoff_at) FROM close_periods p
                  WHERE p.status IN ('closing','closed','report_failed')
                ), 0), ?)
              END AS effective_cutoff
       FROM time_entries e
       CROSS JOIN close_control c
       LEFT JOIN xero_projects_client_links l
         ON l.tenant_id=? AND l.client_id=e.client_id
       LEFT JOIN xero_projects_entry_selections s ON s.entry_id=e.id
       WHERE c.id=1 AND e.id=?`,
  )
    .bind(logicalFridayCutoff, tenantId, entryId)
    .first<{
      id: string;
      user_id: string;
      revision: number;
      work_type: string;
      client_id: string | null;
      job_id: string | null;
      start_at: number;
      locked_at: number | null;
      contact_id: string | null;
      selection_revision: number | null;
      effective_cutoff: number;
    }>();
  if (!entry || entry.work_type !== 'client' || !entry.client_id) {
    throw new XeroProblem(
      'ENTRY_CLASSIFICATION',
      'Choose a classified client entry before selecting Xero work. The FYI project/activity may remain blank.',
    );
  }
  if (entry.revision !== input.expectedSourceRevision) {
    throw new XeroProblem(
      'SOURCE_CHANGED',
      'The entry changed before its Xero selection could be saved. Reload and try again.',
      409,
    );
  }
  if (entry.user_id !== actor.id && actor.role !== 'admin') {
    throw new XeroProblem('FORBIDDEN', 'You can select Xero work only for your own entry.', 403);
  }
  if (entry.locked_at !== null || entry.start_at < entry.effective_cutoff) {
    throw new XeroProblem(
      'ENTRY_LOCKED',
      'Use the audited correction flow for a locked entry.',
      409,
    );
  }
  if (!entry.contact_id) {
    throw new XeroProblem('CLIENT_MAPPING', 'Map this client to a Xero contact first.');
  }
  if (
    entry.selection_revision !== null &&
    input.expectedSelectionRevision !== entry.selection_revision
  ) {
    throw new XeroProblem(
      'SELECTION_CHANGED',
      'The Xero selection changed. Reload the entry before saving.',
      409,
    );
  }
  if (entry.selection_revision === null && input.expectedSelectionRevision !== undefined) {
    throw new XeroProblem(
      'SELECTION_CHANGED',
      'This entry does not yet have a saved Xero selection.',
      409,
    );
  }
  const projectRecord = await cached<XProject>(env.DB, tenantId, 'project', projectId);
  const taskRecord = await cached<XTask>(env.DB, tenantId, 'task', taskId);
  const project = projectRecord.data;
  const task = taskRecord.data;
  if (project.contactId !== entry.contact_id || project.status !== 'INPROGRESS') {
    throw new XeroProblem(
      'PROJECT_RELATIONSHIP',
      'The project must be open and belong to the mapped client contact.',
    );
  }
  if (task.projectId !== projectId) {
    throw new XeroProblem(
      'TASK_RELATIONSHIP',
      'The task must belong to the selected active project.',
    );
  }
  const catalogueGuard = `EXISTS (
    SELECT 1
    FROM xero_projects_catalog p
    JOIN xero_projects_catalog t ON t.tenant_id=p.tenant_id
    WHERE p.tenant_id=? AND p.kind='project' AND p.resource_id=?
      AND p.parent_id=? AND p.active=1 AND p.catalogue_revision=?
      AND json_extract(p.data_json,'$.status')='INPROGRESS'
      AND t.kind='task' AND t.resource_id=? AND t.parent_id=p.resource_id
      AND t.active=1 AND t.catalogue_revision=?
  )`;
  const statement =
    entry.selection_revision === null
      ? env.DB.prepare(
          `INSERT OR IGNORE INTO xero_projects_entry_selections
           (entry_id,tenant_id,project_id,task_id,project_name_snapshot,
            task_name_snapshot,task_charge_type_snapshot,
            task_rate_currency_snapshot,task_rate_value_snapshot,
            project_catalogue_revision,task_catalogue_revision,
            selection_revision,selected_by_user_id,selected_at)
           SELECT ?,?,?,?,?,?,?,?,?,?,?,1,?,?
           WHERE EXISTS (
             SELECT 1 FROM time_entries e
             CROSS JOIN close_control c
             WHERE c.id=1 AND e.id=? AND e.revision=? AND e.work_type='client'
               AND e.client_id=? AND e.job_id IS ? AND e.locked_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM xero_projects_client_links l
                 WHERE l.tenant_id=? AND l.client_id=e.client_id AND l.contact_id=?
               )
               AND ${catalogueGuard}
               AND e.start_at >= CASE
                 WHEN c.activated_at IS NULL THEN COALESCE((
                   SELECT MAX(p.cutoff_at) FROM close_periods p
                   WHERE p.status IN ('closing','closed','report_failed')
                 ), -9223372036854775808)
                 ELSE MAX(c.closed_through, COALESCE((
                   SELECT MAX(p.cutoff_at) FROM close_periods p
                   WHERE p.status IN ('closing','closed','report_failed')
                 ), 0), ?)
               END
           )`,
        ).bind(
          entryId,
          tenantId,
          projectId,
          taskId,
          project.name,
          task.name,
          task.chargeType,
          task.rate.currency,
          task.rate.value,
          projectRecord.catalogueRevision,
          taskRecord.catalogueRevision,
          actor.id,
          now,
          entryId,
          entry.revision,
          entry.client_id,
          entry.job_id,
          tenantId,
          entry.contact_id,
          tenantId,
          projectId,
          entry.contact_id,
          projectRecord.catalogueRevision,
          taskId,
          taskRecord.catalogueRevision,
          logicalFridayCutoff,
        )
      : env.DB.prepare(
          `UPDATE xero_projects_entry_selections
           SET project_id=?,task_id=?,project_name_snapshot=?,task_name_snapshot=?,
               task_charge_type_snapshot=?,task_rate_currency_snapshot=?,
               task_rate_value_snapshot=?,project_catalogue_revision=?,
               task_catalogue_revision=?,selection_revision=selection_revision+1,
               selected_by_user_id=?,selected_at=?
           WHERE entry_id=? AND tenant_id=? AND selection_revision=?
             AND EXISTS (
               SELECT 1 FROM time_entries e
               CROSS JOIN close_control c
               WHERE c.id=1 AND e.id=? AND e.revision=? AND e.work_type='client'
                 AND e.client_id=? AND e.job_id IS ? AND e.locked_at IS NULL
                 AND EXISTS (
                   SELECT 1 FROM xero_projects_client_links l
                   WHERE l.tenant_id=? AND l.client_id=e.client_id AND l.contact_id=?
                 )
                 AND ${catalogueGuard}
                 AND e.start_at >= CASE
                   WHEN c.activated_at IS NULL THEN COALESCE((
                     SELECT MAX(p.cutoff_at) FROM close_periods p
                     WHERE p.status IN ('closing','closed','report_failed')
                   ), -9223372036854775808)
                   ELSE MAX(c.closed_through, COALESCE((
                     SELECT MAX(p.cutoff_at) FROM close_periods p
                     WHERE p.status IN ('closing','closed','report_failed')
                   ), 0), ?)
                 END
             )`,
        ).bind(
          projectId,
          taskId,
          project.name,
          task.name,
          task.chargeType,
          task.rate.currency,
          task.rate.value,
          projectRecord.catalogueRevision,
          taskRecord.catalogueRevision,
          actor.id,
          now,
          entryId,
          tenantId,
          entry.selection_revision,
          entryId,
          entry.revision,
          entry.client_id,
          entry.job_id,
          tenantId,
          entry.contact_id,
          tenantId,
          projectId,
          entry.contact_id,
          projectRecord.catalogueRevision,
          taskId,
          taskRecord.catalogueRevision,
          logicalFridayCutoff,
        );
  const result = await statement.run();
  if ((result.meta.changes ?? 0) !== 1) {
    const lock = await env.DB.prepare(
      `SELECT e.revision,e.work_type,e.client_id,e.job_id,e.locked_at,e.start_at,l.contact_id,
              CASE
                WHEN c.activated_at IS NULL THEN COALESCE((
                  SELECT MAX(p.cutoff_at) FROM close_periods p
                  WHERE p.status IN ('closing','closed','report_failed')
                ), -9223372036854775808)
                ELSE MAX(c.closed_through, COALESCE((
                  SELECT MAX(p.cutoff_at) FROM close_periods p
                  WHERE p.status IN ('closing','closed','report_failed')
                ), 0), ?)
              END AS effective_cutoff
       FROM time_entries e CROSS JOIN close_control c
       LEFT JOIN xero_projects_client_links l
         ON l.tenant_id=? AND l.client_id=e.client_id
       WHERE c.id=1 AND e.id=?`,
    )
      .bind(logicalFridayCutoff, tenantId, entryId)
      .first<{
        revision: number;
        work_type: string;
        client_id: string | null;
        job_id: string | null;
        locked_at: number | null;
        start_at: number;
        contact_id: string | null;
        effective_cutoff: number;
      }>();
    if (lock && (lock.locked_at !== null || lock.start_at < lock.effective_cutoff)) {
      throw new XeroProblem(
        'ENTRY_LOCKED',
        'Use the audited correction flow for a locked entry.',
        409,
      );
    }
    if (
      !lock ||
      lock.revision !== entry.revision ||
      lock.work_type !== 'client' ||
      lock.client_id !== entry.client_id ||
      lock.job_id !== entry.job_id ||
      lock.contact_id !== entry.contact_id
    ) {
      throw new XeroProblem(
        'SOURCE_CHANGED',
        'The entry or client mapping changed while saving. Reload and try again.',
        409,
      );
    }
    const catalogue = await env.DB.prepare(`SELECT 1 AS valid WHERE ${catalogueGuard}`)
      .bind(
        tenantId,
        projectId,
        entry.contact_id,
        projectRecord.catalogueRevision,
        taskId,
        taskRecord.catalogueRevision,
      )
      .first<{ valid: number }>();
    if (!catalogue) {
      throw new XeroProblem(
        'CATALOGUE_CHANGED',
        'The Xero project or task changed while saving. Refresh the choices and try again.',
        409,
      );
    }
    throw new XeroProblem(
      'SELECTION_CHANGED',
      'The Xero selection changed while saving. Reload and try again.',
      409,
    );
  }
  const selectionRevision = (entry.selection_revision ?? 0) + 1;
  await audit(
    env.DB,
    actor,
    'entry_selection_saved',
    entryId,
    { projectId, taskId, selectionRevision },
    now,
  ).run();
  return {
    entryId,
    selectionRevision,
    projectId,
    taskId,
    projectName: project.name,
    taskName: task.name,
    chargeType: task.chargeType,
    rate: task.rate,
  };
}

/** Include this statement in the same D1 batch that creates a cutoff split. */
export function copyEntrySelectionStatement(
  db: D1Database,
  fromEntryId: string,
  toEntryId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO xero_projects_entry_selections
       (entry_id,tenant_id,project_id,task_id,project_name_snapshot,
        task_name_snapshot,task_charge_type_snapshot,task_rate_currency_snapshot,
        task_rate_value_snapshot,project_catalogue_revision,
        task_catalogue_revision,selection_revision,selected_by_user_id,selected_at)
       SELECT ?,tenant_id,project_id,task_id,project_name_snapshot,
              task_name_snapshot,task_charge_type_snapshot,
              task_rate_currency_snapshot,task_rate_value_snapshot,
              project_catalogue_revision,task_catalogue_revision,
              selection_revision,selected_by_user_id,selected_at
       FROM xero_projects_entry_selections WHERE entry_id=?`,
    )
    .bind(toEntryId, fromEntryId);
}

export function catalogueIsStale(fetchedAt: number, now = Date.now()): boolean {
  return now - fetchedAt > STALE_AFTER_MS;
}
