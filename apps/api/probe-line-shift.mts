/**
 * 实测「改动 vs 行号」的关系 —— 用**项目真实的解析器**，不用嘴说。
 *
 * 回答的问题：
 *   「你说'改动只在已有符号内部'时行号不变 —— 可是只要改动，行号不是一定会变吗？」
 *
 * 用同一个文件的 6 个变体跑两遍解析（第一遍 chunker / 第二遍实体层），
 * 逐条打印 函数名@行号，并与基准做差。
 *
 * 用法：
 *   cd apps/api && ./node_modules/.bin/tsx probe-line-shift.mts
 *
 * ⚠️ 放 `src/` 之外：tsconfig 的 include 是 ["src"]，本文件用顶层 await。
 */
import { createTypeScriptParser } from './src/indexing/languages/typescript/index.js';
import { parseTsFile } from './src/indexing/languages/typescript/chunker.js';

const BASE = [
  `import { api } from './api';`, // 1
  ``, // 2
  `function go(page: number) {`, // 3
  `  const clamped = Math.max(1, page);`, // 4
  `  return clamped;`, // 5
  `}`, // 6
  ``, // 7
  `function onSizeChange(size: number) {`, // 8
  `  return size * 2;`, // 9
  `}`, // 10
  ``, // 11
  `function reset() {`, // 12
  `  return go(1);`, // 13
  `}`, // 14
];

const v = {
  A: BASE,
  // B：改第 4 行的内容，**总行数不变**
  B: BASE.map((l, i) => (i === 3 ? `  const clamped = Math.min(99, Math.max(1, page));` : l)),
  // C：在 go 的**函数体内**插入一行，总行数 14 → 15
  C: [...BASE.slice(0, 5), `  console.log(clamped);`, ...BASE.slice(5)],
  // D：把 onSizeChange 改名，**总行数不变**
  D: BASE.map((l) => l.replace('onSizeChange', 'onSizeUpdate')),
  // E：在**文件最末尾**追加一行注释，总行数 14 → 15
  E: [...BASE, `// trailing comment`],
  // F：改第 1 行的 import 目标，**总行数不变**
  F: BASE.map((l, i) => (i === 0 ? `import { api } from './server/api';` : l)),
};

const parser = createTypeScriptParser('typescript');

type Snap = { fns: string[]; chunks: string[]; imports: string[]; lines: number };

async function snap(code: string): Promise<Snap> {
  const text = code.join('\n') + '\n';
  const ent = await parser.analyzeEntities('sample.ts', text);
  const ch = parseTsFile('sample.ts', text);
  return {
    fns: ent.functions
      .filter((f) => f.name && !f.name.startsWith('anonymous'))
      .map((f) => `${f.name}@${f.lineStart}`)
      .sort(),
    chunks: ch.chunks.map((c) => `${c.symbolName}@${c.lineStart}`).sort(),
    imports: ent.imports.map((i) => `${i.importPath}#${i.line}`).sort(),
    lines: code.length,
  };
}

const snaps: Record<string, Snap> = {};
for (const k of Object.keys(v)) snaps[k] = await snap(v[k]);

const base = snaps.A;
const line = (s: Snap, label: string) => {
  const fnsSame = s.fns.join('|') === base.fns.join('|');
  const impSame = s.imports.join('|') === base.imports.join('|');
  const linesSame = s.lines === base.lines;

  let verdict: string;
  if (fnsSame && impSame) {
    verdict = linesSame
      ? '✅ 行号与符号集完全未变'
      : '✅ 行号与符号集未变（总行数虽变，但没动到任何已有符号的行号）';
  } else {
    const moved = s.fns.filter((x) => !base.fns.includes(x)).length;
    verdict = `❌ 已失效：函数行号/名字差异 ${moved} 条${impSame ? '' : '，import 也变了'}`;
  }

  console.log(`${label}`);
  console.log(`   总行数            ${base.lines} → ${s.lines}${linesSame ? '' : '   ← 变了'}`);
  console.log(`   第二遍 函数@行号  ${s.fns.join('  ')}`);
  console.log(`   第一遍 chunk@行号 ${s.chunks.join('  ')}`);
  console.log(`   import            ${s.imports.join(', ')}`);
  console.log(`   ⇒ ${verdict}`);
  console.log('');
};

console.log('='.repeat(84));
console.log('改动 vs 行号：同一文件的 6 个变体，各自过一遍真实解析器');
console.log('='.repeat(84));
console.log('');
line(base, 'A. 基准（原样，14 行）');
line(snaps.B, 'B. 只改第 4 行的内容（总行数不变）');
line(snaps.C, 'C. 在 go 的函数体内插入一行（14 → 15 行）');
line(snaps.D, 'D. 把 onSizeChange 改名（总行数不变）');
line(snaps.E, 'E. 在文件最末尾追加一行注释（14 → 15 行）');
line(snaps.F, 'F. 改第 1 行的 import 目标（总行数不变）');
