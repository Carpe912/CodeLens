/**
 * 查询意图解析器 - 解析用户查询中的自然语言意图
 *
 * 功能说明：
 * 将混合了代码标识符和自然语言的查询分解为结构化的意图对象
 *
 * 支持的查询格式：
 * - URL + 意图: "/api/users 位置" → 查找 /api/users 的调用位置
 * - 函数 + 意图: "getUserById 在哪调用" → 查找函数的调用位置
 * - 完整 URL: "https://api.example.com/users" → 提取路径部分
 *
 * 使用场景：
 * - 智能搜索：理解用户的真实意图，提供更精准的搜索结果
 * - 多语言支持：同时支持中文和英文的意图关键词
 * - 上下文感知：根据意图调整搜索策略（定义优先 vs 使用优先）
 *
 * 处理示例：
 * - 输入: "/api/users 位置"
 * - 输出: { target: "/api/users", action: "find_usages", originalQuery: "/api/users 位置" }
 */

/**
 * 解析后的意图对象接口
 */
export interface ParsedIntent {
  // 提取的目标（URL、函数名、类名等）
  target: string;

  // 用户的操作意图
  action: 'find_definition' | 'find_usages' | 'find_callers' | 'find_implementations' | 'general_search';

  // 原始查询字符串（用于日志和调试）
  originalQuery: string;

  // 额外的过滤条件（可选）
  filters?: {
    fileType?: string;    // 文件类型过滤（如 .ts, .js）
    directory?: string;   // 目录过滤（如 src/api）
  };
}

/**
 * 解析用户查询，提取目标和意图
 *
 * 解析流程：
 * 1. 尝试提取完整 URL（http://... 或 https://...）
 * 2. 尝试提取路径 URL（以 / 开头）
 * 3. 尝试提取代码标识符（函数名、类名等）
 * 4. 分析剩余文本中的意图关键词
 * 5. 返回结构化的意图对象
 *
 * @param query - 用户输入的查询字符串
 * @returns 解析后的意图对象
 *
 * @example
 * // 示例 1: URL + 中文意图
 * parseQueryIntent("/api/users 位置")
 * // 返回: { target: "/api/users", action: "find_usages", originalQuery: "/api/users 位置" }
 *
 * @example
 * // 示例 2: 完整 URL
 * parseQueryIntent("https://api.example.com/users/123 定义")
 * // 返回: { target: "/users/123", action: "find_definition", originalQuery: "..." }
 *
 * @example
 * // 示例 3: 函数名 + 英文意图
 * parseQueryIntent("getUserById where called")
 * // 返回: { target: "getUserById", action: "find_usages", originalQuery: "..." }
 */
export function parseQueryIntent(query: string): ParsedIntent {
  // 初始化默认返回值
  const result: ParsedIntent = {
    target: query,
    action: 'general_search',
    originalQuery: query,
  };

  // 策略 1: 尝试提取完整 URL（包括 http/https 协议）
  const fullUrlMatch = query.match(/^(https?:\/\/[^\s]+)/);
  if (fullUrlMatch) {
    const fullUrl = fullUrlMatch[1];

    // 从完整 URL 中提取路径部分（去掉协议和域名）
    try {
      const url = new URL(fullUrl);
      result.target = url.pathname; // 只保留路径部分，如 /api/users
    } catch {
      // 如果 URL 解析失败（格式不标准），使用正则提取路径
      const pathMatch = fullUrl.match(/https?:\/\/[^\/]+(\/.+)/);
      result.target = pathMatch ? pathMatch[1] : fullUrl;
    }

    // 提取 URL 后面的自然语言部分
    const remainingText = query.slice(fullUrlMatch[0].length).trim();

    // 分析自然语言意图
    if (remainingText) {
      result.action = detectAction(remainingText);
    }

    return result;
  }

  // 策略 2: 尝试提取路径 URL（以 / 开头的相对路径）
  // 匹配格式: /path/to/resource, /api/users/:id, /api/{id}
  const urlMatch = query.match(/^(\/[a-zA-Z0-9_\-.:{}$\/]+)/);
  if (urlMatch) {
    result.target = urlMatch[1];

    // 提取 URL 后面的自然语言部分
    const remainingText = query.slice(urlMatch[1].length).trim();

    // 分析自然语言意图
    if (remainingText) {
      result.action = detectAction(remainingText);
    }

    return result;
  }

  // 策略 3: 尝试提取代码标识符（函数名、类名、变量名等）
  // 匹配格式: getUserById, UserService, API_URL
  const codeMatch = query.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
  if (codeMatch) {
    result.target = codeMatch[1];
    const remainingText = query.slice(codeMatch[1].length).trim();

    // 分析自然语言意图
    if (remainingText) {
      result.action = detectAction(remainingText);
    }

    return result;
  }

  // 策略 4: 无法提取明确目标，返回原始查询作为通用搜索
  return result;
}

