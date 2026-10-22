PRAGMA foreign_keys = ON;

CREATE TABLE xero_accounting_verifications (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tenant_id TEXT NOT NULL,
  tenant_name TEXT NOT NULL,
  organisation_name TEXT NOT NULL,
  verified_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  verified_at INTEGER NOT NULL,
  http_status INTEGER NOT NULL CHECK (http_status = 200)
);
