# 影响面分析：设计与一次「静默坏账」的修复

> 状态：已实现（2026-09）
> 相关代码：`apps/api/src/analysis/impact.ts`、`apps/api/src/server/routes/analysis.ts`
> 相关迁移：`apps/api/migrations/004_fix_call_graph_and_file_dependencies.sql`

---

## 1. 为什么要做这个

「改了这里会波及什么」是这个项目最有价值的候选能力：它复用的全部是**已经索引好**的数据，
不需要新增任何采集逻辑。但动手之前先把数据链路摸了一遍，结果发现了比功能本身更值得记录的东西。

原始需求只是加两个接口。实际做的事里，大约 70% 的时间花在「让这两个接口背后的数据真的存在」。

---

## 2. 核心发现：整条图链路从来没有工作过

### 2.1 症状与真相

表面上，`call_graph` 表存在、建了索引、有 `/call-graph` 接口、`multi-strategy-search` 里有
`call_graph` 检索策略、`DependencyTracker` 有 800 多行图算法。看起来是个「基本可用但不够强」的子系统。

真相是 **这张表一行数据都没有**。

### 2.2 根因

`relationship-builder.ts` 的写入语句是这样的：

```sql
INSERT INTO call_graph (
  repo_id,           -- ← 这一列不存在
  from_chunk_id,
  to_chunk_id,       -- ← 这一列也不存在
  to_symbol, call_type, arguments, call_line
) VALUES (...)
ON CONFLICT DO NOTHING
```

而 `call_graph` 的真实定义（`db/index.ts` 建表 + migration 001）只有：

```
id, from_chunk_id, to_symbol, created_at, call_type, arguments, call_line
```

**缺少 `repo_id` 与 `to_chunk_id`。** 这条 INSERT 必然抛
`column "repo_id" of relation "call_graph" does not exist`。

而这行 INSERT 被 `try/catch` 包着：

```ts
} catch (error) {
  // 记录错误但继续处理其他函数
  console.error(`Error creating call graph edges for ${name}:`, error);
}
```

于是每一个函数都失败一次、打印一行日志、然后继续。索引「成功完成」，
报告里写着「已建立 N 个关系」，而调用图是空的。

### 2.3 缺失的列被 8 处代码引用

`repo_id` 与 `to_chunk_id` 不只是写入方需要：

| 列 | 引用位置 | 后果 |
|---|---|---|
| `repo_id` | `relationship-builder` 写入 | 写入必然失败 |
| `repo_id` | `clearRepoData`（`db/index.ts`，删除仓库时调用） | 删仓库删到一半抛错，留下半清理的脏数据 |
| `repo_id` | `EnhancedIndexer.getIndexingStats` | 整个统计查询失败，索引统计永远拿不到 |
| `to_chunk_id` | `multi-strategy-search` × 2（caller/callee 检索） | 依赖感知检索策略必然抛错 |
| `to_chunk_id` | `dependency-tracker` × 2 | 图查询必然抛错 |

也就是说：**代码库对自己表结构的认知是自相矛盾的**。写入方和 6 处读取方assume 有这两列，
`db/index.ts` 的建表语句里却没有，还有一处注释明确写着「call_graph 表没有 repo_id 字段，
需要通过 JOIN 删除」——那是有人发现了问题、绕过去了，但没去修根因。

### 2.4 第二笔坏账：`file_dependencies` 与一个不存在的触发器

`relationship-builder.ts` 里原本写着：

```ts
// 步骤 5: 更新文件依赖关系（由 import_relations 表的触发器自动完成）
// 数据库触发器会自动聚合 import_relations 表的数据，生成文件级别的依赖关系
// 因此这里不需要手动处理
```

全仓库检索 `CREATE TRIGGER` / `CREATE FUNCTION`：**零结果**。
那个「会自动聚合的触发器」从来没被写出来。代码把职责委托给了一个不存在的东西，
注释还替它背书。这就是 `file_dependencies` 一直是空表的全部原因。

### 2.5 第三笔：写入正确、读取全错的表

修复过程中检查器还额外抓出两类「表没问题、查询写错了」的缺陷：

