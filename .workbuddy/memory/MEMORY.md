# CodeLens 长期笔记

> 部署→skill `codelens-deploy`；评测→skill `codelens-retrieval-eval`；细节→`TECHNICAL-NOTES.md`。

## 铁律

1. **源码改了 ≠ 线上在跑**：判据 = 线上 dist grep 新标识符；只 scp **不重启**⇒ 不生效；
   `migrations/` 不在 dist，要单独带。
2. **最危险 = 静默空转/少做**：`reindex` 0/0+ready、`reembed` 静默留 NULL、`0 chunk ⇒ continue`。
   **计数 == 0 必须显式失败。**
   变体：**「为了避免假阳性而跳过」的检查会同时放过真问题** —— 正确姿势是把「跳过」变成
   **显式允许清单**（`check:sql` 的 `KNOWN_NON_TABLES` 就是这么修的），而不是静默跳过。
3. **产物断言必须带「规模断言」**：只 grep「我改的那个文件里的新标识符」**不能**区分
   「整个 dist 完整」和「只有那 1 个文件在」。
   2026-09-20 实测：`mv dist` 走但**忘移 `tsconfig.tsbuildinfo`** ⇒ tsc 增量**只重发 1 个文件**
   （`find dist -type f | wc -l` = **1**）⇒ 打出来的包没有 `dist/index.js` ⇒ **线上直接挂（health=000）**。
   ⇒ ① `mv dist` 必须**同时** `mv tsconfig.tsbuildinfo`（原 `build` 脚本是 `rm -rf dist tsbuildinfo`，
   **它是对的**，拆成 `mv` 时漏了一半）；② 打包后立刻 `tar tzf | grep -x "dist/index.js"` +
   条目数 ≥ 阈值；③ 基线：API **172 文件 / 189 条目**、web `index.html` **490 B**。
4. **`CREATE INDEX IF NOT EXISTS` 只按名字判存在、不比对定义** ⇒ 撞上带外建过的同名索引就**整条静默 no-op**。
   2026-09-20 实测：`idx_agent_conversations_session` 线上是 `btree (session_id)`，
   而仓内声明的是四列复合 —— 复合索引从未建出、无报错、启动日志正常。
   ⇒ 往 **out-of-band 表**补索引前先查 `pg_indexes.indexdef`，必要时换名（已改为 `_session_recent`）。
   ⚠️ `check:sql` / `check:live-schema` **都覆盖不到索引定义**；判据是 `pg_indexes` 文本，不是「有没有报错」。
   ⚠️ 表小时 `EXPLAIN` 仍走 Seq Scan，**别据此以为索引没生效**。
5. 重启：`pm2 restart codelens-api --update-env`（`--only` 可能没真重启），核对 uptime 归零 + `/health` 200。
6. `reindex` 只按 `files` 已登记路径重解析 ⇒ 目录结构一变它就是错的工具（删仓重建或**续跑**）。
7. **失败先续跑别重建**：`POST /repos/:id/resume`（migration 006）；代价 ∝ 剩余量。
8. **回滚点（`dist.prev.*` / `codelens-web.prev.*`）就是事故时的救命路径** ——
   2026-09-20 靠 `mv dist.prev.<ts> dist` 把线上从 000 救回来。保留最近 5 个，多出的 `mv` 到
   `/tmp/old-rollbacks/`，**别 `rm`**。

## 环境

- **线上配置唯一来源 = `ecosystem.config.js::env_production`**；`.env` 只对手工脚本生效且**值不同**
  ⇒ **别手跑 `reembed.js`**。
- **pm2 把 `console.warn/error` 分流到 `-error.log`** ⇒ out 日志 grep 警告恒空。
  ⚠️ **日志路径以 `pm2 describe codelens-api | grep -i "log path"` 为准**：
  线上实际是 **`/var/log/codelens-api-{out,error}.log`**（out 已 672 MB）。
  `/root/.pm2/logs/` 里那两个文件**停在 5 月 1 日**、早就不写了 —— `tail` 它们会看到「5 月的错误」，
  极易误判成本次启动的问题。
- 前端线上 = **nginx `/code/`→alias `/www/wwwroot/codelens-web/`**；API 公开在 **`/code-api/`**。
  本机 https 被拦 → 直连 `http://47.116.6.132/code-api`。
