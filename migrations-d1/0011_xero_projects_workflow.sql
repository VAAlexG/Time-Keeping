-- Reviewed-time integration for Xero Projects. This deliberately uses a
-- xero_projects_* namespace so the existing Xero Practice Manager import can
-- continue to operate independently.

CREATE TABLE xero_projects_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tenant_id TEXT,
  tenant_name TEXT,
  connection_id TEXT,
  encrypted_tokens TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0,
  pending_connections_json TEXT,
  pending_actor_id TEXT,
  connected INTEGER NOT NULL DEFAULT 0 CHECK (connected IN (0, 1)),
  paused INTEGER NOT NULL DEFAULT 1 CHECK (paused IN (0, 1)),
  cutover_at INTEGER,
  refresh_lease_token TEXT,
  refresh_lease_until INTEGER NOT NULL DEFAULT 0,
  catalogue_lease_token TEXT,
  catalogue_lease_until INTEGER NOT NULL DEFAULT 0,
  throttle_until INTEGER NOT NULL DEFAULT 0,
  -- Credential rotation has its own optimistic-concurrency counter.  Control
  -- changes (pause/cutover) must not invalidate a refresh token after Xero has
  -- already rotated it.
  token_revision INTEGER NOT NULL DEFAULT 1,
  connection_revision INTEGER NOT NULL DEFAULT 1,
  catalogue_revision INTEGER NOT NULL DEFAULT 0,
  mapping_revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (tenant_id IS NULL OR length(tenant_id) = 36),
  CHECK (cutover_at IS NULL OR cutover_at >= 0)
);
INSERT INTO xero_projects_connection (id, created_at, updated_at) VALUES (1, 0, 0);

-- A CHECK-backed transaction fence. Services set asserted from live state as
-- the first statement in a D1 batch; a false assertion aborts the whole batch.
CREATE TABLE xero_projects_transaction_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  asserted INTEGER NOT NULL CHECK (asserted = 1)
);
INSERT INTO xero_projects_transaction_guard VALUES (1, 1);

CREATE TABLE xero_projects_oauth_states (
  state_hash TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX xero_projects_oauth_states_expiry_idx
  ON xero_projects_oauth_states(expires_at);

CREATE TABLE xero_projects_catalog (
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project', 'task', 'user', 'contact')),
  resource_id TEXT NOT NULL,
  parent_id TEXT NOT NULL DEFAULT '',
  data_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  fetched_at INTEGER NOT NULL,
  catalogue_revision INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, kind, resource_id)
);
CREATE INDEX xero_projects_catalog_parent_idx
  ON xero_projects_catalog(tenant_id, kind, parent_id, active);

CREATE TABLE xero_projects_catalog_staging (
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project', 'task', 'user', 'contact')),
  resource_id TEXT NOT NULL,
  parent_id TEXT NOT NULL DEFAULT '',
  data_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, kind, resource_id)
);
CREATE INDEX xero_projects_catalog_staging_run_idx
  ON xero_projects_catalog_staging(run_id, kind);

CREATE TABLE xero_projects_catalog_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
  projects_count INTEGER NOT NULL DEFAULT 0,
  tasks_count INTEGER NOT NULL DEFAULT 0,
  users_count INTEGER NOT NULL DEFAULT 0,
  contacts_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX xero_projects_catalog_runs_started_idx
  ON xero_projects_catalog_runs(started_at DESC);

CREATE TABLE xero_projects_client_links (
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  contact_id TEXT NOT NULL,
  contact_name_snapshot TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  mapped_by_user_id TEXT NOT NULL,
  mapped_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, client_id),
  UNIQUE (tenant_id, contact_id, client_id)
);

CREATE TABLE xero_projects_user_links (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  xero_user_id TEXT NOT NULL,
  xero_email_snapshot TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  mapped_by_user_id TEXT NOT NULL,
  mapped_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id),
  UNIQUE (tenant_id, xero_user_id)
);

CREATE TABLE xero_projects_work_links (
  tenant_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  project_name_snapshot TEXT NOT NULL,
  task_name_snapshot TEXT NOT NULL,
  task_charge_type_snapshot TEXT NOT NULL,
  task_rate_currency_snapshot TEXT NOT NULL,
  task_rate_value_snapshot REAL NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  mapped_by_user_id TEXT NOT NULL,
  mapped_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, job_id)
);
CREATE INDEX xero_projects_work_links_remote_idx
  ON xero_projects_work_links(tenant_id, project_id, task_id);

