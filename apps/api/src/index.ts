/**
 * CodeLens API 服务入口文件
 *
 * 核心功能：
 * - 代码仓库管理（GitLab/ZIP 导入、索引、刷新）
 * - 多策略代码搜索（向量搜索、关键词搜索、URL 搜索）
 * - 智能问答（基于代码上下文的问答系统）
 * - 根因分析（代码问题的深度分析）
 * - Agent 交互（多轮对话式代码查询）
 * - 缓存管理（提升查询性能）
 *
 * 技术栈：
 * - Fastify: 高性能 Web 框架
 * - PostgreSQL + pgvector: 向量数据库
 * - Anthropic Claude: 大语言模型
 * - BullMQ: 任务队列（索引任务）
 */

import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initDatabase, createRepo, pool, searchByKeyword, searchByEmbedding, getRepo, addQuestionFeedback, getQuestionFeedback, getSimilarQuestionsWithFeedback, clearRepoData, getIndexProgress } from './db/index.js';
import { enqueueIndexJob, enqueueIncrementalIndexJob, enqueueRefreshJob, enqueueReindexJob, startIndexWorker } from './indexer/queue.js';
import { generateEmbedding } from './llm/embeddings.js';
import { answerQuestion, analyzeRootCause } from './llm/qa.js';
import { searchTTLCache, generateCacheKey, getAllCacheStats, clearAllCaches } from './cache.js';
import { MultiStrategySearch } from './llm/multi-strategy-search.js';
import { AgentCore, getAgentConfig } from './agent/index.js';
import Anthropic from '@anthropic-ai/sdk';
import { normalizeGitLabUrl, extractProjectName, getGitLabDefaultBranch } from './utils/gitlab.js';

/**
 * 验证必需的环境变量
 * 确保 API 密钥等关键配置已正确设置
 *
 * 必需的环境变量：
 * - ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN: Claude API 密钥
 * - OPENAI_API_KEY 或 EMBED_API_KEY: 向量嵌入 API 密钥
 *
 * 如果缺少必需变量，程序将退出并提示错误
 */
function validateEnv() {
  const required = [
    process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY ? null : 'ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN',
    process.env.EMBED_API_KEY || process.env.OPENAI_API_KEY ? null : 'OPENAI_API_KEY or EMBED_API_KEY'
  ].filter(Boolean);

  if (required.length > 0) {
    console.error(`Missing required environment variables: ${required.join(', ')}`);
    console.error('Please check your .env file');
    process.exit(1);
  }
}

validateEnv();

/**
 * 创建 Fastify 服务器实例
 * 启用日志记录功能
 */
const fastify = Fastify({ logger: true });

/**
 * 注册 CORS 插件
 * 允许跨域请求，支持前端应用调用 API
 */
await fastify.register(cors);

/**
 * 注册文件上传插件
 * 配置：
 * - 最大文件大小: 50MB
 * - 最大文件数: 1 个
 *
 * 用于支持 ZIP 文件上传功能
 */
await fastify.register(multipart, {
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
    files: 1,
  },
});

/**
 * 注册限流插件
 * 配置：
 * - 最大请求数: 100 次
 * - 时间窗口: 1 分钟
 *
 * 防止 API 滥用和 DDoS 攻击
 */
await fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

/**
 * 初始化数据库
 * 创建必要的表和索引
 */
await initDatabase();

/**
 * 启动索引工作进程
 * 处理后台索引任务队列
 */
startIndexWorker();

/**
 * 初始化多策略搜索引擎
 * 支持向量搜索、关键词搜索、模糊搜索、依赖搜索等多种策略
 */
const anthropicApiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';
const multiStrategySearch = new MultiStrategySearch(pool, anthropicApiKey);

/**
 * 初始化 Agent 核心
 * 支持多轮对话式代码查询和分析
 */
const anthropic = new Anthropic({ apiKey: anthropicApiKey });
const agentConfig = getAgentConfig();
const agent = new AgentCore(pool, anthropic, agentConfig);
console.log('[Server] Agent initialized');

/**
 * 健康检查端点
 * GET /health
 *
 * 用途：
 * - 服务健康状态检查
 * - 负载均衡器探活
 * - 监控系统心跳检测
 *
 * @returns { ok: true, service: 'codelens-api' }
 */
fastify.get('/health', async () => {
  return { ok: true, service: 'codelens-api' };
});

/**
 * 获取所有仓库列表
 * GET /repos
 *
 * 功能：
 * - 返回所有已索引的代码仓库
 * - 按创建时间倒序排列
 * - 自动隐藏 GitLab Token（安全考虑）
 *
 * @returns 仓库列表数组
 */
fastify.get('/repos', async () => {
  const result = await pool.query('SELECT * FROM repos ORDER BY created_at DESC');
  // 隐藏 gitlab_token 以保护安全
  const repos = result.rows.map((repo: any) => ({
    ...repo,
    gitlab_token: repo.gitlab_token ? '***' : null,
  }));
  return repos;
});

/**
 * 获取单个仓库详情
 * GET /repos/:id
 *
 * @param id - 仓库 ID
 * @returns 仓库详细信息
 * @throws 404 - 仓库不存在
 */
fastify.get<{
  Params: { id: string };
}>('/repos/:id', async (request, reply) => {
  const { id } = request.params;
  const repo = await getRepo(parseInt(id));

  if (!repo) {
    return reply.code(404).send({ error: 'Repository not found' });
  }

  // 隐藏 gitlab_token 以保护安全
  return {
    ...repo,
    gitlab_token: repo.gitlab_token ? '***' : null,
  };
});

/**
 * 创建新仓库
 * POST /repos
 *
 * 功能：
 * - 创建仓库记录
 * - 自动触发索引任务
 * - 支持 GitLab 和 ZIP 两种来源
 *
 * @body name - 仓库名称
 * @body source - 来源类型：'gitlab' 或 'zip'
 * @body url - GitLab 仓库地址（source 为 gitlab 时必需）
 * @body gitlabToken - GitLab 访问令牌（可选，用于私有仓库）
 *
 * @returns { repoId, status: 'indexing' }
 * @throws 400 - 参数缺失或无效
 */
fastify.post<{
  Body: { name: string; source: 'gitlab' | 'zip'; url?: string; gitlabToken?: string };
}>('/repos', async (request, reply) => {
  const { name, source, url, gitlabToken } = request.body;

  if (!name || !source) {
    return reply.code(400).send({ error: 'Missing name or source' });
  }

  if (source === 'gitlab' && !url) {
    return reply.code(400).send({ error: 'GitLab source requires url' });
  }

  // 创建仓库记录
  const repoId = await createRepo(name, source, url, gitlabToken);

  // 将索引任务加入队列
  await enqueueIndexJob({
    repoId,
    repoName: name,
    source,
    url,
    gitlabToken,
  });

  return { repoId, status: 'indexing' };
});

/**
 * 上传 ZIP 文件创建仓库
 * POST /repos/upload
 *
 * 功能：
 * - 接收 ZIP 文件上传
 * - 保存到临时目录
 * - 创建仓库并触发索引
 *
 * 流程：
 * 1. 接收文件上传
 * 2. 保存到 /tmp 目录
 * 3. 创建仓库记录
 * 4. 触发解压和索引任务
 *
 * @returns { repoId, status: 'indexing' }
 * @throws 400 - 未上传文件
 */
