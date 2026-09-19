# 快速模式 vs 完整模式 - 详细对比

## 核心理念

**快速模式**：最小化处理，快速让用户能搜索  
**完整模式**：深度分析，构建完整知识图谱

---

## 1. 模式对比总览

| 维度 | 快速模式 (Quick Mode) | 完整模式 (Full Mode) |
|------|---------------------|---------------------|
| **目标** | 快速可用 | 功能完整 |
| **时间** | ~8分钟 | ~20分钟 |
| **AST 解析** | ✅ 解析一次 | ♻️ 复用缓存 |
| **提取深度** | 浅层（基本信息） | 深层（详细信息） |
| **生成表** | `code_chunks` | `functions`, `classes`, `constants`, `url_patterns` |
| **向量粒度** | 粗粒度（代码块级） | 细粒度（实体级） |
| **关系图谱** | ❌ 不构建 | ✅ 完整构建 |
| **搜索能力** | 基础语义搜索 | 全功能搜索（语义+图+依赖） |

---

## 2. 快速模式详解

### 2.1 处理流程

```typescript
async quickIndex(
  repoId: number,
  fileId: number,
  filePath: string,
  sourceFile: SourceFile  // 已解析的 AST
): Promise<void> {
  // 步骤 1: 浅层遍历 AST，提取基本信息
  const chunks = this.extractBasicChunks(sourceFile);
  
  // 步骤 2: 生成粗粒度向量
  const embeddings = await this.generateBasicEmbeddings(chunks);
  
  // 步骤 3: 存储到 code_chunks 表
  await this.storeCodeChunks(repoId, fileId, chunks, embeddings);
  
  // 完成！不做其他处理
}
```

### 2.2 提取的信息

**只提取最基本的信息**：

```typescript
interface BasicChunk {
  name: string;           // 符号名称（函数名、类名等）
  type: string;           // 类型（function、class、variable）
  lineStart: number;      // 起始行号
  lineEnd: number;        // 结束行号
  code: string;           // 完整代码文本
}
```

**示例代码**：

```typescript
// 输入代码
export async function fetchUser(id: number): Promise<User> {
  const response = await fetch(`/api/users/${id}`);
  return response.json();
}

// 快速模式提取
{
  name: 'fetchUser',
  type: 'function',
  lineStart: 1,
  lineEnd: 4,
  code: 'export async function fetchUser(id: number): Promise<User> { ... }'
}
```

**不提取的信息**：
- ❌ 参数类型（`id: number`）
- ❌ 返回类型（`Promise<User>`）
- ❌ 函数调用（`fetch`）
- ❌ 导出类型（`export`）
- ❌ 复杂度分析
- ❌ 字符串常量（`/api/users/${id}`）

### 2.3 向量生成

**粗粒度向量**：

```typescript
// 向量输入文本
const text = `${chunk.name} ${chunk.type}\n${chunk.code.slice(0, 500)}`;

// 示例
"fetchUser function
export async function fetchUser(id: number): Promise<User> {
  const response = await fetch(`/api/users/${id}`);
  return response.json();
}"

// 生成 1536 维向量
const embedding = await generateEmbedding(text);
```

**特点**：
- ✅ 快速生成（每个文件 1-3 个向量）
- ✅ 适合代码块级别的语义搜索
- ⚠️ 精度较低（整个函数作为一个向量）

### 2.4 数据库存储

**只写入一个表**：

```sql
-- code_chunks 表
INSERT INTO code_chunks (
  repo_id,
  file_id,
  symbol_name,      -- 'fetchUser'
  symbol_type,      -- 'function'
  line_start,       -- 1
  line_end,         -- 4
  code_text,        -- 完整代码
  embedding,        -- 粗粒度向量
  indexed_level     -- 'quick'
) VALUES (...);
```

### 2.5 支持的搜索

**快速模式完成后，用户可以**：

✅ **向量搜索**（语义搜索）
```typescript
// 查询：查找用户相关的函数
SELECT * FROM code_chunks
WHERE repo_id = 1
ORDER BY embedding <=> query_vector
LIMIT 10;
```

✅ **模糊搜索**（文本匹配）
```typescript
// 查询：查找包含 "fetch" 的代码
SELECT * FROM code_chunks
WHERE repo_id = 1
  AND code_text ILIKE '%fetch%';
```

❌ **不支持的搜索**：
- 图搜索（调用关系）
- 依赖搜索（导入关系）
- 精确实体搜索（函数签名、类继承）

---

## 3. 完整模式详解

### 3.1 处理流程

```typescript
async fullIndex(
  repoId: number,
  fileId: number,
  filePath: string,
  sourceFile: SourceFile  // 复用快速模式的 AST！
): Promise<void> {
  // 步骤 1: 深度遍历 AST，提取详细信息
  const entities = this.extractDetailedEntities(sourceFile);
  
  // 步骤 2: 存储实体到专门的表
  await this.storeEntities(repoId, fileId, entities);
  
  // 步骤 3: 生成细粒度向量
  await this.generateDetailedEmbeddings(repoId, fileId, entities);
  
  // 步骤 4: 构建关系图谱
  await this.buildRelationships(repoId, fileId, entities);
  
  // 步骤 5: 更新 code_chunks 的索引级别
  await this.updateIndexLevel(repoId, fileId, 'full');
}
```

### 3.2 提取的信息

**提取完整的详细信息**：

```typescript
interface DetailedFunction {
  name: string;                    // 函数名
  fullName: string;                // 完整名称（包含命名空间）
  signature: string;               // 完整签名
  parameters: Parameter[];         // 参数列表（名称+类型）
  returnType: string;              // 返回类型
  isAsync: boolean;                // 是否异步
  isExported: boolean;             // 是否导出
  exportType: 'named' | 'default'; // 导出类型
  visibility: 'public' | 'private';// 可见性
  cyclomaticComplexity: number;    // 圈复杂度
  linesOfCode: number;             // 代码行数
  calls: FunctionCall[];           // 调用的函数列表
  lineStart: number;
  lineEnd: number;
  code: string;
}
```

**示例代码**：

```typescript
// 输入代码
export async function fetchUser(id: number): Promise<User> {
  const response = await fetch(`/api/users/${id}`);
  return response.json();
}

// 完整模式提取
{
  name: 'fetchUser',
  fullName: 'fetchUser',
  signature: 'async function fetchUser(id: number): Promise<User>',
  parameters: [
    { name: 'id', type: 'number', optional: false }
  ],
  returnType: 'Promise<User>',
  isAsync: true,
  isExported: true,
  exportType: 'named',
  visibility: 'public',
  cyclomaticComplexity: 2,
  linesOfCode: 3,
  calls: [
    { name: 'fetch', arguments: ['`/api/users/${id}`'], line: 2 },
    { name: 'json', type: 'method', line: 3 }
  ],
  lineStart: 1,
  lineEnd: 4,
  code: '...'
}
```