- **本机 `pnpm build:web` 曾必挂**：`Host version "0.25.12" does not match binary version "0.27.7"`。
  根因 = vite 的嵌套 esbuild 是**真实目录**，其兄弟 `@esbuild/` **只有 `darwin-x64`**、缺 `darwin-arm64`
  ⇒ arm64 查找冒泡到 pnpm hoisted store 命中 **0.27.7**。
  **已根治**：`ln -sfn $PWD/node_modules/.pnpm/@esbuild+darwin-arm64@0.25.12/node_modules/@esbuild/darwin-arm64 <vite>/node_modules/vite/node_modules/@esbuild/darwin-arm64`
  （实测**扛得过** `pnpm install --frozen-lockfile`；但 install **不会自己修**）。
  ⚠️ 只设 `ESBUILD_BINARY_PATH` **救不了自动部署** —— `scripts/deploy.js:133` 跑 `pnpm build:web`，不带该变量。
- **curl 通 ≠ 无头 Chrome 通**：headless Chrome 只能走 loopback，fetch 公网 IP 报
  `Failed to fetch`（页面渲染但「统计不可用」）⇒ 浏览器验证**必须走 SSH 隧道**。
- ⚠️ **`github.com` 在本机被 SNI 阻断**：HTTPS 443 在 TLS ClientHello 后即
  `Recv failure: Connection reset by peer`；`api.github.com`/`codeload`/`raw` 正常；
  **22 端口 TCP 能连但 SSH 握手被切**（`kex_exchange_identification`）。
  ⇒ **remote 用 `ssh://git@ssh.github.com:443/Carpe912/CodeLens.git`**（已切换，实测可认证/可 ls-remote）。
  `~/.ssh/config` 里那个 `Host github.com` 块带 `ProxyCommand ... 127.0.0.1:7890`，
  而 **7890 无监听** ⇒ 走 `git@github.com` 会卡死（配置写好 ≠ 能跑）。原 HTTPS 地址存 `/tmp/origin-url-before.txt`。
- **别用 `nc -z` 判断可用性**：它只验 TCP 三次握手，对 SNI 阻断/协议层切断会给假阳性，
  必须做到 TLS/SSH 握手层。

## 数据口径（反直觉）

1. `code_chunks.repo_id` **全 NULL** ⇒ 归属一律 JOIN `files.repo_id`（否则恒 0）。
2. `code_chunks.id` 与 `functions`/`string_constants` 的 id 是**两套空间** ⇒ evidence `id` ≠ 主键。
3. call_graph 入边**按 `to_symbol` 分组**反查（按 chunk_id ⇒ 恒 0 caller）；伪自环**勿全砍**（误杀真递归），
   判据见 `TECHNICAL-NOTES.md` §。
4. `url_patterns` **一行 ≠ 一个接口**：原始 **283** → 去重 **277** → 真实接口 **238**，
   加 16 个 method 未判定但路径确认是接口 ⇒ **可调用 254**；余 23 行不是接口（前端路由/
   vite 产物/文案/CDN），由 `classifyUndecidedRow()` 判 —— **规则只此一份**，前端只展示。
   **「列出全部 N」检索无解**（top-K 不完备）⇒ 结构化查询：`GET /repos/:id/url-patterns`、
   `/ask` 枚举（`structured:true`）、MCP `dist/mcp/codelens-mcp.js`。`/stats` 的 `urlPatterns`
   是裸行数，接口数用 `interfacesCallable`。
   ⚠️ helper 展开**必须按「定义所在文件」判作用域**（`scope` 14 文件同名不同义，全局先到先得
   会给出**错但很像真的**路径）。
   ✅ 清单完整性用**双实现集合差**验（硬编码 vs 数据驱动，归一化占位符后差集须 0）。
