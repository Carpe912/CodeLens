# CodeLens 实现细节笔记（按需查阅，不自动注入）

> 从 `MEMORY.md` 拆出来的**可查证的实现细节**：需要时读本文件，判据是 file:line。
> `MEMORY.md` 只留「必须记住、重踩代价高」的陷阱与口径。

## 1. 检索链路内部

`GET /search` 四条分支（`server/routes/search.ts`，判据互斥有先后）：URL /
`strategy=multi`(threshold 0.3) / `enhanced=true`(0.5) / default。前端只用 URL 与 default，
**从不传 `strategy=multi`**。`POST /ask` 走 RAG：检索 → rerank → deepseek-chat → 结构化答案。

- **`threshold` 在 rerank 之前过滤**（`retrieval/multi-strategy-search.ts`）→ 精排只能在已被规则
  砍过的池子里重排，与该文件自己写的「宽召回」原则矛盾。`/ask` 与 `/root-cause` 已改为显式传
  `ASK_RETRIEVAL_OPTIONS`（threshold 0.3 + `[vector,exact,dependency]` + followDependencies），
  实测证据 2→10 条。
  **仍未修**：`/search?enhanced=true` 仍吃 0.5 默认；改默认值会同时影响 `/agent/query` 与图节点，
  **须先有 NL 评测集再动**。
- **evidence 白名单**：`server/evidence-mapper.ts:mapRawChunksToEvidence`，`/ask` 与 `/search`
  **共用**。修前默认分支回原始 DB 行（198KB，含 `embedding` 10/10、无 `content`/`score`）；
  修后 8KB。各分支字段名统一为 `code_text` / `content` / `score`。
- **线上 rerank 是开着的**：`.env.production` 与 pm2 注入 env 均 `RERANK_ENABLED=true`、
  `RERANK_CANDIDATES=50`、`RERANK_MODEL=qwen3.7-text-rerank`
  ⇒ `retrievalLimit = max(limit,50) = 50`（`multi-strategy-search.ts:207-208`）。
  判据是启动日志 `[Server] Retrieval (rerank: …（候选 50，超时 3000ms）)`。
- ⚠️ `expandWithDependencies()` 是**空函数** → `followDependencies: true` 目前什么都没做，
  evidence 也不会被依赖展开。
- ⚠️ `/ask`（`server/routes/ask.ts`）的 TTL 缓存键**不含检索配置**（只含 repoId/query/enhanced/
  strategy）⇒ 改了 `ASK_RETRIEVAL_OPTIONS` 后**必须重启进程**，否则老结果继续命中缓存。
  `MultiStrategySearch.searchCache` 同理（内存内，重启即清）。
- **`strategy=multi` 实测 420KB**（`includeContext`+`followDependencies` 展开，UI 不用，非泄漏）。
- 曾有一处误判：以为 `/ask` 掉分是因为 `ask.ts` 写死 `limit: 10` —— 错，线上 rerank 开着，
  候选池本已 50 条宽。真实根因见 `MEMORY.md` 的向量召回谓词问题。

### URL 检索排序约定（改 `retrieval/url-search.ts` 前必看）

- 所有策略分值必须**同尺 0-1**：`deriveURLConstruction` 曾是 0-100，会无条件压过精确命中
  → 已 ×0.01。
- 三类意图都必须查 `url_usages`；不要按段循环 `ILIKE … LIMIT n` 且无 ORDER BY。
- `deduplicateResults` 依赖**插入顺序** → 最终排序必须显式给 `file → line` 并列键。
- 段匹配要乘「查询段数 / 模式段数」精确度权重。
- `normalized_pattern` **无前导斜杠**。
- `searchURLUsages` 是**文本 ILIKE + 打分**，不是解析出的调用边。

## 2. 索引与 URL 关联层内部

- **`indexing/url-resolver.ts` = 跨文件符号表**。入口 `ASTAnalyzer.registerRepoFiles(files)`，
  **必须在任何 `analyzeFile` 之前调用**，索引完 `releaseRepoFiles()`。它单独开一个 ts-morph
  Project —— `analyzeFile` 逐文件且分析完就 `removeSourceFile`，符号表寄生同一 project 会被反复
  清空，跨文件常量（`API_PREFIX` 定义在 config、用在 service）就永远查不到。
- **provider（路径提供点）**：不只记调用点，还记「路径被构造的地方」（对象字面量叶子、函数
  return）。`config/apiConfig.js` 因此 0 → 19 条（全文件无 HTTP 调用，检索层救不了）。
- **作用域硬约束**：符号表按文件隔离，局部变量沿函数链向上找，跨文件只认 import/require。
- **归一化剥协议+域名**，但纯 base URL 常量保留（本身是有效锚点）。
- 自检脚本：`apps/api/src/scripts/probe-url-resolver.ts`。
- **跨过程归属**（把 URL 命中率从 89% 推到 100%）解决三类「字面交集为零」的位置：业务方法只调
  自己的封装 / 路径模板处理器 / 版本循环路由。
  索引侧 `URLResolver.collectIndirectSites()` 产出 `indirect_call`（落调用行）与 `template_helper`
  （落被调函数定义行）；
  ⚠️ **只在名字唯一时归属**，先用 `resolveReceiverClass()`（靠 classFields / instanceOf）定位
  接收者，**挂错文件比漏掉更有害**；⚠️ **只插 `url_usages`，不新建 `url_patterns` 行**。
  实测：`getOrderItem` 在两个文件里路径不同，正是靠接收者类型才归属正确。
  检索侧 `searchURLRelated()`：排在直接命中之后、不改原排名、带 `relatedKind` 标签、封顶 30 条。
- **省时闸门**：改索引器后先做本地 A/B 探针（同语料只开关新分支，diff 输出）。A=B ⇒ 本语料行为
  中性 ⇒ **不需要 reindex**；仅当 A≠B 才走完整 reindex + reembed + rebuild-references。
  ⚠️ `reindex.js` 不重建向量，且内置向量生成走 `OPENAI_API_KEY`（手工 shell 没有）→
  **静默留 NULL、退出码仍 0**；之后必须跑
  `node --env-file-if-exists=.env.production apps/api/dist/scripts/reembed.js`。
- **一次索引把每个文件解析两遍**：Babel（`indexer.ts:200` → `code_chunks` + 粗向量）→
  ts-morph（`enhanced-indexer.ts:109` → 实体表 + 细向量），两者不共享 AST。
  与 `docs/design/unified-indexer-design.md`（553 行，当年搁置）同源。

## 3. 影响面分析（已上线）

- 前端第四档模式 + 每条证据行紫色按钮；组件 `apps/web/src/components/ImpactPanel.tsx`
  （自己取数）。面板必显「结论强度」（warnings / unresolvedEdges / truncated）。
- 修过的链路：
  - `extractImports` 认 CommonJS `require()`。
  - `resolveImportPathCandidates` 用 `path.posix.join` 保持相对（**禁用 `path.resolve`**，
    它把相对路径锚到 cwd）。
  - `extractFunctionCalls(code, selfName)` 在声明行跳过同名与 `constructor`
    （ts-morph 对 ConstructorDeclaration `getName()` 返回 undefined → name='anonymous'）。
  - 影响面为空但入边非零时**必须警告**（防「0 影响零警告」假阴性）。
- 基线：import_relations 32、file_dependencies 10、call_graph 232（曾 333，其中 101 是声明伪自环；
  修后仅剩 1 个真自环 = `dynamicOrderApi.js buildNestedPath` 真递归，**勿当噪声删**）、
  url_patterns 153。
- ⚠️ `rebuild-graph` 不碰向量，但经 relationship-builder 写 `url_patterns` → 重建后必须重跑
  `eval_cases.py`（应 37/37）。三表重建前先 pg_dump。

## 4. 仓库页 UI 内部

- **设计取向：深色命令栏 + 浅色工作区**。内容组件（QueryCallTree / SymbolCallTree /
  EvidenceCallTree / CodeBlock，约 1600 行）全是浅色 → **不要**试图把它们改深色
  （重写量大且无法肉眼验收）。
- 原三档模式选择器写了 `className="hidden"` → 根因分析与搜索在界面上点不到；已改成一等公民。
- 顶栏读 `GET /repos/:id/stats`。`QAResponse.kind`（`ask|search|root-cause`）决定渲染方式；
  根因卡片是玫瑰色 + 显式「以下是基于检索证据推断的可能原因，不是已验证的结论」——**别删**。
- 问答主视图 = `POST /query-call-tree` 的调用树，方向由提问语义决定（callers/callees/both）。
  定根优先级：URL 末段 > 提问里 camelCase 标识符 > 前端传的 evidence。三者都定不到 →
  `level:'file'`，前端降级显示原始证据列表，**不画假树**。
- **路由与入参**（手工探针记错过）：只有 `POST /call-tree`、`/symbol-call-tree`、
  `/query-call-tree`（**没有** `/url-call-tree`）。
  `/call-tree` 要 `{repoId, symbols:[{symbol,filePath}], maxDepth?}`；
  `/query-call-tree` 要 `{repoId, query, candidates?, maxDepth?, direction?}`。
  返回 400/404 时先读 `app.post<{Body:…}>` 的 schema，别记成「服务坏了」。
  方向判定的英文正则脆弱，新增英文问法先跑 `parseCallIntent` 单点验证。
- **改 UI 必做肉眼验证**：`apps/web/scripts/preview/`（`serve.py` + `cdp_shot.mjs`）+ `.env.preview`
  + SSH 隧道连真实后端。步骤与 5 个坑（代理 502 / 后台进程被回收 / Chrome 沙箱 /
  virtual-time-budget 挂死 / React 受控输入）见 skill `codelens-deploy` §9。

## 5. 构建细节（配合 skill `codelens-deploy`）

- 前端构建三坑：① `pnpm` 不在 PATH → 直接调 `apps/web/node_modules/.bin/{tsc,vite}`；
  ② esbuild 版本错配要 `ESBUILD_BINARY_PATH` 指向**仓库根**的
  `node_modules/.pnpm/@esbuild+darwin-arm64@*/…/esbuild`（apps/web 下没有 `.pnpm`）；
  路径写错**不报「路径不存在」**，只继续报版本错配 → 极易误判为 pin 失效，务必先 `test -x`；
  ③ 增量构建会跳过检查 → 先 `mv tsconfig.tsbuildinfo /tmp/` 强制全量。
- **发布姿势**：本地 `dist` tar → scp `/tmp` → 解到 `codelens-web.new` → 校验 md5 + 关键字符串 →
  `mv codelens-web codelens-web.prev.<ts> && mv codelens-web.new codelens-web` → 同步
  `/root/CodeLens/apps/web/dist` → `pm2 restart codelens-web`。
- **技术债**：`/root/CodeLens/apps/api/dist.prev.*` 已 25+ 个回滚点，只留最近 3~5 个。

## 6. 向量召回恒 0 的排查手法（10 秒，不需 embedding 服务）

拿**已知 chunk 自己的向量**当 `$2` 去跑新旧谓词，直接对比返回行数：

```sql
-- 旧（错）：WHERE t.repo_id = $1            → 恒 0 行
-- 新（对）：JOIN files f ON f.id = t.file_id WHERE f.repo_id = $1
```

根因：`code_chunks.repo_id` 全为 NULL（写了四遍仍漏过 `multi-strategy-search.ts:buildVectorQuery()`）。

## 7. 规模明细（2026-09 重构后 `wc -l` 实测）

`apps/api/src` = **27,450 行 / 71 个 `.ts`（不含 `.d.ts`）**：

| 模块 | 文件 | 行数 | 占比 |
|---|---:|---:|---:|
| `indexing/`（含 `languages/`） | 13 | 8,215 | 29.9% |
| `retrieval/` | 9 | 6,039 | 22.0% |
| `scripts/` | 14 | 3,152 | 11.5% |
| `server/` | 13 | 2,780 | 10.1% |
| `analysis/` | 5 | 2,238 | 8.2% |
| `agent/`（含 `agent/graph/`） | 6 | 1,640 | 6.0% |
| `llm/` | 3 | 1,045 | 3.8% |
| `db/` | 1 | 1,003 | 3.7% |
| `cache/` | 2 | 701 | 2.6% |
| `utils/` | 3 | 432 | 1.6% |
| `config/` | 1 | 108 | 0.4% |
| 根 `index.ts` | 1 | 97 | 0.4% |

`apps/web/src` = **5,191 行 / 26 文件**；路由 **55 条**（`pnpm verify:routes`）；
`indexing/languages/` 子树 = 7 文件 / 3,885 行。

**单文件 Top 5**：`retrieval/url-derivation.ts` 1,571 › `languages/typescript/url-resolver.ts` 1,378
› `indexing/relationship-builder.ts` 1,355 › `retrieval/url-search.ts` 1,336
› `languages/typescript/entities.ts` 1,329。

> 已过时的历史数字（别再引用）：`indexing` 10 文件 / 5,791 行、`retrieval` 9 / 5,596、
> api/src 61 文件 / 21,988 行、web 2,180 行、路由 50 条。

## 8. 语言适配层（P1+P2）落地细节

**A/B 验收**（本地 dist 重跑 277 文件语料 vs 线上 repoId 29 实际表量，逐表一致）：

| 表 | 线上（旧代码） | 本地（新代码） |
|---|---:|---:|
| `files` | 277 | 277 |
| `code_chunks` | 3242 | 3242 |
| `string_constants` | 2237 | 2237 |
| `functions` | 540 | 540 |
| `classes` | 335 | 335 |
| `url_patterns` | 398 | 396（解析层产出） |
| `import_relations` | 1887 | 1887 |

`url_patterns` 差的 2 行 = `relationship-builder.buildIndirectUsages()` 的**兜底 INSERT**
（`method = NULL`，`definition_code` 分别是调用行 / 函数定义行），依赖数据库、不属解析层。

探针：`apps/api/src/scripts/probe-language-refactor.ts`（只读本地语料、不连库；常量
`BASELINE` / `EXPECTED_URL_PATTERNS` 换语料时同步更新）。

**上线验证三件套**：pm2 pid 变动 + uptime 归零 + `/health` 200；dist 里能 grep 到
`languageRegistry.forFile`、且 `dist/indexing/parsers/` 不存在；URL 评测 36/37 未回归。

**为什么 `.vue` 实体层为空（有意保留）**：`enhanced-indexer` 第二遍把 SFC 原文直接交给 ts-morph，
**不解包 `<script>`**。test-repo 有 166 个 `.vue`。修它 = 第一次产出实体 → 计数明显变化 → 必须重建索引。

**新增语言 checklist**（= 写 `languages/<lang>/` 一个目录 + 注册一行）：见
`docs/design/language-adapters-design.md` §6。Java 需要 chunker / entities / annotations
（**注解拼装**替代 `url-resolver`）/ module-resolution 四块。

## 9. `/search` 的 URL 识别缺陷（repo 30 暴露，2026-09-19）

`server/routes/search.ts:92`：

```ts
const isURL = q.match(/^https?:\/\//) || q.match(/\/[a-z]+\/[a-z]+/i);
//                                            ^^^^^^^^^^^^^^^^^^ 要求两个「字母」段
```

`/post/123` 第 2 段是**数字** → 不判为 URL → 落到默认向量/模糊分支。
实测（repo 30，目标 `post/:id` → `integration/server.js:16`）：

| 查询 | 命中数 | 有 URL 通道命中 | 含 `integration/server.js` |
|---|---:|---|---|
| `/post/123` | 10 | ✗ | ✗ |
| `/api/post/123` | 40 | ✓ | ✓ |
| `/order/post/123` | 40 | ✓ | ✓ |

`/post/123` 的 10 条全是 `lib/config-validator.js` 里 `let data12 = …` 之类声明噪声（score 0.39–0.43）。

- **归因 B 类**：全表 `definition_file_id` / `definition_line` 非空，正确行就在库里，**只是没进通道**。
- **为什么 repo 29 没暴露**：37 条 URL 用例全部以 `/api/...` 起头，第 2 段即配对成功。
- **修法**：第 2 段放宽为字母或数字，或复用 `retrieval/query-intent-parser.ts:106` 的
  `/^(\/[a-zA-Z0-9_\-.:{}$\/]+)/`。**改完必须重跑两套 eval**（`eval_cases.py` 的 URL 用例
  + `eval_nl_cases.py`）。属改检索行为，**需用户拍板**。

### 9.1 ✅ 已修（2026-09-19，已上线）

**做法：抽成单一实现，而不是在两个路由各改一遍正则。**
`retrieval/query-intent-parser.ts` 新增导出 `looksLikeUrlQuery(query)`：

```ts
const PATH_CHAR = '[A-Za-z0-9_\\-.:{}$]';
const URL_PATH_QUERY_RE = new RegExp(`/${PATH_CHAR}+/${PATH_CHAR}+`);
export function looksLikeUrlQuery(query: string): boolean {
  return /^https?:\/\//.test(query) || URL_PATH_QUERY_RE.test(query);
}
```

`server/routes/search.ts`（原 :92）与 `server/routes/ask.ts`（原 :124）**都**改为调它——
两处原本各有一份内联正则，正是这种重复让它们可以独立漂移。

- **证伪/回归防护**：`apps/api/src/scripts/probe-url-query-detect.ts`（纯函数、不连库）
  内置一份 `legacyLooksLikeUrlQuery()` 的**逐字拷贝**，断言新实现是旧实现的**严格超集**
  （穷举段组合 + 定向用例）⇒ **不可能引入「原本识别为 URL、现在不识别」的回归**。
  反向新增命中：`/post/123`、`/users/42`、`/orders/7`、`/v2/items/9`。
- ⚠️ 探针第一版**挂过**：把 `a/b/c` 放在 SHOULD_NOT_BE_URL 里，但新旧正则**都**匹配它
  （两段都是字母）。→ 移到 `PRE_EXISTING_BROAD` 组（断言 legacy 与 new 都为 true）才正确。
  **教训：写「新实现是旧实现的超集」这类断言时，先想清楚哪些是「本来就误判」的**，
  它们不属于回归，属于双方共有的既有行为。
