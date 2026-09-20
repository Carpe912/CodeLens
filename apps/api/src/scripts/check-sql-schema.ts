#!/usr/bin/env node

/**
 * SQL ↔ Schema 一致性静态检查器
 *
 * 为什么需要它：
 * 本项目的 `call_graph` 表曾长期缺少 `repo_id` / `to_chunk_id` 两列，
 * 但写入方 `relationship-builder.ts` 与 6 处读取方都在引用这两列。
 * 由于每条 INSERT 都被 try/catch 包裹（只为「不中断索引流程」），
 * 故障被完全静默：表里一行都没有，图分析却从未报错。
 * 这类「SQL 引用了不存在的列」的缺陷，改代码时看不出来、typecheck 也查不出、
 * 只有真连上数据库跑一遍才会炸——而本项目的 CI 里没有数据库。
 *
 * 于是用静态分析补上这道闸门：
 *   1. 从 `db/index.ts` 的 CREATE TABLE 与 `migrations/*.sql` 的
 *      CREATE TABLE / ALTER TABLE ... ADD COLUMN 还原「真实 schema」。
 *   2. 扫描 `src/**` 里所有 SQL 字符串，逐条校验列引用。
 *   3. 报告「引用了不存在列」的位置。
 *
 * 覆盖三类引用：
 *   - 限定引用 `alias.column`（alias 能解析到某张已知表时）
 *   - `INSERT INTO t (a, b)` 的列清单
 *   - `UPDATE t SET a = ...` 的赋值目标
 *   - 单表语句（无 JOIN）里的裸列名
 *
 * 刻意不做的事：
 *   - 不校验未知表（CTE、子查询派生表、视图）→ 直接跳过，避免假阳性
 *   - 不校验函数名、类型转换、关键字
 *
 * ============================================
 * 可选的语法校验（默认关闭）
 * ============================================
 * 本检查器的核心能力是「列是否存在」，这可以在不连数据库的情况下静态判定。
 * 而「SQL 语法是否合法」需要一个真正的 SQL 解析器。为了不给项目强加依赖，
 * 语法校验做成可选：把环境变量 CODELENS_SQL_PARSER_DIR 指向一个已安装
 * pgsql-ast-parser 的 node_modules 目录即可启用：
 *
 *   CODELENS_SQL_PARSER_DIR=/path/to/node_modules/pgsql-ast-parser \
 *     pnpm --filter @codelens/api check:sql
 *
 * 【已知限制，必须明确】
 * pgsql-ast-parser 不支持 WITH RECURSIVE（实测在 "WITH RECURSIVE " 之后立即报错）。
 * 因此本仓库里基于递归 CTE 的查询（影响面分析、调用链）**无法**通过这条路径验证，
 * 它们会被单独统计为「未验证」。这不是在掩盖，而是把「哪部分没被验证」显式说出来 ——
 * 否则『检查通过』会被误读成『全部验证过』。
 *
 * 用法：
 *   pnpm --filter @codelens/api check:sql
 *   pnpm --filter @codelens/api check:sql -- --verbose   # 额外列出被跳过的未知表
 *
 * 退出码：发现幽灵列 = 1；通过 = 0；**一个源文件都没扫到 = 3**。
 *
 * ⚠️ 退出码 3 是刻意加出来的：部署态（服务器只有 dist/）没有 src/，
 * 空扫描会「没有任何 finding」→ 打印 PASS。那不是通过，是没执行。
 * 所以**不要**在服务器上把它当闸门，它只在仓库内（开发机 / CI）有意义。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const API_ROOT = join(__dirname, '..', '..'); // apps/api
const SRC_ROOT = join(API_ROOT, 'src');
const MIGRATIONS_DIR = join(API_ROOT, 'migrations');

/**
 * 定位「运行时建表语句」所在文件。
 *
 * 优先取**与本脚本同源**的那一份（`<script>/../db/index.*`），而不是
 * 「按 API_ROOT 猜出来的那一份」。原因：
 *   - 服务器上的部署产物**只有 `dist`，没有 `src`**（`deploy.js` 只 scp 构建结果），
 *     按 `src/db/index.ts` 找会 ENOENT；
 *   - 更隐蔽的是「暂存目录」场景：把新产物解到 `dist.staged` 再跑检查时，
 *     若按 `API_ROOT/dist/db/index.js` 去找，会读到**正在运行的旧 dist**，
 *     于是检查的是旧代码 —— 修复被验证成「仍然有问题」。
 * 同源定位可以同时消除这两个坑。
 */
