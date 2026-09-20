/**
 * 服务级共享单例（context）
 *
 * 这里集中构造整个 API 进程只应存在一份的重对象：
 * - 数据库连接池（pool）
 * - 多策略搜索引擎（multiStrategySearch）
 * - Anthropic 客户端（anthropic）—— 现为「当前 LLM 客户端」，见下方说明
 * - Agent 核心（agent）
 * - LangGraph 编排图（getGraph，懒加载）
 *
 * 拆分前这些单例直接写在 index.ts 的模块顶层；拆出后由路由模块通过
 * server/deps.ts 引用同一批实例，保证与拆分前完全一致（单例、共享状态不变）。
 *
 * 注意：构造这些对象不访问数据库，因此模块导入即可安全求值；
 * 数据库初始化（initDatabase）与队列启动（startIndexWorker）由
 * server/app.ts 在注册路由前显式调用。
 */

import { pool } from '../db/index.js';
import { MultiStrategySearch } from '../retrieval/multi-strategy-search.js';
import { AgentCore, getAgentConfig } from '../agent/index.js';
import { createCodeLensGraph, type CodeLensGraph } from '../agent/graph/index.js';
import { getLlmClient, describeLlmConfig } from '../llm/client.js';
import { describeRerankConfig } from '../retrieval/rerank.js';

/**
 * LLM 客户端（厂商由 LLM_PROVIDER 决定：deepseek | anthropic）
 *
 * 变量名 `anthropicApiKey` 与 `anthropic` 为历史遗留：这两个名字被 server/deps.ts
 * 再导出、进而被各个路由模块解构引用。为了把改动面控制在最小（不触碰 7 个路由
 * 文件），这里保留原导出名，但其语义已经变成「当前配置的 LLM」。
 */
export const llm = getLlmClient();

/** @deprecated 语义已变为「当前 LLM 客户端」，请使用 `llm` */
export const anthropic = llm;

/** @deprecated 已不再使用具体厂商的密钥变量，保留仅为兼容既有导入 */
export const anthropicApiKey =
  process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';

/** 多策略搜索引擎：向量 / 关键词 / 模糊 / URL / 依赖感知 */
export const multiStrategySearch = new MultiStrategySearch(pool, anthropicApiKey);

/** Agent 配置 */
export const agentConfig = getAgentConfig();

/** Agent 核心（单轮线性管道） */
export const agent = new AgentCore(pool, llm, agentConfig);
console.log(`[Server] Agent initialized (LLM: ${describeLlmConfig()})`);
console.log(`[Server] Retrieval (${describeRerankConfig()})`);

/**
 * 编排图（LangGraph）懒加载单例
 *
 * 为什么懒加载而不是启动时构建：
 * 1. 功能关闭时完全不加载 @langchain/* 依赖，不给启动路径增加开销
 * 2. checkpointer 的 setup() 会建表 —— 避免产生无人要求的启动期副作用
 *
 * 旧的 AgentCore 仍然完整保留，/agent/query 行为未变。
 * 图仅通过 /agent/v2/query 暴露，并由 AGENT_GRAPH_ENABLED 控制。
 */
let graphPromise: Promise<CodeLensGraph> | null = null;

export function getGraph(): Promise<CodeLensGraph> {
  if (!graphPromise) {
    graphPromise = createCodeLensGraph({ pool, anthropicApiKey });
  }
  return graphPromise;
}

export { pool };
