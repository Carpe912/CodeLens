/**
 * 证据调用树
 *
 * ============================================
 * 为什么需要这个模块
 * ============================================
 * `/ask` 返回的 `evidence` 是一个**平铺列表**：10 条命中彼此独立，
 * 看不出谁调用了谁。而库里其实有 `call_graph`（调用边），只是没有任何
 * 入口把「这一批证据 + 它们的调用关系」拼成一棵树。
 *
 * ============================================
 * 三个必须绕开的坑（都是实测发现，不是设计推测）
 * ============================================
 * 1) **证据的 `id` 不是 `code_chunks.id`。**
 *    `/ask` 的 multi 分支用 `parseInt(result.id.split(':')[1])` 从
 *    `"table:id"` 里抠数字，把表名丢了。实测 `id=11486` 来自 `functions`
 *    表、`262546` 来自 `string_constants`，而 `call_graph.from_chunk_id`
 *    指向的是 `code_chunks`。所以**不能拿证据 id 去 walk 图**，
 *    必须按 (repoId, symbol_name, file_path) 重新解析。
 *
 * 2) **`code_chunks.repo_id` 全是 NULL。**
 *    实测 257 行里 `count(repo_id) = 0`。任何 `WHERE code_chunks.repo_id = $1`
 *    都会静默返回空集。归属关系只能走 `files.repo_id`。
 *
 * 3) **入库时的 `to_chunk_id` 解析大部分是失败的。**
 *    实测 333 条边里 181 条 `to_chunk_id IS NULL`；更糟的是同名的目标
 *    在有些行解析成功、有些行失败 —— 对某次真实检索的 10 条证据，
 *    **19 条出边里 0 条**带 `to_chunk_id`，而其中 `buildOrderPath`
 *    `cancelOrder` `getOrderDetail` 明明都在 `code_chunks` 里。
 *    所以本模块**在查询时按 `to_symbol` 名字重新解析**，不信任
 *    `to_chunk_id`。这不只是绕过坏数据 —— 它把召回从 0 提到了 11/25。
 *
 * ============================================
 * 另一处坑：101 条自环是「声明伪影」，不是递归
 * ============================================
 * `call_graph` 里 101 条自环（`from_chunk_id = to_chunk_id`）全部满足
 * `to_symbol = 该 chunk 自己的 symbol_name` 且 `call_line = line_start`。
 * 即：AST 抽取把「方法/构造器的声明标识符」当成了一次对自身的调用。
 * 101/101 都符合这个特征，因此可以用这个**精确谓词**过滤掉，
 * 而不是粗暴地砍掉所有自环（那样会误杀真实的单行递归）。
 *
 * ============================================
 * 与 /impact/* 的口径差异（有意为之）
 * ============================================
 * `analysis/impact.ts` 的立场是「符号名有歧义就返回 409 列候选，绝不猜」——
 * 因为那个接口回答的是**权威结论**（改动会波及什么），猜错比报错更糟。
 *
 * 本模块的用途是**可视化辅助**：把一批证据的调用关系画成一棵树给人看。
 * 一个节点歧义就整请求失败，等于这个功能不可用。因此这里的选择是：
 * **仍然展开，但把歧义如实标出来**（`ambiguous` + `candidateCount` +
 * 候选清单），并计入 `stats.ambiguousNodes` 与 `warnings`，交由 UI 区分显示。
 * 换句话说：不隐藏不确定性，但不因为不确定性而拒绝服务。
 */

import type { Pool } from 'pg';

/** 遍历深度上限（防止超大 fan-out 把请求拖死） */
export const CALL_TREE_MAX_DEPTH = 4;
/** 遍历深度默认值 */
export const CALL_TREE_DEFAULT_DEPTH = 2;
/** 单次返回节点数上限（超出即 truncated） */
export const CALL_TREE_MAX_NODES = 300;
/** 每个根节点最多返回多少个「谁调用了它」 */
export const CALL_TREE_MAX_CALLERS = 10;

