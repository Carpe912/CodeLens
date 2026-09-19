/**
 * 按用户语义构建调用关系（提问 → 调用树）
 *
 * ============================================
 * 为什么需要这个模块
 * ============================================
 * 之前的调用树是「先有证据、再画树」，用户必须自己点按钮、自己输符号名。
 * 但用户的真实提问本身就带着意图：
 *   「https://.../account/getUserAuthority 这个接口在哪里调用了或者被谁调用了」
 *     → 根符号 getUserAuthority，方向 = 调用方（callers）
 *   「batchProcessOrders 调用了哪些方法」
 *     → 根符号 batchProcessOrders，方向 = 被调用方（callees）
 * 所以这里从**原始提问**里解析出「根符号 + 方向」，直接产出调用树。
 *
 * ============================================
 * 解析策略（刻意保守，宁可多给候选也不猜错）
 * ============================================
 * 1) **根符号候选按可信度排序**：
 *    URL 末段 > 提问里的 lowerCamelCase 标识符 > 证据里排第一的符号。
 *    URL 末段排第一是因为「接口路径最后一段通常就是处理函数名」这个约定最稳。
 * 2) **每个候选都要回 DB 验证存在**（精确匹配优先，再退化为大小写不敏感），
 *    验证通过才当根 —— 否则「看起来像函数名的英文单词」会被误当成符号。
 * 3) **方向靠关键词计分**，而不是命中即返回：中英文各有正负向词表，
 *    「调用了谁」(callees) 与「谁调用了」(callers) 只差语序，必须分开判。
 *    两边都没命中时返回 'both'（把上下文都给出来）。
 * 4) 解析不出根符号时**不报错**，而是如实返回 `level:'file'` + 原因，
 *    由前端降级展示证据列表 —— 宁可不显示，也不要显示一棵假的树。
 */

import type { Pool } from 'pg';
import {
  buildSymbolCallTree,
  SYMBOL_TREE_DEFAULT_DEPTH,
  type SymbolCallTreeResult,
} from './symbol-call-tree.js';
import { buildUrlCallTree } from './url-call-tree.js';

export type CallDirection = 'callers' | 'callees' | 'both';

export interface CallIntent {
  direction: CallDirection;
  /** symbol = 解析到了具体符号；file = 只能到文件级别（未解析出符号） */
  level: 'symbol' | 'file';
  /** 给用户看的解释，说明为什么是这个方向 */
  reason: string;
  /** 从提问里抽出的候选符号（按优先级排序） */
  tokens: string[];
  matchedBy: 'url-segment' | 'query-token' | 'evidence-top' | 'none';
}

export interface ResolvedRoot {
  symbol: string;
  filePath: string;
  lineStart: number;
  chunkId: number;
}

export interface QueryCallTreeResult {
  repoId: number;
  query: string;
  intent: CallIntent;
  root: ResolvedRoot | null;
  tree: SymbolCallTreeResult | null;
  /** 提问里出现的、同样能在仓库中找到定义的其它候选符号 */
  alternatives: ResolvedRoot[];
  warnings: Array<{ code: string; message: string }>;
}

// —— 方向词表 ——
// 顺序无关，靠计分；长词优先由正则本身的 specificity 保证。
const CALLERS_PATTERNS: Array<{ re: RegExp; w: number }> = [
  { re: /在哪(里|些)?(地方|文件|模块)?(被)?调用/g, w: 3 },
  { re: /被谁(调用|引用|使用|用到)/g, w: 3 },
  { re: /谁(在)?(调用|引用|使用|用到)了?/g, w: 3 },
  { re: /(哪些|什么)(地方|文件|模块|位置)(调用|引用|使用)/g, w: 2 },
  { re: /被(引用|调用|使用)/g, w: 2 },
  { re: /调用(方|点|处)/g, w: 2 },
  { re: /(who calls|called by|callers|usages|references)/gi, w: 3 },
  { re: /\b(is|are|was|were)\s+[A-Za-z_$][\w$.]*\s+called\b/gi, w: 3 },
  // 单独出现的 called（如 "where is X called"）是弱正向信号
  { re: /\bcalled\b/gi, w: 1 },
];

const CALLEES_PATTERNS: Array<{ re: RegExp; w: number }> = [
  { re: /调用了?(谁|哪(些|个)|什么|哪些方法|哪些接口|哪些函数)/g, w: 3 },
  { re: /(依赖|依赖了|依赖于)(谁|哪(些|个)|什么)?/g, w: 3 },
  { re: /内部(调用|依赖)(了)?(谁|哪(些|个)|什么)?/g, w: 2 },
  { re: /会调用(哪些|什么|谁)/g, w: 2 },
  { re: /(calls into|depends on|callees|dependency)/gi, w: 3 },
  { re: /\b(what|which)\s+(does|do|did)?\s*[A-Za-z_$][\w$.]*\s+calls?\b/gi, w: 3 },
];

