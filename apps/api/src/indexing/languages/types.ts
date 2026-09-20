/**
 * 语言适配层的**中立契约**。
 *
 * ============================================================
 * 这个文件里不允许出现任何具体语言的语法概念。
 * ============================================================
 *
 * 它是「加一门语言需要动多少代码」的分界线：
 * - 分界线**以内**（`languages/<lang>/`）：可以随便 import 解析库（ts-morph / babel /
 *   java-parser …），认识语法、认识 AST。
 * - 分界线**以外**（indexer / enhanced-indexer / relationship-builder /
 *   dependency-tracker / retrieval / web）：只认下面这些结构体，**不认识任何语言的语法**。
 *
 * 现状核查（2026-09-19）：`apps/api/src` 26,745 行里只有 4 个文件 import 了语法解析库
 * （`languages/typescript/{chunker,entities,url-resolver,sfc-host}.ts`，合计 3,395 行 = 12.7%），
 * 其余 87% 本来就已经中立 —— 所以「支持 Java」的正确做法是**在这里抽一层接缝**，
 * 而不是重写解析层。
 *
 * ⚠️ 反面警告：**不要**试图把这些类型再往下抽象成「通用 AST 节点模型」。
 * 下游要的从来不是 AST，而是「这个符号叫什么、在第几行、调了谁、对应哪个 URL」。
 * 中立接缝在**输出结构**，不在输入 AST。
 */

// ============================================
// 语言标识
// ============================================

/**
 * 语言标识。
 *
 * ⚠️ 这里**故意**是开放字符串而不是 `'typescript' | 'javascript' | 'vue'` 这样的闭合联合：
 * 闭合联合每次加语言都要改公共契约、波及所有引用方；开放字符串让「加语言」退化成
 * 往注册表里多 `register` 一行。
 *
 * 传入 DB 时落 `files.language` 列（`TEXT NOT NULL`，可放任意值）。
 */
export type LanguageId = string;

// ============================================
// 第一遍产物：代码块（喂 code_chunks + 粗粒度向量）
// ============================================

/**
 * 一个独立的代码单元（函数、类、方法、变量等）。
 *
 * 这是「检索的最小可见单位」——`code_chunks` 表按它落行，粗粒度向量按它生成。
 */
export interface CodeChunk {
  /** 符号名称（函数名、类名、变量名等） */
  symbolName: string;

  /**
   * 符号类型，用于区分不同的代码结构。
   *
   * ⚠️ 新增取值前先确认下游不会因此断链。当前下游只有一处**枚举式**消费
   * （`apps/web/src/components/EvidenceCallTree.tsx` 的 `SYMBOL_TYPE_STYLE`），
   * 它有 `unknown` 兜底 ⇒ 加值最多是「徽章颜色变成灰的」，不会报错。
   * 数据库侧 `code_chunks.symbol_type` 是 `TEXT` 且**无 CHECK 约束**，加值无需迁移。
   *
   * 2026-09-19 补的两个值，各自都对应一处实测到的静默丢数据：
   * - `enum`：Babel 的 `TSEnumDeclaration` 原先**没有任何 visitor** ⇒
   *   纯枚举文件抽不出 chunk ⇒ 整份文件从索引里消失（repo 33 实测 25 个 `enum/*.ts`）。
   * - `module`：整文件兜底块（见 `index.ts` 的 `makeModuleFallbackChunk`）。
   *   符号级抽取必然有「抽不出来」的文件（barrel 文件、`<script setup>` 只有 import 的组件、
   *   纯 i18n 字典），兜底保证**每个入库文件至少有一个可检索、可向量化的块**。
   */
  symbolType:
    | 'function'
    | 'class'
    | 'method'
    | 'variable'
    | 'interface'
    | 'type'
    | 'enum'
    | 'component'
    | 'module';

  /** 代码块起始行号（从 1 开始） */
  lineStart: number;

  /** 代码块结束行号（包含） */
  lineEnd: number;

  /** 代码块的完整源代码文本 */
  code: string;

  /** 代码块所在的文件路径 */
  filePath: string;

  /**
   * 代码块所属的编程语言。
   *
   * ⚠️ 由适配层统一回填（`LanguageParser.parseChunks()` 的包装里），
   * **解析器自己不必也不应该写** —— 历史上 `ts-parser.ts` 在 9 个 visitor 里
   * 各自硬写 `'typescript'`，于是 `.js` 文件在 `files.language` 里被标成 `typescript`。
   */
  language?: LanguageId;

  /** 该代码块内部使用的导入符号列表 */
  imports: string[];

  /** 该代码块导出的符号列表 */
  exports: string[];

  /** 该代码块内部调用的函数/方法名称列表，用于构建调用图 */
  calls: string[];
}

/**
 * 第一遍解析结果（文件级）。
 *
 * 由 `LanguageParser.parseChunks()` 返回。**不再携带 `language`** ——
 * 语言由 registry 按适配器回填，避免各解析器各写各的。
 */
