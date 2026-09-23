/**
 * 图编排验证脚本
 *
 * 用途：验证 LangGraph 编排层的行为正确性 —— 不只是「能编译」，而是「真的会按预期循环」。
 *
 * 运行：
 *   pnpm --filter @codelens/api verify:graph
 *   或 cd apps/api && ./node_modules/.bin/tsx src/scripts/verify-graph.ts
 *
 * 覆盖三层：
 *   A. 纯函数逻辑 —— 评分启发式、条件边判定、最坏情况收敛性
 *   B. 真实依赖探测 —— 数据库是否可连（信息性，失败不视为错误）
 *   C. 循环行为端到端 —— 注入桩件检索器/生成器，在**不依赖数据库和 LLM** 的
 *      前提下验证「证据不足 → 换策略重检索 → 充足后生成」确实发生
 *      （C5 额外验证答案引用自检：捏造的「文件:行号」会被挑出来且答案不被改写）
 *
 * 之所以能做到 C 层：createCodeLensGraph 支持注入 search 与 generateAnswer。
 * 若日后移除这两个注入点，本脚本将退化为只能验证 A、B 两层。
 *
 * ⚠️ 注意 import 顺序：dotenv 必须排在其余 import 之前。
 * 因为 llm/qa.ts 在**模块加载期**就会构造 LLM 客户端，
 * 若 dotenv 稍后才执行，读取到的密钥配置会不完整。
 */
import 'dotenv/config';
import pg from 'pg';
import { computeSufficiency, estimateConfidenceFromScores } from '../utils/scoring.js';
import { routeAfterGrade, SEARCH_STRATEGY_PLAN } from '../agent/graph/nodes.js';
import { createCodeLensGraph, runGraphQuery } from '../agent/graph/index.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`);
  if (!cond) failures++;
}
const near = (a: number, b: number, tol = 0.001) => Math.abs(a - b) <= tol;

// ============================================================
// A. 纯函数逻辑
// ============================================================
console.log('\n--- A1. 评分启发式 ---');
check('空证据 → 充分度 0', computeSufficiency([]) === 0);
check('空分数 → 置信度 0', estimateConfidenceFromScores([]) === 0);
check('全 1 分且满采样 → 置信度 1', near(estimateConfidenceFromScores([1, 1, 1, 1, 1]), 1));
check('NaN/Infinity 被过滤', estimateConfidenceFromScores([NaN, Infinity, -Infinity]) === 0);

const weakScore = computeSufficiency([{ score: 0.2, filePath: 'a.ts' }]);
const strongScore = computeSufficiency([
  { score: 0.9, filePath: 'a.ts' },
  { score: 0.85, filePath: 'b.ts' },
  { score: 0.8, filePath: 'c.ts' },
]);
check('弱证据 < 强证据', weakScore < strongScore, `weak=${weakScore} strong=${strongScore}`);
check('充分度恒 ≤ 1', computeSufficiency(
  Array.from({ length: 20 }, (_, i) => ({ score: 1, filePath: `f${i}.ts` }))
) <= 1);

console.log('\n--- A2. 条件边收敛性 ---');
const base = { sufficiency: 0, sufficiencyThreshold: 0.85, round: 0, maxRounds: 3 };
check('充分度达标 → generate',
  routeAfterGrade({ ...base, sufficiency: 0.9 } as any) === 'generate');
check('不足且有余轮 → retrieve',
  routeAfterGrade({ ...base, sufficiency: 0.1, round: 0, maxRounds: 3 } as any) === 'retrieve');
check('不足但轮次用尽 → generate（不死循环）',
  routeAfterGrade({ ...base, sufficiency: 0.1, round: 3, maxRounds: 3 } as any) === 'generate');
check('轮次超限也不回退 → generate',
  routeAfterGrade({ ...base, sufficiency: 0.1, round: 99, maxRounds: 3 } as any) === 'generate');

let converged = true;
for (let maxR = 1; maxR <= 6; maxR++) {
  let r = 0, guard = 0;
  let v = routeAfterGrade({ ...base, sufficiency: 0, round: r, maxRounds: maxR } as any);
  while (v === 'retrieve' && guard++ < 100) {
    r++;
    v = routeAfterGrade({ ...base, sufficiency: 0, round: r, maxRounds: maxR } as any);
  }
  if (v !== 'generate' || guard >= 100) converged = false;
}
check('最坏情况必然收敛（穷举 maxRounds 1..6）', converged);

