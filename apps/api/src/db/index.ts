/**
 * 数据库连接和操作模块
 *
 * 本模块负责：
 * 1. 管理 PostgreSQL 连接池
 * 2. 初始化数据库表结构和索引
 * 3. 提供所有数据库操作的封装函数
 * 4. 实现性能优化的删除和查询操作
 */

import pg from 'pg';
// 只作类型引用（`import type` 会被编译期擦除）⇒ 不会引入 db → indexing 的运行时环
import type { IncrementalReport } from '../indexing/incremental-report.js';

const { Pool } = pg;

/**
 * PostgreSQL 连接池
 * 使用连接池可以复用数据库连接，提高性能
 */
export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'codelens',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

/**
 * 处理连接池错误
 * 如果连接池出现意外错误，记录日志但不退出进程
 * 这样可以避免单个查询错误导致整个服务崩溃
 */
pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
  // 不要调用 process.exit(1)，因为这会导致连接池被关闭
  // 后续的索引任务将无法使用数据库连接
});

/**
 * 初始化数据库
 *
 * 创建所有必需的表、索引和扩展
 * 这个函数在应用启动时调用，确保数据库结构正确
 *
 * 表结构说明：
 * - repos: 存储代码仓库信息
 * - files: 存储文件内容和元数据
 * - code_chunks: 存储代码片段（函数、类等）及其向量
 * - call_graph: 存储函数调用关系
 * - questions: 存储用户提问和答案
 * - question_feedback: 存储问答反馈
 */
