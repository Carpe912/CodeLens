# 04 - 编排层演进：从单轮管道到 LangGraph 图

> **修订说明（2026-09-18）**：本文件原为「AgentRAG 架构升级」，其中第二节至第七节描述的实现
> **在写就当时并不存在于代码中**（详见文末「附录：原内容勘误」）。
> 现已按代码实际情况重写。编排层的多轮能力已于 2026-09 真正落地，见 `apps/api/src/agent/graph/`。
>
> **阅读原则**：本文件出现的每一个数字，要么是代码事实（可当场打开验证），
> 要么是标注了测量方式的实测值。凡不可复现的数字一律不写。

---

## 一、问题：单轮管道的天花板

### 1.1 传统 RAG 的局限性

**传统 RAG 架构：**

```
用户问题 → Embedding → 向量检索 → 拼接上下文 → LLM生成答案
```

**核心问题：**

1. **单次检索的盲目性**
   - 用户问题可能表达不清晰
   - 第一次检索可能方向错误
   - 无法根据中间结果调整策略

2. **缺乏推理能力**
   - 只能做简单的「检索 + 生成」
   - 无法处理需要多步推理的问题
   - 无法综合多个信息源

3. **无法使用工具**
   - 只能依赖向量检索
   - 无法调用代码分析工具
   - 无法读取文件或执行命令

4. **缺少自我纠错**
   - 检索错误无法发现
   - 答案质量无法自我评估
   - 无法主动补充信息

**一个具体的失效场景：**

用户问「查找用户登录相关的 API」

```
1. 向量检索 "用户登录相关的API"
2. 返回 Top 5 结果
3. 拼接到 prompt
4. 生成答案
```

问题在于：
- 检索结果里混入了注册、登出等**相关但不精确**的 API，而模型无法区分
- 用户实际想找的是 OAuth 登录，但向量空间里「登录」和「OAuth」未必接近
- 有些结果必须**读到具体实现才能判断相关性**，而单轮管道没有「读一下再决定」的机会

### 1.2 关键区分：什么问题向量检索解决不了

这是理解本项目的核心，也是面试时值得展开的点。

| 问题类型 | 例子 | 本质 | 向量检索是否适用 |
|---|---|---|---|
| **语义匹配** | 「这段代码干什么」 | 文本相似度 | ✅ 适用 |
| **结构可达性** | 「这个函数在哪被调用」 | 图上的可达性 | ❌ 不适用 |

第二类是**结构性**问题。「users」和「用户列表接口」在向量空间里很近，
但「users」和「api」可能很远——你无法通过调 embedding 模型来解决
「这个 URL 在哪定义」这种问题。

**这正是 CodeLens 手写约 4000 行混合检索的原因**，也是后面判断
「什么该换框架、什么绝对不能换」的依据。

---

## 二、改造前的真实状态（坦诚记录）

2026-09 对代码做了一次完整审计，发现**架构文档描述的能力与代码实际行为存在系统性偏差**。
这一节如实记录，因为它是后续所有判断的依据。

### 2.1 编排层：五个空类撑起约 1600 行

`apps/api/src/agent/` 目录下：

```typescript
export class TaskPlanner {}        // planner.ts
export class ReasoningEngine {}    // reasoning.ts
export class ConversationMemory {} // memory.ts
export class ReflectionEngine {}   // reflection.ts
export class ToolRegistry {}       // tool-registry.ts
```

五个类**全部是空的**，文件体积由 JSDoc 设计文档撑起。
其中 `planner.ts` 还重复声明了全部五个类名，造成四个死代码类。

### 2.2 `AgentCore` 是一条固定三步管道

```typescript
// 改造前的真实实现（简化）
async run(query, context) {
  const task = this.createTask(query, context);          // 1. 正则分类
  const evidence = await this.gatherEvidence(task);      // 2. 检索一次，slice(0,5)
  const answer = await this.generateAnswer(task, evidence); // 3. LLM 生成一次
  return {
    answer, evidence,
    reasoning: [],                    // 恒为空
    confidence: 0.85,                 // ← 硬编码常量
    metadata: {
      stepsExecuted: 1,               // ← 硬编码
      toolsCalled: ['vector_search'], // ← 硬编码
      reflections: 0                  // 无反思机制
    }
  };
}
```

