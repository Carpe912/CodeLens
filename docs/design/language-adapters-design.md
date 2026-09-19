# 多语言解析层解耦评估与改造方案

> 目的：回答「现在如果要支持 Java / Python，是不是只要写一个解析流程？」
> 结论先行，证据在后。写作时间 2026-09-19（改造前 `apps/api/src` 26,745 行；
> P1/P2 落地后为 27,450 行 —— 增量来自新增的适配层契约与文件扫描器）。

---

## 0. 结论

**需要「抽接缝」，不需要重新设计架构。**

三条实测证据支撑这个判断：

1. **解析器库的引用面只有 4 个文件。**
   26,745 行的 `apps/api/src` 里，只有 `ast-analyzer.ts` / `url-resolver.ts` /
   `parsers/ts-parser.ts` / `parsers/vue-parser.ts` 这 4 个文件 import 了任何语法解析库
   （`ts-morph` / `@babel/parser` / `@vue/compiler-sfc`），合计 3,395 行 = **12.7%**。
   其余 87% 的代码（关系构建、依赖追踪、实体落库、检索全层、Web 前端）**一行都不认识 TypeScript 语法**。

2. **下游的接缝已经是语言中立的。**
   `relationship-builder.ts`（1,355 行，产 call_graph / import_relations / url_usages）
   与 `dependency-tracker.ts`（842 行）对 `ts-morph` / `SyntaxKind` 的引用数是 **0**。
   `ASTAnalysisResult` 的 7 个输出类型（`StringConstant` / `URLPattern` / `FunctionInfo` /
   `ClassInfo` / `ImportInfo` / `ParameterInfo` / `PropertyInfo`）没有一个字段提到 TS 语法。
   数据库表同样没有语言概念（`repo_id / file_id / line_start / symbol_name / ...`）。

3. **真正的坑不是「加语言难」，而是「加不了语言时不报错」。**
   见 §2.1 A1：不支持的语言会让索引器安静地跑完、状态显示 `ready`、退出码 0、`Processed: 0/0`。

所以工作量清单是：**改 3 处扩展名清单 + 1 个闭合联合类型 + 抽 1 个接口**。
不是"重写解析层"。

---

## 0.5 执行结果（2026-09-19 已上线）

P1 + P2 已合并为一次改动执行并发布。**判定：纯搬运，解析层输出逐项未变。**

### A/B 验证口径

「改造前」的基准不是 git 里的旧代码副本，而是**线上 repo 29 的现有数据** ——
它本身就是旧代码的产物，比"另一份旧代码"更权威。

```
新代码（编译产物 dist/*.js）在本地 277 文件语料上重跑
        vs
线上 repo 29 的实际表量（psql count(*)）
```

| 表 | 线上（旧代码） | 本地（新代码） | 结果 |
|---|---|---|---|
| `files` | 277 | 277 | ✅ |
| `code_chunks` | 3242 | 3242 | ✅ |
| `string_constants` | 2237 | 2237 | ✅ |
| `functions` | 540 | 540 | ✅ |
| `classes` | 335 | 335 | ✅ |
| `url_patterns` | 398 | **396** | ✅（差值已解释，见下） |
| `import_relations`（原始 import 行数） | 1887 | 1887 | ✅ |

**`url_patterns` 的 2 条差值不是回归**，已逐键 diff 核实：线上 398 = 解析层 396 + 2 条
`RelationshipBuilder.buildIndirectUsages()` 的**兜底插入**（`relationship-builder.ts` 内，
`method = NULL`）。这 2 行的 `definition_code` 分别是**调用行**
（`result = await this.orderApi.cancelOrder(orderId, …)`）与**函数定义行**（template_helper 落点），
各带 1 条 `url_usage` —— 与兜底分支的签名完全吻合。该逻辑依赖数据库、不属解析层，本次未改动。

验证工具：`apps/api/src/scripts/probe-language-refactor.ts`（只读本地语料，不连库）。

### 上线验证（三件套 + 功能面 + 评测回归）

- `pm2` pid 1795727 → 1798024，uptime 归零，`/health` 200
- 产物断言：`indexer.js` 里 `languageRegistry.forFile` ×2、0 文件报错文案 ×1、
  旧 `parsers/index.js` 残留 ×0、`dist/indexing/parsers/` 已不存在
