# 框架替换的边界：哪些模块**不该**用 LangChain/LangGraph 替换

> 📌 **文档性质**：决策记录（ADR），不是路线图。记录的是「替换到这里为止」的判断与依据，
> 目的是让后来者（包括未来的自己）在动「要不要上框架」的念头时，能先看到已经算过的账。
>
> 🗓️ **状态**：截至 2026-09-23，LLM 抽象层已完成 LangChain 化（见 `refactor(llm)` 提交），
> 本文件记录**剩余 8 处刻意保持原生实现**的模块及理由。
>
> **前置阅读**：`framework-comparison-03-hybrid-architecture.md`（混合架构的正面设计）、
> `docs/deployment/SERVER_RUNBOOK.md` 第 9 节（向量维度事故的排障记录）。

---

## 一、一句话结论

> **框架用在其抽象粒度匹配的地方，原生用在「算法 / 容错 / 数据语义」关键处。**

LangChain 的抽象粒度是「一次 LLM 调用」和「一条 chain」，LangGraph 的是「一个有状态的多步图」。
凡是形状对得上的地方，框架确实更省代码（`llm/client.ts` 就是正面案例，335 → 257 行，
且拿到了结构化输出与提示词模板的入口）；**凡是形状对不上的地方，替换不是省代码，
而是把可控的显式逻辑换成了需要额外对抗的隐式行为。**

---

## 二、速览

| # | 模块 | 行数 | LangChain 对应物 | 结论 | 一句话理由 |
|---|------|-----:|-----------------|------|-----------|
| 1 | `llm/embeddings.ts` | 197 | `Embeddings` / `CacheBackedEmbeddings` | ❌ 不换 | 1536↔1024 维度映射一错，**全库向量静默失效**且不报错 |
| 2 | `retrieval/rerank.ts` | 263 | `DashScopeRerank`（`@langchain/community`） | ❌ 不换 | 冷却 / 双响应形状 / 失败降级三件事框架都不提供 |
| 3 | `utils/async.ts` | 122 | `Runnable.withRetry()` / `.withFallbacks()` | ❌ 不换 | 同时服务 LLM 与非 LLM 调用，换掉会要求调用点反向适配 |
| 4 | `retrieval/multi-strategy-search.ts` | 1466 | `Retriever` 接口 | ❌ 不换 | 5 路带权融合 + 逐轮升级策略，单路 `invoke()` 表达不了 |
| 5 | `agent/conversation-memory.ts` | 287 | `Memory` / `PostgresSaver` checkpointer | ❌ 不换 | 会话历史 ≠ 图状态；已有表和 `verify:memory` 自检会被架空 |
| 6 | `classifyQuery()`（`llm/qa.ts`） | — | LLM 分类 / `RouterChain` | ❌ 不换 | 确定性、零成本、零延迟；用 LLM 是**主动引入**噪声 |
| 7 | `mcp/codelens-mcp.ts` | 326 | MCP SDK | ❌ 不换 | 方向相反（对外暴露能力），且本项目以零依赖为设计前提 |
| 8 | `agent/types.ts` 的未用类型 | ~200 | — | ⚠️ 另议 | 是「未实现架构」的债，**用框架让它"有用"是倒果为因** |

---

## 三、判断准则（可复用的六问）

这六条是从下面的具体案例里**反推**出来的，比结论本身更值得复用。

### 准则 1：谁负责失败？——关键路径上「失败也不能让上游失败」的组件不要换

框架的默认语义是「抛出去，让上层决定」。这在 chain 编排里是对的，
但在**降级是硬要求**的地方，会变成每层都要额外包 try/catch。

- `rerank.ts` 的契约是：**排序是增强，不是依赖**。模型挂了必须退回规则排序，检索整体不能失败。
- `embeddings.ts` 同理：嵌入失败要能降级为「跳过向量路召回」，而不是让整个检索 500。

### 准则 2：失败是响亮的还是静默的？——静默失效区不要换

这是**最贵**的一条。换框架的风险里，崩溃（进程挂、类型错）是最便宜的 —— 立刻发现。
真正贵的是**改了不出错、但结果全错**的语义漂移，它能潜伏数月。

本仓最典型的是向量维度：

```
qwen3.7-text-embedding 原生 1024 维
  ↓ 靠 dimensions: 1536 参数扩到 1536
库里所有向量列是 vector(1536)（migrations/002）
```

