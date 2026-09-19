/**
 * 重排（rerank）精排模块
 *
 * 背景：
 *   检索链路原本是「多策略召回 → mergeResults() 规则加权排序 → 去重 → 截断」，
 *   排序完全靠手工权重，没有真正的语义精排。本模块补上缺失的第二阶段：
 *     宽召回候选集 → 调 rerank 模型对 (query, document) 打语义相关性分
 *     → 按该分重排 → 截断到最终条数。
 *
 * 设计要点：
 * - **默认关闭**：只有 `RERANK_ENABLED=true` 才启用，避免未经验证的模型名拖累线上检索。
 * - **失败必须降级**：本模块只负责抛错，由调用方回退到规则排序，绝不能让整个检索失败。
 * - **失败冷却**：连续失败后进入 60s 冷却，避免每次检索都白等一次超时。
 * - **不打印密钥**：密钥只进请求头，日志里最多出现「是否已配置」。
 *
 * 环境变量：
 * - RERANK_ENABLED       'true' 才启用（默认 false）
 * - RERANK_MODEL         模型名；回退 DASHSCOPE_RERANK_MODEL；兜底 qwen3.7-text-rerank
 * - RERANK_API_KEY       密钥；回退 DASHSCOPE_API_KEY → EMBED_API_KEY
 * - RERANK_BASE_URL      端点；回退 DASHSCOPE_BASE_URL；默认 https://dashscope.aliyuncs.com
 * - RERANK_CANDIDATES    送入精排的候选条数（默认 50，模型上限 500）
 * - RERANK_TOP_N         只保留前 N 条（默认不限，交给检索 limit 截断）
 * - RERANK_TIMEOUT_MS    单次调用超时（默认 3000ms）
 * - RERANK_MAX_DOC_CHARS 单条候选文本截断长度（默认 2000；模型单文档上限 4000 token）
 *
 * 接口参考（DashScope 原生 text-rerank）：
 *   POST {base}/api/v1/services/rerank/text-rerank/text-rerank
 *   请求体：{ model, input: { query, documents: string[] }, parameters: { top_n, return_documents } }
 *   响应体：{ output: { results: [{ index, relevance_score }] }, usage, request_id }
 *   注意：部分模型（如 qwen3-rerank）把 results 放在**顶层**而非 output 里，解析需兼容两种形状。
 */

/** 单条候选的重排打分结果 */
export interface RerankScore {
  /** 该条在输入 documents 数组中的原始下标 */
  index: number;
  /** 语义相关性分数（0-1，越大越相关；仅限本次请求内可比） */
  relevanceScore: number;
}

export interface RerankConfigView {
  enabled: boolean;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  candidates: number;
  topN: number | null;
  timeoutMs: number;
  maxDocChars: number;
  coolingDown: boolean;
}

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com';
const DEFAULT_MODEL = 'qwen3.7-text-rerank';
const DEFAULT_CANDIDATES = 50;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_DOC_CHARS = 2000;
const MAX_CANDIDATES = 500;

/** 失败冷却截止时间戳（毫秒）。0 表示正常。 */
let cooldownUntil = 0;
/** 冷却时长：失败后 60s 内不再尝试，避免每次检索都等一次超时。 */
const FAILURE_COOLDOWN_MS = 60_000;

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveRerankApiKey(): string {
  return (
    process.env.RERANK_API_KEY ||
    process.env.DASHSCOPE_API_KEY ||
    process.env.EMBED_API_KEY ||
    ''
  );
}

export function hasRerankApiKey(): boolean {
  return resolveRerankApiKey().length > 0;
}