- 功能面：`/repos`、`/search`（URL 检索命中 `advancedUserApi.js` / `apiConfig.js` 定义处）、
  `/ask`（完整 RAG 链返回真实答案）全部正常
- **评测回归：URL 用例 36/37 = 97%，与既定基线一致**

### 附带修掉的一个真 bug

`scripts/rebuild-graph.ts` 一直**没有调用** `registerRepoFiles()` —— 它在无跨文件符号表的情况下
经 `RelationshipBuilder` **写 `url_patterns` / `url_usages`**，也就是"重建一次图就污染一次 URL 索引"，
而且没有任何报错。现在它成对调用 `registerRepoFiles` / `releaseRepoFiles`。
这也是把生命周期写进 `RepoScopedParser.beginRepo/endRepo` 契约的直接动因：
**漏调应该类型可见，而不是靠人记得。**

### 本次**没有**改的行为（有意保留）

`.vue` 文件在**实体层**（functions / classes / string_constants / url_patterns）仍然为空：
第二遍分析把 SFC 原文直接交给 ts-morph，不解包 `<script>`。这是历史行为的忠实保留 ——
修它会让 test-repo 的 166 个 `.vue` 文件第一次产出实体，`url_patterns` / `functions` 数量会明显上涨，
必须重建索引。**作为独立缺口记录在案，不在本次"纯搬运"范围内。**

---

## 1. 现状测绘（**改造前**；路径为旧位置，映射见 §3.1）

### 1.1 两条解析链、两遍文件遍历

一次 `indexRepository` 会把每个文件**解析两次**，用**两套不同的解析库**：

| | 第一遍 | 第二遍 |
|---|---|---|
| 入口 | `indexer.ts:160 indexCodebase()` | `indexer.ts:287 enhancedIndexer.reindexRepository()` |
| 文件来源 | 磁盘（`collectFiles` 递归扫） | 数据库 `files` 表（回磁盘按 path 读内容） |
| 解析库 | `@babel/parser`（→ `parsers/ts-parser.ts`） | `ts-morph`（→ `ast-analyzer.ts`） |
| 分发点 | `parsers/index.ts:43 parseFile()` 按扩展名 | 无分发 —— 一律交给 ts-morph |
| 产出 | `files` + `code_chunks` + 粗粒度向量 | `functions` / `classes` / `string_constants` / `url_patterns` / `import_relations` / `call_graph` + 细粒度向量 |
| 批大小 | 10，串行 | 5，批内并行 |

两遍之间没有数据传递，第二遍**只复用文件清单，不复用 AST**。

> 这一点和 `docs/design/unified-indexer-design.md` 是同一个病灶。那份文档主张
> 「合并成一个 UnifiedIndexer」——方向对，但它当年被归到「长期规划」搁置了。
> 本次多语言改造其实是**同一次手术的两个收益**：抽出 `LanguageParser` 之后，
> 一个 adapter 一次解析同时产出 chunk 级和实体级结果，双解析自然消失。
> 两者应该合并成一次改造，而不是做两轮。

### 1.2 解析器库的真实引用边界

```
$ grep -rln "from 'ts-morph'" apps/api/src          # 改造前的路径
./indexing/ast-analyzer.ts        (61 处 SyntaxKind/SourceFile/Node 使用, 1453 行)
./indexing/url-resolver.ts        (117 处, 1394 行)
./scripts/probe-url-resolver.ts   (9 处, 仅开发期自检脚本)

$ grep -rln "@babel/parser"      →  ./indexing/parsers/ts-parser.ts (456 行)
$ grep -rln "@vue/compiler-sfc"  →  ./indexing/parsers/vue-parser.ts (92 行)
```

改造后（同样 4 个文件，只是换了位置；**没有任何新增的语法解析依赖**）：

```
./indexing/languages/typescript/entities.ts      ← 原 indexing/ast-analyzer.ts
./indexing/languages/typescript/url-resolver.ts  ← 原 indexing/url-resolver.ts
./indexing/languages/typescript/chunker.ts       ← 原 indexing/parsers/ts-parser.ts
./indexing/languages/typescript/sfc-host.ts      ← 原 indexing/parsers/vue-parser.ts
./scripts/probe-url-resolver.ts                  （import 路径已更新）
```

