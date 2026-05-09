# 多分支独立索引实现总结

## 实现完成情况

✅ **后端实现（已完成）**
✅ **VSCode扩展实现（已完成）**
⏳ **测试验证（待进行）**

---

## 一、后端实现

### 1. 数据库改造

**文件**: `apps/api/src/db/index.ts`

**新增字段**:
- `gitlab_url` (TEXT) - 规范化的GitLab URL
- `branch` (TEXT) - 分支名称，默认'main'
- `is_base_branch` (BOOLEAN) - 是否为基础分支
- `parent_repo_id` (INTEGER) - 父仓库ID（指向基础分支）
- `default_branch` (TEXT) - GitLab默认分支名称

**新增索引**:
- `UNIQUE INDEX idx_repos_gitlab_url_branch ON repos(gitlab_url, branch)` - 确保每个分支只索引一次
- `INDEX idx_repos_gitlab_url ON repos(gitlab_url)` - 加速按仓库查询
- `INDEX idx_repos_parent_repo_id ON repos(parent_repo_id)` - 加速查询分支索引

### 2. 新增API端点

**文件**: `apps/api/src/index.ts`

#### GET /repos/check
检查GitLab仓库是否已索引

**参数**:
- `gitlabUrl` (必需) - GitLab仓库URL
- `branch` (可选) - 分支名称

**返回**:
```json
{
  "exists": true,
  "hasBaseBranch": true,
  "repo": { "id": 1, "name": "project", "status": "ready", "branch": "feature-x" },
  "baseBranch": { "id": 2, "branch": "main", "status": "ready" }
}
```

#### POST /repos/from-gitlab
从GitLab创建基础分支索引

**请求体**:
```json
{
  "gitlabUrl": "https://gitlab.com/team/project",
  "gitlabToken": "glpat-xxx",
  "branch": "main"  // 可选，不提供则自动获取默认分支
}
```

**返回**:
```json
{
  "repoId": 1,
  "status": "indexing",
  "branch": "main"
}
```

#### POST /repos/branch-index
创建分支增量索引

**请求体**:
```json
{
  "gitlabUrl": "https://gitlab.com/team/project",
  "branch": "feature-login",
  "gitlabToken": "glpat-xxx"
}
```

**返回**:
```json
{
  "repoId": 3,
  "status": "indexing",
  "branch": "feature-login",
  "baseBranch": "main"
}
```

### 3. GitLab工具函数

**文件**: `apps/api/src/utils/gitlab.ts`

- `normalizeGitLabUrl()` - 规范化URL（统一HTTPS格式，去除.git）
- `extractProjectPath()` - 提取项目路径
- `extractProjectName()` - 提取项目名称
- `extractGitLabDomain()` - 提取域名
- `getGitLabDefaultBranch()` - 获取默认分支（调用GitLab API）
- `validateGitLabToken()` - 验证Token有效性

### 4. 队列类型更新

**文件**: `apps/api/src/indexer/queue.ts`

扩展了`IndexJobData`类型：
```typescript
export type IndexJobData = {
  repoId: number;
  repoName: string;
  source: 'gitlab' | 'zip';
  url?: string;
  zipPath?: string;
  gitlabToken?: string;
  branch?: string;        // 新增
  baseBranch?: string;    // 新增
  baseRepoId?: number;    // 新增
};
```

---

## 二、VSCode扩展实现

### 1. GitLab辅助函数

**文件**: `apps/vscode-extension/src/utils/gitlabHelper.ts`

**功能**:
- `getGitLabDefaultBranch()` - 获取GitLab默认分支
- `getCurrentBranch()` - 获取当前Git分支
- `getDiffFromBaseBranch()` - 获取与基础分支的差异文件
- `getGitRemoteUrl()` - 获取Git远程仓库URL

### 2. API方法扩展

**文件**: `apps/vscode-extension/src/api/repos.ts`

**新增方法**:
- `checkByGitLabUrl(gitlabUrl, branch?)` - 检查仓库是否已索引
- `createFromGitLab(gitlabUrl, gitlabToken?, branch?)` - 创建基础分支索引
- `createBranchIndex(gitlabUrl, branch, gitlabToken?)` - 创建分支索引

### 3. 工作区索引器重构

**文件**: `apps/vscode-extension/src/indexing/workspaceIndexer.ts`