export async function initDatabase() {
  try {
    // 启用 pgvector 扩展，用于向量相似度搜索
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS vector;
    `);

    /**
     * repos 表：存储代码仓库信息
     * - id: 主键
     * - name: 仓库名称
     * - source: 来源类型（gitlab 或 zip）
     * - url: GitLab 仓库 URL
     * - gitlab_token: GitLab 访问令牌（用于私有仓库）
     * - status: 索引状态（ready/indexing/failed）
     * - description: 仓库描述
     * - index_progress: 索引进度（JSONB 格式，包含 total、processed、startTime）
     * - created_at: 创建时间
     * - gitlab_url: 规范化的 GitLab URL（用于多分支索引）
     * - branch: 分支名称
     * - is_base_branch: 是否为基础分支（默认分支）
     * - parent_repo_id: 父仓库 ID（指向基础分支）
     * - default_branch: GitLab 默认分支名称
     */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS repos (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        url TEXT,
        gitlab_token TEXT,
        status TEXT NOT NULL,
        description TEXT,
        index_progress JSONB DEFAULT '{"total": 0, "processed": 0, "startTime": null}'::jsonb,
        created_at TIMESTAMP DEFAULT NOW(),
        gitlab_url TEXT,
        branch TEXT DEFAULT 'main',
        is_base_branch BOOLEAN DEFAULT false,
        parent_repo_id INTEGER REFERENCES repos(id),
        default_branch TEXT
      );
    `);

    /**
     * repos 表：补齐后加的列
     *
     * 【为什么必须显式补】上面的 `CREATE TABLE IF NOT EXISTS` 在**表已存在**时
     * 是彻底的 no-op —— 它既不会建表，也不会把后来新增的列补进去。
     * 而 gitlab_url / branch / is_base_branch / parent_repo_id / default_branch
     * 都是后加的列，于是只要库里存在旧版 repos 表，这些列就**永远缺失**。
     *
     * 【真实事故 2026-09-18】缺失导致下面的
     *   `CREATE INDEX ... ON repos(gitlab_url)`
     * 抛 42703（未定义列），而该处 catch 只忽略 23505，
     * 异常一路冒到 initDatabase 调用方 → **整个服务起不来**
     * （PM2 显示 online、端口不监听，表现为崩溃重启循环，排查成本很高）。
     *
     * 同一天 in 004 迁移里修过 call_graph 缺 repo_id / to_chunk_id 的同类问题。
     * 教训：CREATE TABLE IF NOT EXISTS ≠ 列一定存在。凡是代码假定存在的列，
     * 都必须在启动时用 ADD COLUMN IF NOT EXISTS 兜底。
     *
     * 用 `pnpm --filter @codelens/api check:live-schema` 可扫描这类漂移。
     */
    await pool.query(`
      ALTER TABLE repos
        ADD COLUMN IF NOT EXISTS gitlab_url TEXT,
        ADD COLUMN IF NOT EXISTS branch TEXT DEFAULT 'main',
        ADD COLUMN IF NOT EXISTS is_base_branch BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS parent_repo_id INTEGER REFERENCES repos(id),
        ADD COLUMN IF NOT EXISTS default_branch TEXT,
        -- 最近一次增量索引的变更报告（见 indexing/incremental-report.ts）。
        -- 存 JSONB 而不是建表：报告是「一次操作的结果快照」，只按 repo 取最新一份，
        -- 没有独立查询需求；建表会多一张只有读写、没有关联的表。
        ADD COLUMN IF NOT EXISTS last_incremental JSONB;
    `);

    /**
     * files 表：存储文件信息
     * - id: 主键
     * - repo_id: 所属仓库 ID（外键，级联删除）
     * - path: 文件路径（相对于仓库根目录）
     * - language: 编程语言（typescript/javascript/vue 等）
     * - content: 文件完整内容
     * - created_at: 创建时间
     * - entities_indexed_at: **第二遍（实体层）完成时间**。NULL = 尚未完成。
     *   用来让第二遍也能「断点续跑」——在它之前，第二遍挂掉只能整仓重来。
     *   详见 migrations/006_add_files_entities_indexed_at.sql。
     */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS files (
        id SERIAL PRIMARY KEY,
        repo_id INTEGER REFERENCES repos(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        language TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        entities_indexed_at TIMESTAMPTZ
      );
    `);

    // 老库补列（建表语句里的新列只对「从零建库」生效）
    await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS entities_indexed_at TIMESTAMPTZ`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_files_pending_entities
         ON files (repo_id) WHERE entities_indexed_at IS NULL`
    );

    /**
     * code_chunks 表：存储代码片段（核心表）
     * - id: 主键
     * - file_id: 所属文件 ID（外键，级联删除）
     * - symbol_name: 符号名称（函数名、类名等）
     * - symbol_type: 符号类型（function/class/method/variable 等）
     * - line_start: 起始行号
     * - line_end: 结束行号
     * - code_text: 代码文本内容
     * - embedding: 向量表示（1536 维，用于语义搜索）
     * - created_at: 创建时间
     *
     * 注意：embedding 使用 pgvector 的 vector 类型，支持高效的向量相似度搜索
     */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS code_chunks (
        id SERIAL PRIMARY KEY,
        file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
        symbol_name TEXT NOT NULL,
        symbol_type TEXT NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        code_text TEXT NOT NULL,
        embedding vector(1536),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    /**
     * call_graph 表：存储函数调用关系
     * - id: 主键
     * - repo_id: 所属仓库 ID（外键，级联删除）
     * - from_chunk_id: 调用者代码块 ID（外键，级联删除）
     * - to_chunk_id: 被调用者代码块 ID（可为 NULL —— 表示调用名未能解析到具体定义）
     * - to_symbol: 被调用的符号名称（原始文本，即使 to_chunk_id 为 NULL 也保留）
     * - created_at: 创建时间
     *
     * 用途：构建函数调用图，支持调用链分析
     *
     * 【为什么 to_symbol 和 to_chunk_id 要同时存在】
     * to_symbol 是「名字」，to_chunk_id 是「实体」。同名符号在不同文件里很常见
     * （如多个文件都定义 `index`、`handler`），只靠名字做图遍历会产生跨文件歧义，
     * 并且 `LEFT JOIN code_chunks ON symbol_name = to_symbol` 会在同名多定义时
     * 把结果行数放大。写入时由 resolveCalledFunction 尽力解析（先本文件、再被导入文件），
     * 解析成功即填 to_chunk_id；解析失败保留 to_symbol 并把 to_chunk_id 置 NULL，
     * 由读取方显式区分「已解析」与「未解析」，而不是假装图是完整的。
     */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS call_graph (
        id SERIAL PRIMARY KEY,
        repo_id INTEGER REFERENCES repos(id) ON DELETE CASCADE,
        from_chunk_id INTEGER REFERENCES code_chunks(id) ON DELETE CASCADE,
        to_chunk_id INTEGER REFERENCES code_chunks(id) ON DELETE SET NULL,
        to_symbol TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    /**
     * questions 表：存储用户提问和 AI 回答
     * - id: 主键
     * - repo_id: 所属仓库 ID（外键，级联删除）
     * - query: 用户的问题
     * - answer: AI 生成的答案
     * - evidence_ids: 证据代码块 ID 数组（用于追溯答案来源）
     * - created_at: 创建时间
     */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id SERIAL PRIMARY KEY,
        repo_id INTEGER REFERENCES repos(id) ON DELETE CASCADE,
        query TEXT NOT NULL,
        answer TEXT,
        evidence_ids INTEGER[],
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    /**
     * question_feedback 表：存储用户对问答的反馈
     * - id: 主键
     * - question_id: 关联的问题 ID（外键，级联删除）
     * - feedback_text: 反馈文本内容
     * - is_helpful: 是否有帮助（true/false）
     * - created_at: 创建时间
     *
     * 用途：收集用户反馈，用于改进问答质量
     */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS question_feedback (
        id SERIAL PRIMARY KEY,
        question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
        feedback_text TEXT NOT NULL,
        is_helpful BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    /**
     * agent_conversations 表：**跨轮会话记忆**的唯一持久化载体
     * - id: 主键
     * - session_id: 会话 ID（客户端传入，同一会话的多轮问答共用）
     * - repo_id: 所属仓库 ID（会话必须按仓库隔离，否则跨仓证据会串味）
     * - query: 本轮用户问题
     * - response: 本轮完整响应（JSONB，含 answer / evidence 等）
     * - execution_time_ms: 本轮耗时
     * - created_at: 创建时间
     *
     * ============================================
     * ⚠️ 这张表曾经是「只在线上存在、仓库里查不到」的状态
     * ============================================
     * 2026-09-20 复核发现：`agent/core.ts` 里有 4 处 SQL 引用本表
     * （INSERT 1 处 / SELECT 3 处），但**全仓没有任何一处 CREATE TABLE**，
     * migrations 里也没有。线上 `information_schema` 里它确实存在（7 列），
     * 说明它是被**带外创建**的 —— 本机或新环境从零建库时，这条 INSERT
     * 会以 42P01（表不存在）失败，而 core.ts:528 的 catch 只记一条日志，
     * **响应照常返回**，于是表现为「对话记录永远为空且不报错」。
     *
     * 这正是本项目反复踩到的同一形状：代码假定存在、真实库没有 ⇒ 静默空转。
     * 所以这里补上声明，并逐列 ALTER 兜底（已有线上表补齐缺列）。
     * 补完之后 `check:live-schema` 才能覆盖它，漂移不再只能靠人工发现。
     *
     * 【顺序要求】索引语句必须写在 ALTER 之后。
     * 2026-09-18 的事故就是 `CREATE INDEX ... ON repos(gitlab_url)` 跑在缺列的表上
     * 抛 42703，异常冒到调用方导致**整个服务起不来**。
     */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_conversations (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(128),
        repo_id INTEGER REFERENCES repos(id) ON DELETE CASCADE,
        query TEXT,
        response JSONB,
        execution_time_ms INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 老库补列（建表语句里的列只对「从零建库」生效，已存在的表是 no-op）
    await pool.query(`
      ALTER TABLE agent_conversations
        ADD COLUMN IF NOT EXISTS session_id VARCHAR(128),
        ADD COLUMN IF NOT EXISTS repo_id INTEGER,
        ADD COLUMN IF NOT EXISTS query TEXT,
        ADD COLUMN IF NOT EXISTS response JSONB,
        ADD COLUMN IF NOT EXISTS execution_time_ms INTEGER,
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
    `);

    /**
     * 会话记忆的读取路径：WHERE session_id = $1 AND repo_id = $2
     * ORDER BY created_at DESC, id DESC —— 本索引与查询的列序、排序方向都对齐，
     * 过滤 + 排序一条路径走完，不需要额外 sort。
     *
     * ⚠️ 名字故意与线上那张历史遗留的单列索引 `idx_agent_conversations_session`
     * **区分开**（`_session_recent`）。原因：`agent_conversations` 最初是 out-of-band
     * 建的表，线上已存在同名索引 `btree (session_id)`。若这里沿用同名 + `IF NOT EXISTS`，
     * 整条 DDL 会**静默 no-op** —— 报错没有、索引也没建，而读代码的人会以为复合索引已在。
     * （2026-09-20 实测踩到：`pg_indexes.indexdef` 是 `btree (session_id)`，
     * 与这里的声明不一致，而启动日志一切正常。）
     *
     * `CREATE INDEX IF NOT EXISTS` 只按**名字**判存在，不比对定义 ——
     * 所以只要可能与历史索引撞名，就必须换名字，否则闸门是关着的。
     */
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_conversations_session_recent
        ON agent_conversations (session_id, repo_id, created_at DESC, id DESC);
    `);

    /**
     * 删除旧的 IVFFlat 索引（如果存在）
     * IVFFlat 是一种向量索引算法，但在删除操作时性能较差
     * 我们改用 HNSW 索引，性能更好
     */
    try {
      await pool.query(`
        DROP INDEX IF EXISTS idx_code_chunks_embedding;
      `);
    } catch (err) {
      console.error('Failed to drop IVFFlat index:', err);
    }

    /**
     * 跳过启动时创建 HNSW 索引
     *
     * 原因：HNSW 索引创建非常耗时（大型仓库可能需要几分钟）
     * 如果在启动时创建，会阻塞服务启动
     *
     * 解决方案：手动创建索引或通过管理接口创建
     * 创建命令：
     * CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding_hnsw
     * ON code_chunks USING hnsw (embedding vector_cosine_ops)
     * WITH (m = 16, ef_construction = 64);
     *
     * HNSW 参数说明：
     * - m = 16: 每个节点的最大连接数，影响搜索质量和索引大小
     * - ef_construction = 64: 构建时的搜索深度，越大质量越好但构建越慢
     */
    console.log('⚠ Skipping HNSW index creation during startup (create it manually if needed)');

    /**
     * 创建额外的索引以优化查询性能
     *
     * 索引策略：
     * 1. 外键索引：加速 JOIN 操作
     * 2. 查询字段索引：加速 WHERE 条件过滤
     * 3. 复合索引：针对常见查询模式
     */

    // files 表索引：加速按仓库查询文件
    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_files_repo_id ON files(repo_id);
      `);
    } catch (err: any) {
      if (err.code !== '23505') throw err; // 忽略重复键错误
    }

    // code_chunks 表索引：加速各种查询场景
    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_code_chunks_file_id ON code_chunks(file_id);
      `);
    } catch (err: any) {
      if (err.code !== '23505') throw err;
    }

    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_code_chunks_symbol_name ON code_chunks(symbol_name);
      `);
    } catch (err: any) {
      if (err.code !== '23505') throw err;
    }

    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_code_chunks_symbol_type ON code_chunks(symbol_type);
      `);
    } catch (err: any) {
      if (err.code !== '23505') throw err;
    }

    // call_graph 表索引：加速调用关系查询
    // to_chunk_id 是实体级遍历（影响面分析/调用链）的关键列，必须有索引
    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_call_graph_from_chunk_id ON call_graph(from_chunk_id);
      `);
    } catch (err: any) {
      if (err.code !== '23505') throw err;
    }

    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_call_graph_to_chunk_id ON call_graph(to_chunk_id);
      `);
    } catch (err: any) {
      if (err.code !== '23505') throw err;
    }

    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_call_graph_repo_id ON call_graph(repo_id);
      `);
    } catch (err: any) {
      if (err.code !== '23505') throw err;
    }

    // questions 表索引：加速按仓库查询问题
    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_questions_repo_id ON questions(repo_id);
      `);
    } catch (err: any) {
      if (err.code !== '23505') throw err;
    }

    // question_feedback 表索引：加速按问题查询反馈
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_question_feedback_question_id ON question_feedback(question_id);
    `);

    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_repos_gitlab_url ON repos(gitlab_url) WHERE gitlab_url IS NOT NULL;
      `);
    } catch (err: any) {
      if (err.code !== '23505') throw err;
    }

    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_repos_parent_repo_id ON repos(parent_repo_id) WHERE parent_repo_id IS NOT NULL;
      `);
    } catch (err: any) {
      if (err.code !== '23505') throw err;
    }

    console.log('Database initialized');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    throw error;
  }
}

/**
 * 类型定义：仓库信息
 */
/**
 * 类型定义：仓库记录
 *
 * ⚠️ 这是 repos 行的**部分视图**，不是全部列（`gitlab_url` / `branch` /
 * `default_branch` / `index_progress` 等运行时确实存在，但没在这里声明）。
 * 新增列时如果代码要读它，就把它加到这里 —— 否则调用方只能靠 `any` 绕过去，
 * 而 `any` 会让「列名拼错」一路跑到 SQL 报错才被发现。
 */
export type Repo = {
  id: number;
  name: string;
  source: 'gitlab' | 'zip';
  url?: string;
  gitlab_token?: string;
  status: 'ready' | 'indexing' | 'failed';
  description?: string;
  created_at: Date;
  /** 最近一次增量索引的变更报告（`indexing/incremental-report.ts`） */
  last_incremental?: IncrementalReport | null;
};

/**
 * 类型定义：代码块记录
 */
export type CodeChunkRecord = {
  id: number;
  file_id: number;
  symbol_name: string;
  symbol_type: string;
  line_start: number;
  line_end: number;
  code_text: string;
  embedding?: number[];
};

/**
 * 创建新仓库
 *
 * @param name 仓库名称
 * @param source 来源类型（gitlab 或 zip）
 * @param url GitLab 仓库 URL（可选）
 * @param gitlabToken GitLab 访问令牌（可选，用于私有仓库）
 * @returns 新创建的仓库 ID
 */
export async function createRepo(name: string, source: 'gitlab' | 'zip', url?: string, gitlabToken?: string): Promise<number> {
  const result = await pool.query(
    'INSERT INTO repos (name, source, url, gitlab_token, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [name, source, url, gitlabToken, 'indexing']
  );
  return result.rows[0].id;
}

/**
 * 获取仓库信息
 *
 * @param repoId 仓库 ID
 * @returns 仓库信息，如果不存在则返回 null
 */
export async function getRepo(repoId: number): Promise<Repo | null> {
  const result = await pool.query('SELECT * FROM repos WHERE id = $1', [repoId]);
  return result.rows[0] || null;
}

/**
 * 更新仓库状态
 *
 * @param repoId 仓库 ID
 * @param status 新状态（ready/indexing/failed）
 */
export async function updateRepoStatus(repoId: number, status: 'ready' | 'indexing' | 'failed') {
  await pool.query('UPDATE repos SET status = $1 WHERE id = $2', [status, repoId]);
}

/**
 * 更新索引进度
 *
 * ⚠️ **`startTime` 只在显式传入时才写**（这是 2026-09-20 修的一个「字段在撒谎」的问题）。
 *
 * 修前是 `startTime: startTime || new Date()`，而调用方**每处理一个文件**都会调一次
 * 这个方法（`updateIndexProgress(repoId, files.length, alreadyIndexed + processedCount)`）。
 * 于是 `startTime` 被每一轮覆盖成「当前时间」，它实际表示的是
 * **「最后一次进度更新是什么时候」** —— 前端拿它算「已用时」永远得到 0，
 * 而且从数值上完全看不出异常（它一直是个看起来很合理的近期时间戳）。
 *
 * 现在拆成两条路径：
 * - 传了 `startTime` ⇒ 这是**一次新索引的开始**，整体重置进度，并把 `phase` 打回 `'basic'`
 *   （否则上一轮的 `'enhanced'` 会残留，让 `getIndexProgress` 在基础阶段去读
 *   上一轮的 `enhancedTotal/enhancedProcessed`，显示成「1037/1051」这种陈旧值）；
 * - 没传 ⇒ 只更新总数与已处理数，**其余键原样保留**（`jsonb_set` 天然只改指定键）。
 *
 * @param repoId - 仓库 ID
 * @param total - 本次要处理的文件总数
 * @param processed - 已处理文件数
 * @param startTime - 仅在一次索引**开始时**传入
 */
export async function updateIndexProgress(repoId: number, total: number, processed: number, startTime?: Date) {
  if (startTime) {
    await pool.query('UPDATE repos SET index_progress = $1 WHERE id = $2', [
      JSON.stringify({ total, processed, startTime, phase: 'basic' }),
      repoId,
    ]);
    return;
  }

  await pool.query(
    `UPDATE repos
        SET index_progress = jsonb_set(
              jsonb_set(coalesce(index_progress, '{}'::jsonb), '{total}', to_jsonb($1::int)),
              '{processed}', to_jsonb($2::int)
            )
      WHERE id = $3`,
    [total, processed, repoId]
  );
}

/**
 * 获取索引进度
 *
 * @param repoId 仓库 ID
 * @returns 索引进度信息，如果不存在则返回 null
 */
export async function getIndexProgress(repoId: number): Promise<{ total: number; processed: number; startTime: Date | null; phase?: 'basic' | 'enhanced' } | null> {
  const result = await pool.query('SELECT index_progress FROM repos WHERE id = $1', [repoId]);
  if (!result.rows[0]) return null;
  const progress = result.rows[0].index_progress;

  // 根据当前阶段返回对应的进度字段
  const isEnhanced = progress.phase === 'enhanced';

  return {
    total: isEnhanced ? (progress.enhancedTotal || 0) : (progress.total || 0),
    processed: isEnhanced ? (progress.enhancedProcessed || 0) : (progress.processed || 0),
    startTime: progress.startTime ? new Date(progress.startTime) : null,
    phase: progress.phase,
  };
}

/**
 * 需要在批量清理期间临时摘除、之后再挂回的外键约束（**唯一清单**）。
 *
 * ⚠️ 这份清单同时驱动「摘除」和「挂回」，不要在两处各写一份 ——
 * 2026-09-19 的故障正是「摘除」与「挂回」用了两份独立写法，
 * 而「挂回」那半段一旦失败就再没人补，导致线上库**永久缺失 6 个外键**。
 */
export const FK_CONSTRAINTS: ReadonlyArray<{ table: string; name: string; definition: string }> = [
  {
    table: 'code_chunks',
    name: 'code_chunks_parent_chunk_id_fkey',
    definition: 'FOREIGN KEY (parent_chunk_id) REFERENCES code_chunks(id) ON DELETE SET NULL'
  },
  {
    table: 'string_constants',
    name: 'string_constants_chunk_id_fkey',
    definition: 'FOREIGN KEY (chunk_id) REFERENCES code_chunks(id) ON DELETE CASCADE'
  },
  {
    table: 'string_constants',
    name: 'string_constants_file_id_fkey',
    definition: 'FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE'
  },
  {
    table: 'string_constants',
    name: 'string_constants_repo_id_fkey',
    definition: 'FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE'
  },
  {
    table: 'call_graph',
    name: 'call_graph_from_chunk_id_fkey',
    definition: 'FOREIGN KEY (from_chunk_id) REFERENCES code_chunks(id) ON DELETE CASCADE'
  },
  {
    table: 'url_patterns',
    name: 'url_patterns_definition_chunk_id_fkey',
    definition: 'FOREIGN KEY (definition_chunk_id) REFERENCES code_chunks(id) ON DELETE SET NULL'
  },
  {
    table: 'functions',
    name: 'functions_chunk_id_fkey',
    definition: 'FOREIGN KEY (chunk_id) REFERENCES code_chunks(id) ON DELETE CASCADE'
  },
  {
    table: 'classes',
    name: 'classes_chunk_id_fkey',
    definition: 'FOREIGN KEY (chunk_id) REFERENCES code_chunks(id) ON DELETE CASCADE'
  }
];

/** 摘除外键（批量删除前调用）。与 {@link ensureForeignKeyConstraints} 成对。 */
export async function dropForeignKeyConstraints(): Promise<void> {
  for (const c of FK_CONSTRAINTS) {
    await pool.query(`ALTER TABLE ${c.table} DROP CONSTRAINT IF EXISTS ${c.name}`);
  }
}

export interface ConstraintRestoreResult {
  /** 正常建立（并已校验存量数据）的约束 */
  added: string[];
  /** 因存量脏数据只能以 `NOT VALID` 建立的约束（对新写入仍然生效） */
  notValid: string[];
  /** 连 `NOT VALID` 都建不起来的约束 */
  failed: Array<{ name: string; error: string }>;
}

/**
 * 挂回外键约束（批量清理后调用）。
 *
 * ⚠️ **为什么不用 `DO $$ … $$` 块**（2026-09-19 故障复盘）：
 * 旧实现把 `ADD CONSTRAINT` 写在一个 `DO` 块里，**块内没有异常处理**。
 * PostgreSQL 里 `DO` 块是一整个子事务，任一条 `ALTER` 抛错都会让整条
 * `pool.query` 失败并向上抛出 ⇒ 外层 JS 的 `for` 循环**就此中断**，
 * 数组中排在后面的约束**一个都不会再创建**；`clearRepoData` 也会在
 * 「重置 index_progress」之前直接跳出。
 * 线上后果：库里只剩循环顺序最靠前的 2 个外键，其余 6 个永久缺失。
 *
 * 现在的做法是**逐个约束独立 try/catch**（在 JS 侧隔离，而不是靠 SQL 块）：
 * 1. 先尝试正常 `ADD CONSTRAINT`；
 * 2. 失败（通常是存量行违反约束）→ 退化为 `ADD CONSTRAINT … NOT VALID`
 *    —— 它**不会**校验存量行，但对**之后**的写入同样强制执行；
 * 3. 仍失败 → 记进 `failed` 并**继续下一个**，绝不中断整个流程。
 *
 * 调用方可根据返回值决定是否告警（脏数据需要另行清理，见
 * `scripts/repair-constraints.ts`）。
 */
export async function ensureForeignKeyConstraints(): Promise<ConstraintRestoreResult> {
  const result: ConstraintRestoreResult = { added: [], notValid: [], failed: [] };

  for (const c of FK_CONSTRAINTS) {
    const exists = await pool.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [c.name]);
    if (exists.rowCount && exists.rowCount > 0) continue;

    try {
      await pool.query(`ALTER TABLE ${c.table} ADD CONSTRAINT ${c.name} ${c.definition}`);
      result.added.push(c.name);
      continue;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️  约束 ${c.name} 正常建立失败，退化为 NOT VALID：${msg}`);
      try {
        await pool.query(
          `ALTER TABLE ${c.table} ADD CONSTRAINT ${c.name} ${c.definition} NOT VALID`
        );
        result.notValid.push(c.name);
      } catch (err2) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        result.failed.push({ name: c.name, error: msg2 });
        console.warn(`⚠️  约束 ${c.name} 建立失败，已跳过（不影响后续约束）：${msg2}`);
      }
    }
  }

  return result;
}

