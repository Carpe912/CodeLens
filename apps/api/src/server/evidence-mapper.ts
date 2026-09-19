/**
 * 检索证据的统一出网形状（显式白名单映射）
 *
 * ============================================
 * 为什么必须白名单，不能直接返回数据库行
 * ============================================
 * `searchByKeyword()` / `searchByEmbedding()` 内部都是 `SELECT c.*, f.path AS file_path`
 * 然后**直接 `return rows`**。如果路由把 rows 原样序列化出网，会同时发生三类问题：
 *
 * 1. **`embedding` 泄漏**：1536 维浮点数组，没有任何消费方，纯撑大报文。
 *    实测一条中文问句 10 条命中 = **198 KB**，而同量级的 URL 查询只有 **16.7 KB**（差 12 倍）。
 * 2. **字段名不一致**：原始行给的是 `similarity`，而 `MultiStrategySearch` / URL 分支给的是
 *    `score`。前端 `RepoPage` 渲染相似度徽标读 `hit.similarity`，代码块读 `hit.code_text`，
 *    而 vscode 扩展（`views/searchView.ts`、`views/qaWebview.ts`）读的是 `SearchResult.content`。
 *    原样出网时 `content` 字段根本不存在 → **扩展渲染出空白代码块**。
 * 3. **内部列外泄**：`created_at` / `metadata` / `node_type` / `parent_chunk_id` / `repo_id`。
 *
 * ⚠️ 这个白名单最初只写在 `server/routes/ask.ts` 里（`/ask` 的四个分支），
 * `/search` 的默认分支一直是原样出网 —— **同一个 bug 只修了一半**。
 * 现已提取到此处供两处共用；新增返回原始行的分支时，**必须走这个函数**。
 *
 * 注意 `similarity` 必须保留：web 前端用它渲染相似度百分比。
 */

/** 统一后的证据形状（四条分支共用） */
export interface Evidence {
  id: unknown;
  file_id: number;
  file_path: string;
  line_start: number;
  line_end: number;
  content: string;
  code_text: string;
  symbol_name: string;
  symbol_type: string;
  score: number;
  similarity?: number;
}

/**
 * 原始 `code_chunks` 行 → 统一证据形状。
 *
 * 同时补上 `score` 与 `content`：前者让所有分支的分值口径一致，
 * 后者是 vscode 扩展的必填字段。
 */
export function mapRawChunksToEvidence(rows: any[]): Evidence[] {
  return rows.map((row) => ({
    id: row.id,
    file_id: row.file_id ?? 0,
    file_path: row.file_path || '',
    line_start: row.line_start || 0,
    line_end: row.line_end || 0,
    content: row.code_text || '',
    code_text: row.code_text || '',
    symbol_name: row.symbol_name || '',
    symbol_type: row.symbol_type || 'unknown',
    // 原始行的相关度列名是 similarity；关键词分支可能只给 score
    score: row.similarity ?? row.score ?? 0,
    similarity: row.similarity ?? row.score ?? 0,
  }));
}