**没有任何循环**。所谓「多轮推理」不存在。

### 2.3 死配置与零引用表

`config.ts` 七个配置项中，**四个没有任何读取点**：

| 配置 | 状态 |
|---|---|
| `maxReasoningRounds: 5` | ⚠️ 无读取点（没有循环可限） |
| `confidenceThreshold: 0.85` | ⚠️ 无读取点 |
| `enableReflection: true` | ⚠️ 无读取点 |
| `enableLearning: true` | ⚠️ 无读取点 |
| `toolTimeout: 30000` | ✅ 现已接入检索调用 |
| `llmModel` | ✅ 生效 |
| `temperature` | ✅ 生效 |

数据库里有 6 张 agent 表，**5 张零代码引用**：
`agent_executions`、`agent_reflections`、`tool_calls`、`conversation_memory`、`agent_lessons`
（只有 `agent_conversations` 被写入）。

**但有个重要判断**：这 6 张表的 schema 是**对的**——
`agent_executions(plan, steps, result, confidence)` 是状态机、
`agent_reflections(round, on_track, needs_replan)` 是反思记录、
`tool_calls(execution_id, tool_name, params, result)` 是工具轨迹。

也就是说：**数据模型先行，只是没有代码去驱动它。**
这个判断直接决定了改造方向——不是删表，而是补上驱动它的编排层。

### 2.4 四套互不兼容的意图分类器

| 位置 | 分类数 | 机制 |
|---|---|---|
| `llm/qa.ts` `classifyQuery` | 8 类 QueryType | 正则 |
| `agent/core.ts` `classifyTaskType` | 4 类 TaskType | 正则 |
| `retrieval/query-intent-parser.ts` | 5 种 action | 正则 |
| `retrieval/multi-strategy-search.ts` | 5 类 intent | 正则 |

同一句「为什么登录失败」在四处得到四个不同的标签，且 agent 层完全无视
qa 层已算出的分类结果。这是**真实的技术债**，也是面试时可以主动说的弱点。

---

## 三、改造边界的决策

这是整个改造中最能体现工程判断力的一步。

| 层 | 决策 | 理由 |
|---|---|---|
| **检索层**（约 4000 行） | **一行不动** | 项目的真实壁垒。换成通用向量存储抽象是**降级** |
| **分块层** | **一行不动** | 已有 AST 级分块，通用字符切分是倒退 |
| **编排层** | **重写为图** | 原实现是空壳 + 硬编码，没有可保留的东西 |
| **索引层 / DB 层 / API 层** | **不动** | 与「缺少编排」这个问题无关 |

**核心判断**：缺的不是检索能力（那 4000 行是真的、有效的），
缺的是**编排能力**——状态机、多轮循环、条件分支、状态持久化。
而这正是 LangGraph 的领域。

> **一句话总结这个决策**：知道什么时候**不**用某个框架，
> 比会用某个框架更重要。

如果当时顺手用 LangChain 把检索层也换掉，会失去
`url-derivation.ts` 那 1571 行积累的跨文件 URL 推导能力——那是买不来的。

---

## 四、编排层的真实实现

### 4.1 图拓扑

```
            ┌──────────────────────────────┐
            │                              │ 证据不足且轮次未用尽
   START → retrieve → grade ───────────────┘
                        │
                        └→ generate → END
```

对应 `apps/api/src/agent/graph/index.ts`：

```typescript
const workflow = new StateGraph(GraphState)
  .addNode('retrieve', createRetrieveNode(search))
  .addNode('grade', createGradeNode())
  // 节点名为 generate 而非 answer：状态里已有 answer 通道，LangGraph 不允许重名
  .addNode('generate', createAnswerNode(deps.generateAnswer))
  .addEdge(START, 'retrieve')
  .addEdge('retrieve', 'grade')
  .addConditionalEdges('grade', routeAfterGrade, {
    retrieve: 'retrieve',
    generate: 'generate',
  })
  .addEdge('generate', END);
```

