/**
 * SQLite schema constants — idempotent (CREATE TABLE IF NOT EXISTS).
 */

export const STRUCTURE_SCHEMA = `
CREATE TABLE IF NOT EXISTS migrations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sites (
  site_key     TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  base_url     TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nodes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id       INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  site_key        TEXT NOT NULL REFERENCES sites(site_key) ON DELETE CASCADE,
  node_key        TEXT NOT NULL,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('forum','sub_forum','board')),
  level           INTEGER NOT NULL,
  full_path       TEXT,
  db_path         TEXT,
  moderators      TEXT,
  raw             TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_crawled_at TEXT,
  UNIQUE (site_key, node_key)
);

CREATE INDEX IF NOT EXISTS idx_nodes_parent     ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_site_type  ON nodes(site_key, type);

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

CREATE INDEX IF NOT EXISTS idx_fetch_log_created ON fetch_log(created_at);
`;

export const BOARD_SCHEMA = `
CREATE TABLE IF NOT EXISTS migrations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS threads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  board_node_id   INTEGER NOT NULL,
  url             TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  author          TEXT,
  posted_at       TEXT,
  last_reply_at   TEXT,
  reply_count     INTEGER,
  view_count      INTEGER,
  is_pinned       INTEGER NOT NULL DEFAULT 0,
  raw             TEXT,
  first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_threads_posted        ON threads(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_pinned_posted ON threads(is_pinned, posted_at DESC);

CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id     INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  floor         INTEGER NOT NULL,
  author        TEXT NOT NULL,
  posted_at     TEXT,
  content_html  TEXT NOT NULL,
  content_text  TEXT NOT NULL,
  attachments   TEXT,
  raw           TEXT,
  UNIQUE (thread_id, floor)
);

CREATE TABLE IF NOT EXISTS board_crawl_state (
  board_node_id           INTEGER PRIMARY KEY,
  deepest_page_crawled    INTEGER NOT NULL DEFAULT 0,
  latest_thread_posted_at TEXT,
  last_crawled_at         TEXT,
  last_thread_key         TEXT
);

CREATE TABLE IF NOT EXISTS daily_traffic (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  board_node_id INTEGER NOT NULL,
  date          TEXT NOT NULL,
  online        INTEGER,
  today_posts   INTEGER,
  threads       INTEGER,
  posts         INTEGER,
  snapshot_at   TEXT,
  UNIQUE (board_node_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_traffic_date ON daily_traffic(date);
`;
