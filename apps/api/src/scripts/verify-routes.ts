#!/usr/bin/env node

/**
 * 路由注册验证（不需要数据库）
 *
 * 为什么需要这个脚本：
 * routes/* 是按领域拆出来的插件，只有在 `app.ready()` 时 Fastify 才会
 * 真正校验路由表 —— 重复路径、非法路径、插件注册错误都会在这一刻抛错。
 * `tsc` 完全查不出来。此前验证路由只能靠「启动整个服务」，
 * 而启动服务需要数据库连接，本地经常没有 PG，于是这一步长期被跳过。
 *
 * 本脚本只注册路由、不初始化数据库也不启动监听，
 * 因此可以在无 PG 环境下验证「路由表本身是否健康、新端点是否真的挂上了」。
 *
 * 用法：
 *   pnpm --filter @codelens/api verify:routes
 *
 * 退出码：断言失败 = 1
 */

import Fastify from 'fastify';
import { registerRoutes } from '../server/routes/index.js';

/** 必须存在的路由（新增能力在此登记，防止「写了但没挂上」） */
const EXPECTED: Array<{ method: string; url: string }> = [
  { method: 'GET', url: '/health' },

  // 影响面分析（本次新增）
  { method: 'GET', url: '/impact' },
  { method: 'GET', url: '/impact/file' },
  { method: 'GET', url: '/impact/symbol' },

  // 既有能力，确保没有被新路由挤掉
  { method: 'GET', url: '/search' },
  { method: 'GET', url: '/call-graph' },
  { method: 'POST', url: '/ask' },
  { method: 'POST', url: '/agent/query' },
  { method: 'POST', url: '/agent/v2/query' },
  { method: 'GET', url: '/repos' },
];

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`PASS  ${name}${detail ? '  :: ' + detail : ''}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? '  :: ' + detail : ''}`);
  }
}

async function main(): Promise<void> {
  console.log('='.repeat(64));
  console.log('路由注册验证（无需数据库）');
  console.log('='.repeat(64));
  console.log('');

  const app = Fastify({ logger: false });

  // 用官方 onRoute 钩子收集路由表。
  // 不要读 fastify 内部字段（如 app.routes）—— 那是私有实现，版本间会变。
  const registered = new Set<string>();
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const m of methods) registered.add(`${String(m).toUpperCase()} ${route.url}`);
  });

  try {
    await registerRoutes(app);
  } catch (error: any) {
    console.log(`FAIL  路由注册抛错  :: ${error.message}`);
    process.exit(1);
  }

  // app.ready() 才是 Fastify 真正校验路由表的时刻
  try {
    await app.ready();
    check('路由表可 ready（无重复/非法路径）', true);
  } catch (error: any) {
    check('路由表可 ready（无重复/非法路径）', false, error.message);
    process.exit(1);
  }

  console.log('');
  console.log('--- 已注册路由树 ---');
  console.log(app.printRoutes({ commonPrefix: false }));

  for (const exp of EXPECTED) {
    const key = `${exp.method} ${exp.url}`;
    // Fastify 会为 GET 自动补一条 HEAD，两者都算「路由存在」
    const ok = registered.has(key) || (exp.method === 'GET' && registered.has(`HEAD ${exp.url}`));
    check(`存在路由 ${key}`, ok);
  }

  check('路由数量 > 0', registered.size > 0, `${registered.size} 条`);

  console.log('');
  console.log('='.repeat(64));
  if (failures === 0) {
    console.log('==== ALL PASS ====');
  } else {
    console.log(`==== ${failures} FAILED ====`);
  }
  console.log('='.repeat(64));

  await app.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('验证脚本异常：', error);
  process.exit(2);
});
