/**
 * Agent 核心引擎
 *
 * ⚠️ 实现状态（务必先读这一行再看代码）
 *
 * 本类当前是一个**单轮线性管道**，不含任何迭代、反思或规划：
 *
 *   分类(正则) → 多策略检索(1 次) → LLM 生成(1 次) → 落库
 *
 * 已实现：
 * - 任务类型分类（基于关键词正则，非 LLM）
 * - 证据收集（委托给 MultiStrategySearch，单次调用）
 * - 答案生成（委派给 `llm/qa.ts` 的 `answerQuestion`，含查询分类、
 *   扩展上下文、超时与一次重试）
 * - 答案 ↔ 证据引用自检（`llm/answer-consistency.ts`，只观测不改写）
 * - 会话与工具调用记录的持久化
 * - 事件发射（task_started / tool_called / answer / error）
 *
 * 未实现（此前注释与 AGENTRAG_UPGRADE.md 有过不实描述，已于 Phase 0 修正）：
 * - ❌ 多轮推理循环（config.maxReasoningRounds 对本类无效，它只被编排图读取）
 * - ❌ 自我反思（REFLECTIONS_IMPLEMENTED 为 false，reflections 恒为 0）
 * - ❌ 任务分解 / 动态重规划（TaskPlanner 是空类，见 planner.ts）
 * - ❌ 本类不读取历史会话（本管道每轮无状态）
 *   ⚠️ 注意区分：用户实际走的 `/ask` 链路**已经有**跨轮会话记忆
 *   （`agent/conversation-memory.ts`），只是不在这里。见 AGENT_CAPABILITIES。
 * - ❌ 学习机制（config.enableLearning 未被读取）
 *
 * 工作流程：
 * 1. 接收用户查询 -> 2. 分类任务类型 -> 3. 收集相关证据
 * 4. 生成结构化答案 -> 5. 持久化到数据库 -> 6. 返回响应
 */

import type { Pool } from 'pg';
import type {
  Task,
  AgentResponse,
  AgentContext,
  AgentConfig,
  TaskType,
  ToolCall
} from './types.js';
import { MultiStrategySearch } from '../retrieval/multi-strategy-search.js';
import { DEFAULT_SAMPLE_SIZE, estimateConfidenceFromScores } from '../utils/scoring.js';
// 答案 ↔ 证据一致性自检（只观测，不改写答案）
import { checkAnswerConsistency, describeConsistencyIssue } from '../llm/answer-consistency.js';
// 答案生成直接复用 llm/qa.ts，不再自建提示词：见 generateAnswer 的注释
import { answerQuestion } from '../llm/qa.js';
// 证据的统一形状与转换（四条生成链路同源，避免字段名漂移）
import {
  toEvidenceRecord,
  toResponseEvidence,
  type EvidenceRecord,
  type GenerateAnswerFn,
} from './evidence.js';
// 超时实现已抽到 utils/async.ts，与 LLM 调用侧共用同一份（避免两处阈值/文案漂移）
import { withTimeout } from '../utils/async.js';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

/**
 * 能力开关：明确声明哪些 Agent 能力**尚未实现**。
 *
 * 这些常量存在的意义是防止再次出现"文档宣称已实现、代码里其实是常量"的情况。
 * 在真正实现之前，任何下游消费者（前端、指标看板、文档）都应读取这里，
 * 而不是假设 AgentResponse.metadata 里的数字是真实产生的。
 */
