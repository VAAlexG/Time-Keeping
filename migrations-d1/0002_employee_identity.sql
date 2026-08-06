PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  access_subject TEXT NOT NULL UNIQUE,
  entra_object_id TEXT UNIQUE,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  role TEXT NOT NULL CHECK (role IN ('employee', 'admin')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

ALTER TABLE time_entries ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE RESTRICT;

DROP INDEX time_entries_single_active;
CREATE UNIQUE INDEX time_entries_user_single_active
  ON time_entries(user_id)
  WHERE end_at IS NULL;
CREATE INDEX time_entries_user_start_idx ON time_entries(user_id, start_at DESC);

DROP TABLE sessions;
DROP TABLE login_attempts;
