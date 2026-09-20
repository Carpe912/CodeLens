/**
 * 跨轮会话记忆（供 `/ask` 使用）
 *
 * ============================================
 * 为什么需要它
 * ============================================
 * 在它之前，`/ask` 是**完全无状态**的：同一个会话里问
 *   「登录功能是怎么实现的」
 *   「那它呢？」/「再往下看一层」
 * 第二问的检索词就是字面上的「那它呢」——多策略检索拿不到任何有效信号，
 * 于是要么召回一堆无关代码，要么直接触发「未检索到证据」护栏。
 *
 * 这不是模型能力问题，是**链路里没有把上一轮的问题带下来**。
 *
 * ============================================
 * 与 v2 图编排 checkpointer 的区别（别把这俩当成一回事）
 * ============================================
 * `agent/graph/` 的 `PostgresSaver` 持久化的是**图内部状态**
 * （evidence / strategiesUsed / trace / round），属于「一次查询的执行现场」。
 * 而本模块持久化的是**对话轮次**（问 + 答），属于「用户看到过什么」。
 *
 * 二者不能互相替代，而且**不能只靠打开 checkpointer 来实现会话记忆**：
 * `graph/state.ts` 里 `evidence` / `strategiesUsed` / `trace` 用的是
 * `prev.concat(next)` 累积 reducer，`round` 也不在每轮重置 ——
 * 同一个 thread 上问第二个问题时，第一个问题的证据会被累加进来，
 * `strategiesUsed` 直接是满的，检索层会误判成「策略都试过了」而不再重试。
 * 详见 docs/agent-unimplemented-design.md 的 v2 部分。
 *
 * ============================================
 * 为什么落在 `agent_conversations` 而不是 `questions`
 * ============================================
 * - `questions` 已有 145 行，是「全量问答审计 + 反馈」口径（`/ask` 现在就在写它），
 *   按 query 检索，没有 `session_id` 概念。往里加会话维度会同时改表 + 改写入路径。
 * - `agent_conversations` 线上已存在且**天然带 `session_id` / `repo_id` / `response`**，
 *   形状与本需求完全吻合，**零迁移**（本项目 `migrations/` 不进 dist，能不加就不加）。
 * - 副作用是好的：它此前 0 行、且是全仓唯一「有 SQL 引用但无建表声明」的表，
 *   现在从空转表变成真正被使用的表，并在 `db/index.ts` 里补了声明。
 *
 * ============================================
 * 失败语义（本项目的硬要求）
 * ============================================
 * 记忆读取失败**不允许**被静默吞掉。`loadRecentTurns` 返回判别联合
 * `MemoryLoad`，调用方必须处理 `ok: false` 分支，无法「顺手忽略」。
 * 会话记忆降级时答案仍然返回，但响应里必须带上 `memory.loadError`，
 * 让「记忆没生效」这件事可观测 —— 而不是变成一个没人发现的空转。
 */

import type { Pool } from 'pg';

/** 单轮对话（读回来的形状） */
export interface ConversationTurn {
  /** 该轮用户问题 */
  query: string;
  /** 该轮最终答案 */
  answer: string;
  /** 该轮落库时间 */
  createdAt: Date;
}

/**
 * 记忆读取结果。
 *
 * 用判别联合而不是「返回空数组」：空数组同时表示
 * 「新会话（正常）」和「读失败（异常）」两种截然不同的状态，
 * 合并成一个值就再也分不清了 —— 这正是本项目栽过的那类跟头。
 */
export type MemoryLoad =
  | { ok: true; turns: ConversationTurn[] }
  | { ok: false; error: string };

/** 默认注入的历史轮数。3 轮足够解析「它 / 这个 / 再往下」这类指代 */
export const DEFAULT_MEMORY_TURNS = 3;

/** `session_id` 列宽（与 db/index.ts 的 VARCHAR(128) 对齐） */
export const MAX_SESSION_ID_LEN = 128;

/** 单轮历史答案注入上下文时的截断上限（字符） */
export const MAX_HISTORY_ANSWER_CHARS = 800;

