import Anthropic from '@anthropic-ai/sdk';
import type { CodeChunkRecord } from '../db/index.js';
import { getChunksWithContext } from '../db/index.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

/**
 * 查询类型分类
 */
type QueryType =
  | 'url_lookup'           // URL 查找：/api/users, 这个接口在哪
  | 'code_location'        // 代码定位：login 函数在哪
  | 'implementation'       // 实现方式：如何实现登录
  | 'architecture'         // 架构理解：系统架构是什么
  | 'bug_analysis'         // Bug 分析：为什么会出现这个问题
  | 'usage_example'        // 使用示例：如何使用这个函数
  | 'comparison'           // 对比分析：A 和 B 有什么区别
  | 'general';             // 通用查询

/**
 * 智能分类查询类型
 */
function classifyQuery(query: string): QueryType {
  // URL 查找
  if (query.match(/\/(api|rest|v\d+|graphql)\/|:\w+|\/\{|\bhttps?:\/\//i)) {
    return 'url_lookup';
  }

  // 代码定位
  if (query.match(/在哪|位置|文件|哪个文件|定义在/)) {
    return 'code_location';
  }

  // 实现方式
  if (query.match(/如何实现|怎么实现|怎样实现|实现方式|实现逻辑|怎么做|如何处理/)) {
    return 'implementation';
  }

  // 架构理解
  if (query.match(/架构|设计|模式|结构|组织方式|整体.*流程|系统.*设计/)) {
    return 'architecture';
  }

  // Bug 分析
  if (query.match(/为什么|原因|bug|问题|错误|异常|失败|不work|不生效|没有.*效果/)) {
    return 'bug_analysis';
  }

  // 使用示例
  if (query.match(/如何使用|怎么用|用法|示例|例子|调用方式/)) {
    return 'usage_example';
  }

  // 对比分析
  if (query.match(/区别|差异|对比|比较|和.*有什么不同|vs/)) {
    return 'comparison';
  }

  return 'general';
}

/**
 * 生成针对性的系统提示词
 */
function generateSystemPrompt(queryType: QueryType): string {
  const basePrompt = `你是一个专业的代码智能助手，擅长理解和解释代码。`;

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
 * 优化的问答函数
 */
export async function answerQuestion(
  query: string,
  evidence: Array<CodeChunkRecord & { file_path?: string }>,
  historicalFeedback?: Array<{ query: string; answer: string; feedback: Array<{ feedback_text: string; is_helpful: boolean }> }>,
  useExtendedContext: boolean = true
): Promise<string> {
  // 1. 分类查询类型
  const queryType = classifyQuery(query);
  console.log(`Query classified as: ${queryType}`);

  // 2. 使用扩展上下文
  let evidenceWithContext: Array<CodeChunkRecord & { file_path?: string; extended_code?: string }> = evidence;
  if (useExtendedContext) {
    try {
      evidenceWithContext = await getChunksWithContext(evidence, 5, 5);
      console.log('Using extended context for evidence');
    } catch (error) {
      console.log('Extended context unavailable, using original evidence');
    }
  }

  // 3. 构建证据文本
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

  // 4. 构建反馈上下文
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

  // 5. 生成针对性提示词
  const systemPrompt = generateSystemPrompt(queryType);
  const userPrompt = generateUserPrompt(query, queryType, evidenceText, feedbackContext);

  // 6. 调用 Claude
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
 * 优化的根因分析函数
 */
export async function analyzeRootCause(
  query: string,
  evidence: Array<CodeChunkRecord & { file_path?: string }>,
  useExtendedContext: boolean = true
): Promise<string> {
  // 使用扩展上下文
  let evidenceWithContext: Array<CodeChunkRecord & { file_path?: string; extended_code?: string }> = evidence;
  if (useExtendedContext) {
    try {
      evidenceWithContext = await getChunksWithContext(evidence, 5, 5);
      console.log('Using extended context for root cause analysis');
    } catch (error) {
      console.log('Extended context unavailable, using original evidence');
    }
  }

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

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const content = message.content[0];
  return content.type === 'text' ? content.text : '';
}
