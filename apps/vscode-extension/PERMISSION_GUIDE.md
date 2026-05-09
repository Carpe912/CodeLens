# CodeLens VSCode 扩展 - 权限控制说明

## 权限控制机制

为了保护公司代码安全，扩展提供了多层权限验证机制，确保只有授权的项目才能被索引。

## 权限验证原理详解

### 工作流程

当你在VSCode中打开一个项目时，扩展会执行以下步骤来验证权限：

#### 1. 获取Git远程仓库URL

扩展在工作区目录执行Git命令：

```bash
git remote get-url origin

# 可能返回：
# HTTPS格式: https://gitlab.company.com/frontend-team/my-project.git
# SSH格式: git@gitlab.company.com:frontend-team/my-project.git
```

#### 2. 解析GitLab项目信息

从远程URL中提取GitLab域名和项目路径：

```typescript
// 输入: git@gitlab.company.com:frontend-team/my-project.git

// 正则匹配解析
const sshMatch = remoteUrl.match(/git@([^:]+):(.+?)(?:\.git)?$/);

// 提取结果:
{
  domain: "gitlab.company.com",           // GitLab域名
  projectPath: "frontend-team/my-project" // 项目路径（组/项目名）
}
```

支持两种URL格式：
- **HTTPS**: `https://gitlab.com/group/project.git`
- **SSH**: `git@gitlab.com:group/project.git`

#### 3. 检查域名白名单

如果配置了 `allowedGitLabDomains`，检查项目域名是否在白名单中：

```typescript
// 你的配置
"codelens.allowedGitLabDomains": ["gitlab.company.com"]

// 检查逻辑
if (domain === "gitlab.company.com") {
  // ✅ 域名在白名单中，继续检查
} else {
  // ❌ 域名不在白名单中，拒绝索引
  return { 
    allowed: false, 
    reason: "GitLab域名不在允许列表中" 
  };
}
```

#### 4. 调用GitLab API验证权限

这是**最关键的一步**，使用你配置的GitLab Token调用GitLab API：

```typescript
// 构造API URL（需要URL编码项目路径）
const encodedPath = encodeURIComponent("frontend-team/my-project");
// 结果: "frontend-team%2Fmy-project"

const apiUrl = "https://gitlab.company.com/api/v4/projects/frontend-team%2Fmy-project";

// 发送HTTP请求
const response = await fetch(apiUrl, {
  headers: {
    'PRIVATE-TOKEN': 'glpat-your-token-here'
  }
});
```

**GitLab API内部处理逻辑**：

```
1. 接收到请求，提取 PRIVATE-TOKEN
   ↓
2. 查询这个Token属于哪个用户（例如：张三）
   ↓
3. 查询项目 "frontend-team/my-project" 的成员列表
   ↓
4. 检查用户"张三"是否在成员列表中
   ↓
5. 如果是成员 → 返回 200 OK + 项目详细信息
   如果不是成员 → 返回 404 Not Found
   如果Token无效 → 返回 401 Unauthorized
```

#### 5. 根据响应决定是否允许索引

```typescript
if (response.status === 200) {
  // ✅ 你有权限访问这个项目
  return { 
    allowed: true,
    projectPath: "frontend-team/my-project"
  };
} else if (response.status === 404) {
  // ❌ 你不是这个项目的成员
  return { 
    allowed: false, 
    reason: "您没有访问 GitLab 项目 'frontend-team/my-project' 的权限" 
  };
} else if (response.status === 401) {
  // ❌ Token无效
  return { 
    allowed: false, 
    reason: "GitLab Token无效或已过期" 
  };
}
```

### 完整示例

假设你在VSCode中打开了项目 `/Users/username/projects/my-frontend-app`：

