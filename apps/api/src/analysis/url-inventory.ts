/**
 * URL 接口清单：把 `url_patterns` 从「一个数字」变成**可枚举的结构化清单**
 *
 * ============================================================
 * 为什么需要它（而不是让 /ask 去检索）
 * ============================================================
 * 「列出所有接口」是**集合类问题**，而检索式问答只会给出 top-K ——
 * top-K 回答的是「最相似的 K 条」，**在数学上无法保证完备**。
 * 调 K、加 rerank、换嵌入模型都不解决；想完备只能走结构化查询（SQL）。
 *
 * ============================================================
 * 为什么还要「展开 helper」
 * ============================================================
 * `url_patterns.pattern` 里存的是**源码写法**，例如
 *   `${QUALITY_URL(aid)}/api/service/list`
 * 直接列出来人看不懂，而且同一个接口因为实参名不同会被算成多行
 * （`${QUALITY_URL(aid)}/…` 与 `${QUALITY_URL(option.aid)}/…`）。
 *
 * 本模块把开头那一段 `${HELPER(...)}` 展开成真实前缀。
 * **展开表不硬编码**：它从该仓库**已索引的文件内容**里现查 helper 定义
 * （`const QUALITY_URL = (appId) => \`${COOP_URL}/quality/a/${appId}\``），
 * 然后递归展开。所以换一个仓库、换一套命名约定都不需要改代码。
 *
 * 查不到定义就**如实返回 null**，由调用方回退到原始 pattern —— 不猜。
 */

import type { Pool } from 'pg';
import { pool as defaultPool } from '../server/context.js';

/**
 * 对「method 未判定」的行，回答**它到底是不是一个接口**。
 *
 * 为什么要单独建模：这批行混着两种完全不同的东西 ——
 *   · **真接口**，只是 method 写在变量里、索引器没推断出来；
 *   · **根本不是接口**的东西：前端路由 `path:` 叶子、vite 构建产物、界面文案、外部 CDN。
 * 直接当接口计数会虚高；直接删掉又会漏掉真接口。所以既不能合并也不能丢弃，只能标注。
 */
export type UndecidedKind = 'interface' | 'not-interface' | 'unknown';

export interface UndecidedClassification {
  kind: UndecidedKind;
  /** 判定依据（面向人，可直接展示在界面上） */
  reason: string;
}

/** 一条 URL 记录（出网形状，字段名 camelCase 与其它路由一致） */
export interface UrlPatternRow {
  id: number;
  /** NULL 表示索引器**没能判定出 HTTP method** —— 这类行不一定是接口，见 `classifyUndecidedRow` */
  method: string | null;
  /** 源码里的原始写法，保留作证据 */
  pattern: string;
  /** 索引器归一化后的形态（`${...}` → `:param`），**保留 helper 实参名** */
  normalizedPattern: string;
  /** helper 展开后的真实路径；无法展开（依赖运行时变量）时为 null */
  realPath: string | null;
  definitionFile: string | null;
  definitionLine: number | null;
  usageCount: number;
  usageFiles: string[];
  /**
   * 仅当 `method === null` 时有值 —— 对「这是不是接口」的可复核判定。
   * method 已判定的行不需要它（已经确定是接口了）。
   */
  classification?: UndecidedClassification;
}

export interface UrlInventory {
  repoId: number;
  /** 原始行数（含 method 为 NULL 的行） */
  total: number;
  /** 去重后的真实接口数（method 非空 + 同一 realPath 合并） */
  distinctInterfaces: number;
  byMethod: Record<string, number>;
  rows: UrlPatternRow[];
}

export interface UrlInventoryOptions {
  method?: string;
  /** 关键词过滤，作用在「真实路径 / 原始 pattern / 定义文件」上 */
  q?: string;
  /** 是否包含 method 为 NULL 的行（默认 true，因为它们是诊断线索） */
  includeEmptyMethod?: boolean;
}

// ---------------------------------------------------------------------------
// helper 定义索引：从仓库自己的文件内容里现查
// ---------------------------------------------------------------------------