export const AGENT_CAPABILITIES = {
  /** 多轮推理循环是否已实现 */
  REASONING_LOOP_IMPLEMENTED: false,
  /** 自我反思是否已实现 */
  REFLECTIONS_IMPLEMENTED: false,
  /**
   * `AgentCore.run()` 是否读取历史会话。
   *
   * ⚠️ 这个字段**只描述 `AgentCore` 自己**，不代表产品有没有会话记忆。
   * 2026-09-20 起，用户实际使用的 `/ask` 链路**已经具备跨轮会话记忆**，
   * 但它实现在 `agent/conversation-memory.ts` + `server/routes/ask.ts`，
   * 与 `AgentCore` 无关（`run()` 依旧不读历史，每轮无状态）。
   *
   * 之所以不把这里改成 true：改了就是撒谎 —— `AgentCore` 确实没有。
   * 之所以要写这么长：不改又有下游（前端 / 指标看板）读到 false
   * 就断言「产品没有会话记忆」的风险。所以用 `ASK_ROUTE_SESSION_MEMORY_IMPLEMENTED`
   * 单独声明后者。
   */
  CONVERSATION_MEMORY_IMPLEMENTED: false,
  /**
   * `/ask` 路由的跨轮会话记忆是否已实现。
   * 与 `AgentCore` 无关，是独立实现（见 `agent/conversation-memory.ts`）。
   */
  ASK_ROUTE_SESSION_MEMORY_IMPLEMENTED: true,
} as const;

/**
 * 当前单轮管道的真实执行阶段。
 * 用于让 AgentResponse.metadata.stepsExecuted 反映实际阶段数，
 * 而不是写死的 1。若将来实现多轮循环，应改为动态累计。
 */
const AGENT_STAGES = ['classify', 'gather_evidence', 'generate_answer'] as const;

/**
 * 默认答案生成实现：复用 `llm/qa.ts` 的 `answerQuestion`。
 *
 * 与 `graph/nodes.ts` 的默认实现是同一个函数 —— 这是本次改造的重点：
 * 四条生成链路（/ask、/root-cause、AgentCore、编排图）从此共用
 * **同一套查询分类 + 提示词工程 + 超时重试**，而不是各写一份。
 */
async function defaultGenerateAnswer(
  query: string,
  evidence: EvidenceRecord[]
): Promise<string> {
  return answerQuestion(query, evidence);
}

/**
 * Agent 核心类
 *
 * 继承自 EventEmitter，支持事件驱动的架构
 * 可以监听 Agent 执行过程中的各种事件
 */
export class AgentCore extends EventEmitter {
  // 多策略搜索引擎：结合向量搜索和精确搜索
  private multiStrategySearch: MultiStrategySearch;

  // 工具调用历史：记录所有工具调用，用于调试和分析
  private toolCallHistory: any[] = [];

  // 记忆统计：跟踪短期和长期记忆的使用情况
  private memoryStats = { shortTermCount: 0, longTermCount: 0 };

  // 答案生成函数：默认走 llm/qa.ts 的 answerQuestion
  private generateAnswerImpl: GenerateAnswerFn;

  /**
   * 构造函数
   *
   * @param db - PostgreSQL 连接池，用于数据持久化
   * @param config - Agent 配置，控制行为参数
   * @param generateAnswer - 可注入的答案生成函数；不传则走 `answerQuestion`。
   *   这个注入点与 `createCodeLensGraph({ generateAnswer })` 是同一个用法，
   *   目的是让「无 LLM 环境下验证引用自检确实生效」成为可能。
   *
   * 此前这里还有第三个参数 `llm: LlmClient`。已随答案生成改为复用
   * `answerQuestion` 一并去掉 —— 它唯一的使用点就是那段自建提示词的
   * `this.llm.messages.create()`。保留一个没人用的客户端只会让
   * 「AgentCore 自己调模型」的错觉继续存在。
   */
  constructor(
    private db: Pool,
    private config: AgentConfig,
    generateAnswer?: GenerateAnswerFn
  ) {
    super();
    // 初始化多策略搜索引擎（检索是纯算法融合，不消耗 LLM）
    this.multiStrategySearch = new MultiStrategySearch(db);
    this.generateAnswerImpl = generateAnswer ?? defaultGenerateAnswer;
    console.log('[AgentCore] Initialized');
  }

