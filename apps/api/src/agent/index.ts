/**
 * Agent 编排层导出
 *
 * 结构：
 * - AgentCore        核心引擎（✅ 已实现）—— 单轮线性管道：分类 → 检索一次 → 生成一次 → 落库
 * - LangGraph 图     多轮编排（✅ 已实现）—— 见 ./graph/，retrieve → grade →（条件回边）→ generate
 * - AGENT_CAPABILITIES 能力开关，声明哪些能力尚未实现
 * - getAgentConfig / DEFAULT_AGENT_CONFIG  配置获取
 * - types            所有类型定义
 *
 * 已移除的空实现（planner / reasoning / memory / reflection / tool-registry）：
 * 这些类原为构造即抛错的占位符、零代码引用，其设计意图已归档到
 * docs/agent-unimplemented-design.md。
 *
 * 已知的失效配置（提取与否不影响任何行为，因为无人读取）：
 * - config.maxReasoningRounds  —— 轮次由 LangGraph 图自行计算，不读此值
 * - config.enableReflection    —— 无反思环节
 * - config.enableLearning      —— 无学习机制
 * - config.confidenceThreshold —— 无「低于阈值则继续检索」逻辑
 *
 * 使用示例：
 * ```typescript
 * import { AgentCore, getAgentConfig } from './agent/index.js';
 *
 * const config = getAgentConfig();
 * const agent = new AgentCore(db, llm, config);
 * const response = await agent.executeQuery('查找登录功能', repoId);
 * ```
 */

export { AgentCore, AGENT_CAPABILITIES } from './core.js';
export { getAgentConfig, DEFAULT_AGENT_CONFIG } from '../config/index.js';
export * from './types.js';
