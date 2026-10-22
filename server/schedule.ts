import { DateTime } from 'luxon';
import { BRISBANE_ZONE } from './time';
import type {
  PriorityAssignee,
  ScheduleOccurrence,
  ScheduleRecurrence,
  ScheduleTemplate,
} from './types';

export interface ScheduleTemplateInput {
  title: string;
  description: string;
  assignee: PriorityAssignee;
  recurrenceType: ScheduleRecurrence;
  weekdays: number[];
  startDate: string;
  monthlyDay: number | null;
  yearlyMonth: number | null;
  yearlyDay: number | null;
  dueTime: string | null;
}

const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());
const date = (value: string) => DateTime.fromISO(value, { zone: BRISBANE_ZONE }).startOf('day');

export function recurrenceLabel(input: ScheduleTemplateInput): string {
  if (input.recurrenceType === 'weekly') return 'Weekly';
  if (input.recurrenceType === 'fortnightly') return 'Fortnightly';
  if (input.recurrenceType === 'monthly') return `Monthly · day ${input.monthlyDay}`;
  return `Yearly · ${String(input.yearlyMonth).padStart(2, '0')}-${String(input.yearlyDay).padStart(2, '0')}`;
}

function clampedDay(year: number, month: number, requested: number) {
  return Math.min(requested, DateTime.local(year, month).daysInMonth ?? requested);
}

export function occurrenceDates(
  input: ScheduleTemplateInput,
  fromDate: string,
  toDate: string,
): string[] {
  const start = date(input.startDate);
  const from = DateTime.max(start, date(fromDate));
  const to = date(toDate);
  const result: string[] = [];
  if (from > to) return result;
  if (input.recurrenceType === 'weekly' || input.recurrenceType === 'fortnightly') {
    const weekdays = new Set(input.weekdays);
    const anchorWeek = start.startOf('week');
    for (let cursor = from; cursor <= to; cursor = cursor.plus({ days: 1 })) {
      const weekDistance = Math.floor(cursor.startOf('week').diff(anchorWeek, 'weeks').weeks);
      if (
        weekdays.has(cursor.weekday) &&
        (input.recurrenceType === 'weekly' || weekDistance % 2 === 0)
      )
        result.push(cursor.toISODate()!);
    }
    return result;
  }
  if (input.recurrenceType === 'monthly') {
    for (let cursor = from.startOf('month'); cursor <= to; cursor = cursor.plus({ months: 1 })) {
      const candidate = cursor.set({
        day: clampedDay(cursor.year, cursor.month, input.monthlyDay!),
      });
      if (candidate >= from && candidate <= to && candidate >= start)
        result.push(candidate.toISODate()!);
    }
    return result;
  }
  for (let year = from.year; year <= to.year; year += 1) {
    const day = clampedDay(year, input.yearlyMonth!, input.yearlyDay!);
    const candidate = DateTime.fromObject(
      { year, month: input.yearlyMonth!, day },
      { zone: BRISBANE_ZONE },
    );
    if (candidate >= from && candidate <= to && candidate >= start)
      result.push(candidate.toISODate()!);
  }
  return result;
}

function dueMillis(dueDate: string, dueTime: string | null) {
  const [hour, minute] = (dueTime ?? '23:59').split(':').map(Number);
  return date(dueDate)
    .set({ hour, minute, second: dueTime ? 0 : 59, millisecond: dueTime ? 0 : 999 })
    .toMillis();
}

interface TemplateRow {
  id: string;
  title: string;
  description: string;
  assignee: PriorityAssignee;
  recurrence_type: ScheduleRecurrence;
  weekdays: string;
  start_date: string;
  monthly_day: number | null;
  yearly_month: number | null;
  yearly_day: number | null;
  due_time: string | null;
  active: number;
  created_by_user_id: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}
interface OccurrenceRow {
  id: string;
  template_id: string;
  due_date: string;
  due_at: number;
  due_time: string | null;
  title: string;
  description: string;
  assignee: PriorityAssignee;
  recurrence_label: string;
  completed: number;
  cancelled: number;
  completed_by_user_id: string | null;
  completed_by_name: string | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}
