# CodeLens VSCode 扩展

基于AI的代码搜索和智能问答VSCode扩展。

## 功能特性

- **自动索引工作区**：打开工作区时自动索引（带权限检查）
- **智能搜索**：多策略搜索（语义、精确、模糊）
- **内联CodeLens**：在函数上方显示引用数量和调用关系
- **AI智能问答**：右键选中代码即可询问AI
- **调用图可视化**：交互式函数调用关系图
- **增量索引**：文件变化时自动更新索引
- **权限控制**：基于GitLab的权限验证，保障企业安全

## 系统要求

- CodeLens API服务器运行在 http://localhost:8787
- PostgreSQL 和 Redis 运行中
- 环境变量已配置（ANTHROPIC_API_KEY, EMBED_API_KEY）

## 支持的语言

- TypeScript (`.ts`, `.tsx`)
- JavaScript (`.js`, `.jsx`)
- Vue (`.vue`)

## 扩展设置

### 基础设置

- `codelens.apiUrl`: CodeLens API服务器地址（默认：http://localhost:8787）
- `codelens.autoIndex`: 打开工作区时自动索引（默认：true）
- `codelens.enableCodeLens`: 显示内联CodeLens（默认：true）
- `codelens.enableHover`: 显示悬停文档（默认：true）

### 权限控制设置

- `codelens.enablePermissionCheck`: 索引前启用权限检查（默认：true）
- `codelens.allowedGitLabDomains`: 允许的GitLab域名白名单（默认：[]）
- `codelens.gitlabToken`: GitLab个人访问令牌，用于权限验证
- `codelens.allowedWorkspaces`: 总是允许索引的工作区URI列表

**企业配置示例**：
```json
{
  "codelens.enablePermissionCheck": true,
  "codelens.allowedGitLabDomains": ["gitlab.company.com"],
  "codelens.gitlabToken": "glpat-xxxxxxxxxxxxxxxxxxxx"
}
```

详细的权限控制文档请查看 [PERMISSION_GUIDE.md](./PERMISSION_GUIDE.md)

## 使用方法

1. 在VSCode中打开工作区
2. 扩展会检查权限并提示是否索引
3. 使用命令面板命令：
   - `CodeLens: 搜索代码` - 搜索代码
   - `CodeLens: 询问AI` - 打开问答面板
   - `CodeLens: 索引工作区` - 手动触发索引
4. 选中代码后右键选择"询问AI关于选中内容"
5. 鼠标悬停在函数名上查看文档
6. 点击内联CodeLens查看引用或调用图

## 开发调试

```bash
npm install
npm run compile
# 按 F5 启动扩展开发主机
```

## 文档

- [USAGE_GUIDE.md](./USAGE_GUIDE.md) - 详细使用指南（中文）
- [PERMISSION_GUIDE.md](./PERMISSION_GUIDE.md) - 权限控制指南（中文）

## 许可证

待定
