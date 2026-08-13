PRAGMA foreign_keys = ON;

CREATE TABLE priority_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  assignee TEXT NOT NULL CHECK (assignee IN ('alex', 'brendon', 'suzie')),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 10),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX priority_items_board_idx
  ON priority_items(completed, assignee, priority DESC, created_at ASC);
