/**
 * 搜索建议和拼写纠错工具
 *
 * 核心功能：
 * 1. Levenshtein 编辑距离计算
 * 2. 字符串相似度分析
 * 3. 相似词查找
 * 4. 常见拼写错误纠正
 * 5. 关键词提取（驼峰/下划线拆分）
 * 6. 智能搜索建议生成
 *
 * 使用场景：
 * - 搜索查询优化：纠正用户输入的拼写错误
 * - 智能提示：提供相似的搜索词建议
 * - 关键词提取：从复合词中提取关键词
 */

/**
 * 计算两个字符串之间的 Levenshtein 编辑距离
 *
 * Levenshtein 距离定义：
 * 将字符串 a 转换为字符串 b 所需的最少单字符编辑操作次数
 * 允许的操作：插入、删除、替换
 *
 * 算法：动态规划
 * 时间复杂度：O(m * n)
 * 空间复杂度：O(m * n)
 *
 * @param a 第一个字符串
 * @param b 第二个字符串
 * @returns 编辑距离（非负整数）
 *
 * 示例：
 * levenshteinDistance('kitten', 'sitting') => 3
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  // 初始化第一列：从空字符串到 b[0..i] 需要 i 次插入
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  // 初始化第一行：从空字符串到 a[0..j] 需要 j 次插入
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  // 动态规划填表
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        // 字符相同，不需要操作
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        // 字符不同，选择代价最小的操作
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // 替换
          matrix[i][j - 1] + 1,     // 插入
          matrix[i - 1][j] + 1      // 删除
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * 计算两个字符串的相似度比率
 *
 * @param a 第一个字符串
 * @param b 第二个字符串
 * @returns 相似度比率，范围 [0, 1]，1 表示完全相同
 *
 * 计算公式：
 * similarity = 1 - (editDistance / maxLength)
 *
 * 特点：
 * - 不区分大小写
 * - 考虑字符串长度差异
 *
 * 示例：
 * similarityRatio('hello', 'hallo') => 0.8
 * similarityRatio('test', 'TEST') => 1.0
 */
function similarityRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0; // 两个空字符串视为完全相同
  const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
  return 1 - distance / maxLen;
}

/**
 * 从字典中查找相似的词条
 *
 * @param query 查询词
 * @param dictionary 词典数组
 * @param threshold 相似度阈值，默认 0.6（60% 相似）
 * @param maxResults 最多返回结果数，默认 5
 * @returns 相似词数组，按相似度降序排列
 *
 * 算法流程：
 * 1. 计算查询词与字典中每个词的相似度
 * 2. 过滤相似度 >= 阈值的词
 * 3. 按相似度降序排序
 * 4. 返回前 N 个结果
 *
 * 使用场景：
 * - 拼写纠错：找到最接近的正确拼写
 * - 搜索建议：提供相关的搜索词
 *
 * 示例：
 * findSimilarTerms('functoin', ['function', 'action', 'section'], 0.6, 3)
 * => [{ term: 'function', similarity: 0.875 }, { term: 'action', similarity: 0.625 }]
 */
export function findSimilarTerms(
  query: string,
  dictionary: string[],
  threshold: number = 0.6,
  maxResults: number = 5
): Array<{ term: string; similarity: number }> {
  const queryLower = query.toLowerCase();

  const similarities = dictionary
    .map((term) => ({
      term,
      similarity: similarityRatio(queryLower, term.toLowerCase()),
    }))
    .filter((item) => item.similarity >= threshold) // 过滤低相似度
    .sort((a, b) => b.similarity - a.similarity)    // 降序排序
    .slice(0, maxResults);                          // 取前 N 个

  return similarities;
}

/**
 * 常见编程拼写错误映射表
 *
 * 收录内容：
 * - 常见关键字拼写错误（function, return, const 等）
 * - HTTP 方法拼写错误（get, post, delete 等）
 * - API 术语拼写错误（authentication, authorization 等）
 *
 * 维护建议：
 * - 根据用户实际错误日志持续更新
 * - 优先收录高频错误
 */