function resolveDbSourceFile(): string {
  const candidates = [
    join(__dirname, '..', 'db', 'index.ts'), // src/scripts → src/db/index.ts（开发）
    join(__dirname, '..', 'db', 'index.js'), // dist/scripts → dist/db/index.js（部署）
    join(SRC_ROOT, 'db', 'index.ts'),        // 兜底
    join(API_ROOT, 'dist', 'db', 'index.js'),// 兜底
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `找不到建表语句所在文件，已尝试：\n  ${candidates.join('\n  ')}`
  );
}

const VERBOSE = process.argv.includes('--verbose');

// ---------------------------------------------------------------------------
// 1. 还原 schema
// ---------------------------------------------------------------------------

/**
 * 表名 → 列名集合。
 *
 * 导出是给 `check-live-schema.ts` 复用的：那个脚本拿这份「代码期望的 schema」
 * 去和真实数据库比对，找的是**反向**的漂移（见该文件头注释）。
 */
export type Schema = Map<string, Set<string>>;

/** 建表语句中不属于列名的起始关键字 */
const DDL_CONSTRAINT_KEYWORDS = new Set([
  'primary', 'foreign', 'unique', 'check', 'constraint', 'exclude', 'like',
  'inherits', 'partition', 'with', 'using', 'tablespace', 'comment',
]);

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;

/**
 * 去掉 SQL 注释（引号感知）。
 *
 * 必须在解析建表语句**之前**做：migration 里的列定义常常长这样：
 *     -- Importer
 *     importer_file_id INT NOT NULL,
 * 若不去注释，按逗号切分后这一段的开头是 `--`，列名就永远解析不出来
 * （这正是本检查器第一版误报 188 处的原因）。
 */
function stripSqlComments(text: string): string {
  let out = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;

  while (i < text.length) {
    const ch = text[i];

    if (inSingle) {
      out += ch;
      if (ch === "'") {
        if (text[i + 1] === "'") { out += text[++i]; i++; continue; }
        inSingle = false;
      }
      i++;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }

    if (ch === "'") { inSingle = true; out += ch; i++; continue; }
    if (ch === '"') { inDouble = true; out += ch; i++; continue; }

    if (ch === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      out += ' ';
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/** 从 `(` 开始做括号配平，返回括号内部文本与结束位置 */
function readParenBody(text: string, openIdx: number): { body: string; endIdx: number } {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];

    if (inSingle) {
      if (ch === "'") {
        if (text[i + 1] === "'") { i++; continue; }
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }

    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') {
      depth--;
      if (depth === 0) return { body: stripSqlComments(text.slice(openIdx + 1, i)), endIdx: i };
    }
  }
  return { body: stripSqlComments(text.slice(openIdx + 1)), endIdx: text.length };
}

/** 按顶层逗号切分（忽略括号内、引号内的逗号） */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let current = '';

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];

    if (inSingle) {
      current += ch;
      if (ch === "'") {
        if (body[i + 1] === "'") { current += body[++i]; continue; }
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"') inDouble = false;
      continue;
    }

    if (ch === "'") { inSingle = true; current += ch; continue; }
    if (ch === '"') { inDouble = true; current += ch; continue; }
    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')') { depth--; current += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** 取一段 DDL 片段开头的标识符 */
function leadingIdentifier(part: string): string | null {
  const trimmed = part.trim();
  if (!trimmed || !IDENT_START.test(trimmed[0])) return null;
  let i = 0;
  while (i < trimmed.length && IDENT_CHAR.test(trimmed[i])) i++;
  return trimmed.slice(0, i);
}

function ensureTable(schema: Schema, table: string): Set<string> {
  let cols = schema.get(table);
  if (!cols) { cols = new Set<string>(); schema.set(table, cols); }
  return cols;
}

/** 解析 CREATE TABLE，把列名并入 schema */
function parseCreateTables(text: string, schema: Schema): void {
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;

  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const table = m[1].toLowerCase();
    const openIdx = m.index + m[0].length - 1;
    const { body } = readParenBody(text, openIdx);
    const cols = ensureTable(schema, table);

    for (const part of splitTopLevel(body)) {
      const ident = leadingIdentifier(part);
      if (!ident) continue;
      if (DDL_CONSTRAINT_KEYWORDS.has(ident.toLowerCase())) continue;
      cols.add(ident.toLowerCase());
    }
  }
}

