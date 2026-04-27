# CodeLens 完整学习指南

> 本文档面向初学者，详细讲解 CodeLens 项目的架构、核心技术和实现细节。

## 目录

- [项目概述](#项目概述)
- [技术栈详解](#技术栈详解)
- [项目架构](#项目架构)
- [核心模块解析](#核心模块解析)
- [数据流程](#数据流程)
- [关键技术实现](#关键技术实现)
- [从零开始开发](#从零开始开发)
- [常见问题](#常见问题)

---

## 项目概述

### 什么是 CodeLens？

CodeLens 是一个基于 AI 的代码理解和问答系统，它可以：

1. **索引代码仓库** - 自动分析和索引 GitHub 仓库的代码
2. **语义搜索** - 使用向量相似度搜索相关代码
3. **智能问答** - 基于代码上下文回答问题
4. **调用图分析** - 可视化函数调用关系

### 核心价值

- 快速理解大型代码库
- 自然语言查询代码
- 发现代码之间的关联
- 辅助代码审查和重构

---

## 技术栈详解

### 前端技术

| 技术 | 版本 | 用途 | 学习资源 |
|------|------|------|----------|
| **React** | 18.3 | UI 框架 | [React 官方文档](https://react.dev) |
| **TypeScript** | 5.6 | 类型系统 | [TypeScript 手册](https://www.typescriptlang.org/docs/) |
| **Vite** | 6.0 | 构建工具 | [Vite 指南](https://vitejs.dev/guide/) |
| **React Flow** | 11.11 | 流程图可视化 | [React Flow 文档](https://reactflow.dev) |
| **Tailwind CSS** | 3.4 | CSS 框架 | [Tailwind 文档](https://tailwindcss.com/docs) |

### 后端技术

| 技术 | 版本 | 用途 | 学习资源 |
|------|------|------|----------|
| **Fastify** | 5.2 | Web 框架 | [Fastify 文档](https://fastify.dev) |
| **PostgreSQL** | 14+ | 关系数据库 | [PostgreSQL 教程](https://www.postgresql.org/docs/) |
| **pgvector** | 0.5+ | 向量存储 | [pgvector GitHub](https://github.com/pgvector/pgvector) |
| **Redis** | 6+ | 缓存 | [Redis 命令参考](https://redis.io/commands/) |
| **tree-sitter** | - | 代码解析 | [tree-sitter 文档](https://tree-sitter.github.io/tree-sitter/) |

### AI 服务

| 服务 | 用途 |
|------|------|
| **OpenAI API** | 文本嵌入（text-embedding-3-small）|
| **Anthropic Claude** | 代码问答（Claude 3.5 Sonnet）|

---

## 项目架构

### 目录结构

```
CodeLens/
├── apps/
│   ├── api/                    # 后端 API 服务
│   │   ├── src/
│   │   │   ├── index.ts        # 入口文件
│   │   │   ├── routes/         # API 路由
│   │   │   │   ├── repos.ts    # 仓库管理
│   │   │   │   ├── search.ts   # 搜索接口
│   │   │   │   ├── qa.ts       # 问答接口
│   │   │   │   └── call-graph.ts # 调用图
│   │   │   ├── services/       # 业务逻辑
│   │   │   │   ├── indexer.ts  # 代码索引
│   │   │   │   ├── embedder.ts # 向量化
│   │   │   │   ├── search.ts   # 搜索服务
│   │   │   │   └── qa.ts       # 问答服务
│   │   │   ├── parsers/        # 代码解析器
│   │   │   │   ├── ts-parser.ts # TypeScript
│   │   │   │   ├── py-parser.ts # Python
│   │   │   │   └── go-parser.ts # Go
│   │   │   ├── db/             # 数据库
│   │   │   │   ├── pool.ts     # 连接池
│   │   │   │   └── schema.sql  # 表结构
│   │   │   ├── cache/          # 缓存
│   │   │   │   └── redis.ts    # Redis 客户端
│   │   │   └── utils/          # 工具函数
│   │   └── package.json
│   │
│   └── web/                    # 前端应用
│       ├── src/
│       │   ├── App.tsx         # 主应用
│       │   ├── main.tsx        # 入口
│       │   ├── components/     # 组件
│       │   │   ├── SearchBar.tsx
│       │   │   ├── CodeBlock.tsx
│       │   │   ├── QAPanel.tsx
│       │   │   └── CallGraph.tsx
│       │   ├── hooks/          # 自定义 Hooks
│       │   ├── types/          # 类型定义
│       │   └── utils/          # 工具函数
│       ├── .env.production     # 生产环境配置
│       └── package.json
│
├── packages/                   # 共享包
│   └── shared/
│       └── types/              # 共享类型定义
│
├── ecosystem.config.js         # PM2 配置
├── pnpm-workspace.yaml         # pnpm 工作空间
└── package.json                # 根配置
```

### 架构图

```
┌─────────────────────────────────────────────────────────┐
│                      用户浏览器                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  搜索界面    │  │  问答界面    │  │  调用图界面  │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
                          │ HTTPS
                          ▼
┌─────────────────────────────────────────────────────────┐
│                    Nginx 反向代理                        │
│  /code/  → 静态文件    /code-api/  → API 服务          │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   Fastify API 服务                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  索引服务    │  │  搜索服务    │  │  问答服务    │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
           │                  │                  │
           ▼                  ▼                  ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  PostgreSQL  │    │    Redis     │    │  OpenAI API  │
│  + pgvector  │    │   (缓存)     │    │  Claude API  │
└──────────────┘    └──────────────┘    └──────────────┘
```

---

## 核心模块解析

### 1. 代码索引器 (Indexer)

**文件**: [`apps/api/src/services/indexer.ts`](apps/api/src/services/indexer.ts)

**功能**: 克隆 GitHub 仓库并提取代码块

**核心流程**:

```typescript
// 1. 克隆仓库
async function cloneRepo(repoUrl: string) {
  const repoPath = `/tmp/repos/${repoId}`;
  await exec(`git clone ${repoUrl} ${repoPath}`);
  return repoPath;
}

// 2. 遍历文件
async function walkDirectory(dir: string) {
  const files = await fs.readdir(dir, { recursive: true });
  return files.filter(f => isSupportedFile(f));
}

// 3. 解析代码
async function parseFile(filePath: string) {
  const parser = getParser(filePath); // TypeScript/Python/Go
  const ast = parser.parse(fileContent);
  return extractFunctions(ast);
}

// 4. 存储到数据库
async function saveCodeBlocks(blocks: CodeBlock[]) {
  await db.query(
    'INSERT INTO code_blocks (repo_id, file_path, name, code, language) VALUES ...'
  );
}
```

**关键技术**:
- **tree-sitter**: 解析代码生成 AST（抽象语法树）
- **流式处理**: 避免大仓库内存溢出
- **增量索引**: 只处理变更的文件

**学习要点**:
1. 如何使用 tree-sitter 解析不同语言
2. AST 遍历和节点提取
3. 大文件流式处理

### 2. 向量嵌入器 (Embedder)

**文件**: [`apps/api/src/services/embedder.ts`](apps/api/src/services/embedder.ts)

**功能**: 将代码转换为向量表示

**核心流程**:

```typescript
// 1. 准备文本
function prepareText(codeBlock: CodeBlock): string {
  return `${codeBlock.name}\n${codeBlock.code}\n${codeBlock.docstring}`;
}

// 2. 调用 OpenAI API
async function getEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
    dimensions: 1536
  });
  return response.data[0].embedding;
}

// 3. 存储向量
async function saveEmbedding(blockId: string, vector: number[]) {
  await db.query(
    'INSERT INTO embeddings (block_id, vector) VALUES ($1, $2)',
    [blockId, vector]
  );
}
```

**关键技术**:
- **文本嵌入**: 将文本转换为高维向量
- **批量处理**: 减少 API 调用次数
- **向量维度**: 1536 维（OpenAI text-embedding-3-small）

**学习要点**:
1. 什么是词嵌入（Word Embedding）
2. 如何选择合适的嵌入模型
3. 批量 API 调用的最佳实践

### 3. 语义搜索 (Search)

**文件**: [`apps/api/src/services/search.ts`](apps/api/src/services/search.ts)

**功能**: 基于向量相似度搜索代码

**核心流程**:

```typescript
// 1. 查询向量化
async function searchCode(query: string, repoId: string) {
  const queryVector = await getEmbedding(query);
  
  // 2. 向量相似度搜索
  const results = await db.query(`
    SELECT 
      cb.*,
      e.vector <=> $1::vector AS distance
    FROM code_blocks cb
    JOIN embeddings e ON e.block_id = cb.id
    WHERE cb.repo_id = $2
    ORDER BY e.vector <=> $1::vector
    LIMIT 10
  `, [queryVector, repoId]);
  
  return results.rows;
}
```

**关键技术**:
- **余弦相似度**: 计算向量之间的相似度
- **pgvector**: PostgreSQL 向量扩展
- **索引优化**: IVFFlat 索引加速搜索

**学习要点**:
1. 向量相似度计算原理
2. pgvector 的使用和优化
3. 如何平衡搜索速度和准确度

### 4. 智能问答 (QA)

**文件**: [`apps/api/src/services/qa.ts`](apps/api/src/services/qa.ts)

**功能**: 基于代码上下文回答问题

**核心流程**:

```typescript
async function answerQuestion(question: string, repoId: string) {
  // 1. 检索相关代码
  const relevantCode = await searchCode(question, repoId);
  
  // 2. 构建提示词
  const prompt = `
    Based on the following code:
    ${relevantCode.map(c => c.code).join('\n\n')}
    
    Answer this question: ${question}
  `;
  
  // 3. 调用 Claude API
  const response = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }]
  });
  
  return response.content[0].text;
}
```

**关键技术**:
- **RAG (检索增强生成)**: 结合搜索和生成
- **提示工程**: 设计有效的提示词
- **上下文窗口**: 管理 token 限制

**学习要点**:
1. RAG 架构原理
2. 如何设计好的提示词
3. 如何处理长上下文

### 5. 调用图分析 (Call Graph)

**文件**: [`apps/api/src/routes/call-graph.ts`](apps/api/src/routes/call-graph.ts)

**功能**: 分析函数调用关系

**核心流程**:

```typescript
async function buildCallGraph(repoId: string, functionName: string) {
  // 1. 查找函数定义
  const targetFunc = await findFunction(repoId, functionName);
  
  // 2. 查找调用者
  const callers = await db.query(`
    SELECT * FROM code_blocks
    WHERE repo_id = $1 AND code LIKE $2
  `, [repoId, `%${functionName}(%`]);
  
  // 3. 查找被调用者
  const callees = await extractFunctionCalls(targetFunc.code);
  
  // 4. 构建图结构
  return {
    nodes: [targetFunc, ...callers, ...callees],
    edges: buildEdges(targetFunc, callers, callees)
  };
}
```

**关键技术**:
- **静态分析**: 不执行代码分析调用关系
- **图算法**: 构建和遍历调用图
- **可视化**: React Flow 渲染

**学习要点**:
1. 静态代码分析技术
2. 图数据结构和算法
3. 前端图可视化

---

## 数据流程

### 索引流程

```
用户输入 GitHub URL
    ↓
克隆仓库到本地
    ↓
遍历所有代码文件
    ↓
使用 tree-sitter 解析
    ↓
提取函数/类/方法
    ↓
存储到 code_blocks 表
    ↓
调用 OpenAI API 生成向量
    ↓
存储到 embeddings 表
    ↓
创建向量索引
    ↓
索引完成
```

### 搜索流程

```
用户输入搜索查询
    ↓
调用 OpenAI API 向量化查询
    ↓
在 embeddings 表中进行向量搜索
    ↓
计算余弦相似度
    ↓
返回 Top-K 最相似的代码块
    ↓
前端展示结果
```

### 问答流程

```
用户提问
    ↓
向量搜索相关代码（同搜索流程）
    ↓
构建包含代码上下文的提示词
    ↓
调用 Claude API 生成回答
    ↓
流式返回答案
    ↓
前端实时显示
```

---

## 关键技术实现

### 1. 向量相似度搜索

**原理**: 使用余弦相似度衡量向量之间的相似程度

```sql
-- pgvector 提供的操作符
-- <=> : 余弦距离（越小越相似）
-- <-> : 欧氏距离
-- <#> : 内积

SELECT 
  code_blocks.*,
  embeddings.vector <=> $1::vector AS distance
FROM code_blocks
JOIN embeddings ON embeddings.block_id = code_blocks.id
WHERE repo_id = $2
ORDER BY embeddings.vector <=> $1::vector
LIMIT 10;
```

**优化**: 创建 IVFFlat 索引

```sql
CREATE INDEX ON embeddings 
USING ivfflat (vector vector_cosine_ops)
WITH (lists = 100);
```

### 2. 代码解析

**使用 tree-sitter 解析 TypeScript**:

```typescript
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';

const parser = new Parser();
parser.setLanguage(TypeScript.typescript);

const tree = parser.parse(sourceCode);
const rootNode = tree.rootNode;

// 查找所有函数声明
const functions = rootNode.descendantsOfType('function_declaration');

functions.forEach(func => {
  const name = func.childForFieldName('name')?.text;
  const params = func.childForFieldName('parameters')?.text;
  const body = func.childForFieldName('body')?.text;
  
  console.log({ name, params, body });
});
```

### 3. 流式响应

**后端实现**:

```typescript
app.post('/qa', async (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const stream = await anthropic.messages.stream({
    model: 'claude-3-5-sonnet-20241022',
    messages: [{ role: 'user', content: prompt }]
  });

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta') {
      reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
  }

  reply.raw.end();
});
```

**前端实现**:

```typescript
const eventSource = new EventSource('/code-api/qa');

eventSource.onmessage = (event) => {
  const chunk = JSON.parse(event.data);
  setAnswer(prev => prev + chunk.delta.text);
};

eventSource.onerror = () => {
  eventSource.close();
};
```

### 4. 缓存策略

**Redis 缓存搜索结果**:

```typescript
async function searchWithCache(query: string, repoId: string) {
  const cacheKey = `search:${repoId}:${query}`;
  
  // 1. 尝试从缓存读取
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }
  
  // 2. 执行搜索
  const results = await searchCode(query, repoId);
  
  // 3. 写入缓存（1小时过期）
  await redis.setex(cacheKey, 3600, JSON.stringify(results));
  
  return results;
}
```

---

## 从零开始开发

### 第一步：环境准备

```bash
# 1. 安装 Node.js 22
nvm install 22
nvm use 22

# 2. 安装 pnpm
npm install -g pnpm

# 3. 安装 PostgreSQL
brew install postgresql@14

# 4. 安装 Redis
brew install redis

# 5. 安装 pgvector
cd /tmp
git clone https://github.com/pgvector/pgvector.git
cd pgvector
make
make install
```

### 第二步：初始化项目

```bash
# 1. 克隆项目
git clone https://github.com/yourusername/CodeLens.git
cd CodeLens

# 2. 安装依赖
pnpm install

# 3. 配置环境变量
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env

# 编辑 .env 文件，填入 API Keys
```

### 第三步：初始化数据库

```bash
# 1. 启动 PostgreSQL
brew services start postgresql@14

# 2. 创建数据库
createdb codelens

# 3. 安装 pgvector 扩展
psql codelens -c "CREATE EXTENSION vector;"

# 4. 创建表结构
psql codelens < apps/api/src/db/schema.sql
```

### 第四步：启动开发服务

```bash
# 终端 1: 启动 API
cd apps/api
pnpm dev

# 终端 2: 启动前端
cd apps/web
pnpm dev

# 终端 3: 启动 Redis
redis-server
```

### 第五步：测试功能

1. 打开浏览器访问 http://localhost:5173
2. 输入 GitHub 仓库 URL，点击索引
3. 等待索引完成
4. 尝试搜索和问答功能

---

## 常见问题

### Q1: 为什么选择 pgvector 而不是专门的向量数据库？

**A**: 
- **简化架构**: 不需要额外维护向量数据库
- **事务支持**: 可以在同一事务中操作关系数据和向量数据
- **成本**: 减少基础设施成本
- **性能**: 对于中小规模数据集，性能足够

### Q2: 如何处理大型仓库？

**A**:
- **流式处理**: 不一次性加载所有文件到内存
- **批量向量化**: 每次处理 100 个代码块
- **增量索引**: 只处理变更的文件
- **后台任务**: 使用队列异步处理

### Q3: 向量搜索的准确度如何提高？

**A**:
- **混合搜索**: 结合关键词搜索和向量搜索
- **重排序**: 使用更强的模型对结果重排序
- **上下文增强**: 在向量化时包含更多上下文信息
- **微调模型**: 使用领域数据微调嵌入模型

### Q4: 如何降低 API 成本？

**A**:
- **缓存**: 缓存常见查询的向量
- **批量处理**: 减少 API 调用次数
- **本地模型**: 使用开源模型（如 sentence-transformers）
- **增量更新**: 只对变更的代码重新向量化

### Q5: 如何支持更多编程语言？

**A**:
1. 安装对应的 tree-sitter 语言包
2. 在 `parsers/` 目录创建新的解析器
3. 实现语言特定的节点提取逻辑
4. 在 `indexer.ts` 中注册新的解析器

示例：

```typescript
// parsers/java-parser.ts
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';

export class JavaParser {
  private parser: Parser;
  
  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(Java);
  }
  
  extractFunctions(code: string) {
    const tree = this.parser.parse(code);
    return tree.rootNode.descendantsOfType('method_declaration');
  }
}
```

---

## 进阶学习资源

### 向量数据库和搜索

- [pgvector 官方文档](https://github.com/pgvector/pgvector)
- [Pinecone 学习中心](https://www.pinecone.io/learn/)
- [向量搜索原理](https://www.youtube.com/watch?v=QvKMwLjdK-s)

### RAG 架构

- [LangChain RAG 教程](https://python.langchain.com/docs/use_cases/question_answering/)
- [Building RAG Applications](https://www.deeplearning.ai/short-courses/building-applications-vector-databases/)

### 代码分析

- [tree-sitter 文档](https://tree-sitter.github.io/tree-sitter/)
- [AST Explorer](https://astexplorer.net/) - 在线查看 AST

### AI API

- [OpenAI Embeddings Guide](https://platform.openai.com/docs/guides/embeddings)
- [Anthropic Claude API](https://docs.anthropic.com/claude/reference/getting-started-with-the-api)

---

## 贡献指南

欢迎贡献代码！请查看 [CONTRIBUTING.md](./CONTRIBUTING.md)

## 许可证

MIT License - 详见 [LICENSE](./LICENSE)

---

**祝学习愉快！如有问题，欢迎提 Issue。**
