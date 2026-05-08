-- Up Migration

-- Mark pinned threads in the existing single-table design.
-- posted_at and last_fetched_at already exist on `threads` from the init migration.
ALTER TABLE threads
  ADD COLUMN IF NOT EXISTS is_pinned boolean NOT NULL DEFAULT false;

-- Index supporting "latest threads in a board, optionally filtered by pinned".
CREATE INDEX IF NOT EXISTS threads_board_pinned_posted_idx
  ON threads (site_key, board_key, is_pinned, posted_at DESC NULLS LAST);

-- Per-board incremental crawl state.
-- Read by forum_list_threads to decide where to resume / when to stop.
-- Written at the end of every list_threads run.
CREATE TABLE IF NOT EXISTS board_crawl_state (
  board_id                bigint PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
  deepest_page_crawled    int         NOT NULL DEFAULT 0,
  latest_thread_posted_at timestamptz,
  last_crawled_at         timestamptz,
  last_thread_key         text
);

-- Down Migration

-- DROP TABLE IF EXISTS board_crawl_state;
-- DROP INDEX IF EXISTS threads_board_pinned_posted_idx;
-- ALTER TABLE threads DROP COLUMN IF EXISTS is_pinned;
