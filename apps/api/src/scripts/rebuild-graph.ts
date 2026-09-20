#!/usr/bin/env node

/**
 * Rebuild Graph Script — 只重建「关系图」，不碰向量
 *
 * ============================================
 * 为什么需要它
 * ============================================
 * `call_graph` / `import_relations` / `file_dependencies` 这三张表的数据
 * 全部来自索引流程的「关系构建」阶段，与 embedding 无关。
 * 但索引流程是一个整体：`EnhancedIndexer.indexFile` 在构建关系之后**必然**会调用
 * `generateEmbeddings`。于是当只想修图数据时，代价是重新生成整个仓库的向量
 * （真实花钱、真实耗时）。
 *
 * 本脚本只做「AST 分析 → 构建关系 → 物化文件依赖边」三步，
 * **完全不触碰 embedding**。用于：
 *   - schema 修复后回填历史数据（例如 004 迁移补齐 call_graph 列）
 *   - 关系构建逻辑更新后重建，而不必重新嵌入
 *
 * ============================================
 * 与 rebuild-references 的区别
 * ============================================
 * `rebuild-references` 只重建 constant_references ——
 * 它给 `buildRelationships` 传的是 `imports: []` / `functions: []` 的空 AST 结果，
 * 因此 **import_relations 与 call_graph 完全不会被重建**。
 * 想重建依赖图必须重新做 AST 分析，这就是本脚本存在的原因。
 *
 * ============================================
 * 用法
 * ============================================
 *   pnpm --filter @codelens/api rebuild-graph <repoId>
 *   pnpm --filter @codelens/api rebuild-graph 1
 *
 * 退出码：仓库不存在 = 1；失败文件数 > 阈值 = 1
 */

// 与 migrate.ts / verify-graph.ts 保持一致：先加载 .env 再读环境变量。
// dotenv 不覆盖已存在的环境变量，因此：
//   - 服务器上用 `node --env-file-if-exists=.env.production` 启动时，
//     命令行注入的值优先，.env 只会补空缺；
//   - 本地 `pnpm rebuild-graph` 时 cwd 是 apps/api，读取 apps/api/.env。
// import 必须排在其余 import 之前（部分模块会在加载期读环境变量）。
import 'dotenv/config';
import { Pool } from 'pg';
import { ASTAnalyzer } from '../indexing/languages/typescript/entities.js';
import { RelationshipBuilder } from '../indexing/relationship-builder.js';
import { describeError, describeErrorBrief } from '../utils/errors.js';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'codelens',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

/** 失败文件占比超过这个值就判定为整体失败（避免「跑完了但没数据」被当成成功） */
const FAILURE_RATIO_LIMIT = 0.05;

