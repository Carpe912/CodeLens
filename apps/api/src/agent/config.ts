/**
 * Agent 配置
 */

import type { AgentConfig } from './types.js';

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  // 推理配置
  maxReasoningRounds: 5,
  confidenceThreshold: 0.85,

  // 功能开关
  enableReflection: true,
  enableLearning: true,

  // 超时配置
  toolTimeout: 30000, // 30 秒

  // LLM 配置
  llmModel: 'claude-sonnet-4-6',
  temperature: 0.7,
};

export function getAgentConfig(): AgentConfig {
  return {
    ...DEFAULT_AGENT_CONFIG,
    maxReasoningRounds: parseInt(process.env.AGENT_MAX_ROUNDS || '5'),
    confidenceThreshold: parseFloat(process.env.AGENT_CONFIDENCE_THRESHOLD || '0.85'),
    enableReflection: process.env.AGENT_ENABLE_REFLECTION !== 'false',
    enableLearning: process.env.AGENT_ENABLE_LEARNING !== 'false',
    toolTimeout: parseInt(process.env.AGENT_TOOL_TIMEOUT || '30000'),
    llmModel: process.env.AGENT_LLM_MODEL || 'claude-sonnet-4-6',
    temperature: parseFloat(process.env.AGENT_TEMPERATURE || '0.7'),
  };
}