**额外提取的信息**：
- ✅ 字符串常量：`/api/users/${id}` → 识别为 URL 模式
- ✅ 导入关系：如果有 `import { User } from './types'`
- ✅ 类型信息：`User` 类型的定义和使用
- ✅ 函数调用：`fetch` 和 `json` 方法

### 3.3 向量生成

**细粒度向量**（为每个实体单独生成）：

```typescript
// 函数向量
const functionText = `${func.signature}\n${func.code.slice(0, 500)}`;
const functionEmbedding = await generateEmbedding(functionText);

// 常量向量
const constantText = `${constant.symbolName}: ${constant.stringValue} (${constant.type})`;
const constantEmbedding = await generateEmbedding(constantText);

// URL 向量
const urlText = `${url.method} ${url.pattern}\n${url.definitionCode}`;
const urlEmbedding = await generateEmbedding(urlText);
```

**示例**：

```typescript
// 函数向量输入
"async function fetchUser(id: number): Promise<User>
export async function fetchUser(id: number): Promise<User> {
  const response = await fetch(`/api/users/${id}`);
  return response.json();
}"

// URL 向量输入
"GET /api/users/:id
const response = await fetch(`/api/users/${id}`);"
```

**特点**：
- ✅ 精度更高（每个实体独立向量）
- ✅ 适合精确搜索
- ⚠️ 生成较慢（每个文件 10-20 个向量）

### 3.4 数据库存储

**写入多个表**：

```sql
-- 1. functions 表
INSERT INTO functions (
  repo_id, file_id,
  name, full_name, signature,
  parameters, return_type,
  is_async, is_exported, export_type,
  cyclomatic_complexity, lines_of_code,
  line_start, line_end, code,
  embedding  -- 细粒度向量
) VALUES (...);

-- 2. string_constants 表
INSERT INTO string_constants (
  repo_id, file_id,
  symbol_name, string_value, constant_type,
  line_start, line_end, code,
  embedding
) VALUES (...);

-- 3. url_patterns 表
INSERT INTO url_patterns (
  repo_id, pattern, normalized_pattern,
  method, definition_file_id, definition_line,
  components, path_params, query_params,
  embedding
) VALUES (...);

-- 4. import_relations 表（关系图谱）
INSERT INTO import_relations (
  repo_id, importer_file_id, imported_file_id,
  imported_symbol, import_type, import_path
) VALUES (...);

-- 5. call_graph 表（关系图谱）
INSERT INTO call_graph (
  repo_id, from_chunk_id, to_chunk_id,
  to_symbol, call_type, arguments
) VALUES (...);

-- 6. 更新 code_chunks
UPDATE code_chunks
SET indexed_level = 'full'
WHERE repo_id = ? AND file_id = ?;
```

### 3.5 支持的搜索

**完整模式完成后，用户可以**：

✅ **所有快速模式的搜索**

✅ **精确实体搜索**
```sql
-- 查找特定签名的函数
SELECT * FROM functions
WHERE repo_id = 1
  AND signature ILIKE '%Promise<User>%';
```

✅ **URL 搜索**
```sql
-- 查找 API 端点
SELECT * FROM url_patterns
WHERE repo_id = 1
  AND normalized_pattern LIKE '/api/users/%';
```

✅ **依赖搜索**
```sql
-- 查找谁导入了 fetchUser
SELECT f.path, ir.importer_line
FROM import_relations ir
JOIN files f ON ir.importer_file_id = f.id
WHERE ir.imported_symbol = 'fetchUser';
```

✅ **图搜索（调用关系）**
```sql
-- 查找谁调用了 fetchUser
SELECT cc.symbol_name, f.path
FROM call_graph cg
JOIN code_chunks cc ON cg.from_chunk_id = cc.id
JOIN files f ON cc.file_id = f.id
WHERE cg.to_symbol = 'fetchUser';
```

---

## 4. 实际示例对比

### 示例代码

```typescript
// src/api/user.ts
import { apiClient } from './client';

export interface User {
  id: number;
  name: string;
  email: string;
}

const API_BASE = '/api/users';

export async function fetchUser(id: number): Promise<User> {
  const url = `${API_BASE}/${id}`;
  const response = await apiClient.get(url);
  return response.data;
}

export async function createUser(data: Partial<User>): Promise<User> {
  const response = await apiClient.post(API_BASE, data);
  return response.data;
}
```

### 快速模式提取结果

```json
// code_chunks 表（3 条记录）
[
  {
    "symbol_name": "User",
    "symbol_type": "interface",
    "line_start": 3,
    "line_end": 7,
    "code": "export interface User { ... }",
    "embedding": [0.123, 0.456, ...],  // 1536 维
    "indexed_level": "quick"
  },
  {
    "symbol_name": "fetchUser",
    "symbol_type": "function",
    "line_start": 11,
    "line_end": 15,
    "code": "export async function fetchUser(id: number): Promise<User> { ... }",
    "embedding": [0.789, 0.012, ...],
    "indexed_level": "quick"
  },
  {
    "symbol_name": "createUser",
    "symbol_type": "function",
    "line_start": 17,
    "line_end": 20,
    "code": "export async function createUser(data: Partial<User>): Promise<User> { ... }",
    "embedding": [0.345, 0.678, ...],
    "indexed_level": "quick"
  }
]
```

**总计**：
- 3 个代码块
- 3 个向量
- 1 个表
- 耗时：~2 秒

### 完整模式提取结果

```json
// 1. functions 表（2 条记录）
[
  {
    "name": "fetchUser",
    "full_name": "fetchUser",
    "signature": "async function fetchUser(id: number): Promise<User>",
    "parameters": [{"name": "id", "type": "number"}],
    "return_type": "Promise<User>",
    "is_async": true,
    "is_exported": true,
    "export_type": "named",
    "cyclomatic_complexity": 2,
    "lines_of_code": 4,
    "embedding": [0.111, 0.222, ...]
  },
  {
    "name": "createUser",
    "full_name": "createUser",
    "signature": "async function createUser(data: Partial<User>): Promise<User>",
    "parameters": [{"name": "data", "type": "Partial<User>"}],
    "return_type": "Promise<User>",
    "is_async": true,
    "is_exported": true,
    "export_type": "named",
    "cyclomatic_complexity": 2,
    "lines_of_code": 3,
    "embedding": [0.333, 0.444, ...]
  }
]

// 2. string_constants 表（1 条记录）
[
  {
    "symbol_name": "API_BASE",
    "string_value": "/api/users",
    "constant_type": "url_segment",
    "export_type": "none",
    "line_start": 9,
    "line_end": 9,
    "embedding": [0.555, 0.666, ...]
  }
]

// 3. url_patterns 表（2 条记录）
[
  {
    "pattern": "/api/users/${id}",
    "normalized_pattern": "/api/users/:id",
    "method": "GET",
    "definition_line": 12,
    "path_params": ["id"],
    "embedding": [0.777, 0.888, ...]
  },
  {
    "pattern": "/api/users",
    "normalized_pattern": "/api/users",
    "method": "POST",
    "definition_line": 18,
    "path_params": [],
    "embedding": [0.999, 0.000, ...]
  }
]

// 4. import_relations 表（1 条记录）
[
  {
    "imported_symbol": "apiClient",
    "import_path": "./client",
    "import_type": "named",
    "importer_line": 1
  }
]

// 5. call_graph 表（4 条记录）
[
  {
    "from_chunk": "fetchUser",
    "to_symbol": "apiClient.get",
    "call_type": "method",
    "arguments": ["url"]
  },
  {
    "from_chunk": "createUser",
    "to_symbol": "apiClient.post",
    "call_type": "method",
    "arguments": ["API_BASE", "data"]
  }
  // ... 更多调用关系
]

// 6. code_chunks 更新
UPDATE code_chunks SET indexed_level = 'full' WHERE file_id = ?;
```