### 4.2 状态设计（`agent/graph/state.ts`）

用 `Annotation.Root` 定义，关键设计点：

- **累积型通道**（`evidence` / `strategiesUsed` / `trace`）用 reducer 合并，
  便于多轮累积与事后审计
- **阈值放进状态**（`sufficiencyThreshold`）而非闭包 —— 这是为了让条件边
  的判定**完全由状态决定**。如果依赖闭包变量，进程重启后注入的参数可能不同，
  同一份状态会得到不同判定结果。放进状态后 `routeAfterGrade` 是**纯函数**，
  从 checkpoint 恢复的行为完全可复现

### 4.3 逐轮升级的检索策略（`agent/graph/nodes.ts`）

这是原 `TaskPlanner` 设计文档中「根据执行情况调整策略」的最小可用实现——
不引入 LLM 规划，而是把「首轮窄、后续轮逐步放宽」固化成有序表：

| 轮次 | 策略名 | 手段 | 阈值 |
|---|---|---|---|
| 1 | `r1_vector_exact` | 向量 + 精确，偏精准 | 0.3 |
| 2 | `r2_with_dependency` | 加入依赖追踪，顺调用图扩大召回 | 0.25 |
| 3 | `r3_broad` | 全策略 + 降低阈值，尽可能兜住 | 0.2 |

好处：行为可预测、成本可估计、失败模式清晰。
若要接入 LLM 规划，只需替换查表逻辑，**节点契约不变**。

### 4.4 收敛保证（`routeAfterGrade`）

```typescript
export function routeAfterGrade(state: GraphStateType): 'retrieve' | 'generate' {
  if (state.sufficiency >= state.sufficiencyThreshold) return 'generate';
  if (state.round >= state.maxRounds) return 'generate';  // ← 先查上限再考虑重试
  return 'retrieve';
}
```

**判定顺序刻意先查轮次上限**，保证即使在充分度始终不达标的最坏情况下也必然终止。

另外轮次上限的取值有个取舍：

```
maxRounds = min(config.maxReasoningRounds, SEARCH_STRATEGY_PLAN.length)
```

因为策略计划定义的是**互不相同**的检索手段，用尽之后再重复最后一档
只是白白花钱、几乎不会带来新证据。想跑更多轮，应往策略计划里补策略，
而不是把 `maxRounds` 调大。

### 4.5 评分：从假常量到真启发式

改造前 `confidence: 0.85` 是写死的。现在的评分集中在
`utils/scoring.ts`，作为**单一事实来源**供 AgentCore 与图共用，避免两套实现漂移。

**答案置信度**（`estimateConfidenceFromScores`）：
相关性均值占 70%，证据覆盖度占 30%。

**证据充分度**（`computeSufficiency`，用于触发重检索）：

| 维度 | 权重 | 满分条件 |
|---|---|---|
| 条数 | 45% | 3 条及以上 |
| 来源多样性 | 25% | 来自 2 个及以上不同文件 |
| 质量 | 30% | 最高的 3 条分数之均值 |

来源多样性这一维度的作用是**防止 5 条证据全挤在同一个函数里**。

> ⚠️ **必须说清的语义**：这些是**启发式规则**，由「检索到多少、相关度多高、
> 来源是否多样」折算而来，**不是模型输出的概率，也没有经过人工标注校准**。
> 用途是横向比较与触发重检索，**不应对外当作准确性承诺**。

---

## 五、上下文管理的真实机制

改造前文档声称有 `ContextManager` 做 token 级压缩——**这个类不存在**。
真实的上下文处理相当简单，如实记录：

### 5.1 证据上下文扩展

`db/index.ts` 的 `getChunksWithContext(chunks, linesBefore = 5, linesAfter = 5)`：

对每条命中的代码块，从数据库取**前 5 行、后 5 行**拼成 `extended_code`，
使 LLM 看到的不是孤立的函数体，而是带上下文的片段。
`answerQuestion()` 默认启用（`useExtendedContext = true`）。

### 5.2 每轮证据条数上限