/** 解析 ALTER TABLE ... ADD COLUMN / DROP COLUMN，增量修正 schema */
function parseAlterTable(text: string, schema: Schema): void {
  const re = /ALTER\s+TABLE\s+(?:ONLY\s+)?([A-Za-z_][A-Za-z0-9_]*)([\s\S]*?);/gi;

  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const table = m[1].toLowerCase();
    const tail = stripSqlComments(m[2]);
    if (!schema.has(table)) continue; // 未知表不参与
    const cols = ensureTable(schema, table);

    const addRe = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
    let a: RegExpExecArray | null;
    while ((a = addRe.exec(tail)) !== null) cols.add(a[1].toLowerCase());

    const dropRe = /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
    let d: RegExpExecArray | null;
    while ((d = dropRe.exec(tail)) !== null) cols.delete(d[1].toLowerCase());
  }
}

/**
 * 还原「代码期望的 schema」：运行时建表语句 + migrations。
 *
 * 导出供 `check-live-schema.ts` 复用 —— 那个脚本做的是**反向**校验：
 * 拿这份期望 schema 去比真实数据库，找出「代码假定存在、但库里没有」的列。
 */
export function buildSchema(): Schema {
  const schema: Schema = new Map();

  // 运行时建表：src/db/index.ts（开发）或 dist/db/index.js（部署）
  const dbIndex = readFileSync(resolveDbSourceFile(), 'utf-8');
  parseCreateTables(dbIndex, schema);
  parseAlterTable(dbIndex, schema);

  // 迁移脚本：migrations/*.sql（按文件名顺序应用，模拟真实执行顺序）
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
    parseCreateTables(sql, schema);
    parseAlterTable(sql, schema);
  }

  return schema;
}

/**
 * 汇总「可能包含 ADD COLUMN」的全部文本：运行时建表文件 + 所有迁移。
 *
 * 供 `check-live-schema.ts` 判断某个缺失的列是否有 `IF NOT EXISTS` 兜底。
 * 刻意不再去遍历 `src/**` —— 部署态下 `src` 不存在，遍历会落空。
 */
export function collectAlterSources(): string {
  let text = readFileSync(resolveDbSourceFile(), 'utf-8');
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))) {
    text += '\n' + readFileSync(join(MIGRATIONS_DIR, f), 'utf-8');
  }
  return text;
}

// ---------------------------------------------------------------------------
// 2. 提取源码中的所有 SQL 字符串
// ---------------------------------------------------------------------------

type SqlLiteral = { file: string; line: number; sql: string };

/**
 * 判断某个位置的 `/` 是否是一个正则字面量的开始
 *
 * 为什么需要它：下面的字面量扫描器必须能正确跳过正则字面量。
 * 反例（真实踩到的坑）：
 *     value.replace(/^['"]+|['"]+$/g, '')
 * 这个正则里同时含有 `'` 和 `"`。如果扫描器把它当成普通代码，
 * 遇到里面的 `'` 就会误认为「一个字符串从这里开始」，从而与后面的引号
 * 配错位置，导致**整份文件的字面量解析全部错位**（后面的「字符串」都是垃圾），
 * 进而产生假阳性、并可能漏掉真正的 SQL。
 *
 * 判定用 JS 词法分析的标准启发式：看 `/` 前面最近的**非空白字符**，
 * 若它是运算符/分隔符（或不存在），则 `/` 是正则起始；若是标识符、`)`、`]`
 * 等，则 `/` 是除号。
 */