**总计**：
- 2 个函数实体
- 1 个常量实体
- 2 个 URL 模式
- 1 个导入关系
- 4 个调用关系
- 10 个向量（3 个粗粒度 + 7 个细粒度）
- 5 个表
- 耗时：~8 秒

---

## 5. 搜索能力对比

### 场景 1：查找用户相关的代码

**查询**："user authentication"

**快速模式**：
```sql
SELECT * FROM code_chunks
WHERE embedding <=> query_vector
LIMIT 10;
```
**结果**：返回包含 "user" 的代码块（粗粒度）

**完整模式**：
```sql
-- 搜索多个表
SELECT * FROM functions WHERE embedding <=> query_vector
UNION ALL
SELECT * FROM classes WHERE embedding <=> query_vector
UNION ALL
SELECT * FROM string_constants WHERE embedding <=> query_vector
LIMIT 10;
```
**结果**：返回精确的函数、类、常量（细粒度）

---

### 场景 2：查找 API 端点

**查询**："/api/users/:id"

**快速模式**：
```sql
SELECT * FROM code_chunks
WHERE code_text ILIKE '%/api/users%';
```
**结果**：返回包含该字符串的代码块（可能包含很多无关代码）

**完整模式**：
```sql
SELECT * FROM url_patterns
WHERE normalized_pattern = '/api/users/:id';
```
**结果**：精确返回该 URL 的定义和使用位置

---

### 场景 3：查找函数调用关系

**查询**："谁调用了 fetchUser？"

**快速模式**：
❌ **无法查询**（没有调用关系数据）

**完整模式**：
```sql
SELECT 
  cc.symbol_name as caller,
  f.path as file_path,
  cg.call_line
FROM call_graph cg
JOIN code_chunks cc ON cg.from_chunk_id = cc.id
JOIN files f ON cc.file_id = f.id
WHERE cg.to_symbol = 'fetchUser';
```
**结果**：返回所有调用 fetchUser 的函数和位置

---

## 6. 性能对比

### 单个文件（100 行代码）

| 指标 | 快速模式 | 完整模式 |
|------|---------|---------|
| **AST 解析** | 50ms | 0ms（复用） |
| **信息提取** | 10ms | 100ms |
| **向量生成** | 200ms（3个） | 800ms（10个） |
| **数据库写入** | 50ms | 200ms |
| **总耗时** | **310ms** | **1100ms** |

### 整个仓库（1000 个文件）

| 指标 | 快速模式 | 完整模式 |
|------|---------|---------|
| **AST 解析** | 50s | 0s（复用） |
| **信息提取** | 10s | 100s |
| **向量生成** | 200s | 800s |
| **数据库写入** | 50s | 200s |
| **关系构建** | 0s | 150s |
| **总耗时** | **310s (5分钟)** | **1250s (21分钟)** |

**注意**：完整模式不需要重新解析 AST，节省了 50 秒！

---

## 7. 渐进式索引流程

### 用户体验时间线

```
T = 0s
用户上传代码
    ↓
T = 5min (快速模式完成)
✅ 用户可以开始搜索
   - 语义搜索
   - 模糊搜索
   - 基础代码浏览
    ↓
T = 5min ~ 26min (完整模式运行中)
⚙️ 后台处理，不影响用户使用
    ↓
T = 26min (完整模式完成)
✅ 完整功能可用
   - 精确实体搜索
   - URL 搜索
   - 依赖追踪
   - 调用图分析
```

### 实现代码

```typescript
async indexRepository(repoId: number, repoPath: string): Promise<void> {
  const files = await this.collectFiles(repoPath);
  
  // 阶段 1：快速模式（优先级高）
  console.log('🚀 Phase 1: Quick indexing...');
  for (const file of files) {
    await this.indexFile(repoId, file.id, file.path, file.content, 'quick');
  }
  console.log('✅ Quick indexing done! Users can start searching.');
  
  // 通知前端：基础搜索可用
  await this.notifyIndexingProgress(repoId, {
    phase: 'quick_done',
    searchEnabled: true
  });
  
  // 阶段 2：完整模式（后台运行）
  console.log('🔧 Phase 2: Full indexing (background)...');
  for (const file of files) {
    // 复用快速模式的 AST 缓存
    await this.indexFile(repoId, file.id, file.path, file.content, 'full');
  }
  console.log('✅ Full indexing done! All features available.');
  
  // 通知前端：完整功能可用
  await this.notifyIndexingProgress(repoId, {
    phase: 'full_done',
    allFeaturesEnabled: true
  });
}
```

---

## 8. 前端 UI 展示

### 快速模式完成后

```
┌─────────────────────────────────────┐
│ 📦 Repository: my-project           │
│                                     │
│ ✅ Basic indexing complete          │
│ 🔍 Search is now available          │
│                                     │
│ ⚙️ Advanced indexing in progress... │
│ Progress: 45% (450/1000 files)      │
│                                     │
│ Available features:                 │
│ ✅ Semantic search                  │
│ ✅ Code browsing                    │
│ ⏳ Call graph (coming soon)         │
│ ⏳ Dependency tracking (coming soon)│
└─────────────────────────────────────┘
```

### 完整模式完成后

```
┌─────────────────────────────────────┐
│ 📦 Repository: my-project           │
│                                     │
│ ✅ Full indexing complete           │
│ 🎉 All features available           │
│                                     │
│ Available features:                 │
│ ✅ Semantic search                  │
│ ✅ Code browsing                    │
│ ✅ Call graph analysis              │
│ ✅ Dependency tracking              │
│ ✅ URL endpoint search              │
│ ✅ Advanced filters                 │
└─────────────────────────────────────┘
```

---

## 9. 总结

### 快速模式

**目标**：让用户尽快开始使用  
**策略**：最小化处理，只提取基本信息  
**结果**：基础搜索可用，满足 80% 的使用场景

### 完整模式

**目标**：提供完整的代码分析能力  
**策略**：深度分析，构建知识图谱  
**结果**：高级功能可用，满足专业开发者需求

### 关键优势

1. **AST 复用**：完整模式复用快速模式的 AST，节省 20% 时间
2. **渐进式体验**：用户不需要等待全部完成就能开始使用
3. **代码统一**：一个索引器，两种模式，易于维护
4. **灵活降级**：如果完整模式失败，快速模式仍然可用

### 适用场景