/**
 * 校验「目前处于 NOT VALID 状态」的外键约束（清掉脏数据后调用）。
 *
 * @returns 每个被尝试校验的约束及其结果
 */
export async function validateForeignKeyConstraints(): Promise<
  Array<{ name: string; ok: boolean; error?: string }>
> {
  const out: Array<{ name: string; ok: boolean; error?: string }> = [];
  const names = FK_CONSTRAINTS.map((c) => c.name);

  const rows = await pool.query<{ conname: string; conrelid: string }>(
    `SELECT conname, conrelid::regclass::text AS conrelid
       FROM pg_constraint
      WHERE conname = ANY($1) AND convalidated = false`,
    [names]
  );

  for (const row of rows.rows) {
    const c = FK_CONSTRAINTS.find((x) => x.name === row.conname);
    if (!c) continue;
    try {
      await pool.query(`ALTER TABLE ${c.table} VALIDATE CONSTRAINT ${c.name}`);
      out.push({ name: c.name, ok: true });
    } catch (err) {
      out.push({ name: c.name, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return out;
}

/**
 * 删除某个仓库在**所有子表**里的行（含 `files`，以及这些文件的 `code_chunks`）。
 *
 * 顺序：叶子表 → `files` → `code_chunks`（由叶到根，避免中间态违反外键）。
 *
 * ⚠️ **不要只依赖 `ON DELETE CASCADE`**。`DELETE /repos/:id` 过去就是这么做的：
 * 一旦某个 `*_repo_id_fkey` 缺失（正是 2026-09-19 那次故障），级联会**静默不生效**
 * —— 既不报错也不告警，`DELETE FROM repos` 照样返回成功，只在库里留下一堆指向
 * 已删仓库的孤儿行（线上实测 684 行 `string_constants`，又反过来阻塞外键重建）。
 * 显式按 `repo_id` 删除与约束是否存在无关。
 *
 * 手动删除而非依赖级联的附带理由：级联会逐行触发子表删除，比批量 DELETE 慢得多。
 */
export async function deleteRepoChildRows(repoId: number): Promise<void> {
  console.log('Deleting child tables...');
  await pool.query('DELETE FROM constant_references WHERE repo_id = $1', [repoId]);
  await pool.query('DELETE FROM string_constants WHERE repo_id = $1', [repoId]);
  await pool.query('DELETE FROM url_usages WHERE repo_id = $1', [repoId]);
  await pool.query('DELETE FROM url_patterns WHERE repo_id = $1', [repoId]);
  await pool.query('DELETE FROM call_graph WHERE repo_id = $1', [repoId]);
  await pool.query('DELETE FROM functions WHERE repo_id = $1', [repoId]);
  await pool.query('DELETE FROM classes WHERE repo_id = $1', [repoId]);
  await pool.query('DELETE FROM file_dependencies WHERE repo_id = $1', [repoId]);
  await pool.query('DELETE FROM import_relations WHERE repo_id = $1', [repoId]);
  console.log('✓ Deleted child tables');

  // code_chunks 没有 repo_id 列（归属经 files.repo_id 表达）→ 先取 file_id 再删
  const fileIdsResult = await pool.query('SELECT id FROM files WHERE repo_id = $1', [repoId]);
  const fileIds = fileIdsResult.rows.map(r => r.id);

  if (fileIds.length > 0) {
    console.log(`Found ${fileIds.length} files, deleting code_chunks...`);
    await pool.query('DELETE FROM code_chunks WHERE file_id = ANY($1)', [fileIds]);
    console.log('✓ Deleted code_chunks');
  }

  await pool.query('DELETE FROM files WHERE repo_id = $1', [repoId]);
  console.log('✓ Deleted files');
}

/**
 * 清除仓库数据（性能优化版本）
 *
 * 这是一个关键的性能优化函数，解决了大规模数据删除的性能问题
 *
 * 【问题背景】
 * 删除 96K 条 code_chunks 记录时，直接 DELETE 耗时 16-19 分钟
 *
 * 【性能瓶颈分析】
 * 1. HNSW 向量索引：删除时需要重新平衡索引结构，非常慢
 * 2. 7 个 B-tree 索引：每次删除都要更新所有索引
 * 3. 外键级联删除：触发子表的级联删除操作
 * 4. 事务日志：大量删除操作产生巨大的 WAL 日志
 *
 * 【优化策略】
 * 采用"先删索引，再删数据，最后重建索引"的策略：
 *
 * Step 1: 删除所有索引和外键约束
 *   - 删除 HNSW 向量索引（最耗时的索引）
 *   - 删除所有 B-tree 索引
 *   - 删除外键约束（避免级联删除开销）
 *
 * Step 2: 删除子表数据
 *   - 手动删除所有依赖 code_chunks 的子表
 *   - 避免外键级联删除的性能开销
 *
 * Step 3: 删除主表数据
 *   - 此时没有索引，删除速度极快
 *   - 没有外键约束，无级联开销
 *
 * Step 4: 重建所有索引和约束
 *   - 批量重建索引比逐行维护索引快得多
 *   - 恢复数据完整性约束
 *
 * 【性能提升】
 * - 删除时间：16-19 分钟 → 98 秒（提升 10-12 倍）
 * - 总 reindex 时间：20+ 分钟 → 2-3 分钟
 *
 * 【技术原理】
 * 1. 索引维护开销：逐行删除时，每次都要更新索引；批量重建索引只需一次
 * 2. HNSW 特性：HNSW 索引在删除时需要重新平衡图结构，非常耗时
 * 3. 外键级联：级联删除会触发多次查询和删除操作
 * 4. 批量操作：PostgreSQL 对批量操作有优化，比逐行操作快得多
 *
 * @param repoId 要清除数据的仓库 ID
 */
export async function clearRepoData(repoId: number): Promise<void> {
  console.log(`Clearing data for repo ${repoId}...`);

  const startTime = Date.now();

  /**
   * Step 1: 删除所有索引和外键约束
   *
   * 为什么要先删除索引？
   * - 索引维护是删除操作的主要性能瓶颈
   * - HNSW 向量索引在删除时特别慢（需要重新平衡图结构）
   * - 删除索引后，DELETE 操作只需要删除表数据，速度快得多
   */
  console.log('Dropping indexes and constraints...');

  // 删除 code_chunks 表的所有索引
  await pool.query('DROP INDEX IF EXISTS idx_code_chunks_embedding_hnsw');
  await pool.query('DROP INDEX IF EXISTS idx_code_chunks_file_id');
  await pool.query('DROP INDEX IF EXISTS idx_code_chunks_symbol_name');
  await pool.query('DROP INDEX IF EXISTS idx_code_chunks_symbol_type');
  await pool.query('DROP INDEX IF EXISTS idx_code_chunks_node_type');
  await pool.query('DROP INDEX IF EXISTS idx_code_chunks_metadata');
  // 说明：这里曾有一个 `idx_code_chunks_repo ON code_chunks(repo_id)` 索引，
  // 但**本文件的建表语句从未定义 repo_id 列**（仓库归属统一通过 files.repo_id 表达）。
  // 该索引在新建库上会直接抛 `column "repo_id" does not exist`，已移除；
  // 仓库范围的 code_chunks 查询一律 JOIN files 后按 f.repo_id 过滤。
  //
  // ⚠️ 注意措辞：不是「code_chunks 表从来没有 repo_id 列」。
  // 2026-09-18 在 47.116.6.132 上实测发现，该库的 code_chunks **残留着**一列 repo_id，
  // 且 257 行全为 NULL（历史 schema 遗留，insertCodeChunk 从不写它）。
  // 也就是说「代码 schema 里没有」≠「线上库里没有」。判断这类问题时以
  // information_schema 为准，别信注释 —— `check:live-schema` 就是干这个的。
  // 任何依赖 code_chunks.repo_id 的查询在新建库上会失败、在老库上会静默返回 0 行。
  // 摘除外键。⚠️ 清单**只**在 FK_CONSTRAINTS 里维护一份：
  // 摘除与挂回各写一份的话，两半很容易漂移（2026-09-19 故障就是挂回那半段漏了 6 个）。
  await dropForeignKeyConstraints();

  console.log('✓ All indexes and constraints dropped');

  // Step 2/3/4: 删除子表 → files → code_chunks（顺序与理由见 deleteRepoChildRows）
  await deleteRepoChildRows(repoId);

  /**
   * Step 5: 重建所有索引和外键约束
   *
   * 为什么批量重建索引更快？
   * - PostgreSQL 对批量索引构建有优化
   * - 可以一次性扫描表并构建索引
   * - 比逐行维护索引快得多
   *
   * HNSW 索引参数说明：
   * - m = 16: 每个节点的最大连接数，平衡搜索质量和索引大小
   * - ef_construction = 64: 构建时的搜索深度，影响索引质量
   */
  console.log('Recreating indexes and constraints...');

  // 重建 code_chunks 表的索引
  await pool.query('CREATE INDEX IF NOT EXISTS idx_code_chunks_file_id ON code_chunks (file_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_code_chunks_symbol_name ON code_chunks (symbol_name)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_code_chunks_symbol_type ON code_chunks (symbol_type)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_code_chunks_node_type ON code_chunks (node_type)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_code_chunks_metadata ON code_chunks USING gin (metadata)');

  // ============================================================
  // URL 索引的唯一键（跨边界调用链的基础，不要改回 (repo_id, pattern)）
  // ============================================================
  // 语义：url_patterns 是「接口」，一个 (method, 规范化路径) 一行；
  //       调用方与路由定义**共用同一行**，两侧的位置记在 url_usages 里。
  // 历史坑：旧键是 (repo_id, pattern)（原始路径），而原始路径不区分 HTTP 方法，
  //       于是 `/api/users/:id` 下 GET/POST/PUT/DELETE 只有第一个能入库，
  //       后写入的抛唯一冲突被 relationship-builder 的 catch 吃掉 →
  //       「接口在哪里被调用了」永远查不全（实测覆盖率 4/65）。
  await pool.query('DROP INDEX IF EXISTS idx_url_patterns_unique');
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_url_patterns_endpoint_unique
    ON url_patterns (repo_id, COALESCE(method, ''), normalized_pattern)
  `);
  // url_usages 同一位置的重复插入挡掉（历史数据曾有 4 倍重复：445 行里 344 行是噪声）
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_url_usages_site_unique
    ON url_usages (repo_id, url_pattern_id, COALESCE(usage_file_id, -1),
                   COALESCE(usage_line, -1), COALESCE(usage_context, ''))
  `);

  // 重建 HNSW 向量索引（最耗时的索引）
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding_hnsw
    ON code_chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
  `);

  // 重建外键约束，恢复数据完整性。
  //
  // ⚠️ **不要再退回 `DO $$ … ADD CONSTRAINT … $$` 的写法。**
  // `DO` 块在 PostgreSQL 里是一整个子事务，而块内**没有异常处理**：只要有一条
  // `ALTER` 失败（典型场景：存量行违反约束），整条 `pool.query` 就会抛错，
  // 外层 `for (const constraint of …)` 循环随之中断 —— 数组中排在它后面的约束
  // **一个都不会创建**，本函数也走不到下面的「重置 index_progress」。
  // 2026-09-19 线上库就是这么永久只剩 2 个外键的，而 DELETE /repos/:id 依赖
  // ON DELETE CASCADE，缺约束时它静默留下孤儿行（实测 684 行 string_constants），
  // 孤儿行又反过来让外键永远建不起来 —— 一个自锁死的循环。
  // 现在改成**逐个约束独立 try/catch**（退化路径 NOT VALID），见 ensureForeignKeyConstraints。
  const restored = await ensureForeignKeyConstraints();
  if (restored.added.length > 0) {
    console.log(`✓ 外键已恢复：${restored.added.length} 个`);
  }
  if (restored.notValid.length > 0) {
    console.warn(
      '⚠️  以下外键因存量脏数据只能以 NOT VALID 建立（对之后的新写入仍然生效）：' +
        restored.notValid.join(', ') +
        ' —— 需清理脏数据后跑 node apps/api/dist/scripts/repair-constraints.js 再校验'
    );
  }
  if (restored.failed.length > 0) {
    console.warn(
      '⚠️  以下外键建立失败，已跳过（未中断流程，但数据完整性缺一块）：' +
        restored.failed.map((f) => `${f.name}(${f.error})`).join('; ')
    );
  }

  console.log('✓ All indexes and constraints recreated');

  // 计算并输出总耗时
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`✓ Cleared all data for repo ${repoId} in ${elapsed}s`);

  // 重置索引进度
  await pool.query('UPDATE repos SET index_progress = $1 WHERE id = $2', [JSON.stringify({ total: 0, processed: 0, startTime: null }), repoId]);
}

/**
 * 插入文件记录
 *
 * @param repoId 仓库 ID
 * @param path 文件路径
 * @param language 编程语言
 * @param content 文件内容
 * @returns 新插入的文件 ID
 */
export async function insertFile(repoId: number, path: string, language: string, content: string): Promise<number> {
  const result = await pool.query(
    'INSERT INTO files (repo_id, path, language, content) VALUES ($1, $2, $3, $4) RETURNING id',
    [repoId, path, language, content]
  );
  return result.rows[0].id;
}

/**
 * 插入代码块记录
 *
 * @param fileId 文件 ID
 * @param symbolName 符号名称
 * @param symbolType 符号类型
 * @param lineStart 起始行号
 * @param lineEnd 结束行号
 * @param codeText 代码文本
 * @param embedding 向量表示（可选）
 * @returns 新插入的代码块 ID
 */
export async function insertCodeChunk(
  fileId: number,
  symbolName: string,
  symbolType: string,
  lineStart: number,
  lineEnd: number,
  codeText: string,
  embedding?: number[]
): Promise<number> {
  const result = await pool.query(
    'INSERT INTO code_chunks (file_id, symbol_name, symbol_type, line_start, line_end, code_text, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [fileId, symbolName, symbolType, lineStart, lineEnd, codeText, embedding ? `[${embedding.join(',')}]` : null]
  );
  return result.rows[0].id;
}

/**
 * 按关键词搜索代码块
 *
 * 性能优化：
 * 1. 跳过超长查询（>100字符），因为 ILIKE 对长字符串很慢
 * 2. 只搜索 symbol_name，不搜索 code_text（避免全文扫描）
 * 3. 限制返回 20 条结果
 *
 * @param repoId 仓库 ID
 * @param keyword 搜索关键词
 * @returns 匹配的代码块列表
 */
export async function searchByKeyword(repoId: number, keyword: string): Promise<CodeChunkRecord[]> {
  // 跳过超长查询（例如 URL），ILIKE 对长字符串性能很差
  if (keyword.length > 100) {
    return [];
  }

  // 只搜索 symbol_name，避免对 code_text 进行慢速的 ILIKE 扫描
  const result = await pool.query(
    `SELECT c.*, f.path as file_path
     FROM code_chunks c
     JOIN files f ON c.file_id = f.id
     WHERE f.repo_id = $1 AND c.symbol_name ILIKE $2
     LIMIT 20`,
    [repoId, `%${keyword}%`]
  );
  return result.rows;
}

/**
 * 按向量相似度搜索代码块（语义搜索）
 *
 * 使用 pgvector 的余弦相似度搜索
 * 相似度计算：1 - (embedding <=> query_embedding)
 * 值越大表示越相似（范围 0-1）
 *
 * 性能优化：
 * - 设置 hnsw.ef_search = 40，提高召回率
 * - 使用 HNSW 索引加速搜索（比暴力搜索快 100+ 倍）
 *
 * @param repoId 仓库 ID
 * @param embedding 查询向量（1024 维）
 * @param limit 返回结果数量（默认 10）
 * @returns 按相似度排序的代码块列表
 */
export async function searchByEmbedding(repoId: number, embedding: number[], limit = 10): Promise<CodeChunkRecord[]> {
  // 设置 HNSW 搜索参数，提高召回率
  // ef_search 越大，搜索越准确，但速度越慢
  await pool.query('SET hnsw.ef_search = 40');

  const result = await pool.query(
    `SELECT c.*, f.path as file_path, 1 - (c.embedding <=> $1::vector) as similarity
     FROM code_chunks c
     JOIN files f ON c.file_id = f.id
     WHERE f.repo_id = $2 AND c.embedding IS NOT NULL
     ORDER BY c.embedding <=> $1::vector
     LIMIT $3`,
    [`[${embedding.join(',')}]`, repoId, limit]
  );
  return result.rows;
}

/**
 * 增量索引相关函数
 * 用于支持文件的增量更新，避免重新索引整个仓库
 */

/**
 * 根据路径获取文件
 *
 * @param repoId 仓库 ID
 * @param path 文件路径
 * @returns 文件信息，如果不存在则返回 null
 */
export async function getFileByPath(repoId: number, path: string): Promise<{ id: number; content: string } | null> {
  const result = await pool.query(
    'SELECT id, content FROM files WHERE repo_id = $1 AND path = $2',
    [repoId, path]
  );
  return result.rows[0] || null;
}

/**
 * 更新文件内容
 *
 * ⚠️ 同时把 `entities_indexed_at` 置回 NULL（= 实体层标记失效）。
 *
 * 这是「断点续跑」的正确性前提，不是顺手清理：内容变了，上一轮的实体层结论
 * 就不再对应当前内容。若不置 NULL，会出现这种坏序列：
 *   更新内容 → （进程在此崩溃） → 续跑 ⇒ 因为标记还是旧的而**跳过**这个文件
 * ⇒ 文件的新内容永远拿不到实体层更新，而且没有任何报错。
 * 置 NULL 之后，`indexFileWith` 成功时会重新盖上标记，语义闭环。
 *
 * @param fileId 文件 ID
 * @param content 新内容
 * @param language 编程语言
 */
export async function updateFile(fileId: number, content: string, language: string): Promise<void> {
  await pool.query(
    'UPDATE files SET content = $1, language = $2, entities_indexed_at = NULL WHERE id = $3',
    [content, language, fileId]
  );
}

/**
 * 删除文件的所有代码块
 *
 * 用于增量更新时，先删除旧的代码块，再插入新的
 *
 * @param fileId 文件 ID
 */
export async function deleteFileChunks(fileId: number): Promise<void> {
  await pool.query('DELETE FROM code_chunks WHERE file_id = $1', [fileId]);
}

/**
 * 删除文件
 *
 * @param fileId 文件 ID
 */
export async function deleteFile(fileId: number): Promise<void> {
  await pool.query('DELETE FROM files WHERE id = $1', [fileId]);
}

// Feedback functions
export async function addQuestionFeedback(questionId: number, feedbackText: string, isHelpful: boolean): Promise<number> {
  const result = await pool.query(
    'INSERT INTO question_feedback (question_id, feedback_text, is_helpful) VALUES ($1, $2, $3) RETURNING id',
    [questionId, feedbackText, isHelpful]
  );
  return result.rows[0].id;
}

export async function getQuestionFeedback(questionId: number): Promise<Array<{ id: number; feedback_text: string; is_helpful: boolean; created_at: Date }>> {
  const result = await pool.query(
    'SELECT id, feedback_text, is_helpful, created_at FROM question_feedback WHERE question_id = $1 ORDER BY created_at DESC',
    [questionId]
  );
  return result.rows;
}

export async function getSimilarQuestionsWithFeedback(repoId: number, query: string, limit = 5): Promise<Array<{
  id: number;
  query: string;
  answer: string;
  feedback: Array<{ feedback_text: string; is_helpful: boolean }>;
}>> {
  const result = await pool.query(
    `SELECT q.id, q.query, q.answer,
      COALESCE(
        json_agg(
          json_build_object('feedback_text', qf.feedback_text, 'is_helpful', qf.is_helpful)
          ORDER BY qf.created_at DESC
        ) FILTER (WHERE qf.id IS NOT NULL),
        '[]'
      ) as feedback
     FROM questions q
     LEFT JOIN question_feedback qf ON q.id = qf.question_id
     WHERE q.repo_id = $1 AND q.query ILIKE $2
     GROUP BY q.id, q.query, q.answer
     ORDER BY q.created_at DESC
     LIMIT $3`,
    [repoId, `%${query}%`, limit]
  );
  return result.rows;
}

/**
 * 获取代码块的扩展上下文
 * 包含前后若干行代码，提供更完整的上下文
 *
 * @param chunkId 代码块 ID
 * @param linesBefore 前面包含的行数（默认 5 行）
 * @param linesAfter 后面包含的行数（默认 5 行）
 */
export async function getChunkWithContext(
  chunkId: number,
  linesBefore: number = 5,
  linesAfter: number = 5
): Promise<(CodeChunkRecord & { file_path?: string; extended_code?: string }) | null> {
  const result = await pool.query(
    `SELECT c.*, f.content, f.path as file_path
     FROM code_chunks c
     JOIN files f ON c.file_id = f.id
     WHERE c.id = $1`,
    [chunkId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const chunk = result.rows[0];
  const lines = chunk.content.split('\n');

  // 计算扩展范围（注意：line_start 和 line_end 是 1-based）
  const start = Math.max(0, chunk.line_start - linesBefore - 1);
  const end = Math.min(lines.length, chunk.line_end + linesAfter);

  const extendedCode = lines.slice(start, end).join('\n');

  return {
    ...chunk,
    extended_code: extendedCode,
  };
}

/**
 * 批量获取代码块的扩展上下文
 */
export async function getChunksWithContext(
  chunks: Array<CodeChunkRecord & { file_path?: string }>,
  linesBefore: number = 5,
  linesAfter: number = 5
): Promise<Array<CodeChunkRecord & { file_path?: string; extended_code?: string }>> {
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const withContext = await getChunkWithContext(chunk.id, linesBefore, linesAfter);
      return withContext || chunk;
    })
  );

  return results;
}

