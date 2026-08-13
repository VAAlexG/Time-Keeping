import type { PriorityAssignee, PriorityItem } from './types';

interface PriorityRow {
  id: string;
  title: string;
  assignee: PriorityAssignee;
  priority: number;
  completed: number;
  created_by_user_id: string;
  created_by_name: string;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

const SELECT = `SELECT p.id, p.title, p.assignee, p.priority, p.completed,
  p.created_by_user_id, u.display_name AS created_by_name, p.completed_at,
  p.created_at, p.updated_at
  FROM priority_items p JOIN users u ON u.id = p.created_by_user_id`;

const iso = (value: number) => new Date(value).toISOString();
const fromRow = (row: PriorityRow): PriorityItem => ({
  id: row.id,
  title: row.title,
  assignee: row.assignee,
  priority: row.priority,
  completed: Boolean(row.completed),
  createdByUserId: row.created_by_user_id,
  createdByName: row.created_by_name,
  completedAt: row.completed_at === null ? null : iso(row.completed_at),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

export class D1PriorityStore {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<PriorityItem[]> {
    const rows = await this.db
      .prepare(
        `${SELECT} ORDER BY p.completed ASC, p.priority DESC, p.updated_at DESC, p.created_at ASC`,
      )
      .all<PriorityRow>();
    return rows.results.map(fromRow);
  }

  async create(input: {
    title: string;
    assignee: PriorityAssignee;
    priority: number;
    createdByUserId: string;
  }): Promise<PriorityItem> {
    const id = crypto.randomUUID();
    const timestamp = this.now().getTime();
    await this.db
      .prepare(
        `INSERT INTO priority_items (id, title, assignee, priority, completed,
        created_by_user_id, completed_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
      )
      .bind(
        id,
        input.title.trim(),
        input.assignee,
        input.priority,
        input.createdByUserId,
        timestamp,
        timestamp,
      )
      .run();
    return (await this.get(id))!;
  }

  async update(
    id: string,
    input: {
      title: string;
      assignee: PriorityAssignee;
      priority: number;
      completed: boolean;
    },
  ): Promise<PriorityItem | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const timestamp = this.now().getTime();
    const completedAt = input.completed
      ? existing.completedAt
        ? Date.parse(existing.completedAt)
        : timestamp
      : null;
    await this.db
      .prepare(
        `UPDATE priority_items SET title = ?, assignee = ?, priority = ?, completed = ?,
        completed_at = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(
        input.title.trim(),
        input.assignee,
        input.priority,
        Number(input.completed),
        completedAt,
        timestamp,
        id,
      )
      .run();
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM priority_items WHERE id = ?').bind(id).run();
    return Boolean(result.meta.changes);
  }

  private async get(id: string): Promise<PriorityItem | null> {
    const row = await this.db
      .prepare(`${SELECT} WHERE p.id = ? LIMIT 1`)
      .bind(id)
      .first<PriorityRow>();
    return row ? fromRow(row) : null;
  }
}
