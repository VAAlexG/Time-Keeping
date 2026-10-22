PRAGMA foreign_keys = ON;

-- Friday closes are independent from the existing Monday-Sunday dashboard reports.
CREATE TABLE close_periods (
  id TEXT PRIMARY KEY,
  coverage_from INTEGER NOT NULL,
  cutoff_at INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('initial', 'scheduled', 'recovery', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('closing', 'closed', 'report_failed')),
  reason TEXT NOT NULL DEFAULT '',
  initiated_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  suppress_delivery INTEGER NOT NULL DEFAULT 0 CHECK (suppress_delivery IN (0, 1)),
  entry_count INTEGER NOT NULL DEFAULT 0,
  total_ms INTEGER NOT NULL DEFAULT 0,
  source_revision INTEGER NOT NULL DEFAULT 0 CHECK (source_revision >= 0),
  closed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (coverage_from < cutoff_at)
);
CREATE INDEX close_periods_cutoff_idx ON close_periods(cutoff_at DESC);

-- Every audited correction advances the period source exactly once. Reports
-- bind themselves to this revision so a correction that commits while files
-- are rendering cannot publish an obsolete snapshot.
CREATE TRIGGER close_periods_source_revision_monotonic
BEFORE UPDATE OF source_revision ON close_periods
WHEN NEW.source_revision <> OLD.source_revision
  AND NEW.source_revision <> OLD.source_revision + 1
BEGIN
  SELECT RAISE(ABORT, 'CLOSE_SOURCE_REVISION_CONFLICT');
END;

CREATE TABLE close_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  activated_at INTEGER,
  closed_through INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
INSERT INTO close_control (id, activated_at, closed_through, updated_at)
VALUES (1, NULL, 0, unixepoch() * 1000);

-- D1 batch statements cannot inspect earlier result counts. Updating this row
-- to zero deliberately violates the CHECK and rolls the whole batch back.
CREATE TABLE close_transaction_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  asserted INTEGER NOT NULL CHECK (asserted = 1),
  write_scope TEXT CHECK (write_scope IS NULL OR write_scope = 'close'),
  write_period_id TEXT,
  CHECK (
    (write_scope IS NULL AND write_period_id IS NULL) OR
    (write_scope = 'close' AND write_period_id IS NOT NULL)
  )
);
INSERT INTO close_transaction_guard (id, asserted) VALUES (1, 1);

ALTER TABLE time_entries ADD COLUMN client_description TEXT NOT NULL DEFAULT ''
  CHECK (length(client_description) <= 2000);
ALTER TABLE time_entries ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE time_entries ADD COLUMN locked_at INTEGER;
ALTER TABLE time_entries ADD COLUMN close_period_id TEXT;
ALTER TABLE time_entries ADD COLUMN segment_root_id TEXT;
ALTER TABLE time_entries ADD COLUMN segment_parent_id TEXT;
ALTER TABLE time_entries ADD COLUMN segment_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE time_entries ADD COLUMN original_start_at INTEGER;
ALTER TABLE time_entries ADD COLUMN original_end_at INTEGER;

UPDATE time_entries
SET segment_root_id = id,
    original_start_at = start_at,
    original_end_at = end_at
WHERE segment_root_id IS NULL;

CREATE INDEX time_entries_lock_idx ON time_entries(locked_at, start_at);
CREATE INDEX time_entries_close_period_idx ON time_entries(close_period_id, start_at);
CREATE INDEX time_entries_segment_root_idx ON time_entries(segment_root_id, segment_index);

-- A one-shot token is inserted only by the dedicated audited correction flow.
-- It lets D1 reject accidental edits through an old endpoint even if an API guard regresses.
CREATE TABLE locked_entry_write_tokens (
  entry_id TEXT NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
  expected_revision INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (entry_id, expected_revision)
);

CREATE TRIGGER time_entries_locked_update_guard
BEFORE UPDATE ON time_entries
WHEN OLD.locked_at IS NOT NULL AND (
  NEW.locked_at IS NOT OLD.locked_at OR
  NEW.close_period_id IS NOT OLD.close_period_id OR
  NOT EXISTS (
    SELECT 1 FROM locked_entry_write_tokens t
    WHERE t.entry_id = OLD.id
      AND t.expected_revision = OLD.revision
      AND t.expires_at >= unixepoch() * 1000
  )
)
BEGIN
  SELECT RAISE(ABORT, 'LOCKED_ENTRY');
END;

CREATE TRIGGER time_entries_locked_update_token_cleanup
AFTER UPDATE ON time_entries
WHEN OLD.locked_at IS NOT NULL
BEGIN
  DELETE FROM locked_entry_write_tokens
  WHERE entry_id = OLD.id AND expected_revision = OLD.revision;