const templateFromRow = (row: TemplateRow): ScheduleTemplate => ({
  id: row.id,
  title: row.title,
  description: row.description,
  assignee: row.assignee,
  recurrenceType: row.recurrence_type,
  weekdays: JSON.parse(row.weekdays) as number[],
  startDate: row.start_date,
  monthlyDay: row.monthly_day,
  yearlyMonth: row.yearly_month,
  yearlyDay: row.yearly_day,
  dueTime: row.due_time,
  active: Boolean(row.active),
  createdByUserId: row.created_by_user_id,
  createdAt: iso(row.created_at)!,
  updatedAt: iso(row.updated_at)!,
  archivedAt: iso(row.archived_at),
});
const occurrenceFromRow = (row: OccurrenceRow, now: number): ScheduleOccurrence => ({
  id: row.id,
  templateId: row.template_id,
  dueDate: row.due_date,
  dueTime: row.due_time,
  dueAt: iso(row.due_at)!,
  title: row.title,
  description: row.description,
  assignee: row.assignee,
  recurrenceLabel: row.recurrence_label,
  completed: Boolean(row.completed),
  cancelled: Boolean(row.cancelled),
  overdue: !row.completed && !row.cancelled && row.due_at < now,
  completedByUserId: row.completed_by_user_id,
  completedByName: row.completed_by_name,
  completedAt: iso(row.completed_at),
  createdAt: iso(row.created_at)!,
  updatedAt: iso(row.updated_at)!,
});