- `dependency-tracker.ts` / `relationship-builder.ts` 里的
  `SELECT id, content FROM code_chunks` —— `code_chunks` 的正文列叫 `code_text`，
  `content` 是 `files` 表的列。取回 `undefined` 后立刻 `.split('\n')`，必然 TypeError。
- `multi-strategy-search.ts` 的 `getAvailableTerms` 里
  `SELECT DISTINCT symbol_name FROM functions` —— `functions` / `classes` 的列是
  `name` / `full_name`，只有 `string_constants` 才有 `symbol_name`。
  三连查询包在同一个 `try` 里，第一条就抛 → 整块 `catch` → **搜索建议词永远是空的**。

这些都属于同一类：**写错了列名，但因为被 catch 包住，表现得像「功能只是弱」，而不是「坏了」。**

---

## 3. 怎么修的

### 3.1 先建一把「能离线运行的尺子」

本地没有 PostgreSQL（`ECONNREFUSED`），也没有 Docker。而上面全部缺陷的共同特征恰恰是：
**只有真连上数据库跑一遍才会暴露。**

于是先写了 `src/scripts/check-sql-schema.ts`：

1. 从 `db/index.ts` 的 `CREATE TABLE` 与 `migrations/*.sql` 的
   `CREATE TABLE` / `ALTER TABLE ... ADD COLUMN` 还原「真实 schema」；
2. 扫描 `src/**` 里所有 SQL 字符串；
3. 校验三类引用：限定引用 `alias.column`、`INSERT INTO t (列清单)`、`UPDATE t SET 列=`
   （单表且无 JOIN 时额外校验裸列名）；
4. 报告「引用了不存在的列」。

这个方向的好处是把「运行时才炸」的问题变成了 **静态可判定** 的问题，
从此不需要数据库也能守住这条线。

**踩坑记录（值得单独说）**：第一版跑出 188 处误报。原因是 migration 里的列定义常长这样：

```sql
-- Importer
importer_file_id INT NOT NULL,
```

按逗号切分后，这一段的开头是 `--` 而不是列名，于是整列被跳过、schema 少了一半列。
修法是解析前先做**引号感知的注释剥离**。修完误报降到 27 处，且全部真实。

第二版又暴露了另一个坑：扫描器不认识**正则字面量**。

```ts
value.replace(/^['"]+|['"]+$/g, '')
```

这个正则里同时含 `'` 和 `"`，扫描器遇到里面的 `'` 就以为「一个字符串从这里开始」，
从此整份文件的引号配对全部错位 —— 会产生假阳性，**更危险的是可能漏掉真正的 SQL**。
修法是加一个标准的 JS 词法启发式判断 `/` 是正则还是除号。

### 3.2 补列（迁移 004）

```sql
ALTER TABLE call_graph
  ADD COLUMN IF NOT EXISTS repo_id INT REFERENCES repos(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS to_chunk_id INT REFERENCES code_chunks(id) ON DELETE SET NULL;
```

选「补列」而不是「改写所有读取方改用 `to_symbol`」，理由是：
`to_chunk_id` 是**实体级**遍历的前提。作者的意图（写入方填 `toChunk?.id`）
本来就是对的，只是目标列不存在导致结果被丢弃 —— 补列让原本的意图得以实现。

迁移同时做了三件事：

- 回填历史行（`repo_id` 由 `from_chunk_id → code_chunks → files` 推出；
  `to_chunk_id` **仅在同名定义唯一时**才回填，否则留 `NULL` ——
  宁可让读取方知道「未解析」，也不要写一个可能是错的实体）
- 补索引与**唯一索引**，让写入方的 `ON CONFLICT DO NOTHING` 真正生效
  （`import_relations` 同样如此：没有唯一索引就没有「冲突」，该子句等于装饰品，
  重复行会静默堆积）
- 删除孤儿索引 `idx_code_chunks_repo` —— 它建在 `code_chunks(repo_id)` 上，
  而这一列从未存在，新建库跑到这行会直接抛错

### 3.3 物化 `file_dependencies`（不再依赖不存在的触发器）

新增 `RelationshipBuilder.rebuildFileDependencies(repoId)`，由 `EnhancedIndexer.indexFiles`
在**所有文件处理完之后**调用一次：

