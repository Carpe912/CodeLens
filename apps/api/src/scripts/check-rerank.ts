/**
 * Rerank 连通性自检脚本
 *
 * 用途：部署后确认 rerank 精排**真的能调通**，而不只是「配置里写了」。
 * 走的是与线上完全一致的代码路径（retrieval/rerank.ts），因此能真实暴露：
 * - 密钥缺失或失效（InvalidApiKey）
 * - 模型名不被服务端接受（Model Not Exist / 400）
 * - baseURL 配错 / 网络不通 / 超时
 * - 模型是否**真的在做语义排序**（相关性文档是否排到第一）
 *
 * 用法：
 *   pnpm --filter @codelens/api check:rerank
 *   # 服务器上（PM2 的 env_production 不会进到手动 shell，需显式带 env 文件）
 *   node --env-file-if-exists=.env.production apps/api/dist/scripts/check-rerank.js
 *
 * 退出码：0 = 通过；1 = 调用失败；2 = 配置缺失。
 */

import 'dotenv/config';
import { rerankDocuments, getRerankConfig, resetRerankCooldown } from '../retrieval/rerank.js';
import { describeError } from '../utils/errors.js';

/** 明显的相关性梯度：0 最相关，1 弱相关，2 无关 */
const QUERY = '如何计算订单总价';
const DOCUMENTS = [
  'function calculateOrderTotal(items: Item[]): number { return items.reduce((sum, i) => sum + i.price * i.qty, 0); }',
  'function getOrderStatus(orderId: string): Promise<OrderStatus> { return db.orders.findOne(orderId).status; }',
  'function sendNotificationEmail(to: string, subject: string): Promise<void> { return mailer.send({ to, subject }); }',
];
const EXPECTED_TOP_INDEX = 0;

async function main(): Promise<void> {
  resetRerankCooldown();
  const config = getRerankConfig();

  console.log('='.repeat(64));
  console.log('Rerank 自检');
  console.log('='.repeat(64));
  console.log(`启用开关 : ${config.enabled ? 'true' : 'false（线上检索不会调用 rerank）'}`);
  console.log(`模型     : ${config.model}`);
  console.log(`端点     : ${config.baseUrl}/api/v1/services/rerank/text-rerank/text-rerank`);
  console.log(`密钥     : ${config.hasApiKey ? '已配置' : '缺失'}`);
  console.log(`候选/超时 : ${config.candidates} / ${config.timeoutMs}ms`);
  console.log('');

  if (!config.hasApiKey) {
    console.error('✗ 未配置 rerank 密钥（RERANK_API_KEY / DASHSCOPE_API_KEY），无法自检');
    process.exit(2);
  }

  console.log(`查询: ${QUERY}`);
  DOCUMENTS.forEach((d, i) => console.log(`  [${i}] ${d.slice(0, 72)}${d.length > 72 ? '…' : ''}`));
  console.log('');
  console.log('正在发起一次真实调用...');
  console.log('');

  const startedAt = Date.now();
  try {
    const scores = await rerankDocuments(QUERY, DOCUMENTS, { topN: DOCUMENTS.length });
    const elapsed = Date.now() - startedAt;

    console.log('✓ 调用成功');
    console.log(`  耗时: ${elapsed}ms`);
    console.log('  打分（降序）:');
    scores.forEach((s, rank) => {
      const tag = s.index === EXPECTED_TOP_INDEX ? '  ← 期望最相关' : '';
      console.log(`    #${rank + 1}  原始下标 ${s.index}  score=${s.relevanceScore.toFixed(6)}${tag}`);
    });

    if (scores[0]?.index !== EXPECTED_TOP_INDEX) {
      console.error('');
      console.error(`✗ 排序不符合预期：最相关文档（下标 ${EXPECTED_TOP_INDEX}）未排到第一`);
      console.error('  链路是通的，但模型没有正确排序——请确认模型名是否为 rerank 类模型');
      process.exit(1);
    }

    console.log('');
    console.log('='.repeat(64));
    console.log('PASS — rerank 链路正常且排序正确');
    console.log('='.repeat(64));
  } catch (error) {
    console.error('✗ 调用失败');
    console.error(describeError(error));
    console.error('');
    console.error('排查提示：');
    console.error('  - InvalidApiKey   → 密钥错误/过期，检查 RERANK_API_KEY');
    console.error('  - Model Not Exist → 模型名不被服务端接受，检查 RERANK_MODEL');
    console.error('                     （DashScope 公开文档里的重排模型名通常是 qwen3-rerank）');
    console.error('  - 超时            → 检查 RERANK_BASE_URL 与网络，或调大 RERANK_TIMEOUT_MS');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('自检脚本异常退出:');
  console.error(describeError(error));
  process.exit(1);
});
