/**
 * 影响面分析（Impact Analysis）
 *
 * ============================================
 * 这个模块解决什么问题
 * ============================================
 * 「改动这里会波及什么？」是代码库检索工具最有价值、也最容易被做成假的一个能力。
 * 本模块建立在两条**真实存在**的关系数据之上：
 *
 *   1. 文件级：file_dependencies（由 import_relations 物化而成）
 *      用于回答「改了 A 文件，哪些文件会被连带影响」
 *   2. 符号级：call_graph（from_chunk_id → to_chunk_id）
 *      用于回答「改了这个函数，谁会受影响」
 *
 * ============================================
 * 两个容易踩的坑，本模块显式处理
 * ============================================
 *
 * 【坑 1：名字不等于实体】
 * call_graph.to_symbol 是「调用时写的名字」（字符串），to_chunk_id 才是「解析到的定义」。
 * 同名符号在不同文件里很常见（handler、index、create…）。只按名字做反向查询，
 * 会把「恰好同名」的调用也算成依赖，图越滚越大且无法分辨真假。
 * 因此：
 *   - 遍历只走 to_chunk_id（实体级），保证不产生跨文件误连
 *   - 解析不到定义的调用边（to_chunk_id IS NULL）**不计入**结果，
 *     但通过 unresolvedEdges 如实告知「有多少条边没能解析」，
 *     让使用者知道这个图是不完整的，而不是假装它是完整的。
 *
 * 【坑 2：别名歧义】
 * 一个符号名可能对应多个 chunk。此时我们不擅自挑一个，而是把 candidates 全列出来
 * 并要求调用方指定 chunkId —— 猜错比报错更糟。
 *
 * ============================================
 * 与 DependencyTracker 的分工
 * ============================================
 * - DependencyTracker：基于 import_relations 的**单跳**明细查询（谁导入了这个符号/文件）
 * - 本模块：基于物化边表的**多跳传递闭包**（深度可配）与影响面聚合
 * 两者数据同源（import_relations），但用途不同：一个看细节，一个看波及范围。
 */

import type { Pool } from 'pg';

/** 影响面遍历的最大深度上限（防止意外传入超大值导致递归失控） */
export const MAX_DEPTH_LIMIT = 10;

/** 单次查询返回节点数的上限（超出即标记 truncated） */
export const MAX_NODES = 500;

export class ImpactError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_FOUND' | 'AMBIGUOUS' | 'BAD_REQUEST'
  ) {
    super(message);
  }
}

/** 一个受影响的文件 */
export interface AffectedFile {
  fileId: number;
  path: string;
  /** 距离目标的跳数：1 = 直接依赖，>1 = 间接 */
  depth: number;
  /** 从目标到该文件的路径（用于解释「为什么会被影响」） */
  pathChain: string[];
}

/** 一个受影响的符号 */
export interface AffectedSymbol {
  chunkId: number;
  symbolName: string;
  symbolType: string;
  filePath: string;
  startLine: number;
  depth: number;
  pathChain: string[];
}

/** 影响面报告的通用外壳 */
export interface ImpactReport<T> {
  /** 分析目标的可读描述 */
  target: string;
  maxDepth: number;
  /** 按层级分组的受影响节点 */
  byDepth: Array<{ depth: number; nodes: T[] }>;
  totalAffected: number;
  /** 是否因为 MAX_NODES 上限而被截断 */
  truncated: boolean;
  /**
   * 有多少条「关系边」因为目标无法解析到定义而未能计入结果。
   * 这是本报告**不完整**的量化说明 —— 请据此判断结论强度。
   */
  unresolvedEdges: number;
  /** 结果可信度的说明（自然语言，直接展示给使用者） */
  warnings: string[];
}

/** 符号解析候选 */
export interface SymbolCandidate {
  chunkId: number;
  symbolName: string;
  symbolType: string;
  filePath: string;
  startLine: number;
}

function clampDepth(raw: unknown, fallback = 3): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_DEPTH_LIMIT);
}