**快速模式适合**：
- 快速浏览代码
- 基础语义搜索
- 代码片段查找

**完整模式适合**：
- 代码重构（需要调用关系）
- API 文档生成（需要 URL 模式）
- 依赖分析（需要导入关系）
- 影响范围评估（需要完整图谱）

---

## 10. 实际搜索场景对比

### 数据结构回顾

**快速模式数据**：
```json
{
  "name": "fetchUser",
  "type": "function",
  "code": "export async function fetchUser(id: number): Promise<User> { ... }"
}
```

**完整模式数据**：
```json
{
  "function": {
    "name": "fetchUser",
    "signature": "async function fetchUser(id: number): Promise<User>",
    "parameters": [{"name": "id", "type": "number"}],
    "returnType": "Promise<User>",
    "isAsync": true,
    "calls": ["fetch", "json"]
  },
  "url_pattern": {
    "pattern": "/api/users/${id}",
    "normalized": "/api/users/:id",
    "method": "GET"
  },
  "call_graph": [
    {"from": "fetchUser", "to": "fetch"},
    {"from": "fetchUser", "to": "json"}
  ]
}
```

---

### 场景 1：查找函数名

**用户查询**："fetchUser"

#### 快速模式 ✅
```sql
SELECT * FROM code_chunks
WHERE symbol_name = 'fetchUser';
```
**匹配字段**：`name: "fetchUser"`  
**结果**：✅ 可以找到  
**返回信息**：函数名、代码文本、行号

#### 完整模式 ✅
```sql
SELECT * FROM functions
WHERE name = 'fetchUser';
```
**匹配字段**：`function.name: "fetchUser"`  
**结果**：✅ 可以找到  
**返回信息**：函数名、签名、参数、返回值、调用关系

**结论**：✅ **两种模式都可以**，但完整模式返回更详细的信息

---

### 场景 2：查找异步函数

**用户查询**："所有异步函数"

#### 快速模式 ⚠️
```sql
SELECT * FROM code_chunks
WHERE code_text LIKE '%async%';
```
**匹配字段**：`code: "export async function..."`  
**结果**：⚠️ 可以找到，但不准确  
**问题**：
- 会匹配注释中的 "async"
- 会匹配字符串中的 "async"
- 无法区分 async 函数和普通函数

#### 完整模式 ✅
```sql
SELECT * FROM functions
WHERE is_async = true;
```
**匹配字段**：`function.isAsync: true`  
**结果**：✅ 精确匹配  
**返回信息**：所有真正的异步函数

**结论**：⚠️ **快速模式可以模糊匹配，完整模式精确匹配**

---

### 场景 3：查找特定签名的函数

**用户查询**："返回 Promise<User> 的函数"

#### 快速模式 ⚠️
```sql
SELECT * FROM code_chunks
WHERE code_text LIKE '%Promise<User>%';
```
**匹配字段**：`code: "...Promise<User>..."`  
**结果**：⚠️ 可以找到，但不准确  
**问题**：
- 会匹配注释中的类型
- 会匹配参数类型（不是返回值）
- 无法区分返回值和其他类型引用

#### 完整模式 ✅
```sql
SELECT * FROM functions
WHERE return_type = 'Promise<User>';
```
**匹配字段**：`function.returnType: "Promise<User>"`  
**结果**：✅ 精确匹配返回值类型  
**返回信息**：所有返回 Promise<User> 的函数

**结论**：⚠️ **快速模式只能模糊搜索，完整模式可以精确搜索类型**

---

### 场景 4：查找带特定参数的函数

**用户查询**："接受 id: number 参数的函数"

#### 快速模式 ⚠️
```sql
SELECT * FROM code_chunks
WHERE code_text LIKE '%id: number%';
```
**匹配字段**：`code: "...id: number..."`  
**结果**：⚠️ 可以找到，但不准确  
**问题**：
- 会匹配变量声明 `const id: number`
- 会匹配类型定义 `interface { id: number }`
- 无法区分参数和其他用途

#### 完整模式 ✅
```sql
SELECT * FROM functions
WHERE parameters::text LIKE '%"name":"id"%'
  AND parameters::text LIKE '%"type":"number"%';
```
**匹配字段**：`function.parameters: [{"name": "id", "type": "number"}]`  
**结果**：✅ 精确匹配函数参数  
**返回信息**：所有接受 id: number 参数的函数

**结论**：⚠️ **快速模式只能模糊搜索，完整模式可以精确搜索参数**

---

### 场景 5：查找 API 端点

**用户查询**："/api/users/:id"

#### 快速模式 ⚠️
```sql
SELECT * FROM code_chunks
WHERE code_text LIKE '%/api/users/%';
```
**匹配字段**：`code: "...fetch(\`/api/users/\${id}\`)..."`  
**结果**：⚠️ 可以找到，但信息不完整  
**问题**：
- 只能找到包含该字符串的代码块
- 无法识别这是一个 URL
- 无法规范化（`/api/users/${id}` vs `/api/users/:id`）
- 无法区分 GET/POST 等方法

#### 完整模式 ✅
```sql
SELECT * FROM url_patterns
WHERE normalized_pattern = '/api/users/:id';
```
**匹配字段**：`url_pattern.normalized: "/api/users/:id"`  
**结果**：✅ 精确匹配 URL 模式  
**返回信息**：
- 原始模式：`/api/users/${id}`
- 规范化模式：`/api/users/:id`
- HTTP 方法：`GET`
- 路径参数：`["id"]`
- 定义位置

**结论**：❌ **快速模式无法识别 URL，只有完整模式支持 URL 搜索**

---

### 场景 6：查找函数调用关系

**用户查询**："fetchUser 调用了哪些函数？"

#### 快速模式 ❌
```sql
-- 无法查询，没有调用关系数据
```
**匹配字段**：无  
**结果**：❌ 无法查询  
**原因**：快速模式不提取函数调用信息

#### 完整模式 ✅
```sql
SELECT * FROM call_graph
WHERE from_symbol = 'fetchUser';
```
**匹配字段**：`call_graph: [{"from": "fetchUser", "to": "fetch"}, ...]`  
**结果**：✅ 返回所有被调用的函数  
**返回信息**：
- `fetchUser` → `fetch`
- `fetchUser` → `json`

**结论**：❌ **只有完整模式支持调用关系查询**

---

### 场景 7：查找谁调用了某个函数

**用户查询**："谁调用了 fetchUser？"

#### 快速模式 ⚠️
```sql
SELECT * FROM code_chunks
WHERE code_text LIKE '%fetchUser%';
```
**匹配字段**：`code: "...fetchUser(...)..."`  
**结果**：⚠️ 可以找到包含 fetchUser 的代码  
**问题**：
- 会匹配函数定义本身
- 会匹配注释中的 fetchUser
- 会匹配字符串中的 fetchUser
- 无法确定是否真的调用了该函数

#### 完整模式 ✅
```sql
SELECT * FROM call_graph
WHERE to_symbol = 'fetchUser';
```
**匹配字段**：`call_graph: [{"from": "someFunction", "to": "fetchUser"}]`  
**结果**：✅ 精确返回所有调用者  
**返回信息**：调用者函数名、调用位置、调用参数