- **上线后实测**（repo 30）：`/post/123` 命中 10 条噪声 → 40 条且包含目标
  `integration/server.js:16`。**repo 29 无回归**：URL 37 例仍 36/37、关联层 9/30。
- **NL 评测复测（修后）**：覆盖 **18/19**、精确 **16/19**、反例 **3/3 PASS** ——
  与修前一致（repo 29 的用例全部以 `/api/` 起头，本来就没踩到这个缺陷）。
  唯一未命中仍为 `15 路由批量注册 → complexRoutes.js:createResourceRoutes`。

**顺带确认的判读口径**：`usage_context` **不出现在 `/search` 出网结果里**（两仓实测皆 0 次），
所以「某条命中来自哪条通道」要看 `relatedKind`，或回查该 hit 的 `file_path` 是否等于
`url_patterns.definition_file_id` 对应文件。`relatedKind` 只在「关联层」命中时出现。

## 10. 线上库的数据卫生问题（2026-09-19 实测）

1. `string_constants` **684 行孤儿**：`repo_id ∈ {13,15,16,17,18,19,25,27,28}`，
   这些 id 已不在 `repos` 表（现存仅 29、30）。占该表 9,737 行的 7%。
2. **6 个外键缺失**。`pg_constraint` 里只剩 `code_chunks_parent_chunk_id_fkey`
   与 `string_constants_chunk_id_fkey`；缺失：

   ```
   string_constants_file_id_fkey        string_constants_repo_id_fkey
   call_graph_from_chunk_id_fkey        url_patterns_definition_chunk_id_fkey
   functions_chunk_id_fkey              classes_chunk_id_fkey
   ```

**机制**（`db/index.ts`，约 566–729 行）：`clearRepoData()` 先 `DROP CONSTRAINT IF EXISTS`
这些 FK，再用

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '…') THEN
    ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY … ;
  END IF;
END $$;
```

重建。**DO 块没有 `EXCEPTION` 处理**：一旦存在违反约束的存量行（正是那 684 行，
它们的 `repo_id`/`file_id` 指向已删对象）→ `ADD CONSTRAINT` 抛错 → 该次 `pool.query` 抛异常
→ `for (const constraint of constraints)` 循环中断 → **数组中它之后的约束全部不再创建**，
并且函数在**末尾那句** `UPDATE repos SET index_progress` **之前就跳出**
（当日是 `db/index.ts:738`；重构后为 846 行 —— 行号会漂，**引用请用符号名**）。

因为循环顺序是 `code_chunks_parent_chunk_id` → `string_constants_chunk_id` →
`string_constants_file_id`(✗ 在这里炸) → …，所以**恰好只留下前两个** —— 与线上观测完全吻合。

⇒ **幂等的假象**：注释写「使用 DO 块来安全地添加约束」，实际一旦脏一次就再也没机会补回。
修法二选一：① 加约束前先清理孤儿行（`DELETE FROM string_constants WHERE repo_id NOT IN (SELECT id FROM repos)`）；
② 先 `ADD CONSTRAINT … NOT VALID` 再单独 `VALIDATE CONSTRAINT`（把失败点隔离到一次显式调用）。
**会影响线上数据/行为，需用户拍板。**

### 10.1 完整因果链（比 §10 的初判多一环）

初判只找到「DO 块 → 6 个外键缺失」。补上第二环才闭环：

```
clearRepoData 的 DO 块无异常处理
   → 6 个外键永久缺失（含 string_constants_repo_id_fkey）
   → DELETE /repos/:id 只写 `DELETE FROM repos WHERE id=$1`，**纯靠 ON DELETE CASCADE**
     缺 FK 时级联**静默不生效**：不报错、不告警、照样返回 {success:true}
   → 每删一个仓库就留一批孤儿行（9 个仓 × 76 = 684 行 string_constants）
   → 孤儿行又让 ADD CONSTRAINT 继续失败 ⇒ 自锁死，永远修不回来
```

**第二环是 `server/routes/repos.ts` 的删除路由**，它信任了一个「可能不存在」的约束。
修一处不够 —— 只修 DO 块的话，下次再有人手动摘过约束，孤儿行会重新长出来。

### 10.2 ✅ 已修（2026-09-19，已上线并验证）

| 改动 | 内容 |
|---|---|
| `db/index.ts` | 抽出 **`FK_CONSTRAINTS`（8 条，唯一清单）** + `dropForeignKeyConstraints()` / `ensureForeignKeyConstraints()` / `validateForeignKeyConstraints()`。挂回改为**逐个约束独立 try/catch**（正常 → `NOT VALID` → 记入 `failed`），**绝不中断整批**；`clearRepoData` 改为调用它们，日志按 `added / notValid / failed` 分别告警 |
| `db/index.ts` | 抽出 `deleteRepoChildRows(repoId)`（叶子表 → `files` → `code_chunks`），`clearRepoData` 与删除路由**共用** |
| `server/routes/repos.ts` | 删除路由先 `deleteRepoChildRows(repoId)` 再 `DELETE FROM repos` ⇒ **不再依赖级联** |
| `scripts/repair-constraints.ts` | 新脚本（`pnpm --filter @codelens/api repair:constraints`）：解析每条 FK 的 `ON DELETE` 语义（CASCADE→DELETE 孤儿行 / SET NULL→置空），默认只挂回约束，`--fix` 才清孤儿行 |

**线上验证（2026-09-19）**：
- 默认模式跑一遍就恢复了 4 个可建的外键；剩 2 个（`string_constants.file_id/repo_id`）
  因 684 行孤儿被正确降级为 `NOT VALID` 并明确告警（**旧实现会在第 2 条就整批放弃**）。
- 备份 → `--fix` → **`pg_constraint` 8/8 且 `convalidated = t`**，孤儿复查 `0|0`，
  `string_constants` 9737 → **9053**（= 9737 − 684 ✓）。
- **repo 29 基线逐项未动**：files 277 / chunks 3242 / url_patterns 398 / string_constants 2237。
- 备份：`/root/string_constants_orphans_20260919-175614.csv`（684 行 + 表头，13MB）。
  孤儿 `repo_id ∈ {13,15,16,17,18,19,25,27,28}`，**均不在 `repos`（现存仅 29、30）** ⇒ 不可达。

⚠️ 脚本默认模式**会写库**（挂回约束，幂等无损），只是不删行。第一版 banner 写「只体检，
不改数据」是错的，已更正为「只挂回约束，不删任何行」——
**工具的输出措辞必须与它实际做的事一致**，否则下一次就没人信它的告警了。

> 附带教训：`psql -c` 传多条 SQL 时**只返回最后一条**的结果；要多结果请写成
> 单条 `UNION ALL`，或多次 `-c`。本文件里几处统计都踩过这个坑。

## 11. `check:sql` 的 8 处假阳性，以及它更危险的「空转通过」（2026-09-19 已修）

### 11.1 8 处假阳性的两个形状（都是检查器的锅，不是代码的锅）

| # | 形状 | 位置 | 为什么误报 |
|---|---|---|---|
| 7 | `col_snake AS "camelCase"` | `analysis/url-call-tree.ts:143`(4) / `:168`(3) | bareRe 是 `\b([A-Za-z_]\w*)\b`，双引号不是单词字符 ⇒ 把别名 `symbolName` 当成了裸标识符；而 `AS` 检测写的是 `/\bAS\s+$/`，**匹配不到 `AS "`**（多了一个引号） |
| 1 | `trim(both '/' from pattern)` | `indexing/relationship-builder.ts:654` | `both` 是 PostgreSQL **TRIM 的保留修饰词**，不在关键字表里 |

**必须先证明它们真的是假阳性再动手**（读原文 SQL、确认 snake_case 列确实存在）——
「让检查器闭嘴」和「修 bug」在 diff 上长得一模一样，但后果相反。

修法：① `SQL_KEYWORDS` 补 `both / leading / trailing`；
② AS 别名检测放宽为 `/\bAS\s+"?$/`（带引号的别名**永远不是列引用**）。
修后：`扫描 73 个源文件，校验 217 条 SQL 字符串` → **PASS（0 findings）**。
反向确认没有「过度闭麦」：`grep` 过 DDL，没有任何列叫 `both/leading/trailing`。

### 11.2 更危险的：「0 个源文件」也打印 PASS

部署态（服务器只有 `dist/`，没有 `src/`）里 `walk(SRC_ROOT)` 返回空 ⇒
**0 个文件、0 条 SQL、0 个 finding ⇒ 打印 `PASS` 并退出 0**。
与 `reindex` 的 `Processed: 0/0 + ready + 退出 0`、`reembed` 静默留 NULL
是**同一个形状**：闸门看起来是绿的，其实根本没跑。

修法：`files.length === 0` 时打印 **`SKIP — 本次检查不构成通过`** 并
**`process.exit(3)`**，用独立退出码把「没执行」和「通过」彻底分开。
线上实测：`SERVER check:sql EXIT=3`（修前是 `EXIT=0` + 假 PASS）。

⇒ **`check:sql` 只在仓库内（开发机 / CI）有意义，别在服务器上拿它当绿灯。**
真正能在两种环境跑的闸门是 `verify:routes`（55 条）与 `verify:graph`（30 条断言）。

## 12. 仓库与凭证暴露（2026-09-19 体检发现）

### 12.1 事实链（全部可复现）

```bash
git ls-files | grep -i env                      # → .env.production 被跟踪
git cat-file -e HEAD:.env.production            # → 成功（在 HEAD 里）
git log --all --oneline -- .env.production      # → 88315c6 / b9b2f1a / 4d38763 / 49e33d9
git cat-file -e origin/main:.env.production     # → 成功（已推送到公开仓库）
curl -s -o /dev/null -w "%{http_code}" \
  https://api.github.com/repos/Carpe912/CodeLens  # → 200 = **仓库公开**
```

远端那份里的敏感项（只看长度与前缀）：`ANTHROPIC_AUTH_TOKEN`(67, `sk-`)、
`EMBED_API_KEY`(51, `sk-`)、`DB_PASSWORD`(`666666`)。
工作区另有 `DEEPSEEK_API_KEY` / `RERANK_API_KEY` / `DASHSCOPE_API_KEY`(各 35, `sk-`)，
在 **4 个未推送提交**里（其中 `88315c6` 就动过该文件）⇒ 下次 push 一起泄露。

⚠️ **`.gitignore` 第 13 行已经写了 `.env.production`** —— 但 gitignore 对**已跟踪**文件无效。
「配置里看起来防住了」是本项目反复出现的错觉（§11.2 空转 PASS、§10 静默级联同类）。

### 12.2 爆炸半径（别自己吓自己，要实测）

| 探测 | 结果 |
|---|---|
| 开发机 `nc -z 47.116.6.132 {5432,8787,22,443}` | **仅 22 / 443 可达** |
| 服务器 `ss -lntp` | Postgres `127.0.0.1:5432`、Redis `127.0.0.1:6379` **只绑本地** |
| API 8787 | 绑 `0.0.0.0` 但被云安全组挡住（外网不可达） |

⇒ 真实风险 = **凭证被白嫖（账单/配额）**，**不是**数据库被拖走。

### 12.3 处置顺序（顺序不能反）

1. **先去各厂商轮换**这 5 把 key + DB 密码。**历史重写无法收回已被抓取的明文**，
   轮换才是根治；不轮换就清历史 = 自我安慰。
2. `git rm --cached .env.production`（文件留在磁盘，服务不受影响）。
3. 清历史：`git filter-repo --path .env.production --invert-paths`（或 BFG）→
   `git push --force-with-lease origin main`。
4. 检查 GitHub 的 secret scanning 告警（公开仓库通常已经报过）。

⚠️ 改 `DB_PASSWORD` 有**连带面**：`ecosystem.config.js` 的 `env_production`、根 `.env.production`、
以及记忆/文档里的示例命令都要同步改，否则会出现「服务连不上库」。

> **本节状态：已由用户决策关闭处置（2026-09-19）。** 用户明确说明这是**测试账号、后续会弃用**
> ⇒ 不做轮换、不清历史。**本节的四步清单仅作存档，不要再主动排查或向用户提起此事。**

---

## 13. 依赖展开 `expandWithDependencies()`（2026-09-19 实现并上线）

### 13.1 为什么要做：`followDependencies: true` 曾是一个空承诺

`followDependencies: true` 是 `/ask`、`/root-cause`、agent 图**默认打开**的开关
（`server/routes/ask.ts:ASK_RETRIEVAL_OPTIONS`），但 `MultiStrategySearch.expandWithDependencies()`
**是一个空函数** —— 开关开了，什么都没发生。而 `docs/resume-codelens.md` 早已把「依赖展开」写成
多路召回的一路。**代码与文档差一整条召回通道**，且没有任何报错。

### 13.2 语义与三条不变式

命中文件 F 里 `import { X } from './T'` ⇒ 把 **T 里定义 X 的那个块**补进结果。

1. **不改原排名**：按「锚点」（每个命中文件里分数最高的那条）分组，把补入项插在**锚点正后方**，
   同一锚点的补入项构成**连续块**；其余命中的相对顺序完全不动。
2. **上限挂钩证据预算**：`MAX_ADDITIONS = clamp(ceil(limit * 0.4), 2, 6)` —— `limit=10` → 4 条。
   因为下游最后是 `slice(0, limit)`，补入项会**挤掉**真实命中 ⇒ 不设上限就会拿精确率换召回率。
3. **补不上必须出声**：0 条时区分「没找到内部导入边」（warn + 提示跑 `rebuild-graph`）与
   「全与已有证据重复」（log）。**绝不允许静默 return。**

补入项带 `metadata.relation='dependency'` / `definitionOf` / `dependencyOfFile` / `sourceResultId`，
`score = 锚点分 × 0.6`（折价，不压过直接命中），并同样走 `expandCodeContext`（±5 行）。

### 13.3 实现要点（`retrieval/multi-strategy-search.ts`）

- 定位靠**符号级 JOIN**，这是它区别于「再加一次模糊检索」的地方：
  `import_relations ir JOIN files tf ON tf.id=ir.imported_file_id
   JOIN code_chunks c ON c.file_id=tf.id AND c.symbol_name=ir.imported_symbol`
  只认 `imported_file_id IS NOT NULL AND is_external=false`（内部边）。
- 数据前提：repo 29 的 1336 条内部 import 边中，**936 条（70%）**能 JOIN 到真实 `code_chunks` 行
  —— 剩下的对不上是因为导出符号本身没被切块（如 re-export）。
- 调用点是 `searchWithSuggestions()` 步骤 11，传的是用户侧 `limit`（不是 rerank 的宽召回
  `retrievalLimit`），保证上限跟证据预算而非候选池挂钩。

### 13.4 验证探针 `apps/api/probe-dependency-expand.mts`（**故意放在 `src/` 之外**）

`tsconfig.json` 的 `include` 是 `["src"]` ⇒ 不进产物；而它用了**顶层 `await`**，在 `target: ES2020`
下编译不过，**放进 `src/` 会直接把构建搞坏**。

跑法（隧道与探针必须同一条命令，且必须带 env 文件）：

```bash
ssh -N -L 5432:127.0.0.1:5432 root@47.116.6.132 &
./node_modules/.bin/tsx --env-file-if-exists=.env probe-dependency-expand.mts
```

**探针本身踩过的 4 个坑（每个都让验证变成「假通过」或「假失败」）：**

1. **平凡通过**：v1 拿中文整句 + `strategies:['exact']` 跑 A/B，**两侧都是 0 条** ⇒ 所有断言真空成立。
   这正是本项目最爱的「静默空转」，只不过这次发生在验证工具上。
2. **`exact` 根本不会执行**：`selectStrategies()` 只在 `intent.confidence > 0.8` 时把 `exact` 放进
   策略表 ⇒ 普通查询传 `strategies:['exact']` 得到**空策略表**，必然 0 条。
   `fuzzy` 也不行：它是 pg_trgm 给**整块代码**打相似度，短查询（`Repository`）低于默认阈值。
3. **断言写错方向**：v1 断言「DEP 项紧跟在锚点后」用 `results[i-1].id === sourceResultId`，
   这只对**第 1 条**成立（第 2~4 条前面是上一条 DEP）⇒ 断言把自己判失败。正确语义是**连续块**。
4. **`.env` 的 DB 密码是过期的**：带 `--env-file-if-exists=.env` 会把过期密码灌进 `DB_PASSWORD`
   ⇒ `28P01`。探针改用 `PROBE_DB_*` 前缀，**完全不读** `.env` 的 `DB_*`。

**接线断言与召回断言必须分开**：2a 用 **spy**（替换实例上的 `expandWithDependencies` 计数）证明
`followDependencies` 真的把调用送到方法里，与召回无关（用 `fuzzy` 即可，不需要 embedding）；
2b 才做真实 A/B。否则 embedding 一旦失败，「开关没接上」和「没召回」就分不开。

⚠️ **本机 `.env` 的 `EMBED_API_KEY` 已失效（401）** ⇒ 2b 在本机显式 **SKIP**（打印横幅 + 计入
`skips`，总结里单独报出），真正的端到端召回证据由**部署后重跑线上 eval** 给出。

### 13.5 上线与回归（2026-09-19）

- 原子发布 + 守卫断言（dist 保留注释 ⇒ 断言带结构）：`dependencyOfFile ≥ 1`、
  `c.symbol_name = ir.imported_symbol ≥ 1`、**旧 2 参签名 `expandWithDependencies(repoId, results)` = 0**。
- 校准了一个易误读的点：`ask.ts:105` 的解构默认值是 `strategy = 'enhanced'`、`enhanced = true`
  ⇒ **默认 `/ask` 走 `enhanced` 分支**（`{ limit: 10, ...ASK_RETRIEVAL_OPTIONS }`），
  所以 `followDependencies: true` 确实生效，本改动落在评测与 UI 真正走的路径上。
  （`else` 那条「原始 embedding」分支只在显式传 `enhanced: false` 时才进。）
  **教训：分支默认值要和分支条件一起读，只看 if 顺序会得出相反的结论。**

