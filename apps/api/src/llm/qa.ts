import Anthropic from '@anthropic-ai/sdk';
import type { CodeChunkRecord } from '../db/index.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

export async function answerQuestion(
  query: string,
  evidence: Array<CodeChunkRecord & { file_path?: string }>,
  historicalFeedback?: Array<{ query: string; answer: string; feedback: Array<{ feedback_text: string; is_helpful: boolean }> }>
): Promise<string> {
  const evidenceText = evidence
    .map((e, i) => {
      return `[证据 ${i + 1}] ${e.file_path || 'unknown'}:${e.line_start}-${e.line_end}
符号: ${e.symbol_name} (${e.symbol_type})
代码:
\`\`\`
${e.code_text}
\`\`\`
`;
    })
    .join('\n\n');

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

  const prompt = `你是一个代码智能问答助手。用户提出了关于代码仓库的问题，我已经为你检索了相关的代码片段作为证据。

用户问题: ${query}

相关代码证据:
${evidenceText}
${feedbackContext}
请基于这些证据回答用户的问题。要求:
1. 直接回答问题，给出具体的文件、函数、行号
2. 解释实现方案和逻辑
3. 如果证据不足，明确指出
4. 如果有历史反馈，请整合其中有价值的信息（如废弃的功能、相关议题等）
5. 用中文回答`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = message.content[0];
  return content.type === 'text' ? content.text : '';
}

export async function analyzeRootCause(query: string, evidence: Array<CodeChunkRecord & { file_path?: string }>): Promise<string> {
  const evidenceText = evidence
    .map((e, i) => {
      return `[证据 ${i + 1}] ${e.file_path || 'unknown'}:${e.line_start}-${e.line_end}
符号: ${e.symbol_name} (${e.symbol_type})
代码:
\`\`\`
${e.code_text}
\`\`\`
`;
    })
    .join('\n\n');

  const prompt = `你是一个代码根因分析专家。用户报告了一个 bug，我已经为你检索了相关的代码片段。

Bug 描述: ${query}

相关代码证据:
${evidenceText}

请分析这个 bug 的根本原因。要求:
1. 识别可能的根因（token 过期、状态管理、并发问题等）
2. 指出具体的代码位置和逻辑问题
3. 给出调用链分析
4. 提供修复建议
5. 用中文回答`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = message.content[0];
  return content.type === 'text' ? content.text : '';
}
