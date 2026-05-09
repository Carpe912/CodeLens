# 共享索引架构设计

## 问题分析

**当前问题**：
- 每个用户打开工作区时都会上传代码并索引
- 同一个GitLab项目被多人重复索引
- 浪费服务器资源和存储空间
- 索引时间长，用户体验差

**理想方案**：
- 一个GitLab项目只索引一次
- 所有用户共享同一份索引数据
- 后端自动从GitLab同步最新代码
- 用户只需要查询，不需要上传

## 架构设计

### 方案一：基于GitLab URL的共享索引（推荐）

```
用户A打开项目 → 检测GitLab URL → 查询后端是否已索引
                                    ↓
                              已索引 → 直接使用
                                    ↓
                              未索引 → 后端从GitLab克隆并索引
                                    ↓
用户B打开同一项目 → 检测到已索引 → 直接使用（无需重复索引）
```

### 数据流程

```
┌─────────────┐
│  用户A VSCode │
└──────┬──────┘
       │ 1. 检测 git@gitlab.com:team/project.git
       ↓
┌─────────────────────────────────────┐
│  CodeLens API Server                │
│  ┌───────────────────────────────┐  │
│  │ 检查数据库:                    │  │
│  │ SELECT * FROM repos            │  │
│  │ WHERE gitlab_url = '...'       │  │
│  └───────────────────────────────┘  │
│         ↓                            │
│    已存在？                          │
│    ├─ 是 → 返回 repoId              │
│    └─ 否 → 从GitLab克隆 → 索引     │
└─────────────────────────────────────┘
       ↓
┌─────────────┐
│  用户B VSCode │ → 检测到已索引 → 直接使用
└─────────────┘
```

## 实现方案

### 1. 后端API改造

#### 新增API：检查仓库是否已索引

```typescript
// GET /repos/check?gitlabUrl=xxx
fastify.get('/repos/check', async (request, reply) => {
  const { gitlabUrl } = request.query;
  
  // 规范化URL（去除.git后缀，统一格式）
  const normalizedUrl = normalizeGitLabUrl(gitlabUrl);
  
  // 查询数据库
  const result = await pool.query(
    'SELECT id, name, status, index_progress FROM repos WHERE gitlab_url = $1',
    [normalizedUrl]
  );
  
  if (result.rows.length > 0) {
    return {
      exists: true,
      repo: result.rows[0]
    };
  } else {
    return {
      exists: false
    };
  }
});
```

#### 新增API：从GitLab URL创建仓库

```typescript
// POST /repos/from-gitlab
fastify.post('/repos/from-gitlab', async (request, reply) => {
  const { gitlabUrl, gitlabToken } = request.body;
  
  // 规范化URL
  const normalizedUrl = normalizeGitLabUrl(gitlabUrl);
  
  // 检查是否已存在
  const existing = await pool.query(
    'SELECT id FROM repos WHERE gitlab_url = $1',
    [normalizedUrl]
  );
  
  if (existing.rows.length > 0) {
    return {
      repoId: existing.rows[0].id,
      status: 'already_exists'
    };
  }
  
  // 解析项目名称
  const projectName = extractProjectName(gitlabUrl);
  
  // 创建仓库记录
  const repoId = await createRepo(projectName, 'gitlab', gitlabUrl, gitlabToken);
  
  // 后台克隆并索引
  await enqueueIndexJob({
    repoId,
    repoName: projectName,
    source: 'gitlab',
    url: gitlabUrl,
    gitlabToken
  });
  
  return {
    repoId,
    status: 'indexing'
  };
});
```

#### 数据库表结构改造

```sql
-- 添加 gitlab_url 字段和唯一索引
ALTER TABLE repos ADD COLUMN gitlab_url TEXT;
CREATE UNIQUE INDEX idx_repos_gitlab_url ON repos(gitlab_url);

-- 添加最后同步时间
ALTER TABLE repos ADD COLUMN last_synced_at TIMESTAMP;
```

### 2. VSCode扩展改造

#### 新的索引流程

