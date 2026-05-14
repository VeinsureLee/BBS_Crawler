# BBS_Crawler

基于 Playwright 的论坛爬虫，把帖子持久化到分层 SQLite 存储，并提供 TypeScript 库给下游使用。**BBS Agent of BYR** 项目的数据摄取层。

> 状态：**Phase 3 落地 + 拆表**——分层式 per-forum SQLite 存储，置顶帖与普通帖分别存于 `pinned_*` / `plain_*` 两组表；配置驱动初始化、节点递归树、init 流水线加固。`school-bbs` 适配器完成。English version: [`README.md`](README.md)。

> 本项目**不是 MCP 服务**——它是 TypeScript 库 + CLI 脚本。MCP 服务由下游独立项目实现，把本项目作为依赖引入。完整设计思路见 [`.shadow/README.md`](.shadow/README.md)。

## 它做什么

- 通过 Playwright Chromium 爬取论坛内容（讨论区 / 版面 / 置顶帖 / 普通帖 / 楼层）
- 把数据持久化到**分层 SQLite**：一个全局 `structure.db` 装节点递归树，每个顶级讨论区单独一个 `forums/<key>.db`
- 第一次打开数据库文件时自动应用 schema —— 全新部署不需要单独的 migration 框架
- 站点适配器可插拔：内置 `school-bbs`，新站点只需在 `src/adapters/<site>/` 下加一个文件夹 + 一份 YAML 配置
- **配置驱动初始化**：顶级讨论区清单和节点形态写在 `config/sites/<siteKey>.entries.yml` 和 `<siteKey>.node-types.yml` 里 —— 论坛首页 HTML 不再是真理来源
- 登录流程用 `storageState` 持久化 + 可选加密凭据缓存（AES-256-GCM），cookie 失效不强迫手动重登
- 每版面增量爬取进度（`board_crawl_state.last_thread_posted_at` 水位线），下游只取增量
- pino multistream 结构化日志（stdout + 按日切割的 `.logs/app/app-<date>.log`）。长跑脚本如 `init:threads` 会自己渲染原地刷新的 TUI 并静默 pino 的 stdout sink（文件日志不变）

## 它不做什么

- **不是 MCP 服务** —— 那是下游项目的事
- 不做全文搜索 —— `search.ts` 已删除，下游 RAG / 搜索项目负责
- 不暴露浏览器底层工具

## 在生态中的位置

| 仓库 | 职责 |
|---|---|
| **`BBS_Crawler`（本仓库）** | 浏览器爬虫 + 分层 SQLite 存储 + TS 库 |
| `BBS_Database` | 存储栈：SQLite（原文）+ Chroma（向量）+ Neo4j（关系） |
| `BBS_Agent` | 多索引 RAG agent，消费 MCP 层（独立仓库） |

本爬虫**拥有**分层 SQLite schema。下游消费方读取同一批文件（只读）做 embedding / 图索引。

## 技术栈