/** 与调用方向无关、但指示「想看实现/结构」的词（用于给出更贴切的 reason） */
const STRUCTURE_HINTS = /(怎么实现|如何实现|实现原理|实现方式|整体流程|调用链|执行流程|架构|依赖关系)/;

function score(patterns: Array<{ re: RegExp; w: number }>, text: string): number {
  let s = 0;
  for (const { re, w } of patterns) {
    const m = text.match(new RegExp(re.source, re.flags));
    if (m) s += w * m.length;
  }
  return s;
}

/**
 * 解析提问里的调用方向。
 * 中英文都判，「调用了谁」与「谁调用了」必须区分开。
 */
export function parseCallIntent(query: string): { direction: CallDirection; reason: string } {
  const callersScore = score(CALLERS_PATTERNS, query);
  const calleesScore = score(CALLEES_PATTERNS, query);

  if (callersScore > calleesScore) {
    return { direction: 'callers', reason: '提问在问「谁调用了它」→ 展开调用方' };
  }
  if (calleesScore > callersScore) {
    return { direction: 'callees', reason: '提问在问「它调用了谁」→ 展开被调用方' };
  }
  if (callersScore > 0 && callersScore === calleesScore) {
    return { direction: 'both', reason: '提问同时涉及调用与被调用 → 双向展开' };
  }
  if (STRUCTURE_HINTS.test(query)) {
    return { direction: 'both', reason: '提问想看实现/结构 → 双向展开调用上下文' };
  }
  return { direction: 'both', reason: '未识别到明确方向 → 默认双向展开' };
}

/** 常见的、不该被当成符号名的英文词与协议片段 */
const STOP_WORDS = new Set([
  'http', 'https', 'www', 'com', 'cn', 'net', 'org', 'api', 'rest', 'the', 'and', 'for',
  'how', 'what', 'where', 'which', 'does', 'is', 'are', 'this', 'that', 'code', 'file',
  'function', 'method', 'class', 'get', 'post', 'put', 'delete', 'v1', 'v2', 'v3',
]);

/** 像符号名的标识符：含内部大写（lowerCamelCase / PascalCase）或下划线，且不是停用词 */
function looksLikeSymbol(t: string): boolean {
  if (t.length < 3 || t.length > 80) return false;
  if (STOP_WORDS.has(t.toLowerCase())) return false;
  if (/^[A-Z0-9_]+$/.test(t) && t.length <= 3) return false;
  return /[A-Z]/.test(t.slice(1)) || t.includes('_') || /^[a-z]+[A-Z]/.test(t);
}

/**
 * 从提问里抽出符号候选，按可信度排序。
 *
 * - URL 末段最可信（接口路径最后一段通常就是处理函数名）
 * - 其次是 URL 中其它像符号名的路径段
 * - 再次是提问文本里像符号名的标识符
 */
export function extractSymbolTokens(query: string): { tokens: string[]; fromUrl: boolean } {
  const urlTokens: string[] = [];
  const textTokens: string[] = [];
  let fromUrl = false;

  const urlRe = /https?:\/\/[^\s"'<>）)】\],，。；;]+/gi;
  for (const m of query.matchAll(urlRe)) {
    fromUrl = true;
    const raw = m[0];
    try {
      const u = new URL(raw);
      const segs = u.pathname.split('/').filter(Boolean);
      // 从后往前找第一个像符号名的段：末段优先
      for (let i = segs.length - 1; i >= 0; i--) {
        const seg = decodeURIComponent(segs[i]).replace(/\.[A-Za-z0-9]+$/, '');
        if (!seg || /^[:{]/.test(seg) || /^\d+$/.test(seg)) continue;
        if (!/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(seg)) continue;
        if (looksLikeSymbol(seg)) {
          if (i === segs.length - 1) urlTokens.unshift(seg);
          else urlTokens.push(seg);
        }
      }
      // query string 里的 camelCase（如图 ?action=getUserAuthority）
      for (const v of u.searchParams.values()) {
        if (looksLikeSymbol(v)) urlTokens.push(v);
      }
    } catch {
      // URL 解析失败（缺协议等）：退化为按 / 切分
      const segs = raw.split('/').filter(Boolean);
      const last = segs[segs.length - 1]?.replace(/\.[A-Za-z0-9]+$/, '') ?? '';
      if (looksLikeSymbol(last)) urlTokens.unshift(last);
    }
  }

  // 提问文本里的标识符（排除 URL 自身，避免重复）
  const withoutUrl = query.replace(urlRe, ' ');
  const idRe = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g;
  for (const m of withoutUrl.matchAll(idRe)) {
    if (looksLikeSymbol(m[0])) textTokens.push(m[0]);
  }

  // 去重保序
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const t of [...urlTokens, ...textTokens]) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    tokens.push(t);
  }
  return { tokens: tokens.slice(0, 12), fromUrl };
}