export interface ChunkResult {
  /** 被解析文件的路径（沿用旧 `ParseResult` 的字段，调用方日志/排错会用到） */
  filePath: string;

  /** 从文件中解析出的所有代码块 */
  chunks: CodeChunk[];

  /** 文件中的导入语句 */
  imports: Array<{ source: string; specifiers: string[] }>;

  /** 文件导出的所有符号名称 */
  exports: string[];
}

// ============================================
// 第二遍产物：结构化实体（喂 functions/classes/constants/url_patterns + 细粒度向量）
// ============================================
//
// 下面这些接口原本定义在 ts-morph 实现里，但它们**逐字段都是业务概念**、
// 没有一个字段提到 TypeScript 语法 —— 所以上提到这里，作为语言无关的输出契约。
// 这正是「Java 适配器只需要产出同样结构」的依据。

/** 字符串常量 */
export interface StringConstant {
  /** 符号名称（变量名、属性名等） */
  symbolName?: string;
  /** 字符串值 */
  stringValue: string;
  /** 常量类型（url_segment、error_code 等） */
  constantType: string;
  lineStart: number;
  lineEnd: number;
  /** 父对象名称（如果是对象属性或枚举值） */
  parentObject?: string;
  exportType?: 'named' | 'default' | 'none';
  /** 完整代码 */
  code: string;
}

/** URL 组成部分 */
export interface URLComponent {
  /** 组件类型 */
  type: 'literal' | 'variable' | 'param';
  /** 组件值 */
  value: string;
  /** 来源信息 */
  source?: {
    file?: string;
    symbol?: string;
  };
}

/** URL 模式（一个接口一行） */
export interface URLPattern {
  /** 原始模式 */
  pattern: string;
  /** 规范化后的模式 */
  normalizedPattern: string;
  /** HTTP 方法（GET、POST 等） */
  method?: string;
  /** URL 组成部分 */
  components: URLComponent[];
  /** 路径参数列表 */
  pathParams: string[];
  /** 查询参数列表 */
  queryParams: string[];
  /** 定义行号 */
  definitionLine: number;
  /** 定义代码 */
  definitionCode: string;
}

/** 函数参数 */
export interface ParameterInfo {
  name: string;
  type?: string;
  isOptional: boolean;
  defaultValue?: string;
}

/** 函数信息 */
export interface FunctionInfo {
  name: string;
  /** 完整名称（包括类名等） */
  fullName: string;
  signature: string;
  returnType?: string;
  functionType: 'function' | 'method' | 'arrow' | 'constructor';
  visibility?: 'public' | 'private' | 'protected';
  isAsync: boolean;
  isExported: boolean;
  parameters: ParameterInfo[];
  /** 圈复杂度 */
  cyclomaticComplexity: number;
  linesOfCode: number;
  lineStart: number;
  lineEnd: number;
  code: string;
}

/** 类属性 */
export interface PropertyInfo {
  name: string;
  type?: string;
  visibility?: string;
  isStatic: boolean;
  isReadonly: boolean;
}

/** 类 / 接口 / 类型别名 / 枚举 */
export interface ClassInfo {
  name: string;
  fullName: string;
  classType: 'class' | 'interface' | 'type' | 'enum';
  extendsClass?: string;
  implementsInterfaces: string[];
  properties: PropertyInfo[];
  /** 方法名列表 */
  methods: string[];
  decorators: string[];
  lineStart: number;
  lineEnd: number;
  code: string;
}

/** 模块导入 */
export interface ImportInfo {
  importedSymbol?: string;
  importType: 'named' | 'default' | 'namespace' | 'side-effect';
  importPath: string;
  isExternal: boolean;
  alias?: string;
  line: number;
}

/**
 * 一处「路径提供点」：路径被**构造**的地方，而不只是被调用的地方。
 *
 * 为什么需要它：`config/apiConfig.js` 这类**路径表**文件全篇没有一个 HTTP 调用，
 * 只看调用点会让它产生 0 条记录 ——「搜 /api/v1/users/:userId/profile 找不到它定义在哪」
 * 正是这么来的。上了 provider 之后该文件 0 → 19 条（检索层救不了这种缺口）。
 */
export interface URLProvider {
  file: string;
  line: number;
  value: string;
  code: string;
  kind: 'config_value' | 'returned';
}

/**
 * 一处「跨过程归属」：把 URL 挂到它真正的中介点上，而不是调用点上。
 *
 * - `indirect_call`：调用行 ← 被调封装方法最终请求的 URL
 *   （`this.orderApi.getOrderItem(...)` → `/api/v1/orders/:orderId/items/:itemId`）
 * - `template_helper`：被调函数的**定义行** ← 调用方传进来的字面路径
 *   （`fromTemplate('/api/v1/users/:userId/...')` → 记到 `fromTemplate` 定义处）
 *
 * 它解决的是「字面交集为零」的三类位置：业务方法只调自己的封装 / 路径模板处理器 /
 * 版本循环路由。⚠️ 只在名字唯一时归属 —— **挂错文件比漏掉更有害**。
 */
