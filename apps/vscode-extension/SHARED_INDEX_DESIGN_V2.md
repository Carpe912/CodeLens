# 共享索引架构设计 V2（优化版）

## 核心理念

**初始化共享，增量自主**

- 初始化时共享基础索引（避免重复克隆）
- 日常使用时手动增量索引（适应不同分支）

## 问题分析

### 场景1：多人重复初始化（浪费）

```
开发者A：打开项目 → 上传代码 → 索引（10分钟）
开发者B：打开项目 → 上传代码 → 索引（10分钟）  ← 重复！
开发者C：打开项目 → 上传代码 → 索引（10分钟）  ← 重复！
```

**问题**：同一个GitLab项目被重复索引，浪费资源

### 场景2：不同分支需要不同索引

```
开发者A：feature-login 分支   → 有登录相关代码
开发者B：feature-payment 分支 → 有支付相关代码
开发者C：main 分支            → 稳定版本代码
```

**问题**：自动同步main分支没有意义，每个人需要索引自己的分支

## 解决方案

### 架构图

```
┌─────────────────────────────────────────────────────────┐
│  初始化阶段（只执行一次）                                │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  用户A打开项目                                           │
│    ↓                                                      │
│  检测 git@gitlab.com:team/project.git                   │
│    ↓                                                      │
│  查询后端：此项目是否已索引？                            │
│    ├─ 是 → 直接使用（0秒）                              │
│    └─ 否 → 后端从GitLab克隆main分支 → 索引（10分钟）   │
│                                                           │
│  用户B打开项目                                           │
│    ↓                                                      │
│  检测 git@gitlab.com:team/project.git                   │
│    ↓                                                      │
│  查询后端：已索引 ✅                                     │
│    ↓                                                      │
│  直接使用（0秒）                                         │
│                                                           │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  日常使用阶段（手动控制）                                │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  开发者A在 feature-login 分支                            │
│    ↓                                                      │
│  修改了 login.ts, auth.ts                                │
│    ↓                                                      │
│  点击"增量索引"按钮                                      │
│    ↓                                                      │
│  上传变更文件 → 后端增量索引（30秒）                     │
│    ↓                                                      │
│  索引更新完成，可以查询最新代码                          │
│                                                           │
│  开发者B在 feature-payment 分支                          │
│    ↓                                                      │
│  修改了 payment.ts, order.ts                             │
│    ↓                                                      │
│  点击"增量索引"按钮                                      │
│    ↓                                                      │
│  上传变更文件 → 后端增量索引（30秒）                     │
│    ↓                                                      │
│  索引更新完成，可以查询最新代码                          │
│                                                           │
└─────────────────────────────────────────────────────────┘
```

## 实现方案

### 1. 后端API（需要添加）

#### 1.1 检查仓库是否已索引

```typescript
// GET /repos/check?gitlabUrl=xxx
fastify.get('/repos/check', async (request, reply) => {
  const { gitlabUrl } = request.query;
  
  // 规范化URL（去除.git后缀，统一HTTPS/SSH格式）
  const normalizedUrl = normalizeGitLabUrl(gitlabUrl);
  
  // 查询数据库
  const result = await pool.query(
    'SELECT id, name, status FROM repos WHERE gitlab_url = $1',
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

#### 1.2 从GitLab URL创建仓库（初始化）

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
  
  // 后台克隆main分支并索引
  await enqueueIndexJob({
    repoId,
    repoName: projectName,
    source: 'gitlab',
    url: gitlabUrl,
    branch: 'main',  // 只克隆main分支作为基础索引
    gitlabToken
  });
  
  return {
    repoId,
    status: 'indexing'
  };
});
```

#### 1.3 URL规范化函数

```typescript
function normalizeGitLabUrl(url: string): string {
  // 去除.git后缀
  let normalized = url.replace(/\.git$/, '');
  
  // 统一SSH和HTTPS格式
  // git@gitlab.com:team/project.git → https://gitlab.com/team/project
  // https://gitlab.com/team/project.git → https://gitlab.com/team/project
  
  if (normalized.startsWith('git@')) {
    // SSH格式：git@gitlab.com:team/project
    normalized = normalized
      .replace(/^git@/, 'https://')
      .replace(/:/, '/');
  }
  
  return normalized;
}

function extractProjectName(url: string): string {
  // https://gitlab.com/team/project → project
  // git@gitlab.com:team/project.git → project
  const parts = url.replace(/\.git$/, '').split('/');
  return parts[parts.length - 1];
}
```