```bash
# 步骤1: 扩展执行Git命令
$ cd /Users/username/projects/my-frontend-app
$ git remote get-url origin
git@gitlab.company.com:frontend-team/my-frontend-app.git

# 步骤2: 解析GitLab信息
domain = "gitlab.company.com"
projectPath = "frontend-team/my-frontend-app"

# 步骤3: 检查域名白名单
allowedDomains = ["gitlab.company.com"]
✅ 域名匹配

# 步骤4: 调用GitLab API
GET https://gitlab.company.com/api/v4/projects/frontend-team%2Fmy-frontend-app
Headers: PRIVATE-TOKEN: glpat-xxxxxxxxxxxxxxxxxxxx

# 步骤5: GitLab API响应
HTTP 200 OK
{
  "id": 12345,
  "name": "my-frontend-app",
  "path_with_namespace": "frontend-team/my-frontend-app",
  "permissions": {
    "project_access": { "access_level": 30 }  // 30 = Developer
  }
}

# 结果: ✅ 允许索引
```

### 为什么这种方式安全可靠？

#### 1. **利用GitLab官方权限系统**

不需要自己实现权限判断，直接使用GitLab的成员管理系统：
- GitLab维护每个项目的成员列表
- 每个成员有明确的角色（Guest/Reporter/Developer/Maintainer/Owner）
- API自动根据Token对应的用户和项目成员关系判断权限

#### 2. **实时权限验证**

- 权限变更立即生效（在GitLab中添加/移除成员后，下次索引时立即反映）
- 不需要维护额外的权限数据库
- 不会出现权限数据不同步的问题

#### 3. **Token的作用**

Personal Access Token就像你的"数字身份证"：

```typescript
// Token绑定到特定用户
Token: glpat-xxxxxxxxxxxxxxxxxxxx
↓
用户: 张三 (username: zhangsan)
↓
GitLab检查: 张三是否是项目成员？
```

#### 4. **最小权限原则**

只需要 `read_api` 权限：
- ✅ 可以读取项目信息（包括检查访问权限）
- ❌ 不能修改项目（没有写权限）
- ❌ 不能访问敏感数据（如CI/CD变量）

### 手动测试权限验证

你可以使用curl命令手动测试：

```bash
# 1. 测试有权限的项目
curl -H "PRIVATE-TOKEN: glpat-your-token" \
  "https://gitlab.company.com/api/v4/projects/your-team%2Fyour-project"

# 响应: 200 OK
{
  "id": 12345,
  "name": "your-project",
  "path_with_namespace": "your-team/your-project",
  "permissions": {
    "project_access": { "access_level": 30 }
  }
}

# 2. 测试无权限的项目
curl -H "PRIVATE-TOKEN: glpat-your-token" \
  "https://gitlab.company.com/api/v4/projects/other-team%2Fother-project"

# 响应: 404 Not Found
{
  "message": "404 Project Not Found"
}

# 3. 测试无效Token
curl -H "PRIVATE-TOKEN: invalid-token" \
  "https://gitlab.company.com/api/v4/projects/your-team%2Fyour-project"

# 响应: 401 Unauthorized
{
  "message": "401 Unauthorized"
}
```

### 安全性分析

#### ✅ 安全的地方

1. **Token不会离开本地**
   - Token只用于本地调用GitLab API
   - 不会发送到CodeLens API服务器
   - 不会存储在索引数据中

2. **Token存储在用户本地设置**
   - 位置：`~/.config/Code/User/settings.json`
   - 不会提交到Git仓库
   - 只有当前用户可以访问

3. **使用HTTPS加密通信**
   - 所有API请求通过HTTPS
   - Token在传输过程中加密
   - 防止中间人攻击

4. **最小权限原则**
   - 只需要 `read_api` 权限
   - 不需要写权限或管理员权限
   - 即使Token泄露，影响也有限

#### ⚠️ 需要注意的地方

1. **Token泄露风险**
   - ❌ 不要将Token提交到代码仓库
   - ❌ 不要在公共场合分享Token
   - ❌ 不要将Token写入日志文件
   - ✅ 定期更换Token（建议每3个月）

2. **Token过期管理**
   - 创建Token时设置过期时间
   - Token过期后需要重新生成
   - 扩展会提示Token无效