  /**
   * 主入口：执行任务
   *
   * 这是 Agent 的核心方法，协调整个任务执行流程
   *
   * @param query - 用户查询字符串
   * @param context - 执行上下文（仓库 ID、会话 ID 等）
   * @returns {Promise<AgentResponse>} Agent 响应，包含答案、证据和元数据
   *
   * 执行流程：
   * 1. 任务理解：分析查询意图，创建结构化任务对象
   * 2. 证据收集：使用多策略搜索收集相关代码片段
   * 3. 答案生成：基于证据使用 LLM 生成结构化答案
   * 4. 响应构建：组装完整响应并触发事件
   *
   * 错误处理：
   * - 捕获所有异常，返回包含错误信息的响应
   * - 触发 'error' 事件，便于外部监控
   */
  async run(query: string, context: AgentContext): Promise<AgentResponse> {
    const startTime = Date.now();
    console.log(`[AgentCore] Starting task: ${query}`);

    // 记录本轮开始时的工具调用水位，用于统计本轮真实调用了哪些工具
    const toolCallWatermark = this.toolCallHistory.length;

    try {
      // 1. 理解任务：将自然语言查询转换为结构化任务
      const task = this.createTask(query, context);
      this.emit('task_started', { type: 'task_started', task });

      // 2. 执行搜索：收集相关代码证据
      //    内部持有的是 EvidenceRecord（含结构化 file_path/line_start/line_end），
      //    对外才转成展示形态的 Evidence —— 自检和置信度都要机器可比的字段。
      const records = await this.gatherEvidence(task);

      // 3. 生成答案：基于证据生成结构化回答
      const answer = await this.generateAnswer(task, records);

      // 3.5 答案引用自检：核对答案里写的「文件:行号」是否真在本轮证据中。
      // generateAnswer 的提示词明确要求"关键证据（文件路径和行号）"，
      // 而编造的引用在形式上与真实引用无异 —— 因此生成之后必须对一遍账。
      // 与 /ask、/root-cause 共用同一实现，同样**只观测、不改写**答案。
      const consistency = checkAnswerConsistency(answer, records);
      const consistencyWarning = describeConsistencyIssue(consistency, '[AgentCore]');
      if (consistencyWarning) console.warn(consistencyWarning);

      // 本轮实际发生的工具调用（不再硬编码为 ['vector_search']）
      const toolsCalled = Array.from(
        new Set(this.toolCallHistory.slice(toolCallWatermark).map(c => c.tool))
      );

      // 4. 构建响应：组装完整的 Agent 响应对象
      const response: AgentResponse = {
        answer,                      // 最终答案文本
        evidence: records.map(toResponseEvidence), // 展示形态：含人读的 source 串
        // 推理轨迹：当前是单轮管道，没有可填充的推理过程，因此确实是空的。
        // 这不是"为了省事留空"，而是多轮推理尚未实现（见文件头实现状态说明）。
        reasoning: [],
        // 由证据数量与相关度启发式估算，取代此前的固定值 0.85
        // 评分规则集中在 utils/scoring.ts，与图编排层共用同一实现
        confidence: estimateConfidenceFromScores(records.map(e => e.score)),
        executionTime: Date.now() - startTime, // 总执行时间
        consistency,                 // 引用自检报告（不改写答案，交调用方处置）
        metadata: {
          planId: task.id,           // 任务 ID
          stepsExecuted: AGENT_STAGES.length, // 真实执行阶段数（分类 → 检索 → 生成）
          toolsCalled,               // 本轮真实调用的工具
          reflections: 0             // 反思机制尚未实现，恒为 0
        }
      };

      // 触发答案事件，供外部监听器处理
      this.emit('answer', { type: 'answer', answer: response });
      console.log(`[AgentCore] Task completed in ${response.executionTime}ms`);

      return response;
    } catch (error: any) {
      console.error('[AgentCore] Task execution failed:', error);
      this.emit('error', { type: 'error', error });

      // 返回错误响应，而不是抛出异常
      return {
        answer: `执行失败: ${error.message}`,
        evidence: [],
        reasoning: [],
        confidence: 0,
        executionTime: Date.now() - startTime,
        metadata: {
          planId: '',
          stepsExecuted: 0,
          // 失败前实际发生的工具调用，便于排查卡在哪一步
          toolsCalled: Array.from(
            new Set(this.toolCallHistory.slice(toolCallWatermark).map(c => c.tool))
          ),
          reflections: 0
        }
      };
    }
  }

