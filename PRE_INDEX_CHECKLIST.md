# 5K 文件仓库索引前检查报告

## 检查时间
2024-01-XX

## 仓库规模
- **预期文件数**：5,000 个文件（包含各种类型）
- **实际索引文件数**：仅索引 `.ts`, `.tsx`, `.js`, `.jsx`, `.vue` 文件
- **预估索引时间**：基础索引 15-20 分钟，增强索引 60-90 分钟

---

## ✅ 安全检查项

### 1. **文件类型过滤 - 正常**

**代码位置**：`apps/api/src/indexer/indexer.ts:216`

```typescript
if (fullPath.match(/\.(ts|tsx|js|jsx|vue)$/)) {
  files.push(fullPath);
}
```

**结论**：
- ✅ 只索引支持的文件类型（TypeScript/JavaScript/Vue）
- ✅ 自动跳过图片、视频、PDF、二进制文件等
- ✅ 不会因为不支持的文件类型而报错

### 2. **目录过滤 - 正常**

**代码位置**：`apps/api/src/indexer/indexer.ts:200-204`

```typescript
const skipDirs = [
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '.cache', '.turbo', '.nuxt', '.output', 'out', '.vercel',
  'vendor', 'target', '__pycache__', '.pytest_cache'
];
```

**结论**：
- ✅ 自动跳过 node_modules、dist、build 等目录
- ✅ 避免索引编译产物和依赖包
- ✅ 大幅减少实际需要索引的文件数

### 3. **错误处理 - 正常**

**代码位置**：`apps/api/src/indexer/indexer.ts:130-134`

```typescript
} catch (error) {
  console.error(`Failed to index ${filePath}:`, error);
  processedCount++;
  await updateIndexProgress(repoId, files.length, alreadyIndexed + processedCount);
}
```

**结论**：
- ✅ 单个文件解析失败不会中断整个索引
- ✅ 错误会被记录到日志
- ✅ 进度会继续更新

### 4. **内存管理 - 正常**

**代码位置**：`apps/api/src/indexer/indexer.ts:82-88`

```typescript
const BATCH_SIZE = 10;
for (let i = 0; i < filesToProcess.length; i += BATCH_SIZE) {
  const batch = filesToProcess.slice(i, i + BATCH_SIZE);
  // ... 处理批次
  
  // Force garbage collection between batches if available
  if (global.gc) {
    global.gc();
  }
  
  // Add delay between batches to allow memory cleanup
  await new Promise(resolve => setTimeout(resolve, 1000));
}
```

**结论**：
- ✅ 批处理机制（每批 10 个文件）
- ✅ 批次间强制垃圾回收
- ✅ 批次间延迟 1 秒，避免内存溢出

### 5. **文本编码处理 - 正常**

**代码位置**：`apps/api/src/indexer/indexer.ts:92`

```typescript
const content = await readFile(filePath, 'utf-8');
```

**结论**：
- ✅ 使用 UTF-8 编码读取文件
- ⚠️ 如果文件不是 UTF-8 编码（如 GBK），可能会出现乱码
- ⚠️ 二进制文件会被跳过（因为文件类型过滤）

### 6. **解析器错误处理 - 正常**

**代码位置**：`apps/api/src/parser/ts-parser.ts:14-21`

```typescript
try {
  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx', ['decorators', { decoratorsBeforeExport: true }]],
  });
  // ... 解析逻辑
} catch (error) {
  console.error(`Failed to parse ${filePath}:`, error);
  return { chunks: [], imports: [], exports: [], language: 'unknown' };
}
```

**结论**：
- ✅ 解析失败会返回空结果，不会抛出异常
- ✅ 语法错误的文件会被跳过
- ✅ 不会因为单个文件的语法错误而中断索引

### 7. **OpenAI API 限流保护 - 正常**

**代码位置**：`apps/api/src/llm/embeddings.ts:74-90`

```typescript
const BATCH_SIZE = 10;
for (let i = 0; i < uncachedTexts.length; i += BATCH_SIZE) {
  const batchTexts = uncachedTexts.slice(i, i + BATCH_SIZE);
  // ... 批量调用 API
}
```

**结论**：
- ✅ Embedding 批处理（每批 10 个）
- ✅ 减少 API 调用次数
- ⚠️ 没有重试机制，如果遇到 429 限流会直接失败

### 8. **数据库连接池 - 正常**

**代码位置**：`apps/api/src/db/index.ts`（连接池配置）

```typescript
const pool = new Pool({
  max: 50, // 最大连接数
  // ...
});
```

**结论**：
- ✅ 连接池大小 50，足够支撑并发写入
- ✅ 避免连接耗尽

---

## ⚠️ 潜在风险点

### 1. **大文件处理**

**风险**：
- 如果单个文件超过 10MB，读取到内存可能导致内存压力
- 超大文件的 AST 解析可能耗时很长

**缓解措施**：
- 当前没有文件大小限制
- 建议：如果遇到超大文件，可以手动跳过或拆分

