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
 * ⚠️ 生效状态说明（随代码演进而更新，最近一次校正：AgentCore 复用 answerQuestion 时）：
 * 调用 getAgentConfig() 前请先确认你要调的字段确实生效。
 *
 * 这 3 个生效：
 * - toolTimeout          —— AgentCore.gatherEvidence() 的检索超时
 * - maxReasoningRounds   —— 编排图 runGraphQuery() 的轮次上限
 *                           （仅当 AGENT_GRAPH_ENABLED=true 走 /agent/v2/query 时）
 * - confidenceThreshold  —— 编排图的证据充分度阈值（同上，仅图链路）
 *
 * 这 4 个失效（无任何读取点）：
 * - enableReflection    —— ReflectionEngine 未实现
 * - enableLearning      —— 无学习机制
 * - llmModel            —— ⚠️ 注意这是**本配置字段**失效，不等于环境变量失效：
 *                          答案生成改走 llm/qa.ts 的 answerQuestion 后，那里
 *                          直接读 `process.env.AGENT_LLM_MODEL`（见 llm/qa.ts），
 *                          不经过本对象。设环境变量依旧有效，改这个字段无效。
 * - temperature         —— 真正失效：改用 answerQuestion 后全仓已无 temperature
 *                          读取点，统一为 LLM 客户端默认温度 0.7（见 llm/client.ts）。
 *
 * 历史教训：maxReasoningRounds 与 confidenceThreshold 曾被长期标注为「死配置」，
 * 实际早已被编排图读取。判定「某配置是否生效」时要以当前代码的读取点为准，
 * 不要沿用旧注释。
 */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  // ========== 推理配置 ==========
  /** ✅ 生效（仅编排图）：轮次上限，runGraphQuery() 会与策略计划长度取小。 */
  maxReasoningRounds: 5,
  /** ✅ 生效（仅编排图）：证据充分度阈值，低于它则换策略重检索。 */
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
   * ⚠️ 失效（仅本字段）：答案生成改用 `llm/qa.ts` 的 answerQuestion 后，
   * 已无代码读取 `config.llmModel`。真正决定模型的是环境变量
   * `AGENT_LLM_MODEL`（由 qa.ts 直接读取），未配置时由 `llm/client.ts`
   * 的 `resolveModel()` 按厂商兜底为 deepseek-chat。
   *
   * **不要在这里写死模型名**：历史上这里写死过 `claude-sonnet-4-6`，
   * 换成 DeepSeek 后虽然能被适配层救回，但语义是误导的。
   */
  llmModel: '',
  /** ⚠️ 失效：全仓已无 temperature 读取点，统一用 LLM 客户端默认值 0.7。 */
  temperature: 0.7,
};

/**
 * 获取 Agent 配置
 *
 * 从环境变量读取配置，如果未设置则使用默认值。
 *
 * ⚠️ 注意：本函数会读取全部 7 个环境变量并填进配置对象，但其中 4 个字段
 * **没有任何读取点**，设了它们不会报错，也不会生效。
 * 详见 DEFAULT_AGENT_CONFIG 上方的生效状态说明。
 *
 * @returns {AgentConfig} 合并后的配置对象
 *
 * ✅ 生效的环境变量：
 * - AGENT_TOOL_TIMEOUT: 检索调用超时（默认 30000ms）
 * - AGENT_LLM_MODEL: 生成答案所用模型（默认留空 = 兜底 deepseek-chat）。
 *   注意它是被 llm/qa.ts **直接读取**的，不走下面的配置对象。
 * - AGENT_MAX_ROUNDS: 编排图轮次上限（默认 5；仅 AGENT_GRAPH_ENABLED=true 时）
 * - AGENT_CONFIDENCE_THRESHOLD: 编排图充分度阈值（默认 0.85；同上）
 *
 * ⚠️ 当前失效的环境变量：
 * - AGENT_TEMPERATURE: 无读取点（答案生成统一用客户端默认温度）
 * - AGENT_ENABLE_REFLECTION: 反思引擎未实现
 * - AGENT_ENABLE_LEARNING: 学习机制未实现
 *
 * 使用示例：
 * ```bash
 * # 缩短检索超时，并限制编排图最多跑 2 轮
 * export AGENT_TOOL_TIMEOUT=10000
 * export AGENT_MAX_ROUNDS=2
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
    // ⚠️ 这两个字段现在都无人读取：模型与温度由 llm/qa.ts 决定。
    // 保留读取是留档 —— 删掉会造成「AGENT_LLM_MODEL 在这里、又在那里」的困惑
    // 变成静默消失；但**不要**因为看到这里就给它们加上使用点。
    llmModel: process.env.AGENT_LLM_MODEL || '',
    temperature: parseFloat(process.env.AGENT_TEMPERATURE || '0.7'),
  };
}