**结论**：⚠️ **快速模式只能模糊搜索，完整模式可以精确追踪调用关系**

---

### 场景 8：查找导入关系

**用户查询**："哪些文件导入了 fetchUser？"

#### 快速模式 ⚠️
```sql
SELECT * FROM code_chunks
WHERE code_text LIKE '%import%fetchUser%';
```
**匹配字段**：`code: "import { fetchUser } from ..."`  
**结果**：⚠️ 可以找到包含 import 语句的代码  
**问题**：
- 只能找到 import 语句所在的代码块
- 无法追踪跨文件的使用
- 无法区分 import 和其他用途

#### 完整模式 ✅
```sql
SELECT f.path, ir.importer_line
FROM import_relations ir
JOIN files f ON ir.importer_file_id = f.id
WHERE ir.imported_symbol = 'fetchUser';
```
**匹配字段**：完整模式通过 import_relations 表查询  
**结果**：✅ 返回所有导入该函数的文件  
**返回信息**：导入文件路径、导入行号、导入类型

**结论**：⚠️ **快速模式只能找到 import 语句，完整模式可以追踪导入关系**

---

### 场景 9：语义搜索

**用户查询**："获取用户信息的函数"（自然语言）

#### 快速模式 ✅
```sql
SELECT * FROM code_chunks
WHERE embedding <=> query_vector
LIMIT 10;
```
**匹配字段**：`code` 的向量嵌入  
**结果**：✅ 返回语义相关的代码块  
**返回信息**：整个代码块（可能包含多个函数）

#### 完整模式 ✅
```sql
SELECT * FROM functions
WHERE embedding <=> query_vector
LIMIT 10;
```
**匹配字段**：`function.signature` + `function.code` 的向量嵌入  
**结果**：✅ 返回语义相关的函数  
**返回信息**：精确的函数定义和详细信息

**结论**：✅ **两种模式都支持语义搜索，但完整模式更精确**

---

### 场景 10：代码浏览

**用户操作**："浏览文件中的所有函数"

#### 快速模式 ✅
```sql
SELECT * FROM code_chunks
WHERE file_id = ? AND symbol_type = 'function';
```
**匹配字段**：`type: "function"`  
**结果**：✅ 返回所有函数代码块  
**返回信息**：函数名、代码、行号

#### 完整模式 ✅
```sql
SELECT * FROM functions
WHERE file_id = ?;
```
**匹配字段**：`function` 表中的所有记录  
**结果**：✅ 返回所有函数  
**返回信息**：函数名、签名、参数、返回值、复杂度等

**结论**：✅ **两种模式都支持代码浏览，但完整模式提供更多信息**

---

## 11. 场景总结表

| 搜索场景 | 快速模式 | 完整模式 | 推荐 |
|---------|---------|---------|------|
| **1. 查找函数名** | ✅ 可以 | ✅ 可以（更详细） | 都可以 |
| **2. 查找异步函数** | ⚠️ 模糊 | ✅ 精确 | 完整模式 |
| **3. 查找特定签名** | ⚠️ 模糊 | ✅ 精确 | 完整模式 |
| **4. 查找特定参数** | ⚠️ 模糊 | ✅ 精确 | 完整模式 |
| **5. 查找 API 端点** | ⚠️ 模糊 | ✅ 精确 | 完整模式 |
| **6. 函数调用了谁** | ❌ 不支持 | ✅ 支持 | 完整模式 |
| **7. 谁调用了函数** | ⚠️ 模糊 | ✅ 精确 | 完整模式 |
| **8. 导入关系** | ⚠️ 模糊 | ✅ 精确 | 完整模式 |
| **9. 语义搜索** | ✅ 粗粒度 | ✅ 细粒度 | 都可以 |
| **10. 代码浏览** | ✅ 基础 | ✅ 详细 | 都可以 |

---

## 12. 使用建议

### 快速模式适合的场景

✅ **基础搜索**
- 查找函数名、类名
- 浏览代码结构
- 快速定位代码位置

✅ **语义搜索**
- 自然语言查询
- 模糊概念搜索
- 相似代码查找

✅ **文本搜索**
- 查找包含特定字符串的代码
- 简单的关键词搜索

### 完整模式适合的场景

✅ **精确搜索**
- 查找特定签名的函数
- 查找特定类型的参数
- 查找异步/同步函数

✅ **关系分析**
- 函数调用链分析
- 依赖关系追踪
- 影响范围评估

✅ **API 分析**
- 查找 API 端点
- 分析 URL 使用情况
- 追踪 API 调用

✅ **代码重构**
- 查找所有调用者
- 分析函数影响范围
- 安全重命名

### 实际使用策略

**阶段 1：快速模式完成后（5分钟）**
- 用户可以进行基础搜索和代码浏览
- 满足 70-80% 的日常使用场景
- 适合快速查找和探索代码

**阶段 2：完整模式完成后（26分钟）**
- 解锁所有高级功能
- 支持深度代码分析
- 适合代码重构和架构分析

**前端提示**：
```
快速模式：
"基础搜索已可用。高级功能（调用图、依赖追踪）正在后台构建中..."

完整模式：
"所有功能已就绪！现在支持调用图分析、依赖追踪、API 端点搜索等高级功能。"
```

---

## 13. 最终结论

### 数据结构对应的搜索能力

**快速模式数据**：
```json
{
  "name": "fetchUser",
  "type": "function",
  "code": "export async function fetchUser..."
}
```
**支持的搜索**：
- ✅ 函数名精确匹配
- ✅ 代码文本模糊搜索
- ✅ 语义搜索（粗粒度）
- ⚠️ 类型/签名模糊搜索（不准确）
- ❌ 调用关系（不支持）
- ❌ URL 识别（不支持）

---

**完整模式数据**：
```json
{
  "function": {
    "name": "fetchUser",
    "signature": "async function fetchUser(id: number): Promise<User>",
    "parameters": [{"name": "id", "type": "number"}],
    "returnType": "Promise<User>",
    "isAsync": true,
    "calls": ["fetch", "json"]
  },
  "url_pattern": {
    "pattern": "/api/users/${id}",
    "normalized": "/api/users/:id",
    "method": "GET"
  },
  "call_graph": [
    {"from": "fetchUser", "to": "fetch"},
    {"from": "fetchUser", "to": "json"}
  ]
}
```
**支持的搜索**：
- ✅ 函数名精确匹配
- ✅ 签名精确匹配
- ✅ 参数类型精确匹配
- ✅ 返回值类型精确匹配
- ✅ 异步/同步精确筛选
- ✅ 语义搜索（细粒度）
- ✅ 调用关系追踪
- ✅ URL 模式识别和搜索
- ✅ 依赖关系分析

---

### 核心差异

