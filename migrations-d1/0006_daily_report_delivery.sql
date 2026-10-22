PRAGMA foreign_keys = OFF;

CREATE TABLE weekly_report_deliveries_daily (
  id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  delivery_date TEXT NOT NULL,
  delivery_type TEXT NOT NULL CHECK (delivery_type IN ('scheduled', 'test')),
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  recipient TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  provider_message_id TEXT,
  error_message TEXT,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (week_start, delivery_date, delivery_type)
);

INSERT INTO weekly_report_deliveries_daily
  (id, week_start, delivery_date, delivery_type, status, recipient, attempts,
   provider_message_id, error_message, sent_at, created_at, updated_at)
SELECT id, week_start, week_start, delivery_type, status, recipient, attempts,
       provider_message_id, error_message, sent_at, created_at, updated_at
FROM weekly_report_deliveries;

DROP TABLE weekly_report_deliveries;
ALTER TABLE weekly_report_deliveries_daily RENAME TO weekly_report_deliveries;

PRAGMA foreign_keys = ON;
