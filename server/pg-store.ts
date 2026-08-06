import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { DeliveryClaim, DeliveryType, Project, TimeEntry, TimeStore } from './types';

function projectFromRow(row: any): Project {
  return { id: row.id, name: row.name, createdAt: new Date(row.created_at).toISOString() };
}

function entryFromRow(row: any): TimeEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    notes: row.notes,
    startAt: new Date(row.start_at).toISOString(),
    endAt: row.end_at ? new Date(row.end_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const ENTRY_SELECT = `
  SELECT e.*, p.name AS project_name
  FROM time_entries e JOIN projects p ON p.id = e.project_id`;

export class PgTimeStore implements TimeStore {
  constructor(private readonly pool: pg.Pool) {}

  async listProjects(): Promise<Project[]> {
    const result = await this.pool.query('SELECT * FROM projects ORDER BY lower(name)');
    return result.rows.map(projectFromRow);
  }

  async getOrCreateProject(name: string): Promise<Project> {
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO projects (id, name) VALUES ($1, $2)
       ON CONFLICT ((lower(name))) DO UPDATE SET name = projects.name
       RETURNING *`,
      [id, name.trim()],
    );
    return projectFromRow(result.rows[0]);
  }

  async getActiveEntry(): Promise<TimeEntry | null> {
    const result = await this.pool.query(`${ENTRY_SELECT} WHERE e.end_at IS NULL LIMIT 1`);
    return result.rowCount ? entryFromRow(result.rows[0]) : null;
  }

  async clockIn(projectName: string, notes: string, now: Date): Promise<TimeEntry> {
    const project = await this.getOrCreateProject(projectName);
    try {
      const result = await this.pool.query(
        `INSERT INTO time_entries (id, project_id, notes, start_at)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [randomUUID(), project.id, notes.trim(), now],
      );
      return entryFromRow({ ...result.rows[0], project_name: project.name });
    } catch (error: any) {
      if (error?.code === '23505' && error?.constraint === 'time_entries_single_active') {
        throw new Error('ACTIVE_TIMER_EXISTS');
      }
      throw error;
    }
  }

  async clockOut(now: Date): Promise<TimeEntry | null> {
    const result = await this.pool.query(
      `WITH stopped AS (
         UPDATE time_entries SET end_at = $1, updated_at = now()
         WHERE id = (SELECT id FROM time_entries WHERE end_at IS NULL FOR UPDATE SKIP LOCKED LIMIT 1)
           AND start_at < $1
         RETURNING *
       ) SELECT stopped.*, p.name AS project_name FROM stopped
         JOIN projects p ON p.id = stopped.project_id`,
      [now],
    );
    return result.rowCount ? entryFromRow(result.rows[0]) : null;
  }

  async createEntry(input: {
    projectName: string;
    notes: string;
    startAt: Date;
    endAt: Date;
  }): Promise<TimeEntry> {
    const project = await this.getOrCreateProject(input.projectName);
    const result = await this.pool.query(
      `INSERT INTO time_entries (id, project_id, notes, start_at, end_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [randomUUID(), project.id, input.notes.trim(), input.startAt, input.endAt],
    );
    return entryFromRow({ ...result.rows[0], project_name: project.name });
  }

  async updateEntry(
    id: string,
    input: { projectName: string; notes: string; startAt: Date; endAt: Date },
  ): Promise<TimeEntry | null> {
    const project = await this.getOrCreateProject(input.projectName);
    const result = await this.pool.query(
      `UPDATE time_entries SET project_id = $2, notes = $3, start_at = $4, end_at = $5, updated_at = now()
       WHERE id = $1 AND end_at IS NOT NULL RETURNING *`,
      [id, project.id, input.notes.trim(), input.startAt, input.endAt],
    );
    return result.rowCount ? entryFromRow({ ...result.rows[0], project_name: project.name }) : null;
  }

  async deleteEntry(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM time_entries WHERE id = $1', [id]);
    return Boolean(result.rowCount);
  }

  async listEntries(input: { from: Date; to: Date; projectId?: string }): Promise<TimeEntry[]> {
    const values: unknown[] = [input.from, input.to];
    let where = 'e.start_at < $2 AND COALESCE(e.end_at, now()) > $1';
    if (input.projectId) {
      values.push(input.projectId);
      where += ' AND e.project_id = $3';
    }
    const result = await this.pool.query(
      `${ENTRY_SELECT} WHERE ${where} ORDER BY e.start_at DESC`,
      values,
    );
    return result.rows.map(entryFromRow);
  }

  async claimDelivery(
    weekStart: string,
    type: DeliveryType,
    recipient: string,
  ): Promise<DeliveryClaim> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT status, updated_at FROM weekly_report_deliveries
         WHERE week_start = $1 AND delivery_type = $2 FOR UPDATE`,
        [weekStart, type],
      );
      if (existing.rowCount && existing.rows[0].status === 'sent') {
        await client.query('COMMIT');
        return { shouldSend: false, reason: 'already-sent' };
      }
      if (
        existing.rowCount &&
        existing.rows[0].status === 'sending' &&
        new Date(existing.rows[0].updated_at).getTime() > Date.now() - 15 * 60_000
      ) {
        await client.query('COMMIT');
        return { shouldSend: false, reason: 'already-sending' };
      }
      if (existing.rowCount) {
        await client.query(
          `UPDATE weekly_report_deliveries
           SET status = 'sending', recipient = $3, attempts = attempts + 1,
               error_message = NULL, updated_at = now()
           WHERE week_start = $1 AND delivery_type = $2`,
          [weekStart, type, recipient],
        );
      } else {
        await client.query(
          `INSERT INTO weekly_report_deliveries
           (id, week_start, delivery_type, status, recipient)
           VALUES ($1, $2, $3, 'sending', $4)`,
          [randomUUID(), weekStart, type, recipient],
        );
      }
      await client.query('COMMIT');
      return { shouldSend: true };
    } catch (error: any) {
      await client.query('ROLLBACK');
      if (error?.code === '23505') return { shouldSend: false, reason: 'already-sending' };
      throw error;
    } finally {
      client.release();
    }
  }

  async markDeliverySent(weekStart: string, type: DeliveryType, sentAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE weekly_report_deliveries SET status = 'sent', sent_at = $3, updated_at = now()
       WHERE week_start = $1 AND delivery_type = $2`,
      [weekStart, type, sentAt],
    );
  }

  async markDeliveryFailed(weekStart: string, type: DeliveryType, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE weekly_report_deliveries
       SET status = 'failed', error_message = $3, updated_at = now()
       WHERE week_start = $1 AND delivery_type = $2`,
      [weekStart, type, error.slice(0, 1000)],
    );
  }
}
