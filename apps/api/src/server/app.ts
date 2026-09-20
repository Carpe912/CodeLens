/**
 * Fastify 应用装配
 *
 * 负责：创建实例 → 注册插件 → 初始化数据库 → 启动索引 worker → 注册路由。
 * 顺序与拆分前 index.ts 保持一致。
 *
 * 拆分前的 index.ts 在模块顶层用 top-level await 直接做这些事；现在收敛到
 * buildServer()，由 index.ts 调用，便于测试时复用（可在不 listen 的情况下拿到 app）。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';

import { initDatabase } from '../db/index.js';
import { startIndexWorker } from '../indexing/queue.js';
import { registerRoutes } from './routes/index.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  // 跨域
  await app.register(cors);

  // 文件上传（ZIP 导入）：单文件上限 50MB
  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024,
      files: 1,
    },
  });

  // 限流：每分钟 100 次
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // 初始化数据库（建表/索引）
  await initDatabase();

  // 启动后台索引任务队列
  startIndexWorker();

  // 注册全部路由
  await registerRoutes(app);

  return app;
}