/**
 * 单轮历史**问题**注入上下文时的截断上限（字符）。
 *
 * 之前只截答案不截问题，是个真实的漏洞：用户完全可以把整个文件粘进输入框
 * 当提问（「这个文件为什么报错」+ 5000 行代码），此时问题本身就能撑爆预算，
 * 而答案截断完全挡不住。问题只需要够解析指代，不需要完整复现。
 */
export const MAX_HISTORY_QUERY_CHARS = 200;

/** 历史上下文总预算（字符）。超出的更早轮次直接放弃，不截半句 */
export const MAX_MEMORY_CONTEXT_CHARS = 3000;

/**
 * 规范化客户端传来的 sessionId。
 *
 * 直接信任客户端长度会带来两个问题：一是能把 `VARCHAR(128)` 写满
 * 甚至抛错，二是超长 ID 会白白撑大索引。这里统一裁剪。
 *
 * @returns 规范化后的 ID；空/非法时返回 null（调用方据此走无记忆路径）
 */
export function normalizeSessionId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_SESSION_ID_LEN);
}

/**
 * 从 `agent_conversations.response`（JSONB）里提取答案文本。
 *
 * ⚠️ 坑：`response` 是 JSONB，`pg` 默认会把它**解析成 JS 对象**返回，
 * 不是字符串。但历史行完全可能是以字符串形态塞进去的（比如某次手工写入）。
 * 两种形态都要接住，且绝不能让对象走到模板字符串里变成 `[object Object]`
 * —— 那会静默污染提示词，模型只会把它当成一段乱码。
 */
function extractAnswer(response: unknown): string {
  let obj: any = response;

  // 形态 A：pg 已解析（对象/数组）
  // 形态 B：仍是字符串 → 尝试再解析一次
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      // 不是 JSON，那就当纯文本答案用
      return obj.trim();
    }
  }

  if (obj && typeof obj === 'object') {
    const answer = (obj as any).answer;
    if (typeof answer === 'string') return answer;
    // 兜底：`/root-cause` 口径存的是 rootCause
    const rootCause = (obj as any).rootCause;
    if (typeof rootCause === 'string') return rootCause;
  }

  return '';
}

/**
 * 读取某会话在某仓库下的最近若干轮问答。
 *
 * 【为什么这么排序】`ORDER BY created_at DESC, id DESC`
 * 只按 `created_at` 排是不确定的：一毫秒内落库的多行（并发或快速连问）
 * 顺序由存储引擎决定，取回来的「上一轮」可能不是真正的上一轮。
 * `id` 是单调递增的，作为第二排序键才能给出稳定结果。
 * 取完再 reverse 成时间正序，喂给模型时「最近的在后」读起来才自然。
 *
 * 【为什么必须带 repo_id】同一 sessionId 可能被复用到别的仓库。
 * 不带 repo_id 会把别的仓库的代码问答注入进来 —— 模型会顺着错误上下文
 * 往下答，且看上去「言之有据」。
 */
