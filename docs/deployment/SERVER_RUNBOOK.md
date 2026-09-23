# CodeLens 服务器部署与验证 Runbook

> 本文档描述**当前代码状态**下唯一正确的部署与验证流程。
>
> ⚠️ 同目录下的 `DEPLOYMENT_GUIDE.md` 是历史文档：它引用的
> `migrate-to-dashscope.sh`、`migrate-agent.cjs`、`agent_*` 表均已删除，
> 且使用了未定义的 `your-server`。请以本文档为准。

---

## 1. 目标环境

| 项 | 值 |
| --- | --- |
| 服务器 | `47.116.6.132`（root） |
| 部署目录 | `/root/CodeLens` |
| API 端口 | `8787`（Fastify，绑定 `0.0.0.0`） |
| 前端端口 | `5173`（`serve -s dist`） |
| PM2 应用 | `codelens-api`、`codelens-web` |
| 对外地址 | `https://sunlingyue.cn/code/`（前端）、`https://sunlingyue.cn/code-api/`（API） |
| 数据库 | `localhost:5432/codelens`（PG，口令见 `/root/CodeLens/.env.production`） |

> **`DEPLOY_DIR` 只有 `/root/CodeLens` 一个。** `deploy-server.sh` 历史上写的是
> `/opt/codelens`，会让「部署成功」与「实际运行的服务」指向不同目录，已统一。
> （`/opt/codelens` 确实存在，但是 2026-05-01 的 npm 残留，无人使用，可删。）

### 1.1 部署机制：**没有自动部署**（2026-09-18 实地核实）

关于「push 之后会自动部署」的印象，核实结论是**不成立**：

| 可能的自动部署来源 | 核实结果 |
| --- | --- |
| GitHub Actions / CI | 仓库**没有任何** `.github/workflows`、`.gitlab-ci.yml`、`Jenkinsfile` |
| 服务器上的 git 仓库 | **`/root/CodeLens` 和 `/opt/codelens` 都不是 git 仓库**（无 `.git`） |
| git hook（post-receive 等） | 无（因为压根没有 git 仓库） |
| 定时任务 | 唯一的宝塔 cron 是 **ACME 证书续期**（`acme_v2.py --renew_v2`），与部署无关 |
| 代码里的 webhook | 代码中的 "webhook" 全部是**索引别人的仓库**用的，非自身部署 |

所以：**部署是手动的**，且因为服务器上没有 git 仓库，
真实机制是**本地构建 → `scp` 上传 → `ssh` 执行服务器端步骤**（`scripts/deploy.js`）。

> 推论：`deploy-server.sh` 里的 `git pull` **在这台服务器上不可能成功**。
> 它只适合「服务器上直接改了代码」的场景；正常发版请用本地 `pnpm deploy`。

---

## 2. 部署前：本地自检（不需要数据库）

本地没有 PostgreSQL，因此这几条是**唯一能在部署前拦住问题**的闸门：

```bash
pnpm typecheck                 # 三端类型检查
pnpm build:api                 # 必须先通过，产物要上传
pnpm --filter @codelens/api check:sql       # SQL ↔ schema 漂移（0 条才算过）
pnpm --filter @codelens/api verify:routes   # 路由注册（应为 50 条 ALL PASS）
pnpm --filter @codelens/api check:llm       # LLM 链路（真实调用一次，需配好密钥）
```

`check:llm`：改过 LLM 相关代码或切换厂商后必跑。它是**真实发起一次调用**，
能一次性暴露密钥失效（401）、模型名不被接受（400）、baseURL/网络错误——
这些都不会被类型检查发现。详见第 8 节。

`check:sql` 的意义：本项目曾长期存在「SQL 引用不存在的列」这类**只在运行时才炸、
且被 try/catch 静默吞掉**的坏账（`call_graph.repo_id` / `to_chunk_id` 即为此例）。
它在离线状态下还原 schema（`CREATE TABLE` + `ALTER TABLE ADD COLUMN`），
再校验每一段 SQL 字符串里的列引用。

### ⚠️ 2.0 还有一个**反向**检查，必须连库跑：`check:live-schema`

`check:sql` 检查的是「源码 SQL → 代码还原的 schema」。它默认
「代码里 `CREATE TABLE` 写了这列，库里就有这列」—— **这个前提是错的**。
`CREATE TABLE IF NOT EXISTS` 在表已存在时是彻底 no-op，不会补列。

`check:live-schema` 补上这个缺口：**连上真实数据库**，逐表比对列，
报告「代码假定有、真实库没有」的列，并区分：

- **[自愈]** 代码里有 `ADD COLUMN IF NOT EXISTS` 兜底 → 启动时自动补
- **[地雷]** 没有任何兜底 → 一旦被 SQL 引用就失败（被 catch 包住则静默吞掉）

```bash
# 本地（若有库）
pnpm --filter @codelens/api check:live-schema

# 服务器上（只有 dist，没有 src，脚本会自动改用 dist/db/index.js）
cd /root/CodeLens && node --env-file-if-exists=.env.production \
  apps/api/dist/scripts/check-live-schema.js
```

**部署前先在服务器上跑这个**，能一次性列出所有同类地雷，避免「换完 dist 才发现起不来」。