END;

CREATE TRIGGER time_entries_locked_delete_guard
BEFORE DELETE ON time_entries
WHEN OLD.locked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'LOCKED_ENTRY');
END;

-- Inserting the close_period row is the write fence for first activation. The
-- close batch opens this transaction-local scope before it locks entries and
-- clears it before commit. Other requests cannot observe the uncommitted scope.
CREATE TRIGGER time_entries_closing_period_update_guard
BEFORE UPDATE ON time_entries
WHEN OLD.locked_at IS NULL
  AND OLD.start_at < COALESCE((
    SELECT MAX(cutoff_at) FROM close_periods
    WHERE status IN ('closing', 'closed', 'report_failed')
  ), 0)
  AND NOT (
    NEW.locked_at IS NOT NULL
    AND NEW.close_period_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM close_transaction_guard g
      JOIN close_periods p ON p.id = g.write_period_id
      WHERE g.id = 1
        AND g.write_scope = 'close'
        AND g.write_period_id = NEW.close_period_id
        AND p.status = 'closing'
        AND OLD.start_at < p.cutoff_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'LOCKED_PERIOD');
END;

CREATE TRIGGER time_entries_closing_period_delete_guard
BEFORE DELETE ON time_entries
WHEN OLD.locked_at IS NULL
  AND OLD.start_at < COALESCE((
    SELECT MAX(cutoff_at) FROM close_periods
    WHERE status IN ('closing', 'closed', 'report_failed')
  ), 0)
BEGIN
  SELECT RAISE(ABORT, 'LOCKED_PERIOD');
END;

CREATE TRIGGER time_entries_closed_period_insert_guard
BEFORE INSERT ON time_entries
WHEN NEW.locked_at IS NULL
  AND NEW.start_at < COALESCE((SELECT MAX(cutoff_at) FROM close_periods), 0)
BEGIN
  SELECT RAISE(ABORT, 'LOCKED_PERIOD');
END;

CREATE TRIGGER time_entries_closed_period_move_guard
BEFORE UPDATE OF start_at, end_at ON time_entries
WHEN OLD.locked_at IS NULL
  AND NEW.locked_at IS NULL
  AND NEW.start_at < COALESCE((SELECT MAX(cutoff_at) FROM close_periods), 0)
BEGIN
  SELECT RAISE(ABORT, 'LOCKED_PERIOD');
END;

CREATE TABLE report_versions (
  id TEXT PRIMARY KEY,
  close_period_id TEXT NOT NULL REFERENCES close_periods(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  supersedes_report_id TEXT REFERENCES report_versions(id) ON DELETE RESTRICT,
  snapshot_json TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  total_ms INTEGER NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
  correction_reason TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE(close_period_id, version)
);
CREATE INDEX report_versions_period_idx ON report_versions(close_period_id, version DESC);

CREATE TRIGGER report_versions_source_revision_guard
BEFORE INSERT ON report_versions
WHEN NEW.source_revision IS NOT (
  SELECT source_revision FROM close_periods WHERE id = NEW.close_period_id
)
BEGIN
  SELECT RAISE(ABORT, 'REPORT_SOURCE_REVISION_CONFLICT');
END;

CREATE TABLE report_artifacts (
  report_id TEXT NOT NULL REFERENCES report_versions(id) ON DELETE RESTRICT,
  format TEXT NOT NULL CHECK (format IN ('pdf', 'csv', 'xlsx')),
  filename TEXT NOT NULL,
  content BLOB NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 1900000),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (report_id, format)
);

CREATE TABLE report_delivery_outbox (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES report_versions(id) ON DELETE RESTRICT,
  recipient TEXT NOT NULL COLLATE NOCASE,
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'provider_accepted', 'failed', 'needs_attention')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  attachment_manifest_sha256 TEXT NOT NULL,
  provider_message_id TEXT,
  last_error TEXT,
  write_started_at INTEGER,
  accepted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(report_id, recipient)
);
CREATE INDEX report_delivery_ready_idx
  ON report_delivery_outbox(state, next_attempt_at, lease_until);

CREATE TABLE locked_entry_corrections (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES time_entries(id) ON DELETE RESTRICT,
  close_period_id TEXT NOT NULL REFERENCES close_periods(id) ON DELETE RESTRICT,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 5 AND 1000),
  from_revision INTEGER NOT NULL,
  to_revision INTEGER NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  revised_report_id TEXT REFERENCES report_versions(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE(entry_id, to_revision)
);

CREATE TABLE close_audit (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX close_audit_entity_idx ON close_audit(entity_id, created_at DESC);