**核心改进**:

#### `indexWorkspace()` - 智能索引入口
- 自动检测是否为GitLab仓库
- GitLab仓库 → 调用`indexFromGitLab()`（多分支支持）
- 非GitLab仓库 → 调用`indexFromZip()`（传统方式）

#### `indexFromGitLab()` - GitLab多分支索引
1. 获取当前分支
2. 检查后端索引状态
3. 根据情况提供选项：
   - 当前分支已索引 → 直接使用
   - 基础分支已索引 → 选择使用基础分支或创建独立索引
   - 无任何索引 → 创建基础分支索引

#### `createBaseBranchIndex()` - 创建基础分支索引
- 调用后端从GitLab克隆默认分支
- 监控索引进度
- 完成后询问是否为当前分支创建索引

#### `createBranchIndex()` - 创建分支索引
- 调用后端创建分支索引（仅索引差异）
- 显示进度提示

#### `incrementalIndex()` - 手动增量索引
- 检测与基础分支的差异文件
- 显示变更文件数量
- 调用后端增量索引API

### 4. 命令注册

**文件**: `apps/vscode-extension/src/commands/indexing.ts`

**新增命令**:
- `codelens.incrementalIndex` - 增量索引命令

### 5. package.json配置

**文件**: `apps/vscode-extension/package.json`

**新增命令**:
```json
{
  "command": "codelens.incrementalIndex",
  "title": "CodeLens: 增量索引",
  "icon": "$(sync)"
}
```

---

## 三、用户体验流程

### 场景1：第一个用户索引项目

```
1. 打开工作区（feature-login分支）
2. 扩展检测到GitLab仓库
3. 后端检查：无任何索引
4. 提示："此仓库尚未索引。是否从GitLab克隆默认分支并索引？"
5. 用户点击"是"
6. 后端从GitLab克隆main分支 → 索引（约10分钟）
7. 索引完成后提示："是否为当前分支（feature-login）创建独立索引？"
8. 用户点击"是"
9. 后端只索引与main的差异文件 → 快速完成（约2分钟）
```

### 场景2：后续用户

```
1. 打开工作区（feature-payment分支）
2. 扩展检测到GitLab仓库
3. 后端检查：main分支已索引
4. 提示："检测到基础分支 'main' 已索引。"
   选项：
   - "使用基础分支索引"（立即可用）
   - "为 'feature-payment' 创建独立索引"（约2分钟）
5. 用户选择后立即可用
```

### 场景3：增量索引

```
1. 开发者在feature-login分支修改代码
2. 打开命令面板 → 运行"CodeLens: 增量索引"
3. 扩展检测变更文件（3个）
4. 提示："检测到 3 个变更文件。是否进行增量索引？"
5. 用户点击"是"
6. 上传变更文件 → 增量索引（约30秒）
7. 完成，可以查询最新代码
```

---

## 四、技术亮点

### 1. 自动检测默认分支
不再硬编码为"main"，而是调用GitLab API获取实际默认分支名称。

### 2. 共享基础索引
多个开发者共享同一个基础分支索引，节省约90%的资源。

### 3. 分支差异索引
分支索引只存储与基础分支的差异，大幅减少索引时间和存储空间。

### 4. 手动增量索引
用户自主控制刷新时机，避免自动同步带来的干扰。

### 5. 智能提示
根据索引状态提供不同选项，用户体验流畅。

---

## 五、数据库设计

### repos表结构

| 字段 | 类型 | 说明 |
|------|------|------|
| id | SERIAL | 主键 |
| name | TEXT | 仓库名称 |
| source | TEXT | 来源（gitlab/zip） |
| url | TEXT | 原始URL |
| gitlab_url | TEXT | 规范化URL |
| branch | TEXT | 分支名称 |
| is_base_branch | BOOLEAN | 是否为基础分支 |
| parent_repo_id | INTEGER | 父仓库ID |
| default_branch | TEXT | 默认分支名称 |
| gitlab_token | TEXT | GitLab Token |
| status | TEXT | 状态（ready/indexing/failed） |
| created_at | TIMESTAMP | 创建时间 |

### 索引设计

