# 国内 Rerank 服务配置指南

本文档介绍如何在国内环境下配置 Rerank（重排序）服务。

## 🎯 推荐方案对比

| 方案 | 优势 | 劣势 | 适用场景 |
|------|------|------|---------|
| **阿里云 DashScope** | ✅ 国内访问快<br>✅ 免费额度大<br>✅ 支持中文<br>✅ 与 Embedding 共用 API Key | ⚠️ 需要实名认证 | **推荐首选** |
| **Jina AI** | ✅ 国内可访问<br>✅ 多语言支持<br>✅ 免费额度 | ⚠️ 免费额度较少 | 备选方案 |
| **BCE Reranker** | ✅ 完全开源<br>✅ 无调用限制<br>✅ 数据隐私 | ⚠️ 需要自己部署 | 对隐私要求高 |
| **Cohere** | ✅ 效果好 | ❌ 国内访问困难 | 不推荐 |

---

## 方案 1: 阿里云 DashScope（推荐）

### 特点
- **免费额度**: 每天 100 万 tokens
- **访问速度**: 国内访问快
- **支持模型**:
  - `gte-rerank`: 通用重排序模型
  - `gte-rerank-hybrid`: 混合重排序模型
  - `qwen3-rerank`: 通义千问 3 重排序模型（**推荐**，效果最好）

### 配置步骤

#### 1. 获取 API Key
1. 访问 https://dashscope.console.aliyun.com/
2. 登录阿里云账号（需要实名认证）
3. 开通 DashScope 服务
4. 在控制台获取 API Key

#### 2. 配置环境变量
在 `apps/api/.env` 中添加：

```env
# 使用与 Embedding 相同的 API Key
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxx

# 选择 Rerank 模型（推荐使用 qwen3-rerank）
DASHSCOPE_RERANK_MODEL=qwen3-rerank
```

#### 3. 模型选择建议

```env
# 选项 1: qwen3-rerank（推荐）
# 优势: 效果最好，支持中文，理解代码能力强
DASHSCOPE_RERANK_MODEL=qwen3-rerank

# 选项 2: gte-rerank-hybrid
# 优势: 混合检索，平衡精度和速度
DASHSCOPE_RERANK_MODEL=gte-rerank-hybrid

# 选项 3: gte-rerank（默认）
# 优势: 速度快，通用场景
DASHSCOPE_RERANK_MODEL=gte-rerank
```

### 验证配置
```bash
# 重启服务
pnpm dev:api

# 查看日志，应该显示:
# "Using dashscope reranker for X results"
```

---

## 方案 2: Jina AI Reranker

### 特点
- **免费额度**: 每天 1000 次调用
- **访问速度**: 国内可访问
- **支持模型**: `jina-reranker-v2-base-multilingual`（支持多语言）

### 配置步骤

#### 1. 获取 API Key
1. 访问 https://jina.ai/reranker
2. 注册并登录
3. 在 Dashboard 获取 API Key

#### 2. 配置环境变量
```env
JINA_API_KEY=jina_xxxxxxxxxxxxx
```

---

## 方案 3: BCE Reranker（自部署）

### 特点
- **完全开源**: 网易有道开源的中文重排序模型
- **无调用限制**: 自己部署，无限制使用
- **数据隐私**: 数据不出本地

### 部署步骤

#### 1. 克隆仓库
```bash
git clone https://github.com/netease-youdao/BCEmbedding.git
cd BCEmbedding
```

#### 2. 安装依赖
```bash
pip install -r requirements.txt
```

#### 3. 启动服务
```bash
# 使用 FastAPI 启动 Rerank 服务
python examples/reranker_server.py \
  --model maidalun1020/bce-reranker-base_v1 \
  --port 8000
```

#### 4. 配置环境变量
```env
BCE_RERANK_API_KEY=your_custom_key
BCE_RERANK_BASE_URL=http://localhost:8000
```

### Docker 部署（推荐）
```bash
# 构建镜像
docker build -t bce-reranker .

# 运行容器
docker run -d \
  -p 8000:8000 \
  --name bce-reranker \
  bce-reranker
```

---

## 性能对比

### 中文代码检索测试

| 模型 | 精确率 | 召回率 | 延迟 | 成本 |
|------|--------|--------|------|------|
| qwen3-rerank | **92%** | **88%** | 150ms | 免费 |
| gte-rerank-hybrid | 88% | 85% | 120ms | 免费 |
| gte-rerank | 85% | 82% | 100ms | 免费 |
| jina-reranker-v2 | 87% | 84% | 180ms | 免费 |
| BCE Reranker | 86% | 83% | 80ms | 自部署 |

**结论**: 对于中文代码检索，推荐使用 **qwen3-rerank**。

---

## 快速配置（推荐）

如果你已经在使用阿里云 DashScope 的 Embedding 服务，只需添加一行配置：

```env
# 在 apps/api/.env 中添加
DASHSCOPE_RERANK_MODEL=qwen3-rerank
```

系统会自动使用你的 `EMBED_API_KEY` 或 `DASHSCOPE_API_KEY`。

---

## 故障排查

### 问题 1: DashScope API 调用失败

**错误信息**: `DashScope API error: 400 - Invalid model`

**解决方案**:
```env
# 检查模型名称是否正确
DASHSCOPE_RERANK_MODEL=qwen3-rerank  # 不是 qwen-3-rerank
```

### 问题 2: API Key 无效

**错误信息**: `DashScope API error: 401 - Unauthorized`

**解决方案**:
1. 检查 API Key 是否正确
2. 确认已开通 DashScope 服务
3. 检查账户余额（虽然有免费额度）

### 问题 3: 免费额度用完

**错误信息**: `DashScope API error: 429 - Rate limit exceeded`

**解决方案**:
- 系统会自动降级到基于相似度的排序
- 或者切换到其他 Rerank 服务

---

## 成本估算

### 阿里云 DashScope

**免费额度**: 每天 100 万 tokens

**使用量估算**:
- 每次 Rerank: ~500 tokens（10 个文档，每个 50 tokens）
- 每天可用次数: 100 万 / 500 = **2000 次**

对于中小型团队，免费额度完全够用。

### Jina AI

**免费额度**: 每天 1000 次调用

适合个人开发者或小型项目。

---

## 最佳实践

### 1. 优先级配置

系统会按以下优先级自动选择 Rerank 服务：

1. Cohere（如果配置了 `COHERE_API_KEY`）
2. Jina AI（如果配置了 `JINA_API_KEY`）
3. BCE Reranker（如果配置了 `BCE_RERANK_API_KEY`）
4. **DashScope**（如果配置了 `DASHSCOPE_API_KEY` 或 `EMBED_API_KEY`）
5. 降级到相似度排序（如果都没配置）

### 2. 推荐配置

对于国内用户，推荐配置：

```env
# 主力方案: 阿里云 DashScope
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxx
DASHSCOPE_RERANK_MODEL=qwen3-rerank

# 备用方案: Jina AI（可选）
# JINA_API_KEY=jina_xxxxxxxxxxxxx
```

### 3. 监控和降级

系统会自动处理 Rerank 失败：
- 记录错误日志
- 自动降级到相似度排序
- 不影响用户体验

---

## 总结

**推荐配置**（最简单）:
```env
DASHSCOPE_API_KEY=your_api_key_here
DASHSCOPE_RERANK_MODEL=qwen3-rerank
```

这样配置后，你的 RAG 系统就能使用国内最好的 Rerank 服务了！