  /**
   * 创建任务
   *
   * 将用户的自然语言查询转换为结构化的任务对象
   *
   * @param query - 用户查询字符串
   * @param context - 执行上下文
   * @returns {Task} 结构化的任务对象
   *
   * 任务对象包含：
   * - 唯一 ID：用于跟踪和关联
   * - 任务类型：根据查询内容自动分类
   * - 目标和约束：明确任务的目的和限制
   */
  private createTask(query: string, context: AgentContext): Task {
    const taskType = this.classifyTaskType(query);

    return {
      id: uuidv4(),                  // 生成唯一任务 ID
      description: query,            // 原始查询
      type: taskType,                // 分类后的任务类型
      goal: query,                   // 任务目标（简化版与 description 相同）
      constraints: [],               // 约束条件（可扩展）
      successCriteria: ['回答用户问题'], // 成功标准
      context                        // 执行上下文
    };
  }

  /**
   * 分类任务类型
   *
   * 基于关键词匹配自动识别查询的任务类型
   * 不同类型的任务会采用不同的执行策略
   *
   * @param query - 用户查询字符串
   * @returns {TaskType} 任务类型枚举值
   *
   * 分类规则：
   * - 根因分析：包含"为什么"、"原因"、"bug"、"问题"等关键词
   * - 影响分析：包含"影响"、"修改...会"、"如果...改"等模式
   * - 架构分析：包含"架构"、"设计"、"模式"、"结构"等关键词
   * - 通用查询：其他所有查询
   *
   * 优化建议：
   * 可以使用 LLM 进行更精确的意图识别，而不是简单的关键词匹配
   */
  private classifyTaskType(query: string): TaskType {
    const lowerQuery = query.toLowerCase();

    // 根因分析：查找问题原因
    if (lowerQuery.match(/为什么|原因|bug|问题|错误|异常|失败/)) {
      return 'root_cause_analysis';
    }

    // 影响分析：评估修改影响
    if (lowerQuery.match(/影响|修改.*会|如果.*改/)) {
      return 'impact_analysis';
    }

    // 架构分析：理解系统设计
    if (lowerQuery.match(/架构|设计|模式|结构|整体/)) {
      return 'architecture_analysis';
    }

    // 默认为通用查询
    return 'general_query';
  }

  /**
   * 收集证据
   *
   * 使用多策略搜索从代码库中收集相关证据
   * 结合向量搜索（语义相似度）和精确搜索（关键词匹配）
   *
   * @param task - 任务对象
   * @returns {Promise<EvidenceRecord[]>} 证据列表，按相关性排序
   *
   * 搜索策略：
   * - 向量搜索：基于语义理解，找到概念相关的代码
   * - 精确搜索：基于关键词匹配，找到字面相关的代码
   *
   * 结果处理：
   * - 取相关性最高的 DEFAULT_SAMPLE_SIZE 条
   * - 转换为统一的 EvidenceRecord 格式（与 /ask、编排图同一份转换函数）
   * - 包含文件路径、行号和相关性评分
   *
   * 副作用：
   * - 每次调用都会写入 toolCallHistory 并发出 tool_called 事件
   * - 受 config.toolTimeout 约束，超时视为失败
   *
   * 错误处理：
   * - 搜索失败或超时时返回空数组，不中断任务执行
   * - 记录错误日志便于调试
   */
  private async gatherEvidence(task: Task): Promise<EvidenceRecord[]> {
    const toolName = 'multi_strategy_search';
    const startedAt = Date.now();

    try {
      // 执行多策略搜索；套上 config.toolTimeout，避免检索挂起拖死整个请求
      const results = await withTimeout(
        this.multiStrategySearch.search(
          task.context.repoId,
          task.description,
          { limit: 10, strategies: ['vector', 'exact'] }
        ),
        this.config.toolTimeout,
        toolName
      );

      this.recordToolCall(toolName, startedAt, true);

      // 取相关性最高的若干条并转换为统一证据形状。
      // 转换函数收在 agent/evidence.ts：此前这段字段映射在本文件、/ask 路由
      // 和 graph/nodes.ts 各存一份，任一处漏掉 file_path 就会让
      // checkAnswerConsistency 静默降级为 empty_evidence（不报错、只是不再校验）。
      return results.slice(0, DEFAULT_SAMPLE_SIZE).map(toEvidenceRecord);
    } catch (error) {
      this.recordToolCall(toolName, startedAt, false, error);
      console.error('[AgentCore] Evidence gathering failed:', error);
      return []; // 失败时返回空数组，允许任务继续执行
    }
  }

