/**
 * 问答系统模块 - 基于代码证据的智能问答
 *
 * 功能说明：
 * 使用 Claude AI 模型，结合代码搜索结果，为用户提供准确的代码问答服务
 *
 * 核心特性：
 * 1. 查询分类：自动识别 8 种查询类型，生成针对性提示词
 * 2. 上下文扩展：自动扩展代码上下文（前后 5 行），提供更完整的信息
 * 3. 历史反馈：整合用户的历史反馈，持续改进回答质量
 * 4. 结构化回答：根据查询类型，使用不同的回答结构
 *
 * 支持的查询类型：
 * - url_lookup: URL 查找（/api/users 在哪定义）
 * - code_location: 代码定位（login 函数在哪）
 * - implementation: 实现方式（如何实现登录）
 * - architecture: 架构理解（系统架构是什么）
 * - bug_analysis: Bug 分析（为什么会出现这个问题）
 * - usage_example: 使用示例（如何使用这个函数）
 * - comparison: 对比分析（A 和 B 有什么区别）
 * - general: 通用查询
 *
 * 使用场景：
 * - 代码理解：快速了解代码的功能和实现
 * - 问题诊断：分析 Bug 的根本原因
 * - 学习参考：获取代码使用示例和最佳实践
 */

import Anthropic from '@anthropic-ai/sdk';
import type { CodeChunkRecord } from '../db/index.js';
import { getChunksWithContext } from '../db/index.js';

// 初始化 Anthropic 客户端
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

/**
 * 查询类型枚举
 *
 * 每种类型对应不同的回答策略和提示词模板
 */
type QueryType =
  | 'url_lookup'           // URL 查找：查找 API 端点的定义位置和使用方式
  | 'code_location'        // 代码定位：查找函数、类、变量的定义位置
  | 'implementation'       // 实现方式：解释代码的实现逻辑和工作原理
  | 'architecture'         // 架构理解：描述系统架构和设计思路
  | 'bug_analysis'         // Bug 分析：诊断问题的根本原因
  | 'usage_example'        // 使用示例：提供代码使用方法和示例
  | 'comparison'           // 对比分析：对比不同实现或技术选择
  | 'general';             // 通用查询：其他类型的查询

/**
 * 智能分类查询类型
 *
 * 分类策略：
 * 使用正则表达式匹配查询中的关键词和模式，识别用户的真实意图
 *
 * 分类优先级：
 * 1. URL 查找（最高优先级，基于 URL 模式）
 * 2. 代码定位（基于位置关键词）
 * 3. 实现方式（基于"如何"关键词）
 * 4. 架构理解（基于架构关键词）
 * 5. Bug 分析（基于问题关键词）
 * 6. 使用示例（基于使用关键词）
 * 7. 对比分析（基于对比关键词）
 * 8. 通用查询（默认）
 *
 * @param query - 用户查询字符串
 * @returns 查询类型
 *
 * @example
 * classifyQuery("/api/users 在哪")        // 'url_lookup'
 * classifyQuery("login 函数在哪")         // 'code_location'
 * classifyQuery("如何实现用户认证")        // 'implementation'
 * classifyQuery("为什么登录失败")          // 'bug_analysis'
 */
