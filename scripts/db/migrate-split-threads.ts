/**
 * One-shot migration: split the single `threads` + `posts` tables in each
 * forum db into two pairs:
 *   - pinned_threads / pinned_posts   (rows where is_pinned = 1)
 *   - plain_threads  / plain_posts    (rows where is_pinned = 0)
 *
 * Idempotent: forums that already have `pinned_threads` / `plain_threads`
 * (and no legacy `threads`) are skipped.
 *
 * Per forum db:
 *   1. Backup the original file (and any WAL/SHM sidecars) to `<file>.bak`.
 *   2. Apply the new FORUM_SCHEMA (creates pinned_* / plain_* idempotently).
 *   3. In a transaction:
 *        - INSERT INTO pinned_threads SELECT ... FROM threads WHERE is_pinned=1
 *          (preserve `id` so the existing post FKs map cleanly).
 *        - INSERT INTO plain_threads  SELECT ... FROM threads WHERE is_pinned=0
 *        - INSERT INTO pinned_posts   SELECT p.* FROM posts p
 *            JOIN threads t ON t.id = p.thread_id WHERE t.is_pinned=1
 *        - INSERT INTO plain_posts    same, where is_pinned=0
 *        - DROP TABLE posts; DROP TABLE threads
 *   4. Verify row counts: pinned+plain == legacy threads (and same for posts).
 *
 * Usage:
 *   npx tsx scripts/db/migrate-split-threads.ts             # default --data-dir ./.data
 *   npx tsx scripts/db/migrate-split-threads.ts --dry-run   # report only, no writes
 *   npx tsx scripts/db/migrate-split-threads.ts --data-dir ./.data --yes
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { SQLiteDb, FORUM_SCHEMA } from '../../src/repository/db';

interface Args {
  dataDir: string;
  dryRun: boolean;
  yes: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { dataDir: process.env.DATABASE_PATH ?? './.data', dryRun: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data-dir') { args.dataDir = argv[++i]!; }
    else if (a === '--dry-run') { args.dryRun = true; }
    else if (a === '--yes' || a === '-y') { args.yes = true; }
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: tsx scripts/db/migrate-split-threads.ts [--data-dir DIR] [--dry-run] [--yes]`);
      process.exit(0);
    }
  }
  return args;
}

function listForumDbFiles(dataDir: string): string[] {
  const structurePath = path.join(dataDir, 'structure.db');
  if (!fs.existsSync(structurePath)) {
    throw new Error(`structure.db not found at ${structurePath}`);
  }
  const sdb = new SQLiteDb(structurePath);
  try {
    const rows = sdb.rawAll<{ db_file: string }>(
      `SELECT db_file FROM nodes WHERE db_file IS NOT NULL ORDER BY id`,
    );
    return rows.map((r) => r.db_file);
  } finally {
    sdb.closeSync();
  }
}

function tableExists(db: SQLiteDb, name: string): boolean {
  const rows = db.rawAll<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`,
  );
  return rows.length > 0;
}

interface PreCheck {
  needsMigration: boolean;
  legacyThreads: number;
  legacyPosts: number;
  legacyPinned: number;
  legacyPlain: number;
  alreadyHasNew: boolean;
}

function preCheck(db: SQLiteDb): PreCheck {
  const hasLegacy = tableExists(db, 'threads') && tableExists(db, 'posts');
  const hasNewPinned = tableExists(db, 'pinned_threads');
  const hasNewPlain = tableExists(db, 'plain_threads');

  if (!hasLegacy) {
    return {
      needsMigration: false,
      legacyThreads: 0, legacyPosts: 0, legacyPinned: 0, legacyPlain: 0,
      alreadyHasNew: hasNewPinned && hasNewPlain,
    };
  }

  const threadsRows = db.rawAll<{ c: number }>(`SELECT count(*) AS c FROM threads`);
  const postsRows = db.rawAll<{ c: number }>(`SELECT count(*) AS c FROM posts`);
  const pinnedRows = db.rawAll<{ c: number }>(`SELECT count(*) AS c FROM threads WHERE is_pinned = 1`);
  const plainRows = db.rawAll<{ c: number }>(`SELECT count(*) AS c FROM threads WHERE is_pinned = 0`);

  return {
    needsMigration: true,
    legacyThreads: threadsRows[0]!.c,
    legacyPosts: postsRows[0]!.c,
    legacyPinned: pinnedRows[0]!.c,
    legacyPlain: plainRows[0]!.c,
    alreadyHasNew: hasNewPinned && hasNewPlain,
  };
}

function backupFile(absPath: string): string {
  const bak = `${absPath}.bak`;
  if (fs.existsSync(bak)) {
    throw new Error(`Backup already exists: ${bak} — refusing to overwrite. Delete or rename it first.`);
  }
  fs.copyFileSync(absPath, bak);
  // Copy WAL/SHM sidecars if present so the backup is restorable as-is.
  for (const ext of ['-wal', '-shm']) {
    const side = absPath + ext;
    if (fs.existsSync(side)) {
      fs.copyFileSync(side, bak + ext);
    }
  }
  return bak;
}

function migrateOne(db: SQLiteDb): { migratedThreads: number; migratedPosts: number } {
  // Apply the new schema first (creates pinned_/plain_ tables if absent).
  db.rawExec(FORUM_SCHEMA);

  const before = db.rawAll<{ c: number }>(`SELECT count(*) AS c FROM threads`)[0]!.c;
  const beforePosts = db.rawAll<{ c: number }>(`SELECT count(*) AS c FROM posts`)[0]!.c;

  db.rawExec(`BEGIN TRANSACTION;
    INSERT INTO pinned_threads
      (id, board_node_id, url, title, author, posted_at, last_reply_at,
       reply_count, view_count, raw, first_seen_at, last_fetched_at)
    SELECT id, board_node_id, url, title, author, posted_at, last_reply_at,
           reply_count, view_count, raw, first_seen_at, last_fetched_at
      FROM threads WHERE is_pinned = 1;

    INSERT INTO plain_threads
      (id, board_node_id, url, title, author, posted_at, last_reply_at,
       reply_count, view_count, raw, first_seen_at, last_fetched_at)
    SELECT id, board_node_id, url, title, author, posted_at, last_reply_at,
           reply_count, view_count, raw, first_seen_at, last_fetched_at
      FROM threads WHERE is_pinned = 0;

    INSERT INTO pinned_posts
      (thread_id, floor, author, posted_at, content_html, content_text, attachments, raw)
    SELECT p.thread_id, p.floor, p.author, p.posted_at, p.content_html,
           p.content_text, p.attachments, p.raw
      FROM posts p JOIN threads t ON t.id = p.thread_id
     WHERE t.is_pinned = 1;

    INSERT INTO plain_posts
      (thread_id, floor, author, posted_at, content_html, content_text, attachments, raw)
    SELECT p.thread_id, p.floor, p.author, p.posted_at, p.content_html,
           p.content_text, p.attachments, p.raw
      FROM posts p JOIN threads t ON t.id = p.thread_id
     WHERE t.is_pinned = 0;

    DROP INDEX IF EXISTS idx_threads_board;
    DROP INDEX IF EXISTS idx_threads_board_pinned;
    DROP TABLE posts;
    DROP TABLE threads;
  COMMIT;`);

  // Verify
  const pinnedT = db.rawAll<{ c: number }>(`SELECT count(*) AS c FROM pinned_threads`)[0]!.c;
  const plainT = db.rawAll<{ c: number }>(`SELECT count(*) AS c FROM plain_threads`)[0]!.c;
  const pinnedP = db.rawAll<{ c: number }>(`SELECT count(*) AS c FROM pinned_posts`)[0]!.c;
  const plainP = db.rawAll<{ c: number }>(`SELECT count(*) AS c FROM plain_posts`)[0]!.c;

  if (pinnedT + plainT !== before) {
    throw new Error(`thread row count mismatch: ${pinnedT}+${plainT} != ${before}`);
  }
  if (pinnedP + plainP !== beforePosts) {
    throw new Error(`post row count mismatch: ${pinnedP}+${plainP} != ${beforePosts}`);
  }
  return { migratedThreads: before, migratedPosts: beforePosts };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const dataDir = path.resolve(args.dataDir);
  if (!fs.existsSync(dataDir)) {
    throw new Error(`data dir not found: ${dataDir}`);
  }

  console.log(`Data dir: ${dataDir}`);
  const dbFiles = listForumDbFiles(dataDir);
  console.log(`Found ${dbFiles.length} forum db files in structure.db.`);

  const plan: Array<{
    dbFile: string;
    absPath: string;
    check: PreCheck;
    fileExists: boolean;
  }> = [];

  for (const f of dbFiles) {
    const absPath = path.isAbsolute(f) ? f : path.join(dataDir, f);
    if (!fs.existsSync(absPath)) {
      plan.push({ dbFile: f, absPath, fileExists: false, check: {
        needsMigration: false, legacyThreads: 0, legacyPosts: 0, legacyPinned: 0, legacyPlain: 0, alreadyHasNew: false,
      }});
      continue;
    }
    const db = new SQLiteDb(absPath);
    try {
      plan.push({ dbFile: f, absPath, fileExists: true, check: preCheck(db) });
    } finally {
      db.closeSync();
    }
  }

  // Report
  let toMigrate = 0, skipped = 0, missing = 0;
  let sumThreads = 0, sumPosts = 0, sumPinned = 0, sumPlain = 0;
  for (const p of plan) {
    if (!p.fileExists) {
      console.log(`  [missing]    ${p.dbFile}`);
      missing++;
    } else if (p.check.needsMigration) {
      console.log(
        `  [migrate]    ${p.dbFile}   threads=${p.check.legacyThreads} (pinned=${p.check.legacyPinned}, plain=${p.check.legacyPlain})  posts=${p.check.legacyPosts}`,
      );
      toMigrate++;
      sumThreads += p.check.legacyThreads;
      sumPosts += p.check.legacyPosts;
      sumPinned += p.check.legacyPinned;
      sumPlain += p.check.legacyPlain;
    } else if (p.check.alreadyHasNew) {
      console.log(`  [skip - ok]  ${p.dbFile}   (already migrated)`);
      skipped++;
    } else {
      console.log(`  [skip - new] ${p.dbFile}   (fresh db, no legacy tables)`);
      skipped++;
    }
  }
  console.log('');
  console.log(`Plan: migrate ${toMigrate} forum db(s) (${sumThreads} threads: ${sumPinned} pinned + ${sumPlain} plain; ${sumPosts} posts). Skip ${skipped}.${missing > 0 ? ` Missing files: ${missing}.` : ''}`);

  if (toMigrate === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (args.dryRun) {
    console.log('--dry-run: no files were modified.');
    return;
  }

  if (!args.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question('\nProceed with migration? Each db will be backed up to <file>.bak first. [y/N] ');
    rl.close();
    if (!/^y(es)?$/i.test(ans.trim())) {
      console.log('Aborted.');
      return;
    }
  }

  let done = 0, failed = 0;
  for (const p of plan) {
    if (!p.fileExists || !p.check.needsMigration) continue;

    console.log(`\n→ ${p.dbFile}`);
    try {
      const bak = backupFile(p.absPath);
      console.log(`  backup → ${path.basename(bak)}`);

      const db = new SQLiteDb(p.absPath);
      try {
        const result = migrateOne(db);
        console.log(`  ok: ${result.migratedThreads} threads, ${result.migratedPosts} posts migrated`);
      } finally {
        db.closeSync();
      }
      done++;
    } catch (e) {
      failed++;
      console.error(`  FAILED: ${(e as Error).message}`);
      console.error(`  The .bak file is intact — to restore: mv "${p.absPath}.bak" "${p.absPath}"`);
    }
  }

  console.log(`\nDone. Migrated ${done}, failed ${failed}.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('migrate-split-threads failed:', err);
  process.exit(1);
});
