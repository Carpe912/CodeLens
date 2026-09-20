/**
 * 增量索引的「变更报告」
 *
 * ============================================
 * 要回答的问题
 * ============================================
 * 增量索引跑完，用户想知道的是：**这次到底变了什么？**
 * 这个问题有两层，必须分开答，混在一起就会变成一锅粥：
 *
 * 1. **上游变了什么** —— 由 git 给出（`git-upstream.ts`）：新增/修改/删除/重命名了哪些文件、
 *    哪些提交。这是「输入」。
 * 2. **索引变了什么** —— 由本模块给出：把重建前后的实体层做差集，得到
 *    「新增了哪些函数/类/常量/接口」「删掉了哪些」「哪些只是行号挪了位置」。这是「输出」。
 *
 * 只报第 1 层的问题是：用户看到「上游改了 3 个文件」，仍不知道这对检索意味着什么
 * ——（比如新增了一个接口，那就能被搜到；只是调整缩进，那什么都没变）。
 * 只报第 2 层的问题是：看不出「为什么会有这些变化」。
 *
 * ============================================
 * 为什么用「前后快照做差」而不是「在索引过程中逐条记录」
 * ============================================
 * 逐条记录需要把埋点插进 `storeEntities` / `buildRelationships` / 引用传播的每一条路径里，
 * 任何一条路径忘了埋点就会**静默漏报**，而且这份报告本身会变成一处需要维护的耦合。
 * 快照做差是**事后推断**：只依赖「受影响文件的实体行在重建前后各是什么」，与索引内部实现解耦 ——
 * 索引器怎么改，报告都还成立。
 *
 * ============================================
 * 关键设计：把「位移」从「新增/删除」里摘出来
 * ============================================
 * 这是本模块最容易做错的地方。如果按「(路径, 符号, 行号) 三元组」直接比集合：
 * 在文件开头插一行注释，会让**该文件里所有符号的行号都 +1**，
 * 于是每个符号都同时出现在「删除」和「新增」两个列表里 ——
 * 报告会显示「新增 47 个函数、删除 47 个函数」，而实际上**一个符号都没变**。
 *
 * 所以口径必须是：**先按 (类型, 路径, 符号名) 匹配，再看行号**。
 * - 只在 after 里 → 真的新增
 * - 只在 before 里 → 真的删除
 * - 两边都在、行号不同 → 只是位移（单独一类，不计入新增/删除）
 *
 * 这也解释了为什么行号在索引里那么要紧（见 `TECHNICAL-NOTES.md` §12.0/§18）：
 * 它是**证据定位**用的坐标。符号的「身份」是名字，行号是它的「位置」——
 * 两者混为一谈，报告和检索都会失真。
 */

import { Pool } from 'pg';
import { MAX_COMMITS } from './git-upstream.js';
import type { GitCommit, GitFileChange, UpstreamStatus } from './git-upstream.js';

/** 参与报告的实体类型 */
export type EntityKind = 'function' | 'class' | 'constant' | 'urlPattern';

export interface EntityItem {
  kind: EntityKind;
  /** 仓内相对路径 */
  path: string;
  /** 符号名（URL 接口用「方法 + 规范化路径」） */
  symbol: string;
  /** 起始行号 */
  line: number;
}

/** 键 = (类型, 路径, 符号名)。行号**不进键** —— 见文件头的说明 */
type EntityKey = string;

/** 单次差集里每类最多回传多少条明细（计数仍给真实总数） */
const MAX_ITEMS = 200;
/** 符号名截断长度（字符串常量的值可能很长，报告不适合铺开） */
const MAX_SYMBOL_LEN = 120;

export interface EntityDelta {
  added: EntityItem[];
  removed: EntityItem[];
  /** 符号还在，只是起始行号变了（纯位移，不算新增/删除） */
  moved: Array<{ item: EntityItem; fromLine: number }>;
  counts: {
    added: number;
    removed: number;
    moved: number;
  };
  /** 明细是否被 MAX_ITEMS 截断（计数不受影响） */
  truncated: boolean;
}

/**
 * 一次增量索引「对索引做了什么」
 *
 * ⚠️ 注意与「上游变了什么」的区别：这里的 added/modified/deleted 是
 * **索引侧的判定结果**（拿磁盘内容与库里内容比对得出的），
 * 它已经过滤掉了「git 说变了、但内容其实一样」的情况
 * （比如只改了行尾符、或者文件被 touch 但没改内容）。
 */
export interface IndexingOutcome {
  /** 直接改动的文件（内容确实不同） */
  added: string[];
  modified: string[];
  /** 需要从索引里移除的文件 */
  deleted: string[];
  /** 引用传播带进来的文件：它们自己没被改，但因为引用了改动过的文件而必须重建 */
  propagated: string[];
  /** 实体层/关系层实际重建的文件数（= 直接改动 + 被牵连） */
  rebuiltFiles: number;
  entities: EntityDelta;
  durationMs: number;
}

