/**
 * 影响面分析 路由
 *
 * 目标：把已经索引好的关系数据（file_dependencies / call_graph）真正暴露成可用接口 ——
 * 这两个能力此前只存在于代码里，没有任何入口。
 *
 * 两个端点：
 * - GET /impact/file    改文件会波及什么
 * - GET /impact/symbol  改符号会波及什么
 *
 * 设计取舍：
 * - 不做静默降级。关系数据缺失或调用边未解析时，响应里带 warnings 与
 *   unresolvedEdges，明确告诉调用方「这个结论有多可靠」，而不是返回一个
 *   看起来完整、实际不完整的结果。
 * - 符号名有歧义时返回 409 并列出候选，要求用 chunkId 消歧，绝不猜。
 */

import type { FastifyInstance } from 'fastify';
import {
  pool, analyzeFileImpact, analyzeSymbolImpact, resolveSymbolCandidates, ImpactError, MAX_DEPTH_LIMIT,
  buildEvidenceCallTree, buildSymbolCallTree, buildQueryCallTree, getRepo,
} from '../deps.js';

export async function analysisRoutes(app: FastifyInstance): Promise<void> {

/**
 * 文件级影响面
 * GET /impact/file?repoId=1&path=src/utils/a.ts&maxDepth=3&direction=dependents
 *
 * @query repoId     仓库 ID（必需）
 * @query path       仓库内相对路径（必需）
 * @query maxDepth   最大跳数，默认 3，上限 10
 * @query direction  dependents（默认，谁依赖我＝改动影响面）| dependencies（我依赖谁）
 *
 * @returns ImpactReport：按 depth 分组的受影响文件 + 可信度说明
 * @throws 400 缺少参数 / 参数非法
 * @throws 404 文件不存在
 */
app.get<{
  Querystring: { repoId: string; path: string; maxDepth?: string; direction?: string };
}>('/impact/file', async (request, reply) => {
  const { repoId, path, maxDepth, direction } = request.query;

  if (!repoId || !path) {
    return reply.code(400).send({ error: 'Missing repoId or path' });
  }

  const repoIdNum = Number(repoId);
  if (!Number.isInteger(repoIdNum) || repoIdNum <= 0) {
    return reply.code(400).send({ error: 'repoId must be a positive integer' });
  }

  const dir = direction ?? 'dependents';
  if (dir !== 'dependents' && dir !== 'dependencies') {
    return reply.code(400).send({ error: "direction must be 'dependents' or 'dependencies'" });
  }

  try {
    const report = await analyzeFileImpact(pool, repoIdNum, path, maxDepth, dir);
    return { direction: dir, ...report };
  } catch (error) {
    if (error instanceof ImpactError) {
      return reply.code(error.code === 'NOT_FOUND' ? 404 : 400).send({ error: error.message });
    }
    console.error('Impact (file) error:', error);
    return reply.code(500).send({ error: 'Failed to analyze file impact' });
  }
});

/**
 * 符号级影响面
 * GET /impact/symbol?repoId=1&symbolName=parseFile&maxDepth=3
 *
 * @query repoId      仓库 ID（必需）
 * @query symbolName  符号名（必需，精确匹配、区分大小写）
 * @query maxDepth    最大跳数，默认 3，上限 10
 * @query chunkId     同名符号有多个定义时用于消歧
 *
 * @returns ImpactReport：按 depth 分组的受影响符号 + 可信度说明
 * @throws 400 缺少参数 / chunkId 不匹配
 * @throws 404 符号不存在
 * @throws 409 符号名有歧义，需用 chunkId 指定
 */
app.get<{
  Querystring: { repoId: string; symbolName: string; maxDepth?: string; chunkId?: string };
}>('/impact/symbol', async (request, reply) => {
  const { repoId, symbolName, maxDepth, chunkId } = request.query;

  if (!repoId || !symbolName) {
    return reply.code(400).send({ error: 'Missing repoId or symbolName' });
  }

  const repoIdNum = Number(repoId);
  if (!Number.isInteger(repoIdNum) || repoIdNum <= 0) {
    return reply.code(400).send({ error: 'repoId must be a positive integer' });
  }

  let chunkIdNum: number | undefined;
  if (chunkId !== undefined) {
    chunkIdNum = Number(chunkId);
    if (!Number.isInteger(chunkIdNum) || chunkIdNum <= 0) {
      return reply.code(400).send({ error: 'chunkId must be a positive integer' });
    }
  }

  try {
    const report = await analyzeSymbolImpact(pool, repoIdNum, symbolName, maxDepth, chunkIdNum);
    return report;
  } catch (error) {
    if (error instanceof ImpactError) {
      const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'AMBIGUOUS' ? 409 : 400;

      // 歧义时把候选**结构化**返回，而不是只给一段人读的文本。
      //
      // 理由：这个错不是终点，而是「需要用户选一个」的中间态。若只返回字符串，
      // 前端就得去正则解析错误文案才能渲染出可选按钮 —— 一旦文案改一个字，
      // 消歧功能就会静默失效，且不报错。把候选作为字段返回，让契约承担这件事。
      if (error.code === 'AMBIGUOUS') {
        const candidates = await resolveSymbolCandidates(pool, repoIdNum, symbolName);
        return reply.code(status).send({
          error: error.message,
          code: error.code,
          symbolName,
          candidates,
        });
      }

      return reply.code(status).send({ error: error.message, code: error.code });
    }
    console.error('Impact (symbol) error:', error);
    return reply.code(500).send({ error: 'Failed to analyze symbol impact' });
  }
});

/**
 * 能力自述
 * GET /impact
 *
 * 说明这组接口依赖什么数据、什么情况下结论会不完整。
 * 存在的意义：让「数据没构建」这件事可被发现，而不是表现为「影响面为 0」。
 */
app.get('/impact', async () => {
  const counts = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM call_graph) AS call_graph_edges,
       (SELECT COUNT(*)::int FROM call_graph WHERE to_chunk_id IS NULL) AS unresolved_call_edges,
       (SELECT COUNT(*)::int FROM file_dependencies) AS file_dependency_edges,
       (SELECT COUNT(*)::int FROM import_relations WHERE imported_file_id IS NOT NULL) AS internal_import_edges`
  );

  const c = counts.rows[0];

  const warnings: string[] = [];
  if (c.call_graph_edges === 0) {
    warnings.push('call_graph 为空 → /impact/symbol 会返回「无人调用」。需要重新索引仓库。');
  }
  if (c.file_dependency_edges === 0 && c.internal_import_edges > 0) {
    warnings.push(
      'file_dependencies 为空但 import_relations 有数据 → 依赖边尚未物化。' +
        '重新索引仓库（会调用 rebuildFileDependencies），或直接调用该方法。'
    );
  }
  if (c.file_dependency_edges === 0 && c.internal_import_edges === 0) {
    warnings.push('仓库尚未索引，或该仓库没有任何仓内导入关系。');
  }

  return {
    endpoints: {
      'GET /impact/file': '文件级影响面（基于 file_dependencies 的传递闭包）',
      'GET /impact/symbol': '符号级影响面（基于 call_graph 的实体级传递闭包）',
      'POST /call-tree': '证据调用树（把 /ask 的 evidence 按 call_graph 长成可展开的调用链）',
      'POST /symbol-call-tree': '符号调用树（以单个符号为根的双向调用链）',
      'POST /query-call-tree': '提问语义 → 调用关系（从原始提问解析根符号与方向）',
    },
    maxDepthLimit: MAX_DEPTH_LIMIT,
    dataSources: {
      callGraphEdges: c.call_graph_edges,
      unresolvedCallEdges: c.unresolved_call_edges,
      fileDependencyEdges: c.file_dependency_edges,
      internalImportEdges: c.internal_import_edges,
    },
    warnings,
  };
});

/**
 * 证据调用树
 * POST /call-tree
 *
 * 把一批检索证据（`/ask` 返回的 `evidence`）按 `call_graph` 长成一棵调用树，
 * 供前端把「平铺的证据列表」渲染成可展开的调用链。
 *
 * @body repoId      仓库 ID（必需）
 * @body symbols     证据符号数组（必需），每项 `{ symbol, filePath? }`
 *                   —— 只传这两个字段即可：证据里的 `id` 来自 functions /
 *                   string_constants 表，不是 code_chunks 主键，传了也没用。
 * @body maxDepth    展开深度，默认 2，上限 4
 *
 * @returns CallTreeResult：roots（以每条证据为根的森林）+ stats + warnings
 * @throws 400 参数缺失或非法 / symbols 为空
 * @throws 404 仓库不存在
 *
 * 与 /impact/* 的口径差异：那边「符号名歧义就 409」，因为回答的是权威结论；
 * 这边是可视化辅助，歧义节点**照常展开但如实标记**（见模块头部说明）。
 */
app.post<{
  Body: {
    repoId?: number;
    symbols?: Array<{ symbol?: string; filePath?: string }>;
    maxDepth?: number;
  };
}>('/call-tree', async (request, reply) => {
  const { repoId, symbols, maxDepth } = request.body ?? {};

  if (!repoId || !Array.isArray(symbols)) {
    return reply.code(400).send({ error: 'Missing repoId or symbols' });
  }
  if (!Number.isInteger(repoId) || repoId <= 0) {
    return reply.code(400).send({ error: 'repoId must be a positive integer' });
  }

  const inputs = symbols
    .filter((s) => s && typeof s.symbol === 'string' && s.symbol.trim() !== '')
    .map((s) => ({ symbol: String(s.symbol).trim(), filePath: s.filePath ? String(s.filePath) : undefined }));

  if (inputs.length === 0) {
    return reply.code(400).send({ error: 'symbols must contain at least one non-empty symbol' });
  }

  const repo = await getRepo(repoId);
  if (!repo) {
    return reply.code(404).send({ error: `Repository with id ${repoId} not found` });
  }

  try {
    const result = await buildEvidenceCallTree(pool, repoId, inputs, maxDepth);
    return { repoId, ...result };
  } catch (error) {
    console.error('Evidence call tree error:', error);
    return reply.code(500).send({ error: 'Failed to build evidence call tree' });
  }
});

/**
 * 符号调用树（双向）
 * POST /symbol-call-tree
 *
 * 以单个符号为根，向上（callers：谁调用了它）+ 向下（callees：它调用了谁）
 * 双向传递展开成可展开的树。每个节点带 filePath / lineStart / codeText，
 * 供前端「点击节点查看代码与文件地址」。
 *
 * @body repoId       仓库 ID（必需）
 * @body symbolName   符号名（必需，精确匹配、区分大小写）
 * @body chunkId      同名多定义时消歧（可选）
 * @body maxDepth     单方向展开深度，默认 2，上限 4
 * @body direction    'both'（默认）| 'callers' | 'callees'
 *
 * @returns SymbolCallTreeResult：root + callers + callees + stats + rootCandidates + warnings
 * @throws 400 参数缺失或非法
 * @throws 404 仓库不存在
 */
app.post<{
  Body: {
    repoId?: number;
    symbolName?: string;
    chunkId?: number;
    maxDepth?: number;
    direction?: 'both' | 'callers' | 'callees';
  };
}>('/symbol-call-tree', async (request, reply) => {
  const { repoId, symbolName, chunkId, maxDepth, direction } = request.body ?? {};

  if (!repoId || !symbolName || typeof symbolName !== 'string' || symbolName.trim() === '') {
    return reply.code(400).send({ error: 'Missing repoId or symbolName' });
  }
  if (!Number.isInteger(repoId) || repoId <= 0) {
    return reply.code(400).send({ error: 'repoId must be a positive integer' });
  }
  if (chunkId !== undefined && (!Number.isInteger(chunkId) || chunkId <= 0)) {
    return reply.code(400).send({ error: 'chunkId must be a positive integer' });
  }
  if (direction !== undefined && !['both', 'callers', 'callees'].includes(direction)) {
    return reply.code(400).send({ error: "direction must be 'both', 'callers' or 'callees'" });
  }

  const repo = await getRepo(repoId);
  if (!repo) {
    return reply.code(404).send({ error: `Repository with id ${repoId} not found` });
  }

  try {
    const result = await buildSymbolCallTree(
      pool,
      repoId,
      symbolName.trim(),
      chunkId,
      maxDepth,
      direction
    );
    return { repoId, ...result };
  } catch (error) {
    console.error('Symbol call tree error:', error);
    return reply.code(500).send({ error: 'Failed to build symbol call tree' });
  }
});

/**
 * 提问语义 → 调用关系
 * POST /query-call-tree
 *
 * 从**用户的原始提问**里解析出「根符号 + 调用方向」，直接产出调用树。
 * 供问答结果页把「平铺的证据列表」替换成「调用关系」视图。
 *
 * 例：
 *  - 「https://host/rest/account/getUserAuthority 这个接口在哪里被调用」
 *    → 根 = getUserAuthority（URL 末段），方向 = callers
 *  - 「batchProcessOrders 调用了哪些方法」
 *    → 根 = batchProcessOrders（提问里的标识符），方向 = callees
 *
 * @body repoId      仓库 ID（必需）
 * @body query       用户原始提问（必需）
 * @body candidates  可选：本次问答检索到的证据符号，用于提问里没有符号时定根
 * @body maxDepth    展开深度，默认 2，上限 4
 *
 * @returns QueryCallTreeResult：intent（方向/依据/token）+ root + tree + alternatives + warnings
 *   root 为 null 时 intent.level='file'，调用方应降级展示（例如回落到证据列表）。
 * @throws 400 参数缺失或非法
 * @throws 404 仓库不存在
 */
app.post<{
  Body: {
    repoId?: number;
    query?: string;
    candidates?: Array<{ symbol?: string; filePath?: string }>;
    maxDepth?: number;
    direction?: 'both' | 'callers' | 'callees';
  };
}>('/query-call-tree', async (request, reply) => {
  const { repoId, query, candidates, maxDepth, direction } = request.body ?? {};

  if (!repoId || !query || typeof query !== 'string' || query.trim() === '') {
    return reply.code(400).send({ error: 'Missing repoId or query' });
  }
  if (!Number.isInteger(repoId) || repoId <= 0) {
    return reply.code(400).send({ error: 'repoId must be a positive integer' });
  }
  if (direction !== undefined && !['both', 'callers', 'callees'].includes(direction)) {
    return reply.code(400).send({ error: "direction must be 'both', 'callers' or 'callees'" });
  }

  const repo = await getRepo(repoId);
  if (!repo) {
    return reply.code(404).send({ error: `Repository with id ${repoId} not found` });
  }

  try {
    const result = await buildQueryCallTree(
      pool,
      repoId,
      query.trim(),
      Array.isArray(candidates) ? candidates : [],
      maxDepth,
      direction
    );
    return result;
  } catch (error) {
    console.error('Query call tree error:', error);
    return reply.code(500).send({ error: 'Failed to build query call tree' });
  }
});

}
