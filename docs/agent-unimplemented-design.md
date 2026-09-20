# Agent 未实现部分的设计意图

> **状态**：本文描述的这些能力**均未实现**（作用域：v1 `AgentCore`，见下文说明）。
>
> **唯一的两处例外**：
>
> 1. **「有界迭代」**：`apps/api/src/agent/graph/`（LangGraph）已落地，
>    但**线上默认关闭**，且只覆盖「迭代」——不含推理、反思、记忆、工具注册。详见「已经落地的部分」。
> 2. **「跨轮会话记忆」**（2026-09-20 新增）：已在 **`/ask` 路由**落地，
>    与 `AgentCore` 无关（`AgentCore.run()` 仍然不读历史）。实现
>    `apps/api/src/agent/conversation-memory.ts`，见下文「2026-09-20 已落地的两项」。
>
> 也就是说：**`AgentCore` 这条管道本身依然没有记忆、推理、反思、规划**，
> 但产品对用户暴露的主链路（`/ask`）已经具备跨轮上下文。
>
> 本文承接原先散落在 `apps/api/src/agent/` 下 5 个占位文件 JSDoc 中的设计笔记。
> 那些笔记原本挂在 `export class X {}` 这样的空类上，容易让读者误以为能力已经存在。
> 现统一归位到本文档：**代码文件只描述代码实际做了什么，设计方案放这里。**
>
> 原始逐字内容见 git 历史（`apps/api/src/agent/{planner,reasoning,memory,reflection,tool-registry}.ts`）。
>
> **2026-09 更新**：那 5 个空占位文件（以及配套的 `add_agent_tables.sql` 迁移）已**删除**。
> 删除理由：它们构造即抛错、零代码引用，只是"未来设计"的壳；保留会让静态分析
> 与新人误判能力边界。设计意图全部收敛到本文档，需要时再按下面章节落地。
> 下表中提到的 `agent_reflections` / `conversation_memory` / `agent_lessons` / `tool_calls`
> 等表，其建表 SQL 也已一并移除——落地对应能力时需重新添加迁移。
>
> **2026-09-20 复核**（口径：线上 `information_schema`，**不由迁移文件推断**）：
>
> - 这批表的建表 SQL 确实已不在仓库里，但**线上库中依然存在**，共 7 张：
>   `agent_conversations`、`agent_executions`、`agent_lessons`、`agent_performance_stats`、
>   `agent_reflections`、`conversation_memory`、`tool_calls`。
>   ⇒ 由此产生一条**容易踩的落差**：线上有表，但**重新建库不会产生这些表**。
>   落地任一相关能力时必须先补迁移，否则代码会直接撞在缺表上。
> - 7 张中只有 `agent_conversations` 被代码真实读写（`AgentCore.executeQuery()` 写入、
>   `getSession()` 读取）；其余 6 张在 `apps/api/src/` 中**零引用**，且线上**全部 0 行**。
> - ⚠️ **「0 行」不能直接读作「从未被调用」**：错误日志里出现过
>   `[AgentCore] Failed to save conversation`，而该 catch 只打印日志、**不影响响应返回**
>   —— 也就是说存在一类**静默的持久化失败**。要判断某张表究竟是没被调用还是写失败了，
>   必须结合日志，只看行数会得出错误结论。
> - ✅ **同日已修上面的「落差」**：`agent_conversations` 的建表声明已补回
>   `apps/api/src/db/index.ts`（`CREATE TABLE IF NOT EXISTS` + 逐列
>   `ADD COLUMN IF NOT EXISTS` 兜底 + 会话索引），线上表原样可用（幂等 no-op）。
>   同时 `check:sql` 新增了「SQL 引用但 schema 未声明的表」白名单闸门 ——
>   此前这张表正是因为那道闸门**刻意跳过未知表**而长期隐形（详见下方「为什么 0 行」一段）。
> - ⚠️ 另外 6 张表**仍然没有建表声明**，且仍然零引用零行。它们不参与任何闸门校验，
>   属于「既没被用、也没被声明」的状态。

---

## 当前实现的真实边界（v1 `AgentCore`）

`AgentCore` 是一条**单轮线性管道**，不具备下列任何能力：

```
分类(正则) → 多策略检索(1 次) → LLM 生成(1 次) → 落库
```