-- Completed-entry edits advance this private epoch. The trigger below clears
-- any prior Xero selection in the same SQLite statement, so a failed/stale
-- edit cannot delete a valid selection and a successful edit cannot retain a
-- selection that was validated against an older entry revision.
ALTER TABLE time_entries
  ADD COLUMN xero_selection_epoch INTEGER NOT NULL DEFAULT 0;

-- The job link above is only a reusable default. Every entry records the
-- reviewed project/task choice and labels in this tenant-bound snapshot so a
-- later remap or Xero rename cannot silently change historical time.
CREATE TABLE xero_projects_entry_selections (
  entry_id TEXT PRIMARY KEY REFERENCES time_entries(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  project_name_snapshot TEXT NOT NULL,
  task_name_snapshot TEXT NOT NULL,
  task_charge_type_snapshot TEXT NOT NULL,
  task_rate_currency_snapshot TEXT NOT NULL,
  task_rate_value_snapshot REAL NOT NULL,
  project_catalogue_revision INTEGER NOT NULL,
  task_catalogue_revision INTEGER NOT NULL,
  selection_revision INTEGER NOT NULL DEFAULT 1,
  selected_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  selected_at INTEGER NOT NULL
);
CREATE INDEX xero_projects_entry_selections_remote_idx
  ON xero_projects_entry_selections(tenant_id, project_id, task_id);

CREATE TRIGGER xero_projects_selection_invalidate_on_entry_edit
AFTER UPDATE OF xero_selection_epoch ON time_entries
FOR EACH ROW
WHEN NEW.xero_selection_epoch <> OLD.xero_selection_epoch
BEGIN
  DELETE FROM xero_projects_entry_selections WHERE entry_id = NEW.id;
END;

CREATE TABLE xero_projects_approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('approved', 'cancelled')),
  preview_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  approved_by_user_id TEXT NOT NULL,
  approved_by_email TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  cancelled_by_user_id TEXT,
  cancelled_by_email TEXT,
  cancelled_at INTEGER,
  cancellation_reason TEXT,
  CHECK (
    (state = 'approved' AND cancelled_at IS NULL) OR
    (state = 'cancelled' AND cancelled_at IS NOT NULL AND length(cancellation_reason) BETWEEN 1 AND 500)
  )
);
CREATE INDEX xero_projects_approvals_approved_idx
  ON xero_projects_approvals(approved_at DESC);

CREATE TABLE xero_projects_approval_items (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL REFERENCES xero_projects_approvals(id) ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL,
  entry_id TEXT NOT NULL REFERENCES time_entries(id) ON DELETE RESTRICT,
  source_revision INTEGER NOT NULL,
  selection_revision INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  client_link_revision INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  user_link_revision INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  xero_user_id TEXT NOT NULL,
  project_catalogue_revision INTEGER NOT NULL,
  task_catalogue_revision INTEGER NOT NULL,
  user_catalogue_revision INTEGER NOT NULL,
  source_snapshot_json TEXT NOT NULL,
  mapping_revision INTEGER NOT NULL,
  mapping_snapshot_json TEXT NOT NULL,
  exact_duration_ms INTEGER NOT NULL CHECK (exact_duration_ms > 0),
  rounded_minutes INTEGER NOT NULL CHECK (rounded_minutes BETWEEN 1 AND 59940),
  rounding_delta_seconds REAL NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) <= 128),
  created_at INTEGER NOT NULL,
  UNIQUE (approval_id, entry_id)
);
CREATE INDEX xero_projects_approval_items_entry_idx
  ON xero_projects_approval_items(entry_id, source_revision);