/**
 * 从自然语言文本中检测用户意图
 *
 * 支持的意图类型：
 * - find_usages: 查找使用位置/调用位置
 * - find_definition: 查找定义位置
 * - find_implementations: 查找实现
 * - find_callers: 查找调用者
 * - general_search: 通用搜索
 *
 * 关键词匹配策略：
 * 1. 优先匹配中文关键词（完全匹配）
 * 2. 然后匹配英文关键词（不区分大小写）
 * 3. 如果都不匹配，返回通用搜索
 *
 * @param text - 自然语言文本
 * @returns 检测到的操作意图
 *
 * @example
 * detectAction("位置")           // 'find_usages'
 * detectAction("在哪里调用")      // 'find_usages'
 * detectAction("where called")   // 'find_usages'
 * detectAction("定义")           // 'find_definition'
 * detectAction("implementation") // 'find_implementations'
 */
function detectAction(text: string): ParsedIntent['action'] {
  const lowerText = text.toLowerCase();

  // 中文关键词映射表
  // 按语义分组，便于维护和扩展
  const chineseKeywords: Record<string, ParsedIntent['action']> = {
    // 查找使用位置相关
    '位置': 'find_usages',
    '在哪': 'find_usages',
    '哪里调用': 'find_usages',
    '调用': 'find_usages',
    '使用': 'find_usages',
    '引用': 'find_usages',

    // 查找定义相关
    '定义': 'find_definition',

    // 查找实现相关
    '实现': 'find_implementations',

    // 查找调用者相关
    '谁调用': 'find_callers',
  };

  // 英文关键词映射表
  const englishKeywords: Record<string, ParsedIntent['action']> = {
    // 查找使用位置相关
    'usage': 'find_usages',
    'usages': 'find_usages',
    'where': 'find_usages',
    'called': 'find_usages',
    'references': 'find_usages',

    // 查找定义相关
    'definition': 'find_definition',

    // 查找实现相关
    'implementation': 'find_implementations',

    // 查找调用者相关
    'callers': 'find_callers',
  };

  // 优先检查中文关键词（使用完全匹配）
  for (const [keyword, action] of Object.entries(chineseKeywords)) {
    if (text.includes(keyword)) {
      return action;
    }
  }

  // 然后检查英文关键词（不区分大小写）
  for (const [keyword, action] of Object.entries(englishKeywords)) {
    if (lowerText.includes(keyword)) {
      return action;
    }
  }

  // 如果没有匹配到任何关键词，返回通用搜索
  return 'general_search';
}

/**
 * 使用示例：
 *
 * @example
 * // 示例 1: URL + 中文意图（查找使用位置）
 * parseQueryIntent("/api/users 位置")
 * // => { target: "/api/users", action: "find_usages", originalQuery: "/api/users 位置" }
 *
 * @example
 * // 示例 2: URL + 中文意图（查找定义）
 * parseQueryIntent("/api/users 定义")
 * // => { target: "/api/users", action: "find_definition", originalQuery: "/api/users 定义" }
 *
 * @example
 * // 示例 3: 函数名 + 中文意图
 * parseQueryIntent("getUserById 在哪调用")
 * // => { target: "getUserById", action: "find_usages", originalQuery: "getUserById 在哪调用" }
 *
 * @example
 * // 示例 4: 完整 URL + 英文意图
 * parseQueryIntent("https://api.example.com/users where called")
 * // => { target: "/users", action: "find_usages", originalQuery: "..." }
 *
 * @example
 * // 示例 5: 类名 + 实现查询
 * parseQueryIntent("UserService 实现")
 * // => { target: "UserService", action: "find_implementations", originalQuery: "..." }
 */
