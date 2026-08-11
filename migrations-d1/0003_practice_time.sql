PRAGMA foreign_keys = ON;

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('fyi', 'csv')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 240),
  client_code TEXT,
  export_code TEXT,
  manager_name TEXT,
  partner_name TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
);
CREATE INDEX clients_active_name_idx ON clients(active, name COLLATE NOCASE);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('fyi', 'csv')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 240),
  job_code TEXT,
  status TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  default_billable INTEGER NOT NULL DEFAULT 1 CHECK (default_billable IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
);
CREATE INDEX jobs_client_active_name_idx ON jobs(client_id, active, name COLLATE NOCASE);

CREATE TABLE internal_activities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  name_key TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO internal_activities (id, name, name_key, active, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Administration', 'administration', 1, unixepoch() * 1000, unixepoch() * 1000),
  ('00000000-0000-4000-8000-000000000002', 'Training', 'training', 1, unixepoch() * 1000, unixepoch() * 1000),
  ('00000000-0000-4000-8000-000000000003', 'Leave', 'leave', 1, unixepoch() * 1000, unixepoch() * 1000),
  ('00000000-0000-4000-8000-000000000004', 'Business development', 'business development', 1, unixepoch() * 1000, unixepoch() * 1000),
  ('00000000-0000-4000-8000-000000000005', 'Team meetings', 'team meetings', 1, unixepoch() * 1000, unixepoch() * 1000);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('fyi', 'csv')),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('scheduled', 'manual', 'import')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  clients_created INTEGER NOT NULL DEFAULT 0,
  clients_updated INTEGER NOT NULL DEFAULT 0,
  clients_archived INTEGER NOT NULL DEFAULT 0,
  jobs_created INTEGER NOT NULL DEFAULT 0,
  jobs_updated INTEGER NOT NULL DEFAULT 0,
  jobs_archived INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX sync_runs_started_idx ON sync_runs(started_at DESC);

ALTER TABLE time_entries ADD COLUMN work_type TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE time_entries ADD COLUMN client_id TEXT REFERENCES clients(id) ON DELETE RESTRICT;
ALTER TABLE time_entries ADD COLUMN job_id TEXT REFERENCES jobs(id) ON DELETE RESTRICT;
ALTER TABLE time_entries ADD COLUMN internal_activity_id TEXT REFERENCES internal_activities(id) ON DELETE RESTRICT;
ALTER TABLE time_entries ADD COLUMN billable INTEGER NOT NULL DEFAULT 0 CHECK (billable IN (0, 1));
ALTER TABLE time_entries ADD COLUMN client_name_snapshot TEXT;
ALTER TABLE time_entries ADD COLUMN client_external_id_snapshot TEXT;
ALTER TABLE time_entries ADD COLUMN client_code_snapshot TEXT;
ALTER TABLE time_entries ADD COLUMN job_name_snapshot TEXT;
ALTER TABLE time_entries ADD COLUMN job_external_id_snapshot TEXT;
ALTER TABLE time_entries ADD COLUMN job_code_snapshot TEXT;
ALTER TABLE time_entries ADD COLUMN activity_name_snapshot TEXT;
ALTER TABLE time_entries ADD COLUMN legacy_project_name_snapshot TEXT;

UPDATE time_entries
SET work_type = 'legacy',
    billable = 0,
    legacy_project_name_snapshot = (
      SELECT p.name FROM projects p WHERE p.id = time_entries.project_id
    );

CREATE INDEX time_entries_classification_idx ON time_entries(work_type, client_id, job_id, internal_activity_id);
CREATE INDEX time_entries_billable_idx ON time_entries(billable, start_at DESC);