/**
 * 把 symbolName 解析为候选 chunk
 *
 * 不做「猜测性选择」：多个候选一律全量返回，由调用方决定用哪个。
 */
export async function resolveSymbolCandidates(
  pool: Pool,
  repoId: number,
  symbolName: string
): Promise<SymbolCandidate[]> {
  const res = await pool.query(
    `SELECT
       c.id AS chunk_id,
       c.symbol_name,
       c.symbol_type,
       c.line_start,
       f.path AS file_path
     FROM code_chunks c
     JOIN files f ON c.file_id = f.id
     WHERE f.repo_id = $1 AND c.symbol_name = $2
     ORDER BY f.path, c.line_start`,
    [repoId, symbolName]
  );

  return res.rows.map((r) => ({
    chunkId: r.chunk_id,
    symbolName: r.symbol_name,
    symbolType: r.symbol_type,
    filePath: r.file_path,
    startLine: r.line_start,
  }));
}

/**
 * 文件级影响面：改动该文件后，哪些文件会被（间接）影响
 *
 * 方向：沿 file_dependencies 的**反向**遍历（target → source），
 * 即「谁依赖了我」，这才是「改动波及」的方向。
 *
 * @param pool 数据库连接池
 * @param repoId 仓库 ID
 * @param filePath 目标文件路径（仓库内相对路径）
 * @param maxDepth 最大跳数
 * @param direction 'dependents' = 谁依赖我（影响面）；'dependencies' = 我依赖谁
 */
