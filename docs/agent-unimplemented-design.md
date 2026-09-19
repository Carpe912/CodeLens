# Agent 未实现部分的设计意图

> **状态**：全部为「设计意图」，**尚未实现**。
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

---

## 当前实现的真实边界

`AgentCore` 是一条**单轮线性管道**，不具备下列任何能力：

```
分类(正则) → 多策略检索(1 次) → LLM 生成(1 次) → 落库
```

未实现清单（与 `AGENT_CAPABILITIES` 常量保持一致）：

| 能力 | 状态 | 相关死配置 / 空表 |
|---|---|---|
| 多轮推理循环 | ❌ 未实现 | `config.maxReasoningRounds` |
| 自我反思 | ❌ 未实现 | `config.enableReflection`、`agent_reflections` 表 |
| 任务分解与重规划 | ❌ 未实现 | `TaskPlanner` |
| 跨轮会话记忆 | ❌ 未实现 | `config.enableLearning`、`conversation_memory` 表 |
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

**现状**：`apps/api/src/agent/planner.ts` 中的类为空实现。任务类型分类由 `agent-core.ts`
内部的**关键词正则**完成（`classifyTaskType`），没有 LLM 参与，也没有真正的计划对象产出。

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

> ⚠️ 注意区分：当前 `AgentResponse.confidence` 是 `agent-core.ts` 里
> `estimateConfidence()` 依据"证据条数与相关度"算出的**启发式分数**，
> 不是这里描述的、基于假设图的置信度。两者语义不同，不要混用。

**现状**：完全未实现。`AgentResponse.reasoning` 恒为空数组。

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
每轮独立的无状态单轮。`conversation_memory` 表为空且零代码引用。

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

**现状**：完全未实现。`agent_reflections` 表已建好（含 `round`、`on_track`、`needs_replan` 字段）
但零代码引用；`AgentResponse.metadata.reflections` 恒为 0。

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

**现状**：完全未实现。检索被**硬编码**在 `agent-core.ts` 的 `gatherEvidence()` 中，只调用
`MultiStrategySearch.search()` 一个入口。`tool_calls` 表零代码引用。

> 补充：`agent-core.ts` 现已写入 `toolCallHistory` 并发出 `tool_called` 事件，
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