3. **网络安全**
   - 确保使用HTTPS连接GitLab
   - 在不安全的网络环境下谨慎使用
   - 公司内网环境相对安全

### 审计和日志

扩展会在控制台输出详细的权限检查日志：

```
[PermissionChecker] Checking workspace: /Users/username/projects/my-project
[PermissionChecker] Git remote URL: git@gitlab.company.com:frontend-team/my-project.git
[PermissionChecker] GitLab domain: gitlab.company.com
[PermissionChecker] Project path: frontend-team/my-project
[PermissionChecker] Calling GitLab API: https://gitlab.company.com/api/v4/projects/frontend-team%2Fmy-project
[PermissionChecker] API response: 200 OK
[PermissionChecker] Permission check passed ✅
```

查看日志：
1. 打开开发者工具：`Cmd+Shift+I`（Mac）或 `Ctrl+Shift+I`（Windows）
2. 切换到 Console 标签
3. 搜索 `[PermissionChecker]`

### 常见问题

#### Q1: 为什么需要配置Token？

**A**: Token用于验证你的身份。GitLab API需要知道"你是谁"才能判断你是否有权限访问某个项目。

#### Q2: Token会被发送到哪里？

**A**: Token只会发送到你配置的GitLab服务器（如 `gitlab.company.com`），不会发送到CodeLens API服务器或其他地方。

#### Q3: 如果不配置Token会怎样？

**A**: 扩展会跳过GitLab权限验证，只检查域名白名单。这意味着只要域名匹配，就会允许索引（不推荐）。

#### Q4: Token需要什么权限？

**A**: 只需要 `read_api` 权限。这个权限允许读取项目信息，但不能修改任何内容。

#### Q5: 如何知道Token是否有效？

**A**: 尝试索引一个项目，如果提示"GitLab Token无效"，说明Token过期或被撤销，需要重新生成。

#### Q6: 多个GitLab账号怎么办？

**A**: 目前只支持配置一个Token。如果需要访问多个GitLab账号的项目，建议：
- 使用主账号的Token
- 或者将需要索引的项目添加到 `allowedWorkspaces` 白名单

## 权限检查流程

当尝试索引工作区时，扩展会按以下顺序检查：

```
1. 检查是否在"总是允许"列表中 → 是 → 允许索引
   ↓ 否
2. 检查是否为Git仓库 → 否 → 询问用户
   ↓ 是
3. 检查是否有远程仓库 → 否 → 询问用户（本地仓库）
   ↓ 是
4. 检查是否为GitLab仓库 → 否 → 询问用户（非GitLab）
   ↓ 是
5. 检查GitLab域名是否在允许列表 → 否 → 拒绝
   ↓ 是
6. 检查用户是否有该项目访问权限 → 否 → 拒绝
   ↓ 是
7. 允许索引
```

## 配置选项

### 1. `codelens.enablePermissionCheck`
- **类型**: `boolean`
- **默认值**: `true`
- **说明**: 是否启用权限检查
- **建议**: 生产环境保持启用

```json
{
  "codelens.enablePermissionCheck": true
}
```

### 2. `codelens.allowedGitLabDomains`
- **类型**: `string[]`
- **默认值**: `[]`（允许所有域名）
- **说明**: 允许索引的GitLab域名白名单
- **示例**: 
  ```json
  {
    "codelens.allowedGitLabDomains": [
      "gitlab.company.com",
      "gitlab.internal.com"
    ]
  }
  ```

**使用场景**:
- 限制只能索引公司内部GitLab项目
- 防止索引外部或个人GitLab项目

### 3. `codelens.gitlabToken`
- **类型**: `string`
- **默认值**: `""`
- **说明**: GitLab Personal Access Token，用于验证用户是否有项目访问权限
- **权限要求**: `read_api` 或 `api`

**如何获取GitLab Token**:
1. 登录GitLab
2. 进入 `Settings` → `Access Tokens`
3. 创建新Token，勾选 `read_api` 权限
4. 复制Token并配置到VSCode设置中