| 维度 | 快速模式 | 完整模式 |
|------|---------|---------|
| **数据粒度** | 代码块级别 | 实体级别 |
| **搜索精度** | 模糊匹配 | 精确匹配 |
| **关系图谱** | 无 | 完整 |
| **适用场景** | 日常搜索 | 深度分析 |
| **用户体验** | 快速可用 | 功能完整 |

**最佳实践**：
1. 快速模式让用户尽快开始使用（5分钟）
2. 完整模式在后台构建，不影响用户体验（21分钟）
3. 前端根据索引状态动态启用/禁用功能
4. 用户可以在快速模式下工作，等待完整模式解锁高级功能

---

## 14. 复杂 URL 搜索场景实战

基于真实的测试案例，展示快速模式和完整模式在处理复杂 URL 场景时的差异。

### 场景 A：通过常量拼接构建的 URL

#### 代码示例

```javascript
// src/config/apiConfig.js
export const API_PREFIX = '/api/v1';
export const RESOURCES = {
  USERS: 'users',
  ORDERS: 'orders'
};

// src/api/advancedUserApi.js
import { API_PREFIX, RESOURCES } from '../config/apiConfig';

export async function getUserProfile(userId) {
  // 通过常量拼接构建 URL
  const url = `${API_PREFIX}/${RESOURCES.USERS}/${userId}/profile`;
  const response = await fetch(url);
  return response.json();
}
```

#### 用户查询："/api/v1/users/:userId/profile"

##### 快速模式 ⚠️

```sql
SELECT * FROM code_chunks
WHERE code_text LIKE '%/api/v1/users%'
   OR code_text LIKE '%profile%';
```

**匹配字段**：`code: "const url = \`\${API_PREFIX}/\${RESOURCES.USERS}/\${userId}/profile\`"`

**结果**：⚠️ 可以找到，但信息不完整
- ✅ 找到 `getUserProfile` 函数
- ❌ 无法识别这是一个 URL
- ❌ 无法规范化为 `/api/v1/users/:userId/profile`
- ❌ 无法追踪 `API_PREFIX` 和 `RESOURCES.USERS` 的值
- ❌ 无法关联到 `apiConfig.js` 中的常量定义

**返回信息**：
```json
{
  "symbol_name": "getUserProfile",
  "code_text": "export async function getUserProfile(userId) { const url = `${API_PREFIX}/${RESOURCES.USERS}/${userId}/profile`; ... }",
  "file_path": "src/api/advancedUserApi.js",
  "line_start": 5
}
```

##### 完整模式 ✅

```sql
SELECT * FROM url_patterns
WHERE normalized_pattern = '/api/v1/users/:userId/profile';
```

**匹配字段**：
- `url_pattern.pattern: "${API_PREFIX}/${RESOURCES.USERS}/${userId}/profile"`
- `url_pattern.normalized: "/api/v1/users/:userId/profile"`

**结果**：✅ 精确匹配，完整追踪
- ✅ 识别为 URL 模式
- ✅ 规范化为 `/api/v1/users/:userId/profile`
- ✅ 追踪常量值：`API_PREFIX = '/api/v1'`, `RESOURCES.USERS = 'users'`
- ✅ 识别路径参数：`userId`
- ✅ 关联到常量定义文件

**返回信息**：
```json
{
  "pattern": "${API_PREFIX}/${RESOURCES.USERS}/${userId}/profile",
  "normalized_pattern": "/api/v1/users/:userId/profile",
  "method": "GET",
  "definition_file": "src/api/advancedUserApi.js",
  "definition_line": 6,
  "path_params": ["userId"],
  "components": [
    {"type": "constant", "value": "API_PREFIX", "resolved": "/api/v1"},
    {"type": "constant", "value": "RESOURCES.USERS", "resolved": "users"},
    {"type": "param", "name": "userId"},
    {"type": "literal", "value": "profile"}
  ],
  "constant_references": [
    {"file": "src/config/apiConfig.js", "line": 1, "name": "API_PREFIX"},
    {"file": "src/config/apiConfig.js", "line": 3, "name": "RESOURCES"}
  ]
}
```

**结论**：❌ **快速模式无法处理常量拼接，只有完整模式能追踪多文件的 URL 构建**

---

### 场景 B：工厂方法生成的 URL

#### 代码示例

```javascript
// src/utils/apiFactory.js
export const API_VERSION = 'v1';

export function buildApiPath(resource) {
  return `/api/${API_VERSION}/${resource}`;
}

export function resourceWithId(resource, id) {
  return `${buildApiPath(resource)}/${id}`;
}

// src/api/productApi.js
import { resourceWithId } from '../utils/apiFactory';

export async function getProductById(id) {
  // 通过工厂方法生成 URL
  const url = resourceWithId('products', id);
  const response = await fetch(url);
  return response.json();
}
```

#### 用户查询："/api/v1/products/:id"

##### 快速模式 ❌

```sql
SELECT * FROM code_chunks
WHERE code_text LIKE '%products%'
  AND code_text LIKE '%/api%';
```

**结果**：❌ 无法找到
- ❌ URL 不在代码文本中（由工厂方法动态生成）
- ❌ 只能找到 `resourceWithId('products', id)` 调用
- ❌ 无法推导出最终的 URL 路径
- ❌ 无法关联到工厂方法的实现

**返回信息**：
```json
{
  "symbol_name": "getProductById",
  "code_text": "const url = resourceWithId('products', id);",
  "file_path": "src/api/productApi.js"
}
```
用户看到这个结果，无法知道实际的 URL 是什么。

##### 完整模式 ✅

```sql
SELECT * FROM url_patterns
WHERE normalized_pattern = '/api/v1/products/:id';
```

**匹配字段**：
- `url_pattern.pattern: "resourceWithId('products', id)"`
- `url_pattern.normalized: "/api/v1/products/:id"`

**结果**：✅ 完整追踪工厂方法调用链
- ✅ 识别 `resourceWithId` 是 URL 工厂方法
- ✅ 追踪到 `buildApiPath` 的实现
- ✅ 解析常量 `API_VERSION = 'v1'`
- ✅ 推导出最终 URL：`/api/v1/products/:id`
- ✅ 关联所有相关文件

**返回信息**：
```json
{
  "pattern": "resourceWithId('products', id)",
  "normalized_pattern": "/api/v1/products/:id",
  "method": "GET",
  "definition_file": "src/api/productApi.js",
  "definition_line": 6,
  "path_params": ["id"],
  "factory_chain": [
    {
      "function": "resourceWithId",
      "file": "src/utils/apiFactory.js",
      "line": 7,
      "returns": "${buildApiPath(resource)}/${id}"
    },
    {
      "function": "buildApiPath",
      "file": "src/utils/apiFactory.js",
      "line": 3,
      "returns": "/api/${API_VERSION}/${resource}"
    }
  ],
  "resolved_url": "/api/v1/products/:id"
}
```

**结论**：❌ **快速模式完全无法处理工厂方法，只有完整模式能追踪函数调用链并推导 URL**

---

### 场景 C：嵌套资源的多层 URL

#### 代码示例

