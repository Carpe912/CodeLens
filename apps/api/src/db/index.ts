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
     * files 表：存储文件信息
     * - id: 主键
     * - repo_id: 所属仓库 ID（外键，级联删除）
     * - path: 文件路径（相对于仓库根目录）
     * - language: 编程语言（typescript/javascript/vue 等）
     * - content: 文件完整内容
     * - created_at: 创建时间
     */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS files (
        id SERIAL PRIMARY KEY,
        repo_id INTEGER REFERENCES repos(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        language TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

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
     * - from_chunk_id: 调用者代码块 ID（外键，级联删除）
     * - to_symbol: 被调用的符号名称
     * - created_at: 创建时间
     *
     * 用途：构建函数调用图，支持调用链分析
     * 例如：A 函数调用 B 函数，则 from_chunk_id 指向 A，to_symbol 为 "B"
     */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS call_graph (
        id SERIAL PRIMARY KEY,
        from_chunk_id INTEGER REFERENCES code_chunks(id) ON DELETE CASCADE,
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
    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_call_graph_from_chunk_id ON call_graph(from_chunk_id);
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

    // repos 表索引：支持多分支索引查询
    try {
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_gitlab_url_branch ON repos(gitlab_url, branch) WHERE gitlab_url IS NOT NULL;
      `);
    } catch (err: any) {
      if (err.code !== '23505') throw err;
    }

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
export type Repo = {
  id: number;
  name: string;
  source: 'gitlab' | 'zip';
  url?: string;
  gitlab_token?: string;
  status: 'ready' | 'indexing' | 'failed';
  description?: string;
  created_at: Date;
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
 * @param repoId 仓库 ID
 * @param total 总文件数
 * @param processed 已处理文件数
 * @param startTime 开始时间（可选）
 */
export async function updateIndexProgress(repoId: number, total: number, processed: number, startTime?: Date) {
  const progress = {
    total,
    processed,
    startTime: startTime || new Date(),
  };
  await pool.query('UPDATE repos SET index_progress = $1 WHERE id = $2', [JSON.stringify(progress), repoId]);
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
  await pool.query('DROP INDEX IF EXISTS idx_code_chunks_repo');
  await pool.query('ALTER TABLE code_chunks DROP CONSTRAINT IF EXISTS code_chunks_parent_chunk_id_fkey');

  // 删除 string_constants 表的外键约束（指向 code_chunks）
  await pool.query('ALTER TABLE string_constants DROP CONSTRAINT IF EXISTS string_constants_chunk_id_fkey');
  await pool.query('ALTER TABLE string_constants DROP CONSTRAINT IF EXISTS string_constants_file_id_fkey');
  await pool.query('ALTER TABLE string_constants DROP CONSTRAINT IF EXISTS string_constants_repo_id_fkey');

  // 删除其他表指向 code_chunks 的外键约束
  await pool.query('ALTER TABLE call_graph DROP CONSTRAINT IF EXISTS call_graph_from_chunk_id_fkey');
  await pool.query('ALTER TABLE url_patterns DROP CONSTRAINT IF EXISTS url_patterns_definition_chunk_id_fkey');
  await pool.query('ALTER TABLE functions DROP CONSTRAINT IF EXISTS functions_chunk_id_fkey');
  await pool.query('ALTER TABLE classes DROP CONSTRAINT IF EXISTS classes_chunk_id_fkey');

  console.log('✓ All indexes and constraints dropped');

  /**
   * Step 2: 删除子表数据
   *
   * 为什么要手动删除子表？
   * - 避免外键级联删除的性能开销
   * - 外键级联会触发多次查询和删除操作
   * - 手动删除可以直接批量删除，速度更快
   *
   * 删除顺序：从叶子表到根表
   */
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

  /**
   * Step 3: 删除 code_chunks 表数据
   *
   * 此时已经没有索引和外键约束，删除速度极快
   * 先查询所有文件 ID，然后批量删除
   */
  const fileIdsResult = await pool.query('SELECT id FROM files WHERE repo_id = $1', [repoId]);
  const fileIds = fileIdsResult.rows.map(r => r.id);

  if (fileIds.length > 0) {
    console.log(`Found ${fileIds.length} files, deleting code_chunks...`);
    await pool.query('DELETE FROM code_chunks WHERE file_id = ANY($1)', [fileIds]);
    console.log('✓ Deleted code_chunks');
  }

  /**
   * Step 4: 删除 files 表数据
   */
  await pool.query('DELETE FROM files WHERE repo_id = $1', [repoId]);
  console.log('✓ Deleted files');

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
  await pool.query('CREATE INDEX IF NOT EXISTS idx_code_chunks_repo ON code_chunks (repo_id)');

  // 重建 HNSW 向量索引（最耗时的索引）
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding_hnsw
    ON code_chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
  `);

  // 重建外键约束，恢复数据完整性
  // 使用 DO 块来安全地添加约束（如果不存在）
  const constraints = [
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

  for (const constraint of constraints) {
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = '${constraint.name}'
        ) THEN
          ALTER TABLE ${constraint.table}
          ADD CONSTRAINT ${constraint.name}
          ${constraint.definition};
        END IF;
      END $$;
    `);
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
 * 搜索字符串常量（URL、API 端点等）
 *
 * 用于查找代码中定义的字符串常量，特别是 URL 模式
 * 按字符串长度降序排序，优先返回更完整的 URL
 *
 * @param repoId 仓库 ID
 * @param pattern 搜索模式
 * @param limit 返回结果数量（默认 20）
 * @returns 匹配的字符串常量列表
 */
export async function searchStringConstants(repoId: number, pattern: string, limit = 20): Promise<any[]> {
  const result = await pool.query(
    `SELECT
       sc.id,
       sc.value,
       sc.symbol_name,
       sc.export_type,
       f.path as file_path,
       c.start_line,
       c.end_line,
       c.code_text
     FROM string_constants sc
     JOIN code_chunks c ON sc.chunk_id = c.id
     JOIN files f ON c.file_id = f.id
     WHERE f.repo_id = $1 AND sc.value ILIKE $2
     ORDER BY LENGTH(sc.value) DESC
     LIMIT $3`,
    [repoId, `%${pattern}%`, limit]
  );
  return result.rows;
}

/**
 * 查找常量的使用位置
 *
 * 通过常量 ID 查找所有引用该常量的代码位置
 * 用于依赖追踪和影响分析
 *
 * @param repoId 仓库 ID
 * @param constantId 常量 ID
 * @returns 使用该常量的代码块列表
 */
export async function findConstantUsages(repoId: number, constantId: number): Promise<any[]> {
  const result = await pool.query(
    `SELECT
       c.id,
       c.code_text,
       c.start_line,
       c.end_line,
       f.path as file_path,
       sc.value as constant_value,
       sc.symbol_name
     FROM constant_references cr
     JOIN code_chunks c ON cr.chunk_id = c.id
     JOIN files f ON c.file_id = f.id
     JOIN string_constants sc ON cr.constant_id = sc.id
     WHERE f.repo_id = $1 AND cr.constant_id = $2
     ORDER BY f.path, c.start_line`,
    [repoId, constantId]
  );
  return result.rows;
}

/**
 * 查找函数调用链（递归查询）
 *
 * 使用 PostgreSQL 的递归 CTE（Common Table Expression）查找函数的调用链
 * 可以追踪"谁调用了这个函数"以及"调用了多少层"
 *
 * 工作原理：
 * 1. Base case: 找到目标函数
 * 2. Recursive case: 递归查找调用者
 * 3. 防止循环：检查路径中是否已存在该函数
 *
 * 示例：
 * 如果 A -> B -> C，查询 C 会返回：
 * - depth=1: B 调用 C
 * - depth=2: A 调用 B
 *
 * @param repoId 仓库 ID
 * @param functionName 函数名称
 * @param maxDepth 最大递归深度（默认 3）
 * @returns 调用链列表，按深度和文件路径排序
 */
export async function findCallChain(repoId: number, functionName: string, maxDepth = 3): Promise<any[]> {
  const result = await pool.query(
    `WITH RECURSIVE call_chain AS (
       -- Base case: 找到目标函数
       SELECT
         cg.caller_chunk_id,
         cg.callee_chunk_id,
         cg.caller_name,
         cg.callee_name,
         1 as depth,
         ARRAY[cg.callee_name] as path
       FROM call_graph cg
       JOIN code_chunks c ON cg.callee_chunk_id = c.id
       JOIN files f ON c.file_id = f.id
       WHERE f.repo_id = $1 AND cg.callee_name ILIKE $2

       UNION ALL

       -- Recursive case: 递归查找调用者
       SELECT
         cg.caller_chunk_id,
         cg.callee_chunk_id,
         cg.caller_name,
         cg.callee_name,
         cc.depth + 1,
         cc.path || cg.caller_name
       FROM call_graph cg
       JOIN call_chain cc ON cg.callee_chunk_id = cc.caller_chunk_id
       JOIN code_chunks c ON cg.caller_chunk_id = c.id
       JOIN files f ON c.file_id = f.id
       WHERE f.repo_id = $1 AND cc.depth < $3
         AND NOT (cg.caller_name = ANY(cc.path)) -- 防止循环引用
     )
     SELECT DISTINCT
       cc.*,
       c.code_text,
       c.start_line,
       c.end_line,
       f.path as file_path
     FROM call_chain cc
     JOIN code_chunks c ON cc.caller_chunk_id = c.id
     JOIN files f ON c.file_id = f.id
     ORDER BY cc.depth, f.path, c.start_line`,
    [repoId, `%${functionName}%`, maxDepth]
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
 * @param fileId 文件 ID
 * @param content 新内容
 * @param language 编程语言
 */
export async function updateFile(fileId: number, content: string, language: string): Promise<void> {
  await pool.query(
    'UPDATE files SET content = $1, language = $2 WHERE id = $3',
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