图编排层中 `MAX_EVIDENCE_PER_ROUND = 15`，避免多轮累积后把上下文窗口撑爆。

### 5.3 Embedding 输入的截断

`indexing/enhanced-indexer.ts` 中的实际限制：

| 场景 | 限制 |
|---|---|
| 函数 embedding 文本 | `func.code.slice(0, 500)` —— 500 字符 |
| 类 embedding 文本 | `cls.code.slice(0, 500)` |
| embedding 输入总长 | `generateEmbedding(text.slice(0, 8000))` —— 8000 字符 |

**这是真实的取舍**：截断能控制成本与延迟，但会丢失长函数的尾部信息。
如果面试官问「长函数怎么处理」，这是个诚实的切入点。

### 5.4 按查询类型生成不同提示词

`llm/qa.ts` 的 `generateSystemPrompt` / `generateUserPrompt`
按 8 类查询（`url_lookup` / `code_location` / `implementation` /
`architecture` / `bug_analysis` / `usage_example` / `comparison` / `general`）
生成不同结构的回答要求。

这是**目前仍然生效**的能力，但分类依赖正则，是第 2.4 节提到的技术债。

---

## 六、改造前后对比

| 维度 | 改造前 | 改造后 | 可验证方式 |
|---|---|---|---|
| 检索次数 | 恒为 1 | 1 ~ 3（按证据充分度决定） | 看 `trace` 输出 |
| 推理轨迹 | `reasoning: []` 恒空 | `trace` 逐节点记录 | `GET /agent/v2/query` 返回值 |
| 置信度 | 硬编码 0.85 | 由证据启发式算出 | `utils/scoring.ts` |
| 工具调用记录 | 硬编码 `['vector_search']` | 真实写入 + 发事件 | `toolCallHistory` |
| `config` 生效项 | 3 / 7 | 5 / 7 | `config.ts` 注释标注 |
| 循环收敛保证 | 不适用（无循环） | 穷举 `maxRounds` 1..6 证明 | `verify:graph` 脚本 |
| 会话持久化 | 只写不读 | 支持 checkpoint（需显式开启） | `AGENT_GRAPH_CHECKPOINTER` |

### 实测轨迹（可复现）

`pnpm --filter @codelens/api verify:graph` 的 C1 用例输出：

```
[retrieve] 第 1 轮 · 策略 r1_vector_exact · 命中 1 条 · 采纳 1 条 · 耗时 0ms
[grade] 充分度 0.34 / 阈值 0.85 → 证据不足，换策略重检索（还剩 2 轮）
[retrieve] 第 2 轮 · 策略 r2_with_dependency · 命中 3 条 · 采纳 3 条 · 耗时 0ms
[grade] 充分度 0.98 / 阈值 0.85 → 证据充分，进入答案生成
[generate] 基于 4 条证据生成 · 充分度 0.98 · 耗时 0ms
```

**这就是「多轮推理」的真实样子**——不是「平均 3 轮」，而是
「不足则换策略，够了就停」。

### 验证体系

`src/scripts/verify-graph.ts`，30 项断言，三层：

- **A 层 纯函数**：评分边界（空 / NaN / Infinity）、条件边各分支、穷举收敛性
- **B 层 真实依赖探测**：数据库连通性（信息性输出，不计入失败）
- **C 层 循环行为端到端**：桩件注入检索器与生成器，**不依赖数据库和 LLM**
  即可验证「证据不足 → 换策略重检索 → 充足后生成」确实发生

C 层之所以能做，是因为 `createCodeLensGraph` 支持注入 `search` 与 `generateAnswer`。
接口可注入是**为了可测性**，不是为了扩展性——这个区别值得在面试中说清。

---

## 七、一个真实的踩坑（面试官会感兴趣）

给图的状态通道起了 `answer`，节点也叫 `answer`：

```typescript
const workflow = new StateGraph(GraphState)
  .addNode('answer', createAnswerNode())   // ← 状态里已有 answer 通道
```

`tsc --noEmit` **完全通过**，但运行时抛：

```
Error: answer is already being used as a state attribute (a.k.a. a channel),
cannot also be used as a node name.
```

