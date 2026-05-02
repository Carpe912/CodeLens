/**
 * Result deduplication utilities
 * 结果去重增强：基于内容相似度和位置的智能去重
 */

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = Array(b.length + 1)
    .fill(null)
    .map(() => Array(a.length + 1).fill(0));

  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j - 1][i] + 1, // deletion
        matrix[j][i - 1] + 1, // insertion
        matrix[j - 1][i - 1] + cost // substitution
      );
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calculate content similarity ratio (0-1)
 */
export function contentSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;

  const maxLen = Math.max(a.length, b.length);
  const distance = levenshteinDistance(a, b);
  return 1 - distance / maxLen;
}

/**
 * Normalize code content for comparison
 * 标准化代码内容：移除空白、注释等
 */
export function normalizeCode(code: string): string {
  return code
    .replace(/\/\/.*$/gm, '') // 移除单行注释
    .replace(/\/\*[\s\S]*?\*\//g, '') // 移除多行注释
    .replace(/\s+/g, ' ') // 标准化空白
    .trim();
}

/**
 * Check if two code snippets are duplicates
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
 * Check if two results are from overlapping locations
 */
export function isOverlappingLocation(
  file1: string,
  line1Start: number,
  line1End: number,
  file2: string,
  line2Start: number,
  line2End: number
): boolean {
  // Different files -> not overlapping
  if (file1 !== file2) return false;

  // Check line range overlap
  return !(line1End < line2Start || line2End < line1Start);
}

/**
 * Deduplicate results based on content similarity and location
 */
export interface DeduplicatableResult {
  id: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  score: number;
}

export function deduplicateResults<T extends DeduplicatableResult>(
  results: T[],
  options: {
    contentThreshold?: number; // 内容相似度阈值 (0-1)
    checkLocation?: boolean; // 是否检查位置重叠
    keepHighestScore?: boolean; // 保留最高分的结果
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

  // Sort by score descending if keeping highest score
  const sorted = keepHighestScore
    ? [...results].sort((a, b) => b.score - a.score)
    : results;

  for (const result of sorted) {
    let isDuplicate = false;

    // Check against already added results
    for (const existing of deduplicated) {
      // 1. Check exact ID match
      if (result.id === existing.id) {
        isDuplicate = true;
        break;
      }

      // 2. Check location overlap
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

      // 3. Check content similarity
      if (isDuplicateContent(result.content, existing.content, contentThreshold)) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      deduplicated.push(result);
      seen.add(result.id);
    }
  }

  return deduplicated;
}

/**
 * Merge similar results by averaging scores
 */
export function mergeSimilarResults<T extends DeduplicatableResult>(
  results: T[],
  contentThreshold: number = 0.95
): T[] {
  if (results.length === 0) return [];

  const merged: T[] = [];
  const processed = new Set<number>();

  for (let i = 0; i < results.length; i++) {
    if (processed.has(i)) continue;

    const current = results[i];
    const similar: T[] = [current];

    // Find similar results
    for (let j = i + 1; j < results.length; j++) {
      if (processed.has(j)) continue;

      const candidate = results[j];

      if (
        current.filePath === candidate.filePath &&
        isDuplicateContent(current.content, candidate.content, contentThreshold)
      ) {
        similar.push(candidate);
        processed.add(j);
      }
    }

    // Merge: keep the one with highest score, average the scores
    const best = similar.reduce((prev, curr) => (curr.score > prev.score ? curr : prev));
    const avgScore = similar.reduce((sum, r) => sum + r.score, 0) / similar.length;

    merged.push({
      ...best,
      score: avgScore,
    });

    processed.add(i);
  }

  return merged;
}