### ⚠️ 2.1 依赖完整性检查（**必须做，漏了会把服务搞挂**）

`deploy.js` 的旧流程会把服务器 `node_modules` 整个删掉再 `pnpm install --prod`。
但本项目实际部署时这台服务器上**没有跑 pnpm install**，导致 `node_modules` 长期残缺 ——
它只够支撑「当时那一版」代码。一旦新代码引入了新依赖，交换 `dist` 后进程会
**直接起不来**（PM2 显示 online 但端口不监听，因为在崩溃重启循环）。

真实事故（2026-09-18）：部署后 `@langchain/langgraph` 找不到：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@langchain/langgraph'
  imported from /root/CodeLens/apps/api/dist/agent/graph/index.js
```

原因：新代码的 Agent 编排层引入了 `@langchain/*` 与 `zod`，
而服务器上这 5 个包从未安装过。

**所以：交换 `dist` 之前，先算清新 dist 的外部依赖，逐个确认在服务器上存在。**

```bash
# 1) 本地：列出 dist 真正 import 的外部包
node -e '
const fs=require("fs"),path=require("path");const set=new Set();
(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
 if(e.isDirectory())w(p);else if(e.name.endsWith(".js")){
   const t=fs.readFileSync(p,"utf8");const re=/(?:from|import)\s*\(?\s*["\x27]([^"\x27]+)["\x27]/g;let m;
   while((m=re.exec(t))){const s=m[1];if(s.startsWith(".")||s.startsWith("node:"))continue;
     const q=s.split("/");set.add(s.startsWith("@")?q.slice(0,2).join("/"):q[0]);}}}})("dist");
console.log([...set].sort().join("\n"));'

# 2) 服务器：逐个确认存在（注意 @scope 包要按子目录查）
for m in @langchain/langgraph @langchain/core zod ...; do
  [ -d "/root/CodeLens/apps/api/node_modules/$m" ] && echo "OK   $m" || echo "MISS $m"
done
```

有缺失时，**先装依赖再换 dist**：

```bash
# 上传本地 lockfile（依赖变了就必须同步）
scp pnpm-lock.yaml root@47.116.6.132:/root/CodeLens/

# 在服务器上（先备份，见 3.1）
cd /root/CodeLens && pnpm install --prod
```

> 经验：`pnpm install --prod` 只删除 devDependencies，不会动既有生产包，
> 因此对运行中的进程是安全的（进程的模块已加载在内存里）。
> 但**装完必须重启**才会生效。

---

## 3. 部署

### 方式 A：本地一键（推荐）

```bash
# 普通部署（不重建关系图）
pnpm deploy

# 同时重建关系图（改了关系构建逻辑、或刚跑完 004 迁移后需要）
REBUILD_GRAPH_REPO_IDS=1 pnpm deploy
```

内部流程（`scripts/deploy.sh` → `scripts/deploy.js`）：
本地构建 → `scp` 上传 → 服务器 `pnpm install --prod` → **执行迁移** → 按需重建关系图 → `pm2 restart` → 验证。

### 方式 B：服务器上手工执行

```bash
ssh root@47.116.6.132
cd /root/CodeLens
REBUILD_GRAPH_REPO_IDS=1 bash deploy-server.sh
```

### 关键点：迁移用的是「台账执行器」，不是 `psql -f`

```bash
node --env-file-if-exists=.env.production apps/api/dist/scripts/migrate.js
```

- 台账 = `schema_migrations` 表，记录哪些迁移已执行，避免破坏性迁移（`002` 会按新
  维度重建 embedding）被重复执行。
- 用 `node` 跑**编译产物**而不是 `tsx`，因为服务器上装的是 `pnpm install --prod`，
  `tsx` 属于 devDependencies，装不上。
- `--env-file-if-exists` 用于补齐手动执行时缺失的环境变量（PM2 的 `env_production`
  只作用于 PM2 启动的进程，不会自动出现在你的 shell 里）。

---

## 4. 数据侧：关系图必须单独重建

`004_fix_call_graph_and_file_dependencies.sql` **只修表结构，不回填数据**。
迁移后 `call_graph` / `file_dependencies` 仍然是空的，必须重建：

```bash
cd /root/CodeLens
node --env-file-if-exists=.env.production apps/api/dist/scripts/rebuild-graph.js <repoId>
```

`rebuild-graph` 只做「AST 分析 → 建关系 → 物化文件依赖边」，**完全不碰 embedding**：

| | rebuild-graph | reindex |
| --- | --- | --- |
| 重建 `import_relations` / `call_graph` / `file_dependencies` | ✅ | ✅ |
| 重新生成向量（真实花钱、耗时） | ❌ 不碰 | ✅ |
| 适用场景 | 改 schema / 改关系构建逻辑 | 文件内容变了 |

> `rebuild-references` **不能**用来重建依赖图：它给 `buildRelationships` 传的是
> `imports: []` / `functions: []` 的空结果，`import_relations` 与 `call_graph`
> 根本不会被重建。

脚本会打印重建前后的行数对比、未解析调用边的比例，以及失败文件清单。
失败文件占比 > 5% 时退出码为 1（避免「跑完了但没数据」被当成成功）。

---

## 5. 验证

### 5.1 能力自述端点（首选，一行搞定）

```bash
curl -sf http://localhost:8787/impact | python3 -m json.tool
```

它会直接告诉你图数据的真实行数，以及不完整时**为什么**不完整：

```json
{
  "dataSources": {
    "callGraphEdges": 1234,
    "unresolvedCallEdges": 87,
    "fileDependencyEdges": 456,
    "internalImportEdges": 456
  },
  "warnings": []
}
```

`warnings` 非空即为数据没就绪，逐条给出了下一步动作。
**这是特意设计的**：让「图数据没构建」表现为一条明确警告，而不是
「影响面 = 0」这种看起来正常、实则错误的结果。

### 5.2 数据库侧计数

```bash
psql -U postgres -d codelens -c "
SELECT
  (SELECT COUNT(*) FROM import_relations)                          AS imports,
  (SELECT COUNT(*) FROM call_graph)                                AS call_edges,
  (SELECT COUNT(*) FROM call_graph WHERE to_chunk_id IS NULL)      AS unresolved,
  (SELECT COUNT(*) FROM file_dependencies)                         AS file_edges;
"
```

`call_edges` 必须 > 0。若为 0，说明 `rebuild-graph` 没跑或跑失败。

确认迁移已记录：

```bash
psql -U postgres -d codelens -c "SELECT version, applied_at FROM schema_migrations ORDER BY version;"
```

应看到 `004_fix_call_graph_and_file_dependencies`。

### 5.3 逐接口验证

```bash
# 文件级：改这个文件会波及谁
curl -sf "http://localhost:8787/impact/file?repoId=1&path=src/index.ts&maxDepth=3"

# 符号级：改这个函数会波及谁
curl -sf "http://localhost:8787/impact/symbol?repoId=1&symbolName=<函数名>&maxDepth=3"
```

预期与语义：

- 正常 → 返回按 `depth` 分组的受影响文件/符号。
- `404` → 文件/符号不存在（先确认路径是**仓库内相对路径**）。
- `409` → 符号名有歧义（同名符号多处定义）。响应会列出候选 `chunkId`，
  带上 `&chunkId=<id>` 重试即可。**接口不会替你猜。**
- 响应中的 `unresolvedEdges` > 0 → 有调用边没解析到定义，这些边不计入影响面，
  真实影响面可能更大。这是如实告知，不是 bug。
- `warnings` 里出现「数据未构建」→ 回到第 4 步。

---

## 6. 排障

### 6.1 迁移/脚本报 `ECONNREFUSED`

脚本现在会打印完整原因（含底层 IPv6/IPv4 两次尝试）和目标库地址：

```
Migration Failed!
目标库：localhost:5432/codelens as postgres
================================================================
AggregateError [ECONNREFUSED]
    (该错误的 message 为空)
    底层错误（2 项）:
      - Error [ECONNREFUSED]: connect ECONNREFUSED ::1:5432
      - Error [ECONNREFUSED]: connect ECONNREFUSED 127.0.0.1:5432
    → 检查：数据库/Redis 是否已启动、host/port 是否正确、安全组是否放行。
```

处理：

```bash
systemctl status postgresql
systemctl start postgresql
netstat -tlnp | grep 5432
```

> 为什么特意强调这条：`pg` 在 IPv4/IPv6 都连不上时抛的是 **`AggregateError`**，
> 而它的 `message` 是**空字符串**。原先脚本用 `console.error(error.message)` 输出，
> 结果是一整块空白 —— 运维只能靠猜。现在统一走 `describeError()` 展开底层 `errors[]`。

### 6.2 `password authentication failed`（`28P01`）

脚本会提示检查 `DB_USER` / `DB_PASSWORD`。手动执行时最容易踩的坑是：
**PM2 的环境变量不会自动出现在你的 shell 里**，需要靠
`--env-file-if-exists=.env.production` 补上。确认该文件存在且口令正确。

### 6.3 `/impact` 返回 `warnings` 但表里有数据

看警告文案区分两种情况：

- 「`file_dependencies` 为空但 `import_relations` 有数据」→ 依赖边未物化，
  跑 `rebuild-graph`。
- 「`call_graph` 为空」→ 调用图没建，跑 `rebuild-graph`。
- 「仓库尚未索引」→ 先索引仓库。

### 6.4 部署后 API 起不来

```bash
pm2 logs codelens-api --err --lines 50
```

检查 `dist` 是否完整。**注意一个容易踩的坑**：`apps/api/tsconfig.tsbuildinfo`
位于 `dist` **之外**。如果只删 `dist` 而保留这个增量构建清单，`tsc` 会认为
「无需重新生成」，从而只产出改动过的几个文件，得到一个**残缺的 dist**。
因此 `build` 脚本是：

```json
"build": "rm -rf dist tsconfig.tsbuildinfo && tsc -p tsconfig.json"
```

---

## 7. 首次上线实测记录（2026-09-18，服务器 `47.116.6.132`）

上一版本这里写的是「未验证项」。本轮已在生产服务器上**实际部署并验证**，
结论如下（原始结论保留在 7.3，供对照）。

### 7.1 已验证通过

| 项 | 实测结果 |
| --- | --- |
| 迁移台账 | `001`/`002`/`003`/`004` 全部执行成功并入库 `schema_migrations` |
| 向量安全 | `002` 正确走「跳过」分支：`vector(1536)` 未变，257/103/10 条向量全在 |
| 触发器 | `trigger_update_file_dependency` 已创建（此前因 001 无法执行而从未存在） |
| `call_graph` 去重 | 337 → 333（004 的去重确实删掉了 4 条重复边） |
| **递归 CTE 实际执行** | ✅ `/impact/symbol` 返回真实传递闭包结果 |
| 符号级影响面 | `createOrderRequest` → 2 个受影响方法（`cancelOrder`、`returnOrder`），含 `pathChain` |
| 歧义拒绝猜测 | `constructor`（10 个定义）→ **409** + 全部候选 `#chunkId(file:line)` |
| 文件级影响面 | ✅ 200，且诚实返回 `warnings`（该仓库无 `import`，`file_dependencies` 本就为空） |
| 错误处理 | 不存在路径 → 404；缺参数 → 400 |
| 数据诚实性 | `/impact` 明确回报 `unresolvedCallEdges: 181`（54.4%）与数据缺口警告 |
| 启动自愈 | `repos` 的 5 个缺失列在启动时被 `ADD COLUMN IF NOT EXISTS` 自动补齐 |

`check:sql`：181 条 SQL 字符串 / 15 张表，0 处幽灵列。
`verify:routes`：50 条路由（含 3 个 `/impact` 端点）全部注册成功。

### 7.2 `call_graph` 未解析边比例（实测）

**181 / 333 = 54.4%** 的调用边无法解析到定义。这些边**不进图**，接口通过
`unresolvedEdges` 如实告知。成因：该测试仓库大量调用第三方库方法与动态属性，
这些没有仓内定义可解析。

> 注意：`test-repo` 的 14 个文件**没有任何 `import` 语句**，因此
> `import_relations` 与 `file_dependencies` 为 0 **是正确的**，
> 不是构建失败。要在文件级影响面上看到数据，需要一个真正有仓内导入的仓库。

### 7.3 本轮部署暴露的 3 个真实故障（都值得记住）

1. **依赖残缺 → 服务崩溃循环**。`@langchain/*` 与 `zod` 从未在服务器安装。
   换完 dist 后 `ERR_MODULE_NOT_FOUND`，PM2 显示 `online` 但 8787 不监听。
   → 见 2.1 的依赖完整性检查。
2. **`repos` 缺 5 列 → 服务起不来**。`initDatabase` 里
   `CREATE INDEX ON repos(gitlab_url)` 抛 `42703`，而 catch 只忽略 `23505`，
   异常冒到调用方。根因是 `CREATE TABLE IF NOT EXISTS` 不补列。
   → 已在 `db/index.ts` 加 `ADD COLUMN IF NOT EXISTS` 兜底；
   → 新增 `check:live-schema` 系统性排查同类问题（当时一次性列出全部 5 列）。
3. **`001` 不可重放 → 迁移从未成功过**。44 处 `CREATE INDEX` 缺 `IF NOT EXISTS`，
   `CREATE TRIGGER` 也没有（Postgres 本就无此语法）。在任何「表已存在」的库上
   001 都会中途报错回滚。→ 已全部补成幂等写法 + `DROP TRIGGER IF EXISTS`。

### 7.4 仍然未验证

- **多仓库并发 / 大仓库规模下的表现**：本轮只在一个 14 文件的测试仓库上验证过。
- **`/impact` 的语义精度**：结果「看起来对」（改 `createOrderRequest` 波及同文件的
  `cancelOrder`/`returnOrder`），但尚未用人工标注集核对准确率。
- **未解析边的 54.4% 是否可接受**：取决于调用解析策略是否需要增强（如跟踪
  `require()` / 第三方方法名匹配）。

---

## 8. LLM 厂商切换（Anthropic → DeepSeek，2026-09-18 已上线）

### 8.1 结论先行

线上问答链路已切到 DeepSeek，实测可用。**切换只改配置，不改调用点**：
`llm/client.ts` 提供厂商适配层，上层（`llm/qa.ts`、`agent/core.ts`）通过
`client.messages.create(...)` 调用，形状与 Anthropic 一致，因此换厂商不动业务代码。

| 项 | 值 |
|---|---|
| Provider | DeepSeek（代码内固定为单一 provider；`LLM_PROVIDER` 已移除） |
| 模型 | `LLM_MODEL=deepseek-chat`（稳定别名，实际生效 `deepseek-flash`） |
| Base URL | `https://api.deepseek.com` |
| 备选模型 | `deepseek-v4-pro`（推理模型，更强但更慢；推理 token 会占用 `max_tokens`） |
| 嵌入 | **与 LLM 厂商无关**，仍走 `EMBED_*`（DashScope `qwen3.7-text-embedding`，`EMBED_DIMENSIONS=1536`）——DeepSeek 不提供嵌入模型 |

> 为什么要适配层而不是直接改 `qa.ts`：调用点有 3 处（`qa.ts`×2、`agent/core.ts`×1）
> 且**模型名写死为 `claude-sonnet-4-6`**。直接改等于把「厂商」和「模型名」两件事
> 散落到多个文件，回滚要改代码。适配层把模型名归一化，Claude 风格的名字会自动
> 映射成当前厂商的默认模型——所以上层连模型名都不用改。

### 8.2 ⚠️ 真正的配置来源是 `ecosystem.config.js`，不是 `.env.production`

这是本次最容易踩的坑：**PM2 的 `env_production` 才是线上生效的变量**，
根目录 `.env.production` 只对「手动执行的脚本」生效（且脚本必须显式加
`--env-file-if-exists=.env.production`）。

两个文件当时还有**实际冲突**：`.env.production` 用 `xiaocaseai` 做嵌入，
而 `ecosystem.config.js` 用 DashScope。线上以 `ecosystem.config.js` 为准。

**切 LLM 时必须同步改 `ecosystem.config.js` 的 `env_production`**，否则：
- 只改 `.env.production` → 进程读不到 `DEEPSEEK_API_KEY`，切换静默失败；
- 反之若删掉 `ANTHROPIC_*` 又没加 `DEEPSEEK_*` → `validateEnv()` 直接 `exit(1)`。

**不要在切换 LLM 时顺手「统一」嵌入配置**——嵌入与 LLM 厂商无关，改了会破坏向
量检索（现有向量是 1536 维 `qwen3.7-text-embedding` 产物）。

### 8.3 变更清单（本次实际改了哪些）

| 文件 | 改动 |
|---|---|
| `apps/api/src/llm/client.ts` | **新增**。厂商适配层：`getLlmClient()` 单例、`resolveProvider()`、`resolveModel()`、`getResponseText()`、`describeLlmConfig()` |
| `apps/api/src/llm/qa.ts` | 改用 `getLlmClient()`；去掉写死的 `claude-sonnet-4-6` |
| `apps/api/src/agent/core.ts` | `llm` 类型改为 `LlmClient`；去读 `ANTHROPIC_API_KEY` |
| `apps/api/src/agent/types.ts` | `AgentDependencies.llm` 类型改为 `LlmClient` |
| `apps/api/src/server/context.ts` | `anthropic` 单例 → LLM 客户端；保留旧导出名以不触碰 7 个路由文件 |
| `apps/api/src/index.ts` | **`validateEnv()` 改为按 provider 校验**（原先写死只认 `ANTHROPIC_*`，会导致服务起不来） |
| `apps/api/src/indexing/indexer.ts` | **去掉「无 `ANTHROPIC_API_KEY` 就跳过增强索引」的门禁**（见 8.4） |
| `apps/api/src/indexing/enhanced-indexer.ts`、`src/retrieval/multi-strategy-search.ts` | 删掉「只赋值、从不读取」的 Anthropic 死字段 |
| `apps/api/package.json` | 新增 `check:llm` |
| `apps/api/src/scripts/check-llm.ts` | **新增**。真实调用一次当前厂商，验证密钥/模型名/网络 |
| `ecosystem.config.js` | `env_production` 增加 `LLM_PROVIDER`/`LLM_MODEL`/`DEEPSEEK_*` |

**零新增依赖**：DeepSeek 是 OpenAI 兼容协议，而 `openai` 包本就是本项目直接依赖
（`llm/embeddings.ts` 在用）且已在服务器安装。这条很重要——见 2.1，漏装依赖
曾直接把服务搞挂。

> 🗓️ **后续变更（2026-09-23）**：LLM 客户端已改用 `@langchain/openai` 的 `ChatOpenAI`
> （`refactor(llm)` 提交），因此 **LLM 路径不再复用 `openai` 包** —— 上面这条「零新增依赖」
> 只描述了 DeepSeek 切换当时的做法。`openai` 包现在仅由 `llm/embeddings.ts` 使用。

### 8.4 切换时一并修掉的两个「静默失效」地雷

换厂商会暴露那些**把具体厂商当成硬前提**的代码。这次发现两处，都属于「不报错、
但功能悄悄没了」：

1. **启动门禁**：`validateEnv()` 只认 `ANTHROPIC_AUTH_TOKEN/API_KEY`，否则
   `process.exit(1)`。切到 DeepSeek 且移除 Anthropic 凭据后，**服务根本起不来**。
   → 已改为按 `LLM_PROVIDER` 校验对应凭据。
   （🗓️ 后续：`LLM_PROVIDER` 本身也已移除，现为固定校验 `DEEPSEEK_API_KEY`
   与 `EMBED_API_KEY` —— 见 8.6）
2. **增强索引被静默跳过**：`indexing/indexer.ts` 曾以「`ANTHROPIC_API_KEY` 是否存在」
   作为是否运行 AST 增强索引的开关。但 `EnhancedIndexer` **只做 AST 分析，不调用
   任何 LLM**（它那个 Anthropic 字段只赋值、从未读取，注释里写的「用于向量生成」
   本身就不成立）。后果：切到 DeepSeek 后符号表/调用关系/依赖图全部为空，
   `/impact` 随之失效，**而日志里只有一行 warning**。
   → 已改为无条件执行。

教训：**改厂商前，先搜一遍「所有读该厂商密钥的地方」**，逐个判断它是真的要用，
还是把密钥当成了某种「功能已启用」的代替信号。

### 8.5 部署与验证步骤（实测命令）

```bash
# 0) 切之前先确认新产物 + 网络 + 密钥都通（此时线上还没动）
ssh root@47.116.6.132 'cd /root/CodeLens && \
  node --env-file-if-exists=.env.production apps/api/dist.new/scripts/check-llm.js'

# 1) 上传新产物到 dist.new，再原子替换（保留 dist.prev.<ts> 作为回滚点）
scp -r apps/api/dist root@47.116.6.132:/root/CodeLens/apps/api/dist.new
ssh root@47.116.6.132 'cd /root/CodeLens/apps/api && \
  mv dist dist.prev.$(date +%Y%m%d_%H%M%S) && mv dist.new dist'

# 2) 上传 ecosystem.config.js（配置真正的来源），重启时必须带 --update-env
scp ecosystem.config.js root@47.116.6.132:/root/CodeLens/
ssh root@47.116.6.132 'cd /root/CodeLens && \
  pm2 restart ecosystem.config.js --env production --update-env'

# 3) 确认启动日志里 provider 真的换了
ssh root@47.116.6.132 'grep -aE "\[LLM\]|Agent initialized" /var/log/codelens-api-out.log | tail -2'
```

预期日志：

```
[LLM] provider=deepseek model=deepseek-chat
[Server] Agent initialized (LLM: provider=deepseek model=deepseek-chat baseURL=api.deepseek.com apiKey=已配置)
```

### 8.6 回滚

⚠️ **已不存在「切回 Anthropic」的配置回滚路径**：`LLM_PROVIDER` 与 `ANTHROPIC_*`
已随依赖一并从代码中移除（2026-09-23），要重新启用必须改代码并重新引入依赖。

若整包回退代码：`git checkout` 后重新构建，或直接用服务器上保留的
`apps/api/dist.prev.<时间戳>` 换回来。

### 8.7 实测结果（2026-09-18）

| 验证项 | 结果 |
|---|---|
| 本地 `check:llm` | PASS，578ms，生效模型 `deepseek-flash` |
| 服务器 `check:llm`（切换前，指向 dist.new） | PASS，647ms |
| 服务器 `check:llm`（切换后，指向 dist） | PASS |
| `POST /ask`（URL 型查询，走 `searchURL`，不需要 embedding） | **200**，4.21s，10 条证据，答案正确列出 `/api/orders` 的 3 处定义位置（`test-repo/src/api/orderApi.js:13/23`…） |
| `POST /ask`（普通查询，走向量检索） | **401** —— 但**不是 LLM 的问题**，是嵌入密钥失效，见 8.9 |
| 启动日志 | `provider=deepseek model=deepseek-chat` |
| 切换后报错数 | **0** |
| 既有端点回归 | `/health` 200、`/impact` 200、`/impact/symbol` 200、`/repos` 200、`/search` 200 |
| `tsc --noEmit` / `check:sql` / `verify:routes` | 全通过；`check:sql` 182 条 SQL / 0 幽灵列；`verify:routes` 50 条路由 ALL PASS |

> 顺带确认两个**不是**回归的现象：`/search` 与 `/call-graph` 曾返回 400，是因为
> 参数名写错（`/search` 要 `q=` 不是 `query=`；`/call-graph` 需要 `symbolName`），
> 报文即 `{"error":"Missing repoId or q"}`。`/impact/file` 的 404 则是路径要以
> `test-repo/` 开头——都是调用姿势问题，不是代码问题。

### 8.8 ⚠️ 安全债（建议尽快处理）- **`.env.production` 已被 `.gitignore` 收录，但依然被 git 跟踪**。
  这是 `.gitignore` 最容易误解的一点：**忽略规则对「已入库的文件」不生效**。
  该文件在加规则之前就已提交，因此后续改动仍会正常入库。
  `git check-ignore .env.production` 返回空，**不代表它是安全的**——
  要用 `git ls-files` 判断是否被跟踪。
  其中明文包含 DB 密码、Anthropic token、DashScope key、DeepSeek key。

  修复：
  ```bash
  git rm --cached .env.production        # 停止跟踪，保留本地文件
  # .gitignore 已有该规则，无需再加
  ```

- **`ecosystem.config.js` 是正常跟踪的部署配置，但里面同样硬编码了全部密钥**
  （这是它的特性，PM2 靠它注入 env）。若要彻底脱敏，需改成从外部读取，
  或接受「此文件按机密管理」的现状。

- **`apps/api/.env.example` 里曾硬编码真实 DashScope key**，已替换为占位符。
  `.env.example` 是模板文件，**永远不该出现真实密钥**。

- **密钥进过 git 历史就等于已泄漏**：`git rm --cached` 只是停止跟踪，
  历史提交里仍有明文。必须**轮换全部已泄漏的密钥**（DB 密码、Anthropic token、
  DashScope key、DeepSeek key）。历史里另有 `migrate-to-dashscope.sh` 的硬编码 key，
  同样建议轮换。



---

## 9. ⚠️ 另一个独立故障：嵌入密钥已失效（与 LLM 切换无关）

**这条是本次切换过程中顺带发现的，成因与 LLM 换厂商完全无关，但它会让 `/ask` 报 401，
很容易被误认为「换 LLM 换坏了」。**

### 9.1 现象

普通查询调 `POST /ask` 返回 **401**：

```json
{"statusCode":401,"code":"invalid_api_key","error":"Unauthorized",
 "message":"401 Incorrect API key provided. For details, see: https://help.aliyun.com/zh/model-studio/error-code#apikey-error"}
```

注意报文里是 **`aliyun.com`** —— 这不是 DeepSeek，而是**嵌入服务（DashScope）**。
调用栈清楚指向嵌入生成：

```
at async generateEmbedding (apps/api/dist/llm/embeddings.js:74)
at async MultiStrategySearch.generateQueryEmbedding (multi-strategy-search.js:866)
at async MultiStrategySearch.vectorSearch (multi-strategy-search.js:405)
at async MultiStrategySearch.search (multi-strategy-search.js:87)
```

### 9.2 判定：不是本次改动引入的

三条证据：

1. **密钥本身就是坏的**（与应用代码无关，直接打接口即失败）：
   | 配置位置 | 密钥来源 | 实测 |
   |---|---|---|
   | `ecosystem.config.js`（线上实际生效） | DashScope `sk-4002f0…` | **401 invalid_api_key** |
   | `.env.production` | xiaocaseai `sk-Krq1GA…` | **401 该令牌已过期** |

2. `git diff` 证明本次**没有改动任何 `EMBED_*` / `DASHSCOPE_*` 的值**
   （只有注释行被修改）。LLM 与嵌入是两条独立链路，DeepSeek 也不提供嵌入模型。

3. 日志里 `invalid_api_key` **只出现在本次排查时间点**，历史 `/ask` 请求（5 月为主）
   没有同类报错——说明该密钥是**后来失效/被吊销**的，与今天无关。

### 9.3 影响范围（重要，容易低估）

向量检索是 `/ask`、`/search`（enhanced）等的主检索路径。嵌入不可用意味着：

- **语义检索失效**，只能靠关键词/URL 等不依赖嵌入的策略兜底；
- **接口不是「降级成功」而是直接 401 抛出** —— `vectorSearch` 的异常经
  `Promise.all` 冒到路由层，被 Fastify 当成未处理异常返回。
  这是**缺少降级**：一个检索子策略失败，整个问答就不可用。
- 库里已有的 1536 维向量仍完好，但**查询侧无法生成新向量**，等于有索引不能用。

对照实测：URL 型查询（走 `searchURL`，不碰嵌入）**200 正常**；
普通查询 100% 401。这个对比正是定位该问题的钥匙。

### 9.4 处置记录（2026-09-18 已完成）

1. **换用有效密钥**（`ecosystem.config.js` 与 `.env.production` 已同步）：
   `EMBED_MODEL=qwen3.7-text-embedding`，`EMBED_DIMENSIONS=1536`。
   ⚠️ 该模型**原生维度是 1024**，靠 `EMBED_DIMENSIONS=1536` 指定为 1536 才与既有
   `vector(1536)` 列兼容。**这个值不能随手改**，否则与库里向量不兼容。
2. **重建全部向量**：新增 `apps/api/src/scripts/reembed.ts`（`pnpm --filter @codelens/api reembed`）。
   实测 **1195 行全部成功、0 失败、耗时 34 秒**：

   | 表 | 总行数 | 已更新 | 跳过 | 失败 |
   |---|---|---|---|---|
   | code_chunks | 257 | 257 | 0 | 0 |
   | functions | 103 | 103 | 0 | 0 |
   | classes | 10 | 10 | 0 | 0 |
   | string_constants | 760 | 760 | 0 | 0 |
   | url_patterns | 65 | 65 | 0 | 0 |

   注意 `url_patterns` 原先 65 行**一个向量都没有**、`string_constants` 760 行只有
   152 个——这是历史上就没生成过（不是过期），本次一并补齐。
3. **验证通过**：
   - 数据层：同一 chunk 文本的新旧向量余弦相似度从 **0.036 → 0.93**；
   - 功能层：`POST /ask` 普通查询（走向量检索）从「200 但证据为空」恢复为
     **200 + 10 条证据**，答案能跨文件归纳（同时指出 `OrderApi` 与 `DynamicOrderApi`
     两种风格，并识别出同类中混用 `axios` 与 `fetch`）。
   - 既有端点全部 200：`/health`、`/repos`、`/impact`、`/impact/symbol`、`/impact/file`、`/search`。

### 9.5 仍未做

- ~~**rerank 仍未实现**~~ → **本次已实现，见第 10 节**。
  （历史状态留档：`DASHSCOPE_RERANK_MODEL` 曾是纯配置占位、全仓无代码读取，
  `search.ts` 那句 `console.log('...reranking')` 只是假象。）
- **检索缺降级**：见 9.3，单个检索子策略失败会让整个 `/ask` 挂掉，建议补 try/catch 降级。
- 建议把 `reembed` 写进「换嵌入模型」的标准流程：**换模型 → 重刷向量 → 验证 `/ask`**。

---

## 10. rerank 精排（本次新增功能）

### 10.1 背景：项目里的「重排」原本只是规则打分

复核结论（区分两种"重排"，避免混淆）：

| | 位置 | 性质 |
|---|---|---|
| 规则式重排（**原本就有**） | `retrieval/multi-strategy-search.ts` `mergeResults()`：按意图加权 → 多策略命中 +0.1 → 按分排序；`deduplication.ts` 去重/平均分合并 | 纯打分函数，**不调模型** |
| 模型精排（**原先不存在**） | 无 | 无调用点、无 SDK、无代码读配置 |

所以「配了 `qwen3.7-text-rerank` 却没生效」不是配置问题，而是**功能缺失**。

### 10.2 实现

- 新增 `apps/api/src/retrieval/rerank.ts`：封装 DashScope 原生接口
  `POST {RERANK_BASE_URL}/api/v1/services/rerank/text-rerank/text-rerank`。
  兼容两种响应形状（`output.results` 与顶层 `results`），见该文件头注释。
- 接入点 `multi-strategy-search.ts`：
  1. 开启时把召回宽度从 `limit` 放宽到 `RERANK_CANDIDATES`（默认 50）——**精排的前提是宽召回**；
  2. 规则融合 + 去重之后，`applyRerank()` 调模型对候选打语义分；
  3. 用 rerank 分覆盖 `score` 并重排，重排前分数存进 `metadata.preRerankScore`；
  4. 再按 `limit` 截断。URL 分支同样走精排。
- 配置（**PM2 `env_production` 为准**）：
  `RERANK_ENABLED` / `RERANK_MODEL` / `RERANK_API_KEY` / `RERANK_BASE_URL` /
  `RERANK_CANDIDATES` / `RERANK_TIMEOUT_MS`。
  未设 `RERANK_MODEL`/`RERANK_API_KEY` 时回退 `DASHSCOPE_RERANK_MODEL` / `DASHSCOPE_API_KEY`。

### 10.3 容错（关键设计）

- **失败必降级**：调不通/超时/配额不足时只打警告并**回退规则排序**，检索不会失败。
- **失败冷却 60s**：避免每次检索都白等一次超时（`isRerankCoolingDown()`）。
- **默认关闭**：`RERANK_ENABLED` 非 `'true'` 时行为与历史版本完全一致。

### 10.4 验证（本地已完成）

```
pnpm --filter @codelens/api check:rerank      # 或服务器上：
node --env-file-if-exists=.env.production apps/api/dist/scripts/check-rerank.js
```

- 自检通过：`qwen3.7-text-rerank` 真实调用 200，耗时 ~280ms，
  相关文档 0.9413 / 弱相关 0.1399 / 无关 0.1164 —— **模型真的在按语义排序**。
- 链路验证：`applyRerank` 把原本排第 2 的 `calculateOrderTotal` 提到第 1（0.9450 > 0.9000）；
  换成错误密钥时打印降级警告并**保持原顺序**。
- 启动日志新增一行 `[Server] Retrieval (rerank: ...)`，可直接从 PM2 日志确认是否启用。

### 10.5 部署注意

- rerank 是**新增代码**，不是改配置：必须重新构建并 `scp dist/` 到服务器，再
  `pm2 restart codelens-api --update-env`。只改 ecosystem 里的 `RERANK_ENABLED` 不会生效。
- 若换非 DashScope 的重排服务，除 `RERANK_BASE_URL` 外还需改 `rerank.ts` 的请求/响应结构。

### 10.6 部署记录（2026-09-18 17:16，已上线）

按「新产物先在服务器自检 → 再原子替换 → 再重启」的顺序执行：

1. 备份：`ecosystem.config.js.bak.20260918-171541`、`.env.production.bak.20260918-171541`
   （回滚点：`apps/api/dist.prev.20260918-171614`）
2. 上传 `dist` → `dist.new`（61 个 js，含 `index.js` / `retrieval/rerank.js` / `scripts/check-rerank.js`）
3. **动线上前先自检**：`node --env-file-if-exists=.env.production apps/api/dist.new/scripts/check-rerank.js`
   → PASS，耗时 427ms，排序正确
4. 原子替换 + `pm2 restart ecosystem.config.js --only codelens-api --env production --update-env`

**线上验证结果**：

| 检查项 | 结果 |
|---|---|
| 启动日志 | `[Server] Retrieval (rerank: qwen3.7-text-rerank @ dashscope.aliyuncs.com（候选 50，超时 3000ms）)` |
| 重启后新增错误 | **0** 条 |
| 降级警告 | 无（说明模型调用一直成功） |
| `/health` | `{"ok":true}` |
| `GET /search?repoId=29&q=查询订单详情&strategy=multi` | 20 条，日志 `rerank 精排完成：候选 36 条，top1 分数 0.8643（重排前 0.6847）` |
| `POST /ask` | 200，5 条证据，日志同样出现 `rerank 精排完成` |

重排效果实例（同一查询，重排前后对比）：`loadOrderDetails` 由第 4 位升到第 1 位
（0.6350 → 0.8643），而 `detailPath` / `base` 这类语义空洞的名字被压下去——
正是精排该有的行为。返回体里 `metadata.preRerankScore` 保留重排前分数，便于对比排查。

> ⚠️ **注意 `score` 语义已变**：开启 rerank 后返回的 `score` 是**模型相关性分**，
> 与原先的规则融合分不在同一量纲（实测同一个查询里 0.37 vs 0.56）。
> 阈值过滤仍发生在**重排之前**（用的是规则分），下游没有任何代码二次按 `score` 过滤——
> 已确认无回归。若将来新增消费方，**不要**对 `score` 再套 0.3/0.5 这类阈值。
