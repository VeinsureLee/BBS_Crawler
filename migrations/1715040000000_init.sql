-- Up Migration

CREATE TABLE sites (
  site_key       text PRIMARY KEY,
  display_name   text NOT NULL,
  base_url       text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE boards (
  id             bigserial PRIMARY KEY,
  site_key       text NOT NULL REFERENCES sites(site_key) ON DELETE CASCADE,
  board_key      text NOT NULL,
  name           text,
  UNIQUE (site_key, board_key)
);

CREATE TABLE threads (
  id              bigserial PRIMARY KEY,
  site_key        text NOT NULL REFERENCES sites(site_key) ON DELETE CASCADE,
  url             text NOT NULL,
  title           text NOT NULL,
  author          text,
  board_key       text,
  posted_at       timestamptz,
  last_reply_at   timestamptz,
  reply_count     int,
  view_count      int,
  raw             jsonb,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_key, url)
);
CREATE INDEX threads_site_board_idx ON threads (site_key, board_key, last_reply_at DESC);

CREATE TABLE posts (
  id            bigserial PRIMARY KEY,
  thread_id     bigint NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  floor         int NOT NULL,
  author        text NOT NULL,
  posted_at     timestamptz,
  content_html  text NOT NULL,
  content_text  text NOT NULL,
  attachments   jsonb,
  raw           jsonb,
  UNIQUE (thread_id, floor)
);

CREATE INDEX posts_fts_idx ON posts
  USING GIN (to_tsvector('simple', coalesce(content_text, '')));
CREATE INDEX threads_title_fts_idx ON threads
  USING GIN (to_tsvector('simple', coalesce(title, '')));

CREATE TABLE fetch_log (
  id          bigserial PRIMARY KEY,
  site_key    text NOT NULL,
  tool        text NOT NULL,
  args        jsonb NOT NULL,
  status      text NOT NULL,
  error_code  text,
  duration_ms int,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

-- DROP TABLE IF EXISTS fetch_log;
-- DROP TABLE IF EXISTS posts;
-- DROP TABLE IF EXISTS threads;
-- DROP TABLE IF EXISTS boards;
-- DROP TABLE IF EXISTS sites;