const IDENT = '[A-Za-z_$][\\w$]*';
/**
 * ⚠️ 必须锚定**行首**（最多 2 个空格缩进）—— 这是在用形态近似「模块级作用域」。
 *
 * 不锚定会踩到一个真实的坑：仓库里 `src/service/Api/PlayWright/ApiService.ts`
 * 的函数体内有 `const url = \`${domain}/testwire/static/pw/api.json\``。
 * 如果不限作用域，`${url}`（`WrapAxios` 把 url 当形参收进来，是**运行时的值**）
 * 就会被这条函数内的局部变量「解析」成那个静态资源路径 —— 一个看起来很像真的
 * 假答案，比解析不出来危险得多。
 *
 * 模块级的 URL helper 在这个代码库里一律顶格书写，所以行首锚定足够。
 */
const CONST_DEF_RE = new RegExp(
  `(?:^|\\n)[ \\t]{0,2}(?:export\\s+)?(?:const|let|var)\\s+(${IDENT})\\s*=\\s*(?:\\([^)]*\\)\\s*=>\\s*)?[\\\`'"]([^\\\`'"]*)[\\\`'"]`,
  'g'
);
/** `function NAME(args) { return \`...\` }`（同样只认模块级） */
const FUNC_DEF_RE = new RegExp(
  `(?:^|\\n)[ \\t]{0,2}(?:export\\s+)?function\\s+(${IDENT})\\s*\\([^)]*\\)\\s*\\{[^}]*?return\\s+[\\\`'"]([^\\\`'"]*)[\\\`'"]`,
  'g'
);

/** 运行时变量名：出现在 `${...}` 里只可能是「值」而不是「helper」，一律不解析 */
const RUNTIME_VALUE_NAMES = new Set([
  'url', 'uri', 'href', 'link', 'path', 'pathname', 'src', 'base', 'baseUrl', 'baseURL',
  'host', 'domain', 'origin', 'target', 'endpoint', 'value', 'data',
]);

const HELPER_INDEX_TTL_MS = 5 * 60 * 1000;

/** 一条 helper 定义 */
export interface HelperDef {
  template: string;
  /** 定义所在文件 —— 递归展开时要用它来决定作用域 */
  file: string;
  exported: boolean;
}

export interface HelperIndex {
  /** 文件 -> (helper 名 -> 定义)。对应 JS 的词法作用域 */
  local: Map<string, Map<string, HelperDef>>;
  /** 只有 `export` 过的定义才进这里（跨文件可见） */
  global: Map<string, HelperDef>;
  /** 同名被多个文件 export 过、含义可能不同 -> 从 global 里剔除 */
  ambiguous: string[];
  filesScanned: number;
}

interface HelperIndexEntry {
  index: HelperIndex;
  builtAt: number;
}

const helperIndexCache = new Map<number, HelperIndexEntry>();

/** 需要拿到 `export` 关键字，所以单独匹配一次 */
const EXPORTED_CONST_RE = /(?:^|\n)[ \t]{0,2}export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
const EXPORTED_FUNC_RE = /(?:^|\n)[ \t]{0,2}export\s+function\s+([A-Za-z_$][\w$]*)/g;

/**
 * 扫描该仓库已索引的文件内容，建立 helper 定义索引。
 *
 * ============================================================
 * 为什么必须分「文件内」和「文件外」两层
 * ============================================================
 * 只用一张 `名字 -> 模板` 的全局表会踩到一个真实且隐蔽的坑：
 * 这个仓库里 **`scope` 这个名字在 14 个文件里各定义了一次**，含义各不相同
 * （`TestScenario` 系列的 `scope` 指向 `/rest/quality/a/{appId}`，
 *   `TestScenarioReport` 的 `scope` 指向 `…/api/report`，
 *   `TestScenarioExecute` 的 `scope` 干脆指向 `/plugin/api/log`）。
 * 全局表「先到先得」会让其中 13 个文件的路径全部展开成错的 ——
 * 而且错得**很像真的**，比展不开危险得多。
 *
 * 所以这里如实建模 JS 作用域：
 *   * 非 export 的定义只在**它自己所在的文件**里可见（`local`）；
 *   * export 过的才跨文件可见（`global`）；
 *   * 同名在多个文件被 export 过则视为有歧义，从 `global` 剔除，宁可展不开。
 * 展开时按 `本文件 -> global` 的顺序查，与源码里的可见性一致。
 *
 * 只读 `files.content`，不碰任何付费资源（不调 LLM、不算向量）。
 */