```javascript
// src/api/orderApi.js
const API_BASE = '/api';

export async function getOrderItem(orderId, itemId) {
  // 三层嵌套的 URL
  const url = `${API_BASE}/orders/${orderId}/items/${itemId}`;
  const response = await fetch(url);
  return response.json();
}

// src/routes/complexRoutes.js
const router = express.Router();

// 服务端路由定义
router.get('/api/orders/:orderId/items/:itemId', (req, res) => {
  const { orderId, itemId } = req.params;
  // 处理逻辑
});

// src/components/UserDashboard.js
import { getOrderItem } from '../api/orderApi';

async function loadOrderDetails(orderId) {
  const items = await Promise.all([
    getOrderItem(orderId, 'item-1'),
    getOrderItem(orderId, 'item-2'),
    getOrderItem(orderId, 'item-3')
  ]);
  return items;
}
```

#### 用户查询："/api/orders/:orderId/items/:itemId"

##### 快速模式 ⚠️

```sql
SELECT * FROM code_chunks
WHERE code_text LIKE '%/api/orders%'
  AND code_text LIKE '%items%';
```

**结果**：⚠️ 可以找到部分，但不完整
- ✅ 找到 `getOrderItem` 函数（客户端调用）
- ✅ 找到路由定义（服务端）
- ❌ 找不到 `UserDashboard` 中的间接调用
- ❌ 无法识别这是同一个 URL 的不同使用场景
- ❌ 无法区分客户端调用和服务端定义

**返回信息**：
```json
[
  {
    "symbol_name": "getOrderItem",
    "code_text": "const url = `${API_BASE}/orders/${orderId}/items/${itemId}`;",
    "file_path": "src/api/orderApi.js",
    "line_start": 4
  },
  {
    "symbol_name": "anonymous",
    "code_text": "router.get('/api/orders/:orderId/items/:itemId', (req, res) => { ... })",
    "file_path": "src/routes/complexRoutes.js",
    "line_start": 5
  }
]
```

##### 完整模式 ✅

```sql
-- 查找 URL 模式
SELECT * FROM url_patterns
WHERE normalized_pattern = '/api/orders/:orderId/items/:itemId';

-- 查找所有使用该 URL 的位置
SELECT 
  uu.usage_file_id,
  f.path,
  uu.usage_line,
  uu.usage_context
FROM url_usages uu
JOIN files f ON uu.usage_file_id = f.id
WHERE uu.url_pattern_id = (
  SELECT id FROM url_patterns 
  WHERE normalized_pattern = '/api/orders/:orderId/items/:itemId'
);

-- 查找调用该 API 的函数
SELECT 
  cg.from_chunk_id,
  cc.symbol_name,
  f.path
FROM call_graph cg
JOIN code_chunks cc ON cg.from_chunk_id = cc.id
JOIN files f ON cc.file_id = f.id
WHERE cg.to_symbol = 'getOrderItem';
```

**结果**：✅ 完整的使用追踪
- ✅ 识别为同一个 URL 模式
- ✅ 找到客户端调用（`orderApi.js`）
- ✅ 找到服务端定义（`complexRoutes.js`）
- ✅ 找到间接调用（`UserDashboard.js` 通过 `getOrderItem`）
- ✅ 区分使用上下文（api_call vs route_definition）
- ✅ 追踪调用链：`loadOrderDetails` → `getOrderItem` → URL

**返回信息**：
```json
{
  "url_pattern": {
    "pattern": "/api/orders/${orderId}/items/${itemId}",
    "normalized_pattern": "/api/orders/:orderId/items/:itemId",
    "method": "GET",
    "path_params": ["orderId", "itemId"]
  },
  "usages": [
    {
      "type": "api_call",
      "file": "src/api/orderApi.js",
      "line": 4,
      "function": "getOrderItem",
      "context": "客户端 API 调用"
    },
    {
      "type": "route_definition",
      "file": "src/routes/complexRoutes.js",
      "line": 5,
      "context": "服务端路由定义"
    },
    {
      "type": "indirect_call",
      "file": "src/components/UserDashboard.js",
      "line": 6,
      "function": "loadOrderDetails",
      "call_chain": ["loadOrderDetails", "getOrderItem"],
      "context": "业务组件中的批量调用"
    }
  ],
  "call_graph": {
    "callers": [
      {"function": "loadOrderDetails", "file": "src/components/UserDashboard.js"}
    ],
    "callees": [
      {"function": "fetch", "type": "native"}
    ]
  }
}
```

**结论**：⚠️ **快速模式只能找到直接包含 URL 的代码，完整模式能追踪完整的调用链和使用上下文**

---

### 场景 D：条件分支中的多个 URL

#### 代码示例

```javascript
// src/api/advancedUserApi.js
export async function getUserData(userId, dataType) {
  let url;
  
  // 根据不同条件构建不同的 URL
  if (dataType === 'profile') {
    url = `/api/v1/users/${userId}/profile`;
  } else if (dataType === 'orders') {
    url = `/api/v1/users/${userId}/orders`;
  } else if (dataType === 'settings') {
    url = `/api/v1/users/${userId}/settings`;
  } else {
    url = `/api/v1/users/${userId}`;
  }
  
  const response = await fetch(url);
  return response.json();
}
```

#### 用户查询："/api/v1/users/:userId/orders"

##### 快速模式 ⚠️

```sql
SELECT * FROM code_chunks
WHERE code_text LIKE '%/api/v1/users%'
  AND code_text LIKE '%orders%';
```

**结果**：⚠️ 找到函数，但无法区分具体的 URL
- ✅ 找到 `getUserData` 函数
- ❌ 无法区分这个函数中的 4 个不同 URL
- ❌ 搜索 `/api/v1/users/:userId/profile` 也会返回同一个函数
- ❌ 无法知道哪个条件分支对应哪个 URL

**返回信息**：
```json
{
  "symbol_name": "getUserData",
  "code_text": "export async function getUserData(userId, dataType) { let url; if (dataType === 'profile') { url = `/api/v1/users/${userId}/profile`; } else if (dataType === 'orders') { url = `/api/v1/users/${userId}/orders`; } ... }",
  "file_path": "src/api/advancedUserApi.js",
  "line_start": 2
}
```

##### 完整模式 ✅

```sql
SELECT * FROM url_patterns
WHERE normalized_pattern = '/api/v1/users/:userId/orders';
```

**结果**：✅ 精确匹配特定的 URL
- ✅ 识别出 4 个不同的 URL 模式
- ✅ 每个 URL 有独立的记录
- ✅ 记录条件分支信息
- ✅ 搜索不同 URL 返回不同结果

**返回信息**：
```json
{
  "pattern": "/api/v1/users/${userId}/orders",
  "normalized_pattern": "/api/v1/users/:userId/orders",
  "method": "GET",
  "definition_file": "src/api/advancedUserApi.js",
  "definition_line": 7,
  "path_params": ["userId"],
  "condition": "dataType === 'orders'",
  "branch_context": {
    "type": "if-else",
    "condition": "dataType === 'orders'",
    "sibling_urls": [
      "/api/v1/users/:userId/profile",
      "/api/v1/users/:userId/settings",
      "/api/v1/users/:userId"
    ]
  }
}
```