```json
{
  "codelens.gitlabToken": "glpat-xxxxxxxxxxxxxxxxxxxx"
}
```

**安全提示**:
- Token应该配置在用户设置（User Settings）中，不要提交到代码仓库
- 定期更换Token
- 使用最小权限原则（只需要 `read_api`）

### 4. `codelens.allowedWorkspaces`
- **类型**: `string[]`
- **默认值**: `[]`
- **说明**: 总是允许索引的工作区URI列表
- **自动管理**: 用户选择"总是允许此工作区"时自动添加

```json
{
  "codelens.allowedWorkspaces": [
    "file:///Users/username/projects/my-project",
    "file:///Users/username/projects/another-project"
  ]
}
```

## 使用场景

### 场景1: 公司内部项目（推荐配置）

**需求**: 只允许索引公司GitLab上的项目

**配置**:
```json
{
  "codelens.enablePermissionCheck": true,
  "codelens.allowedGitLabDomains": ["gitlab.company.com"],
  "codelens.gitlabToken": "glpat-your-token-here"
}
```

**效果**:
- ✅ 公司GitLab项目（用户有权限）→ 自动允许
- ❌ 公司GitLab项目（用户无权限）→ 拒绝
- ❌ 外部GitLab项目 → 拒绝
- ❓ 非GitLab项目 → 询问用户

### 场景2: 宽松模式（开发测试）

**需求**: 允许索引所有GitLab项目，但验证权限

**配置**:
```json
{
  "codelens.enablePermissionCheck": true,
  "codelens.allowedGitLabDomains": [],
  "codelens.gitlabToken": "glpat-your-token-here"
}
```

**效果**:
- ✅ 任何GitLab项目（用户有权限）→ 允许
- ❌ 任何GitLab项目（用户无权限）→ 拒绝
- ❓ 非GitLab项目 → 询问用户

### 场景3: 完全信任模式（不推荐）

**需求**: 关闭所有权限检查

**配置**:
```json
{
  "codelens.enablePermissionCheck": false
}
```

**效果**:
- ✅ 所有项目 → 直接允许索引

**警告**: 此模式下任何项目都可以被索引，存在安全风险！

### 场景4: 白名单模式

**需求**: 只允许特定的几个项目

**配置**:
```json
{
  "codelens.enablePermissionCheck": true,
  "codelens.allowedGitLabDomains": ["gitlab.company.com"],
  "codelens.allowedWorkspaces": [
    "file:///Users/username/projects/project-a",
    "file:///Users/username/projects/project-b"
  ]
}
```

**效果**:
- ✅ project-a 和 project-b → 直接允许
- ✅ 其他公司GitLab项目（有权限）→ 允许
- ❌ 其他公司GitLab项目（无权限）→ 拒绝

## 用户交互

### 1. 非Git仓库

**提示**:
```
"my-project" 不是Git仓库。是否允许索引此工作区？
[允许] [拒绝] [总是允许此工作区]
```

### 2. 本地Git仓库（无远程）

**提示**:
```
"my-project" 是本地Git仓库（无远程地址）。是否允许索引？
[允许] [拒绝] [总是允许此工作区]
```

### 3. 非GitLab仓库

**提示**:
```
"my-project" 不是GitLab仓库。是否允许索引？
[允许] [拒绝] [总是允许此工作区]
```

### 4. GitLab域名不在白名单

**错误提示**:
```
无法索引工作区: GitLab域名 "gitlab.external.com" 不在允许列表中。
允许的域名：gitlab.company.com
[查看设置]
```

### 5. 无GitLab项目访问权限

**错误提示**:
```
无法索引工作区: 您没有访问 GitLab 项目 "group/project" 的权限
[查看设置]
```

### 6. 权限验证成功

**成功提示**:
```
已验证权限: group/project
```

## 技术实现

### Git信息获取

```typescript
// 检查是否为Git仓库
git rev-parse --git-dir

// 获取远程仓库URL
git remote get-url origin
```

### GitLab URL解析