function makeKey(kind: EntityKind, path: string, symbol: string): EntityKey {
  // \u0000 不可能出现在路径或符号名里，用它做分隔符不会被内容撞开
  return `${kind}\u0000${path}\u0000${symbol}`;
}

function box(item: EntityItem): EntityItem {
  return { ...item, symbol: item.symbol.slice(0, MAX_SYMBOL_LEN) };
}

/**
 * 抓「这些文件的实体层快照」
 *
 * ⚠️ **必须在删除文件之前调用**。文件一旦被删，它的 `functions` / `classes` 等行会随
 * 外键 CASCADE 一起消失（或者 `cleanupFileEntities` 主动删掉），
 * 那时再抓就只剩一份「重建前的空快照」，报告会把「删除」漏报成「什么都没发生」。
 *
 * ⚠️ 这里按 **file_id** 抓，而报告最终要按 **path** 呈现 —— 因为文件删掉之后
 * file_id 就再也映射不到路径了。所以 SQL 里 JOIN 了 files 表把 path 带出来，
 * 让快照自带路径。这也是「快照必须在删之前抓」的另一个理由。
 *
 * @param db - 数据库连接池
 * @param repoId - 仓库 ID
 * @param fileIds - 受影响的文件 ID 集合（为空时直接返回空快照，不发查询）
 */
export async function snapshotEntities(
  db: Pool,
  repoId: number,
  fileIds: number[]
): Promise<Map<EntityKey, EntityItem>> {
  const snapshot = new Map<EntityKey, EntityItem>();
  if (fileIds.length === 0) return snapshot;

  const put = (item: EntityItem) => {
    if (!item.path || !item.symbol) return;
    // 同名符号可能有多行（重载/重复声明），后者覆盖前者即可 ——
    // 这里只关心「这个符号还在不在、在哪一行」
    snapshot.set(makeKey(item.kind, item.path, item.symbol), item);
  };

  // 1) 函数：full_name 比分文件内的 name 更能标识身份（含类名前缀）
  const functions = await db.query(
    `
    SELECT f.path, COALESCE(fu.full_name, fu.name) AS symbol, fu.line_start
    FROM functions fu
    JOIN files f ON f.id = fu.file_id
    WHERE fu.repo_id = $1 AND fu.file_id = ANY($2)
  `,
    [repoId, fileIds]
  );
  for (const r of functions.rows) {
    put({ kind: 'function', path: r.path, symbol: r.symbol, line: r.line_start });
  }

  // 2) 类 / 接口 / 类型别名 / 枚举
  const classes = await db.query(
    `
    SELECT f.path, COALESCE(cl.full_name, cl.name) AS symbol, cl.line_start
    FROM classes cl
    JOIN files f ON f.id = cl.file_id
    WHERE cl.repo_id = $1 AND cl.file_id = ANY($2)
  `,
    [repoId, fileIds]
  );
  for (const r of classes.rows) {
    put({ kind: 'class', path: r.path, symbol: r.symbol, line: r.line_start });
  }

  // 3) 字符串常量：没有名字时退化成「值」，否则匿名常量会被整批漏掉
  const constants = await db.query(
    `
    SELECT f.path, COALESCE(sc.symbol_name, sc.string_value) AS symbol, sc.line_start
    FROM string_constants sc
    JOIN files f ON f.id = sc.file_id
    WHERE sc.repo_id = $1 AND sc.file_id = ANY($2)
  `,
    [repoId, fileIds]
  );
  for (const r of constants.rows) {
    put({ kind: 'constant', path: r.path, symbol: r.symbol, line: r.line_start });
  }

  // 4) URL 接口：⚠️ 归属列是 definition_file_id（不是 file_id），
  //    而且这张表是**跨文件共享**的（一个接口一行）。
  const urlPatterns = await db.query(
    `
    SELECT f.path,
           (COALESCE(up.method, '') || ' ' || up.normalized_pattern) AS symbol,
           up.definition_line
    FROM url_patterns up
    JOIN files f ON f.id = up.definition_file_id
    WHERE up.repo_id = $1 AND up.definition_file_id = ANY($2)
  `,
    [repoId, fileIds]
  );
  for (const r of urlPatterns.rows) {
    put({ kind: 'urlPattern', path: r.path, symbol: r.symbol, line: r.definition_line });
  }

  return snapshot;
}

/**
 * 比较两份快照，得出「新增 / 删除 / 位移」
 *
 * 判定顺序是刻意的：先按 (类型, 路径, 符号) 匹配身份，再比行号。
 * 这样「插了一行导致整文件行号下移」只会体现为 moved，不会污染 added/removed。
 */