export async function buildHelperIndex(db: Pool, repoId: number): Promise<HelperIndex> {
  const cached = helperIndexCache.get(repoId);
  if (cached && Date.now() - cached.builtAt < HELPER_INDEX_TTL_MS) {
    return cached.index;
  }

  const local = new Map<string, Map<string, HelperDef>>();
  const seenExported = new Map<string, HelperDef[]>();
  let scanned = 0;
  let total = 0;

  const result = await db.query<{ path: string; content: string | null }>(
    'SELECT path, content FROM files WHERE repo_id = $1',
    [repoId]
  );

  for (const row of result.rows) {
    const content = row.content;
    if (!content) continue;
    scanned++;

    // 先收集本文件中被 export 的名字
    const exportedNames = new Set<string>();
    for (const re of [EXPORTED_CONST_RE, EXPORTED_FUNC_RE]) {
      re.lastIndex = 0;
      let em: RegExpExecArray | null;
      while ((em = re.exec(content)) !== null) exportedNames.add(em[1]);
    }

    const fileMap = new Map<string, HelperDef>();
    for (const re of [CONST_DEF_RE, FUNC_DEF_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const name = m[1];
        const template = m[2];
        // ⚠️ 不能用 `template &&` 判空 —— `const PTRFIX = ""` 是**合法的空串定义**，
        // 漏掉它会导致 `${PTRFIX}/rest` 展不开，进而把整个 `/rest` 前缀变成 `:param`。
        if (!name || template === undefined) continue;
        // 同一文件内同名以第一次为准
        if (fileMap.has(name)) continue;

        const def: HelperDef = { template, file: row.path, exported: exportedNames.has(name) };
        fileMap.set(name, def);
        total++;

        if (def.exported) {
          const list = seenExported.get(name);
          if (list) list.push(def);
          else seenExported.set(name, [def]);
        }
      }
    }
    if (fileMap.size > 0) local.set(row.path, fileMap);
  }

  const global = new Map<string, HelperDef>();
  const ambiguous: string[] = [];
  for (const [name, defs] of seenExported) {
    const distinct = new Set(defs.map((d) => d.template));
    if (distinct.size > 1) {
      ambiguous.push(name);
      continue; // 同名不同义 -> 不放进全局表
    }
    global.set(name, defs[0]);
  }

  const index: HelperIndex = { local, global, ambiguous, filesScanned: scanned };
  helperIndexCache.set(repoId, { index, builtAt: Date.now() });
  console.log(
    `[url-inventory] repo ${repoId}: 扫描 ${scanned} 个文件，` +
      `收集 ${total} 条 helper 定义（文件内 ${local.size} 个文件，跨文件 export ${global.size} 条` +
      `${ambiguous.length ? `，因同名不同义剔除 ${ambiguous.length} 条：${ambiguous.join('/')}` : ''}）`
  );
  return index;
}

/** 手动失效（仓库重建索引后调用） */
export function clearHelperIndexCache(repoId?: number): void {
  if (repoId === undefined) helperIndexCache.clear();
  else helperIndexCache.delete(repoId);
}

// ---------------------------------------------------------------------------
// 展开
// ---------------------------------------------------------------------------

const MAX_EXPAND_DEPTH = 6;
const PLACEHOLDER_RE = /\$\{[^}]*\}/g;
/** 开头一整段 `${HELPER}` 或 `${HELPER(args)}` */
const LEAD_HELPER_RE = new RegExp(`^\\$\\{\\s*(${IDENT})\\s*(?:\\(([^)]*)\\))?\\s*\\}`);
/** 纯表达式：`NAME` 或 `NAME(args)` */
const EXPR_RE = new RegExp(`^\\s*(${IDENT})\\s*(?:\\(([^)]*)\\))?\\s*$`);

/**
 * 按作用域查一个 helper：**先看当前文件，再看跨文件 export**。
 * 与源码里的可见性顺序一致。
 */
function lookupHelper(name: string, scopeFile: string, index: HelperIndex): HelperDef | null {
  const localDef = index.local.get(scopeFile)?.get(name);
  if (localDef) return localDef;
  return index.global.get(name) ?? null;
}

