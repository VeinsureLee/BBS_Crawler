# bbs-crawler

Playwright + 分层 SQLite 的 BBS 爬虫库，作为 BBS_MCP 的可嵌入组件。

## 环境要求

- **Node.js ≥ 20**（推荐 LTS 20 / 22；24 亦支持）。
- 原生依赖 `better-sqlite3`（`^12`）随包提供预编译二进制，覆盖 Node 20 / 22 / 24（win/mac/linux、x64/arm64），`npm install` 通常直接下载、**无需本机编译**。
- 若所在平台 / Node 版本没有现成预编译包，`npm install` 会回退到源码编译，此时需要本机具备 **Python 3** + **C/C++ 构建工具链**（Windows：安装 Visual Studio Build Tools 并勾选 *Desktop development with C++*）。装好后重装或 `npm rebuild better-sqlite3` 即可。
- 备注：旧版（better-sqlite3 11.x）没有 Node 24 的预编译包，在 Node 24 上 fresh clone 必须本机编译——升到 12.x 后此问题消失。

## 功能总览

| 能力 | 入口命令 |
|---|---|
| 登录并保存浏览器会话 | `npm run login` |
| 非交互式登录（仅读环境变量） | `npm run login:once` |
| 初始化讨论区（顶层 sections） | `npm run init:sections` |
| 初始化版面（boards + 子版面） | `npm run init:boards` |
| 初始化置顶帖（默认）；`--with-plain` 额外抓首页普通帖 | `npm run init:threads` |
| 一键顺序执行以上三步 | `npm run init` |
| 导出论坛结构到 JSON | `npm run init:export` |
| 刷新版面流量统计 | `npm run refresh:stats` |
| 按 id 爬单帖 | `npm run crawl:thread -- --id <boardKey>/<articleId>` |
| 按 URL 爬单帖 | `npm run crawl:thread -- --url <url>` |
| 按讨论区查询详情（程序内） | read API `getSectionDetail()` |
| 数据库健康检查 | `npm run db:check` |

## 快速开始

```bash
# 1. 安装依赖
npm install
npx playwright install chromium

# 2. 配置环境
cp .env.example .env
# 填写 SCHOOL_BBS_USERNAME / SCHOOL_BBS_PASSWORD / SCHOOL_BBS_BASE_URL

# 3. 登录（将会话保存至 STORAGE_STATE_DIR，默认 .state/）
npm run login

# 4. 初始化论坛结构
npm run init
# 如需同时抓取首页普通帖：
npm run init:threads -- --with-plain
```

## 配置（可嵌入）

路径解析优先级：**显式参数 > 环境变量 > 自动发现**。

- `.env`：`BBS_ENV_FILE` 显式指定，否则只读包内 `BBS_Crawler/.env`（**不再向上查找父目录**；嵌入方负责把配置写入该文件）。
- `config/sites`：`SITE_CONFIG_DIR` 显式指定，否则使用包自带目录。
- 数据目录：`DATABASE_PATH` 显式指定，否则默认为 `.env` 所在目录下的 `data/`。

程序内通过 `createCrawler()` 一次性装配，返回完整的 `Crawler` 对象：

```typescript
import { createCrawler } from 'bbs-crawler';

const crawler = await createCrawler({
  envFile?: string,        // .env 文件路径
  dataDir?: string,        // 数据目录
  siteConfigDir?: string,  // site YAML 目录
  siteKey?: string,        // 默认 'school-bbs'
  idleTimeoutMs?: number,  // 0 = 永不自动关浏览器
});

// crawler.service          — CrawlerService（抓取）
// crawler.readers          — 读 / 查询 API
// crawler.runInitSections  — 初始化讨论区
// crawler.runInitBoards    — 并行 BFS 遍历 section 树（v4+）
// crawler.runInitPinned    — 并行 pool + 失败重试轮（v4+）
// crawler.runRefreshBoardStats — 按 section 并行刷新
// crawler.withLoggedInPage — 直接操作已登录的 Page
// crawler.authStatus       — 只读登录状态探测（不触发登录）
// crawler.warmUp           — 建立会话，不抓数据
// crawler.shutdown         — 释放浏览器与数据库连接

await crawler.shutdown();
```

`CrawlerRuntime` 是 `Crawler` 之上的幂等生命周期包装，长进程嵌入方
建议用它管理 init/shutdown 顺序。

### 并行初始化（v4）

`runInitBoards` / `runInitPinned` / `runRefreshBoardStats` 都接受：

