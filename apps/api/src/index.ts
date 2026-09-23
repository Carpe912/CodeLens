/**
 * CodeLens API 服务入口（bootstrap）
 *
 * 本文件只负责进程级生命周期：环境校验 → 装配应用 → 监听端口 → 优雅关闭。
 * 具体职责已拆分：
 * - 插件与路由装配 → src/server/app.ts
 * - 服务级单例     → src/server/context.ts
 * - 各领域路由      → src/server/routes/*.ts
 *
 * 技术栈：
 * - Fastify: 高性能 Web 框架
 * - PostgreSQL + pgvector: 向量数据库
 * - LLM: DeepSeek（经 llm/client.ts 的 LangChain 适配层）
 * - BullMQ: 任务队列（索引任务）
 */

import 'dotenv/config';

import { buildServer } from './server/app.js';

/**
 * 验证必需的环境变量
 *
 * 必需：
 * - DEEPSEEK_API_KEY: LLM 密钥（推理/问答）
 * - OPENAI_API_KEY 或 EMBED_API_KEY: 向量嵌入 API 密钥
 *
 * 缺失时直接退出并提示。
 *
 * 注意：这两个密钥属于**不同厂商**，必须分别校验——DeepSeek 不提供嵌入模型，
 * 嵌入始终走 OpenAI 兼容端点（见 llm/embeddings.ts）。
 */
function validateEnv() {
  const hasLlmKey = Boolean(process.env.DEEPSEEK_API_KEY);
  const hasEmbedKey = Boolean(process.env.EMBED_API_KEY || process.env.OPENAI_API_KEY);

  const required = [
    hasLlmKey ? null : 'DEEPSEEK_API_KEY',
    hasEmbedKey ? null : 'OPENAI_API_KEY or EMBED_API_KEY',
  ].filter(Boolean);

  if (required.length > 0) {
    console.error(`Missing required environment variables: ${required.join(', ')}`);
    console.error('(请检查 .env 文件)');
    process.exit(1);
  }
}

validateEnv();

const fastify = await buildServer();

/**
 * 服务器监听端口（环境变量 PORT，默认 8787）
 */
const port = parseInt(process.env.PORT || '8787');

/**
 * 优雅关闭
 *
 * 监听 SIGINT / SIGTERM：停止接受新请求 → 等待现有请求完成 → 关闭服务器。
 * 不关闭数据库连接池，让后台索引任务（BullMQ）继续运行；
 * 连接池会在进程退出时自动清理。
 */
const signals = ['SIGINT', 'SIGTERM'];
signals.forEach((signal) => {
  process.on(signal, async () => {
    console.log(`Received ${signal}, closing server gracefully...`);
    try {
      await fastify.close();
      console.log('Server closed successfully');
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
  });
});

/**
 * 启动服务器：监听所有网络接口（0.0.0.0），支持 Docker 与本地/生产环境。
 */
try {
  await fastify.listen({ port, host: '0.0.0.0' });
  console.log(`CodeLens API running at http://localhost:${port}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
