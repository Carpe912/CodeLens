# VSCode插件发布指南

## 📋 发布前准备清单

### 1. 创建发布者账号

#### 步骤1：注册Microsoft账号
- 访问 https://login.live.com
- 注册或登录Microsoft账号

#### 步骤2：创建Azure DevOps组织
- 访问 https://dev.azure.com
- 使用Microsoft账号登录
- 创建新组织（Organization）

#### 步骤3：创建Personal Access Token (PAT)
1. 在Azure DevOps中，点击右上角用户设置 → "Personal access tokens"
2. 点击 "New Token"
3. 配置：
   - **Name**: `vsce-publish`
   - **Organization**: 选择你的组织
   - **Expiration**: 90天或自定义
   - **Scopes**: Custom defined → 勾选 **Marketplace** → **Manage**
4. 点击 "Create" 并**保存Token**（只显示一次！）

#### 步骤4：创建发布者（Publisher）
1. 访问 https://marketplace.visualstudio.com/manage
2. 登录Microsoft账号
3. 点击 "Create publisher"
4. 填写：
   - **ID**: 发布者ID（例如：`codelens-team`）
   - **Display Name**: 显示名称（例如：`CodeLens Team`）
   - **Description**: 描述
5. 点击 "Create"

### 2. 安装发布工具

```bash
npm install -g @vscode/vsce
```

### 3. 准备插件文件

#### 必需文件
- ✅ `package.json` - 插件配置
- ✅ `README.md` - 插件说明
- ⚠️ `CHANGELOG.md` - 版本更新日志（建议）
- ⚠️ `LICENSE` - 许可证文件（建议）
- ⚠️ `icon.png` - 插件图标（128x128px，建议）

#### 更新package.json

确保以下字段正确：

```json
{
  "name": "codelens-vscode",
  "displayName": "CodeLens - Intelligent Code Search",
  "description": "AI-powered code search and Q&A for your workspace",
  "version": "0.1.0",
  "publisher": "your-publisher-id",  // 替换为你的发布者ID
  "repository": {
    "type": "git",
    "url": "https://github.com/your-username/codelens.git"  // 替换为你的仓库
  },
  "icon": "icon.png",  // 如果有图标
  "engines": {
    "vscode": "^1.85.0"
  },
  "categories": [
    "Programming Languages",
    "Machine Learning",
    "Other"
  ],
  "keywords": [
    "code search",
    "ai",
    "intelligent search",
    "code intelligence",
    "gitlab"
  ]
}
```

#### 创建CHANGELOG.md

```bash
cat > CHANGELOG.md << 'EOF'
# Change Log

## [0.1.0] - 2026-05-10

### Added
- 自动索引工作区
- 多分支独立索引支持
- 智能代码搜索（语义、精确、模糊）
- AI智能问答
- 内联CodeLens显示引用和调用
- 调用图可视化
- 增量索引功能
- GitLab权限控制
- 支持TypeScript、JavaScript、Vue

### Features
- 自动检测GitLab默认分支
- 共享基础分支索引，节省90%资源
- 手动增量索引，用户自主控制
EOF
```

#### 创建LICENSE文件

```bash
# 选择一个许可证，例如MIT
cat > LICENSE << 'EOF'
MIT License

Copyright (c) 2026 CodeLens Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
EOF
```

#### 创建.vscodeignore文件

```bash
cat > .vscodeignore << 'EOF'
.vscode/**
.vscode-test/**
src/**
.gitignore
.yarnrc
vsc-extension-quickstart.md
**/tsconfig.json
**/.eslintrc.json
**/*.map
**/*.ts
!dist/**/*.js
node_modules/**
*.vsix
IMPLEMENTATION.md
PROGRESS.md
SHARED_INDEX_DESIGN*.md
MULTI_BRANCH_IMPLEMENTATION_SUMMARY.md
PUBLISH_GUIDE.md
EOF
```