fastify.post('/repos/upload', async (request, reply) => {
  const data = await request.file();

  if (!data) {
    return reply.code(400).send({ error: 'No file uploaded' });
  }

  const filename = data.filename;
  const buffer = await data.toBuffer();
  const zipPath = join('/tmp', `codelens-${Date.now()}-${filename}`);

  // 保存上传的文件
  await writeFile(zipPath, buffer);

  // 创建仓库记录
  const repoId = await createRepo(filename, 'zip');

  // 将索引任务加入队列
  await enqueueIndexJob({
    repoId,
    repoName: filename,
    source: 'zip',
    zipPath,
  });

  return { repoId, status: 'indexing' };
});

/**
 * 检查 GitLab 仓库是否已索引
 * GET /repos/check
 *
 * 功能：
 * - 检查指定的 GitLab 仓库是否已经被索引
 * - 支持检查特定分支或基础分支
 * - 用于避免重复索引
 *
 * @query gitlabUrl - GitLab 仓库 URL（必需）
 * @query branch - 分支名称（可选）
 *
 * @returns {
 *   exists: boolean,
 *   hasBaseBranch: boolean,
 *   repo?: object,
 *   baseBranch?: object
 * }
 *
 * @throws 400 - 缺少 gitlabUrl 参数
 */
fastify.get<{
  Querystring: { gitlabUrl: string; branch?: string };
}>('/repos/check', async (request, reply) => {
  const { gitlabUrl, branch } = request.query;

  if (!gitlabUrl) {
    return reply.code(400).send({ error: 'Missing gitlabUrl parameter' });
  }

  // 标准化 GitLab URL（去除尾部斜杠、统一格式）
  const normalizedUrl = normalizeGitLabUrl(gitlabUrl);

  if (branch) {
    // 检查特定分支是否存在
    const result = await pool.query(
      'SELECT id, name, status, branch, is_base_branch, parent_repo_id FROM repos WHERE gitlab_url = $1 AND branch = $2',
      [normalizedUrl, branch]
    );

    if (result.rows.length > 0) {
      return {
        exists: true,
        repo: result.rows[0]
      };
    }
  }

  // 检查基础分支是否存在
  const baseResult = await pool.query(
    'SELECT id, name, status, branch, is_base_branch, default_branch FROM repos WHERE gitlab_url = $1 AND is_base_branch = true',
    [normalizedUrl]
  );

  if (baseResult.rows.length > 0) {
    return {
      exists: true,
      hasBaseBranch: true,
      baseBranch: baseResult.rows[0]
    };
  }

  return {
    exists: false,
    hasBaseBranch: false
  };
});

/**
 * 标准化仓库名称
 * 辅助函数，用于统一仓库名称格式
 *
 * 处理逻辑：
 * 1. 去除首尾空格和尾部斜杠
 * 2. 提取路径的最后一部分（basename）
 * 3. 去除 .git 和 .zip 后缀
 * 4. 转换为小写
 *
 * @param value - 原始仓库名称
 * @returns 标准化后的名称
 *
 * 示例：
 * 'https://gitlab.com/team/project.git' => 'project'
 * 'my-repo.zip' => 'my-repo'
 */
const normalizeRepoName = (value: string) => {
  const trimmed = value.trim().replace(/\/+$/g, '');
  const baseName = trimmed.split(/[\\/]/).pop() || trimmed;
  return baseName.replace(/\.(git|zip)$/i, '').toLowerCase();
};

/**
 * 按名称检查仓库是否存在
 * GET /repos/check-by-name
 *
 * 功能：
 * - 根据仓库名称查找已索引的仓库
 * - 支持模糊匹配（忽略大小写、后缀）
 * - 只返回状态为 'ready' 的仓库
 *
 * 匹配规则：
 * - 忽略 .git 和 .zip 后缀
 * - 忽略路径前缀（只匹配 basename）
 * - 大小写不敏感
 *
 * @query name - 仓库名称（必需）
 *
 * @returns {
 *   exists: boolean,
 *   repos: Array<object>
 * }
 *
 * @throws 400 - 缺少 name 参数
 */
fastify.get<{
  Querystring: { name: string };
}>('/repos/check-by-name', async (request, reply) => {
  const { name } = request.query;

  if (!name) {
    return reply.code(400).send({ error: 'Missing name parameter' });
  }

  const normalizedInput = normalizeRepoName(name);
  console.log('[check-by-name] Input name:', name);
  console.log('[check-by-name] Normalized input:', normalizedInput);

  // 调试：查看所有仓库
  const allRepos = await pool.query('SELECT id, name, status FROM repos');
  console.log('[check-by-name] All repos:', allRepos.rows);

  // 搜索匹配的仓库（忽略大小写和后缀）
  const result = await pool.query(
    `SELECT id, name, status, branch, gitlab_url,
            LOWER(REGEXP_REPLACE(name, '\\.(git|zip)$', '', 'i')) as normalized_name,
            LOWER(REGEXP_REPLACE(REGEXP_REPLACE(name, '^.*/', ''), '\\.(git|zip)$', '', 'i')) as normalized_basename
     FROM repos
     WHERE (
        LOWER(REGEXP_REPLACE(name, '\\.(git|zip)$', '', 'i')) = $1
        OR LOWER(REGEXP_REPLACE(REGEXP_REPLACE(name, '^.*/', ''), '\\.(git|zip)$', '', 'i')) = $1
        OR LOWER(name) = $1
     )
     AND status = $2`,
    [normalizedInput, 'ready']
  );

  console.log('[check-by-name] Query result:', result.rows);

  if (result.rows.length > 0) {
    return {
      exists: true,
      repos: result.rows
    };
  }

  return {
    exists: false,
    repos: []
  };
});

/**
 * 从 GitLab 创建基础分支索引
 * POST /repos/from-gitlab
 *
 * 功能：
 * - 从 GitLab 仓库创建基础分支索引
 * - 自动获取默认分支（main/master）
 * - 支持私有仓库（通过 token）
 *
 * 基础分支索引说明：
 * - 基础分支是其他分支索引的参照基准
 * - 其他分支可以基于基础分支进行增量索引（只索引差异）
 * - 通常使用 main 或 master 分支作为基础分支
 *
 * @body gitlabUrl - GitLab 仓库 URL（必需）
 * @body gitlabToken - GitLab 访问令牌（可选，私有仓库需要）
 * @body branch - 分支名称（可选，默认使用仓库的默认分支）
 *
 * @returns {
 *   repoId: number,
 *   status: 'indexing' | 'already_exists',
 *   branch: string
 * }
 *
 * @throws 400 - 缺少 gitlabUrl
 */