如果换 `Embeddings` 抽象层时这个显式参数被「通用封装」吃掉，行为会退化成：
**查询向量与存量向量不在同一语义空间** —— 检索不报错，只是召回结果变成噪声。
排查成本极高，而收益只是少写几十行。同类风险还见于记忆的**仓库作用域**（准则 5）。

### 准则 3：抽象粒度是否匹配形状？——「一个调用」的抽象表达不了「一套算法」

LangChain 的 `Retriever` 契约是 `invoke(query) → Document[]`，单路、无状态、无轮次。
而本仓检索是：

```
5 路召回（向量 / 关键词 / 模糊 / URL / 依赖感知）
  → 加权融合 + 去重 → （可选）rerank 精排 → 截断
  → 不足则按 SEARCH_STRATEGY_PLAN 逐轮升级策略重来
```

这是**算法**，不是编排。用框架实现等于把算法拆散塞进不适配的接口，代码不会变少。
（注：本仓已经用对了方式 —— 图通过 `deps.search` **注入**这个引擎，编排归图、算法归算法，
两边都各得其所。见 `agent/graph/index.ts`。）

### 准则 4：观测面会不会缩水？

自建实现通常顺手挂了观测点，换成框架后这些点会连着一起消失，
而且往往是排查能力先消失、问题后爆发。

- 具体：`embeddings.ts` 里有 `cacheStatsTracker.recordHit/recordMiss('embedding')`，
  被 `GET /admin/cache/stats` 消费（`server/routes/admin.ts:110`）。
  换成 `CacheBackedEmbeddings`，这个端点的数据源就没了 —— 缓存命中率**无法再从外部观测**。
- 通用：替换前先问「现在有哪些日志/指标挂在它身上」，它们是不是要重建。

### 准则 5：替换会不会要求调用点**反向适配**？——好的替换是「实现换、接口不动」

`llm/client.ts` 的改造之所以干净，是因为它**保住了 `messages.create(params)` 这个接口**，
上层（`llm/qa.ts`、`agent/core.ts`、`check-llm.ts`）一行没改。

反例是 `utils/async.ts`：`withRetry` 是**纯函数**，接收 `() => Promise<T>`。
换成 `Runnable.withRetry()` 意味着每个调用点都得先把调用包成 `Runnable`
（要把检索调用、DB 查询也拖进 LangChain 的类型体系）。**为了用重试而改造调用点的数据类型**，
说明抽象层级不匹配。

### 准则 6：依赖成本是否与收益相称？

`@langchain/openai`、`@langchain/core`、`@langchain/langgraph` 是值价的（在用）。
但 `CacheBackedEmbeddings`、`DashScopeRerank` 这类「顺路能用」的类，统一放在
`@langchain/community` —— 一个会把大量与本事无关的第三方包拽进依赖树的伞包。
**为一个类引入一个伞包，是让依赖成本替代码量买单。**

---

## 四、逐项分析

### 4.1 `llm/embeddings.ts`（197 行）—— 不换

**现状**：裸 `openai` SDK（OpenAI 兼容端点）+ 自管 LRU 缓存 + 缓存命中率统计。

| 维度 | 评估 |
|------|------|
| 对应物 | `OpenAIEmbeddings`（`@langchain/openai`，已装）；缓存需 `CacheBackedEmbeddings`（`@langchain/community`，**未装**） |
| 收益 | 约 -60 行；抽象更统一 |
| 成本 | 新增伞包依赖；失去 `cacheStatsTracker` → `/admin/cache/stats` 数据源 |
| 风险 | **维度语义静默漂移**（准则 2）—— 最坏后果是全库检索失效且不报错 |

**结论**：收益是「代码更整齐」，风险是「检索静默全废」。不换。

> 补充：本模块与 LLM 厂商无关（DeepSeek 不提供嵌入模型），
> 所以「统一成一个 LangChain 客户端」这个动机本身也不成立 —— 它跟 `client.ts` 不是一件事。

### 4.2 `retrieval/rerank.ts`（263 行）—— 不换

**现状**：直连 DashScope 原生 `text-rerank` 接口。

三件框架不提供、但线上必需的事：

| 机制 | 为什么必需 | 框架是否提供 |
|------|-----------|-------------|
| **失败冷却 60s** | 模型名错/配额耗尽时，每次检索都白等一次 3s 超时 | ❌ |
| **双响应形状兼容** | 部分模型把 `results` 放**顶层**而非 `output` 内，解析需兼容两种 | ❌ |
| **失败必须降级** | 排序是增强不是依赖，挂了要退回规则排序，检索不能失败 | ⚠️ 需自行包一层 |

