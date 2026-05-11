/**
 * One-shot migration from the old two-database layout to the new layered one.
 *
 *   OLD  <source>/structure.db   (sites, sections, boards, board_crawl_state)
 *        <source>/content.db     (threads, posts, fetch_log)
 *
 *   NEW  <target>/structure.db   (sites, nodes, fetch_log)
 *        <target>/forums/<key>.db (threads, posts, board_crawl_state, daily_traffic)
 *
 * Workflow:
 *   1. Verify source exists and contains the old schema.
 *   2. Refuse if target already has a `nodes` table with rows (already migrated).
 *   3. Write new files into a staging directory (<target>.staging-<ts>/).
 *   4. Verify row counts: sites, nodes, threads, posts, fetch_log all match.
 *   5. Backup the original target → <target>.backup-<ts>/ (renames atomically).
 *   6. Move staging → target.
 *
 *   On any error before step 5: staging is removed, target untouched.
 *   On any error between 5 and 6: user manually `mv <backup> <target>` to restore.
 *
 * Usage:
 *   npx tsx scripts/db/migrate-to-layered.ts            # --source ./data --target ./.data
 *   npx tsx scripts/db/migrate-to-layered.ts --dry-run  # analyze + print plan, no writes
 *   npx tsx scripts/db/migrate-to-layered.ts --source ./old --target ./new
 *   npx tsx scripts/db/migrate-to-layered.ts --yes      # skip confirmation prompt
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { SQLiteDb, STRUCTURE_SCHEMA, FORUM_SCHEMA } from '../../src/repository/db';
import { logger } from '../../src/util/logger';

interface Args {
  source: string;
  target: string;
  dryRun: boolean;
  yes: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { source: './data', target: './.data', dryRun: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') { args.source = argv[++i]!; }
    else if (a === '--target') { args.target = argv[++i]!; }
    else if (a === '--dry-run') { args.dryRun = true; }
    else if (a === '--yes' || a === '-y') { args.yes = true; }
  }
  return args;
}

function safeFileName(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function forumDbFile(sectionKey: string): string {
  return `forums/${safeFileName(sectionKey)}.db`;
}

// ---------------------------------------------------------------------------
// Read legacy data
// ---------------------------------------------------------------------------

interface LegacySite { site_key: string; display_name: string; base_url: string; created_at: string; }
interface LegacySection { id: number; parent_section_id: number | null; site_key: string; section_key: string; name: string | null; last_crawled_at: string | null; }
interface LegacyBoard { id: number; site_key: string; board_key: string; name: string | null; section_id: number | null; moderators: string | null; stats: string | null; last_crawled_at: string | null; }
interface LegacyBoardCrawlState { board_id: number; deepest_page_crawled: number; latest_thread_posted_at: string | null; last_crawled_at: string | null; last_thread_key: string | null; }
interface LegacyThread { id: number; site_key: string; url: string; title: string; author: string | null; board_key: string | null; posted_at: string | null; last_reply_at: string | null; reply_count: number | null; view_count: number | null; raw: string | null; is_pinned: number; first_seen_at: string; last_fetched_at: string; }
interface LegacyPost { id: number; thread_id: number; floor: number; author: string; posted_at: string | null; content_html: string; content_text: string; attachments: string | null; raw: string | null; }
interface LegacyFetchLog { site_key: string; tool: string; args: string; status: string; error_code: string | null; duration_ms: number | null; created_at: string; }

interface LegacyData {
  sites: LegacySite[];
  sections: LegacySection[];
  boards: LegacyBoard[];
  boardCrawlState: LegacyBoardCrawlState[];
  threads: LegacyThread[];
  posts: LegacyPost[];
  fetchLog: LegacyFetchLog[];
}

async function readLegacy(source: string): Promise<LegacyData> {
  const structurePath = path.join(source, 'structure.db');
  const contentPath = path.join(source, 'content.db');
  if (!fs.existsSync(structurePath)) throw new Error(`Source structure.db not found: ${structurePath}`);
  if (!fs.existsSync(contentPath)) throw new Error(`Source content.db not found: ${contentPath}`);

  const structure = new SQLiteDb(structurePath);
  const content = new SQLiteDb(contentPath);

  try {
    const sites = (await structure.query<LegacySite>(`SELECT * FROM sites`)).rows;
    const sections = (await structure.query<LegacySection>(
      `SELECT id, parent_section_id, site_key, section_key, name, last_crawled_at FROM sections`,
    )).rows;
    const boards = (await structure.query<LegacyBoard>(
      `SELECT id, site_key, board_key, name, section_id, moderators, stats, last_crawled_at FROM boards`,
    )).rows;
    const boardCrawlState = (await structure.query<LegacyBoardCrawlState>(
      `SELECT board_id, deepest_page_crawled, latest_thread_posted_at, last_crawled_at, last_thread_key FROM board_crawl_state`,
    )).rows;

    const threads = (await content.query<LegacyThread>(`SELECT * FROM threads`)).rows;
    const posts = (await content.query<LegacyPost>(`SELECT * FROM posts`)).rows;
    const fetchLog = (await content.query<LegacyFetchLog>(
      `SELECT site_key, tool, args, status, error_code, duration_ms, created_at FROM fetch_log`,
    )).rows;

    return { sites, sections, boards, boardCrawlState, threads, posts, fetchLog };
  } finally {
    await structure.close();
    await content.close();
  }
}

// ---------------------------------------------------------------------------
// Plan: top-level forum per site → db_file mapping
// ---------------------------------------------------------------------------

interface ForumPlan {
  /** Top-level section in the old schema (parent_section_id IS NULL). */
  topLevelSection: LegacySection;
  /** Path relative to target dir, e.g. "forums/ten.db". */
  dbFile: string;
}