export function resolveRerankBaseUrl(): string {
  return (process.env.RERANK_BASE_URL || process.env.DASHSCOPE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function resolveRerankModel(): string {
  return process.env.RERANK_MODEL || process.env.DASHSCOPE_RERANK_MODEL || DEFAULT_MODEL;
}

export function resolveRerankCandidates(): number {
  return Math.min(readInt('RERANK_CANDIDATES', DEFAULT_CANDIDATES), MAX_CANDIDATES);
}

export function resolveRerankTimeoutMs(): number {
  return readInt('RERANK_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
}

export function resolveRerankMaxDocChars(): number {
  return readInt('RERANK_MAX_DOC_CHARS', DEFAULT_MAX_DOC_CHARS);
}

function resolveRerankTopN(): number | null {
  const raw = process.env.RERANK_TOP_N;
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** 是否处于失败冷却期 */
export function isRerankCoolingDown(): boolean {
  return Date.now() < cooldownUntil;
}

/**
 * rerank 是否可用：需显式开启 + 有密钥 + 不在冷却期。
 * 注意这里是「是否值得调用」，不是「模型是否真的能调通」——
 * 模型名/配额问题只会在真实调用时暴露，并触发冷却。
 */
export function isRerankEnabled(): boolean {
  return process.env.RERANK_ENABLED === 'true' && hasRerankApiKey() && !isRerankCoolingDown();
}

/** 供启动日志/健康检查使用的配置快照（不含密钥明文） */
export function getRerankConfig(): RerankConfigView {
  return {
    enabled: process.env.RERANK_ENABLED === 'true',
    model: resolveRerankModel(),
    baseUrl: resolveRerankBaseUrl(),
    hasApiKey: hasRerankApiKey(),
    candidates: resolveRerankCandidates(),
    topN: resolveRerankTopN(),
    timeoutMs: resolveRerankTimeoutMs(),
    maxDocChars: resolveRerankMaxDocChars(),
    coolingDown: isRerankCoolingDown(),
  };
}

/** 单行描述，用于启动日志（绝不包含密钥） */
export function describeRerankConfig(): string {
  const c = getRerankConfig();
  if (!c.enabled) return `rerank: 关闭（RERANK_ENABLED != 'true'）`;
  if (!c.hasApiKey) return `rerank: 已开启但缺少密钥，实际不会调用`;
  return `rerank: ${c.model} @ ${c.baseUrl}（候选 ${c.candidates}，超时 ${c.timeoutMs}ms）`;
}

/** 进入失败冷却期 */
function enterCooldown(): void {
  cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
}

/** 手动清除冷却（脚本自检用） */
export function resetRerankCooldown(): void {
  cooldownUntil = 0;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** 从两种响应形状里取出 results 数组 */
function extractResults(body: any): Array<{ index: number; relevanceScore: number }> {
  const candidates = body?.output?.results ?? body?.results ?? body?.data;
  if (!Array.isArray(candidates)) {
    throw new Error(`rerank 响应缺少 results 数组: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return candidates.map((item: any) => ({
    index: typeof item?.index === 'number' ? item.index : -1,
    relevanceScore:
      typeof item?.relevance_score === 'number'
        ? item.relevance_score
        : typeof item?.score === 'number'
          ? item.score
          : 0,
  }));
}

/**
 * 调用 rerank 模型，对候选文档按与 query 的语义相关性重新打分。
 *
 * @param query     用户查询
 * @param documents 候选文本（顺序即返回结果里的 index 基准）
 * @param opts.topN 只保留前 N 条；不传则返回全部（由调用方截断）
 * @returns 按相关性降序的打分结果
 * @throws 调用失败/超时/响应异常时抛错，由调用方降级处理
 */
export async function rerankDocuments(
  query: string,
  documents: string[],
  opts: { topN?: number } = {}
): Promise<RerankScore[]> {
  if (documents.length === 0) return [];

  const apiKey = resolveRerankApiKey();
  if (!apiKey) throw new Error('缺少 rerank 密钥（RERANK_API_KEY / DASHSCOPE_API_KEY）');

  const model = resolveRerankModel();
  const maxDocChars = resolveRerankMaxDocChars();
  const timeoutMs = resolveRerankTimeoutMs();
  const url = `${resolveRerankBaseUrl()}/api/v1/services/rerank/text-rerank/text-rerank`;

  const payload = {
    model,
    input: {
      query: truncate(query, 4000),
      documents: documents.map((d) => truncate(d || '', maxDocChars)),
    },
    parameters: {
      return_documents: false,
      ...(opts.topN ? { top_n: opts.topN } : {}),
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    enterCooldown();
    const reason = (error as Error).name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error as Error).message;
    throw new Error(`rerank 请求失败: ${reason}`);
  }
  clearTimeout(timer);

  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    enterCooldown();
    throw new Error(`rerank 响应非 JSON（HTTP ${response.status}）: ${text.slice(0, 200)}`);
  }

  if (!response.ok || body?.code) {
    enterCooldown();
    const code = body?.code || `HTTP ${response.status}`;
    throw new Error(`rerank 调用被拒绝: ${code} - ${body?.message || text.slice(0, 200)}`);
  }

  const scored = extractResults(body)
    .filter((r) => r.index >= 0 && r.index < documents.length)
    .sort((a, b) => b.relevanceScore - a.relevanceScore);

  if (scored.length === 0) {
    enterCooldown();
    throw new Error('rerank 返回了 0 条有效打分');
  }

  return scored;
}
