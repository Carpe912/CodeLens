export type Repo = {
  id: number;
  name: string;
  source: 'gitlab' | 'zip';
  status: 'ready' | 'indexing' | 'failed';
  created_at: string;
};

/**
 * `GET /repos/:id` 的完整返回。
 *
 * 比列表接口多的字段都是仓库页「顶栏身份区」要用的：分支、来源地址、索引进度快照。
 * ZIP 来源的仓库 `url` 为 null（没有可跳转的远端），此时不要渲染外链按钮。
 */
export type RepoDetail = Repo & {
  url: string | null;
  gitlab_url: string | null;
  description: string | null;
  branch: string | null;
  default_branch: string | null;
  index_progress?: IndexProgress | null;
  /** 最近一次增量索引的报告（`POST /repos/:id/refresh` 跑完后写入） */
  last_incremental?: IncrementalReport | null;
};

// =====================================================================
// 增量索引：上游侧（git）与索引侧（实体差集）
// =====================================================================

/**
 * 上游的一个文件变更。
 *
 * `status` 是简化过的语义：git 的 `C`（复制）被归一成 `added`、
 * `T`（类型变化，如普通文件→符号链接）被归一成 `modified`。
 * 界面要展示的是「新增/修改/删除/重命名」这四类，不需要知道 git 内部的字母。
 */
export type GitFileChange = {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** 仅重命名有值：原路径。界面上显示成「旧 → 新」 */
  fromPath?: string;
  /**
   * 这个文件会不会进索引。
   *
   * ⚠️ 与「文件变了没有」无关 —— 索引器只认 TS/JS/TSX/JSX 与 `.vue`。
   * 界面必须把「改了 12 个文件」和「其中 9 个会进索引」分开说，
   * 否则用户会以为改了就一定会被搜到。
   */
  indexable: boolean;
};

export type GitCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
};

/** 上游文件变更的计数汇总 */
export type GitDiffSummary = {
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  total: number;
  indexable: number;
};

/** 参与实体差集的一条实体 */
export type EntityItem = {
  kind: 'function' | 'class' | 'constant' | 'urlPattern';
  path: string;
  /** 符号名；URL 接口是「方法 + 规范化路径」 */
  symbol: string;
  line: number;
};

/**
 * 索引侧的变化：重建前后实体层的差集。
 *
 * 「位移」是**单独一类**而不是算进新增/删除：在文件开头插一行注释会让
 * 该文件里所有符号的行号 +1，若按「路径+符号+行号」比集合，就会显示成
 * 「新增 47 个、删除 47 个」，而实际一个符号都没变。
 */
export type EntityDelta = {
  added: EntityItem[];
  removed: EntityItem[];
  /** 符号还在、只是起始行号变了 */
  moved: Array<{ item: EntityItem; fromLine: number }>;
  counts: { added: number; removed: number; moved: number };
  /** 明细被截断（计数仍是真实总数） */
  truncated: boolean;
};

/** 一次增量对索引做了什么 */
export type IndexingOutcome = {
  added: string[];
  modified: string[];
  deleted: string[];
  /** 自己没有改动，但因为引用了改动过的文件而被牵连重建 */
  propagated: string[];
  rebuiltFiles: number;
  entities: EntityDelta;
  durationMs: number;
};

/** `repos.last_incremental` 的形状 */
export type IncrementalReport = {
  at: string;
  /** `full` 表示这一次落到了全量（本地副本缺失或不是 git 工作区） */
  mode: 'incremental' | 'full';
  branch?: string;
  fromSha?: string;
  toSha?: string;
  ahead?: number;
  behind?: number;
  commits?: GitCommit[];
  gitFiles?: GitFileChange[];
  gitSummary?: GitDiffSummary;
  outcome?: IndexingOutcome;
  /** 需要额外说明的情况，或失败原因 */
  note?: string;
};

/**
 * `POST /repos/:id/upstream-check` 的返回。
 *
 * 用「可辨识联合」而不是一堆可选字段：`supported` 为 false 时**没有**
 * `behind` / `files`，如果建模成可选字段，组件里就会到处写
 * `data.behind ?? 0`，把「不支持增量」静默显示成「0 个更新」——
 * 那正好是最误导人的那种错。
 */
