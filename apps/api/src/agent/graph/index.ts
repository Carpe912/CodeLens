/**
 * CodeLens 编排图（LangGraph）
 *
 * 拓扑：
 *
 *            ┌───────────────────────────────┐
 *            │                               │ 证据不足且轮次未用尽
 *   START → retrieve → grade ────────────────┘
 *                        │
 *                        └→ generate → END
 *
 * （终节点命名为 generate，因为状态里已有名为 answer 的通道，LangGraph 不允许节点与通道重名）
 *
 * 与原 AgentCore 单轮管道的关键差别：
 * 1. **有环** —— grade 可以把流程打回 retrieve，换一套策略重新检索
 * 2. **状态显式** —— 全部流转信息在 GraphState 中，可落库、可审计、可续跑
 * 3. **判定收敛** —— routeAfterGrade 先查轮次上限，最坏情况也必然终止
 * 4. **感知成本** —— 每次检索与生成都记耗时进 trace
 *
 * ⚠️ 与现有能力的关系：
 * 本图**不替换**任何现有路由。/ask、/root-cause、/agent/query 行为完全不变。
 * 图通过独立路由 /agent/v2/query 暴露，由环境变量开关控制。
 */

import { StateGraph, START, END } from '@langchain/langgraph';
import type { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { MultiStrategySearch } from '../../retrieval/multi-strategy-search.js';
import { getAgentConfig } from '../../config/index.js';
// 答案 ↔ 证据一致性自检（只观测，不改写答案）
import { checkAnswerConsistency, describeConsistencyIssue } from '../../llm/answer-consistency.js';
import type { ConsistencyReport } from '../../llm/answer-consistency.js';
import { GraphState } from './state.js';
import type { GraphEvidence } from './state.js';
import {
  createRetrieveNode,
  createGradeNode,
  createAnswerNode,
  routeAfterGrade,
  SEARCH_STRATEGY_PLAN,
  type GenerateAnswerFn,
} from './nodes.js';

/** 图执行结果 —— 对 API 层暴露的稳定契约 */
export interface GraphRunResult {
  /** 最终答案 */
  answer: string;
  /** 参与生成的全部证据 */
  evidence: GraphEvidence[];
  /** 启发式置信度（0-1），非模型概率 */
  confidence: number;
  /** 最终证据充分度（0-1） */
  sufficiency: number;
  /** 实际执行的检索轮次 */
  rounds: number;
  /** 依次使用过的策略名 */
  strategiesUsed: string[];
  /** 逐步执行轨迹，便于在 UI 上回放 */
  trace: string[];
  /** 总耗时（毫秒） */
  executionTime: number;
  /** 会话 ID，同时作为 checkpointer 的 thread_id */
  sessionId: string;
  /**
   * 答案引用 ↔ 证据的一致性自检报告（只观测，不改写答案）。
   *
   * `GraphEvidence` 就是 `CodeChunkRecord` 加上 file_path/score，本身就带
   * line_start/line_end，因此这里无需任何形状转换。与 /ask、/agent/query
   * 共用同一实现，四条生成链路在这一点上不再有缺口。
   */
  consistency: ConsistencyReport;
}

/**
 * 构建 checkpointer。
 *
 * **默认关闭**，需显式设置 AGENT_GRAPH_CHECKPOINTER=postgres 才启用。
 * 这样安排的原因：checkpointer 的 setup() 会在库里建表，
 * 属于有副作用的操作，不应在用户没准备好的情况下静默执行。
 *
 * 启用后即可获得跨进程的断点续跑能力：
 * 同一个 sessionId（thread_id）可以从中断处继续，而非从头重来。
 */
async function buildCheckpointer(pool: Pool) {
  if (process.env.AGENT_GRAPH_CHECKPOINTER !== 'postgres') {
    return undefined;
  }

  // 动态导入：未启用该能力时完全不加载这个包
  const mod = await import('@langchain/langgraph-checkpoint-postgres');
  const saver = new mod.PostgresSaver(pool);
  await saver.setup();
  console.log('[Graph] PostgresSaver checkpointer 已启用');
  return saver;
}

/**
 * 构建并编译编排图。
 *
 * @param deps.pool - 复用现有 pg 连接池（不新建连接）
 * @param deps.search - 可注入的检索器，默认 new MultiStrategySearch(...)。
 *   注入点存在的意义：让图能在无数据库、无 LLM 的环境下被完整测试
 *   （尤其是「证据不足 → 重检索」这条环，靠单元测试很难覆盖）
 * @param deps.generateAnswer - 可注入的答案生成函数，默认走 llm/qa.ts
 * @returns 已编译的图
 */
export async function createCodeLensGraph(deps: {
  pool: Pool;
  search?: MultiStrategySearch;
  generateAnswer?: GenerateAnswerFn;
}) {
  // 复用现有的多策略搜索引擎：图只编排，检索实现一行未改
  const search = deps.search ?? new MultiStrategySearch(deps.pool);
  const checkpointer = await buildCheckpointer(deps.pool);

  const workflow = new StateGraph(GraphState)
    .addNode('retrieve', createRetrieveNode(search))
    .addNode('grade', createGradeNode())
    // 节点名为 generate 而非 answer：状态里已有 answer 通道，LangGraph 不允许重名
    .addNode('generate', createAnswerNode(deps.generateAnswer))
    .addEdge(START, 'retrieve')
    .addEdge('retrieve', 'grade')
    .addConditionalEdges('grade', routeAfterGrade, {
      retrieve: 'retrieve',
      generate: 'generate',
    })
    .addEdge('generate', END);

  return checkpointer ? workflow.compile({ checkpointer }) : workflow.compile();
}

/** 已编译图的类型别名，避免把框架内部泛型泄漏到调用方 */
export type CodeLensGraph = Awaited<ReturnType<typeof createCodeLensGraph>>;

/**
 * 执行一次图查询。
 *
 * 这里做了两件此前做不到的事：
 * 1. 把 config.maxReasoningRounds 真正接上 —— 此前该配置无人读取
 * 2. 把 config.confidenceThreshold 作为「证据充分度阈值」接入条件边
 *
 * 轮次上限的处理有一个刻意的取舍：
 *   maxRounds = min(config.maxReasoningRounds, 策略计划长度)
 * 因为策略计划定义了**互不相同的**检索手段，用尽之后再重复最后一档
 * 只是白白花钱、几乎不会带来新证据。想跑更多轮，应往
 * SEARCH_STRATEGY_PLAN 里补策略，而不是把 maxRounds 调大。
 *
 * @param graph - 已编译的图
 * @param params.query - 用户问题
 * @param params.repoId - 目标仓库
 * @param params.sessionId - 会话 ID（可选；同时作为 thread_id）
 */
export async function runGraphQuery(
  graph: CodeLensGraph,
  params: { query: string; repoId: number; sessionId?: string }
): Promise<GraphRunResult> {
  const config = getAgentConfig();
  const startedAt = Date.now();
  const sessionId = params.sessionId || uuidv4();

  const maxRounds = Math.max(
    1,
    Math.min(config.maxReasoningRounds, SEARCH_STRATEGY_PLAN.length)
  );

  const finalState = await graph.invoke(
    {
      query: params.query,
      repoId: params.repoId,
      sessionId,
      maxRounds,
      sufficiencyThreshold: config.confidenceThreshold,
    },
    { configurable: { thread_id: sessionId } }
  );

  // 答案引用自检：与 /ask、/agent/query 同一道关卡。
  // 图这条链路此前是最容易漏掉的 —— 它复用了 answerQuestion 的提示词
  // （同样要求给出"文件路径和行号"），却没有任何校验。
  const consistency = checkAnswerConsistency(finalState.answer, finalState.evidence);
  const consistencyWarning = describeConsistencyIssue(consistency, '[graph]');
  if (consistencyWarning) console.warn(consistencyWarning);

  return {
    answer: finalState.answer,
    evidence: finalState.evidence,
    confidence: finalState.confidence,
    sufficiency: finalState.sufficiency,
    rounds: finalState.round,
    strategiesUsed: finalState.strategiesUsed,
    trace: finalState.trace,
    executionTime: Date.now() - startedAt,
    sessionId,
    consistency,
  };
}
