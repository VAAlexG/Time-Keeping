import type {
  Client,
  DeliveryClaim,
  DeliveryType,
  EntryFilters,
  InternalActivity,
  Job,
  Project,
  SyncCounts,
  SyncRun,
  TimeEntry,
  TimeStore,
  User,
  UserRole,
  WorkClassificationInput,
} from './types';

interface ProjectRow {
  id: string;
  name: string;
  created_at: number;
}
interface UserRow {
  id: string;
  access_subject: string;
  entra_object_id: string | null;
  email: string;
  display_name: string;
  role: UserRole;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
}
interface ClientRow {
  id: string;
  external_id: string;
  source: 'fyi' | 'csv';
  name: string;
  client_code: string | null;
  export_code: string | null;
  manager_name: string | null;
  partner_name: string | null;
  active: number;
  synced_at: number;
}
interface JobRow {
  id: string;
  external_id: string;
  client_id: string;
  source: 'fyi' | 'csv';
  name: string;
  job_code: string | null;
  status: string | null;
  active: number;
  default_billable: number;
  synced_at: number;
}
interface ActivityRow {
  id: string;
  name: string;
  active: number;
}
interface EntryRow {
  id: string;
  user_id: string;
  user_email: string;
  user_display_name: string;
  project_id: string;
  project_name: string;
  work_type: 'client' | 'internal' | 'legacy';
  client_id: string | null;
  client_name_snapshot: string | null;
  client_external_id_snapshot: string | null;
  client_code_snapshot: string | null;
  job_id: string | null;
  job_name_snapshot: string | null;
  job_external_id_snapshot: string | null;
  job_code_snapshot: string | null;
  internal_activity_id: string | null;
  activity_name_snapshot: string | null;
  legacy_project_name_snapshot: string | null;
  billable: number;
  notes: string;
  start_at: number;
  end_at: number | null;
  created_at: number;
  updated_at: number;
}
interface SyncRunRow {
  id: string;
  source: 'fyi' | 'csv';
  trigger_type: 'scheduled' | 'manual' | 'import';
  status: 'running' | 'succeeded' | 'failed';
  clients_created: number;
  clients_updated: number;
  clients_archived: number;
  jobs_created: number;
  jobs_updated: number;
  jobs_archived: number;
  error_message: string | null;
  started_at: number;
  completed_at: number | null;
}

export interface CatalogClientInput {
  externalId: string;
  name: string;
  clientCode?: string | null;
  exportCode?: string | null;
  managerName?: string | null;
  partnerName?: string | null;
  active: boolean;
}
export interface CatalogJobInput {
  externalId: string;
  clientExternalId: string;
  name: string;
  jobCode?: string | null;
  status?: string | null;
  active: boolean;
}

const USER_SELECT = `SELECT id, access_subject, entra_object_id, email, display_name, role,
  created_at, updated_at, last_seen_at FROM users`;
const CLIENT_SELECT = `SELECT id, external_id, source, name, client_code, export_code,
  manager_name, partner_name, active, synced_at FROM clients`;
const JOB_SELECT = `SELECT id, external_id, client_id, source, name, job_code, status,
  active, default_billable, synced_at FROM jobs`;
const ENTRY_SELECT = `SELECT e.id, e.user_id, u.email AS user_email, u.display_name AS user_display_name,
  e.project_id, p.name AS project_name, e.work_type, e.client_id, e.client_name_snapshot,
  e.client_external_id_snapshot, e.client_code_snapshot, e.job_id, e.job_name_snapshot,
  e.job_external_id_snapshot, e.job_code_snapshot, e.internal_activity_id,
  e.activity_name_snapshot, e.legacy_project_name_snapshot, e.billable, e.notes,
  e.start_at, e.end_at, e.created_at, e.updated_at
  FROM time_entries e JOIN projects p ON p.id = e.project_id JOIN users u ON u.id = e.user_id`;