支持两种格式：
- **HTTPS**: `https://gitlab.com/group/project.git`
- **SSH**: `git@gitlab.com:group/project.git`

### GitLab API验证

```typescript
// 使用GitLab API检查项目访问权限
GET https://gitlab.company.com/api/v4/projects/:project_path
Headers: PRIVATE-TOKEN: your-token

// 响应状态码
200 - 有权限访问
404 - 项目不存在或无权限
401 - Token无效
```

## 安全最佳实践

### 1. 企业部署建议

**强制配置**:
```json
{
  "codelens.enablePermissionCheck": true,
  "codelens.allowedGitLabDomains": ["gitlab.company.com"]
}
```

**通过VSCode策略强制执行**:
- 使用 `settings.json` 的 `machine` 或 `machineOverridable` 作用域
- 防止用户修改权限设置

### 2. Token管理

**推荐做法**:
- Token存储在用户设置中（`~/.config/Code/User/settings.json`）
- 不要存储在工作区设置中（`.vscode/settings.json`）
- 定期轮换Token（建议每3个月）
- 使用最小权限（`read_api`）

**不推荐做法**:
- ❌ 将Token提交到Git仓库
- ❌ 使用具有写权限的Token
- ❌ 共享Token给其他用户

### 3. 审计日志

扩展会在控制台输出权限检查日志：

```
[PermissionChecker] Checking workspace: /Users/username/projects/my-project
[PermissionChecker] Git remote URL: git@gitlab.company.com:group/project.git
[PermissionChecker] GitLab domain: gitlab.company.com
[PermissionChecker] Project path: group/project
[PermissionChecker] Permission check passed
```

查看日志：
1. 打开开发者工具：`Cmd+Shift+I`
2. 切换到 Console 标签
3. 搜索 `[PermissionChecker]`

## 故障排查

### 问题1: 提示"无权限访问项目"，但我确实有权限

**可能原因**:
- GitLab Token过期或无效
- Token权限不足（需要 `read_api`）
- 网络问题导致API调用失败

**解决方案**:
1. 重新生成GitLab Token
2. 确认Token有 `read_api` 权限
3. 检查网络连接
4. 查看控制台日志确认具体错误

### 问题2: 想要索引非GitLab项目

**解决方案**:
- 方式1: 在提示时选择"总是允许此工作区"
- 方式2: 手动添加到 `codelens.allowedWorkspaces`
- 方式3: 临时关闭权限检查（不推荐）

### 问题3: 如何批量允许多个项目

**解决方案**:
编辑用户设置，批量添加：

```json
{
  "codelens.allowedWorkspaces": [
    "file:///Users/username/projects/project-1",
    "file:///Users/username/projects/project-2",
    "file:///Users/username/projects/project-3"
  ]
}
```

### 问题4: 权限检查太严格，影响开发效率

**解决方案**:
- 开发环境：使用宽松模式（不限制域名）
- 生产环境：使用严格模式（限制域名 + Token验证）

```json
// 开发环境
{
  "codelens.enablePermissionCheck": true,
  "codelens.allowedGitLabDomains": [],
  "codelens.gitlabToken": "your-token"
}

// 生产环境
{
  "codelens.enablePermissionCheck": true,
  "codelens.allowedGitLabDomains": ["gitlab.company.com"],
  "codelens.gitlabToken": "your-token"
}
```

## 总结

权限控制机制提供了灵活的配置选项，可以根据不同场景调整安全级别：

| 场景 | 权限检查 | 域名限制 | Token验证 | 安全级别 |
|------|---------|---------|----------|---------|
| 企业生产 | ✅ | ✅ | ✅ | 🔒🔒🔒 高 |
| 企业开发 | ✅ | ❌ | ✅ | 🔒🔒 中 |
| 个人使用 | ✅ | ❌ | ❌ | 🔒 低 |
| 完全信任 | ❌ | ❌ | ❌ | ⚠️ 无 |

**推荐配置**: 企业生产模式，提供最高安全性。
