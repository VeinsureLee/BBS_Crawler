# bbs-crawler

Playwright + layered-SQLite BBS crawler. Embeddable component of
`bbs-mcp`; also runnable standalone via `npm run init:*` / `crawl:*`
CLI scripts.

## Requirements

- **Node.js ≥ 20** (LTS 20 / 22 recommended; 24 supported).
- Native dep `better-sqlite3` (`^12`) ships prebuilt binaries for
  Node 20/22/24 × win/mac/linux × x64/arm64 — `npm install` normally
  downloads them with no local compile.
- If your platform/Node combo has no prebuilt, npm falls back to source
  build, which needs **Python 3** + a C/C++ toolchain (Windows: Visual
  Studio Build Tools with "Desktop development with C++"). Re-install
  or `npm rebuild better-sqlite3` after the toolchain is in place.

## What it does

| Capability | CLI command |
|---|---|
| Login + save browser session | `npm run login` |
| Non-interactive login (env-driven) | `npm run login:once` |
| Init top-level forum sections | `npm run init:sections` |
| Init boards + sub-sections | `npm run init:boards` |
| Init pinned threads (default); `--with-plain` also fetches first-page plain threads | `npm run init:threads` |
| All three in order | `npm run init` |
| Export forum structure to JSON | `npm run init:export` |
| Refresh per-board traffic stats | `npm run refresh:stats` |
| Crawl one thread by id | `npm run crawl:thread -- --id <boardKey>/<articleId>` |
| Crawl one thread by url | `npm run crawl:thread -- --url <url>` |
| DB health check | `npm run db:check` |

## Quick start

```bash
# 1. Install
npm install
npx playwright install chromium

# 2. Configure
cp .env.example .env
# fill SCHOOL_BBS_USERNAME / SCHOOL_BBS_PASSWORD / SCHOOL_BBS_BASE_URL

# 3. Login (saves session to STORAGE_STATE_DIR, default .state/)
npm run login

# 4. Bootstrap forum structure
npm run init
# To also pull first-page plain threads:
npm run init:threads -- --with-plain
```

## Embedding

Path resolution precedence: **explicit arg > env var > auto-discover**.

- `.env` — set `BBS_ENV_FILE` to override; otherwise reads only the
  in-package `BBS_Crawler/.env` (does NOT walk parent dirs; the
  embedder is responsible for writing this file).
- `config/sites` — `SITE_CONFIG_DIR` overrides; otherwise bundled.
- Data dir — `DATABASE_PATH` overrides; otherwise `<.env dir>/data`.

`createCrawler()` is the single entry:

```ts
import { createCrawler } from 'bbs-crawler';

const crawler = await createCrawler({
  envFile?: string,
  dataDir?: string,
  siteConfigDir?: string,
  siteKey?: string,         // default 'school-bbs'
  idleTimeoutMs?: number,   // 0 = never auto-close browser
});

// crawler.service          — CrawlerService (fetch / list / etc.)
// crawler.readers          — read/query API
// crawler.runInitSections  — bootstrap sections
// crawler.runInitBoards    — parallel BFS over the section tree (v4+)
// crawler.runInitPinned    — parallel pool + retry passes (v4+)
// crawler.runRefreshBoardStats — parallel refresh per section
// crawler.withLoggedInPage — drive an already-logged-in Page
// crawler.authStatus       — read-only login probe (no side-effect login)
// crawler.warmUp           — establish session, fetching no data
// crawler.shutdown         — release browser + db

await crawler.shutdown();
```

`CrawlerRuntime` adds an idempotent lifecycle wrapper around `Crawler` —
preferred for long-lived embedders that need init/shutdown ordering
guarantees.

### Parallel init (v4)

`runInitBoards`, `runInitPinned`, and `runRefreshBoardStats` all accept:

```ts
interface InitOpts {
  concurrency?: number;        // worker pool size; defaults to YAML crawl.concurrency
  retryConcurrency?: number;   // applies to runInitPinned; default 1
  maxRetryPasses?: number;     // applies to runInitPinned; default YAML maxRetryPasses
  onProgress?: (e: InitProgressEvent) => void;
}
```