function isRegexStart(source: string, slashIdx: number): boolean {
  for (let i = slashIdx - 1; i >= 0; i--) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    // 标识符/数字/右括号结尾 → 这里是除号
    if (/[A-Za-z0-9_$)\]]/.test(c)) return false;
    return true;
  }
  return true; // 文件开头
}

/** 跳过正则字面量，返回结束位置（指向闭合 `/` 之后） */
function skipRegexLiteral(source: string, slashIdx: number): number {
  let i = slashIdx + 1;
  let inClass = false;

  while (i < source.length) {
    const c = source[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') { inClass = true; i++; continue; }
    if (c === ']') { inClass = false; i++; continue; }
    if (c === '/' && !inClass) {
      i++;
      // 跳过 flags
      while (i < source.length && /[a-z]/i.test(source[i])) i++;
      return i;
    }
    if (c === '\n') return i; // 正则不能跨行，说明判断有误，及时止损
    i++;
  }
  return i;
}

/** 从 TS/JS 源码里抽出所有字符串字面量（含模板串，`${}` 替换成占位符） */
function extractStringLiterals(source: string): { text: string; index: number }[] {
  const out: { text: string; index: number }[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    // 跳过行注释
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    // 跳过块注释
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    // 跳过正则字面量（含引号的正则会打乱引号配对，必须在这里拦掉）
    if (ch === '/' && isRegexStart(source, i)) {
      i = skipRegexLiteral(source, i);
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      const start = i;
      let buf = '';
      i++;
      let closed = false;

      while (i < source.length) {
        const c = source[i];

        if (c === '\\') { buf += source[i + 1] ?? ''; i += 2; continue; }

        if (quote === '`' && c === '$' && source[i + 1] === '{') {
          // 模板串插值：整段替换为占位符，避免把 JS 表达式当 SQL 解析
          let depth = 1;
          i += 2;
          while (i < source.length && depth > 0) {
            if (source[i] === '{') depth++;
            else if (source[i] === '}') depth--;
            i++;
          }
          buf += ' __PH__ ';
          continue;
        }

        if (c === quote) { closed = true; i++; break; }
        buf += c;
        i++;
      }

      if (closed) out.push({ text: buf, index: start });
      continue;
    }

    i++;
  }

  return out;
}

function looksLikeSql(text: string): boolean {
  if (text.length < 20) return false;
  const hasVerb = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WITH)\b/i.test(text);
  const hasClause = /\b(FROM|INTO|JOIN|SET|VALUES)\b/i.test(text);
  return hasVerb && hasClause;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry)) acc.push(full);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// 3. 逐条校验
