/**
 * Query Intent Parser - 解析用户查询中的自然语言意图
 *
 * 处理类似 "/api/users 位置" 这样的混合查询：
 * - 提取 URL 部分: /api/users
 * - 识别意图关键词: 位置 -> 查找调用位置
 * - 返回结构化的意图对象
 */

export interface ParsedIntent {
  // 提取的 URL 或代码标识符
  target: string;

  // 用户想要做什么
  action: 'find_definition' | 'find_usages' | 'find_callers' | 'find_implementations' | 'general_search';

  // 原始查询
  originalQuery: string;

  // 额外的过滤条件
  filters?: {
    fileType?: string;
    directory?: string;
  };
}

/**
 * 解析用户查询，提取目标和意图
 */
export function parseQueryIntent(query: string): ParsedIntent {
  // 默认返回值
  const result: ParsedIntent = {
    target: query,
    action: 'general_search',
    originalQuery: query,
  };

  // 1. 尝试提取完整 URL（包括 http/https）
  const fullUrlMatch = query.match(/^(https?:\/\/[^\s]+)/);
  if (fullUrlMatch) {
    const fullUrl = fullUrlMatch[1];

    // 从完整 URL 中提取路径部分
    try {
      const url = new URL(fullUrl);
      result.target = url.pathname; // 只保留路径部分，去掉域名
    } catch {
      // 如果 URL 解析失败，使用正则提取路径
      const pathMatch = fullUrl.match(/https?:\/\/[^\/]+(\/.+)/);
      result.target = pathMatch ? pathMatch[1] : fullUrl;
    }

    // 提取 URL 后面的自然语言部分
    const remainingText = query.slice(fullUrlMatch[0].length).trim();

    // 2. 分析自然语言意图
    if (remainingText) {
      result.action = detectAction(remainingText);
    }

    return result;
  }

  // 2. 尝试提取路径 URL（以 / 开头）
  const urlMatch = query.match(/^(\/[a-zA-Z0-9_\-.:{}$\/]+)/);
  if (urlMatch) {
    result.target = urlMatch[1];

    // 提取 URL 后面的自然语言部分
    const remainingText = query.slice(urlMatch[1].length).trim();

    // 3. 分析自然语言意图
    if (remainingText) {
      result.action = detectAction(remainingText);
    }

    return result;
  }

  // 4. 如果不是 URL，尝试提取其他代码标识符（函数名、类名等）
  const codeMatch = query.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
  if (codeMatch) {
    result.target = codeMatch[1];
    const remainingText = query.slice(codeMatch[1].length).trim();

    if (remainingText) {
      result.action = detectAction(remainingText);
    }

    return result;
  }

  // 5. 无法提取明确目标，返回原始查询
  return result;
}

/**
 * 从自然语言中检测用户意图
 */
function detectAction(text: string): ParsedIntent['action'] {
  const lowerText = text.toLowerCase();

  // 中文关键词映射
  const chineseKeywords: Record<string, ParsedIntent['action']> = {
    '位置': 'find_usages',
    '在哪': 'find_usages',
    '哪里调用': 'find_usages',
    '调用': 'find_usages',
    '使用': 'find_usages',
    '引用': 'find_usages',
    '定义': 'find_definition',
    '实现': 'find_implementations',
    '谁调用': 'find_callers',
  };

  // 英文关键词映射
  const englishKeywords: Record<string, ParsedIntent['action']> = {
    'usage': 'find_usages',
    'usages': 'find_usages',
    'where': 'find_usages',
    'called': 'find_usages',
    'references': 'find_usages',
    'definition': 'find_definition',
    'implementation': 'find_implementations',
    'callers': 'find_callers',
  };

  // 检查中文关键词
  for (const [keyword, action] of Object.entries(chineseKeywords)) {
    if (text.includes(keyword)) {
      return action;
    }
  }

  // 检查英文关键词
  for (const [keyword, action] of Object.entries(englishKeywords)) {
    if (lowerText.includes(keyword)) {
      return action;
    }
  }

  return 'general_search';
}

/**
 * 示例用法：
 *
 * parseQueryIntent("/api/users 位置")
 * => { target: "/api/users", action: "find_usages", originalQuery: "/api/users 位置" }
 *
 * parseQueryIntent("/api/users 定义")
 * => { target: "/api/users", action: "find_definition", originalQuery: "/api/users 定义" }
 *
 * parseQueryIntent("getUserById 在哪调用")
 * => { target: "getUserById", action: "find_usages", originalQuery: "getUserById 在哪调用" }
 */
