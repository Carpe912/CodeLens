/**
 * Agent 核心类型定义
 *
 * 本文件定义了 AI Agent 系统的所有核心类型和接口
 * 包括任务定义、计划执行、工具调用、推理过程、记忆管理等
 */

import type { Pool } from 'pg';
import type Anthropic from '@anthropic-ai/sdk';

// ============================================
// 基础类型
// ============================================

/**
 * Agent 执行上下文
 *
 * 包含 Agent 执行任务所需的环境信息
 * 用于跟踪任务的来源、会话和用户信息
 */
export interface AgentContext {
  repoId: number;              // 代码仓库 ID，标识当前分析的代码库
  sessionId?: string;          // 会话 ID，用于关联同一会话的多次交互
  userId?: string;             // 用户 ID，标识发起请求的用户
  metadata?: Record<string, any>; // 额外的元数据，可存储自定义信息
}

/**
 * 任务定义
 *
 * 描述 Agent 需要完成的具体任务
 * 包含任务目标、约束条件和成功标准
 */
export interface Task {
  id: string;                  // 任务唯一标识符
  description: string;         // 任务描述，通常是用户的原始问题
  type: TaskType;              // 任务类型，用于选择合适的执行策略
  goal: string;                // 任务目标，明确要达成的结果
  constraints: string[];       // 约束条件，限制任务执行的范围
  successCriteria: string[];   // 成功标准，判断任务是否完成的依据
  context: AgentContext;       // 执行上下文
}

/**
 * 任务类型枚举
 *
 * 定义 Agent 支持的任务类型
 * 不同类型的任务会采用不同的执行策略和工具组合
 */
export type TaskType =
  | 'code_search'              // 代码搜索：查找特定代码片段或功能
  | 'root_cause_analysis'      // 根因分析：分析 bug 或问题的根本原因
  | 'code_generation'          // 代码生成：生成新的代码实现
  | 'impact_analysis'          // 影响分析：评估代码修改的影响范围
  | 'architecture_analysis'    // 架构分析：分析系统架构和设计模式
  | 'general_query';           // 通用查询：其他类型的代码相关问题

// ============================================
// 计划相关
// ============================================

/**
 * 执行计划
 *
 * Agent 为完成任务制定的分步执行计划
 * 采用分治策略，将复杂任务分解为多个可执行的步骤
 */
export interface Plan {
  id: string;                  // 计划唯一标识符
  taskId: string;              // 关联的任务 ID
  steps: PlanStep[];           // 执行步骤列表，按顺序执行
  estimatedComplexity: number; // 预估复杂度（0-1），用于资源分配
  createdAt: Date;             // 计划创建时间
}

/**
 * 计划步骤
 *
 * 执行计划中的单个步骤
 * 每个步骤对应一个工具调用或分析操作
 */
export interface PlanStep {
  id: string;                  // 步骤唯一标识符
  order: number;               // 执行顺序，从 0 开始
  description: string;         // 步骤描述，说明该步骤的目的
  tool: string;                // 使用的工具名称
  params: Record<string, any>; // 工具参数
  dependencies: string[];      // 依赖的步骤 ID 列表，必须先完成依赖步骤
  status: StepStatus;          // 当前状态
  result?: StepResult;         // 执行结果（完成后填充）
}

/**
 * 步骤状态枚举
 *
 * 描述计划步骤的执行状态
 */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * 步骤执行结果
 *
 * 记录步骤执行的详细结果
 * 包括成功状态、返回数据、错误信息和性能指标
 */
export interface StepResult {
  success: boolean;            // 是否执行成功
  data: any;                   // 返回的数据
  error?: string;              // 错误信息（失败时）
  duration: number;            // 执行耗时（毫秒）
  metadata?: Record<string, any>; // 额外的元数据
}

// ============================================
// 工具相关
// ============================================

/**
 * 工具定义
 *
 * Agent 可以调用的工具接口
 * 工具是 Agent 与外部系统交互的桥梁
 */
export interface Tool {
  name: string;                // 工具名称，全局唯一
  description: string;         // 工具描述，说明工具的功能和用途
  parameters: ToolParameter[]; // 参数定义列表
  execute: (params: any, context: AgentContext) => Promise<any>; // 执行函数
}

/**
 * 工具参数定义
 *
 * 描述工具接受的参数
 */
export interface ToolParameter {
  name: string;                // 参数名称
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'; // 参数类型
  description: string;         // 参数描述
  required: boolean;           // 是否必需
  default?: any;               // 默认值（可选参数）
}

/**
 * 工具调用记录
 *
 * 记录 Agent 调用工具的详细信息
 * 用于调试、审计和性能分析
 */
export interface ToolCall {
  id: string;                  // 调用唯一标识符
  tool: string;                // 工具名称
  params: Record<string, any>; // 调用参数
  result?: any;                // 返回结果
  error?: string;              // 错误信息（失败时）
  duration?: number;           // 执行耗时（毫秒）
  timestamp: Date;             // 调用时间戳
}

// ============================================
// 推理相关
// ============================================

/**
 * 假设
 *
 * Agent 在推理过程中形成的假设
 * 基于证据和推理，对问题的可能答案或解释
 */
export interface Hypothesis {
  id: string;                  // 假设唯一标识符
  description: string;         // 假设描述
  confidence: number;          // 置信度（0-1），表示对假设的确信程度
  evidence: Evidence[];        // 支持该假设的证据列表
  createdAt: Date;             // 创建时间
  updatedAt: Date;             // 最后更新时间
}

/**
 * 证据
 *
 * 支持推理和假设的证据
 * 可以是代码片段、日志、配置或文档
 */
