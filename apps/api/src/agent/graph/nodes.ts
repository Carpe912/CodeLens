/**
 * LangGraph 图节点实现
 *
 * 设计原则：**能复用就不重写**。
 * 三个节点全部复用项目已有的资产，图本身只负责「什么时候调用谁、失败后怎么办」：
 *
 *   retrieve → 复用 MultiStrategySearch（约 4000 行手写混合检索，一行未改）
 *   grade    → 复用 utils/scoring.ts 的充分度启发式
 *   answer   → 复用 llm/qa.ts 的 answerQuestion（含扩展上下文与提示词工程）
 *
 * 换句话说：LangGraph 接管的是**编排**，不是检索。这是本次改造的核心边界。
 */

import type { SearchOptions } from '../../retrieval/multi-strategy-search.js';
import type { MultiStrategySearch } from '../../retrieval/multi-strategy-search.js';
import { answerQuestion } from '../../llm/qa.js';
import { computeSufficiency, estimateConfidenceFromScores, DEFAULT_SAMPLE_SIZE } from '../../utils/scoring.js';
import { toEvidenceRecord, type EvidenceRecord, type GenerateAnswerFn } from '../evidence.js';
import type { GraphStateType, GraphUpdate } from './state.js';

/**
 * 逐轮升级的检索策略计划。
 *
 * 这是原 TaskPlanner 设计文档里「根据执行情况调整策略」的最小可用实现：
 * 不引入 LLM 规划，而是把「第一轮窄、后续轮逐步放宽」固化成一张有序表。
 * 好处是行为可预测、成本可估计、失败模式清晰；后续若接入 LLM 规划，
 * 只需替换本表的查表逻辑，节点契约不变。
 *
 * 第 1 轮：向量 + 精确，偏精准，宁缺毋滥
 * 第 2 轮：加入依赖追踪，顺着调用图扩大召回
 * 第 3 轮：全策略 + 降低阈值，尽可能兜住
 */
export const SEARCH_STRATEGY_PLAN: ReadonlyArray<{
  name: string;
  options: SearchOptions;
}> = [
  {
    name: 'r1_vector_exact',
    options: {
      limit: 10,
      threshold: 0.3,
      strategies: ['vector', 'exact'],
      includeContext: true,
    },
  },
  {
    name: 'r2_with_dependency',
    options: {
      limit: 15,
      threshold: 0.25,
      strategies: ['vector', 'dependency'],
      includeContext: true,
      followDependencies: true,
    },
  },
  {
    name: 'r3_broad',
    options: {
      limit: 20,
      threshold: 0.2,
      strategies: ['vector', 'exact', 'fuzzy', 'graph'],
      includeContext: true,
    },
  },
];

/**
 * 每轮最多向状态贡献多少条证据。
 * 避免多轮累积后把上下文窗口撑爆 —— 原设计文档「上下文窗口管理」一节的诉求。
 */
const MAX_EVIDENCE_PER_ROUND = 15;

/**
 * 检索节点工厂。
 *
 * 每次执行按当前 round 取用对应策略，并把 round 自增。
 * 自增放在这里而不是 grade 里，是为了保证「round 数 == 已执行的检索次数」这一不变量，
 * 便于事后从状态直接读出成本。
 */
export function createRetrieveNode(search: MultiStrategySearch) {
  return async (state: GraphStateType): Promise<Partial<GraphUpdate>> => {
    // round 从 0 开始，超出计划长度后固定使用最后一档（最宽策略）
    const planIndex = Math.min(state.round, SEARCH_STRATEGY_PLAN.length - 1);
    const plan = SEARCH_STRATEGY_PLAN[planIndex];

    const startedAt = Date.now();
    const results = await search.search(state.repoId, state.query, plan.options);
    const evidence = results.slice(0, MAX_EVIDENCE_PER_ROUND).map(toEvidenceRecord);
    const elapsed = Date.now() - startedAt;

    return {
      evidence,
      strategiesUsed: [plan.name],
      round: state.round + 1,
      trace: [
        `[retrieve] 第 ${state.round + 1} 轮 · 策略 ${plan.name} · 命中 ${results.length} 条`
          + ` · 采纳 ${evidence.length} 条 · 耗时 ${elapsed}ms`,
      ],
    };
  };
}

