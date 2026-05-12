/**
 * 多语言分词器模块
 *
 * 支持的语言和格式：
 * 1. 中文分词（基于 segmentit 库）
 * 2. 日文分词（基于 segmentit 库）
 * 3. 英文分词（基于空格和标点）
 * 4. 驼峰命名拆分（camelCase → camel, Case）
 * 5. 下划线命名拆分（snake_case → snake, case）
 *
 * 使用场景：
 * - 代码搜索：将查询和代码内容分词以提升匹配准确度
 * - 关键词提取：从文本中提取有意义的关键词
 * - 多语言支持：处理包含中文、日文注释的代码
 */

// 延迟加载 segmentit 分词库（避免启动时加载）
let segment: any = null;

/**
 * 获取 segmentit 分词器实例（单例模式）
 *
 * @returns segmentit 分词器实例
 *
 * 实现细节：
 * - 使用懒加载，首次调用时才导入库
 * - 单例模式，避免重复初始化
 * - 使用默认词典配置
 */
async function getSegment() {
  if (!segment) {
    // @ts-ignore - segmentit 没有类型定义文件
    const segmentit = await import('segmentit');
    const pkg = segmentit.default || segmentit;
    const { Segment, useDefault } = pkg;
    segment = useDefault(new Segment()); // 使用默认词典
  }
  return segment;
}

/**
 * 检测文本是否包含中文字符
 *
 * @param text 待检测的文本
 * @returns 如果包含中文返回 true
 *
 * Unicode 范围：
 * - 一-龥：CJK 统一汉字基本区（常用汉字）
 */
function containsChinese(text: string): boolean {
  return /[一-龥]/.test(text);
}

/**
 * 检测文本是否包含日文字符
 *
 * @param text 待检测的文本
 * @returns 如果包含日文返回 true
 *
 * Unicode 范围：
 * - ぀-ゟ：平假名（ひらがな）
 * - ゠-ヿ：片假名（カタカナ）
 */
function containsJapanese(text: string): boolean {
  return /[぀-ゟ゠-ヿ]/.test(text);
}

/**
 * 拆分驼峰命名和下划线命名
 *
 * @param word 待拆分的单词
 * @returns 拆分后的单词数组
 *
 * 支持的格式：
 * - camelCase: getUserName → ["get", "User", "Name"]
 * - PascalCase: GetUserName → ["Get", "User", "Name"]
 * - snake_case: get_user_name → ["get", "user", "name"]
 * - kebab-case: get-user-name → ["get", "user", "name"]
 * - 混合格式: get_userName → ["get", "user", "Name"]
 *
 * 算法：
 * 1. 先按下划线拆分
 * 2. 对每部分递归处理驼峰命名
 * 3. 遇到大写字母时切分
 */
function splitCamelCase(word: string): string[] {
  // 先处理下划线和短横线
  if (word.includes('_') || word.includes('-')) {
    return word.split(/[_-]/).flatMap(part => splitCamelCase(part));
  }

  // 处理驼峰命名
  const parts: string[] = [];
  let current = '';

  for (let i = 0; i < word.length; i++) {
    const char = word[i];
    // 判断是否为大写字母（排除数字和符号）
    const isUpper = char === char.toUpperCase() && char !== char.toLowerCase();

    if (isUpper && current) {
      // 遇到大写字母且当前有累积内容，切分
      parts.push(current);
      current = char;
    } else {
      current += char;
    }
  }

  // 添加最后一部分
  if (current) {
    parts.push(current);
  }

  return parts.filter(p => p.length > 0);
}

/**
 * 多语言分词器主函数
 *
 * @param text 待分词的文本
 * @returns 分词结果数组（已转为小写）
 *
 * 分词流程：
 * 1. 按空格和标点符号初步分割
 * 2. 对每个片段检测语言类型
 * 3. 根据语言类型选择分词策略：
 *    - 中文/日文：使用 segmentit 分词
 *    - 英文：拆分驼峰和下划线命名
 * 4. 统一转为小写
 *
 * 示例：
 * tokenize('getUserName 获取用户名')
 * => ['get', 'user', 'name', '获取', '用户', '名']
 *
 * tokenize('handleClick_Event')
 * => ['handle', 'click', 'event']
 */
export async function tokenize(text: string): Promise<string[]> {
  const tokens: string[] = [];

  // 1. 按空格和标点符号分割
  // 支持的分隔符：空格、逗号、分号、句号、括号、引号等
  const segments = text.split(/[\s,;.!?()[\]{}<>'"]+/).filter(s => s.length > 0);

  for (const seg of segments) {
    // 2. 检测语言类型并选择分词策略
    if (containsChinese(seg)) {
      // 中文分词
      const segmentInstance = await getSegment();
      const words = segmentInstance.doSegment(seg, { simple: true });
      tokens.push(...words.map((w: any) => w.toLowerCase()));
    } else if (containsJapanese(seg)) {
      // 日文分词（使用相同的分词器）
      const segmentInstance = await getSegment();
      const words = segmentInstance.doSegment(seg, { simple: true });
      tokens.push(...words.map((w: any) => w.toLowerCase()));
    } else {
      // 3. 英文：拆分驼峰和下划线命名
      const parts = splitCamelCase(seg);
      tokens.push(...parts.map(p => p.toLowerCase()));
    }
  }

  return tokens;
}

/**
 * 停用词集合
 *
 * 停用词定义：
 * 在文本分析中频繁出现但对语义贡献较小的词
 * 例如：冠词、介词、连词、代词等
 *
 * 分类：
 * - 英文停用词：the, a, is, are, in, on 等
 * - 中文停用词：的、了、在、是、我、有 等
 * - 日文停用词：の、に、は、を、た 等
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

/**
 * 提取关键词（过滤停用词和短词）
 *
 * @param text 待提取的文本
 * @returns 关键词数组（已去重）
 *
 * 提取规则：
 * 1. 先进行分词
 * 2. 过滤停用词
 * 3. 过滤长度 <= 1 的短词（单字符通常无意义）
 * 4. 去重
 *
 * 使用场景：
 * - 搜索查询优化：提取用户输入的关键词
 * - 文档摘要：提取文档的核心词汇
 * - 标签生成：为代码片段生成标签
 *
 * 示例：
 * extractKeywords('这是一个getUserName函数')
 * => ['getUserName', '函数'] // 过滤了 '这', '是', '一个'
 */
export async function extractKeywords(text: string): Promise<string[]> {
  const tokens = await tokenize(text);

  // 过滤停用词和短词
  const keywords = tokens.filter(token => {
    return token.length > 1 && !stopWords.has(token);
  });

  // 去重（使用 Set）
  return [...new Set(keywords)];
}
