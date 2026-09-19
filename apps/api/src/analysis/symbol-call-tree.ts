/**
 * 符号调用树（双向）
 *
 * ============================================
 * 与 evidence-call-tree.ts 的区别
 * ============================================
 * `evidence-call-tree` 的根是「一批检索证据」，向下展开「它调用了谁」，
 * 顺带反查根的「谁调用了它」（只做一层，仅用于显示 ↑ 计数）。
 *
 * 本模块的根是「用户指定的一个符号」，并且**双向都做传递展开**：
 * - callers（向上）：谁调用了它 → 再往上谁调用了「调用它的人」……
 * - callees（向下）：它调用了谁 → 再往下……
 * 目标场景：用户在搜索框输入 `getProductById`，直接看到它的完整调用上下文。
 *
 * ============================================
 * 复用的可靠性口径（来自 evidence-call-tree 的实测结论）
 * ============================================
 * 1) repo 归属走 `files.repo_id` —— `code_chunks.repo_id` 实测全为 NULL。
 * 2) 入边（callers）按 `to_symbol` 名字反查是可靠的（不依赖 to_chunk_id）。
 * 3) 出边（callees）的 `to_chunk_id` 大量为 NULL，必须按 `to_symbol` 名字重新解析。
 * 4) 「声明行上的自调用」是 AST 伪影（from=to 且 to_symbol=自身名 且 call_line=line_start），
 *    需用精确谓词过滤，不能粗暴砍掉所有自环。
 * 5) 同名多候选不拒绝服务，而是展开首个但标记 ambiguous + 候选清单（可视化用途）。
 */

import type { Pool } from 'pg';

/** 单方向展开深度上限 */
export const SYMBOL_TREE_MAX_DEPTH = 4;
/** 默认深度 */
export const SYMBOL_TREE_DEFAULT_DEPTH = 2;
/** 单方向节点数上限 */
export const SYMBOL_TREE_MAX_NODES = 400;

export interface SymbolTreeNode {
  key: string;
  symbol: string;
  symbolType: string;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  /** 解析到的 code_chunks.id；未解析为 null */
  chunkId: number | null;
  /** 这条边在「调用方」的哪一行发生；根节点为 null */
  callLine: number | null;
  resolved: boolean;
  ambiguous: boolean;
  candidateCount: number;
  candidates?: Array<{ filePath: string; lineStart: number | null }>;
  /** 因成环停止展开 */
  cyclic: boolean;
  /** 因节点预算/深度耗尽停止展开 */
  truncated: boolean;
  codeText: string;
  children: SymbolTreeNode[];
}

export interface SymbolCallTreeWarning {
  code: string;
  message: string;
}

export interface SymbolCallTreeResult {
  /** 根符号本身 */
  root: SymbolTreeNode | null;
  /** 向上分支：谁调用了它（root 直接展开） */
  callers: SymbolTreeNode[];
  /** 向下分支：它调用了谁（root 直接展开） */
  callees: SymbolTreeNode[];
  stats: {
    callersNodes: number;
    calleesNodes: number;
    totalNodes: number;
    resolvedEdges: number;
    unresolvedEdges: number;
    ambiguousNodes: number;
    selfLoopEdgesFiltered: number;
    cyclesDetected: number;
    truncated: boolean;
    maxDepth: number;
  };
  /** 根符号同名的多个定义时的候选清单（前端据此让用户选择） */
  rootCandidates: Array<{
    chunkId: number;
    filePath: string;
    lineStart: number;
  }>;
  warnings: SymbolCallTreeWarning[];
}

interface ChunkRow {
  id: number;
  symbol_name: string;
  symbol_type: string;
  line_start: number;
  line_end: number;
  code_text: string;
  path: string;
}