fastify.post<{
  Body: { gitlabUrl: string; gitlabToken?: string; branch?: string };
}>('/repos/from-gitlab', async (request, reply) => {
  const { gitlabUrl, gitlabToken, branch } = request.body;

  if (!gitlabUrl) {
    return reply.code(400).send({ error: 'Missing gitlabUrl' });
  }

  const normalizedUrl = normalizeGitLabUrl(gitlabUrl);

  // 从 GitLab API 获取默认分支
  const defaultBranch = branch || await getGitLabDefaultBranch(gitlabUrl, gitlabToken);

  // 检查是否已存在
  const existing = await pool.query(
    'SELECT id FROM repos WHERE gitlab_url = $1 AND branch = $2',
    [normalizedUrl, defaultBranch]
  );

  if (existing.rows.length > 0) {
    return {
      repoId: existing.rows[0].id,
      status: 'already_exists',
      branch: defaultBranch
    };
  }

  // 创建仓库记录
  const projectName = extractProjectName(gitlabUrl);
  const result = await pool.query(
    `INSERT INTO repos (name, source, url, gitlab_url, branch, is_base_branch, default_branch, gitlab_token, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     RETURNING id`,
    [projectName, 'gitlab', gitlabUrl, normalizedUrl, defaultBranch, true, defaultBranch, gitlabToken, 'indexing']
  );

  const repoId = result.rows[0].id;

  // 将索引任务加入队列
  await enqueueIndexJob({
    repoId,
    repoName: projectName,
    source: 'gitlab',
    url: gitlabUrl,
    branch: defaultBranch,
    gitlabToken
  });

  return {
    repoId,
    status: 'indexing',
    branch: defaultBranch
  };
});

/**
 * 创建分支索引（基于基础分支的增量索引）
 * POST /repos/branch-index
 *
 * 功能：
 * - 为指定分支创建增量索引
 * - 只索引与基础分支的差异部分
 * - 显著减少索引时间和存储空间
 *
 * 增量索引原理：
 * 1. 使用 git diff 找出分支与基础分支的差异文件
 * 2. 只对变更的文件进行 AST 解析和向量化
 * 3. 搜索时合并基础分支和当前分支的结果
 *
 * 使用场景：
 * - 为 feature 分支创建索引
 * - 为 PR/MR 分支创建索引
 * - 快速索引开发分支
 *
 * @body gitlabUrl - GitLab 仓库 URL（必需）
 * @body branch - 分支名称（必需）
 * @body gitlabToken - GitLab 访问令牌（可选）
 *
 * @returns {
 *   repoId: number,
 *   status: 'indexing' | 'already_exists',
 *   branch: string,
 *   baseBranch: string
 * }
 *
 * @throws 400 - 缺少参数或基础分支未索引
 */
fastify.post<{
  Body: { gitlabUrl: string; branch: string; gitlabToken?: string };
}>('/repos/branch-index', async (request, reply) => {
  const { gitlabUrl, branch, gitlabToken } = request.body;

  if (!gitlabUrl || !branch) {
    return reply.code(400).send({ error: 'Missing gitlabUrl or branch' });
  }

  const normalizedUrl = normalizeGitLabUrl(gitlabUrl);

  // 检查基础分支是否存在
  const baseResult = await pool.query(
    'SELECT id, branch FROM repos WHERE gitlab_url = $1 AND is_base_branch = true',
    [normalizedUrl]
  );

  if (baseResult.rows.length === 0) {
    return reply.code(400).send({ error: 'Base branch not indexed yet' });
  }

  const baseRepoId = baseResult.rows[0].id;
  const baseBranch = baseResult.rows[0].branch;

  // 检查分支是否已存在
  const existing = await pool.query(
    'SELECT id FROM repos WHERE gitlab_url = $1 AND branch = $2',
    [normalizedUrl, branch]
  );

  if (existing.rows.length > 0) {
    return {
      repoId: existing.rows[0].id,
      status: 'already_exists',
      branch
    };
  }

  // 创建分支索引记录
  const projectName = extractProjectName(gitlabUrl);
  const result = await pool.query(
    `INSERT INTO repos (name, source, url, gitlab_url, branch, is_base_branch, parent_repo_id, gitlab_token, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     RETURNING id`,
    [projectName, 'gitlab', gitlabUrl, normalizedUrl, branch, false, baseRepoId, gitlabToken, 'indexing']
  );

  const repoId = result.rows[0].id;

  // 将索引任务加入队列，包含基础分支信息用于 diff 计算
  await enqueueIndexJob({
    repoId,
    repoName: projectName,
    source: 'gitlab',
    url: gitlabUrl,
    branch,
    baseBranch,
    baseRepoId,
    gitlabToken
  });

  return {
    repoId,
    status: 'indexing',
    branch,
    baseBranch
  };
});

/**
 * 增量索引指定文件
 * POST /repos/:id/incremental-index
 *
 * 功能：
 * - 只重新索引指定的文件列表
 * - 适用于文件变更后的快速更新
 * - 避免全量重新索引
 *
 * 使用场景：
 * - Git hook 触发的文件变更索引
 * - IDE 保存文件后的实时索引
 * - 持续集成中的增量更新
 *
 * @param id - 仓库 ID
 * @body files - 需要重新索引的文件路径数组
 *
 * @returns {
 *   jobId: string,
 *   status: 'indexing',
 *   filesCount: number
 * }
 *
 * @throws 400 - 参数无效
 * @throws 404 - 仓库不存在
 */
fastify.post<{
  Params: { id: string };
  Body: { files: string[] };
}>('/repos/:id/incremental-index', async (request, reply) => {
  const repoId = parseInt(request.params.id);
  const { files } = request.body;

  if (!files || !Array.isArray(files) || files.length === 0) {
    return reply.code(400).send({ error: 'Missing or invalid files array' });
  }

  const repo = await getRepo(repoId);
  if (!repo) {
    return reply.code(404).send({ error: 'Repository not found' });
  }

  // 根据来源确定仓库路径
  const repoPath = `/tmp/codelens-repos/${repoId}`;

  const jobId = await enqueueIncrementalIndexJob({
    repoId,
    repoPath,
    files,
  });

  return { jobId, status: 'indexing', filesCount: files.length };
});

/**
 * 刷新 GitLab 仓库
 * POST /repos/:id/refresh
 *
 * 功能：
 * - 拉取最新代码
 * - 增量更新索引（只处理变更的文件）
 * - 保留现有索引数据
 *
 * 与 reindex 的区别：
 * - refresh: 增量更新，保留现有数据，只更新变更部分
 * - reindex: 全量重建，清空所有数据，重新索引
 *
 * 使用场景：
 * - 定期同步远程仓库的更新
 * - 手动触发代码更新
 * - Webhook 触发的自动更新
 *
 * @param id - 仓库 ID
 *
 * @returns {
 *   jobId: string,
 *   status: 'refreshing'
 * }
 *
 * @throws 400 - 仓库类型不支持或正在索引中
 * @throws 404 - 仓库不存在
 */
fastify.post<{
  Params: { id: string };
}>('/repos/:id/refresh', async (request, reply) => {
  const repoId = parseInt(request.params.id);

  const repo = await getRepo(repoId);
  if (!repo) {
    return reply.code(404).send({ error: 'Repository not found' });
  }

  if (repo.source !== 'gitlab') {
    return reply.code(400).send({ error: 'Only GitLab repositories can be refreshed' });
  }

  if (!repo.url) {
    return reply.code(400).send({ error: 'Repository URL not found' });
  }

  if (repo.status === 'indexing') {
    return reply.code(400).send({ error: 'Repository is currently being indexed' });
  }

  // 允许刷新失败状态的仓库 - refresh 函数会处理重新克隆

  // 清空查询缓存（重要：避免返回过期的搜索结果）
  console.log('Clearing query cache after refresh');
  clearAllCaches();

  // 更新状态为索引中
  await pool.query('UPDATE repos SET status = $1 WHERE id = $2', ['indexing', repoId]);

  const jobId = await enqueueRefreshJob({
    repoId,
    url: repo.url,
    gitlabToken: repo.gitlab_token,
  });

  return { jobId, status: 'refreshing' };
});