export function diffEntitySnapshots(
  before: Map<EntityKey, EntityItem>,
  after: Map<EntityKey, EntityItem>
): EntityDelta {
  const added: EntityItem[] = [];
  const removed: EntityItem[] = [];
  const moved: Array<{ item: EntityItem; fromLine: number }> = [];

  let addedCount = 0;
  let removedCount = 0;
  let movedCount = 0;

  for (const [key, item] of after) {
    const prev = before.get(key);
    if (!prev) {
      addedCount++;
      if (added.length < MAX_ITEMS) added.push(box(item));
    } else if (prev.line !== item.line) {
      movedCount++;
      if (moved.length < MAX_ITEMS) moved.push({ item: box(item), fromLine: prev.line });
    }
  }

  for (const [key, item] of before) {
    if (!after.has(key)) {
      removedCount++;
      if (removed.length < MAX_ITEMS) removed.push(box(item));
    }
  }

  return {
    added,
    removed,
    moved,
    counts: { added: addedCount, removed: removedCount, moved: movedCount },
    truncated:
      addedCount > added.length || removedCount > removed.length || movedCount > moved.length,
  };
}

/** 空的差集（无变更时用，省掉一次快照开销） */
export function emptyDelta(): EntityDelta {
  return {
    added: [],
    removed: [],
    moved: [],
    counts: { added: 0, removed: 0, moved: 0 },
    truncated: false,
  };
}

// =====================================================================
// 落库的报告
// =====================================================================

/** 存进 `repos.last_incremental` 的那一份。上游侧（git）与索引侧（实体差集）都在里面 */
export interface IncrementalReport {
  /** 生成时间（ISO） */
  at: string;
  /**
   * `incremental` = 走了一次快进 + 增量；
   * `full` = 落到了全量（目录不存在 / 不是 git 工作区 / 首次索引）。
   * UI 必须把这两者区分开 —— 看到「全量」就不该期待「只改了 3 个文件」。
   */
  mode: 'incremental' | 'full';
  branch?: string;
  /** 本次快进前的 HEAD */
  fromSha?: string;
  /** 快进后的 HEAD */
  toSha?: string;
  ahead?: number;
  behind?: number;
  commits?: GitCommit[];
  gitFiles?: GitFileChange[];
  gitSummary?: UpstreamStatus['summary'];
  /** 索引侧结果；未跑索引（无变更 / 全量）时缺省 */
  outcome?: IndexingOutcome;
  /** 没能给出报告时的原因（例如「上游 0 变更」） */
  note?: string;
}

/** 上游文件明细落库上限 —— 报告是给人看的，不是归档 */
const MAX_GIT_FILES = 300;

/** 列表类字段统一截断，避免一次大同步把 JSONB 写爆 */
function capList<T>(list: T[], limit: number): { list: T[]; truncated: boolean } {
  return list.length <= limit
    ? { list, truncated: false }
    : { list: list.slice(0, limit), truncated: true };
}

/**
 * 由上游状态 + 索引结果拼出一份报告。
 *
 * 不在这里读数据库：调用方（`refreshGitLabRepo`）手上已经有全部素材，
 * 拼装逻辑做成纯函数才好单测。
 */
export function buildIncrementalReport(input: {
  mode: IncrementalReport['mode'];
  status?: UpstreamStatus | null;
  fromSha?: string;
  outcome?: IndexingOutcome | null;
  note?: string;
}): IncrementalReport {
  const report: IncrementalReport = {
    at: new Date().toISOString(),
    mode: input.mode,
  };

  if (input.status) {
    const { status } = input;
    report.branch = status.branch;
    report.fromSha = input.fromSha ?? status.localSha;
    report.toSha = status.upstreamSha;
    report.ahead = status.ahead;
    report.behind = status.behind;
    report.commits = capList(status.commits, MAX_COMMITS).list;
    const files = capList(status.files, MAX_GIT_FILES);
    report.gitFiles = files.list;
    report.gitSummary = status.summary;
    if (files.truncated) {
      // 用 note 明说被截断，否则 UI 会以为「总共就这么多文件」
      report.note = `上游文件明细超过 ${MAX_GIT_FILES} 条已截断（计数为真实总数）`;
    }
  }

  if (input.outcome) report.outcome = input.outcome;
  if (input.note) report.note = report.note ? `${report.note}；${input.note}` : input.note;

  return report;
}

/** 把报告写到 `repos.last_incremental`（只保留最新一份） */
export async function saveIncrementalReport(
  db: Pool,
  repoId: number,
  report: IncrementalReport
): Promise<void> {
  await db.query(`UPDATE repos SET last_incremental = $1::jsonb WHERE id = $2`, [
    JSON.stringify(report),
    repoId,
  ]);
}
