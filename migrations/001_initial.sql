CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY,
  name varchar(120) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS projects_name_unique_ci ON projects (lower(name));

CREATE TABLE IF NOT EXISTS time_entries (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  notes varchar(2000) NOT NULL DEFAULT '',
  start_at timestamptz NOT NULL,
  end_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT time_entries_valid_range CHECK (end_at IS NULL OR end_at > start_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS time_entries_single_active
  ON time_entries ((end_at IS NULL)) WHERE end_at IS NULL;
CREATE INDEX IF NOT EXISTS time_entries_start_at_idx ON time_entries (start_at DESC);
CREATE INDEX IF NOT EXISTS time_entries_project_idx ON time_entries (project_id);

CREATE TABLE IF NOT EXISTS weekly_report_deliveries (
  id uuid PRIMARY KEY,
  week_start date NOT NULL,
  delivery_type varchar(20) NOT NULL CHECK (delivery_type IN ('scheduled', 'test')),
  status varchar(20) NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  recipient varchar(320) NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  error_message varchar(1000),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (week_start, delivery_type)
);

CREATE TABLE IF NOT EXISTS user_sessions (
  sid varchar NOT NULL PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS user_sessions_expire_idx ON user_sessions (expire);

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename varchar(255) PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
