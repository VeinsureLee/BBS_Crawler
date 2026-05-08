# BBS_Crawler

A Playwright-based MCP server that crawls forum posts and persists them to a local PostgreSQL database. Designed as the data-ingestion layer of the **BBS Agent of BYR** project.

> Status: **stable, production-ready** — full `school-bbs` lifecycle complete, 4 MCP tools working, all smoke tests passing. See [`Readme_ch.md`](Readme_ch.md) for the Chinese version.

## What it does

- Exposes 4 high-level MCP tools (`forum_list_sites`, `forum_list_threads`, `forum_get_thread`, `forum_session_status`) so a custom agent can crawl forum content on demand.
- Drives a real Chromium browser via Playwright so login-gated pages are reachable.
- Persists login sessions via Playwright `storageState` — the agent never re-submits credentials on every call.
- Optional encrypted local credential cache (AES-256-GCM) so cookies-expiry doesn't force a manual re-login when the user opted into "remember password".
- Always upserts crawled content to the embedded PGlite database. Single-table `threads` with `is_pinned` flag separates init-time pinned threads from on-demand crawled threads; `board_crawl_state` tracks per-board crawl progress so the agent can incrementally pull only what's new.
- Downstream query / RAG / embeddings live in the [`BBS_Database`](https://github.com/VeinsureLee/BBS_Database) project — this MCP only crawls and persists.
- Pluggable site adapters: ships with a `school-bbs` adapter; new sites are added by dropping a file under `src/adapters/<site>/`.

## How it fits the ecosystem

| Repo | Role |
|---|---|
| [`BBS_Crawler`](https://github.com/VeinsureLee/BBS_Crawler) (this repo) | Browser-driven crawler + MCP server; writes Postgres |
| [`BBS_Database`](https://github.com/VeinsureLee/BBS_Database) | Storage stack: PostgreSQL (raw) + Chroma (embeddings) + Neo4j (relations) |
| [`BBS_Agent`](https://github.com/VeinsureLee/BBS_Agent) | Multi-Index RAG agent that consumes the MCP and queries the database |

This crawler **owns** the PostgreSQL schema for forum content. `BBS_Database` reads the same Postgres to build embeddings / graph indexes downstream.

## Tech stack

- TypeScript (Node 20+)
- [Playwright](https://playwright.dev/) (Chromium only)
- [PGlite](https://pglite.dev/) (embedded PostgreSQL, no external DB required)
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) for MCP transport (stdio)
- `zod` for env / input validation, `pino` for structured logging

## Quick start

```bash
# 1. install
npm install
npx playwright install chromium

# 2. configure
cp .env.example .env
# fill in SCHOOL_BBS_USERNAME, SCHOOL_BBS_PASSWORD, SCHOOL_BBS_BASE_URL
# (PGDATA_DIR is optional, defaults to ./.pgdata)

# 3. first-time login (saves storageState; prompts whether to remember password)
npm run login school-bbs

# 4. initialize forum structure (run once)
npm run init:sections school-bbs
npm run init:boards school-bbs
npm run init:pinned school-bbs

# 5. run as MCP server (stdio)
# Recommend `npm run dev` (uses tsx) for daily use; `npm run start` (node dist) requires a build first
npm run dev

# Optional: run end-to-end smoke test to verify everything works
npx tsx scripts/debug/smoke-mcp.ts
```

The login flow asks `Remember password? (y/N)`. Choosing `y` writes encrypted credentials to `./.state/<siteKey>.credentials.enc` (AES-256-GCM, mode 0600). When cookies later expire, the auth manager auto-relogins from the cached credentials and the agent never sees a `SESSION_EXPIRED`. Choosing `N` keeps cookies-only mode — re-run `npm run login` whenever the session lapses.

To plug into a Claude Code / Claude Desktop / custom agent, register the binary as a stdio MCP server. Example `claude_desktop_config.json` snippet:

```json
{
  "mcpServers": {
    "bbs-crawler": {
      "command": "node",
      "args": ["d:/MyProject/Python_Project/BBS_Crawler/dist/index.js"],
      "env": {
        "SCHOOL_BBS_USERNAME": "...",
        "SCHOOL_BBS_PASSWORD": "...",
        "SCHOOL_BBS_BASE_URL": "..."
      }
    }
  }
}
```

## MCP tools

| Tool | Purpose |
|---|---|
| `forum_list_sites` | Discover which adapters are registered |
| `forum_list_threads` | Crawl threads from a board by exact name (incremental or paged) |
| `forum_get_thread` | Fetch a single thread including all replies |
| `forum_session_status` | Inspect login state for a site |

`forum_search`, `forum_query_cache`, and `forum_relogin` were removed — search/cache reads are the responsibility of [`BBS_Database`](https://github.com/VeinsureLee/BBS_Database); re-login happens automatically when the credential store has cached credentials.

### Response envelope

All four tools return a uniform JSON envelope (serialized as a single MCP `text` content part):

```jsonc
// success
{
  "ok": true,
  "data": <tool-specific payload>,
  "nextCursor": { "startPage": 4 } | null,   // forum_list_threads only
  "state": {                                  // forum_list_threads only
    "deepestPageCrawled": 12,
    "latestThreadPostedAt": "2026-05-08T03:14:00Z",
    "lastCrawledAt": "2026-05-08T10:23:00Z"
  }
}

// failure
{
  "ok": false,
  "error": { "code": "SESSION_EXPIRED" | "LOGIN_FAILED" | "BOARD_NOT_FOUND" | "FETCH_FAILED",
             "message": "..." }
}
```

`nextCursor` and `state` are omitted on tools that don't produce them.

### `forum_list_threads`

```ts
forum_list_threads({
  siteKey: string,
  boardName: string,                       // strict equality match against boards.name
  mode?: 'incremental' | 'pages',          // default: 'incremental'
  pages?: number,                          // 'pages' mode; default 3
  cursor?: { startPage: number }           // 'pages' mode continuation
})
```

- **`incremental`** (default): start at page 1, stop when a thread's `posted_at` is `<=` the stored watermark. Pinned threads do NOT trigger the stop and do NOT advance the watermark (their dates are arbitrary). Best for "what's new since last time".
- **`pages`**: crawl exactly `pages` pages starting at `cursor.startPage` (default 1). Returns `nextCursor` so the agent can keep paging back through history. Best for finding older threads.

Each result row carries `raw.threadId` of the form `"{boardKey}/{articleId}"` — pass that opaque string back to `forum_get_thread`.

### `forum_get_thread`

```ts
forum_get_thread({ siteKey: string, threadId: string })   // threadId = "{boardKey}/{articleId}"
```

## Configuration

All secrets live in environment variables. The headline ones:

| Var | Purpose |
|---|---|
| `PGDATA_DIR` | Path for PGlite storage directory (default: `./.pgdata`) |
| `{SITE_KEY_UPPER}_USERNAME` / `_PASSWORD` / `_BASE_URL` | Per-site credentials and base URL, e.g. `SCHOOL_BBS_USERNAME` |
| `BROWSER_HEADLESS` | `false` for visual debugging (default `true`) |
| `RATE_MIN_INTERVAL_MS` / `RATE_JITTER_MS` / `RATE_MAX_CONCURRENCY` | Per-site politeness knobs (defaults: 1500 / 1000 / 1) |
| `STORAGE_STATE_DIR` | Where `storageState.json` and `*.credentials.enc` files live (default `./.state`) |
| `CRED_KEY` | Optional. Stable secret used to derive the AES key for credential storage. Defaults to a hostname-bound seed when unset (sufficient for single-machine use). |
| `LOG_LEVEL` | `debug` enables failure screenshots under `./.state/debug/` |

`.env` and `./.state/` are gitignored. Only `.env.example` is committed.

## Adding a new site

1. Create `src/adapters/<site-key>/index.ts` exporting an object that satisfies `SiteAdapter` (see [`src/core/site-adapter.ts`](src/core/site-adapter.ts)).
2. Implement `isLoggedIn`, `login`, `listThreads`, `getThread`, `search`. Helpers go in sibling files (`selectors.ts`, `login.ts`, ...).
3. Add a `import './<site-key>'` in [`src/adapters/index.ts`](src/adapters/index.ts) for side-effect registration.
4. Add HTML fixtures under `tests/fixtures/<site-key>/` and an integration test.
5. Document required env vars (`<SITE_KEY_UPPER>_USERNAME`, etc.) in `.env.example`.

The framework provides browser pooling, session persistence, rate limiting, retries, and DB persistence — adapters only convert page content into the structured `Thread` / `ThreadSummary` types.

## Project layout

```
src/
  server/            MCP tool registration + JSON Schemas
  core/              orchestration: registry, crawler-service, auth, browser pool, rate limiter
  repository/        all SQL (no ORM)
  adapters/          one folder per site
migrations/          node-pg-migrate SQL files
tests/fixtures/      redacted HTML snapshots driving adapter integration tests
scripts/             one-shot CLI helpers (login-once, inspect)
```

## Scripts

### Authentication scripts

| Script | Purpose | Usage |
|---|---|---|
| `login` | Perform interactive login and save storageState | `npm run login [siteKey]` |
| `login:once` | Non-interactive login (requires env vars set) | `npm run login:once [siteKey]` |

### Initialization scripts (for school-bbs)

Run these in order to explore and persist the forum structure:

| Script | Purpose | Usage |
|---|---|---|
| `init:sections` | Crawl top-level sections from homepage and persist to DB | `npm run init:sections [siteKey]` |
| `init:boards` | For each section, crawl its subsections and boards and persist to DB | `npm run init:boards [siteKey]` |
| `init:pinned` | For each board, discover pinned threads and crawl them with replies | `npm run init:pinned [siteKey] [--limit N] [--concurrency K] [--skip-done]` |

Note: `init:pinned` has smart retry handling: boards that fail during concurrent crawl are retried sequentially (concurrency=1) in up to 3 retry passes.

### Crawling scripts

| Script | Purpose | Usage |
|---|---|---|
| `crawl:board` | Crawl a specific board page and save raw HTML for inspection | `npx tsx scripts/crawl/crawl-board.ts <boardPath>` |
| `crawl:section` | Crawl a specific section page and save raw HTML for inspection | `npx tsx scripts/crawl/crawl-section.ts <sectionPath>` |
| `crawl:pinned` | Crawl pinned threads from a board and save raw HTMLs | `npx tsx scripts/crawl/crawl-pinned.ts <boardKey>` |
| `crawl:board-skip` | Crawl a board with skip logic (custom behavior) | `npx tsx scripts/crawl/crawl-board-with-skip.ts` |

### Debug scripts

| Script | Purpose | Usage |
|---|---|---|
| `debug:board` | Debug a specific board page interactively | `npx tsx scripts/debug/debug-board.ts` |
| `debug:failed-boards` | Explore boards that failed during crawl | `npx tsx scripts/debug/explore-failed-boards.ts` |
| `debug:find-thread` | Find and inspect a specific thread | `npx tsx scripts/debug/find-thread.ts` |
| `debug:inspect` | Inspect the forum interactively | `npx tsx scripts/debug/inspect-forum.ts` |
| `explore` | General exploration utility | `npx tsx scripts/util/explore.ts` |

### Database scripts

| Script | Purpose | Usage |
|---|---|---|
| `db:check` | Verify database connection and schema | `npm run db:check` |
| `db:migrate:up` | Run pending database migrations | `npm run db:migrate:up` |
| `db:migrate:down` | Roll back last migration | `npm run db:migrate:down` |
| `db:migrate:status` | Show migration status | `npm run db:migrate:status` |
| `db:delete-pinned` | Delete pinned thread records (for re-crawl) | `npm run db:delete-pinned` |

### Utility scripts

| Script | Purpose | Usage |
|---|---|---|
| `format:html` | Format raw HTML files for readability | `npx tsx scripts/util/format-html.ts <file.html>` |

## Roadmap

Already landed:

- Login + session persistence via `storageState.json`
- Encrypted "remember password" credential cache + auto-relogin
- Forum structure crawling (sections / boards / pinned threads)
- `forum_list_threads` with `incremental` / `pages` modes and per-board crawl-state tracking
- `forum_get_thread` by composite `{boardKey}/{articleId}` id
- 4 stable error codes (`SESSION_EXPIRED` / `LOGIN_FAILED` / `BOARD_NOT_FOUND` / `FETCH_FAILED`)
- **Auto-init on first MCP tool call** (no manual `npm run init:*` required)
- Expanded date parser for `school-bbs` (handles `MM-DD`, `HH:MM`, `今天/昨天/前天`, `N天前`)
- Fixed: storageState path alignment, pinned thread detection, date parsing (smoke test bugs)

Next up:

- Restore the unit test suite for `tests/unit/repository/**` (currently excluded after the PGlite migration)

Out of scope for v1 (deferred): CAPTCHA / SSO / 2FA login, low-level `browser_*` MCP tools, additional site adapters beyond `school-bbs`, Chinese tokenizer FTS, background scheduler, multi-worker deployment, in-MCP search / cache-read tools (handled by `BBS_Database`).

## Privacy

- No URLs, usernames, or passwords are committed to source. `.env` is gitignored.
- Logger redacts known credentials at write time.
- `storageState.json` (cookies) is permissioned 0600 (best-effort on Windows) and stays out of git.

## License

TBD.
