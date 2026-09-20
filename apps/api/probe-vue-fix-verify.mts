/**
 * 验证 `.vue` 第二遍修复 —— 直接跑**真实适配器**，不跑模拟。
 *
 * ============================================================
 * 为什么必须单独写这个（而不是复用 probe-vue-entities.mts）
 * ============================================================
 * `probe-vue-entities.mts` 第 5 部分的「拟议改法」是我**手写的模拟**（自己在外面解包、
 * 自己拼行号）。模拟和真实现可能不一致 —— 尤其是行号回填、多块合并、import 去重这些
 * 只在真实现里才有的逻辑。所以修复后必须用 `createTypeScriptParser('vue')` 的
 * `analyzeEntities()` 本体再量一次，否则验证的是「我的假设」而不是「上线的那份代码」。
 *
 * 用法：
 *   ./node_modules/.bin/tsx probe-vue-fix-verify.mts
 *   （不需要隧道与密钥；语料来自 /tmp/vue-all.json）
 *
 * ⚠️ 放 `src/` 之外：`tsconfig.json` 的 include 是 `["src"]`，且本文件用顶层 await。
 */
import { readFileSync } from 'node:fs';
import { createTypeScriptParser } from './src/indexing/languages/typescript/index.js';

const ALL = JSON.parse(readFileSync('/tmp/vue-all.json', 'utf8')) as Array<{
  path: string;
  content: string;
}>;

