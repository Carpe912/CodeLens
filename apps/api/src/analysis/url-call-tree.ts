/**
 * 接口级调用关系（跨 HTTP 边界）
 *
 * ============================================
 * 它解决的是什么
 * ============================================
 * 「https://host/rest/account/getUserAuthority 这个接口在哪里被调用了」
 *
 * 这个问题的调用关系**跨越 HTTP 边界**：
 *   调用方代码里只有一条 URL 字符串，服务端只有一条路由声明，
 *   两者之间没有任何语法关系 —— 静态调用图（call_graph）结构上就看不见它。
 *
 * 所以这里不用 call_graph，而是用 URL 索引：
 *   url_patterns  一个 (method, 规范化路径) 一行，即「接口」本身
 *   url_usages    该接口出现的每个位置，usage_context 区分两侧
 *                 api_call         → 调用点（谁调用了它）
 *                 route_definition → 路由定义（实现在哪）
 *
 * 于是：callers = 调用点，root = 路由定义，callees = 该 handler 的进程内调用链
 * （callees 仍走 buildSymbolCallTree，即 call_graph，两个索引在这里合流）。
 *
 * ============================================
 * 已知边界（别假装它比实际更强）
 * ============================================
 * - 路径里带参数名差异时匹配不上：客户端的 `/users/${id}` 与路由的 `/users/:userId`
 *   规范化后是 `:id` 与 `:userId`，是两个串。这里靠「占位段互相通配」兜住，
 *   但 `*.js` 里完全由变量拼出来的路径（`${path}`）仍然无法定根。
 * - 只有库里有 url_patterns/url_usages 数据才有效；两者都空时直接返回 null，
 *   由调用方降级回符号级逻辑。
 */

import type { Pool } from 'pg';
import {
  buildSymbolCallTree,
  SYMBOL_TREE_DEFAULT_DEPTH,
  type SymbolCallTreeResult,
  type SymbolTreeNode,
} from './symbol-call-tree.js';

interface PatternRow {
  id: number;
  method: string | null;
  pattern: string;
  normalizedPattern: string;
  definitionFileId: number | null;
  definitionLine: number | null;
}

interface UsageRow {
  usageContext: string | null;
  fileId: number | null;
  filePath: string | null;
  line: number | null;
  code: string;
  httpMethod: string | null;
  /** 该位置所在的函数/方法名（由 code_chunks 反查），取不到则 null */
  encloser: string | null;
  chunkId: number | null;
  codeText: string;
}

/** 路径占位段：`:id`、`${id}`、`*` 都算 */
function isPlaceholder(seg: string): boolean {
  return seg.startsWith(':') || seg === '*' || seg.includes('${');
}