- TypeScript（Node 20+）
- [Playwright](https://playwright.dev/)（仅 Chromium）
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)（同步嵌入式 SQLite，WAL 模式）
- [js-yaml](https://github.com/nodeca/js-yaml) + [zod](https://zod.dev/) 做配置加载和校验
- [pino](https://getpino.io/) 做结构化日志（stdout + 文件 sink）

## 快速开始

```bash
# 1. 安装依赖
npm install
npx playwright install chromium

# 2. 配置环境变量
cp .env.example .env
# 填入 SCHOOL_BBS_USERNAME / SCHOOL_BBS_PASSWORD / SCHOOL_BBS_BASE_URL
# DATABASE_PATH 默认 ./.data

# 3. 首次登录（保存 storageState；询问是否记住密码）
npm run login

# 4. 初始化论坛结构
npm run init:sections                          # 顶级讨论区（先读 entries.yml，缺失则爬首页）
npm run init:boards                            # 子讨论区 + 版面
npm run init:threads -- --concurrency 8        # 默认只爬置顶帖。用 8 比默认 16 更稳，避免 chrome 爆内存
# 或者顺便把每个版面第一页的非置顶帖也爬了（每帖只取首页）：
npm run init:threads -- --concurrency 8 --with-plain

# 5. 另开一个窗口看实时进度（可选）
npm run tail:progress
```

`tail:progress` 跟最新的 `.logs/app/app-<日期>.log`，过滤出 `progress.tick` /
`progress.final` 行，渲染一块**局部刷新**的多行展示（汇总 + per-forum 明细）。
终端是 TTY 时用 ANSI 光标上移 + 清屏做原地覆盖；管道到文件 / 非 TTY 时自动
fallback 到行模式。自动处理跨天 rollover。避开 PowerShell `Select-String` /
`ConvertFrom-Json` 那套 MatchInfo 坑。

第 4 步跑完，数据目录长这样：

```
.data/
  structure.db              sites + nodes（递归树）+ fetch_log
  forums/
    本站站务.db                pinned_threads + pinned_posts
                            + plain_threads  + plain_posts
                            + board_crawl_state + daily_traffic
    校园生活.db
    学术科技.db
    ...
```

每个 forum db 把置顶帖（sticky）和普通帖（plain）分到两组独立的表里。同一个 URL
只会出现在其中一边——当某帖的置顶状态在两次爬取之间翻转时，upsert 路径会先把对侧
表里的那一行删掉（级联清理对应的 posts），再写入目标表。

`npm run login` 会问 `Remember password? (y/N)`：
- 选 `y` → 凭据用 AES-256-GCM 加密写到 `./.state/<siteKey>.credentials.enc`（mode 0600）。之后 cookie 失效时，AuthManager 用缓存自动重登
- 选 `N` → 仅 cookie 模式，会话失效时手动再跑一次 `npm run login`

## 库 API

本项目作为 TypeScript 库被消费。公开接口在 [`src/index.ts`](src/index.ts)：

| 分组 | 导出 |
|---|---|
| **数据库** | `initDb`, `getStructureDb`, `getForumDb`, `closeAllDbs`, `STRUCTURE_SCHEMA`, `FORUM_SCHEMA` |
| **站点 / 节点** | `upsertSite`, `upsertSection`, `hasSections`, `listTopLevelSections`, `sectionsMissingBoards` |
| **版面** | `upsertBoard`, `listBoards`, `boardsMissingPinned`, `findBoardByName`, `getBoardById`, `resolveBoardRoute`, `findForumDbFileForBoard` |
| **帖子 / 楼层** | `upsertPinnedThread`, `upsertPlainThread`, `upsertPinnedThreadSummary`, `upsertPlainThreadSummary`, `upsertPinnedPosts`, `upsertPlainPosts`, `checkThreadExists`, `getCrawledThreadUrls`, `shouldSkipFetch`（均按 kind 参数路由） |
| **爬取编排** | `CrawlerService`, `InitOrchestrator`, `runInitSections` / `runInitBoards` / `runInitPinned`, `BrowserPool`, `AuthManager`, `createRateLimiter` |
| **审计 / 状态** | `appendFetchLog`, `getBoardCrawlState`, `upsertBoardCrawlState` |
| **适配器** | `getAdapter`, `listAdapters` |
| **工具** | `logger`, `addRedactedSecret`, `appLogPath`, `retry`, `parseConfig` |
| **错误** | `BaseAppError`, `MissingCredentialsError`, `LoginFailedError`, `SessionExpiredError`, `NavigationTimeoutError`, `RateLimitedError`, `BoardNotFoundError`, `FetchFailedError`, `DatabaseError`, `UnknownSiteError` |

下游 MCP 风格消费方的典型用法：

```typescript
import {
  initDb, parseConfig, BrowserPool, AuthManager, createRateLimiter,
  CrawlerService, getAdapter,
  upsertPlainThread, upsertPlainPosts, appendFetchLog,
} from 'bbs-crawler';
import 'bbs-crawler/dist/adapters';   // 副作用导入：注册 adapter

const cfg = parseConfig(process.env);
initDb({ dataDir: cfg.dataDir });

const crawler = new CrawlerService({
  rateLimiter: createRateLimiter({ /* ... */ }),
  browserPool: new BrowserPool({ /* ... */ }),
  auth: new AuthManager({ /* ... */ }),
  registry: { getAdapter },
  // 普通（非置顶）帖。要写置顶帖请换成 upsertPinnedThread / upsertPinnedPosts。
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

## 配置

所有敏感信息走 `.env`（gitignored）。所有论坛结构相关在 `config/sites/`。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `{SITE_KEY}_USERNAME` / `_PASSWORD` / `_BASE_URL` / `_LOGIN_URL` | — | 每站点凭据。例如 `SCHOOL_BBS_USERNAME` |
| `DATABASE_PATH` | `./.data` | `structure.db` + `forums/` 的根目录 |
| `LOG_DIR` | `./.logs` | pino 文件 sink 根目录 |
| `LOG_LEVEL` | `info` | `debug` 时输出更详细 |
| `LOG_FILE_DISABLED` | `false` | 设 `true` 跳过文件 sink（`NODE_ENV=test` 时自动跳过） |
| `LOG_STDOUT_DISABLED` | `false` | 设 `true` 让 pino 不往 stdout 写。`init:threads` 启动时会自动打开它，让自己的 TUI 独占终端；一般不用手动改 |
| `BROWSER_HEADLESS` | `true` | 设 `false` 实时看 Chrome |
| `BROWSER_EXECUTABLE_PATH` | （Playwright 自带） | 指定本地 Chrome 路径 |
| `BROWSER_USER_AGENT` | （默认） | 覆盖 UA 字符串 |
| `STORAGE_STATE_DIR` | `./.state` | `<siteKey>.json`（cookie）和 `*.credentials.enc` 的目录 |
| `IDLE_TIMEOUT_MS` | `300000` | 浏览器空闲多少毫秒后自动关闭 |
| `RATE_MIN_INTERVAL_MS` / `RATE_JITTER_MS` / `RATE_MAX_CONCURRENCY` | `1500` / `1000` / `1` | 限速参数 |
| `CRED_KEY` | 主机名派生 | 凭据缓存的 AES key 种子 |
| `SITE_CONFIG_DIR` | `./config/sites` | 配置目录覆盖（测试用） |

每站点 YAML 在 `config/sites/`：

| 文件 | 用途 |
|---|---|
| `<siteKey>.yml` | Selectors、route 模板、爬取参数（间隔、并发、重试） |
| `<siteKey>.entries.yml` | 顶级讨论区清单 —— `init:sections` 优先读这个，缺失则回退到爬首页 |
| `<siteKey>.node-types.yml` | 节点形态声明：`forum` / `sub_forum` / `board` / `thread` + `childTypes` 关系 |

`.env` / `./.state/` / `./.data/` / `./.logs/` 都在 `.gitignore` 里。仓库只提交 `.env.example`。

## 脚本说明

### 认证
| 脚本 | 用途 |
|---|---|
| `npm run login [siteKey]` | 交互式登录 + 保存 `storageState`；可选加密保存凭据 |
| `npm run login:once [siteKey]` | 非交互式（仅 env）登录 |

### 初始化流水线
| 脚本 | 用途 |
|---|---|
| `npm run init:sections [siteKey]` | 入库顶级讨论区（先读 `entries.yml`，缺失则回退到爬首页） |
| `npm run init:boards [siteKey]` | 递归爬取每个讨论区下的子讨论区 + 版面（已加环检测） |
| `npm run init:threads [siteKey] [--concurrency N] [--limit N] [--with-plain] [--skip-done] [--verbose]` | 爬取置顶帖（默认）。加 `--with-plain` 会顺便把每个版面第一页的非置顶帖也爬了（每帖只取首页）。**终端默认只显示一块局部刷新的进度**（进度条 + 按 forum 分组的 done/total/pin/plain/fail）；`--verbose` 在进度块上方滚动展示每个版面的结果。文件日志始终保留全部 per-step 细节 |
| `npm run init` | 顺序跑完上面三步（默认只爬置顶；想覆盖 plain 请单独跑 `init:threads -- --with-plain`） |
| `npm run init:export [siteKey] [outputPath]` | 导出论坛结构到 JSON |

### 爬取
| 脚本 | 用途 |
|---|---|
| `npm run crawl:board <boardPath>` | 保存某个版面页面的原始 HTML（探索用） |
| `npm run crawl:section <sectionPath>` | 保存某个讨论区页面的原始 HTML |
| `npm run crawl:pinned <boardKey>` | 保存某版面所有置顶帖的原始 HTML |
| `npm run crawl:board-skip <boardKey> [freshnessHours]` | 生产风格：列出 + 抓取帖子，跳过近期已爬的（用 `shouldSkipFetch`） |

### 数据库
| 脚本 | 用途 |
|---|---|
| `npm run db:check [siteKey]` | 健康检查：列出 `structure.db` 的表 + 每个 `forums/*.db` 的表行数 |
| `npm run db:migrate:split-threads -- [--dry-run] [--data-dir ./.data] [--yes]` | 一次性迁移：把每个 `forums/*.db` 里的单一 `threads` + `posts` 拆成 `pinned_threads` / `pinned_posts` / `plain_threads` / `plain_posts` 四张表。改写前先把 db 备份到 `<file>.bak`。幂等 |

### 调试
| 脚本 | 用途 |
|---|---|
| `npm run debug:board <boardKey>` | 用**有头** Chrome 打开版面页面以可视化检查 |
| `npm run debug:failed-boards` | 列出最近失败的版面 |
| `npx tsx scripts/debug/check-cycles.ts` | 诊断 `nodes.parent_id` 是否有环（防数据腐败） |
| `npx tsx scripts/debug/smoke-precheck.ts` | 快速检查环境 + DB |

### 工具
| 脚本 | 用途 |
|---|---|
| `npm run explore` | 通用探索工具 |
| `npm run format:html <file>` | 美化原始 HTML 用于离线分析 |
| `npm run tail:progress` | 跟最新的应用日志，把 `progress.tick` / `progress.final` 渲染成**局部刷新**的多行块（ANSI 光标上移 + 清屏）。非 TTY 管道自动 fallback 到行模式 |

## 添加新站点

1. `.env` 加变量：`<SITE_KEY_UPPER>_USERNAME` / `_PASSWORD` / `_BASE_URL` / `_LOGIN_URL`
2. 新建 `config/sites/<siteKey>.yml`（selectors / routes / 爬取参数 —— 抄一份 `school-bbs.yml`）
3. （可选但推荐）`<siteKey>.entries.yml` 和 `<siteKey>.node-types.yml`
4. 实现 `src/adapters/<siteKey>/index.ts` 满足 [`SiteAdapter`](src/core/site-adapter.ts) 接口；模块顶层调 `register(adapter)`
5. 在 [`src/adapters/index.ts`](src/adapters/index.ts) 加 `import './<siteKey>'`
6. 跑 `npm run init:sections <siteKey>` 等

框架已经包办了浏览器池、会话持久化、限速、重试、写库。adapter 只负责把页面 DOM 转成结构化的 `Thread` / `ThreadSummary`。

## 目录结构

```
src/
  core/                browser-pool / rate-limiter / auth-manager / init-orchestrator+runners /
                       crawler-service / registry / site-adapter / site-config / errors
  repository/          逐表 SQL 访问；分层存储路由
  adapters/            每个站点一个文件夹（目前只有 school-bbs）
  util/                logger, retry
  index.ts             公开库入口
config/
  sites/               每站点 YAML 配置
scripts/
  auth/                do-login, login-once
  init/                init-sections, init-boards, init-threads, init-ui (TUI), export-structure
  crawl/               crawl-board, crawl-section, crawl-pinned, crawl-board-with-skip,
                       crawl-forum-structure
  db/                  check-db, migrate-split-threads
  debug/               debug-board, explore-failed-boards, smoke-precheck, check-cycles, ...
  util/                explore, format-html, tail-progress
tests/
  unit/                vitest 套件：core, repository, util, adapter
.shadow/               中文设计文档（架构 / 模块 / 工作流）
```

## 文档

详细设计文档在 [`.shadow/`](.shadow/)（中文，给开发者也给非开发者看）：

- [`README.md`](.shadow/README.md) —— 项目定位
- [`数据库.md`](.shadow/数据库.md) —— 分层 SQLite 设计、schema、迁移路径
- [`配置文件.md`](.shadow/配置文件.md) —— 三类 YAML 配置文件
- [`工作流程/01-初始化.md`](.shadow/工作流程/01-初始化.md) —— 初始化流水线
- [`工作流程/02-爬取版面帖子.md`](.shadow/工作流程/02-爬取版面帖子.md) —— 爬取版面帖子工作流
- [`模块/`](.shadow/模块/) —— 各模块详细规格（爬虫、浏览器与会话、数据库访问层、配置加载、限速、重试与错误、日志、元数据 CRUD 接口）

## Roadmap

已完成（Phase 1–3 + 拆表）：
- pino multistream + 按日切割的应用日志 + 脱敏（`LOG_STDOUT_DISABLED` 让长跑 CLI 可以单独静默 stdout，不影响文件 sink）
- 配置驱动初始化（`entries.yml` + `node-types.yml`）
- 分层 SQLite 存储（per-forum `.db`），nodes 递归树，自动应用 schema，**深度受限**且**避免环**的 CTE 走链
- 单一 `threads` → `pinned_threads` / `plain_threads`（含对应 `*_posts`）拆分；置顶状态翻转时跨表迁移行。一次性迁移脚本 `db:migrate:split-threads`
- `init:pinned` + `init:plain` 合并为 `init:threads`（默认仅置顶；`--with-plain` 加爬第一页非置顶）
- `init:threads` 自带 TUI：原地刷新的进度块 + 按 forum 分组对齐表；`--verbose` 在进度块上方滚动展示每版面的结果。单帖错误被 per-thread try/catch 捕获并跳过，不再因一个坏 URL 把整个版面拖崩
- 按讨论区分组的进度报告（每 5 秒，也写入文件日志，方便另一个窗口跑 `tail:progress`）、浏览器死亡检测 + 优雅退出、`--skip-done` 续跑、严格的 CLI 解析
- `init-boards` 环保护：`visited` 集合 + 跳过把自己列为子节点的情况
- 跨平台 `tail:progress`（替换了脆弱的 PowerShell `Select-String` / `ConvertFrom-Json` 一行命令）
- 删除 pg-mem 死测试、`search.ts`、老 migration 框架

本仓库范围外（在别处实现）：
- MCP 服务（独立的下游项目，把本仓库当库引）
- 全文 / 向量搜索 + RAG
- `school-bbs` 之外更多站点适配器
- 后台调度器 / 多机部署

## 隐私

- `.env`、`./.state/`、`./.logs/`、`./.data/` 都在 `.gitignore` 中
- pino 自动脱敏注册过的字符串（通过 `addRedactedSecret(...)`）—— `AuthManager` 在首次登录时注册凭据
- 凭据缓存用 AES-256-GCM，默认 key 从主机名派生；用 `CRED_KEY` 自定义可以跨机迁移
- `storageState.json`（含 cookie）写盘后 chmod 0600（Windows 上尽力而为）

## License

TBD。
