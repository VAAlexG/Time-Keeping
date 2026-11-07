PRAGMA foreign_keys = ON;

-- Closed periods remain immutable.  A late-entry amendment window creates a
-- narrowly scoped draft lane for one user and one already-closed period.  The
-- original report remains immutable; finalisation locks the drafts and creates
-- a new report version.
CREATE TABLE close_amendment_windows (
  id TEXT PRIMARY KEY,
  close_period_id TEXT NOT NULL REFERENCES close_periods(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('open', 'finalizing', 'closed', 'revoked')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 5 AND 1000),
  opened_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  finalized_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  opened_at INTEGER NOT NULL,
  expires_at INTEGER,
  finalizing_at INTEGER,
  finalize_reason TEXT CHECK (finalize_reason IS NULL OR length(finalize_reason) BETWEEN 5 AND 1000),
  closed_at INTEGER,
  report_id TEXT REFERENCES report_versions(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (expires_at IS NULL OR expires_at > opened_at),
  CHECK (
    (status = 'open' AND finalized_by_user_id IS NULL AND finalizing_at IS NULL AND
      finalize_reason IS NULL AND closed_at IS NULL AND report_id IS NULL) OR
    (status = 'finalizing' AND finalized_by_user_id IS NOT NULL AND finalizing_at IS NOT NULL AND
      finalize_reason IS NOT NULL AND closed_at IS NULL AND report_id IS NULL) OR
    (status = 'closed' AND finalized_by_user_id IS NOT NULL AND finalizing_at IS NOT NULL AND
      finalize_reason IS NOT NULL AND closed_at IS NOT NULL AND report_id IS NOT NULL) OR
    (status = 'revoked' AND finalized_by_user_id IS NULL AND finalizing_at IS NULL AND
      finalize_reason IS NULL AND closed_at IS NOT NULL AND report_id IS NULL)
  )
);
CREATE UNIQUE INDEX close_amendment_windows_active_idx
  ON close_amendment_windows(user_id)
  WHERE status IN ('open', 'finalizing');
CREATE UNIQUE INDEX close_amendment_windows_active_period_idx
  ON close_amendment_windows(close_period_id)
  WHERE status IN ('open', 'finalizing');
CREATE INDEX close_amendment_windows_user_idx
  ON close_amendment_windows(user_id, status, opened_at DESC);
CREATE INDEX close_amendment_windows_period_idx
  ON close_amendment_windows(close_period_id, opened_at DESC);

-- A window can only ever point at an already-published close. Keeping this
-- rule in D1 means an accidental direct insert cannot create a historic write
-- lane around the API validation.
CREATE TRIGGER close_amendment_windows_period_guard
BEFORE INSERT ON close_amendment_windows
WHEN NOT EXISTS (
  SELECT 1
  FROM close_periods p
  WHERE p.id = NEW.close_period_id
    AND p.status IN ('closed', 'report_failed')
    AND EXISTS (SELECT 1 FROM report_versions r WHERE r.close_period_id = p.id)
    AND NOT EXISTS (
      SELECT 1 FROM locked_entry_corrections c
      WHERE c.close_period_id = p.id AND c.revised_report_id IS NULL
    )
)
BEGIN
  SELECT RAISE(ABORT, 'AMENDMENT_PERIOD_NOT_PUBLISHED');
END;

CREATE TRIGGER close_amendment_windows_identity_immutable
BEFORE UPDATE OF close_period_id, user_id, reason, opened_by_user_id, opened_at, expires_at, created_at
ON close_amendment_windows
BEGIN
  SELECT RAISE(ABORT, 'AMENDMENT_WINDOW_IMMUTABLE');
END;

CREATE TRIGGER close_amendment_windows_state_guard
BEFORE UPDATE OF status ON close_amendment_windows
WHEN NOT (
  (OLD.status = 'open' AND NEW.status IN ('open', 'finalizing', 'revoked')) OR
  (OLD.status = 'finalizing' AND NEW.status IN ('finalizing', 'closed'))
)
BEGIN
  SELECT RAISE(ABORT, 'AMENDMENT_STATE_CONFLICT');
END;

CREATE TRIGGER close_amendment_windows_finalizing_metadata_guard
BEFORE UPDATE OF finalized_by_user_id, finalizing_at, finalize_reason
ON close_amendment_windows
WHEN OLD.status = 'finalizing' AND (
  NEW.finalized_by_user_id IS NOT OLD.finalized_by_user_id OR
  NEW.finalizing_at IS NOT OLD.finalizing_at OR
  NEW.finalize_reason IS NOT OLD.finalize_reason
)
BEGIN
  SELECT RAISE(ABORT, 'AMENDMENT_FINALIZATION_IMMUTABLE');
END;

CREATE TRIGGER close_amendment_windows_terminal_immutable
BEFORE UPDATE ON close_amendment_windows
WHEN OLD.status IN ('closed', 'revoked')
BEGIN
  SELECT RAISE(ABORT, 'AMENDMENT_WINDOW_IMMUTABLE');
END;

CREATE TRIGGER close_amendment_windows_delete_guard
BEFORE DELETE ON close_amendment_windows
BEGIN
  SELECT RAISE(ABORT, 'AMENDMENT_WINDOW_IMMUTABLE');
END;

CREATE TRIGGER locked_entry_corrections_amendment_guard
BEFORE INSERT ON locked_entry_corrections
WHEN EXISTS (
  SELECT 1 FROM close_amendment_windows w
  WHERE w.close_period_id = NEW.close_period_id
    AND w.status IN ('open', 'finalizing')
)
BEGIN
  SELECT RAISE(ABORT, 'AMENDMENT_CORRECTION_CONFLICT');
END;

CREATE TABLE close_amendment_audit (
  id TEXT PRIMARY KEY,
  window_id TEXT NOT NULL REFERENCES close_amendment_windows(id) ON DELETE RESTRICT,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN (
    'window.opened', 'draft.created', 'draft.updated', 'draft.deleted',
    'window.finalizing', 'window.closed', 'window.revoked'
  )),
  entry_id TEXT,
  details_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX close_amendment_audit_window_idx
  ON close_amendment_audit(window_id, created_at, id);

CREATE TRIGGER close_amendment_audit_update_guard
BEFORE UPDATE ON close_amendment_audit
BEGIN
  SELECT RAISE(ABORT, 'AMENDMENT_AUDIT_IMMUTABLE');
END;

CREATE TRIGGER close_amendment_audit_delete_guard
BEFORE DELETE ON close_amendment_audit
BEGIN
  SELECT RAISE(ABORT, 'AMENDMENT_AUDIT_IMMUTABLE');
END;

ALTER TABLE time_entries
  ADD COLUMN amendment_window_id TEXT REFERENCES close_amendment_windows(id) ON DELETE RESTRICT;
CREATE INDEX time_entries_amendment_window_idx
  ON time_entries(amendment_window_id, locked_at, start_at);

CREATE TRIGGER time_entries_amendment_window_immutable
BEFORE UPDATE OF amendment_window_id ON time_entries
WHEN NEW.amendment_window_id IS NOT OLD.amendment_window_id
BEGIN
  SELECT RAISE(ABORT, 'AMENDMENT_WINDOW_IMMUTABLE');
END;

CREATE TRIGGER time_entries_amendment_insert_shape_guard
BEFORE INSERT ON time_entries
WHEN NEW.amendment_window_id IS NOT NULL AND NOT (
  NEW.end_at IS NOT NULL AND NEW.end_at > NEW.start_at
  AND NEW.active_guard IS NULL AND NEW.locked_at IS NULL AND NEW.close_period_id IS NULL
  AND NEW.segment_root_id = NEW.id AND NEW.segment_parent_id IS NULL AND NEW.segment_index = 0
  AND NEW.original_start_at = NEW.start_at AND NEW.original_end_at = NEW.end_at
)
BEGIN
  SELECT RAISE(ABORT, 'INVALID_AMENDMENT_DRAFT');
END;

CREATE TRIGGER time_entries_amendment_classification_guard
BEFORE INSERT ON time_entries
WHEN NEW.amendment_window_id IS NOT NULL AND NEW.locked_at IS NULL AND NOT (
  (NEW.work_type = 'client' AND NEW.client_id IS NOT NULL
    AND NEW.internal_activity_id IS NULL AND NEW.legacy_project_name_snapshot IS NULL
    AND EXISTS (SELECT 1 FROM clients c WHERE c.id = NEW.client_id AND c.active = 1)
    AND (NEW.job_id IS NULL OR EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.id = NEW.job_id AND j.client_id = NEW.client_id AND j.active = 1
    ))) OR
  (NEW.work_type = 'internal' AND NEW.client_id IS NULL AND NEW.job_id IS NULL
    AND NEW.internal_activity_id IS NOT NULL AND NEW.billable = 0
    AND NEW.legacy_project_name_snapshot IS NULL
    AND EXISTS (
      SELECT 1 FROM internal_activities a
      WHERE a.id = NEW.internal_activity_id AND a.active = 1
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'INVALID_AMENDMENT_CLASSIFICATION');
END;

CREATE TRIGGER time_entries_amendment_edit_shape_guard
BEFORE UPDATE ON time_entries
WHEN OLD.amendment_window_id IS NOT NULL AND NEW.locked_at IS NULL AND NOT (
  NEW.id = OLD.id AND NEW.user_id = OLD.user_id AND NEW.created_at = OLD.created_at
  AND NEW.active_guard IS NULL AND NEW.close_period_id IS NULL
  AND NEW.segment_root_id IS OLD.segment_root_id
  AND NEW.segment_parent_id IS OLD.segment_parent_id AND NEW.segment_index = OLD.segment_index
  AND NEW.revision = OLD.revision + 1 AND NEW.xero_selection_epoch = OLD.xero_selection_epoch + 1
  AND NEW.original_start_at = NEW.start_at AND NEW.original_end_at = NEW.end_at
)
BEGIN
  SELECT RAISE(ABORT, 'INVALID_AMENDMENT_DRAFT');
END;

CREATE TRIGGER time_entries_amendment_edit_classification_guard
BEFORE UPDATE ON time_entries
WHEN OLD.amendment_window_id IS NOT NULL AND NEW.locked_at IS NULL AND NOT (
  (NEW.work_type = 'client' AND NEW.client_id IS NOT NULL
    AND NEW.internal_activity_id IS NULL AND NEW.legacy_project_name_snapshot IS NULL
    AND EXISTS (SELECT 1 FROM clients c WHERE c.id = NEW.client_id AND c.active = 1)
    AND (NEW.job_id IS NULL OR EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.id = NEW.job_id AND j.client_id = NEW.client_id AND j.active = 1
    ))) OR
  (NEW.work_type = 'internal' AND NEW.client_id IS NULL AND NEW.job_id IS NULL
    AND NEW.internal_activity_id IS NOT NULL AND NEW.billable = 0
    AND NEW.legacy_project_name_snapshot IS NULL
    AND EXISTS (
      SELECT 1 FROM internal_activities a
      WHERE a.id = NEW.internal_activity_id AND a.active = 1
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'INVALID_AMENDMENT_CLASSIFICATION');
END;

CREATE TRIGGER time_entries_amendment_finalize_shape_guard
BEFORE UPDATE ON time_entries
WHEN OLD.amendment_window_id IS NOT NULL AND OLD.locked_at IS NULL
  AND NEW.locked_at IS NOT NULL AND NOT (
  NEW.id = OLD.id AND NEW.user_id = OLD.user_id AND NEW.project_id = OLD.project_id
  AND NEW.notes = OLD.notes AND NEW.client_description = OLD.client_description
  AND NEW.start_at = OLD.start_at AND NEW.end_at = OLD.end_at
  AND NEW.active_guard IS OLD.active_guard AND NEW.created_at = OLD.created_at
  AND NEW.work_type = OLD.work_type AND NEW.client_id IS OLD.client_id
  AND NEW.job_id IS OLD.job_id AND NEW.internal_activity_id IS OLD.internal_activity_id
  AND NEW.billable = OLD.billable
  AND NEW.client_name_snapshot IS OLD.client_name_snapshot
  AND NEW.client_external_id_snapshot IS OLD.client_external_id_snapshot
  AND NEW.client_code_snapshot IS OLD.client_code_snapshot
  AND NEW.job_name_snapshot IS OLD.job_name_snapshot
  AND NEW.job_external_id_snapshot IS OLD.job_external_id_snapshot
  AND NEW.job_code_snapshot IS OLD.job_code_snapshot
  AND NEW.activity_name_snapshot IS OLD.activity_name_snapshot
  AND NEW.legacy_project_name_snapshot IS OLD.legacy_project_name_snapshot
  AND NEW.segment_root_id IS OLD.segment_root_id
  AND NEW.segment_parent_id IS OLD.segment_parent_id AND NEW.segment_index = OLD.segment_index
  AND NEW.original_start_at IS OLD.original_start_at
  AND NEW.original_end_at IS OLD.original_end_at
  AND NEW.xero_selection_epoch = OLD.xero_selection_epoch
  AND NEW.revision = OLD.revision + 1
)
BEGIN
  SELECT RAISE(ABORT, 'INVALID_AMENDMENT_FINALIZATION');
END;

ALTER TABLE report_versions
  ADD COLUMN amendment_window_id TEXT REFERENCES close_amendment_windows(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX report_versions_amendment_window_idx
  ON report_versions(amendment_window_id)
  WHERE amendment_window_id IS NOT NULL;

CREATE TRIGGER report_versions_amendment_window_guard
BEFORE INSERT ON report_versions
WHEN NEW.amendment_window_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM close_amendment_windows w
  WHERE w.id = NEW.amendment_window_id
    AND w.close_period_id = NEW.close_period_id
    AND w.status = 'finalizing'
)
BEGIN
  SELECT RAISE(ABORT, 'AMENDMENT_REPORT_MISMATCH');
END;

CREATE TRIGGER close_amendment_windows_closed_report_guard
BEFORE UPDATE OF status, report_id ON close_amendment_windows
WHEN NEW.status = 'closed' AND NOT EXISTS (
  SELECT 1 FROM report_versions r
  WHERE r.id = NEW.report_id
    AND r.amendment_window_id = NEW.id
    AND r.close_period_id = NEW.close_period_id
)
BEGIN
  SELECT RAISE(ABORT, 'AMENDMENT_REPORT_MISMATCH');
END;

-- Replace the historic-period guards with equivalent guards that additionally
-- recognise the one audited draft lane.  Every other historic mutation stays
-- blocked exactly as before.
DROP TRIGGER time_entries_closing_period_update_guard;
DROP TRIGGER time_entries_closing_period_delete_guard;
DROP TRIGGER time_entries_closed_period_insert_guard;
DROP TRIGGER time_entries_closed_period_move_guard;

CREATE TRIGGER time_entries_closing_period_update_guard
BEFORE UPDATE ON time_entries
WHEN OLD.locked_at IS NULL
  AND OLD.start_at < COALESCE((
    SELECT MAX(cutoff_at) FROM close_periods
    WHERE status IN ('closing', 'closed', 'report_failed')
  ), 0)
  AND NOT (
    -- Ordinary close transaction locks an unlocked current-period row.
    OLD.amendment_window_id IS NULL
    AND NEW.locked_at IS NOT NULL
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
  AND NOT (
    -- The owner may edit only their own completed draft while the exact window
    -- remains open and the edited interval remains inside that period.
    OLD.amendment_window_id IS NOT NULL
    AND NEW.amendment_window_id = OLD.amendment_window_id
    AND NEW.user_id = OLD.user_id
    AND NEW.locked_at IS NULL
    AND NEW.close_period_id IS NULL
    AND NEW.end_at IS NOT NULL
    AND NEW.end_at > NEW.start_at
    AND date(NEW.start_at / 1000, 'unixepoch', '+10 hours') =
        date((NEW.end_at - 1) / 1000, 'unixepoch', '+10 hours')
    AND EXISTS (
      SELECT 1
      FROM close_amendment_windows w
      JOIN close_periods p ON p.id = w.close_period_id
      WHERE w.id = OLD.amendment_window_id
        AND w.user_id = OLD.user_id
        AND w.status = 'open'
        AND (w.expires_at IS NULL OR w.expires_at >= unixepoch() * 1000)
        AND NEW.start_at >= p.coverage_from
        AND NEW.end_at <= p.cutoff_at
    )
  )
  AND NOT (
    -- Finalisation is the only allowed transition from amendment draft to a
    -- locked entry in the original period.
    OLD.amendment_window_id IS NOT NULL
    AND NEW.amendment_window_id = OLD.amendment_window_id
    AND NEW.user_id = OLD.user_id
    AND NEW.locked_at IS NOT NULL
    AND NEW.close_period_id IS NOT NULL
    AND NEW.start_at = OLD.start_at
    AND NEW.end_at = OLD.end_at
    AND NEW.end_at IS NOT NULL
    AND NEW.end_at > NEW.start_at
    AND date(NEW.start_at / 1000, 'unixepoch', '+10 hours') =
        date((NEW.end_at - 1) / 1000, 'unixepoch', '+10 hours')
    AND EXISTS (
      SELECT 1
      FROM close_amendment_windows w
      JOIN close_periods p ON p.id = w.close_period_id
      WHERE w.id = OLD.amendment_window_id
        AND w.user_id = OLD.user_id
        AND w.status = 'finalizing'
        AND NEW.close_period_id = w.close_period_id
        AND NEW.start_at >= p.coverage_from
        AND NEW.end_at <= p.cutoff_at
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
  AND NOT (
    OLD.amendment_window_id IS NOT NULL
    AND OLD.end_at IS NOT NULL
    AND OLD.end_at > OLD.start_at
    AND date(OLD.start_at / 1000, 'unixepoch', '+10 hours') =
        date((OLD.end_at - 1) / 1000, 'unixepoch', '+10 hours')
    AND EXISTS (
      SELECT 1
      FROM close_amendment_windows w
      JOIN close_periods p ON p.id = w.close_period_id
      WHERE w.id = OLD.amendment_window_id
        AND w.user_id = OLD.user_id
        AND w.status = 'open'
        AND (w.expires_at IS NULL OR w.expires_at >= unixepoch() * 1000)
        AND OLD.start_at >= p.coverage_from
        AND OLD.end_at <= p.cutoff_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'LOCKED_PERIOD');
END;

CREATE TRIGGER time_entries_closed_period_insert_guard
BEFORE INSERT ON time_entries
WHEN NEW.locked_at IS NULL
  AND NEW.start_at < COALESCE((SELECT MAX(cutoff_at) FROM close_periods), 0)
  AND NOT (
    NEW.amendment_window_id IS NOT NULL
    AND NEW.close_period_id IS NULL
    AND NEW.end_at IS NOT NULL
    AND NEW.end_at > NEW.start_at
    AND date(NEW.start_at / 1000, 'unixepoch', '+10 hours') =
        date((NEW.end_at - 1) / 1000, 'unixepoch', '+10 hours')
    AND EXISTS (
      SELECT 1
      FROM close_amendment_windows w
      JOIN close_periods p ON p.id = w.close_period_id
      WHERE w.id = NEW.amendment_window_id
        AND w.user_id = NEW.user_id
        AND w.status = 'open'
        AND (w.expires_at IS NULL OR w.expires_at >= unixepoch() * 1000)
        AND NEW.start_at >= p.coverage_from
        AND NEW.end_at <= p.cutoff_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'LOCKED_PERIOD');
END;

CREATE TRIGGER time_entries_closed_period_move_guard
BEFORE UPDATE OF start_at, end_at ON time_entries
WHEN OLD.locked_at IS NULL
  AND NEW.locked_at IS NULL
  AND NEW.start_at < COALESCE((SELECT MAX(cutoff_at) FROM close_periods), 0)
  AND NOT (
    OLD.amendment_window_id IS NOT NULL
    AND NEW.amendment_window_id = OLD.amendment_window_id
    AND NEW.user_id = OLD.user_id
    AND NEW.close_period_id IS NULL
    AND NEW.end_at IS NOT NULL
    AND NEW.end_at > NEW.start_at
    AND date(NEW.start_at / 1000, 'unixepoch', '+10 hours') =
        date((NEW.end_at - 1) / 1000, 'unixepoch', '+10 hours')
    AND EXISTS (
      SELECT 1
      FROM close_amendment_windows w
      JOIN close_periods p ON p.id = w.close_period_id
      WHERE w.id = OLD.amendment_window_id
        AND w.user_id = OLD.user_id
        AND w.status = 'open'
        AND (w.expires_at IS NULL OR w.expires_at >= unixepoch() * 1000)
        AND NEW.start_at >= p.coverage_from
        AND NEW.end_at <= p.cutoff_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'LOCKED_PERIOD');
END;
