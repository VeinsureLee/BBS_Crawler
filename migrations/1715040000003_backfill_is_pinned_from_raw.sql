-- Up Migration

-- Backfill is_pinned for threads that were ingested by init:pinned before the
-- is_pinned column existed. Those rows have `raw.pinned = true` set by
-- scripts/init/init-pinned.ts. Idempotent: future runs are no-ops because
-- the column is already set.
UPDATE threads
   SET is_pinned = true
 WHERE is_pinned = false
   AND raw IS NOT NULL
   AND (raw ->> 'pinned') = 'true';

-- Down Migration

-- UPDATE threads SET is_pinned = false WHERE is_pinned = true AND raw IS NOT NULL AND (raw ->> 'pinned') = 'true';