/**
 * 评分节点工厂。
 *
 * 只做判定、不改证据，因此不产生副作用。
 * 判定结论写进 trace，让「Agent 为什么又搜了一次」对使用者可见。
 */
export function createGradeNode() {
  return async (state: GraphStateType): Promise<Partial<GraphUpdate>> => {
    const sufficiency = computeSufficiency(
      state.evidence.map(e => ({ score: e.score, filePath: e.file_path }))
    );

    const passed = sufficiency >= state.sufficiencyThreshold;
    const canRetry = state.round < state.maxRounds;

    const verdict = passed
      ? '证据充分，进入答案生成'
      : canRetry
        ? `证据不足，换策略重检索（还剩 ${state.maxRounds - state.round} 轮）`
        : '证据不足但轮次已用尽，降级生成';

    return {
      sufficiency,
      trace: [`[grade] 充分度 ${sufficiency} / 阈值 ${state.sufficiencyThreshold} → ${verdict}`],
    };
  };
}

/**
 * 条件边：评分之后往哪走。
 *
 * 这是一个**纯函数**——只看状态，不依赖任何闭包变量。
 * 判定顺序刻意先查轮次上限，保证即使在充分度始终不达标的最坏情况下也必然收敛。
 *
 * ⚠️ 命名注意：这里返回的 'generate' 而非 'answer'。
 * LangGraph 不允许节点名与状态通道名重复，而状态里已经有一个 `answer`
 * 通道（用于装最终答案）。若把节点也叫 answer，编译期不会报错，
 * 但在图构建时会抛 "answer is already being used as a state attribute"。
 */
export function routeAfterGrade(state: GraphStateType): 'retrieve' | 'generate' {
  if (state.sufficiency >= state.sufficiencyThreshold) return 'generate';
  if (state.round >= state.maxRounds) return 'generate';
  return 'retrieve';
}

/**
 * 答案生成函数的签名，由 `agent/evidence.ts` 统一定义。
 *
 * 抽成可注入类型的目的：让图可以在**不依赖数据库和 LLM** 的情况下被测试。
 * 默认实现走既有的 answerQuestion，生产行为不变。
 * 这里转出是为了让 `graph/index.ts` 与 `agent/core.ts` 从同一处取类型 ——
 * AgentCore 的注入参数也用它，两处签名必须一致。
 */
export type { GenerateAnswerFn };

/**
 * 默认答案生成实现：复用 llm/qa.ts 的 answerQuestion。
 * 扩展上下文、查询类型分类、针对性提示词等既有能力因此全部自动生效。
 */
async function defaultGenerateAnswer(
  query: string,
  evidence: EvidenceRecord[]
): Promise<string> {
  return answerQuestion(query, evidence);
}

/**
 * 答案生成节点工厂。
 *
 * @param generate - 可注入的生成函数；不传则使用 answerQuestion
 */
export function createAnswerNode(generate: GenerateAnswerFn = defaultGenerateAnswer) {
  return async (state: GraphStateType): Promise<Partial<GraphUpdate>> => {
    // 空证据护栏：与 AgentCore.generateAnswer 保持同一策略，
    // 没有证据时不调用 LLM，避免产生无依据的回答。
    if (state.evidence.length === 0) {
      return {
        answer:
          `经过 ${state.round} 轮检索（策略：${state.strategiesUsed.join(' → ')}）`
          + '仍未找到相关代码证据，无法基于证据回答。'
          + '建议换用更具体的函数名、文件名或 URL 路径重试。',
        confidence: 0,
        trace: ['[generate] 无证据，跳过 LLM 调用以避免幻觉'],
      };
    }

    const startedAt = Date.now();
    const answer = await generate(state.query, state.evidence);
    const elapsed = Date.now() - startedAt;

    return {
      answer,
      confidence: estimateConfidenceFromScores(
        state.evidence.map(e => e.score),
        DEFAULT_SAMPLE_SIZE
      ),
      trace: [
        `[generate] 基于 ${state.evidence.length} 条证据生成`
          + ` · 充分度 ${state.sufficiency} · 耗时 ${elapsed}ms`,
      ],
    };
  };
}