**结论：LangGraph 的这类约束编译期发现不了，必须实际构造图才会暴露。**
所以图编排的验证不能只跑类型检查——这也是后来把
「图构建 + 环路执行」写进验证脚本的原因。

（这个问题能被发现，恰恰是因为先写了验证脚本而不是只跑 `tsc`。这是个好例子：
**测试的价值不只在回归，还在于它强迫你真正执行一次。**）

---

## 八、未来优化方向

### 8.1 短期（真正该先做的）

1. ~~**评测体系**~~ —— ✅ **已在 2026-09-19 落地**（`test-repo/eval/` + `test-repo/TEST_REPORT.md`），
   从本清单划掉。当时的理由「**没有评测的优化都是玄学**」现在有了证据：
   换成真实语料后 `/ask` 覆盖从 100% 掉到 26%，靠评测集定位到一处
   「仓库范围谓词写在恒为 NULL 的列上、导致主表向量召回恒返回 0 行」的缺陷，
   修完回到 19/19。**没有这套东西，它只会表现为「今天好像不太准」。**
   （口径与数字见 `11-面试实战口径与拓展方案.md` §六 与 `test-repo/TEST_REPORT.md` §12）
   - 仍未做：真实工单语料（现有问题是照着代码出的，数字是上界）、
     `questions` / `question_feedback` 的反馈闭环

2. **统一意图分类** —— 淘汰 2.4 节所述的另外三套正则分类器，
   改为一次带 schema 校验的结构化输出调用

3. **流式输出** —— `graph.stream()` 已具备条件，只需接 SSE。
   （注意：改造前**不存在**流式，不要声称有）

### 8.2 中期

1. **多跳查询引擎** —— 把意图**编译**成执行计划，而不是退化成向量召回
   ```
   "所有需要管理员权限的 API"
     → { plan: [ find_symbol(requireAdmin),
                 reverse_traverse(call_graph, depth: 3),
                 filter(symbol_type == "route_handler") ] }
     → 在 call_graph 上做图遍历 → 确定性完整集合
   ```
   难点在于设计查询计划的中间表示，以及为每类算子做代价估算
   （决定走图遍历还是向量召回）。这是数据库领域的经典问题在代码检索上的投影。

2. **影响面分析** —— 反转 `call_graph` 做反向可达性 + 叠加 git blame 推荐 reviewer。
   难点：反向遍历在大型图上会爆炸，需要按层次截断 + 重要性剪枝；
   且动态派发会让静态调用图不完备，必须明确告知用户这是下界。

3. **增量索引** —— 难点不在文件 diff，在**部分失效传播**：
   删一个函数时，指向它的边可能存在于**未变更**的文件里。
   需要 Merkle tree 式的指纹向上聚合。

### 8.3 长期

1. **代码专用 Embedding + 结构增强** —— 不只 embed 代码文本，
   而是把「被谁调用、调用了谁、在哪个模块」也编码进表示。
   难点是需要图节点的表示学习方案，且要能增量更新。

2. **多语言支持** —— 换 tree-sitter 做统一语法树。
   这是一个**真权衡**：TS Compiler API 提供完整类型信息，
   tree-sitter 只给语法树。支持多语言的代价是失去类型信息，
   会让 URL 推导那类能力的精度下降。

3. **MCP Server 化** —— 让 CodeLens 成为 Claude Code / Cursor 可调用的检索后端。
   技术难度不高，但意味着想过分发问题。

---

## 九、面试要点

### 核心卖点（按说服力排序）

1. **手写约 4000 行混合检索** —— 最硬的一条。不是调库，
   `url-derivation.ts` 1571 行的跨文件 URL 拼接链推导是通用框架不提供的能力
2. **主动审计出自己代码与文档不符，并真正修复** —— 展示自我审视能力
3. **改造边界的判断** —— 「检索层一行不动」体现知道何时**不**用框架
4. **可验证的验证体系** —— 30 项断言 + 穷举收敛证明

### 问题预判（真实版本）

**Q: 为什么不用现成的 Agent 框架，或者为什么不全用？**

