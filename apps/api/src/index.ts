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
 * - LLM: 由 LLM_PROVIDER 决定（deepseek | anthropic）
 * - BullMQ: 任务队列（索引任务）
 */

import 'dotenv/config';

import { buildServer } from './server/app.js';
import { resolveProvider } from './llm/client.js';

/**
 * 验证必需的环境变量
 *
 * 必需：
 * - LLM 密钥：按 LLM_PROVIDER 决定的厂商校验
 *     deepseek  → DEEPSEEK_API_KEY
 *     anthropic → ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY
 * - OPENAI_API_KEY 或 EMBED_API_KEY: 向量嵌入 API 密钥
 *
 * 缺失时直接退出并提示。
 *
 * 注意：这里曾经写死只认 ANTHROPIC_*，把「换 LLM 厂商」和「服务能不能启动」
 * 绑死在一起——切换到 DeepSeek 后会因为校验不到 Anthropic 密钥而直接 exit(1)。
 * 因此改为按 provider 校验，嵌入侧要求保持不变（DeepSeek 不提供嵌入模型）。
 */
function validateEnv() {
  const provider = resolveProvider();

  const llmOk =
    provider === 'deepseek'
      ? Boolean(process.env.DEEPSEEK_API_KEY)
      : Boolean(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY);

  const required = [
    llmOk ? null : provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN',
    process.env.EMBED_API_KEY || process.env.OPENAI_API_KEY ? null : 'OPENAI_API_KEY or EMBED_API_KEY',
  ].filter(Boolean);

  if (required.length > 0) {
    console.error(`Missing required environment variables: ${required.join(', ')}`);
    console.error(`(当前 LLM_PROVIDER=${provider}，请检查 .env 文件)`);
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
