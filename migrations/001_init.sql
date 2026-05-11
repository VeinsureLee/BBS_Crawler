-- SQLite Schema Initialization

CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sites (
  site_key       TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  base_url       TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS boards (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  site_key       TEXT NOT NULL,
  board_key      TEXT NOT NULL,
  name           TEXT,
  section_id     INTEGER,
  moderators     TEXT,
  stats          TEXT,
  last_crawled_at TEXT,
  UNIQUE (site_key, board_key),
  FOREIGN KEY (site_key) REFERENCES sites(site_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS boards_section_idx ON boards (section_id);

CREATE TABLE IF NOT EXISTS sections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  site_key       TEXT NOT NULL,
  section_key    TEXT NOT NULL,
  parent_section_id INTEGER,
  name           TEXT,
  last_crawled_at TEXT,
  UNIQUE (site_key, section_key),
  FOREIGN KEY (site_key) REFERENCES sites(site_key) ON DELETE CASCADE,
  FOREIGN KEY (parent_section_id) REFERENCES sections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS sections_parent_idx ON sections (parent_section_id);

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
  UNIQUE (site_key, url),
  FOREIGN KEY (site_key) REFERENCES sites(site_key) ON DELETE CASCADE
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

CREATE TABLE IF NOT EXISTS board_crawl_state (
  board_id                INTEGER PRIMARY KEY,
  deepest_page_crawled    INTEGER NOT NULL DEFAULT 0,
  latest_thread_posted_at TEXT,
  last_crawled_at         TEXT,
  last_thread_key         TEXT,
  FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
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

-- Mark migration 001 as applied
INSERT OR IGNORE INTO migrations (id, name) VALUES ('001', 'init');