export interface IndirectCallSite {
  /** 落点文件 */
  file: string;
  /** 落点行 */
  line: number;
  /** 落点行代码 */
  code: string;
  /** 被归属的函数名 */
  callee: string;
  /** 归属的 URL */
  url: string;
  kind: 'indirect_call' | 'template_helper';
}

/**
 * 第二遍解析结果（文件级）：从源文件里抽出的**全部结构化实体**。
 *
 * 旧名 `ASTAnalysisResult`。改名是为了消除「AST」这个实现细节 ——
 * 下游几条链（relationship-builder / dependency-tracker / 落库 / 向量）从来不关心
 * 它是怎么解析出来的，只关心这 6 个数组。
 */
export interface EntityResult {
  /** 字符串常量列表 */
  stringConstants: StringConstant[];
  /** URL 模式列表 */
  urlPatterns: URLPattern[];
  /** 函数列表 */
  functions: FunctionInfo[];
  /** 类列表 */
  classes: ClassInfo[];
  /** 导入列表 */
  imports: ImportInfo[];
  /** 跨过程 URL 落点（间接调用 / 模板句柄） */
  indirectSites: IndirectCallSite[];
}

// ============================================
// 适配器契约
// ============================================

/**
 * 一门语言的解析适配器。
 *
 * 实现这个接口 = 支持一门新语言。除此之外**不需要改任何文件**
 * （扩展名清单由 `supportedExtensions` 自动汇总）。
 */
export interface LanguageParser {
  /** 语言标识，会落 `files.language` */
  readonly id: LanguageId;

  /** 该适配器负责的扩展名，**含点号**（如 `'.ts'`）。registry 据此建索引 */
  readonly extensions: readonly string[];

  /**
   * 可选：内容嗅探。
   *
   * 扩展名不足以判定语言时用（`.vue` 这类「宿主容器」——外层是 SFC，
   * 内部可能是 TS 也可能是 JS）。默认实现只按扩展名匹配。
   */
  sniff?(filePath: string, code: string): boolean;

  /** 第一遍：产出代码块（喂 `code_chunks` + 粗粒度向量） */
  parseChunks(filePath: string, code: string): ChunkResult;

  /** 第二遍：产出结构化实体（喂 functions/classes/string_constants/url_patterns + 细粒度向量） */
  analyzeEntities(filePath: string, code: string): Promise<EntityResult>;
}

/**
 * 需要「整仓视野」的适配器。
 *
 * ⚠️ 生命周期必须显式化。历史教训：整仓符号表原本是 ASTAnalyzer 的私有字段，
 * 靠调用方「记得先调 `registerRepoFiles()`」来维持 —— 结果 `scripts/rebuild-graph.ts`
 * 一直没调（它直接 `new ASTAnalyzer()`），于是它写出的 `url_patterns` / `url_usages`
 * 全是 `${占位符}` 而没人发现。把生命周期写进接口，才能让这类疏漏变成**类型可见**的问题。
 *
 * - TS 实现：`beginRepo` 建跨文件符号表（跨文件常量解析必需）
 * - 将来的 Java 实现：`beginRepo` 建注解索引（类级 `@RequestMapping` 前缀需要整仓视野）
 */
export interface RepoScopedParser extends LanguageParser {
  /** 索引开始前调用一次，拿到**全仓**文件。可选：不需要整仓视野的适配器可以不实现 */
  beginRepo?(files: ReadonlyArray<{ path: string; content: string }>): void;

  /** 索引结束后调用一次，释放符号表（避免整仓源码常驻内存） */
  endRepo?(): void;
}

/** 语言注册表：扩展名 → 适配器的唯一映射来源 */
export interface LanguageRegistry {
  /** 注册一个适配器。同一扩展名重复注册时后注册者覆盖前者 */
  register(parser: RepoScopedParser): void;

  /** 按文件路径找适配器；找不到返回 null（= 该文件不参与索引） */
  forFile(filePath: string): RepoScopedParser | null;

  /** 按语言标识找适配器 */
  byId(id: LanguageId): RepoScopedParser | null;

  /** 已注册的全部适配器 */
  all(): RepoScopedParser[];

  /**
   * 全部受支持的扩展名（含点号）。
   *
   * ⚠️ 这是**唯一**一份扩展名清单。历史上它散在三处且互不相同：
   * `indexer.ts:365`（唯一入库闸门）/ `relationship-builder.ts:1058`（多 .mjs/.cjs/.json）/
   * `url-resolver.ts:1373`。三份清单意味着「扫描到的文件」和「能解析的文件」可能不一致。
   */
  readonly supportedExtensions: readonly string[];
}
