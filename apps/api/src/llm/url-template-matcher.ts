/**
 * URL 模板匹配器 - 将动态 URL 与模板模式进行匹配
 *
 * 功能说明：
 * 用于识别和匹配包含动态参数的 URL 模板，支持多种模板语法
 *
 * 支持的模板格式：
 * - ES6 模板字符串: `/api/users/${userId}`
 * - Express/React Router 风格: `/api/users/:userId`
 * - OpenAPI 风格: `/api/users/{userId}`
 * - Angular 风格: `/api/users/<userId>`
 *
 * 使用场景：
 * - API 路由匹配：判断实际请求 URL 是否匹配某个路由模板
 * - 参数提取：从实际 URL 中提取动态参数的值
 * - URL 搜索：在代码库中查找定义了特定 URL 模式的位置
 *
 * 匹配示例：
 * - 模板: `/rest/enterprise/project/${pid}`
 * - 查询: `/rest/enterprise/project/5eda325a2f391b475a711a7b`
 * - 结果: 匹配成功，提取参数 { pid: '5eda325a2f391b475a711a7b' }
 */

/**
 * 模板匹配结果接口
 */
export interface TemplateMatch {
  template: string;                          // 标准化后的模板字符串
  score: number;                             // 匹配分数 (0-1)，基于静态段的匹配比例
  extractedParams: Record<string, string>;   // 提取的动态参数 { 参数名: 参数值 }
  segments: {
    static: string[];                        // 静态路径段列表
    dynamic: string[];                       // 动态参数名列表
  };
}

/**
 * 将 URL 与模板模式进行匹配
 *
 * 匹配算法：
 * 1. 标准化：移除协议、域名、尾部斜杠
 * 2. 分段解析：将模板解析为静态段和动态段
 * 3. 长度检查：URL 和模板的段数必须相同
 * 4. 逐段匹配：
 *    - 静态段：必须完全匹配（不区分大小写）
 *    - 动态段：提取参数值
 * 5. 计算分数：匹配的静态段数 / 总静态段数
 *
 * @param url - 要匹配的实际 URL
 * @param template - URL 模板模式
 * @returns 匹配结果对象，如果不匹配则返回 null
 *
 * @example
 * // 示例 1: 成功匹配
 * matchURLTemplate(
 *   '/api/users/123',
 *   '/api/users/${id}'
 * );
 * // 返回: {
 * //   template: 'api/users/${id}',
 * //   score: 1.0,
 * //   extractedParams: { id: '123' },
 * //   segments: { static: ['api', 'users'], dynamic: ['id'] }
 * // }
 *
 * @example
 * // 示例 2: 不匹配（静态段不同）
 * matchURLTemplate(
 *   '/api/products/123',
 *   '/api/users/${id}'
 * );
 * // 返回: null
 */
export function matchURLTemplate(url: string, template: string): TemplateMatch | null {
  // 标准化 URL（移除协议、域名、尾部斜杠）
  const normalizedURL = normalizeURL(url);
  const normalizedTemplate = normalizeURL(template);

  // 从模板中提取静态段和动态段
  const templateSegments = parseTemplate(normalizedTemplate);
  const urlSegments = normalizedURL.split('/').filter(s => s);

  // 检查段数是否匹配（必须相同才能匹配）
  if (urlSegments.length !== templateSegments.length) {
    return null;
  }

  // 逐段匹配
  const extractedParams: Record<string, string> = {};
  let matchedStatic = 0;  // 已匹配的静态段数量
  let totalStatic = 0;    // 总静态段数量

  for (let i = 0; i < templateSegments.length; i++) {
    const templateSeg = templateSegments[i];
    const urlSeg = urlSegments[i];

    if (templateSeg.type === 'static') {
      // 静态段：必须完全匹配（不区分大小写）
      totalStatic++;
      if (templateSeg.value.toLowerCase() === urlSeg.toLowerCase()) {
        matchedStatic++;
      } else {
        // 静态段不匹配 - 整体匹配失败
        return null;
      }
    } else if (templateSeg.type === 'dynamic') {
      // 动态段：提取参数值
      extractedParams[templateSeg.name] = urlSeg;
    }
  }

  // 计算匹配分数：匹配的静态段数 / 总静态段数
  // 如果没有静态段（全是动态参数），分数为 1.0
  const score = totalStatic > 0 ? matchedStatic / totalStatic : 1.0;

  return {
    template: normalizedTemplate,
    score,
    extractedParams,
    segments: {
      static: templateSegments.filter(s => s.type === 'static').map(s => s.value),
      dynamic: templateSegments.filter(s => s.type === 'dynamic').map(s => s.name),
    },
  };
}

/**
 * 标准化 URL，移除协议、域名和尾部斜杠
 *
 * 标准化步骤：
 * 1. 移除协议和域名（http://example.com）
 * 2. 移除尾部斜杠
 * 3. 移除开头斜杠（保持一致性）
 *
 * @param url - 原始 URL
 * @returns 标准化后的路径
 *
 * @example
 * normalizeURL('https://api.example.com/users/123/')
 * // 返回: 'users/123'
 */