/** 调用方的输入：只要符号名 + 可选文件路径 */
export interface CallTreeSymbolInput {
  symbol: string;
  filePath?: string;
}

/** 一个「谁调用了根符号」的引用（按名字可靠反查得到） */
export interface CallTreeCaller {
  symbol: string;
  symbolType: string;
  filePath: string | null;
  lineStart: number | null;
  callLine: number | null;
}

export interface CallTreeNode {
  /** 前端 React key：由访问路径生成，保证同层唯一 */
  key: string;
  symbol: string;
  symbolType: string;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  /** 解析到的 code_chunks.id；未解析为 null */
  chunkId: number | null;
  /** 调用发生在调用方的哪一行 */
  callLine: number | null;
  /** 是否属于本次检索命中的证据 */
  isEvidence: boolean;
  /** 是否解析到了具体代码块 */
  resolved: boolean;
  /** 同名多候选，展开结果可能不精确 */
  ambiguous: boolean;
  candidateCount: number;
  /** 歧义时给出候选（最多 3 个），便于人肉判断 */
  candidates?: Array<{ filePath: string; lineStart: number | null }>;
  /** 因成环而停止展开 —— 已在上层出现过 */
  cyclic: boolean;
  /** 因节点预算耗尽而停止展开 */
  truncated: boolean;
  children: CallTreeNode[];
}

export interface CallTreeWarning {
  code: string;
  message: string;
}

export interface CallTreeResult {
  roots: Array<CallTreeNode & { callers: CallTreeCaller[] }>;
  stats: {
    evidenceInput: number;
    evidenceResolved: number;
    nodes: number;
    resolvedEdges: number;
    unresolvedEdges: number;
    ambiguousNodes: number;
    selfLoopEdgesFiltered: number;
    cyclesDetected: number;
    truncated: boolean;
    maxDepth: number;
  };
  warnings: CallTreeWarning[];
}

/** 一行 `code_chunks` + 它的文件路径 */
interface ChunkRow {
  id: number;
  symbol_name: string;
  symbol_type: string;
  line_start: number;
  line_end: number;
  path: string;
}