> ⚠️ **作用域很关键**：下面这份清单描述的是 **v1 `AgentCore`**，不是整个项目。
> 项目另有 `apps/api/src/agent/graph/`——一张 LangGraph **有环图**，已实现**有界多轮**
> （`retrieve → grade →（证据不足则回边换策略重检索）→ generate`）。
> 它经 `POST /agent/v2/query` 暴露、由 `AGENT_GRAPH_ENABLED` 控制，**不替换**
> `/ask`、`/root-cause`、`/agent/query`。
> 所以：v1 的边界描述仍然成立，但**不能据此认为「项目不具备多轮能力」**。
> 该图的实现程度与线上状态见文末「与 LangGraph 的对应关系」。

未实现清单（与 `AGENT_CAPABILITIES` 常量保持一致；该常量同样只描述 v1）：

| 能力 | 状态 | 相关死配置 / 空表 |
|---|---|---|
| 多轮推理循环 | ⚠️ v1 未实现；**v2 图已实现有界多轮**（规则评分驱动，非 LLM 推理） | `config.maxReasoningRounds` |
| 自我反思 | ❌ 未实现 | `config.enableReflection`、`agent_reflections` 表 |
| 任务分解与重规划 | ❌ 未实现 | `TaskPlanner` |
| 跨轮会话记忆 | ✅ **`/ask` 已实现**（2026-09-20）；`AgentCore` 自身仍未实现 | `conversation_memory` 表（仍空置） |
| 学习机制 | ❌ 未实现 | `agent_lessons` 表 |
| 工具动态注册 | ❌ 未实现 | `ToolRegistry`、`tool_calls` 表 |

---

## 1. 任务规划器（TaskPlanner）

**目标**：把复杂问题拆成有依赖关系的可执行步骤，而不是一律走同一条检索路径。

**应包含**：

- **任务分解** — 将复杂任务拆为子任务，识别子任务间依赖，估算各自复杂度
- **计划生成** — 按任务类型选择策略，确定工具调用顺序与参数，产出可执行步骤序列
- **计划优化** — 并行化无依赖步骤、合并相似操作、优先关键路径
- **动态调整** — 依据执行结果调整后续步骤，步骤失败时生成备选方案，支持暂停/恢复/重规划

**规划策略**：前向规划（从现状推进到目标）、后向规划（从目标反推步骤）、分层规划（先高层后细化）。

**现状**：完全未实现。（原来的占位类 `apps/api/src/agent/planner.ts` 已删除，见文首说明。）
任务类型分类由 `core.ts` 内部的**关键词正则**完成（`classifyTaskType`），没有 LLM 参与，
也没有真正的计划对象产出。

---

## 2. 推理引擎（ReasoningEngine）

**目标**：实现 ReAct（Reasoning + Acting）循环。

**循环形态**：

```
while (!达到目标 && 轮次 < 最大轮次) {
  思考：分析当前情况，形成假设
  行动：选择并执行工具
  观察：分析结果，更新假设
  评估：检查是否达到目标或需要调整
}
```

**推理类型**：演绎（一般规则 → 具体结论）、归纳（具体案例 → 一般规律）、溯因（结果 → 推测原因）、类比（相似场景迁移）。

**置信度管理**：每个假设带 0-1 评分，支持证据时上调、反驳时下调；低于阈值则继续收集证据。
终止条件为：达成目标 / 置信度足够 / 轮次耗尽 / 无可用行动。

> ⚠️ 注意区分：当前 `AgentResponse.confidence` 是 `core.ts` 里
> `estimateConfidence()` 依据"证据条数与相关度"算出的**启发式分数**，
> 不是这里描述的、基于假设图的置信度。两者语义不同，不要混用。

**现状**：**v1 `AgentCore` 完全未实现**，`AgentResponse.reasoning` 恒为空数组。

> **唯一沾边的是「迭代」这一层**：`graph/`（v2）已让流程可以回边——`grade` 用**规则判定**
> （`computeSufficiency()` 算出证据充分度、与阈值比较）决定是否打回 `retrieve` 换策略重检索，
> 轮次由 `min(config.maxReasoningRounds, 策略计划长度)` 封顶，且条件边**先查轮次上限**以保证必然收敛。
> 但它**没有**实现本节描述的假设图与置信度推理：判断依据是分数阈值而非逐步推理，也不产出推理链。
> **不要把 v2 的「有界重试」当作 ReAct 已落地。**

---

## 3. 对话记忆（ConversationMemory）

**目标**：让 Agent 具备跨轮上下文。

**三类记忆**：

- **短期记忆** — 当前会话对话历史，维持上下文连贯、解析代词指代
- **长期记忆** — 跨会话持久化知识（成功/失败经验）
- **工作记忆** — 当前任务的中间结果与状态

**管理策略**：容量上限、重要性评分、遗忘机制、长对话摘要压缩。

