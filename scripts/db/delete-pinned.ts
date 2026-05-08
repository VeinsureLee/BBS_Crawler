#!/usr/bin/env tsx
/**
 * Delete all pinned threads and their associated posts from the database.
 * Also cleans up the progress file for init-pinned.
 *
 * Usage:
 *   npx tsx scripts/delete-pinned.ts [siteKey]
 *
 * Defaults to siteKey="school-bbs".
 */
import 'dotenv/config';
import * as fs from 'fs';
import { parseConfig } from '../../src/core/config';
import { initDb, closeDb, getDb } from '../../src/repository/db';

const PROGRESS_FILE = './.init-pinned.progress.json';

interface CliArgs {
  siteKey: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  return { siteKey: args[0] ?? 'school-bbs' };
}

async function deletePinnedThreads(siteKey: string): Promise<{ threadsDeleted: number; postsDeleted: number }> {
  const db = getDb();

  // First count what we're going to delete
  const countResult = await db.query<{ thread_count: string; post_count: string }>(
    `SELECT
       COUNT(DISTINCT t.id) as thread_count,
       COUNT(p.id) as post_count
     FROM threads t
     LEFT JOIN posts p ON t.id = p.thread_id
     WHERE t.site_key = $1
       AND (t.raw->>'pinned')::boolean = true`,
    [siteKey]
  );

  const threadCount = parseInt(countResult.rows[0]!.thread_count, 10);
  const postCount = parseInt(countResult.rows[0]!.post_count, 10);

  if (threadCount === 0) {
    console.log('No pinned threads found.');
    return { threadsDeleted: 0, postsDeleted: 0 };
  }

  console.log(`Found ${threadCount} pinned threads with ${postCount} posts. Deleting...`);

  // Delete posts first (due to foreign key constraint), then threads
  await db.transaction(async (tx) => {
    // Delete posts associated with pinned threads
    await tx.query(
      `DELETE FROM posts
       WHERE thread_id IN (
         SELECT id FROM threads
         WHERE site_key = $1
           AND (raw->>'pinned')::boolean = true
       )`,
      [siteKey]
    );

    // Delete pinned threads
    await tx.query(
      `DELETE FROM threads
       WHERE site_key = $1
         AND (raw->>'pinned')::boolean = true`,
      [siteKey]
    );
  });

  return { threadsDeleted: threadCount, postsDeleted: postCount };
}

function deleteProgressFile(siteKey: string): void {
  if (!fs.existsSync(PROGRESS_FILE)) return;

  try {
    const progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8')) as Record<string, string[]>;
    if (progress[siteKey]) {
      delete progress[siteKey];
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), 'utf-8');
      console.log(`Cleared progress file for ${siteKey}.`);
    }
  } catch (e) {
    console.warn('Could not update progress file:', (e as Error).message);
  }
}

async function main() {
  const { siteKey } = parseArgs();
  const cfg = parseConfig(process.env);
  initDb(cfg.pgDataDir);

  try {
    const { threadsDeleted, postsDeleted } = await deletePinnedThreads(siteKey);
    if (threadsDeleted > 0) {
      console.log(`Successfully deleted ${threadsDeleted} pinned threads and ${postsDeleted} posts.`);
    }
    deleteProgressFile(siteKey);
    console.log('Done. You can now re-run init:pinned to crawl again.');
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error('delete-pinned failed:', err);
  process.exit(1);
});
