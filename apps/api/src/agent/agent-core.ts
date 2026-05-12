/**
 * Agent 核心引擎
 *
 * 这是 AI Agent 系统的核心实现，整合了以下功能：
 * - 任务理解与分类
 * - 证据收集（多策略搜索）
 * - 答案生成（基于 LLM）
 * - 会话管理与持久化
 * - 事件发射与监控
 *
 * 架构设计：
 * 采用简化的 Agent 架构，将规划、推理、记忆和反思功能整合到单一类中
 * 使用 EventEmitter 模式支持事件驱动的监控和日志记录
 *
 * 工作流程：
 * 1. 接收用户查询 -> 2. 分类任务类型 -> 3. 收集相关证据
 * 4. 生成结构化答案 -> 5. 持久化到数据库 -> 6. 返回响应
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Pool } from 'pg';
import type {
  Task,
  AgentResponse,
  AgentContext,
  AgentConfig,
  TaskType,
  Evidence
} from './types.js';
import { MultiStrategySearch } from '../llm/multi-strategy-search.js';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

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

  /**
   * 构造函数
   *
   * @param db - PostgreSQL 连接池，用于数据持久化
   * @param llm - Anthropic Claude 客户端，用于自然语言处理
   * @param config - Agent 配置，控制行为参数
   */
  constructor(
    private db: Pool,
    private llm: Anthropic,
    private config: AgentConfig
  ) {
    super();
    // 初始化多策略搜索引擎
    this.multiStrategySearch = new MultiStrategySearch(
      db,
      process.env.ANTHROPIC_API_KEY || ''
    );
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

    try {
      // 1. 理解任务：将自然语言查询转换为结构化任务
      const task = this.createTask(query, context);
      this.emit('task_started', { type: 'task_started', task });

      // 2. 执行搜索：收集相关代码证据
      const evidence = await this.gatherEvidence(task);

      // 3. 生成答案：基于证据生成结构化回答
      const answer = await this.generateAnswer(task, evidence);

      // 4. 构建响应：组装完整的 Agent 响应对象
      const response: AgentResponse = {
        answer,                      // 最终答案文本
        evidence,                    // 支持答案的证据列表
        reasoning: [],               // 推理步骤（简化版暂未实现）
        confidence: 0.85,            // 答案置信度（固定值，可优化为动态计算）
        executionTime: Date.now() - startTime, // 总执行时间
        metadata: {
          planId: task.id,           // 任务 ID
          stepsExecuted: 1,          // 执行的步骤数
          toolsCalled: ['vector_search'], // 调用的工具列表
          reflections: 0             // 反思次数（简化版未启用）
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
          toolsCalled: [],
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
   * @returns {Promise<Evidence[]>} 证据列表，按相关性排序
   *
   * 搜索策略：
   * - 向量搜索：基于语义理解，找到概念相关的代码
   * - 精确搜索：基于关键词匹配，找到字面相关的代码
   *
   * 结果处理：
   * - 限制返回前 5 个最相关的结果
   * - 转换为统一的 Evidence 格式
   * - 包含文件路径、行号和相关性评分
   *
   * 错误处理：
   * - 搜索失败时返回空数组，不中断任务执行
   * - 记录错误日志便于调试
   */
  private async gatherEvidence(task: Task): Promise<Evidence[]> {
    try {
      // 执行多策略搜索，最多返回 10 个结果
      const results = await this.multiStrategySearch.search(
        task.context.repoId,
        task.description,
        { limit: 10, strategies: ['vector', 'exact'] }
      );

      // 取前 5 个结果并转换为 Evidence 格式
      return results.slice(0, 5).map(r => ({
        type: 'code' as const,       // 证据类型：代码
        source: `${r.filePath}:${r.lineStart}`, // 来源：文件路径和起始行号
        content: r.content,          // 代码内容
        relevance: r.score           // 相关性评分（0-1）
      }));
    } catch (error) {
      console.error('[AgentCore] Evidence gathering failed:', error);
      return []; // 失败时返回空数组，允许任务继续执行
    }
  }

  /**
   * 生成答案
   *
   * 基于收集到的证据，使用 LLM 生成结构化的答案
   *
   * @param task - 任务对象
   * @param evidence - 证据列表
   * @returns {Promise<string>} 生成的答案文本
   *
   * 工作流程：
   * 1. 构建证据摘要：将证据格式化为可读文本
   * 2. 构建提示词：包含问题、证据和答案要求
   * 3. 调用 LLM：使用 Claude API 生成答案
   * 4. 提取文本：从响应中提取答案内容
   *
   * 提示词设计：
   * - 角色定位：专业的代码分析助手
   * - 输入：用户问题 + 代码证据
   * - 输出要求：清晰、结构化、包含证据引用
   *
   * 答案结构：
   * 1. 直接回答问题
   * 2. 关键证据（文件路径和行号）
   * 3. 简要解释
   *
   * 错误处理：
   * - LLM 调用失败时返回降级答案
   * - 记录错误日志便于调试
   */
  private async generateAnswer(task: Task, evidence: Evidence[]): Promise<string> {
    // 构建证据摘要：每条证据包含序号、来源和内容片段
    const evidenceSummary = evidence.map((e, i) =>
      `${i + 1}. ${e.source}:\n${e.content.substring(0, 300)}` // 限制每条证据最多 300 字符
    ).join('\n\n');

    // 构建提示词：指导 LLM 如何生成答案
    const prompt = `你是一个专业的代码分析助手。基于以下代码证据回答问题。

问题: ${task.description}

代码证据:
${evidenceSummary}

请生成一个清晰、结构化的答案，包括：
1. 直接回答问题
2. 关键证据（文件路径和行号）
3. 简要解释

保持简洁专业。`;

    try {
      // 调用 Claude API 生成答案
      const response = await this.llm.messages.create({
        model: this.config.llmModel,      // 使用配置的模型
        max_tokens: 2000,                 // 最大生成 2000 个 token
        temperature: this.config.temperature, // 使用配置的温度参数
        messages: [{ role: 'user', content: prompt }]
      });

      // 提取文本内容
      const content = response.content[0];
      if (content.type === 'text') {
        return content.text;
      }
    } catch (error) {
      console.error('[AgentCore] Answer generation failed:', error);
    }

    // 降级答案：LLM 调用失败时返回
    return '基于收集到的信息，请查看代码证据。';
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
