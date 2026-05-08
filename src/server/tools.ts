import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listAdapters } from '../core/registry';
import { wrap } from './envelope';
import { McpToolError } from './error-codes';
import {
  ListSitesInput,
  ListThreadsInput,
  GetThreadInput,
  SessionStatusInput,
} from './schemas';
import type { CrawlerService } from '../core/crawler-service';

export interface ToolDeps {
  crawler: CrawlerService;
  isLoggedIn: (siteKey: string) => Promise<boolean>;
  storageStatePathFor: (siteKey: string) => string;
}

/**
 * Register the four MCP tools the agent uses:
 *   - forum_list_sites
 *   - forum_list_threads
 *   - forum_get_thread
 *   - forum_session_status
 *
 * forum_list_threads / forum_get_thread are registered here but route to
 * placeholder implementations until Branch 4 wires up the real adapter
 * methods (listThreadsByName / fetchThreadById on CrawlerService).
 */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'forum_list_sites',
    {
      description: 'List registered site adapters available to this MCP server.',
      inputSchema: ListSitesInput.shape,
    },
    async () => wrap(async () => ({
      data: listAdapters().map((a) => ({
        siteKey: a.siteKey,
        displayName: a.displayName,
        baseUrl: a.baseUrl,
        requiresAuth: a.requiresAuth,
      })),
    })),
  );

  server.registerTool(
    'forum_list_threads',
    {
      description:
        'Crawl threads from a board by exact name. Default mode "incremental" stops when known posts are reached; "pages" crawls a fixed page range starting at cursor.startPage.',
      inputSchema: ListThreadsInput.shape,
    },
    async (raw: unknown) => wrap(async () => {
      const input = ListThreadsInput.parse(raw);
      void deps; // crawler.listThreadsByName(input) — implemented in Branch 4
      void input;
      throw new McpToolError(
        'FETCH_FAILED',
        'forum_list_threads is not yet implemented (Branch 4).',
      );
    }),
  );

  server.registerTool(
    'forum_get_thread',
    {
      description: 'Fetch a single thread including all replies, by site-internal threadId.',
      inputSchema: GetThreadInput.shape,
    },
    async (raw: unknown) => wrap(async () => {
      const input = GetThreadInput.parse(raw);
      void deps; // crawler.fetchThreadById(input) — implemented in Branch 4
      void input;
      throw new McpToolError(
        'FETCH_FAILED',
        'forum_get_thread is not yet implemented (Branch 4).',
      );
    }),
  );

  server.registerTool(
    'forum_session_status',
    {
      description: 'Inspect login state for a site.',
      inputSchema: SessionStatusInput.shape,
    },
    async (raw: unknown) => wrap(async () => {
      const { siteKey } = SessionStatusInput.parse(raw);
      return {
        data: {
          siteKey,
          loggedIn: await deps.isLoggedIn(siteKey),
          storageStatePath: deps.storageStatePathFor(siteKey),
        },
      };
    }),
  );
}
