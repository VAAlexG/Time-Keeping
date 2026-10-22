PRAGMA foreign_keys = ON;

ALTER TABLE priority_items ADD COLUMN description TEXT NOT NULL DEFAULT '';

CREATE TABLE finalized_weekly_reports (
  week_start TEXT PRIMARY KEY,
  week_end TEXT NOT NULL,
  finalized_at INTEGER NOT NULL,
  filename TEXT NOT NULL,
  content BLOB NOT NULL,
  total_ms INTEGER NOT NULL,
  entry_count INTEGER NOT NULL,
  email_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (email_status IN ('pending', 'sending', 'sent', 'failed')),
  email_recipients TEXT NOT NULL,
  email_attempts INTEGER NOT NULL DEFAULT 0,
  email_sent_at INTEGER,
  provider_message_id TEXT,
  email_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX finalized_weekly_reports_finalized_idx
  ON finalized_weekly_reports(finalized_at DESC);