const COMMON_TYPOS: Record<string, string> = {
  // 常见关键字拼写错误
  fucntion: 'function',
  funciton: 'function',
  retrun: 'return',
  reutrn: 'return',
  cosnt: 'const',
  conts: 'const',
  improt: 'import',
  imoprt: 'import',
  exoprt: 'export',
  exprot: 'export',
  calss: 'class',
  clsas: 'class',
  interfce: 'interface',
  interafce: 'interface',
  asynch: 'async',
  awiat: 'await',
  promies: 'promise',
  promse: 'promise',
  obejct: 'object',
  ojbect: 'object',
  arary: 'array',
  arry: 'array',
  lenght: 'length',
  heigth: 'height',
  widht: 'width',

  // HTTP 方法拼写错误
  gt: 'get',
  pst: 'post',
  delte: 'delete',
  delet: 'delete',

  // 常见 API 术语拼写错误
  athentication: 'authentication',
  authetication: 'authentication',
  autorization: 'authorization',
  authroization: 'authorization',
  valiation: 'validation',
  validtion: 'validation',
};

/**
 * 纠正查询中的常见拼写错误
 *
 * @param query 原始查询字符串
 * @returns 包含纠正后的查询和是否有纠正的标志
 *
 * 实现细节：
 * 1. 按空格分割查询为单词
 * 2. 对每个单词检查是否在错误映射表中
 * 3. 如果存在则替换为正确拼写
 * 4. 重新组合为字符串
 *
 * 特点：
 * - 不区分大小写
 * - 保留原始单词间的空格
 *
 * 示例：
 * correctTypos('fucntion retrun value')
 * => { corrected: 'function return value', hasCorrected: true }
 */
export function correctTypos(query: string): { corrected: string; hasCorrected: boolean } {
  const words = query.split(/\s+/);
  let hasCorrected = false;

  const correctedWords = words.map((word) => {
    const lowerWord = word.toLowerCase();
    if (COMMON_TYPOS[lowerWord]) {
      hasCorrected = true;
      return COMMON_TYPOS[lowerWord];
    }
    return word;
  });

  return {
    corrected: correctedWords.join(' '),
    hasCorrected,
  };
}

/**
 * 从驼峰或下划线命名中提取关键词
 *
 * @param text 待提取的文本
 * @returns 关键词数组（已去重和转小写）
 *
 * 支持的格式：
 * - camelCase: getUserName → ['get', 'user', 'name']
 * - PascalCase: GetUserName → ['get', 'user', 'name']
 * - snake_case: get_user_name → ['get', 'user', 'name']
 * - kebab-case: get-user-name → ['get', 'user', 'name']
 *
 * 算法步骤：
 * 1. 拆分驼峰命名（在小写字母后跟大写字母处切分）
 * 2. 拆分下划线、短横线、空格
 * 3. 过滤空字符串
 * 4. 转小写并去重
 *
 * 使用场景：
 * - 搜索优化：将复合词拆分为独立关键词
 * - 代码分析：提取函数名、变量名中的语义
 *
 * 示例：
 * extractKeywords('getUserName_fromAPI')
 * => ['get', 'user', 'name', 'from', 'api']
 */
