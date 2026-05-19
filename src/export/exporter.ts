/**
 * Export forum structure to JSON file.
 */
import fs from 'fs';
import path from 'path';
import { getStructureDb } from '../repository/db';
import { DatabaseError } from '../core/errors';
import type { ForumStructure, SectionStructure, BoardStructure } from './types';

const FORMAT_VERSION = '1.0';

/**
 * Export forum structure from database to JSON file.
 */
export async function exportForumStructure(
  siteKey: string,
  outputPath: string,
): Promise<void> {
  try {
    const db = getStructureDb();

    // Get site info
    const siteResult = await db.query<{ display_name: string; base_url: string }>(
      `SELECT display_name, base_url FROM sites WHERE site_key = $1`,
      [siteKey],
    );
    if (siteResult.rows.length === 0) {
      throw new Error(`Site ${siteKey} not found`);
    }
    const siteRow = siteResult.rows[0]!;

    // Build section tree recursively
    const sections = await buildSectionTree(siteKey);

    // Get pinned thread info for each board
    const boardsWithPinned = await getBoardsWithPinned(siteKey);

    // Attach pinned info to boards in the tree
    attachPinnedInfoToTree(sections, boardsWithPinned);

    const structure: ForumStructure = {
      version: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      siteKey,
      site: {
        displayName: siteRow.display_name,
        baseUrl: siteRow.base_url,
      },
      sections,
    };

    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Write to file
    fs.writeFileSync(outputPath, JSON.stringify(structure, null, 2), 'utf-8');
  } catch (e) {
    throw new DatabaseError(`exportForumStructure failed for ${siteKey}`, e);
  }
}

/**
 * Load forum structure from JSON file.
 */
export function loadForumStructure(inputPath: string): ForumStructure {
  const content = fs.readFileSync(inputPath, 'utf-8');
  return JSON.parse(content) as ForumStructure;
}

/**
 * Build section tree from database.
 */
async function buildSectionTree(siteKey: string): Promise<SectionStructure[]> {
  const db = getStructureDb();

  // Get all section nodes (forum + sub_forum).
  const sectionsResult = await db.query<{
    id: number;
    node_key: string;
    name: string | null;
    parent_id: number | null;
  }>(
    `SELECT id, node_key, name, parent_id FROM nodes
      WHERE site_key = $1 AND type IN ('forum','sub_forum')
      ORDER BY id`,
    [siteKey],
  );

  // Get all board nodes.
  const boardsResult = await db.query<{
    id: number;
    node_key: string;
    name: string | null;
    parent_id: number | null;
  }>(
    `SELECT id, node_key, name, parent_id FROM nodes
      WHERE site_key = $1 AND type = 'board'
      ORDER BY id`,
    [siteKey],
  );

  // Build map of section id to section
  const sectionMap = new Map<number, SectionStructure & { id: number; parentId: number | null }>();
  for (const row of sectionsResult.rows) {
    sectionMap.set(row.id, {
      id: row.id,
      parentId: row.parent_id,
      sectionKey: row.node_key,
      name: row.name ?? '',
      subSections: [],
      boards: [],
    });
  }

  // Build map of section id to boards
  const boardMap = new Map<number, BoardStructure[]>();
  for (const row of boardsResult.rows) {
    const board: BoardStructure = {
      boardKey: row.node_key,
      name: row.name ?? '',
      pinnedCount: 0,
      pinnedThreads: [],
    };
    const sectionId = row.parent_id;
    if (sectionId !== null) {
      const boards = boardMap.get(sectionId) ?? [];
      boards.push(board);
      boardMap.set(sectionId, boards);
    }
  }

  // Attach boards to sections
  for (const [sectionId, boards] of boardMap) {
    const section = sectionMap.get(sectionId);
    if (section) {
      section.boards = boards;
    }
  }

  // Build tree
  const rootSections: SectionStructure[] = [];
  for (const section of sectionMap.values()) {
    if (section.parentId === null) {
      // Remove id and parentId from exported structure
      const { id, parentId, ...exportable } = section;
      rootSections.push(exportable);
    } else {
      const parent = sectionMap.get(section.parentId);
      if (parent) {
        const { id, parentId: _p, ...exportable } = section;
        parent.subSections.push(exportable);
      }
    }
  }

  return rootSections;
}

/**
 * Get boards with pinned thread info.
 */
async function getBoardsWithPinned(
  siteKey: string,
): Promise<Map<string, { count: number; threads: { title: string; url: string }[] }>> {
  const result = new Map<string, { count: number; threads: { title: string; url: string }[] }>();

  // Note: threads are in content db, but we just need the summary
  // For now, we'll just set empty pinned info - this will be populated during init
  return result;
}

/**
 * Attach pinned info to boards in the tree.
 */
function attachPinnedInfoToTree(
  sections: SectionStructure[],
  pinnedInfo: Map<string, { count: number; threads: { title: string; url: string }[] }>,
): void {
  for (const section of sections) {
    for (const board of section.boards) {
      const info = pinnedInfo.get(board.boardKey);
      if (info) {
        board.pinnedCount = info.count;
        board.pinnedThreads = info.threads;
      }
    }
    attachPinnedInfoToTree(section.subSections, pinnedInfo);
  }
}
