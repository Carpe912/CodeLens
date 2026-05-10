# 企业级配置指南

## 📋 概述

Coopwire CodeLens 支持企业级统一配置，管理员可以在代码中配置权限策略，无需每个用户单独设置。

## 🔧 配置文件位置

```
apps/vscode-extension/src/config/enterprise.ts
```

## ⚙️ 配置项说明

### 1. enablePermissionCheck

**说明**：是否启用GitLab权限验证

**默认值**：`true`

**使用场景**：
- `true`：生产环境，启用权限检查，确保只有有权限的用户才能索引
- `false`：开发环境，禁用权限检查，方便测试

```typescript
enablePermissionCheck: true,
```

### 2. allowedGitLabDomains

**说明**：允许索引的GitLab域名白名单

**默认值**：`[]`（空数组表示允许所有域名）

**使用场景**：
- 企业内部GitLab：限制只能索引公司GitLab上的项目
- 多个GitLab实例：支持配置多个域名

```typescript
allowedGitLabDomains: [
  'gitlab.company.com',
  'gitlab.internal.com',
],
```

### 3. defaultApiUrl

**说明**：默认API服务器地址

**默认值**：`http://localhost:8787`

**使用场景**：
- 开发环境：`http://localhost:8787`
- 生产环境：`https://codelens-api.company.com`

```typescript
defaultApiUrl: 'https://codelens-api.company.com',
```

## 📝 配置示例

### 示例1：开发环境配置

```typescript
export const ENTERPRISE_CONFIG = {
  enablePermissionCheck: false,  // 禁用权限检查
  allowedGitLabDomains: [],      // 允许所有域名
  defaultApiUrl: 'http://localhost:8787',
};
```

### 示例2：企业生产环境配置

```typescript
export const ENTERPRISE_CONFIG = {
  enablePermissionCheck: true,   // 启用权限检查
  allowedGitLabDomains: [
    'gitlab.company.com',        // 只允许公司GitLab
  ],
  defaultApiUrl: 'https://codelens-api.company.com',
};
```

### 示例3：多GitLab实例配置

```typescript
export const ENTERPRISE_CONFIG = {
  enablePermissionCheck: true,
  allowedGitLabDomains: [
    'gitlab.company.com',        // 主GitLab
    'gitlab.dev.company.com',    // 开发GitLab
    'gitlab.internal.com',       // 内部GitLab
  ],
  defaultApiUrl: 'https://codelens-api.company.com',
};
```

## 🚀 部署流程

### 1. 修改配置文件

编辑 `src/config/enterprise.ts`：

```typescript
export const ENTERPRISE_CONFIG = {
  enablePermissionCheck: true,
  allowedGitLabDomains: ['gitlab.yourcompany.com'],
  defaultApiUrl: 'https://codelens-api.yourcompany.com',
};
```

### 2. 重新编译

```bash
cd apps/vscode-extension
npm run compile
```

### 3. 打包插件

```bash
npm run package
```

### 4. 分发给用户

将生成的 `.vsix` 文件分发给企业内部用户安装。

## 🔒 权限验证流程

当 `enablePermissionCheck: true` 时，插件会执行以下检查：

1. **检查是否为Git仓库**
   - 非Git仓库 → 询问用户是否允许索引

2. **检查是否为GitLab仓库**
   - 非GitLab仓库 → 询问用户是否允许索引

3. **检查GitLab域名**
   - 如果配置了 `allowedGitLabDomains`
   - 域名不在白名单 → 拒绝索引

4. **检查用户权限**（如果用户配置了GitLab Token）
   - 调用GitLab API验证用户是否有该项目的访问权限
   - 无权限 → 拒绝索引

5. **所有检查通过**
   - 允许索引

## 👥 用户配置

用户只需要配置自己的GitLab Token（如果是私有仓库）：

```json
{
  "codelens.gitlabToken": "glpat-xxxxxxxxxxxx"
}
```

**用户无需配置**：
- ~~`codelens.enablePermissionCheck`~~ （由企业配置控制）
- ~~`codelens.allowedGitLabDomains`~~ （由企业配置控制）

## 🔄 更新配置

如果需要更新企业配置：

1. 修改 `src/config/enterprise.ts`
2. 重新编译和打包
3. 发布新版本给用户
4. 用户更新插件即可

## 📊 配置优先级

```
企业配置 (enterprise.ts) > 用户配置 (VSCode settings)
```

- `enablePermissionCheck`：只读取企业配置
- `allowedGitLabDomains`：只读取企业配置
- `gitlabToken`：读取用户配置（每个用户不同）
- `apiUrl`：用户可以覆盖企业默认配置

## ⚠️ 注意事项

1. **配置文件在代码中**
   - 企业配置是编译到插件中的
   - 修改配置需要重新打包和分发

2. **GitLab Token安全**
   - Token由用户自己配置，不要在企业配置中硬编码
   - Token存储在用户本地VSCode配置中

3. **域名匹配规则**
   - 使用 `includes` 匹配，支持子域名
   - 例如：配置 `gitlab.company.com` 也会匹配 `dev.gitlab.company.com`

4. **开发环境建议**
   - 开发时建议 `enablePermissionCheck: false`
   - 生产环境必须 `enablePermissionCheck: true`

## 🆘 常见问题

### Q1: 如何临时禁用权限检查？
**A**: 修改 `enterprise.ts` 中的 `enablePermissionCheck: false`，重新编译打包。

### Q2: 用户可以绕过企业配置吗？
**A**: 不能。企业配置编译在代码中，用户无法修改。

### Q3: 如何添加新的GitLab域名？
**A**: 在 `allowedGitLabDomains` 数组中添加新域名，重新打包分发。

### Q4: 配置错误会怎样？
**A**: 
- 域名不在白名单：用户会看到拒绝提示
- Token无效：用户会看到权限验证失败提示

## 📞 技术支持

如有问题，请联系：
- 技术支持邮箱：support@coopwire.com
- 内部文档：[企业配置Wiki](https://wiki.company.com/codelens)