/** 按符号名取回仓库内全部 chunk（含 code_text，供点击查看代码） */
async function fetchChunksBySymbols(
  pool: Pool,
  repoId: number,
  symbols: string[]
): Promise<Map<string, ChunkRow[]>> {
  const bySymbol = new Map<string, ChunkRow[]>();
  if (symbols.length === 0) return bySymbol;

  const res = await pool.query<ChunkRow>(
    `SELECT c.id, c.symbol_name, c.symbol_type, c.line_start, c.line_end, c.code_text, f.path
     FROM code_chunks c
     JOIN files f ON f.id = c.file_id
     WHERE f.repo_id = $1 AND c.symbol_name = ANY($2::text[])
     ORDER BY c.symbol_name, f.path, c.line_start`,
    [repoId, symbols]
  );

  for (const row of res.rows) {
    const list = bySymbol.get(row.symbol_name);
    if (list) list.push(row);
    else bySymbol.set(row.symbol_name, [row]);
  }
  return bySymbol;
}

function pickCandidate(
  candidates: ChunkRow[] | undefined,
  preferredPath?: string | null
): { row: ChunkRow | null; ambiguous: boolean; candidateCount: number } {
  if (!candidates || candidates.length === 0) {
    return { row: null, ambiguous: false, candidateCount: 0 };
  }
  if (preferredPath) {
    const sameFile = candidates.filter((c) => c.path === preferredPath);
    if (sameFile.length === 1) {
      return { row: sameFile[0], ambiguous: false, candidateCount: candidates.length };
    }
  }
  if (candidates.length === 1) {
    return { row: candidates[0], ambiguous: false, candidateCount: 1 };
  }
  return { row: candidates[0], ambiguous: true, candidateCount: candidates.length };
}