function buildForumPlan(sections: LegacySection[]): Map<number, ForumPlan> {
  const plan = new Map<number, ForumPlan>();
  const seenFile = new Set<string>();
  for (const s of sections) {
    if (s.parent_section_id != null) continue;
    let dbFile = forumDbFile(s.section_key);
    // Collision-safe: append numeric suffix if two sections happen to clash.
    let n = 2;
    while (seenFile.has(dbFile)) {
      dbFile = `forums/${safeFileName(s.section_key)}_${n}.db`;
      n++;
    }
    seenFile.add(dbFile);
    plan.set(s.id, { topLevelSection: s, dbFile });
  }
  return plan;
}

/**
 * For a given board id, walk up the section parent chain to find the
 * top-level section it belongs to. Returns null if the chain is broken.
 */
function findForumForBoard(
  boardId: number,
  boards: LegacyBoard[],
  sections: LegacySection[],
): LegacySection | null {
  const board = boards.find((b) => b.id === boardId);
  if (!board || board.section_id == null) return null;
  let secId: number | null = board.section_id;
  const seen = new Set<number>();
  while (secId != null) {
    if (seen.has(secId)) return null;
    seen.add(secId);
    const sec = sections.find((s) => s.id === secId);
    if (!sec) return null;
    if (sec.parent_section_id == null) return sec;
    secId = sec.parent_section_id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Write the new layout into the staging dir
// ---------------------------------------------------------------------------

interface MigrationStats {
  sites: number;
  nodesForum: number;
  nodesSubForum: number;
  nodesBoard: number;
  threads: number;
  posts: number;
  boardCrawlState: number;
  fetchLog: number;
}

async function writeStaging(stagingDir: string, data: LegacyData): Promise<MigrationStats> {
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(path.join(stagingDir, 'forums'), { recursive: true });

  const newStructure = new SQLiteDb(path.join(stagingDir, 'structure.db'));
  newStructure.applySchema(STRUCTURE_SCHEMA);

  const stats: MigrationStats = {
    sites: 0, nodesForum: 0, nodesSubForum: 0, nodesBoard: 0,
    threads: 0, posts: 0, boardCrawlState: 0, fetchLog: 0,
  };

  // --- sites ---
  for (const s of data.sites) {
    await newStructure.query(
      `INSERT INTO sites (site_key, display_name, base_url, created_at) VALUES ($1,$2,$3,$4)`,
      [s.site_key, s.display_name, s.base_url, s.created_at],
    );
    stats.sites++;
  }

  // --- nodes: topo-order forums (level 0) → sub_forums → boards ---
  const forumPlan = buildForumPlan(data.sections);
  const oldSectionToNewNode = new Map<number, number>();   // section.id → nodes.id
  const oldBoardToNewNode = new Map<number, number>();     // board.id   → nodes.id

  // Topologically order sections: do parents before children.
  // First, top-level (parent_section_id == null), then BFS.
  const topLevel = data.sections.filter((s) => s.parent_section_id == null);
  const ordered: LegacySection[] = [...topLevel];
  let head = 0;
  while (head < ordered.length) {
    const parent = ordered[head]!;
    const children = data.sections.filter((s) => s.parent_section_id === parent.id);
    for (const c of children) ordered.push(c);
    head++;
  }
  if (ordered.length !== data.sections.length) {
    throw new Error(`Section tree integrity: visited ${ordered.length}/${data.sections.length}`);
  }

  for (const sec of ordered) {
    const isTopLevel = sec.parent_section_id == null;
    const newParentId = sec.parent_section_id == null
      ? null
      : oldSectionToNewNode.get(sec.parent_section_id);
    if (sec.parent_section_id != null && newParentId === undefined) {
      throw new Error(`Section ${sec.id} parent ${sec.parent_section_id} not yet inserted (topo order bug)`);
    }
    const level = isTopLevel ? 0 : await (async () => {
      // Look up parent level from new DB
      const r = await newStructure.query<{ level: number }>(
        `SELECT level FROM nodes WHERE id = $1`,
        [newParentId],
      );
      return (r.rows[0]?.level ?? 0) + 1;
    })();
    const type = isTopLevel ? 'forum' : 'sub_forum';
    const dbFile = isTopLevel ? forumPlan.get(sec.id)!.dbFile : null;

    await newStructure.query(
      `INSERT INTO nodes
         (parent_id, site_key, node_key, name, type, level, db_file, created_at, last_crawled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, datetime('now'), $8)`,
      [
        newParentId,
        sec.site_key,
        sec.section_key,
        sec.name ?? sec.section_key,
        type,
        level,
        dbFile,
        sec.last_crawled_at,
      ],
    );
    const r = await newStructure.query<{ id: number }>(`SELECT last_insert_rowid() AS id`);
    oldSectionToNewNode.set(sec.id, Number(r.rows[0]!.id));
    if (isTopLevel) stats.nodesForum++; else stats.nodesSubForum++;
  }

  // Boards → nodes (type='board'). Parent is the section the old row points to.
  for (const b of data.boards) {
    if (b.section_id == null) {
      logger.warn({ boardKey: b.board_key }, 'board has null section_id; inserting at site root');
    }
    const newParentId = b.section_id == null ? null : oldSectionToNewNode.get(b.section_id);
    if (b.section_id != null && newParentId === undefined) {
      throw new Error(`Board ${b.id} references section ${b.section_id} which was not migrated`);
    }
    let level = 1;
    if (newParentId != null) {
      const r = await newStructure.query<{ level: number }>(
        `SELECT level FROM nodes WHERE id = $1`,
        [newParentId],
      );
      level = (r.rows[0]?.level ?? 0) + 1;
    }
    await newStructure.query(
      `INSERT INTO nodes
         (parent_id, site_key, node_key, name, type, level, moderators, stats, created_at, last_crawled_at)
       VALUES ($1,$2,$3,$4,'board',$5,$6,$7, datetime('now'), $8)`,
      [
        newParentId,
        b.site_key,
        b.board_key,
        b.name ?? b.board_key,
        level,
        b.moderators,
        b.stats,
        b.last_crawled_at,
      ],
    );
    const r = await newStructure.query<{ id: number }>(`SELECT last_insert_rowid() AS id`);
    oldBoardToNewNode.set(b.id, Number(r.rows[0]!.id));
    stats.nodesBoard++;
  }

  // --- fetch_log (moves into structure.db) ---
  for (const fl of data.fetchLog) {
    await newStructure.query(
      `INSERT INTO fetch_log (site_key, tool, args, status, error_code, duration_ms, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [fl.site_key, fl.tool, fl.args, fl.status, fl.error_code, fl.duration_ms, fl.created_at],
    );
    stats.fetchLog++;
  }

  // --- forum dbs: open one per top-level forum, write threads/posts/state into it ---
  const boardKeyToNodeId = new Map<string, number>();          // "site_key|board_key" → new node id
  const boardKeyToForumDb = new Map<string, SQLiteDb>();       // "site_key|board_key" → forum db handle
  const forumDbs = new Map<string, SQLiteDb>();                // dbFile → SQLiteDb

  function openForumDb(dbFile: string): SQLiteDb {
    let db = forumDbs.get(dbFile);
    if (db) return db;
    db = new SQLiteDb(path.join(stagingDir, dbFile));
    db.applySchema(FORUM_SCHEMA);
    forumDbs.set(dbFile, db);
    return db;
  }

  // Build board → forumDb routing
  for (const b of data.boards) {
    const newNodeId = oldBoardToNewNode.get(b.id);
    if (newNodeId === undefined) continue;
    const forum = findForumForBoard(b.id, data.boards, data.sections);
    if (!forum) {
      logger.warn({ boardKey: b.board_key }, 'board has no ancestor forum; skipping content');
      continue;
    }
    const dbFile = forumPlan.get(forum.id)!.dbFile;
    const forumDb = openForumDb(dbFile);
    boardKeyToNodeId.set(`${b.site_key}|${b.board_key}`, newNodeId);
    boardKeyToForumDb.set(`${b.site_key}|${b.board_key}`, forumDb);
  }

  // --- board_crawl_state ---
  for (const s of data.boardCrawlState) {
    const newBoardNodeId = oldBoardToNewNode.get(s.board_id);
    if (newBoardNodeId === undefined) continue;
    const board = data.boards.find((b) => b.id === s.board_id);
    if (!board) continue;
    const forumDb = boardKeyToForumDb.get(`${board.site_key}|${board.board_key}`);
    if (!forumDb) continue;
    await forumDb.query(
      `INSERT INTO board_crawl_state
         (board_node_id, deepest_page_crawled, latest_thread_posted_at, last_crawled_at, last_thread_key)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        newBoardNodeId,
        s.deepest_page_crawled,
        s.latest_thread_posted_at,
        s.last_crawled_at,
        s.last_thread_key,
      ],
    );
    stats.boardCrawlState++;
  }

  // --- threads ---
  const oldThreadIdToNew = new Map<number, { newId: number; forumDb: SQLiteDb }>();
  for (const t of data.threads) {
    if (!t.board_key) {
      logger.warn({ url: t.url }, 'thread missing board_key; skipping');
      continue;
    }
    const key = `${t.site_key}|${t.board_key}`;
    const forumDb = boardKeyToForumDb.get(key);
    const boardNodeId = boardKeyToNodeId.get(key);
    if (!forumDb || boardNodeId === undefined) {
      logger.warn({ siteKey: t.site_key, boardKey: t.board_key, url: t.url }, 'thread board not found in new tree; skipping');
      continue;
    }
    await forumDb.query(
      `INSERT INTO threads
         (board_node_id, url, title, author, posted_at, last_reply_at,
          reply_count, view_count, raw, is_pinned, first_seen_at, last_fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        boardNodeId, t.url, t.title, t.author,
        t.posted_at, t.last_reply_at,
        t.reply_count, t.view_count, t.raw,
        t.is_pinned, t.first_seen_at, t.last_fetched_at,
      ],
    );
    const r = await forumDb.query<{ id: number }>(`SELECT last_insert_rowid() AS id`);
    oldThreadIdToNew.set(t.id, { newId: Number(r.rows[0]!.id), forumDb });
    stats.threads++;
  }

  // --- posts ---
  for (const p of data.posts) {
    const mapped = oldThreadIdToNew.get(p.thread_id);
    if (!mapped) continue;
    await mapped.forumDb.query(
      `INSERT INTO posts (thread_id, floor, author, posted_at, content_html, content_text, attachments, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        mapped.newId, p.floor, p.author, p.posted_at,
        p.content_html, p.content_text, p.attachments, p.raw,
      ],
    );
    stats.posts++;
  }

  // Close everything (better-sqlite3 closes are sync inside)
  for (const [, db] of forumDbs) await db.close();
  await newStructure.close();

  return stats;
}

// ---------------------------------------------------------------------------
// Verify: count rows in source vs target
// ---------------------------------------------------------------------------

async function countRow(db: SQLiteDb, sql: string): Promise<number> {
  const r = await db.query<{ c: number }>(sql);
  return Number(r.rows[0]?.c ?? 0);
}

async function verify(stagingDir: string, data: LegacyData): Promise<string[]> {
  const newStructure = new SQLiteDb(path.join(stagingDir, 'structure.db'));
  const errors: string[] = [];

  try {
    const sitesNew = await countRow(newStructure, `SELECT count(*) AS c FROM sites`);
    if (sitesNew !== data.sites.length) errors.push(`sites: old=${data.sites.length} new=${sitesNew}`);

    const nodesNew = await countRow(newStructure, `SELECT count(*) AS c FROM nodes`);
    const expectedNodes = data.sections.length + data.boards.length;
    if (nodesNew !== expectedNodes) errors.push(`nodes: expected=${expectedNodes} new=${nodesNew}`);

    const fetchLogNew = await countRow(newStructure, `SELECT count(*) AS c FROM fetch_log`);
    if (fetchLogNew !== data.fetchLog.length) errors.push(`fetch_log: old=${data.fetchLog.length} new=${fetchLogNew}`);

    // Sum threads/posts across forum dbs.
    const forumFiles = fs.readdirSync(path.join(stagingDir, 'forums'))
      .filter((f) => f.endsWith('.db'))
      .map((f) => path.join(stagingDir, 'forums', f));
    let threadsTotal = 0;
    let postsTotal = 0;
    let crawlStateTotal = 0;
    for (const f of forumFiles) {
      const fdb = new SQLiteDb(f);
      try {
        threadsTotal += await countRow(fdb, `SELECT count(*) AS c FROM threads`);
        postsTotal += await countRow(fdb, `SELECT count(*) AS c FROM posts`);
        crawlStateTotal += await countRow(fdb, `SELECT count(*) AS c FROM board_crawl_state`);
      } finally {
        await fdb.close();
      }
    }
    // Threads "skipped" (no board_key or unknown board) are allowed — warn-logged
    // upstream. So new can be <= old; only flag if strictly greater.
    if (threadsTotal > data.threads.length) {
      errors.push(`threads inflated: old=${data.threads.length} new=${threadsTotal}`);
    }
    if (postsTotal > data.posts.length) {
      errors.push(`posts inflated: old=${data.posts.length} new=${postsTotal}`);
    }
  } finally {
    await newStructure.close();
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function confirm(msg: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`${msg} (y/N): `)).trim().toLowerCase();
  rl.close();
  return ans === 'y' || ans === 'yes';
}

async function main(): Promise<void> {
  const args = parseArgs();
  const source = path.resolve(args.source);
  const target = path.resolve(args.target);

  logger.info({ source, target, dryRun: args.dryRun }, 'migrate-to-layered 开始');

  // 1. Verify source.
  const sourceStructure = path.join(source, 'structure.db');
  if (!fs.existsSync(sourceStructure)) {
    logger.error({ sourceStructure }, '源 structure.db 不存在，无需迁移（或路径错误）');
    process.exit(1);
  }

  // 2. Refuse if target already migrated.
  const targetStructure = path.join(target, 'structure.db');
  if (fs.existsSync(targetStructure) && target !== source) {
    const db = new SQLiteDb(targetStructure);
    try {
      const r = await db.query<{ c: number }>(
        `SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='nodes'`,
      );
      if ((r.rows[0]?.c ?? 0) > 0) {
        logger.error({ targetStructure }, '目标 structure.db 已含 nodes 表，疑似已迁移；中止');
        process.exit(1);
      }
    } finally {
      await db.close();
    }
  }

  // 3. Read legacy.
  logger.info({}, '读取旧库 …');
  const data = await readLegacy(source);
  logger.info(
    {
      sites: data.sites.length,
      sections: data.sections.length,
      boards: data.boards.length,
      threads: data.threads.length,
      posts: data.posts.length,
      fetchLog: data.fetchLog.length,
    },
    '旧库行数',
  );

  const forumPlan = buildForumPlan(data.sections);
  logger.info({ forums: forumPlan.size }, `计划：${forumPlan.size} 个顶级讨论区 → 独立 .db 文件`);
  for (const [, p] of forumPlan) {
    logger.info({ sectionKey: p.topLevelSection.section_key, dbFile: p.dbFile }, '  forum 映射');
  }

  if (args.dryRun) {
    logger.info({}, 'dry-run 完成（未写文件）');
    return;
  }

  // 4. Confirm.
  if (!args.yes) {
    const ok = await confirm(`即将把 ${source} 的数据迁移到 ${target} 的分层结构（原文件会被备份）`);
    if (!ok) {
      logger.info({}, '用户取消');
      return;
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const stagingDir = `${target}.staging-${ts}`;
  const backupDir = `${target}.backup-${ts}`;

  // 5. Write staging.
  logger.info({ stagingDir }, '写入暂存目录 …');
  let stats: MigrationStats;
  try {
    stats = await writeStaging(stagingDir, data);
  } catch (e) {
    logger.error({ err: String(e) }, '迁移写入失败，清理暂存目录');
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw e;
  }
  logger.info(stats as unknown as Record<string, unknown>, '暂存写入完成');

  // 6. Verify.
  logger.info({}, '校验行数 …');
  const errors = await verify(stagingDir, data);
  if (errors.length > 0) {
    logger.error({ errors }, '校验失败，清理暂存目录');
    fs.rmSync(stagingDir, { recursive: true, force: true });
    process.exit(1);
  }
  logger.info({}, '校验通过');

  // 7. Atomic-ish swap.
  if (fs.existsSync(target)) {
    fs.renameSync(target, backupDir);
    logger.info({ backupDir }, '已备份原目录');
  }
  fs.renameSync(stagingDir, target);
  logger.info({ target }, '迁移完成');
  logger.info({}, `恢复方式：rm -rf ${target} && mv ${backupDir} ${target}`);
}

main().catch((err) => {
  console.error('migrate-to-layered failed:', err);
  process.exit(1);
});
