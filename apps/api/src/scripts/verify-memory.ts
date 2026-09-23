#!/usr/bin/env node

/**
 * 会话记忆 / 答案一致性 / 超时重试 的离线断言
 *
 * ============================================
 * 为什么需要这个脚本
 * ============================================
 * 本次新增的三块能力里，有两块是**纯函数**（历史上下文压缩、引用一致性判定），
 * 但它们的行为很难靠「跑一次服务看一眼」验证：
 *
 * - 上下文压缩的边界是「预算不够时保留最新的那一轮」，
 *   在正常 3 轮输入下**永远不会触发**，肉眼看不出来。
 * - 引用一致性最有价值的判定是 `line_mismatch`（文件对得上、行号编的），
 *   必须构造一个「文件在证据里、行号不在区间里」的输入才能验到。
 * - 一致性检查存在一类系统性漏判风险：把裸文件名当全路径匹配，
 *   会让「引用了不存在的文件」被判成 ok。这个漏洞在**正常输入下不会暴露**。
 *
 * 本项目没有测试框架（devDeps 里没有 vitest/jest），约定是用
 * `src/scripts/verify-*.ts` 写自包含断言脚本 + 退出码。
 * 本脚本沿用该约定：不连数据库、不起服务，纯内存断言。
 *
 * 用法：
 *   ./node_modules/.bin/tsx src/scripts/verify-memory.ts
 *   （或 pnpm --filter @codelens/api verify:memory）
 *
 * 退出码：断言失败 = 1
 */

import {
  formatConversationContext,
  normalizeSessionId,
  MAX_SESSION_ID_LEN,
  MAX_HISTORY_ANSWER_CHARS,
  MAX_HISTORY_QUERY_CHARS,
  type ConversationTurn,
} from '../agent/conversation-memory.js';
import { checkAnswerConsistency, describeConsistencyIssue } from '../llm/answer-consistency.js';
import { withRetry, withTimeout, TimeoutError } from '../utils/async.js';

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log('');
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

function turn(query: string, answer: string, minutesAgo = 0): ConversationTurn {
  return { query, answer, createdAt: new Date(Date.now() - minutesAgo * 60_000) };
}

