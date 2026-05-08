# BBS_Crawler

A Playwright-based MCP server that crawls forum posts and persists them to a local PostgreSQL database. Designed as the data-ingestion layer of the **BBS Agent of BYR** project.

> Status: active development — framework complete with PGlite storage, `school-bbs` adapter partially implemented (sections/boards/pinned threads crawling works, listThreads/search TBD). See [`Readme_ch.md`](Readme_ch.md) for the Chinese version.

## What it does

- Exposes a small set of high-level MCP tools (`forum_search`, `forum_list_threads`, `forum_get_thread`, ...) so a custom agent can crawl forum content on demand.
- Drives a real Chromium browser via Playwright so login-gated pages are reachable.
- Persists login sessions via Playwright `storageState` — the agent never re-submits credentials on every call.
- Optionally writes crawled content to embedded PGlite database (`persist: true`) for later RAG / batch use.
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
# (DATABASE_URL is optional, defaults to local PGlite in ./.pglite)

# 3. first-time login (saves storage state)
npm run login school-bbs

# 4. initialize DB structure (optional, for full-site crawling)
npm run init:sections school-bbs
npm run init:boards school-bbs
npm run init:pinned school-bbs

# 5. run as MCP server (stdio)
npm run start
```

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
| `forum_search` | Keyword search on a site |
| `forum_list_threads` | Paginated board listing |
| `forum_get_thread` | Fetch a single thread (with replies) |
| `forum_query_cache` | Read-only keyword search over already-persisted content (no browser) |
| `forum_session_status` | Inspect login state for a site |
| `forum_relogin` | Force-rerun the login flow |

Site-scoped tools take a `siteKey` (e.g. `"school-bbs"`). All tools return structured JSON with `siteKey` + `fetchedAt` for freshness reasoning. The data flow has three paths: real-time fetch, fetch + persist (with `persist: true`), and cache-only via `forum_query_cache`.

## Configuration

All secrets live in environment variables. The headline ones:

| Var | Purpose |
|---|---|
| `PGDATA` | Path for PGlite storage directory (default: `./.pglite`) |
| `{SITE_KEY_UPPER}_USERNAME` / `_PASSWORD` / `_BASE_URL` | Per-site credentials and base URL, e.g. `SCHOOL_BBS_USERNAME` |
| `BROWSER_HEADLESS` | `false` for visual debugging (default `true`) |
| `RATE_MIN_INTERVAL_MS` / `RATE_JITTER_MS` / `RATE_MAX_CONCURRENCY` | Per-site politeness knobs (defaults: 1500 / 1000 / 1) |
| `STORAGE_STATE_DIR` | Where Playwright `storageState.json` files are kept (default `./.state`) |
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

## Roadmap (live)

Tracked in GitHub issues:

- [#1 Investigate forum page structure and authentication](https://github.com/VeinsureLee/BBS_Crawler/issues/1)
- [#2 Implement browser-based login and session persistence](https://github.com/VeinsureLee/BBS_Crawler/issues/2)
- [#3 Implement post list and content crawling](https://github.com/VeinsureLee/BBS_Crawler/issues/3)

Out of scope for v1 (deferred): CAPTCHA / SSO / 2FA login, low-level `browser_*` MCP tools, additional site adapters beyond `school-bbs`, Chinese tokenizer FTS, background scheduler, multi-worker deployment.

## Privacy

- No URLs, usernames, or passwords are committed to source. `.env` is gitignored.
- Logger redacts known credentials at write time.
- `storageState.json` (cookies) is permissioned 0600 (best-effort on Windows) and stays out of git.

## License

TBD.