console.log('\n--- A3. 策略计划 ---');
check('计划非空', SEARCH_STRATEGY_PLAN.length > 0, `${SEARCH_STRATEGY_PLAN.length} 档`);
check('策略名唯一',
  new Set(SEARCH_STRATEGY_PLAN.map(p => p.name)).size === SEARCH_STRATEGY_PLAN.length);
check('阈值逐轮放宽',
  SEARCH_STRATEGY_PLAN.every((p, i) =>
    i === 0 || (p.options.threshold ?? 0) <= (SEARCH_STRATEGY_PLAN[i - 1].options.threshold ?? 0)));

// ============================================================
// C. 循环行为端到端（桩件注入，无需数据库 / LLM）
// ============================================================
console.log('\n--- C. 循环行为端到端 ---');

const STRONG = [
  { score: 0.95, filePath: 'a.ts' },
  { score: 0.92, filePath: 'b.ts' },
  { score: 0.90, filePath: 'c.ts' },
];
const WEAK = [{ score: 0.2, filePath: 'a.ts' }];

/** 构造桩件检索器：第 n 次调用返回 plan(n) 指定的证据 */
function stubSearch(plan: (callIndex: number) => typeof STRONG) {
  let call = 0;
  return {
    search: async () => {
      const items = plan(call++);
      return items.map((it, i) => ({
        id: `stub:${i}`,
        type: 'chunk',
        score: it.score,
        filePath: it.filePath,
        lineStart: 1,
        lineEnd: 2,
        content: `// stub content for ${it.filePath}`,
        context: { fileName: it.filePath, symbolName: 'stubSymbol' },
        metadata: {},
      }));
    },
  } as any;
}

// 桩件 pool：仅用于满足签名，桩件检索器不会真的连库
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// C1. 首轮不足 → 第二轮充足：应当发生一次回边重检索
{
  let generateCalls = 0;
  const graph = await createCodeLensGraph({
    pool,
    search: stubSearch(i => (i === 0 ? WEAK : STRONG)),
    generateAnswer: async (_q, ev) => {
      generateCalls++;
      return `ANSWER_WITH_${ev.length}_EVIDENCE`;
    },
  });

  const r = await runGraphQuery(graph, { query: 'stub query', repoId: 1 });
  check('C1 发生回边重检索，共 2 轮', r.rounds === 2, `rounds=${r.rounds}`);
  check('C1 使用了 2 种不同策略', r.strategiesUsed.length === 2, r.strategiesUsed.join(' → '));
  check('C1 策略顺序符合逐轮升级',
    r.strategiesUsed[0] === SEARCH_STRATEGY_PLAN[0].name
    && r.strategiesUsed[1] === SEARCH_STRATEGY_PLAN[1].name);
  check('C1 证据被累积（1 弱 + 3 强 = 4 条）', r.evidence.length === 4, `n=${r.evidence.length}`);
  check('C1 生成器只被调用一次', generateCalls === 1, `calls=${generateCalls}`);
  check('C1 答案来自注入的生成器', r.answer === 'ANSWER_WITH_4_EVIDENCE', r.answer);
  check('C1 置信度由证据算出（>0）', r.confidence > 0, `conf=${r.confidence}`);
  check('C1 trace 含 retrieve/grade/generate 三段',
    r.trace.some(t => t.startsWith('[retrieve]'))
    && r.trace.some(t => t.startsWith('[grade]'))
    && r.trace.some(t => t.startsWith('[generate]')),
    `${r.trace.length} 条`);
  console.log('     trace:');
  r.trace.forEach(t => console.log('       ', t));
}

// C2. 首轮即充足：不应发生多余检索
{
  const graph = await createCodeLensGraph({
    pool,
    search: stubSearch(() => STRONG),
    generateAnswer: async (_q, ev) => `OK_${ev.length}`,
  });
  const r = await runGraphQuery(graph, { query: 'stub query', repoId: 1 });
  check('C2 首轮充足，仅 1 轮', r.rounds === 1, `rounds=${r.rounds}`);
  check('C2 只用了 1 种策略', r.strategiesUsed.length === 1, r.strategiesUsed.join(' → '));
}

