# Claude Code Prompt：实现企业级 Agentic RAG 系统

你是一个资深 AI 系统架构师 + 全栈工程师，请基于以下要求实现一个**可运行的企业级 Agentic RAG 项目（MVP，但结构必须专业）**。

---

## 🎯 项目目标

实现一个 **Agentic RAG 问答系统**，具备以下能力：

- 动态决策是否检索
- 多轮检索（支持 retry）
- query rewrite
- hybrid retrieval（vector + keyword）
- reranking
- reflection（失败自动重试）
- 输出带 citation

---

## 🧠 核心架构要求（必须遵守）

系统必须采用如下分层：

```text
Frontend（可选）
   ↓
API Layer
   ↓
Agent Layer（核心）
   ↓
Tool Layer（RAG / SQL / API）
   ↓
Retrieval System
   ↓
LLM
```

---

## 🧩 Agent 设计（必须实现）

请实现一个明确拆分的 Agent：

### 1. Planner

- 判断是否需要检索
- 判断是否需要多轮检索

---

### 2. Tool Router

支持选择：

- RAG（默认）
- （预留）SQL / API

---

### 3. Reflection（关键）

必须实现：

- 判断 retrieval 是否成功
- 如果失败：
  - 改写 query
  - 重试（最多 2-3 次）

---

## 🔍 Retrieval 系统要求

必须实现：

### 1. Query Rewrite

- 至少生成 2 个 query

---

### 2. Hybrid Retrieval

实现组合：

- Vector Search（embedding）
- Keyword Search（BM25 或简化版）

---

### 3. Rerank

- 简单实现（可用 cosine / 模拟）
- 或使用已有 reranker

---

### 4. Context Builder

- 限制 token（如 top-k）
- 拼接上下文

---

## 🔁 执行流程（必须符合）

```text
1. 用户输入

2. Agent Planner
   → 是否检索

3. Query Rewrite

4. Tool Router → RAG

5. Retrieval（hybrid）

6. Rerank

7. Context 构建

8. Reflection 判断：
   如果结果不好：
      → rewrite
      → retry

9. LLM 生成答案

10. 输出（带 citation）
```

---

## 🧱 技术要求

### 后端

- Node.js（TypeScript）或 Python（优先 Python）
- 清晰模块划分

---

### LLM

- 可用 OpenAI / Claude / mock

---

### Embedding

- 可用真实 API 或 mock

---

### 向量存储

- 可用内存实现（MVP）
- 或 FAISS / 简单数组

---

### Keyword Search

- 简单 BM25 或关键词匹配即可

---

## 📂 项目结构（必须输出）

必须生成类似：

```text
project/
 ├── agent/
 ├── retrieval/
 ├── tools/
 ├── memory/
 ├── llm/
 ├── api/
 ├── config/
 ├── data/
 └── main.py / server.ts
```

---

## 📊 必须实现的功能

- [ ] Agent（planner + router + reflection）
- [ ] query rewrite
- [ ] hybrid retrieval
- [ ] rerank
- [ ] retry机制
- [ ] citation输出

---

## 📈 可观测性（必须有）

请输出日志：

- 每次 query rewrite
- 每次 retrieval 结果
- 是否 retry
- 最终使用的 context

---

## 🧪 Demo 要求

请提供：

### 示例数据

（几条文档）

---

### 示例问题

例如：

- “公司利润下降原因是什么？”

---

### 示例输出

必须包含：

- 答案
- 引用来源（doc id）

---

## 🚨 重要约束

- 不要只写伪代码，必须是**可运行代码**
- 不要省略核心模块（Agent / Retrieval）
- 不要把所有逻辑写在一个文件里
- 必须体现“多轮检索 + 反思机制”

---

## 🧠 设计原则（必须遵守）

- RAG 是工具，不是主流程
- Agent 控制流程
- Retrieval 必须支持 retry
- 结构优先于功能堆叠

---

## ✅ 输出内容

请按顺序输出：

1. 项目结构
2. 关键模块代码
3. 运行方式
4. 示例运行结果

---

## 🧩 加分项（可选）

- Memory（对话上下文）
- Graph RAG（简单版）
- Web UI（简单即可）

---

## 🧠 一句话目标

实现一个：

👉 **具备“决策 + 检索 + 反思 + 重试”的 Agentic RAG 系统**

项目：企业级 Agentic RAG 问答系统

设计并实现基于 Agent 的 RAG 架构，将检索从静态 pipeline 升级为动态决策系统
构建多轮检索机制，引入 query rewrite、hybrid search 和 reranking，提升检索召回率
实现反思（reflection）机制，在检索不足时自动重试，提高回答准确性
集成向量检索、关键词检索及结构化查询，实现多工具协同
设计 memory 模块（短期 + 长期），提升对话连续性
搭建评估体系（recall / faithfulness），支持系统优化与调优
🧠 最后一句（点醒你）

真正的企业级 RAG，不是“把检索做好”
而是：
让系统知道什么时候检索、怎么检索、检索错了怎么办
