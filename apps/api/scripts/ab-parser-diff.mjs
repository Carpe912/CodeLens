// A/B 探针（只读，不连数据库）：同一份语料，跑「旧解析器」与「新解析器」，逐文件比对产出。
//
// 目的不是「新版本代码块更多」这种自证，而是回答两个**可能让改动作废**的问题：
//   A. 有没有文件在旧版本有 chunk、新版本反而没了？（回归）
//   B. 有没有文件两版都是 0 chunk？（兜底失效）
//
// 用法：node ab-parser-diff.mjs <repoRoot> <oldDistDir> <newDistDir>
import { readFile } from 'node:fs/promises';
import { scanRepoFiles } from '/root/CodeLens/apps/api/dist/indexing/file-scanner.js';

const repoRoot = (process.argv[2] || '/tmp/codelens-repos/33').replace(/\/$/, '');
const oldDist = (process.argv[3] || '/root/CodeLens/apps/api/dist.ab-before').replace(/\/$/, '');
const newDist = (process.argv[4] || '/root/CodeLens/apps/api/dist').replace(/\/$/, '');

const oldMod = await import(oldDist + '/indexing/languages/typescript/index.js');
const newMod = await import(newDist + '/indexing/languages/typescript/index.js');

const oldParsers = {
  typescript: oldMod.createTypeScriptParser('typescript'),
  vue: oldMod.createTypeScriptParser('vue'),
};
const newParsers = {
  typescript: newMod.createTypeScriptParser('typescript'),
  vue: newMod.createTypeScriptParser('vue'),
};

const pick = (parsers, filePath) =>
  filePath.endsWith('.vue') ? parsers.vue : parsers.typescript;

const sig = (chunks) =>
  chunks
    .map((c) => `${c.symbolType}:${c.symbolName}:${c.lineStart}-${c.lineEnd}`)
    .sort()
    .join('|');

const { files } = await scanRepoFiles(repoRoot);

let recoveredFromZero = 0;
let recoveredByEnum = 0;
let recoveredByModule = 0;
let gainedOnNonEmpty = 0;
let stillEmpty = 0;
let regressed = 0;
let identical = 0;
let oldTotal = 0;
let newTotal = 0;

const regainedSample = [];
const gainedSample = [];
const regressSample = [];
const stillEmptySample = [];

for (const abs of files) {
  const rel = abs.replace(repoRoot + '/', '');
  let content;
  try {
    content = await readFile(abs, 'utf-8');
  } catch {
    continue;
  }

  let oldChunks = [];
  let newChunks = [];
  try {
    oldChunks = pick(oldParsers, abs).parseChunks(abs, content).chunks;
  } catch (e) {
    oldChunks = [];
  }
  try {
    newChunks = pick(newParsers, abs).parseChunks(abs, content).chunks;
  } catch (e) {
    newChunks = [];
  }

  oldTotal += oldChunks.length;
  newTotal += newChunks.length;

  const o = oldChunks.length;
  const n = newChunks.length;

  if (o === 0 && n > 0) {
    recoveredFromZero++;
    if (newChunks.some((c) => c.symbolType === 'module')) recoveredByModule++;
    else if (newChunks.some((c) => c.symbolType === 'enum')) recoveredByEnum++;
    if (regainedSample.length < 12) {
      regainedSample.push(`  +${n} [${[...new Set(newChunks.map((c) => c.symbolType))].join(',')}] ${rel}`);
    }
  } else if (o === 0 && n === 0) {
    stillEmpty++;
    if (stillEmptySample.length < 10) stillEmptySample.push('  ' + rel);
  } else if (o > 0 && n === 0) {
    regressed++;
    if (regressSample.length < 10) regressSample.push('  ' + rel);
  } else if (sig(oldChunks) === sig(newChunks)) {
    identical++;
  } else {
    // 两版都非空、但签名不同。唯一的预期来源是「同一个文件里新增了 enum 块」。
    // 用「有没有条目消失」判定是增益还是回归 —— **这是这个探针存在的核心理由**：
    // 「新版本 chunk 更多」本身什么都不证明，必须证明「没有任何一条旧条目被换掉」。
    const newKeys = new Set(newChunks.map((c) => `${c.symbolType}:${c.symbolName}`));
    const oldKeys = new Set(oldChunks.map((c) => `${c.symbolType}:${c.symbolName}`));
    const added = newChunks.filter((c) => !oldKeys.has(`${c.symbolType}:${c.symbolName}`));
    const removed = oldChunks.filter((c) => !newKeys.has(`${c.symbolType}:${c.symbolName}`));

    if (removed.length > 0) {
      regressed++;
      if (regressSample.length < 10) {
        regressSample.push(`  -${removed.length}/+${added.length} ${rel}`);
      }
    } else {
      gainedOnNonEmpty++;
      if (gainedSample.length < 12) {
        gainedSample.push(
          `  +${added.length} [新增 ${[...new Set(added.map((c) => c.symbolType))].join(',')}] ${rel}`
        );
      }
    }
  }
}

console.log('语料文件数          :', files.length);
console.log('旧版 chunk 总数     :', oldTotal);
console.log('新版 chunk 总数     :', newTotal, '(+' + (newTotal - oldTotal) + ')');
console.log('');
console.log('逐文件产出完全相同  :', identical);
console.log('从 0 chunk 变非 0   :', recoveredFromZero, `（其中整文件兜底 ${recoveredByModule}、enum ${recoveredByEnum}）`);
console.log('原有 chunk 上新增   :', gainedOnNonEmpty, '（预期全部来自新增的 enum 块）');
console.log('两版都为 0 chunk    :', stillEmpty, stillEmpty === 0 ? '✓ 兜底覆盖全部' : '✗ 兜底有漏');
console.log('旧有条目被替换/丢失 :', regressed, regressed === 0 ? '✓ 无回归' : '✗ 有回归');
console.log('');
console.log('自洽校验: 相同 + 恢复 + 新增 + 都为0 + 回归 =',
  identical + recoveredFromZero + gainedOnNonEmpty + stillEmpty + regressed,
  '应等于', files.length);
console.log('');
if (regainedSample.length) {
  console.log('--- 从 0 恢复样本（最多 12 条） ---');
  console.log(regainedSample.join('\n'));
}
if (gainedSample.length) {
  console.log('--- 原有 chunk 上新增样本（最多 12 条） ---');
  console.log(gainedSample.join('\n'));
}
if (regressSample.length) {
  console.log('--- 回归样本（最多 10 条） ---');
  console.log(regressSample.join('\n'));
}
if (stillEmptySample.length) {
  console.log('--- 仍为空样本（最多 10 条） ---');
  console.log(stillEmptySample.join('\n'));
}