```typescript
// src/indexing/workspaceIndexer.ts
export class WorkspaceIndexer {
  async indexWorkspace(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    // 1. 权限检查（保持不变）
    const permissionResult = await this.permissionChecker.checkWorkspacePermission(workspaceFolder);
    if (!permissionResult.allowed) {
      vscode.window.showErrorMessage(`无法索引工作区: ${permissionResult.reason}`);
      return;
    }
    
    // 2. 获取GitLab URL
    const gitInfo = await this.getGitInfo(workspaceFolder.uri.fsPath);
    if (!gitInfo.remoteUrl) {
      vscode.window.showErrorMessage('无法获取Git远程仓库地址');
      return;
    }
    
    // 3. 检查后端是否已索引此仓库
    const checkResult = await this.apiService.repos.checkByGitLabUrl(gitInfo.remoteUrl);
    
    if (checkResult.exists) {
      // 仓库已索引，直接使用
      const repo = checkResult.repo;
      this.repoRegistry.registerRepo(
        workspaceFolder.uri.toString(),
        repo.id,
        repo.name
      );
      
      if (repo.status === 'ready') {
        vscode.window.showInformationMessage(
          `此仓库已索引，可直接使用（共享索引）`
        );
        this.repoRegistry.updateStatus(workspaceFolder.uri.toString(), 'ready');
      } else if (repo.status === 'indexing') {
        vscode.window.showInformationMessage(
          `此仓库正在索引中，请稍候...`
        );
        // 监控进度
        await this.monitorProgress(repo.id, workspaceFolder.uri.toString());
      }
    } else {
      // 仓库未索引，请求后端从GitLab克隆并索引
      const action = await vscode.window.showInformationMessage(
        `此仓库尚未索引。是否从GitLab克隆并索引？（其他用户将共享此索引）`,
        '是',
        '否'
      );
      
      if (action === '是') {
        await this.indexFromGitLab(workspaceFolder, gitInfo.remoteUrl);
      }
    }
  }
  
  private async indexFromGitLab(
    workspaceFolder: vscode.WorkspaceFolder,
    gitlabUrl: string
  ): Promise<void> {
    try {
      // 获取GitLab Token（用于克隆私有仓库）
      const config = vscode.workspace.getConfiguration('codelens');
      const gitlabToken = config.get<string>('gitlabToken');
      
      // 请求后端从GitLab索引
      const result = await this.apiService.repos.createFromGitLab(gitlabUrl, gitlabToken);
      
      // 注册到本地状态
      this.repoRegistry.registerRepo(
        workspaceFolder.uri.toString(),
        result.repoId,
        workspaceFolder.name
      );
      
      // 监控索引进度
      await this.monitorProgress(result.repoId, workspaceFolder.uri.toString());
    } catch (error: any) {
      vscode.window.showErrorMessage(`从GitLab索引失败: ${error.message}`);
    }
  }
  
  private async getGitInfo(workspacePath: string): Promise<{
    remoteUrl?: string;
  }> {
    try {
      const { stdout } = await execAsync('git remote get-url origin', { cwd: workspacePath });
      return { remoteUrl: stdout.trim() };
    } catch {
      return {};
    }
  }
}
```

#### 新增API方法

```typescript
// src/api/repos.ts
export class RepoAPI {
  /**
   * 检查GitLab仓库是否已索引
   */
  async checkByGitLabUrl(gitlabUrl: string): Promise<{
    exists: boolean;
    repo?: any;
  }> {
    const encodedUrl = encodeURIComponent(gitlabUrl);
    return this.client.request(`/repos/check?gitlabUrl=${encodedUrl}`);
  }
  
  /**
   * 从GitLab URL创建仓库（后端克隆并索引）
   */
  async createFromGitLab(gitlabUrl: string, gitlabToken?: string): Promise<{
    repoId: number;
    status: string;
  }> {
    return this.client.request('/repos/from-gitlab', {
      method: 'POST',
      body: { gitlabUrl, gitlabToken }
    });
  }
}
```

### 3. 自动同步机制

#### 定时任务：自动从GitLab拉取更新