const vue = createTypeScriptParser('vue');
const ts = createTypeScriptParser('typescript');

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}${detail ? ` —— ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
};

console.log('='.repeat(94));
console.log('真实适配器验证：createTypeScriptParser(\'vue\').analyzeEntities() × 166 个真实 .vue');
console.log('='.repeat(94));

const T = { fn: 0, arrow: 0, cls: 0, anon: 0, str: 0, url: 0, indirect: 0 };
let filesWithFn = 0;
let filesEmptyAll = 0;

// 行号完整性：函数声明行的源码文本里应当出现该函数名
let fnLineChecked = 0;
let fnLineBad = 0;
const badSamples: string[] = [];

// import 去重：同一文件内不应出现重复的 (path|symbol|type|alias)
let dupImportFiles = 0;

for (const f of ALL) {
  const r = await vue.analyzeEntities(f.path, f.content);
  const lines = f.content.split('\n');

  T.fn += r.functions.length;
  T.arrow += r.functions.filter((x) => x.functionType === 'arrow').length;
  T.cls += r.classes.length;
  T.anon += r.classes.filter((c) => c.name === 'anonymous').length;
  T.str += r.stringConstants.length;
  T.url += r.urlPatterns.length;
  T.indirect += r.indirectSites.length;

  if (r.functions.length > 0) filesWithFn++;
  if (
    r.functions.length === 0 &&
    r.classes.length === 0 &&
    r.stringConstants.length === 0
  ) {
    filesEmptyAll++;
  }

  // 行号完整性：抽到的函数，其 lineStart 那一行应该提到这个名字
  for (const fn of r.functions) {
    if (fn.functionType !== 'function' && fn.functionType !== 'arrow') continue;
    fnLineChecked++;
    const srcLine = lines[fn.lineStart - 1] ?? '';
    if (!srcLine.includes(fn.name)) {
      fnLineBad++;
      if (badSamples.length < 5) {
        badSamples.push(`${f.path.split('/').pop()} ${fn.name}@${fn.lineStart} → "${srcLine.trim().slice(0, 50)}"`);
      }
    }
  }

  // import 去重
  const keys = r.imports.map((i) => `${i.importPath}|${i.importedSymbol ?? ''}|${i.importType}|${i.alias ?? ''}`);
  if (new Set(keys).size !== keys.length) dupImportFiles++;
}

console.log(`\n  抽样文件数                        ${ALL.length}`);
console.log(`  functions 总数                    ${T.fn}`);
console.log(`    └ arrow 类型                    ${T.arrow}`);
console.log(`  classes 总数                      ${T.cls}`);
console.log(`    └ anonymous 垃圾                ${T.anon}`);
console.log(`  string_constants 总数             ${T.str}`);
console.log(`  url_patterns（内容派生）           ${T.url}`);
console.log(`  indirectSites                     ${T.indirect}（未 beginRepo ⇒ 预期 0）`);
console.log(`  有函数产出的文件数                 ${T.fn > 0 ? filesWithFn : 0} / ${ALL.length}`);
console.log(`  三层全空的文件数                   ${filesEmptyAll}`);

console.log('\n' + '-'.repeat(94));
console.log('断言');
console.log('-'.repeat(94));

check('functions 与离线预演一致（预期 590）', T.fn === 590, `实测 ${T.fn}`);
check('有函数产出的文件数与预演一致（预期 128）', filesWithFn === 128, `实测 ${filesWithFn}`);
check('anonymous 垃圾类清零（预期 0）', T.anon === 0, `实测 ${T.anon}`);
check('classes 与预演一致（预期 66）', T.cls === 66, `实测 ${T.cls}`);
check('string_constants 无回归（预期 1514）', T.str === 1514, `实测 ${T.str}`);
check('arrow 仍为 0（语料特性，不是 bug）', T.arrow === 0, `实测 ${T.arrow}`);
check(
  `函数行号完整性（${fnLineChecked} 个函数，lineStart 行应含函数名）`,
  fnLineBad === 0,
  fnLineBad === 0 ? '全部命中' : `${fnLineBad} 个不符：${badSamples.join(' ; ')}`
);
check('无重复 import 行', dupImportFiles === 0, `重复文件数 ${dupImportFiles}`);

// ---------------------------------------------------------------------------
// 回归：TS 路径行为不能被这次改动影响
// ---------------------------------------------------------------------------
console.log('\n' + '-'.repeat(94));
console.log('回归：TS 适配器（应完全不受影响）');
console.log('-'.repeat(94));

const tsSrc = [
  'import { readFileSync } from "node:fs";',
  'export function alpha(a: number): number { return a + 1 }',
  'export async function beta() { return 2 }',
  'class Gamma { delta() { return 3 } constructor() {} }',
  'const epsilon = () => 4',
].join('\n');

const tsResult = await ts.analyzeEntities('sample.ts', tsSrc);
const tsNames = tsResult.functions.map((f) => `${f.name}:${f.functionType}`).sort();
console.log(`  TS 抽样抽出：${tsNames.join(', ')}`);
// 预期 5 个：alpha(function) / beta(function) / epsilon(arrow) / delta(method) / 构造函数
// ⚠️ 构造函数的名字是 `anonymous` —— ts-morph 对 `ConstructorDeclaration.getName()` 返回
//    undefined，`extractFunctionInfo` 兜底成 'anonymous'。这是**改动前就有的既有行为**，
//    不是本次引入的，这里只做记录。`Gamma` 是 class 不是 function，不计入。
check(
  'TS：抽到 5 个（function×2 / arrow / method / constructor）',
  tsNames.length === 5,
  `实测 ${tsNames.length} 个：${tsNames.join(', ')}`
);
check(
  'TS：四类 functionType 齐全',
  new Set(tsResult.functions.map((f) => f.functionType)).size === 4,
  [...new Set(tsResult.functions.map((f) => f.functionType))].sort().join(',')
);
check('TS：行号未被平移（alpha 应在第 2 行）', tsResult.functions.find((f) => f.name === 'alpha')?.lineStart === 2,
  `实测 @${tsResult.functions.find((f) => f.name === 'alpha')?.lineStart}`);
check('TS：imports 未被平移（应在第 1 行）', tsResult.imports[0]?.line === 1, `实测 @${tsResult.imports[0]?.line}`);

// ---------------------------------------------------------------------------
// 关键回归：`.vue` 里「函数声明 + getReturnType 会崩」的场景应恢复且 returnType 可降级
// ---------------------------------------------------------------------------
console.log('\n' + '-'.repeat(94));
console.log('关键回归：原先会崩的 AlertFormView 现在应抽出 7 个函数、行号落在 <script> 内');
console.log('-'.repeat(94));

const target = ALL.find((f) => f.path.endsWith('AlertFormView.vue'));
if (!target) {
  check('找到 AlertFormView.vue 样本', false, '语料里没有');
} else {
  const r = await vue.analyzeEntities(target.path, target.content);
  const names = r.functions.map((f) => f.name).sort();
  const lines = target.content.split('\n');
  const scriptStart = lines.findIndex((l) => l.includes('<script')) + 1;
  console.log(`  <script> 起始行 = ${scriptStart}`);
  console.log(`  抽出 ${r.functions.length} 个函数：${names.join(', ')}`);
  console.log(`  行号范围 = ${Math.min(...r.functions.map((f) => f.lineStart))} ~ ${Math.max(...r.functions.map((f) => f.lineEnd))}`);
  console.log(`  returnType 缺失（降级为 undefined）的个数 = ${r.functions.filter((f) => !f.returnType).length}`);

  check('抽出 7 个函数', r.functions.length === 7, `实测 ${r.functions.length}`);
  check(
    '函数名与预演一致',
    names.join(',') === 'applySettings,doReset,loadSettings,onReset,onSubmit,setValue,validate',
    names.join(',')
  );
  check(
    '所有行号都落在 <script> 起始行之后（偏移回填正确）',
    Math.min(...r.functions.map((f) => f.lineStart)) >= scriptStart,
    `最小行号 ${Math.min(...r.functions.map((f) => f.lineStart))} vs script 起始 ${scriptStart}`
  );
  check('不再产生 anonymous 垃圾类', r.classes.filter((c) => c.name === 'anonymous').length === 0,
    `实测 ${r.classes.filter((c) => c.name === 'anonymous').length}`);
}

console.log('\n' + '='.repeat(94));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log('='.repeat(94));
if (fail > 0) process.exitCode = 1;