```ts
interface InitOpts {
  concurrency?: number;        // worker pool 大小；缺省取 YAML crawl.concurrency
  retryConcurrency?: number;   // 只对 runInitPinned 生效；默认 1
  maxRetryPasses?: number;     // 只对 runInitPinned 生效；默认 YAML maxRetryPasses
  onProgress?: (e: InitProgressEvent) => void;
}
```

`onProgress` 每个 item 在 `started` / `ok` / `failed` 三种状态变化时触发。
消费者（如 bbs-mcp 的 `forum_init`）把它翻译成 UI 进度。

### 日志

Pino 多 stream：
- stdout（设 `LOG_STDOUT_DISABLED=true` 后静默，给 CLI TUI 用）
- `<LOG_DIR>/app/app-<YYYY-MM-DD>.log`（`NODE_ENV=test` 时跳过）
- shadow stream —— `addLogShadow(fn)` 注册回调，收到每条解析后的日志条目。
  bbs-mcp 用这个把日志按 `category` 字段路由到自己的分类日志树

关键环境变量（完整列表见 `.env.example`）：

| 变量 | 说明 |
|---|---|
| `SCHOOL_BBS_USERNAME` / `SCHOOL_BBS_PASSWORD` / `SCHOOL_BBS_BASE_URL` | 站点凭据 |
| `DATABASE_PATH` | SQLite 数据目录（默认 `.env` 同级 `data/`） |
| `BROWSER_HEADLESS` | `false` 可打开有界面的 Chrome（调试用） |
| `BROWSER_EXECUTABLE_PATH` | 指定本地 Chrome 路径 |
| `STORAGE_STATE_DIR` | 会话文件目录（默认 `.state/`） |
| `RATE_MIN_INTERVAL_MS` / `RATE_JITTER_MS` / `RATE_MAX_CONCURRENCY` | 速率限制（**只对 CrawlerService 生效**；init runner 用 YAML `crawl.requestIntervalMs`）|
| `LOG_STDOUT_DISABLED` | `true` 静默 stdout（给 CLI TUI 用）|
| `SITE_CONFIG_DIR` | 覆盖 site YAML 目录 |
| `LOG_LEVEL` | 日志级别（默认 `info`） |

## 公开接口（`src/index.ts`，6 组）

| 组 | 内容 |
|---|---|
| **① 装配** | `createCrawler(config?)` / `CrawlerRuntime` — 装配 + 生命周期 |
| **② 抓取用例** | `CrawlerService`（`fetchThread` / `fetchThreadById` / `listThreadsByName`）；`runInitSections` / `runInitBoards` / `runInitPinned` / `runRefreshBoardStats`（v4 起均并行 + InitOpts） |
| **③ 读 / 查询 API** | `listSites` / `listSections` / `listBoards` / `getSectionDetail` / `listThreadsByBoard` / `getThreadByUrl` / `searchThreadsByTitle` / `findBoardByName` / `getBoardById` |
| **④ 持久化（进阶）** | `initDb` / `getStructureDb` / `getBoardDb` / `getDataDir` / `closeAllDbs`；upsert 系列 |
| **⑤ 基础设施** | `BrowserPool` / `AuthManager` / `createRateLimiter` / `getAdapter` / `listAdapters` / `parseConfig` / `loadAndResolvePaths` |
| **⑥ 导出 / 错误 / 类型** | `exportForumStructure` / `loadForumStructure`；10+ 错误类；`BrowserDeadError` / `classifyError`；`logger` + `addLogShadow`；`SiteAdapter` 等契约类型 |

## 目录结构

```
src/
  contract/    SiteAdapter 接口定义（爬虫适配器契约）
  config/      app-config（环境变量解析）、site-config（YAML 加载）、paths（路径解析）
  session/     BrowserPool、AuthManager、createRateLimiter（浏览器与会话管理）
  service/     CrawlerService、createCrawler、init-runners、page-pool、runtime 包装
  repository/  各表的 SQL 访问（sites / sections / boards / threads / posts 等）
  read/        只读查询 API（readers.ts）
  adapters/    各站点适配器（当前仅 school-bbs）
  export/      论坛结构序列化 / 反序列化
  util/        logger、retry
  errors.ts    所有错误类
  registry.ts  适配器注册表
  index.ts     公开库入口
config/
  sites/       per-site YAML 配置（<siteKey>.yml）
scripts/
  auth/        do-login、login-once
  init/        init-sections、init-boards、init-threads、export-structure、refresh-board-stats
  crawl/       crawl-thread、crawl-board、crawl-section、crawl-pinned 等
  db/          check-db
```

## 开发

```bash
# 构建
npm run build

# 测试
npm test

# 类型检查（不产出文件）
npm run lint:tsc
```

英文版见 [README.md](README.md).