function normalizeURL(url: string): string {
  let normalized = url;

  // 移除协议和域名（如 https://example.com）
  normalized = normalized.replace(/^https?:\/\/[^\/]+/, '');

  // 移除尾部斜杠
  normalized = normalized.replace(/\/$/, '');

  // 移除开头斜杠（保持一致性）
  normalized = normalized.replace(/^\//, '');

  return normalized;
}

/**
 * 模板段接口 - 表示模板中的一个路径段
 */
interface TemplateSegment {
  type: 'static' | 'dynamic';  // 段类型：静态或动态
  value: string;               // 段的原始值
  name: string;                // 参数名（仅动态段有效）
}

/**
 * 将模板字符串解析为段数组
 *
 * 支持的动态参数格式：
 * 1. ${varName} - ES6 模板字符串风格
 * 2. :varName - Express/React Router 风格
 * 3. {varName} - OpenAPI 风格
 * 4. <varName> - Angular 风格
 *
 * @param template - 模板字符串
 * @returns 段数组，每个段包含类型、值和参数名
 *
 * @example
 * parseTemplate('/api/users/${id}/posts/:postId')
 * // 返回: [
 * //   { type: 'static', value: 'api', name: '' },
 * //   { type: 'static', value: 'users', name: '' },
 * //   { type: 'dynamic', value: '${id}', name: 'id' },
 * //   { type: 'static', value: 'posts', name: '' },
 * //   { type: 'dynamic', value: ':postId', name: 'postId' }
 * // ]
 */
function parseTemplate(template: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  const parts = template.split('/').filter(s => s);

  for (const part of parts) {
    // 检查模板变量模式（按优先级顺序）：
    // 1. ${varName} - ES6 模板字符串
    // 2. :varName - Express/React Router 风格
    // 3. {varName} - OpenAPI 风格
    // 4. <varName> - Angular 风格

    const es6Match = part.match(/^\$\{([^}]+)\}$/);
    const colonMatch = part.match(/^:([a-zA-Z_][a-zA-Z0-9_]*)$/);
    const braceMatch = part.match(/^\{([^}]+)\}$/);
    const angleMatch = part.match(/^<([^>]+)>$/);

    if (es6Match) {
      // ES6 模板字符串格式
      segments.push({
        type: 'dynamic',
        value: part,
        name: es6Match[1],
      });
    } else if (colonMatch) {
      // Express/React Router 格式
      segments.push({
        type: 'dynamic',
        value: part,
        name: colonMatch[1],
      });
    } else if (braceMatch) {
      // OpenAPI 格式
      segments.push({
        type: 'dynamic',
        value: part,
        name: braceMatch[1],
      });
    } else if (angleMatch) {
      // Angular 格式
      segments.push({
        type: 'dynamic',
        value: part,
        name: angleMatch[1],
      });
    } else {
      // 静态段
      segments.push({
        type: 'static',
        value: part,
        name: '',
      });
    }
  }

  return segments;
}

/**
 * 检查字符串是否包含模板变量
 *
 * 识别所有支持的模板格式：
 * - ${varName}
 * - :varName
 * - {varName}
 * - <varName>
 *
 * @param str - 要检查的字符串
 * @returns 如果包含模板变量返回 true，否则返回 false
 *
 * @example
 * isTemplate('/api/users/${id}')  // true
 * isTemplate('/api/users/:id')    // true
 * isTemplate('/api/users/123')    // false
 */
export function isTemplate(str: string): boolean {
  return /\$\{[^}]+\}|:[a-zA-Z_][a-zA-Z0-9_]*|\{[^}]+\}|<[^>]+>/.test(str);
}

/**
 * 从模板字符串中提取所有模板变量名
 *
 * @param template - 模板字符串
 * @returns 变量名数组
 *
 * @example
 * extractTemplateVars('/api/users/${userId}/posts/:postId')
 * // 返回: ['userId', 'postId']
 */
export function extractTemplateVars(template: string): string[] {
  const vars: string[] = [];
  const segments = parseTemplate(template);

  // 遍历所有段，收集动态参数名
  for (const seg of segments) {
    if (seg.type === 'dynamic') {
      vars.push(seg.name);
    }
  }

  return vars;
}

/**
 * 计算两个 URL 之间的相似度（用于模糊匹配）
 *
 * 相似度算法：
 * 1. 标准化两个 URL
 * 2. 分割为路径段
 * 3. 逐段比较，计算匹配的段数
 * 4. 相似度 = 匹配段数 / 最大段数
 *
 * 应用场景：
 * - 当精确匹配失败时，使用模糊匹配找到相似的 URL
 * - 处理 URL 变体（如带版本号的 API）
 *
 * @param url1 - 第一个 URL
 * @param url2 - 第二个 URL
 * @returns 相似度分数 (0-1)，1 表示完全相同
 *
 * @example
 * calculateURLSimilarity('/api/v1/users', '/api/v2/users')
 * // 返回: 0.67 (2/3 段匹配)
 *
 * @example
 * calculateURLSimilarity('/api/users/123', '/api/users/456')
 * // 返回: 0.67 (2/3 段匹配)
 */
export function calculateURLSimilarity(url1: string, url2: string): number {
  // 标准化两个 URL
  const norm1 = normalizeURL(url1);
  const norm2 = normalizeURL(url2);

  // 分割为路径段
  const segs1 = norm1.split('/').filter(s => s);
  const segs2 = norm2.split('/').filter(s => s);

  // 如果段数不同，基于重叠部分计算相似度
  const minLen = Math.min(segs1.length, segs2.length);
  const maxLen = Math.max(segs1.length, segs2.length);

  // 逐段比较，统计匹配的段数（不区分大小写）
  let matches = 0;
  for (let i = 0; i < minLen; i++) {
    if (segs1[i].toLowerCase() === segs2[i].toLowerCase()) {
      matches++;
    }
  }

  // 相似度 = 匹配段数 / 最大段数
  return matches / maxLen;
}
