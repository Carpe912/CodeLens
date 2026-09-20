/**
 * 探针：在不改索引器、不连数据库的前提下，先验证 URLResolver 的解析效果。
 *
 * 用法：
 *   cd apps/api && ./node_modules/.bin/tsx src/scripts/probe-url-resolver.ts <repoRoot> <pathPrefix>
 *
 * 例：
 *   ./node_modules/.bin/tsx src/scripts/probe-url-resolver.ts /Users/me/proj/test-repo test-repo
 *
 * `pathPrefix` 决定登记进符号表的路径（必须与库里 files.path 一致，才能复用同一套
 * 相对路径/require 解析）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Project, Node, SyntaxKind } from 'ts-morph';
import { URLResolver } from '../indexing/languages/typescript/url-resolver.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
const EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue']);

function walk(root: string, rel = ''): string[] {
  const out: string[] = [];
  const abs = path.join(root, rel);
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (ent.name.startsWith('.') && ent.name !== '.') continue;
    if (SKIP_DIRS.has(ent.name)) continue;
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...walk(root, r));
    else if (EXT.has(path.extname(ent.name))) out.push(r);
  }
  return out;
}

async function main() {
  const repoRoot = process.argv[2];
  const prefix = process.argv[3] ?? 'test-repo';
  if (!repoRoot) {
    console.error('用法: probe-url-resolver.ts <repoRoot> [pathPrefix]');
    process.exit(1);
  }

  const relFiles = walk(repoRoot);
  const files = relFiles.map((rel) => ({
    path: `${prefix}/${rel}`,
    content: fs.readFileSync(path.join(repoRoot, rel), 'utf-8'),
  }));
  console.log(`登记 ${files.length} 个文件（前缀 ${prefix}/）\n`);

  const project = new Project({
    compilerOptions: { allowJs: true, target: 99, module: 99 },
    skipAddingFilesFromTsConfig: true,
  });
  const resolver = new URLResolver(project);
  resolver.registerFiles(files);

  // ---- 扫描所有 HTTP 调用 / 路由注册，尝试解析其实参 ----
  const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'all'];
  let total = 0;
  let resolved = 0;
  let placeholders = 0;
  let legacyUsable = 0;
  const byFile = new Map<string, Array<{ line: number; text: string; ok: boolean; legacy: string }>>();

  /** 旧行为：只把实参「模板化」，遇到标识符直接产出 `${名字}` */
  const legacyPattern = (node: Node): string | null => {
    if (Node.isStringLiteral(node)) return node.getLiteralValue();
    if (Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
    if (Node.isTemplateExpression(node)) {
      let out = node.getHead().getLiteralText();
      for (const span of node.getTemplateSpans()) {
        const e = span.getExpression();
        out += Node.isIdentifier(e) ? '${' + e.getText() + '}' : '${...}';
        out += span.getLiteral().getLiteralText();
      }
      return out;
    }
    if (Node.isIdentifier(node)) return '${' + node.getText() + '}';
    if (Node.isBinaryExpression(node)) {
      const l = legacyPattern(node.getLeft());
      const r = legacyPattern(node.getRight());
      return l && r ? l + r : null;
    }
    return null;
  };

  for (const f of files) {
    const sf = project.getSourceFileOrThrow(f.path);
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const calleeText = callee.getText();
      if (calleeText.startsWith('cy.')) continue;

      const isHttp =
        calleeText.includes('axios.') ||
        calleeText === 'fetch' ||
        calleeText.endsWith('.fetch') ||
        HTTP_METHODS.some((m) => calleeText.endsWith(`.${m}`));
      if (!isHttp) continue;

      const args = call.getArguments();
      if (args.length === 0) continue;

      total++;
      const line = call.getStartLineNumber();
      const v = resolver.resolveCallArg(f.path, line);
      const isPlaceholder = !v || /^\$\{[^}]*\}$/.test(v.trim());
      if (v && !isPlaceholder) resolved++;
      else placeholders++;

      const legacy = legacyPattern(args[0]) ?? '(无)';
      const legacyOk = /[a-z]{3,}/.test(legacy) || /^https?:/.test(legacy);
      if (legacyOk) legacyUsable++;

      const short = f.path.replace(`${prefix}/`, '');
      if (!byFile.has(short)) byFile.set(short, []);
      byFile.get(short)!.push({ line, text: v ?? '(未解析)', ok: !isPlaceholder, legacy });
    }
  }

  for (const [file, rows] of [...byFile.entries()].sort()) {
    console.log(`\x1b[1m${file}\x1b[0m`);
    for (const r of rows.sort((a, b) => a.line - b.line)) {
      const mark = r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      const changed = r.ok ? '' : `   \x1b[2m(旧: ${r.legacy})\x1b[0m`;
      console.log(`  ${mark} L${String(r.line).padStart(3)}  ${r.text}${changed}`);
    }
  }

  console.log(`\n========== 调用点解析 ==========`);
  console.log(`HTTP/路由调用点总数 : ${total}`);
  console.log(`旧实现（含字面段）  : ${legacyUsable}`);
  console.log(`新解析出真实路径    : \x1b[32m${resolved}\x1b[0m`);
  console.log(`仍是纯占位符        : \x1b[31m${placeholders}\x1b[0m`);

  // ---- URL 提供点（路径表 / 路径构造函数）----
  const providers = resolver.collectProviders();
  console.log(`\n========== URL 提供点：${providers.length} 个 ==========`);
  const byProviderFile = new Map<string, typeof providers>();
  for (const p of providers) {
    const short = p.file.replace(`${prefix}/`, '');
    if (!byProviderFile.has(short)) byProviderFile.set(short, []);
    byProviderFile.get(short)!.push(p);
  }
  for (const [file, rows] of [...byProviderFile.entries()].sort()) {
    console.log(`\x1b[1m${file}\x1b[0m`);
    for (const r of rows.sort((a, b) => a.line - b.line)) {
      console.log(`  L${String(r.line).padStart(3)} [${r.kind}] ${r.value}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