async function main(): Promise<void> {
  console.log('='.repeat(72));
  console.log('会话记忆 / 答案一致性 / 超时重试 断言');
  console.log('='.repeat(72));

  // ============================================================
  // 1. normalizeSessionId
  // ============================================================
  section('normalizeSessionId');
  check('非字符串 → null', normalizeSessionId(123) === null);
  check('undefined → null', normalizeSessionId(undefined) === null);
  check('空串 → null', normalizeSessionId('') === null);
  check('纯空白 → null', normalizeSessionId('   \n\t ') === null);
  check('正常值原样返回', normalizeSessionId('sess-abc') === 'sess-abc');
  check('两端空白被裁掉', normalizeSessionId('  sess-abc  ') === 'sess-abc');
  {
    const long = 'x'.repeat(500);
    const got = normalizeSessionId(long);
    check(
      `超长被裁到 ${MAX_SESSION_ID_LEN}`,
      got !== null && got.length === MAX_SESSION_ID_LEN,
      `实际长度 ${got?.length}`
    );
  }

  // ============================================================
  // 2. formatConversationContext
  // ============================================================
  section('formatConversationContext');

  check('无历史 → 空串（提示词与开启记忆前逐字一致）', formatConversationContext([]) === '');

  {
    const turns = [
      turn('登录是怎么实现的', '答案一：见 src/auth/login.ts:10', 3),
      turn('那它呢', '答案二：见 src/auth/session.ts:20', 2),
      turn('再往下看一层', '答案三：见 src/auth/token.ts:30', 1),
    ];
    const ctx = formatConversationContext(turns);

    check('包含全部 3 轮', ctx.includes('历史第 1 轮') && ctx.includes('历史第 3 轮'));
    check('包含各轮问题', ctx.includes('登录是怎么实现的') && ctx.includes('再往下看一层'));
    // 顺序是最容易写错的地方：DESC 取回来如果不 reverse，模型会看到倒序对话
    check(
      '按时间正序（第1轮 在 第3轮 之前）',
      ctx.indexOf('历史第 1 轮') < ctx.indexOf('历史第 3 轮')
    );
    // 这条指令是防「复用上一轮的文件:行号」的关键，缺了它一致性检查会大面积报警
    check(
      '含「证据只能来自本轮证据」的约束',
      ctx.includes('不要引用历史轮次里出现过的文件名或行号')
    );
    check('含会话历史起止标记', ctx.includes('=== 同一会话此前轮次 ===') && ctx.includes('=== 会话历史结束 ==='));
  }

  {
    // 单轮答案超长 → 截断并打标
    const longAnswer = 'A'.repeat(MAX_HISTORY_ANSWER_CHARS + 500);
    const ctx = formatConversationContext([turn('长答案问题', longAnswer, 1)]);
    check('超长答案被截断', ctx.includes('…（已截断）'));
    check(
      '截断后总长受控',
      ctx.length < MAX_HISTORY_ANSWER_CHARS + 400,
      `实际 ${ctx.length}`
    );
  }

  {
    // 预算不足时必须保留**最新**一轮，而不是最早一轮
    const turns = [
      turn('最早的问题', 'E'.repeat(2000), 3),
      turn('最近的问题', '最新答案本体', 1),
    ];
    const ctx = formatConversationContext(turns, 600);
    check(
      '预算不足时保留最新一轮（而非最早一轮）',
      ctx.includes('最近的问题') && !ctx.includes('最早的问题'),
      `上下文片段: ${ctx.slice(0, 160).replace(/\n/g, ' ')}`
    );
  }

  {
    // 极端预算：一轮都放不下时，也不能吐出一个残缺块
    const ctx = formatConversationContext([turn('问题', '答'.repeat(100))], 10);
    check('预算连一轮都放不下 → 返回空串而非半截内容', ctx === '');
  }

  {
    // 超长**问题**也要截断：用户可以把整个文件粘进输入框当提问，
    // 只截答案挡不住这种输入（这是真实存在的用法，不是假想）
    const ctx = formatConversationContext([turn('Q'.repeat(5000), '答')]);
    check('超长问题被截断', ctx.includes('…（已截断）'), `上下文长度 ${ctx.length}`);
    check(
      '超长问题不会撑爆上下文',
      ctx.length < MAX_HISTORY_QUERY_CHARS + 400,
      `实际 ${ctx.length}`
    );
  }

  {
    // ★ 关键不变量：默认预算下「最坏单轮输入」也必须能注入进去。
    // 否则会出现「用户传了 sessionId、历史也确实有，但上下文恒为空」——
    // 会话记忆静默失效，且没有任何报错。这是本项目最忌讳的失败形状。
    const worst = turn('Q'.repeat(5000), 'A'.repeat(20000));
    const ctx = formatConversationContext([worst]);
    check(
      '不变量：默认预算下最坏单轮输入仍能注入（记忆不会静默失效）',
      ctx.length > 0 && ctx.includes('历史第 1 轮'),
      `上下文长度 ${ctx.length}`
    );
  }

  // ============================================================
  // 3. checkAnswerConsistency
  // ============================================================
  section('checkAnswerConsistency');

  const evidence = [
    { file_path: 'apps/api/src/llm/qa.ts', line_start: 399, line_end: 464 },
    { file_path: 'apps/api/src/agent/core.ts', line_start: 142, line_end: 211 },
  ];

  check(
    '证据为空 → empty_evidence',
    checkAnswerConsistency('见 src/a.ts:1', []).verdict === 'empty_evidence'
  );
  check(
    '答案无引用 → no_refs（不算失败）',
    checkAnswerConsistency('这是一个不带任何引用的回答。', evidence).verdict === 'no_refs'
  );
  check(
    '空答案 → no_refs',
    checkAnswerConsistency('', evidence).verdict === 'no_refs'
  );

  {
    const r = checkAnswerConsistency('答案定义在 apps/api/src/llm/qa.ts:420 处。', evidence);
    check('精确路径 + 区间内行号 → ok', r.verdict === 'ok', `verdict=${r.verdict}`);
    check('行号判定为命中区间', r.citations[0]?.lineInEvidence === true);
  }

  {
    // 模型常省略前缀，这里必须能对上（否则报告全是误报，等于没有拦截）
    const r = checkAnswerConsistency('见 llm/qa.ts:400。', evidence);
    check('后缀路径（省略 apps/api/src/ 前缀）能匹配', r.verdict === 'ok', `verdict=${r.verdict}`);
  }

  {
    const r = checkAnswerConsistency('见 qa.ts:400。', evidence);
    check('裸文件名（qa.ts）能匹配到全路径', r.verdict === 'ok', `verdict=${r.verdict}`);
  }

  {
    // 核心用例：引用了证据里根本没有的文件 → 幻觉引用的强信号
    const r = checkAnswerConsistency('实现在 src/auth/login.ts:88。', evidence);
    check('引用不存在的文件 → unsupported_refs', r.verdict === 'unsupported_refs', `verdict=${r.verdict}`);
    check('该引用出现在 unsupported 列表', r.unsupported.includes('src/auth/login.ts:88'));
    check('对应 citation.fileMatched = false', r.citations[0]?.fileMatched === false);
  }

  {
    // 核心用例：文件对得上，但行号在所有证据区间之外（编造行号）
    const r = checkAnswerConsistency('见 apps/api/src/llm/qa.ts:99999。', evidence);
    check('文件匹配但行号越界 → line_mismatch', r.verdict === 'line_mismatch', `verdict=${r.verdict}`);
    check('越界引用出现在 mismatchedLines', r.mismatchedLines.length === 1);
    check('fileMatched 仍为 true（文件是对的）', r.citations[0]?.fileMatched === true);
  }

  {
    // 区间写法 `399-464`：取起始行判定
    const r = checkAnswerConsistency('见 apps/api/src/llm/qa.ts:399-464。', evidence);
    check('支持 `行号-行号` 区间写法', r.verdict === 'ok', `verdict=${r.verdict}`);
  }

  {
    // URL 的端口号不是行号 —— 不排除的话每个带端口的 URL 都会变成一条假引用
    const r = checkAnswerConsistency('接口在 https://example.com:8080/api/users 上。', evidence);
    check('URL 端口不会被误判成引用', r.verdict === 'no_refs', `verdict=${r.verdict}`);
  }

  {
    // 混合：一条对、一条编 → 整体必须是 unsupported_refs（不能被「有对的」冲淡）
    const r = checkAnswerConsistency(
      '一部分见 apps/api/src/llm/qa.ts:420，另一部分见 src/nope.ts:1。',
      evidence
    );
    check('混合引用 → 取最严重的 verdict', r.verdict === 'unsupported_refs', `verdict=${r.verdict}`);
    check('citations 记录全部 2 条', r.citations.length === 2, `实际 ${r.citations.length}`);
  }

  {
    // 前缀边界：`xqa.ts` 不该被当作 `qa.ts` 的后缀匹配
    const r = checkAnswerConsistency('见 mysrc/xqa.ts:1。', evidence);
    check('不把 xqa.ts 误判为 qa.ts 的后缀', r.verdict === 'unsupported_refs', `verdict=${r.verdict}`);
  }

  // 告警文案：四条链路共用同一个格式化函数，措辞正确性同样要验
  {
    const r = checkAnswerConsistency('实现在 src/auth/login.ts:88。', evidence);
    const msg = describeConsistencyIssue(r, '[test]');
    check('unsupported_refs → 告警含未匹配文件', !!msg && msg.includes('未匹配文件 ['),
      String(msg));

    // line_mismatch 时 unsupported 天然为空，不能打出「未匹配文件 []」
    const m = checkAnswerConsistency('见 apps/api/src/llm/qa.ts:99999。', evidence);
    const mMsg = describeConsistencyIssue(m, '[test]');
    check('line_mismatch → 告警只提行号越界', !!mMsg && mMsg.includes('行号越界 [')
      && !mMsg.includes('未匹配文件'), String(mMsg));

    // 判定正常时必须返回 null —— 否则调用方那句 `if (warning)` 形同虚设
    const ok = checkAnswerConsistency('见 apps/api/src/llm/qa.ts:420。', evidence);
    check('判定 ok → 不产出告警', describeConsistencyIssue(ok, '[test]') === null);
    check('无引用判定 → 不产出告警',
      describeConsistencyIssue(checkAnswerConsistency('没有引用的回答。', evidence), '[test]')
        === null);
  }

  // ============================================================
  // 4. withTimeout / withRetry
  // ============================================================
  section('withTimeout / withRetry');

  {
    const slow = new Promise(resolve => setTimeout(resolve, 500));
    let threw: unknown = null;
    try {
      await withTimeout(slow, 30, 'test.slow');
    } catch (e) {
      threw = e;
    }
    check('超时抛 TimeoutError', threw instanceof TimeoutError, `实际：${String(threw)}`);
  }

  {
    const fast = Promise.resolve('ok');
    const got = await withTimeout(fast, 1000, 'test.fast');
    check('未超时正常返回', got === 'ok');
  }

  {
    const got = await withTimeout(Promise.resolve('no-limit'), 0, 'test.disabled');
    check('timeoutMs=0 表示不限制', got === 'no-limit');
  }

  {
    // 第 1 次失败、第 2 次成功 → withRetry 必须重试
    let calls = 0;
    const got = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new Error('第一次失败');
        return '第二次成功';
      },
      { attempts: 2, label: 'test.retry' }
    );
    check('重试后成功', got === '第二次成功' && calls === 2, `calls=${calls}`);
  }

  {
    // 全部失败 → 抛出的必须是**原始错误**，不能被包成 AggregateError
    let calls = 0;
    let threw: any = null;
    try {
      await withRetry(
        async () => {
          calls++;
          throw new Error(`第 ${calls} 次失败`);
        },
        { attempts: 3, label: 'test.exhaust' }
      );
    } catch (e) {
      threw = e;
    }
    check('尝试次数用尽后抛出', calls === 3, `calls=${calls}`);
    check('抛出的是最后一次的原始错误', threw?.message === '第 3 次失败', `实际：${threw?.message}`);
  }

  {
    // shouldRetry 返回 false → 不重试（用于「参数错误重试也没用」的场景）
    let calls = 0;
    try {
      await withRetry(
        async () => {
          calls++;
          throw new Error('fatal');
        },
        { attempts: 3, label: 'test.noretry', shouldRetry: () => false }
      );
    } catch {
      /* 预期抛出 */
    }
    check('shouldRetry=false 时只调用一次', calls === 1, `calls=${calls}`);
  }

  {
    // 超时 + 重试组合：每次尝试都超时，最终抛 TimeoutError
    let calls = 0;
    let threw: unknown = null;
    try {
      await withRetry(
        () => {
          calls++;
          return new Promise(resolve => setTimeout(resolve, 200));
        },
        { attempts: 2, timeoutMs: 20, label: 'test.timeout-retry' }
      );
    } catch (e) {
      threw = e;
    }
    check('超时会被重试', calls === 2, `calls=${calls}`);
    check('最终抛 TimeoutError', threw instanceof TimeoutError);
  }

  // ============================================================
  // 汇总
  // ============================================================
  console.log('');
  console.log('='.repeat(72));
  if (failures === 0) {
    console.log(`PASS — ${checks} 项断言全部通过`);
  } else {
    console.log(`FAIL — ${failures}/${checks} 项断言失败`);
  }
  console.log('='.repeat(72));

  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
  console.error('');
  console.error('断言脚本自身失败：');
  console.error(error);
  process.exit(2);
});