**线上评测：三项与基线逐项一致（无回归，也没有可见增益）**

| 路径 | 基线 | 改动后 |
|---|---|---|
| URL（`eval_cases.py`，37 条） | 36/37 | **36/37** |
| `/search` 默认分支（19 目标） | 覆盖 18/19、精确 16/19 | **18/19、16/19** |
| `/ask`（19 目标） | 覆盖 19/19、精确 16/19 | **19/19、16/19** |
| 反例承认证据不足 | 3/3 PASS | **3/3 PASS** |

未命中集合**完全不变**：`apiFactory.js` 的 `resource` / `resourceWithId` / `nestedResource`
「覆盖为真、精确为假」（类级大块吸收，属切块粒度代价），外加 `/search` 的
`complexRoutes.js:createResourceRoutes`。证据条数全部 10 条。

**为什么看不到增益（不要写成「已验证有效」）**：19 个期望目标里没有一个是「命中文件所导入
符号的定义」，依赖展开即使补入了真实定义块（探针实测 4 条），也落不到这些期望位置上。
要量化收益，需要**另建一组问「被导入的定义」的用例**（如 `ApiPage` / `IndexStatus`）。
⇒ 准确表述是三个词：**已实现 + 探针证明在工作 + 线上证明不回归**。

---

## 14. `.vue` 的「实体层为空」是**错的**（2026-09-19 实测推翻）

### 14.1 那条错误结论从哪来

`indexing/languages/typescript/index.ts` 的 Vue 适配器 `analyzeEntities()` 上原有注释写着：

> 「后果是：`.vue` 文件在实体层（functions / classes / string_constants / url_patterns）
> 贡献**为空**，只有第一遍的 `code_chunks` 里有它们。」以及「修它 → url_patterns / functions
> 数量会**明显上涨** → 必须重建索引」。

我把它抄进了项目笔记，然后它就变成了「事实」。**实测两条都不成立。**
（这条注释本身写于「纯搬运」重构时，属**未经验证的机制推断**——又一次「把猜测当代码事实」。）

### 14.2 机制：为什么不是「空」，而是「真垃圾混杂」

`ASTAnalyzer.analyzeFile()` 是 `project.createSourceFile(path, content, {overwrite:true})`，
把 **.vue 原文**整段交给 ts-morph。TS 解析器是**容错**的：

- `<script>` / `<script setup>` 里的语句**照样被解析出来** ⇒ functions / string_constants 是
  **真实的**，而且行号是**绝对行号**（整份文件都在，不需要像第一遍那样回填偏移）；
- `<template>` 里的 HTML 被当成表达式/JSX 解析 ⇒ 吐出一堆 `anonymous` 类；
- URL 抽取依赖真实表达式求值，模板垃圾里当然什么也求不出来。

所以准确说法是：**「真实数据 + 误解析垃圾混在一起」，而不是「空」。**

### 14.3 实测口径（repo 29，166 个 .vue，可直接复现）

```sql
-- 每层产出（示例：把 language 换成 'typescript' 即可对照）
WITH f AS (SELECT id, language FROM files WHERE repo_id=29)
SELECT f.language, count(DISTINCT f.id) AS files,
  (SELECT count(*) FROM code_chunks c      WHERE c.file_id IN (SELECT id FROM f f2 WHERE f2.language=f.language)),
  (SELECT count(*) FROM functions x        WHERE x.file_id IN (SELECT id FROM f f3 WHERE f3.language=f.language)),
  (SELECT count(*) FROM classes x          WHERE x.file_id IN (SELECT id FROM f f4 WHERE f4.language=f.language)),
  (SELECT count(*) FROM string_constants x WHERE x.file_id IN (SELECT id FROM f f5 WHERE f5.language=f.language)),
  (SELECT count(*) FROM url_patterns x     WHERE x.definition_file_id IN (SELECT id FROM f f6 WHERE f6.language=f.language)),
  (SELECT count(*) FROM import_relations x WHERE x.importer_file_id  IN (SELECT id FROM f f7 WHERE f7.language=f.language))
FROM f GROUP BY f.language ORDER BY 2 DESC;

-- 垃圾判据：classes 里叫 anonymous 的占比
SELECT count(*) FILTER (WHERE c.name='anonymous') || ' / ' || count(*) FROM classes c
  JOIN files f ON f.id=c.file_id WHERE f.repo_id=29 AND f.language='vue';

-- 归因判据（决定是 A 类还是 B 类）
SELECT count(*) FROM files WHERE repo_id=29 AND language='vue'
  AND (content LIKE '%''/api/%' OR content LIKE '%`/api/%' OR content LIKE '%"/api/%');