export function extractKeywords(text: string): string[] {
  // 拆分驼峰命名：在小写字母后跟大写字母处插入空格
  const camelCaseSplit = text.replace(/([a-z])([A-Z])/g, '$1 $2');

  // 拆分下划线、短横线、空格
  const words = camelCaseSplit
    .split(/[_\-\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());

  // 去重
  return [...new Set(words)];
}

/**
 * 搜索建议接口
 */
export interface SearchSuggestion {
  type: 'typo' | 'similar' | 'keyword'; // 建议类型
  original: string;                      // 原始输入
  suggestion: string;                    // 建议内容
  reason: string;                        // 建议原因说明
}

/**
 * 生成智能搜索建议
 *
 * @param query 用户查询
 * @param availableTerms 可用词条列表（可选）
 * @returns 搜索建议数组
 *
 * 建议类型：
 * 1. typo（拼写纠错）：检测并纠正常见拼写错误
 * 2. similar（相似词）：从可用词条中查找相似的词
 * 3. keyword（关键词提取）：从复合词中提取关键词
 *
 * 算法流程：
 * 1. 检查拼写错误并生成纠正建议
 * 2. 对查询中的每个词查找相似词（需要提供词典）
 * 3. 提取关键词（如果查询包含复合词）
 *
 * 使用场景：
 * - 搜索框自动建议
 * - "您是否要找" 提示
 * - 搜索结果优化
 *
 * 示例：
 * generateSuggestions('fucntion getUserName', ['function', 'getUser'])
 * => [
 *   { type: 'typo', original: 'fucntion getUserName', suggestion: 'function getUserName', reason: 'Corrected common typos' },
 *   { type: 'similar', original: 'getUserName', suggestion: 'getUser', reason: 'Did you mean "getUser"? (85% match)' },
 *   { type: 'keyword', original: 'getUserName', suggestion: 'get user name', reason: 'Extracted keywords from compound terms' }
 * ]
 */
export function generateSuggestions(
  query: string,
  availableTerms: string[] = []
): SearchSuggestion[] {
  const suggestions: SearchSuggestion[] = [];

  // 策略 1：检查拼写错误
  const { corrected, hasCorrected } = correctTypos(query);
  if (hasCorrected) {
    suggestions.push({
      type: 'typo',
      original: query,
      suggestion: corrected,
      reason: 'Corrected common typos',
    });
  }

  // 策略 2：查找相似词（需要词典）
  if (availableTerms.length > 0) {
    const queryWords = query.split(/\s+/);

    for (const word of queryWords) {
      if (word.length < 3) continue; // 跳过短词（通常无意义）

      // 查找相似词（相似度阈值 0.7，最多 3 个结果）
      const similar = findSimilarTerms(word, availableTerms, 0.7, 3);

      for (const { term, similarity } of similar) {
        if (term.toLowerCase() !== word.toLowerCase()) {
          suggestions.push({
            type: 'similar',
            original: word,
            suggestion: term,
            reason: `Did you mean "${term}"? (${Math.round(similarity * 100)}% match)`,
          });
        }
      }
    }
  }

  // 策略 3：提取关键词（如果查询包含复合词）
  const keywords = extractKeywords(query);
  if (keywords.length > 1 && keywords.join(' ') !== query.toLowerCase()) {
    suggestions.push({
      type: 'keyword',
      original: query,
      suggestion: keywords.join(' '),
      reason: 'Extracted keywords from compound terms',
    });
  }

  return suggestions;
}

/**
 * 搜索词典类
 *
 * 用于构建和维护搜索词典，支持：
 * - 动态添加词条
 * - 自动提取关键词
 * - 过滤短词（长度 < 3）
 *
 * 使用场景：
 * - 从搜索历史构建词典
 * - 从代码库提取常用术语
 * - 为搜索建议提供词条来源
 */
export class SearchDictionary {
  private terms: Set<string> = new Set();

  /**
   * 添加单个词条
   *
   * @param term 词条
   *
   * 实现细节：
   * - 自动提取关键词（拆分驼峰和下划线）
   * - 过滤长度 < 3 的短词
   */
  addTerm(term: string): void {
    const keywords = extractKeywords(term);
    keywords.forEach((keyword) => {
      if (keyword.length >= 3) {
        this.terms.add(keyword);
      }
    });
  }

  /**
   * 批量添加词条
   *
   * @param terms 词条数组
   */
  addTerms(terms: string[]): void {
    terms.forEach((term) => this.addTerm(term));
  }

  /**
   * 获取所有词条
   *
   * @returns 词条数组
   */
  getTerms(): string[] {
    return Array.from(this.terms);
  }

  /**
   * 清空词典
   */
  clear(): void {
    this.terms.clear();
  }
}
