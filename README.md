# CodeLens - 代码智能问答平台

面向私有代码仓库的代码智能问答与根因分析平台。

## 功能特性

- **仓库接入**: 支持 GitLab 地址和 ZIP 包上传
- **代码解析**: AST 解析 TypeScript/JavaScript/Vue 代码
- **智能检索**: 关键词搜索 + 语义向量检索
- **功能定位**: 精准返回文件、函数、行号
- **智能问答**: 基于 LLM 的代码方案问答
- **根因分析**: Bug 根因定位和调用链分析

## 技术栈

### 前端
- React 18 + TypeScript
- TanStack Query
- React Router
- Tailwind CSS

### 后端
- Fastify
- BullMQ + Redis (任务队列)
- PostgreSQL + pgvector (向量检索)
- Babel Parser (AST 解析)
- Anthropic Claude API (LLM)
- OpenAI Embeddings API (向量化)

## 环境要求

- Node.js >= 18
- PostgreSQL >= 14 (需要 pgvector 扩展)
- Redis >= 6
- pnpm >= 9

## 快速开始

### 1. 安装依赖

```bash
# 升级 Node.js 到 v18+
nvm install 18
nvm use 18

# 安装依赖
pnpm install
```

### 2. 配置数据库

```bash
# 安装 PostgreSQL 和 pgvector
# macOS
brew install postgresql@14
brew install pgvector

# 启动 PostgreSQL
brew services start postgresql@14

# 创建数据库
createdb codelens

# 安装 pgvector 扩展
psql codelens -c "CREATE EXTENSION vector;"
```

### 3. 配置 Redis

```bash
# macOS
brew install redis
brew services start redis
```

### 4. 配置环境变量

在 `apps/api` 目录创建 `.env` 文件:

```env
# 数据库
DB_HOST=localhost
DB_PORT=5432
DB_NAME=codelens
DB_USER=postgres
DB_PASSWORD=postgres

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# API Keys
ANTHROPIC_API_KEY=your_anthropic_api_key
OPENAI_API_KEY=your_openai_api_key

# 服务端口
PORT=8787
```

### 5. 启动服务

```bash
# 启动 API 服务
pnpm dev:api

# 启动前端 (新终端)
pnpm dev:web
```

访问 http://localhost:5173

## 使用指南

### 1. 接入仓库

**GitLab 接入**:
- 输入仓库名称和 GitLab URL
- 点击"接入仓库"
- 系统会自动克隆并索引代码

**ZIP 上传**:
- 选择代码包 (.zip)
- 上传后自动解压并索引

### 2. 搜索代码

- 选择仓库
- 输入关键词或语义描述
- 查看匹配的代码片段和行号

### 3. 智能问答

示例问题:
- "登录方案是什么？"
- "这个页面的数据流怎么走？"
- "token 刷新逻辑在哪里？"

### 4. 根因分析

描述 bug:
- "登录一天要登录好几次，什么原因？"
- "为什么这个页面会重复请求？"

系统会分析调用链并给出根因。

## 项目结构

```
CodeLens/
├── apps/
│   ├── web/          # React 前端
│   │   └── src/
│   │       ├── App.tsx
│   │       ├── main.tsx
│   │       └── styles.css
│   └── api/          # Fastify 后端
│       └── src/
│           ├── index.ts        # API 入口
│           ├── db/             # 数据库层
│           ├── parser/         # 代码解析
│           ├── indexer/        # 索引构建
│           └── llm/            # LLM 集成
├── package.json
└── pnpm-workspace.yaml
```

## API 接口

### 仓库管理
- `GET /repos` - 获取仓库列表
- `POST /repos` - 创建 GitLab 仓库
- `POST /repos/upload` - 上传 ZIP 包

### 搜索与问答
- `GET /search?repoId=1&q=login` - 搜索代码
- `POST /ask` - 智能问答
- `POST /root-cause` - 根因分析

### 历史记录
- `GET /questions` - 问答历史

## 核心能力

### 代码解析
- 支持 TypeScript/JavaScript/Vue
- AST 级别的符号提取
- 函数、类、方法、变量识别
- import/export 关系分析
- 调用链追踪

### 检索能力
- 全文关键词搜索
- 语义向量检索 (OpenAI Embeddings)
- 混合检索结果去重
- 精准到行号的定位

### LLM 编排
- 证据汇总
- 方案解释
- 根因推理
- 调用链分析

## 生产部署

### 一键部署

本地代码修改后，执行以下命令一键部署到服务器：

```bash
npm run deploy
```

部署脚本会自动：
1. 构建前端和后端代码
2. 上传到服务器
3. 重启 PM2 服务

详细部署文档请查看 [DEPLOYMENT.md](./DEPLOYMENT.md)

### 学习指南

如果你是初学者，想深入了解项目架构和实现细节，请阅读：

📚 [CodeLens 完整学习指南](./LEARNING_GUIDE.md)

该文档包含：
- 项目架构详解
- 核心模块源码解析
- 关键技术实现
- 从零开始的开发指南

### 性能优化

- 向量索引使用 IVFFlat
- 代码块批量向量化
- Redis 缓存热点查询
- 增量索引更新

## 常见问题

**Q: Node 版本太低怎么办？**
A: 使用 nvm 升级到 Node 18+

**Q: pgvector 扩展安装失败？**
A: 确保 PostgreSQL 版本 >= 14，参考官方文档安装

**Q: 索引速度慢？**
A: 调整 BullMQ 并发数，批量生成 embeddings

**Q: LLM 调用失败？**
A: 检查 API Key 配置，确保网络可访问

## 后续规划

- [ ] 支持更多语言 (Python, Go, Java)
- [ ] 增量索引优化
- [ ] PR 分析和代码审查
- [ ] 版本对比和变更分析
- [ ] 自动诊断和修复建议
- [ ] 团队协作和知识沉淀

## License

MIT