async function countGraphTables(repoId: number): Promise<{
  imports: number;
  callEdges: number;
  unresolvedCallEdges: number;
  fileEdges: number;
}> {
  const res = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM import_relations WHERE repo_id = $1) AS imports,
       (SELECT COUNT(*)::int FROM call_graph WHERE repo_id = $1) AS call_edges,
       (SELECT COUNT(*)::int FROM call_graph WHERE repo_id = $1 AND to_chunk_id IS NULL) AS unresolved,
       (SELECT COUNT(*)::int FROM file_dependencies WHERE repo_id = $1) AS file_edges`,
    [repoId]
  );
  const r = res.rows[0];
  return {
    imports: r.imports,
    callEdges: r.call_edges,
    unresolvedCallEdges: r.unresolved,
    fileEdges: r.file_edges,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error('Usage: pnpm --filter @codelens/api rebuild-graph <repoId>');
    console.error('Example: pnpm --filter @codelens/api rebuild-graph 1');
    process.exit(1);
  }

  const repoId = parseInt(args[0]);
  if (!Number.isInteger(repoId) || repoId <= 0) {
    console.error('Error: repoId must be a positive integer');
    process.exit(1);
  }

  console.log('='.repeat(64));
  console.log('Rebuild Graph (relations only, no embeddings)');
  console.log('='.repeat(64));
  // 显式打印连接目标：运维排查时第一个要确认的就是「连到哪去了」
  console.log(
    `DB: ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '5432'}/` +
      `${process.env.DB_NAME || 'codelens'} as ${process.env.DB_USER || 'postgres'}`
  );
  console.log(`Repository ID: ${repoId}`);
  console.log('');

  const repoResult = await pool.query('SELECT id, name, source FROM repos WHERE id = $1', [repoId]);
  if (repoResult.rows.length === 0) {
    console.error(`Error: Repository with ID ${repoId} not found`);
    await pool.end();
    process.exit(1);
  }
  console.log(`Repository: ${repoResult.rows[0].name} (${repoResult.rows[0].source})`);
  console.log('');

  const before = await countGraphTables(repoId);
  console.log('--- 重建前 ---');
  console.log(`  import_relations  : ${before.imports}`);
  console.log(`  call_graph 边     : ${before.callEdges}（其中未解析 ${before.unresolvedCallEdges}）`);
  console.log(`  file_dependencies : ${before.fileEdges}`);
  console.log('');

  const filesResult = await pool.query(
    'SELECT id, path, content FROM files WHERE repo_id = $1 ORDER BY id',
    [repoId]
  );
  const files = filesResult.rows;

  if (files.length === 0) {
    console.error('Error: 该仓库没有任何文件记录，请先执行索引。');
    await pool.end();
    process.exit(1);
  }

  console.log(`共 ${files.length} 个文件，开始重建关系…`);
  console.log('');

  // 清空该仓库的派生关系，保证结果不是「新数据叠加在旧数据之上」。
  // 之所以可以安全清空 import_relations：buildRelationships 内部先建导入关系、
  // 再建调用图，而解析被调用函数时只依赖**当前文件自己**的导入关系。
  await pool.query('DELETE FROM file_dependencies WHERE repo_id = $1', [repoId]);
  await pool.query('DELETE FROM call_graph WHERE repo_id = $1', [repoId]);
  await pool.query('DELETE FROM import_relations WHERE repo_id = $1', [repoId]);

  const astAnalyzer = new ASTAnalyzer();

  // ⚠️ 建跨文件符号表 —— 这个脚本此前**一直漏了这一步**。
  //
  // `ASTAnalyzer` 的符号表是「整仓视野」的：没有它，`ApiPaths.users.list()` /
  // `${API_PREFIX}/users` 这类表达式只能抽出 `${name}` 占位符。而本脚本会经
  // `RelationshipBuilder.buildRelationships` **写 url_patterns / url_usages** ——
  // 于是漏调它的后果是：重建一次图，就污染一次 URL 索引，而且**没有任何报错**。
  //
  // 这正是把生命周期写进 `RepoScopedParser.beginRepo/endRepo` 契约的原因：
  // 漏调应该是类型层面可见的，而不是靠人记得。
  astAnalyzer.registerRepoFiles(files.map((f) => ({ path: f.path, content: f.content })));

  const relationshipBuilder = new RelationshipBuilder(pool);

  let processed = 0;
  let failed = 0;
  let importsCreated = 0;
  let callEdgesCreated = 0;
  const failedFiles: Array<{ path: string; error: string }> = [];

  for (const file of files) {
    try {
      const astResult = await astAnalyzer.analyzeFile(file.path, file.content);
      const result = await relationshipBuilder.buildRelationships(
        repoId,
        file.id,
        file.path,
        astResult
      );
      importsCreated += result.importsCreated;
      callEdgesCreated += result.callGraphEdgesCreated;
    } catch (error: any) {
      // 单个文件失败不中断整体，但会被计数并在结尾汇报 ——
      // 「静默吞掉」正是这个项目此前坏账的成因，不能再犯。
      failed++;
      // 用 describeErrorBrief 而不是 `error.message ?? error`：
      // 后者在 message 为空字符串时（AggregateError）仍会输出空，列表里就只剩文件名。
      failedFiles.push({ path: file.path, error: describeErrorBrief(error) });
    }

    processed++;
    if (processed % 50 === 0) {
      console.log(`  进度 ${processed}/${files.length} · 失败 ${failed}`);
    }
  }

  // 释放整仓符号表（占着全仓源码，不释放会一直留到进程退出）
  astAnalyzer.releaseRepoFiles();

  console.log('');
  console.log(`关系构建完成：处理 ${processed} 个文件，失败 ${failed} 个`);

  console.log('');
  console.log('物化 file_dependencies（整仓聚合）…');
  const fileEdges = await relationshipBuilder.rebuildFileDependencies(repoId);
  console.log(`  写入 ${fileEdges} 条文件依赖边`);

  const after = await countGraphTables(repoId);

  console.log('');
  console.log('='.repeat(64));
  console.log('--- 重建后 ---');
  console.log(`  import_relations  : ${before.imports} → ${after.imports}`);
  console.log(
    `  call_graph 边     : ${before.callEdges} → ${after.callEdges}` +
      `（其中未解析 ${after.unresolvedCallEdges}）`
  );
  console.log(`  file_dependencies : ${before.fileEdges} → ${after.fileEdges}`);
  console.log('');

  if (after.unresolvedCallEdges > 0 && after.callEdges > 0) {
    const pct = ((after.unresolvedCallEdges / after.callEdges) * 100).toFixed(1);
    console.log(
      `  ⚠ ${after.unresolvedCallEdges}/${after.callEdges}（${pct}%）条调用边未能解析到定义。`
    );
    console.log('    这些边不会进入影响面分析，接口会通过 unresolvedEdges 如实告知。');
    console.log('    常见原因：调用的是第三方库方法、动态属性、或同名歧义。');
    console.log('');
  }

  if (failed > 0) {
    console.log(`  ⚠ ${failed} 个文件处理失败，前 10 个：`);
    for (const f of failedFiles.slice(0, 10)) {
      console.log(`    - ${f.path}: ${f.error}`);
    }
    console.log('');
  }

  const failureRatio = failed / processed;
  const ok = failureRatio <= FAILURE_RATIO_LIMIT;
  console.log('='.repeat(64));
  console.log(ok ? '完成' : `失败：${failed}/${processed} 个文件出错，超过阈值`);
  console.log('='.repeat(64));

  await pool.end();
  process.exit(ok ? 0 : 1);
}

main().catch(async (error) => {
  console.error('');
  console.error('Rebuild Graph Failed!');
  // error.message 对 AggregateError（数据库连不上时最常见）是空串，
  // 用 describeError 展开底层 errors[]，避免只留下一块空白。
  console.error(describeError(error));
  await pool.end();
  process.exit(1);
});
