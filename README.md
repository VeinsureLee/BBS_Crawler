# bbs-crawler

Playwright + 分层 SQLite 的 BBS 爬虫库，作为 BBS_MCP 的可嵌入组件。

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

- `.env`：`BBS_ENV_FILE` 显式指定，否则从 cwd 向上查找（将 `.env` 放在 BBS_MCP 根目录即可被子目录自动命中）。
- `config/sites`：`SITE_CONFIG_DIR` 显式指定，否则使用包自带目录。
- 数据目录：`DATABASE_PATH` 显式指定，否则默认为 `.env` 所在目录下的 `data/`。

程序内通过 `createCrawler()` 一次性装配，返回完整的 `Crawler` 对象：

```typescript
import { createCrawler } from 'bbs-crawler';

const crawler = await createCrawler({
  envFile?: string,      // .env 文件路径
  dataDir?: string,      // 数据目录
  siteConfigDir?: string,// site YAML 目录
  siteKey?: string,      // 默认 'school-bbs'
});

// crawler.service          — CrawlerService（抓取）
// crawler.readers          — 读 / 查询 API
// crawler.runInitSections  — 初始化讨论区
// crawler.runInitBoards    — 初始化版面
// crawler.runInitPinned    — 初始化置顶帖
// crawler.runRefreshBoardStats — 刷新流量统计
// crawler.withLoggedInPage — 直接操作已登录的 Page
// crawler.shutdown         — 释放浏览器与数据库连接

await crawler.shutdown();
```

关键环境变量（完整列表见 `.env.example`）：

| 变量 | 说明 |
|---|---|
| `SCHOOL_BBS_USERNAME` / `SCHOOL_BBS_PASSWORD` / `SCHOOL_BBS_BASE_URL` | 站点凭据 |
| `DATABASE_PATH` | SQLite 数据目录（默认 `.env` 同级 `data/`） |
| `BROWSER_HEADLESS` | `false` 可打开有界面的 Chrome（调试用） |
| `BROWSER_EXECUTABLE_PATH` | 指定本地 Chrome 路径 |
| `STORAGE_STATE_DIR` | 会话文件目录（默认 `.state/`） |
| `RATE_MIN_INTERVAL_MS` / `RATE_JITTER_MS` / `RATE_MAX_CONCURRENCY` | 速率限制参数 |
| `SITE_CONFIG_DIR` | 覆盖 site YAML 目录 |
| `LOG_LEVEL` | 日志级别（默认 `info`） |

## 公开接口（`src/index.ts`，6 组）

| 组 | 内容 |
|---|---|
| **① 装配** | `createCrawler(config?)` — 返回 `Crawler`；`CrawlerConfig` 类型 |
| **② 抓取用例** | `CrawlerService`（方法：`fetchThread` / `fetchThreadById` / `listThreadsByName`）；`runInitSections` / `runInitBoards` / `runInitPinned` / `runRefreshBoardStats` |
| **③ 读 / 查询 API** | `listSites` / `listSections` / `listBoards` / `getSectionDetail` / `listThreadsByBoard` / `getThreadByUrl` / `findBoardByName` / `getBoardById` |
| **④ 持久化（进阶）** | `initDb` / `getStructureDb` / `getBoardDb` / `getDataDir` / `closeAllDbs`；`upsertSite` / `upsertSection` / `upsertBoard` / `upsertThread` / `upsertPosts` / `upsertDailyTraffic` / `appendFetchLog` 等 |
| **⑤ 基础设施** | `BrowserPool` / `AuthManager` / `createRateLimiter` / `getAdapter` / `listAdapters` / `parseConfig` / `loadAndResolvePaths` / `findEnvFileUpward` |
| **⑥ 导出 / 错误 / 类型** | `exportForumStructure` / `loadForumStructure`；10 个错误类（`BaseAppError` 等）；`logger` / `retry`；`SiteAdapter` 等契约类型 |

## 目录结构

```
src/
  contract/    SiteAdapter 接口定义（爬虫适配器契约）
  config/      app-config（环境变量解析）、site-config（YAML 加载）、paths（路径解析）
  session/     BrowserPool、AuthManager、createRateLimiter（浏览器与会话管理）
  service/     CrawlerService、createCrawler（factory）、init-runners（批量初始化逻辑）
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
