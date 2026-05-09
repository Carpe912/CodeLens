# CodeLens VSCode 扩展 - 使用指南

## 概述

CodeLens VSCode扩展为您的工作区提供AI驱动的代码搜索和智能问答功能。它连接到现有的CodeLens API服务器，提供以下核心功能：

- **自动索引工作区** - 打开工作区时自动索引代码
- **内联CodeLens** - 在函数/类上方显示引用数量和调用关系
- **智能搜索** - 多策略搜索（语义、精确、模糊）
- **AI问答** - 右键选中代码即可询问AI
- **调用图可视化** - 交互式函数调用关系图
- **增量索引** - 文件变化时自动更新索引

## 前置要求

1. **CodeLens API服务器运行中**
   ```bash
   cd /Users/coopwire-test/remote-project/CodeLens/apps/api
   npm run dev
   ```
   默认地址：http://localhost:8787

2. **PostgreSQL 和 Redis 运行中**
   ```bash
   # PostgreSQL (默认端口 5432)
   # Redis (默认端口 6379)
   ```

3. **环境变量配置**
   ```bash
   # apps/api/.env
   ANTHROPIC_API_KEY=your_key
   EMBED_API_KEY=your_key
   ```

## 安装和开发

### 1. 安装依赖
```bash
cd /Users/coopwire-test/remote-project/CodeLens/apps/vscode-extension
npm install
```

### 2. 编译扩展
```bash
npm run compile
```

### 3. 启动调试
在VSCode中：
1. 打开 `apps/vscode-extension` 文件夹
2. 按 `F5` 启动扩展开发主机
3. 新窗口会打开，扩展已激活

## 功能使用

### 1. 自动索引工作区

**首次打开工作区时：**
- 扩展会提示："Would you like to index this workspace for intelligent code search?"
- 选择 "Index Now" 开始索引
- 索引进度会显示在通知栏中

**手动触发索引：**
- 命令面板 (`Cmd+Shift+P`) → `CodeLens: Index Workspace`

**重新索引：**
- 命令面板 → `CodeLens: Re-index Workspace`

### 2. 代码搜索

**打开搜索：**
- 命令面板 → `CodeLens: Search Code`
- 输入搜索关键词（如：`authentication`, `handleLogin`, `UserService`）

**查看结果：**
- 左侧边栏 "CodeLens" → "Search Results"
- 点击结果跳转到对应文件和行号

### 3. 内联CodeLens

**自动显示：**
- 在TypeScript/JavaScript文件中，函数和类上方会显示：
  - `$(references) X references` - 被调用次数
  - `$(call-outgoing) Calls Y functions` - 调用其他函数数量

**点击操作：**
- 点击 "X references" → 显示所有引用位置
- 点击 "Calls Y functions" → 打开调用图

### 4. 悬停文档

**使用方法：**
- 将鼠标悬停在函数名或变量名上
- 自动显示：
  - 符号类型
  - 文件位置
  - 代码片段
  - "View Call Graph" 链接

### 5. AI智能问答

**方式一：右键菜单**
1. 选中代码片段
2. 右键 → `CodeLens: Ask AI About Selection`
3. Q&A面板打开，显示AI回答和代码证据

**方式二：命令面板**
1. 命令面板 → `CodeLens: Ask AI`
2. 输入问题（如："How does authentication work in this codebase?"）
3. 按 `Ctrl+Enter` 或点击 "Ask AI"

**查看结果：**
- 答案以Markdown格式显示
- 代码证据列表可点击跳转到源文件

### 6. 调用图可视化

**打开调用图：**
- 点击内联CodeLens中的 "Calls X functions"
- 或悬停文档中的 "View Call Graph" 链接

**交互：**
- 绿色节点：调用者（Called By）
- 蓝色节点：被调用者（Calls）
- 橙色节点：目标函数
- 点击节点跳转到源文件

### 7. 增量索引

**自动触发：**
- 编辑并保存文件后，3秒内自动增量索引
- 后台静默执行，无需用户干预

**支持的文件类型：**
- TypeScript: `.ts`, `.tsx`
- JavaScript: `.js`, `.jsx`
- Vue: `.vue`
- Python: `.py`
- Go: `.go`
- Java: `.java`
- C/C++: `.c`, `.cpp`, `.h`, `.hpp`
- C#: `.cs`
- Ruby: `.rb`
- PHP: `.php`
- Swift: `.swift`
- Kotlin: `.kt`

## 配置选项

打开设置 (`Cmd+,`) 搜索 "codelens"：

### `codelens.apiUrl`
- **默认值**: `http://localhost:8787`
- **说明**: CodeLens API服务器地址
- **修改后**: 自动重新连接

### `codelens.autoIndex`
- **默认值**: `true`
- **说明**: 打开工作区时自动索引
- **禁用**: 需要手动触发索引

### `codelens.enableCodeLens`
- **默认值**: `true`
- **说明**: 显示内联CodeLens（引用和调用）
- **禁用**: 隐藏所有内联CodeLens

### `codelens.enableHover`
- **默认值**: `true`
- **说明**: 显示悬停文档
- **禁用**: 不显示悬停信息

## 快捷键

建议在 `keybindings.json` 中添加：

```json
[
  {
    "key": "cmd+shift+s",
    "command": "codelens.search",
    "when": "editorTextFocus"
  },
  {
    "key": "cmd+shift+a",
    "command": "codelens.askAI"
  },
  {
    "key": "cmd+shift+i",
    "command": "codelens.indexWorkspace"
  }
]
```

## 状态栏指示器