/**
 * 重新索引仓库（清空所有数据并重新开始）
 * POST /repos/:id/reindex
 *
 * 功能：
 * - 清空所有现有索引数据
 * - 从头开始重新索引
 * - 适用于索引损坏或需要完全重建的情况
 *
 * 清空的数据包括：
 * - 文件记录
 * - 代码块（chunks）
 * - 向量嵌入
 * - 调用图（call graph）
 * - 依赖关系
 *
 * 使用场景：
 * - 索引数据损坏
 * - 索引算法升级
 * - 向量维度变更
 * - 数据不一致修复
 *
 * 注意：
 * - ZIP 仓库不支持重新索引（需要重新上传）
 * - 重新索引会清空所有缓存
 * - 过程可能耗时较长
 *
 * @param id - 仓库 ID
 *
 * @returns {
 *   jobId: string,
 *   status: 'reindexing'
 * }
 *
 * @throws 400 - 仓库正在索引中或不支持重新索引
 * @throws 404 - 仓库不存在
 */
fastify.post<{
  Params: { id: string };
}>('/repos/:id/reindex', async (request, reply) => {
  const repoId = parseInt(request.params.id);

  const repo = await getRepo(repoId);
  if (!repo) {
    return reply.code(404).send({ error: 'Repository not found' });
  }

  if (repo.status === 'indexing') {
    return reply.code(400).send({ error: 'Repository is currently being indexed' });
  }

  // 清空所有现有数据
  console.log(`Clearing data for repo ${repoId}`);
  await clearRepoData(repoId);

  // 清空查询缓存（重要：避免返回过期的搜索结果）
  console.log('Clearing query cache after reindex');
  clearAllCaches();

  // 更新状态为索引中
  await pool.query('UPDATE repos SET status = $1 WHERE id = $2', ['indexing', repoId]);

  // 根据来源类型将索引任务加入队列
  let jobId;
  if (repo.source === 'gitlab') {
    if (!repo.url) {
      return reply.code(400).send({ error: 'Repository URL not found' });
    }
    jobId = await enqueueReindexJob({
      repoId,
      url: repo.url,
      gitlabToken: repo.gitlab_token,
    });
  } else {
    // ZIP 仓库不支持重新索引（原始 zip 文件路径不可用）
    return reply.code(400).send({ error: 'Re-indexing ZIP repositories is not supported. Please upload again.' });
  }

  return { jobId, status: 'reindexing' };
});

/**
 * 删除仓库
 * DELETE /repos/:id
 *
 * 功能：
 * - 删除仓库记录
 * - 级联删除所有相关数据（文件、代码块、向量等）
 *
 * 注意：
 * - 正在索引的仓库不能删除
 * - 删除操作不可逆
 * - 数据库外键级联会自动清理相关数据
 *
 * @param id - 仓库 ID
 *
 * @returns {
 *   success: true,
 *   message: 'Repository deleted'
 * }
 *
 * @throws 400 - 仓库正在索引中
 * @throws 404 - 仓库不存在
 */
fastify.delete<{
  Params: { id: string };
}>('/repos/:id', async (request, reply) => {
  const repoId = parseInt(request.params.id);

  const repo = await getRepo(repoId);
  if (!repo) {
    return reply.code(404).send({ error: 'Repository not found' });
  }

  if (repo.status === 'indexing') {
    return reply.code(400).send({ error: 'Cannot delete repository while indexing' });
  }

  // 删除仓库（级联删除所有相关数据）
  await pool.query('DELETE FROM repos WHERE id = $1', [repoId]);

  return { success: true, message: 'Repository deleted' };
});

/**
 * 获取索引进度
 * GET /repos/:id/progress
 *
 * 功能：
 * - 实时查询索引任务的进度
 * - 计算完成百分比
 * - 估算剩余时间
 *
 * 进度信息包括：
 * - total: 总文件数
 * - processed: 已处理文件数
 * - percentComplete: 完成百分比
 * - estimatedTimeRemaining: 预计剩余时间（秒）
 * - phase: 当前阶段（如：parsing、embedding）
 *
 * 时间估算算法：
 * - 基于已处理文件的平均耗时
 * - 添加 20% 的缓冲以应对波动
 * - 至少处理 10 个文件后才开始估算
 *
 * @param id - 仓库 ID
 *
 * @returns {
 *   status: string,
 *   progress: {
 *     total: number,
 *     processed: number,
 *     percentComplete: number,
 *     estimatedTimeRemaining: number | null,
 *     startTime: Date,
 *     phase: string
 *   } | null
 * }
 *
 * @throws 404 - 仓库不存在
 */
fastify.get<{
  Params: { id: string };
}>('/repos/:id/progress', async (request, reply) => {
  const repoId = parseInt(request.params.id);

  const repo = await getRepo(repoId);
  if (!repo) {
    return reply.code(404).send({ error: 'Repository not found' });
  }

  const progress = await getIndexProgress(repoId);
  if (!progress) {
    return { status: repo.status, progress: null };
  }

  const { total, processed, startTime, phase } = progress;

  // 计算预计剩余时间
  let estimatedTimeRemaining = null;
  let percentComplete = 0;

  if (total > 0) {
    percentComplete = Math.floor((processed / total) * 100);

    if (processed > 10 && startTime) { // 至少处理 10 个文件后才估算
      const elapsedMs = Date.now() - startTime.getTime();
      const msPerFile = elapsedMs / processed;
      const remainingFiles = total - processed;

      // 使用更保守的估算，添加 20% 的缓冲以应对波动
      const estimatedMs = msPerFile * remainingFiles * 1.2;
      estimatedTimeRemaining = Math.round(estimatedMs / 1000); // 转换为秒
    }
  }

  return {
    status: repo.status,
    progress: {
      total,
      processed,
      percentComplete,
      estimatedTimeRemaining, // 单位：秒
      startTime,
      phase,
    },
  };
});

/**
 * 管理员端点：重置仓库状态（临时调试用）
 * POST /repos/:id/reset-status
 *
 * 功能：
 * - 手动修改仓库状态
 * - 用于调试和故障恢复
 *
 * 注意：这是临时端点，生产环境应该移除或添加认证
 *
 * @param id - 仓库 ID
 * @body status - 新状态：'ready' | 'failed' | 'indexing'
 *
 * @returns { message, repoId, status }
 * @throws 400 - 状态值无效
 */
fastify.post<{
  Params: { id: string };
  Body: { status: string };
}>('/repos/:id/reset-status', async (request, reply) => {
  const repoId = parseInt(request.params.id);
  const { status } = request.body;

  if (!['ready', 'failed', 'indexing'].includes(status)) {
    return reply.code(400).send({ error: 'Invalid status' });
  }

  await pool.query('UPDATE repos SET status = $1 WHERE id = $2', [status, repoId]);
  return { message: 'Status updated', repoId, status };
});

