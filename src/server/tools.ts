import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listAdapters } from '../core/registry';
import { searchCache } from '../repository/search';
import { serializeError } from './errors';
import type { CrawlerService } from '../core/crawler-service';

export interface ToolDeps {
  crawler: CrawlerService;
  storageStatePathFor: (siteKey: string) => string;
  reloginForcefully: (siteKey: string) => Promise<void>;
  isLoggedIn: (siteKey: string) => Promise<boolean>;
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool('forum_list_sites',
    { description: 'List registered site adapters.', inputSchema: {} as any },
    async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(
        listAdapters().map((a) => ({
          siteKey: a.siteKey,
          displayName: a.displayName,
          baseUrl: a.baseUrl,
          requiresAuth: a.requiresAuth,
        })),
      ) }],
    }),
  );

  server.registerTool('forum_search',
    { description: 'Keyword search on a site.', inputSchema: {} as any },
    async (args: any) => wrap(async () => deps.crawler.search(args)),
  );

  server.registerTool('forum_list_threads',
    { description: 'Paginated board listing.', inputSchema: {} as any },
    async (args: any) => wrap(async () => deps.crawler.listThreads(args)),
  );

  server.registerTool('forum_get_thread',
    { description: 'Fetch a single thread including replies.', inputSchema: {} as any },
    async (args: any) => wrap(async () => deps.crawler.fetchThread(args)),
  );

  server.registerTool('forum_query_cache',
    { description: 'Read-only keyword search over persisted content.', inputSchema: {} as any },
    async (args: any) => wrap(async () => ({ rows: await searchCache(args) })),
  );

  server.registerTool('forum_session_status',
    { description: 'Inspect login state for a site.', inputSchema: {} as any },
    async ({ siteKey }: any) => wrap(async () => ({
      siteKey, loggedIn: await deps.isLoggedIn(siteKey),
      storageStatePath: deps.storageStatePathFor(siteKey),
    })),
  );

  server.registerTool('forum_relogin',
    { description: 'Force re-run of the login flow for a site.', inputSchema: {} as any },
    async ({ siteKey }: any) => wrap(async () => {
      await deps.reloginForcefully(siteKey);
      return { ok: true };
    }),
  );
}

async function wrap<T>(fn: () => Promise<T>): Promise<any> {
  try {
    const out = await fn();
    return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
  } catch (e) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(serializeError(e)) }] };
  }
}
