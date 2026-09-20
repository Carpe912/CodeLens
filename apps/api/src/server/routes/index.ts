/**
 * 路由注册入口
 *
 * 把各领域路由插件统一注册到 Fastify 实例上。路由路径与拆分前完全一致
 * （拆分只是把同一个文件里的 30 个 handler 按领域分到 7 个模块）。
 */

import type { FastifyInstance } from 'fastify';
import { healthRoutes } from './health.js';
import { reposRoutes } from './repos.js';
import { searchRoutes } from './search.js';
import { askRoutes } from './ask.js';
import { feedbackRoutes } from './feedback.js';
import { agentRoutes } from './agent.js';
import { adminRoutes } from './admin.js';
import { analysisRoutes } from './analysis.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoutes);
  await app.register(reposRoutes);
  await app.register(searchRoutes);
  await app.register(askRoutes);
  await app.register(feedbackRoutes);
  await app.register(agentRoutes);
  await app.register(adminRoutes);
  await app.register(analysisRoutes);
}