/**
 * 把模板字面量里的每一段 `${...}` 递归展开；展不开的降级为 `:param`。
 *
 * 降级而不是报错是有意的：helper 的实参（`${appId}`）本来就不该有静态值，
 * 它对应路径参数；只有**基底**展不开才需要如实返回 null 让调用方放弃。
 */
function expandTemplate(
  template: string,
  scopeFile: string,
  index: HelperIndex,
  depth: number
): string {
  return template.replace(/\$\{([^}]*)\}/g, (_full, inner: string) => {
    const resolved = resolveExpr(inner, scopeFile, index, depth);
    return resolved === null ? ':param' : resolved;
  });
}

/** 解析一个表达式（`HELPER` / `HELPER(args)`）为真实字符串；失败返回 null */
function resolveExpr(
  expr: string,
  scopeFile: string,
  index: HelperIndex,
  depth: number
): string | null {
  if (depth >= MAX_EXPAND_DEPTH) return null;
  const m = EXPR_RE.exec(expr);
  if (!m) return null;
  const name = m[1];
  // 形如 `${url}` 的一律按「运行时值」处理：它对应的是一个变量，
  // 不是 URL 前缀 helper。宁可展不开，也不要拿同名局部变量硬凑一个答案。
  if (RUNTIME_VALUE_NAMES.has(name)) return null;
  const def = lookupHelper(name, scopeFile, index);
  if (!def) return null;
  // 递归时作用域切到**定义所在文件**：`COOP_URL` 定义在 base.ts，
  // 它用到的 `${PTRFIX}` 是 base.ts 里的**非 export** 常量，只能在该文件里看到。
  return expandTemplate(def.template, def.file, index, depth + 1);
}

function normalizeTail(tail: string): string {
  let t = tail.replace(PLACEHOLDER_RE, ':param');
  const q = t.indexOf('?');
  if (q >= 0) t = t.slice(0, q);
  t = t.replace(/\/+$/, '');
  if (t && !t.startsWith('/')) t = '/' + t;
  return t;
}

/**
 * 展开一条 pattern 为真实路径。
 *
 * - 开头是 `${HELPER...}` 且能查到定义 → `前缀 + 归一化后的剩余路径`
 * - 开头是 `${HELPER...}` 但查不到定义 → `null`（如实放弃，不猜）
 * - 本来就是字面量（`/rest/...`、`plugin/api/...`、`https://...`）→ 归一化后返回
 * - 既不是字面量也没有斜杠（如 `login`）→ `null`（这类不是接口路径）
 *
 * @param defFile 该 pattern 的**定义文件**。作用域解析必须靠它 ——
 *                同名 helper（如 `scope`）在不同文件里含义不同。
 */