/** 把 URL 或路径拆成段；顺便把纯数字段视作参数 */
function splitPath(raw: string): string[] {
  let path = raw;
  const schemeIdx = path.indexOf('://');
  if (schemeIdx >= 0) {
    path = path.slice(schemeIdx + 3);
    const slash = path.indexOf('/');
    path = slash >= 0 ? path.slice(slash) : '/';
  }
  path = path.split(/[?#]/)[0];
  return path
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .filter(Boolean);
}

/**
 * 把一个具体 URL 路径匹配到库里的接口模式。
 *
 * 规则（刻意保守）：
 * - 模式段与 URL 段**从尾部对齐**逐段比：字面量必须相等（忽略大小写），
 *   占位段可匹配任意一段。URL 允许比模式多出前缀段（baseURL、网关前缀等）。
 * - 字面量段命中越多分越高；同分取更长的模式。
 * - 一个占位段都不含、且与 URL 等长的模式优先级最高（精确路由）。
 */
export function matchUrlToPattern(
  rawUrl: string,
  patterns: Array<{ normalizedPattern: string; method: string | null }>
): { index: number; score: number } | null {
  const urlSegs = splitPath(rawUrl);
  if (urlSegs.length === 0) return null;

  let best: { index: number; score: number } | null = null;

  for (let i = 0; i < patterns.length; i++) {
    const patSegs = splitPath(patterns[i].normalizedPattern);
    if (patSegs.length === 0 || patSegs.length > urlSegs.length) continue;

    const offset = urlSegs.length - patSegs.length;
    let score = 0;
    let ok = true;

    for (let j = 0; j < patSegs.length; j++) {
      const ps = patSegs[j];
      const us = urlSegs[offset + j];
      if (isPlaceholder(ps)) continue; // 占位段通配
      if (ps.toLowerCase() !== us.toLowerCase()) {
        ok = false;
        break;
      }
      score += 2;
    }
    if (!ok) continue;
    // 完全由字面量组成且长度一致的模式更可信
    if (patSegs.every((s) => !isPlaceholder(s)) && patSegs.length === urlSegs.length) score += 1;

    if (!best || score > best.score) best = { index: i, score };
  }

  return best;
}

/** 取某一行所在的 code_chunk（用于回填函数名与代码文本） */
async function enclosingChunk(
  pool: Pool,
  fileId: number | null,
  line: number | null
): Promise<{ symbolName: string | null; chunkId: number | null; codeText: string; lineStart: number | null; lineEnd: number | null }> {
  if (!fileId || !line) return { symbolName: null, chunkId: null, codeText: '', lineStart: null, lineEnd: null };
  const res = await pool.query<{ id: number; symbolName: string | null; codeText: string; lineStart: number; lineEnd: number }>(
    `SELECT id, symbol_name AS "symbolName", code_text AS "codeText",
            line_start AS "lineStart", line_end AS "lineEnd"
     FROM code_chunks
     WHERE file_id = $1 AND line_start <= $2 AND line_end >= $2
     ORDER BY line_start DESC
     LIMIT 1`,
    [fileId, line]
  );
  const r = res.rows[0];
  if (!r) return { symbolName: null, chunkId: null, codeText: '', lineStart: null, lineEnd: null };
  return { symbolName: r.symbolName, chunkId: r.id, codeText: r.codeText, lineStart: r.lineStart, lineEnd: r.lineEnd };
}

/**
 * 为「接口 URL」构建跨边界调用树。
 *
 * @returns 匹配不到接口模式时返回 null（调用方据此降级）
 */
export async function buildUrlCallTree(
  pool: Pool,
  repoId: number,
  url: string,
  maxDepthRaw: number = SYMBOL_TREE_DEFAULT_DEPTH
): Promise<SymbolCallTreeResult | null> {
  const patternsRes = await pool.query<PatternRow>(
    `SELECT id, method, pattern, normalized_pattern AS "normalizedPattern",
            definition_file_id AS "definitionFileId", definition_line AS "definitionLine"
     FROM url_patterns
     WHERE repo_id = $1`,
    [repoId]
  );
  if (patternsRes.rows.length === 0) return null;

  const hit = matchUrlToPattern(
    url,
    patternsRes.rows.map((p) => ({ normalizedPattern: p.normalizedPattern, method: p.method }))
  );
  if (!hit) return null;

  const chosen = patternsRes.rows[hit.index];

  const usagesRes = await pool.query<UsageRow>(
    `SELECT u.usage_context AS "usageContext", u.usage_file_id AS "fileId",
            f.path AS "filePath", u.usage_line AS "line",
            u.usage_code AS "code", u.http_method AS "httpMethod"
     FROM url_usages u
     LEFT JOIN files f ON f.id = u.usage_file_id
     WHERE u.repo_id = $1 AND u.url_pattern_id = $2
     ORDER BY u.usage_context, u.usage_line`,
    [repoId, chosen.id]
  );

  const usages: UsageRow[] = [];
  for (const u of usagesRes.rows) {
    const enc = await enclosingChunk(pool, u.fileId, u.line);
    usages.push({ ...u, encloser: enc.symbolName, chunkId: enc.chunkId, codeText: enc.codeText });
  }

  const methodUpper = (chosen.method || 'ANY').toUpperCase();
  const endpointLabel = `${methodUpper} /${chosen.normalizedPattern}`;

  const callSites = usages.filter((u) => u.usageContext === 'api_call');
  const definitions = usages.filter((u) => u.usageContext !== 'api_call');

  const callers: SymbolTreeNode[] = callSites.map((u, i) => ({
    key: `url-caller-${i}`,
    // 调用点用「所在函数名」作为符号名，取不到就退化成文件名
    symbol: u.encloser || (u.filePath ? u.filePath.split('/').pop()! : '<调用点>'),
    symbolType: u.encloser ? 'function' : 'unknown',
    filePath: u.filePath,
    lineStart: u.line,
    lineEnd: u.line,
    chunkId: u.chunkId,
    callLine: u.line,
    resolved: true,
    ambiguous: false,
    candidateCount: 1,
    cyclic: false,
    truncated: false,
    codeText: u.codeText || u.code,
    children: [],
  }));

  // 根节点：优先用路由定义（实现在哪），没有定义就把接口本身当根
  const def = definitions[0];
  const root: SymbolTreeNode = {
    key: 'root',
    symbol: def?.encloser || endpointLabel,
    symbolType: 'url',
    filePath: def?.filePath ?? null,
    lineStart: def?.line ?? chosen.definitionLine ?? null,
    lineEnd: def?.line ?? chosen.definitionLine ?? null,
    chunkId: def?.chunkId ?? null,
    callLine: null,
    resolved: true,
    ambiguous: false,
    candidateCount: 1,
    cyclic: false,
    truncated: false,
    codeText: def?.codeText || def?.code || '',
    children: [],
  };

  // 向下分支：handler 的进程内调用链（call_graph）。取不到就留空，不编造。
  let callees: SymbolTreeNode[] = [];
  const warnings: SymbolCallTreeResult['warnings'] = [];

  if (def?.chunkId && def.encloser) {
    try {
      const sub = await buildSymbolCallTree(
        pool,
        repoId,
        def.encloser,
        def.chunkId,
        maxDepthRaw,
        'callees'
      );
      callees = sub.callees;
      warnings.push(...sub.warnings);
    } catch {
      warnings.push({ code: 'CALLEES_UNAVAILABLE', message: '该路由处理函数的内部调用链未能展开。' });
    }
  }

  if (callSites.length === 0) {
    warnings.push({
      code: 'NO_CALL_SITE',
      message: `已定位到这个接口（${endpointLabel}），但索引里没有记录到调用点 —— 调用方可能不在已入库的仓库范围内，或路径由变量拼接而无法静态解析。`,
    });
  }

  return {
    root,
    callers,
    callees,
    stats: {
      callersNodes: callers.length,
      calleesNodes: callees.length,
      totalNodes: 1 + callers.length + callees.length,
      resolvedEdges: callers.length,
      unresolvedEdges: 0,
      ambiguousNodes: 0,
      selfLoopEdgesFiltered: 0,
      cyclesDetected: 0,
      truncated: false,
      maxDepth: maxDepthRaw,
    },
    rootCandidates: [],
    warnings,
  };
}
