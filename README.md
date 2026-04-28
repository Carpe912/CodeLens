# CodeLens - 代码智能问答平台

面向私有代码仓库的代码智能问答与根因分析平台，支持用户反馈和知识积累。

## 功能特性

- **仓库接入**: 支持 GitLab 地址（含 Token 鉴权）和 ZIP 包上传
- **代码解析**: AST 解析 TypeScript/JavaScript/Vue 代码
- **智能检索**: 关键词搜索 + 语义向量检索
- **功能定位**: 精准返回文件、函数、行号
- **智能问答**: 基于 LLM 的代码方案问答
- **根因分析**: Bug 根因定位和调用链分析
- **调用图可视化**: 函数调用关系图谱展示
- **用户反馈系统**: 支持用户补充信息，系统持续学习改进
- **历史反馈集成**: 自动整合历史反馈到新的问答中

## 技术栈

### 前端
- React 18 + TypeScript
- TanStack Query
- React Router
- Tailwind CSS
- Prism.js (代码高亮)
- React Flow (调用图可视化)

### 后端
- Fastify
- BullMQ + Redis (任务队列)
- PostgreSQL + pgvector (向量检索)
- Babel Parser (AST 解析)
- Anthropic Claude API (LLM)
- 阿里云 DashScope Embeddings API (向量化，text-embedding-v3 模型)

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
EMBED_API_KEY=your_dashscope_api_key
EMBED_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBED_MODEL=text-embedding-v3
EMBED_DIMENSIONS=1024

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
- 输入仓库名称
- 输入 GitLab URL (例如: https://gitlab.com/user/repo.git)
- 输入 Personal Access Token (私有仓库必填，公开仓库可选)
  - Token 需要 `read_repository` 权限
- 点击"接入仓库"
- 系统会自动克隆并索引代码

**ZIP 上传**:
- 点击上传区域选择代码包 (.zip)
- 上传后自动解压并索引

### 2. 搜索代码

- 选择已索引的仓库
- 切换到"搜索"模式
- 输入关键词或语义描述
- 支持自动搜索（输入后 800ms 自动触发）
- 查看匹配的代码片段和行号
- 可按文件类型和符号类型筛选结果
- 支持分页浏览

### 3. 智能问答

切换到"问答"模式，示例问题:
- "登录方案是什么？"
- "这个页面的数据流怎么走？"
- "token 刷新逻辑在哪里？"

系统会：
1. 检索相关代码片段
2. 查找历史相似问题的反馈
3. 基于代码证据和历史反馈生成答案
4. 显示历史相关反馈（如果有）

### 4. 用户反馈

在问答结果下方，可以添加反馈：
- 点击"添加反馈或补充信息"
- 输入反馈内容，例如：
  - "这个登录流程已经被废弃，现在使用 OAuth2.0 方式"
  - "当前功能是议题 #456 编写的"
  - "这个方法在 v2.0 中已移除"
- 选择反馈类型：
  - ✓ 有帮助的补充：标记为有价值的信息
  - ⚠ 需要修正：标记为需要改进的内容

下次有人问类似问题时，系统会自动整合这些反馈到答案中。

### 5. 根因分析

切换到"根因分析"模式，描述 bug:
- "登录一天要登录好几次，什么原因？"
- "为什么这个页面会重复请求？"

系统会分析调用链并给出根因。

### 6. 调用图可视化

在搜索结果中，点击任意代码片段的"调用图"按钮：
- 查看函数的调用关系
- 显示被哪些函数调用（calledBy）
- 显示调用了哪些函数（calls）
- 点击节点可以跳转到其他函数的调用图

## 项目结构

```
CodeLens/
├── apps/
│   ├── web/          # React 前端
│   │   └── src/
│   │       ├── App.tsx              # 主应用组件
│   │       ├── components/
│   │       │   └── CallGraph.tsx    # 调用图组件
│   │       ├── main.tsx
│   │       └── styles.css
│   └── api/          # Fastify 后端
│       └── src/
│           ├── index.ts             # API 入口
│           ├── db/                  # 数据库层
│           │   └── index.ts         # 数据库操作
│           ├── parser/              # 代码解析
│           │   └── index.ts         # AST 解析器
│           ├── indexer/             # 索引构建
│           │   ├── queue.ts         # 任务队列
│           │   └── indexer.ts       # 索引逻辑
│           ├── llm/                 # LLM 集成
│           │   ├── embeddings.ts    # 向量化
│           │   └── qa.ts            # 问答逻辑
│           ├── cache.ts             # 缓存管理
│           └── store.ts             # 状态存储
├── package.json
└── pnpm-workspace.yaml
```

## API 接口

### 仓库管理
- `GET /repos` - 获取仓库列表
- `POST /repos` - 创建 GitLab 仓库（支持 Token 鉴权）
- `POST /repos/upload` - 上传 ZIP 包
- `POST /repos/:id/incremental-index` - 增量索引
- `POST /repos/:id/refresh` - 刷新 GitLab 仓库（自动增量更新）

### 搜索与问答
- `GET /search?repoId=1&q=login` - 搜索代码
- `POST /ask` - 智能问答（集成历史反馈）
- `POST /root-cause` - 根因分析

### 反馈管理
- `POST /questions/feedback` - 提交反馈
- `GET /questions/feedback?questionId=xxx` - 获取反馈

### 调用图
- `GET /call-graph?repoId=1&symbolName=login` - 获取函数调用图

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
- 相似问题匹配

### LLM 编排
- 证据汇总
- 方案解释
- 根因推理
- 调用链分析
- 历史反馈集成

### 用户反馈系统
- 反馈存储和管理
- 相似问题检索
- 反馈自动集成到问答流程
- 支持标记反馈类型（有帮助/需修正）
- 系统持续学习和改进

## 数据库表结构

### repos
存储仓库信息
- `id`: 主键
- `name`: 仓库名称
- `source`: 来源类型 (gitlab/zip)
- `url`: GitLab URL
- `gitlab_token`: GitLab Token (加密存储)
- `status`: 状态 (ready/indexing/failed)

### files
存储文件信息
- `id`: 主键
- `repo_id`: 关联仓库
- `path`: 文件路径
- `language`: 编程语言
- `content`: 文件内容

### code_chunks
存储代码片段
- `id`: 主键
- `file_id`: 关联文件
- `symbol_name`: 符号名称
- `symbol_type`: 符号类型
- `line_start`: 起始行
- `line_end`: 结束行
- `code_text`: 代码文本
- `embedding`: 向量 (1024 维，使用阿里云 text-embedding-v3)

### call_graph
存储调用关系
- `id`: 主键
- `from_chunk_id`: 调用方
- `to_symbol`: 被调用符号

### questions
存储问答记录
- `id`: 主键
- `repo_id`: 关联仓库
- `query`: 用户问题
- `answer`: LLM 回答
- `evidence_ids`: 证据 ID 列表

### question_feedback
存储用户反馈
- `id`: 主键
- `question_id`: 关联问题
- `feedback_text`: 反馈内容
- `is_helpful`: 是否有帮助

## 生产部署

### 一键部署

本地代码修改后，执行以下命令一键部署到服务器：

```bash
npm run deploy
```

部署脚本会自动：
1. 检查 Node 版本（需要 >= 18.12）
2. 本地构建前端和后端代码
3. 通过 SSH 上传到服务器
4. 在服务器上安装生产依赖
5. 使用 PM2 重启服务
6. 验证服务健康状态

### PM2 配置说明

生产环境的 PM2 配置（`ecosystem.config.js`）包含内存优化参数：

```javascript
{
  name: 'codelens-api',
  script: './apps/api/dist/index.js',
  node_args: '--expose-gc --max-old-space-size=1024',
  max_memory_restart: '1G',
  env_production: {
    NODE_ENV: 'production',
    // ... 其他环境变量
  }
}
```

关键配置：
- `--max-old-space-size=1024`: 限制 Node.js 堆内存为 1GB
- `--expose-gc`: 启用手动垃圾回收（用于批量索引时释放内存）
- `max_memory_restart`: 内存超过 1GB 时自动重启

### 索引性能优化

针对小内存服务器（1-2GB），系统采用了以下优化策略：

1. **分批处理**：每批处理 3 个文件，避免一次性加载过多文件
2. **批次间延迟**：每批处理后等待 1 秒，让垃圾回收有时间清理内存
3. **手动 GC**：在批次间主动触发垃圾回收
4. **增量更新**：支持 GitLab 仓库增量索引，只处理变更文件
5. **任务超时**：BullMQ 任务锁定时间设为 1 小时，避免长时间索引被误判为超时

### GitLab 仓库刷新

系统支持 GitLab 仓库的自动增量更新：

```bash
# 通过 API 触发刷新
POST /repos/:id/refresh
```

刷新逻辑：
- 首次克隆：全量索引所有文件
- 后续更新：使用 `git diff` 检测变更文件，只索引变更部分
- 自动处理文件新增、修改、删除

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
- 搜索结果缓存 (TTL 5分钟)

## 常见问题

**Q: Node 版本太低怎么办？**
A: 使用 nvm 升级到 Node 18+

**Q: pgvector 扩展安装失败？**
A: 确保 PostgreSQL 版本 >= 14，参考官方文档安装

**Q: 索引速度慢？**
A: 调整 BullMQ 并发数，批量生成 embeddings

**Q: 索引任务失败或卡住？**
A: 
1. 检查服务日志：`pm2 logs codelens-api`
2. 常见原因：内存溢出（OOM）、任务超时、Git 权限问题
3. 重置仓库状态：`UPDATE repos SET status = 'ready' WHERE id = <repo_id>;`
4. 对于大型仓库，系统会自动分批处理（每批 3 个文件）

**Q: 内存不足导致索引失败？**
A: 
1. 系统已针对小内存服务器优化（1-2GB 可用）
2. 使用分批处理 + 手动 GC + 批次间延迟
3. 如果仍然失败，可以进一步减小批次大小（修改 `indexer.ts` 中的 `BATCH_SIZE`）

**Q: LLM 调用失败？**
A: 检查 API Key 配置，确保网络可访问

**Q: 如何获取 GitLab Personal Access Token？**
A: 
1. 登录 GitLab
2. 进入 Settings > Access Tokens
3. 创建新 Token，勾选 `read_repository` 权限
4. 复制 Token 并保存（只显示一次）

**Q: 如何获取阿里云 DashScope API Key？**
A:
1. 访问 https://dashscope.aliyun.com/
2. 注册并登录阿里云账号
3. 开通 DashScope 服务
4. 在控制台获取 API Key

**Q: 反馈功能如何工作？**
A: 
1. 用户提交反馈后，系统会存储到数据库
2. 下次有人问相似问题时，系统会检索历史反馈
3. LLM 会参考这些反馈生成更准确的答案
4. 避免重复给出过时或错误的信息

**Q: GitLab 仓库如何增量更新？**
A:
1. 使用 `POST /repos/:id/refresh` 接口触发刷新
2. 首次克隆会全量索引所有文件
3. 后续更新只索引变更的文件（通过 git diff 检测）
4. 自动处理文件新增、修改、删除

## 后续规划

- [x] GitLab Token 鉴权
- [x] 用户反馈系统
- [x] 历史反馈集成
- [x] 调用图可视化
- [x] 前端界面优化
- [ ] 支持更多语言 (Python, Go, Java)
- [ ] 增量索引优化
- [ ] PR 分析和代码审查
- [ ] 版本对比和变更分析
- [ ] 自动诊断和修复建议
- [ ] 团队协作和知识沉淀
- [ ] 反馈投票和排序
- [ ] 反馈审核机制

## License

MIT
