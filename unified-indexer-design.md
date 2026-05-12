# 统一索引器设计方案

## 1. 架构对比

### 现有设计（两阶段）

```
用户上传代码
    ↓
┌─────────────────────────────────────┐
│ 阶段1：基础索引（Babel Parser）      │
│ - 解析文件（@babel/parser）          │
│ - 提取代码块                         │
│ - 生成 code_chunks                   │
│ - 生成粗粒度向量                     │
│ 时间：~5分钟                         │
└─────────────────────────────────────┘
    ↓ 用户可以开始搜索
┌─────────────────────────────────────┐
│ 阶段2：增强索引（ts-morph）          │
│ - 重新解析文件（ts-morph）           │
│ - 提取详细实体                       │
│ - 生成 functions/classes/constants   │
│ - 生成细粒度向量                     │
│ - 构建关系图谱                       │
│ 时间：~30分钟                        │
└─────────────────────────────────────┘
    ↓ 完整功能可用
```

**问题**：
- ❌ 重复解析：同一个文件被解析两次
- ❌ 两个解析器：Babel + ts-morph，维护成本高
- ❌ 代码分散：indexer.ts + enhanced-indexer.ts
- ❌ 数据冗余：code_chunks 和 functions 表有重叠

---

### 新设计（统一索引器）

```
用户上传代码
    ↓
┌─────────────────────────────────────┐
│ 统一索引器（ts-morph）               │
│                                     │
│ 快速模式（优先级高）                 │
│ - 解析文件一次                       │
│ - 提取基本信息                       │
│ - 生成 code_chunks（粗粒度）         │
│ - 生成基础向量                       │
│ - 跳过关系构建                       │
│ 时间：~8分钟（比Babel慢一点）        │
└─────────────────────────────────────┘
    ↓ 用户可以开始搜索
┌─────────────────────────────────────┐
│ 统一索引器（ts-morph）               │
│                                     │
│ 完整模式（优先级低，后台运行）        │
│ - 复用已解析的 AST（缓存）           │
│ - 提取详细信息                       │
│ - 生成 functions/classes/constants   │
│ - 生成细粒度向量                     │
│ - 构建关系图谱                       │
│ 时间：~25分钟（复用AST，更快）       │
└─────────────────────────────────────┘
    ↓ 完整功能可用
```

**优势**：
- ✅ 只解析一次：AST 可以缓存复用
- ✅ 一个解析器：只用 ts-morph，代码统一
- ✅ 代码集中：一个 unified-indexer.ts
- ✅ 渐进式增强：快速模式 → 完整模式

---

## 2. 代码实现

### 2.1 统一索引器接口