const SYNC_SELECT = `SELECT id, source, trigger_type, status, clients_created, clients_updated,
  clients_archived, jobs_created, jobs_updated, jobs_archived, error_message, started_at, completed_at
  FROM sync_runs`;

const iso = (value: number) => new Date(value).toISOString();
const projectFromRow = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  createdAt: iso(row.created_at),
});
const userFromRow = (row: UserRow): User => ({
  id: row.id,
  accessSubject: row.access_subject,
  entraObjectId: row.entra_object_id,
  email: row.email,
  displayName: row.display_name,
  role: row.role,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  lastSeenAt: iso(row.last_seen_at),
});
const clientFromRow = (row: ClientRow): Client => ({
  id: row.id,
  externalId: row.external_id,
  source: row.source,
  name: row.name,
  clientCode: row.client_code,
  exportCode: row.export_code,
  managerName: row.manager_name,
  partnerName: row.partner_name,
  active: Boolean(row.active),
  syncedAt: iso(row.synced_at),
});
const jobFromRow = (row: JobRow): Job => ({
  id: row.id,
  externalId: row.external_id,
  clientId: row.client_id,
  source: row.source,
  name: row.name,
  jobCode: row.job_code,
  status: row.status,
  active: Boolean(row.active),
  defaultBillable: Boolean(row.default_billable),
  syncedAt: iso(row.synced_at),
});
const activityFromRow = (row: ActivityRow): InternalActivity => ({
  id: row.id,
  name: row.name,
  active: Boolean(row.active),
});
const entryFromRow = (row: EntryRow): TimeEntry => ({
  id: row.id,
  userId: row.user_id,
  userEmail: row.user_email,
  userDisplayName: row.user_display_name,
  projectId: row.project_id,
  projectName: row.project_name,
  workType: row.work_type,
  clientId: row.client_id,
  clientName: row.client_name_snapshot,
  clientExternalId: row.client_external_id_snapshot,
  clientCode: row.client_code_snapshot,
  jobId: row.job_id,
  jobName: row.job_name_snapshot,
  jobExternalId: row.job_external_id_snapshot,
  jobCode: row.job_code_snapshot,
  internalActivityId: row.internal_activity_id,
  activityName: row.activity_name_snapshot,
  billable: Boolean(row.billable),
  legacy: row.work_type === 'legacy',
  notes: row.notes,
  startAt: iso(row.start_at),
  endAt: row.end_at === null ? null : iso(row.end_at),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});
const syncFromRow = (row: SyncRunRow): SyncRun => ({
  id: row.id,
  source: row.source,
  triggerType: row.trigger_type,
  status: row.status,
  clientsCreated: row.clients_created,
  clientsUpdated: row.clients_updated,
  clientsArchived: row.clients_archived,
  jobsCreated: row.jobs_created,
  jobsUpdated: row.jobs_updated,
  jobsArchived: row.jobs_archived,
  errorMessage: row.error_message,
  startedAt: iso(row.started_at),
  completedAt: row.completed_at === null ? null : iso(row.completed_at),
});

interface ResolvedClassification {
  projectName: string;
  workType: 'client' | 'internal';
  clientId: string | null;
  jobId: string | null;
  internalActivityId: string | null;
  billable: boolean;
  clientName: string | null;
  clientExternalId: string | null;
  clientCode: string | null;
  jobName: string | null;
  jobExternalId: string | null;
  jobCode: string | null;
  activityName: string | null;
}

