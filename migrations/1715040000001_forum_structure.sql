-- Up Migration

CREATE TABLE sections (
  id                bigserial PRIMARY KEY,
  site_key          text NOT NULL REFERENCES sites(site_key) ON DELETE CASCADE,
  section_key       text NOT NULL,
  parent_section_id bigint REFERENCES sections(id) ON DELETE CASCADE,
  name              text,
  last_crawled_at   timestamptz,
  UNIQUE (site_key, section_key)
);

CREATE INDEX sections_parent_idx ON sections (parent_section_id);

ALTER TABLE boards
  ADD COLUMN section_id      bigint REFERENCES sections(id) ON DELETE SET NULL,
  ADD COLUMN moderators      jsonb,
  ADD COLUMN stats           jsonb,
  ADD COLUMN last_crawled_at timestamptz;

CREATE INDEX boards_section_idx ON boards (section_id);

-- stats jsonb shape:
--   { "online": int, "today": int, "threads": int, "posts": int, "snapshot_at": timestamptz }
-- moderators jsonb shape:
--   ["userKey1", "userKey2", ...]

-- Down Migration
-- DROP INDEX IF EXISTS boards_section_idx;
-- ALTER TABLE boards
--   DROP COLUMN IF EXISTS last_crawled_at,
--   DROP COLUMN IF EXISTS stats,
--   DROP COLUMN IF EXISTS moderators,
--   DROP COLUMN IF EXISTS section_id;
-- DROP INDEX IF EXISTS sections_parent_idx;
-- DROP TABLE IF EXISTS sections;
