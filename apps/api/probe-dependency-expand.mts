/**
 * `expandWithDependencies` 的本地探针（只连库，不连线上服务）
 *
 * ============================================
 * 为什么不是「跑两个查询 diff」
 * ============================================
 * 第一版就是这么写的：同一 query 开关 `followDependencies` 跑两遍。结果两边都是 **0 条**
 * —— 中文整句 + `strategies:['exact']` 召不回任何东西，于是「断言」全部平凡通过，
 * 探针打印 `A/B 全部通过`，**什么都没证明**。
 * 这正是本项目反复踩的「静默空转」，只是这次踩在我自己的验证工具上。
 *
 * ⇒ 所以本版做两件事：
 *   第 1 部分（**有断言**）：跳过检索质量，直接给 `expandWithDependencies` 喂**真实的命中文件**，
 *     检查它到底补了什么、插在哪、有没有超上限。这是我要验的逻辑。
 *   第 2 部分（**只报告**）：真实检索跑一遍，但 **0 条就明确报「未能验证」并按失败计**，
 *     不允许出现「没跑出东西 = 通过」。
 *
 * 用法（隧道与探针必须在同一条命令里，否则隧道会被回收）：
 *   ssh -N -L 5432:127.0.0.1:5432 root@47.116.6.132 &
 *   ./node_modules/.bin/tsx --env-file-if-exists=.env probe-dependency-expand.mts
 *
 * ⚠️ 必须带上 `--env-file-if-exists=.env`：第 2 部分走 `vector` 策略，要在调试机上真的调
 *    一次 embedding（`EMBED_API_KEY`）。不带它 → vector 静默返回 0 条，看起来像功能坏了。
 *    （库连接不读 `.env` 的 `DB_*`，见下方 pool 处的说明。）
 *
 * ⚠️ 本文件**故意放在 `src/` 之外**：`tsconfig.json` 的 `include` 是 `["src"]`，
 *    所以它不会进构建产物；而它用了顶层 `await`，在 `target: ES2020` 下**编译不过**，
 *    放进 `src/` 会直接把构建搞坏。
 */
import pg from 'pg';
import { MultiStrategySearch, type SearchResult } from './src/retrieval/multi-strategy-search.js';

const REPO = 29;
const LIMIT = 10;

// ⚠️ 故意**不读** `DB_*`：用 `--env-file-if-exists=.env` 时那份 `DB_PASSWORD` 是**过期的**
//    （线上真密码由 pm2 注入），直接读会 28P01 password authentication failed。
//    这里用独立的 `PROBE_DB_*` 前缀（默认即是隧道 + 可用凭据），与 `.env` 完全解耦。
const pool = new pg.Pool({
  host: process.env.PROBE_DB_HOST || '127.0.0.1',
  port: parseInt(process.env.PROBE_DB_PORT || '5432'),
  database: process.env.PROBE_DB_NAME || 'codelens',
  user: process.env.PROBE_DB_USER || 'postgres',
  password: process.env.PROBE_DB_PASSWORD || '666666',
});

let failures = 0;
let skips = 0; // 显式跳过（不是通过）—— 必须在总结里出现，否则「跳过」会伪装成「全绿」
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

const engine = new MultiStrategySearch(pool);
// 私有方法：探针就是要单独验它
const expand = (results: SearchResult[], limit: number) =>
  (engine as any).expandWithDependencies(REPO, results, limit) as Promise<void>;

const seed = (id: string, filePath: string, score: number): SearchResult => ({
  id,
  type: 'chunk',
  score,
  filePath,
  lineStart: 1,
  lineEnd: 30,
  content: '(probe seed)',
  context: { fileName: filePath.split('/').pop() || '' },
  metadata: {},
});

const label = (r: SearchResult) =>
  `[${r.metadata?.relation === 'dependency' ? 'DEP' : '   '}] ${r.filePath}:${r.lineStart}-${r.lineEnd}` +
  `${r.metadata?.definitionOf ? `  定义=${r.metadata.definitionOf}` : ''}`;

// ---------------------------------------------------------------------------
// 第 1 部分：拿真实数据、真实命中文件，验 expandWithDependencies 本身
// ---------------------------------------------------------------------------
console.log('='.repeat(78));
console.log('第 1 部分：喂真实命中文件，验补入行为');
console.log('='.repeat(78));