interface SymbolRow {
  chunkId: number;
  symbolName: string;
  symbolType: string;
  filePath: string;
  lineStart: number;
}

/** 在仓库里按名字找符号定义：先精确匹配，再大小写不敏感 */
async function findSymbolsByName(
  pool: Pool,
  repoId: number,
  names: string[]
): Promise<Map<string, SymbolRow[]>> {
  // 键统一为小写符号名，调用方按 token.toLowerCase() 取用
  const byLower = new Map<string, SymbolRow[]>();
  if (names.length === 0) return byLower;

  const res = await pool.query<SymbolRow>(
    `SELECT c.id AS "chunkId", c.symbol_name AS "symbolName", c.symbol_type AS "symbolType",
            f.path AS "filePath", c.line_start AS "lineStart"
     FROM code_chunks c
     JOIN files f ON f.id = c.file_id
     WHERE f.repo_id = $1
       AND (c.symbol_name = ANY($2::text[]) OR lower(c.symbol_name) = ANY($3::text[]))
     ORDER BY c.symbol_name, f.path, c.line_start`,
    [repoId, names, names.map((n) => n.toLowerCase())]
  );

  for (const row of res.rows) {
    const key = row.symbolName.toLowerCase();
    const list = byLower.get(key);
    if (list) list.push(row);
    else byLower.set(key, [row]);
  }
  return byLower;
}

/**
 * 按提问语义构建调用关系。
 *
 * @param pool          pg 连接池
 * @param repoId        仓库 ID
 * @param query         用户的原始提问
 * @param candidates    可选：本次问答检索到的证据符号（用于提问里没有明确符号时定根）
 * @param maxDepthRaw   展开深度
 */
