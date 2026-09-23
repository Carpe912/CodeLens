/**
 * Agent 配置模块
 *
 * 提供 Agent 的默认配置和环境变量覆盖机制
 * 支持通过环境变量动态调整 Agent 行为
 */

import type { AgentConfig } from '../agent/types.js';

/**
 * 默认 Agent 配置
 *
 * ⚠️ 生效状态说明（Phase 0 校正）：
 * 下面 7 个字段中只有 3 个真正被代码读取。其余 4 个是为「多轮推理 + 反思 + 学习」
 * 那套尚未实现的架构预留的，目前设置它们**不会改变任何行为**。
 * 调用 getAgentConfig() 前请先确认你要调的字段确实生效。
 *
 * 这 3 个生效：
 * - toolTimeout
 * - llmModel
 * - temperature
 *
 * 这 4 个失效（无任何读取点）：
 * - maxReasoningRounds  —— AgentCore 是单轮管道，不存在循环
 * - confidenceThreshold —— 没有「置信度低于阈值则继续收集证据」的逻辑
 * - enableReflection    —— ReflectionEngine 未实现
 * - enableLearning      —— 无学习机制
 */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  // ========== 推理配置 ==========
  /** ⚠️ 失效：单轮管道，无循环。仅为未来图式编排预留。 */
  maxReasoningRounds: 5,
  /** ⚠️ 失效：无「低于阈值继续检索」逻辑，当前无人读取。 */
  confidenceThreshold: 0.85,

  // ========== 功能开关 ==========
  /** ⚠️ 失效：ReflectionEngine 尚未实现，无人读取。 */
  enableReflection: true,
  /** ⚠️ 失效：无学习机制，无人读取。 */
  enableLearning: true,

  // ========== 超时配置 ==========
  /** ✅ 生效：约束 AgentCore.gatherEvidence() 的检索调用。 */
  toolTimeout: 30000,

  // ========== LLM 配置 ==========
  /**
   * ✅ 生效：AgentCore.generateAnswer() 使用的模型。
   *
   * 刻意留空 —— 空值由 `llm/client.ts` 的 `resolveModel()` 兜底为 deepseek-chat。
   * **不要在这里写死模型名**：那样会让「换模型」和「改代码」重新绑在一起
   * （历史上这里写死过 `claude-sonnet-4-6`，换成 DeepSeek 后虽然能被适配层救回，
   * 但语义是误导的）。
   */
  llmModel: '',
  /** ✅ 生效：AgentCore.generateAnswer() 的温度参数。 */
  temperature: 0.7,
};

/**
 * 获取 Agent 配置
 *
 * 从环境变量读取配置，如果未设置则使用默认值。
 *
 * ⚠️ 注意：本函数会读取全部 7 个环境变量，但其中 4 个对应的配置项在
 * AgentCore 中**没有任何读取点**。设了它们不会报错，也不会生效。
 * 详见 DEFAULT_AGENT_CONFIG 上方的生效状态说明。
 *
 * @returns {AgentConfig} 合并后的配置对象
 *
 * ✅ 生效的环境变量：
 * - AGENT_TOOL_TIMEOUT: 检索调用超时（默认 30000ms）
 * - AGENT_LLM_MODEL: 生成答案所用模型（默认留空 = 兜底 deepseek-chat）
 * - AGENT_TEMPERATURE: 生成温度（默认 0.7）
 *
 * ⚠️ 当前失效的环境变量（仅为未实现的架构预留）：
 * - AGENT_MAX_ROUNDS: 单轮管道，无循环可限
 * - AGENT_CONFIDENCE_THRESHOLD: 无阈值触发逻辑
 * - AGENT_ENABLE_REFLECTION: 反思引擎未实现
 * - AGENT_ENABLE_LEARNING: 学习机制未实现
 *
 * 使用示例：
 * ```bash
 * # 缩短检索超时，并使用更确定的输出
 * export AGENT_TOOL_TIMEOUT=10000
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
    // 留空即交给 llm/client.ts 按 provider 选默认模型，避免写死某家厂商
    llmModel: process.env.AGENT_LLM_MODEL || '',
    temperature: parseFloat(process.env.AGENT_TEMPERATURE || '0.7'),
  };
}