```sql
INSERT INTO file_dependencies (repo_id, source_file_id, target_file_id, dependency_count, dependency_types)
SELECT d.repo_id, d.importer_file_id, d.imported_file_id, COUNT(*), jsonb_agg(DISTINCT d.import_type)
FROM (SELECT DISTINCT ... FROM import_relations WHERE ...) d
GROUP BY d.repo_id, d.importer_file_id, d.imported_file_id
ON CONFLICT (source_file_id, target_file_id) DO UPDATE ...
```

三个设计决定：

- **放在最后统一做，不逐文件做**：一条依赖边需要导入方与被导入方**双方**都已入库，
  被导入的文件可能排在批次后面。逐文件维护必然漏边。
- **应用层显式调用，不用触发器**：可测试、可追踪、不会出现「隐形依赖」。
  触发器方案已经用一次失败证明了它的坏处 —— 没人知道它不存在。
- **先去重再计数**：`COUNT(*)` 会因重复的原始行而算重。
  由于增量重索引路径没有调用 `cleanupFileRelationships`（该方法当前无调用点），
  重复行是可能存在的，所以先 `SELECT DISTINCT` 再聚合。

### 3.4 清理

- `db/index.ts` 里三个**零调用点 + SQL 必定报错**的函数直接删除：
  `searchStringConstants`（`sc.value` / `c.start_line` 均为幽灵列）、
  `findConstantUsages`（同上）、`findCallChain`（用了 `caller_chunk_id` 等 4 个不存在的列）。
  三者的职能分别被 `url-search`、`DependencyTracker.traceConstantUsage`、
  以及新的影响面分析模块取代 —— 保留两套实现只会继续漂移。
- 修掉上述 `code_chunks.content` → `code_text`、`functions.symbol_name` → `name` 等线上查询。
- `migrate` 脚本原本**只执行 `001_enhanced_schema.sql` 一个文件**（文件名硬编码），
  002/003 从未被它应用过。改为扫描目录、按序执行，并用 `schema_migrations` 台账记录。
  同时把 002 改成**幂等 + 失败安全**：原版无条件
  `DROP COLUMN embedding` 再重建，只要重跑一次就会清空全部向量。

---

## 4. 影响面分析本身的设计

### 4.1 两条链路，两种粒度

| | 文件级 | 符号级 |
|---|---|---|
| 数据源 | `file_dependencies`（由 `import_relations` 物化） | `call_graph` |
| 遍历方向 | `target_file_id → source_file_id`（谁依赖我） | `to_chunk_id → from_chunk_id`（谁调用我） |
| 回答 | 改这个文件，哪些文件会被连带影响 | 改这个函数，谁会受影响 |
| 入口 | `GET /impact/file` | `GET /impact/symbol` |

传递闭包用 `WITH RECURSIVE` 实现，三处关键细节：

```sql
WITH RECURSIVE impacted AS (
  SELECT $1::int AS file_id, 0 AS depth, ARRAY[$1::int] AS walked
  UNION ALL
  SELECT fd.source_file_id, i.depth + 1, i.walked || fd.source_file_id
  FROM impacted i
  JOIN file_dependencies fd ON fd.target_file_id = i.file_id
  WHERE i.depth < $2                          -- ① 深度上限
    AND fd.repo_id = $3
    AND NOT fd.source_file_id = ANY(i.walked) -- ② 环检测
)
SELECT DISTINCT ON (i.file_id) ...            -- ③ 同名节点只保留最短路径
ORDER BY i.file_id, i.depth
```

- **① 深度上限**：上限 10，防止环或高扇入导致递归失控
- **② 环检测**：`walked` 数组记录路径，避免 `A→B→C→A` 死循环
- **③ `DISTINCT ON` + `ORDER BY depth`**：同一个文件可能通过多条路径到达，
  只保留最短路径，避免结果膨胀且让「距离」有意义

### 4.2 三个「不装懂」的设计

这是本模块和「看起来能用」的实现拉开差距的地方。

**① 名字 ≠ 实体，遍历只走实体**