扩展会在状态栏显示当前状态：

- `$(sync~spin) CodeLens: Creating archive...` - 创建工作区压缩包
- `$(sync~spin) CodeLens: Uploading...` - 上传到服务器
- `$(sync~spin) CodeLens: Indexing 45%` - 索引进度
- `$(check) CodeLens: Ready` - 索引完成，可以使用
- `$(error) CodeLens: Failed` - 索引失败

## 故障排查

### 1. API服务器无法连接

**症状**: 提示 "CodeLens API server is not reachable"

**解决方案**:
```bash
# 检查API服务器是否运行
curl http://localhost:8787/health

# 启动API服务器
cd /Users/coopwire-test/remote-project/CodeLens/apps/api
npm run dev
```

### 2. 索引失败

**症状**: 状态栏显示 "CodeLens: Failed"

**解决方案**:
1. 检查API服务器日志
2. 确认PostgreSQL和Redis运行正常
3. 尝试重新索引：命令面板 → `CodeLens: Re-index Workspace`

### 3. 搜索无结果

**症状**: 搜索返回 "No results found"

**可能原因**:
- 工作区未索引完成
- 搜索关键词不匹配
- 缓存问题

**解决方案**:
1. 等待索引完成（查看状态栏）
2. 尝试不同的搜索关键词
3. 重新索引工作区

### 4. CodeLens不显示

**症状**: 函数上方没有显示引用和调用信息

**解决方案**:
1. 检查设置：`codelens.enableCodeLens` 是否为 `true`
2. 确认文件类型支持（TypeScript/JavaScript等）
3. 等待索引完成
4. 重新加载窗口：命令面板 → `Developer: Reload Window`

### 5. 悬停文档不显示

**症状**: 鼠标悬停无反应

**解决方案**:
1. 检查设置：`codelens.enableHover` 是否为 `true`
2. 确认符号已被索引
3. 尝试搜索该符号确认是否存在

## 性能优化

### 大型工作区

对于大型工作区（>10,000文件）：

1. **排除不必要的目录**
   - 扩展自动排除：`node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`
   - 如需额外排除，修改 `workspaceIndexer.ts` 中的 `excludePatterns`

2. **分批索引**
   - 索引分为两个阶段：基础索引 + 增强索引
   - 基础索引完成后即可使用搜索功能

3. **缓存策略**
   - 搜索结果缓存5分钟
   - 文件变化后自动清除相关缓存

## 开发和调试

### 查看日志

**扩展日志**:
- 开发者工具 (`Cmd+Shift+I`) → Console
- 搜索 `[CodeLens]` 查看扩展日志

**API服务器日志**:
```bash
cd /Users/coopwire-test/remote-project/CodeLens/apps/api
npm run dev
# 查看终端输出
```

### 修改代码后重新加载

1. 修改扩展代码
2. 运行 `npm run compile`
3. 在扩展开发主机窗口：命令面板 → `Developer: Reload Window`

### 打包扩展

```bash
# 安装vsce
npm install -g @vscode/vsce

# 打包
cd /Users/coopwire-test/remote-project/CodeLens/apps/vscode-extension
vsce package

# 生成 codelens-vscode-0.1.0.vsix
```

### 安装打包的扩展

```bash
code --install-extension codelens-vscode-0.1.0.vsix
```

## 架构说明

### 目录结构

```
apps/vscode-extension/
├── src/
│   ├── extension.ts              # 扩展入口
│   ├── api/                      # API客户端
│   │   ├── client.ts             # HTTP客户端
│   │   ├── repos.ts              # 仓库API
│   │   ├── search.ts             # 搜索API
│   │   ├── ask.ts                # 问答API
│   │   └── callGraph.ts          # 调用图API
│   ├── providers/                # VSCode提供者
│   │   ├── codeLensProvider.ts   # 内联CodeLens
│   │   └── hoverProvider.ts      # 悬停文档
│   ├── views/                    # UI组件
│   │   ├── searchView.ts         # 搜索侧边栏
│   │   ├── qaWebview.ts          # Q&A面板
│   │   └── callGraphWebview.ts   # 调用图面板
│   ├── indexing/                 # 索引编排
│   │   ├── workspaceIndexer.ts   # 工作区索引
│   │   └── fileWatcher.ts        # 文件监听
│   ├── state/                    # 状态管理
│   │   ├── repoRegistry.ts       # 仓库注册表
│   │   └── cache.ts              # 搜索缓存
│   └── commands/                 # 命令处理
│       ├── indexing.ts           # 索引命令
│       ├── search.ts             # 搜索命令
│       └── qa.ts                 # 问答命令
├── dist/                         # 编译输出
├── package.json                  # 扩展清单
└── tsconfig.json                 # TypeScript配置
```

### 数据流

1. **索引流程**:
   ```
   用户打开工作区 → 创建ZIP → 上传到API → 轮询进度 → 索引完成
   ```

2. **搜索流程**:
   ```
   用户输入查询 → 检查缓存 → 调用API → 显示结果 → 缓存结果
   ```

3. **增量索引流程**:
   ```
   文件变化 → 3秒防抖 → 批量收集 → 调用API → 后台更新
   ```

## 贡献指南

欢迎贡献代码！请遵循以下步骤：

1. Fork 仓库
2. 创建功能分支：`git checkout -b feature/your-feature`
3. 提交更改：`git commit -m 'Add some feature'`
4. 推送分支：`git push origin feature/your-feature`
5. 创建Pull Request

## 许可证

待定

## 联系方式

如有问题或建议，请提交Issue。