function clampDepth(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

interface PendingExpand {
  chunkId: number;
  symbol: string;
  depth: number;
  ancestors: Set<number>;
  node: SymbolTreeNode;
}

/**
 * 构建以单个符号为根的双向调用树。
 */
export async function buildSymbolCallTree(
  pool: Pool,
  repoId: number,
  symbolName: string,
  chunkId?: number,
  maxDepthRaw: unknown = SYMBOL_TREE_DEFAULT_DEPTH,
  direction: 'both' | 'callers' | 'callees' = 'both'
): Promise<SymbolCallTreeResult> {
  const maxDepth = clampDepth(maxDepthRaw, SYMBOL_TREE_DEFAULT_DEPTH, SYMBOL_TREE_MAX_DEPTH);
  const doCallers = direction === 'both' || direction === 'callers';
  const doCallees = direction === 'both' || direction === 'callees';

  const stats: SymbolCallTreeResult['stats'] = {
    callersNodes: 0,
    calleesNodes: 0,
    totalNodes: 0,
    resolvedEdges: 0,
    unresolvedEdges: 0,
    ambiguousNodes: 0,
    selfLoopEdgesFiltered: 0,
    cyclesDetected: 0,
    truncated: false,
    maxDepth,
  };
  const warnings: SymbolCallTreeWarning[] = [];

  // —— 解析根符号 ——
  const candidates = (await fetchChunksBySymbols(pool, repoId, [symbolName])).get(symbolName) ?? [];

  if (candidates.length === 0) {
    warnings.push({
      code: 'SYMBOL_NOT_FOUND',
      message: `仓库 ${repoId} 中找不到符号 "${symbolName}"（精确匹配、区分大小写）。`,
    });
    return { root: null, callers: [], callees: [], stats, rootCandidates: [], warnings };
  }

  let rootRow: ChunkRow;
  if (chunkId !== undefined) {
    const picked = candidates.find((c) => c.id === chunkId);
    if (!picked) {
      warnings.push({
        code: 'CHUNK_ID_MISMATCH',
        message: `chunkId=${chunkId} 不属于符号 "${symbolName}"，已回退到第一个候选。`,
      });
      rootRow = candidates[0];
    } else {
      rootRow = picked;
    }
  } else {
    rootRow = candidates[0];
  }

  const rootAmbiguous = candidates.length > 1;

  const makeNode = (
    key: string,
    row: ChunkRow | null,
    opts: {
      callLine?: number | null;
      ambiguous?: boolean;
      candidateCount?: number;
      candidates?: ChunkRow[];
      symbolName?: string;
    } = {}
  ): SymbolTreeNode => {
    const node: SymbolTreeNode = {
      key,
      symbol: row ? row.symbol_name : (opts.symbolName ?? ''),
      symbolType: row ? row.symbol_type : 'unknown',
      filePath: row ? row.path : null,
      lineStart: row ? row.line_start : null,
      lineEnd: row ? row.line_end : null,
      chunkId: row ? row.id : null,
      callLine: opts.callLine ?? null,
      resolved: row !== null,
      ambiguous: opts.ambiguous === true,
      candidateCount: opts.candidateCount ?? (row ? 1 : 0),
      cyclic: false,
      truncated: false,
      codeText: row ? row.code_text : '',
      children: [],
    };
    if (opts.ambiguous && opts.candidates && opts.candidates.length > 1) {
      node.candidates = opts.candidates.slice(0, 3).map((c) => ({ filePath: c.path, lineStart: c.line_start }));
    }
    stats.totalNodes += 1;
    if (node.ambiguous) stats.ambiguousNodes += 1;
    return node;
  };

  const root: SymbolTreeNode = makeNode('root', rootRow, {
    ambiguous: rootAmbiguous,
    candidateCount: candidates.length,
    candidates,
  });

  const makeVirtualNode = (): SymbolTreeNode => ({
    key: 'virtual',
    symbol: rootRow.symbol_name,
    symbolType: 'unknown',
    filePath: null,
    lineStart: null,
    lineEnd: null,
    chunkId: null,
    callLine: null,
    resolved: false,
    ambiguous: false,
    candidateCount: 0,
    cyclic: false,
    truncated: false,
    codeText: '',
    children: [],
  });

  // —— 展开：callees（向下，谁被它调用）——
  // 从某个 chunk 出发，查它的出边（from_chunk_id = 自己），得到 to_symbol 列表。
  // 每轮按 from_chunk_id 分组对齐到「当前展开的 chunk」。
  const expandCallees = async (seedChunkId: number): Promise<SymbolTreeNode[]> => {
    const virtualParent = makeVirtualNode();
    let queue: PendingExpand[] = [
      { chunkId: seedChunkId, symbol: rootRow.symbol_name, depth: 0, ancestors: new Set([seedChunkId]), node: virtualParent },
    ];

    while (queue.length > 0) {
      const depth = queue[0].depth + 1;
      if (depth > maxDepth) break;
      const active = queue.filter(() => stats.totalNodes < SYMBOL_TREE_MAX_NODES);
      if (active.length === 0) { if (queue.length > 0) stats.truncated = true; break; }
      if (active.length < queue.length) stats.truncated = true;

      const chunkIds = Array.from(new Set(active.map((q) => q.chunkId)));
      const res = await pool.query<{
        from_chunk_id: number; to_symbol: string; call_line: number | null;
        raw_edges: number; all_self_loop: boolean;
      }>(
        `SELECT cg.from_chunk_id, cg.to_symbol, MIN(cg.call_line)::int AS call_line,
                COUNT(*)::int AS raw_edges,
                bool_and(cg.from_chunk_id = cg.to_chunk_id AND cg.to_symbol = own.symbol_name AND cg.call_line = own.line_start) AS all_self_loop
         FROM call_graph cg JOIN code_chunks own ON own.id = cg.from_chunk_id
         WHERE cg.from_chunk_id = ANY($1::int[]) AND cg.repo_id = $2
         GROUP BY cg.from_chunk_id, cg.to_symbol ORDER BY cg.from_chunk_id, call_line NULLS LAST`,
        [chunkIds, repoId]
      );

      const edges = res.rows.filter((e) => {
        if (!e.all_self_loop) return true;
        stats.selfLoopEdgesFiltered += e.raw_edges;
        return false;
      });

      const targetSymbols = Array.from(new Set(edges.map((e) => e.to_symbol)));
      const targetMap = await fetchChunksBySymbols(pool, repoId, targetSymbols);

      const edgesByFrom = new Map<number, typeof edges>();
      for (const e of edges) {
        const list = edgesByFrom.get(e.from_chunk_id);
        if (list) list.push(e); else edgesByFrom.set(e.from_chunk_id, [e]);
      }

      const nextQueue: PendingExpand[] = [];
      for (const item of active) {
        const ownEdges = edgesByFrom.get(item.chunkId) ?? [];
        const seen = new Set<string>();
        for (const edge of ownEdges) {
          if (stats.totalNodes >= SYMBOL_TREE_MAX_NODES) { stats.truncated = true; break; }
          if (seen.has(edge.to_symbol)) continue;
          seen.add(edge.to_symbol);

          const candidates = targetMap.get(edge.to_symbol);
          const picked = pickCandidate(candidates, item.node.filePath);
          const child = makeNode(`${item.node.key === 'virtual' ? 'callee' : item.node.key}.${edge.to_symbol}`, picked.row, {
            callLine: edge.call_line, ambiguous: picked.ambiguous,
            candidateCount: picked.candidateCount, candidates, symbolName: edge.to_symbol,
          });
          item.node.children.push(child);
          stats.calleesNodes += 1;

          if (picked.row) {
            stats.resolvedEdges += 1;
            if (item.ancestors.has(picked.row.id)) { child.cyclic = true; stats.cyclesDetected += 1; continue; }
            const nextAncestors = new Set(item.ancestors); nextAncestors.add(picked.row.id);
            nextQueue.push({ chunkId: picked.row.id, symbol: picked.row.symbol_name, depth, ancestors: nextAncestors, node: child });
          } else {
            stats.unresolvedEdges += 1;
          }
        }
      }
      queue = nextQueue;
    }
    return virtualParent.children;
  };

  // —— 展开：callers（向上，谁调用了它）——
  // 从某个符号出发，查「to_symbol = 该符号名」的入边，得到 from_chunk_id（调用方）。
  // 每轮按 to_symbol 分组对齐到「当前展开的符号名」。
  const expandCallers = async (seedSymbol: string, seedChunkId: number): Promise<SymbolTreeNode[]> => {
    const virtualParent = makeVirtualNode();
    let queue: PendingExpand[] = [
      { chunkId: seedChunkId, symbol: seedSymbol, depth: 0, ancestors: new Set([seedChunkId]), node: virtualParent },
    ];

    while (queue.length > 0) {
      const depth = queue[0].depth + 1;
      if (depth > maxDepth) break;
      const active = queue.filter(() => stats.totalNodes < SYMBOL_TREE_MAX_NODES);
      if (active.length === 0) { if (queue.length > 0) stats.truncated = true; break; }
      if (active.length < queue.length) stats.truncated = true;

      const activeSymbols = Array.from(new Set(active.map((q) => q.symbol)));
      const res = await pool.query<{
        from_chunk_id: number; to_symbol: string; call_line: number | null;
        raw_edges: number; all_self_loop: boolean;
      }>(
        `SELECT cg.from_chunk_id, cg.to_symbol, MIN(cg.call_line)::int AS call_line,
                COUNT(*)::int AS raw_edges,
                bool_and(cg.from_chunk_id = cg.to_chunk_id AND cg.to_symbol = cc.symbol_name AND cg.call_line = cc.line_start) AS all_self_loop
         FROM call_graph cg JOIN code_chunks cc ON cc.id = cg.from_chunk_id
         WHERE cg.repo_id = $1 AND cg.to_symbol = ANY($2::text[])
         GROUP BY cg.from_chunk_id, cg.to_symbol ORDER BY cg.from_chunk_id, call_line NULLS LAST`,
        [repoId, activeSymbols]
      );

      const edges = res.rows.filter((e) => {
        if (!e.all_self_loop) return true;
        stats.selfLoopEdgesFiltered += e.raw_edges;
        return false;
      });

      // 调用方实体（from_chunk_id → 符号）
      const idSet = Array.from(new Set(edges.map((e) => e.from_chunk_id)));
      const fromChunkById = new Map<number, ChunkRow>();
      if (idSet.length > 0) {
        const idRes = await pool.query<ChunkRow>(
          `SELECT c.id, c.symbol_name, c.symbol_type, c.line_start, c.line_end, c.code_text, f.path
           FROM code_chunks c JOIN files f ON f.id = c.file_id WHERE c.id = ANY($1::int[])`,
          [idSet]
        );
        for (const r of idRes.rows) fromChunkById.set(r.id, r);
      }

      // 按被调用的 to_symbol 分组对齐到「当前展开的符号」
      const edgesByToSymbol = new Map<string, typeof edges>();
      for (const e of edges) {
        const list = edgesByToSymbol.get(e.to_symbol);
        if (list) list.push(e); else edgesByToSymbol.set(e.to_symbol, [e]);
      }

      const nextQueue: PendingExpand[] = [];
      for (const item of active) {
        const ownEdges = edgesByToSymbol.get(item.symbol) ?? [];
        const seen = new Set<string>();
        for (const edge of ownEdges) {
          if (stats.totalNodes >= SYMBOL_TREE_MAX_NODES) { stats.truncated = true; break; }

          const callerRow = fromChunkById.get(edge.from_chunk_id) ?? null;
          const childSymbol = callerRow?.symbol_name ?? '';
          if (!childSymbol || seen.has(childSymbol)) continue;
          seen.add(childSymbol);

          const child = makeNode(`${item.node.key === 'virtual' ? 'caller' : item.node.key}.${childSymbol}`, callerRow, {
            callLine: edge.call_line,
          });
          item.node.children.push(child);
          stats.callersNodes += 1;

          if (callerRow) {
            stats.resolvedEdges += 1;
            if (item.ancestors.has(callerRow.id)) { child.cyclic = true; stats.cyclesDetected += 1; continue; }
            const nextAncestors = new Set(item.ancestors); nextAncestors.add(callerRow.id);
            nextQueue.push({ chunkId: callerRow.id, symbol: callerRow.symbol_name, depth, ancestors: nextAncestors, node: child });
          } else {
            stats.unresolvedEdges += 1;
          }
        }
      }
      queue = nextQueue;
    }
    return virtualParent.children;
  };

  // —— 双向展开 ——
  const callers: SymbolTreeNode[] = doCallers ? await expandCallers(rootRow.symbol_name, rootRow.id) : [];
  const callees: SymbolTreeNode[] = doCallees ? await expandCallees(rootRow.id) : [];

  if (stats.truncated) {
    warnings.push({
      code: 'TRUNCATED',
      message: `已达到节点上限 ${SYMBOL_TREE_MAX_NODES} 或深度上限 ${maxDepth}，部分子树未展开。`,
    });
  }
  if (stats.selfLoopEdgesFiltered > 0) {
    warnings.push({
      code: 'SELF_LOOP_ARTIFACTS_FILTERED',
      message: `过滤掉 ${stats.selfLoopEdgesFiltered} 条「声明行上的自调用」伪影边。`,
    });
  }
  if (rootAmbiguous) {
    warnings.push({
      code: 'ROOT_AMBIGUOUS',
      message: `符号 "${symbolName}" 在仓库中有 ${candidates.length} 个定义，当前展示第一个；可通过 chunkId 指定。`,
    });
  }

  return {
    root,
    callers,
    callees,
    stats,
    rootCandidates: candidates.map((c) => ({ chunkId: c.id, filePath: c.path, lineStart: c.line_start })),
    warnings,
  };
}