CREATE TRIGGER xero_projects_approval_item_current_source
BEFORE INSERT ON xero_projects_approval_items
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM time_entries
  WHERE id = NEW.entry_id
    AND revision = NEW.source_revision
    AND end_at IS NOT NULL
)
OR NOT EXISTS (
  SELECT 1 FROM xero_projects_entry_selections
  WHERE entry_id = NEW.entry_id
    AND tenant_id = NEW.tenant_id
    AND selection_revision = NEW.selection_revision
    AND project_id = NEW.project_id
    AND task_id = NEW.task_id
)
OR NOT EXISTS (
  SELECT 1 FROM xero_projects_connection
  WHERE id = 1 AND tenant_id = NEW.tenant_id
    AND mapping_revision = NEW.mapping_revision
)
OR NOT EXISTS (
  SELECT 1 FROM xero_projects_client_links
  WHERE tenant_id = NEW.tenant_id AND client_id = NEW.client_id
    AND revision = NEW.client_link_revision
)
OR NOT EXISTS (
  SELECT 1 FROM xero_projects_user_links
  WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id
    AND xero_user_id = NEW.xero_user_id
    AND revision = NEW.user_link_revision
)
OR NOT EXISTS (
  SELECT 1 FROM xero_projects_catalog
  WHERE tenant_id = NEW.tenant_id AND kind = 'project'
    AND resource_id = NEW.project_id AND active = 1
    AND catalogue_revision = NEW.project_catalogue_revision
)
OR NOT EXISTS (
  SELECT 1 FROM xero_projects_catalog
  WHERE tenant_id = NEW.tenant_id AND kind = 'task'
    AND resource_id = NEW.task_id AND parent_id = NEW.project_id AND active = 1
    AND catalogue_revision = NEW.task_catalogue_revision
)
OR NOT EXISTS (
  SELECT 1 FROM xero_projects_catalog
  WHERE tenant_id = NEW.tenant_id AND kind = 'user'
    AND resource_id = NEW.xero_user_id AND active = 1
    AND catalogue_revision = NEW.user_catalogue_revision
)
OR COALESCE((
  SELECT SUM(prior.end_at - prior.start_at)
  FROM time_entries current_entry
  JOIN time_entries prior
    ON prior.segment_root_id = current_entry.segment_root_id
   AND prior.segment_index < current_entry.segment_index
   AND prior.end_at IS NOT NULL
   AND prior.end_at > prior.start_at
  WHERE current_entry.id = NEW.entry_id
), 0) <> CAST(json_extract(NEW.source_snapshot_json, '$.lineageDurationBeforeMs') AS INTEGER)
BEGIN
  SELECT RAISE(ABORT, 'XERO_SOURCE_CHANGED');
END;

CREATE TRIGGER xero_projects_approval_items_immutable
BEFORE UPDATE ON xero_projects_approval_items
BEGIN
  SELECT RAISE(ABORT, 'XERO_APPROVAL_ITEM_IMMUTABLE');
END;

CREATE TRIGGER xero_projects_approval_snapshot_immutable
BEFORE UPDATE OF tenant_id, preview_hash, snapshot_json ON xero_projects_approvals
BEGIN
  SELECT RAISE(ABORT, 'XERO_APPROVAL_SNAPSHOT_IMMUTABLE');
END;

-- A cancelled approval with audited proof that no Xero write was created may
-- be explicitly reapproved. Its
-- payload snapshot stays immutable, while current reviewer/acknowledgement
-- metadata is replaced and each approval event remains in the audit table.
CREATE TRIGGER xero_projects_approval_review_metadata_guard
BEFORE UPDATE OF warnings_json, approved_by_user_id, approved_by_email, approved_at
ON xero_projects_approvals
WHEN NOT (OLD.state = 'cancelled' AND NEW.state = 'approved')
BEGIN
  SELECT RAISE(ABORT, 'XERO_APPROVAL_REVIEW_IMMUTABLE');
END;

CREATE TABLE xero_projects_upload_outbox (
  id TEXT PRIMARY KEY,
  approval_item_id TEXT NOT NULL UNIQUE REFERENCES xero_projects_approval_items(id) ON DELETE RESTRICT,
  approval_id TEXT NOT NULL REFERENCES xero_projects_approvals(id) ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  entry_id TEXT NOT NULL REFERENCES time_entries(id) ON DELETE RESTRICT,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) <= 128),
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'retry_wait', 'provider_accepted', 'failed', 'needs_attention', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at INTEGER,
  last_attempt_at INTEGER,
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  remote_time_entry_id TEXT,
  remote_status_raw TEXT,
  billing_label TEXT,
  last_status_checked_at INTEGER,
  source_drift INTEGER NOT NULL DEFAULT 0 CHECK (source_drift IN (0, 1)),
  remote_drift_json TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX xero_projects_upload_outbox_due_idx
  ON xero_projects_upload_outbox(state, next_attempt_at, lease_until);
-- A Xero time entry can settle exactly one local outbox item.  The partial
-- unique index still permits every pre-upload row to carry NULL.
CREATE UNIQUE INDEX xero_projects_upload_outbox_remote_idx
  ON xero_projects_upload_outbox(tenant_id, remote_time_entry_id)
  WHERE remote_time_entry_id IS NOT NULL;

CREATE TRIGGER xero_projects_outbox_payload_immutable
BEFORE UPDATE OF approval_item_id, approval_id, tenant_id, project_id, entry_id,
  payload_json, payload_hash, idempotency_key, created_at
ON xero_projects_upload_outbox
BEGIN
  SELECT RAISE(ABORT, 'XERO_OUTBOX_PAYLOAD_IMMUTABLE');
END;

CREATE TABLE xero_projects_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX xero_projects_audit_created_idx
  ON xero_projects_audit(created_at DESC);