/** 按符号名把仓库内的 chunk 全部取回，供解析与歧义判定 */
async function fetchChunksBySymbols(
  pool: Pool,
  repoId: number,
  symbols: string[]
): Promise<Map<string, ChunkRow[]>> {
  const bySymbol = new Map<string, ChunkRow[]>();
  if (symbols.length === 0) return bySymbol;

  // 注意：repo 归属走 files.repo_id —— code_chunks.repo_id 实测全为 NULL
  const res = await pool.query<ChunkRow>(
    `SELECT c.id, c.symbol_name, c.symbol_type, c.line_start, c.line_end, f.path
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

/**
 * 从同名候选中选一个。
 *
 * 优先级：**调用方同文件的唯一匹配** > **全仓唯一匹配** > 取第一个但标记歧义。
 * 同文件优先是因为绝大多数调用要么在同文件、要么目标名在全仓唯一；
 * 这条规则让 `getOrderItem`（在 dynamicOrderApi.js / orderApi.js 各一份）
 * 也能在调用方就近的文件里落地。
 */
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
  // 多个候选且无法靠同文件消歧：展开但如实标记
  return { row: candidates[0], ambiguous: true, candidateCount: candidates.length };
}

/** 待展开队列里的一个任务 */
interface PendingExpand {
  chunkId: number;
  symbol: string;
  parentPath: string;
  depth: number;
  ancestors: Set<number>;
  node: CallTreeNode;
}

/**
 * 构建证据调用树
 *
 * @param pool     pg 连接池
 * @param repoId   仓库 ID
 * @param inputs   证据符号（symbol 必填，filePath 可选，用于消歧）
 * @param maxDepthRaw 深度上限（未指定用默认 2，上限 4）
 * @returns 以每条证据为根的森林 + 统计数据 + warnings
 */
export async function buildEvidenceCallTree(
  pool: Pool,
  repoId: number,
  inputs: CallTreeSymbolInput[],
  maxDepthRaw: unknown = CALL_TREE_DEFAULT_DEPTH
): Promise<CallTreeResult> {
  const parsedDepth = Number(maxDepthRaw);
  const maxDepth = Number.isFinite(parsedDepth)
    ? Math.min(Math.max(Math.trunc(parsedDepth), 1), CALL_TREE_MAX_DEPTH)
    : CALL_TREE_DEFAULT_DEPTH;

  const warnings: CallTreeWarning[] = [];
  const stats: CallTreeResult['stats'] = {
    evidenceInput: inputs.length,
    evidenceResolved: 0,
    nodes: 0,
    resolvedEdges: 0,
    unresolvedEdges: 0,
    ambiguousNodes: 0,
    selfLoopEdgesFiltered: 0,
    cyclesDetected: 0,
    truncated: false,
    maxDepth,
  };

  // —— 第 1 步：解析证据 → code_chunks ——
  const evidenceSymbols = Array.from(new Set(inputs.map((i) => i.symbol).filter(Boolean)));
  const rootChunkMap = await fetchChunksBySymbols(pool, repoId, evidenceSymbols);

  interface RootSeed {
    input: CallTreeSymbolInput;
    row: ChunkRow | null;
    ambiguous: boolean;
    candidateCount: number;
    candidates: ChunkRow[] | undefined;
  }

  const seeds: RootSeed[] = inputs.map((input) => {
    const candidates = rootChunkMap.get(input.symbol);
    const picked = pickCandidate(candidates, input.filePath);
    return { input, row: picked.row, ambiguous: picked.ambiguous, candidateCount: picked.candidateCount, candidates };
  });

  stats.evidenceResolved = seeds.filter((s) => s.row).length;
  const unresolvedRoots = seeds.filter((s) => !s.row);
  if (unresolvedRoots.length > 0) {
    warnings.push({
      code: 'EVIDENCE_NOT_RESOLVED',
      message:
        `${unresolvedRoots.length}/${inputs.length} 条证据在本仓库的 code_chunks 中找不到同名定义，` +
        `这些节点保留为叶子（不展开调用链）：` +
        unresolvedRoots.slice(0, 5).map((s) => s.input.symbol).join(', ') +
        (unresolvedRoots.length > 5 ? ` …共 ${unresolvedRoots.length} 个` : ''),
    });
  }

  // —— 第 2 步：建根节点 ——
  const nodesByKey = new Map<string, CallTreeNode>();
  const makeNode = (
    key: string,
    symbol: string,
    row: ChunkRow | null,
    opts: {
      isEvidence?: boolean;
      callLine?: number | null;
      ambiguous?: boolean;
      candidateCount?: number;
      candidates?: ChunkRow[];
    } = {}
  ): CallTreeNode => {
    const candidates = opts.candidates;
    const node: CallTreeNode = {
      key,
      symbol,
      symbolType: row ? row.symbol_type : 'unknown',
      filePath: row ? row.path : null,
      lineStart: row ? row.line_start : null,
      lineEnd: row ? row.line_end : null,
      chunkId: row ? row.id : null,
      callLine: opts.callLine ?? null,
      isEvidence: opts.isEvidence === true,
      resolved: row !== null,
      ambiguous: opts.ambiguous === true,
      candidateCount: opts.candidateCount ?? (row ? 1 : 0),
      cyclic: false,
      truncated: false,
      children: [],
    };
    if (opts.ambiguous && candidates && candidates.length > 1) {
      node.candidates = candidates.slice(0, 3).map((c) => ({ filePath: c.path, lineStart: c.line_start }));
    }
    nodesByKey.set(key, node);
    stats.nodes += 1;
    if (node.ambiguous) stats.ambiguousNodes += 1;
    return node;
  };

  const roots: CallTreeResult['roots'] = [];
  const queue: PendingExpand[] = [];

  seeds.forEach((seed, idx) => {
    const key = `r${idx}`;
    const node = makeNode(key, seed.input.symbol, seed.row, {
      isEvidence: true,
      ambiguous: seed.ambiguous,
      candidateCount: seed.candidateCount,
      candidates: seed.candidates,
    });
    const root = Object.assign(node, { callers: [] as CallTreeCaller[] });
    roots.push(root);

    if (seed.row) {
      queue.push({ chunkId: seed.row.id, symbol: seed.row.symbol_name, parentPath: key, depth: 0, ancestors: new Set([seed.row.id]), node });
    }
  });

  // —— 第 3 步：按层展开调用链 ——
  // 批量化：每一层把所有待展开的 chunkId 收齐，一次查询拿走全部出边
  let levelQueue = queue;
  while (levelQueue.length > 0) {
    const depth = levelQueue[0].depth + 1;
    if (depth > maxDepth) break;

    const active = levelQueue.filter((q) => stats.nodes < CALL_TREE_MAX_NODES);
    if (active.length === 0) {
      if (levelQueue.length > 0) stats.truncated = true;
      break;
    }
    if (active.length < levelQueue.length) stats.truncated = true;

    const chunkIds = Array.from(new Set(active.map((q) => q.chunkId)));

    // 出边：查询时按 to_symbol 名字解析，不信任入库的 to_chunk_id
    const edgeRes = await pool.query<{
      from_chunk_id: number;
      to_symbol: string;
      call_line: number | null;
      raw_edges: number;
      all_self_loop: boolean;
    }>(
      `SELECT cg.from_chunk_id,
              cg.to_symbol,
              MIN(cg.call_line)::int AS call_line,
              COUNT(*)::int           AS raw_edges,
              bool_and(cg.from_chunk_id = cg.to_chunk_id
                       AND cg.to_symbol = own.symbol_name
                       AND cg.call_line = own.line_start) AS all_self_loop
       FROM call_graph cg
       JOIN code_chunks own ON own.id = cg.from_chunk_id
       WHERE cg.from_chunk_id = ANY($1::int[]) AND cg.repo_id = $2
       GROUP BY cg.from_chunk_id, cg.to_symbol
       ORDER BY cg.from_chunk_id, call_line NULLS LAST`,
      [chunkIds, repoId]
    );

    // 声明伪影（整组都是「声明行上的自调用」）直接丢掉；混合组保留真实的那部分
    const edges = edgeRes.rows.filter((e) => {
      if (!e.all_self_loop) return true;
      stats.selfLoopEdgesFiltered += e.raw_edges;
      return false;
    });

    const targetSymbols = Array.from(new Set(edges.map((e) => e.to_symbol)));
    const targetMap = await fetchChunksBySymbols(pool, repoId, targetSymbols);

    // 按 from_chunk_id 归组，便于对齐到各自的父节点
    const edgesByFrom = new Map<number, typeof edges>();
    for (const e of edges) {
      const list = edgesByFrom.get(e.from_chunk_id);
      if (list) list.push(e);
      else edgesByFrom.set(e.from_chunk_id, [e]);
    }

    const nextQueue: PendingExpand[] = [];

    for (const item of active) {
      const ownEdges = edgesByFrom.get(item.chunkId) ?? [];
      const seenChildSymbols = new Set<string>();

      for (const edge of ownEdges) {
        if (stats.nodes >= CALL_TREE_MAX_NODES) {
          stats.truncated = true;
          break;
        }
        // 同一父节点下同名目标只保留一个节点
        if (seenChildSymbols.has(edge.to_symbol)) continue;
        seenChildSymbols.add(edge.to_symbol);

        const candidates = targetMap.get(edge.to_symbol);
        const picked = pickCandidate(candidates, item.node.filePath);

        const childKey = `${item.parentPath}.${edge.to_symbol}`;
        const child = makeNode(childKey, edge.to_symbol, picked.row, {
          callLine: edge.call_line,
          ambiguous: picked.ambiguous,
          candidateCount: picked.candidateCount,
          candidates,
        });
        item.node.children.push(child);

        if (picked.row) {
          stats.resolvedEdges += 1;
          if (item.ancestors.has(picked.row.id)) {
            // 成环：标出来但不展开，避免无限递归
            child.cyclic = true;
            stats.cyclesDetected += 1;
            continue;
          }
          const nextAncestors = new Set(item.ancestors);
          nextAncestors.add(picked.row.id);
          nextQueue.push({
            chunkId: picked.row.id,
            symbol: picked.row.symbol_name,
            parentPath: childKey,
            depth,
            ancestors: nextAncestors,
            node: child,
          });
        } else {
          stats.unresolvedEdges += 1;
        }
      }
    }

    levelQueue = nextQueue;
  }

  // —— 第 4 步：根节点的「谁调用了它」——
  // 反查只按 to_symbol 名字做：这个方向实测是可靠的（入边不依赖 to_chunk_id）
  const resolvedRootSymbols = roots.filter((r) => r.resolved).map((r) => r.symbol);
  if (resolvedRootSymbols.length > 0) {
    const callerRes = await pool.query<{
      to_symbol: string;
      symbol_name: string;
      symbol_type: string;
      path: string;
      line_start: number;
      call_line: number | null;
    }>(
      `SELECT cg.to_symbol, cc.symbol_name, cc.symbol_type, f.path, cc.line_start,
              MIN(cg.call_line)::int AS call_line
       FROM call_graph cg
       JOIN code_chunks cc ON cc.id = cg.from_chunk_id
       JOIN files f ON f.id = cc.file_id
       WHERE cg.repo_id = $1 AND cg.to_symbol = ANY($2::text[])
         AND NOT (cg.from_chunk_id = cg.to_chunk_id AND cc.symbol_name = cg.to_symbol AND cg.call_line = cc.line_start)
       GROUP BY cg.to_symbol, cc.symbol_name, cc.symbol_type, f.path, cc.line_start
       ORDER BY cg.to_symbol, call_line NULLS LAST`,
      [repoId, resolvedRootSymbols]
    );

    const callersBySymbol = new Map<string, CallTreeCaller[]>();
    for (const row of callerRes.rows) {
      const list = callersBySymbol.get(row.to_symbol) ?? [];
      if (list.length < CALL_TREE_MAX_CALLERS) {
        list.push({
          symbol: row.symbol_name,
          symbolType: row.symbol_type,
          filePath: row.path,
          lineStart: row.line_start,
          callLine: row.call_line,
        });
      }
      callersBySymbol.set(row.to_symbol, list);
    }
    for (const root of roots) {
      root.callers = callersBySymbol.get(root.symbol) ?? [];
    }
  }

  if (stats.nodes === 0) {
    warnings.push({
      code: 'EMPTY_TREE',
      message: '未生成任何节点：证据符号在本仓库解析不到，或该仓库还没有调用边（需要先建立索引）。',
    });
  }
  if (stats.truncated) {
    warnings.push({
      code: 'TRUNCATED',
      message: `已达到节点上限 ${CALL_TREE_MAX_NODES} 或深度上限 ${maxDepth}，部分子树未展开。可降低 maxDepth 或缩小证据集。`,
    });
  }
  if (stats.selfLoopEdgesFiltered > 0) {
    warnings.push({
      code: 'SELF_LOOP_ARTIFACTS_FILTERED',
      message:
        `过滤掉 ${stats.selfLoopEdgesFiltered} 条「声明行上的自调用」伪影边` +
        `（AST 把方法/构造器的声明标识符当成了对自身的调用，特征：from=to 且 to_symbol=自身符号名 且 call_line=声明行）。`,
    });
  }
  if (stats.ambiguousNodes > 0) {
    warnings.push({
      code: 'AMBIGUOUS_NODES',
      message:
        `${stats.ambiguousNodes} 个节点存在同名候选，展开结果可能不精确（已在节点上标记 ambiguous 与候选清单）。` +
        `本模块为可视化用途，与 /impact/* 的「歧义即 409」策略不同：这里不隐藏不确定性，但不拒绝服务。`,
    });
  }

  return { roots, stats, warnings };
}
