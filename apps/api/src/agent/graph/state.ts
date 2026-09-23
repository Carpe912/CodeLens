/**
 * LangGraph 图状态定义
 *
 * 这是 CodeLens 编排层的**唯一状态载体**，取代原先散落在
 * AgentCore 各方法之间靠局部变量传递的隐式状态。
 *
 * 设计原则：
 * 1. 字段只增不减 —— 用 reducer 累积，方便断点续跑与事后审计
 * 2. 循环控制显式化 —— round / maxRounds 进入状态，不再依赖隐式递归
 * 3. 与数据库 schema 对齐 —— 本状态的形状可直接落进 agent_executions
 *    （plan / steps / result / confidence 四列）
 *
 * 对应关系（详见 docs/agent-unimplemented-design.md 文末）：
 *   本状态字段           →  agent_executions 列
 *   evidence / trace     →  steps (JSONB)
 *   answer / confidence  →  result / confidence
 *   round                →  agent_reflections.round
 */

import { Annotation } from '@langchain/langgraph';
import type { EvidenceRecord } from '../evidence.js';

/**
 * 图中流转的证据条目。
 *
 * 就是 `EvidenceRecord` 的别名 —— 四条生成链路（/ask、/root-cause、AgentCore、编排图）
 * 共用同一形状，定义收在 `agent/evidence.ts`。历史上这里各有各的定义，
 * 一旦某个字段名漂移（例如 `file_path` 写成 `filePath`），
 * 引用自检会静默降级为 `empty_evidence` 而不报错，因此必须同源。
 */
export type GraphEvidence = EvidenceRecord;

/**
 * 图状态通道定义。
 *
 * reducer 说明：
 * - 累积型（evidence / strategiesUsed / trace）：合并新旧值
 * - 覆盖型（其余）：以新值覆盖，用 `(_a, b) => b` 显式表达，
 *   避免依赖框架的隐式默认行为
 *
 * 所有通道都给了 default，这样即使调用方漏传某个字段也不会在运行时炸掉。
 * query 与 repoId 的业务必要性在路由层做校验（见 routes 侧校验逻辑）。
 */
export const GraphState = Annotation.Root({
  // ============ 输入 ============
  /** 用户原始问题 */
  query: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  /** 目标仓库 ID */
  repoId: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  /** 会话 ID，用于 checkpointer 的 thread_id */
  sessionId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),

  // ============ 检索累积 ============
  /** 累积的多轮证据（不去重，保留每轮各自的结果以便审计） */
  evidence: Annotation<GraphEvidence[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
  /** 已尝试过的检索策略名，用于避免重复同样的失败尝试 */
  strategiesUsed: Annotation<string[]>({
    reducer: (prev, next) => Array.from(new Set(prev.concat(next))),
    default: () => [],
  }),

  // ============ 循环控制 ============
  /** 当前已完成的检索轮次，从 0 开始 */
  round: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  /** 轮次上限，由图构建时从 config.maxReasoningRounds 注入 */
  maxRounds: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 1,
  }),

  // ============ 评分 ============
  /** 证据充分度（0-1），由 grade 节点计算 */
  sufficiency: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  /**
   * 充分度阈值：低于此值则换策略重检索。
   *
   * 放进状态而非闭包，是为了让条件边的判定**完全由状态决定** ——
   * 这样从 checkpoint 恢复时，判定规则也随之恢复，不会因为
   * 进程重启后注入了不同的闭包参数而产生不一致的行为。
   * 取值来自 config.confidenceThreshold。
   */
  sufficiencyThreshold: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0.85,
  }),

  // ============ 输出 ============
  /** 最终答案 */
  answer: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  /** 启发式置信度（0-1），复用 AgentCore 的同一套估算规则 */
  confidence: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),

  // ============ 审计 ============
  /** 执行轨迹，逐节点追加，便于在 UI 上回放「Agent 是怎么想的」 */
  trace: Annotation<string[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
});

/** 图状态（读取用） */
export type GraphStateType = typeof GraphState.State;

/** 图状态更新（节点返回值用） */
export type GraphUpdate = typeof GraphState.Update;