**这就是全部耦合面。** 一张表可以列完。

### 1.3 已经天然中立的接缝（这是好消息，别动它）

- `ASTAnalysisResult`（改造前 `ast-analyzer.ts:151`；现改名 `EntityResult`，定义在
  `languages/types.ts`）—— 7 个数组字段，全是业务概念，没有语法概念。
- `ParseResult` / `CodeChunk`（改造前 `parsers/types.ts`；现为 `ChunkResult` / `CodeChunk`
  @ `languages/types.ts`）—— 唯一的例外是 `language` 字段（见 A3/A4）。
- `relationship-builder.ts` —— 0 个语法库引用，靠 `astResult` 字段名 + DB 表工作。
- `enhanced-indexer.storeEntities()` / `generateEmbeddings()` —— 按 `astResult.stringConstants` /
  `.functions` / `.classes` / `.urlPatterns` 分支，与语言无关。
- `dependency-tracker.ts` —— 0 个语法库引用（它做的是**导入路径字符串**解析 + DB 查询，
  被 `retrieval/multi-strategy-search.ts:51` 在检索期使用）。
- `retrieval/**` 全层、`server/routes/**`、`apps/web/**` —— 都不碰解析。

---

## 2. 耦合点清单

### A 类 —— 硬耦合，加语言**必须**改

| ID | 位置 | 现状 | 为什么是坑 |
|---|---|---|---|
| **A1** | `indexer.ts:365` | `if (fullPath.match(/\.(ts\|tsx\|js\|jsx\|vue)$/))` | **这是唯一的入库闸门**。Java 仓库 → 0 文件 → `Processed: 0/0` + 状态 `ready` + 退出码 0。静默失败，和 `reindex` 那个坑同源 |
| **A2** | ~~`relationship-builder.ts:1058`~~ | `[…… '.mjs','.cjs','.json']` | ⚠️ **审计时判错、已核实更正**：这不是"重复的扩展名清单"。它是**导入路径候选探测**（`./foo` → 试 `./foo.ts`、`./foo/index.ts` …），与"扫哪些文件"是不同概念 —— `.json`/`.mjs`/`.cjs` **可以被 import 但不必入库**。`url-resolver.ts` 那份同理。**结论：此处不改**（代码里已加注，防止后人误合并） |
| **A3** | `parsers/index.ts:43-56` | 按 `endsWith` 的 if 链 | 加语言要改这个函数；应为注册表查表 |
| **A3'** | `parsers/types.ts:31,57` | `language: 'typescript' \| 'javascript' \| 'vue'` | **闭合联合类型**。加 Java 要改这个**共享契约**，会波及所有引用方 |
| **A4** | `parsers/ts-parser.ts` | 9 个 visitor 全部硬写 `language: 'typescript'` | `.js` / `.jsx` 文件在 `files.language` 里被标成 `typescript` —— 现在就在撒谎，只是没人依赖它 |
| **A5** | `indexer.ts:203` | `if (!parseResult \|\| parseResult.chunks.length === 0) { continue; }` | 解析失败与"不支持"不可区分，都只是静默 `continue` |

### B 类 —— 语义耦合，**不要**抽象

| ID | 位置 | 说明 |
|---|---|---|
| **B1** | `url-resolver.ts`（1394 行） | 它不是"一个 parser"，是**整仓符号表 + 表达式求值解释器**。字段 `topDecls / fileProps / fileObjMethods / classMethods / classes / classFields / instanceOf / factoryClass / imports / sources`，方法 `evalString / evalIdentifier / evalProperty / evalCall / evalArray / inline / evalBlock / truthiness`。它回答的是「这个表达式**求值**成什么 URL」 |
| **B2** | `ast-analyzer.ts`（1453 行） | `extractStringConstants / extractFunctions / extractClasses / extractImports`，全部基于 `SyntaxKind.X` 遍历 |

**为什么不能抽象**：Java 侧的问题形态根本不同。

| 语言 | 身份识别 | 路径来源 |
|---|---|---|
| TS/JS | 装饰器 `@Controller('/users')` + `@Get(':id')` —— **注解拼装** | 运行时字符串表达式（常量拼接、模板串、函数返回） |
| Vue | 无 | 与 TS 共用，SFC 只做宿主解包 |

