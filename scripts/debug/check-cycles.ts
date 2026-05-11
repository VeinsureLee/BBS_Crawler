/**
 * Detect cycles in the nodes table (parent_id self-loops or chains that
 * don't terminate at a NULL parent). Used to diagnose the "init:pinned
 * hangs" symptom caused by data corruption from listSectionChildren
 * returning the current section as one of its own children.
 *
 * Usage:
 *   npx tsx scripts/debug/check-cycles.ts
 */
import 'dotenv/config';
import { parseConfig } from '../../src/core/config';
import { initDb, getStructureDb, closeAllDbs } from '../../src/repository/db';

async function main(): Promise<void> {
  const cfg = parseConfig(process.env);
  initDb({ dataDir: cfg.dataDir });
  const db = getStructureDb();

  console.log(`Scanning ${cfg.dataDir}/structure.db nodes table for cycles...\n`);

  // 1. Self-loops: parent_id == id
  const selfLoops = await db.query<{ id: number; node_key: string; name: string; type: string }>(
    `SELECT id, node_key, name, type FROM nodes WHERE id = parent_id`,
  );
  console.log(`=== 自环 (parent_id 指向自己): ${selfLoops.rows.length} 个 ===`);
  for (const r of selfLoops.rows) {
    console.log(`  [${r.id}] ${r.node_key}  type=${r.type}  name=${r.name}`);
  }

  // 2. Walk up each board, see if chain terminates in <= 10 hops
  const boards = await db.query<{ id: number; node_key: string; parent_id: number | null }>(
    `SELECT id, node_key, parent_id FROM nodes WHERE type = 'board' LIMIT 50`,
  );
  console.log(`\n=== 前 50 个 board 的祖先链 ===`);
  let cycleCount = 0;
  for (const b of boards.rows) {
    const seen = new Set<number>();
    let current: number | null = b.id;
    let hops = 0;
    let cycleHit = false;
    let reachedForum = false;
    while (current !== null && hops < 20) {
      if (seen.has(current)) {
        cycleHit = true;
        break;
      }
      seen.add(current);
      const r = await db.query<{ parent_id: number | null; type: string }>(
        `SELECT parent_id, type FROM nodes WHERE id = $1`,
        [current],
      );
      if (r.rows.length === 0) break;
      if (r.rows[0]!.type === 'forum') {
        reachedForum = true;
        break;
      }
      current = r.rows[0]!.parent_id;
      hops++;
    }
    if (cycleHit) {
      cycleCount++;
      console.log(`  [board ${b.id}] ${b.node_key} → 走了 ${hops} 跳遇到环`);
    } else if (!reachedForum) {
      console.log(`  [board ${b.id}] ${b.node_key} → ${hops} 跳后未到 forum (parent_id=${current})`);
    }
  }
  if (cycleCount === 0) console.log('  (前 50 个 board 均无环)');
  console.log(`\n=== 总计有环 board: ${cycleCount}/${boards.rows.length} ===`);

  // 3. Sub-forums whose parent_id points to themselves (data corruption signature)
  console.log('\n=== sub_forum 的 parent_id 分布 (非空且非自己) ===');
  const r = await db.query<{ count: number; parent_id: number }>(
    `SELECT count(*) AS count, parent_id FROM nodes
      WHERE type = 'sub_forum' AND parent_id IS NOT NULL
      GROUP BY parent_id ORDER BY count DESC LIMIT 10`,
  );
  for (const row of r.rows) {
    console.log(`  parent_id=${row.parent_id}: ${row.count} 个 sub_forum`);
  }

  await closeAllDbs();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