#### 1.4 数据库改造

```sql
-- 添加 gitlab_url 字段和唯一索引
ALTER TABLE repos ADD COLUMN gitlab_url TEXT;
CREATE UNIQUE INDEX idx_repos_gitlab_url ON repos(gitlab_url);

-- 添加源类型字段（区分上传/GitLab克隆）
ALTER TABLE repos ADD COLUMN source TEXT DEFAULT 'upload';
-- source: 'upload' | 'gitlab'
```

### 2. VSCode扩展改造

#### 2.1 修改初始化流程

```typescript
// src/indexing/workspaceIndexer.ts
export class WorkspaceIndexer {
  /**
   * 初始化工作区索引
   */
  async indexWorkspace(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    // 1. 权限检查
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
    
    // 3. 检查后端是否已有此项目的索引
    const checkResult = await this.apiService.repos.checkByGitLabUrl(gitInfo.remoteUrl);
    
    if (checkResult.exists) {
      // ✅ 服务器已有索引，直接使用
      const repo = checkResult.repo;
      this.repoRegistry.registerRepo(
        workspaceFolder.uri.toString(),
        repo.id,
        repo.name
      );
      
      vscode.window.showInformationMessage(
        `✅ 此项目已索引，可直接使用（共享索引）\n` +
        `💡 如需更新索引，请使用"增量索引"命令`
      );
      
      this.repoRegistry.updateStatus(workspaceFolder.uri.toString(), 'ready');
    } else {
      // ❌ 服务器未索引，询问是否初始化
      const action = await vscode.window.showInformationMessage(
        `此项目尚未索引。是否从GitLab克隆并创建基础索引？\n` +
        `（其他用户将共享此索引，约需10分钟）`,
        '是',
        '否'
      );
      
      if (action === '是') {
        await this.initializeFromGitLab(workspaceFolder, gitInfo.remoteUrl);
      }
    }
  }
  
  /**
   * 从GitLab初始化索引（只执行一次）
   */
  private async initializeFromGitLab(
    workspaceFolder: vscode.WorkspaceFolder,
    gitlabUrl: string
  ): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration('codelens');
      const gitlabToken = config.get<string>('gitlabToken');
      
      vscode.window.showInformationMessage('正在从GitLab克隆并索引...');
      
      // 请求后端从GitLab克隆main分支并索引
      const result = await this.apiService.repos.createFromGitLab(gitlabUrl, gitlabToken);
      
      // 注册到本地状态
      this.repoRegistry.registerRepo(
        workspaceFolder.uri.toString(),
        result.repoId,
        workspaceFolder.name
      );
      
      // 监控索引进度
      await this.monitorProgress(result.repoId, workspaceFolder.uri.toString());
      
      vscode.window.showInformationMessage(
        `✅ 基础索引创建完成！\n` +
        `💡 如需更新索引，请使用"增量索引"命令`
      );
    } catch (error: any) {
      vscode.window.showErrorMessage(`初始化失败: ${error.message}`);
    }
  }
  
  /**
   * 增量索引（手动触发）
   */
  async incrementalIndex(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    const workspaceUri = workspaceFolder.uri.toString();
    const repoId = this.repoRegistry.getRepoId(workspaceUri);
    
    if (!repoId) {
      vscode.window.showErrorMessage('请先初始化工作区索引');
      return;
    }
    
    try {
      vscode.window.showInformationMessage('正在检测变更文件...');
      
      // 获取变更的文件
      const changedFiles = await this.getChangedFiles(workspaceFolder.uri.fsPath);
      
      if (changedFiles.length === 0) {
        vscode.window.showInformationMessage('没有检测到变更文件');
        return;
      }
      
      vscode.window.showInformationMessage(
        `检测到 ${changedFiles.length} 个变更文件，正在增量索引...`
      );
      
      // 创建增量ZIP（只包含变更文件）
      const zipPath = await this.createIncrementalZip(
        workspaceFolder.uri.fsPath,
        changedFiles
      );
      
      // 上传增量ZIP
      await this.apiService.repos.uploadIncremental(repoId, zipPath);
      
      // 等待索引完成
      await this.monitorProgress(repoId, workspaceUri);
      
      vscode.window.showInformationMessage('✅ 增量索引完成！');
    } catch (error: any) {
      vscode.window.showErrorMessage(`增量索引失败: ${error.message}`);
    }
  }
  
  /**
   * 获取变更的文件（相对于上次索引）
   */
  private async getChangedFiles(workspacePath: string): Promise<string[]> {
    try {
      // 获取未提交的变更
      const { stdout: unstaged } = await execAsync(
        'git diff --name-only',
        { cwd: workspacePath }
      );
      
      // 获取已暂存的变更
      const { stdout: staged } = await execAsync(
        'git diff --cached --name-only',
        { cwd: workspacePath }
      );
      
      // 获取未跟踪的文件
      const { stdout: untracked } = await execAsync(
        'git ls-files --others --exclude-standard',
        { cwd: workspacePath }
      );
      
      // 合并所有变更文件
      const allFiles = [
        ...unstaged.trim().split('\n'),
        ...staged.trim().split('\n'),
        ...untracked.trim().split('\n')
      ].filter(f => f && this.isSupportedFile(f));
      
      // 去重
      return [...new Set(allFiles)];
    } catch (error) {
      console.error('Failed to get changed files:', error);
      return [];
    }
  }
  
  /**
   * 创建增量ZIP（只包含变更文件）
   */
  private async createIncrementalZip(
    workspacePath: string,
    changedFiles: string[]
  ): Promise<string> {
    const archiver = require('archiver');
    const fs = require('fs');
    const path = require('path');
    
    const zipPath = path.join(os.tmpdir(), `codelens-incremental-${Date.now()}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    archive.pipe(output);
    
    // 只添加变更的文件
    for (const file of changedFiles) {
      const filePath = path.join(workspacePath, file);
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: file });
      }
    }
    
    await archive.finalize();
    
    return new Promise((resolve, reject) => {
      output.on('close', () => resolve(zipPath));
      output.on('error', reject);
    });
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