反向查询若写成 `WHERE cg.to_symbol = $1`，会把「恰好同名」的调用也算进来，
而且 `LEFT JOIN code_chunks ON symbol_name = to_symbol` 在同名多定义时会放大结果行数。
本模块的遍历**只走 `to_chunk_id`**，因此不会产生跨文件误连。

**② 但会如实报告「有多少边没能解析」**

只走实体级会带来一个副作用：解析失败的边被排除在外，影响面可能被低估。
这一点**不掩盖** —— 响应里的 `unresolvedEdges` 明确给出数量：

```
该符号共有 12 个调用点，其中 3 个未能解析到定义（to_chunk_id 为空），
已排除在影响面之外。因此真实影响面可能大于本报告。
```

「影响面为 0」与「影响面未知」在响应里是可区分的。这是整个模块最重要的一个取舍：
**宁可给出一个带警告的不完整答案，也不要给出一个看起来完整的错误答案。**

同理，`GET /impact` 是一个「能力自述」端点，直接报告
`call_graph_edges` / `file_dependency_edges` 是否为 0 —— 让「数据没构建」
这件事可被发现，而不是表现为「影响面为 0」。

**③ 歧义不猜**

符号名在仓库里有多个定义时，接口返回 **409** 并列出全部候选
（含路径与行号），要求调用方用 `chunkId` 指定。猜错比报错更糟。

---

## 5. 验证

本地无 PostgreSQL，因此分两层验证：

**离线可跑的（已执行）**

| 项 | 结果 |
|---|---|
| `check:sql`（改前） | **27 处**幽灵列引用 |
| `check:sql`（改后） | **0 处** —— 175 条 SQL 全部通过列校验 |
| 语法校验（可选，`pgsql-ast-parser`） | 166 条解析通过；9 条**明确标注未验证** |
| `verify:routes` | 50 条路由，`/impact` 三个端点确认注册，无重复/非法路径 |
| `verify:graph` | 30 项断言 ALL PASS |
| `typecheck` / `build`（api / web / vscode，当时是三个包） | 全部通过 |

> 🗓️ 上表是**本次影响面分析实施当时（2026-09）的实测快照**。代码会继续增长，
> 所以这些数字对不上是正常的 —— 例如最近一次复核（2026-09-23，AgentCore 复用
> answerQuestion 之后）：`check:sql` 是 **257 条 SQL / 87 个源文件**、
> `verify:routes` **59 条路由**、`verify:graph` **36 项断言**、`verify:memory` **51 项断言**。
> 引用时请现跑一次，或直接说「这类结论我用脚本验证过，数字我可以现场给你跑」。
> （注意 `verify:graph` 那一行在快照当时确实是 30 项，后来补了 C5 引用自检用例才变成 36。）

**未能验证的（必须说清楚）**

- **递归 CTE 的语法**：`pgsql-ast-parser` 不支持 `WITH RECURSIVE`（实测在
  `"WITH RECURSIVE "` 之后立即报错）。该脚本会把这类语句计入「未验证」，
  而不是假装通过。
- **端到端行为**：本机没有 PostgreSQL，递归遍历、环检测、深度上限的正确性
  只在 SQL 层面审阅过，**没有真实执行过**。需要连上数据库后用真实仓库复跑。
- pgvector 的 `<=>` 等运算符也不在解析器算子表内，同样标注为未验证。

---

## 6. 这件事的教训

1. **「可选的、被 catch 包住的写入」是最危险的代码形态。**
   它把「完全坏了」伪装成「功能弱」。如果要 catch，至少要计数并在结束时报告
   「N 条边写入失败」，否则失败率 100% 也会显示为成功。
2. **注释里的「自动完成」是一个需要验证的断言，不是事实。**
   「由触发器自动完成」这句话让一整张表空了几个月。凡是「某处会自动处理」的注释，
   都应该能被一条 grep 证伪或证实。
3. **本地跑不起来的项目，必须把能离线跑的检查做成脚本。**
   `check:sql` 找出 27 处缺陷，其中大多数从来没有任何人注意到 ——
   因为验证它们需要「恰好去连一次数据库」。
4. **宁可输出带警告的不完整结果，也不要输出看起来很完整的错误结果。**
   `unresolvedEdges` 和 `/impact` 自述端点就是这个原则的落地。