TS 需要的是**解释器**（因为路径是算出来的）；Java 需要的是**声明式拼装**
（类级 prefix + 方法级 path 直接串起来，偶尔读一个 `static final` 常量）。
两者共享的只是**输出结构**，不是算法。

> 结论：`url-resolver.ts` 不该被"通用化"，它应该被**移进 `languages/typescript/`**，
> 作为 TS adapter 的内部实现。Java adapter 自带一个约 400 行的注解拼装器，
> 输出同样的 `URLPattern` / `URLProvider` / `IndirectCallSite`。

### C 类 —— 已中立，别动

`relationship-builder.ts` / `dependency-tracker.ts` / `enhanced-indexer` 的落库与向量部分 /
所有 DB 表 / `retrieval/**` / `server/routes/**` / `apps/web/**`。

---

## 3. 目标形态

### 3.1 目录（已按此落地）

```
indexing/
  languages/                          ← 语言适配层：唯一认识语法的目录
    types.ts                          ← 中立契约 (362 行)：LanguageId / CodeChunk / ChunkResult /
                                         EntityResult / LanguageParser / RepoScopedParser /
                                         LanguageRegistry + 7 个实体类型（原在 entities.ts）
    registry.ts                       ← 注册表 (111 行)：扩展名 → 适配器的唯一映射来源
    typescript/
      index.ts                        ← 适配器 (168 行)：把下面几块拼成 LanguageParser
      chunker.ts                      ← ← 原 parsers/ts-parser.ts   (Babel,    456 → 446 行)
      entities.ts                     ← ← 原 indexing/ast-analyzer.ts (ts-morph, 1453 → 1329 行)
      url-resolver.ts                 ← ← 原 indexing/url-resolver.ts (1394 → 1378 行)
      sfc-host.ts                     ← ← 原 parsers/vue-parser.ts  (92 → 91 行)
    # java/                            ← 将来：只需要新增这个目录
    # python/                          ← 将来：只需要新增这个目录
  file-scanner.ts                     ← 唯一一份扩展名清单 + SKIP_DIRS (78 行)（取代 A1）
  indexer.ts                          ← 只保留编排，不再出现任何 .ts/.vue 字样
  enhanced-indexer.ts                 ← 持有 registry，不再持有 ASTAnalyzer
  relationship-builder.ts             ← 不动（仅 import 路径与类型改名）
  dependency-tracker.ts               ← 不动
  queue.ts                            ← 不动
```

`indexing/parsers/` 已删除。行数减少来自把 7 个实体类型上提到 `languages/types.ts`，
以及去掉 `ts-parser.ts` 里 9 处硬编码的 `language: 'typescript'`。

### 3.2 接口

```ts
// indexing/languages/types.ts
export type LanguageId = string;            // 取代 A3' 的闭合联合

export interface ChunkResult {
  chunks: CodeChunk[];
  imports: Array<{ source: string; specifiers: string[] }>;
  exports: string[];
}
// 注意：ChunkResult 不再携带 language —— 由 registry 统一回填，顺带修掉 A4

export interface EntityResult {             // = 现 ASTAnalysisResult，逐字段照搬
  stringConstants: StringConstant[];
  urlPatterns: URLPattern[];
  functions: FunctionInfo[];
  classes: ClassInfo[];
  imports: ImportInfo[];
  indirectSites: IndirectCallSite[];
}

export interface LanguageParser {
  readonly id: LanguageId;
  readonly extensions: readonly string[];
  /** 可选：内容嗅探。用于 .vue 这类「宿主容器」——扩展名不足以判定内部语言 */
  sniff?(filePath: string, code: string): boolean;
  /** 粗粒度：喂 code_chunks + 粗向量 */
  parseChunks(filePath: string, code: string): ChunkResult;
  /** 细粒度：喂 functions/classes/constants/url_patterns + 细向量 */
  analyzeEntities(filePath: string, code: string): Promise<EntityResult>;
}

/**
 * 需要「整仓视野」的 parser（TS 的跨文件符号表、Java 的注解索引）
 * 都不满足于逐文件视角 —— 所以生命周期必须显式化，而不是藏在 ASTAnalyzer 的私有字段里。
 */
export interface RepoScopedParser extends LanguageParser {
  beginRepo?(files: ReadonlyArray<{ path: string; content: string }>): void;
  endRepo?(): void;
}

export interface LanguageRegistry {
  register(p: RepoScopedParser): void;
  forFile(filePath: string): RepoScopedParser | null;   // 取代 A3 的 if 链
  byId(id: LanguageId): RepoScopedParser | null;
  readonly supportedExtensions: readonly string[];      // 取代 A1/A2/第三份清单
}
```