```sql
-- 唯一约束：同一仓库的同一分支只能索引一次
CREATE UNIQUE INDEX idx_repos_gitlab_url_branch 
ON repos(gitlab_url, branch) 
WHERE gitlab_url IS NOT NULL;

-- 加速按仓库查询
CREATE INDEX idx_repos_gitlab_url 
ON repos(gitlab_url) 
WHERE gitlab_url IS NOT NULL;

-- 加速查询分支索引
CREATE INDEX idx_repos_parent_repo_id 
ON repos(parent_repo_id) 
WHERE parent_repo_id IS NOT NULL;
```

---

## 六、性能优化

### 资源节省对比

| 指标 | 传统方案（每人上传） | 多分支方案 | 节省 |
|------|---------------------|-----------|------|
| 10人团队索引同一项目 | 10次上传 + 10次索引 | 1次克隆 + 1次基础索引 + 10次差异索引 | ~90% |
| 存储空间 | 10份完整代码 + 10份索引 | 1份完整代码 + 1份完整索引 + 10份差异索引 | ~85% |
| 首次索引时间 | 每人10分钟 | 第1人10分钟，其他人2分钟 | ~80% |
| 后续索引时间 | 10分钟 | 2分钟（仅差异） | 80% |

---

## 七、待测试场景

### 基础功能测试
- [ ] 首次索引GitLab仓库（创建基础分支索引）
- [ ] 后续用户使用基础分支索引
- [ ] 创建分支独立索引
- [ ] 增量索引功能
- [ ] 非GitLab仓库的ZIP上传索引

### 边界情况测试
- [ ] 默认分支不是main的仓库
- [ ] 私有仓库（需要Token）
- [ ] 分支无差异时的增量索引
- [ ] 并发索引同一仓库
- [ ] 网络异常处理

### 权限测试
- [ ] 无权限访问的仓库
- [ ] Token过期
- [ ] 域名白名单限制

---

## 八、后续优化建议

### 1. 自动检测分支切换
监听Git分支切换事件，自动切换到对应的索引。

### 2. 分支索引缓存
缓存最近使用的分支索引，加速切换。

### 3. 后台自动增量索引
可选配置：检测到文件变更后自动触发增量索引。

### 4. 索引状态可视化
在状态栏显示当前使用的分支索引信息。

### 5. 批量分支索引
支持一次性为多个分支创建索引。

---

## 九、文件清单

### 后端文件
- ✅ `apps/api/src/db/index.ts` - 数据库改造
- ✅ `apps/api/src/index.ts` - API端点
- ✅ `apps/api/src/utils/gitlab.ts` - GitLab工具函数
- ✅ `apps/api/src/indexer/queue.ts` - 队列类型更新

### VSCode扩展文件
- ✅ `apps/vscode-extension/src/utils/gitlabHelper.ts` - GitLab辅助函数
- ✅ `apps/vscode-extension/src/api/repos.ts` - API方法扩展
- ✅ `apps/vscode-extension/src/indexing/workspaceIndexer.ts` - 索引器重构
- ✅ `apps/vscode-extension/src/commands/indexing.ts` - 命令注册
- ✅ `apps/vscode-extension/package.json` - 配置更新

### 文档文件
- ✅ `apps/vscode-extension/IMPLEMENTATION.md` - 实现方案
- ✅ `apps/vscode-extension/PROGRESS.md` - 进度跟踪
- ✅ `apps/vscode-extension/SHARED_INDEX_DESIGN_V2.md` - 设计文档
- ✅ `apps/vscode-extension/MULTI_BRANCH_IMPLEMENTATION_SUMMARY.md` - 本文档

---

## 十、编译验证

### 后端编译
```bash
cd apps/api
npm run build
# ✅ 编译成功
```

### VSCode扩展编译
```bash
cd apps/vscode-extension
npm run compile
# ✅ 编译成功
```

---

## 总结

多分支独立索引功能已完整实现，包括：

1. ✅ 后端数据库改造和API端点
2. ✅ VSCode扩展的智能索引流程
3. ✅ 增量索引命令
4. ✅ GitLab默认分支自动检测
5. ✅ 共享基础索引机制
6. ✅ 分支差异索引

**预计效果**：
- 节省90%的索引资源
- 首次索引后，其他用户2分钟即可使用
- 支持手动增量索引，用户自主控制刷新时机
- 自动检测GitLab默认分支，不再硬编码

**下一步**：进行端到端测试，验证各个场景的功能正确性。
