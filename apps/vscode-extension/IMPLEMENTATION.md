# 多分支独立索引实现方案

## 数据库表结构改造

```sql
-- 1. 添加分支相关字段
ALTER TABLE repos ADD COLUMN gitlab_url TEXT;
ALTER TABLE repos ADD COLUMN branch TEXT DEFAULT 'main';
ALTER TABLE repos ADD COLUMN is_base_branch BOOLEAN DEFAULT false;
ALTER TABLE repos ADD COLUMN parent_repo_id INTEGER REFERENCES repos(id);
ALTER TABLE repos ADD COLUMN default_branch TEXT;

-- 2. 创建唯一索引（gitlab_url + branch 组合唯一）
CREATE UNIQUE INDEX idx_repos_gitlab_url_branch ON repos(gitlab_url, branch);

-- 3. 创建普通索引
CREATE INDEX idx_repos_gitlab_url ON repos(gitlab_url);
CREATE INDEX idx_repos_parent_repo_id ON repos(parent_repo_id);

-- 4. 添加注释
COMMENT ON COLUMN repos.gitlab_url IS 'GitLab仓库URL（规范化后）';
COMMENT ON COLUMN repos.branch IS '分支名称';
COMMENT ON COLUMN repos.is_base_branch IS '是否为基础分支（默认分支）';
COMMENT ON COLUMN repos.parent_repo_id IS '父仓库ID（指向基础分支）';
COMMENT ON COLUMN repos.default_branch IS 'GitLab默认分支名称';
```

## 后端API实现

### 1. 工具函数

```typescript
// apps/api/src/utils/gitlab.ts

/**
 * 规范化GitLab URL
 */
export function normalizeGitLabUrl(url: string): string {
  // 去除.git后缀
  let normalized = url.replace(/\.git$/, '');
  
  // 统一SSH和HTTPS格式为HTTPS
  if (normalized.startsWith('git@')) {
    // git@gitlab.com:team/project → https://gitlab.com/team/project
    normalized = normalized
      .replace(/^git@/, 'https://')
      .replace(/:/, '/');
  }
  
  return normalized;
}

/**
 * 从URL提取项目路径
 */
export function extractProjectPath(url: string): string {
  // https://gitlab.com/team/project → team/project
  const normalized = normalizeGitLabUrl(url);
  const match = normalized.match(/https?:\/\/[^\/]+\/(.+)/);
  return match ? match[1] : '';
}

/**
 * 从URL提取项目名称
 */
export function extractProjectName(url: string): string {
  const projectPath = extractProjectPath(url);
  const parts = projectPath.split('/');
  return parts[parts.length - 1];
}

/**
 * 获取GitLab项目的默认分支
 */
export async function getGitLabDefaultBranch(
  gitlabUrl: string,
  gitlabToken?: string
): Promise<string> {
  try {
    const normalized = normalizeGitLabUrl(gitlabUrl);
    const projectPath = extractProjectPath(normalized);
    const domain = normalized.match(/https?:\/\/([^\/]+)/)?.[1];
    
    if (!domain || !projectPath) {
      return 'main'; // 默认返回main
    }
    
    // 调用GitLab API获取项目信息
    const encodedPath = encodeURIComponent(projectPath);
    const apiUrl = `https://${domain}/api/v4/projects/${encodedPath}`;
    
    const headers: Record<string, string> = {};
    if (gitlabToken) {
      headers['PRIVATE-TOKEN'] = gitlabToken;
    }
    
    const response = await fetch(apiUrl, { headers });
    
    if (response.ok) {
      const project = await response.json();
      return project.default_branch || 'main';
    }
    
    return 'main';
  } catch (error) {
    console.error('[GitLab] Failed to get default branch:', error);
    return 'main';
  }
}
```

### 2. 检查仓库API

```typescript
// apps/api/src/index.ts

/**
 * 检查GitLab仓库是否已索引
 * GET /repos/check?gitlabUrl=xxx&branch=xxx
 */
