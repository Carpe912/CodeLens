/**
 * TypeScript / JavaScript / Vue 的**语言适配器**。
 *
 * ============================================================
 * 这个目录（`languages/typescript/`）是「认识语法」的地方。
 * 出了这个目录就再没有人 import ts-morph / @babel/parser / @vue/compiler-sfc。
 * ============================================================
 *
 * 目录职责：
 * - `chunker.ts`      ← 原 `parsers/ts-parser.ts`（Babel）：产代码块
 * - `entities.ts`     ← 原 `indexing/ast-analyzer.ts`（ts-morph）：产结构化实体
 * - `url-resolver.ts` ← 原 `indexing/url-resolver.ts`：跨文件符号表 + 表达式求值
 * - `sfc-host.ts`     ← 原 `parsers/vue-parser.ts`：解包 SFC 的 `<script>` 再交给 chunker
 * - `index.ts`        ← 本文件：把上面几块拼成符合 `LanguageParser` 的适配器
 *
 * ⚠️ **为什么 TS 和 Vue 是两个适配器、却共享一个分析器实例**：
 * - 必须是两个 `id`：`files.language` 要区分 `'typescript'` 和 `'vue'`（历史行为如此）。
 * - 必须共享一个 `ASTAnalyzer`：它的整仓符号表很贵（277 文件 ≈ 全仓源码常驻内存）。
 *   每个适配器各建一个等于把内存翻倍，而两者的符号表内容**完全相同**
 *   （都登记同一个全仓文件列表）。
 */

import { ASTAnalyzer } from './entities.js';
import { parseTsFile } from './chunker.js';
import { parseVueScriptBlocks, parseVueFile } from './sfc-host.js';
import type {
  ChunkResult,
  CodeChunk,
  EntityResult,
  LanguageParser,
  RepoScopedParser,
} from '../types.js';

/**
 * 仓级上下文持有者。
 *
 * 把 `ASTAnalyzer` 的「整仓符号表」生命周期收拢到这里：两个适配器共用一份，
 * 且 `beginRepo` **幂等** —— 因为 TS 和 Vue 两个适配器会把**同一个全仓文件列表**
 * 各登记一次，不拦一下就会白建两遍符号表。
 *
 * 历史教训：符号表原本是 `ASTAnalyzer` 的私有字段，靠调用方「记得先调
 * `registerRepoFiles()`」来维持。`scripts/rebuild-graph.ts` 一直没调，
 * 于是它写出的 `url_patterns` 全是 `${占位符}` 而无人察觉。
 * 现在生命周期是接口的一部分（`RepoScopedParser.beginRepo/endRepo`），
 * 漏调会在类型层面暴露出来。
 */
class RepoScope {
  private analyzer: ASTAnalyzer | null = null;
  /** 已登记的文件数；为 null 表示当前没有仓级上下文 */
  private registeredCount: number | null = null;

  /** 拿到分析器（懒建，避免不索引时白占内存） */
  analyzerFor(): ASTAnalyzer {
    this.analyzer ??= new ASTAnalyzer();
    return this.analyzer;
  }

  /** 建仓级上下文。同一份文件列表重复调用是 no-op */
  begin(files: ReadonlyArray<{ path: string; content: string }>): void {
    if (files.length === 0) return;
    const analyzer = this.analyzerFor();
    if (this.registeredCount === files.length) return;
    analyzer.registerRepoFiles(files.map((f) => toResolverSource(f.path, f.content)));
    this.registeredCount = files.length;
  }

  /** 释放仓级上下文（索引结束调用，避免整仓源码常驻内存） */
  end(): void {
    this.analyzer?.releaseRepoFiles();
    this.registeredCount = null;
  }
}