A: 我确实用了 LangGraph，但**只用它做编排**。检索层没换，因为它解决的是
「这个函数在哪被调用」这类**结构性**问题——这是图上的可达性问题，
不是向量相似度问题。我的核心逻辑在混合检索的融合排序（完全匹配 1.0、
包含完整目标 0.95、被包含 0.85、部分段匹配 0.7），换成通用向量存储抽象
等于把项目最核心的价值换掉。

**Q: 如何保证推理不会陷入死循环？**

A: 两层。一是条件边判定**先查轮次上限再查重试**，最坏情况必然终止；
二是轮次上限取 `min(config.maxRounds, 策略计划长度)`，因为策略计划定义的是
互不相同的检索手段，用尽后重复最后一档只是白花钱。我还写了穷举
`maxRounds` 1..6 的测试来证明收敛。

**Q: 置信度是怎么算的？**

A: 明确的启发式：相关性均值 70% + 证据覆盖度 30%。我要强调它**不是**模型概率，
也没有经过标注校准，用途是横向比较和触发重检索，不是准确性承诺。
代码和文档里都标注了这一点——这类东西一旦被当成模型置信度用，会误导下游。

**Q: 这个项目有什么不足？**

A: 四条，都是真的：
1. 有 4 套并存的意图分类器，术语互不兼容，同一句话得到 4 个标签——应该统一成一次结构化输出
2. 没有评测集，所有质量判断都是主观的，无法证明改动是变好还是变坏
3. 会话是「只写不读」的——`/agent/query` 存会话记录但从不读回历史
4. 只支持 TS/JS——深度依赖 TS Compiler API，换 tree-sitter 会丢掉类型信息

**Q: 成本会不会太高？**

A: 我要诚实说：改造后的多轮会**增加**成本——每多一轮检索就多一次
检索开销和可能的 LLM 调用。目前的控制手段是轮次上限 + 逐轮升级策略
（多数查询首轮即达标，不会进入第二轮）。但我**没有实测的平均轮次数据**，
所以不引用具体成本数字。要真正优化，得先有 8.1 节说的评测体系。

**Q: 为什么改造前的文档会写得不实？**

A: 因为设计意图和实现被混在了一起——那五个文件里的 JSDoc 写的是
「应该怎么做」，读者（包括我自己）会误以为「已经这么做」。
我的修正动作是把设计笔记整体迁到独立文档，代码文件只描述实际行为，
并且让空壳类的构造直接抛错，让误用立刻暴露而不是静默返回 undefined。

---

## 附录：原内容勘误

本文件 2026-05 版本中有以下内容与代码不符，已全部移除：

| 原内容 | 实际情况 |
|---|---|
| 第 77-129 行的 `ReasoningEngine.reason()` 实现（含 `for` 循环、`stopReason === 'tool_use'` 分支、`assessQuality` 0.7 阈值） | `reasoning.ts` 当时是 `export class ReasoningEngine {}`，空类 |
| `ToolRegistry` 的工具注册与调用实现 | 空类；检索入口硬编码在 `agent-core.ts` |
| `ContextManager` 的 token 级压缩（`maxTokens = 180000`） | 该类不存在；真实机制见第五节 |
| 「推理轮次 1轮 → 1-5轮（5x）」 | 改造前恒为 1 轮 |
| 「平均每次推理 3 轮」「单次成本 $0.0405」 | 无轮次概念，无从计算 |
| 「平均推理 8-12 秒 → 4-6 秒（提升 50%）」 | 无可复现的测量过程 |
| 「准确率 75% → 89%」「60% → 100%」 | 无评测集，无法得出此类数字 |
| 「Round 1 搜索…Round 5 汇总」走查案例 | 虚构 |
| 「流式输出：边推理边返回」 | 全仓无 SSE 实现 |
| 「5+ 种工具」「并行工具调用」 | 无工具系统 |

**教训**：把「设计意图」和「实现现状」写在同一份文档里，
是这类偏差的根本原因。现已分离：设计意图在
`docs/agent-unimplemented-design.md`，实现现状在本文与代码。