// C3. 始终不足：必须收敛到 maxRounds 并仍产出答案
{
  const graph = await createCodeLensGraph({
    pool,
    search: stubSearch(() => WEAK),
    generateAnswer: async (_q, ev) => `DEGRADED_${ev.length}`,
  });
  const r = await runGraphQuery(graph, { query: 'stub query', repoId: 1 });
  // config.maxReasoningRounds 默认 5，但被策略计划长度封顶为 3
  const expected = Math.min(3, SEARCH_STRATEGY_PLAN.length);
  check(`C3 始终不足时收敛到 ${expected} 轮`, r.rounds === expected, `rounds=${r.rounds}`);
  check('C3 仍产出答案（降级而非失败）', r.answer === `DEGRADED_${expected}`, r.answer);
  check('C3 置信度偏低但仍计算', r.confidence >= 0 && r.confidence < 0.85, `conf=${r.confidence}`);
}

// C4. 完全没有证据：不应调用 LLM
{
  let generateCalls = 0;
  const graph = await createCodeLensGraph({
    pool,
    search: stubSearch(() => []),
    generateAnswer: async () => { generateCalls++; return 'SHOULD_NOT_HAPPEN'; },
  });
  const r = await runGraphQuery(graph, { query: 'stub query', repoId: 1 });
  check('C4 无证据时不调用 LLM', generateCalls === 0, `calls=${generateCalls}`);
  check('C4 返回明确的失败说明', r.answer.includes('无法基于证据回答'), r.answer.slice(0, 40) + '...');
  check('C4 置信度为 0', r.confidence === 0, `conf=${r.confidence}`);
}

// C5. 引用自检：答案里的「文件:行号」是否真在本轮证据中
// 桩件证据位于 a.ts，区间 [1,2]，因此 a.ts:2 应当对得上、src/ghost.ts:999 不应当。
{
  const graph = await createCodeLensGraph({
    pool,
    search: stubSearch(() => STRONG),
    // 头部引用真实证据，尾部捏造一条 —— 正是提示词要求「给出文件路径和行号」时的典型失败形态
    generateAnswer: async () => '见 a.ts:2 的实现；另见 src/ghost.ts:999 中的调度逻辑。',
  });
  const r = await runGraphQuery(graph, { query: 'stub query', repoId: 1 });

  check('C5 自检报告随结果返回', !!r.consistency, `verdict=${r.consistency?.verdict}`);
  check('C5 判定为 unsupported_refs', r.consistency.verdict === 'unsupported_refs', r.consistency.verdict);
  check('C5 只挑出对不上的那条引用', r.consistency.unsupported.length === 1
    && r.consistency.unsupported[0] === 'src/ghost.ts:999', JSON.stringify(r.consistency.unsupported));
  check('C5 对得上的引用未被误报', !r.consistency.unsupported.includes('a.ts:2'));
  check('C5 答案本身未被改写', r.answer === '见 a.ts:2 的实现；另见 src/ghost.ts:999 中的调度逻辑。');

  // 反向用例：引用全部落在证据区间内 → 不应告警
  const clean = await createCodeLensGraph({
    pool,
    search: stubSearch(() => STRONG),
    generateAnswer: async () => '见 a.ts:1 与 b.ts:2。',
  });
  const rc = await runGraphQuery(clean, { query: 'stub query', repoId: 1 });
  check('C5 引用全部对得上时判定 ok', rc.consistency.verdict === 'ok', rc.consistency.verdict);
}

// ============================================================
// B. 真实环境探测（仅信息，不计入失败）
// ============================================================
console.log('\n--- B. 真实依赖探测（信息性，不计入失败）---');
try {
  await pool.query('SELECT 1');
  const repos = await pool.query('SELECT id, name FROM repos ORDER BY id LIMIT 5');
  console.log(`     数据库可连接，repos=${repos.rowCount}`);
  repos.rows.forEach(r => console.log(`       ${r.id}: ${r.name}`));
  console.log('     → 可进一步执行真实端到端查询（POST /agent/v2/query）');
} catch (e: any) {
  console.log(`     数据库不可连接（${e?.code || e?.constructor?.name}）—— 端到端检索测试跳过`);
  console.log('     C 层已用桩件覆盖循环行为，因此不影响本次改造的验证结论');
} finally {
  await pool.end();
}

console.log(`\n==== ${failures === 0 ? 'ALL PASS' : failures + ' FAILED'} ====`);
process.exit(failures === 0 ? 0 : 1);