**存储建议**：长期记忆用向量库以支持语义检索；短期记忆用 Redis 以换取低延迟；工作记忆放内存。

**现状**：完全未实现。`AgentCore.memoryStats` 只是两个计数器，`clearMemory()` 也只是把计数器清零。
`/agent/query` 虽接收 `sessionId` 并写库，但 `run()` **从不读回历史**——所以"多轮对话"实际上是
每轮独立的无状态单轮。

精确到调用点（这里最容易看错）：

- **写入**发生在 `executeQuery()` 中、`run()` **返回之后**，落到 `agent_conversations` 表——
  性质是**审计日志**，不是喂给下一轮的上下文。而且这个 INSERT 被 `try/catch` 包住，
  失败只打日志、**不影响响应**（线上确实出现过 `Failed to save conversation`）。
- **读取**确实存在，但在另一个方法 `getSession()` 里（供「查看会话历史 / 恢复上下文」用）；
  `run()` **不调用它**——这才是「多轮无状态」的真正原因。
- 与本节能力直接对应的 `conversation_memory` 表：线上 0 行、源码零引用。

> ✅ **2026-09-20：本节能力已在别处落地（但不是在 `AgentCore` 里）。**
>
> 真正的跨轮会话记忆做在 **`/ask` 链路**上：`agent/conversation-memory.ts`
> 负责读写 `agent_conversations`，`server/routes/ask.ts` 在调用 LLM 前把它压缩成
> 上下文注入提示词。上面列的「`AgentCore` 不读历史」这三点**依然成立**——
> 两条链路互不影响。
>
> 为什么不去改 `AgentCore` 而是另起一处：线上真实流量走的是 `/ask`
> （前端只调 `/ask`，`/agent/query` 无前端调用方 —— 这正是 `agent_conversations`
> 长期 0 行的原因）。把记忆做在没人走的链路上，等于没做。
> 详见文末「2026-09-20 已落地的两项」。

---

## 4. 反思引擎（ReflectionEngine）

**目标**：让 Agent 具备元认知能力——评估自己的执行过程并调整策略。

**四项功能**：

1. **执行监控** — 跟踪进展、评估中间结果质量、检测异常、测量性能指标
2. **问题识别** — 计划偏离、效率低下、结果质量差、陷入循环、资源不足
3. **策略调整** — 重新规划、切换策略、调整参数、请求人工介入、提前终止
4. **经验学习** — 记录有效方法、分析失败原因、提取教训、持久化到知识库

**触发时机**：定期（每 N 步 / 每 T 秒）、事件驱动（步骤失败、置信度下降、检测到异常）、任务结束后总结。

**评估指标**：进度（onTrack / progress / estimatedRemaining）、质量（confidence / evidenceQuality /
consistencyScore）、效率（timePerStep / toolSuccessRate / resourceUtilization）、问题（issues / severity / needsReplan）。

**现状**：完全未实现。`agent_reflections` 表**线上库中存在**（含 `round`、`on_track`、`needs_replan`
等字段——但建表 SQL 已不在仓库，重新建库不会产生它），线上 0 行、源码零引用；
`AgentResponse.metadata.reflections` 恒为 0。

---

## 5. 工具注册表（ToolRegistry）

**目标**：让工具可注册、可发现、可统一调用。

**四项功能**：

1. **注册** — 登记名称、描述、参数定义、执行函数、校验规则
2. **发现** — 按名称查找、按功能搜索、基于任务类型推荐、按分类管理
3. **调用** — 参数校验、权限检查、执行、结果格式化与验证、错误捕获
4. **调用管理** — 超时控制、失败重试、并发上限、调用历史、性能监控

**设想的工具分类**：

- 搜索类：`vector_search`、`exact_search`、`regex_search`、`file_search`
- 分析类：`parse_code`、`find_references`、`find_definitions`、`analyze_dependencies`
- 文件类：`read_file`、`list_files`、`get_file_info`
- 数据库类：`query_db`、`get_schema`
- LLM 类：`summarize`、`classify`、`extract`

**工具选择策略**：基于任务类型、基于上下文（已知路径则直读，未知则先搜）、基于历史成功率。

**错误处理**：超时取消并记录；网络类错误指数退避重试 3 次，参数类错误不重试；主工具失败降级到备选。

**现状**：完全未实现。检索被**硬编码**在 `core.ts` 的 `gatherEvidence()` 中，只调用
`MultiStrategySearch.search()` 一个入口。`tool_calls` 表零代码引用（线上 0 行，建表 SQL 亦不在仓库）。