/**
 * 管理员端点：迁移向量维度
 * POST /admin/migrate-vector-dimension
 *
 * 功能：
 * - 将向量维度从 1024 迁移到 1536
 * - 重建向量索引
 * - 清空现有嵌入数据
 *
 * 迁移步骤：
 * 1. 删除现有向量索引
 * 2. 删除旧的 embedding 列
 * 3. 创建新的 1536 维 embedding 列
 * 4. 重建 HNSW 索引
 *
 * 注意：
 * - 迁移后需要重新索引所有仓库
 * - 所有现有的向量嵌入会被清空
 * - 这是一次性操作，谨慎使用
 *
 * @returns {
 *   success: boolean,
 *   message: string
 * }
 *
 * @throws 500 - 迁移失败
 */
fastify.post('/admin/migrate-vector-dimension', async (request, reply) => {
  try {
    console.log('Starting migration: changing embedding vector dimension from 1024 to 1536...');

    // 删除索引
    console.log('Dropping index...');
    await pool.query('DROP INDEX IF EXISTS idx_code_chunks_embedding');
    await pool.query('DROP INDEX IF EXISTS idx_code_chunks_embedding_hnsw');

    // 删除旧的 embedding 列
    console.log('Dropping old embedding column...');
    await pool.query('ALTER TABLE code_chunks DROP COLUMN IF EXISTS embedding');

    // 添加新的 1536 维 embedding 列
    console.log('Adding new embedding column with 1536 dimensions...');
    await pool.query('ALTER TABLE code_chunks ADD COLUMN embedding vector(1536)');

    // 重建索引（使用 HNSW 索引以获得更好的性能）
    console.log('Recreating HNSW index...');
    await pool.query('CREATE INDEX idx_code_chunks_embedding_hnsw ON code_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)');

    console.log('Migration completed successfully!');

    return {
      success: true,
      message: 'Vector dimension migrated from 1024 to 1536. All existing embeddings have been cleared. You need to re-index your repositories.'
    };
  } catch (error: any) {
    console.error('Migration failed:', error);
    return reply.code(500).send({ error: 'Migration failed', details: error.message });
  }
});

/**
 * 代码搜索端点
 * GET /search
 *
 * 功能：
 * - 支持多种搜索策略（关键词、向量、URL、多策略）
 * - 自动检测查询类型（URL 或普通查询）
 * - 结果缓存以提升性能
 *
 * 搜索策略：
 * 1. URL 搜索：检测到 URL 格式时，使用专门的 URL 搜索
 * 2. 多策略搜索（strategy=multi）：结合向量、精确匹配、模糊匹配、依赖搜索
 * 3. 增强搜索（enhanced=true）：使用查询改写和重排序
 * 4. 默认搜索：关键词搜索 + 语义向量搜索
 *
 * 缓存机制：
 * - 使用 TTL 缓存（15 分钟）
 * - 缓存键包含 repoId、查询、策略等参数
 * - 命中缓存时直接返回，避免重复计算
 *
 * @query repoId - 仓库 ID（必需）
 * @query q - 查询字符串（必需）
 * @query enhanced - 是否使用增强搜索（可选，默认 false）
 * @query strategy - 搜索策略：'default' | 'multi'（可选）
 *
 * @returns {
 *   query: string,
 *   hits: Array<{
 *     id: number,
 *     file_path: string,
 *     line_start: number,
 *     line_end: number,
 *     content: string,
 *     score: number,
 *     symbol_name: string,
 *     metadata: object
 *   }>,
 *   enhanced: boolean,
 *   strategy: string
 * }
 *
 * @throws 400 - 缺少必需参数
 */