/**
 * 把喂给**跨文件符号表**的源码规范成合法 TS。
 *
 * 这是「两遍索引都必须解包 SFC」这条规则的第三处、也是最晚被补上的一处：
 * 第一遍（`parseVueFile`）与第二遍（`vueParser.analyzeEntities`）早就走了
 * `parseVueScriptBlocks`，但**符号表这一遍**一直拿的是 `.vue` 原文。
 *
 * ⚠️ `.vue` 必须解包，且**用空行占位而不是把 script 块拼起来**。两条理由都有实测：
 *
 * 1. **直接喂原文会挂，而且挂得极彻底。** `<template>` / `<style>` 会被 TS 的
 *    错误恢复当成代码：`@import="onImport"`（模板事件绑定）与 `.x-import {`
 *    （CSS 类选择器）都会被解析成 `ImportDeclaration`，而
 *    `ImportDeclaration.getModuleSpecifierValue()` 遇到非字符串字面量会**抛异常**。
 *    2026-09-19：repo 33 的 4 个 `.vue` 就这样让**整仓**增强索引在 2 秒内全挂
 *    （`functions` / `url_patterns` / `url_usages` / `call_graph` 全为 0），
 *    详见 `URLResolver.registerFiles` 里的说明。
 * 2. **行号必须与 `.vue` 文件一致。** 符号表产出的 provider 带行号；直接拼接
 *    两个 script 块会让第二块的行号整体前移，指向文件里不相干的行。
 *    空行占位后，ts-morph 看到的就是「行号完全对齐的纯 script 文件」，无需任何平移。
 *
 * 纯模板 / 纯样式组件（没有 script 块）→ 全空行 → 解析出空文件。
 * **这是正常情况，不是缺陷**（与 `parseVueScriptBlocks` 的约定一致）。
 *
 * 导出是为了让 A/B 探针能调用**真实实现**（`probe-resolver-sfc.ts`），
 * 而不是在探针里手抄一份模拟列 —— 「模拟通过 ≠ 上线的那份代码正确」。
 */
export function toResolverSource(path: string, content: string): { path: string; content: string } {  if (!path.endsWith('.vue')) return { path, content };

  const blank = () => content.split('\n').map(() => '').join('\n');

  let blocks;
  try {
    blocks = parseVueScriptBlocks(path, content);
  } catch {
    // 连 SFC 都解不开（语法错得离谱）⇒ 宁可整份空行，也不要把 `<template>` 放进去被当代码
    return { path, content: blank() };
  }
  if (blocks.length === 0) return { path, content: blank() };

  const lines = content.split('\n').map(() => '');
  for (const block of blocks) {
    const blockLines = block.content.split('\n');
    for (let i = 0; i < blockLines.length; i++) {
      const target = block.offset + i;
      if (target >= 0 && target < lines.length) lines[target] = blockLines[i];
    }
  }
  return { path, content: lines.join('\n') };
}

/**
 * 把「相对 script 块」的行号整体平移成「相对 `.vue` 文件」的绝对行号。
 *
 * ⚠️ 必须覆盖**每一个带行号的字段** —— 漏一个就会出现「跳转到文件:行号」指到别处：
 * `functions.lineStart/lineEnd`、`classes.lineStart/lineEnd`、
 * `stringConstants.lineStart/lineEnd`、`urlPatterns.definitionLine`、`imports.line`。
 *
 * ⚠️ `indirectSites` 的 `line` **不要平移** —— 它来自整仓符号表（本身已是绝对行号）。
 */
function shiftEntityLines(result: EntityResult, offset: number): void {
  if (offset <= 0) return;

  for (const fn of result.functions) {
    fn.lineStart += offset;
    fn.lineEnd += offset;
  }
  for (const cls of result.classes) {
    cls.lineStart += offset;
    cls.lineEnd += offset;
  }
  for (const constant of result.stringConstants) {
    constant.lineStart += offset;
    constant.lineEnd += offset;
  }
  for (const pattern of result.urlPatterns) {
    pattern.definitionLine += offset;
  }
  for (const imp of result.imports) {
    imp.line += offset;
  }
}

/**
 * import 去重。
 *
 * 一个 `.vue` 可以同时有 `<script>` 和 `<script setup>`，两边各写一次同名 import 时
 * 会产出两条等价记录；落到 `import_relations` 就是重复边。按「路径 + 符号 + 类型 + 别名」判等。
 */