  /**
   * 记录一次工具调用。
   *
   * 此前 toolCallHistory 从未被写入，导致 getStats().toolCallsCount 恒为 0、
   * metadata.toolsCalled 只能硬编码。现在由这里统一填充并发出事件。
   *
   * @param tool - 工具名称
   * @param startedAt - 调用开始时间戳（毫秒）
   * @param success - 是否成功
   * @param error - 失败时的错误对象
   */
  private recordToolCall(tool: string, startedAt: number, success: boolean, error?: unknown): void {
    const toolCall: ToolCall = {
      id: uuidv4(),
      tool,
      params: {},
      error: error instanceof Error ? error.message : undefined,
      duration: Date.now() - startedAt,
      timestamp: new Date(),
    };

    this.toolCallHistory.push(toolCall);
    this.emit('tool_called', { type: 'tool_called', toolCall });
  }

  /**
   * 生成答案
   *
   * 委派给注入的生成函数，默认即 `llm/qa.ts` 的 `answerQuestion`。
   *
   * @param task - 任务对象
   * @param evidence - 证据列表（EvidenceRecord，含结构化 file_path/行号）
   * @returns {Promise<string>} 生成的答案文本
   *
   * 为什么不再自建提示词：
   * 本方法此前有一段内联提示词 + 直接调 `this.llm.messages.create()`。
   * 它与 `answerQuestion` 做的是同一件事，但**少了三样东西**：
   *   1. 查询类型分类（classifyQuery → 不同问题用不同提示词与结构）
   *   2. 扩展上下文（getChunksWithContext，给证据补前后 5 行）
   *   3. 60s 的 LLM 专用超时预算（这里用的是 config.toolTimeout，
   *      是给**工具调用**设的，比答案生成该有的预算短）
   * 也就是说，同一句问题经 /ask 与经 /agent/query 得到的是两套提示词、
   * 两种上下文、两个超时 —— 而答案质量差异无从解释。现在收敛到一份。
   *
   * 代价（明确记录，避免日后误判为回退）：
   * - 模型不再读 `config.llmModel`，而是 `process.env.AGENT_LLM_MODEL`
   *   （与 /ask 同源，见 llm/qa.ts）；未配置时由 llm/client.ts 按厂商取默认模型。
   * - temperature 不再读 `config.temperature`，统一用客户端默认 0.7
   *   （恰好与 config 默认值相同，因此默认部署下行为无变化）。
   * - 失败时不再返回"基于收集到的信息，请查看代码证据。"，而是把
   *   answerQuestion 内部的降级/异常路径交给上层 catch。
   *
   * 保留的只有空证据护栏 —— 它属于**编排决策**（没证据就别问模型），
   * 不属于提示词工程，因此留在这一层。
   */
  private async generateAnswer(task: Task, evidence: EvidenceRecord[]): Promise<string> {
    // 空证据护栏：没有检索到任何证据时不调用 LLM。
    // 此时让模型"基于证据回答"只可能产生幻觉，直接如实告知更可靠。
    // 调用方可通过 metadata.toolsCalled / confidence=0 判断这是检索失败而非答案为空。
    if (evidence.length === 0) {
      console.warn('[AgentCore] No evidence retrieved, skipping LLM call to avoid hallucination');
      return '未在该代码库中检索到与该问题相关的代码证据，无法基于证据回答。'
        + '建议换用更具体的函数名、文件名或 URL 路径重试。';
    }

    try {
      return await this.generateAnswerImpl(task.description, evidence);
    } catch (error) {
      console.error('[AgentCore] Answer generation failed:', error);
      // 降级答案：生成失败时返回，保证调用方始终拿到明确结果
      return '基于收集到的信息，请查看代码证据。';
    }
  }