export type UpstreamCheckResponse =
  | { supported: false; reason: string; source?: string; error?: string }
  | ({
      supported: true;
      branch: string;
      localSha: string;
      upstreamSha: string;
      ahead: number;
      behind: number;
      commits: GitCommit[];
      files: GitFileChange[];
      summary: GitDiffSummary;
      lastIncremental: IncrementalReport | null;
    });

/** 索引规模统计（`GET /repos/:id/stats`）—— 说明「这个索引里有什么」 */
export type RepoStats = {
  repoId: number;
  files: number;
  chunks: number;
  /**
   * ⚠️ `url_patterns` **原始行数** —— 不是接口数！
   * 一行 ≠ 一个接口（helper 实参名不同会重复），且混着前端路由/构建产物/文案。
   * 展示「接口数」请用 `interfacesCallable`；这个字段只留给对账用。
   */
  urlPatterns: number;
  urlUsages: number;
  callEdges: number;
  /** 去重后 method 已判定的接口数（与清单面板的 238 一致） */
  interfaces?: number;
  /** 可调用接口数 = `interfaces` + method 未判定但路径确认是接口的（= 238 + 16 = 254） */
  interfacesCallable?: number;
};

/**
 * 「method 未判定」的行到底是不是接口。
 *
 * 后端 `classifyUndecidedRow` 是**唯一**的判定来源 —— 前端不要自己再写一套
 * 字符串规则，否则界面和 `/ask` 的回答会给出互相矛盾的数字。
 */
export type UndecidedKind = 'interface' | 'not-interface' | 'unknown';

/**
 * `url_patterns` 里的一条记录（`GET /repos/:id/url-patterns`）。
 *
 * ⚠️ **一行 ≠ 一个接口**：索引器按源码写法入库，同一个接口会因 helper 实参名
 * 不同（`${URL(aid)}` / `${URL(option.aid)}`）被算成多行，后端已按
 * (method, realPath) 合并。所以展示的条数是合并后的，不是原始行数。
 */
export type UrlPatternRow = {
  id: number;
  /** null = 索引器没能判定出 HTTP method，此时 `classification` 必有值 */
  method: string | null;
  /** 源码里的原始写法，保留作证据（能回源码核对） */
  pattern: string;
  normalizedPattern: string;
  /** helper 展开后的真实路径；依赖运行时变量时为 null */
  realPath: string | null;
  definitionFile: string | null;
  definitionLine: number | null;
  usageCount: number;
  usageFiles: string[];
  classification?: { kind: UndecidedKind; reason: string };
};

/** 全量接口清单（**不是** top-K 检索结果，条数即全集） */
export type UrlInventory = {
  repoId: number;
  /** `url_patterns` 原始行数（未合并） */
  total: number;
  /** 合并后 method 已判定的接口数 */
  distinctInterfaces: number;
  byMethod: Record<string, number>;
  rows: UrlPatternRow[];
};

/**
 * `POST /root-cause` 的返回。
 *
 * 注意它与 `/ask` **形状不同**：`/ask` 给的是 `answer`，根因给的是 `rootCause`。
 * 早先的代码把 `rootCause` 硬塞进 `answer` 渲染，于是「根因分析」在界面上
 * 和普通问答长得一模一样，使用者无法分辨 —— 这里分开建模，界面才能分开渲染。
 */
export type RootCauseResponse = {
  query: string;
  rootCause: string;
  evidence: SearchHit[];
};

export type IndexProgress = {
  total: number;
  processed: number;
  percentComplete: number;
  estimatedTimeRemaining: number | null;
  startTime: string | null;
  phase?: 'basic' | 'enhanced';
};

export type SearchHit = {
  id: number;
  file_path: string;
  symbol_name: string;
  symbol_type: string;
  line_start: number;
  line_end: number;
  code_text: string;
  similarity?: number;
  /** URL 搜索附带的口径信息（usageContext / relatedKind / constantValue 等） */
  metadata?: SearchHitMetadata;
};

