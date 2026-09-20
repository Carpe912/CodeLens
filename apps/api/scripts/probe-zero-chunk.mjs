// 只读诊断：确认「未入库文件」到底是真该 0 chunk，还是解析器漏抽。
// 用法：node probe-zero-chunk.mjs <repoRoot> [相对路径...]
// 不带相对路径时，从 stdin 逐行读（每行一个相对路径）。
import { readFile } from 'node:fs/promises';
import { languageRegistry } from '/root/CodeLens/apps/api/dist/indexing/languages/registry.js';

const root = (process.argv[2] || '/tmp/codelens-repos/33').replace(/\/$/, '') + '/';
let targets = process.argv.slice(3);

if (targets.length === 0) {
  const chunks = [];
  for await (const line of process.stdin) {
    const t = line.trim();
    if (t) chunks.push(t);
  }
  targets = chunks;
}

function pad(s, n) {
  s = String(s);
  while (s.length < n) s = ' ' + s;
  return s;
}

for (const t of targets) {
  const abs = root + t;
  let content;
  try {
    content = await readFile(abs, 'utf-8');
  } catch (e) {
    console.log('?? 读不到 | ' + t + ' | ' + e.message);
    continue;
  }
  const parser = languageRegistry.forFile(abs);
  if (!parser) {
    console.log('!! 无解析器 | ' + t);
    continue;
  }
  let n = -1;
  let err = '';
  try {
    n = parser.parseChunks(abs, content).chunks.length;
  } catch (e) {
    err = e.message;
  }
  const lines = content.split('\n').length;
  console.log(
    pad(n, 5) + ' chunks |' + pad(lines, 6) + ' 行 | ' + pad(parser.id, 10) + ' | ' + t +
      (err ? ' | 抛错: ' + err.slice(0, 90) : '')
  );
}
