/**
 * 搜索结果去重工具
 * 基于内容相似度和位置的智能去重
 *
 * 核心功能：
 * 1. 编辑距离计算（Levenshtein Distance）
 * 2. 内容相似度分析
 * 3. 代码标准化（去除注释和空白）
 * 4. 位置重叠检测
 * 5. 智能去重和合并
 *
 * 使用场景：
 * - 搜索结果去重：避免返回重复的代码片段
 * - 相似代码检测：识别功能相近的代码块
 * - 结果合并：将相似结果合并以提升质量
 */

/**
 * 计算两个字符串之间的 Levenshtein 编辑距离
 *
 * Levenshtein 距离定义：
 * 将字符串 a 转换为字符串 b 所需的最少单字符编辑操作次数
 * 允许的操作：插入、删除、替换
 *
 * 算法：动态规划
 * 时间复杂度：O(m * n)，其中 m 和 n 是两个字符串的长度
 * 空间复杂度：O(m * n)
 *
 * @param a 第一个字符串
 * @param b 第二个字符串
 * @returns 编辑距离（非负整数）
 *
 * 示例：
 * levenshteinDistance('kitten', 'sitting') => 3
 * - kitten → sitten (替换 k 为 s)
 * - sitten → sittin (替换 e 为 i)
 * - sittin → sitting (插入 g)
 */
function levenshteinDistance(a: string, b: string): number {
  // 边界情况：空字符串
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // 创建 DP 矩阵：matrix[i][j] 表示 b[0..i] 到 a[0..j] 的编辑距离
  const matrix: number[][] = Array(b.length + 1)
    .fill(null)
    .map(() => Array(a.length + 1).fill(0));

  // 初始化第一行：从空字符串到 a[0..j] 需要 j 次插入
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  // 初始化第一列：从空字符串到 b[0..j] 需要 j 次插入
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;

  // 动态规划填表
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      // 如果字符相同，不需要操作
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j - 1][i] + 1,       // 删除 b[j-1]
        matrix[j][i - 1] + 1,       // 插入 a[i-1]
        matrix[j - 1][i - 1] + cost // 替换（如果需要）
      );
    }
  }

  return matrix[b.length][a.length];
}

/**
 * 计算两个字符串的内容相似度
 *
 * @param a 第一个字符串
 * @param b 第二个字符串
 * @returns 相似度比率，范围 [0, 1]，1 表示完全相同
 *
 * 计算公式：
 * similarity = 1 - (editDistance / maxLength)
 *
 * 示例：
 * contentSimilarity('hello', 'hallo') => 0.8
 * contentSimilarity('abc', 'abc') => 1.0
 */
export function contentSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;  // 完全相同
  if (!a || !b) return 0.0; // 任一为空

  const maxLen = Math.max(a.length, b.length);
  const distance = levenshteinDistance(a, b);
  return 1 - distance / maxLen;
}

/**
 * 标准化代码内容以便比较
 *
 * 标准化步骤：
 * 1. 移除单行注释（// ...）
 * 2. 移除多行注释（/* ... *\/）
 * 3. 标准化空白字符（多个空格/换行 → 单个空格）
 * 4. 去除首尾空白
 *
 * @param code 原始代码字符串
 * @returns 标准化后的代码
 *
 * 使用场景：
 * - 比较代码逻辑是否相同（忽略注释和格式）
 * - 检测重复代码
 *
 * 示例：
 * normalizeCode('const x = 1; // comment\n  const y = 2;')
 * => 'const x = 1; const y = 2;'
 */