5. **agent 系列 7 张表线上存在但全 0 行**（`agent_conversations`/`agent_executions`/`agent_lessons`/
   `agent_performance_stats`/`agent_reflections`/`conversation_memory`/`tool_calls`）。
   2026-09-20 起 **`agent_conversations` 已在 `db/index.ts` 补回建表声明**（CREATE + 逐列 ALTER 兜底
   + `idx_agent_conversations_session`）；**其余 6 张仍无声明、零引用、零行**（重建库仍不会产生）。
   ⚠️ **0 行 ≠ 未调用**：`Failed to save conversation` 只打日志、不影响响应 ⇒ 有静默持久化失败。
   真实原因另有其一：**唯一写入点 `executeQuery()` 只被 `/agent/query` 调用，而前端从不调它**。
6. **前端只调 `/ask`（+`/search`、`/root-cause`）**；`/agent/query`、`/agent/v2/query` 无前端调用方。
   ⇒ **面向用户的能力要做在 `/ask` 上**，做在 `/agent/*` 上等于没做（它们只存在于文档里）。
7. **`/ask` 跨轮会话记忆已实现**（2026-09-20，`agent/conversation-memory.ts` + 请求体可选 `sessionId`）：
   不传 `sessionId` ⇒ 行为与开启前逐字一致。三条硬约束：按 `repo_id` 过滤、
   `ORDER BY created_at DESC, id DESC`（同语句 `NOW()` 是事务时间戳，会打平）、
   **会话态必须绕过 `searchTTLCache`**（缓存键不含历史，命中会返回「无视上文」的答案且无异常）。
   ⚠️ 不要用「打开 v2 checkpointer」代替：累积 reducer + `round` 不重置 ⇒ 同 thread 第二问会继承第一问证据。
   答案引用自检 = `llm/answer-consistency.ts`，`/ask` 与 `/root-cause` 响应带 `consistency` 字段。
   ⚠️ **它是原生 SQL，不是 LangChain memory**：模块只 `import type { Pool } from 'pg'`（编译期擦除
   ⇒ 运行时零依赖）。`langchain` 包**没装**（`BufferMemory`/`ConversationSummaryMemory` 不可用）。
   ✅ **更正（2026-09-20）**：`@langchain/langgraph-checkpoint-postgres@1.0.5` **确实导出 `PostgresStore`**，
   但**只在子路径** `@langchain/langgraph-checkpoint-postgres/store`（根 `index` 只导 `PostgresSaver`；
   包 `exports` 含 `./store`）。早期「没提供 Store」的结论是只看了根入口 ⇒ **错的**。
   Store 需要 `CREATE EXTENSION vector` + 3 张表（`store`/`store_vectors`/`store_migrations`）——
   线上 **pgvector 0.7.0 已装**（PG 13.23，`code_chunks` 等已有 5 个 embedding 索引含 HNSW）
   ⇒ **基础设施零成本，能不能用不是问题**。真正的判据是**检索函数该不该是「相似」**：
   短追问（「那它呢」）的指代物就在**上一轮**，按向量近邻召回会把 20 轮前语义相似但对话无关的轮次捞回来
   ⇒ **当前需求是「近因」不是「相似」，Store 在这里不仅更贵、而且更差**。
   只有当需求真的右移（跨会话累积 / 语义召回历史 / 工具轨迹与偏好 / 多命名空间隔离）才值得换。
   另外 `docs/agent-unimplemented-design.md` 里 `conversation_memory → BaseStore` 只是**当初的设计映射**，
   不是实现记录 —— 实际用的是 `agent_conversations` 且不走 Store。

## 仓库与历史

- ⚠️ **仓库是公开的**（`Carpe912/CodeLens`）⇒ `.env.production`、`apps/web/.env.production`、
  `ecosystem.config.js` 里的 DeepSeek/Anthropic/DashScope key 与 DB 密码**已泄漏，待用户轮换**。
  新历史已排除这三类文件，但**排除 ≠ 止血**。配置说明留在 `ecosystem.config.example.js`（脱敏）。
  ⚠️ **2026-09-20 追加泄漏面（不在仓库里，在服务器磁盘上）**：
  `/var/log/codelens-api-error.log` 存着完整 git clone 命令行，内嵌明文凭据
  `https://leon.sun%40…:SUNlingyao0912@gitlab.logwire.cn/…` ⇒ 轮换清单**要加上 GitLab 账号密码/
  access token**，且**日志文件本身要清理**（74 MB 里可能不止一处）。
