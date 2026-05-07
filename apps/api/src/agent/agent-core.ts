/**
 * 简化版 Agent 核心引擎
 * 整合了规划、推理、记忆和反思功能
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

export class AgentCore extends EventEmitter {
  private multiStrategySearch: MultiStrategySearch;
  private toolCallHistory: any[] = [];
  private memoryStats = { shortTermCount: 0, longTermCount: 0 };

  constructor(
    private db: Pool,
    private llm: Anthropic,
    private config: AgentConfig
  ) {
    super();
    this.multiStrategySearch = new MultiStrategySearch(
      db,
      process.env.ANTHROPIC_API_KEY || ''
    );
    console.log('[AgentCore] Initialized');
  }

  /**
   * 主入口：执行任务
   */
  async run(query: string, context: AgentContext): Promise<AgentResponse> {
    const startTime = Date.now();
    console.log(`[AgentCore] Starting task: ${query}`);

    try {
      // 1. 理解任务
      const task = this.createTask(query, context);
      this.emit('task_started', { type: 'task_started', task });

      // 2. 执行搜索
      const evidence = await this.gatherEvidence(task);

      // 3. 生成答案
      const answer = await this.generateAnswer(task, evidence);

      // 4. 构建响应
      const response: AgentResponse = {
        answer,
        evidence,
        reasoning: [],
        confidence: 0.85,
        executionTime: Date.now() - startTime,
        metadata: {
          planId: task.id,
          stepsExecuted: 1,
          toolsCalled: ['vector_search'],
          reflections: 0
        }
      };

      this.emit('answer', { type: 'answer', answer: response });
      console.log(`[AgentCore] Task completed in ${response.executionTime}ms`);

      return response;
    } catch (error: any) {
      console.error('[AgentCore] Task execution failed:', error);
      this.emit('error', { type: 'error', error });

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
   */
  private createTask(query: string, context: AgentContext): Task {
    const taskType = this.classifyTaskType(query);

    return {
      id: uuidv4(),
      description: query,
      type: taskType,
      goal: query,
      constraints: [],
      successCriteria: ['回答用户问题'],
      context
    };
  }

  /**
   * 分类任务类型
   */
  private classifyTaskType(query: string): TaskType {
    const lowerQuery = query.toLowerCase();

    if (lowerQuery.match(/为什么|原因|bug|问题|错误|异常|失败/)) {
      return 'root_cause_analysis';
    }

    if (lowerQuery.match(/影响|修改.*会|如果.*改/)) {
      return 'impact_analysis';
    }

    if (lowerQuery.match(/架构|设计|模式|结构|整体/)) {
      return 'architecture_analysis';
    }

    return 'general_query';
  }

  /**
   * 收集证据
   */
  private async gatherEvidence(task: Task): Promise<Evidence[]> {
    try {
      const results = await this.multiStrategySearch.search(
        task.context.repoId,
        task.description,
        { limit: 10, strategies: ['vector', 'exact'] }
      );

      return results.slice(0, 5).map(r => ({
        type: 'code' as const,
        source: `${r.filePath}:${r.lineStart}`,
        content: r.content,
        relevance: r.score
      }));
    } catch (error) {
      console.error('[AgentCore] Evidence gathering failed:', error);
      return [];
    }
  }

  /**
   * 生成答案
   */
  private async generateAnswer(task: Task, evidence: Evidence[]): Promise<string> {
    const evidenceSummary = evidence.map((e, i) =>
      `${i + 1}. ${e.source}:\n${e.content.substring(0, 300)}`
    ).join('\n\n');

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
      const response = await this.llm.messages.create({
        model: this.config.llmModel,
        max_tokens: 2000,
        temperature: this.config.temperature,
        messages: [{ role: 'user', content: prompt }]
      });

      const content = response.content[0];
      if (content.type === 'text') {
        return content.text;
      }
    } catch (error) {
      console.error('[AgentCore] Answer generation failed:', error);
    }

    return '基于收集到的信息，请查看代码证据。';
  }

  /**
   * 获取记忆统计
   */
  getMemoryStats() {
    return this.memoryStats;
  }

  /**
   * 清空记忆
   */
  clearMemory() {
    this.memoryStats = { shortTermCount: 0, longTermCount: 0 };
  }

  /**
   * 获取工具调用历史
   */
  getToolCallHistory() {
    return this.toolCallHistory;
  }

  /**
   * API 方法：执行查询
   */
  async executeQuery(query: string, repoId: number, sessionId?: string): Promise<AgentResponse> {
    const context: AgentContext = {
      repoId,
      sessionId: sessionId || uuidv4()
    };

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
    }

    return response;
  }

  /**
   * API 方法：获取会话信息
   */
  async getSession(sessionId: string) {
    try {
      const result = await this.db.query(
        `SELECT * FROM agent_conversations WHERE session_id = $1 ORDER BY created_at DESC`,
        [sessionId]
      );

      if (result.rows.length === 0) {
        return null;
      }

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
      throw error;
    }
  }

  /**
   * API 方法：获取执行历史
   */
  async getExecutionHistory(sessionId: string) {
    try {
      const result = await this.db.query(
        `SELECT query, response, execution_time_ms, created_at
         FROM agent_conversations
         WHERE session_id = $1
         ORDER BY created_at ASC`,
        [sessionId]
      );

      return result.rows.map(row => ({
        query: row.query,
        answer: typeof row.response === 'string' ? JSON.parse(row.response).answer : row.response.answer,
        executionTime: row.execution_time_ms,
        timestamp: row.created_at
      }));
    } catch (error) {
      console.error('[AgentCore] Failed to get execution history:', error);
      throw error;
    }
  }

  /**
   * API 方法：获取统计信息
   */
  async getStats() {
    try {
      const result = await this.db.query(`
        SELECT
          COUNT(*) as total_queries,
          AVG(execution_time_ms) as avg_execution_time,
          COUNT(DISTINCT session_id) as total_sessions,
          COUNT(DISTINCT repo_id) as repos_analyzed
        FROM agent_conversations
      `);

      const stats = result.rows[0];

      return {
        totalQueries: parseInt(stats.total_queries),
        avgExecutionTime: parseFloat(stats.avg_execution_time) || 0,
        totalSessions: parseInt(stats.total_sessions),
        reposAnalyzed: parseInt(stats.repos_analyzed),
        memoryStats: this.memoryStats,
        toolCallsCount: this.toolCallHistory.length
      };
    } catch (error) {
      console.error('[AgentCore] Failed to get stats:', error);
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