fastify.get<{
  Querystring: { gitlabUrl: string; branch?: string };
}>('/repos/check', async (request, reply) => {
  const { gitlabUrl, branch } = request.query;
  
  if (!gitlabUrl) {
    return reply.code(400).send({ error: 'Missing gitlabUrl parameter' });
  }
  
  const normalizedUrl = normalizeGitLabUrl(gitlabUrl);
  
  if (branch) {
    // 检查特定分支
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
  
  // 检查是否有基础分支
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
 * 从GitLab创建基础分支索引
 * POST /repos/from-gitlab
 */
fastify.post<{
  Body: { gitlabUrl: string; gitlabToken?: string; branch?: string };
}>('/repos/from-gitlab', async (request, reply) => {
  const { gitlabUrl, gitlabToken, branch } = request.body;
  
  if (!gitlabUrl) {
    return reply.code(400).send({ error: 'Missing gitlabUrl' });
  }
  
  const normalizedUrl = normalizeGitLabUrl(gitlabUrl);
  
  // 获取默认分支
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
  
  // 后台克隆并索引
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
 * 创建分支增量索引
 * POST /repos/branch-index
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
  
  // 后台克隆分支并索引差异
  await enqueueIndexJob({
    repoId,
    repoName: projectName,
    source: 'gitlab',
    url: gitlabUrl,
    branch,
    baseBranch,  // 用于计算差异
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
```

## VSCode扩展实现

### 1. 获取GitLab默认分支

```typescript
// src/utils/gitlabHelper.ts
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * 获取GitLab项目的默认分支
 */
export async function getGitLabDefaultBranch(
  gitlabUrl: string,
  gitlabToken?: string
): Promise<string> {
  try {
    // 规范化URL
    const normalized = normalizeGitLabUrl(gitlabUrl);
    const projectPath = extractProjectPath(normalized);
    const domain = normalized.match(/https?:\/\/([^\/]+)/)?.[1];
    
    if (!domain || !projectPath) {
      return 'main';
    }
    
    // 调用GitLab API
    const encodedPath = encodeURIComponent(projectPath);
    const apiUrl = `https://${domain}/api/v4/projects/${encodedPath}`;
    
    const headers: Record<string, string> = {};
    if (gitlabToken) {
      headers['PRIVATE-TOKEN'] = gitlabToken;
    }
    
    const response = await fetch(apiUrl, { headers });
    
    if (response.ok) {
      const project = await response.json();
      return project.default_branch || 'main';
    }
    
    return 'main';
  } catch (error) {
    console.error('[GitLabHelper] Failed to get default branch:', error);
    return 'main';
  }
}

/**
 * 获取当前分支名称
 */
export async function getCurrentBranch(workspacePath: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git branch --show-current', { cwd: workspacePath });
    return stdout.trim() || 'main';
  } catch {
    return 'main';
  }
}

/**
 * 获取与基础分支的差异文件
 */
export async function getDiffFromBaseBranch(
  workspacePath: string,
  baseBranch: string
): Promise<string[]> {
  try {
    const { stdout } = await execAsync(
      `git diff --name-only ${baseBranch}...HEAD`,
      { cwd: workspacePath }
    );
    
    return stdout
      .trim()
      .split('\n')
      .filter(f => f && isSupportedFile(f));
  } catch (error) {
    console.error('[GitLabHelper] Failed to get diff:', error);
    return [];
  }
}

function normalizeGitLabUrl(url: string): string {
  let normalized = url.replace(/\.git$/, '');
  if (normalized.startsWith('git@')) {
    normalized = normalized.replace(/^git@/, 'https://').replace(/:/, '/');
  }
  return normalized;
}

function extractProjectPath(url: string): string {
  const match = url.match(/https?:\/\/[^\/]+\/(.+)/);
  return match ? match[1] : '';
}

function isSupportedFile(file: string): boolean {
  return /\.(ts|tsx|js|jsx|vue)$/.test(file);
}
```

### 2. 更新API方法

```typescript
// src/api/repos.ts
export class RepoAPI {
  /**
   * 检查GitLab仓库是否已索引
   */
  async checkByGitLabUrl(gitlabUrl: string, branch?: string): Promise<{
    exists: boolean;
    hasBaseBranch?: boolean;
    repo?: any;
    baseBranch?: any;
  }> {
    const encodedUrl = encodeURIComponent(gitlabUrl);
    const branchParam = branch ? `&branch=${encodeURIComponent(branch)}` : '';
    return this.client.request(`/repos/check?gitlabUrl=${encodedUrl}${branchParam}`);
  }
  
  /**
   * 从GitLab创建基础分支索引
   */
  async createFromGitLab(
    gitlabUrl: string,
    gitlabToken?: string,
    branch?: string
  ): Promise<{
    repoId: number;
    status: string;
    branch: string;
  }> {
    return this.client.request('/repos/from-gitlab', {
      method: 'POST',
      body: { gitlabUrl, gitlabToken, branch }
    });
  }
  
  /**
   * 创建分支增量索引
   */
  async createBranchIndex(
    gitlabUrl: string,
    branch: string,
    gitlabToken?: string
  ): Promise<{
    repoId: number;
    status: string;
    branch: string;
    baseBranch: string;
  }> {
    return this.client.request('/repos/branch-index', {
      method: 'POST',
      body: { gitlabUrl, branch, gitlabToken }
    });
  }
}
```

继续实现VSCode扩展的核心逻辑...