export async function buildQueryCallTree(
  pool: Pool,
  repoId: number,
  query: string,
  candidates: Array<{ symbol?: string; filePath?: string }> = [],
  maxDepthRaw: unknown = SYMBOL_TREE_DEFAULT_DEPTH,
  directionOverride?: CallDirection
): Promise<QueryCallTreeResult> {
  const warnings: QueryCallTreeResult['warnings'] = [];
  const parsed = parseCallIntent(query);
  // 前端允许显式覆盖方向（用户手动切换「调用方 / 被调用方」）
  const direction: CallDirection = directionOverride ?? parsed.direction;
  const reason = directionOverride
    ? `用户手动指定方向 → ${directionOverride === 'callers' ? '展开调用方' : directionOverride === 'callees' ? '展开被调用方' : '双向展开'}`
    : parsed.reason;
  const { tokens, fromUrl } = extractSymbolTokens(query);

  // —— 0) URL 类提问优先走「接口级」调用关系（跨 HTTP 边界）——
  // 这是一条**独立于 call_graph 的链路**：url_patterns + url_usages。
  // 提问里带 URL 时先按接口路径匹配；匹配到就整体走接口级，
  // 不再把 URL 末段当符号名丢进 code_chunks 里找（旧行为，几乎必然落空 ——
  // 接口名往往不是任何函数的符号名，这就是 URL 提问老是降级的原因）。
  if (fromUrl) {
    const urlRaw = query.match(/https?:\/\/[^\s"'<>）)】\],，。；;]+/i)?.[0];
    if (urlRaw) {
      try {
        const urlTree = await buildUrlCallTree(
          pool,
          repoId,
          urlRaw,
          Number(maxDepthRaw) > 0 ? Number(maxDepthRaw) : SYMBOL_TREE_DEFAULT_DEPTH
        );
        if (urlTree && urlTree.root) {
          return {
            repoId,
            query,
            intent: {
              direction: 'callers',
              level: 'symbol',
              reason: `${reason}（按接口路径匹配 url_patterns，调用点来自 url_usages）`,
              tokens,
              matchedBy: 'url-segment',
            },
            root: {
              symbol: urlTree.root.symbol,
              filePath: urlTree.root.filePath ?? '',
              lineStart: urlTree.root.lineStart ?? 0,
              chunkId: urlTree.root.chunkId ?? 0,
            },
            tree: urlTree,
            alternatives: [],
            warnings: [...warnings, ...urlTree.warnings],
          };
        }
      } catch (error) {
        warnings.push({
          code: 'URL_TREE_FAILED',
          message: `接口级调用关系构建失败，已回退到符号级：${(error as Error).message}`,
        });
      }
    }
  }

  const evidenceSymbols = candidates
    .map((c) => (typeof c.symbol === 'string' ? c.symbol.trim() : ''))
    .filter((s) => s !== '');

  // —— 1) 解析根符号：提问里的 token 优先，其次证据首位 ——
  const lookupNames = Array.from(new Set([...tokens, ...evidenceSymbols]));
  const found = await findSymbolsByName(pool, repoId, lookupNames);

  let root: ResolvedRoot | null = null;
  let matchedBy: CallIntent['matchedBy'] = 'none';
  const alternatives: ResolvedRoot[] = [];
  const claimed = new Set<number>();

  for (const token of tokens) {
    const rows = found.get(token.toLowerCase());
    if (!rows || rows.length === 0) continue;
    if (!root) {
      root = {
        symbol: rows[0].symbolName,
        filePath: rows[0].filePath,
        lineStart: rows[0].lineStart,
        chunkId: rows[0].chunkId,
      };
      matchedBy = fromUrl ? 'url-segment' : 'query-token';
      claimed.add(rows[0].chunkId);
    } else if (!claimed.has(rows[0].chunkId)) {
      alternatives.push({
        symbol: rows[0].symbolName,
        filePath: rows[0].filePath,
        lineStart: rows[0].lineStart,
        chunkId: rows[0].chunkId,
      });
      claimed.add(rows[0].chunkId);
    }
  }

  // 提问里没解析到符号 → 退到证据首位（保守：只取第一位，不猜）
  if (!root && evidenceSymbols.length > 0) {
    const rows = found.get(evidenceSymbols[0].toLowerCase());
    if (rows && rows.length > 0) {
      root = {
        symbol: rows[0].symbolName,
        filePath: rows[0].filePath,
        lineStart: rows[0].lineStart,
        chunkId: rows[0].chunkId,
      };
      matchedBy = 'evidence-top';
      claimed.add(rows[0].chunkId);
      warnings.push({
        code: 'ROOT_FROM_EVIDENCE',
        message: `提问里没有可定位的符号名，已改用检索命中的第一个符号「${rows[0].symbolName}」作为根。`,
      });
    }
  }

  if (!root) {
    warnings.push({
      code: 'NO_ROOT_SYMBOL',
      message:
        tokens.length > 0
          ? `提问里出现的名字（${tokens.slice(0, 5).join(', ')}）在本仓库的 code_chunks 中都没有定义，无法确定调用关系的根。`
          : '提问里没有识别到可用于定位的符号名，无法构建调用关系。',
    });
    return {
      repoId,
      query,
      intent: { direction, level: 'file', reason, tokens, matchedBy: 'none' },
      root: null,
      tree: null,
      alternatives: [],
      warnings,
    };
  }

  // —— 2) 建树 ——
  let tree: SymbolCallTreeResult | null = null;
  try {
    tree = await buildSymbolCallTree(pool, repoId, root.symbol, root.chunkId, maxDepthRaw, direction);
  } catch (error) {
    warnings.push({
      code: 'TREE_BUILD_FAILED',
      message: `构建调用树失败：${(error as Error).message}`,
    });
  }

  // 方向与实际情况不符时明确提示（用户可能在问「谁调用」，但该符号没有调用方）
  if (tree) {
    const { callersNodes, calleesNodes } = tree.stats;
    if (direction === 'callers' && callersNodes === 0) {
      warnings.push({
        code: 'NO_CALLERS_FOUND',
        message:
          `按提问语义查的是「谁调用了它」，但「${root.symbol}」在本仓库没有解析到调用方` +
          (calleesNodes > 0 ? `（它有 ${calleesNodes} 处被调用方）。可切换方向继续查看。` : '。'),
      });
    }
    if (direction === 'callees' && calleesNodes === 0) {
      warnings.push({
        code: 'NO_CALLEES_FOUND',
        message:
          `按提问语义查的是「它调用了谁」，但「${root.symbol}」没有解析到被调用方` +
          (callersNodes > 0 ? `（它有 ${callersNodes} 处调用方）。可切换方向继续查看。` : '。'),
      });
    }
  }

  return {
    repoId,
    query,
    intent: { direction, level: 'symbol', reason, tokens, matchedBy },
    root,
    tree,
    alternatives: alternatives.slice(0, 8),
    warnings,
  };
}
