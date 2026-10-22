PRAGMA foreign_keys = OFF;
-- D1 runs each migration in a transaction, where changing foreign_keys is a
-- no-op. Defer validation until the replacement tables have their final names.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE clients_xero (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('fyi', 'xero', 'csv')),
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
INSERT INTO clients_xero SELECT * FROM clients;

CREATE TABLE jobs_xero (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES clients_xero(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('fyi', 'xero', 'csv')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 240),
  job_code TEXT,
  status TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  default_billable INTEGER NOT NULL DEFAULT 1 CHECK (default_billable IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
);
INSERT INTO jobs_xero SELECT * FROM jobs;

CREATE TABLE time_entries_xero (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  start_at INTEGER NOT NULL,
  end_at INTEGER,
  active_guard INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  work_type TEXT NOT NULL DEFAULT 'legacy',
  client_id TEXT REFERENCES clients_xero(id) ON DELETE RESTRICT,
  job_id TEXT REFERENCES jobs_xero(id) ON DELETE RESTRICT,
  internal_activity_id TEXT REFERENCES internal_activities(id) ON DELETE RESTRICT,
  billable INTEGER NOT NULL DEFAULT 0 CHECK (billable IN (0, 1)),
  client_name_snapshot TEXT,
  client_external_id_snapshot TEXT,
  client_code_snapshot TEXT,
  job_name_snapshot TEXT,
  job_external_id_snapshot TEXT,
  job_code_snapshot TEXT,
  activity_name_snapshot TEXT,
  legacy_project_name_snapshot TEXT,
  CHECK (end_at IS NULL OR end_at > start_at),
  CHECK (
    (end_at IS NULL AND active_guard = 1) OR
    (end_at IS NOT NULL AND active_guard IS NULL)
  )
);
INSERT INTO time_entries_xero SELECT * FROM time_entries;

DROP TABLE time_entries;
DROP TABLE jobs;
DROP TABLE clients;
ALTER TABLE clients_xero RENAME TO clients;
ALTER TABLE jobs_xero RENAME TO jobs;
ALTER TABLE time_entries_xero RENAME TO time_entries;
CREATE INDEX clients_active_name_idx ON clients(active, name COLLATE NOCASE);
CREATE INDEX jobs_client_active_name_idx ON jobs(client_id, active, name COLLATE NOCASE);
CREATE INDEX time_entries_start_at_idx ON time_entries(start_at DESC);
CREATE INDEX time_entries_project_idx ON time_entries(project_id);
CREATE UNIQUE INDEX time_entries_user_single_active
  ON time_entries(user_id)
  WHERE end_at IS NULL;
CREATE INDEX time_entries_user_start_idx ON time_entries(user_id, start_at DESC);
CREATE INDEX time_entries_classification_idx ON time_entries(work_type, client_id, job_id, internal_activity_id);
CREATE INDEX time_entries_billable_idx ON time_entries(billable, start_at DESC);

CREATE TABLE sync_runs_xero (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('fyi', 'xero', 'csv')),
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
INSERT INTO sync_runs_xero SELECT * FROM sync_runs;
DROP TABLE sync_runs;
ALTER TABLE sync_runs_xero RENAME TO sync_runs;
CREATE INDEX sync_runs_started_idx ON sync_runs(started_at DESC);

CREATE TABLE xero_connections (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tenant_id TEXT NOT NULL,
  tenant_name TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  connected_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE xero_oauth_states (
  state_hash TEXT PRIMARY KEY,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX xero_oauth_states_expiry_idx ON xero_oauth_states(expires_at);

PRAGMA foreign_keys = ON;