### 3.3 三个调用点怎么变

```ts
// ① indexer.ts collectFiles —— 唯一一份清单
const SCANNABLE = new Set(registry.supportedExtensions);   // ['.ts','.tsx','.js','.jsx','.vue']

// ② 扫描后立刻检查：不支持就大声失败（修 A1/A5）
if (files.length === 0) {
  throw new Error(`No indexable files found. Supported: ${registry.supportedExtensions.join(', ')}`);
}
// → 状态 failed + 明确原因，而不是 ready + Processed 0/0

// ③ enhanced-indexer.indexFiles —— 按语言分组，各自 beginRepo
const byLang = groupBy(files, f => registry.forFile(f.path)?.id ?? '__unsupported__');
for (const [langId, group] of byLang) {
  const parser = registry.byId(langId);
  parser?.beginRepo?.(group.map(f => ({ path: f.path, content: f.content })));  // TS: 建符号表
  await this.indexGroup(parser, group);
  parser?.endRepo?.();
}
```

注意 ③：现在 `ASTAnalyzer.registerRepoFiles()` 是**无条件、全量、单一语言**的
（`enhanced-indexer.ts:157`）。分组后 TS 组仍拿全量 TS 文件（行为不变），
Java 组以后可以有自己的整仓索引 —— 互不干扰。

---

## 4. 迁移三阶段（含验收闸门）

| 阶段 | 内容 | 行为是否变化 | 要不要 reindex | 状态 |
|---|---|---|---|---|
| **P1 收口** | 建 `languages/{types,registry}.ts` + `file-scanner.ts`；TS/Vue 包成两个适配器（共享一个分析器）；扫描走 `registry.supportedExtensions`（**同一集合，不加 .mjs**）；`language` 类型放宽为 `LanguageId`；0 文件改为抛错 | 除"0 文件抛错"外中性 | **不需要** | ✅ 已上线 |
| **P2 搬家** | TS 四文件移入 `languages/typescript/`；`enhanced-indexer` 改为持有 registry；**保持文件处理顺序不变**（先全适配器 `beginRepo`，再按原顺序逐文件）；删掉 `parsers/` | **中性**（已用 A/B 探针证明，见 §0.5） | **不需要** | ✅ 已上线 |
| **P3 加语言** | 写 `languages/java/` 实现 `LanguageParser`；registry 多一行 | 新增能力 | **需要**（新仓首次索引天然全量） | ⏳ 待 Java 仓库接入时做 |

**P2 的验收方式（已执行）**：因为"改造前"的代码在同一批次里被移动，git 里没有可比基准，
所以改用**线上 repo 29 的实际数据**当基准（它就是旧代码的产物）——
用编译产物 `dist/*.js` 在本地 277 文件语料上重跑，逐表比对。
口径与结果见 §0.5。

> ⚠️ P1/P2 都不需要 reindex，但**必须**重新构建 + 重启 API；且改动落在 `indexing/**`，
> 上线判据按运维铁律 1：**线上 dist 里 grep 得到新标识符**，而不是本地探针绿。
> 现成的探针：`apps/api/src/scripts/probe-language-refactor.ts`。

---

## 5. 明确**不要**做的事

1. **不要造"通用 AST 抽象"**（把所有语言归一化成一套中间节点模型）。
   这是最诱人的错误方向：成本极高（等于自研一个更差的 tree-sitter），收益为零 ——
   因为下游要的不是 AST，是「这个符号叫什么、在第几行、调了谁、对应哪个 URL」。
   中立接缝在**输出结构**，不在输入 AST。
2. **不要试图把 `url-resolver.ts` 通用化**。见 §2-B1。它是 TS 特有的**求值器**。
3. **不要引入 tree-sitter 只为"多语言"**。当前 4 个文件已经用着三个成熟库；
   加 Java 用 java-parser / 类似库 + 注解拼装，比换一套通用解析框架便宜得多。
   （tree-sitter 的价值在"支持 20 种语言"，代价是丢掉类型/作用域信息，
   而 `url-resolver` 恰恰依赖作用域 —— 见 memory 里的"作用域硬约束"。）
