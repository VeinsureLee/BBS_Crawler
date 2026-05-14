# BBS_Crawler

A Playwright-based forum crawler that persists posts into a layered SQLite store and exposes a TypeScript library for downstream consumers. The data-ingestion layer of the **BBS Agent of BYR** project.

> Status: **Phase 3 landed + thread-table split** — layered per-forum SQLite storage with separate `pinned_*` / `plain_*` tables, config-driven init, recursive node tree, hardened init pipeline. `school-bbs` adapter is complete. See [`Readme_ch.md`](Readme_ch.md) for the Chinese version.

> This project is **not an MCP service**. It's a TypeScript library + CLI scripts. The MCP server lives in a separate downstream project that imports this as a dependency. See [`.shadow/README.md`](.shadow/README.md) for the project's design rationale.

## What it does

- Crawls forum content (sections / boards / pinned threads / regular threads / posts) via Playwright Chromium.
- Persists everything into a **layered SQLite** layout: a single `structure.db` carrying the recursive node tree, plus one `forums/<key>.db` per top-level discussion area.
- Auto-applies schema on first open — no separate migration framework for fresh installs.
- Pluggable site adapters: ships with a `school-bbs` adapter; new sites are added by dropping a folder under `src/adapters/<site>/` plus a YAML config.
- **Config-driven init**: top-level forums and node shapes are declared in `config/sites/<siteKey>.entries.yml` and `<siteKey>.node-types.yml` — the homepage HTML is no longer the source of truth.
- Login flow with `storageState` persistence + optional encrypted credential cache (AES-256-GCM) so cookie expiry never forces a manual re-login.
- Per-board incremental crawl state (`board_crawl_state.last_thread_posted_at` watermark) so consumers only fetch what's new.
- Structured logging via pino multistream (stdout + daily-rotated `.logs/app/app-<date>.log`). Long-running scripts like `init:threads` render their own in-place TUI and silence pino's stdout sink (file log is unaffected).

## What it doesn't do

- **Not an MCP service** — that's a downstream project's job.
- No full-text search — `search.ts` was removed; the downstream RAG / search project owns that.
- No browser-level low-level tools.

## How it fits the ecosystem

| Repo | Role |
|---|---|
| **`BBS_Crawler` (this repo)** | Browser-driven crawler + layered SQLite store + TS library |
| `BBS_Database` | Storage stack: SQLite (raw) + Chroma (embeddings) + Neo4j (relations) |
| `BBS_Agent` | Multi-Index RAG agent that consumes the MCP layer (separate repo) |

This crawler **owns** the layered SQLite schema. Downstream consumers query the same files (read-only) to build embeddings / graph indexes.

## Tech stack

