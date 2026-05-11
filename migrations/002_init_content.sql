-- SQLite Schema Initialization - Content Database
-- Tables: threads, posts, fetch_log, migrations

CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS threads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  site_key        TEXT NOT NULL,
  url             TEXT NOT NULL,
  title           TEXT NOT NULL,
  author          TEXT,
  board_key       TEXT,
  posted_at       TEXT,
  last_reply_at   TEXT,
  reply_count     INTEGER,
  view_count      INTEGER,
  raw             TEXT,
  is_pinned       INTEGER NOT NULL DEFAULT 0,
  first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (site_key, url)
);

CREATE INDEX IF NOT EXISTS threads_site_board_idx ON threads (site_key, board_key, last_reply_at DESC);
CREATE INDEX IF NOT EXISTS threads_board_pinned_posted_idx ON threads (site_key, board_key, is_pinned, posted_at DESC);

CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id     INTEGER NOT NULL,
  floor         INTEGER NOT NULL,
  author        TEXT NOT NULL,
  posted_at     TEXT,
  content_html  TEXT NOT NULL,
  content_text  TEXT NOT NULL,
  attachments   TEXT,
  raw           TEXT,
  UNIQUE (thread_id, floor),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fetch_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_key    TEXT NOT NULL,
  tool        TEXT NOT NULL,
  args        TEXT NOT NULL,
  status      TEXT NOT NULL,
  error_code  TEXT,
  duration_ms INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Mark migration 002 as applied
INSERT OR IGNORE INTO migrations (id, name) VALUES ('002', 'init_content');