export function normalizeCode(code: string): string {
  return code
    .replace(/\/\/.*$/gm, '')        // 移除单行注释
    .replace(/\/\*[\s\S]*?\*\//g, '') // 移除多行注释
    .replace(/\s+/g, ' ')            // 标准化空白
    .trim();
}

/**
 * 检查两个代码片段是否为重复内容
 *
 * @param content1 第一个代码片段
 * @param content2 第二个代码片段
 * @param threshold 相似度阈值，默认 0.9（90% 相似即视为重复）
 * @returns 如果相似度 >= 阈值则返回 true
 *
 * 实现细节：
 * 1. 先标准化代码（去除注释和空白）
 * 2. 计算标准化后的相似度
 * 3. 与阈值比较
 */
export function isDuplicateContent(
  content1: string,
  content2: string,
  threshold: number = 0.9
): boolean {
  const normalized1 = normalizeCode(content1);
  const normalized2 = normalizeCode(content2);

  const similarity = contentSimilarity(normalized1, normalized2);
  return similarity >= threshold;
}

/**
 * 检查两个结果是否来自重叠的位置
 *
 * @param file1 第一个文件路径
 * @param line1Start 第一个结果的起始行
 * @param line1End 第一个结果的结束行
 * @param file2 第二个文件路径
 * @param line2Start 第二个结果的起始行
 * @param line2End 第二个结果的结束行
 * @returns 如果位置重叠返回 true
 *
 * 重叠判断逻辑：
 * - 不同文件 → 不重叠
 * - 同一文件 → 检查行范围是否有交集
 *
 * 行范围重叠条件：
 * NOT (range1 完全在 range2 之前 OR range2 完全在 range1 之前)
 */
export function isOverlappingLocation(
  file1: string,
  line1Start: number,
  line1End: number,
  file2: string,
  line2Start: number,
  line2End: number
): boolean {
  // 不同文件 → 不重叠
  if (file1 !== file2) return false;

  // 检查行范围是否重叠
  // 不重叠的情况：range1 完全在 range2 之前 OR range2 完全在 range1 之前
  return !(line1End < line2Start || line2End < line1Start);
}

/**
 * 可去重结果的接口定义
 */
export interface DeduplicatableResult {
  id: string;         // 唯一标识符
  filePath: string;   // 文件路径
  lineStart: number;  // 起始行号
  lineEnd: number;    // 结束行号
  content: string;    // 代码内容
  score: number;      // 相关性分数
}

/**
 * 对搜索结果进行智能去重
 *
 * @param results 待去重的结果列表
 * @param options 去重选项
 * @returns 去重后的结果列表
 *
 * 去重策略（按优先级）：
 * 1. ID 完全匹配 → 视为重复
 * 2. 位置重叠检测 → 同一文件的重叠行范围视为重复
 * 3. 内容相似度 → 相似度超过阈值视为重复
 *
 * 选项说明：
 * - contentThreshold: 内容相似度阈值（0-1），默认 0.9
 * - checkLocation: 是否检查位置重叠，默认 true
 * - keepHighestScore: 是否保留最高分结果，默认 true
 *
 * 实现细节：
 * - 如果 keepHighestScore=true，先按分数降序排序
 * - 遍历结果，与已添加的结果逐一比较
 * - 发现重复则跳过，否则添加到结果集
 */
export function deduplicateResults<T extends DeduplicatableResult>(
  results: T[],
  options: {
    contentThreshold?: number;   // 内容相似度阈值 (0-1)
    checkLocation?: boolean;     // 是否检查位置重叠
    keepHighestScore?: boolean;  // 保留最高分的结果
  } = {}
): T[] {
  const {
    contentThreshold = 0.9,
    checkLocation = true,
    keepHighestScore = true,
  } = options;

  if (results.length === 0) return [];

  const deduplicated: T[] = [];
  const seen = new Set<string>();

  // 如果保留最高分，先按分数降序排序
  const sorted = keepHighestScore
    ? [...results].sort((a, b) => b.score - a.score)
    : results;

  for (const result of sorted) {
    let isDuplicate = false;

    // 与已添加的结果逐一比较
    for (const existing of deduplicated) {
      // 策略 1：检查 ID 是否完全匹配
      if (result.id === existing.id) {
        isDuplicate = true;
        break;
      }

      // 策略 2：检查位置是否重叠
      if (checkLocation) {
        if (
          isOverlappingLocation(
            result.filePath,
            result.lineStart,
            result.lineEnd,
            existing.filePath,
            existing.lineStart,
            existing.lineEnd
          )
        ) {
          isDuplicate = true;
          break;
        }
      }

      // 策略 3：检查内容相似度
      if (isDuplicateContent(result.content, existing.content, contentThreshold)) {
        isDuplicate = true;
        break;
      }
    }

    // 如果不是重复，添加到结果集
    if (!isDuplicate) {
      deduplicated.push(result);
      seen.add(result.id);
    }
  }

  return deduplicated;
}

/**
 * 合并相似的搜索结果（通过平均分数）
 *
 * @param results 待合并的结果列表
 * @param contentThreshold 内容相似度阈值，默认 0.95（更严格）
 * @returns 合并后的结果列表
 *
 * 合并策略：
 * 1. 找出所有相似的结果（同一文件 + 内容相似度 >= 阈值）
 * 2. 保留分数最高的结果
 * 3. 将所有相似结果的分数取平均值作为最终分数
 *
 * 使用场景：
 * - 多个搜索引擎返回相似结果时，合并以提升排名
 * - 减少结果数量，提升用户体验
 *
 * 示例：
 * 输入：[{score: 0.9, content: 'foo'}, {score: 0.8, content: 'foo'}]
 * 输出：[{score: 0.85, content: 'foo'}] // 平均分数
 */
export function mergeSimilarResults<T extends DeduplicatableResult>(
  results: T[],
  contentThreshold: number = 0.95
): T[] {
  if (results.length === 0) return [];

  const merged: T[] = [];
  const processed = new Set<number>(); // 记录已处理的索引

  for (let i = 0; i < results.length; i++) {
    if (processed.has(i)) continue;

    const current = results[i];
    const similar: T[] = [current]; // 相似结果组

    // 查找所有与当前结果相似的结果
    for (let j = i + 1; j < results.length; j++) {
      if (processed.has(j)) continue;

      const candidate = results[j];

      // 判断条件：同一文件 + 内容相似
      if (
        current.filePath === candidate.filePath &&
        isDuplicateContent(current.content, candidate.content, contentThreshold)
      ) {
        similar.push(candidate);
        processed.add(j); // 标记为已处理
      }
    }

    // 合并：保留最高分的结果，分数取平均值
    const best = similar.reduce((prev, curr) => (curr.score > prev.score ? curr : prev));
    const avgScore = similar.reduce((sum, r) => sum + r.score, 0) / similar.length;

    merged.push({
      ...best,
      score: avgScore, // 使用平均分数
    });

    processed.add(i);
  }

  return merged;
}