- 提交历史已重建**并已推送**：**76 条 → 27 条**按模块线性（原 76 条里 26 条标题就是 `#`）。
  远程 `origin` 的 `main` 就是这条新历史（`git ls-remote origin` 可核对），旧历史已强制覆盖。
  旧历史锚点 = 分支 **`main-before-rewrite`** 与 tag `backup-before-commit-rewrite`（同为 `6731ec0`）
  + `/tmp/codelens-git-backup/*.bundle`（原先的 `origin/main` = `8b1edef`）。
  ⚠️ **别 `git pull`**（会合并出旧历史，git 自己的提示在这里是错的），要改历史就用
  `git push --force-with-lease origin main`。
  报告：`/tmp/codelens-git-backup/COMMIT_REWRITE_REPORT.md`。
- `.gitignore` 已补：`apps/web/dist-preview`、`apps/web/dist.preview`、`*.tsbuildinfo*`、
  `ecosystem.config.js`、`.workbuddy/tmp/`。根因：`dist` 匹配不到 `dist-preview`、
  `*.tsbuildinfo` 匹配不到 `.bak.*`/`.stale.*` 变体 ⇒ 垃圾文件才被跟踪。
- 重建历史的方法论 + 6 个坑（备份 ref 取内容会丢未提交改动、覆盖率断言空转、quotepath 转义、
  并行编辑覆盖、孤儿分支禁 reset --hard、排除密钥≠止血）→ skill `git-history-module-rewrite`。

## 边界

- 索引器只认 **TS/JS/TSX/JSX 与 `.vue`**（Java/Python/Go 不入库）。
- 线上仓：29 `test-repo`（**勿动**）、30 `fastify`、33 `testwire-frontend`（**仅 33 重建过**）。
- 判命中不能按符号名判（关联命中 `symbol_name` 恒空）；BSD grep 的 `\|` 是字面量 → `-E`。
  （**这条已经重复踩过 3 次**，包括在核查 agent 是否用 LangGraph 时——写 grep 前先想一下要几个模式。）
- **v2 图 = `apps/api/src/agent/graph/`，真 LangGraph**（`@langchain/langgraph`），
  拓扑 `retrieve → grade →（回边）→ generate`，`maxRounds = min(config.maxReasoningRounds, 策略计划长度)`。
  ⚠️ **线上未开启**（`AGENT_GRAPH_ENABLED` 不在 pm2 进程 env、库里无 `checkpoint*` 表 ⇒ 从未执行过）；
  仅 `POST /agent/v2/query` 暴露，不替换 v1 三条路由。`grade` 是**规则判定**
  （`computeSufficiency()` 比阈值），**不是 ReAct**。自检：`pnpm --filter @codelens/api verify:graph`。
- ⚠️ **重写历史的副作用**：新历史每个提交只含该模块的「**最终内容**」，不含演进过程 ⇒
  被删除的文件（5 个 agent 占位类）在**新历史任何提交里都不存在**，`git show HEAD:<它们>` 必然失败。
  旧提交只在 `main-before-rewrite` / `backup-before-commit-rewrite` 上，
  **绝不要把这些旧 ref 推到远程**（含已泄漏的密钥）。依赖 git 考古的演示（如 `interview-prep/11` §491）
  应改为**把旧代码贴进材料**。
- 能力边界文档 = `docs/agent-unimplemented-design.md`（2026-09-20 已按线上实况修正，
  并新增「2026-09-20 已落地的两项」章节）。
- 自检脚本（都不需要数据库）：`verify:routes`、`verify:graph`、**`verify:memory`**（会话记忆/一致性/
  超时重试，47 项断言，纯函数）、`check:sql`。需要库的：`check:live-schema`（本地无 PG 会 ECONNREFUSED）。
- 真实库往返验证的**可复用套路**：把待验模块用 `tsc --module esnext` 单文件编译成 JS
  （type-only import 会被擦除 ⇒ 零运行时依赖），scp 到服务器 /tmp，`ln -s` 指到 app 的
  `node_modules` 以解析 `pg`，`{"type":"module"}` 使其按 ESM 解析，用隔离 session + `finally` 清理。
  服务器无 tsx ⇒ **不要**指望在服务器上跑 TS。