export class D1TimeStore implements TimeStore {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async upsertUser(input: {
    accessSubject: string;
    entraObjectId?: string;
    email: string;
    displayName: string;
    role: UserRole;
  }): Promise<User> {
    const timestamp = this.now().getTime();
    const email = input.email.trim().toLowerCase();
    const displayName = input.displayName.trim() || email;
    const objectId = input.entraObjectId?.trim() || null;
    let row = await this.db
      .prepare(
        `${USER_SELECT} WHERE access_subject = ? OR email = ? COLLATE NOCASE OR (? IS NOT NULL AND entra_object_id = ?) LIMIT 1`,
      )
      .bind(input.accessSubject, email, objectId, objectId)
      .first<UserRow>();
    if (row) {
      await this.db
        .prepare(
          `UPDATE users SET access_subject = ?, entra_object_id = COALESCE(?, entra_object_id),
        email = ?, display_name = ?, role = ?, updated_at = ?, last_seen_at = ? WHERE id = ?`,
        )
        .bind(
          input.accessSubject,
          objectId,
          email,
          displayName,
          input.role,
          timestamp,
          timestamp,
          row.id,
        )
        .run();
    } else {
      await this.db
        .prepare(
          `INSERT INTO users (id, access_subject, entra_object_id, email, display_name, role,
        created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          input.accessSubject,
          objectId,
          email,
          displayName,
          input.role,
          timestamp,
          timestamp,
          timestamp,
        )
        .run();
    }
    row = await this.db
      .prepare(`${USER_SELECT} WHERE access_subject = ? LIMIT 1`)
      .bind(input.accessSubject)
      .first<UserRow>();
    if (!row) throw new Error('Unable to provision user');
    return userFromRow(row);
  }

  async listUsers(): Promise<User[]> {
    const result = await this.db
      .prepare(`${USER_SELECT} ORDER BY display_name COLLATE NOCASE, email COLLATE NOCASE`)
      .all<UserRow>();
    return result.results.map(userFromRow);
  }
  async listProjects(): Promise<Project[]> {
    const result = await this.db
      .prepare('SELECT id, name, created_at FROM projects ORDER BY name_key')
      .all<ProjectRow>();
    return result.results.map(projectFromRow);
  }
  async getOrCreateProject(name: string): Promise<Project> {
    const cleaned = name.trim();
    const key = cleaned.toLocaleLowerCase('en-AU');
    const timestamp = this.now().getTime();
    await this.db
      .prepare(
        'INSERT OR IGNORE INTO projects (id, name, name_key, created_at) VALUES (?, ?, ?, ?)',
      )
      .bind(crypto.randomUUID(), cleaned, key, timestamp)
      .run();
    const row = await this.db
      .prepare('SELECT id, name, created_at FROM projects WHERE name_key = ?')
      .bind(key)
      .first<ProjectRow>();
    if (!row) throw new Error('Unable to create classification label');
    return projectFromRow(row);
  }

  async listClients(input: { activeOnly?: boolean; search?: string } = {}): Promise<Client[]> {
    const bindings: unknown[] = [];
    const where: string[] = [];
    if (input.activeOnly) where.push('active = 1');
    if (input.search) {
      where.push('(name LIKE ? OR client_code LIKE ? OR export_code LIKE ?)');
      bindings.push(`%${input.search}%`, `%${input.search}%`, `%${input.search}%`);
    }
    const result = await this.db
      .prepare(
        `${CLIENT_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY name COLLATE NOCASE LIMIT 2000`,
      )
      .bind(...bindings)
      .all<ClientRow>();
    return result.results.map(clientFromRow);
  }
  async listJobs(clientId?: string, activeOnly = false): Promise<Job[]> {
    const where: string[] = [];
    const bindings: unknown[] = [];
    if (clientId) {
      where.push('client_id = ?');
      bindings.push(clientId);
    }
    if (activeOnly) where.push('active = 1');
    const result = await this.db
      .prepare(
        `${JOB_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY name COLLATE NOCASE LIMIT 5000`,
      )
      .bind(...bindings)
      .all<JobRow>();
    return result.results.map(jobFromRow);
  }
  async listInternalActivities(activeOnly = false): Promise<InternalActivity[]> {
    const result = await this.db
      .prepare(
        `SELECT id, name, active FROM internal_activities${activeOnly ? ' WHERE active = 1' : ''} ORDER BY name COLLATE NOCASE`,
      )
      .all<ActivityRow>();
    return result.results.map(activityFromRow);
  }
  async saveInternalActivity(input: {
    id?: string;
    name: string;
    active: boolean;
  }): Promise<InternalActivity> {
    const timestamp = this.now().getTime();
    const name = input.name.trim();
    const id = input.id ?? crypto.randomUUID();
    if (input.id) {
      await this.db
        .prepare(
          'UPDATE internal_activities SET name = ?, name_key = ?, active = ?, updated_at = ? WHERE id = ?',
        )
        .bind(name, name.toLocaleLowerCase('en-AU'), Number(input.active), timestamp, id)
        .run();
    } else {
      await this.db
        .prepare(
          'INSERT INTO internal_activities (id, name, name_key, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(id, name, name.toLocaleLowerCase('en-AU'), Number(input.active), timestamp, timestamp)
        .run();
    }
    const row = await this.db
      .prepare('SELECT id, name, active FROM internal_activities WHERE id = ?')
      .bind(id)
      .first<ActivityRow>();
    if (!row) throw new Error('Internal activity not found');
    return activityFromRow(row);
  }
  async setJobBillableDefault(id: string, billable: boolean): Promise<Job | null> {
    await this.db
      .prepare('UPDATE jobs SET default_billable = ?, updated_at = ? WHERE id = ?')
      .bind(Number(billable), this.now().getTime(), id)
      .run();
    const row = await this.db.prepare(`${JOB_SELECT} WHERE id = ?`).bind(id).first<JobRow>();
    return row ? jobFromRow(row) : null;
  }

  private async resolveClassification(
    input: WorkClassificationInput,
  ): Promise<ResolvedClassification> {
    if (input.workType === 'client') {
      if (!input.jobId) {
        const client = await this.db
          .prepare(
            `SELECT id, external_id, name, client_code, active FROM clients WHERE id = ? LIMIT 1`,
          )
          .bind(input.clientId)
          .first<{
            id: string;
            external_id: string;
            name: string;
            client_code: string | null;
            active: number;
          }>();
        if (!client) throw new Error('INVALID_CLIENT');
        if (!client.active) throw new Error('INACTIVE_CLIENT');
        return {
          projectName: `${client.name} - Unassigned project / activity`,
          workType: 'client',
          clientId: client.id,
          jobId: null,
          internalActivityId: null,
          billable: input.billable,
          clientName: client.name,
          clientExternalId: client.external_id,
          clientCode: client.client_code,
          jobName: null,
          jobExternalId: null,
          jobCode: null,
          activityName: null,
        };
      }
      const row = await this.db
        .prepare(
          `SELECT j.id AS job_id, j.external_id AS job_external_id, j.name AS job_name,
        j.job_code, j.active AS job_active, c.id AS client_id, c.external_id AS client_external_id,
        c.name AS client_name, c.client_code, c.active AS client_active
        FROM jobs j JOIN clients c ON c.id = j.client_id WHERE j.id = ? AND c.id = ? LIMIT 1`,
        )
        .bind(input.jobId, input.clientId)
        .first<{
          job_id: string;
          job_external_id: string;
          job_name: string;
          job_code: string | null;
          job_active: number;
          client_id: string;
          client_external_id: string;
          client_name: string;
          client_code: string | null;
          client_active: number;
        }>();
      if (!row) throw new Error('INVALID_CLIENT_JOB');
      if (!row.client_active || !row.job_active) throw new Error('INACTIVE_CLIENT_JOB');
      return {
        projectName: `${row.client_name} - ${row.job_name}`,
        workType: 'client',
        clientId: row.client_id,
        jobId: row.job_id,
        internalActivityId: null,
        billable: input.billable,
        clientName: row.client_name,
        clientExternalId: row.client_external_id,
        clientCode: row.client_code,
        jobName: row.job_name,
        jobExternalId: row.job_external_id,
        jobCode: row.job_code,
        activityName: null,
      };
    }
    const activity = await this.db
      .prepare('SELECT id, name, active FROM internal_activities WHERE id = ? LIMIT 1')
      .bind(input.internalActivityId)
      .first<ActivityRow>();
    if (!activity) throw new Error('INVALID_INTERNAL_ACTIVITY');
    if (!activity.active) throw new Error('INACTIVE_INTERNAL_ACTIVITY');
    return {
      projectName: `Internal - ${activity.name}`,
      workType: 'internal',
      clientId: null,
      jobId: null,
      internalActivityId: activity.id,
      billable: false,
      clientName: null,
      clientExternalId: null,
      clientCode: null,
      jobName: null,
      jobExternalId: null,
      jobCode: null,
      activityName: activity.name,
    };
  }

  async getActiveEntry(userId: string): Promise<TimeEntry | null> {
    const row = await this.db
      .prepare(`${ENTRY_SELECT} WHERE e.user_id = ? AND e.end_at IS NULL LIMIT 1`)
      .bind(userId)
      .first<EntryRow>();
    return row ? entryFromRow(row) : null;
  }
  private async insertEntry(
    userId: string,
    classification: WorkClassificationInput,
    notes: string,
    startAt: Date,
    endAt: Date | null,
  ): Promise<TimeEntry> {
    const resolved = await this.resolveClassification(classification);
    const project = await this.getOrCreateProject(resolved.projectName);
    const id = crypto.randomUUID();
    const timestamp = this.now().getTime();
    try {
      await this.db
        .prepare(
          `INSERT INTO time_entries (id, user_id, project_id, notes, start_at, end_at,
        active_guard, created_at, updated_at, work_type, client_id, job_id, internal_activity_id, billable,
        client_name_snapshot, client_external_id_snapshot, client_code_snapshot, job_name_snapshot,
        job_external_id_snapshot, job_code_snapshot, activity_name_snapshot, legacy_project_name_snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .bind(
          id,
          userId,
          project.id,
          notes.trim(),
          startAt.getTime(),
          endAt?.getTime() ?? null,
          endAt ? null : 1,
          timestamp,
          timestamp,
          resolved.workType,
          resolved.clientId,
          resolved.jobId,
          resolved.internalActivityId,
          Number(resolved.billable),
          resolved.clientName,
          resolved.clientExternalId,
          resolved.clientCode,
          resolved.jobName,
          resolved.jobExternalId,
          resolved.jobCode,
          resolved.activityName,
        )
        .run();
    } catch (error) {
      if (!endAt && (await this.getActiveEntry(userId))) throw new Error('ACTIVE_TIMER_EXISTS');
      throw error;
    }
    return (await this.getEntry(id, userId))!;
  }
  async clockIn(
    userId: string,
    classification: WorkClassificationInput,
    notes: string,
    now: Date,
  ): Promise<TimeEntry> {
    return this.insertEntry(userId, classification, notes, now, null);
  }
  async clockOut(userId: string, now: Date): Promise<TimeEntry | null> {
    const active = await this.getActiveEntry(userId);
    if (!active || now <= new Date(active.startAt)) return null;
    const result = await this.db
      .prepare(
        'UPDATE time_entries SET end_at = ?, active_guard = NULL, updated_at = ? WHERE id = ? AND user_id = ? AND end_at IS NULL',
      )
      .bind(now.getTime(), now.getTime(), active.id, userId)
      .run();
    return result.meta.changes ? this.getEntry(active.id, userId) : null;
  }
  async createEntry(
    userId: string,
    input: WorkClassificationInput & { notes: string; startAt: Date; endAt: Date },
  ): Promise<TimeEntry> {
    return this.insertEntry(userId, input, input.notes, input.startAt, input.endAt);
  }
  async updateEntry(
    userId: string,
    id: string,
    input: WorkClassificationInput & { notes: string; startAt: Date; endAt: Date },
  ): Promise<TimeEntry | null> {
    const resolved = await this.resolveClassification(input);
    const project = await this.getOrCreateProject(resolved.projectName);
    const result = await this.db
      .prepare(
        `UPDATE time_entries SET project_id = ?, notes = ?, start_at = ?, end_at = ?,
      updated_at = ?, work_type = ?, client_id = ?, job_id = ?, internal_activity_id = ?, billable = ?,
      client_name_snapshot = ?, client_external_id_snapshot = ?, client_code_snapshot = ?, job_name_snapshot = ?,
      job_external_id_snapshot = ?, job_code_snapshot = ?, activity_name_snapshot = ?, legacy_project_name_snapshot = NULL
      WHERE id = ? AND user_id = ? AND end_at IS NOT NULL`,
      )
      .bind(
        project.id,
        input.notes.trim(),
        input.startAt.getTime(),
        input.endAt.getTime(),
        this.now().getTime(),
        resolved.workType,
        resolved.clientId,
        resolved.jobId,
        resolved.internalActivityId,
        Number(resolved.billable),
        resolved.clientName,
        resolved.clientExternalId,
        resolved.clientCode,
        resolved.jobName,
        resolved.jobExternalId,
        resolved.jobCode,
        resolved.activityName,
        id,
        userId,
      )
      .run();
    return result.meta.changes ? this.getEntry(id, userId) : null;
  }
  async deleteEntry(userId: string, id: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM time_entries WHERE id = ? AND user_id = ?')
      .bind(id, userId)
      .run();
    return Boolean(result.meta.changes);
  }
  async listEntries(input: EntryFilters): Promise<TimeEntry[]> {
    const bindings: unknown[] = [input.to.getTime(), this.now().getTime(), input.from.getTime()];
    const where = ['e.start_at < ?', 'COALESCE(e.end_at, ?) > ?'];
    const filters: [unknown, string][] = [
      [input.userId, 'e.user_id = ?'],
      [input.clientId, 'e.client_id = ?'],
      [input.jobId, 'e.job_id = ?'],
      [input.internalActivityId, 'e.internal_activity_id = ?'],
      [input.workType, 'e.work_type = ?'],
    ];
    for (const [value, clause] of filters)
      if (value !== undefined) {
        where.push(clause);
        bindings.push(value);
      }
    if (input.billable !== undefined) {
      where.push('e.billable = ?');
      bindings.push(Number(input.billable));
    }
    const result = await this.db
      .prepare(`${ENTRY_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.start_at DESC`)
      .bind(...bindings)
      .all<EntryRow>();
    return result.results.map(entryFromRow);
  }

  async beginSync(
    source: 'fyi' | 'csv',
    triggerType: 'scheduled' | 'manual' | 'import',
  ): Promise<string> {
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO sync_runs (id, source, trigger_type, status, started_at) VALUES (?, ?, ?, 'running', ?)`,
      )
      .bind(id, source, triggerType, this.now().getTime())
      .run();
    return id;
  }
  async finishSync(id: string, counts: SyncCounts): Promise<void> {
    await this.db
      .prepare(
        `UPDATE sync_runs SET status = 'succeeded', clients_created = ?, clients_updated = ?,
      clients_archived = ?, jobs_created = ?, jobs_updated = ?, jobs_archived = ?, completed_at = ? WHERE id = ?`,
      )
      .bind(
        counts.clientsCreated,
        counts.clientsUpdated,
        counts.clientsArchived,
        counts.jobsCreated,
        counts.jobsUpdated,
        counts.jobsArchived,
        this.now().getTime(),
        id,
      )
      .run();
  }
  async failSync(id: string, message: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE sync_runs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?`,
      )
      .bind(message.slice(0, 1000), this.now().getTime(), id)
      .run();
  }
  async latestSync(): Promise<SyncRun | null> {
    const row = await this.db
      .prepare(`${SYNC_SELECT} ORDER BY started_at DESC LIMIT 1`)
      .first<SyncRunRow>();
    return row ? syncFromRow(row) : null;
  }
  async syncCatalog(
    source: 'fyi' | 'csv',
    clients: CatalogClientInput[],
    jobs: CatalogJobInput[],
    markMissingInactive: boolean,
  ): Promise<SyncCounts> {
    const counts: SyncCounts = {
      clientsCreated: 0,
      clientsUpdated: 0,
      clientsArchived: 0,
      jobsCreated: 0,
      jobsUpdated: 0,
      jobsArchived: 0,
    };
    const timestamp = this.now().getTime();
    const existingClientRows = await this.db
      .prepare(`${CLIENT_SELECT} WHERE source = ?`)
      .bind(source)
      .all<ClientRow>();
    const existingJobRows = await this.db
      .prepare(`${JOB_SELECT} WHERE source = ?`)
      .bind(source)
      .all<JobRow>();
    const existingClients = new Map(
      existingClientRows.results.map(clientFromRow).map((item) => [item.externalId, item]),
    );
    const existingJobs = new Map(
      existingJobRows.results.map(jobFromRow).map((item) => [item.externalId, item]),
    );
    const seenClients = new Set<string>();
    const seenJobs = new Set<string>();
    for (const item of clients) {
      const externalId = item.externalId.trim();
      if (!externalId || seenClients.has(externalId))
        throw new Error(`Duplicate or missing client external ID: ${externalId || '(blank)'}`);
      seenClients.add(externalId);
      const existing = existingClients.get(externalId);
      if (existing) {
        await this.db
          .prepare(
            `UPDATE clients SET name = ?, client_code = ?, export_code = ?, manager_name = ?,
          partner_name = ?, active = ?, updated_at = ?, synced_at = ? WHERE id = ?`,
          )
          .bind(
            item.name.trim(),
            item.clientCode ?? null,
            item.exportCode ?? null,
            item.managerName ?? null,
            item.partnerName ?? null,
            Number(item.active),
            timestamp,
            timestamp,
            existing.id,
          )
          .run();
        counts.clientsUpdated++;
      } else {
        await this.db
          .prepare(
            `INSERT INTO clients (id, external_id, source, name, client_code, export_code,
          manager_name, partner_name, active, created_at, updated_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            externalId,
            source,
            item.name.trim(),
            item.clientCode ?? null,
            item.exportCode ?? null,
            item.managerName ?? null,
            item.partnerName ?? null,
            Number(item.active),
            timestamp,
            timestamp,
            timestamp,
          )
          .run();
        counts.clientsCreated++;
      }
    }
    const clientRows = await this.listClients();
    const clientIds = new Map(clientRows.map((item) => [item.externalId, item.id]));
    for (const item of jobs) {
      const externalId = item.externalId.trim();
      if (!externalId || seenJobs.has(externalId))
        throw new Error(`Duplicate or missing job external ID: ${externalId || '(blank)'}`);
      const clientId = clientIds.get(item.clientExternalId);
      if (!clientId)
        throw new Error(`Job ${externalId} references unknown client ${item.clientExternalId}`);
      seenJobs.add(externalId);
      const existing = existingJobs.get(externalId);
      if (existing) {
        await this.db
          .prepare(
            `UPDATE jobs SET client_id = ?, name = ?, job_code = ?, status = ?, active = ?, updated_at = ?, synced_at = ? WHERE id = ?`,
          )
          .bind(
            clientId,
            item.name.trim(),
            item.jobCode ?? null,
            item.status ?? null,
            Number(item.active),
            timestamp,
            timestamp,
            existing.id,
          )
          .run();
        counts.jobsUpdated++;
      } else {
        await this.db
          .prepare(
            `INSERT INTO jobs (id, external_id, client_id, source, name, job_code, status,
          active, default_billable, created_at, updated_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            externalId,
            clientId,
            source,
            item.name.trim(),
            item.jobCode ?? null,
            item.status ?? null,
            Number(item.active),
            timestamp,
            timestamp,
            timestamp,
          )
          .run();
        counts.jobsCreated++;
      }
    }
    if (markMissingInactive) {
      for (const item of existingClients.values())
        if (item.active && !seenClients.has(item.externalId)) {
          await this.db
            .prepare('UPDATE clients SET active = 0, updated_at = ?, synced_at = ? WHERE id = ?')
            .bind(timestamp, timestamp, item.id)
            .run();
          counts.clientsArchived++;
        }
      for (const item of existingJobs.values())
        if (item.active && !seenJobs.has(item.externalId)) {
          await this.db
            .prepare('UPDATE jobs SET active = 0, updated_at = ?, synced_at = ? WHERE id = ?')
            .bind(timestamp, timestamp, item.id)
            .run();
          counts.jobsArchived++;
        }
    }
    return counts;
  }

  async claimDelivery(
    weekStart: string,
    type: DeliveryType,
    recipient: string,
  ): Promise<DeliveryClaim> {
    const timestamp = this.now().getTime();
    const inserted = await this.db
      .prepare(
        `INSERT OR IGNORE INTO weekly_report_deliveries
      (id, week_start, delivery_type, status, recipient, attempts, created_at, updated_at)
      VALUES (?, ?, ?, 'sending', ?, 1, ?, ?)`,
      )
      .bind(crypto.randomUUID(), weekStart, type, recipient, timestamp, timestamp)
      .run();
    if (inserted.meta.changes) return { shouldSend: true };
    const existing = await this.db
      .prepare(
        'SELECT status FROM weekly_report_deliveries WHERE week_start = ? AND delivery_type = ?',
      )
      .bind(weekStart, type)
      .first<{ status: 'sending' | 'sent' | 'failed' }>();
    if (existing?.status === 'sent') return { shouldSend: false, reason: 'already-sent' };
    const reclaimed = await this.db
      .prepare(
        `UPDATE weekly_report_deliveries SET status = 'sending', recipient = ?,
      attempts = attempts + 1, error_message = NULL, updated_at = ? WHERE week_start = ? AND delivery_type = ?
      AND (status = 'failed' OR (status = 'sending' AND updated_at < ?))`,
      )
      .bind(recipient, timestamp, weekStart, type, timestamp - 15 * 60_000)
      .run();
    return reclaimed.meta.changes
      ? { shouldSend: true }
      : { shouldSend: false, reason: 'already-sending' };
  }
  async markDeliverySent(
    weekStart: string,
    type: DeliveryType,
    sentAt: Date,
    providerMessageId?: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE weekly_report_deliveries SET status = 'sent', sent_at = ?, provider_message_id = ?,
      updated_at = ? WHERE week_start = ? AND delivery_type = ?`,
      )
      .bind(sentAt.getTime(), providerMessageId ?? null, sentAt.getTime(), weekStart, type)
      .run();
  }
  async markDeliveryFailed(weekStart: string, type: DeliveryType, error: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE weekly_report_deliveries SET status = 'failed', error_message = ?, updated_at = ?
      WHERE week_start = ? AND delivery_type = ?`,
      )
      .bind(error.slice(0, 1000), this.now().getTime(), weekStart, type)
      .run();
  }
  private async getEntry(id: string, userId?: string): Promise<TimeEntry | null> {
    const row = await this.db
      .prepare(`${ENTRY_SELECT} WHERE e.id = ?${userId ? ' AND e.user_id = ?' : ''} LIMIT 1`)
      .bind(...(userId ? [id, userId] : [id]))
      .first<EntryRow>();
    return row ? entryFromRow(row) : null;
  }
}