`onProgress` fires once per item per `started` / `ok` / `failed`
transition. Consumers (e.g. bbs-mcp's `forum_init`) translate these
into UI progress events.

### Logging

Pino, multi-stream:
- stdout (suppressed when `LOG_STDOUT_DISABLED=true` — used by CLI TUIs)
- `<LOG_DIR>/app/app-<YYYY-MM-DD>.log` (skipped under `NODE_ENV=test`)
- Shadow stream — `addLogShadow(fn)` registers a callback that receives
  every parsed log entry. Used by bbs-mcp to route by `category` field
  into its own dated, categorized log tree.

### Key env vars

| Var | Meaning |
|---|---|
| `SCHOOL_BBS_USERNAME` / `_PASSWORD` / `_BASE_URL` | Site credentials |
| `DATABASE_PATH` | SQLite data root (default `<.env dir>/data`) |
| `BROWSER_HEADLESS` | `false` to see Chrome |
| `BROWSER_EXECUTABLE_PATH` | Use your own Chrome binary |
| `STORAGE_STATE_DIR` | Session file dir (default `.state/`) |
| `RATE_MIN_INTERVAL_MS` / `RATE_JITTER_MS` / `RATE_MAX_CONCURRENCY` | Rate limit (applies to CrawlerService only — init runners use YAML `crawl.requestIntervalMs`) |
| `SITE_CONFIG_DIR` | Override site YAML dir |
| `LOG_LEVEL` | Default `info` |
| `LOG_STDOUT_DISABLED` | `true` to silence stdout (CLI TUI usage) |

Full list: `.env.example`.

## Public surface (`src/index.ts`, 6 groups)

1. **Assembly** — `createCrawler` / `CrawlerRuntime` / `createCrawlerConfig`
2. **Use cases** — `CrawlerService` (`fetchThread` / `fetchThreadById` /
   `listThreadsByName`); `runInitSections` / `runInitBoards` /
   `runInitPinned` / `runRefreshBoardStats`
3. **Read API** — `listSites` / `listSections` / `listBoards` /
   `getSectionDetail` / `listThreadsByBoard` / `getThreadByUrl` /
   `searchThreadsByTitle` / `findBoardByName` / `getBoardById`
4. **Persistence (advanced)** — `initDb` / `getStructureDb` / `getBoardDb` /
   the upsert family
5. **Infrastructure** — `BrowserPool` / `AuthManager` / `createRateLimiter` /
   `getAdapter` / `parseConfig` / `loadAndResolvePaths`
6. **Export + errors + types** — `exportForumStructure` /
   `loadForumStructure`; 10 error classes (`BaseAppError` and subclasses);
   `BrowserDeadError`; `classifyError`; `logger` + `addLogShadow`;
   `SiteAdapter` and all contract types

## Layout

```
src/
  contract/    SiteAdapter interface (crawler-adapter contract)
  config/      env config / site YAML / path resolution
  session/     BrowserPool / AuthManager / rate-limiter
  service/     CrawlerService, createCrawler, init-runners, page-pool, runtime wrapper
  repository/  per-table SQL access (sites / sections / boards / threads / posts ...)
  read/        read-only query API
  adapters/    per-site adapters (currently only school-bbs)
  export/      forum structure serialization
  util/        logger (with shadow API), retry
  errors.ts    all error classes
  registry.ts  adapter registry
  index.ts     public entry
config/
  sites/       per-site YAML (<siteKey>.yml)
scripts/
  auth/        do-login, login-once
  init/        init-sections, init-boards, init-threads, export-structure, refresh-board-stats
  crawl/       crawl-thread / crawl-board / crawl-section / crawl-pinned
  db/          check-db
  repl/        interactive shell (acceptance harness)
```

## Development

```bash
npm run build           # tsc → dist/
npm test                # vitest (140+ tests)
npm run lint:tsc        # tsc --noEmit
```

Chinese version: see [README_CH.md](README_CH.md).
