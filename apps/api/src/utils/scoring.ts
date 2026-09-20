/**
 * 评分的单一事实来源
 *
 * 这里集中放置两套启发式评分，供 AgentCore 单轮管道与 LangGraph 编排层共用。
 * 抽出来的动机很直接：这两套逻辑原本分散在 agent-core.ts 与图节点中，
 * 一旦各写一份，阈值和权重必然漂移，指标就失去可比性。
 *
 * ⚠️ 重要语义声明：
 * 这些分数是**启发式规则**，由「检索到多少、相关度多高、来源是否多样」折算而来，
 * 不是模型输出的概率，也没有经过人工标注校准。
 * 它们的用途是横向比较与触发重检索，**不应对外当作准确性承诺**。
 */

/** 置信度估算的默认采样上限 */
export const DEFAULT_SAMPLE_SIZE = 5;

/** 将数值截断到 [0, 1] */
export function clamp01(n: number): number {
  return Math.min(Math.max(n, 0), 1);
}

/** 四舍五入到两位小数，避免浮点噪声污染指标 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 依据相关性分数估算答案置信度。
 *
 * 相关性均值占 70%，证据覆盖度（相对采样上限）占 30%。
 * 采样上限与检索节点取用的条数保持一致，避免两处硬编码漂移。
 *
 * @param scores - 相关性分数列表，按相关性降序
 * @param sampleSize - 采样上限
 * @returns 0-1 的启发式分数；无有效分数时为 0
 */
export function estimateConfidenceFromScores(
  scores: number[],
  sampleSize: number = DEFAULT_SAMPLE_SIZE
): number {
  const cleaned = scores
    .slice(0, sampleSize)
    .filter(v => typeof v === 'number' && Number.isFinite(v))
    .map(clamp01);

  if (cleaned.length === 0) return 0;

  const avgRelevance = cleaned.reduce((sum, v) => sum + v, 0) / cleaned.length;
  const coverage = Math.min(cleaned.length / sampleSize, 1);

  return round2(avgRelevance * 0.7 + coverage * 0.3);
}

/**
 * 判断检索到的证据是否「足够回答问题了」。
 *
 * 三个维度加权：
 * - 条数 45%：3 条及以上记满分
 * - 来源多样性 25%：来自 2 个及以上不同文件记满分（防止 5 条全挤在同一函数里）
 * - 质量 30%：最高的 3 条分数之均值
 *
 * 返回值与 config.confidenceThreshold（语义为「低于此值需要更多证据」）比较，
 * 决定是继续换策略重检索，还是直接生成答案。
 *
 * @param entries - 检索结果，需含分数与文件路径
 * @returns 0-1 的充分度
 */
export function computeSufficiency(
  entries: Array<{ score: number; filePath: string }>
): number {
  if (entries.length === 0) return 0;

  const scores = entries
    .map(e => e.score)
    .filter(v => typeof v === 'number' && Number.isFinite(v))
    .map(clamp01);

  if (scores.length === 0) return 0;

  const distinctFiles = new Set(entries.map(e => e.filePath).filter(Boolean)).size;
  const countFactor = Math.min(entries.length / 3, 1);
  const diversityFactor = Math.min(distinctFiles / 2, 1);

  const topScores = scores.slice().sort((a, b) => b - a).slice(0, 3);
  const qualityFactor = topScores.reduce((sum, v) => sum + v, 0) / topScores.length;

  return round2(countFactor * 0.45 + diversityFactor * 0.25 + qualityFactor * 0.30);
}