对应物 `DashScopeRerank` 同样在 `@langchain/community`（准则 6）。
另外该模块的失败语义是「**只抛错、由调用方降级**」，这个分工与框架 chain 的异常传播方向相反（准则 1）。

**结论**：不换。

### 4.3 `utils/async.ts`（122 行）—— 不换

**现状**：`withTimeout` / `withRetry` 两个纯函数，唯一事实来源。

消费方（grep 可验证）：
- `llm/qa.ts` → LLM 调用（**是** LangChain 的调用点）
- `agent/core.ts:314` → **检索**调用（不是 LLM）
- `agent/core.ts:431` → LLM 调用
- `scripts/verify-memory.ts` → 自检脚本

**理由**（准则 5）：它服务的是「任意 `Promise<T>`」，不是「Runnable」。
换成框架版本会反过来要求调用点改变类型，且会**排除掉非 LLM 的调用点**（检索超时是刚需 ——
`withTimeout` 的诞生就是为了治「检索挂住拖死整个 HTTP 请求」）。

**结论**：不换。

### 4.4 `retrieval/multi-strategy-search.ts`（1466 行）—— 不换

**现状**：5 路召回 + 加权融合 + 去重 + 逐轮升级，**零 LLM 调用**。

**理由**（准则 3）：见上文。这是全仓最大的一块原生实现，也是检索质量的核心资产；
它跟「LLM 编排」没有交集，替换动机不成立。

**已经做对的地方**：`agent/graph/index.ts` 通过 `deps.search` 注入它，
图只负责「什么时候检索、不足怎么办」，算法一行没动。**保持这个分工即可。**

### 4.5 `agent/conversation-memory.ts`（287 行）—— 不换

**现状**：原生 SQL 读写 `agent_conversations`（带 `session_id` / `repo_id`），
有独立自检脚本 `verify:memory`。

**理由**：**这不是「重造了 LangChain Memory」，而是做了一件 LangChain Memory 不做的事**：

| | 持久化内容 | 生命周期 | 本仓归属 |
|---|---|---|---|
| `PostgresSaver` checkpointer | 图内部状态（`evidence` / `strategiesUsed` / `trace` / `round`） | 一次查询的执行现场 | `agent/graph/` |
| `conversation-memory.ts` | 对话轮次（问 + 答） | 用户看到过什么 | `/ask` |

⚠️ **这两者不能互相替代**，文件头已写明原因：`graph/state.ts` 的
`evidence` / `strategiesUsed` / `trace` 用的是 `prev.concat(next)` **累积** reducer，
`round` 也不逐轮重置 —— 直接复用 checkpointer 当会话记忆，第二个问题会把第一个问题的证据
累加进来，`strategiesUsed` 直接满格，检索层误判成「策略都试过了」而**不再重试**。

另外两点（准则 4/5）：换掉会丢「仓库作用域过滤」这个业务语义，以及 `verify:memory`
这套可执行的自检；那张表的历史数据也没有迁移路径。

**结论**：不换。**但需要防的是「以为 checkpointer 顺手就把会话记忆解决了」** —— 这是本仓
最容易被误判的一处。

### 4.6 查询分类（正则版 `classifyQuery`）—— 不换

**现状**：正则/关键词规则识别 8 种查询类型，用于选提示词模板。

**理由**：它是**确定性、零成本、零延迟**的。换成 LLM 分类会引入：一次额外调用
（延迟 + 费用）+ 一次不确定性（同类问题可能分到不同模板 → 答案风格抖动）。
在「选哪个提示词」这种**低风险决策**上，规则是更优解。
（准则：LLM 该用在歧义大、收益高的地方；这里两者都不成立。）

### 4.7 `mcp/codelens-mcp.ts`（326 行）—— 不换

**现状**：手写 ~120 行 JSON-RPC 2.0 handler，**刻意不依赖 `@modelcontextprotocol/sdk`**。

**理由**：方向不同 —— 这是**对外暴露** CodeLens 能力给外部 Agent，
不是消费工具，因此完全不涉及框架选型。而「零依赖、零版本漂移、零安装步骤」
是它的显式设计前提（文件头第 1 条设计选择），换成 SDK 是**逆着设计意图**改。

### 4.8 `agent/types.ts` 的未使用类型（`Tool` / `Reflection` / `Lesson` 等）—— 另议