export async function analyzeFileImpact(
  pool: Pool,
  repoId: number,
  filePath: string,
  maxDepthRaw: unknown = 3,
  direction: 'dependents' | 'dependencies' = 'dependents'
): Promise<ImpactReport<AffectedFile>> {
  const maxDepth = clampDepth(maxDepthRaw);

  const fileRes = await pool.query(
    'SELECT id, path FROM files WHERE repo_id = $1 AND path = $2',
    [repoId, filePath]
  );

  if (fileRes.rows.length === 0) {
    throw new ImpactError(`File not found in repo ${repoId}: ${filePath}`, 'NOT_FOUND');
  }

  const rootId: number = fileRes.rows[0].id;
  const rootPath: string = fileRes.rows[0].path;

  // 反向 = 找 source（谁指向我）；正向 = 找 target（我指向谁）
  const joinColumn = direction === 'dependents' ? 'target_file_id' : 'source_file_id';
  const pickColumn = direction === 'dependents' ? 'source_file_id' : 'target_file_id';

  const res = await pool.query(
    `WITH RECURSIVE impacted AS (
       SELECT
         $1::int AS file_id,
         0 AS depth,
         ARRAY[$1::int] AS walked
       UNION ALL
       SELECT
         fd.${pickColumn} AS file_id,
         i.depth + 1 AS depth,
         i.walked || fd.${pickColumn} AS walked
       FROM impacted i
       JOIN file_dependencies fd ON fd.${joinColumn} = i.file_id
       WHERE i.depth < $2
         AND fd.repo_id = $3
         AND fd.${pickColumn} IS NOT NULL
         AND NOT fd.${pickColumn} = ANY(i.walked)
     )
     SELECT DISTINCT ON (i.file_id)
       i.file_id,
       i.depth,
       i.walked,
       f.path
     FROM impacted i
     JOIN files f ON f.id = i.file_id
     WHERE i.depth > 0
     ORDER BY i.file_id, i.depth
     LIMIT $4`,
    [rootId, maxDepth, repoId, MAX_NODES + 1]
  );

  const truncated = res.rows.length > MAX_NODES;
  const rows = truncated ? res.rows.slice(0, MAX_NODES) : res.rows;

  // 把 walked(file id 数组) 翻译成路径数组，并去掉首元素（目标自身）
  const idToPath = new Map<number, string>([[rootId, rootPath]]);
  const missingIds: number[] = [];
  for (const r of rows) {
    if (!idToPath.has(r.file_id)) missingIds.push(r.file_id);
  }
  if (missingIds.length > 0) {
    const fill = await pool.query('SELECT id, path FROM files WHERE id = ANY($1)', [missingIds]);
    for (const r of fill.rows) idToPath.set(r.id, r.path);
  }

  const nodes: AffectedFile[] = rows.map((r) => ({
    fileId: r.file_id,
    path: r.path,
    depth: r.depth,
    pathChain: (r.walked as number[]).map((id) => idToPath.get(id) ?? `#${id}`),
  }));

  // 未解析边：文件级依赖来自 import_relations，不存在「解析失败」的概念，
  // 但存在「外部依赖被刻意排除」的情况，这里如实说明口径。
  const unresolved = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM import_relations
     WHERE repo_id = $1 AND imported_file_id IS NULL`,
    [repoId]
  );

  const warnings: string[] = [];
  const unresolvedEdges: number = unresolved.rows[0]?.n ?? 0;
  if (unresolvedEdges > 0) {
    warnings.push(
      `有 ${unresolvedEdges} 条导入指向仓库外部（第三方包），它们不是仓内节点，未计入影响面。`
    );
  }
  if (truncated) {
    warnings.push(`受影响节点超过 ${MAX_NODES} 个，结果已截断（可降低 maxDepth 后重试）。`);
  }
  if (nodes.length === 0) {
    warnings.push(
      direction === 'dependents'
        ? '没有任何仓内文件依赖该文件（或依赖数据尚未构建 —— 需要重新索引仓库）。'
        : '该文件不依赖任何仓内文件。'
    );
  }

  return {
    target: rootPath,
    maxDepth,
    byDepth: groupByDepth(nodes),
    totalAffected: nodes.length,
    truncated,
    unresolvedEdges,
    warnings,
  };
}

/**
 * 符号级影响面：改动该符号后，哪些符号会被（间接）影响
 *
 * 方向：沿 call_graph 反向遍历（to_chunk_id → from_chunk_id），
 * 即「谁调用了它」的传递闭包。
 *
 * @param pool 数据库连接池
 * @param repoId 仓库 ID
 * @param symbolName 符号名称
 * @param maxDepth 最大跳数
 * @param chunkId 当符号名有歧义时，用调用方显式指定的 chunkId 消歧
 */
export async function analyzeSymbolImpact(
  pool: Pool,
  repoId: number,
  symbolName: string,
  maxDepthRaw: unknown = 3,
  chunkId?: number
): Promise<ImpactReport<AffectedSymbol>> {
  const maxDepth = clampDepth(maxDepthRaw);

  const candidates = await resolveSymbolCandidates(pool, repoId, symbolName);

  if (candidates.length === 0) {
    throw new ImpactError(
      `Repo ${repoId} 中找不到符号 "${symbolName}"。注意：符号名是精确匹配（区分大小写）。`,
      'NOT_FOUND'
    );
  }

  let root: SymbolCandidate;

  if (chunkId !== undefined) {
    const picked = candidates.find((c) => c.chunkId === chunkId);
    if (!picked) {
      throw new ImpactError(
        `chunkId=${chunkId} 不属于符号 "${symbolName}"；候选为：${candidates
          .map((c) => `#${c.chunkId}(${c.filePath}:${c.startLine})`)
          .join(', ')}`,
        'BAD_REQUEST'
      );
    }
    root = picked;
  } else if (candidates.length > 1) {
    // 歧义：不猜
    throw new ImpactError(
      `符号 "${symbolName}" 在该仓库中有 ${candidates.length} 个定义，无法确定指哪一个。` +
        `请用 chunkId 指定：${candidates
          .map((c) => `#${c.chunkId}(${c.filePath}:${c.startLine})`)
          .join(', ')}`,
      'AMBIGUOUS'
    );
  } else {
    root = candidates[0];
  }

  const res = await pool.query(
    `WITH RECURSIVE impacted AS (
       SELECT
         $1::int AS chunk_id,
         0 AS depth,
         ARRAY[$1::int] AS walked
       UNION ALL
       SELECT
         cg.from_chunk_id AS chunk_id,
         i.depth + 1 AS depth,
         i.walked || cg.from_chunk_id AS walked
       FROM impacted i
       JOIN call_graph cg ON cg.to_chunk_id = i.chunk_id
       WHERE i.depth < $2
         AND cg.repo_id = $3
         AND cg.from_chunk_id IS NOT NULL
         AND NOT cg.from_chunk_id = ANY(i.walked)
     )
     SELECT DISTINCT ON (i.chunk_id)
       i.chunk_id,
       i.depth,
       i.walked,
       c.symbol_name,
       c.symbol_type,
       c.line_start,
       f.path AS file_path
     FROM impacted i
     JOIN code_chunks c ON c.id = i.chunk_id
     JOIN files f ON c.file_id = f.id
     WHERE i.depth > 0
     ORDER BY i.chunk_id, i.depth
     LIMIT $4`,
    [root.chunkId, maxDepth, repoId, MAX_NODES + 1]
  );

  const truncated = res.rows.length > MAX_NODES;
  const rows = truncated ? res.rows.slice(0, MAX_NODES) : res.rows;

  // ------------------------------------------------------------------
  // 把调用链上的 chunk id 翻译成可读标签
  // ------------------------------------------------------------------
  // 【修复】原实现是 `walked.map((id) => id === root.chunkId ? symbolLabel(root) : `chunk#${id}`)`，
  // 也就是除根节点外**一律输出 `chunk#442855` 这种裸 id**。
  // 但 pathChain 的唯一用途就是回答「这个符号**为什么**会被波及」——
  // 输出一个数据库主键等于没回答。前端拿到它只能原样显示，
  // 使用者看到的是一串无意义的数字。
  //
  // 现在：把 walked 里出现过的所有 chunk id 一次查出来，映射成
  // 「符号名 (类型 @ 路径:行号)」，与根节点的标签格式保持一致。
  const walkedIds = new Set<number>();
  for (const r of rows) {
    for (const id of r.walked as number[]) walkedIds.add(id);
  }

  const labelById = new Map<number, string>();
  if (walkedIds.size > 0) {
    const labels = await pool.query(
      `SELECT c.id, c.symbol_name, c.symbol_type, c.line_start, f.path
       FROM code_chunks c
       JOIN files f ON c.file_id = f.id
       WHERE c.id = ANY($1)`,
      [[...walkedIds]]
    );
    for (const r of labels.rows) {
      labelById.set(
        r.id,
        `${r.symbol_name} (${r.symbol_type} @ ${r.path}:${r.line_start})`
      );
    }
  }

  // 查不到标签的 id 仍然兜底成 chunk#id（例如 chunk 已被重索引删除），
  // 但这是异常路径，不再是常态。
  const pathChainOf = (walked: number[]): string[] =>
    walked.map((id) => labelById.get(id) ?? `chunk#${id}`);

  const nodes: AffectedSymbol[] = rows.map((r) => ({
    chunkId: r.chunk_id,
    symbolName: r.symbol_name,
    symbolType: r.symbol_type,
    filePath: r.file_path,
    startLine: r.line_start,
    depth: r.depth,
    pathChain: pathChainOf(r.walked as number[]),
  }));

  // ------------------------------------------------------------------
  // 入边的分类清点 —— 这是本报告可信度的核心
  // ------------------------------------------------------------------
  // 一次查询把 to_symbol 指向本符号的边分成四类：
  //   incoming           全部入边
  //   unresolved         to_chunk_id 为空（解析不到定义，无法进图）
  //   artifactSelfLoops  「函数声明行伪自环」——名字出现在自己的声明行上，
  //                      被调用图构建期的正则当成了调用
  //   resolvedElsewhere  to_chunk_id 指向**同名但不同实体**的另一个定义
  //
  // 只有剩下的部分才真正参与遍历。把每一类都如实报出来，
  // 使用者才能判断「0 个受影响」到底是事实还是数据缺陷。
  const edgeStats = await pool.query(
    `SELECT
       COUNT(*)::int AS incoming,
       COUNT(*) FILTER (WHERE cg.to_chunk_id IS NULL)::int AS unresolved,
       COUNT(*) FILTER (
         WHERE cg.from_chunk_id IS NOT NULL
           AND cg.from_chunk_id = cg.to_chunk_id
           AND cg.call_line = caller.line_start
           AND cg.to_symbol = caller.symbol_name
       )::int AS artifact_self_loops,
       COUNT(*) FILTER (
         WHERE cg.to_chunk_id IS NOT NULL
           AND cg.to_chunk_id <> $3
           AND NOT (
             cg.from_chunk_id = cg.to_chunk_id
             AND cg.call_line = caller.line_start
             AND cg.to_symbol = caller.symbol_name
           )
       )::int AS resolved_elsewhere
     FROM call_graph cg
     LEFT JOIN code_chunks caller ON caller.id = cg.from_chunk_id
     WHERE cg.repo_id = $1 AND cg.to_symbol = $2`,
    [repoId, root.symbolName, root.chunkId]
  );

  const incomingEdges: number = edgeStats.rows[0]?.incoming ?? 0;
  const unresolvedEdges: number = edgeStats.rows[0]?.unresolved ?? 0;
  const artifactSelfLoops: number = edgeStats.rows[0]?.artifact_self_loops ?? 0;
  const resolvedElsewhere: number = edgeStats.rows[0]?.resolved_elsewhere ?? 0;

  const warnings: string[] = [];

  if (incomingEdges === 0) {
    warnings.push(
      '该符号没有任何入边 —— 可能是它确实无人调用（死代码候选），' +
        '也可能是调用图尚未构建（需要重新索引仓库）。两种情况需要人工确认。'
    );
  } else {
    const excluded: string[] = [];
    if (unresolvedEdges > 0) {
      excluded.push(`${unresolvedEdges} 条未能解析到定义（to_chunk_id 为空）`);
    }
    if (artifactSelfLoops > 0) {
      excluded.push(`${artifactSelfLoops} 条是函数声明行的伪自环`);
    }
    if (resolvedElsewhere > 0) {
      excluded.push(`${resolvedElsewhere} 条指向同名的另一个定义`);
    }

    if (excluded.length > 0) {
      warnings.push(
        `该符号共有 ${incomingEdges} 个调用点，其中 ${excluded.join('、')}，` +
          '均不计入影响面；真实影响面可能大于本报告。'
      );
    }

    // 【关键修复】区分「确实没有影响面」与「有调用点但一条都用不上」。
    //
    // 旧逻辑只在 `incomingEdges === 0` 时给警告。于是当一个符号的唯一入边
    // 恰好是伪自环（仓库 29 的 login 就是），环保护把它过滤掉后
    // totalAffected=0 而 warnings=[] —— 报告读起来就是
    // 「改动这个函数没有任何影响面」，一个有零提示的假阴性。
    if (nodes.length === 0) {
      warnings.push(
        '入边扣除上述排除项后，影响面为空。这**不**代表「改动没有影响」，' +
          '只代表调用图里没有可用于遍历的真实调用方 —— 请结合上面的排除项判断结论强度。'
      );
    }
  }

  if (truncated) {
    warnings.push(`受影响节点超过 ${MAX_NODES} 个，结果已截断（可降低 maxDepth 后重试）。`);
  }

  return {
    target: symbolLabel(root),
    maxDepth,
    byDepth: groupByDepth(nodes),
    totalAffected: nodes.length,
    truncated,
    unresolvedEdges,
    warnings,
  };
}

function symbolLabel(c: SymbolCandidate): string {
  return `${c.symbolName} (${c.symbolType} @ ${c.filePath}:${c.startLine})`;
}

/** 按 depth 分组，depth 升序排列 */
function groupByDepth<T extends { depth: number }>(nodes: T[]): Array<{ depth: number; nodes: T[] }> {
  const byDepth = new Map<number, T[]>();
  for (const n of nodes) {
    const bucket = byDepth.get(n.depth);
    if (bucket) bucket.push(n);
    else byDepth.set(n.depth, [n]);
  }
  return [...byDepth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([depth, group]) => ({ depth, nodes: group }));
}
