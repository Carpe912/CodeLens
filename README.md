# CodeLens - 智能代码搜索与问答平台

<div align="center">

**面向私有代码仓库的代码理解与搜索引擎**

手写混合检索 · AST 结构分析 · URL 跨文件推导 · LangGraph 多轮编排

---

### 📚 文档导航

**[快速开始](#-快速开始)** · **[功能特性](#-功能特性)** · **[架构设计](#-架构设计)** · **[目录结构](#-目录结构)**

[🎓 学习指南](./docs/guides/LEARNING_GUIDE.md) · [📐 项目总览](./docs/guides/PROJECT_OVERVIEW.md) · [🚢 部署指南](./docs/deployment/DEPLOYMENT.md) · [📐 设计文档](./docs/design/)

---

</div>

## 📖 项目简介

CodeLens 是一个面向私有代码仓库的**代码搜索与问答系统**。它解决的核心问题是：
在大型代码库中，**「某个接口/函数到底在哪里定义、被谁调用、怎么拼出来的」**这类问题，
靠文本搜索或纯语义检索都答不准——因为这是**结构可达性**问题，不是语义相似度问题。

因此 CodeLens 的检索层是**手写的混合检索**（约 4000 行），而不是把一切交给向量库：

- **结构信号优先**：能精确命中的走精确路径（`url-search` / `url-template-matcher`）
- **语义兜底**：自然语言描述走向量检索（pgvector + HNSW）
- **跨文件推导**：把分散在多个文件的常量/模板/函数调用拼成完整 URL（`url-derivation`）
- **关系扩展**：沿依赖图与调用图扩展召回（`dependency-tracker`）

在此之上，**编排层（`src/agent/`）** 负责决定「检索几轮、用哪个策略、证据够不够」。
编排层是**两套并存**的实现：

| 实现 | 位置 | 特点 | 入口 |
|------|------|------|------|
| `AgentCore` | `agent/core.ts` | 单轮线性管道：分类 → 检索一次 → 生成一次 | `POST /agent/query` |
| LangGraph 图 | `agent/graph/` | 多轮编排：检索 → 评估证据 → 不足则换策略重检索（有收敛保证） | `POST /agent/v2/query` |

LangGraph 版本通过条件边实现「证据不足则回边重检索」，轮次上限取
`min(config.maxReasoningRounds, 策略计划长度)`，条件边先判轮次上限再判充分度，
**最坏情况必然收敛**（不会死循环）。两套实现并存是为了可做 A/B 对比。

> ⚠️ **关于「AgentRAG」的说辞**：早期文档曾宣称「多轮推理 + 工具调用 + 会话记忆 + 自我反思」，
> 但其中多数能力当时**并未实现**（相关类为空占位）。现已清理这些不实描述，
> 并删除了空占位类。需要多轮编排时，看 `agent/graph/`；其余能力的状态见
> [docs/agent-unimplemented-design.md](./docs/agent-unimplemented-design.md)。

---

## ✨ 功能特性

### 1. 混合检索（多策略）

检索不依赖单一策略，而是按查询意图组合：

| 策略 | 说明 | 适用场景 |
|------|------|----------|
| Vector Search | pgvector 语义检索（1536 维 + HNSW） | 模糊描述、概念查询 |
| Exact Match | 精确模式匹配 | 已知完整路径/符号名 |
| Fuzzy Search | 模糊/纠错匹配 | 拼写错误、部分匹配 |
| Dependency-Aware | 依赖关系追踪（跨文件常量引用） | URL/常量跨文件拼接 |
| URL Search | URL 专项检索 + 模板匹配 | API 端点定位 |
| Graph-Based | 调用图遍历 | 调用链分析 |

策略分发在 `retrieval/multi-strategy-search.ts` 中按意图集中调度，
结果经去重（`retrieval/deduplication.ts`）与打分后排序。

### 2. AST 深度分析

解析 TypeScript / JavaScript / Vue，抽取结构化信息：

```typescript
const API_BASE = '/api/v1';
export function getUserProfile(userId: string) {
  return fetch(`${API_BASE}/users/${userId}`);
}
```

提取结果：
- ✅ 常量：`API_BASE = '/api/v1'`
- ✅ 函数：`getUserProfile(userId: string)`
- ✅ URL 模式：`/api/v1/users/{userId}`
- ✅ 调用关系：`getUserProfile` → `fetch`

### 3. URL 跨文件推导

追踪 URL 的构造链，把分散在多个文件的拼接还原为完整路径：

```typescript
// constants.ts
export const API_BASE = '/api/v1';
// endpoints.ts
import { API_BASE } from './constants';
export const USER_ENDPOINT = `${API_BASE}/users`;
// service.ts
import { USER_ENDPOINT } from './endpoints';
fetch(`${USER_ENDPOINT}/${userId}`);
```

推导结果：`/api/v1/users/{userId}`

> 这是项目最有技术含量的部分。实现要点与踩过的坑见
> [docs/design/](./docs/design/)（含迭代过程记录）。

### 4. 调用图与影响面分析

调用图由 `call_graph` 表承载。该表同时保存 **名字**（`to_symbol`）与 **实体**
（`to_chunk_id`）两列，这是刻意的设计：同名符号在不同文件里很常见
（`handler`、`index`、`create`…），只按名字做反向查询会把「恰好同名」也算成依赖，
而且 `LEFT JOIN code_chunks ON symbol_name = to_symbol` 会在同名多定义时放大结果行数。

- 正向（calls）与反向（calledBy）追踪，前端用 React Flow 交互式展示
- 影响面分析：给定文件或符号，沿依赖边做**传递闭包**，回答「改动这里会波及什么」

```
getUserProfile
  ├─ 被调用（calledBy）
  │   ├─ ProfilePage.tsx:45
  │   └─ UserSettings.tsx:23
  └─ 调用（calls）
      ├─ fetch
      └─ validateUserId
```

> ⚠️ **已知边界**：无法解析到定义的调用边（`to_chunk_id IS NULL`）不会进入图遍历，
> 但接口会通过 `unresolvedEdges` 如实告知数量。也就是说「影响面为 0」与
> 「影响面未知」在响应里是可区分的，不会被混淆。
>
> 设计说明与它暴露出的历史缺陷见 [docs/design/impact-analysis.md](./docs/design/impact-analysis.md)。

### 5. 智能问答与根因分析

基于检索到的代码证据 + LLM 生成答案；证据为空时**跳过 LLM**返回明确说明，
避免无依据的幻觉：

- `POST /ask` —— 代码问答
- `POST /root-cause` —— 根因分析

---

## 🚀 快速开始

### 环境要求

- Node.js >= 18
- PostgreSQL >= 14（需 pgvector 扩展）
- Redis >= 6
- pnpm >= 9

### 安装步骤

```bash
# 1. 安装依赖
pnpm install

# 2. 配置数据库
createdb codelens
psql codelens -c "CREATE EXTENSION vector;"

# 3. 启动 Redis
brew services start redis        # macOS
# sudo systemctl start redis     # Linux

# 4. 配置环境变量
cp apps/api/.env.example apps/api/.env
# 需要填写（完整清单见 apps/api/.env.example）：
# - LLM_PROVIDER / DEEPSEEK_API_KEY: LLM 厂商与密钥（默认 DeepSeek，可切回 anthropic）
# - EMBED_API_KEY:     DashScope（阿里百炼）Embedding 密钥
# - RERANK_API_KEY:    DashScope 精排密钥（与 EMBED 同源；RERANK_ENABLED=false 可关闭）
# - DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD: PostgreSQL 连接
# - REDIS_HOST / REDIS_PORT: Redis 连接

# 5. 初始化表结构
pnpm --filter @codelens/api migrate

# 6. 启动
pnpm dev:api    # API 服务（默认端口 8787）
pnpm dev:web    # 前端（默认端口 5173）
```

访问 http://localhost:5173 开始使用。

---

## 🏗️ 架构设计

### 技术栈

**前端（apps/web）**
- React 18 + TypeScript + Vite
- TanStack Query（数据管理）
- React Flow（调用图可视化）
- Monaco Editor / Prism（代码展示）
- Tailwind CSS

**后端（apps/api）**
- Fastify 5（Web 框架）
- PostgreSQL + pgvector（向量数据库，1536 维 / HNSW）
- Redis + BullMQ（索引任务队列）
- LLM 层（`LLM_PROVIDER` 切换厂商；默认 DeepSeek `deepseek-chat`，可回滚 Anthropic Claude）
  —— 适配层见 `apps/api/src/llm/client.ts`，排障见 `docs/deployment/SERVER_RUNBOOK.md` 第 8 节
- 阿里百炼 DashScope（`qwen3.7-text-embedding` 向量化 + `qwen3.7-text-rerank` 精排）
  —— 精排见 `apps/api/src/retrieval/rerank.ts`，由 `RERANK_ENABLED` 开关控制，
  模型不可用时自动降级回规则排序
- LangGraph（`@langchain/langgraph`，编排层）

**代码分析**
- Babel Parser / ts-morph（TS/JS AST）
- @vue/compiler-sfc（Vue SFC）
- segmentit（中文分词）

> 历史上有过一版 VS Code 扩展（`apps/vscode-extension`，2026-09-19 移除）。
> 它承担的「搜索 / 问答 / 调用图」能力现已全部由 `apps/web` 覆盖，
> 移除后仓库只剩 `apps/api` 与 `apps/web` 两个包。

### 数据库设计

```sql
-- 核心表
repos              -- 仓库信息
files              -- 文件信息
code_chunks        -- 代码片段（含 embedding，供向量检索）

-- AST 分析表
functions          -- 函数定义
classes            -- 类定义
string_constants   -- 字符串常量
url_patterns       -- URL 模式

-- 关系表
call_graph         -- 函数调用关系
import_relations   -- 导入关系
file_dependencies  -- 文件依赖

-- 反馈
question_feedback  -- 问答反馈（用于改进检索）
```

---

## 📁 目录结构

```
CodeLens/
├── apps/
│   ├── api/                      # 后端 API（Fastify + TypeScript）
│   │   └── src/
│   │       ├── index.ts              # 进程入口：环境校验 / 启动 / 优雅关闭
│   │       ├── server/               # HTTP 层
│   │       │   ├── app.ts            #   装配：插件 → 初始化 → 路由
│   │       │   ├── context.ts        #   服务级单例（pool / agent / graph）
│   │       │   ├── deps.ts           #   路由依赖聚合出口
│   │       │   └── routes/           #   按领域拆分的路由
│   │       │       ├── repos.ts      #     仓库管理（导入/索引/刷新/删除）
│   │       │       ├── search.ts     #     搜索 / 调用图
│   │       │       ├── ask.ts        #     问答 / 根因分析
│   │       │       ├── agent.ts      #     Agent 查询（v1 / v2）
│   │       │       ├── feedback.ts   #     问答反馈
│   │       │       ├── admin.ts      #     运维（迁移/缓存）
│   │       │       └── health.ts     #     健康检查
│   │       ├── retrieval/            # 检索层（项目核心资产，手写）
│   │       │   ├── multi-strategy-search.ts   # 策略调度与融合
│   │       │   ├── url-search.ts              # URL 专项检索
│   │       │   ├── url-derivation.ts          # 跨文件 URL 推导
│   │       │   ├── url-template-matcher.ts    # URL 模板匹配
│   │       │   ├── query-intent-parser.ts     # 查询意图解析
│   │       │   ├── deduplication.ts           # 结果去重
│   │       │   ├── rerank.ts                  # rerank 精排（DashScope，可降级）
│   │       │   ├── search-suggestions.ts      # 搜索建议/纠错
│   │       │   └── multilingual-tokenizer.ts  # 中英文分词
│   │       ├── indexing/             # 索引层
│   │       │   ├── enhanced-indexer.ts        # 增强索引器（两阶段编排）
│   │       │   ├── indexer.ts                 # 基础索引器
│   │       │   ├── file-scanner.ts            # 可索引文件扫描（单一事实源）
│   │       │   ├── dependency-tracker.ts      # 依赖追踪
│   │       │   ├── relationship-builder.ts    # 关系/调用图构建
│   │       │   ├── queue.ts                   # BullMQ 任务队列
│   │       │   └── languages/                 # 语言适配层（加语言 = 加一个目录）
│   │       │       ├── types.ts               # LanguageParser 契约（语言中立）
│   │       │       ├── registry.ts            # 按扩展名分发
│   │       │       └── typescript/            # TS / JS / TSX / JSX + .vue
│   │       │           ├── index.ts           #   adapter：beginRepo / endRepo 作用域
│   │       │           ├── chunker.ts         #   Babel    → code_chunks
│   │       │           ├── entities.ts        #   ts-morph → 结构化实体
│   │       │           ├── url-resolver.ts    #   跨文件符号表 + 表达式求值
│   │       │           └── sfc-host.ts        #   .vue SFC <script> 解包
│   │       ├── agent/                # 编排层
│   │       │   ├── core.ts           #   AgentCore（单轮线性管道）
│   │       │   ├── types.ts
│   │       │   └── graph/           #   LangGraph 编排图
│   │       │       ├── index.ts      #     图构建 + 运行入口
│   │       │       ├── nodes.ts      #     retrieve / grade / generate
│   │       │       └── state.ts      #     图状态定义
│   │       ├── llm/                  # 生成层
│   │       │   ├── client.ts         #   厂商适配层（DeepSeek 默认 / Anthropic 回滚）
│   │       │   ├── embeddings.ts     #   向量化（DashScope）
│   │       │   └── qa.ts             #   问答 / 根因生成
│   │       ├── cache/                # 缓存
│   │       │   ├── index.ts          #   应用级缓存（TTL / 统计）
│   │       │   └── lru-cache.ts      #   通用 LRU 原语
│   │       ├── analysis/             # 影响面分析（file_dependencies / call_graph）
│   │       ├── config/               # 配置（Agent 配置等）
│   │       ├── db/                   # 数据库访问
│   │       ├── utils/                # 通用工具（打分 / GitLab / 错误展开）
│   │       └── scripts/              # 运维脚本（migrate / reindex / verify / reembed）
│   │
│   └── web/                      # 前端（React + Vite）
│       └── src/
│           ├── pages/            # 页面（首页 / 仓库页 / 调用图页）
│           ├── components/       # 组件
│           ├── utils/            # 前端工具
│           └── types/
│
├── docs/                         # 文档
│   ├── guides/                   #   学习指南、项目总览
│   ├── deployment/               #   部署文档
│   ├── design/                   #   设计文档（索引器 / URL 推导 / 框架对比）
│   └── agent-unimplemented-design.md   # Agent 未实现能力的设计归档
│
├── interview-prep/               # 面试准备材料
└── scripts/                      # 部署与运维脚本
```

---

## 🔧 API 接口

### 仓库管理
```http
GET    /repos                          # 仓库列表
GET    /repos/:id                      # 仓库详情
POST   /repos                          # 创建仓库
POST   /repos/upload                   # 上传 ZIP 导入
POST   /repos/from-gitlab              # 从 GitLab 导入
POST   /repos/:id/reindex              # 全量重建索引
POST   /repos/:id/incremental-index    # 增量索引
POST   /repos/:id/refresh              # 刷新
GET    /repos/:id/progress             # 索引进度
DELETE /repos/:id                      # 删除仓库
```

### 搜索与问答
```http
GET    /search?repoId=1&q=login        # 混合检索
GET    /call-graph?repoId=1&symbolName=login   # 调用图（1 跳）
POST   /ask                            # 代码问答
POST   /root-cause                     # 根因分析
```

### 影响面分析
```http
GET    /impact                              # 能力自述：依赖数据是否已构建
GET    /impact/file?repoId=1&path=src/a.ts  # 文件级影响面
       &maxDepth=3&direction=dependents     #   dependents=谁依赖我（默认）
                                            #   dependencies=我依赖谁
GET    /impact/symbol?repoId=1&symbolName=parseFile   # 符号级影响面
       &maxDepth=3&chunkId=123              #   同名多定义时必须用 chunkId 消歧
```

符号名在该仓库有多个定义时返回 **409** 并列出候选，而不是猜一个 —— 猜错比报错更糟。

### Agent
```http
POST   /agent/query                    # AgentCore（单轮）
POST   /agent/v2/query                 # LangGraph 编排（多轮，需 AGENT_GRAPH_ENABLED=true）
GET    /agent/sessions/:sessionId      # 会话
GET    /agent/stats                    # 统计
```

### 运维
```http
GET    /health                         # 健康检查
GET    /admin/cache/stats              # 缓存统计
POST   /admin/cache/clear              # 清空缓存
```

---

## 📊 性能与优化（机制说明）

> 下面只描述**机制**。本仓库没有基准测试框架，因此不提供「提升 N 倍」这类无法复现的数字。

### 批量删除：先删索引再删数据

带 HNSW 向量索引的表在**逐行删除**时开销极大（每次删除都要维护图结构与多个 B-tree）。
批量删除的正确姿势是反过来做：

1. `DROP INDEX`（含 HNSW 与各 B-tree）
2. 批量 `DELETE`（无索引维护开销）
3. `CREATE INDEX` 重建

前提是**离线批量**操作——重建期间该表不可查询，因此不适合在线实时删除；
删几行的场景保留逐行删除路径。

### 查询缓存

LRU + TTL 两级缓存（检索结果、向量、查询重写等），命中直接返回，
避免重复的 embedding 与检索开销。

### 分词

中文查询经分词与同义词扩展后再检索（`retrieval/multilingual-tokenizer.ts`），
缓解中文短查询召回差的问题。

---

## 🚢 生产部署

```bash
npm run deploy
```

脚本流程：本地构建 → 上传 → 安装生产依赖 → PM2 重启 → 健康检查。

详见 [docs/deployment/DEPLOYMENT.md](./docs/deployment/DEPLOYMENT.md)。

---

## ❓ 常见问题

<details>
<summary><b>Q: 索引速度慢怎么办？</b></summary>

A: 系统针对小内存服务器做了优化：分批处理、批次间延迟、主动 GC。
可调整 `BATCH_SIZE` 进一步权衡速度与内存。
</details>

<details>
<summary><b>Q: 支持哪些编程语言？</b></summary>

A: 当前支持 TypeScript / JavaScript / TSX / JSX 与 Vue SFC。解析层已抽成**语言适配层**（`indexing/languages/`），新增语言 = 新建 `languages/<lang>/` 目录实现 `LanguageParser` 接口（`parseChunks` + `analyzeEntities`），再在 `registry.ts` 里 `register()` 一行即可，下游检索/关系/前端无需改动。
</details>

<details>
<summary><b>Q: `/agent/query` 和 `/agent/v2/query` 有什么区别？</b></summary>

A: `v1` 是单轮线性管道（分类 → 检索一次 → 生成一次），稳定、快。
`v2` 是 LangGraph 多轮编排（证据不足会换策略回边重检索，轮次有上限、保证收敛）。
`v2` 默认关闭，需设 `AGENT_GRAPH_ENABLED=true`。
</details>

---

## 🗺️ 后续规划

- [x] 混合检索（多策略）
- [x] AST 深度分析
- [x] URL 跨文件推导
- [x] 调用图可视化
- [x] LangGraph 多轮编排
- [x] 影响面分析（文件级 + 符号级传递闭包）
- [ ] 评测体系（标注集 + RAGAS / A-B）—— 没有它，一切「准确率」都无从谈起
- [ ] 支持更多语言（Python / Go / Java）
- [ ] PR 分析与代码审查

---

## ✅ 验证方式

本仓库没有 CI，也常年连不上本地 PostgreSQL，因此把「能离线跑的验证」做成了脚本。
改动后用这几条命令自证，而不是靠肉眼 review：

```bash
pnpm --filter @codelens/api typecheck      # 类型
pnpm --filter @codelens/api build          # 构建
pnpm --filter @codelens/api check:sql      # 静态校验：SQL 引用的列是否真实存在
pnpm --filter @codelens/api verify:routes  # 路由表可 ready（不需要数据库）
pnpm --filter @codelens/api verify:graph   # LangGraph 编排的 30 项断言
```

### 为什么需要 `check:sql`

`call_graph` 曾长期缺少 `repo_id` / `to_chunk_id` 两列，而代码里有 8 处在引用它们。
由于每条 INSERT 都被 `try/catch` 包裹（只为「不中断索引流程」），故障被完全静默：
**整张表一行都插不进去，却从不报错**，调用图因此一直返回空结果。

这类「SQL 引用了不存在的列」的缺陷：改代码时看不出来、`tsc` 查不出、只有真连上数据库才会炸。
`check:sql` 从建表语句与 migration 还原真实 schema，再逐条校验源码里的 SQL：

- 首次运行发现 **27 处**幽灵列引用（含 3 处零调用点的死函数、2 处必然抛错的线上查询）
- 修复后 **0 处**

脚本还会可选地做 SQL **语法**校验（需 `CODELENS_SQL_PARSER_DIR` 指向 `pgsql-ast-parser`）。
它对递归 CTE 与 pgvector 运算符无能为力 —— 这一点会在输出里如实标注为「未验证」，
而不是让「检查通过」被误读成「全部验证过」。

### 关系图数据需要单独重建

迁移只修表结构，**不回填数据**。`import_relations` / `call_graph` / `file_dependencies`
三张表与 embedding 无关，因此重建它们不需要重新花钱嵌入：

```bash
pnpm --filter @codelens/api rebuild-graph <repoId>
```

它只做「AST 分析 → 建关系 → 物化文件依赖边」，不触碰向量，并会打印重建前后行数、
未解析调用边比例与失败文件清单。相比之下 `reindex` 会重新生成整个仓库的向量，
仅在文件内容本身变化时才需要。`rebuild-references` 则**不能**用来重建依赖图 ——
它传入的是空的 imports/functions 结果。

### 部署到服务器

部署与服务器侧验证流程见 **[docs/deployment/SERVER_RUNBOOK.md](./docs/deployment/SERVER_RUNBOOK.md)**：
包含迁移（台账执行器）、关系图重建、`/impact` 能力自述端点的判读、以及常见失败的处理。

---

## 📄 License

MIT

---

<div align="center">

**Made with ❤️ by CodeLens Team**

[文档](./docs/) · [问题反馈](https://github.com/your-repo/issues)

</div>