export interface Evidence {
  type: 'code' | 'log' | 'config' | 'documentation'; // 证据类型
  source: string;              // 证据来源（如文件路径、URL）
  content: string;             // 证据内容
  relevance: number;           // 相关性评分（0-1）
  metadata?: Record<string, any>; // 额外的元数据
}

/**
 * 推理步骤
 *
 * Agent 推理过程中的单个步骤
 * 采用 ReAct (Reasoning + Acting) 模式
 * 每个步骤包含：思考 -> 行动 -> 观察
 */
export interface ReasoningStep {
  id: string;                  // 步骤唯一标识符
  round: number;               // 推理轮次
  thought: string;             // 思考过程，Agent 的内部推理
  action: Action;              // 采取的行动
  observation: string;         // 观察结果，行动的反馈
  hypothesis?: Hypothesis;     // 形成的假设（可选）
}

/**
 * 行动
 *
 * Agent 在推理步骤中采取的具体行动
 */
export interface Action {
  type: 'search' | 'analyze' | 'verify' | 'answer'; // 行动类型
  tool?: string;               // 使用的工具（如果需要）
  params?: Record<string, any>; // 工具参数
  answer?: string;             // 最终答案（type 为 'answer' 时）
}

// ============================================
// 记忆相关
// ============================================

/**
 * 消息
 *
 * 对话中的单条消息
 * 用于构建对话历史和上下文
 */
export interface Message {
  id: string;                  // 消息唯一标识符
  role: 'user' | 'assistant' | 'system' | 'tool'; // 消息角色
  content: string;             // 消息内容
  metadata?: Record<string, any>; // 额外的元数据
  timestamp: Date;             // 消息时间戳
}

/**
 * 记忆系统
 *
 * Agent 的记忆管理系统
 * 包含短期记忆、长期记忆和工作记忆
 */
export interface Memory {
  shortTerm: Message[];        // 短期记忆：当前会话的对话历史
  longTerm: Map<string, any>;  // 长期记忆：跨会话的持久化知识
  workingMemory: Map<string, any>; // 工作记忆：当前任务的临时数据
}

// ============================================
// 反思相关
// ============================================

/**
 * 反思结果
 *
 * Agent 对当前执行状态的反思和评估
 * 用于自我监控和动态调整策略
 */
export interface Reflection {
  onTrack: boolean;            // 是否按计划进行
  issues: string[];            // 发现的问题列表
  needsReplan: boolean;        // 是否需要重新规划
  confidence: number;          // 当前置信度（0-1）
  suggestions: string[];       // 改进建议
  reasoning: string;           // 反思的推理过程
}

/**
 * 经验教训
 *
 * 从失败或成功中学习的经验
 * 用于改进未来的任务执行
 */
export interface Lesson {
  id: string;                  // 教训唯一标识符
  taskType: TaskType;          // 相关的任务类型
  failureReason: string;       // 失败原因
  solution: string;            // 解决方案
  successRate: number;         // 成功率（0-1）
  createdAt: Date;             // 创建时间
}

// ============================================
// Agent 响应
// ============================================

/**
 * Agent 响应
 *
 * Agent 执行任务后返回的完整响应
 * 包含答案、证据、推理过程和元数据
 */
export interface AgentResponse {
  answer: string;              // 最终答案
  evidence: Evidence[];        // 支持答案的证据列表
  reasoning: ReasoningStep[];  // 推理步骤列表
  confidence: number;          // 答案置信度（0-1）
  executionTime: number;       // 总执行时间（毫秒）
  metadata: {                  // 执行元数据
    planId: string;            // 执行计划 ID
    stepsExecuted: number;     // 执行的步骤数
    toolsCalled: string[];     // 调用的工具列表
    reflections: number;       // 反思次数
  };
}

// ============================================
// 配置
// ============================================

/**
 * Agent 配置
 *
 * 控制 Agent 行为的配置参数
 */
export interface AgentConfig {
  maxReasoningRounds: number;  // 最大推理轮次，防止无限循环
  confidenceThreshold: number; // 置信度阈值，低于此值需要更多证据
  enableReflection: boolean;   // 是否启用反思机制
  enableLearning: boolean;     // 是否启用学习机制
  toolTimeout: number;         // 工具调用超时时间（毫秒）
  llmModel: string;            // 使用的 LLM 模型名称
  temperature: number;         // LLM 温度参数（0-1），控制输出随机性
}

// ============================================
// 事件
// ============================================

/**
 * Agent 事件
 *
 * Agent 执行过程中触发的事件
 * 用于监控、日志记录和实时反馈
 * 采用联合类型实现类型安全的事件系统
 */
export type AgentEvent =
  | { type: 'task_started'; task: Task }                          // 任务开始
  | { type: 'plan_created'; plan: Plan }                          // 计划创建
  | { type: 'step_started'; step: PlanStep }                      // 步骤开始
  | { type: 'step_completed'; step: PlanStep; result: StepResult } // 步骤完成
  | { type: 'tool_called'; toolCall: ToolCall }                   // 工具调用
  | { type: 'thought'; thought: string }                          // 思考过程
  | { type: 'hypothesis_updated'; hypothesis: Hypothesis }        // 假设更新
  | { type: 'reflection'; reflection: Reflection }                // 反思结果
  | { type: 'replan'; newPlan: Plan }                            // 重新规划
  | { type: 'answer'; answer: AgentResponse }                     // 最终答案
  | { type: 'error'; error: Error };                             // 错误发生

// ============================================
// 依赖注入
// ============================================

/**
 * Agent 依赖
 *
 * Agent 运行所需的外部依赖
 * 通过依赖注入模式提供，便于测试和扩展
 */
export interface AgentDependencies {
  db: Pool;                    // 数据库连接池，用于持久化存储
  llm: Anthropic;              // LLM 客户端，用于自然语言处理
  config: AgentConfig;         // Agent 配置
}
