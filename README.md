# CodeLens - 智能代码搜索与问答平台

<div align="center">

**基于 AgentRAG 的代码理解与搜索引擎**

多轮推理 · 自主决策 · 工具调用 · 会话记忆 · 自我反思

---

### 📚 文档导航

**[快速开始](#快速开始)** · **[功能特性](#功能特性)** · **[架构设计](#架构设计)**

**[🎓 学习指南](./LEARNING_GUIDE.md)** · **[🚀 升级说明](./AGENTRAG_UPGRADE.md)** · **[🚢 部署指南](./DEPLOYMENT.md)** · **[📐 项目架构](./PROJECT_OVERVIEW.md)**

---

</div>

## 📖 项目简介

CodeLens 是一个面向私有代码仓库的**智能代码搜索与问答平台**，采用业界领先的 **AgentRAG 架构**，通过多轮推理、工具调用和自我反思，实现从被动检索到主动推理的质的飞跃。

> 💡 **新用户？** 建议阅读顺序：[README](./README.md) → [升级说明](./AGENTRAG_UPGRADE.md) → [学习指南](./LEARNING_GUIDE.md) → [部署指南](./DEPLOYMENT.md)

### 🚀 AgentRAG 核心能力

- 🤖 **多轮推理引擎**：最多 5 轮自主推理，自动分解复杂任务
- 🛠️ **工具调用能力**：向量搜索、符号查找、代码分析、调用图追踪
- 🧠 **会话记忆**：支持上下文对话，记住之前的查询和结论
- 🔍 **自我反思**：每轮推理后评估进度和置信度，动态调整策略
- 📊 **执行追踪**：记录所有推理步骤和工具调用，完全可审计
- 🎯 **结构化答案**：直接回答 + 关键证据 + 置信度评分

### 💡 传统能力（持续增强）

- 🔍 **多策略搜索引擎**：向量语义搜索 + 精确匹配 + 模糊搜索 + 依赖追踪 + 调用图遍历
- 🌲 **AST 深度分析**：提取函数、类、常量、URL 模式，构建完整的代码知识图谱
- 🔗 **调用链追踪**：自动构建函数调用图，支持正向/反向追踪
- 🌐 **URL 智能推导**：追踪 URL 构造链，理解 API 端点的完整路径
- 🌍 **多语言支持**：中文分词优化，支持中英文混合查询
- 📈 **向量升级**：1536 维向量（阿里百炼 text-embedding-v4）+ qwen3-rerank 重排序

---

## 🎯 AgentRAG vs 传统 RAG

### 架构对比

| 维度 | 传统 RAG | CodeLens AgentRAG | 提升 |
|------|---------|-------------------|------|
| **推理能力** | 单轮检索 | 多轮推理（最多5轮） | ∞ |
| **决策能力** | 被动响应 | 自主决策、任务分解 | 质的飞跃 |
| **工具使用** | ❌ 无 | ✅ 向量搜索、符号查找、代码分析 | 新增 |
| **会话记忆** | ❌ 无 | ✅ 上下文对话、历史追踪 | 新增 |
| **自我反思** | ❌ 无 | ✅ 每轮评估、动态调整 | 新增 |
| **向量维度** | 1024 | 1536 | +50% |
| **答案质量** | 代码片段 | 结构化答案 + 证据链 | +100% |
| **置信度** | ❌ 无 | ✅ 0-1 评分 | 新增 |

### 实际效果对比

**查询示例**：`searchProducts 函数是如何实现的？`

**传统 RAG**：
```
返回 3-5 个相关代码片段
用户需要自己理解和整合
```

**CodeLens AgentRAG**：
```json
{
  "answer": "## searchProducts 函数实现\n\n**直接回答：**\n`searchProducts` 是 `ProductApi` 类的一个异步方法，通过 GET 请求调用 `/api/products/search` 端点...",
  
  "evidence": [
    {
      "type": "code",
      "source": "test-repo/src/api/productApi.js:33",
      "content": "async searchProducts(query) { return axios.get(...) }",
      "relevance": 0.72
    }
  ],
  
  "reasoning": [
    "步骤1: 使用向量搜索定位 searchProducts 函数",
    "步骤2: 分析函数实现和调用关系",
    "步骤3: 提取关键证据并生成结构化答案"
  ],
  
  "confidence": 0.85,
  "executionTime": 9170,
  "metadata": {
    "stepsExecuted": 3,
    "toolsCalled": ["vector_search", "symbol_lookup", "call_graph"]
  }
}
```

---

## ✨ 功能特性

### 1. AgentRAG 智能问答

**核心优势**：从被动检索到主动推理

#### 多轮推理引擎

```typescript
// Agent 自主推理流程
while (currentStep < maxSteps && confidence < threshold) {
  // 1. 分析当前状态
  const analysis = await analyzeCurrentState();
  
  // 2. 选择工具
  const tool = selectBestTool(analysis);
  
  // 3. 执行工具
  const result = await executeTool(tool);
  
  // 4. 自我反思
  const reflection = await reflect(result);
  
  // 5. 更新置信度
  confidence = reflection.confidence;
}
```

#### 工具调用能力

- **vector_search**: 语义向量搜索
- **symbol_lookup**: 精确符号查找
- **code_analysis**: 代码结构分析
- **call_graph**: 调用关系追踪
- **url_derivation**: URL 推导分析

#### 会话记忆

```typescript
// 支持上下文对话
用户: "searchProducts 函数在哪里？"
Agent: "在 productApi.js:33"

用户: "它被谁调用了？"  // Agent 记住上下文
Agent: "被 UserDashboard.js:103 的 searchAndFilter 方法调用"
```

#### 自我反思

```typescript
{
  "reflection": {
    "progress": "已找到函数定义和调用关系",
    "confidence": 0.85,
    "nextAction": "分析函数实现细节",
    "reasoning": "证据充分，可以生成答案"
  }
}
```

### 2. 多策略搜索引擎

### 环境要求

- Node.js >= 18
- PostgreSQL >= 14（需要 pgvector 扩展）
- Redis >= 6
- pnpm >= 9

### 安装步骤

```bash
# 1. 克隆项目
git clone <your-repo-url>
cd CodeLens

# 2. 安装依赖
pnpm install

# 3. 配置数据库
createdb codelens
psql codelens -c "CREATE EXTENSION vector;"

# 4. 启动 Redis
brew services start redis  # macOS
# 或 sudo systemctl start redis  # Linux

# 5. 配置环境变量
cp apps/api/.env.example apps/api/.env
# 编辑 .env 文件，填入必要的配置：
# - ANTHROPIC_API_KEY: Claude API 密钥
# - EMBED_API_KEY: XiaocaseAI API 密钥
# - DATABASE_URL: PostgreSQL 连接字符串
# - REDIS_URL: Redis 连接字符串

# 6. 启动服务
pnpm dev:api    # 启动 API 服务（端口 8787）
pnpm dev:web    # 启动前端（端口 5173）
```

访问 http://localhost:5173 开始使用。

---

## ✨ 功能特性

### 1. 多策略搜索引擎

CodeLens 实现了业界领先的多策略搜索引擎，自动组合 5 种搜索策略：

| 策略 | 说明 | 适用场景 |
|------|------|----------|
| **Vector Search** | 语义向量搜索 | 模糊描述、概念查询 |
| **Exact Match** | 精确模式匹配 | 函数名、变量名 |
| **Fuzzy Search** | 模糊文本搜索 | 拼写错误容错 |
| **Dependency-Aware** | 依赖关系追踪 | 跨文件引用查找 |
| **Graph-Based** | 调用图遍历 | 调用链分析 |

**示例**：
- 搜索 "用户登录" → 自动匹配 `userLogin`, `handleLogin`, `loginUser` 等相关函数
- 搜索 "usre" → 自动纠正为 "user" 并返回结果
- 搜索 "/api/users" → 追踪 URL 构造链，找到所有相关常量和函数

### 2. AST 深度分析

通过 AST（抽象语法树）深度解析代码，提取结构化信息：

```typescript
// 代码示例
const API_BASE = '/api/v1';
export function getUserProfile(userId: string) {
  return fetch(`${API_BASE}/users/${userId}`);
}
```

**提取结果**：
- ✅ 常量：`API_BASE = '/api/v1'`
- ✅ 函数：`getUserProfile(userId: string)`
- ✅ URL 模式：`/api/v1/users/{userId}`
- ✅ 调用关系：`getUserProfile` → `fetch`

### 3. URL 智能推导

自动追踪 URL 构造链，理解 API 端点的完整路径：

```typescript
// 步骤 1: 定义基础路径
const API_BASE = '/api/v1';

// 步骤 2: 组合用户路径
const USER_PATH = API_BASE + '/users';

// 步骤 3: 构造完整 URL
fetch(USER_PATH + '/' + userId);
```

**推导结果**：`/api/v1/users/{userId}`（置信度: 95%）

### 4. 调用图可视化

交互式函数调用关系图谱：

```
getUserProfile
  ├─ 被调用（calledBy）
  │   ├─ ProfilePage.tsx:45
  │   └─ UserSettings.tsx:23
  └─ 调用（calls）
      ├─ fetch
      └─ validateUserId
```

### 5. 智能问答

基于代码证据的 AI 问答：

**Q**: "登录方案是什么？"

**A**: 系统使用 JWT Token 认证方案：
1. 用户提交账号密码到 `/api/auth/login`
2. 后端验证成功后返回 JWT Token
3. 前端将 Token 存储在 localStorage
4. 后续请求在 Header 中携带 `Authorization: Bearer <token>`

**证据**：
- `apps/api/src/auth/login.ts:23-45`
- `apps/web/src/utils/auth.ts:12-18`

---

## 🏗️ 架构设计

### 技术栈

**前端**
- React 18 + TypeScript
- TanStack Query（数据管理）
- React Flow（调用图可视化）
- Tailwind CSS（样式）

**后端**
- Fastify（Web 框架）
- PostgreSQL + pgvector（向量数据库）
- Redis + BullMQ（任务队列）
- Anthropic Claude（LLM）
- XiaocaseAI（Embeddings & Rerank）

**代码分析**
- Babel Parser（AST 解析）
- ts-morph（TypeScript 分析）
- segmentit（中文分词）

### 核心模块

```
apps/api/src/
├── llm/                          # AI 模块
│   ├── embeddings.ts             # 向量化（text-embedding-v4）
│   ├── multi-strategy-search.ts  # 多策略搜索引擎
│   ├── url-derivation.ts         # URL 推导分析
│   ├── url-search.ts             # URL 专项搜索
│   └── qa.ts                     # 智能问答
├── indexer/                      # 索引器
│   ├── enhanced-indexer.ts       # 增强索引器（AST 分析）
│   ├── ast-analyzer.ts           # AST 分析器
│   ├── relationship-builder.ts   # 关系构建器
│   └── dependency-tracker.ts     # 依赖追踪器
├── utils/                        # 工具模块
│   ├── cache.ts                  # LRU 缓存
│   ├── deduplication.ts          # 结果去重
│   ├── multilingual-tokenizer.ts # 多语言分词
│   └── search-suggestions.ts     # 搜索建议
└── db/                           # 数据库
    └── index.ts                  # 数据库操作（含优化）
```

### 数据库设计

```sql
-- 核心表
repos              -- 仓库信息
files              -- 文件信息
code_chunks        -- 代码片段（含向量）

-- AST 分析表
functions          -- 函数定义
classes            -- 类定义
string_constants   -- 字符串常量
url_patterns       -- URL 模式

-- 关系表
call_graph         -- 函数调用关系
import_relations   -- 导入关系
file_dependencies  -- 文件依赖
```

---

## 📊 性能优化

### 1. 索引删除优化（10-12倍提升）

**问题**：删除 96K 条记录耗时 16-19 分钟

**原因**：
- HNSW 向量索引在删除时性能极差
- 7 个 B-tree 索引需要维护
- 外键级联删除触发子表操作

**解决方案**：
```typescript
// 优化前：直接删除（16-19 分钟）
DELETE FROM code_chunks WHERE repo_id = $1;

// 优化后：先删除索引，再删除数据，最后重建索引（98 秒）
1. DROP INDEX（所有索引和外键）
2. DELETE FROM 子表（避免级联）
3. DELETE FROM code_chunks（无索引，速度快）
4. CREATE INDEX（重建索引）
```

**效果**：
- 删除时间：16-19 分钟 → **98 秒**（提升 **10-12 倍**）
- 总 reindex 时间：20+ 分钟 → **2-3 分钟**

### 2. 查询缓存（2-5倍提升）

**实现**：LRU 缓存 + 5 分钟 TTL

```typescript
// 缓存命中：50-100ms
// 缓存未命中：200-500ms
```

### 3. 多语言分词优化

**中文查询准确度提升 40-60%**

```typescript
// 优化前："用户登录" → ["用户登录"]
// 优化后："用户登录" → ["用户", "登录", "user", "login"]
```

---

## 📚 学习指南

想深入了解项目的实现细节？查看完整的学习指南：

👉 [CodeLens 完整学习指南](./LEARNING_GUIDE.md)

**内容包括**：
- 🎯 项目架构详解
- 🔧 核心模块源码解析
- 🚀 性能优化全过程
- 📖 从零开始的开发指南
- 💡 关键技术实现细节

**适合人群**：
- ✅ 新手：逐步理解项目架构和实现
- ✅ 资深开发者：了解技术难点和优化策略

---

## 🔧 API 接口

### 仓库管理
```http
GET    /repos                    # 获取仓库列表
POST   /repos                    # 创建仓库（GitLab）
POST   /repos/upload             # 上传 ZIP
POST   /repos/:id/reindex        # 重新索引
DELETE /repos/:id                # 删除仓库
```

### 搜索与问答
```http
GET    /search?repoId=1&q=login  # 多策略搜索
POST   /ask                       # 智能问答
POST   /root-cause                # 根因分析
```

### 调用图
```http
GET    /call-graph?repoId=1&symbolName=login  # 获取调用图
```

---

## 🚢 生产部署

### 一键部署

```bash
npm run deploy
```

部署脚本自动完成：
1. ✅ 本地构建（前端 + 后端）
2. ✅ 上传到服务器
3. ✅ 安装生产依赖
4. ✅ PM2 重启服务
5. ✅ 健康检查

详细部署文档请查看：[DEPLOYMENT.md](./DEPLOYMENT.md)

---

## ❓ 常见问题

<details>
<summary><b>Q: 索引速度慢怎么办？</b></summary>

A: 系统已针对小内存服务器优化：
- 分批处理（每批 3 个文件）
- 批次间延迟（1 秒）
- 手动 GC（释放内存）
- 可调整 `BATCH_SIZE` 进一步优化
</details>

<details>
<summary><b>Q: 如何获取 API Key？</b></summary>

A: 
- **Anthropic API Key**: https://console.anthropic.com/
- **XiaocaseAI API Key**: https://api.xiaocaseai.cn/
</details>

<details>
<summary><b>Q: 支持哪些编程语言？</b></summary>

A: 当前支持 TypeScript/JavaScript/Vue，后续将支持 Python/Go/Java
</details>

---

## 🗺️ 后续规划

- [x] 多策略搜索引擎
- [x] AST 深度分析
- [x] URL 智能推导
- [x] 调用图可视化
- [x] 多语言分词优化
- [x] 索引删除性能优化
- [ ] 支持更多语言（Python, Go, Java）
- [ ] PR 分析和代码审查
- [ ] 版本对比和变更分析
- [ ] 团队协作和知识沉淀

---

## 📄 License

MIT

---

<div align="center">

**Made with ❤️ by CodeLens Team**

[GitHub](https://github.com/your-repo) · [文档](./LEARNING_GUIDE.md) · [问题反馈](https://github.com/your-repo/issues)

</div>