- TypeScript (Node 20+)
- [Playwright](https://playwright.dev/) (Chromium only)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (synchronous embedded SQLite, WAL mode)
- [js-yaml](https://github.com/nodeca/js-yaml) + [zod](https://zod.dev/) for config loading and validation
- [pino](https://getpino.io/) for structured logging (stdout + file sink)

## Quick start

```bash
# 1. install
npm install
npx playwright install chromium

# 2. configure
cp .env.example .env
# fill in SCHOOL_BBS_USERNAME / SCHOOL_BBS_PASSWORD / SCHOOL_BBS_BASE_URL
# DATABASE_PATH defaults to ./.data

# 3. first-time login (saves storageState; prompts whether to remember password)
npm run login

# 4. initialize forum structure
npm run init:sections                          # top-level forums (entries.yml first, fallback to homepage)
npm run init:boards                            # boards + sub-forums
npm run init:threads -- --concurrency 8        # pinned threads (default). use 8 (not the default 16) to be safe on chrome memory
# or, also crawl the first page of non-pinned threads in one pass:
npm run init:threads -- --concurrency 8 --with-plain

# 5. (optional) watch live progress in another terminal
npm run tail:progress
```

`tail:progress` follows the latest `.logs/app/app-<date>.log`, filters
`progress.tick` / `progress.final` lines, and renders a multi-line block
(summary + per-forum breakdown) that **refreshes in place** when the
terminal is a TTY (ANSI cursor-up + clear). When piped to a file or
non-TTY pipe, it falls back to plain line-mode. Auto-handles day
rollover. No PowerShell `Select-String` / `ConvertFrom-Json` quirks.

After step 4 your data layout looks like:

```
.data/
  structure.db              sites + nodes (recursive tree) + fetch_log
  forums/
    本站站务.db                pinned_threads + pinned_posts
                            + plain_threads  + plain_posts
                            + board_crawl_state + daily_traffic
    校园生活.db
    学术科技.db
    ...
```

Each forum db keeps pinned (sticky) threads and plain (regular) threads in
separate tables. A given URL lives in exactly one of them — when a thread's
sticky status flips between crawls, the upsert path deletes the row from
the opposite table (cascading its posts) before writing the new row.

The `npm run login` flow asks `Remember password? (y/N)`. Choosing `y` writes encrypted credentials to `./.state/<siteKey>.credentials.enc` (AES-256-GCM, mode 0600). When cookies later expire, the AuthManager auto-relogins from the cache.

## Library API

The project is consumed as a TypeScript library. Public surface in [`src/index.ts`](src/index.ts):

| Group | Exports |
|---|---|
| **Database** | `initDb`, `getStructureDb`, `getForumDb`, `closeAllDbs`, `STRUCTURE_SCHEMA`, `FORUM_SCHEMA` |
| **Sites / nodes** | `upsertSite`, `upsertSection`, `hasSections`, `listTopLevelSections`, `sectionsMissingBoards` |
| **Boards** | `upsertBoard`, `listBoards`, `boardsMissingPinned`, `findBoardByName`, `getBoardById`, `resolveBoardRoute`, `findForumDbFileForBoard` |
| **Threads / posts** | `upsertPinnedThread`, `upsertPlainThread`, `upsertPinnedThreadSummary`, `upsertPlainThreadSummary`, `upsertPinnedPosts`, `upsertPlainPosts`, `checkThreadExists`, `getCrawledThreadUrls`, `shouldSkipFetch` (all kind-aware) |
| **Crawl orchestration** | `CrawlerService`, `InitOrchestrator`, `runInitSections` / `runInitBoards` / `runInitPinned`, `BrowserPool`, `AuthManager`, `createRateLimiter` |
| **Audit / state** | `appendFetchLog`, `getBoardCrawlState`, `upsertBoardCrawlState` |
| **Adapter** | `getAdapter`, `listAdapters` |
| **Util** | `logger`, `addRedactedSecret`, `appLogPath`, `retry`, `parseConfig` |
| **Errors** | `BaseAppError`, `MissingCredentialsError`, `LoginFailedError`, `SessionExpiredError`, `NavigationTimeoutError`, `RateLimitedError`, `BoardNotFoundError`, `FetchFailedError`, `DatabaseError`, `UnknownSiteError` |

Typical flow for a downstream MCP-style consumer:

```typescript
import {
  initDb, parseConfig, BrowserPool, AuthManager, createRateLimiter,
  CrawlerService, getAdapter,
  upsertPlainThread, upsertPlainPosts, appendFetchLog,
} from 'bbs-crawler';
import 'bbs-crawler/dist/adapters';   // side-effect: register adapters

const cfg = parseConfig(process.env);
initDb({ dataDir: cfg.dataDir });

const crawler = new CrawlerService({
  rateLimiter: createRateLimiter({ /* ... */ }),
  browserPool: new BrowserPool({ /* ... */ }),
  auth: new AuthManager({ /* ... */ }),
  registry: { getAdapter },
  // Plain (non-pinned) threads. For pinned threads, swap in
  // upsertPinnedThread / upsertPinnedPosts.
  persistThread: async (siteKey, thread) => {
    const { threadId, forumDb } = await upsertPlainThread(siteKey, thread);
    await upsertPlainPosts(forumDb, threadId, thread.posts);
    return threadId;
  },
  appendFetchLog,
});

const result = await crawler.listThreadsByName({
  siteKey: 'school-bbs',
  boardName: '北邮人在上海',
  mode: 'incremental',
});
```

## Configuration

All secrets in `.env` (gitignored). All forum-structure config in `config/sites/`.

| Env var | Default | Purpose |
|---|---|---|
| `{SITE_KEY}_USERNAME` / `_PASSWORD` / `_BASE_URL` / `_LOGIN_URL` | — | Per-site credentials. e.g. `SCHOOL_BBS_USERNAME` |
| `DATABASE_PATH` | `./.data` | Root for `structure.db` + `forums/` |
| `LOG_DIR` | `./.logs` | pino file sink root |
| `LOG_LEVEL` | `info` | `debug` for verbose |
| `LOG_FILE_DISABLED` | `false` | Set `true` to skip file sink (auto-disabled under `NODE_ENV=test`) |
| `LOG_STDOUT_DISABLED` | `false` | Set `true` to silence pino's stdout sink. `init:threads` flips this on automatically so its TUI has the terminal to itself; you generally don't need to set it manually |
| `BROWSER_HEADLESS` | `true` | `false` to watch Chrome live |
| `BROWSER_EXECUTABLE_PATH` | (Playwright bundled) | Pin to your local Chrome binary |
| `BROWSER_USER_AGENT` | (default) | Override UA string |
| `STORAGE_STATE_DIR` | `./.state` | Where `<siteKey>.json` (cookies) and `*.credentials.enc` live |
| `IDLE_TIMEOUT_MS` | `300000` | Auto-close browser after N ms idle |
| `RATE_MIN_INTERVAL_MS` / `RATE_JITTER_MS` / `RATE_MAX_CONCURRENCY` | `1500` / `1000` / `1` | Rate limiter knobs |
| `CRED_KEY` | hostname-derived | AES key for credential cache |
| `SITE_CONFIG_DIR` | `./config/sites` | Override config dir (used by tests) |

Per-site YAML lives under `config/sites/`:

| File | Purpose |
|---|---|
| `<siteKey>.yml` | Selectors, route templates, crawl parameters (intervals, concurrency, retries) |
| `<siteKey>.entries.yml` | Top-level forum list — `init:sections` reads this first; falls back to homepage crawl when missing/empty |
| `<siteKey>.node-types.yml` | Node shape declarations: `forum` / `sub_forum` / `board` / `thread` + `childTypes` relationships |

`.env`, `./.state/`, `./.data/`, and `./.logs/` are all gitignored. Only `.env.example` is committed.

## Scripts

### Auth
| Script | Purpose |
|---|---|
| `npm run login [siteKey]` | Interactive login + save `storageState`; optionally encrypt-store credentials |
| `npm run login:once [siteKey]` | Non-interactive (env-only) login |

### Init pipeline
| Script | Purpose |
|---|---|
| `npm run init:sections [siteKey]` | Persist top-level forums (`entries.yml` first, falls back to homepage) |
| `npm run init:boards [siteKey]` | Recursively crawl each forum's section + board structure (cycle-safe) |
| `npm run init:threads [siteKey] [--concurrency N] [--limit N] [--with-plain] [--skip-done] [--verbose]` | Crawl pinned threads (default). `--with-plain` also crawls page 1 of non-pinned threads (each thread truncated to its first page). Terminal shows an in-place refreshing progress block; `--verbose` adds a scrolling per-board event log above. File logs always contain full per-step detail. |
| `npm run init` | Run all three sequentially (pinned only — pass `--with-plain` to init:threads manually for plain coverage) |
| `npm run init:export [siteKey] [outputPath]` | Export forum structure to JSON |

### Crawl
| Script | Purpose |
|---|---|
| `npm run crawl:board <boardPath>` | Save raw HTML of one board page (exploration helper) |
| `npm run crawl:section <sectionPath>` | Save raw HTML of one section page |
| `npm run crawl:pinned <boardKey>` | Save raw HTMLs of all pinned threads of a board |
| `npm run crawl:board-skip <boardKey> [freshnessHours]` | Production-style: list + fetch threads, skipping recent ones via `shouldSkipFetch` |

### Database
| Script | Purpose |
|---|---|
| `npm run db:check [siteKey]` | Health check: list tables in `structure.db` + every `forums/*.db` with row counts |
| `npm run db:migrate:split-threads -- [--dry-run] [--data-dir ./.data] [--yes]` | One-shot migration from the single `threads` + `posts` tables to the split `pinned_threads` / `pinned_posts` / `plain_threads` / `plain_posts` layout. Backs up each `forums/*.db` to `<file>.bak` before rewriting. Idempotent. |

### Debug
| Script | Purpose |
|---|---|
| `npm run debug:board <boardKey>` | Open the board page with **headed** Chrome for visual inspection |
| `npm run debug:failed-boards` | List boards that recently failed |
| `npx tsx scripts/debug/check-cycles.ts` | Diagnose cycles in `nodes.parent_id` (corruption check) |
| `npx tsx scripts/debug/smoke-precheck.ts` | Quick env + DB sanity check |

### Util
| Script | Purpose |
|---|---|
| `npm run explore` | General exploration utility |
| `npm run format:html <file>` | Pretty-print raw HTML for offline analysis |
| `npm run tail:progress` | Follow the latest app log and render `progress.tick` / `progress.final` as a multi-line block that refreshes in place (ANSI cursor-up). Non-TTY pipes fall back to line-mode. |

## Adding a new site

1. Add env vars to `.env`: `<SITE_KEY_UPPER>_USERNAME` / `_PASSWORD` / `_BASE_URL` / `_LOGIN_URL`.
2. Create `config/sites/<siteKey>.yml` (selectors / routes / crawl knobs — copy from `school-bbs.yml`).
3. (Optional but recommended) `<siteKey>.entries.yml` and `<siteKey>.node-types.yml`.
4. Implement `src/adapters/<siteKey>/index.ts` satisfying [`SiteAdapter`](src/core/site-adapter.ts); call `register(adapter)` at module level.
5. Add `import './<siteKey>'` to [`src/adapters/index.ts`](src/adapters/index.ts).
6. Run `npm run init:sections <siteKey>` etc.

The framework already provides browser pooling, session persistence, rate limiting, retries, and DB persistence. Adapters only convert page DOM into the structured `Thread` / `ThreadSummary` types.

## Project layout

```
src/
  core/                browser-pool, rate-limiter, auth-manager, init-orchestrator/runners,
                       crawler-service, registry, site-adapter, site-config, errors
  repository/          per-table SQL access; layered storage routing
  adapters/            one folder per site (currently school-bbs only)
  util/                logger, retry
  index.ts             public library entry
config/
  sites/               per-site YAML config
scripts/
  auth/                do-login, login-once
  init/                init-sections, init-boards, init-threads, init-ui (TUI), export-structure
  crawl/               crawl-board, crawl-section, crawl-pinned, crawl-board-with-skip,
                       crawl-forum-structure
  db/                  check-db, migrate-split-threads
  debug/               debug-board, explore-failed-boards, smoke-precheck, check-cycles, ...
  util/                explore, format-html, tail-progress
tests/
  unit/                vitest suites for core, repository, util, adapter
.shadow/               Chinese design documentation (architecture, modules, workflows)
```

## Documentation

In-depth design docs in [`.shadow/`](.shadow/) (Chinese, accessible to non-developers):

- [`README.md`](.shadow/README.md) — project orientation
- [`数据库.md`](.shadow/数据库.md) — layered SQLite design, schema, migration plan
- [`配置文件.md`](.shadow/配置文件.md) — three YAML config files and their roles
- [`工作流程/01-初始化.md`](.shadow/工作流程/01-初始化.md) — init pipeline
- [`工作流程/02-爬取版面帖子.md`](.shadow/工作流程/02-爬取版面帖子.md) — crawl-board workflow
- [`模块/`](.shadow/模块/) — per-module specs (crawler, browser/session, db access, config loading, rate limiting, retry, logging, metadata CRUD)

## Roadmap

Done (Phase 1–3 + split):
- pino multistream + daily-rotated app log + redaction (`LOG_STDOUT_DISABLED` lets long-running CLIs silence stdout without touching the file sink)
- Config-driven init via `entries.yml` + `node-types.yml`
- Layered SQLite storage (per-forum `.db`), nodes recursive tree, auto-applied schema, depth-bounded cycle-safe CTE walks
- Split `threads` → `pinned_threads` / `plain_threads` (and matching `*_posts`); cross-table move on identity flip. Migration script `db:migrate:split-threads`.
- Merged `init:pinned` + `init:plain` into `init:threads` (default pinned-only; `--with-plain` adds page-1 non-pinned crawl)
- `init:threads` has a dedicated TUI: in-place refreshing progress block + per-forum table; `--verbose` adds a scrolling per-board event log. Per-thread errors are caught and skipped so one bad URL no longer fails the whole board.
- Per-forum progress reporter (every 5s, also emitted to file log so `tail:progress` works in another window), browser-dead detection + graceful exit, `--skip-done` resume, strict CLI parsing
- `init-boards` cycle protection: `visited` set + skip-self-children
- Cross-platform `tail:progress` (replaces the brittle PowerShell `Select-String` / `ConvertFrom-Json` one-liner)
- Removed dead pg-mem tests, `search.ts`, legacy migration framework

Out of scope for this repo (lives elsewhere):
- MCP server (separate downstream project that imports this as a library)
- Full-text / vector search and RAG
- More site adapters beyond `school-bbs`
- Background scheduler / multi-machine deployment

## Privacy

- `.env`, `./.state/`, `./.logs/`, `./.data/` are gitignored
- pino logger automatically redacts strings registered via `addRedactedSecret(...)` — `AuthManager` registers credentials at first-login time
- Credential cache uses AES-256-GCM with a hostname-derived key by default; pin via `CRED_KEY` for portability between machines
- `storageState.json` (cookies) is permissioned 0600 (best-effort on Windows)

## License

TBD.
