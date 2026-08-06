import type { DeliveryClaim, DeliveryType, Project, TimeEntry, TimeStore } from './types';

interface ProjectRow {
  id: string;
  name: string;
  created_at: number;
}

interface EntryRow {
  id: string;
  project_id: string;
  project_name: string;
  notes: string;
  start_at: number;
  end_at: number | null;
  created_at: number;
  updated_at: number;
}

function projectFromRow(row: ProjectRow): Project {
  return { id: row.id, name: row.name, createdAt: new Date(row.created_at).toISOString() };
}

function entryFromRow(row: EntryRow): TimeEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    notes: row.notes,
    startAt: new Date(row.start_at).toISOString(),
    endAt: row.end_at === null ? null : new Date(row.end_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const ENTRY_SELECT = `
  SELECT e.id, e.project_id, p.name AS project_name, e.notes,
         e.start_at, e.end_at, e.created_at, e.updated_at
  FROM time_entries e JOIN projects p ON p.id = e.project_id`;

export class D1TimeStore implements TimeStore {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
    if (!row) throw new Error('Unable to create project');
    return projectFromRow(row);
  }

  async getActiveEntry(): Promise<TimeEntry | null> {
    const row = await this.db
      .prepare(`${ENTRY_SELECT} WHERE e.active_guard = 1 LIMIT 1`)
      .first<EntryRow>();
    return row ? entryFromRow(row) : null;
  }

  async clockIn(projectName: string, notes: string, now: Date): Promise<TimeEntry> {
    const project = await this.getOrCreateProject(projectName);
    const id = crypto.randomUUID();
    try {
      await this.db
        .prepare(
          `INSERT INTO time_entries
           (id, project_id, notes, start_at, end_at, active_guard, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, 1, ?, ?)`,
        )
        .bind(id, project.id, notes.trim(), now.getTime(), now.getTime(), now.getTime())
        .run();
    } catch (error) {
      if (await this.getActiveEntry()) throw new Error('ACTIVE_TIMER_EXISTS');
      throw error;
    }
    return (await this.getEntry(id))!;
  }

  async clockOut(now: Date): Promise<TimeEntry | null> {
    const active = await this.getActiveEntry();
    if (!active || now <= new Date(active.startAt)) return null;
    const result = await this.db
      .prepare(
        `UPDATE time_entries SET end_at = ?, active_guard = NULL, updated_at = ?
         WHERE id = ? AND active_guard = 1`,
      )
      .bind(now.getTime(), now.getTime(), active.id)
      .run();
    if (!result.meta.changes) return null;
    return this.getEntry(active.id);
  }

  async createEntry(input: {
    projectName: string;
    notes: string;
    startAt: Date;
    endAt: Date;
  }): Promise<TimeEntry> {
    const project = await this.getOrCreateProject(input.projectName);
    const id = crypto.randomUUID();
    const timestamp = this.now().getTime();
    await this.db
      .prepare(
        `INSERT INTO time_entries
         (id, project_id, notes, start_at, end_at, active_guard, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .bind(
        id,
        project.id,
        input.notes.trim(),
        input.startAt.getTime(),
        input.endAt.getTime(),
        timestamp,
        timestamp,
      )
      .run();
    return (await this.getEntry(id))!;
  }

  async updateEntry(
    id: string,
    input: { projectName: string; notes: string; startAt: Date; endAt: Date },
  ): Promise<TimeEntry | null> {
    const project = await this.getOrCreateProject(input.projectName);
    const result = await this.db
      .prepare(
        `UPDATE time_entries
         SET project_id = ?, notes = ?, start_at = ?, end_at = ?, updated_at = ?
         WHERE id = ? AND end_at IS NOT NULL`,
      )
      .bind(
        project.id,
        input.notes.trim(),
        input.startAt.getTime(),
        input.endAt.getTime(),
        this.now().getTime(),
        id,
      )
      .run();
    return result.meta.changes ? this.getEntry(id) : null;
  }

  async deleteEntry(id: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM time_entries WHERE id = ?').bind(id).run();
    return Boolean(result.meta.changes);
  }

  async listEntries(input: { from: Date; to: Date; projectId?: string }): Promise<TimeEntry[]> {
    const now = this.now().getTime();
    const bindings: unknown[] = [input.to.getTime(), now, input.from.getTime()];
    let where = 'e.start_at < ? AND COALESCE(e.end_at, ?) > ?';
    if (input.projectId) {
      bindings.push(input.projectId);
      where += ' AND e.project_id = ?';
    }
    const result = await this.db
      .prepare(`${ENTRY_SELECT} WHERE ${where} ORDER BY e.start_at DESC`)
      .bind(...bindings)
      .all<EntryRow>();
    return result.results.map(entryFromRow);
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
        `SELECT status FROM weekly_report_deliveries
         WHERE week_start = ? AND delivery_type = ?`,
      )
      .bind(weekStart, type)
      .first<{ status: 'sending' | 'sent' | 'failed' }>();
    if (existing?.status === 'sent') return { shouldSend: false, reason: 'already-sent' };

    const reclaimed = await this.db
      .prepare(
        `UPDATE weekly_report_deliveries
         SET status = 'sending', recipient = ?, attempts = attempts + 1,
             error_message = NULL, updated_at = ?
         WHERE week_start = ? AND delivery_type = ?
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
        `UPDATE weekly_report_deliveries
         SET status = 'sent', sent_at = ?, provider_message_id = ?, updated_at = ?
         WHERE week_start = ? AND delivery_type = ?`,
      )
      .bind(sentAt.getTime(), providerMessageId ?? null, sentAt.getTime(), weekStart, type)
      .run();
  }

  async markDeliveryFailed(weekStart: string, type: DeliveryType, error: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE weekly_report_deliveries
         SET status = 'failed', error_message = ?, updated_at = ?
         WHERE week_start = ? AND delivery_type = ?`,
      )
      .bind(error.slice(0, 1000), this.now().getTime(), weekStart, type)
      .run();
  }

  private async getEntry(id: string): Promise<TimeEntry | null> {
    const row = await this.db
      .prepare(`${ENTRY_SELECT} WHERE e.id = ? LIMIT 1`)
      .bind(id)
      .first<EntryRow>();
    return row ? entryFromRow(row) : null;
  }
}