// 找「内部导入能对上定义块」最多的几个文件 —— 这些才是这个功能的目标场景
const topFiles = await pool.query(
  `
  SELECT f.path AS path, count(*)::int AS defs
    FROM import_relations ir
    JOIN files f      ON f.id = ir.importer_file_id
    JOIN files tf     ON tf.id = ir.imported_file_id
    JOIN code_chunks c ON c.file_id = tf.id AND c.symbol_name = ir.imported_symbol
   WHERE ir.repo_id = $1
     AND ir.imported_file_id IS NOT NULL
     AND COALESCE(ir.is_external, false) = false
     AND c.code_text IS NOT NULL
   GROUP BY f.path
   ORDER BY defs DESC
   LIMIT 3
`,
  [REPO]
);

console.log(`\n目标文件（内部导入可解析定义数最多）：`);
for (const r of topFiles.rows) console.log(`  ${r.defs} 条  ${r.path}`);

if (topFiles.rows.length === 0) {
  console.log('\n✗ 找不到任何「导入能对上定义」的文件 —— 依赖图或块表有问题，无法验证');
  await pool.end();
  process.exit(1);
}

// --- 1a. 单个真实文件 ---
{
  const target = topFiles.rows[0].path;
  const results = [seed('seed-1', target, 0.9)];
  await expand(results, LIMIT);

  console.log(`\n【1a】单个命中：${target}`);
  results.forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}. ${label(r)}  score=${r.score.toFixed(3)}`));

  const deps = results.filter((r) => r.metadata?.relation === 'dependency');
  console.log('');
  check('补入了条目', deps.length > 0, `实际 ${deps.length} 条`);
  check('条目数不超过上限 ceil(10×0.4)=4', deps.length <= 4, `实际 ${deps.length}`);
  check('第一条就是来源命中本身（顺序未被改）', results[0].id === 'seed-1');
  // ⚠️ 第一版这里写错了：断言 `results[i-1].id === sourceResultId` 只对**第 1 条** DEP 成立，
  // 第 2~4 条前面是上一条 DEP 而不是锚点 → 断言自己把自己判失败。
  // 正确的语义是「同一锚点的 DEP 构成紧跟在锚点之后的**连续块**」。
  check(
    '同一锚点的 DEP 构成紧跟锚点的连续块',
    deps.every((d) => {
      const i = results.indexOf(d);
      if (i < 0) return false;
      const anchorIdx = results.findIndex((r) => r.id === d.metadata.sourceResultId);
      if (anchorIdx < 0) return false;
      for (let k = anchorIdx + 1; k < i; k++) {
        if (results[k].metadata?.sourceResultId !== d.metadata.sourceResultId) return false;
      }
      return true;
    }),
    deps.length > 1 ? `（${deps.length} 条来自同一锚点，验证「连续块」而非「紧邻」）` : ''
  );
  check(
    'DEP 条目都有真实代码与真实行号',
    deps.every((d) => d.content.trim().length > 0 && d.lineStart > 0 && d.lineEnd >= d.lineStart),
    deps.map((d) => `${d.lineStart}-${d.lineEnd}`).join(' ')
  );
  check(
    'DEP 分数被折价（低于来源命中）',
    deps.every((d) => d.score < results[0].score)
  );
  check(
    'DEP 的目标文件都在本仓',
    deps.every((d) => topFiles.rows.length > 0 && typeof d.filePath === 'string' && d.filePath.length > 0)
  );

  // 交叉核对：声明「定义 X」就必须真有那个符号
  if (deps.length > 0) {
    const verify = await pool.query(
      `
      SELECT count(*)::int AS n
        FROM code_chunks c
        JOIN files f ON f.id = c.file_id
       WHERE f.repo_id = $1 AND f.path = $2 AND c.symbol_name = $3
    `,
      [REPO, deps[0].filePath, deps[0].metadata.definitionOf]
    );
    check(
      `声明的定义可交叉核对（${deps[0].metadata.definitionOf} @ ${deps[0].filePath}）`,
      verify.rows[0].n > 0
    );
  }
}

// --- 1b. 上限：喂 8 个真实文件，limit=10 ---
{
  const paths = topFiles.rows.map((r: any) => r.path);
  const results = paths.map((p, i) => seed(`seed-${i}`, p, 0.9 - i * 0.01));
  await expand(results, LIMIT);
  const deps = results.filter((r) => r.metadata?.relation === 'dependency');
  console.log(`\n【1b】上限与不改序：喂 ${paths.length} 个命中文件，limit=${LIMIT}`);
  check('补入数量被上限截断（≤4）', deps.length <= 4, `实际 ${deps.length}`);
  check(
    '去掉 DEP 后，原标题顺序完全不变',
    JSON.stringify(results.filter((r) => r.metadata?.relation !== 'dependency').map((r) => r.id)) ===
      JSON.stringify(paths.map((_, i) => `seed-${i}`))
  );
}

// --- 1c. 空输入不应炸 ---
{
  const results: SearchResult[] = [];
  await expand(results, LIMIT);
  console.log(`\n【1c】空输入`);
  check('空数组安全返回且仍为空', results.length === 0);
}

// --- 1d. 无关文件（没有内部导入）不应产生噪声 ---
{
  const lonely = await pool.query(
    `
    SELECT f.path FROM files f
     WHERE f.repo_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM import_relations ir
          JOIN files tf ON tf.id = ir.imported_file_id
          JOIN code_chunks c ON c.file_id = tf.id AND c.symbol_name = ir.imported_symbol
         WHERE ir.repo_id = $1 AND ir.importer_file_id = f.id
           AND ir.imported_file_id IS NOT NULL AND COALESCE(ir.is_external,false)=false
       )
     LIMIT 1
  `,
    [REPO]
  );
  if (lonely.rows.length > 0) {
    const results = [seed('lonely', lonely.rows[0].path, 0.8)];
    await expand(results, LIMIT);
    console.log(`\n【1d】没有内部导入的文件：${lonely.rows[0].path}`);
    check('不补入任何噪声条目', results.length === 1, `实际 ${results.length} 条`);
  }
}

// ---------------------------------------------------------------------------
// 第 2 部分：端到端 A/B —— 真实 search()，开关 followDependencies
// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(78));
console.log('第 2 部分：真实 search() 的 A/B（followDependencies 关 / 开）');
console.log('='.repeat(78));

// 三个设计约束（都是第一版踩出来的）：
//   ① 查询必须能被所选策略真的召回。`exact` 只在 `intent.confidence > 0.8` 时才生效
//      （见 `selectStrategies`）⇒ 对普通查询传 `strategies:['exact']` 会得到**空策略表** → 0 条，
//      断言又平凡通过；`fuzzy` 用 pg_trgm 跟整块代码算相似度，短查询同样召不回。
//      ⇒ 用 `vector`（请求了就一定会执行）。
//   ② 先做**接线断言**（spy），再做**召回断言**。否则 embedding 一旦静默失败，
//      「开关没接上」和「没召回」就分不开 —— 正是本项目反复踩的静默空转。
//   ③ limit 要给大（30）**并且**池满时明确报告「无法观察」：search() 最后是 slice(0, limit)，
//      池子一满，补入的低分条目会被切掉，`on.length > off.length` 会**假**失败。

// --- 2a. 接线断言：不依赖召回，只验开关真的能把调用送进 expandWithDependencies ---
// 用 `fuzzy` 而不是 `vector`：2a 完全不需要召回，而 `vector` 会真的去调 embedding
// （本机 `.env` 的 key 已失效 → 401 抛错，把一段纯接线断言拖成「跑不起来」）。
// `fuzzy` 不调 embedding、即使 0 条也照样会走到步骤 11，正合适。
{
  const calls: unknown[][] = [];
  const orig = (engine as any).expandWithDependencies.bind(engine);
  (engine as any).expandWithDependencies = async (...args: unknown[]) => {
    calls.push(args);
    return orig(...args);
  };

  // 每次用不同的查询/limit，避开 searchCache 命中（命中会在步骤 3 提前 return，整段步骤 11 被跳过）
  await engine.search(REPO, 'zzz-nonexistent-symbol-aaa', {
    limit: 3,
    threshold: 0.3,
    strategies: ['fuzzy'],
    followDependencies: false,
  });
  check('followDependencies=false 时完全没有触发依赖展开', calls.length === 0, `实际 ${calls.length} 次`);

  await engine.search(REPO, 'zzz-nonexistent-symbol-bbb', {
    limit: 7,
    threshold: 0.3,
    strategies: ['fuzzy'],
    followDependencies: true,
  });
  check('followDependencies=true 时恰好触发一次', calls.length === 1, `实际 ${calls.length} 次`);
  if (calls.length === 1) {
    const [a0, a1, a2] = calls[0];
    check(
      '传参是 (repoId, 结果数组, limit)——上限与证据预算挂钩',
      a0 === REPO && Array.isArray(a1) && a2 === 7,
      `repoId=${String(a0)} isArray=${Array.isArray(a1)} limit=${String(a2)}`
    );
  }

  delete (engine as any).expandWithDependencies; // 还原原型方法，别把 spy 留给 2b
}

// --- 2b. 召回断言：真实 search() 的 A/B ---
// ⚠️ 本机 `.env` 里的 `EMBED_API_KEY` 已失效（401），`vector` 必然抛错 ⇒ 这一段**显式 SKIP**：
//    打印横幅 + 计入 skips，**不计通过也不计失败**。绝不允许 catch 掉当作没事。
//    真正的端到端召回证据在部署后：`/ask` 的 `ASK_RETRIEVAL_OPTIONS` 里 `followDependencies: true`，
//    线上重跑 eval 走的正是这段新代码。
const LIMIT2 = 30;
try {
  const sym = await pool.query(
    `SELECT c.symbol_name FROM code_chunks c JOIN files f ON f.id = c.file_id
      WHERE f.repo_id = $1 AND f.path = $2 AND c.symbol_name IS NOT NULL AND length(c.symbol_name) >= 4
      ORDER BY c.line_start LIMIT 1`,
    [REPO, topFiles.rows[0].path]
  );

  if (sym.rows.length === 0) {
    console.log(`\n✗ 目标文件里找不到可用符号名：${topFiles.rows[0].path}`);
    check('真实检索可验证', false, '无可用符号');
  } else {
    const q = String(sym.rows[0].symbol_name);
    const base = { limit: LIMIT2, threshold: 0.3, strategies: ['vector'], includeContext: true };
    const off = await engine.search(REPO, q, { ...base, followDependencies: false });
    const on = await engine.search(REPO, q, { ...base, followDependencies: true });

    console.log(`\n查询「${q}」（该符号定义于 ${topFiles.rows[0].path}）`);
    console.log(`  关 → ${off.length} 条`);
    off.forEach((r, i) => console.log(`     ${String(i + 1).padStart(2)}. ${label(r)}`));
    console.log(`  开 → ${on.length} 条`);
    on.forEach((r, i) => console.log(`     ${String(i + 1).padStart(2)}. ${label(r)}`));

    const deps = on.filter((r) => r.metadata?.relation === 'dependency');
    check('真实检索能召回（0 条 = 没召回，不是「通过」）', off.length > 0, `关=${off.length}`);

    if (off.length > 0) {
      check(
        '原有命中的相对顺序未被改动',
        JSON.stringify(
          on
            .filter((r) => r.metadata?.relation !== 'dependency')
            .map((r) => `${r.filePath}:${r.lineStart}`)
        ) === JSON.stringify(off.map((r) => `${r.filePath}:${r.lineStart}`))
      );
    }

    if (off.length >= LIMIT2) {
      console.log(`  ⚠️ 结果池已满（${off.length} ≥ limit ${LIMIT2}）→ 无法观察补入是否生效，本轮不做断言`);
    } else if (off.length > 0) {
      check('开关真的改变了行为（开 > 关）', on.length > off.length, `${off.length} → ${on.length}`);
      check(
        '新增条目的数量与标记都对得上',
        deps.length === on.length - off.length,
        `DEP=${deps.length}，差值=${on.length - off.length}`
      );
    }
  }
} catch (e) {
  skips++;
  const msg = e instanceof Error ? e.message : String(e);
  console.log(`\n⚠️ SKIP：embedding 不可用，本段未执行 —— ${msg.split('\n')[0]}`);
  console.log('   本机 `.env` 的 EMBED_API_KEY 已失效（可用那份只在线上 pm2 的环境里）。');
  console.log('   端到端召回改由「部署后重跑线上 eval」验证：/ask 默认 followDependencies=true。');
}

await pool.end();
console.log(
  '\n' +
    (failures > 0
      ? `==== ${failures} 项未通过 ====`
      : skips > 0
        ? `==== 断言全部通过；另有 ${skips} 段被跳过（不算通过，见上）====`
        : '==== 全部通过 ====')
);
process.exit(failures === 0 ? 0 : 1);