## 🚀 发布步骤

### 方法1：使用vsce命令行（推荐）

#### 1. 登录发布者账号

```bash
cd /Users/coopwire-test/remote-project/CodeLens/apps/vscode-extension

# 使用你的Personal Access Token登录
vsce login your-publisher-id
# 输入你的PAT Token
```

#### 2. 打包插件（可选，用于测试）

```bash
# 打包成.vsix文件
vsce package

# 会生成 codelens-vscode-0.1.0.vsix
```

#### 3. 本地测试安装

```bash
# 在VSCode中安装.vsix文件
code --install-extension codelens-vscode-0.1.0.vsix
```

#### 4. 发布到Marketplace

```bash
# 发布插件
vsce publish

# 或者指定版本号（会自动更新package.json）
vsce publish minor  # 0.1.0 -> 0.2.0
vsce publish patch  # 0.1.0 -> 0.1.1
vsce publish major  # 0.1.0 -> 1.0.0
```

### 方法2：通过Web界面上传

1. 打包插件：
   ```bash
   vsce package
   ```

2. 访问 https://marketplace.visualstudio.com/manage

3. 选择你的发布者

4. 点击 "New extension" → "Visual Studio Code"

5. 上传 `.vsix` 文件

6. 填写额外信息并发布

## 📝 发布后

### 1. 验证发布

- 访问 https://marketplace.visualstudio.com/items?itemName=your-publisher-id.codelens-vscode
- 在VSCode中搜索你的插件
- 测试安装和功能

### 2. 更新插件

```bash
# 修改代码后
npm run compile

# 更新版本并发布
vsce publish patch  # 小版本更新
vsce publish minor  # 中版本更新
vsce publish major  # 大版本更新
```

### 3. 取消发布（如果需要）

```bash
vsce unpublish your-publisher-id.codelens-vscode
```

## ⚠️ 注意事项

### 1. 插件名称
- `name` 字段必须是小写字母、数字、连字符
- `displayName` 可以包含空格和大写字母

### 2. 版本号
- 遵循语义化版本（Semantic Versioning）
- 格式：`major.minor.patch`
- 例如：`0.1.0` → `0.1.1` → `0.2.0` → `1.0.0`

### 3. 图标
- 尺寸：128x128像素
- 格式：PNG
- 文件名：`icon.png`

### 4. 依赖项
- 确保所有依赖都在 `dependencies` 中（不是 `devDependencies`）
- 或者使用 `vsce package --no-dependencies` 打包

### 5. 私有发布
如果不想公开发布，可以：
- 只打包成 `.vsix` 文件
- 通过内部渠道分发
- 使用 `code --install-extension` 安装

## 🔧 常见问题

### Q1: 发布失败："ERROR  Missing publisher name"
**A**: 在 `package.json` 中添加 `"publisher": "your-publisher-id"`

### Q2: 发布失败："ERROR  Make sure to edit the README.md file"
**A**: 确保 `README.md` 文件存在且内容充实

### Q3: 如何更新已发布的插件？
**A**: 修改代码后，运行 `vsce publish patch/minor/major`

### Q4: 如何撤回已发布的版本？
**A**: 无法撤回，但可以发布新版本覆盖

### Q5: 插件审核需要多久？
**A**: 通常几分钟到几小时，自动审核

## 📚 相关资源

- [VSCode插件发布官方文档](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [vsce CLI文档](https://github.com/microsoft/vscode-vsce)
- [插件市场管理](https://marketplace.visualstudio.com/manage)
- [Azure DevOps](https://dev.azure.com)

## 🎯 快速发布命令

```bash
# 1. 安装vsce
npm install -g @vscode/vsce

# 2. 登录
vsce login your-publisher-id

# 3. 发布
vsce publish

# 完成！
```

---

**提示**：首次发布建议先使用 `vsce package` 打包测试，确认无误后再 `vsce publish` 正式发布。
