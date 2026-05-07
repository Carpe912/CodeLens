/**
 * Agent 核心类型定义
 */

import type { Pool } from 'pg';
import type Anthropic from '@anthropic-ai/sdk';

// ============================================
// 基础类型
// ============================================

export interface AgentContext {
  repoId: number;
  sessionId?: string;
  userId?: string;
  metadata?: Record<string, any>;
}

export interface Task {
  id: string;
  description: string;
  type: TaskType;
  goal: string;
  constraints: string[];
  successCriteria: string[];
  context: AgentContext;
}

export type TaskType =
  | 'code_search'
  | 'root_cause_analysis'
  | 'code_generation'
  | 'impact_analysis'
  | 'architecture_analysis'
  | 'general_query';

// ============================================
// 计划相关
// ============================================

export interface Plan {
  id: string;
  taskId: string;
  steps: PlanStep[];
  estimatedComplexity: number;
  createdAt: Date;
}

export interface PlanStep {
  id: string;
  order: number;
  description: string;
  tool: string;
  params: Record<string, any>;
  dependencies: string[];
  status: StepStatus;
  result?: StepResult;
}

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface StepResult {
  success: boolean;
  data: any;
  error?: string;
  duration: number;
  metadata?: Record<string, any>;
}

// ============================================
// 工具相关
// ============================================

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameter[];
  execute: (params: any, context: AgentContext) => Promise<any>;
}

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required: boolean;
  default?: any;
}

export interface ToolCall {
  id: string;
  tool: string;
  params: Record<string, any>;
  result?: any;
  error?: string;
  duration?: number;
  timestamp: Date;
}

// ============================================
// 推理相关
// ============================================

export interface Hypothesis {
  id: string;
  description: string;
  confidence: number;
  evidence: Evidence[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Evidence {
  type: 'code' | 'log' | 'config' | 'documentation';
  source: string;
  content: string;
  relevance: number;
  metadata?: Record<string, any>;
}

export interface ReasoningStep {
  id: string;
  round: number;
  thought: string;
  action: Action;
  observation: string;
  hypothesis?: Hypothesis;
}

export interface Action {
  type: 'search' | 'analyze' | 'verify' | 'answer';
  tool?: string;
  params?: Record<string, any>;
  answer?: string;
}

// ============================================
// 记忆相关
// ============================================

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  metadata?: Record<string, any>;
  timestamp: Date;
}

export interface Memory {
  shortTerm: Message[];
  longTerm: Map<string, any>;
  workingMemory: Map<string, any>;
}

// ============================================
// 反思相关
// ============================================

export interface Reflection {
  onTrack: boolean;
  issues: string[];
  needsReplan: boolean;
  confidence: number;
  suggestions: string[];
  reasoning: string;
}

export interface Lesson {
  id: string;
  taskType: TaskType;
  failureReason: string;
  solution: string;
  successRate: number;
  createdAt: Date;
}

// ============================================
// Agent 响应
// ============================================

export interface AgentResponse {
  answer: string;
  evidence: Evidence[];
  reasoning: ReasoningStep[];
  confidence: number;
  executionTime: number;
  metadata: {
    planId: string;
    stepsExecuted: number;
    toolsCalled: string[];
    reflections: number;
  };
}

// ============================================
// 配置
// ============================================

export interface AgentConfig {
  maxReasoningRounds: number;
  confidenceThreshold: number;
  enableReflection: boolean;
  enableLearning: boolean;
  toolTimeout: number;
  llmModel: string;
  temperature: number;
}

// ============================================
// 事件
// ============================================

export type AgentEvent =
  | { type: 'task_started'; task: Task }
  | { type: 'plan_created'; plan: Plan }
  | { type: 'step_started'; step: PlanStep }
  | { type: 'step_completed'; step: PlanStep; result: StepResult }
  | { type: 'tool_called'; toolCall: ToolCall }
  | { type: 'thought'; thought: string }
  | { type: 'hypothesis_updated'; hypothesis: Hypothesis }
  | { type: 'reflection'; reflection: Reflection }
  | { type: 'replan'; newPlan: Plan }
  | { type: 'answer'; answer: AgentResponse }
  | { type: 'error'; error: Error };

// ============================================
// 依赖注入
// ============================================

export interface AgentDependencies {
  db: Pool;
  llm: Anthropic;
  config: AgentConfig;
}