export async function loadRecentTurns(
  db: Pool,
  repoId: number,
  sessionId: string,
  limit: number = DEFAULT_MEMORY_TURNS
): Promise<MemoryLoad> {
  // limit 来自常量或调用方，这里再夹一次，防止被传入超大值拖垮查询
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || DEFAULT_MEMORY_TURNS, 20));

  try {
    const result = await db.query(
      `SELECT query, response, created_at
         FROM agent_conversations
        WHERE session_id = $1 AND repo_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [sessionId, repoId, safeLimit]
    );

    const turns: ConversationTurn[] = result.rows
      .map((row: any) => ({
        query: typeof row.query === 'string' ? row.query : '',
        answer: extractAnswer(row.response),
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      }))
      // 答不出内容的历史轮次对指代解析毫无用处，注入进去只会挤占预算。
      // 注意：这里过滤的是「单轮无答案」，不是「整体为 0」——
      // 新会话查到 0 行是正常状态，不是失败。
      .filter((t: ConversationTurn) => t.query && t.answer)
      .reverse(); // DESC 取最近 N 条 → 反转成时间正序

    return { ok: true, turns };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

/**
 * 追加一轮问答到会话。
 *
 * 写入失败会**抛出**，由调用方决定如何呈现（`/ask` 会记入 `memory.writeFailed`）。
 * 不在这里自己 catch 成一句日志，是因为「写不进去」和「写进去了」对
 * 排查会话记忆失效是完全不同的结论，不能被同一段代码抹平。
 */
export async function appendTurn(
  db: Pool,
  params: {
    repoId: number;
    sessionId: string;
    query: string;
    answer: string;
    executionTimeMs: number;
  }
): Promise<void> {
  const { repoId, sessionId, query, answer, executionTimeMs } = params;

  await db.query(
    `INSERT INTO agent_conversations (session_id, repo_id, query, response, execution_time_ms, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, NOW())`,
    [
      sessionId,
      repoId,
      query,
      // 只存 answer，不存整个响应：会话记忆只用到答案文本，
      // 存整份响应会把 evidence（10~15 条代码）也写进 JSONB，
      // 行体积膨胀十几倍却没有任何读取方需要它。
      JSON.stringify({ answer }),
      Math.max(0, Math.round(executionTimeMs)),
    ]
  );
}

/** 按字符数截断，超出时补一个显式标记（不要静默截断，读的人要知道它被截过） */
function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…（已截断）' : text;
}

/**
 * 把历史轮次压缩成可注入提示词的上下文块。
 *
 * 【最关键的一句约束】结尾必须明确告诉模型：
 * 历史只是用来解析指代，**证据仍然只能来自本轮检索结果**。
 * 否则模型会把上一轮答案里的 `文件:行号` 当成证据直接复用，
 * 而这些引用在本轮证据集里并不存在 —— 表现为「答案看起来很具体，
 * 但引用的行号在证据里根本找不到」，即幻觉引用。
 * （这类引用由 `llm/answer-consistency.ts` 在出网前做一次自检。）
 *
 * 【预算语义】`maxChars` 是**硬上限**：连最近一轮都放不下时返回空串，
 * 而不是超预算硬塞进去。这样调用方传入的预算始终可信。
 * 默认参数下不会触发空结果 —— 单轮最大体积约
 * `MAX_HISTORY_QUERY_CHARS(200) + MAX_HISTORY_ANSWER_CHARS(800) + 固定开销`
 * 远小于默认预算 3000，因此「至少注入最近一轮」在默认配置下恒成立。
 * 这条不变量由 `verify:memory` 直接断言（构造最坏单轮输入）。
 *
 * 【为什么从最近往前收】预算不够时，该留下的是**最新**的上下文：
 * 用户问「那它呢」指的是上一轮，而不是三轮之前。
 *
 * @returns 可直接拼进提示词的文本；无历史（或预算放不下）时返回空字符串
 */
export function formatConversationContext(
  turns: ConversationTurn[],
  maxChars: number = MAX_MEMORY_CONTEXT_CHARS
): string {
  if (!turns || turns.length === 0) return '';

  const blocks: string[] = [];
  let used = 0;

  // 从最近一轮往前收，保证预算不够时留下的是**最新**的上下文
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const block =
      `[历史第 ${i + 1} 轮]\n` +
      `问: ${truncate(t.query, MAX_HISTORY_QUERY_CHARS)}\n` +
      `答: ${truncate(t.answer, MAX_HISTORY_ANSWER_CHARS)}`;

    // 宁可少给一轮，也不给半截 —— 半截答案比没有答案更容易误导
    if (used + block.length > maxChars) break;

    blocks.unshift(block); // unshift 保持时间正序
    used += block.length;
  }

  if (blocks.length === 0) return '';

  return [
    '=== 同一会话此前轮次 ===',
    ...blocks,
    '',
    '注意：以上历史仅用于理解本轮问题里的指代（如「它」「这个」「再往下」）。',
    '本轮答案的证据必须且只能来自下面「本轮代码证据」中的内容，',
    '**不要引用历史轮次里出现过的文件名或行号**，除非它们同样出现在本轮证据中。',
    '=== 会话历史结束 ===',
  ].join('\n');
}