4. **不要改 `relationship-builder.ts`**。它已经中立，动它是纯风险。

---

## 6. 将来落地一个新语言，各层要写什么

| 层 | 要不要动 | 说明 |
|---|---|---|
| `languages/java/index.ts` | ✅ 写 | adapter：拼装 + 声明 extensions |
| `languages/java/chunker.ts` | ✅ 写 | 产 `code_chunks`（类/方法/字段） |
| `languages/java/entities.ts` | ✅ 写 | 产 functions/classes/string_constants/imports |
| `languages/java/annotations.ts` | ✅ 写 | **注解拼装**替代 `url-resolver`，产 `URLPattern` / `URLProvider` |
| `languages/java/module-resolution.ts` | ✅ 写 | 包名/FQN 解析替代 JS 相对路径解析 |
| `registry.ts` 注册一行 | ✅ 改 1 行 | |
| `file-scanner.ts` 白名单 | ⚠️ 自动 | 来自 `registry.supportedExtensions`，**不用改** |
| `languages/types.ts` 语言类型 | ❌ 不改 | 已是 `LanguageId`（原 `parsers/types.ts`） |
| `indexer.ts` / `enhanced-indexer.ts` | ❌ 不改 | 已按 registry 分发 |
| `relationship-builder.ts` | ❌ 不改 | call_graph / url_usages 靠符号名与行号 |
| `dependency-tracker.ts` | ❌ 不改 | 靠 file_id + 路径字符串 |
| DB schema | ❌ 不改 | `files.language` 已是 `TEXT NOT NULL` |
| `retrieval/**` | ❌ 不改 | vector/exact/fuzzy 全走 DB 与向量 |
| `apps/web/**` | ⚠️ 1 行 | `RepoPage.tsx:1220` 与 `MarkdownBody.tsx:49` 硬写 `language="typescript"`，会影响 Prism 高亮观感（不崩，只是高亮不对） |

**结论：新语言 = 写 `languages/<lang>/` 一个目录 + 注册一行。** 这就是用户想要的效果。

---

## 7. 顺带解决的既有问题

| 问题 | 现在 | 改造后 |
|---|---|---|
| 每文件解析两次（Babel + ts-morph） | `indexer.ts:200` 与 `enhanced-indexer.ts:109` 各一遍 | adapter 一次解析产出 `ChunkResult` + `EntityResult`；与 `unified-indexer-design.md` 合并落地 |
| 三份扩展名清单各说各话 | `indexer.ts:365` / `relationship-builder.ts:1058` / `url-resolver.ts:1373` | `registry.supportedExtensions` 单一来源 |
| 不支持的语言静默 `ready` | `Processed: 0/0`、退出码 0 | 抛错 + 状态 `failed` + 打印支持列表 |
| `files.language` 对 `.js` 撒谎 | ts-parser 硬写 `'typescript'` | registry 按 adapter 回填真实语言 |
| `ASTAnalyzer` 的整仓符号表是个私有字段 | `registerRepoFiles` 靠调用方"记得先调" | 生命周期上移到 `RepoScopedParser.beginRepo/endRepo` 契约 |

---

## 8. 建议

- ✅ **P1 + P2 已合并为一次改动发布**（2026-09-19）：都属纯搬运，一次构建、一次验证、一次上线。
- ⏳ **P3 等真的接 Java 仓库时再做**，届时按 §6 的清单干活即可。
- 验收口径已固化：**用 `probe-language-refactor.ts` 对照线上既有仓库的表量**。
  本次的对照点写在脚本常量里（`BASELINE` / `EXPECTED_URL_PATTERNS`），换语料时同步更新。
- 下一步可独立进行的缺口（都不属于本次范围）：
  1. `.vue` 第二遍不解包 SFC ⇒ 166 个 .vue 文件实体层为空（修它会明显改变计数，需重建索引）
  2. `insertFile` 之外，`files.language` 现在由适配器回填，历史行的值不会被纠正
  3. 前端 `RepoPage.tsx` / `MarkdownBody.tsx` 硬写 `language="typescript"`，新语言高亮不对