fastify.get<{
  Querystring: { repoId: string; q: string; enhanced?: string; strategy?: string };
}>('/search', async (request, reply) => {
  const { repoId, q, enhanced, strategy } = request.query;

  if (!repoId || !q) {
    return reply.code(400).send({ error: 'Missing repoId or q' });
  }

  // 先检查缓存
  const cacheKey = generateCacheKey('search', repoId, q, enhanced || 'false', strategy || 'default');
  const cached = searchTTLCache.get(cacheKey);
  if (cached) {
    console.log('Search cache hit');
    return cached;
  }

  let unique;

  // 检测查询是否为 URL
  const isURL = q.match(/^https?:\/\//) || q.match(/\/[a-z]+\/[a-z]+/i);

  // 对 URL 查询使用专门的 URL 搜索
  if (isURL) {
    console.log('Detected URL query, using specialized URL search');
    const { searchURL } = await import('./llm/url-search.js');
    const urlResults = await searchURL(pool, parseInt(repoId), q, 20);

    // 转换为统一格式
    unique = urlResults.map((result) => ({
      id: result.id,
      file_path: result.filePath,
      line_start: result.lineStart,
      line_end: result.lineEnd,
      content: result.content,
      code_text: result.content,
      score: result.score,
      symbol_name: result.context.constantName,
      metadata: result.context,
    }));
  } else if (strategy === 'multi') {
    console.log('Using multi-strategy search (vector + exact + fuzzy + dependency)');
    const searchResults = await multiStrategySearch.search(parseInt(repoId), q, {
      limit: 20,
      threshold: 0.3,
      strategies: ['vector', 'exact', 'fuzzy', 'dependency'],
      includeContext: true,
      followDependencies: false,
    });

    // 转换为统一格式
    unique = searchResults.map((result) => ({
      id: result.id,
      file_path: result.filePath,
      line_start: result.lineStart,
      line_end: result.lineEnd,
      content: result.content,
      score: result.score,
      symbol_name: result.context.symbolName,
      metadata: result.metadata,
    }));
  } else if (enhanced === 'true') {
    console.log('Using enhanced search with query rewriting and reranking');
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '';
    const multiSearch = new MultiStrategySearch(pool, anthropicApiKey);
    const results = await multiSearch.search(parseInt(repoId), q, { limit: 20 });
    unique = results.map(r => ({
      file_path: r.filePath,
      line_start: r.lineStart,
      line_end: r.lineEnd,
      code: r.content,
      symbol_name: r.context.symbolName || '',
      symbol_type: r.type || 'unknown',
      score: r.score,
    }));
  } else {
    // 原始搜索逻辑：关键词搜索 + 语义搜索
    const keywordResults = await searchByKeyword(parseInt(repoId), q);
    const embedding = await generateEmbedding(q);
    const semanticResults = await searchByEmbedding(parseInt(repoId), embedding, 10);

    // 合并结果并去重
    const combined = [...keywordResults, ...semanticResults];
    unique = Array.from(new Map(combined.map((item) => [item.id, item])).values()).slice(0, 20);
  }

  const result = {
    query: q,
    hits: unique,
    enhanced: enhanced === 'true',
    strategy: strategy || 'default',
  };

  // 缓存结果
  searchTTLCache.set(cacheKey, result);

  return result;
});

/**
 * 智能问答端点
 * POST /ask
 *
 * 功能：
 * - 基于代码上下文回答用户问题
 * - 自动搜索相关代码作为证据
 * - 利用历史问答反馈提升答案质量
 * - 支持多种搜索策略
 *
 * 工作流程：
 * 1. 检查缓存，命中则直接返回
 * 2. 根据查询类型选择搜索策略（URL/多策略/增强/默认）
 * 3. 搜索相关代码片段作为证据
 * 4. 获取相似历史问题的反馈
 * 5. 使用 LLM 生成答案
 * 6. 保存问答记录到数据库
 * 7. 缓存结果
 *
 * 搜索策略：
 * - URL 搜索：针对 URL 格式的查询
 * - 多策略搜索：结合向量、精确匹配、依赖分析
 * - 增强搜索：使用查询改写和重排序
 * - 默认搜索：语义向量搜索
 *
 * @body repoId - 仓库 ID（必需）
 * @body query - 用户问题（必需）
 * @body enhanced - 是否使用增强搜索（可选，默认 true）
 * @body strategy - 搜索策略（可选，默认 'enhanced'）
 *
 * @returns {
 *   questionId: number,
 *   query: string,
 *   answer: string,
 *   evidence: Array<CodeChunk>,
 *   historicalFeedback?: Array<Feedback>,
 *   enhanced: boolean,
 *   strategy: string
 * }
 *
 * @throws 400 - 缺少必需参数
 * @throws 404 - 仓库不存在
 */
fastify.post<{
  Body: { repoId: number; query: string; enhanced?: boolean; strategy?: string };
}>('/ask', async (request, reply) => {
  const { repoId, query, enhanced = true, strategy = 'enhanced' } = request.body;

  if (!repoId || !query) {
    return reply.code(400).send({ error: 'Missing repoId or query' });
  }

  // 验证仓库是否存在
  const repo = await getRepo(repoId);
  if (!repo) {
    return reply.code(404).send({ error: `Repository with id ${repoId} not found` });
  }

  // 先检查缓存
  const cacheKey = generateCacheKey('ask', repoId.toString(), query, enhanced.toString(), strategy);
  const cached = searchTTLCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let evidence;

  // 检测查询是否为 URL
  const isURL = query.match(/^https?:\/\//) || query.match(/\/[a-z]+\/[a-z]+/i);

  // 对 URL 查询使用专门的 URL 搜索
  if (isURL) {
    console.log('Detected URL query in /ask, using specialized URL search');
    const { searchURL } = await import('./llm/url-search.js');
    const urlResults = await searchURL(pool, repoId, query, 10);

    // 转换为统一格式
    evidence = urlResults.map((result, index) => ({
      id: index + 1,
      file_id: 0,
      file_path: result.filePath,
      line_start: result.lineStart,
      line_end: result.lineEnd,
      content: result.content,
      code_text: result.content,
      symbol_name: result.context.constantName || '',
      symbol_type: result.type || 'unknown',
      score: result.score,
    })) as any;
  } else if (strategy === 'multi') {
    console.log('Using multi-strategy search for Q&A');
    const searchResults = await multiStrategySearch.search(repoId, query, {
      limit: 10,
      threshold: 0.3,
      strategies: ['vector', 'exact', 'dependency'],
      includeContext: true,
      followDependencies: true, // 跟踪依赖关系，获取更完整的上下文
    });

    // 转换为统一格式，包含必需字段
    evidence = searchResults.map((result) => ({
      id: parseInt(result.id.split(':')[1]) || 0, // 从 "table:id" 格式提取数字 ID
      file_id: 0, // 占位符
      file_path: result.filePath,
      line_start: result.lineStart,
      line_end: result.lineEnd,
      content: result.content,
      code_text: result.content,
      symbol_name: result.context.symbolName || '',
      symbol_type: result.metadata?.nodeType || 'unknown',
      score: result.score,
    })) as any;
  } else if (enhanced) {
    console.log('Using enhanced search for Q&A');
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '';
    const multiSearch = new MultiStrategySearch(pool, anthropicApiKey);
    const results = await multiSearch.search(repoId, query, { limit: 10 });
    evidence = results.map((r, index) => ({
      id: index + 1, // 为每个结果生成唯一 ID
      file_id: 0, // 占位符
      file_path: r.filePath,
      line_start: r.lineStart,
      line_end: r.lineEnd,
      content: r.content,
      code_text: r.content,
      symbol_name: r.context.symbolName || '',
      symbol_type: r.type || 'unknown',
      score: r.score,
    })) as any;
  } else {
    // 原始搜索逻辑：语义向量搜索
    const embedding = await generateEmbedding(query);
    evidence = await searchByEmbedding(repoId, embedding, 10);
  }

  // 获取相似历史问题的反馈（用于改进答案质量）
  const historicalFeedback = await getSimilarQuestionsWithFeedback(repoId, query, 3);

  // 使用 LLM 生成答案
  const answer = await answerQuestion(query, evidence, historicalFeedback);

  // 保存问答记录到数据库
  const questionResult = await pool.query(
    'INSERT INTO questions (repo_id, query, answer, evidence_ids) VALUES ($1, $2, $3, $4) RETURNING id',
    [repoId, query, answer, evidence.map((e: any) => e.id)]
  );

  const questionId = questionResult.rows[0].id;

  const result = {
    questionId,
    query,
    answer,
    evidence,
    historicalFeedback: historicalFeedback.length > 0 ? historicalFeedback : undefined,
    enhanced,
    strategy,
  };

  // 缓存结果
  searchTTLCache.set(cacheKey, result);

  return result;
});

/**
 * 根因分析端点
 * POST /root-cause
 *
 * 功能：
 * - 深度分析代码问题的根本原因
 * - 追踪依赖关系和调用链
 * - 提供更全面的代码上下文
 *
 * 与 /ask 的区别：
 * - /ask: 快速问答，返回 10 个证据
 * - /root-cause: 深度分析，返回 15 个证据，包含更多策略（图分析）
 *
 * 搜索策略：
 * - 多策略模式：向量、精确匹配、模糊匹配、依赖分析、图分析
 * - 跟踪依赖关系：自动展开相关的函数调用和依赖
 * - 更高的证据数量：15 个代码片段
 *
 * 使用场景：
 * - Bug 根因定位
 * - 性能问题分析
 * - 代码逻辑追踪
 * - 复杂问题诊断
 *
 * @body repoId - 仓库 ID（必需）
 * @body query - 问题描述（必需）
 * @body enhanced - 是否使用增强搜索（可选，默认 true）
 * @body strategy - 搜索策略（可选，默认 'enhanced'）
 *
 * @returns {
 *   query: string,
 *   rootCause: string,
 *   evidence: Array<CodeChunk>,
 *   enhanced: boolean,
 *   strategy: string
 * }
 *
 * @throws 400 - 缺少必需参数
 * @throws 404 - 仓库不存在
 */
fastify.post<{
  Body: { repoId: number; query: string; enhanced?: boolean; strategy?: string };
}>('/root-cause', async (request, reply) => {
  const { repoId, query, enhanced = true, strategy = 'enhanced' } = request.body;

  if (!repoId || !query) {
    return reply.code(400).send({ error: 'Missing repoId or query' });
  }

  // 验证仓库是否存在
  const repo = await getRepo(repoId);
  if (!repo) {
    return reply.code(404).send({ error: `Repository with id ${repoId} not found` });
  }

  let evidence;

  // 使用多策略搜索进行全面的根因分析
  if (strategy === 'multi') {
    console.log('Using multi-strategy search for root cause analysis');
    const searchResults = await multiStrategySearch.search(repoId, query, {
      limit: 15,
      threshold: 0.3,
      strategies: ['vector', 'exact', 'fuzzy', 'dependency', 'graph'], // 包含图分析
      includeContext: true,
      followDependencies: true, // 跟踪依赖关系
    });

    // 转换为统一格式，包含必需字段
    evidence = searchResults.map((result) => ({
      id: parseInt(result.id.split(':')[1]) || 0, // 从 "table:id" 格式提取数字 ID
      file_id: 0, // 占位符
      file_path: result.filePath,
      line_start: result.lineStart,
      line_end: result.lineEnd,
      content: result.content,
      code_text: result.content,
      symbol_name: result.context.symbolName || '',
      symbol_type: result.metadata?.nodeType || 'unknown',
      score: result.score,
    })) as any;
  } else if (enhanced) {
    console.log('Using enhanced search for root cause analysis');
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '';
    const multiSearch = new MultiStrategySearch(pool, anthropicApiKey);
    const results = await multiSearch.search(repoId, query, { limit: 15 });
    evidence = results.map((r, index) => ({
      id: index + 1, // 为每个结果生成唯一 ID
      file_id: 0, // 占位符
      file_path: r.filePath,
      line_start: r.lineStart,
      line_end: r.lineEnd,
      content: r.content,
      code_text: r.content,
      symbol_name: r.context.symbolName || '',
      symbol_type: r.type || 'unknown',
      score: r.score,
    })) as any;
  } else {
    // 原始搜索逻辑：语义向量搜索
    const embedding = await generateEmbedding(query);
    evidence = await searchByEmbedding(repoId, embedding, 15);
  }

  // 使用 LLM 进行根因分析
  const rootCause = await analyzeRootCause(query, evidence);

  return {
    query,
    rootCause,
    evidence,
    enhanced,
    strategy,
  };
});

/**
 * 获取历史问题列表
 * GET /questions
 *
 * 功能：
 * - 返回最近的 50 个问答记录
 * - 按创建时间倒序排列
 *
 * 使用场景：
 * - 查看问答历史
 * - 分析常见问题
 * - 问答质量评估
 *
 * @returns Array<QuestionRecord>
 */
fastify.get('/questions', async () => {
  const result = await pool.query('SELECT * FROM questions ORDER BY created_at DESC LIMIT 50');
  return result.rows;
});

/**
 * 添加问题反馈
 * POST /questions/feedback
 *
 * 功能：
 * - 为问答添加用户反馈
 * - 标记答案是否有帮助
 * - 用于改进未来的答案质量
 *
 * 反馈机制：
 * - 收集用户对答案的评价
 * - 存储反馈文本和有用性标记
 * - 在生成新答案时参考历史反馈
 *
 * @body questionId - 问题 ID（必需）
 * @body feedbackText - 反馈文本（必需）
 * @body isHelpful - 是否有帮助（必需）
 *
 * @returns {
 *   feedbackId: number,
 *   success: true
 * }
 *
 * @throws 400 - 缺少必需参数
 */
fastify.post<{
  Body: { questionId: number; feedbackText: string; isHelpful: boolean };
}>('/questions/feedback', async (request, reply) => {
  const { questionId, feedbackText, isHelpful } = request.body;

  if (!questionId || !feedbackText) {
    return reply.code(400).send({ error: 'Missing questionId or feedbackText' });
  }

  const feedbackId = await addQuestionFeedback(questionId, feedbackText, isHelpful);

  return { feedbackId, success: true };
});

/**
 * 获取问题的反馈
 * GET /questions/feedback
 *
 * 功能：
 * - 查询指定问题的所有反馈
 *
 * @query questionId - 问题 ID（必需）
 *
 * @returns {
 *   feedback: Array<Feedback>
 * }
 *
 * @throws 400 - 缺少 questionId 参数
 */
fastify.get<{
  Querystring: { questionId: string };
}>('/questions/feedback', async (request, reply) => {
  const { questionId } = request.query;

  if (!questionId) {
    return reply.code(400).send({ error: 'Missing questionId' });
  }

  const feedback = await getQuestionFeedback(parseInt(questionId));

  return { feedback };
});

/**
 * 获取符号的调用图
 * GET /call-graph
 *
 * 功能：
 * - 查询指定符号的调用关系
 * - 返回该符号调用了哪些函数（出边）
 * - 返回哪些函数调用了该符号（入边）
 *
 * 调用图说明：
 * - 出边（calls）：当前符号调用的其他符号
 * - 入边（calledBy）：调用当前符号的其他符号
 * - 用于理解代码的依赖关系和影响范围
 *
 * 使用场景：
 * - 分析函数的调用链
 * - 评估代码变更的影响范围
 * - 理解模块间的依赖关系
 * - 重构时的影响分析
 *
 * @query repoId - 仓库 ID（必需）
 * @query symbolName - 符号名称（必需）
 *
 * @returns {
 *   symbol: {
 *     name: string,
 *     type: string,
 *     file: string
 *   },
 *   calls: Array<{
 *     name: string,
 *     type: string,
 *     file: string
 *   }>,
 *   calledBy: Array<{
 *     name: string,
 *     type: string,
 *     file: string
 *   }>
 * }
 *
 * @throws 400 - 缺少必需参数
 * @throws 404 - 符号不存在
 * @throws 500 - 查询失败
 */
fastify.get<{
  Querystring: { repoId: string; symbolName: string };
}>('/call-graph', async (request, reply) => {
  const { repoId, symbolName } = request.query;

  if (!repoId || !symbolName) {
    return reply.code(400).send({ error: 'Missing repoId or symbolName' });
  }

  try {
    // 查找符号
    const symbolResult = await pool.query(
      `SELECT c.id, c.symbol_name, c.symbol_type, f.path as file_path
       FROM code_chunks c
       JOIN files f ON c.file_id = f.id
       WHERE f.repo_id = $1 AND c.symbol_name = $2
       LIMIT 1`,
      [parseInt(repoId), symbolName]
    );

    if (symbolResult.rows.length === 0) {
      return reply.code(404).send({ error: 'Symbol not found' });
    }

    const symbol = symbolResult.rows[0];

    // 获取出边调用（该符号调用了哪些符号）
    const outgoingResult = await pool.query(
      `SELECT DISTINCT cg.to_symbol, c2.symbol_type, f2.path as file_path
       FROM call_graph cg
       LEFT JOIN code_chunks c2 ON c2.symbol_name = cg.to_symbol
       LEFT JOIN files f2 ON c2.file_id = f2.id
       WHERE cg.from_chunk_id = $1 AND f2.repo_id = $2`,
      [symbol.id, parseInt(repoId)]
    );

    // 获取入边调用（哪些符号调用了该符号）
    const incomingResult = await pool.query(
      `SELECT DISTINCT c.symbol_name, c.symbol_type, f.path as file_path
       FROM call_graph cg
       JOIN code_chunks c ON cg.from_chunk_id = c.id
       JOIN files f ON c.file_id = f.id
       WHERE cg.to_symbol = $1 AND f.repo_id = $2`,
      [symbolName, parseInt(repoId)]
    );

    return {
      symbol: {
        name: symbol.symbol_name,
        type: symbol.symbol_type,
        file: symbol.file_path,
      },
      calls: outgoingResult.rows.map((row: any) => ({
        name: row.to_symbol,
        type: row.symbol_type,
        file: row.file_path,
      })),
      calledBy: incomingResult.rows.map((row: any) => ({
        name: row.symbol_name,
        type: row.symbol_type,
        file: row.file_path,
      })),
    };
  } catch (error) {
    console.error('Call graph error:', error);
    return reply.code(500).send({ error: 'Failed to fetch call graph' });
  }
});

/**
 * Agent 查询端点
 * POST /agent/query
 *
 * 功能：
 * - 支持多轮对话式代码查询
 * - 自动维护会话上下文
 * - 智能理解用户意图
 *
 * Agent 特性：
 * - 上下文感知：记住之前的对话内容
 * - 多步推理：可以分步骤解决复杂问题
 * - 工具调用：自动选择合适的搜索策略
 * - 会话管理：支持多个独立的对话会话
 *
 * 使用场景：
 * - 复杂的代码探索任务
 * - 需要多轮交互的问题
 * - 渐进式的代码理解
 *
 * @body query - 用户查询（必需）
 * @body repoId - 仓库 ID（必需）
 * @body sessionId - 会话 ID（可选，用于继续之前的对话）
 *
 * @returns {
 *   sessionId: string,
 *   response: string,
 *   evidence?: Array<CodeChunk>,
 *   metadata?: object
 * }
 *
 * @throws 400 - 缺少必需参数
 * @throws 500 - 执行失败
 */
fastify.post('/agent/query', async (request, reply) => {
  const { query, repoId, sessionId } = request.body as { query: string; repoId: number; sessionId?: string };

  if (!query || !repoId) {
    return reply.code(400).send({ error: 'Missing required fields: query, repoId' });
  }

  try {
    const result = await agent.executeQuery(query, repoId, sessionId);
    return result;
  } catch (error: any) {
    console.error('[Agent] Query error:', error);
    return reply.code(500).send({ error: error.message });
  }
});

/**
 * 获取 Agent 会话信息
 * GET /agent/sessions/:sessionId
 *
 * 功能：
 * - 查询指定会话的详细信息
 * - 包含会话状态、创建时间等
 *
 * @param sessionId - 会话 ID
 *
 * @returns Session 对象
 * @throws 404 - 会话不存在
 * @throws 500 - 查询失败
 */
fastify.get('/agent/sessions/:sessionId', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };

  try {
    const session = await agent.getSession(sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    return session;
  } catch (error: any) {
    console.error('[Agent] Get session error:', error);
    return reply.code(500).send({ error: error.message });
  }
});

/**
 * 获取 Agent 会话的执行历史
 * GET /agent/sessions/:sessionId/history
 *
 * 功能：
 * - 返回会话中的所有查询和响应历史
 * - 用于回顾对话过程
 *
 * @param sessionId - 会话 ID
 *
 * @returns {
 *   history: Array<{
 *     query: string,
 *     response: string,
 *     timestamp: Date
 *   }>
 * }
 *
 * @throws 500 - 查询失败
 */
fastify.get('/agent/sessions/:sessionId/history', async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };

  try {
    const history = await agent.getExecutionHistory(sessionId);
    return { history };
  } catch (error: any) {
    console.error('[Agent] Get history error:', error);
    return reply.code(500).send({ error: error.message });
  }
});