export function expandUrlPattern(
  pattern: string,
  defFile: string | null,
  index: HelperIndex
): string | null {
  if (/^https?:\/\//i.test(pattern)) return pattern;

  const scopeFile = defFile ?? '';
  const lead = LEAD_HELPER_RE.exec(pattern);
  if (lead) {
    const expr = lead[2] === undefined ? lead[1] : `${lead[1]}(${lead[2]})`;
    const base = resolveExpr(expr, scopeFile, index, 0);
    if (base === null) return null;
    return (base.replace(/\/+$/, '') + normalizeTail(pattern.slice(lead[0].length))) || null;
  }

  if (!pattern.includes('/')) return null;
  return normalizeTail(pattern) || null;
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

interface RawRow {
  id: number;
  method: string | null;
  pattern: string;
  normalized_pattern: string;
  definition_line: number | null;
  definition_file: string | null;
  usage_count: string | number;
  usage_files: unknown;
}

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/**
 * 判定一条「method 未判定」的行到底是不是接口。
 *
 * 规则**写成代码**而不是人工标注 —— 同一批数据换个仓库、换次重建都要能重算，
 * 而且前端、`/ask` 的回答、离线对账脚本必须得到同一结论。
 *
 * 顺序即优先级（例如 `vite.config.ts` 既在构建产物特征里、也含字面量路径，
 * 要求先被「构建产物」规则接住）。默认返回 `unknown` 而**不是**硬塞进某一类：
 * 没匹配上任何已知特征时，诚实的答案是「需要人工判定」，不是猜。
 *
 * 注意这里刻意**不复用** `definitionFile` 的目测印象：判据都是可复算的字符串特征。
 */
export function classifyUndecidedRow(row: {
  realPath: string | null;
  pattern: string;
  definitionFile: string | null;
}): UndecidedClassification {
  const real = row.realPath ?? '';
  const file = row.definitionFile ?? '';

  if (/^https?:\/\//i.test(real)) {
    return { kind: 'not-interface', reason: '外部资源/CDN 地址，不是本项目自己的接口' };
  }
  if (file.includes('vite.config')) {
    return { kind: 'not-interface', reason: 'vite 构建配置里的路径（构建产物/静态资源）' };
  }
  if (file.includes('router/routes')) {
    return { kind: 'not-interface', reason: '前端路由表里的路由（浏览器地址，不是后端接口）' };
  }
  if (file.includes('initializeRootMenu') || file.includes('AppCreated')) {
    return { kind: 'not-interface', reason: '前端菜单/路由动态拼接出来的路径' };
  }
  if (real === '/Read/Write') {
    return { kind: 'not-interface', reason: '界面文案（组件里显示的字符串）' };
  }
  if (real.startsWith('/plugin/api/') || real.startsWith('/rest/')) {
    return { kind: 'interface', reason: '后端接口路径，只是 method 写在变量里没被推断出来' };
  }
  return { kind: 'unknown', reason: '未匹配任何已知特征，需要人工判定' };
}

/**
 * 取回该仓库**全部** URL 行（不是 top-K），并展开 helper。
 *
 * 这里的「全部」是有意的：调用方要的是完备集合，任何 limit 都会重新引入
 * 「只给了相似度最高的几条」这个问题。
 */
export async function getUrlInventory(
  repoId: number,
  options: UrlInventoryOptions = {},
  db: Pool = defaultPool
): Promise<UrlInventory> {
  const index = await buildHelperIndex(db, repoId);

  const params: unknown[] = [repoId];
  let where = 'p.repo_id = $1';
  if (options.method) {
    params.push(options.method.toUpperCase());
    where += ` AND upper(p.method) = $${params.length}`;
  }
  if (options.includeEmptyMethod === false) {
    where += ' AND p.method IS NOT NULL';
  }

  const result = await db.query<RawRow>(
    `SELECT p.id,
            p.method,
            p.pattern,
            p.normalized_pattern,
            p.definition_line,
            f.path AS definition_file,
            (SELECT count(*) FROM url_usages u WHERE u.url_pattern_id = p.id) AS usage_count,
            COALESCE((
              SELECT json_agg(DISTINCT uf.path)
              FROM url_usages u JOIN files uf ON uf.id = u.usage_file_id
              WHERE u.url_pattern_id = p.id
            ), '[]'::json) AS usage_files
       FROM url_patterns p
       LEFT JOIN files f ON f.id = p.definition_file_id
      WHERE ${where}
      ORDER BY (p.method IS NULL), p.method, p.normalized_pattern`,
    params
  );

  const rows: UrlPatternRow[] = result.rows.map((r) => {
    const realPath = expandUrlPattern(r.pattern, r.definition_file, index);
    const row: UrlPatternRow = {
      id: r.id,
      method: r.method,
      pattern: r.pattern,
      normalizedPattern: r.normalized_pattern,
      realPath,
      definitionFile: r.definition_file,
      definitionLine: r.definition_line,
      usageCount: Number(r.usage_count ?? 0),
      usageFiles: toArray(r.usage_files),
    };
    // 只有 method 未判定的行才需要「这到底是不是接口」的判定；
    // method 已判定的行本身就是接口，多带一个字段只会让人以为还有歧义。
    if (row.method === null) {
      row.classification = classifyUndecidedRow(row);
    }
    return row;
  });

  const keyword = options.q?.trim().toLowerCase();
  const filtered = keyword
    ? rows.filter((r) =>
        [r.realPath ?? '', r.pattern, r.normalizedPattern, r.definitionFile ?? '']
          .join(' ')
          .toLowerCase()
          .includes(keyword)
      )
    : rows;

  // 去重：同一 (method, realPath) 只保留一条，合并调用点与原始写法。
  // 这一步是必须的 —— normalized_pattern 保留了 helper 实参名，
  // 同一接口会因 `${URL(aid)}` / `${URL(option.aid)}` 被算成多行。
  const merged = new Map<string, UrlPatternRow>();
  for (const r of filtered) {
    const key = `${r.method ?? ''}\u0000${r.realPath ?? r.pattern}`;
    const hit = merged.get(key);
    if (!hit) {
      merged.set(key, { ...r });
      continue;
    }
    hit.usageCount += r.usageCount;
    for (const f of r.usageFiles) if (!hit.usageFiles.includes(f)) hit.usageFiles.push(f);
  }

  const distinctRows = [...merged.values()].sort((a, b) => {
    // method 未判定的排**最后**：它们是诊断线索，不该占据清单的开头。
    // （注意别用 `a.method ?? ''` 直接比 —— 空串会排到 'DELETE' 前面，正好相反。）
    const an = a.method === null ? 1 : 0;
    const bn = b.method === null ? 1 : 0;
    if (an !== bn) return an - bn;
    if ((a.method ?? '') !== (b.method ?? '')) return (a.method ?? '') < (b.method ?? '') ? -1 : 1;
    return (a.realPath ?? a.pattern) < (b.realPath ?? b.pattern) ? -1 : 1;
  });

  const byMethod: Record<string, number> = {};
  for (const r of distinctRows) {
    const k = r.method ?? '(未判定)';
    byMethod[k] = (byMethod[k] ?? 0) + 1;
  }

  return {
    repoId,
    total: rows.length,
    distinctInterfaces: distinctRows.filter((r) => r.method !== null).length,
    byMethod,
    rows: distinctRows,
  };
}

/** 从提问里认出用户想筛的 HTTP method（`列出所有 POST 接口` → `POST`） */
export function extractMethodFilter(query: string): string | undefined {
  const m = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/i.exec(query);
  return m ? m[1].toUpperCase() : undefined;
}

/** 从提问里认出用户想筛的路径关键词（`列出 /rest/quality 下的接口`） */
export function extractPathFilter(query: string): string | undefined {
  const m = /(\/[A-Za-z0-9_\-./{}$:]{2,})/.exec(query);
  if (!m) return undefined;
  const raw = m[1].replace(/[.,，。；;]$/, '');
  return raw.includes('${') ? undefined : raw;
}

/**
 * 把清单一整份渲染成文本答案。
 *
 * **刻意由代码拼装而不是交给 LLM**：让模型去「总结 236 条」一定会漏行，
 * 而后缀缺失的清单比没有清单更危险（看起来完备）。
 * LLM 可以负责写开场白，但明细必须原样透传 —— 见 `formatInventoryAnswer` 的调用点。
 */
export function formatInventoryAnswer(inv: UrlInventory, filters: { method?: string; q?: string }): string {
  const lines: string[] = [];
  const scope: string[] = [];
  if (filters.method) scope.push(`method = ${filters.method}`);
  if (filters.q) scope.push(`路径包含 "${filters.q}"`);
  const scopeText = scope.length ? `（${scope.join('，')}）` : '';

  // ⚠️ 分布里必须**排除** `(未判定)` 那一档：标题说的是「可调用接口」，
  // 若把未判定的 39 也列进分布，同一句话里的数字会自相矛盾
  // （124+63+39+39+12 = 277 ≠ 标题的 254）。这一档由下面的「计数口径」交代。
  const byMethod = Object.entries(inv.byMethod)
    .filter(([k]) => k !== '(未判定)')
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');

  // ⚠️ 三个数不能混用：`rows.length`(277) 里含「根本不是接口」的行，
  // 直接把它叫「接口数」就是虚高（这正是本模块当初要解决的问题之一）。
  // 可调用接口 = method 已判定(238) + method 未判定但路径确认是接口的(16)。
  const undecided = inv.rows.filter((r) => r.method === null);
  const undecidedIfaces = undecided.filter((r) => r.classification?.kind === 'interface');
  const callable = inv.distinctInterfaces + undecidedIfaces.length;

  lines.push(
    `仓库 #${inv.repoId} 共 **${callable}** 个可调用接口${scopeText}。` +
      (byMethod ? `（其中 method 已判定的 ${inv.distinctInterfaces} 个分布为：${byMethod}）` : '')
  );
  lines.push('');
  if (undecided.length > 0) {
    lines.push(
      `> **计数口径**：\`url_patterns\` 原始 ${inv.total} 行 → 按 (method, 路径) 去重 **${inv.rows.length}** 行` +
        ` → 其中 method 已判定 **${inv.distinctInterfaces}** 个；另有 **${undecidedIfaces.length}** 个接口的 ` +
        `method 写在变量里没被推断出来。剩余 **${undecided.length - undecidedIfaces.length}** 行` +
        `**不是接口**（前端路由 / 构建产物 / 界面文案 / 外部地址），单独列在文末。`
    );
    lines.push('');
  }
  lines.push('> 本清单由**结构化查询**生成（直接读 `url_patterns`），不是检索 top-K —— 条数即全集，不会有「最相似的前 10 条」这种截断。');
  lines.push('');

  // 按后端前缀分组，读起来更像一份 API 文档
  const groups = new Map<string, UrlPatternRow[]>();
  for (const r of inv.rows) {
    if (r.method === null) continue; // 单独放最后，见下
    const p = r.realPath ?? r.pattern;
    const m = /^\/([^/]+)/.exec(p);
    const key = p.startsWith('http') ? '外部 URL' : m ? `/${m[1]}` : '(未展开)';
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  for (const [group, rows] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`### ${group}  (${rows.length})`);
    lines.push('');
    lines.push('| Method | 路径 | 定义位置 | 调用点 |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of rows) {
      const path = r.realPath ?? `${r.pattern}（未能展开，依赖运行时变量）`;
      const loc = r.definitionFile
        ? `\`${r.definitionFile}:${r.definitionLine ?? 0}\``
        : '—';
      lines.push(`| ${r.method ?? '(未判定)'} | \`${path}\` | ${loc} | ${r.usageCount} |`);
    }
    lines.push('');
  }

  // 未判定 method 的行单独成节。
  // 混在主清单里会让人以为它们是接口 —— 实测这批里大部分是前端路由
  // （`path: "api/:id"`）、构建产物（`static/js/main.js`）和界面文案。
  // 但也不能直接删：其中确实混着 method 存在变量里的**真实接口**。
  // 判定用 classifyUndecidedRow（规则写死在代码里），不靠人目测 —— 这样
  // 界面、这里、以及离线对账脚本三处才会得到同一个结论。
  if (undecided.length > 0) {
    const isIface = undecidedIfaces;
    const notIface = undecided.filter((r) => r.classification?.kind === 'not-interface');
    const unknown = undecided.filter(
      (r) => !r.classification || r.classification.kind === 'unknown'
    );

    lines.push(`### ⚠️ 未能判定 HTTP method 的 ${undecided.length} 条`);
    lines.push('');
    lines.push(
      `这 ${undecided.length} 条里混着两种东西，**不能整批当接口计数**：` +
        `其中 **${isIface.length} 条是真实接口**（method 写在变量里没被推断出来）、` +
        `**${notIface.length} 条根本不是接口**` +
        (unknown.length ? `，另有 ${unknown.length} 条需人工判定` : '') +
        '。判定依据见下表最后一列。'
    );
    lines.push('');
    lines.push('| 值 | 定义位置 | 是不是接口 | 判定依据 |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of undecided) {
      const loc = r.definitionFile
        ? `\`${r.definitionFile}:${r.definitionLine ?? 0}\``
        : '—';
      const kind = r.classification?.kind ?? 'unknown';
      const mark =
        kind === 'interface' ? '✅ 是' : kind === 'not-interface' ? '❌ 否' : '❓ 待判';
      lines.push(
        `| \`${r.realPath ?? r.pattern}\` | ${loc} | ${mark} | ${r.classification?.reason ?? '—'} |`
      );
    }
    lines.push('');
  }

  const unresolved = inv.rows.filter((r) => r.realPath === null).length;
  if (unresolved > 0) {
    lines.push(
      `> 另注：${unresolved} 条的路径依赖运行时变量（例如先在函数里算好 ` +
        '`url` 再传给请求库），静态展开不到字面量，已原样列出。'
    );
  }

  return lines.join('\n');
}
