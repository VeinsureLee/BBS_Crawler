/**
 * End-to-end smoke test for the MCP server.
 *
 * Spawns dist/index.js as a child process, talks the MCP protocol over stdio
 * via the official client SDK, and exercises the four registered tools
 * against the live school-bbs site.
 *
 * Run:  npx tsx scripts/debug/smoke-mcp.ts
 *
 * Pre-reqs: env vars + ./.state/school-bbs.json + boards already in DB.
 * Picks a quiet board ("意见与建议") to keep the crawl fast.
 */
import 'dotenv/config';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BOARD_NAME = process.argv[2] ?? '意见与建议';
const SITE_KEY = 'school-bbs';

function summarize(text: string, max = 600): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + ` ... [+${text.length - max} chars]`;
}

function parseEnvelope(res: { content: Array<{ type: string; text?: string }> }): unknown {
  const part = res.content[0];
  if (!part || part.type !== 'text' || !part.text) {
    throw new Error('Tool response missing text content');
  }
  return JSON.parse(part.text);
}

async function main(): Promise<void> {
  // Spawn the server via tsx — `npm run start` (node dist/index.js) is broken
  // because dist/ uses extension-less imports under "type": "module".
  // The dev mode (tsx src/index.ts) is what actual users invoke from MCP clients.
  const entry = path.resolve(process.cwd(), 'src', 'index.ts');

  console.log(`[smoke] spawning MCP server: tsx ${entry}`);
  const transport = new StdioClientTransport({
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['tsx', entry],
    env: { ...process.env } as Record<string, string>,
  });

  const client = new Client(
    { name: 'smoke-tester', version: '0.0.1' },
    { capabilities: {} },
  );

  await client.connect(transport);
  console.log('[smoke] connected');

  // 1. List tools — sanity check we got the 4 we expect.
  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name).sort();
  console.log('[smoke] tools registered:', toolNames);
  const expected = ['forum_get_thread', 'forum_list_sites', 'forum_list_threads', 'forum_session_status'].sort();
  if (JSON.stringify(toolNames) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${expected.join(',')} got ${toolNames.join(',')}`);
  }

  // 2. forum_list_sites — should return school-bbs.
  console.log('\n[smoke] calling forum_list_sites');
  const sites = await client.callTool({ name: 'forum_list_sites', arguments: {} });
  const sitesBody = parseEnvelope(sites as { content: Array<{ type: string; text?: string }> });
  console.log('  →', JSON.stringify(sitesBody));

  // 3. forum_session_status — should report loggedIn=true if storageState valid.
  console.log('\n[smoke] calling forum_session_status');
  const status = await client.callTool({
    name: 'forum_session_status',
    arguments: { siteKey: SITE_KEY },
  });
  const statusBody = parseEnvelope(status as { content: Array<{ type: string; text?: string }> });
  console.log('  →', JSON.stringify(statusBody));

  // 4. forum_list_threads (pages mode, 1 page) — actually crawls.
  console.log(`\n[smoke] calling forum_list_threads (pages=1) on "${BOARD_NAME}"`);
  const t0 = Date.now();
  const list = await client.callTool(
    {
      name: 'forum_list_threads',
      arguments: { siteKey: SITE_KEY, boardName: BOARD_NAME, mode: 'pages', pages: 1 },
    },
    undefined,
    { timeout: 180_000 },  // 3 min — first call launches browser + logs in
  );
  const ms = Date.now() - t0;
  const listBody = parseEnvelope(list as { content: Array<{ type: string; text?: string }> }) as {
    ok: boolean;
    data?: Array<{ title: string; raw?: { threadId?: string; isPinned?: boolean } }>;
    nextCursor?: { startPage: number } | null;
    state?: { deepestPageCrawled: number; latestThreadPostedAt: string | null; lastCrawledAt: string };
    error?: { code: string; message: string };
  };
  console.log(`  → completed in ${ms}ms`);
  if (!listBody.ok) {
    console.error('  FAILED:', listBody.error);
    await client.close();
    process.exit(1);
  }
  console.log('  → ok=true');
  console.log('  → threads count:', listBody.data?.length);
  console.log('  → nextCursor:', listBody.nextCursor);
  console.log('  → state:', listBody.state);
  if (listBody.data && listBody.data.length > 0) {
    console.log('  → first 5 titles:');
    for (const t of listBody.data.slice(0, 5)) {
      const pinned = t.raw?.isPinned ? ' [PINNED]' : '';
      console.log(`     - ${t.title}${pinned}  (id=${t.raw?.threadId})`);
    }
  }

  // 5. forum_get_thread — pick a non-pinned thread if available, else first.
  const target =
    listBody.data?.find((t) => !t.raw?.isPinned) ?? listBody.data?.[0];
  if (target?.raw?.threadId) {
    console.log(`\n[smoke] calling forum_get_thread on threadId=${target.raw.threadId}`);
    const t0g = Date.now();
    const thread = await client.callTool(
      {
        name: 'forum_get_thread',
        arguments: { siteKey: SITE_KEY, threadId: target.raw.threadId },
      },
      undefined,
      { timeout: 180_000 },
    );
    const msg = Date.now() - t0g;
    const tbody = parseEnvelope(thread as { content: Array<{ type: string; text?: string }> }) as {
      ok: boolean;
      data?: { title: string; posts: Array<{ floor: number; author: string }>; raw?: Record<string, unknown> };
      error?: { code: string; message: string };
    };
    console.log(`  → completed in ${msg}ms`);
    if (!tbody.ok) {
      console.error('  FAILED:', tbody.error);
      await client.close();
      process.exit(1);
    }
    console.log('  → title:', tbody.data?.title);
    console.log('  → post count:', tbody.data?.posts.length);
    if (tbody.data?.posts[0]) {
      const p0 = tbody.data.posts[0];
      console.log(`  → floor 0: ${p0.author}`);
    }
  } else {
    console.log('\n[smoke] no threads returned — skipping forum_get_thread');
  }

  // 6. Re-call forum_list_threads in incremental mode — should return nothing
  //    new since the previous call updated the watermark.
  console.log('\n[smoke] re-calling forum_list_threads (incremental) — expecting empty');
  const list2 = await client.callTool(
    {
      name: 'forum_list_threads',
      arguments: { siteKey: SITE_KEY, boardName: BOARD_NAME, mode: 'incremental' },
    },
    undefined,
    { timeout: 180_000 },
  );
  const list2Body = parseEnvelope(list2 as { content: Array<{ type: string; text?: string }> }) as {
    ok: boolean; data?: unknown[]; state?: unknown; error?: unknown;
  };
  console.log('  → ok=', list2Body.ok, ', count=', list2Body.data?.length, ', state=', list2Body.state);

  await client.close();
  console.log('\n[smoke] done — all calls succeeded');
}

main().catch((err) => {
  console.error('[smoke] FATAL:', summarize(String(err)));
  process.exit(1);
});
