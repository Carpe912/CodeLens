/**
 * 答案 ↔ 证据 一致性自检
 *
 * ============================================
 * 它要抓的那类失败
 * ============================================
 * 提示词要求模型「给出关键证据（文件路径和行号）」。模型很擅长把这个格式
 * **仿写**出来：它知道答案长这样，于是会写出 `src/auth/login.ts:88` 这样
 * 精确到行号的引用 —— 而这个文件可能压根不在本轮证据里。
 *
 * 这是最危险的一种错：**形式上完全符合要求，看起来最可信**。
 * 用户看到「文件:行号」会默认它可点、可查、可核对。
 * 而纯文本答案里，我们没有任何东西告诉用户「这条引用是编的」。
 *
 * 本模块就是那唯一一道拦截：把答案里出现的 `路径:行号` 全部抽出来，
 * 逐条与**本轮证据集**比对，把对不上的挑出来。
 *
 * ============================================
 * 设计原则：只观测，不改写
 * ============================================
 * 本模块**不修改答案**、不删引用、不重写内容，只产出一份可判定的报告。
 * 理由：自动删引用会把「模型编了行号」变成「答案里没有行号」，
 * 错误被藏起来而不是被暴露出来 —— 与本项目一向的口径相反。
 * 报告随响应一起返回，让调用方（前端 / 评测脚本）自己决定怎么呈现。
 *
 * ============================================
 * 已知的判定边界（刻意取舍，不是遗漏）
 * ============================================
 * 1. 文件匹配允许「路径段边界上的后缀匹配」：
 *      答案写 `qa.ts` 或 `llm/qa.ts`，都能匹配上证据里的
 *      `apps/api/src/llm/qa.ts`（模型经常省略前缀）。
 *    代价：不同目录下的同名文件（如多个 `index.ts`）可能被误判为「匹配上了」。
 *    这是**刻意**偏向「少报」：如果对每个裸文件名都报 unsupported，
 *    报告会被噪声淹没，没人再看它 —— 那等于没有这道拦截。
 * 2. 大小写敏感。本仓路径大小写一致，放宽会引入更难查的误判。
 * 3. 只在答案**确实写了行号**时才做行号区间校验；没写行号的引用只校验文件。
 *
 * 纯函数、无 I/O —— 因此可以被 `verify:memory` 这类离线脚本直接断言。
 */

/** 参与比对的证据形状（只取需要的字段，便于测试构造） */
export interface EvidenceLike {
  file_path?: string;
  line_start?: number;
  line_end?: number;
}

/** 单条引用 */
export interface Citation {
  /** 答案里的原始引用文本，如 `apps/api/src/llm/qa.ts:399` */
  raw: string;
  /** 抽取出的文件路径 */
  file: string;
  /** 抽取出的行号；引用未带行号时为 null */
  line: number | null;
  /** 该文件是否能在本轮证据中找到 */
  fileMatched: boolean;
  /**
   * 行号是否落在该文件的某条证据区间内。
   * - true  = 落在区间内
   * - false = 文件匹配上了，但行号在所有区间之外（编造行号的强信号）
   * - null  = 无法判定（没写行号，或证据侧没有行号）
   */
  lineInEvidence: boolean | null;
}

export type ConsistencyVerdict =
  /** 所有引用都能在证据里对上 */
  | 'ok'
  /** 答案里没有出现任何 `路径:行号` 引用，无从校验（不算失败） */
  | 'no_refs'
  /** 本轮没有任何证据，无从校验 */
  | 'empty_evidence'
  /** 存在引用了证据里没有的文件 —— 幻觉引用的强信号 */
  | 'unsupported_refs'
  /** 文件都对得上，但有行号落在所有证据区间之外 */
  | 'line_mismatch';

export interface ConsistencyReport {
  verdict: ConsistencyVerdict;
  /** 抽到的全部引用 */
  citations: Citation[];
  /** 文件对不上的引用原文 */
  unsupported: string[];
  /** 文件对得上但行号越界的引用原文 */
  mismatchedLines: string[];
}

/**
 * 从答案里抽取 `路径:行号` 形态的引用。
 *
 * 只接受带扩展名的路径 + `:数字`（可带 `-数字` 区间），
 * 借扩展名把「时间 12:30」这类噪声挡在外面。
 *
 * ⚠️ URL 必须显式排除，否则 `https://example.com:8080` 会被当成
 * 「文件 example.com 的第 8080 行」——把每个带端口的 URL 都变成一条假引用。
 * 排除不能只靠「向前找 `//`」：路径字符类里**包含 `/`**，所以正则实际
 * 会从 `//example.com` 起匹配（m.index 落在两个斜杠上），
 * 向前两字符恰好是 `s:`，`includes('//')` 判不出来。
 * 因此改用「紧邻的上一字符是不是 `:`」作为判据：`://` 的 `:` 一定紧贴着。
 */
