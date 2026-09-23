/**
 * LLM 连通性自检脚本
 *
 * 用途：部署完成后确认「当前配置的 LLM 厂商」真的可用——而不只是「进程起来了」。
 * 代码路径与线上完全一致（走 getLlmClient → provider 适配层），因此能真实暴露：
 * - 密钥缺失或失效（401）
 * - 模型名不被厂商接受（400 Model Not Exist）
 * - baseURL 配错 / 网络不通
 *
 * 用法：
 *   pnpm --filter api check:llm
 *   # 服务器上（PM2 的 env_production 不会进到手动 shell，故需显式带 env 文件）
 *   node --env-file-if-exists=.env.production apps/api/dist/scripts/check-llm.js
 *
 * 退出码：0 = 通过；1 = 调用失败；2 = 配置缺失。
 */

import 'dotenv/config';
import { getLlmClient, describeLlmConfig, hasApiKey, resolveProvider } from '../llm/client.js';
import { describeError } from '../utils/errors.js';

async function main(): Promise<void> {
  const provider = resolveProvider();

  console.log('='.repeat(64));
  console.log('LLM 自检');
  console.log('='.repeat(64));
  console.log(`配置: ${describeLlmConfig()}`);
  console.log('');

  if (!hasApiKey()) {
    console.error(`✗ 未配置 DeepSeek 的密钥，无法自检`);
    process.exit(2);
  }

  const client = getLlmClient();
  console.log(`实际使用 provider=${client.provider}`);
  console.log('正在发起一次真实调用...');
  console.log('');

  const startedAt = Date.now();
  try {
    const response = await client.messages.create({
      // 刻意传一个 Claude 风格的名字：验证「换厂商后模型名自动映射」这条逻辑
      model: 'claude-sonnet-4-6',
      max_tokens: 64,
      temperature: 0,
      system: '你是一个自检探针，只做最简短的回复。',
      messages: [{ role: 'user', content: '回复四个字：链路正常' }],
    });

    const elapsed = Date.now() - startedAt;
    const text = response.content.find((b) => b.type === 'text')?.text ?? '';

    console.log('✓ 调用成功');
    console.log(`  耗时     : ${elapsed}ms`);
    console.log(`  请求模型 : claude-sonnet-4-6（由适配层映射）`);
    console.log(`  生效模型 : ${response.model ?? '(未回传)'}`);
    console.log(`  返回内容 : ${text.trim()}`);

    if (!text.trim()) {
      console.error('');
      console.error('✗ 返回内容为空——链路通了但没拿到文本，请检查模型能力/参数');
      process.exit(1);
    }

    console.log('');
    console.log('='.repeat(64));
    console.log('PASS — LLM 链路正常');
    console.log('='.repeat(64));
  } catch (error) {
    console.error('✗ 调用失败');
    console.error(describeError(error));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('自检脚本异常退出:');
  console.error(describeError(error));
  process.exit(1);
});