/**
 * URL 检索的口径字段。
 *
 * `relatedKind` 非空表示这条**不是直接命中**，而是关联层结果 ——
 * 它和查询的路径**没有字面交集**，是靠调用关系或版本占位推出来的：
 * - `indirect_call`：某处调用行通过封装的 API 方法间接请求了这个接口
 * - `template_helper`：路径模板处理器（字面模板由调用方传入）
 * - `version_family`：版本循环生成的路由（与查询同位置是 `${version}` 占位段）
 */
export type SearchHitMetadata = {
  usageContext?: string;
  relatedKind?: 'indirect_call' | 'template_helper' | 'version_family';
  constantValue?: string;
  method?: string | null;
  relatedReason?: string;
};

export type QAResponse = {
  questionId?: number;
  query: string;
  answer: string;
  evidence: SearchHit[];
  /**
   * 这条结果是谁产出的。三种模式的结果形状相同，但**语义与渲染方式不同**：
   * - `ask`：LLM 的问答回答
   * - `search`：纯检索命中，没有生成内容（`answer` 为空）
   * - `root-cause`：根因分析结论（后端字段是 `rootCause`，前端归一化到 `answer`）
   * 不区分就会把「根因分析」渲染得和普通问答一模一样。
   */
  kind?: 'ask' | 'search' | 'root-cause';
  historicalFeedback?: Array<{
    query: string;
    answer: string;
    feedback: Array<{ feedback_text: string; is_helpful: boolean }>;
  }>;
};

export type SearchHistoryItem = {
  id: string;
  query: string;
  mode: 'search' | 'ask' | 'root-cause';
  timestamp: number;
  repoId: string;
};

// ============================================================
// 影响面分析（GET /impact/symbol、GET /impact/file）
// ============================================================
// 这组接口此前只存在于后端，前端没有任何入口 —— 「改这里会波及什么」
// 是代码检索工具最有价值的能力，却在界面上点不到。

/**
 * 受影响的一个符号
 *
 * `pathChain` 是**从目标到它的完整链条**，用来回答「为什么它会被影响」。
 * 注意后端曾经在这里输出 `chunk#442855` 这种裸主键（等于没解释），
 * 现在返回的是「符号名 (类型 @ 路径:行号)」，界面直接展示即可。
 */
export type AffectedSymbol = {
  chunkId: number;
  symbolName: string;
  symbolType: string;
  filePath: string;
  startLine: number;
  /** 1 = 直接调用，>1 = 间接 */
  depth: number;
  pathChain: string[];
};

/** 受影响的一个文件 */
export type AffectedFile = {
  fileId: number;
  path: string;
  depth: number;
  pathChain: string[];
};

/**
 * 影响面报告
 *
 * ⚠️ `warnings` / `unresolvedEdges` / `truncated` **不是**可选装饰，是这个结论的
 * 可信度说明。接口的设计原则是「不做静默降级」：调用图里有多少条边没能解析、
 * 结果有没有被截断，都必须如实呈现，否则使用者会把「数据缺失」当成「没有影响」。
 * 界面上必须把它们显示出来，不能隐藏。
 */
export type ImpactReport<T> = {
  target: string;
  maxDepth: number;
  byDepth: Array<{ depth: number; nodes: T[] }>;
  totalAffected: number;
  truncated: boolean;
  unresolvedEdges: number;
  warnings: string[];
};

/** `/impact/file` 的返回额外带一个方向字段 */
export type FileImpactReport = ImpactReport<AffectedFile> & {
  direction?: 'dependents' | 'dependencies';
};

/** `/impact/symbol` 的返回 */
export type SymbolImpactReport = ImpactReport<AffectedSymbol>;

/**
 * 符号消歧候选
 *
 * 一个符号名可能对应多个定义（仓库 29 里 `path` 有 28 个、`constructor` 有 10 个）。
 * 此时后端返回 409 + 候选列表，**不猜** —— 猜错比报错更糟。界面据此让用户选一个。
 */
export type SymbolCandidate = {
  chunkId: number;
  symbolName: string;
  symbolType: string;
  filePath: string;
  startLine: number;
};

/** `ImpactError` 的错误响应体（409 时附带候选） */
export type ImpactErrorBody = {
  error: string;
  code?: 'NOT_FOUND' | 'AMBIGUOUS' | 'BAD_REQUEST';
  symbolName?: string;
  candidates?: SymbolCandidate[];
};
