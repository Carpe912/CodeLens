/**
 * `.vue` 第二遍（实体层）探针：**原文直喂** vs **解包 SFC**
 *
 * ============================================================
 * 要回答的问题
 * ============================================================
 * 线上实测发现：repo 29 的 166 个 .vue 里，
 *   - `functions` 只有 96 条、分布在 34 个文件；
 *   - 而且**全部 functionType == 'function'，'arrow' 是 0**；
 *   - 有 35 个文件「只有箭头函数写法」⇒ 一条 functions 都没有；
 *   - `classes` 198 条里 194 条叫 `anonymous`（模板被当 TS 解析）。
 *
 * 所以真正的问题是：**Vue 3 的 `<script setup>` + 箭头函数写法，第二遍到底抽没抽到？**
 * 以及「把 .vue 改成解包 SFC 再分析」能不能修好 —— 而不是像原注释说的「实体层为空」。
 *
 * ============================================================
 * 为什么必须本地跑
 * ============================================================
 * 这条链路纯 AST，不碰 DB、不碰 embedding ⇒ 可以在开发机上直接对**真实文件内容**做 A/B。
 * 样本是从线上库里 `COPY (SELECT content …)` 出来的真实 .vue 原文。
 *
 * 用法：
 *   ./node_modules/.bin/tsx probe-vue-entities.mts
 *   （不需要隧道，不需要任何密钥）
 *
 * ⚠️ 放在 `src/` 之外：`tsconfig.json` 的 include 是 `["src"]`，
 *    而本文件用了顶层 `await`，在 `target: ES2020` 下编译不过，放进 src/ 会搞坏构建。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseVue } from '@vue/compiler-sfc';
// ⚠️ 必须用 `ts.ScriptKind`：ts-morph 虽然 `export { ScriptKind }`，但 tsx/esbuild 会把
// 这个具名导入当作类型擦除掉 ⇒ 运行时 `ReferenceError: ScriptKind is not defined`。
import { Node, Project, SyntaxKind, ts } from 'ts-morph';
import { createTypeScriptParser } from './src/indexing/languages/typescript/index.js';
import type { EntityResult } from './src/indexing/languages/types.js';

const DIR = process.argv[2] || '/tmp/vue-samples';

const vueParser = createTypeScriptParser('vue');
const tsParser = createTypeScriptParser('typescript');

const summarize = (r: EntityResult) => ({
  fn: r.functions.length,
  arrow: r.functions.filter((f) => f.functionType === 'arrow').length,
  cls: r.classes.length,
  anon: r.classes.filter((c) => c.name === 'anonymous').length,
  str: r.stringConstants.length,
  url: r.urlPatterns.length,
});

const line = (s: ReturnType<typeof summarize>) =>
  `fn=${String(s.fn).padStart(3)} (arrow ${String(s.arrow).padStart(2)})  ` +
  `cls=${String(s.cls).padStart(3)} (anon ${String(s.anon).padStart(3)})  ` +
  `str=${String(s.str).padStart(4)}  url=${s.url}`;

const files = readdirSync(DIR).filter((f) => f.endsWith('.vue'));
if (files.length === 0) {
  console.log(`✗ ${DIR} 下没有 .vue 样本`);
  process.exit(1);
}

console.log('='.repeat(94));
console.log('对照：原文直喂（当前线上行为）  vs  解包 <script> 后再分析（拟议改法）');
console.log('='.repeat(94));

for (const name of files) {
  const code = readFileSync(join(DIR, name), 'utf8');

  // ---- 当前线上行为：整个 .vue 原文交给 vue 适配器 ----
  const raw = await vueParser.analyzeEntities(name, code);

  // ---- 拟议改法：解包 SFC，把 <script> 内容交给分析器 ----
  const { descriptor } = parseVue(code, { filename: name });
  const blocks = [descriptor.script, descriptor.scriptSetup].filter(Boolean) as Array<{
    content: string;
    loc: { start: { line: number } };
    lang?: string;
  }>;

  console.log(`\n── ${name}（${code.split('\n').length} 行）`);
  if (blocks.length === 0) {
    console.log('   ⚠️ 没有 <script> 块（纯模板组件）');
    continue;
  }
  blocks.forEach((b, i) =>
    console.log(`   script 块 #${i + 1}: lang=${b.lang ?? 'js'}  起始行=${b.loc.start.line}  内容 ${b.content.split('\n').length} 行`)
  );

  console.log(`   [现在] 原文直喂      ${line(summarize(raw))}`);

  // 解包后行号会退化成「相对 script 块」——这里把两个块都算上（等同多块合并的近似）
  // ⚠️ 这里必须给**中性扩展名**：第 4 部分已证明，`.vue` 扩展名本身就会让
  // `extractFunctionInfo → getReturnType()` 抛 TypeError 并被 `analyzeFile` 的 try/catch 吞掉。
  // 早先这行传的是 `name`（即 `X.vue`），于是「拟议改法」也被同一个 bug 命中、两侧都显示 0，
  // 把真正的收益盖住了 —— 这正是本探针要避免的「两侧都 0 ⇒ 平凡通过」。
  let unwrapped: EntityResult | null = null;
  for (const b of blocks) {
    const r = await tsParser.analyzeEntities('block.ts', b.content);
    if (!unwrapped) unwrapped = r;
    else {
      unwrapped.functions.push(...r.functions);
      unwrapped.classes.push(...r.classes);
      unwrapped.stringConstants.push(...r.stringConstants);
      unwrapped.urlPatterns.push(...r.urlPatterns);
    }
  }
  const u = unwrapped!;
  console.log(`   [拟议] 解包 script    ${line(summarize(u))}`);

  const rawNames = raw.functions.map((f) => f.name);
  const uNames = u.functions.map((f) => f.name);
  const gained = uNames.filter((n) => !rawNames.includes(n));
  const lost = rawNames.filter((n) => !uNames.includes(n));
  console.log(`   [拟议] 多抽到的函数：${gained.length ? gained.join(', ') : '(无)'}`);
  console.log(`   [拟议] 丢掉的函数：  ${lost.length ? lost.join(', ') : '(无)'}`);

  // 行号口径：解包后拿到的是「相对 script 块」的行号，必须加回 offset（= 起始行 - 1）
  const off = blocks[0].loc.start.line - 1;
  const first = (r: EntityResult) => r.functions[0];
  const fa = first(raw);
  const fu = first(u);
  if (fa && fu) {
    console.log(
      `   [行号] 现在 ${fa.name}@${fa.lineStart}（绝对行） | 解包 ${fu.name}@${fu.lineStart}` +
        ` ⇒ 若平移 +offset(${off}) = ${fu.lineStart + off}`
    );
  }
}
console.log('\n' + '='.repeat(94));

// ---------------------------------------------------------------------------
// 第 2 部分：Vue 3 常见写法的「抽取支持矩阵」
// ---------------------------------------------------------------------------
// 问题不是「.vue 整体为空」，而是「**哪些写法**抽得到」。这一节把写法逐个过一遍，
// 用的就是 .vue 第二遍同一个 TS 适配器。
console.log('\n' + '='.repeat(94));
console.log('写法支持矩阵（TS 适配器 —— 与 .vue 第二遍是同一套代码）');
console.log('='.repeat(94));

const SNIPPETS: Array<[string, string]> = [
  ['function 声明', 'function foo(a) { return a }'],
  ['export function', 'export function foo() { return 1 }'],
  ['async function', 'async function foo() { return 1 }'],
  ['箭头函数 const', 'const foo = () => { return 1 }'],
  ['箭头函数（单表达式）', 'const foo = () => 1'],
  ['函数表达式 const', 'const foo = function () { return 1 }'],
  ['setup 常见形态', 'const p = defineProps()\nconst onClick = () => { emit("x") }'],
  ['class + 方法', 'class Foo { bar() { return 1 } }'],
  ['无 body 的重载声明', 'declare function foo(a: string): void'],
];

for (const [label, src] of SNIPPETS) {
  const r = await tsParser.analyzeEntities('probe.ts', src);
  const kinds = r.functions.map((f) => f.functionType).join(',') || '-';
  console.log(`  ${label.padEnd(22)} fn=${r.functions.length} [${kinds}]  cls=${r.classes.length}`);
}

// ---------------------------------------------------------------------------
// 第 3 部分：定位那个被吞掉的 TypeError
// ---------------------------------------------------------------------------
// 第 1 部分里 AlertFormView 两侧都打印了
//   `TypeError: Cannot read properties of undefined (reading 'escapedName')`
// 来自 `extractFunctionInfo` → `getReturnType()`。这条异常被 `analyzeFile` 的
// **大 try/catch 吞掉**，而 result.functions 的赋值语句在抛错前未执行
// ⇒ **该文件所有函数一次性全丢**。这是「一个坏函数毁掉整个文件」的静默丢数据。
console.log('\n' + '='.repeat(94));
console.log('定位 getReturnType() 崩溃点（说明「0 个函数」是被异常吞掉，不是不支持）');
console.log('='.repeat(94));

const crashTarget = files.find((f) => f === 'AlertFormView.vue') ?? files[0];
{
  const code = readFileSync(join(DIR, crashTarget), 'utf8');
  const { descriptor } = parseVue(code, { filename: crashTarget });
  for (const [i, b] of [descriptor.script, descriptor.scriptSetup].filter(Boolean).entries()) {
    const proj = new Project({ useInMemoryFileSystem: true });
    const sf = proj.createSourceFile('block.ts', (b as { content: string }).content);
    const fns = sf.getFunctions();
    console.log(`\n${crashTarget} script 块 #${i + 1}：ts-morph 看到 ${fns.length} 个函数声明`);
    for (const fn of fns) {
      let verdict = 'ok';
      try {
        fn.getReturnType();
      } catch (e) {
        verdict = `CRASH: ${(e as Error).message.slice(0, 60)}`;
      }
      console.log(`   ${verdict === 'ok' ? '  ✓' : '  ✗'} ${fn.getName()}()  @${fn.getStartLineNumber()}  ${verdict}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 第 4 部分：隔离变量 —— 崩的是「.vue 内容」还是「.vue 扩展名」？
// ---------------------------------------------------------------------------
// 第 3 部分用 `.ts` 文件名 + 解包后的干净内容 ⇒ 7 个函数全 ok、getReturnType() 不崩。
// 但第 1 部分「解包后」仍然崩。两者差在 **filePath 的扩展名**。
// 这里做 2×2：内容（原文 / 解包）× 文件名（.vue / .ts），看谁才是触发器。
console.log('\n' + '='.repeat(94));
console.log('变量隔离：内容 × 文件扩展名（同一个文件、同一套适配器）');
console.log('='.repeat(94));

{
  const code = readFileSync(join(DIR, crashTarget), 'utf8');
  const { descriptor } = parseVue(code, { filename: crashTarget });
  const scriptText = [descriptor.script, descriptor.scriptSetup]
    .filter(Boolean)
    .map((b) => (b as { content: string }).content)
    .join('\n');

  const combos: Array<[string, string, string]> = [
    ['原文 + .vue 名（当前线上）', code, crashTarget],
    ['原文 + .ts  名', code, 'X.ts'],
    ['解包 + .vue 名', scriptText, crashTarget],
    ['解包 + .ts  名（拟议改法）', scriptText, 'X.ts'],
  ];

  for (const [label, text, fpath] of combos) {
    const r = await tsParser.analyzeEntities(fpath, text);
    const looksEmpty = r.functions.length === 0 && /function |=>/.test(text);
    console.log(
      `  ${label.padEnd(26)} fn=${String(r.functions.length).padStart(2)}` +
        `  cls=${String(r.classes.length).padStart(3)}（anon ${String(r.classes.filter((c) => c.name === 'anonymous').length).padStart(3)}）` +
        `  str=${String(r.stringConstants.length).padStart(3)}` +
        (looksEmpty ? '   ← 源码明明有函数却抽到 0 ⇒ 异常被吞' : '')
    );
  }
}

// ---------------------------------------------------------------------------
// 第 5 部分：全量预演 —— 166 个 .vue 上，拟议改法能找回多少
// ---------------------------------------------------------------------------
// 离线跑（内容已从线上 COPY 出来），**不碰 DB、不重建索引** —— 先算出预期收益再决定值不值得动。
const ALL = JSON.parse(readFileSync('/tmp/vue-all.json', 'utf8')) as Array<{
  path: string;
  content: string;
}>;

if (ALL.length > 0) {
  console.log('\n' + '='.repeat(94));
  console.log(`全量预演：${ALL.length} 个 .vue —— 现在 vs 拟议改法（解包 SFC + 不传 .vue 扩展名）`);
  console.log('='.repeat(94));

  const T = {
    cur: { fn: 0, arrow: 0, cls: 0, anon: 0, str: 0, url: 0 },
    prop: { fn: 0, arrow: 0, cls: 0, anon: 0, str: 0, url: 0 },
  };
  let fnCur = 0;
  let fnProp = 0;
  const recovered: string[] = [];

  for (const f of ALL) {
    const s1 = summarize(await vueParser.analyzeEntities(f.path, f.content));

    const { descriptor } = parseVue(f.content, { filename: f.path });
    const blocks = [descriptor.script, descriptor.scriptSetup].filter(Boolean) as Array<{
      content: string;
      loc: { start: { line: number } };
    }>;
    const merged = {
      stringConstants: [],
      urlPatterns: [],
      functions: [],
      classes: [],
      imports: [],
      indirectSites: [],
    } as unknown as EntityResult;
    for (const b of blocks) {
      const r = await tsParser.analyzeEntities('X.ts', b.content);
      const off = b.loc.start.line - 1;
      for (const fn of r.functions) {
        fn.lineStart += off;
        fn.lineEnd += off;
      }
      merged.functions.push(...r.functions);
      merged.classes.push(...r.classes);
      merged.stringConstants.push(...r.stringConstants);
      merged.urlPatterns.push(...r.urlPatterns);
    }
    const s2 = summarize(merged);

    T.cur.fn += s1.fn; T.cur.arrow += s1.arrow; T.cur.cls += s1.cls; T.cur.anon += s1.anon;
    T.cur.str += s1.str; T.cur.url += s1.url;
    T.prop.fn += s2.fn; T.prop.arrow += s2.arrow; T.prop.cls += s2.cls; T.prop.anon += s2.anon;
    T.prop.str += s2.str; T.prop.url += s2.url;
    if (s1.fn > 0) fnCur++;
    if (s2.fn > 0) fnProp++;
    if (s1.fn === 0 && s2.fn > 0) recovered.push(`${f.path} (+${s2.fn})`);
  }

  const row = (label: string, a: number, b: number) =>
    `  ${label.padEnd(34)} ${String(a).padStart(5)}  →  ${String(b).padStart(5)}`;

  console.log(row('functions 总数', T.cur.fn, T.prop.fn));
  console.log(row('  └ 其中 arrow 类型', T.cur.arrow, T.prop.arrow));
  console.log(row('classes 总数', T.cur.cls, T.prop.cls));
  console.log(row('  └ 其中 anonymous 垃圾', T.cur.anon, T.prop.anon));
  console.log(row('string_constants 总数', T.cur.str, T.prop.str));
  console.log(row('url_patterns（内容派生）', T.cur.url, T.prop.url));
  console.log(row('有函数产出的文件数', fnCur, fnProp));
  console.log(
    `\n  「现在 0 个函数、改后能抽到」的文件：${recovered.length} 个` +
      (recovered.length ? `\n    例：${recovered.slice(0, 6).join('  |  ')}` : '')
  );
}

// ---------------------------------------------------------------------------
// 第 7 部分：为什么「arrow 类型」改前改后都是 0？（防止把推理当结论）
// ---------------------------------------------------------------------------
// 曾据此推断「文件在记录到 arrow 之前就崩了」。但第 5 部分显示**改后 arrow 仍是 0**，
// 说明该推断是错的。arrow 的提取路径（entities.ts:898-919）**根本不调用 getReturnType**，
// 不会被这个崩溃波及，所以 arrow=0 只能是语料原因。
//
// ⚠️ 这里**不能用正则**判「有没有顶层箭头函数」：`const x = computed(() => ...)` 会被
// `/const\s+\w+\s*=\s*\(?[^)\n]*\)?\s*=>/` 误判成箭头函数初始化（`[^)\n]*` 会吞掉左括号）。
// 初版正则因此报出「141/166 个文件有顶层箭头」，与实测 arrow=0 直接矛盾。**改用 AST**：
// 直接数 `VariableDeclaration` 里 `Node.isArrowFunction(initializer)` —— 与提取器同一判据。
// ---------------------------------------------------------------------------
// 第 6 部分：修法设计 —— 能不能**保留真实 .vue 路径**、只把扩展名问题解决掉？
// ---------------------------------------------------------------------------
// 第 4 部分证明 `.vue` 扩展名是触发条件。但 `analyzeFile()` 的 `filePath` 不只是个名字：
//   - `indirectSites: this.indirectByFile.get(filePath)` ← **按真实路径查表**，换名 ⇒ 恒空
//   - `extractURLPatterns(..., filePath)` / `buildProviderPatterns(filePath)` ← 也吃路径
// 所以「传一个假名（X.ts）」虽然能绕开崩溃，却会**静默丢掉**间接调用点与路径提供点。
// ⇒ 更稳的修法是：保留真实 `filePath`，只在建 SourceFile 时**显式指定 ScriptKind.TS**。
// 这里直接验证该假设成不成立（成不成立都要有结论，不能猜）。
console.log('\n' + '='.repeat(94));
console.log('修法设计：在 `.vue` 路径下显式指定 ScriptKind.TS，能否消除 getReturnType() 崩溃？');
console.log('='.repeat(94));

{
  const code = readFileSync(join(DIR, crashTarget), 'utf8');
  const { descriptor } = parseVue(code, { filename: crashTarget });
  const scriptText = [descriptor.script, descriptor.scriptSetup]
    .filter(Boolean)
    .map((b) => (b as { content: string }).content)
    .join('\n');

  const trials: Array<[string, string, number | undefined]> = [
    ['解包 .vue 名，不指定 scriptKind', scriptText, undefined],
    ['解包 .vue 名，scriptKind=TS', scriptText, ts.ScriptKind.TS],
    ['解包 .vue 名，scriptKind=TSX', scriptText, ts.ScriptKind.TSX],
    ['解包 .ts  名，不指定（对照）', scriptText, undefined],
  ];

  for (const [label, text, kind] of trials) {
    // 直接建 ts-morph Project，复现 analyzeFile 里建 SourceFile 的方式
    const proj = new Project({ useInMemoryFileSystem: true });
    const virtualName = label.includes('.ts ') ? 'X.ts' : 'X.vue';
    let verdict = '';
    let fns = 0;
    try {
      const sf = proj.createSourceFile(
        virtualName,
        text,
        kind === undefined ? { overwrite: true } : { overwrite: true, scriptKind: kind }
      );
      const decls = sf.getFunctions();
      fns = decls.length;
      let crashed = 0;
      for (const fn of decls) {
        try {
          fn.getReturnType().getText();
        } catch {
          crashed++;
        }
      }
      verdict = crashed === 0 ? '✓ 全部 getReturnType() 正常' : `✗ 仍有 ${crashed}/${fns} 个崩溃`;
    } catch (e) {
      verdict = `✗ 建文件就抛错：${(e as Error).message.slice(0, 50)}`;
    }
    console.log(`  ${label.padEnd(34)} 函数声明=${String(fns).padStart(2)}  ${verdict}`);
  }
}
console.log('\n' + '='.repeat(94));
console.log('为什么 arrow 类型恒为 0 —— 用 AST 数「真正的箭头函数初始化」');
console.log('='.repeat(94));

if (ALL.length > 0) {
  const proj = new Project({ useInMemoryFileSystem: true });
  const kindTally: Record<string, number> = {};
  const initiatorTally: Record<string, number> = {};
  let filesProducingArrow = 0;
  let filesWithRealArrowDecl = 0;
  let realArrowDecls = 0;
  let allVarDecls = 0;

  for (const f of ALL) {
    const { descriptor } = parseVue(f.content, { filename: f.path }) as {
      descriptor: { script?: { content: string } | null; scriptSetup?: { content: string } | null };
    };
    let sawArrowFn = false;
    let sawRealArrowDecl = false;

    for (const b of [descriptor.script, descriptor.scriptSetup].filter(Boolean)) {
      const src = (b as { content: string }).content;

      // (a) 提取器实际抽出了什么
      const r = await tsParser.analyzeEntities('X.ts', src);
      for (const fn of r.functions) {
        kindTally[fn.functionType] = (kindTally[fn.functionType] ?? 0) + 1;
        if (fn.functionType === 'arrow') sawArrowFn = true;
      }

      // (b) AST 口径：源码里到底有几个「初始化器就是箭头函数」的变量声明
      const sf = proj.createSourceFile(`probe_${Math.random().toString(36).slice(2)}.ts`, src, {
        overwrite: true,
      });
      for (const vd of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        allVarDecls++;
        const init = vd.getInitializer();
        const kind = init ? init.getKindName() : 'none';
        initiatorTally[kind] = (initiatorTally[kind] ?? 0) + 1;
        if (init && Node.isArrowFunction(init)) {
          realArrowDecls++;
          sawRealArrowDecl = true;
        }
      }
      sf.forget();
    }
    if (sawArrowFn) filesProducingArrow++;
    if (sawRealArrowDecl) filesWithRealArrowDecl++;
  }

  console.log('  解包后**实际抽出**的 functionType 分布：');
  for (const [k, v] of Object.entries(kindTally).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${k.padEnd(12)} ${String(v).padStart(4)}`);
  }
  console.log(`  ⇒ 抽出 arrow 的文件数：                     ${filesProducingArrow}`);
  console.log(`\n  AST 口径（与提取器同一判据 Node.isArrowFunction）：`);
  console.log(`     变量声明总数：                           ${allVarDecls}`);
  console.log(`     初始化器就是箭头函数的声明数：             ${realArrowDecls}`);
  console.log(`     含此类声明的文件数：                      ${filesWithRealArrowDecl} / ${ALL.length}`);
  console.log('     初始化器类型 top5（说明那些 `const x = …` 到底是什么）：');
  for (const [k, v] of Object.entries(initiatorTally).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`       ${k.padEnd(22)} ${String(v).padStart(4)}`);
  }
  console.log(
    '\n  ⇒ 结论：arrow=0 **不是崩溃造成的**（arrow 不走 getReturnType），' +
      '\n     而是语料里 `const x = …` 的右边绝大多数是 **CallExpression**（computed / watch / ref /' +
      '\n     useXxx 等），箭头函数只是**实参**、不是初始化器本身 ⇒ 提取器正确地没有把它们当函数。'
  );
}
console.log('\n' + '='.repeat(94));