#### 2.2 添加增量索引命令

```typescript
// src/commands/indexing.ts
import * as vscode from 'vscode';
import { WorkspaceIndexer } from '../indexing/workspaceIndexer';

export function registerIndexingCommands(
  context: vscode.ExtensionContext,
  indexer: WorkspaceIndexer
) {
  // 初始化索引
  context.subscriptions.push(
    vscode.commands.registerCommand('codelens.indexWorkspace', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('请先打开一个工作区');
        return;
      }
      await indexer.indexWorkspace(workspaceFolder);
    })
  );
  
  // 增量索引（新增）
  context.subscriptions.push(
    vscode.commands.registerCommand('codelens.incrementalIndex', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('请先打开一个工作区');
        return;
      }
      await indexer.incrementalIndex(workspaceFolder);
    })
  );
  
  // 重新索引（完整索引）
  context.subscriptions.push(
    vscode.commands.registerCommand('codelens.reindexWorkspace', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('请先打开一个工作区');
        return;
      }
      
      const action = await vscode.window.showWarningMessage(
        '重新索引将上传所有文件，可能需要较长时间。是否继续？',
        '是',
        '否'
      );
      
      if (action === '是') {
        // 清除本地注册
        const workspaceUri = workspaceFolder.uri.toString();
        // repoRegistry.unregister(workspaceUri);
        
        // 重新索引
        await indexer.indexWorkspace(workspaceFolder);
      }
    })
  );
}
```

#### 2.3 更新package.json

```json
{
  "contributes": {
    "commands": [
      {
        "command": "codelens.indexWorkspace",
        "title": "CodeLens: 初始化索引"
      },
      {
        "command": "codelens.incrementalIndex",
        "title": "CodeLens: 增量索引",
        "icon": "$(sync)"
      },
      {
        "command": "codelens.reindexWorkspace",
        "title": "CodeLens: 重新索引（完整）"
      }
    ],
    "menus": {
      "commandPalette": [
        {
          "command": "codelens.indexWorkspace"
        },
        {
          "command": "codelens.incrementalIndex"
        },
        {
          "command": "codelens.reindexWorkspace"
        }
      ],
      "editor/title": [
        {
          "command": "codelens.incrementalIndex",
          "group": "navigation",
          "when": "codelens.indexed"
        }
      ]
    }
  }
}
```

