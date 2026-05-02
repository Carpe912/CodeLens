let segment: any = null;

async function getSegment() {
  if (!segment) {
    // @ts-ignore - segmentit has no type definitions
    const segmentit = await import('segmentit');
    const pkg = segmentit.default || segmentit;
    const { Segment, useDefault } = pkg;
    segment = useDefault(new Segment());
  }
  return segment;
}

/**
 * 检测文本是否包含中文字符
 */
function containsChinese(text: string): boolean {
  return /[一-龥]/.test(text);
}

/**
 * 检测文本是否包含日文字符
 */
function containsJapanese(text: string): boolean {
  return /[぀-ゟ゠-ヿ]/.test(text);
}

/**
 * 拆分驼峰命名和下划线命名
 * getUserName -> ["get", "User", "Name"]
 * get_user_name -> ["get", "user", "name"]
 */
function splitCamelCase(word: string): string[] {
  // 先处理下划线
  if (word.includes('_')) {
    return word.split('_').flatMap(part => splitCamelCase(part));
  }

  // 处理驼峰命名
  const parts: string[] = [];
  let current = '';

  for (let i = 0; i < word.length; i++) {
    const char = word[i];
    const isUpper = char === char.toUpperCase() && char !== char.toLowerCase();

    if (isUpper && current) {
      parts.push(current);
      current = char;
    } else {
      current += char;
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts.filter(p => p.length > 0);
}

/**
 * 多语言分词器
 * 支持：中文、日文、英文、驼峰命名、下划线命名
 */
export async function tokenize(text: string): Promise<string[]> {
  const tokens: string[] = [];

  // 1. 按空格和标点符号分割
  const segments = text.split(/[\s,;.!?()[\]{}<>'"]+/).filter(s => s.length > 0);

  for (const seg of segments) {
    // 2. 检测语言类型
    if (containsChinese(seg)) {
      // 中文分词
      const segmentInstance = await getSegment();
      const words = segmentInstance.doSegment(seg, { simple: true });
      tokens.push(...words.map((w: any) => w.toLowerCase()));
    } else if (containsJapanese(seg)) {
      // 日文分词（简单处理，可以后续优化）
      const segmentInstance = await getSegment();
      const words = segmentInstance.doSegment(seg, { simple: true });
      tokens.push(...words.map((w: any) => w.toLowerCase()));
    } else {
      // 3. 英文：拆分驼峰和下划线
      const parts = splitCamelCase(seg);
      tokens.push(...parts.map(p => p.toLowerCase()));
    }
  }

  return tokens;
}

/**
 * 提取关键词（过滤停用词）
 */
const stopWords = new Set([
  // 英文停用词
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'should', 'could', 'may', 'might', 'must', 'can', 'this',
  'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they',

  // 中文停用词
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有',
  '看', '好', '自己', '这', '那', '里', '什么', '如何', '怎么', '为什么',

  // 日文停用词
  'の', 'に', 'は', 'を', 'た', 'が', 'で', 'て', 'と', 'し', 'れ', 'さ',
  'ある', 'いる', 'も', 'する', 'から', 'な', 'こと', 'として', 'い', 'や',
]);

export async function extractKeywords(text: string): Promise<string[]> {
  const tokens = await tokenize(text);

  // 过滤停用词和短词
  const keywords = tokens.filter(token => {
    return token.length > 1 && !stopWords.has(token);
  });

  // 去重
  return [...new Set(keywords)];
}