> 补充：`core.ts` 现已写入 `toolCallHistory` 并发出 `tool_called` 事件，
> 但这只是**调用日志**，不等于动态工具注册与选择能力。

---

## 与 LangGraph 的对应关系

若要实现上述能力，项目已建好的数据库 schema 与时下主流的图式编排框架高度同构：

| 现有表 / 配置 | 对应 LangGraph 概念 |
|---|---|
| `agent_executions(plan, steps, result, confidence)` | 图状态 / checkpoint |
| `agent_reflections(round, on_track, needs_replan)` | 反思节点 |
| `tool_calls(execution_id, tool_name, params, result)` | ToolNode 调用轨迹 |
| `conversation_memory(session_id, message_type, content)` | BaseStore / 会话记忆 |
| `agent_lessons(failure_reason, solution, success_rate)` | 跨会话经验 |
| `config.maxReasoningRounds` | 图循环上限 |

即：这套 schema 当初是按"状态机 + 迭代 + 反思"设计的，只是从未有代码去驱动它。

### 已经落地的部分（2026-09-20 复核）

`apps/api/src/agent/graph/` 是这套设计的**第一个真实落地件**，但它只覆盖了「迭代」这一层：

| 项 | 实际情况 |
|---|---|
| 依赖 | `@langchain/langgraph ^1.4.15` + `@langchain/langgraph-checkpoint-postgres ^1.0.5` —— **真的在用 LangGraph**，不是手写状态机 |
| 拓扑 | `START → retrieve → grade →（条件边）→ retrieve \| generate → END`；`grade` 为规则判定，那条回边就是「多轮」 |
| 收敛 | `maxRounds = min(config.maxReasoningRounds, 策略计划长度)`，条件边先查轮次上限 ⇒ 最坏情况必然终止 |
| 暴露面 | 仅 `POST /agent/v2/query`（`apps/api/src/server/routes/agent.ts`）；v1 三条路由行为完全不变 |
| 开关 | `AGENT_GRAPH_ENABLED`。**线上进程环境变量中未设置 ⇒ 生产环境未开启** |
| 持久化 | `PostgresSaver` checkpointer，以 `sessionId` 作 `thread_id`，`setup()` 懒建表 |
| 自检 | `pnpm --filter @codelens/api verify:graph`（`src/scripts/verify-graph.ts`） |

> ⚠️ **两个最容易误读的点**：
>
> 1. **代码里有 ≠ 线上在跑。** 该图线上默认关闭，且线上库中**没有任何 `checkpoint*` 表**
>    （`PostgresSaver.setup()` 是懒建表）——这本身就是「这张图在线上从未真正执行过」的证据。
> 2. **上表的"对应关系"目前仍只是形状对齐，并未接通。** `graph/state.ts` 只在注释里声明
>    「本状态字段 → `agent_executions` 列」，**没有一行代码真的往那张表写**；
>    LangGraph 的 checkpoint 落进的是它自己的 `checkpoint*` 表。
>    也就是说：本文档前半部分列的那 6 张 agent 表，与已经落地的 v2 图**还没有接上**。

---

## 2026-09-20 已落地的两项（本次新增）

按「先做投入产出最高的一项」的原则，从上面 6 个未实现能力里只挑了两项落地。
**没做的四项及否决理由见 `.workbuddy/memory/` 的决策记录**，此处只记做了什么、边界在哪。

### 1. 跨轮会话记忆（`/ask` 链路）

| 项 | 实际情况 |
|---|---|
| 位置 | `apps/api/src/agent/conversation-memory.ts`，由 `server/routes/ask.ts` 接线 |
| 载体 | `agent_conversations` 表（线上已存在，**本次同时补回了建表声明**，见文首 2026-09-20 复核） |
| 开启方式 | 请求体带 `sessionId` 即开启；**不带则行为与开启前逐字一致**（不读、不写、走缓存） |
| 读取口径 | `WHERE session_id = $1 AND repo_id = $2 ORDER BY created_at DESC, id DESC LIMIT 3` |
| 注入方式 | `formatConversationContext()` 压缩成文本块，插在「用户问题」与「本轮代码证据」之间 |
| 前端 | `apps/web/src/utils/askSession.ts` 按 repo 存 sessionId；结果卡上方显示「本次会话第 N 轮 · 已注入历史 M 轮」+「新会话」按钮 |
| 自检 | `pnpm --filter @codelens/api verify:memory`（47 项断言 + 真实库往返 25 项） |

**为什么必须带 `repo_id`**：同一 sessionId 可能被复用到别的仓库，不带就会把别的仓库的
代码问答注入进来 —— 模型会顺着错误上下文往下答，而且看上去「言之有据」。

