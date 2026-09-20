/**
 * 代码仓库管理 路由
 *
 * 由原 src/index.ts（2000+ 行）按领域拆分而来，处理函数体逐字保留，仅把
 * 顶层 `fastify` 换成本插件收到的 `app`。行为与拆分前完全一致。
 */

import type { FastifyInstance } from 'fastify';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  pool, multiStrategySearch, agent, getGraph, anthropicApiKey, anthropic,
  createRepo, getRepo, searchByKeyword, searchByEmbedding,
  addQuestionFeedback, getQuestionFeedback, getSimilarQuestionsWithFeedback,
  clearRepoData, deleteRepoChildRows, getIndexProgress,
  enqueueIndexJob, enqueueIncrementalIndexJob, enqueueRefreshJob, enqueueReindexJob, enqueueResumeJob,
  generateEmbedding, answerQuestion, analyzeRootCause,
  searchTTLCache, generateCacheKey, getAllCacheStats, clearAllCaches,
  MultiStrategySearch, AgentCore, getAgentConfig,
  createCodeLensGraph, runGraphQuery,
  normalizeGitLabUrl, extractProjectName, getGitLabDefaultBranch,
  getUpstreamStatus, assertGitWorkTree,
  getUrlInventory,
} from '../deps.js';
import type { CodeLensGraph } from '../deps.js';

