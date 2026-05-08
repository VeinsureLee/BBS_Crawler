/**
 * Zod input schemas for the four MCP tools. The MCP SDK consumes a "Zod raw
 * shape" (the value of `.shape` on a ZodObject) as `inputSchema`.
 */
import { z } from 'zod';

export const ListSitesInput = z.object({}).strict();

export const ListThreadsInput = z.object({
  siteKey: z.string().min(1),
  /** Strict equality match against `boards.name`. */
  boardName: z.string().min(1),
  /**
   * incremental (default): start at page 1, stop when posted_at <= watermark.
   * pages: crawl exactly `pages` pages starting at `cursor.startPage` (default 1).
   */
  mode: z.enum(['incremental', 'pages']).optional(),
  pages: z.number().int().min(1).max(50).optional(),
  cursor: z.object({ startPage: z.number().int().min(1) }).optional(),
}).strict();

export const GetThreadInput = z.object({
  siteKey: z.string().min(1),
  /** Site-internal thread identifier (from `forum_list_threads` rows). */
  threadId: z.string().min(1),
}).strict();

export const SessionStatusInput = z.object({
  siteKey: z.string().min(1),
}).strict();

export type ListThreadsArgs = z.infer<typeof ListThreadsInput>;
export type GetThreadArgs = z.infer<typeof GetThreadInput>;
export type SessionStatusArgs = z.infer<typeof SessionStatusInput>;
