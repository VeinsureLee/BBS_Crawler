# BBS_Crawler

A Playwright-based MCP server that crawls forum posts and persists them to a local PostgreSQL database. Designed as the data-ingestion layer of the **BBS Agent of BYR** project.

> Status: early development — framework scaffolding in progress, no site adapter shipped yet. See [`Readme_ch.md`](Readme_ch.md) for the Chinese version.

## What it does

- Exposes a small set of high-level MCP tools (`forum_search`, `forum_list_threads`, `forum_get_thread`, ...) so a custom agent can crawl forum content on demand.
- Drives a real Chromium browser via Playwright so login-gated pages are reachable.
- Persists login sessions via Playwright `storageState` — the agent never re-submits credentials on every call.
- Optionally writes crawled content to PostgreSQL (`persist: true`) for later RAG / batch use.
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
- PostgreSQL 14+
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) for MCP transport (stdio)
- `pg` + `node-pg-migrate` (no ORM)
- `zod` for env / input validation, `pino` for structured logging

## Quick start

> Implementation is incomplete. The commands below are the target shape; expect some to land progressively as the implementation plan is executed.

```bash
# 1. install
npm install
npx playwright install chromium

# 2. configure
cp .env.example .env
# fill in DATABASE_URL, SCHOOL_BBS_USERNAME, SCHOOL_BBS_PASSWORD

# 3. migrate
npm run migrate:up

# 4. run as MCP server (stdio)
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
        "DATABASE_URL": "postgres://crawler:***@localhost:5432/bbs_crawler",
        "SCHOOL_BBS_USERNAME": "...",
        "SCHOOL_BBS_PASSWORD": "..."
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
| `DATABASE_URL` | PostgreSQL connection (required) |
| `{SITE_KEY_UPPER}_USERNAME` / `_PASSWORD` | Per-site credentials, e.g. `SCHOOL_BBS_USERNAME` |
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