```typescript
/**
 * 统一索引器 - 支持快速模式和完整模式
 */
export class UnifiedIndexer {
  private astCache: LRUCache<Project>; // 缓存 ts-morph Project
  
  constructor(private db: Pool, private anthropicApiKey: string) {
    this.astCache = new LRUCache(100, 10 * 60 * 1000); // 10分钟缓存
  }

  /**
   * 索引文件 - 支持两种模式
   * 
   * @param mode - 'quick': 快速模式，只生成基础索引
   *               'full': 完整模式，生成所有索引和关系
   */
  async indexFile(
    repoId: number,
    fileId: number,
    filePath: string,
    content: string,
    mode: 'quick' | 'full' = 'quick'
  ): Promise<IndexResult> {
    console.log(`[${mode.toUpperCase()}] Indexing ${filePath}`);

    // 解析 AST（只解析一次，缓存复用）
    const ast = await this.parseFile(filePath, content);

    if (mode === 'quick') {
      return this.quickIndex(repoId, fileId, filePath, ast);
    } else {
      return this.fullIndex(repoId, fileId, filePath, ast);
    }
  }

  /**
   * 批量索引 - 先快速模式，再完整模式
   */
  async indexRepository(
    repoId: number,
    repoPath: string,
    options: IndexOptions = {}
  ): Promise<void> {
    const files = await this.collectFiles(repoPath);

    // 阶段1：快速模式（优先级高）
    console.log('🚀 Phase 1: Quick indexing...');
    await this.batchIndex(repoId, files, 'quick', {
      onProgress: (progress) => {
        console.log(`Quick: ${progress.processed}/${progress.total}`);
        // 用户可以开始搜索了
      }
    });

    console.log('✅ Quick indexing done! Users can start searching.');

    // 阶段2：完整模式（后台运行）
    console.log('🔧 Phase 2: Full indexing (background)...');
    await this.batchIndex(repoId, files, 'full', {
      onProgress: (progress) => {
        console.log(`Full: ${progress.processed}/${progress.total}`);
      }
    });

    console.log('✅ Full indexing done! All features available.');
  }

  // ============================================
  // 私有方法
  // ============================================

  /**
   * 解析文件为 AST（带缓存）
   */
  private async parseFile(filePath: string, content: string): Promise<SourceFile> {
    const cacheKey = `${filePath}:${this.hashContent(content)}`;
    
    let project = this.astCache.get(cacheKey);
    if (!project) {
      project = new Project({
        useInMemoryFileSystem: true,
        compilerOptions: {
          target: ScriptTarget.Latest,
          module: ModuleKind.ESNext,
        },
      });
      project.createSourceFile(filePath, content);
      this.astCache.set(cacheKey, project);
    }

    return project.getSourceFile(filePath)!;
  }

  /**
   * 快速模式：只生成基础索引
   */
  private async quickIndex(
    repoId: number,
    fileId: number,
    filePath: string,
    ast: SourceFile
  ): Promise<IndexResult> {
    const result: IndexResult = {
      codeChunks: 0,
      entities: 0,
      relationships: 0,
    };

    // 1. 提取代码块（粗粒度）
    const chunks = this.extractCodeChunks(ast);
    
    // 2. 生成粗粒度向量
    const texts = chunks.map(c => `${c.name} ${c.type}\n${c.code.slice(0, 500)}`);
    const embeddings = await this.batchGenerateEmbeddings(texts);

    // 3. 存储到 code_chunks 表
    for (let i = 0; i < chunks.length; i++) {
      await this.db.query(
        `INSERT INTO code_chunks (
          repo_id, file_id, symbol_name, symbol_type,
          line_start, line_end, code_text, embedding
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (repo_id, file_id, symbol_name, line_start) DO UPDATE
        SET code_text = EXCLUDED.code_text, embedding = EXCLUDED.embedding`,
        [
          repoId, fileId, chunks[i].name, chunks[i].type,
          chunks[i].lineStart, chunks[i].lineEnd,
          chunks[i].code, `[${embeddings[i].join(',')}]`
        ]
      );
      result.codeChunks++;
    }

    // 快速模式：不提取实体，不构建关系
    return result;
  }

  /**
   * 完整模式：生成所有索引和关系
   */
  private async fullIndex(
    repoId: number,
    fileId: number,
    filePath: string,
    ast: SourceFile
  ): Promise<IndexResult> {
    const result: IndexResult = {
      codeChunks: 0,
      entities: 0,
      relationships: 0,
    };

    // 1. 提取详细实体
    const entities = this.extractEntities(ast);
    
    // 2. 存储实体到专门的表
    await this.storeEntities(repoId, fileId, entities);
    result.entities = entities.functions.length + 
                      entities.classes.length + 
                      entities.constants.length;

    // 3. 生成细粒度向量
    await this.generateEntityEmbeddings(repoId, fileId, entities);

    // 4. 构建关系图谱
    const relationships = await this.buildRelationships(repoId, fileId, filePath, entities);
    result.relationships = relationships.importsCreated + 
                          relationships.callGraphEdgesCreated;

    return result;
  }

  /**
   * 提取代码块（快速模式用）
   * 只提取基本信息，不深入分析
   */
  private extractCodeChunks(ast: SourceFile): CodeChunk[] {
    const chunks: CodeChunk[] = [];

    // 遍历所有函数
    ast.getFunctions().forEach(func => {
      chunks.push({
        name: func.getName() || 'anonymous',
        type: 'function',
        lineStart: func.getStartLineNumber(),
        lineEnd: func.getEndLineNumber(),
        code: func.getText(),
      });
    });

    // 遍历所有类
    ast.getClasses().forEach(cls => {
      chunks.push({
        name: cls.getName() || 'anonymous',
        type: 'class',
        lineStart: cls.getStartLineNumber(),
        lineEnd: cls.getEndLineNumber(),
        code: cls.getText(),
      });
    });

    // 遍历所有变量声明
    ast.getVariableDeclarations().forEach(decl => {
      chunks.push({
        name: decl.getName(),
        type: 'variable',
        lineStart: decl.getStartLineNumber(),
        lineEnd: decl.getEndLineNumber(),
        code: decl.getText(),
      });
    });

    return chunks;
  }

  /**
   * 提取详细实体（完整模式用）
   * 深入分析类型、参数、返回值等
   */
  private extractEntities(ast: SourceFile): DetailedEntities {
    // 这里复用 enhanced-indexer.ts 中的 ASTAnalyzer 逻辑
    // 提取函数签名、参数类型、返回值、复杂度等
    // 提取类的继承关系、接口实现等
    // 提取字符串常量并分类
    // 提取 URL 模式
    
    return {
      functions: this.extractFunctions(ast),
      classes: this.extractClasses(ast),
      constants: this.extractConstants(ast),
      urlPatterns: this.extractURLPatterns(ast),
      imports: this.extractImports(ast),
    };
  }
}
```

---

## 3. 使用方式对比

### 现有方式

```typescript
// 文件1: indexer.ts
await indexCodebase(repoId, repoPath);  // 基础索引

// 文件2: enhanced-indexer.ts
const enhancedIndexer = new EnhancedIndexer(pool, apiKey);
await enhancedIndexer.reindexRepository(repoId, repoPath);  // 增强索引
```

### 新方式

```typescript
// 只需要一个索引器
const indexer = new UnifiedIndexer(pool, apiKey);

// 方式1：自动渐进式索引（推荐）
await indexer.indexRepository(repoId, repoPath);
// 内部自动执行：快速模式 → 完整模式

// 方式2：手动控制
await indexer.indexFile(repoId, fileId, filePath, content, 'quick');  // 快速
await indexer.indexFile(repoId, fileId, filePath, content, 'full');   // 完整
```

---

## 4. 性能对比

### 现有设计

| 阶段 | 解析器 | 时间 | 用户体验 |
|------|--------|------|----------|
| 基础索引 | Babel | 5分钟 | ✅ 可以搜索 |
| 增强索引 | ts-morph | 30分钟 | ✅ 完整功能 |
| **总计** | 两个 | **35分钟** | 两次解析 |

### 新设计

| 阶段 | 解析器 | 时间 | 用户体验 |
|------|--------|------|----------|
| 快速模式 | ts-morph | 8分钟 | ✅ 可以搜索 |
| 完整模式 | ts-morph（复用AST） | 20分钟 | ✅ 完整功能 |
| **总计** | 一个 | **28分钟** | 一次解析 |

**性能提升**：
- ✅ 总时间减少 20%（35分钟 → 28分钟）
- ✅ 只解析一次，AST 可复用
- ⚠️ 快速模式稍慢（5分钟 → 8分钟），但可接受

---

## 5. 数据库表设计对比

### 现有设计

```sql
-- 基础索引生成
code_chunks (
  id, repo_id, file_id,
  symbol_name, symbol_type,
  line_start, line_end,
  code_text, embedding  -- 粗粒度向量
)

-- 增强索引生成（有重叠）
functions (
  id, repo_id, file_id,
  name, full_name, signature,
  line_start, line_end,
  code, embedding  -- 细粒度向量
)
```

**问题**：code_chunks 和 functions 有重叠，浪费存储空间

### 新设计（优化版）

```sql
-- 统一的代码块表
code_chunks (
  id, repo_id, file_id,
  symbol_name, symbol_type,
  line_start, line_end,
  code_text,
  embedding,  -- 粗粒度向量（快速模式生成）
  
  -- 完整模式才填充的字段
  detailed_info JSONB,  -- 详细信息（签名、参数、返回值等）
  fine_embedding vector(1536),  -- 细粒度向量（完整模式生成）
  indexed_level VARCHAR(10)  -- 'quick' | 'full'
)

-- 专门的实体表（完整模式生成）
functions (...)  -- 保留，用于精确查询
classes (...)
string_constants (...)
url_patterns (...)

-- 关系表（完整模式生成）
import_relations (...)
call_graph (...)
constant_references (...)
```

**优势**：
- ✅ code_chunks 记录索引级别，避免重复
- ✅ 两种粒度的向量都保留，搜索更灵活
- ✅ 可以查询哪些文件只有快速索引，需要补全

---

## 6. 搜索策略对比

### 现有设计

```typescript
// 向量搜索：同时搜索两种粒度
const tables = ['code_chunks', 'functions', 'classes', 'string_constants'];

// 图搜索：只能在完整索引后使用
if (enhancedIndexingDone) {
  await graphSearch(repoId, query);
}
```

### 新设计

```typescript
// 向量搜索：根据索引级别自动选择
const quickIndexedFiles = await db.query(
  'SELECT file_id FROM code_chunks WHERE indexed_level = "quick"'
);

if (quickIndexedFiles.length > 0) {
  // 部分文件只有快速索引，只搜索 code_chunks
  await searchCodeChunks(repoId, query);
} else {
  // 所有文件都有完整索引，搜索所有表
  await searchAllTables(repoId, query);
}

// 图搜索：自动降级
try {
  await graphSearch(repoId, query);
} catch (NoRelationshipsError) {
  // 关系图谱未构建，降级到向量搜索
  await vectorSearch(repoId, query);
}
```

---

## 7. 优缺点总结

### 现有设计（两阶段）

**优点**：
- ✅ 快速模式非常快（Babel 性能好）
- ✅ 两个阶段完全独立，容错性好
- ✅ 可以单独运行基础索引

**缺点**：
- ❌ 重复解析，浪费 CPU
- ❌ 两个解析器，维护成本高
- ❌ 代码分散，难以理解
- ❌ 数据有重叠，浪费存储

### 新设计（统一索引器）

**优点**：
- ✅ 只解析一次，AST 可复用
- ✅ 代码统一，易于维护
- ✅ 总时间更短（20% 提升）
- ✅ 架构清晰，易于扩展

**缺点**：
- ⚠️ 快速模式稍慢（8分钟 vs 5分钟）
- ⚠️ ts-morph 内存占用比 Babel 大
- ⚠️ 需要重构现有代码

---

## 8. 迁移路径

### 阶段1：保持兼容
```typescript
// 保留现有接口，内部使用统一索引器
export async function indexCodebase(repoId: number, repoPath: string) {
  const indexer = new UnifiedIndexer(pool, apiKey);
  await indexer.indexRepository(repoId, repoPath);
}
```

### 阶段2：逐步迁移
- 新项目使用统一索引器
- 旧项目保持现有方式
- 数据库表兼容两种方式

### 阶段3：完全切换
- 移除 Babel 解析器
- 移除旧的 indexer.ts
- 统一使用 UnifiedIndexer

---

## 9. 推荐方案

**短期**：保持现有设计
- 如果系统运行稳定，不急于重构
- 两阶段设计虽然有冗余，但容错性好

**长期**：迁移到统一索引器
- 新功能基于统一索引器开发
- 逐步重构，降低风险
- 最终获得更清晰的架构

---

## 10. 结论

统一索引器方案在架构上更优雅，性能也更好，但需要重构成本。

**建议**：
1. 如果是新项目，直接用统一索引器
2. 如果是现有项目，评估重构成本和收益
3. 可以先实现统一索引器，与现有系统并行运行，逐步迁移