function classifyQuery(query: string): QueryType {
  // 策略 1: URL 查找（最高优先级）
  // 匹配 URL 模式：/api/..., /rest/..., /v1/..., :param, {param}, http://...
  if (query.match(/\/(api|rest|v\d+|graphql)\/|:\w+|\/\{|\bhttps?:\/\//i)) {
    return 'url_lookup';
  }

  // 策略 2: 代码定位
  // 匹配位置相关关键词：在哪、位置、文件、定义在
  if (query.match(/在哪|位置|文件|哪个文件|定义在/)) {
    return 'code_location';
  }

  // 策略 3: 实现方式
  // 匹配"如何"相关关键词：如何实现、怎么做、实现逻辑
  if (query.match(/如何实现|怎么实现|怎样实现|实现方式|实现逻辑|怎么做|如何处理/)) {
    return 'implementation';
  }

  // 策略 4: 架构理解
  // 匹配架构相关关键词：架构、设计、模式、结构
  if (query.match(/架构|设计|模式|结构|组织方式|整体.*流程|系统.*设计/)) {
    return 'architecture';
  }

  // 策略 5: Bug 分析
  // 匹配问题相关关键词：为什么、bug、错误、失败
  if (query.match(/为什么|原因|bug|问题|错误|异常|失败|不work|不生效|没有.*效果/)) {
    return 'bug_analysis';
  }

  // 策略 6: 使用示例
  // 匹配使用相关关键词：如何使用、怎么用、示例
  if (query.match(/如何使用|怎么用|用法|示例|例子|调用方式/)) {
    return 'usage_example';
  }

  // 策略 7: 对比分析
  // 匹配对比相关关键词：区别、差异、对比、vs
  if (query.match(/区别|差异|对比|比较|和.*有什么不同|vs/)) {
    return 'comparison';
  }

  // 策略 8: 通用查询（默认）
  return 'general';
}

/**
 * 生成针对性的系统提示词
 *
 * 根据查询类型生成专门的系统提示词，指导 AI 以最合适的方式回答问题
 *
 * 提示词设计原则：
 * 1. 明确角色定位：告诉 AI 它的专长是什么
 * 2. 结构化输出：要求 AI 按特定结构组织答案
 * 3. 关键信息优先：强调最重要的信息应该放在前面
 * 4. 证据驱动：要求基于实际代码证据，不臆测
 *
 * @param queryType - 查询类型
 * @returns 系统提示词字符串
 */
function generateSystemPrompt(queryType: QueryType): string {
  // 基础提示词：定义 AI 的基本角色
  const basePrompt = `你是一个专业的代码智能助手，擅长理解和解释代码。`;

  // 针对不同查询类型的专门提示词
  const typeSpecificPrompts: Record<QueryType, string> = {
    url_lookup: `
你的专长是帮助开发者快速定位 API 端点和 URL 的定义。

回答时请遵循以下结构：
1. **位置**: 明确指出文件路径和行号
2. **定义方式**:
   - 静态字符串：直接说明值
   - 模板字符串：解释各部分来源（如 \`\${baseUrl}/api/users\`）
   - 函数返回：说明函数名和参数
3. **常量名称**: 如果通过常量定义，说明常量名
4. **使用位置**: 列出在哪些地方被使用
5. **HTTP 方法**: 如果能识别，说明 GET/POST/PUT/DELETE
6. **相关端点**: 如果有相关的其他 URL，简要列出

保持简洁，先回答"在哪里"，再解释"怎么定义"。`,

    code_location: `
你的专长是帮助开发者快速定位代码元素（函数、类、变量等）。

回答时请遵循以下结构：
1. **主要位置**: 文件路径和行号
2. **代码类型**: 函数/类/变量/常量
3. **简要说明**: 一句话描述其作用
4. **相关位置**: 如果在多个地方定义或使用，列出主要的几个
5. **依赖关系**: 简要说明导入/导出关系

直接给出位置，不要过度解释。`,

    implementation: `
你的专长是解释代码的实现逻辑和工作原理。

回答时请遵循以下结构：
1. **核心实现**: 用 2-3 句话概括主要实现方式
2. **关键步骤**: 列出 3-5 个关键步骤
3. **核心代码**: 指出最关键的代码片段（文件:行号）
4. **技术栈**: 使用的主要技术、库、框架
5. **设计模式**: 如果使用了特定模式，简要说明
6. **注意事项**: 重要的实现细节或边界情况

用清晰的逻辑组织，帮助读者理解"怎么做的"。`,

    architecture: `
你的专长是解释系统架构和设计思路。

回答时请遵循以下结构：
1. **整体架构**: 用 2-3 句话描述整体设计
2. **核心组件**: 列出 3-5 个主要组件及其职责
3. **数据流**: 描述数据如何在组件间流动
4. **关键文件**: 列出架构相关的核心文件
5. **设计决策**: 说明为什么这样设计（如果能从代码推断）
6. **扩展点**: 指出可扩展的部分

用架构图的思维组织答案，帮助读者建立全局视角。`,

    bug_analysis: `
你的专长是分析代码问题和 Bug 的根本原因。

回答时请遵循以下结构：
1. **问题定位**: 指出最可能出问题的代码位置
2. **根本原因**: 分析为什么会出现这个问题
   - 逻辑错误
   - 状态管理问题
   - 并发/竞态条件
   - 配置错误
   - 依赖问题
3. **调用链**: 追踪问题的调用路径
4. **复现条件**: 说明在什么情况下会触发
5. **修复建议**: 给出 2-3 个可能的解决方案
6. **预防措施**: 如何避免类似问题

用侦探的思维分析，帮助读者理解"为什么会这样"。`,

    usage_example: `
你的专长是提供清晰的代码使用示例和最佳实践。

回答时请遵循以下结构：
1. **基本用法**: 最简单的使用方式
2. **参数说明**: 解释主要参数的含义和类型
3. **返回值**: 说明返回什么
4. **使用示例**: 从证据中提取实际的使用代码
5. **常见场景**: 列出 2-3 个典型使用场景
6. **注意事项**: 使用时需要注意的点

用教程的思维组织，帮助读者快速上手。`,

    comparison: `
你的专长是对比分析不同的代码实现或技术选择。

回答时请遵循以下结构：
1. **核心差异**: 用一句话总结主要区别
2. **详细对比**: 从多个维度对比
   - 功能差异
   - 实现方式
   - 性能特点
   - 使用场景
3. **代码位置**: 分别指出两者的定义位置
4. **选择建议**: 在什么情况下用哪个
5. **迁移成本**: 如果要从 A 切换到 B，需要注意什么

用对比表格的思维组织，帮助读者做出选择。`,

    general: `
你的专长是回答各类代码相关问题。

回答时请：
1. 直接回答问题的核心
2. 给出具体的文件、函数、行号
3. 解释实现逻辑
4. 如果证据不足，明确指出
5. 保持简洁，避免冗余

根据问题类型灵活调整回答结构。`,
  };

  return basePrompt + '\n' + typeSpecificPrompts[queryType];
}

/**
 * 生成用户提示词
 *
 * 将用户查询、代码证据和历史反馈组合成完整的提示词
 *
 * 提示词结构：
 * 1. 用户问题：明确用户想知道什么
 * 2. 相关代码证据：提供搜索到的代码片段
 * 3. 历史反馈：提供之前的问答和用户反馈
 * 4. 针对性指令：根据查询类型给出具体要求
 * 5. 通用要求：中文回答、简洁准确、给出位置等
 *
 * @param query - 用户查询
 * @param queryType - 查询类型
 * @param evidenceText - 格式化的代码证据文本
 * @param feedbackContext - 格式化的历史反馈文本
 * @returns 用户提示词字符串
 */
function generateUserPrompt(
  query: string,
  queryType: QueryType,
  evidenceText: string,
  feedbackContext: string
): string {
  const typeSpecificInstructions: Record<QueryType, string> = {
    url_lookup: '请基于代码证据，详细说明这个 URL/API 端点的定义位置、构造方式和使用情况。',
    code_location: '请基于代码证据，准确指出代码元素的位置和基本信息。',
    implementation: '请基于代码证据，详细解释实现逻辑和工作原理。',
    architecture: '请基于代码证据，描述系统架构和设计思路。',
    bug_analysis: '请基于代码证据，分析问题的根本原因并给出修复建议。',
    usage_example: '请基于代码证据，提供清晰的使用示例和说明。',
    comparison: '请基于代码证据，对比分析两者的差异和适用场景。',
    general: '请基于代码证据回答问题。',
  };

  return `用户问题: ${query}

相关代码证据:
${evidenceText}
${feedbackContext}
${typeSpecificInstructions[queryType]}

要求:
1. 用中文回答
2. 直接、简洁、准确
3. 给出具体的文件路径和行号
4. 如果证据不足以完整回答，明确指出缺少什么信息
5. 整合历史反馈中的有价值信息`;
}

/**
 * 智能问答函数 - 基于代码证据回答用户问题
 *
 * 工作流程：
 * 1. 查询分类：识别用户的查询类型
 * 2. 上下文扩展：为代码片段添加前后 5 行的上下文
 * 3. 证据格式化：将代码证据格式化为易读的文本
 * 4. 反馈整合：整合历史问答和用户反馈
 * 5. 提示词生成：根据查询类型生成针对性提示词
 * 6. AI 调用：使用 Claude 生成回答
 *
 * 特性：
 * - 自动分类：根据查询内容自动选择最佳回答策略
 * - 上下文感知：提供完整的代码上下文，避免信息不足
 * - 持续改进：学习历史反馈，避免重复错误
 * - 结构化输出：按查询类型组织答案结构
 *
 * @param query - 用户查询字符串
 * @param evidence - 搜索到的代码证据数组
 * @param historicalFeedback - 历史问答和反馈（可选）
 * @param useExtendedContext - 是否使用扩展上下文（默认 true）
 * @returns AI 生成的回答文本
 *
 * @example
 * const evidence = [
 *   { code_text: "const API_URL = '/api/users';", file_path: "src/config.ts", ... }
 * ];
 * const answer = await answerQuestion("/api/users 在哪定义", evidence);
 * // 返回: "这个 URL 定义在 src/config.ts 文件中..."
 */
export async function answerQuestion(
  query: string,
  evidence: Array<CodeChunkRecord & { file_path?: string }>,
  historicalFeedback?: Array<{ query: string; answer: string; feedback: Array<{ feedback_text: string; is_helpful: boolean }> }>,
  useExtendedContext: boolean = true
): Promise<string> {
  // 步骤 1: 分类查询类型
  const queryType = classifyQuery(query);
  console.log(`Query classified as: ${queryType}`);

  // 步骤 2: 使用扩展上下文（为代码片段添加前后 5 行）
  let evidenceWithContext: Array<CodeChunkRecord & { file_path?: string; extended_code?: string }> = evidence;
  if (useExtendedContext) {
    try {
      evidenceWithContext = await getChunksWithContext(evidence, 5, 5);
      console.log('Using extended context for evidence');
    } catch (error) {
      console.log('Extended context unavailable, using original evidence');
    }
  }

  // 步骤 3: 构建证据文本（格式化代码片段）
  const evidenceText = evidenceWithContext
    .map((e, i) => {
      const codeToShow = e.extended_code || e.code_text;
      return `[证据 ${i + 1}] ${e.file_path || 'unknown'}:${e.line_start}-${e.line_end}
符号: ${e.symbol_name} (${e.symbol_type})
代码:
\`\`\`
${codeToShow}
\`\`\`
`;
    })
    .join('\n\n');

  // 步骤 4: 构建反馈上下文（整合历史问答和用户反馈）
  let feedbackContext = '';
  if (historicalFeedback && historicalFeedback.length > 0) {
    feedbackContext = '\n\n历史相关问答和用户反馈:\n';
    historicalFeedback.forEach((item, idx) => {
      feedbackContext += `\n[历史问答 ${idx + 1}]\n问题: ${item.query}\n回答: ${item.answer}\n`;
      if (item.feedback && item.feedback.length > 0) {
        feedbackContext += '用户反馈:\n';
        item.feedback.forEach((fb) => {
          feedbackContext += `- ${fb.feedback_text} ${fb.is_helpful ? '(有帮助)' : '(需改进)'}\n`;
        });
      }
    });
    feedbackContext += '\n请参考这些历史反馈，避免重复错误，并整合有价值的补充信息。\n';
  }

  // 步骤 5: 生成针对性提示词
  const systemPrompt = generateSystemPrompt(queryType);
  const userPrompt = generateUserPrompt(query, queryType, evidenceText, feedbackContext);

  // 步骤 6: 调用 Claude AI 生成回答
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const content = message.content[0];
  return content.type === 'text' ? content.text : '';
}

/**
 * 根因分析函数 - 专门用于 Bug 诊断和问题分析
 *
 * 功能说明：
 * 针对 Bug 和问题场景，提供系统性的根因分析和修复建议
 *
 * 分析维度：
 * 1. 问题定位：找到最可能出问题的代码位置
 * 2. 根本原因：分析问题的本质原因（逻辑错误、状态管理、并发等）
 * 3. 调用链分析：追踪问题的产生和传播路径
 * 4. 复现条件：说明在什么情况下会触发问题
 * 5. 修复建议：提供 2-3 个具体的解决方案
 * 6. 预防措施：说明如何避免类似问题
 *
 * 与普通问答的区别：
 * - 更关注"为什么"而不是"是什么"
 * - 提供系统性的诊断流程
 * - 给出可操作的修复方案
 * - 强调预防和最佳实践
 *
 * @param query - Bug 描述或问题查询
 * @param evidence - 相关代码证据
 * @param useExtendedContext - 是否使用扩展上下文（默认 true）
 * @returns 根因分析报告
 *
 * @example
 * const evidence = [
 *   { code_text: "if (user.id = userId) { ... }", file_path: "src/auth.ts", ... }
 * ];
 * const analysis = await analyzeRootCause("为什么用户认证总是失败", evidence);
 * // 返回详细的根因分析报告
 */
export async function analyzeRootCause(
  query: string,
  evidence: Array<CodeChunkRecord & { file_path?: string }>,
  useExtendedContext: boolean = true
): Promise<string> {
  // 步骤 1: 使用扩展上下文（为代码片段添加前后 5 行）
  let evidenceWithContext: Array<CodeChunkRecord & { file_path?: string; extended_code?: string }> = evidence;
  if (useExtendedContext) {
    try {
      evidenceWithContext = await getChunksWithContext(evidence, 5, 5);
      console.log('Using extended context for root cause analysis');
    } catch (error) {
      console.log('Extended context unavailable, using original evidence');
    }
  }

  // 步骤 2: 构建证据文本
  const evidenceText = evidenceWithContext
    .map((e, i) => {
      const codeToShow = e.extended_code || e.code_text;
      return `[证据 ${i + 1}] ${e.file_path || 'unknown'}:${e.line_start}-${e.line_end}
符号: ${e.symbol_name} (${e.symbol_type})
代码:
\`\`\`
${codeToShow}
\`\`\`
`;
    })
    .join('\n\n');

  // 步骤 3: 生成专门的根因分析提示词
  const systemPrompt = `你是一个专业的代码问题诊断专家，擅长分析 Bug 的根本原因。

你的分析方法：
1. 系统性思考：从多个角度分析问题
2. 证据驱动：基于实际代码推断，不臆测
3. 追根溯源：找到根本原因，不只是表面现象
4. 实用建议：给出可操作的修复方案`;

  const userPrompt = `Bug 描述: ${query}

相关代码证据:
${evidenceText}

请进行根因分析，按以下结构回答：

1. **问题定位** (最可能出问题的代码位置)
2. **根本原因** (为什么会出现这个问题)
   - 分析可能的原因类型：
     * 逻辑错误
     * 状态管理问题
     * 并发/竞态条件
     * 配置错误
     * 依赖问题
     * 边界条件处理
3. **调用链分析** (问题如何产生和传播)
4. **复现条件** (什么情况下会触发)
5. **修复建议** (2-3 个具体的解决方案)
6. **预防措施** (如何避免类似问题)

要求:
- 用中文回答
- 基于证据推断，不要臆测
- 给出具体的文件路径和行号
- 如果证据不足，明确指出需要查看哪些额外信息`;

  // 步骤 4: 调用 Claude AI 生成根因分析
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const content = message.content[0];
  return content.type === 'text' ? content.text : '';
}