**其他 URL 的独立记录**：
```json
[
  {
    "normalized_pattern": "/api/v1/users/:userId/profile",
    "definition_line": 5,
    "condition": "dataType === 'profile'"
  },
  {
    "normalized_pattern": "/api/v1/users/:userId/settings",
    "definition_line": 9,
    "condition": "dataType === 'settings'"
  },
  {
    "normalized_pattern": "/api/v1/users/:userId",
    "definition_line": 11,
    "condition": "else"
  }
]
```

**结论**：⚠️ **快速模式无法区分条件分支中的不同 URL，完整模式为每个 URL 创建独立记录**

---

### 场景 E：循环中批量生成的 URL

#### 代码示例

```javascript
// src/api/dynamicOrderApi.js
export async function getMultipleOrders(orderIds) {
  // 在循环中为每个 orderId 生成 URL
  const orders = await Promise.all(
    orderIds.map(id => {
      const url = `/api/v1/orders/${id}`;
      return fetch(url).then(res => res.json());
    })
  );
  return orders;
}

// src/components/UserDashboard.js
async function batchProcessOrders(orderIds) {
  // 使用 for 循环批量请求
  const results = [];
  for (const id of orderIds) {
    const url = `/api/v1/orders/${id}`;
    const response = await fetch(url);
    results.push(await response.json());
  }
  return results;
}
```

#### 用户查询："/api/v1/orders/:id"

##### 快速模式 ⚠️

```sql
SELECT * FROM code_chunks
WHERE code_text LIKE '%/api/v1/orders%';
```

**结果**：⚠️ 找到代码块，但信息有限
- ✅ 找到两个函数
- ❌ 无法识别这是批量请求
- ❌ 无法统计该 URL 的使用频率
- ❌ 无法区分单次调用和批量调用

**返回信息**：
```json
[
  {
    "symbol_name": "getMultipleOrders",
    "code_text": "orderIds.map(id => { const url = `/api/v1/orders/${id}`; return fetch(url)... })",
    "file_path": "src/api/dynamicOrderApi.js"
  },
  {
    "symbol_name": "batchProcessOrders",
    "code_text": "for (const id of orderIds) { const url = `/api/v1/orders/${id}`; ... }",
    "file_path": "src/components/UserDashboard.js"
  }
]
```

##### 完整模式 ✅

```sql
SELECT 
  up.*,
  COUNT(uu.id) as usage_count,
  uu.usage_context
FROM url_patterns up
LEFT JOIN url_usages uu ON up.id = uu.url_pattern_id
WHERE up.normalized_pattern = '/api/v1/orders/:id'
GROUP BY up.id, uu.usage_context;
```

**结果**：✅ 完整的使用统计和上下文
- ✅ 识别为同一个 URL 模式
- ✅ 统计使用次数（2 次）
- ✅ 识别使用上下文（map 循环、for 循环）
- ✅ 标记为批量请求场景
- ✅ 可以分析性能影响

**返回信息**：
```json
{
  "pattern": "/api/v1/orders/${id}",
  "normalized_pattern": "/api/v1/orders/:id",
  "method": "GET",
  "path_params": ["id"],
  "usage_count": 2,
  "usages": [
    {
      "file": "src/api/dynamicOrderApi.js",
      "line": 5,
      "function": "getMultipleOrders",
      "context": "batch_request",
      "loop_type": "map",
      "performance_note": "Promise.all 并行请求，性能较好"
    },
    {
      "file": "src/components/UserDashboard.js",
      "line": 5,
      "function": "batchProcessOrders",
      "context": "batch_request",
      "loop_type": "for",
      "performance_note": "串行请求，可能存在性能问题"
    }
  ],
  "performance_analysis": {
    "total_usages": 2,
    "batch_requests": 2,
    "potential_n_plus_1": true,
    "optimization_suggestion": "考虑使用批量 API：GET /api/v1/orders?ids=1,2,3"
  }
}
```

**结论**：⚠️ **快速模式无法识别批量请求模式，完整模式能分析使用频率和性能影响**

---

## 15. 复杂场景总结表

| 场景 | 快速模式 | 完整模式 | 差异说明 |
|------|---------|---------|---------|
| **常量拼接 URL** | ⚠️ 找到代码 | ✅ 追踪常量值 | 完整模式能跨文件追踪常量定义 |
| **工厂方法 URL** | ❌ 无法推导 | ✅ 追踪调用链 | 完整模式能推导函数返回的 URL |
| **嵌套资源 URL** | ⚠️ 部分匹配 | ✅ 完整追踪 | 完整模式能追踪间接调用 |
| **条件分支 URL** | ⚠️ 无法区分 | ✅ 独立记录 | 完整模式为每个分支创建记录 |
| **循环批量 URL** | ⚠️ 找到代码 | ✅ 使用统计 | 完整模式能分析使用频率 |

---

## 16. 实战建议

### 对于简单项目（< 100 个文件）

**快速模式已足够**：
- URL 通常是硬编码的字符串
- 很少使用工厂方法或复杂拼接
- 代码搜索就能找到大部分 URL

### 对于中型项目（100-1000 个文件）

**需要完整模式**：
- 开始使用常量和配置文件
- 有一定的代码抽象（工厂方法）
- 需要追踪 URL 的使用情况

### 对于大型项目（> 1000 个文件）

**必须使用完整模式**：
- 复杂的 URL 构建逻辑
- 多层抽象和工厂方法
- 需要分析 API 使用频率
- 需要追踪跨服务的 API 调用

### 实际使用流程

```
1. 上传代码 → 5分钟后快速模式完成
   ↓
2. 用户开始基础搜索
   - 搜索简单的 URL：✅ 可以找到
   - 搜索复杂的 URL：⚠️ 结果不完整
   ↓
3. 26分钟后完整模式完成
   ↓
4. 用户获得完整功能
   - 搜索任何 URL：✅ 精确匹配
   - 追踪 URL 构建：✅ 完整调用链
   - 分析 API 使用：✅ 统计和建议
```

### 前端提示优化

```javascript
// 快速模式完成后
if (indexLevel === 'quick') {
  showMessage({
    type: 'info',
    title: '基础搜索已可用',
    message: '简单的 URL 搜索已可用。高级功能（常量追踪、工厂方法推导）正在后台构建中...',
    features: {
      available: ['基础 URL 搜索', '代码文本搜索'],
      pending: ['常量追踪', '工厂方法推导', '调用链分析']
    }
  });
}

// 完整模式完成后
if (indexLevel === 'full') {
  showMessage({
    type: 'success',
    title: '完整功能已就绪',
    message: '现在支持复杂 URL 搜索、常量追踪、工厂方法推导等高级功能！',
    features: {
      available: [
        '✅ 常量拼接 URL 追踪',
        '✅ 工厂方法 URL 推导',
        '✅ 多文件 URL 构建分析',
        '✅ 条件分支 URL 识别',
        '✅ 批量请求模式分析'
      ]
    }
  });
}
```