export async function reposRoutes(app: FastifyInstance): Promise<void> {

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
app.get('/repos', async () => {
  const result = await pool.query('SELECT * FROM repos ORDER BY created_at DESC');
  // 隐藏 gitlab_token 以保护安全
  const repos = result.rows.map((repo: any) => {
    // `last_incremental` 是「上一次增量跑完的完整报告」（含实体明细，可能上百 KB）。
    // 列表页一个仓库只要一行摘要，把每份报告都传过去纯属浪费 —— 需要它的地方
    // 是仓库详情页 / upstream-check，那两处都会单独带出来。
    // 用解构而不是显式列名：显式列表一旦漏掉后加的列就是一次静默的字段丢失。
    const { last_incremental, ...rest } = repo;
    return { ...rest, gitlab_token: rest.gitlab_token ? '***' : null };
  });
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
app.get<{
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
 * 获取仓库的索引规模统计
 * GET /repos/:id/stats
 *
 * 前端仓库页用它展示「这个索引里到底有什么」——文件数 / 代码块数 / 接口路径数 / 调用边数。
 * 纯只读，不触碰索引状态。
 *
 * ⚠️ `code_chunks.repo_id` **全为 NULL**（既有数据如此），所以代码块计数必须
 *    `JOIN files` 按 `files.repo_id` 过滤，不能按 `code_chunks.repo_id` 统计，否则恒为 0。
 *
 * @param id - 仓库 ID
 * @returns { files, chunks, urlPatterns, urlUsages, callEdges }
 */
app.get<{
  Params: { id: string };
}>('/repos/:id/stats', async (request, reply) => {
  const repoId = parseInt(request.params.id, 10);
  if (!Number.isFinite(repoId)) {
    return reply.code(400).send({ error: 'Invalid repository id' });
  }

  const result = await pool.query(
    `SELECT
       (SELECT count(*) FROM files    WHERE repo_id = $1)                                    AS files,
       (SELECT count(*) FROM code_chunks c JOIN files f ON f.id = c.file_id
         WHERE f.repo_id = $1)                                                               AS chunks,
       (SELECT count(*) FROM url_patterns WHERE repo_id = $1)                                AS url_patterns,
       (SELECT count(*) FROM url_usages   WHERE repo_id = $1)                                AS url_usages,
       (SELECT count(*) FROM call_graph   WHERE repo_id = $1)                                AS call_edges`,
    [repoId]
  );

  const row = result.rows[0] ?? {};

  // ── 接口数的**真实口径** ──────────────────────────────────────────────
  // `url_patterns` 的裸 COUNT(283) 是「源码里出现过多少条 URL 写法」，
  // 不是「有多少个接口」：一行 ≠ 一个接口（helper 实参名不同会被算成多行），
  // 且里面混着前端路由/构建产物/界面文案。
  // 这里用与 /repos/:id/url-patterns 完全同一套逻辑算出可调用接口数，
  // 让顶栏那个数字和点开后的清单**必然一致** —— 否则用户会看到两个互相矛盾的数。
  // helper 索引有 5 分钟 TTL 缓存，首次调用略慢，之后是毫秒级。
  let interfaces: number | undefined;
  let interfacesCallable: number | undefined;
  try {
    const inv = await getUrlInventory(repoId, {}, pool);
    interfaces = inv.distinctInterfaces;
    interfacesCallable =
      inv.distinctInterfaces +
      inv.rows.filter((r) => r.method === null && r.classification?.kind === 'interface').length;
  } catch (err) {
    // 清单算不出来时**降级为 undefined**而不是 0：0 会被当成「这个仓库没有接口」，
    // 而缺字段只会让前端退回显示原始行数。两者是完全不同的错误信号。
    request.log.warn({ err }, 'stats: url inventory unavailable');
  }

  return {
    repoId,
    files: Number(row.files ?? 0),
    chunks: Number(row.chunks ?? 0),
    /** ⚠️ 原始行数 —— **不是**接口数，保留只为向后兼容与对账 */
    urlPatterns: Number(row.url_patterns ?? 0),
    urlUsages: Number(row.url_usages ?? 0),
    callEdges: Number(row.call_edges ?? 0),
    interfaces,
    interfacesCallable,
  };
});


/**
 * 接口清单（结构化）
 * GET /repos/:id/url-patterns
 *
 * ============================================
 * 为什么必须有这个路由
 * ============================================
 * 在此之前 `url_patterns` 全仓**只被读一次** —— `/repos/:id/stats` 里的一个 COUNT。
 * 也就是「只暴露一个数字、不暴露任何一行明细」：
 * 数字错了两轮迭代都没人发现（386 里有 111 行根本不是接口），
 * 因为没有任何出口能让人把数字和明细对上。
 *
 * 本路由把明细原样放出来。`total` 是原始行数，`distinctInterfaces` 是
 * 去重+展开 helper 之后的真实接口数 —— 两个数都返回，差额本身就是诊断信息。
 *
 * 与 `/ask` 的区别：这里**没有 top-K**。返回的就是全集。
 *
 * @query method  - 只看某个 HTTP method（GET/POST/...）
 * @query q       - 关键词过滤（作用在真实路径 / 原始 pattern / 定义文件）
 * @query empty   - `0` 时排除 method 未判定出的行（默认包含）
 *
 * @returns {
 *   repoId, total, distinctInterfaces, byMethod,
 *   rows: [{ id, method, pattern, normalizedPattern, realPath,
 *            definitionFile, definitionLine, usageCount, usageFiles }]
 * }
 */
app.get<{
  Params: { id: string };
  Querystring: { method?: string; q?: string; empty?: string };
}>('/repos/:id/url-patterns', async (request, reply) => {
  const repoId = parseInt(request.params.id, 10);
  if (!Number.isFinite(repoId)) {
    return reply.code(400).send({ error: 'Invalid repository id' });
  }

  const repo = await getRepo(repoId);
  if (!repo) {
    return reply.code(404).send({ error: `Repository with id ${repoId} not found` });
  }

  const { method, q, empty } = request.query;
  return getUrlInventory(repoId, {
    method,
    q,
    includeEmptyMethod: empty !== '0',
  });
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
app.post<{
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
app.post('/repos/upload', async (request, reply) => {
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
app.get<{
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
app.get<{
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
app.post<{
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
app.post<{
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
app.post<{
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
 * 预览上游变更（**只读**：不动工作区、不动数据库）
 * POST /repos/:id/upstream-check
 *
 * 功能：
 * - `fetch` 远端引用（只更新 `origin/*`，不碰工作区）后与本地 HEAD 对比
 * - 返回：默认分支名、超前/落后提交数、提交列表、文件级 A/M/D/R 明细
 *
 * 为什么要有这个「只看不动」的接口：
 * - 增量更新会**改工作区**（快进）和**改索引**。用户点下去之前应该能先看到
 *   「会拉下来几个提交、动到哪些文件」，否则「应用更新」就成了一个盲盒。
 * - 预览与应用共用同一份 diff（都是 `HEAD...origin/<默认分支>`），
 *   所以「预览里说的」和「应用时做的」不会是两个东西。
 *
 * ⚠️ **zip 源返回 200 + `supported:false`，而不是 4xx**。
 *    这不是错误，是一个已知的能力边界：zip 解压出来的目录没有 `.git`，
 *    物理上无法做 diff。用 4xx 会让前端只能显示一个红色报错，
 *    而这里真正需要展示的是「请走全量重建」这句指引。
 *
 * @param id - 仓库 ID
 * @returns
 * - 支持时：`{ supported: true, branch, ahead, behind, commits, files, summary, lastIncremental }`
 * - 不支持时：`{ supported: false, reason }`
 *
 * @throws 404 - 仓库不存在
 * @throws 409 - 仓库正在索引中（此刻工作区可能正在被写，对比结果没有意义）
 * @throws 502 - git 本身失败（网络/认证/仓库损坏）
 */
app.post<{
  Params: { id: string };
}>('/repos/:id/upstream-check', async (request, reply) => {
  const repoId = parseInt(request.params.id, 10);
  if (!Number.isFinite(repoId)) {
    return reply.code(400).send({ error: 'Invalid repository id' });
  }

  const repo = await getRepo(repoId);
  if (!repo) {
    return reply.code(404).send({ error: 'Repository not found' });
  }

  if (repo.source !== 'gitlab') {
    return {
      supported: false,
      source: repo.source,
      reason:
        'ZIP 源没有 .git，无法与上游做 diff。请重新上传新的压缩包（全量重建），或改用 GitLab 源接入。',
    };
  }

  if (!repo.url) {
    return { supported: false, source: repo.source, reason: '该仓库没有记录 GitLab 地址，无法对比上游' };
  }

  // 索引进行中时不查：工作区/索引正在被写，此刻的对比结果没有意义
  if (repo.status === 'indexing') {
    return reply.code(409).send({ error: 'Repository is currently being indexed' });
  }

  const repoPath = `/tmp/codelens-repos/${repoId}`;

  // 先单独判「是不是 git 工作区」，把「没克隆过/被 zip 覆盖过」与
  // 「fetch 失败」区分开 —— 两者的处置完全不同（前者要重克隆，后者是网络）
  try {
    await assertGitWorkTree(repoPath);
  } catch (error) {
    return { supported: false, source: repo.source, reason: (error as Error).message };
  }

  try {
    const status = await getUpstreamStatus(repoPath);
    return {
      supported: true,
      ...status,
      // 顺带把上次增量的报告带出来，前端一次请求就能把「将要发生什么」与
      // 「上次发生了什么」并排显示
      lastIncremental: repo.last_incremental ?? null,
    };
  } catch (error) {
    // git 的报错已经过 redactCredentials（见 git-upstream.ts），可安全外传
    return reply.code(502).send({ supported: false, error: (error as Error).message });
  }
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
app.post<{
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
app.post<{
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
 * 断点续跑：把**上次没做完的部分**补完，不清空任何已有数据
 * POST /repos/:id/resume
 *
 * 与 reindex 的区别（这是这个接口存在的全部理由）：
 * - reindex：`clearRepoData` 清空 → 重新克隆 → 全量索引。代价与**仓库大小**成正比。
 * - resume：什么都不删 → 复用工作区 → 第一遍跳过已登记的、第二遍只做
 *   `entities_indexed_at IS NULL` 的文件。代价与**剩余工作量**成正比。
 *
 * 典型使用场景：索引跑到 1037/1051 挂了。以前只能整仓重来（全量约 6 分钟起，
 * 且已花钱生成的向量会被一起清掉）；现在再点一次续跑，只补那 14 个文件。
 *
 * 允许对 `failed` 与 `ready` 状态调用：
 * - `failed` → 正是要救的场景；
 * - `ready` → 允许，用于「第二遍部分文件失败但整体被判成功」的补漏。
 *   此时同样按 `entities_indexed_at IS NULL` 挑文件，没有待补文件就是空跑
 *   （只重算一次文件级依赖），不会破坏已有数据。
 *
 * ⚠️ **不做** `clearRepoData`，也**不做** `rm -rf` 工作区 —— 这两件事正是
 * 「失败只能从头来」的根源，续跑的定义就是不碰它们。
 *
 * @param id - 仓库 ID
 *
 * @returns { jobId: string, status: 'indexing' }
 *
 * @throws 404 - 仓库不存在
 * @throws 400 - 仓库正在索引中
 */
app.post<{
  Params: { id: string };
}>('/repos/:id/resume', async (request, reply) => {
  const repoId = parseInt(request.params.id);

  const repo = await getRepo(repoId);
  if (!repo) {
    return reply.code(404).send({ error: 'Repository not found' });
  }

  if (repo.status === 'indexing') {
    return reply.code(400).send({ error: 'Repository is currently being indexed' });
  }

  // 待补文件数先查出来告诉调用方 —— 「续跑到底有没有活干」是调用方最想知道的事。
  // 为 0 也不拒绝：它会走一遍收尾（重算文件级依赖），且这样接口语义最简单
  // （「把我补到完整」），调用方不需要先查一次再决定要不要调。
  const pending = await pool.query(
    `SELECT count(*)::int AS n FROM files
      WHERE repo_id = $1 AND entities_indexed_at IS NULL`,
    [repoId]
  );
  const pendingFiles = (pending.rows[0] as { n: number }).n;

  console.log(`Resuming repo ${repoId}: ${pendingFiles} pending files`);
  clearAllCaches();

  await pool.query('UPDATE repos SET status = $1 WHERE id = $2', ['indexing', repoId]);

  // url 只在工作区丢失时才用得到（resumeRepo 内部判断）；ZIP 源没有 url，
  // 它工作区丢了会得到一条明确的报错，而不是静默失败。
  const jobId = await enqueueResumeJob({
    repoId,
    url: repo.url ?? undefined,
    gitlabToken: repo.gitlab_token ?? undefined,
  });

  return { jobId, status: 'indexing', pendingFiles };
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
app.delete<{
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

  // 删除仓库数据。
  //
  // ⚠️ **不能只靠 `ON DELETE CASCADE`**：一旦某个 `*_repo_id_fkey` 缺失
  // （2026-09-19 故障后线上确实缺了 6 个），级联会**静默不生效** —— 不报错、
  // 不告警，`DELETE FROM repos` 照样成功，只留下一堆指向已删仓库的孤儿行
  // （实测 684 行 `string_constants`）。显式按 repo_id 清子表与约束存在与否无关，
  // 随后 `DELETE FROM repos` 的级联只是兜底（此时已无行可删）。
  await deleteRepoChildRows(repoId);
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
app.get<{
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
app.post<{
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

}