// ---------------------------------------------------------------------------

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'group', 'order', 'by', 'having', 'limit', 'offset',
  'union', 'intersect', 'except', 'all', 'distinct', 'on', 'using', 'join',
  'left', 'right', 'inner', 'outer', 'full', 'cross', 'lateral', 'natural',
  'as', 'and', 'or', 'not', 'in', 'is', 'null', 'true', 'false', 'between',
  'like', 'ilike', 'similar', 'exists', 'any', 'some', 'case', 'when', 'then',
  'else', 'end', 'cast', 'into', 'values', 'set', 'returning', 'with',
  'recursive', 'delete', 'insert', 'update', 'conflict', 'do', 'nothing',
  'asc', 'desc', 'nulls', 'first', 'last', 'only', 'table', 'window', 'over',
  'partition', 'filter', 'within', 'array', 'interval', 'default', 'primary',
  'foreign', 'references', 'constraint', 'unique', 'check', 'index', 'create',
  'alter', 'drop', 'add', 'column', 'if', 'exists', 'to', 'for', 'of', 'fetch',
  'next', 'rows', 'row', 'preceding', 'following', 'unbounded', 'current',
  'exclude', 'grouping', 'sets', 'rollup', 'cube', 'jsonb', 'json', 'text',
  'integer', 'int', 'bigint', 'smallint', 'boolean', 'timestamp', 'numeric',
  'serial', 'varchar', 'uuid', 'vector', 'gin', 'hnsw', 'btree', 'concurrently',
  'desc', 'epoch', 'now', 'coalesce', 'count', 'sum', 'min', 'max', 'avg',
  'length', 'lower', 'upper', 'trim', 'substring', 'position', 'greatest',
  'least', 'nullif', 'round', 'floor', 'ceil', 'abs', 'concat', 'replace',
  'string_agg', 'array_agg', 'jsonb_agg', 'json_agg', 'jsonb_build_object',
  'jsonb_array_elements', 'unnest', 'generate_series', 'similarity', 'left',
  'right', 'strict_word_similarity', 'word_similarity', 'setweight',
  'to_tsvector', 'plainto_tsquery', 'ts_rank', 'websearch_to_tsquery',
  'similarity', 'digest', 'normalize_url_pattern', 'infer_constant_type',
  // TRIM 的修饰词：`trim(both '/' from x)` 里的 `both` 是保留字，不是列名。
  // 不加这三个，`relationship-builder.ts` 那句正则就会报出假的 `url_patterns.both`。
  'both', 'leading', 'trailing',
]);

type Finding = {
  kind: 'qualified' | 'insert-columns' | 'update-set' | 'bare-single-table' | 'on-conflict-columns';
  table: string;
  column: string;
  snippet: string;
};

function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function stripStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, " '' ");
}

function normalizeTableName(name: string): string {
  const parts = name.split('.');
  return parts[parts.length - 1].toLowerCase();
}

