# 多分支独立索引实现进度

## ✅ 已完成

### 1. 文档和设计
- ✅ 创建了详细的实现方案文档（IMPLEMENTATION.md）
- ✅ 创建了GitLab工具函数（apps/api/src/utils/gitlab.ts）
  - normalizeGitLabUrl: 规范化URL
  - extractProjectPath: 提取项目路径
  - extractGitLabDomain: 提取域名
  - extractProjectName: 提取项目名称
  - getGitLabDefaultBranch: 获取默认分支（支持非main分支）
  - validateGitLabToken: 验证Token

### 2. VSCode扩展改进
- ✅ 限制文件类型为前端语言（.ts, .tsx, .js, .jsx, .vue）
- ✅ 实现完整的权限控制机制
- ✅ 所有提示消息中文化
- ✅ 创建权限控制详细文档（PERMISSION_GUIDE.md）

## 🚧 待实现

### 后端API（约1-2天）

#### 1. 数据库表结构改造
```sql
-- 需要在 apps/api/src/db/index.ts 的 initDatabase() 中添加
ALTER TABLE repos ADD COLUMN IF NOT EXISTS gitlab_url TEXT;
ALTER TABLE repos ADD COLUMN IF NOT EXISTS branch TEXT DEFAULT 'main';
ALTER TABLE repos ADD COLUMN IF NOT EXISTS is_base_branch BOOLEAN DEFAULT false;
ALTER TABLE repos ADD COLUMN IF NOT EXISTS parent_repo_id INTEGER REFERENCES repos(id);
ALTER TABLE repos ADD COLUMN IF NOT EXISTS default_branch TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_gitlab_url_branch ON repos(gitlab_url, branch);
CREATE INDEX IF NOT EXISTS idx_repos_gitlab_url ON repos(gitlab_url);
CREATE INDEX IF NOT EXISTS idx_repos_parent_repo_id ON repos(parent_repo_id);
```

#### 2. 新增API端点（在 apps/api/src/index.ts 中添加）

**a. 检查仓库是否已索引**
```typescript
GET /repos/check?gitlabUrl=xxx&branch=xxx
返回: { exists: boolean, hasBaseBranch: boolean, repo?: any, baseBranch?: any }
```

**b. 从GitLab创建基础分支索引**
```typescript
POST /repos/from-gitlab
Body: { gitlabUrl, gitlabToken?, branch? }
返回: { repoId, status, branch }
```

**c. 创建分支增量索引**
```typescript
POST /repos/branch-index
Body: { gitlabUrl, branch, gitlabToken? }
返回: { repoId, status, branch, baseBranch }
```

### VSCode扩展改造（约1天）

#### 1. 创建GitLab辅助函数
文件：`apps/vscode-extension/src/utils/gitlabHelper.ts`
- getGitLabDefaultBranch: 获取默认分支
- getCurrentBranch: 获取当前分支
- getDiffFromBaseBranch: 获取与基础分支的差异文件

#### 2. 更新API方法
文件：`apps/vscode-extension/src/api/repos.ts`
- checkByGitLabUrl(gitlabUrl, branch?)
- createFromGitLab(gitlabUrl, gitlabToken?, branch?)
- createBranchIndex(gitlabUrl, branch, gitlabToken?)

#### 3. 更新索引流程
文件：`apps/vscode-extension/src/indexing/workspaceIndexer.ts`
- 修改 indexWorkspace() 方法，支持多分支检查
- 添加 initializeFromGitLab() 方法
- 添加 incrementalIndex() 方法（手动增量索引）
- 添加 createBranchIndex() 方法

#### 4. 添加命令
文件：`apps/vscode-extension/src/commands/indexing.ts`
- codelens.incrementalIndex: 增量索引命令

#### 5. 更新package.json
添加新命令到命令面板和编辑器工具栏

## 📋 实施步骤

### 第1步：后端数据库改造（0.5天）
1. 修改 `apps/api/src/db/index.ts`
2. 在 `initDatabase()` 函数中添加新字段和索引
3. 测试数据库迁移

### 第2步：后端API实现（1天）
1. 在 `apps/api/src/index.ts` 中导入GitLab工具函数
2. 实现 `/repos/check` 端点
3. 实现 `/repos/from-gitlab` 端点
4. 实现 `/repos/branch-index` 端点
5. 测试API端点

### 第3步：VSCode扩展实现（1天）
1. 创建 `gitlabHelper.ts`
2. 更新 `repos.ts` API方法
3. 修改 `workspaceIndexer.ts`
4. 添加增量索引命令
5. 更新 `package.json`
6. 编译测试

### 第4步：端到端测试（0.5天）
1. 测试基础分支索引
2. 测试分支索引
3. 测试增量索引
4. 测试多用户场景

## 🎯 预期效果

### 场景1：第一个用户索引项目
```
1. 打开工作区（feature-login分支）
2. 检测GitLab URL
3. 后端检查：无基础分支
4. 提示："是否从GitLab克隆默认分支（main）并索引？"
5. 用户确认 → 后端克隆main分支 → 索引（10分钟）
6. 提示："是否为当前分支（feature-login）创建独立索引？"
7. 用户确认 → 只索引与main的差异文件 → 快速完成（2分钟）
```

### 场景2：后续用户
```
1. 打开工作区（feature-payment分支）
2. 检测GitLab URL
3. 后端检查：已有main分支索引
4. 提示："检测到main分支已索引。"
   选项：
   - "使用main分支索引"（立即可用）
   - "为当前分支创建独立索引"（2分钟）
5. 用户选择后立即可用
```

### 场景3：增量索引
```
1. 开发者在feature-login分支修改代码
2. 点击"增量索引"按钮
3. 检测变更文件（3个）
4. 上传变更文件 → 增量索引（30秒）
5. 完成，可以查询最新代码
```

## 📝 注意事项

1. **默认分支检测**：使用GitLab API获取默认分支，不硬编码为main
2. **权限验证**：每个分支索引仍然需要验证用户权限
3. **存储优化**：分支索引只存储与基础分支的差异
4. **用户选择**：让用户决定是使用基础分支索引还是创建独立索引
5. **增量索引**：提供手动增量索引按钮，用户自主控制刷新时机

## 🔗 相关文档

- [IMPLEMENTATION.md](./IMPLEMENTATION.md) - 详细实现代码
- [SHARED_INDEX_DESIGN_V2.md](./SHARED_INDEX_DESIGN_V2.md) - 共享索引设计
- [PERMISSION_GUIDE.md](./PERMISSION_GUIDE.md) - 权限控制指南

## 下一步行动

建议按照上述步骤顺序实施：
1. 先完成后端数据库和API
2. 再实现VSCode扩展
3. 最后进行端到端测试

预计总工作量：**3天**