```typescript
// apps/api/src/sync/gitlab-sync.ts
import cron from 'node-cron';

export class GitLabSyncService {
  // 每小时同步一次
  start() {
    cron.schedule('0 * * * *', async () => {
      console.log('[GitLabSync] Starting sync...');
      await this.syncAllRepos();
    });
  }
  
  async syncAllRepos() {
    // 获取所有GitLab仓库
    const result = await pool.query(
      'SELECT id, url, gitlab_token, last_synced_at FROM repos WHERE source = $1',
      ['gitlab']
    );
    
    for (const repo of result.rows) {
      try {
        // 检查是否需要同步（距离上次同步超过1小时）
        const lastSynced = repo.last_synced_at ? new Date(repo.last_synced_at) : null;
        const now = new Date();
        
        if (!lastSynced || (now.getTime() - lastSynced.getTime()) > 3600000) {
          await this.syncRepo(repo);
        }
      } catch (error) {
        console.error(`[GitLabSync] Failed to sync repo ${repo.id}:`, error);
      }
    }
  }
  
  async syncRepo(repo: any) {
    console.log(`[GitLabSync] Syncing repo ${repo.id}...`);
    
    // 拉取最新代码
    const repoPath = `/tmp/codelens-repos/${repo.id}`;
    await execAsync('git pull', { cwd: repoPath });
    
    // 获取变更的文件
    const { stdout } = await execAsync('git diff HEAD@{1} HEAD --name-only', { cwd: repoPath });
    const changedFiles = stdout.trim().split('\n').filter(f => f);
    
    if (changedFiles.length > 0) {
      console.log(`[GitLabSync] ${changedFiles.length} files changed, triggering incremental index`);
      
      // 触发增量索引
      await enqueueIncrementalIndexJob({
        repoId: repo.id,
        repoPath,
        files: changedFiles
      });
    }
    
    // 更新最后同步时间
    await pool.query(
      'UPDATE repos SET last_synced_at = NOW() WHERE id = $1',
      [repo.id]
    );
  }
}
```

## 优势对比

### 当前方案（每人上传）

| 指标 | 数值 |
|------|------|
| 10人团队索引同一项目 | 10次上传 + 10次索引 |
| 存储空间 | 10份代码 + 10份索引 |
| 索引时间 | 每人等待5-10分钟 |
| 服务器负载 | 高 |

### 共享索引方案

| 指标 | 数值 |
|------|------|
| 10人团队索引同一项目 | 1次克隆 + 1次索引 |
| 存储空间 | 1份代码 + 1份索引 |
| 索引时间 | 第1人等待5-10分钟，其他人立即可用 |
| 服务器负载 | 低 |

**节省资源**：90%

## 用户体验

### 场景1：第一个索引该项目的用户

```
1. 打开工作区
2. 检测到 git@gitlab.com:team/project.git
3. 提示："此仓库尚未索引。是否从GitLab克隆并索引？（其他用户将共享此索引）"
4. 点击"是"
5. 后端从GitLab克隆代码
6. 开始索引（5-10分钟）
7. 索引完成，可以使用
```

### 场景2：后续用户

```
1. 打开工作区
2. 检测到 git@gitlab.com:team/project.git
3. 查询后端，发现已索引
4. 提示："此仓库已索引，可直接使用（共享索引）"
5. 立即可用（无需等待）
```

### 场景3：代码更新

```
1. 团队成员推送代码到GitLab
2. 后端定时任务（每小时）自动拉取最新代码
3. 检测到文件变更
4. 自动触发增量索引
5. 所有用户自动获得最新索引（无需手动操作）
```

## 安全性

### 私有仓库访问

- 使用用户配置的GitLab Token克隆私有仓库
- Token存储在后端数据库（加密）
- 只有有权限的用户才能触发索引

### 权限隔离

- 每个用户查询时仍然验证GitLab权限
- 无权限用户无法访问共享索引
- 基于GitLab API的实时权限验证

## 实施步骤

### 阶段1：后端改造（1-2天）

1. 数据库添加 `gitlab_url` 字段和唯一索引
2. 实现 `GET /repos/check` API
3. 实现 `POST /repos/from-gitlab` API
4. 实现URL规范化函数

### 阶段2：VSCode扩展改造（1天）

1. 修改 `workspaceIndexer.ts`，先检查后端是否已索引
2. 添加 `checkByGitLabUrl` 和 `createFromGitLab` API方法
3. 更新用户提示消息

### 阶段3：自动同步（1天）

1. 实现 `GitLabSyncService`
2. 配置定时任务（cron）
3. 测试增量更新

### 阶段4：测试和优化（1天）

1. 多用户并发测试
2. 性能优化
3. 错误处理完善

## 配置选项

```json
{
  // 后端配置
  "GITLAB_SYNC_INTERVAL": "0 * * * *",  // 每小时同步
  "GITLAB_SYNC_ENABLED": true,
  
  // VSCode扩展配置
  "codelens.useSharedIndex": true,  // 使用共享索引（默认开启）
  "codelens.gitlabToken": "glpat-xxx"  // 用于克隆私有仓库
}
```

## 总结

**核心改进**：
1. ✅ 一个仓库只索引一次，所有用户共享
2. ✅ 后端自动从GitLab同步，无需用户上传
3. ✅ 定时增量更新，保持索引最新
4. ✅ 节省90%的资源和时间
5. ✅ 保持权限隔离，安全可控

这个方案既解决了资源浪费问题，又提升了用户体验！