export class D1ScheduleStore {
  constructor(
    private db: D1Database,
    private clock = () => new Date(),
  ) {}
  async listTemplates() {
    const rows = await this.db
      .prepare(
        'SELECT * FROM schedule_templates WHERE active = 1 ORDER BY assignee, title COLLATE NOCASE',
      )
      .all<TemplateRow>();
    return rows.results.map(templateFromRow);
  }
  async listOccurrences(weekStart: string, includeOverdue = true) {
    const weekEnd = date(weekStart).plus({ days: 6 }).toISODate()!;
    const now = this.clock().getTime();
    const query = includeOverdue
      ? `SELECT * FROM schedule_occurrences WHERE cancelled = 0 AND (due_date BETWEEN ? AND ? OR (completed = 0 AND due_at < ?)) ORDER BY completed, due_at, assignee`
      : `SELECT * FROM schedule_occurrences WHERE cancelled = 0 AND due_date BETWEEN ? AND ? ORDER BY due_at, assignee`;
    const statement = includeOverdue
      ? this.db.prepare(query).bind(weekStart, weekEnd, now)
      : this.db.prepare(query).bind(weekStart, weekEnd);
    const rows = await statement.all<OccurrenceRow>();
    return rows.results.map((row) => occurrenceFromRow(row, now));
  }
  async create(input: ScheduleTemplateInput, userId: string) {
    const id = crypto.randomUUID();
    const now = this.clock().getTime();
    await this.db
      .prepare(
        `INSERT INTO schedule_templates
      (id,title,description,assignee,recurrence_type,weekdays,start_date,monthly_day,yearly_month,yearly_day,due_time,active,created_by_user_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        id,
        input.title.trim(),
        input.description.trim(),
        input.assignee,
        input.recurrenceType,
        JSON.stringify(input.weekdays),
        input.startDate,
        input.monthlyDay,
        input.yearlyMonth,
        input.yearlyDay,
        input.dueTime,
        1,
        userId,
        now,
        now,
      )
      .run();
    await this.generateTemplate(id);
    return (await this.getTemplate(id))!;
  }
  async update(id: string, input: ScheduleTemplateInput) {
    const now = this.clock().getTime();
    const today = DateTime.fromJSDate(this.clock(), { zone: BRISBANE_ZONE }).toISODate()!;
    const result = await this.db
      .prepare(
        `UPDATE schedule_templates SET title=?,description=?,assignee=?,recurrence_type=?,weekdays=?,start_date=?,monthly_day=?,yearly_month=?,yearly_day=?,due_time=?,updated_at=? WHERE id=? AND active=1`,
      )
      .bind(
        input.title.trim(),
        input.description.trim(),
        input.assignee,
        input.recurrenceType,
        JSON.stringify(input.weekdays),
        input.startDate,
        input.monthlyDay,
        input.yearlyMonth,
        input.yearlyDay,
        input.dueTime,
        now,
        id,
      )
      .run();
    if (!result.meta.changes) return null;
    await this.db
      .prepare(
        'DELETE FROM schedule_occurrences WHERE template_id=? AND completed=0 AND due_date>?',
      )
      .bind(id, today)
      .run();
    await this.generateTemplate(id);
    return this.getTemplate(id);
  }
  async archive(id: string) {
    const now = this.clock().getTime();
    const today = DateTime.fromJSDate(this.clock(), { zone: BRISBANE_ZONE }).toISODate()!;
    const result = await this.db
      .prepare(
        'UPDATE schedule_templates SET active=0,archived_at=?,updated_at=? WHERE id=? AND active=1',
      )
      .bind(now, now, id)
      .run();
    if (result.meta.changes)
      await this.db
        .prepare(
          'UPDATE schedule_occurrences SET cancelled=1,updated_at=? WHERE template_id=? AND completed=0 AND due_date>?',
        )
        .bind(now, id, today)
        .run();
    return Boolean(result.meta.changes);
  }
  async setCompleted(id: string, completed: boolean, user: { id: string; displayName: string }) {
    const now = this.clock().getTime();
    const result = await this.db
      .prepare(
        `UPDATE schedule_occurrences SET completed=?,completed_by_user_id=?,completed_by_name=?,completed_at=?,updated_at=? WHERE id=? AND cancelled=0`,
      )
      .bind(
        Number(completed),
        completed ? user.id : null,
        completed ? user.displayName : null,
        completed ? now : null,
        now,
        id,
      )
      .run();
    if (!result.meta.changes) return null;
    const row = await this.db
      .prepare('SELECT * FROM schedule_occurrences WHERE id=?')
      .bind(id)
      .first<OccurrenceRow>();
    return row ? occurrenceFromRow(row, now) : null;
  }
  async generateAll() {
    const templates = await this.listTemplates();
    for (const item of templates) await this.generateTemplate(item.id);
    return templates.length;
  }
  private async getTemplate(id: string) {
    const row = await this.db
      .prepare('SELECT * FROM schedule_templates WHERE id=?')
      .bind(id)
      .first<TemplateRow>();
    return row ? templateFromRow(row) : null;
  }
  private async generateTemplate(id: string) {
    const item = await this.getTemplate(id);
    if (!item?.active) return;
    const now = DateTime.fromJSDate(this.clock(), { zone: BRISBANE_ZONE });
    const from = now.minus({ years: 1 }).toISODate()!;
    const to = now.plus({ months: 13 }).toISODate()!;
    const input: ScheduleTemplateInput = {
      title: item.title,
      description: item.description,
      assignee: item.assignee,
      recurrenceType: item.recurrenceType,
      weekdays: item.weekdays,
      startDate: item.startDate,
      monthlyDay: item.monthlyDay,
      yearlyMonth: item.yearlyMonth,
      yearlyDay: item.yearlyDay,
      dueTime: item.dueTime,
    };
    const label = recurrenceLabel(input);
    const timestamp = this.clock().getTime();
    for (const dueDate of occurrenceDates(input, from, to))
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO schedule_occurrences (id,template_id,due_date,due_at,due_time,title,description,assignee,recurrence_label,completed,cancelled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,0,?,?)`,
        )
        .bind(
          crypto.randomUUID(),
          id,
          dueDate,
          dueMillis(dueDate, item.dueTime),
          item.dueTime,
          item.title,
          item.description,
          item.assignee,
          label,
          timestamp,
          timestamp,
        )
        .run();
  }
}