```

| 层 | `.vue` 产出 | TS 对照 | 判定 |
|---|---|---|---|
| `code_chunks`（第一遍，解包 SFC） | **2159**（全仓 3242） | 1083 | ✅ 正常，是主力 |
| `functions` | 96（分布在 **34/166** 个文件） | 444 | ✅ 行号真实（如 `@96`，落在 `<script>` 内） |
| `string_constants` | 1514 | 723 | ✅ 大量真实（`rule` / `规则` / `metric` … script 里的键值） |
| `import_relations` | 1487 | 400 | ✅ |
| `call_graph` 出边 | 290 | 674 | ✅ 有覆盖 |
| **`classes`** | **198，其中 194 是 `anonymous`** | 0/137 anonymous | ❌ **模板污染** |
| **`url_patterns`** | **1**（且是垃圾 `s/item`） | 397 | ⚠️ 见 14.4 |

### 14.4 `url_patterns ≈ 0` 是 **B 类（语料）**，不是 A 类（抽取器）

**165/166 个 .vue 文件完全没有 url_patterns。** 但这不是「没解包 SFC」造成的：

- 含 `/api/` **字面量**的 .vue 文件 = **0 个**（仅有的 `/api/` 出现全是 import 说明符
  `from '../../api/alert'`，是**模块路径不是 URL 路径**）；
- 直接 `api.` / `http.` 调用的 .vue = **0 个**。

repo 29 的视图层一律 `import { fetchAlertList } from '../../api/alert'` 调封装，
**URL 字面量全部在 `api/*.js`** —— 那才是 397/398 条 url_patterns 的来源。

⇒ **即使把第二遍改成解包 SFC 再分析，url_patterns 也涨不上来。**
唯一收益是清掉那 194 行 `anonymous` 垃圾类（数据卫生），代价是必须重建索引（约 6 分钟 + reembed），
而 repo 29 是评测基线语料。**收益/代价不成比例，先别动。**

### 14.5 教训（可复用）

1. **代码注释里的「后果是…」也可能是未经验证的推断。** 看到这类断言，先按语料量一次再引用；
   本项目的「静默空转」反模式（`处理数 == 0`）在这里表现为「**结论数 == 推测数**」。
2. **「某一层为空」这种整片结论，必须逐层量。** 七个层里六个有数据，混在一句「实体层为空」里
   就把真问题（classes 污染、functions 只覆盖 34/166 文件）一起盖掉了。
3. **归因先拆 A/B/C**：这次的 `url_patterns≈0` 光看机制像 A 类（抽取器不行），
   一量语料就翻成 B 类 —— 与 URL 用例评测里那次「A:B = 14:6 → 只修检索最多到 62%」是同一手法。
4. 顺带记一笔**真实的覆盖缺口**（别和上面那句错误结论混为一谈）：**`functions` 只覆盖 34/166 个
   .vue 文件** —— 其余 132 个没有函数（其中 **13 个**是 functions/classes/string_constants
   **三层全空**）。成因待定：多半是这些视图用 `<script setup>` 只声明组合式常量、没有函数声明
   （属**容量特性**），但也可能是抽取漏了。**要下结论得再量一次，别当成 bug 直接修。**
   → **已在 §15 量完：是抽取 bug，不是容量特性。** 132 个里 **94 个**是下面的静默崩溃造成的。

---

## 15. `.vue` 第二遍静默丢函数：**`.vue` 扩展名**触发 ts-morph 崩溃并被吞掉（2026-09-19 探针定位）

> §14 只把 `functions` 覆盖不足记成「待定」。本节把它结掉：**94/166 个 `.vue` 文件的所有函数
> 都被一个被吞掉的异常一次性丢光**，与 Vue 3 写法无关。
> 探针：`apps/api/probe-vue-entities.mts`（7 个部分，`tsx probe-vue-entities.mts /tmp/vue-samples`）。

### 15.1 现象与量化（全量离线预演，166 个真实 `.vue` 原文）

```
functions 总数            96  →  590        （+494）
  有函数产出的文件数        34  →  128        （94 个文件 0 → N）
classes 总数             198  →   66
  └ anonymous 垃圾        194  →    0
触发崩溃的文件            94 / 166           （= 「0 函数」文件数，集合逐字符相同）
```

抽样：`AlertFormView.vue` 现在 **0** 个函数 → 应能抽出 **7** 个
（`applySettings` / `setValue` / `loadSettings` / `validate` / `onSubmit` / `onReset` / `doReset`）。

### 15.2 机制：一个坏函数毁掉整个文件

```
extractFunctions()                              entities.ts:873
  └ sourceFile.getFunctions().forEach(...)      :878
      └ extractFunctionInfo(fn, 'function')     :879
          └ func.getReturnType?.()?.getText()   :953   ← 抛 TypeError
              TypeError: Cannot read properties of undefined (reading 'escapedName')
              （栈：getSignatureFromDeclaration → TypeChecker.getSignatureFromNode → getSignature）

analyzeFile() 的大 try/catch                    entities.ts:187-188  ← console.error 后**照常返回半成品**
  ⇒ result.functions 的赋值（:183）在抛错前**未执行** ⇒ 该文件函数**全丢**
```

⚠️ 注意 `getReturnType?.()` 的 `?.` **只防「方法不存在」，不防「方法抛异常」** —— 它给了这段代码
「已经做过防御」的错觉。**一个节点解析失败 = 整个文件的数据消失**，这是比崩溃本身更贵的形状。

### 15.3 2×2 隔离：内容无关，**扩展名才是触发器**

同一个文件、同一套适配器，只换「内容是否解包」×「传给 ts-morph 的文件名」：

| 组合 | functions | classes（其中 anonymous） | 判定 |
|---|---|---|---|
| 原文 + `.vue` 名（**当前线上**） | **0** | 0（0） | ← 异常被吞 |
| 原文 + `.ts` 名 | 7 | 9（**7**） | 内容能解析，但带模板垃圾 |
| 解包 + `.vue` 名 | **0** | 0（0） | ← 同一个崩溃，与内容无关 |
| **解包 + `.ts` 名（拟议改法）** | **7** | 2（**0**） | ✅ 既拿到函数、又没有垃圾 |

⇒ **不是「Vue 3 `<script setup>` / 箭头函数不支持」**。写法支持矩阵（第 2 部分）逐条实测通过：
`function` / `export function` / `async function` / **箭头 `const x = () => {}`（`functionType='arrow'`）** /
`class + 方法` / `declare function` 全部正常。**唯一不动的是「文件名带 `.vue`」。**

### 15.4 修法设计：**不能**换成假文件名

`analyzeFile(filePath, content)` 的 `filePath` 不只是个名字，**至少三处按它查表/求值**：

- `indirectSites: this.indirectByFile.get(filePath)`（:160）—— **按真实仓库相对路径查表**；
- `extractURLPatterns(constants, sf, filePath)`（:173）→ `resolveURLPattern(url, filePath, line)`（:469）
  —— 相对 import 的符号解析以该文件为基准；
- `buildProviderPatterns(filePath)`（:180）—— 同样按路径分桶（`providersByFile`）。

⇒ 「传 `X.ts` 假名」虽能绕开崩溃，却会**静默丢掉 `.vue` 的间接调用点与路径提供点** ——
拿一个静默失效换另一个静默失效。**正确形状 = 真实 `filePath` 继续用于查表/求值，
只把「交给 ts-morph 建 SourceFile 的那个名字」中性化**（例如给 `analyzeFile` 加一个可选
`tsFileName`，或干脆在 `extractFunctionInfo` 里把 `getReturnType()` 单独 try/catch 兜住）。

**被证伪的捷径**：以为「保留 `.vue` 名 + 显式 `scriptKind: TS`」能修 —— 实测**不行**：

```
解包 .vue 名，不指定 scriptKind   函数声明=7   ✗ 仍有 2/7 个崩溃
解包 .vue 名，scriptKind=TS      函数声明=7   ✗ 仍有 2/7 个崩溃
解包 .vue 名，scriptKind=TSX     函数声明=7   ✗ 仍有 2/7 个崩溃
解包 .ts  名，不指定（对照）        函数声明=7   ✓ 全部 getReturnType() 正常
```

⇒ 触发点不在「怎么解析」，而在**语言服务看到的文件名**（ts-morph 按扩展名决定文件如何进入
语言服务，`.vue` 不被识别）。**先测再改，省了一次白改。**

### 15.5 更正：`arrow=0` **不是**「崩在记录箭头之前」

我曾据「`.vue` 的 functions 100% 是 `function`、`arrow=0`，而 113 个 `.vue` 含 `=>`」推断
「文件在记录到箭头前就崩了」。**这个推断是错的**，且被自己的探针证伪（改后 `arrow` 仍是 0）：

- 箭头提取路径（`entities.ts:898-919`，`VariableDeclaration` + `Node.isArrowFunction`）
  **根本不调用 `getReturnType`** ⇒ 不受这个崩溃影响；
- AST 口径实测（166 文件、**1729 个变量声明**）：**初始化器是箭头函数的 = 0 个**，
  而 `CallExpression` = **1181** 个 ⇒ 语料里 `const x = …` 的右边绝大多数是
  `computed(() => …)` / `watch(() => …)` / `ref(…)`，**箭头只是实参、不是初始化器本身**
  ⇒ 提取器**正确地**没把它们当函数。`arrow=0` 是**语料特性**，不是 bug。

### 15.6 探针自身的两个坑（都踩过）

1. **「拟议改法」那侧误传了 `.vue` 名**（`analyzeEntities(name, …)`，`name` 形如 `X.vue`）
   ⇒ 两侧都被同一个崩溃命中、都显示 0 ⇒ 收益被完全盖住。**这正是「两侧都 0 即平凡通过」
   的变体**：不是断言平凡通过，而是**实验组和对照组一起失效**时看起来「对照很干净」。
   修法：实验组必须只改「待验证的那一个变量」。
2. **`import { ScriptKind } from 'ts-morph'` 在 tsx/esbuild 下被当类型擦除** ⇒ 运行时
   `ReferenceError: ScriptKind is not defined`（而 `'ScriptKind' in tm === true`，极易误判成
   「导出不存在」）。**改用 `ts.ScriptKind.TS`**（`ts` 是 ts-morph 的具名值导出，能正确链接）。
3. 行号口径已验证可回填：解包后 `close@14`（相对 script 块）+ `offset`(= 起始行 − 1 = 21)
   = `35`，与现在的绝对行号**一致** ⇒ 解包改法**不会**破坏「跳转到文件:行号」。

### 15.7 结论与代价

- **收益**：`functions` 96 → 590、覆盖 34 → 128 个文件；顺带清掉 194 行 `anonymous` 垃圾类
  （198 → 66）。**这是真实的索引质量缺口，不是「数据卫生」小项** —— §14.4 把它写成
  「唯一收益是清垃圾、收益/代价不成比例」是**基于不完整量化得出的**，本节推翻。
- **代价**：改的是 `indexing/**` ⇒ **必须重建索引**（约 6 分钟 + `reembed`），
  且 **repo 29 是评测基线语料** ⇒ 重建后基线数字要**重新量一遍**再引用。
- **动作**：修法形状已定（§15.4），但**尚未实施**；实施前先确认是否接受基线重算。
  → **已实施、已上线、已重建索引，见 §16。**

---

## 16. §15 的修复：已实施并上线（2026-09-19）

### 16.1 改了四处（`indexing/**`，故必须重建索引）

| # | 位置 | 改动 |
|---|---|---|
| 1 | `typescript/entities.ts` `extractFunctionInfo()` | `getReturnType()` 单独 `try/catch`，失败降级为 `undefined`。**一个坏节点不再毁掉整文件**（这是通用防御，所有语言受益） |
| 2 | `typescript/entities.ts` `analyzeFile()` | 新增 `options: { tsFileName?, skipPathDerived? }`；新增公开访问器 `pathDerivedFor(filePath)`（返回 `indirectSites` + provider `urlPatterns`）。**把「查表用的 filePath」与「交给 ts-morph 的文件名」解耦** |
| 3 | `typescript/sfc-host.ts` | 抽出可复用的 `parseVueScriptBlocks()`（返回 `{content, offset, lang}[]`），`parseVueFile` 改为复用它（行为不变） |
| 4 | `typescript/index.ts` Vue 适配器 | `analyzeEntities` 改为：解包 SFC → 每块用**中性 ts 名** `${filePath}__sfc${i}.ts` 分析 → `shiftEntityLines()` 回填行号 → 合并；第 0 块取路径派生产出、其余块 `skipPathDerived`；`dedupeImports()` 去重 |

**为什么必须 1+2+3+4 一起**：只做 1 ⇒ 函数回来但 194 条 `anonymous` 垃圾类还在；只做 4 的「解包」
而不给中性名 ⇒ 仍旧崩溃（§15.4 已证）。

### 16.2 本地验证：`apps/api/probe-vue-fix-verify.mts`（16/16 通过）

⚠️ **这个探针必须存在，不能只信 `probe-vue-entities.mts` 的「拟议改法」列** —— 那一列是**我手写的
模拟**（自己在外面解包、自己拼行号），而真实现里还有行号回填、多块合并、import 去重等逻辑。
不跑真实适配器，验证的是「我的假设」而不是「上线的那份代码」。

覆盖：真实 `createTypeScriptParser('vue').analyzeEntities()` × 166 文件；数字逐项对上；
**590 个函数的 `lineStart` 行都真的含有该函数名**（行号完整性）；无重复 import；
TS 路径回归（行号未被平移、四类 functionType 齐全）。

### 16.3 上线与重建索引（实测数字）

部署：原子替换 + 断言 + `pm2 restart codelens-api --update-env`；**pid `1801875 → 1804268`、
uptime 归零、`/health` 200**（三件套齐）。

重建：`reindex.js 29 /tmp/codelens-repos/29` → `Processed: 277/277`、`Errors: 0`、**86s**。

| 层 | 改动前 | 改动后 | 与离线预演 |
|---|---|---|---|
| `.vue` functions | 96 | **590** | ✅ 逐字一致 |
| `.vue` 有函数产出的文件 | 34 | **128** | ✅ |
| `.vue` classes | 198（194 anonymous） | **66（anonymous 0）** | ✅ |
| `.vue` string_constants | 1514 | **1514** | ✅ 无变化 |
| 全体 functions | 540 | **1034**（=540+494） | ✅ 精确 |
| 全体 classes | 335 | **203**（=137+66） | ✅ 精确 |
| 全体 string_constants | 2237 | **2237** | ✅ 无变化 |
| url_patterns | 398 | **398** | ✅ 无变化 |
| call_graph 边 | 964 | 1943 | — |
| file_dependencies | 1047 | 1047 | ✅ |

回归：别名解析 `landed == total`（**1066/1066**）；`.ts` 侧 444 functions / 137 classes 完全未动。

**向量**：`code_chunks` 0 NULL（reindex 不动它）；`functions` / `classes` / `string_constants` /
`url_patterns` **全 NULL**（reindex 内置向量走 `OPENAI_API_KEY`，手工 shell 没有 → 静默失败，见 skill）
⇒ 必须补：
```bash
node --env-file-if-exists=.env.production apps/api/dist/scripts/reembed.js \
  --table=functions --table=classes --table=string_constants --table=url_patterns
```
📌 **`--table=` 可以重复传**（源码 `parseArgs` 里是 `push` 进数组）。**别用全表重刷**：
`code_chunks` 本来 0 NULL，全表跑会白刷 10240 条已有向量（跨 repo）。实测这四表共约 12k 行、
并发 4、耗时 **10 分钟以上**（比 skill 里「约 30s」的老语料估算大得多）。

### 16.4 这一轮新踩的坑（都值钱）

1. **部署断言误命中「另一处合法代码」**：我写的负向断言
   `grep -cF "scope.analyzerFor().analyzeFile(filePath, code)" == 0` 失败了 ——
   因为**TS 适配器的 `analyzeEntities` 保留了同一条调用**（它确实不需要这个 option）。
   ⇒ **守卫正确回滚**（服务全程没中断，pid/uptime 未变）。教训：**断言要么正向（只查新标识符），
   要么精确到唯一**；负向断言必须先确认该字符串**在合法代码里也不存在**。
   这正是 skill §10.1 那类陷阱的变体 —— 那次是命中自己的注释，这次是命中另一处正当调用。
2. **`probe-vue-entities.mts` 的「拟议」列是模拟**，不能替代真实适配器验证（见 16.2）。
3. **`--table=` 可重复**（省 10k 条无谓 embedding 调用）。

### 16.5 重建后的检索回归：**四条路径全部与基线逐字相同**

重建索引会换掉整个数据库的增强层，所以必须重跑全部评测（skill 口径，服务器侧）：

| 路径 | 改动前基线 | 重建后实测 | 判定 |
|---|---|---|---|
| URL | 36/37 = 97% | **36/37** | ✅ 无回归 |
| `GET /search` | 覆盖 18/19、精确 16/19 | **覆盖 18/19、精确 16/19** | ✅ 无回归 |
| `POST /ask` | 覆盖 19/19、精确 16/19 | **覆盖 19/19、精确 16/19** | ✅ 无回归 |
| 反例（承认证据不足） | 3/3 | **3/3** | ✅ 无回归 |

⇒ **索引质量大幅提升（functions 540→1034、`.vue` 调用边 290→1269）而检索分数一动不动** ——
这是预期结果：本评测集的期望目标都是「业务函数/接口定义」，没有一条落在
「原先被丢掉的 `.vue` 函数」上（与 §13 依赖展开「本评测集看不到增益」是同一类原因）。

### 16.6 顺带解释清楚的一个数字：`.vue` 调用边 290 → 1269

不是新建了机制，而是**同一个机制拿到了更多输入**：`relationship-builder.ts:782` 的
`extractFunctionCalls(func.code, func.name)` 是**按 `functions` 表里每个函数的 `code` 文本**抽调用边的
⇒ 找回 494 个 `.vue` 函数，就直接带出它们的调用边。**TS 侧调用边精确停在 674（未动）**，
是一个很好的内控：说明变化完全局限在 `.vue`。

**这就是这次修复的真实价值所在**（比计数更有意义）：`.vue` 文件**内部**的调用链以前根本不可见 ——
实测 `loadSettings:135 → doReset:173 → onReset:165`（全在 `AlertFormView.vue` 内）现在能解析出来，
而修复前该文件产出 0 个函数，这条链在影响面里是不存在的。质量抽检：`.vue` 的 `to_symbol` 里
模板垃圾（含 `<` `>` `:` `@`）= **0**。

## 17. 增量索引的真实边界：它只维护 `code_chunks`，且会**永久删掉调用边**（2026-09-19 实测）

用户问题：「改了仓库代码，需要重新索引吗？很浪费吧，能不能增量？」

### 17.1 三条入口，只有一条半是「真的增量」

| 入口 | 可达性 | 实际干的活 |
|---|---|---|
| `POST /repos/:id/incremental-index`（body `files[]`） | 有路由，**前端无按钮** | `enqueueIncrementalIndexJob` → `indexMultipleFiles` → `indexSingleFile` |
| `POST /repos/:id/refresh` | 前端「刷新」按钮，**但 `repo.source !== 'gitlab'` 直接 400** | `git pull` + `git diff --name-only HEAD@{1} HEAD` 过滤 `.ts/.tsx/.js/.jsx/.vue` → 同一条 `indexMultipleFiles` |
| `POST /repos/:id/reindex` | 前端「重新索引」按钮 | 清空全库 + 重克隆；**zip 源直接 400**（"Please upload again"） |

### 17.2 `indexSingleFile` 只碰一张表

```
deleteFileChunks(fileId)            // DELETE FROM code_chunks WHERE file_id=$1
  → insertCodeChunk(...) (+ batchGenerateEmbeddings)
```
除了 `languageRegistry.forFile` / `parseChunks`，**没有任何实体层调用**。
全仓只有三处会写 `functions/classes/string_constants/url_patterns/call_graph/import_relations/file_dependencies`：
`indexer.ts` 的增强 pass（`indexCodebase` 末尾，无条件执行）、`scripts/reindex.js`、`scripts/rebuild-graph.js`
—— **全是整仓粒度**。

### 17.3 实测：删 chunk 会连带删掉什么（事务内模拟，已 ROLLBACK）

文件 `34334` = `test-repo/web/src/comm/components/AppPagination.vue`：

| | chunks | functions | classes | strings | url_patterns | **call_graph 出边** | import_relations |
|---|---|---|---|---|---|---|---|
| 删前 | 7 | 2 | 0 | 0 | 0 | **8** | 1 |
| 删后 | 0 | 2 | 0 | 0 | 0 | **0** | 1 |

**为什么边会掉、实体行不会掉** —— 取决于该 FK 列**是否真的存了值**：

- `call_graph.from_chunk_id` / `to_chunk_id` 都是 `ON DELETE CASCADE`，且
  **`from_chunk_id` 全仓 3645 行里 0 个 NULL**（每条出边都挂真实 chunk）⇒ 一删 chunk，边真掉。
- `functions.chunk_id` / `classes.chunk_id` / `string_constants.chunk_id` /
  `url_patterns.definition_chunk_id` / `url_usages.usage_chunk_id` **线上全为 NULL**
  （1366/1366、424/424、9053/9053、1108/1108、1707/2734）且 `is_nullable = YES`
  ⇒ 这 5 条 CASCADE 约束是**死约束，永不触发**。实体层靠 `file_id` 挂 `files`，删 chunk 不动它。

⚠️ **别拿 migration 推断行为**：`migrations/001_enhanced_schema.sql` 写的是 `chunk_id INT NOT NULL`，
与线上 `is_nullable=YES` 不符。判据一律查 `information_schema.columns` + `pg_constraint`。

### 17.4 净后果（针对「改了内容的文件」）

- `code_chunks`：重写（新行、新向量）✅
- `call_graph`：**该文件所有出边被级联删除，且这条路径永不重建** ❌
- `functions/classes/string_constants/url_patterns/url_usages/import_relations`：
  **原样保留**旧行号 / 旧签名 / 旧 `code` 文本 / **旧向量** —— 不报错、不改状态、UI 上看不出异常 ⚠️
- `file_dependencies`：只在 `EnhancedIndexer.indexFiles` 末尾物化 ⇒ 增量路径不重建 ⚠️
- 附带：`import_relations` 会**累积重复行**（`cleanupFileRelationships` 至今**无调用点**，
  `relationship-builder.ts:1323` 自己承认了这点）。

⇒ 增量索引不是「无害的省事」，它是**静默降级**。**「数据看起来是有效的」比「没有数据」更危险。**

### 17.5 为什么这个坑至今没在线上暴露

repo 29 / 30 **都是 zip 源** ⇒ `/refresh` 被 `source !== 'gitlab'` 守卫拦掉，`/reindex` 也被 400；
`/incremental-index` 前端从来不调。**坑对 gitlab 源仓库是活的。**

### 17.6 结论与建议（给用户的口径）

1. **改内容、路径集合不变** → 别用增量。用 skill `codelens-deploy` §6 的删仓重建
   （`DELETE FROM repos` → `ALTER SEQUENCE repos_id_seq RESTART WITH 29` → `rm -rf /tmp/codelens-repos/29`
   → 重新上传 zip），约 6 分钟，是唯一不会留脏数据的路径。
2. 理论上的「半增量」= incremental（刷 chunks）+ `scripts/reindex.js`（整仓重建实体+关系，
   能把被删的边修回来）+ `reembed.js --table=…`（补实体向量）。**它并不省向量**，
   实测总时长不占优 ⇒ 现阶段没有实用价值。
3. 要真做增量，最小改动面在 `indexSingleFile` 末尾补「本文件出边重建」；
   关系层为何选整仓重建，设计理由见 `relationship-builder.ts:1285`。

### 17.7 顺手记录：`/reindex` 路由的守卫顺序有个小瑕疵

`repos.ts` 的 `/repos/:id/reindex` 在处理**之前**（736-744 行）就先
`clearRepoData(repoId)` + `status = 'indexing'`，**之后**（757-760 行）才判断
「不是 gitlab → 400」。也就是说 zip 仓库调这个接口会**先被清空、再返回 400**，
留下一个 空库 + `status='indexing'` 的仓库。前端不调它所以没炸，但是个真实的顺序缺陷。

### 17.8 `.vue` 的模板不进索引，以及三个具体编辑情景的判定

**先立一条事实：`.vue` 两遍都只吃 `<script>` 块**（`parseVueScriptBlocks()` → `descriptor.script` /
`descriptor.scriptSetup`），`<template>` / `<style>` 完全不参与。

线上实测（repo 29，`AppPagination.vue` 为参照，`<template>` 1–12 行、`<script setup>` 第 13 行）：

| 判据 | 实测 |
|---|---|
| `.vue` chunk 里含 `<template` / `v-if` / `v-for` / `@click` 的 | **0**（共 2159 个 `.vue` chunk） |
| `string_constants` 里含 `</` 的 | **0** |
| 该文件 chunk 的符号与行号 | `props` 16–24 / `emit` 26–30 / `totalPages` 32 / **`go` 34–38** / `clamped` 35 / `onSizeChange` 40–45 / `size` 41 —— **全在 script 区**，且 `offset = 13−1 = 12` 已正确回填 |

#### 三个情景（用户实际会遇到的）

| 情景 | 走增量的后果 | 判定 |
|---|---|---|
| **新增文件** | 命中 `indexSingleFile` 的 else 分支 → `insertFile` + chunks + 向量 ✅。但 `functions/classes/string_constants` **0 条**；`import_relations` **0 条** ⇒ 别的文件 import 它也**产生不了** `file_dependencies` 边（该表只在 `EnhancedIndexer.indexFiles` 末尾物化）⇒ 影响面 / 依赖检索里这个文件**不存在** | **必须完整重建** |
| **改 `<template>`，行数不变** | 索引内容本该零变化（模板不入库）；但 `files.content` 变了 ⇒ 增量照样 `deleteFileChunks` 再重建（新 chunk id）⇒ **该文件调用边被 CASCADE 删光**，而实体层没得到任何更新 ⇒ **净损失** | 什么都不用做，**别跑增量** |
| **改 `<template>`，增删了行** | `<script>` 起始行变 ⇒ `offset` 变 ⇒ 该文件**所有绝对行号平移**。chunks 会被重算对 ✅，但 `functions/classes.line_start/line_end` **停在旧值** ❌ | **必须完整重建** |
| **在 `<script>` 下新增方法** | 新方法**不在 `functions` 表** ⇒ 影响面 / 调用图 / 符号检索都看不到它；它的调用边缺失；若行数有变化还叠加全文件行号错位 | **必须完整重建** |

**行号错位的机理**（可直接复算）：`offset = <script> 开始标签行号 − 1`；块内符号的绝对行号 = 块内行号 +
`offset`。模板加 3 行 ⇒ `<script>` 从 13 行变 16 行 ⇒ `offset` 从 12 变 15 ⇒ 该文件所有符号行号 +3，
而 `functions` 表里那批行还是 +0 的旧值。**这就是影响面点到错误代码行的原因。**

**统一口径**：改动若**移动了某个已有符号的行号**，或**改了符号名 / import 目标 / URL 字面量 / 文件清单**
⇒ **完整重建**（重传 zip + 保住 repoId）。纯模板、行数不变 ⇒ 索引层无事。
⚠️ 精确判据见 §18 —— **别用「总行数变了吗」当判据**。

## 18. 「改动是否移动行号」的实测口径（2026-09-19，probe-line-shift.mts）

用户质疑：「你只要改动，行号是一定会变的吧？」——**不成立**，但要分清两种改动。
探针 `apps/api/probe-line-shift.mts` 用**真实解析器**（`createTypeScriptParser('typescript')`
+ `parseTsFile`）跑同一份 14 行 TS 源码的 6 个变体：

| 变体 | 总行数 | 第二遍函数@行号 | 第一遍 chunk@行号 | 判定 |
|---|---|---|---|---|
| A 基准 | 14 | `go@3 onSizeChange@8 reset@12` | `clamped@4 go@3 onSizeChange@8 reset@12` | — |
| **B 只改第 4 行内容** | 14 | 同 A | 同 A | **行号完全没动** |
| **C 在 `go` 函数体内插 1 行** | 15 | `go@3 onSizeChange@9 reset@13` | 同左 | **只有插入点之后的符号移动** |
| **D 把 `onSizeChange` 改名** | 14 | `go@3 onSizeUpdate@8 reset@12` | 同左 | 行号全同，**名字变了** |
| **E 文件末尾追加 1 行注释** | 15 | 同 A | 同 A | 总行数变了，**行号一个没动** |
| **F 改第 1 行 import 目标** | 14 | 同 A | 同 A | 行号全同，**import 变了** |

**三条结论**：

1. **「只要有改动行号就会变」是错的**（B）。行号只在**净增/净删整行**时才移动；
   把 3 行换成另外 3 行、或在一行内改内容，行号**一个都不动**。
2. **行号移动是"局部"的**（C）：插入点**之前**的符号（`go@3`）不受影响，
   **之后**的才顺移。所以「往文件末尾追加」根本不移动任何已有符号（E）。
3. **「总行数变了吗」既会多判也会漏判 ⇒ 不能当判据**：
   - 多判：末尾追加行（E，总数 +1 但零移动）；
   - 漏判：**删掉一个空行 + 在别处补一个空行** ⇒ 总数不变，但中间符号全移了。
   精确判据只能是「**有没有插入/删除点落在某个已有符号的起始行之前（含其内部）**」，
   实操上等价于看 diff：**出现"纯新增行/纯删除行"且位置不在文件最末尾 ⇒ 行号移动了；
   diff 全是"同一位置的一对一修改" ⇒ 没移动。**

**D / F 说明判据②为何必要**：行号完全没变，但函数名变了、import 目标变了 ⇒
`functions` / `import_relations` / `file_dependencies` 照样失效。

### 18.1 行号为什么是判据的锚点：它的四个消费点

被追问「和行号有什么关系，是给证据展示用的吗」时，答这个。

**行号不是展示装饰，是索引唯一的坐标系。** 索引不是源码副本而是「关于源码的地图」，
每个条目（函数 / 类 / URL / 调用边 / 代码块）都靠 `(文件, 行号)` 定位回源码。实测的四个消费点：

| 消费点 | 位置 | 行为 |
|---|---|---|
| VS Code 跳转 | `apps/vscode-extension/src/commands/search.ts:199` | `new vscode.Position(ref.line_start - 1, 0)` |
| VS Code 列表 / 问答 | `views/searchView.ts:37,47`、`views/qaWebview.ts:727` | 显示 `path:line`，`line_start` 即打开参数 |
| 调用图节点 | `views/callGraphWebview.ts:288` | `openFile('${node.file_path}', ${node.line_start})` |
| Web | `apps/web/src/pages/RepoPage.tsx:1196,1221` | 显示 `:{line_start}-{line_end}`，按 `lineStart` 渲染代码块 |

evidence 的形状是 `code_text` + `line_start/line_end` **同一次索引时一起快照**下来的
（`server/evidence-mapper.ts` 的 `mapRawChunksToEvidence` 用 `row.code_text` 与 `row.line_start`，
**不回读磁盘**）⇒ 两者内部始终自洽，但都可以整体过期。由此分出两种严重度：

- **内容旧**（探针 B）：区间仍对应那段代码，跳转落点是对的，只有返回的文本是改之前的。
  ⇒ **信息过时**，可容忍。
- **位置错**（探针 C）：区间指到别处，**跳过去是别的代码，而系统把它当成证据呈现**。
  ⇒ **错误信息**，不可容忍。

**坐标无法局部修**（插入点之后的所有条目都受影响，且实体层没有「按 offset 平移」的路径）
⇒ 「行号有没有动」≡「地图还能不能用」≡「要不要重建」。

## 19. 真增量索引的可行性：**积木已全部存在，只差接一根线**（2026-09-19 核实）

被问「如果我不需要行号，能不能实现增量索引」时答这段。

### 19.1 先纠正前提：行号不是增量的代价

一个正确的增量会**重新解析**被改的文件，行号由当前内容算出 ⇒ **行号本来就是对的**。
现在行号会错，是因为当前实现**根本没重新解析那个文件**（只 `deleteFileChunks` + 重插 chunk，
实体层原封不动）—— 那是「没更新」，不是「增量必然错」。**"不要行号"救不了它。**

| 现在的增量会坏什么 | 依赖行号吗 |
|---|---|
| 跳转落到错误行 | ✅ 是 —— **只有这一项** |
| 新增的函数 / 类**根本不在索引里** | ❌ 否，属于「缺条目」 |
| 调用边被 CASCADE 删除且不重建 | ❌ 否 |
| `import_relations` / `file_dependencies` 过期 | ❌ 否 |
| 实体层向量不更新 | ❌ 否 |

⇒ 放弃行号只消掉 5 项里的 1 项。

### 19.2 逐文件的写入函数**已经存在**，只是没接上

`EnhancedIndexer.indexFileWith(parser, repoId, fileId, filePath, content)` —— 本身就是**逐文件**的，
四步全做：

```
analyzeEntities(filePath, content)          // 单文件接口
  → storeEntities(repoId, fileId, …)        // 写 functions/classes/string_constants/url_patterns
  → relationshipBuilder.buildRelationships(...)  // 写 import_relations / url_usages / call_graph
  → generateEmbeddings(repoId, fileId, …)   // 实体向量
```

它是 `private`，**只被 `indexFiles` 的批次循环调用过**；`indexSingleFile` 从未调用它。
`RelationshipBuilder.buildRelationships(repoId, fileId, filePath, astResult)` 同样是逐文件契约。
调用边从 `functions.code` 文本抽（`relationship-builder.ts:782` 的 `extractFunctionCalls`），
**不需要重新解析全仓**。

### 19.3 三条真实约束（都是「顺序 / 全仓视野」，不是「增量不可能」）

1. **import 边需要目标文件已在 `files` 里**（`buildImportRelationships` 在写入时就把
   `imported_file_id` 解析成具体 id）⇒ 必须先把所有新增/改动文件写完第一遍，再跑实体阶段。
2. **跨文件符号表**（`analyzer.beginRepo` / `registerRepoFiles`）必须在任何 `analyzeEntities`
   **之前**建立；它吃**全仓文件内容**（只读取、不解析）⇒ 实体阶段 = 「读全仓、只解析改动文件」。
3. **`file_dependencies` 是整仓 `INSERT … SELECT … GROUP BY`**，只能在最后一次性物化
   （一条边要两端都已入库）。

### 19.4 正确增量的形态

```
① 第一遍：写改动文件（files + code_chunks + 向量）        ← 现有 indexSingleFile 已能做
② 读全仓内容 → beginRepo（建跨文件符号表）
③ 逐改动文件跑 indexFileWith(...)                        ← 复用现有 private 方法
④ 整仓物化 rebuildFileDependencies(repoId)               ← 现有方法
```

工作量 ∝ **改动文件数**，且行号天然正确。改动面：把 `indexFileWith` 提为可复用（或加
`EnhancedIndexer.indexChangedFiles(repoId, repoPath, relativePaths)`），再加一个两阶段编排函数
接到 `enqueueIncrementalIndexJob`。




---

## 20. 真增量索引：已实现（2026-09-19，**未上线 / 未验证**）

§19 的结论是「积木已全部存在，只差接一根线」。本节记录那根线接上之后的实际形态。

### 20.1 落点（改 `indexing/**` ⇒ 按 skill `codelens-deploy` §10 必须重建索引才可能生效）

| 位置 | 新增 | 职责 |
|---|---|---|
| `relationship-builder.ts` | `cleanupFileEntities` | 删该文件的 `functions` / `classes` / `string_constants` |
| | `rebuildCallGraph(repoId)` | 整仓重建调用图（从 `functions` 表读回来重建，见 20.3） |
| | `gcOrphanURLPatterns(repoId, ids\|null)` | 回收「0 使用点」的接口行（见 20.2） |
| | `findReferrersOf(repoId, ids)` | 1 跳引用传播：importers + 调用点挂在「我定义的接口」上的文件 |
| | `findUnresolvedInRepoImports` / `resolveImportCandidates` | 新增文件让「原本解析不到落点」的老 import 复活 |
| `enhanced-indexer.ts` | `rebuildFiles(repoId, fileIds, opts)` | 逐文件两趟（先全删、再全建）实体 + 关系 + 向量 |
| `indexer.ts` | `indexMultipleFiles` 整体重写 | 六阶段编排（见 20.4） |

`buildCallGraphEdges` 的入参类型从 `FunctionInfo[]` 收窄为 `CallGraphSourceFunction`
（`{ name, lineStart, lineEnd, code }`）—— 目的就是让「全量重建」和「增量重建」走**同一个实现**，
调用图的正确性不该取决于它是被哪条路径触发的。

### 20.2 `url_patterns` 为什么**绝对不能**按文件删（本节是整件事最反直觉的一条）

`url_patterns` 的不变式是「一个接口一行」：`(repo_id, COALESCE(method,''), normalized_pattern)` 唯一，
**谁先定义就记谁的 `definition_file_id`**。而 `url_usages.url_pattern_id → url_patterns(id)` 是 CASCADE，
表里躺着**所有调用方**的文件 id。

于是「删除 A 文件定义的接口行」会级联删掉 B、C、D 文件里的调用点记录 ——
而 B/C/D **根本没被改动**，没有任何机制会把它们算回来。这不是「少一行」，是**跨文件数据永久丢失**。

正确做法是换一个判据：**「0 使用点」= 孤儿**。这条不变式站得住的原因是
`buildURLUsages` 每 upsert 一行接口，**紧接着就为同一个位置插一行 usage**（同一个循环体内），
所以任何真实存在的接口行至少有 1 行 usage；反之没有 usage 的必然是残留（或曾插入失败）。
而且它没有 usage ⇒ 删它级联不到任何别的文件 ⇒ 安全。
调用时再加范围限定（`definition_file_id = ANY(本次重建集合)`），避免整仓 GC 意外影响检索结果。

### 20.3 `call_graph` 为什么只能整仓重建 —— 但**不需要重新解析**

`call_graph.from_chunk_id` / `to_chunk_id` 都外键指向 `code_chunks` 且 CASCADE。
增量的第一步必然是重写变更文件的 chunk（`deleteFileChunks` + `insertCodeChunk`），
于是**别的文件指向这些 chunk 的入边被级联删掉** —— 谁都没改那个文件，没人会去重建它的边。

所以调用图必须整仓重建。关键在于「整仓」并不等于「全量重索引」：
调用边的原料是**函数名 + 起止行号 + 函数体源码**，这三样 `functions` 表里全都有
（`storeEntities` 当初就是把 `func.code` 存进去的）。⇒ `rebuildCallGraph` 直接
`SELECT file_id, name, line_start, line_end, code FROM functions` 读回来，喂给同一个
`buildCallGraphEdges`。**不重新解析、不重新生成向量**，实测毫秒~秒级。

⚠️ 时机：必须在 `import_relations` 重建**之后**。`resolveCalledFunction` 的跨文件分支要查
`import_relations`（`importer_file_id → imported_file_id`），提前跑会把所有跨文件调用边解析成 NULL。

### 20.4 六阶段编排与每阶段的失败语义

```
阶段 0  逐个判定候选路径：新增 / 修改 / 删除 / 未变（未变直接跳过）
阶段 1  findReferrersOf —— ⚠️ 必须在删除之前
阶段 2  第一层：indexSingleFile 重写 chunk（删除路径走它的 ENOENT → deleteFile 分支）
阶段 3  新增文件 → 把「候选路径能命中新文件」的老未解析 import 的导入方并进重建集合
阶段 4  EnhancedIndexer.rebuildFiles（两趟：先全删、再全建）
阶段 5  整仓 rebuildCallGraph
阶段 6  gcOrphanURLPatterns（限定在本次重建文件范围）
```

- **为什么阶段 0 要自己判「未变」**：旧实现把这个判断藏在 `indexSingleFile` 内部，
  但阶段 1/3/4 都需要知道「到底谁真的变了」—— 否则一次 no-op 的增量会去重建整个引用闭包。
- **为什么阶段 4 要分两趟**：一趟一个文件（删+建）会踩「A 导出常量、B 引用它，
  而 A 重建时 B 的 import 行刚被删掉还没重建」—— `buildConstantReferences` 是从**常量归属方**
  反查引用者的，于是 A 看不到 B，跨文件引用永久丢失。分两趟至少把「删到还没建的」填掉。
- **失败语义**：阶段 2 之后 chunk 层已经是对的，阶段 4/5/6 失败只会让「增强能力」降级，
  所以每个阶段单独 try/catch，但**每条都打日志**——不许静默吞（这正是本模块要修的慢性烂掉模式）。

### 20.5 顺手修掉的一个真 bug：`cleanupFileRelationships` 删错了列

原实现：
```sql
DELETE FROM constant_references WHERE repo_id = $1 AND referrer_file_id = $2
```
（注释写着「删除该文件中代码引用其他常量的记录」——**注释本身就是错的**。）

`buildConstantReferences(repoId, fileId, constants)` 是**从常量的角度反查谁引用了它**：
它插入的每一行 `constant_id` 都**属于当前正在处理的 fileId**，而 `referrer_file_id` 可以是任意别的文件。
⇒ 「referrer_file_id = 我」的行里混着两种：「别人引用我」和「我引用别人」。
按 referrer 删会把**别人创建的、指向第三个文件的行**一并删掉，而那个「别人」不在重建集合里，
**没人算得回来**。已改为按 `constant_id` 归属删（正常流程里是 no-op ——
`cleanupFileEntities` 删 `string_constants` 时 FK CASCADE 已经做了同一件事，保留它是为了
单独调用本方法时行为也正确，而不是依赖调用方先删实体）。

### 20.6 已知残留风险与上线前闸门

- **残留风险**：跨文件 `constant_references` 的顺序依赖没有彻底消除（A 的重建排在 B 之前时，
  A 看不到 B 的 import 行）。**全量重建有完全相同的问题**，不是本次引入的退化；
  仓库 29 的跨文件 `constant_references` 实测为 0。彻底解决要把 `buildRelationships` 再拆一层
  （先全仓落 `import_relations`，再算引用）。
- **上线前闸门**：本地 A/B —— 同一语料，一路全量重建、一路 `indexMultipleFiles`，
  然后逐表比对：`functions` / `classes` / `string_constants` / `url_patterns` / `url_usages` /
  `import_relations` / `file_dependencies` 按 `(path, line)` 排序比集合；
  `call_graph` 与 `constant_references` 因顺序依赖可接受少量差异，但每条都要能解释。
  **没跑完这个闸门不许上线**（skill `codelens-deploy` §12.8 已同步）。

## 21. 增量索引的「界面化」：先看 → 再应用 → 出明细（2026-09-19，**未上线 / 未验证**）

需求原话：*「界面上需要添加增量索引的功能吧，最好是可以告诉我都新增了那些东西，
这个功能可以只做 Gitlab 接入的，通过对默认分支的 diff 来获取；如果是 zip 类型的，默认就是全量的。」*

### 21.1 结论先给：可以做到，但要分清是**两层**报告

「新增了哪些东西」有**两个**不同的问题，混在一起就会变成一锅粥：

| 层 | 回答什么 | 数据来源 | 落在哪 |
|---|---|---|---|
| 输入层 | 上游**将要**发生什么：落后几个提交、动到哪些文件（A/M/D/R） | `git diff --name-status -M HEAD origin/<默认分支>` | `POST /repos/:id/upstream-check`（只读预览） |
| 输出层 | 索引**实际**变了什么：新增/删除/位移了哪些函数/类/常量/接口 | 重建前后实体层快照做差 | `repos.last_incremental`（`POST /repos/:id/refresh` 跑完写入） |

只做输入层的话，看到「上游改了 3 个文件」仍然不知道对检索意味着什么
（新增一个接口 ⇒ 能被搜到；只调缩进 ⇒ 什么都没变）。只做输出层则看不出「为什么」。

### 21.2 `git-upstream.ts`：为什么每个设计选择都不是随手写的

**① 旧实现为什么必须换掉（`git pull` + `git diff HEAD@{1} HEAD`）**
- `HEAD@{1}` 是 reflog 位置，中间只要发生一次 `checkout` / 别人 `pull` / reflog 过期，比对的基点就错了。
- `--name-only` **只有路径、没有 A/M/D**，于是 UI 根本说不出「新增了哪些」，
  也无法区分「新增文件」与「文件被删除」——这两件事在索引侧一个是插入、一个是删除，方向完全相反。
- `git pull` 默认**允许产生合并提交**。对一个只用来喂索引的镜像目录，合并提交意味着
  工作区历史与上游不再一致，下一次 `HEAD...origin/<分支>` 会开始包含我们自己制造的差异 —— 噪音越滚越大。

**② 现在的三段式：定位默认分支 → `fetch`（只读）→ 对比 → `merge --ff-only`**
顺序本身就是功能：预览（fetch + diff）**不动工作区也不动库**，失败就是网络问题，重试即可；
应用（`--ff-only`）**只在能快进时成功**，本地被改脏时**明确报错**而不是偷偷造合并提交。

**③ `resolveDefaultBranch` 三级回退**（可信度依次下降）：
`refs/remotes/origin/HEAD` → 本地当前分支 → 字面量 `main`。
实测有价值：目标仓库 `testwire-frontend` 的默认分支是 **`master` 而不是 `main`** ——
写死 `main` 的话每次都会 `rev-parse` 失败。

**④ 两个安全约束**（都不是洁癖）
- `execFile('git', ['-C', repoPath, ...])`，**不拼 shell 字符串**。路径虽然是我们自己生成的
  （`/tmp/codelens-repos/<id>`），但拼字符串的习惯一旦扩散到带用户输入的路径上就是命令注入。
  ⚠️ **反例就在隔壁**：`cloneGitLabRepo` 至今用 `execAsync(\`git clone ${cloneUrl} ${targetDir}\`)`，
  而 `cloneUrl` 来自用户提交的 URL —— 这是一个**待修的命令注入**，见 §21.7。
- `redactCredentials()`：克隆时 token 被注进 remote URL（`https://oauth2:<token>@host/...`），
  git 报错会**原样回显**它。所有 stderr 往上抛之前必须过这一层，否则 token 顺着 API 响应泄漏。

**⑤ `--name-status` 的列数是**不一致的**，这是本模块最大的坑**

```
A\tsrc/new.ts              ← 两列
R100\tsrc/old.ts\tsrc/new.ts ← 三列（重命名的**第 2 列是原路径**）
```

把列序读反**不会抛错**，只会静默地把「新路径」当「旧路径」：索引侧于是去删一个从来没存在过的文件
（无操作），而真正该删的旧记录留在库里 → **永远搜得到的幽灵文件**。
第一版就写反过，靠探针在真实 rename 上抓到。

**⑥ `T`（类型变化）必须显式映射**，不能落进 `default: return null`。
`parseNameStatus` 对未知字母返回 `null` 是**静默丢弃**，所以探针里有一条独立闸门：
「解析出的条数 == `git diff --name-status` 原始行数」，专门防「git 新增了状态码而解析器不认识」。

### 21.3 `collectCandidatePaths`：三个分支，别图省事合并

- **删除**：路径原样送进去让索引删那一行，**不按 `indexable` 过滤** —— 库里有这份记录的事实
  比 `languageRegistry` 现在的看法更权威（注册表支持的语言集合是可能变的）。
- **重命名**：旧路径要删、新路径要建。`a.ts → a.txt` 这种**改名又改类型**的组合里新路径不可索引，
  但旧行**必须**清掉 —— 旧路径是唯一还能指向那条记录的线索。
- **新增 / 修改**：只有可索引类型的才需要重建。

### 21.4 `incremental-report.ts`：**行号不进键**是这一节的全部重点

按「(路径, 符号, **行号**)」三元组直接比集合会错得很离谱：在文件开头插一行注释，
会让该文件里**所有**符号的行号 +1，于是每个符号同时出现在「删除」和「新增」里 ——
报告显示「新增 47 个函数、删除 47 个函数」，而实际**一个符号都没变**。

所以口径必须是：**先按 (类型, 路径, 符号名) 匹配身份，再比行号**。
- 只在 after → 真的新增
- 只在 before → 真的删除
- 两边都在、行号不同 → **位移**（单独一类，不计入新增/删除）

这也解释了行号在索引里为什么那么要紧（§12.0 / §18）：它是**证据定位**的坐标。
符号的「身份」是名字，行号是它的「位置」—— 两者混为一谈，报告和检索都会失真。

**为什么用「前后快照做差」而不是「索引过程中逐条埋点」**：逐条埋点要把记录插进
`storeEntities` / `buildRelationships` / 引用传播的每一条路径，任何一条忘了埋就**静默漏报**，
而且这份报告本身会变成一处需要维护的耦合。快照做差是事后推断，与索引内部实现解耦。

**两个必须遵守的时序约束**（写错了会安静地漏报）：
1. `before` 快照**必须在删除之前抓**。`functions` / `classes` / `string_constants` 都有
   `chunk_id → code_chunks ON DELETE CASCADE`，阶段 2 重写 chunk 的那一刻它们就被连带删掉；
   删除文件时更是整个 `files` 行消失。删完再抓只剩一份**空快照**，
   报告会把所有删除漏报成「什么都没发生」。
2. `after` 快照**放在最后**（阶段 7），而不是紧跟实体层重建之后 —— 这样**阶段 6 的孤儿
   `url_patterns` 回收**也能计入报告：一条路由因再无使用点而被 GC 掉，它确实从索引里消失了。

**两侧文件集必须严格同源**：`before` = 改动前已存在的变更文件 + 被删文件；
`after` = 全部变更文件（含新增）。被删文件天然缺席 ⇒ 实体落入 `removed`。
**刻意不包含**阶段 1/3 传播进来的引用方：它们的实体元组按构造不会变
（同一份内容重新解析 ⇒ 同名 functions 落在同一行），纳进来只是噪音；
而一旦某条分支让 after 侧多带进一个文件、before 侧没有，报告就会把该文件**所有**实体谎报成「新增」。

### 21.5 落库形状：为什么是 JSONB 而不是一张表

报告是「一次操作的结果快照」，只按 repo 取最新一份，没有独立查询需求。
建表会多一张只有读写、没有关联的表。存 `repos.last_incremental JSONB`，
走已有的 `ALTER TABLE repos ADD COLUMN IF NOT EXISTS` 兜底块（**必须**：`CREATE TABLE IF NOT EXISTS`
在表已存在时是彻底的 no-op，不会补列 —— 见 db/index.ts 里 2026-09-18 那次「整个服务起不来」的记录）。

⚠️ **列是启动时补的** ⇒ 部署顺序必须是「先让新代码起来（`initDatabase` 补列），再跑增量」。
`last_incremental` 在旧库上**不存在**，任何在补列之前调用 `saveIncrementalReport` 的路径都会报 42703。

`GET /repos`（列表）**刻意剔掉** `last_incremental`：一个仓库一份完整报告可能上百 KB，
列表页每行只要摘要。用解构 `const { last_incremental, ...rest } = repo` 而不是显式列名 ——
显式列表一旦漏掉后加的列就是一次**静默的字段丢失**。

### 21.6 前端 `IncrementalPanel` 的几个刻意的决定

- **ZIP 源显式降级，而不是隐藏按钮**。后端返回 `200 + {supported:false, reason}` 而不是 4xx：
  这不是错误，是已知的能力边界。用 4xx 的话前端只能显示一个红色报错，
  而真正需要展示的是「请走全量重建」这句**指引**。若只是把按钮藏掉，用户会以为「这功能还没做」，
  而不是「这个来源类型做不了」。
- **`UpstreamCheckResponse` 用可辨识联合**而不是一堆可选字段。`supported:false` 时**没有**
  `behind` / `files`；若建模成可选字段，组件里就会到处写 `data.behind ?? 0`，
  把「不支持增量」静默显示成「0 个更新」—— 那正好是最误导人的那种错。
- **「会进索引的文件数」必须和「文件总数」分开显示**：索引器只认 TS/JS/TSX/JSX 与 `.vue`，
  「改了 12 个文件」和「其中 9 个会进索引」是两句不同的话。
- **「仅位移」要单独解释**：不解释的话「位移 47」这个数字看起来像出了 bug。
- **应用更新后自动重新检查一次**：显示「已是最新」是最直观的成功信号。

### 21.7 顺带发现的两个真问题（都没改，等确认）

1. **命令注入**：`cloneGitLabRepo` 用 `execAsync(\`git clone ${cloneUrl} ${targetDir}\`)`，
   `cloneUrl` 由用户提交的 URL 拼接而成。与 `git-upstream.ts` 里刻意用 `execFile` 的做法自相矛盾。
   修法很小（换成 `execFile('git', ['clone', url, dir])`）。
2. **状态卡死**：`/refresh` 与 `/reindex` 在**入队前**就把 `repos.status` 置为 `'indexing'`，
   而队列的 `failed` 监听器**只处理 `index`**。任务失败 ⇒ 状态**永久停在 indexing**：
   UI 一直转圈、前端拦住所有刷新、连删除仓库都会被拒。任务失败是暂时的，状态被卡住是永久的。
   已修（`queue.ts`）：`refresh` 失败 → 回 `'ready'` 并把失败原因写进 `last_incremental` 的 `note`
   （旧索引确实还在，报 `'failed'` 才是撒谎）；`reindex` 失败 → `'failed'`（路由已先 `clearRepoData` 清空）。

### 21.8 验证到什么程度了（**没有**验证到什么）

| 项 | 手段 | 结果 |
|---|---|---|
| git 侧解析（默认分支 / behind / A-M-D-R / T / 复制） | `apps/api/probe-git-upstream.mts` | **34/34 通过** |
| 与真实仓库的路径落点一致性 | 探针用 `git cat-file -e <rev>:<path>` **独立**校验 | 22/22 一致 |
| 候选路径翻译（含改名改类型的旧路径） | 探针里自造 origin，逐条断言集合 | 通过 |
| 类型检查 | api + web `tsc --noEmit` | 均 0 错 |
| 打包 | web `vite build` + api `tsc`，并 grep 产物里的新标识符 | 通过 |
| **DB 侧 SQL（`snapshotEntities` / `saveIncrementalReport`）** | —— | **未验证**（库是 `DB_HOST=localhost`，只监听服务器本机，本机连不上） |
| **端到端（检查 → 应用 → 看明细）** | —— | **未验证**（需要部署 + 一个 GitLab 源仓库） |
| `indexMultipleFiles` 输出与全量重建逐表一致（任务 #20 闸门） | —— | **仍未做**（§20 的老账） |

**探针里踩到的两个坑（都是「测试写错而不是代码错」，值得记住）**
1. `rev-list --count` 在**浅克隆**里会给出与 first-parent 步数不一致的数字 ——
   因为 `master` 历史里全是 merge 提交，`behind`（上游可达、本地不可达）会把被合并进来的
   分支提交也数进去，**大于**步数。**别拿「退回 N 步 ⇒ behind=N」当判据**，
   期望值要独立地向 git 要。第一版探针就是这么误报的。
2. 数「可索引文件数」要**数出来**，别凭印象填：8 个文件里 `notes.md` 与改名后的 `.txt` 都不可索引，
   正确答案是 6 而不是 7。

### 21.9 测试靶子与凭据的实际情况（这条最实用）

- 目标仓库：`http://gitlab.logwire.cn/coopwire/testwire-frontend.git`
  —— **公开可匿名 HTTPS 克隆**（`git ls-remote` 不带任何凭据就成功），
  默认分支 **`master`**，1623 个文件 / **1532 个可索引**（ts 878 / vue 414 / js 237 / tsx 3）。
  这是个比 repo 29（277 文件）**大 5.5 倍**的真实前端工程。
- ⚠️ **用户给的「token」其实是一把 SSH 公钥**（`3072 SHA256:BC1RuWWBhIoDiLrpvOZGvCi3kd4rM9Zh5RbOJMLz1xU`，
  注释 `sun_lingyue@126.com`），**不是**私有凭据，也**不是** GitLab PAT —— 单独拿它登录不了任何东西。
  而且本机 `~/.ssh/id_rsa.pub` 是另一把（`len.sun@logwirecloud.com`），与之不匹配。
  结论：**根本不需要凭据**，直接用匿名 HTTPS。
- 但 `repos 29/30 都是 zip 源`，**线上没有任何 GitLab 源仓库** ⇒ 这条链路目前**没有活靶子**。
  端到端测试需要先新建一个 GitLab 源仓库（代价：约 1532 个文件的首次全量索引）。
  > **2026-09-19 晚更新（这条已推翻）：** repo **33 = testwire-frontend 就是一个活的 GitLab 源**，
  > 见 §22.3。自造夹具仓库（repo 32）已删除。
- 自造 off-by-one 的技巧：把镜像目录 `git reset --hard origin/master~5` 再走
  「检查 → 应用」，就能在**不改上游**的前提下拿到真实的多提交差异，完整跑一遍增量。

---

## 22. 三层索引守卫：把压缩/构建产物挡在索引之外（2026-09-19 实现并上线）

### 22.1 事故现场：45 个文件产出 52.8 MB 代码块正文

把真实工程 testwire-frontend（repo 33）接进来后，索引产出 **45 个文件 / 1431 个代码块，
但代码块正文合计 52.8 MB** —— 平均每个 chunk 约 37 KB，而健康语料是百字节量级。

| 仓库 | 文件数 | chunk 正文 |
|---|---|---|
| repo 29 `test-repo` | 277 | ≈ 0.79 MB |
| repo 30 `fastify` | 289 | ≈ 2.11 MB |
| **repo 33（守卫前）** | **45** | **52.8 MB** |

根因：`public/static/monaco/vs/language/typescript/tsWorker.js` 这类文件是**压缩产物** ——
4.6 MB / 极少行数 / 最长行十几万字符。`parseTsFile` 本身很快（308 KB 的 `workerMain.js` 解析
只要 323 ms），但 AST 分块在压缩代码上会切出大量**跨越大段文本**的 span，
文本量相对原文件放大约 **160×**（`workerMain.js`：308 KB → 50 MB chunk 文本，878 个块）。
后果是按小时计的嵌入耗时与费用，且产出全是没人会检索的噪声。

### 22.2 三层守卫的设计（`indexing/file-scanner.ts`）

`collectFiles` 是**唯一入库闸门**，但 `SKIP_DIRS` 只按**目录名**判断，
抓不到「和源码混在一起」的产物（`public/static/` 里的 vendored 包、`src/assets/` 里生成的 iconfont）。
三层按**代价从低到高**排序，前一层拦住就不进下一层：

| 层 | 判据 | 代价 |
|---|---|---|
| ③ | 路径特征：`public/(static\|assets\|build\|dist)/`、`*.min.{js,ts,tsx}`、`*.bundle.js`、`*.chunk.js` | 纯字符串比对 |
| ② | 单文件 > 1 MB（十进制） | 用 `stat` 已拿到的 size，零成本 |
| ① | 整体像压缩产物（见下） | 需读文件 |

**层① 的判据是「最长行 > 5000 **且** 平均行 > 2000」，两个条件是 AND，缺一不可。**

只用「最长行 > 5000」会**误杀真实源码**。实测反例 `src/utils/Json.ts`：这是个 61 行的手写模块，
有 import、JSDoc、导出函数，但第 39 行是一个 **65,554 字符的位图字符串常量**
（`const txt = "000…333…"`）。只按最长行判，这个文件会被整个丢掉，连带里面几个正经函数一起消失 ——
而「该索引的没索引」比「多索引点噪声」危害大得多。

| 文件 | 行数 | 最长行 | 平均行 | 判定 |
|---|---|---|---|---|
| `src/utils/Json.ts` | 61 | 65,554 | 1,099 | **真源码** → 索引 |
| `public/static/monaco/…/workerMain.js` | 23 | 156,899 | ≈13,700 | 压缩产物 → 跳过 |
| `src/assets/icon/iconfont.js` | 1 | 784,438 | 784,438 | 压缩产物 → 跳过 |

直观解释：压缩产物是「**行少而总体量巨大**」，平均行长会非常大；而带大字符串常量的真源码
只是「某一行特别长」，整篇平均下来仍然正常。

### 22.3 上线与实测结果

- 主闸门在 `collectFiles`（重写为 `scanRepoFiles`，**返回 `{files, skipped}`**），
  并**同时接进增量路径** `indexMultipleFiles` 与 `indexSingleFile`：全量挡住的类型，
  上游改了同一个文件走增量时也该挡。
- **命中必须逐条 log，不许静默跳过**。实测输出：
  `[indexer] 224 个文件被守卫跳过（构建产物路径 222，文件过大 1，压缩产物 1）` + 逐文件明细。
- 实测 testwire-frontend：1532 候选 → **拦 224 → 索引 1308 个文件 / 3.60 MB**。
  最大的剩余文件是 229 KB 的 `src/types/PrimaryItemRawMap.d.ts`（类型声明，合理）。
- **对 repo 29/30 行为中性（各 0 个被拦）⇒ 不需要重建它们的索引。**
  这个「先探针确认中性、再决定要不要重建」的省时闸门，见 skill `codelens-deploy`。
- 自检探针（**只读目录、不碰数据库**）：
  `node apps/api/dist/scripts/probe-index-guard.js <仓库目录>`
  —— 每次调阈值都先跑它，确认「该拦的拦了、不该拦的没被误杀、剩下的规模可索引」。

### 22.4 ⚠️ 部署了新 dist 却忘了重启 → 守卫完全没生效

第一次触发重建时日志是 `Full indexing 1532 files`（**未过滤**）。原因：我只把新的
`file-scanner.js` / `indexer.js` scp 上去了，**没有重启 API** —— Node 在启动时就把模块载入内存了。
重启后同一请求变成 `Processing batch 2/131`（≈1310 个文件），守卫才生效。

这是「通用铁律 1：源码改了 ≠ 线上在跑」的一个**具体且昂贵的后果**：不重启时没有任何报错，
只是白跑一遍全量索引（几十分钟 + 嵌入费用）。**改完 `indexing/**` 必须重启 API 再触发索引。**

### 22.5 顺带确认 / 更正的四件事

1. **`console.warn` 的输出不进 out 日志。** pm2 把 stderr 分流到
   `/var/log/codelens-api-error.log`，`console.log` 才进 `codelens-api-out.log`。
   我在 out 日志里 grep 守卫输出一开始是空，就是踩了这个。
   **因此守卫输出统一改用 `console.log`** —— 跳过构建产物是预期行为，不是异常，
   把 224 行正常信息塞进错误日志只会让人以后不敢认真看错误日志。
2. **`POST /repos/:id/reindex` 里的 `clearRepoData` 要 ~30 s**（它会 drop/recreate 索引与约束）。
   于是 `curl --max-time 20` 会让这次调用**表现为空响应**，很容易被误判成「请求失败」。
   实测：`--max-time 30` 也刚好踩线。**要 > 35 s。**
3. **`POST` 带 `Content-Type: application/json` 但无 body 会 400**
   （`FST_ERR_CTP_EMPTY_JSON_BODY`）。前端 `IncrementalPanel` 是**不带 body 也不带 content-type**
   发的，用 curl 复现时别自作主张加这个头。
4. **线上嵌入配置的唯一来源是 `ecosystem.config.js` 的 `env_production`，不是 `.env`。**
   两者**值不同**：进程 = DashScope `qwen3.7-text-embedding` @ 1536 维；
   `.env` = `text-embedding-v4` @ **1024** 维。且服务器上**根本没有 `.env.production`**
   （旧笔记里「脚本需加 `--env-file-if-exists=.env.production`」的说法是在本地仓库语境下，
   服务器上不成立）。⇒ **绝对不要手动跑 `reembed.js`**：它会用 1024 维配置去写
   `vector(1536)` 列。嵌入必须交给 API 进程做（队列 worker）。
   另外 `RERANK_ENABLED` 线上**已经是 `true`**（此前记录的 `false` 已过时）。

### 22.6 本机 git 凭据：明文文件 → osxkeychain

- 处理前有两层：系统级
  `/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig` 有 `credential.helper=osxkeychain`，
  而用户级 `~/.gitconfig` 是 `credential.helper=store`。**用户级优先**，
  所以实际操作的是 `~/.git-credentials`（明文，213 字节，0600）。
- 处置：`git config --global credential.helper osxkeychain` → 删 `~/.git-credentials`。
  删除前先实测 Keychain 可用（`git -c credential.helper=osxkeychain ls-remote` 成功取到 ref）。**
  不做明文备份**：那些凭据本来就在 Keychain 里，再复制一份明文出来等于没删。
- ⚠️ **userinfo 里的用户名必须是 URL 编码形式**：`.git-credentials` /
  `cloneGitLabRepo` 里存的是 `leon.sun%40logwirecloud.com`。若解码成 `leon.sun@logwirecloud.com`
  直接塞进 URL，裸 `@` 会被当成 host 分隔符 ⇒ 报
  `Port number ended with 'S'`（把 `<x.com>:<密码>` 错当成了主机:端口）。
- **凭据形态判据 = 里面有没有冒号**：有 ⇒ 完整的 `用户名:密码`；没有 ⇒ 裸 token
  （GitLab PAT 是 `glpat-xxx`，不含冒号）⇒ 配 `oauth2` 当用户名。
  （2026-09-19 记的「repo 公开可匿名克隆、token 其实是 SSH 公钥」**已失效**：
  该仓库现在需要认证，匿名 `ls-remote` 报 `could not read Username`。）

---

## 23. 一个 `.vue` 让 1308 个文件的实体层全部归零（2026-09-19 修）

面试材料见 `interview-prep/13-索引崩溃排查：一个文件如何让整仓索引归零.md`（含口述稿）。

### 23.1 现象与判据

repo 33 状态 `failed`。**判据是「哪一层有数、哪一层是 0」**：

| files | code_chunks | functions | url_patterns | url_usages | call_graph |
|---|---|---|---|---|---|
| 1051 | 14084 | **0** | **0** | **0** | **0** |

第一层有数、第二层全 0 ⇒ 范围立刻缩到「增强索引在**一开始**就死了」。
日志 `Indexing 1051 files...` 之后**仅 3 秒**就 `status='failed'` ——
1308 个文件不可能 3 秒跑完 ⇒ 死在**一次性全仓扫描**里，不是逐文件循环。

### 23.2 根因（两个，缺一不可）

1. **`URLResolver.registerFiles` 没有逐文件 try/catch。** 异常穿过
   `registerRepoFiles` → `RepoScope.begin` → 在 `EnhancedIndexer.indexFiles` 才被捕获，
   此时实体/关系表还是空的 ⇒ **一个文件的格式问题 = 整仓检索能力归零（连坐）**。
2. **`.vue` 原文被喂给了 TS 解析器。** `<template>` 的 `@import="x"`（模板事件绑定）
   与 `<style>` 的 `.x-import {`（CSS 类选择器）被 TS 错误恢复**合成 `ImportDeclaration`**，
   而 `getModuleSpecifierValue()` 遇到非字符串字面量的合成节点会抛
   `InvalidOperationError: Expected the module specifier to be a string literal.`

`sfc-host.ts` 的注释早就写了「**两遍**索引都必须走 `parseVueScriptBlocks`」，
但漏了**第三处**：跨文件符号表这一遍（`RepoScope.begin` → `registerRepoFiles`）。

### 23.3 修法

- `url-resolver.ts` `registerFiles`：两遍循环各自逐文件 try/catch，坏文件从 `sources` 摘掉、
  记进 `failed`，最后汇总打印 `[URLResolver] 4/1310 个文件未能进入跨文件符号表` + 逐条明细。
  **降级要局部化 + 记账**：只 catch 不记账 = 从「连坐」退化成「静默漏掉」，更差。
- `languages/typescript/index.ts` 新增并导出 `toResolverSource(path, content)`：
  `.vue` 解包 script 块后用**空行占位**。
  ⚠️ **不能把 script 块直接拼起来** —— 符号表的 provider / 间接落点都带行号，
    拼接会让 `<script setup>` 那块的行号整体前移。空行占位让行号与 `.vue` 严格对齐，无需平移。
  导出是为了让 A/B 探针调用**真实实现**（探针里手抄模拟列 = 假阴性来源）。

### 23.4 定位手法（可复用）

写**离线探针重放线上那次调用**，逐文件 catch，直接钉到「文件 + 行号」——
而不是读代码猜或 grep。现成脚本：`apps/api/src/scripts/probe-resolver-sfc.ts`。
（探针本身也有坑：`imp.getModuleSpecifier().getKindName()` **同样会抛**，
在 catch 块里二次抛出会让整个探针崩掉，看起来像「问题是全局的」。
**探针里每一个可能抛的调用都要单独兜。**）

### 23.5 验证结论（A/B + 逐条核对 + 中性验证）

repo 33：provider 46 → 46（**明细完全一致**）；跨过程落点 95 → 96，差异逐条核对后
**新行为严格更优**：

- **−** `AutomatedTesting/.../Main.vue:177` —— 该文件 `<script setup>` 是 48–118 行，
  177 行**在 `<style lang="scss">` 的 `@container` 规则里** ⇒ 旧行为凭空编造，删掉对
- **+** `PlayWright/SelectorTree/Main.vue:45`、`PublicSetting/.../Import.vue:42` ——
  真实的 `const {...} = context;`（`context = useContext(props)`）⇒ 从「整份被丢」中找回

**对既有语料中性**（逐条一致）⇒ 不需要重建它们的索引：

| 仓库 | 文件 | provider | 跨过程落点 |
|---|---|---|---|
| repo 29（166 个 `.vue`） | 277 | 174 → 174 | 36 → 36 |
| repo 30（0 个 `.vue`） | 289 | 868 → 868 | 25 → 25 |

### 23.6 可迁移的一句话

> **一条「按单个文件成立」的假设，被写进「处理整仓」的循环里，而且失败是静默的。**
> 事故 A（压缩产物被 AST 分块放大 160×，见 §22）与事故 B 是同一个形状。
> 配套三条原则：① 处理数 == 0 必须显式失败或 SKIP；② 降级要局部化 + 记账；
> ③ 改完启发式/解析器先证明「对既有语料中性」，再决定要不要付重建代价。


---

## 24. 五处「静默丢数据」：解析器补 enum、整文件兜底、窄列与 btree 上限（2026-09-20 修）

> 完整版：`interview-prep/14-索引质量排查：五处静默丢数据.md`
> 这一节只留**结论 + 判据 + 命令**。

### 24.1 现象与第一步该做什么

仓库页 1051 个文件 vs 扫描器 1308 个，差 257，**零报错**。取两个清单做双向 `comm`：

```bash
node -e "import('/root/CodeLens/apps/api/dist/indexing/file-scanner.js').then(async m=>{
  const {files}=await m.scanRepoFiles('/tmp/codelens-repos/33'); console.log(files.join('\n'))})" | sort > /tmp/scan_paths.txt
psql -tAc "SELECT path FROM files WHERE repo_id=33" | sort > /tmp/db_paths.txt
comm -23 /tmp/scan_paths.txt /tmp/db_paths.txt | sed 's/.*\.//' | sort | uniq -c | sort -rn
```

**第一步是分类，不是修。** 只看「barrel 文件不产 chunk 是合理的」就会漏掉真缺陷。
分类后必须对可疑文件**写只读探针量一下**（`node dist/... registry.forFile(abs).parseChunks(...)`），
判据是「216 行的文件产出 0 个 chunk 不可能是正常行为」。

### 24.2 五个缺陷（都能独立造成「文件消失」）

| # | 位置 | 失效方式 |
|---|---|---|
| 1 | `chunker.ts` 无 `TSEnumDeclaration` visitor | 纯枚举文件整份 0 chunk（本仓 25 个） |
| 2 | `indexer.ts` `chunks.length===0 ⇒ continue` | 不落 `files` 表、不打日志（257 个） |
| 3 | `functions.return_type` `VARCHAR(255)` | TS 推断返回类型数百字符 → **`storeEntities` 事务回滚 → 整文件实体层消失** |
| 4 | `idx_string_constants_unique` 是 **btree** | 单值 >~2704 字节 ⇒ `index row requires 8520 bytes` ⇒ 同上事务回滚 |
| 5 | `git clone` 到非空目录 | 失败发生在索引成功**之后** ⇒ 把 `ready` 覆写成 `failed`；且 URL 里的明文密码进了 error log |

⚠️ **#3/#4 的伤害全在「它所在的事务是整文件粒度」**：`storeEntities` 一个 `BEGIN` 里有
三张表的写入，任一失败 ⇒ `ROLLBACK` ⇒ 该文件在实体层一条都没有，日志只有一行。

### 24.3 修法与判据

- **补 `TSEnumDeclaration`**（`symbolType:'enum'`）。加值前核查：DB `code_chunks.symbol_type`
  是 `TEXT` 无 CHECK；代码侧只有前端 `SYMBOL_TYPE_STYLE` 一处枚举式消费且有 `unknown` 兜底。
- **整文件兜底块**：`languages/typescript/index.ts` 的 `makeModuleFallbackChunk` +
  `parseWithFallback`（**两解析器共用同一个包装**，先兜底后回填 `language`）。
  `symbolType:'module'` 不伪装成符号；上限 **8000 字节**（按字节不按字符，中文 3 字节/字符）。
- **0 chunk 改为防御性 `console.warn` + 末尾汇总**（兜底生效后此分支不该再触发）。
- **`return_type` → `TEXT`**（migration 005）。选放宽而非截断：截断留下**语法非法的半截类型**。
- **超长字符串常量按字节跳过**：`isIndexableStringConstant()`（>2000 字节），三个抽取点
  **共用同一个判据函数**（复制三份就得有一天只改两份）。
- **clone 前 `rm(targetDir, {recursive,force})`**；**失败信息脱敏**
  （`cloneUrl.replace('//','//***:***@')` 后 `raw.split(cloneUrl).join(redacted)`）。

### 24.4 A/B 验证口径（**「块变多」不是证据**）

只读探针同时 import 新旧两份 dist，同一语料逐文件比对（`ab-parser-diff.mjs`）：

| 指标 | repo 33（1308 文件） |
|---|---|
| chunk 总数 | 14084 → **14395**（+311） |
| 逐文件产出完全相同 | 1018 |
| 从 0 chunk 变非 0 | **257**（整文件兜底 237 + enum 20） |
| 原有 chunk 上新增 | **33**（全部是 enum 块） |
| 两版都为 0 | **0** ✓ |
| **旧有条目被替换/丢失** | **0** ✓ |
| 自洽 | 1018+257+33+0+0 = **1308** |

**要回答的是两个「可能让改动作废」的问题：有没有条目被换掉、有没有文件两版都是空的。**
另外做交叉验证：`comm` 双向差集都为空 ⇒ 「0 chunk 的文件集」与「`files` 缺失的文件集」
**完全重合** ⇒ 排除「还有第二个原因也在丢文件」。

### 24.5 可迁移的三条

1. **能力边界与业务结论必须分开。** 解析器只能报「我这层没抽出东西」，
   不能替上层决定「那这个文件就不入库」。
2. **「预期的跳过」也要计数并汇总。** 237 个兜底文件是正常行为，但不汇总就没人知道
   差额去哪了，排查方向会被引到扫描器上。
3. **一个字段的宽度不该带走一整个文件的实体层。** `VARCHAR(n)` 在事务里 = 整行数据的单点故障；
   描述性元数据一律 `TEXT`。

---

## 25. 断点续跑：两遍索引的续传能力不对等（2026-09-20 实现并上线）

> 完整版：`interview-prep/15-索引失败恢复：从断点续跑说起.md`

### 25.1 问题形状

第一遍（`indexCodebase`）**有**续传（按 `files` 表跳过）；第二遍（`reindexRepository`）
**完全没有**（先 `cleanupRepository` 清 10 张表再全量）。而 `POST /reindex` 还会额外
`clearRepoData` ⇒ **一次失败 = 一次完整重来**（repo 33 全量约 40 min，绝大部分是 embedding 等待）。

### 25.2 设计

- 标记附在数据上，**不写进度文件**：进度是二维的（有 chunk 但无实体是合法状态）；
  进度文件无法感知增量更新导致的结论失效；它在「写完进度」与「写完数据」之间有撒谎窗口。
- `migrations/006`：`files.entities_indexed_at TIMESTAMPTZ`（+ 部分索引）。
- **一设一清**：`indexFileWith` 四步全成功才 `SET = now()`；
  `updateFile` 置 `NULL`（内容变了 ⇒ 结论失效）。只做「设」不做「清」会得到一个
  **比不续跑更坏**的坏序列（更新→崩溃→续跑跳过⇒新内容永远没有实体层）。
- 第一遍判据加严：`EXISTS (SELECT 1 FROM code_chunks ...)`（半成品会被重做）。
- **执行复用 `rebuildFiles`**，只换「选哪些文件」——逐文件重建的三条正确性约束
  （先删干净自己 / `url_patterns` 不能按文件删 / 收尾重算依赖）两边完全一样。
- `POST /repos/:id/resume` 返回 `pendingFiles`；不 `clearRepoData`、不重 clone；
  工作区缺失时 GitLab 重克隆、ZIP 明确报错（**不**用库内 content 反向造源码）。

### 25.3 状态语义

失败恢复按「**索引还在不在**」定：`refresh`→`ready`；`reindex`→`failed`（库已清空）；
`resume`→`failed`（库没清空，但整仓仍不完整）。**续跑的 `failed` 可低成本恢复**，
这是与之前最大的差别。

### 25.4 验证法（不要跑全量去「看看对不对」）

① 零待补路径：补齐标记 → `/resume` 应 `pendingFiles: 0`、数十秒完成、**不产生新向量**。
② 制造局部失败：若干文件标记置 `NULL` → `/resume` → 验收三条：
**只重建了这批** / **它们被重新盖章**（再次 `/resume` 返回 0） /
**`code_chunks` 与向量行数不变**。第③条才是重点 —— 功能的定义是「不重做已完成的事」。

### 25.5 顺带修的「字段在撒谎」

`updateIndexProgress(repoId,total,processed,startTime?)` 原为 `startTime || new Date()`，
而调用方**每处理一个文件**就调一次 ⇒ `startTime` 实际是「最后一次进度更新时间」，
前端算「已用时」恒为 0。改为：传了 `startTime` 才整体重置（并 `phase='basic'`，
否则上一轮 `'enhanced'` 残留会让基础阶段读陈旧的 `enhancedTotal/enhancedProcessed`）；
没传则只 `jsonb_set` total/processed。

> **教训**：这类问题不会报错，数值看起来也完全合理，只能靠追问字段含义发现。

## 26. 「列出全部 N 个接口」答不出来：检索范式对集合类问题是**结构性无解**

（2026-09-20 排查，问：「仓里显示 386 个接口，请列出来」→ 答「证据中不包含这 386 个接口的清单数据」）

### 26.1 三层原因（都在代码里，不是模型不听话）

1. **管道形状**：`/ask` 的四个分支（URL 搜索 / multi / enhanced / 纯向量）**全都**产出
   `evidence = top-K`（`ask.ts:49-54`，`limit: 10`；`/root-cause` 是 15）。
   然后 `answerQuestion(query, evidence)`。LLM 能看到的只有这 10 条 chunk。
2. **提示词是故意这么写的**：`llm/qa.ts:251` 明写「4. 如果证据不足，明确指出」。
   所以那句拒答是**系统按设计工作**，不是故障。
3. **意图路由里没有「集合类」这一档**：`classifyQuery`（`qa.ts:76-120`）只有 8 类
   （url_lookup / code_location / implementation / architecture / bug_analysis /
   usage_example / comparison / general），正则里**没有**「列出/全部/所有/一共/多少个」。
   「列出所有接口」→ 落到 `general` → 通用提示词。

### 26.2 为什么「自动查库」不会发生

- 从「自然语言问题」到「数据」的**唯一通路是向量 top-K**，没有任何 tool。
- LangGraph 图只有三个节点：`retrieve → grade → generate`（`agent/graph/nodes.ts`），
  `generate` 也只是复用 `answerQuestion`。**没有 tool 节点**。
- `url_patterns` 全仓只被一处读：`GET /repos/:id/stats` 的 **COUNT**（`repos.ts:106`）。
  **数字 386 就是从这一行来的，而没有任何路由返回这些行**。前端 `RepoPage.tsx:639`
  只把 `repoStats.urlPatterns` 当数字渲染，没有清单视图。

### 26.3 关键认知：top-K 在数学上**不可能**回答「列全部」

| | 向量 top-K | 集合查询（SQL） |
|---|---|---|
| 回答的问题 | 哪些片段与查询**最相似** | 哪些行**满足谓词** |
| 完备性 | 无保证（K 是固定预算） | 有保证（返回全量） |

「列出全部 386 个」要的是**完备性**，而 top-K 的定义里就没有这个东西。
把 K 从 10 调到 386 也不行：既撑爆上下文，又会让「相似度」这个概念失去筛选意义。
**这是范式不匹配，不是参数没调好。** 提高嵌入质量、加 rerank 都不会改善。

### 26.4 顺带发现：**386 这个数本身是虚高的**

`url_patterns` 里混着大量非 HTTP 接口。实测 repo 33（386 行）：

| 误报形态 | 实际代码 | 行数（样本） |
|---|---|---|
| `ALL \| ${promise}` | `Promise.all(promise)` | 5（method=ALL 全部是 `Promise.all`） |
| `DELETE \| ${name}` | `this._map.delete(name)` | 59 行 method 为空里的一部分 |
| `(空) \| text/csv` | **MIME 类型**，不是路径 | — |
| `ALL \| testwire/static/pw/api.json` | 静态文件路径 | — |

- 根因：`entities.ts:962` 的 `extractHTTPMethod` 用 **`text.includes(method)` 子串匹配**
  ⇒ 代码里出现 `delete` 字样（`Map.delete`）就判成 HTTP DELETE。
- 用「definition_code 里是否含 `axios\|fetch(\|request(\|$http\|http.get`」做粗筛：
  **246 / 386**。即约 **140 行（36%）不像真实 HTTP 调用**。

> **本节最该记住的一点**：这个数错了很久都没人发现，因为 **UI 只显示数字、不提供明细**。
> 与「计数 == 0 必须显式失败」是同一枚硬币的两面 ——
> **只暴露汇总值、不暴露可核对明细，等于把错误永久隐藏起来。**
> 也因此，正确顺序是**先修抽取口径，再谈「完整展示」**：否则只是把一个错的清单展示得更完整。

### 26.5 两个方案（区分清楚，别混）

- **A. 应用内结构化路由**（推荐先做）：给 `classifyQuery` 加 `enumeration` 档，
  命中就用 SQL 取全量、**以表格数据而非 LLM 转述的形式**返回 ⇒ 完备性由构造保证。
  进一步可给 LangGraph 加 tool 节点（`list_url_patterns` / `count_by_method` / …），
  让「要不要查库」由模型决定。
- **B. MCP server**：把 CodeLens 能力暴露成 MCP tool。**注意方向**：MCP 是
  「agent → 工具」协议，它能让 Claude/Cursor 这类**外部 agent** 来查 CodeLens，
  但**不会**让 CodeLens 自己的 `/ask` 变聪明——除非 CodeLens 反过来当 MCP *client*。
  两个需求不要互相代替。

### 26.6 抽取口径的修复（2026-09-20，已上线 + 已离线 A/B）

改的是 `entities.ts` 的四个点。**关键在于「收紧」而不是「开关」** ——
一刀切会连真实调用一起砍掉，所以每一处都对着数据定了判据。

| # | 位置 | 改法 |
|---|---|---|
| 1 | `acceptURL()` 的逃生口 | `if (/\$\{[^}]*\}/.test(s)) return true`（「仍有待解析片段就保留」）是**噪声的总闸门** —— 它让 `Map.delete(name)`→`${name}`、`Promise.all(promise)`→`${promise}` 全部入库。改为：**只有 `trusted` 时才放行纯占位符**（`trusted` = 调用点已由 axios/fetch 确证）。 |
| 2 | 新增 `MIME_TYPE_RE` | `text/csv`、`application/json;charset=utf-8` 含 `/`，能骗过「多段路径」粗筛。在 `acceptURL` 与 `buildProviderPatterns` 两处挡掉（后者是「文件类型→MIME 映射表被当成路径表」的入口）。 |
| 3 | 路由注册块（`app.get('/x')`） | 块里只按属性名匹配 `get/post/put/delete/patch/all` ⇒ `refs.map.get(id)`、`set.delete(id)`、`Promise.all([...])` 全被当成路由注册。加闸门：**首参必须是字面量**（string / 无插值模板 / 模板表达式）。 |
| 4 | `isAxiosCall` | 原为 `exprText.includes('axios.')` —— 对 `Axios.get`（大小写）和 `axios\n  .delete(url)`（换行）**都不成立**，导致这两个真实客户端被判成普通方法调用。改为规范化空白+小写后判。 |

**离线 A/B（不碰数据库）**：`url_patterns` 的抽取是文件内容的纯函数，所以可在同一语料上
跑新旧两版 dist 逐行 diff。用**索引器实际处理的那 1308 个文件**（从 `files` 表导路径），
走 `createTypeScriptFamilyParsers()`（绕开适配器会让 `.vue` 结果与线上不一致）。

| 指标 | 旧 | 新 |
|---|---|---|
| 抽出总行数 | 997 | **592**（−405，−40.6%） |
| 无路径段伪接口（`:id`/`:key`/`:url`） | **402（40%）** | **21（2.1%）** |
| MIME 伪接口 | 23 | **0** |
| 新增行 | — | **0** |

**反向守卫（比总数更重要）**：消失的 45 行「含字面段」逐条核过 ——
44 个是纯参数形态（`:id` 20 / `:key` 22 / `:state.id` 2），1 个是静态资源
`testwire/static/pw/api.json`。**零真实接口被误杀。** 保留下来的 21 行「无路径段」也逐条
读了源码，全部是真实 axios 调用（`src/service/index.ts` 的 `return axios\n.get(url)` 换行写法、
`Videos.vue:152` 的 `Axios.get`、`TestScenarioGroup/index.ts:125` 的 `${scope(...)}/${三元}`）。

> **可复用的验证方法**：不要只看「总数变少了」。
> 必须同时给出 **① 新增行数（应为 0）② 消失行里含字面路径段的那批逐条核验**。
> 只看总数会把「误杀真实数据」和「清掉噪声」混为一谈。

### 26.7 上线与线上重建（2026-09-20）

上线方式：api dist 替换 + `pm2 restart codelens-api --update-env`；
线上数据用 **`node dist/scripts/reindex.js 33 /tmp/codelens-repos/33`** 重建
（该脚本头部明写「只做 AST 增强索引，**不调用任何 LLM**」，且**不含 `clearRepoData`** ⇒ 不动第一遍成果）。

> **为什么用脚本而不是 `POST /repos/:id/reindex`**：后者会额外 `clearRepoData`，
> 连 `code_chunks` 与**已付费的向量**一起清掉。脚本只重建实体层/关系层。
> 重建前先把 `url_patterns`/`url_usages`/`functions`/`classes`/`string_constants`/`call_graph`
> 六张表 `\copy` 到 CSV 备份（可回滚）。

**线上实测（repo 33，1308 文件，180 s，0 errors）**

| | 重建前 | 重建后 |
|---|---|---|
| `url_patterns` | 386 | **283** (−26.7%) |
| `url_usages` | 636 | **383** |
| MIME 形态伪接口 | 23 | **0** |
| `:id`/`:key`/`:url` 无路径段伪接口 | 402（占 40%） | **0** |
| `code_chunks` / 非空向量 | 14395 / 14395 | **14395 / 14395（未动）** |
| `functions` / `classes` / `string_constants` | 4685 / 1282 / 2415 | **同左（未动）** |

**仍有第三类残留（本轮未修，约 9–11 行 ≈ 3.5%，旧版同类约 39%）**

来自 `buildProviderPatterns`：它把「任何返回字符串的函数 / 对象字面量取值」都当成**路径提供点**，
于是混进 4 个静态资源名（`static/css/main.css`、`static/js/main.js`、
`/monaco-editor/…/loader.min.js`、`testwire/static/pw/api.json`）、
4 个纯标签（`login` / `error` / `test` / `src`）、1 个畸形 scheme（`http:/localhost:10086`）。

> ⚠️ 为什么这轮**故意不修**：provider 的语义是「路径**片段**」，
> 合法片段本就可以没有斜杠（`task/add`、`api/:id`、`run/:apiId/:caseId` 都是真的）。
> 想挡住 `login` 就得引入「单词型标签」启发式，**误杀合法单段片段的风险无法只靠形态排除** ——
> 需要先确认 provider 的抽取来源，再配一次同样严格的 A/B。**宁可留着并说清楚，也不猜着改。**

---

## 27. 「把所有 HTTP 接口真实列出来」：口径分层 + helper 展开 + 独立交叉验证（2026-09-20）

用户诉求：`/ask` 回答「列出所有接口」只给一个**猜出来的片段**；
他要的是**完整、可核对的真实接口清单**，并明确表示「建 MCP tool 也可以」。

### 27.1 结论先说

| | 数量 |
|---|---|
| `url_patterns` 原始行（repo 33） | 283 |
| 其中带 HTTP method | 244（含 3 行是**请求封装自身**，不是接口） |
| **去重后的真实接口** | **236** |
| method 为 NULL 的行 | 39 = **21 行不是接口** + 18 行是真实路径但没判定出 method |

产出物：`docs/api-inventory/testwire-frontend-33{,-interfaces}.{html,csv,json}`
（HTML 可按 method 筛选 / 全文检索，每条附 `file:line` 出处；生成器 `scripts/interface-inventory.py`）。

### 27.2 为什么「283」不等于「283 个接口」（两个独立的失真）

**(a) 行 = 调用点 × 路径表达式，不是接口。**
`normalized_pattern` 只做了一件事：把 `${...}` 换 `:param`，**却保留了基底 helper 的实参名**。
于是 `${QUALITY_URL(aid)}/api/service/list` 与 `${QUALITY_URL(option.aid)}/api/service/list`
是两个行、一个接口。展开 helper 后 244 行 → 236 个接口（合并掉 5 组）。

**(b) method 为 NULL 的 39 行大部分根本不是接口。**

| 分类 | 行数 | 证据（`definition_code`） |
|---|---|---|
| 前端路由（Vue Router / 菜单树） | **15** | `path: "api/:id"`、`path: "/login"` |
| 构建产物 / 路径别名（`vite.config.ts`） | **4** | `entryFileNames: "static/js/main.js"`、`'@/': '/src/'` |
| 界面文案 | 1 | `label: "Read/Write"`（下拉框选项） |
| 第三方静态资源 | 1 | `monaco-editor/.../loader.min.js` |
| 真实路径（没能判定 method） | 18 | `return getCookie().then(...)` 等 |

**这 21 行就是 §26.7 里那批「残留」的真身**（当时猜是「返回字符串的函数」，实际主因是
**对象字面量的 `path:` 叶子**被 `URLResolver.collectProviders()` 当成路径提供点）。
`src/controller/Apiwire/Mounted/initializeRootMenu.ts` 贡献 11 行、`src/router/routes.ts` 贡献 3 行。

> 前端路由与后端接口在**形态上无法区分**（都长成 `/application/:aid`）——
> 想区分只能靠「这个对象是不是路由记录/菜单项」，属于**语义**判断。
> 因此我把它们**分类呈现**而不是删掉：删掉要冒误杀风险，分类只损失一点信噪比。

### 27.3 最值钱的发现：**召回本来就是完整的，坏的是粒度与呈现**

独立于索引器做了一次源码侧交叉验证：

- 源码里 `axios.{get,post,put,delete}` + `fetch(` 调用点（排除 `src/assets/monaco` 这个 vendored 文件）
  = **252 处**；`src/service/index.ts` 的 `WrapAxios` 自身 4 处是管道。
- 索引器存下来的 method 行 = 241 处（去 plumbing）。
- 两侧按「去掉基底前缀后的操作路径」归一后对比：**源码有 / DB 无 仅 9 条，DB 有 / 源码无 13 条**，
  且逐条看全是**基底前缀归属差异**（`/getInfo` ↔ `/web/plugin/getInfo`、`/dictionary/f/{p}` ↔
  `/global/dictionary/f/{p}`），不是真漏。
- 反过来源码侧正则解不出的 3 处动态 URL（`src/service/Api/PrimaryService/PrimaryCached.ts`
  先算 `url` 再 `axios.get(url)`），**索引器靠 provider 常量折叠补上了**
  （DB 里有 `/rest/global/preference/clientCache/...` 与 `/auth/preference/clientCache/...`）。

⇒ 之前那句「只有数字没有明细」的锅，**不是索引器漏抽**，而是
**① 存的粒度不对齐「接口」这个概念 ② 除了 COUNT 之外没有任何出口**。

### 27.4 helper 展开表（做清单时必须的，源码核对得出）

`src/service/Api/base.ts`：`PTRFIX=""` ⇒ `COOP_URL="/rest"`、
`GLOBAL_URL="/rest/global"`、`PREFERENCE_URL="/rest/global/preference"`、
`ACCOUNT_URL="/rest/account"`、`QUALITY_PLAYWRIGHT_API="/rest/quality/playwright/api"`、
`QUALITY_URL(appId)="/rest/quality/a/{appId}"`、`PROJECT_URL="/rest/project/p/{projectId}"`、
`PROJECT_APP_URL="/rest/project/a/{appId}"`、`APPLICATION_URL="/rest/project/a/{appId}/application"`、
`OPEN_TESTWIRE_URL="/rest/open/testwire"`、`TEST_URL_PTRFIX="/plugin"`、`TEST_URL_API="/plugin/api"`。

**同名不同义、必须按文件判定**（这是最容易搞错的一步）：

- `URL(appId)` 4 处：`ApiDefinition` → `/…/apiDefinition`、`ApiGroup` → `/…/apiGroup`、
  `Setting` 与 `StepProcessingRuleService` → `/…/api/test/setting`。
- `scope(appId)` **14 处**：`TestScenario`/`detail`/`step`/`TimedTask` → `/rest/quality/a/{appId}`；
  `snapshot`/`snapshotDetail`/`runtimeSetting`/`TestScenarioGroup{,_BuiltInTress}` → `…/api/scenario`；
  `TestScenarioReport`/`TimedTask{,Batch}ReportService` → `…/api/report`；
  `TestScenarioData` → `…/api/test/data`；`TestScenarioExecute` → `/plugin/api/log`（这个连基底都换了）。
- `scoped` 2 处：`Edition` → `/rest/quality/a/{appId}`、`plugin` → `/plugin/web/plugin`。

> 教训：**helper 名不足以确定前缀**。想解析必须带上定义文件。第一版我只映射了 3 个 `scope`，
> 46 行解不出来 ⇒ 数量对不上。这是「同一概念在代码里有 N 个同名实现」的典型坑，
> 与 §17/§23 的「同名多实现」是同一族问题。

### 27.5 仍未做

- **29 / 30 两仓的数据还是修复前的**（`url_patterns` 398 / 710），只有 33 跑了 §26.7 的重建。
  要横向对比必须先把这两仓也重建一遍（同样用 `dist/scripts/reindex.js`，不动向量）。
- 持久化出口还没做：`GET /repos/:id/url-patterns` 路由、前端表格、
  以及把这份清单变成 `/ask` 能直接回答的 tool 节点 / MCP server。
- `functions.return_type` 仍含 ts-morph 绝对路径。

### 27.6 给面试/立项用的说法

> 「用户报『这个数看着不对』，我没有直接去调 K 或换模型，而是先问**这个数是怎么来的**。
> 结果发现三件事：数虚高 26%（抽取口径）、行≠接口（粒度错位）、根本没有出口（只有 COUNT
> 没有明细）。我修了抽取口径并做了离线 A/B（新增 0 行、零真实接口误杀），
> 再用源码侧独立抽取交叉验证召回 —— 结论是**召回本来就够，坏在粒度与呈现**。
> 这三步 AI 都能做，但**『先去质疑口径而不是先去调参』这个判断**是我做的。」





---

## 28. 集合类问题的两个出口：`GET /repos/:id/url-patterns` + MCP server（2026-09-20 已上线）

用户选了「建 MCP server 暴露给外部 Agent」+「给 `/ask` 加集合类查询能力」。

### 28.1 一个前置结论：MCP 也需要那个路由

MCP server 只是**协议适配层**，它自己不会变出数据。
三选一：① 直连 Postgres —— 不行（只在服务器 `127.0.0.1:5432` 监听）；
② 用 `/repos/:id/stats` —— 不行（只有一个 COUNT，**没有明细**，正是 §26 的病根）；
③ 补一个只读明细路由，MCP 与 `/ask` 共用。
所以先补 `GET /repos/:id/url-patterns`，再谈 MCP。

> 这其实是把用户没选的那一项（前端表格）里的**必要部分**摘了出来：
> 路由是数据出口，前端表格只是渲染层，两者可以解耦。

### 28.2 `apps/api/src/analysis/url-inventory.ts` —— helper 展开

`url_patterns.pattern` 存的是**源码写法**（`${QUALITY_URL(aid)}/api/service/list`），
要给人看得先展开。**展开表不硬编码**：从该仓库**已索引的 `files.content`** 里
现查 helper 定义再递归展开。换仓库、换命名约定都不用改代码。

期间踩到**两个真坑**，都写成了自检用例（`npm run check:url-inventory`，13 项）：

| # | 坑 | 现象 | 修法 |
|---|---|---|---|
| 1 | `const PTRFIX = ""` 是合法**空串**定义 | 被 `if (name && template)` 吃掉 ⇒ `${PTRFIX}/rest` 展不开 ⇒ 整个 `/rest` 前缀变成 `:param` | 判据改成 `template !== undefined` |
| 2 | `scope` 在 **14 个文件**里各定义一次，含义不同 | 全局「名字→模板」表先到先得 ⇒ 13 个文件的路径全展开成**错但很像真的** | 如实建模 JS 作用域：非 export 的只在**本文件**可见；export 的才跨文件；同名多文件 export ⇒ 判为有歧义、剔除 |

第 2 条的修法要点：递归展开时**作用域要切到「定义所在文件」** ——
`COOP_URL` 定义在 `base.ts`，它引用的 `${PTRFIX}` 是 base.ts 里的**非 export** 常量。

还有一处**看起来像真的的假答案**，单独挡掉：仓库里
`src/service/Api/PlayWright/ApiService.ts` 的函数体内有
`const url = \`${domain}/testwire/static/pw/api.json\``。
不限作用域时，`WrapAxios` 里的 `${url}`（**运行时的值**）会被这条**函数内局部变量**
"解析"成那个静态资源路径。两道闸门：声明必须锚定**行首**（近似模块级），
外加 `RUNTIME_VALUE_NAMES` 黑名单。现在这 4 行如实返回 `realPath: null`。

### 28.3 `/ask` 的集合类分支

- `qa.ts` 新增 `enumeration` 查询类型，**排在 `url_lookup` 之前**判定
  （否则「列出所有 POST 接口」会被 URL 正则抢走）。
  判据是「列全集的动词」×「接口/端点/路由」**同时**命中 —— 宁可漏判不误判。
- `ask.ts` 在检索分支**之前**插入分支 0：走 `getUrlInventory`，直接读 `url_patterns`。
- **明细由代码拼装，不过 LLM**：让模型「总结 236 条」必然漏行，
  而**少几行的清单比没有清单更危险**（它看起来是完备的）。
  `answerQuestion` 里的 `enumeration` 提示词只作兜底（明确禁止拿 top-K 冒充全集）。
- 返回体带 `structured: true` + `inventory` 汇总，与检索分支可区分。

线上实测（repo 33）：

| 提问 | 结果 |
|---|---|
| 列出当前项目中所有接口 | 277 行清单，29 KB，`structured=true` |
| 列出所有 POST 接口 | 自动识别 method 过滤 → **124** 条 |
| 列出 /plugin/api 下的接口有哪些 | 自动识别路径过滤 → 40 条 |
| 登录功能是怎么实现的（回归） | `structured` 为空 ⇒ 仍走检索，未被误判 |

### 28.4 MCP server：`apps/api/src/mcp/codelens-mcp.ts`

**刻意不依赖 `@modelcontextprotocol/sdk`**：stdio 传输就是「换行分隔的 JSON-RPC 2.0」，
handler 只有 `initialize` / `tools/list` / `tools/call` 三个，自己写约 120 行
换来零依赖、零版本漂移、零安装。

工具：`list_repos` / `list_url_patterns`（核心，含 method、q 过滤）/ `ask_codelens`。

数据源走 HTTP：nginx 已把 API 暴露在 `/code-api/` ⇒ 客户端不需要 SSH 隧道。
（注意：**本机 https 到 `sunlingyue.cn` 被拦**，用 `http://47.116.6.132/code-api` 可直连。）

自检 `npm run check:mcp` 把 server 当**真实 MCP 客户端**驱动，20 项断言，
其中两条是关键：
- **清单完整性**：正文实际列出行数 == 声明的总数（防截断）
- **stdout 洁净**：协议通道没混进调试输出（MCP 最常见的翻车方式）

### 28.5 一个排序 bug（值得记）

`ORDER BY (p.method IS NULL)` 在 SQL 里是对的，但我在 JS 里又排了一次
`(a.method ?? '') < (b.method ?? '')` —— **空串排在 `'DELETE'` 前面**，
正好把「未判定」的 39 行顶到了清单最开头。修法：显式用 `method === null ? 1 : 0`。
`check:mcp` 里加了一条断言「首行必须是可判定 method 的接口」防回归。

### 28.6 仍未做

- 前端 `RepoPage` 还是只渲染那个数字（路由已经有了，接表格是纯前端工作）。
- `clearHelperIndexCache` 已实现但**没接**到重建索引的链路 ——
  helper 索引有 5 分钟 TTL，重建后最多陈旧 5 分钟。改动 helper 定义的场景很少，暂可接受。
- 29 / 30 两仓数据仍是修复前的。