  /**
   * 获取记忆统计
   *
   * 返回当前的记忆使用情况
   * 用于监控和调试记忆系统
   *
   * @returns 记忆统计对象，包含短期和长期记忆的条目数
   */
  getMemoryStats() {
    return this.memoryStats;
  }

  /**
   * 清空记忆
   *
   * 重置记忆统计计数器
   * 注意：简化版中记忆未实际存储，仅重置计数器
   *
   * 使用场景：
   * - 开始新会话时清空上下文
   * - 内存占用过高时释放资源
   */
  clearMemory() {
    this.memoryStats = { shortTermCount: 0, longTermCount: 0 };
  }

  /**
   * 获取工具调用历史
   *
   * 返回所有工具调用的历史记录
   * 用于调试、审计和性能分析
   *
   * @returns 工具调用记录数组
   */
  getToolCallHistory() {
    return this.toolCallHistory;
  }

  /**
   * API 方法：执行查询
   *
   * 这是对外暴露的主要 API 方法
   * 执行查询并将结果持久化到数据库
   *
   * @param query - 用户查询字符串
   * @param repoId - 代码仓库 ID
   * @param sessionId - 会话 ID（可选，未提供时自动生成）
   * @returns {Promise<AgentResponse>} Agent 响应
   *
   * 工作流程：
   * 1. 构建执行上下文
   * 2. 调用核心 run 方法执行任务
   * 3. 将对话记录保存到数据库
   * 4. 返回响应
   *
   * 数据持久化：
   * - 保存到 agent_conversations 表
   * - 记录查询、响应、执行时间等信息
   * - 用于历史查询、分析和审计
   *
   * 错误处理：
   * - 数据库保存失败不影响响应返回
   * - 记录错误日志便于排查
   */
  async executeQuery(query: string, repoId: number, sessionId?: string): Promise<AgentResponse> {
    // 构建执行上下文
    const context: AgentContext = {
      repoId,
      sessionId: sessionId || uuidv4() // 未提供会话 ID 时自动生成
    };

    // 执行任务
    const response = await this.run(query, context);

    // 保存到数据库
    try {
      await this.db.query(
        `INSERT INTO agent_conversations (session_id, repo_id, query, response, execution_time_ms, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [context.sessionId, repoId, query, JSON.stringify(response), response.executionTime]
      );
    } catch (error) {
      console.error('[AgentCore] Failed to save conversation:', error);
      // 保存失败不影响响应返回
    }

    return response;
  }

  /**
   * API 方法：获取会话信息
   *
   * 根据会话 ID 获取该会话的所有对话记录
   *
   * @param sessionId - 会话 ID
   * @returns {Promise<Object|null>} 会话信息对象，包含所有对话记录；不存在时返回 null
   *
   * 返回格式：
   * {
   *   sessionId: string,
   *   conversations: [
   *     {
   *       query: string,        // 用户查询
   *       response: object,     // Agent 响应
   *       executionTime: number, // 执行时间
   *       createdAt: Date       // 创建时间
   *     }
   *   ]
   * }
   *
   * 使用场景：
   * - 查看会话历史
   * - 恢复上下文
   * - 分析对话流程
   */
  async getSession(sessionId: string) {
    try {
      const result = await this.db.query(
        `SELECT * FROM agent_conversations WHERE session_id = $1 ORDER BY created_at DESC`,
        [sessionId]
      );

      // 会话不存在
      if (result.rows.length === 0) {
        return null;
      }

      // 构建会话对象
      return {
        sessionId,
        conversations: result.rows.map(row => ({
          query: row.query,
          response: row.response,
          executionTime: row.execution_time_ms,
          createdAt: row.created_at
        }))
      };
    } catch (error) {
      console.error('[AgentCore] Failed to get session:', error);
      throw error; // 数据库错误需要向上传播
    }
  }

  /**
   * API 方法：获取执行历史
   *
   * 获取指定会话的所有查询执行历史
   * 按时间顺序排列，便于查看对话流程
   *
   * @param sessionId - 会话 ID
   * @returns {Promise<Array>} 执行历史数组
   *
   * 返回格式：
   * [
   *   {
   *     query: string,        // 用户查询
   *     answer: string,       // Agent 答案（从响应中提取）
   *     executionTime: number, // 执行时间（毫秒）
   *     timestamp: Date       // 时间戳
   *   }
   * ]
   *
   * 使用场景：
   * - 查看对话历史
   * - 分析执行性能
   * - 调试问题
   *
   * 数据处理：
   * - 从完整响应中提取答案文本
   * - 处理 JSON 字符串和对象两种格式
   */
  async getExecutionHistory(sessionId: string) {
    try {
      const result = await this.db.query(
        `SELECT query, response, execution_time_ms, created_at
         FROM agent_conversations
         WHERE session_id = $1
         ORDER BY created_at ASC`, // 按时间升序排列
        [sessionId]
      );

      return result.rows.map(row => ({
        query: row.query,
        // 处理响应格式：可能是 JSON 字符串或已解析的对象
        answer: typeof row.response === 'string' ? JSON.parse(row.response).answer : row.response.answer,
        executionTime: row.execution_time_ms,
        timestamp: row.created_at
      }));
    } catch (error) {
      console.error('[AgentCore] Failed to get execution history:', error);
      throw error; // 数据库错误需要向上传播
    }
  }

  /**
   * API 方法：获取统计信息
   *
   * 获取 Agent 系统的全局统计信息
   * 用于监控系统使用情况和性能指标
   *
   * @returns {Promise<Object>} 统计信息对象
   *
   * 统计指标：
   * - totalQueries: 总查询次数
   * - avgExecutionTime: 平均执行时间（毫秒）
   * - totalSessions: 总会话数
   * - reposAnalyzed: 分析的仓库数
   * - memoryStats: 记忆使用统计
   * - toolCallsCount: 工具调用次数
   *
   * 使用场景：
   * - 系统监控面板
   * - 性能分析
   * - 使用情况报告
   *
   * 错误处理：
   * - 数据库查询失败时返回默认值（全 0）
   * - 记录错误日志便于排查
   */
  async getStats() {
    try {
      // 执行聚合查询获取统计数据
      const result = await this.db.query(`
        SELECT
          COUNT(*) as total_queries,              -- 总查询次数
          AVG(execution_time_ms) as avg_execution_time, -- 平均执行时间
          COUNT(DISTINCT session_id) as total_sessions, -- 总会话数（去重）
          COUNT(DISTINCT repo_id) as repos_analyzed     -- 分析的仓库数（去重）
        FROM agent_conversations
      `);

      const stats = result.rows[0];

      return {
        totalQueries: parseInt(stats.total_queries),
        avgExecutionTime: parseFloat(stats.avg_execution_time) || 0, // 无数据时为 0
        totalSessions: parseInt(stats.total_sessions),
        reposAnalyzed: parseInt(stats.repos_analyzed),
        memoryStats: this.memoryStats,           // 内存统计
        toolCallsCount: this.toolCallHistory.length // 工具调用次数
      };
    } catch (error) {
      console.error('[AgentCore] Failed to get stats:', error);
      // 返回默认值，不中断服务
      return {
        totalQueries: 0,
        avgExecutionTime: 0,
        totalSessions: 0,
        reposAnalyzed: 0,
        memoryStats: this.memoryStats,
        toolCallsCount: 0
      };
    }
  }
}