**建议**：
```typescript
// 可以添加文件大小检查
const stats = await stat(filePath);
if (stats.size > 10 * 1024 * 1024) { // 10MB
  console.warn(`Skipping large file: ${filePath} (${stats.size} bytes)`);
  continue;
}
```

### 2. **OpenAI API 成本**

**预估成本**（假设 5000 个文件，每个文件平均 10 个 chunks）：
- 总 chunks：50,000 个
- Embedding 调用：50,000 次（假设无缓存）
- 成本：约 $0.50 - $1.00（取决于 API 定价）

**建议**：
- 确认 OpenAI API 余额充足
- 监控 API 调用量

### 3. **索引时间**

**预估时间**：
- 基础索引：5000 文件 / 100 文件/分钟 = 50 分钟
- 增强索引：5000 文件 / 60 文件/分钟 = 83 分钟
- **总计**：约 2-2.5 小时

**建议**：
- 在非高峰时段进行索引
- 确保服务器稳定运行，避免中断

### 4. **数据库存储空间**

**预估存储**（假设 50,000 个 chunks）：
- code_chunks 表：~1.5 GB（包含向量）
- string_constants 表：~500 MB
- call_graph 表：~200 MB
- **总计**：约 2-3 GB

**建议**：
- 确认数据库有足够空间（至少 5 GB 可用）
- 索引前清空旧数据（如果需要）

### 5. **非 UTF-8 编码文件**

**风险**：
- 如果仓库包含 GBK、Latin-1 等编码的文件，会出现乱码
- 乱码文件可能导致解析失败

**缓解措施**：
- 解析失败会被捕获，不会中断索引
- 乱码文件会被跳过

**建议**：
- 如果发现大量解析失败，检查文件编码
- 可以使用 `chardet` 库自动检测编码

---

## ✅ 推荐操作流程

### 步骤 1：备份数据库（可选）
```bash
ssh root@47.116.6.132
pg_dump -U postgres codelens > backup_$(date +%Y%m%d).sql
```

### 步骤 2：清空旧数据（如果需要）
```sql
-- 在数据库中执行
DELETE FROM repos WHERE id = <旧仓库ID>;
```

### 步骤 3：上传仓库
- 通过前端上传 ZIP 文件
- 或通过 GitLab URL 接入

### 步骤 4：监控索引进度
- 前端会显示实时进度
- 服务器日志：`ssh root@47.116.6.132 "pm2 logs codelens-api"`

### 步骤 5：验证索引结果
- 基础索引完成后，尝试简单查询
- 增强索引完成后，尝试复杂查询（URL 搜索、根因分析）

---

## 🔍 监控命令

### 查看索引日志
```bash
ssh root@47.116.6.132 "pm2 logs codelens-api --lines 100"
```

### 查看数据库大小
```bash
ssh root@47.116.6.132 "psql -U postgres -d codelens -c \"
SELECT 
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
\""
```

### 查看索引进度（数据库）
```bash
ssh root@47.116.6.132 "psql -U postgres -d codelens -c \"
SELECT id, name, status, index_progress 
FROM repos 
WHERE status = 'indexing';
\""
```

---

## 📊 预期结果

### 成功指标
- ✅ 基础索引完成，status = 'ready'
- ✅ 增强索引完成，无报错
- ✅ 可以正常查询和问答
- ✅ 数据库大小在预期范围内（2-3 GB）

### 失败指标
- ❌ 索引中途失败，status = 'failed'
- ❌ 大量文件解析失败（超过 10%）
- ❌ OpenAI API 限流或余额不足
- ❌ 数据库连接超时或空间不足

---

## 🚨 紧急处理

### 如果索引卡住
```bash
# 查看进程状态
ssh root@47.116.6.132 "pm2 status"

# 重启服务
ssh root@47.116.6.132 "pm2 restart codelens-api"

# 查看错误日志
ssh root@47.116.6.132 "pm2 logs codelens-api --err --lines 50"
```

### 如果需要中止索引
```bash
# 停止服务
ssh root@47.116.6.132 "pm2 stop codelens-api"

# 清理数据
ssh root@47.116.6.132 "psql -U postgres -d codelens -c \"DELETE FROM repos WHERE id = <repo_id>;\""

# 重启服务
ssh root@47.116.6.132 "pm2 start codelens-api"
```

---

## 📝 总结

### 系统准备情况：✅ 可以安全索引

**优势**：
1. ✅ 完善的错误处理机制
2. ✅ 批处理和内存管理
3. ✅ 文件类型和目录过滤
4. ✅ 进度监控和恢复能力

**注意事项**：
1. ⚠️ 索引时间较长（2-2.5 小时）
2. ⚠️ OpenAI API 成本（约 $0.50-$1.00）
3. ⚠️ 数据库存储空间（需要 5 GB 可用）
4. ⚠️ 非 UTF-8 编码文件可能出现乱码

**建议**：
- 在非高峰时段进行索引
- 监控服务器资源和日志
- 准备好应急处理方案

**风险评估**：🟢 低风险，可以开始索引
