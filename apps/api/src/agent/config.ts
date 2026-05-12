/**
 * Agent 配置模块
 *
 * 提供 Agent 的默认配置和环境变量覆盖机制
 * 支持通过环境变量动态调整 Agent 行为
 */

import type { AgentConfig } from './types.js';

/**
 * 默认 Agent 配置
 *
 * 这些是经过调优的默认值，适用于大多数场景
 * 可以通过环境变量覆盖这些默认值
 */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  // ========== 推理配置 ==========
  maxReasoningRounds: 5,       // 最大推理轮次：防止无限循环，通常 3-5 轮足够
  confidenceThreshold: 0.85,   // 置信度阈值：低于此值会继续收集证据

  // ========== 功能开关 ==========
  enableReflection: true,      // 启用反思机制：Agent 会定期评估执行状态
  enableLearning: true,        // 启用学习机制：从失败中学习，改进未来执行

  // ========== 超时配置 ==========
  toolTimeout: 30000,          // 工具调用超时：30 秒，防止工具调用卡死

  // ========== LLM 配置 ==========
  llmModel: 'claude-sonnet-4-6', // 使用的 Claude 模型：平衡性能和成本
  temperature: 0.7,            // 温度参数：0.7 提供创造性和准确性的平衡
                               // 较低值（0.3-0.5）更确定，较高值（0.8-1.0）更有创造性
};

/**
 * 获取 Agent 配置
 *
 * 从环境变量读取配置，如果未设置则使用默认值
 * 这允许在不修改代码的情况下调整 Agent 行为
 *
 * @returns {AgentConfig} 合并后的配置对象
 *
 * 支持的环境变量：
 * - AGENT_MAX_ROUNDS: 最大推理轮次（默认 5）
 * - AGENT_CONFIDENCE_THRESHOLD: 置信度阈值（默认 0.85）
 * - AGENT_ENABLE_REFLECTION: 是否启用反思（默认 true）
 * - AGENT_ENABLE_LEARNING: 是否启用学习（默认 true）
 * - AGENT_TOOL_TIMEOUT: 工具超时时间（默认 30000ms）
 * - AGENT_LLM_MODEL: LLM 模型名称（默认 claude-sonnet-4-6）
 * - AGENT_TEMPERATURE: LLM 温度参数（默认 0.7）
 *
 * 使用示例：
 * ```bash
 * # 增加推理轮次，降低温度以获得更确定的输出
 * export AGENT_MAX_ROUNDS=10
 * export AGENT_TEMPERATURE=0.3
 * ```
 */
export function getAgentConfig(): AgentConfig {
  return {
    ...DEFAULT_AGENT_CONFIG,
    // 从环境变量读取推理配置
    maxReasoningRounds: parseInt(process.env.AGENT_MAX_ROUNDS || '5'),
    confidenceThreshold: parseFloat(process.env.AGENT_CONFIDENCE_THRESHOLD || '0.85'),

    // 从环境变量读取功能开关（只有显式设置为 'false' 才禁用）
    enableReflection: process.env.AGENT_ENABLE_REFLECTION !== 'false',
    enableLearning: process.env.AGENT_ENABLE_LEARNING !== 'false',

    // 从环境变量读取超时配置
    toolTimeout: parseInt(process.env.AGENT_TOOL_TIMEOUT || '30000'),

    // 从环境变量读取 LLM 配置
    llmModel: process.env.AGENT_LLM_MODEL || 'claude-sonnet-4-6',
    temperature: parseFloat(process.env.AGENT_TEMPERATURE || '0.7'),
  };
}