function extractCitations(answer: string): Array<{ raw: string; file: string; line: number | null }> {
  const out: Array<{ raw: string; file: string; line: number | null }> = [];
  const re = /([A-Za-z0-9_\-./\\]+\.[A-Za-z0-9]+):(\d+)(?:\s*[-–~]\s*(\d+))?/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    const raw = m[0];
    const file = m[1];
    if (!file) continue;

    // `scheme://host:port` 的排除（见上方注释）
    const prevChar = m.index > 0 ? answer[m.index - 1] : '';
    if (prevChar === ':') continue;

    // 兜底：无 scheme 的 `//host:port`，路径本身以 // 开头也不是合法引用
    if (file.startsWith('//')) continue;

    out.push({ raw, file, line: parseInt(m[2], 10) });
  }

  return out;
}

/** 路径规范化：统一分隔符、去掉 `./` 与开头斜杠 */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * 文件是否匹配。
 *
 * 精确相等，或「路径段边界上的后缀」相等 —— 后者让答案里的
 * 简写路径（`llm/qa.ts`）能对应到证据里的全路径。
 * 用 `'/' + c` 而不是裸 `endsWith(c)`，避免 `xqa.ts` 匹配上 `qa.ts`。
 */
function fileMatches(cited: string, evidencePath: string): boolean {
  const c = normPath(cited);
  const e = normPath(evidencePath);
  if (!c || !e) return false;
  if (c === e) return true;
  return e.endsWith('/' + c);
}

/**
 * 校验答案里的引用是否都能在本轮证据中找到。
 *
 * @param answer   LLM 生成的答案
 * @param evidence 本轮检索到的证据（与 `/ask` 返回给前端的同一批）
 */
export function checkAnswerConsistency(
  answer: string,
  evidence: EvidenceLike[]
): ConsistencyReport {
  const citations: Citation[] = [];

  // 只保留有路径的证据；路径缺失的条目无法参与比对
  const ev = (evidence || []).filter(e => !!e && typeof e.file_path === 'string' && e.file_path);

  if (ev.length === 0) {
    // 无证据可依 —— 但答案里若仍有具体引用，那本身就是问题：
    // 没有证据时模型给出的「文件:行号」只可能来自记忆或编造。
    // 这里仍返回 empty_evidence 让调用方区分「没证据」与「证据对不上」，
    // 引用列表照常给出，便于人工判断。
    const raw = typeof answer === 'string' ? extractCitations(answer) : [];
    return {
      verdict: 'empty_evidence',
      citations: raw.map(r => ({ ...r, fileMatched: false, lineInEvidence: null })),
      unsupported: [],
      mismatchedLines: [],
    };
  }

  if (typeof answer !== 'string' || !answer.trim()) {
    return { verdict: 'no_refs', citations: [], unsupported: [], mismatchedLines: [] };
  }

  const extracted = extractCitations(answer);
  if (extracted.length === 0) {
    return { verdict: 'no_refs', citations: [], unsupported: [], mismatchedLines: [] };
  }

  const unsupported: string[] = [];
  const mismatchedLines: string[] = [];

  for (const c of extracted) {
    const hits = ev.filter(e => fileMatches(c.file, e.file_path!));

    if (hits.length === 0) {
      citations.push({ ...c, fileMatched: false, lineInEvidence: null });
      unsupported.push(c.raw);
      continue;
    }

    // 行号校验：只在引用写了行号、且证据侧有行号区间时才判定
    let lineInEvidence: boolean | null = null;
    if (c.line !== null) {
      const ranges = hits.filter(
        h => typeof h.line_start === 'number' && typeof h.line_end === 'number'
      );
      if (ranges.length > 0) {
        lineInEvidence = ranges.some(
          h => c.line! >= (h.line_start as number) && c.line! <= (h.line_end as number)
        );
        if (!lineInEvidence) mismatchedLines.push(c.raw);
      }
    }

    citations.push({ ...c, fileMatched: true, lineInEvidence });
  }

  const verdict: ConsistencyVerdict =
    unsupported.length > 0 ? 'unsupported_refs'
      : mismatchedLines.length > 0 ? 'line_mismatch'
        : 'ok';

  return { verdict, citations, unsupported, mismatchedLines };
}

/**
 * 把「需要人工关注」的判定格式化成一行告警文案；判定正常时返回 null。
 *
 * 存在的原因：`/ask`、`/root-cause`、`AgentCore`、编排图四条链路都要打同一句日志。
 * 文案分散在各处必然漂移 —— 某天只在一条链路上补上「行号越界」，
 * 另一条就静默漏报。判定留在 checkAnswerConsistency，措辞留在这里，
 * 调用方只负责决定要不要 warn 以及标签叫什么。
 */
export function describeConsistencyIssue(
  report: ConsistencyReport,
  label: string
): string | null {
  if (report.verdict !== 'unsupported_refs' && report.verdict !== 'line_mismatch') {
    return null;
  }

  return (
    `${label} 答案引用与证据不一致 (${report.verdict}): ` +
    `未匹配文件 [${report.unsupported.join(', ')}]` +
    `${report.mismatchedLines.length ? ` 行号越界 [${report.mismatchedLines.join(', ')}]` : ''}`
  );
}
