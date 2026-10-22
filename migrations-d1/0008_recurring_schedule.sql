PRAGMA foreign_keys = ON;

CREATE TABLE schedule_templates (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  assignee TEXT NOT NULL CHECK (assignee IN ('alex', 'brendon', 'suzie')),
  recurrence_type TEXT NOT NULL CHECK (recurrence_type IN ('weekly', 'fortnightly', 'monthly', 'yearly')),
  weekdays TEXT NOT NULL DEFAULT '[]',
  start_date TEXT NOT NULL,
  monthly_day INTEGER CHECK (monthly_day BETWEEN 1 AND 31),
  yearly_month INTEGER CHECK (yearly_month BETWEEN 1 AND 12),
  yearly_day INTEGER CHECK (yearly_day BETWEEN 1 AND 31),
  due_time TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE schedule_occurrences (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES schedule_templates(id) ON DELETE RESTRICT,
  due_date TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  due_time TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assignee TEXT NOT NULL CHECK (assignee IN ('alex', 'brendon', 'suzie')),
  recurrence_label TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0, 1)),
  completed_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  completed_by_name TEXT,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(template_id, due_date)
);

CREATE INDEX schedule_templates_active_idx ON schedule_templates(active, assignee);
CREATE INDEX schedule_occurrences_due_idx ON schedule_occurrences(cancelled, due_date, assignee);
CREATE INDEX schedule_occurrences_overdue_idx ON schedule_occurrences(completed, cancelled, due_at);
