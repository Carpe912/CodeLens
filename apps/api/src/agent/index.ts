/**
 * Agent 模块导出
 *
 * 这是 Agent 模块的统一导出文件
 * 提供对外的公共 API 和类型定义
 *
 * 模块结构：
 * - AgentCore: 核心引擎，负责任务执行和协调
 * - TaskPlanner: 任务规划器（简化版已集成到 AgentCore）
 * - ReasoningEngine: 推理引擎（简化版已集成到 AgentCore）
 * - ConversationMemory: 对话记忆（简化版已集成到 AgentCore）
 * - ReflectionEngine: 反思引擎（简化版已集成到 AgentCore）
 * - ToolRegistry: 工具注册表（简化版已集成到 AgentCore）
 * - getAgentConfig: 配置获取函数
 * - DEFAULT_AGENT_CONFIG: 默认配置
 * - types: 所有类型定义
 *
 * 使用示例：
 * ```typescript
 * import { AgentCore, getAgentConfig } from './agent';
 *
 * const config = getAgentConfig();
 * const agent = new AgentCore(db, llm, config);
 * const response = await agent.executeQuery('查找登录功能', repoId);
 * ```
 */

export { AgentCore } from './agent-core.js';
export { TaskPlanner } from './planner.js';
export { ReasoningEngine } from './reasoning.js';
export { ConversationMemory } from './memory.js';
export { ReflectionEngine } from './reflection.js';
export { ToolRegistry } from './tool-registry.js';
export { getAgentConfig, DEFAULT_AGENT_CONFIG } from './config.js';
export * from './types.js';