function dedupeImports(imports: EntityResult['imports']): EntityResult['imports'] {
  const seen = new Set<string>();
  const deduped: EntityResult['imports'] = [];

  for (const imp of imports) {
    const key = `${imp.importPath}|${imp.importedSymbol ?? ''}|${imp.importType}|${imp.alias ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(imp);
  }

  return deduped;
}

/**
 * 整文件兜底块的**字节**上限（不是字符数）。
 *
 * 兜底块要进 `code_chunks.code_text` 并**生成向量**，所以不能把整个文件塞进去：
 * 守卫允许的最大单文件是 1 MB，直接整份喂给 embedding 既贵又无意义
 * （向量模型对 8 KB 以上的输入本来就只剩「主题漂移」）。
 *
 * ⚠️ 必须按**字节**判，不能按字符：这个仓库的中文注释是 3 字节/字符，
 * 「8000 字符」在中国语料下是 24000 字节。这是本项目里反复踩到的同一类坑
 * （另一个例子是 `string_constants` 的唯一索引按字节算，见 `entities.ts`）。
 */
const MAX_MODULE_FALLBACK_BYTES = 8_000;

/**
 * 整文件兜底块：符号级抽取**一个都没抽出来**时，用整份文件补一条。
 *
 * ============================================================
 * 为什么必须有这一层
 * ============================================================
 * 第一遍索引的产物是「符号块」，而符号级抽取天然有抽不出东西的文件：
 *
 * | 形态 | 例子（repo 33 实测） |
 * |---|---|
 * | barrel 文件 | `src/.../index.ts`：`import Main from './Main.vue'; export default Main;` |
 * | 只有 import + 取值的 SFC | `Auth/Main.vue`（42 行）：`<script setup>` 里只有 import 和 `defineProps` 解构 |
 * | 纯模板 / 纯样式组件 | `ExportData/Main.vue`（11 行）：只有 `<template>` 和空 `<style>` |
 * | 纯类型文件 | `*.d.ts` |
 * | i18n 字典 | `vcrontab/language/{cn,en,pt_br}.js`：`export default { ... }` 一个对象字面量 |
 *
 * 修前这些文件走 `indexer` 的「解析不出代码块 ⇒ 静默 continue」：
 * **不落 `files` 表、不打日志**。后果有三层，一层比一层难查：
 *
 * 1. 仓库页的「文件数」偏小（repo 33 扫描 1308、`files` 表只有 1051，差 257）；
 * 2. 这些文件在 `import_relations` 里**没有落点** ⇒ 指向它们的 import 边解析失败，
 *    依赖图在这些节点上断链；
 * 3. 它们的内容**完全不可检索** —— 搜「高级设置」搜不到那个只有一行 `<div>高级设置</div>`
 *    的组件，而这恰恰是最常见的检索诉求之一。
 *
 * 兜底后：每个通过守卫的文件**至少有一条 chunk** ⇒ 文件在 `files` 表里，
 * 内容进向量库，「这个文件是干什么的」永远有答案（哪怕只是模板文本）。
 *
 * ⚠️ 兜底块**不是**「假装它是个函数」：`symbolType` 是独立的 `'module'`，
 * 下标侧一眼能看出「这条不是符号命中，是整文件命中」。
 */
export function makeModuleFallbackChunk(filePath: string, code: string): CodeChunk {
  const lines = code.split('\n');
  const totalLines = Math.max(lines.length, 1);

  let text = code;
  if (Buffer.byteLength(text, 'utf8') > MAX_MODULE_FALLBACK_BYTES) {
    // 按字节截断后再退到行边界，避免切出半个字符 / 半行
    const buf = Buffer.from(text, 'utf8').subarray(0, MAX_MODULE_FALLBACK_BYTES);
    text = buf.toString('utf8').replace(/\uFFFD+$/, '');
    const cut = text.lastIndexOf('\n');
    if (cut > 0) text = text.slice(0, cut);
    text += '\n/* … 整文件兜底块已截断（超出 ' + MAX_MODULE_FALLBACK_BYTES + ' 字节）… */';
  }

  // 符号名取文件名（不含扩展名）：`.vue` 组件叫 `Main`、barrel 叫 `index`。
  // 用文件名而不是路径，是为了让向量文本里出现的是「Main」这种可读词元，
  // 而路径信息在 `filePath` 字段里本来就全有。
  const base = filePath.split('/').pop() ?? filePath;
  const symbolName = base.replace(/\.[^.]+$/, '') || base;

  return {
    symbolName,
    symbolType: 'module',
    lineStart: 1,
    lineEnd: totalLines,
    code: text,
    filePath,
    imports: [],
    exports: [],
    calls: [],
  };
}

/**
 * 建 TypeScript/JavaScript 与 Vue 两个适配器。
 *
 * 返回数组是因为两者共享同一个 `RepoScope`；调用方（registry）逐个 `register` 即可。
 */
export function createTypeScriptFamilyParsers(): RepoScopedParser[] {
  const scope = new RepoScope();

  /**
   * 解析 + 回填语言 + **空结果兜底**。
   *
   * 合并成一处是刻意的：`tsParser` 与 `vueParser` 都必须兜底
   * （测试与探针走 `createTypeScriptParser(id)` 时也一样），
   * 分散写就一定会漏掉一个 —— 而「漏掉一个」在这个项目里的历史表现
   * 就是 `.vue` 的符号表那一遍被忘掉。
   *
   * ⚠️ 顺序不能换：**先兜底、后回填语言**。反过来则兜底块拿不到 `language`，
   * `code_chunks.language` 会是空，下游按语言过滤时会静默漏掉这些块。
   */
  const parseWithFallback = (
    filePath: string,
    code: string,
    language: string,
    parse: (filePath: string, code: string) => ChunkResult
  ): ChunkResult => {
    const result = parse(filePath, code);
    const chunks =
      result.chunks.length > 0 ? result.chunks : [makeModuleFallbackChunk(filePath, code)];
    return {
      ...result,
      chunks: chunks.map((chunk) => ({ ...chunk, language })),
    };
  };

  const tsParser: RepoScopedParser = {
    id: 'typescript',
    // ⚠️ 与旧 `collectFiles` 的正则保持一致，**故意不含 `.mjs` / `.cjs`**。
    // 加上它们会改变入库文件集合 → 需要重新索引全仓；那是独立的一次改动，
    // 不该混在「纯搬运」里悄悄发生。
    extensions: ['.ts', '.tsx', '.js', '.jsx'],

    parseChunks(filePath, code) {
      return parseWithFallback(filePath, code, 'typescript', parseTsFile);
    },

    async analyzeEntities(filePath, code): Promise<EntityResult> {
      return scope.analyzerFor().analyzeFile(filePath, code);
    },

    beginRepo(files) {
      scope.begin(files);
    },

    endRepo() {
      scope.end();
    },
  };

  // ==================================================================
  // Vue 适配器：实测口径（2026-09-19 在 repo 29 的 166 个 .vue 上量的）
  // 探针：`apps/api/probe-vue-entities.mts`（7 部分）
  //   `./node_modules/.bin/tsx probe-vue-entities.mts /tmp/vue-samples`
  // ==================================================================
  // 修复前后（全量离线预演，166 个真实 .vue 原文）：
  //
  //   | 项 | 修复前 | 修复后 |
  //   |---|---|---|
  //   | functions | 96 | 590 |
  //   | 有函数产出的文件数 | 34 / 166 | 128 / 166 |
  //   | classes | 198 | 66 |
  //   | └ anonymous 垃圾 | 194 | 0 |
  //   | string_constants | 1514 | 1514（**无变化**） |
  //   | url_patterns（内容派生） | 0 | 0（**无变化**） |
  //
  // 根因（两个叠加，缺一不可）：
  //   ① **`.vue` 扩展名** → ts-morph 语言服务下 `getReturnType()` 抛 `TypeError: …'escapedName'`，
  //      被 `analyzeFile` 的大 try/catch 吞掉 ⇒ 该文件函数**整体丢失**（94/166 个文件）。
  //   ② **不解包 SFC** → `<template>` 被当 TS 解析 ⇒ 194 条 `anonymous` 垃圾类。
  //
  // ⚠️ **`url_patterns ≈ 0` 的根因是语料，不是解析器**：
  //    repo 29 的 .vue 里**一个 URL 字面量都没有** —— 含 `/api/` 字面量的 .vue = **0 个**
  //    （仅有的 `/api/` 出现全是 import 说明符 `from '../../api/alert'`），
  //    直接 `api.` / `http.` 调用也是 **0 个**。视图层一律
  //    `import { fetchAlertList } from '../../api/alert'` 调封装，路径字面量全在
  //    `api/*.js` 里（那才是 397/398 条 url_patterns 的来源）。
  //    ⇒ 解包 SFC 之后 url_patterns **依然涨不上来**，这是预期行为，不是 bug。
  //
  // ⚠️ 曾走通的弯路（别再试）：
  //    - 「保留 `.vue` 名 + 显式 `scriptKind: TS`」**修不了**（仍 2/7 崩溃）——
  //      触发点在语言服务看到的**文件名**，不在解析模式；
  //    - 「把 ts-morph 的名字整个换成 `.ts` 假名」会**静默丢掉**间接调用点与路径提供点
  //      （`indirectByFile` / `resolveURLPattern` / `providersByFile` 都按真实 filePath 查表）
  //      ⇒ 所以必须把「查表路径」与「解析器看到的文件名」**分开**（见 `analyzeFile` 的 options）。
  const vueParser: RepoScopedParser = {
    id: 'vue',
    extensions: ['.vue'],
    // 不声明 sniff：`.vue` 扩展名已经足够判定，内容嗅探是留给将来「同一扩展名
    // 承载多种语言」的容器文件（比如未来的 `.java` 模板）用的。

    parseChunks(filePath, code) {
      // SFC 由 sfc-host 解包成 script 块，chunk 行号已回填到 .vue 文件本身。
      // 兜底块覆盖**整个 .vue**（含 `<template>`）—— 纯模板组件也能被搜到。
      return parseWithFallback(filePath, code, 'vue', parseVueFile);
    },

    async analyzeEntities(filePath, code): Promise<EntityResult> {
      const analyzer = scope.analyzerFor();
      const blocks = parseVueScriptBlocks(filePath, code);

      // 纯模板 / 纯样式组件：没有 script 就没有实体可抽。
      // ⚠️ 「按路径派生」的两项（indirectSites / provider patterns）与内容无关，
      //    仍要保留 —— 否则该文件会在间接调用点、路径提供点上凭空消失。
      if (blocks.length === 0) {
        const derived = analyzer.pathDerivedFor(filePath);
        return {
          stringConstants: [],
          urlPatterns: derived.urlPatterns,
          functions: [],
          classes: [],
          imports: [],
          indirectSites: derived.indirectSites,
        };
      }

      const merged: EntityResult = {
        stringConstants: [],
        urlPatterns: [],
        functions: [],
        classes: [],
        imports: [],
        indirectSites: [],
      };

      for (const [index, block] of blocks.entries()) {
        const result = await analyzer.analyzeFile(filePath, block.content, {
          // ⚠️ **中性扩展名是这里的关键**：ts-morph 按扩展名决定文件如何进入语言服务，
          //    `.vue` 名下 `getReturnType()` 会抛 `TypeError: …'escapedName'`，
          //    被 `analyzeFile` 的大 try/catch 吞掉后该文件函数**整体丢失**
          //    （2026-09-19 实测：94/166 个 .vue 受影响，functions 96→590）。
          //    ⚠️ 注意 `filePath` 本身仍必须保持真实路径 —— 它同时是
          //    `indirectByFile` / `resolveURLPattern` / `providersByFile` 的键。
          tsFileName: `${filePath}__sfc${index}.ts`,
          // 路径派生产出只取一次（第 0 块），否则 url_patterns 会违反「一个接口一行」的不变式。
          skipPathDerived: index > 0,
        });

        // 块内行号 → .vue 绝对行号
        shiftEntityLines(result, block.offset);

        merged.stringConstants.push(...result.stringConstants);
        merged.urlPatterns.push(...result.urlPatterns);
        merged.functions.push(...result.functions);
        merged.classes.push(...result.classes);
        merged.imports.push(...result.imports);
        if (index === 0) merged.indirectSites = result.indirectSites;
      }

      // `<script>` 与 `<script setup>` 可能各自写了同一条 import ⇒ 去重后再落库
      merged.imports = dedupeImports(merged.imports);

      return merged;
    },

    // 仓级符号表由同族的 TS 适配器与 Vue 适配器**共用**同一个 analyzer。
    // 两个适配器都实现 beginRepo/endRepo 是为了「只用 Vue 的仓库也能建起上下文」，
    // 而 `scope.begin` 是幂等的，所以重复调用不会白建两遍。
    beginRepo(files) {
      scope.begin(files);
    },

    endRepo() {
      scope.end();
    },
  };

  return [tsParser, vueParser];
}

/**
 * 单语言入口（测试与探针用）。
 *
 * @param id - `'typescript'` 或 `'vue'`
 */
export function createTypeScriptParser(id: 'typescript' | 'vue' = 'typescript'): LanguageParser {
  const found = createTypeScriptFamilyParsers().find((p) => p.id === id);
  if (!found) throw new Error(`unknown typescript-family parser id: ${id}`);
  return found;
}