#### 2.4 添加API方法

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
  
  /**
   * 上传增量ZIP
   */
  async uploadIncremental(repoId: number, zipPath: string): Promise<void> {
    const fs = require('fs');
    const formData = new FormData();
    formData.append('file', fs.createReadStream(zipPath));
    
    return this.client.request(`/repos/${repoId}/incremental`, {
      method: 'POST',
      body: formData
    });
  }
}
```

### 3. 后端增量索引API（假设已存在）

```typescript
// POST /repos/:repoId/incremental
// 上传增量ZIP，只索引变更的文件
fastify.post('/repos/:repoId/incremental', async (request, reply) => {
  const { repoId } = request.params;
  const data = await request.file();
  
  // 保存ZIP
  const zipPath = await saveUploadedFile(data);
  
  // 解压并获取文件列表
  const files = await extractZip(zipPath);
  
  // 只索引这些文件
  await enqueueIncrementalIndexJob({
    repoId,
    files
  });
  
  return { status: 'indexing' };
});
```

## 用户体验

### 场景1：第一个用户（初始化）

```
1. 打开工作区
2. 检测到 git@gitlab.com:team/project.git
3. 提示："此项目尚未索引。是否从GitLab克隆并创建基础索引？（其他用户将共享此索引，约需10分钟）"
4. 点击"是"
5. 后端从GitLab克隆main分支
6. 开始索引（10分钟）
7. 完成，提示："✅ 基础索引创建完成！💡 如需更新索引，请使用'增量索引'命令"
```

### 场景2：后续用户（直接使用）

```
1. 打开工作区
2. 检测到 git@gitlab.com:team/project.git
3. 查询后端，发现已索引
4. 提示："✅ 此项目已索引，可直接使用（共享索引）💡 如需更新索引，请使用'增量索引'命令"
5. 立即可用（0秒等待）
```

### 场景3：日常开发（增量索引）

```
开发者在 feature-login 分支工作：

1. 修改了 login.ts, auth.ts, user.ts
2. 想要查询最新代码的调用关系
3. 点击编辑器右上角的"增量索引"按钮（或命令面板）
4. 检测到3个变更文件
5. 上传变更文件（30秒）
6. 增量索引完成
7. 可以查询最新代码
```

## 优势

### ✅ 节省资源

| 场景 | 当前方案 | 优化方案 | 节省 |
|------|---------|---------|------|
| 10人初始化同一项目 | 10次完整索引 | 1次完整索引 | 90% |
| 日常增量更新 | 上传全部文件 | 只上传变更文件 | 95% |

### ✅ 灵活控制

- 每个开发者根据自己的分支情况决定何时刷新
- 不会被自动同步打断工作流程
- 增量索引速度快（30秒 vs 10分钟）

### ✅ 用户体验

- 第一个用户：等待10分钟（初始化）
- 后续用户：0秒等待（直接使用）
- 日常更新：30秒（增量索引）

## 配置选项

```json
{
  // VSCode扩展配置
  "codelens.useSharedIndex": true,  // 使用共享索引（默认开启）
  "codelens.gitlabToken": "glpat-xxx",  // 用于克隆私有仓库
  "codelens.autoIncrementalIndex": false  // 不自动增量索引，手动控制
}
```

## 实施步骤

### 阶段1：后端改造（1天）

1. ✅ 数据库添加 `gitlab_url` 字段和唯一索引
2. ✅ 实现 `GET /repos/check` API
3. ✅ 实现 `POST /repos/from-gitlab` API
4. ✅ 实现URL规范化函数
5. ✅ 确认增量索引API已存在

### 阶段2：VSCode扩展改造（1天）

1. ✅ 修改 `workspaceIndexer.ts`，添加共享索引检查
2. ✅ 实现 `incrementalIndex` 方法
3. ✅ 添加 `codelens.incrementalIndex` 命令
4. ✅ 添加编辑器工具栏按钮
5. ✅ 更新API方法

### 阶段3：测试（0.5天）

1. ✅ 测试初始化流程
2. ✅ 测试共享索引
3. ✅ 测试增量索引
4. ✅ 测试不同分支场景

**总工作量**：约2.5天

## 总结

**核心改进**：
1. ✅ 初始化时共享基础索引，避免重复克隆
2. ✅ 日常使用时手动增量索引，适应不同分支
3. ✅ 只上传变更文件，速度快（30秒）
4. ✅ 用户自主控制刷新时机，灵活方便
5. ✅ 节省90%的初始化资源，95%的增量更新资源

**与V1的区别**：
- ❌ 去掉了自动同步服务（不适合多分支场景）
- ✅ 保留了共享初始化索引（节省资源）
- ✅ 添加了手动增量索引（灵活控制）

这个方案既解决了资源浪费问题，又适应了多分支开发的实际场景！