**为什么 `ORDER BY` 要带 `id` 兜底**：只按 `created_at` 排是不确定的。
同一条 `INSERT ... VALUES (...), (...), (...)` 里 `NOW()` 是**事务时间戳**，
三行的 `created_at` 完全相同，此时顺序由存储引擎决定，取回来的「上一轮」可能不是真的上一轮。
（这条已用真实库断言验证：构造同时间戳的三行，仍按插入顺序返回。）

**为什么会话态要绕过 `searchTTLCache`**：缓存键是
`(repoId, query, enhanced, strategy)`，**不含会话历史**。而会话态下同一个问题在
第 1 轮和第 3 轮的正确答案不同。键入相同 ⇒ 第 3 轮会命中第 1 轮的缓存，
返回一个「无视上文」的答案，且响应里看不出异常。

**为什么结尾要写「证据只能来自本轮证据」**：历史里含上一轮答案的 `文件:行号`。
不显式禁止复用，模型会把它们当成证据直接用 —— 而这些引用在本轮证据集里并不存在。

> ⚠️ **不要用「打开 v2 checkpointer」来替代本实现**。`graph/state.ts` 的
> `evidence` / `strategiesUsed` / `trace` 是 `prev.concat(next)` 累积 reducer，
> 且 `round` 不在每轮重置 ⇒ 同一 `thread_id` 上问第二个问题时，
> 第一问的证据会被累加进来、`strategiesUsed` 直接是满的，
> 检索层会误判成「策略都试过了」而不再重试。checkpointer 存的是**执行现场**，
> 不是**对话轮次**，两者不能互相替代。

### 2. 答案↔证据一致性自检

| 项 | 实际情况 |
|---|---|
| 位置 | `apps/api/src/llm/answer-consistency.ts`（纯函数） |
| 接入点 | `/ask` 与 `/root-cause` 的响应新增 `consistency` 字段；前端在答案卡上方给出告警 |
| 判定 | 抽出答案里的 `路径:行号`，与本轮证据比对 → `ok` / `no_refs` / `empty_evidence` / `unsupported_refs` / `line_mismatch` |
| 行为 | **只报告，不改写答案** —— 自动删引用会把「模型编了行号」变成「答案里没有行号」，把问题藏起来 |

要抓的是最危险的一类错：提示词要求模型给出「文件路径和行号」，而**编造的引用在格式上
与真实引用完全一样**，甚至更具体更像真的。用户会默认它可点、可核对。

已知边界（刻意取舍）：文件匹配允许「路径段边界上的后缀匹配」
（`llm/qa.ts` 能匹配 `apps/api/src/llm/qa.ts`），代价是不同目录下的同名文件
（多个 `index.ts`）可能被误判为已匹配。这是**偏向少报**：若对每个裸文件名都报
`unsupported_refs`，报告会被噪声淹没，等于没有这道拦截。

### 3. 顺带修掉的工具调用超时缺口

`withTimeout` 原本是 `agent/core.ts` 的模块私有函数，只保护了**检索**调用；
而真正会把整个 HTTP 请求挂住的是 **LLM 调用** —— 它当时**没有任何超时**，
表现为「页面转圈、服务端日志干净」，极难定位。

现在 `withTimeout` / `withRetry` 抽到 `apps/api/src/utils/async.ts`，
`answerQuestion` / `analyzeRootCause` / `AgentCore.generateAnswer` 三处 LLM 调用
统一套上「超时 + 一次重试」，超时预算 `LLM_TIMEOUT_MS`（默认 60s，比工具调用宽）。

> ⚠️ 超时**只以错误拒绝，不会取消底层 promise**（JS 无法真正取消已发出的请求）。
> 底层仍会跑完，结果被丢弃。所以它不是资源回收手段。

### 4. 闸门缺口修补：`check:sql` 的未知表白名单

`check:sql` 原本**刻意跳过所有未知表**（为避开 CTE / 派生表 / 视图的假阳性）。
代价是：**代码引用了仓库根本没声明的表时，它一声不响地跳过** ——
`agent_conversations` 就是这样藏了很久的（`check:live-schema` 只比对「期望 schema 里
有的表」，也不覆盖它）。

现在改为**显式白名单** `KNOWN_NON_TABLES`：名单内是已确认的 CTE / 视图 / 系统目录
（8 项），名单外一律 FAIL 并给出处置指引。
（已实测：临时插入一处引用 `zzz_undeclared_probe_table` 的 SQL ⇒ 立即 FAIL 且指名道姓。）
