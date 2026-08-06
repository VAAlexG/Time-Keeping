PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  name_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE time_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  start_at INTEGER NOT NULL,
  end_at INTEGER,
  active_guard INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (end_at IS NULL OR end_at > start_at),
  CHECK (
    (end_at IS NULL AND active_guard = 1) OR
    (end_at IS NOT NULL AND active_guard IS NULL)
  )
);

CREATE UNIQUE INDEX time_entries_single_active ON time_entries(active_guard);
CREATE INDEX time_entries_start_at_idx ON time_entries(start_at DESC);
CREATE INDEX time_entries_project_idx ON time_entries(project_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE login_attempts (
  identifier TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL,
  blocked_until INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE weekly_report_deliveries (
  id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  delivery_type TEXT NOT NULL CHECK (delivery_type IN ('scheduled', 'test')),
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  recipient TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  provider_message_id TEXT,
  error_message TEXT,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (week_start, delivery_type)
);