/**
 * 获取 Agent 统计信息
 * GET /agent/stats
 *
 * 功能：
 * - 返回 Agent 的运行统计
 * - 包含会话数、查询数等指标
 *
 * 使用场景：
 * - 监控 Agent 使用情况
 * - 性能分析
 * - 使用量统计
 *
 * @returns {
 *   totalSessions: number,
 *   totalQueries: number,
 *   averageResponseTime: number,
 *   ...
 * }
 */
fastify.get('/agent/stats', async () => {
  try {
    const stats = await agent.getStats();
    return stats;
  } catch (error: any) {
    console.error('[Agent] Get stats error:', error);
    return { error: error.message };
  }
});

/**
 * 获取缓存统计信息
 * GET /admin/cache/stats
 *
 * 功能：
 * - 返回所有缓存的统计信息
 * - 包含命中率、大小、容量等指标
 *
 * 统计指标：
 * - hits: 缓存命中次数
 * - misses: 缓存未命中次数
 * - hitRate: 命中率（0-1）
 * - size: 当前缓存大小
 * - maxSize: 最大容量
 *
 * 使用场景：
 * - 监控缓存性能
 * - 优化缓存策略
 * - 容量规划
 *
 * @returns Record<string, CacheStats>
 */
fastify.get('/admin/cache/stats', async () => {
  return getAllCacheStats();
});