function analyze(sqlRaw: string, schema: Schema): { findings: Finding[]; unknownTables: Set<string> } {
  const findings: Finding[] = [];
  const unknownTables = new Set<string>();

  const sql = stripStringLiterals(stripComments(sqlRaw));

  const isKnown = (t: string) => schema.has(normalizeTableName(t));
  const columnsOf = (t: string) => schema.get(normalizeTableName(t));

  // --- alias → table 映射 ---
  const aliasToTable = new Map<string, string>();
  const baseTables = new Set<string>();

  const fromRe =
    /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:ONLY\s+)?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*(?:(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;

  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(sql)) !== null) {
    const rawTable = m[1];
    const table = normalizeTableName(rawTable);
    if (table.includes('__ph__')) continue;

    let aliasCandidate: string | undefined = m[2];
    if (aliasCandidate && SQL_KEYWORDS.has(aliasCandidate.toLowerCase())) aliasCandidate = undefined;

    if (isKnown(table)) {
      baseTables.add(table);
      aliasToTable.set(table, table);
      if (aliasCandidate) aliasToTable.set(aliasCandidate.toLowerCase(), table);
    } else {
      // CTE / 子查询 / 视图：记下但不当错误
      if (!SQL_KEYWORDS.has(table)) unknownTables.add(table);
      if (aliasCandidate) aliasToTable.set(aliasCandidate.toLowerCase(), '');
    }
  }

  // --- INSERT INTO t (a, b) ---
  const insertRe = /INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\(([^)]*)\)/gi;
  while ((m = insertRe.exec(sql)) !== null) {
    const table = normalizeTableName(m[1]);
    const cols = columnsOf(table);
    if (!cols) continue;
    for (const raw of m[2].split(',')) {
      const col = raw.trim().toLowerCase();
      if (!col || col.includes('__ph__') || !/^[a-z_][a-z0-9_]*$/.test(col)) continue;
      if (!cols.has(col)) {
        findings.push({ kind: 'insert-columns', table, column: col, snippet: `INSERT INTO ${table} (${m[2].trim()})` });
      }
    }
  }

  // --- UPDATE t SET a = ..., b = ... ---
  const updateRe = /UPDATE\s+([A-Za-z_][A-Za-z0-9_.]*)\s+SET\s+([\s\S]*?)(?=\bWHERE\b|\bFROM\b|\bRETURNING\b|$)/gi;
  while ((m = updateRe.exec(sql)) !== null) {
    const table = normalizeTableName(m[1]);
    const cols = columnsOf(table);
    if (!cols) continue;
    for (const part of splitTopLevel(m[2])) {
      const target = part.split('=')[0]?.trim().toLowerCase();
      if (!target || !/^[a-z_][a-z0-9_]*$/.test(target)) continue;
      if (!cols.has(target)) {
        findings.push({ kind: 'update-set', table, column: target, snippet: `UPDATE ${table} SET ${target} = ...` });
      }
    }
  }

  // --- ON CONFLICT (a, b) ---
  const conflictRe = /ON\s+CONFLICT\s*\(([^)]*)\)/gi;
  while ((m = conflictRe.exec(sql)) !== null) {
    const target = baseTables.size === 1 ? [...baseTables][0] : null;
    const cols = target ? columnsOf(target) : undefined;
    if (!cols) continue;
    for (const raw of m[1].split(',')) {
      const col = raw.trim().toLowerCase();
      if (!col || !/^[a-z_][a-z0-9_]*$/.test(col)) continue;
      if (!cols.has(col)) {
        findings.push({ kind: 'on-conflict-columns', table: target!, column: col, snippet: `ON CONFLICT (${m[1].trim()})` });
      }
    }
  }

  // --- 限定引用 alias.column ---
  const qualifiedRe = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
  while ((m = qualifiedRe.exec(sql)) !== null) {
    const alias = m[1].toLowerCase();
    const col = m[2].toLowerCase();
    if (col === '__ph__' || col.includes('__ph__')) continue;
    const table = aliasToTable.get(alias);
    if (!table) continue; // 未知来源，跳过
    const cols = columnsOf(table);
    if (!cols) continue;
    if (!cols.has(col)) {
      findings.push({ kind: 'qualified', table, column: col, snippet: `${alias}.${col}` });
    }
  }

  // --- 单表裸列名（仅当语句里只有一张已知表且没有 JOIN 时） ---
  const joinCount = (sql.match(/\bJOIN\b/gi) ?? []).length;
  if (baseTables.size === 1 && joinCount === 0) {
    const table = [...baseTables][0];
    const cols = columnsOf(table)!;

    const bareRe = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
    const seen = new Set<string>();

    while ((m = bareRe.exec(sql)) !== null) {
      const word = m[1];
      const lower = word.toLowerCase();
      const before = sql.slice(Math.max(0, m.index - 6), m.index);
      const after = sql.slice(m.index + word.length, m.index + word.length + 3);

      if (seen.has(`${lower}@${m.index}`)) continue;
      seen.add(`${lower}@${m.index}`);

      if (SQL_KEYWORDS.has(lower)) continue;
      if (lower.includes('__ph__')) continue;
      if (aliasToTable.has(lower)) continue;
      if (cols.has(lower)) continue;
      if (/\.\s*$/.test(before)) continue;      // 限定名的一部分
      if (/^\s*\./.test(after)) continue;        // 限定名的一部分
      if (/::\s*$/.test(before)) continue;       // 类型转换
      if (/^\s*::/.test(after)) continue;
      if (/^\s*\(/.test(after)) continue;        // 函数调用
      // 输出别名。⚠️ 必须同时吃掉 `AS "camelCase"` 这种**带双引号的**别名：
      // pg 回读时会用引号保留大小写，于是 `symbol_name AS "symbolName"` 里的
      // `symbolName` 会被 bareRe 当成一个裸标识符，凭空报出 7 处「列不存在」
      // （url-call-tree.ts:143/168 曾经如此）。带引号的别名**永远不是列引用**。
      if (/\bAS\s+"?$/i.test(before)) continue;
      if (/^\s*$/.test(after) && before.trim() === '') continue;

      findings.push({ kind: 'bare-single-table', table, column: lower, snippet: `... ${word} ...` });
    }
  }

  return { findings, unknownTables };
}

// ---------------------------------------------------------------------------
// 5. 可选的语法校验（需 CODELENS_SQL_PARSER_DIR）
// ---------------------------------------------------------------------------

type SyntaxVerifier = (sql: string) => string | null;

async function loadSyntaxVerifier(): Promise<SyntaxVerifier | null> {
  const dir = process.env.CODELENS_SQL_PARSER_DIR;
  if (!dir) return null;

  try {
    // 用变量做动态 import，避免 TS 静态解析该模块（否则会要求项目声明这个依赖）
    const specifier: string = pathToFileURL(join(dir, 'index.js')).href;
    const mod: any = await import(specifier);
    const parse = mod.parse ?? mod.default?.parse;
    if (typeof parse !== 'function') return null;

    return (sql: string) => {
      try {
        parse(sql);
        return null;
      } catch (e: any) {
        return String(e?.message ?? e);
      }
    };
  } catch {
    return null;
  }
}

/** pgsql-ast-parser 不支持 WITH RECURSIVE，因此递归 CTE 只能标记为「未验证」 */
const isRecursiveCte = (sql: string): boolean => /WITH\s+RECURSIVE/i.test(sql);

/**
 * pgvector 的自定义运算符（余弦距离等）不在解析器的算子表里，
 * 遇到就跳过语法校验并如实计入「未验证」，而不是报成语法错误。
 */
const PGVECTOR_OPERATORS = ['<=>', '<->', '<#>'];
const hasPgvectorOperator = (sql: string): boolean =>
  PGVECTOR_OPERATORS.some((op) => sql.includes(op));

// ---------------------------------------------------------------------------
// 6. main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('='.repeat(72));
  console.log('SQL ↔ Schema 一致性检查');
  console.log('='.repeat(72));

  const schema = buildSchema();
  console.log(`\n还原 schema：${schema.size} 张表`);
  if (VERBOSE) {
    for (const [t, cols] of [...schema.entries()].sort()) {
      console.log(`  ${t} (${cols.size}): ${[...cols].sort().join(', ')}`);
    }
  }
  console.log('');

  const files = walk(SRC_ROOT);
  let checked = 0;
  const perFile = new Map<string, Finding[]>();
  const allUnknown = new Set<string>();

  const syntaxVerifier = await loadSyntaxVerifier();
  const syntaxIssues: Array<{ location: string; message: string }> = [];
  let syntaxChecked = 0;
  let syntaxUnverified = 0;

  for (const file of files) {
    const source = readFileSync(file, 'utf-8');
    for (const lit of extractStringLiterals(source)) {
      if (!looksLikeSql(lit.text)) continue;
      checked++;

      const line = source.slice(0, lit.index).split('\n').length;
      const location = `${relative(API_ROOT, file)}:${line}`;

      const { findings, unknownTables } = analyze(lit.text, schema);
      for (const t of unknownTables) allUnknown.add(t);
      if (findings.length > 0) {
        perFile.set(location, [...(perFile.get(location) ?? []), ...findings]);
      }

      if (syntaxVerifier) {
        if (
          isRecursiveCte(lit.text) ||
          hasPgvectorOperator(lit.text) ||
          lit.text.includes('__PH__')
        ) {
          syntaxUnverified++;
        } else {
          syntaxChecked++;
          const err = syntaxVerifier(lit.text);
          if (err) syntaxIssues.push({ location, message: err.split('\n')[0] });
        }
      }
    }
  }

  // ⚠️ 空扫描**不是通过**。
  //
  // 部署态（服务器上只有 dist/，没有 src/）会让 walk() 返回 0 个文件，
  // 于是「0 条 SQL 被校验」→ 没有任何 finding → 打印 PASS、退出码 0。
  // 这与本项目反复踩的其它静默失效形状完全一致（reindex 的 `Processed: 0/0`
  // 也打印「ready」并退出 0）。用一个**独立的退出码 3**把它和真正的通过区分开，
  // 这样 CI 不可能把它当成绿灯。
  if (files.length === 0) {
    console.log(`扫描 ${files.length} 个源文件，校验 ${checked} 条 SQL 字符串\n`);
    console.log('='.repeat(72));
    console.log('\x1b[33mSKIP\x1b[0m — 没扫描到任何源文件，**本次检查不构成通过**');
    console.log(`  期望的源码目录：${SRC_ROOT}`);
    console.log('  原因：部署态只有 dist/，没有 src/ —— 本检查只能在仓库内运行。');
    console.log('  正确用法：pnpm --filter @codelens/api check:sql （开发机 / CI，在仓库里）');
    console.log('  退出码 3 = 「未真正执行」，与 0（通过）刻意区分开。');
    console.log('='.repeat(72));
    process.exit(3);
  }

  console.log(`扫描 ${files.length} 个源文件，校验 ${checked} 条 SQL 字符串\n`);

  let total = 0;
  for (const [location, findings] of [...perFile.entries()].sort()) {
    console.log(`\x1b[31m${location}\x1b[0m`);
    const uniq = new Map<string, Finding>();
    for (const f of findings) uniq.set(`${f.kind}|${f.table}|${f.column}`, f);
    for (const f of uniq.values()) {
      total++;
      console.log(`  [${f.kind}] \x1b[33m${f.table}.${f.column}\x1b[0m  ← ${f.snippet}`);
    }
  }

  if (VERBOSE && allUnknown.size > 0) {
    console.log(`\n被跳过的未知表（CTE / 派生表 / 视图，共 ${allUnknown.size} 个）：`);
    console.log(`  ${[...allUnknown].sort().join(', ')}`);
  }

  // —— 语法校验结果 ——
  console.log('');
  if (!syntaxVerifier) {
    console.log('语法校验：未启用（设置 CODELENS_SQL_PARSER_DIR 可启用，见文件头说明）');
  } else {
    console.log(`语法校验：已校验 ${syntaxChecked} 条，未验证 ${syntaxUnverified} 条`);
    if (syntaxUnverified > 0) {
      console.log('  未验证原因（不计为错误）：');
      console.log('    · WITH RECURSIVE —— 解析器不支持递归 CTE');
      console.log('    · pgvector 运算符 <=> / <-> / <#> —— 不在解析器算子表内');
      console.log('    · 含模板插值占位符 —— 语句不完整');
      console.log('  ⚠ 这些语句的「列引用」仍已校验，但「语法」未经本工具验证。');
    }
    if (syntaxIssues.length > 0) {
      console.log('');
      console.log('语法疑点（解析器覆盖不全，仅供参考，需人工确认）：');
      for (const issue of syntaxIssues) {
        console.log(`  ${issue.location}  ${issue.message}`);
      }
    }
  }

  console.log(`\n${'='.repeat(72)}`);
  if (total === 0) {
    console.log('\x1b[32mPASS\x1b[0m — 未发现引用不存在的列');
    if (syntaxIssues.length > 0) {
      console.log(`INFO — 另有 ${syntaxIssues.length} 处语法疑点（见上，不作为失败）`);
    }
    console.log('='.repeat(72));
    process.exit(0);
  }
  console.log(`\x1b[31mFAIL\x1b[0m — 发现 ${total} 处引用了不存在的列`);
  console.log('');
  console.log('提示：这类缺陷在运行时表现为 `column "x" does not exist`。');
  console.log('若该查询被 try/catch 包裹，故障会被静默吞掉（表恒为空但无报错）。');
  console.log('='.repeat(72));
  process.exit(1);
}

// 仅在被**直接执行**时运行检查。
//
// 本文件的 buildSchema() / collectAlterSources() 会被 check-live-schema.ts 导入复用。
// 若在这里无条件调用 main()，仅「导入」就会触发整套检查，并且中途 process.exit()，
// 把导入方一起带走（实测表现为两个脚本的表头交替打印后崩溃）。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error('检查器自身异常：', error);
    process.exit(2);
  });
}