**现状**：约 200 行类型定义，对应「未实现的架构」（自主规划、反思、学习）。

**关键提醒**：这是**技术债，不是替换机会**。不要因为「上了 LangChain 就能让它们有用」
而去补实现 —— 那是倒果为因：先有需求，再选实现。
当前真实状况是 `AgentCore` 是**单轮线性管道**（无循环、无反思），
`getAgentConfig()` 的 JSDoc 已明确标注哪 4 个环境变量「设了也不会生效」。

**建议**：单独决策「删掉」或「保留并标注为未实现」（现状），与框架选型无关。

---

## 五、对照：`llm/client.ts` 为什么**该**换

为了说明边界不是「保守」，而是「按形状判断」：

| 判断项（准则） | `llm/client.ts` 的答案 |
|---------------|----------------------|
| 粒度匹配？(3) | ✅ 就是「一次 LLM 调用」，与 `ChatOpenAI` 一对一 |
| 接口要改吗？(5) | ✅ 保住 `messages.create(params)`，上层 3 个调用点零修改 |
| 静默风险？(2) | ✅ 可控 —— 有请求形态等价性断言兜底（见下） |
| 观测面？(4) | ✅ 保留 `describeLlmConfig()` / `check:llm` 自检 |
| 依赖成本？(6) | ✅ `@langchain/openai` 是精准包，不是伞包 |
| 谁负责失败？(1) | ✅ 失败语义不变（抛错 → 调用方降级），无额外对抗 |

**并且做了等价性验证**（拦截 `global.fetch` 抓真实请求体，不依赖网络）：

```
URL          https://api.deepseek.com/chat/completions   ✓
model        claude-sonnet-4-6 → 归一化 deepseek-chat     ✓
max_tokens   64（按次覆盖生效）                            ✓
temperature  0（按次覆盖生效）                             ✓
messages     system 为首条，与改造前逐字段一致              ✓
```

这也印证了准则 2 的正面用法：**能不能验证等价**，本身就是「该不该换」的一个判据。

---

## 六、什么时候应该重新评估

边界不是永久的。出现下列**具体**触发条件时，本节结论应被重新审视：

1. **`@langchain/community` 被别处正式引入时**（4.1 / 4.2）
   —— 伞包的依赖成本已经付过了，此时 4.1/4.2 的成本项只剩「语义风险」，值得重算。
   ⚠️ 但**维度静默失效**这条理由不因依赖成本消失而消失。
2. **需要 rerank 支持第二家厂商时**（4.2）
   —— 若真要接入 2+ 家，抽象层开始有意义；届时优先抽**自己的接口**，而不是套用别人的。
3. **`/ask` 需要真正的多轮图编排时**（4.5）
   —— 若把「追问」做成图里的回边，则图状态与会话历史的**交界**需要重新设计，
   但结论仍是两套存储，不是二选一。
4. **检索需要 LLM 参与决策时**（4.4）
   —— 例如「让模型决定用哪路召回」。此时 4.4 会新增「编排」成分，
   但那部分应加在**图**里，检索引擎本身仍是算法。
5. **`AgentCore` 真要升级为自主 Agent 时**（4.8）
   —— 此时 `Tool` / `Reflection` / `Lesson` 才有真实需求；
   但那是「实现未实现的设计」（见 `docs/agent-unimplemented-design.md`），不是「框架替换」。

---

## 七、附：如何验证这些结论没有腐坏

```bash
# 1. 确认伞包确实没被引入（4.1 / 4.2 / 准则 6）
ls apps/api/node_modules/@langchain/
# 期望只有: core  langgraph  langgraph-checkpoint-postgres  openai

# 2. 确认 async.ts 仍在同时服务 LLM 与非 LLM 调用（4.3 / 准则 5）
rg "utils/async" apps/api/src

# 3. 确认会话记忆与 checkpointer 仍是两套（4.5）
rg "agent_conversations" apps/api/src            # 会话记忆
rg "PostgresSaver" apps/api/src                  # 图状态
pnpm --filter @codelens/api verify:memory        # 会话记忆自检

# 4. 确认检索引擎仍可被注入（4.4 / 准则 3）
pnpm --filter @codelens/api verify:graph         # C 层用桩件检索器验证循环行为
```

---

## 八、一句话收尾

**「不可替换」不是保守，是判断：这些地方的价值在算法、容错和数据语义上，
而不在「用哪个框架」上。动了它们，省下的是行数，赔上的是可观测性和静默正确性。**