/**
 * 清空所有缓存
 * POST /admin/cache/clear
 *
 * 功能：
 * - 清空所有缓存数据
 * - 重置缓存统计
 *
 * 使用场景：
 * - 代码库更新后清除旧缓存
 * - 缓存数据异常时重置
 * - 手动释放内存
 *
 * 注意：清空缓存会导致短期性能下降
 *
 * @returns { message: string }
 */
fastify.post('/admin/cache/clear', async () => {
  clearAllCaches();
  return { message: 'All caches cleared successfully' };
});

/**
 * 服务器监听端口
 * 从环境变量读取，默认为 8787
 */
const port = parseInt(process.env.PORT || '8787');

/**
 * 优雅关闭处理
 *
 * 功能：
 * - 监听 SIGINT（Ctrl+C）和 SIGTERM（kill）信号
 * - 优雅地关闭服务器，等待现有请求完成
 * - 保留数据库连接池供后台任务使用
 *
 * 关闭流程：
 * 1. 接收到终止信号
 * 2. 停止接受新请求
 * 3. 等待现有请求完成
 * 4. 关闭 Fastify 服务器
 * 5. 保留数据库连接池（供 BullMQ 后台任务使用）
 * 6. 进程退出时自动清理连接池
 *
 * 注意：
 * - 不关闭数据库连接池，让后台索引任务继续运行
 * - 连接池会在进程退出时自动清理
 */
const signals = ['SIGINT', 'SIGTERM'];
signals.forEach((signal) => {
  process.on(signal, async () => {
    console.log(`Received ${signal}, closing server gracefully...`);
    try {
      await fastify.close();
      // 不关闭连接池 - 让后台任务（BullMQ）继续使用
      // 连接池会在进程退出时自动清理
      console.log('Server closed successfully');
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
  });
});

/**
 * 启动服务器
 *
 * 配置：
 * - 监听所有网络接口（0.0.0.0）
 * - 支持 Docker 容器部署
 * - 支持本地开发和生产环境
 *
 * 启动失败时自动退出进程
 */
try {
  await fastify.listen({ port, host: '0.0.0.0' });
  console.log(`CodeLens API running at http://localhost:${port}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
