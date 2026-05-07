# BBS_Crawler

基于 Playwright 的 MCP 服务，爬取论坛帖子并落库到本地 PostgreSQL。作为 **BBS Agent of BYR** 项目的数据摄取层。

> 状态：早期开发中——框架脚手架进行中，尚未交付任何站点适配器。English version: [`README.md`](README.md)。

## 它做什么

- 暴露一组高层 MCP tool（`forum_search` / `forum_list_threads` / `forum_get_thread` 等），供自定义 agent 按需爬取论坛内容。
- 通过 Playwright 驱动真实 Chromium 浏览器，能拿到登录后才可见的页面。
- 用 Playwright 的 `storageState` 持久化登录会话——agent 不需要每次都重新提交账密。
- 可选地把抓取到的内容写入 PostgreSQL（`persist: true`），后续给 RAG / 批量处理使用。
- 站点适配器可插拔：内置 `school-bbs` 适配器；新站点只需在 `src/adapters/<site>/` 下加一个文件。

## 在生态里的位置

| 仓库 | 职责 |
|---|---|
| [`BBS_Crawler`](https://github.com/VeinsureLee/BBS_Crawler)（本仓库） | 浏览器爬虫 + MCP 服务，写 PostgreSQL |
| [`BBS_Database`](https://github.com/VeinsureLee/BBS_Database) | 存储栈：PostgreSQL（原文）+ Chroma（向量）+ Neo4j（关系） |
| [`BBS_Agent`](https://github.com/VeinsureLee/BBS_Agent) | 多索引 RAG agent，消费本 MCP 并查询数据库 |

本爬虫**拥有**论坛内容的 PostgreSQL schema。`BBS_Database` 读同一个 PostgreSQL，下游做 embedding / 图索引。

## 技术栈

- TypeScript（Node 20+）
- [Playwright](https://playwright.dev/)（仅 chromium）
- PostgreSQL 14+
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)（stdio 传输）
- `pg` + `node-pg-migrate`（不引 ORM）
- `zod` 做 env / 入参校验，`pino` 做结构化日志

## 快速开始

> 实现尚未完成。下面的命令是目标形态，会随实现进度逐步可用。

```bash
# 1. 安装依赖
npm install
npx playwright install chromium

# 2. 配置环境
cp .env.example .env
# 填入 DATABASE_URL、SCHOOL_BBS_USERNAME、SCHOOL_BBS_PASSWORD

# 3. 跑数据库迁移
npm run migrate:up

# 4. 启动 MCP 服务（stdio）
npm run start
```

接入 Claude Code / Claude Desktop / 自定义 agent 时，把它作为 stdio MCP 服务注册即可。`claude_desktop_config.json` 配置片段示例：

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

## MCP tool 列表

| Tool | 用途 |
|---|---|
| `forum_list_sites` | 查询已注册的站点适配器 |
| `forum_search` | 站点关键词搜索 |
| `forum_list_threads` | 板块列表（分页） |
| `forum_get_thread` | 取整个帖子（含回复） |
| `forum_query_cache` | 在已落库内容上做关键词检索（不开浏览器） |
| `forum_session_status` | 查看某站点的登录状态 |
| `forum_relogin` | 强制重跑登录流程 |

站点相关 tool 第一参数为 `siteKey`（如 `"school-bbs"`）。所有 tool 返回的 JSON 都带 `siteKey` 和 `fetchedAt`，方便 agent 判断数据新鲜度。数据流分三条路径：实时抓取、抓取后落库（`persist: true`）、纯查缓存（`forum_query_cache`）。

## 配置

所有敏感信息只走环境变量。常用项：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接串（必填） |
| `{SITE_KEY_UPPER}_USERNAME` / `_PASSWORD` | 每个站点的凭据，如 `SCHOOL_BBS_USERNAME` |
| `BROWSER_HEADLESS` | 调试时设 `false`（默认 `true`） |
| `RATE_MIN_INTERVAL_MS` / `RATE_JITTER_MS` / `RATE_MAX_CONCURRENCY` | 每站点的礼貌策略（默认 1500 / 1000 / 1） |
| `STORAGE_STATE_DIR` | Playwright `storageState.json` 文件目录（默认 `./.state`） |
| `LOG_LEVEL` | `debug` 时启用失败截图，写到 `./.state/debug/` |

`.env` 和 `./.state/` 都在 `.gitignore` 中。仓库只提交 `.env.example`。

## 新增站点

1. 新建 `src/adapters/<site-key>/index.ts`，导出符合 `SiteAdapter` 接口的对象（见 [`src/core/site-adapter.ts`](src/core/site-adapter.ts)）。
2. 实现 `isLoggedIn`、`login`、`listThreads`、`getThread`、`search`。辅助文件放在同目录（`selectors.ts`、`login.ts` 等）。
3. 在 [`src/adapters/index.ts`](src/adapters/index.ts) 加一行 `import './<site-key>'`，触发 side-effect 注册。
4. 在 `tests/fixtures/<site-key>/` 加 HTML 快照和集成测试。
5. 把所需 env 变量（`<SITE_KEY_UPPER>_USERNAME` 等）补到 `.env.example`。

框架已经包办了浏览器池、会话持久化、限速、重试、写库——adapter 只负责把页面转换成结构化的 `Thread` / `ThreadSummary`。

## 目录结构

```
src/
  server/            MCP tool 注册 + JSON Schema
  core/              编排层：registry / crawler-service / auth / browser pool / rate limiter
  repository/        所有 SQL（不引 ORM）
  adapters/          每个站点一个文件夹
migrations/          node-pg-migrate 的 SQL 文件
tests/fixtures/      脱敏 HTML 快照，驱动 adapter 集成测试
scripts/             一次性 CLI 工具（login-once、inspect）
```

## Roadmap

GitHub issue 跟踪：

- [#1 Investigate forum page structure and authentication](https://github.com/VeinsureLee/BBS_Crawler/issues/1)
- [#2 Implement browser-based login and session persistence](https://github.com/VeinsureLee/BBS_Crawler/issues/2)
- [#3 Implement post list and content crawling](https://github.com/VeinsureLee/BBS_Crawler/issues/3)

v1 范围外（已显式延后）：验证码 / SSO / 2FA、低层 `browser_*` MCP tool、`school-bbs` 之外的更多站点、中文分词 FTS、定时调度器、分布式部署。

## 隐私

- 源码、测试中绝不出现明文 URL / 账号 / 密码；`.env` 在 `.gitignore` 中。
- Logger 在写日志时自动脱敏已注册的凭据字符串。
- `storageState.json`（含 cookie）写盘后 chmod 0600（Windows 上尽力而为），不进 git。

## License

TBD。
