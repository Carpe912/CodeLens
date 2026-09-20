/**
 * 实测 `git-upstream.ts` 的解析正确性 —— 一半用**真实 GitLab 仓库**，一半用**自造 origin**。
 *
 * 回答的问题：
 *   「界面上说『新增了这些文件』，这个 A/M/D 到底可不可信？」
 *
 * ============================================================
 * 为什么非要有这个探针，而不是「类型检查过了就行」
 * ============================================================
 * `git diff --name-status` 的输出**行与行列数不一样**：
 *   A\t新路径             ← 两列
 *   R100\t旧路径\t新路径   ← 三列
 * 把列序读反了**不会抛错**，只会静默地把「新路径」当成「旧路径」。
 * 索引侧的后果是：去删一个从来没存在过的文件（无操作），
 * 而真正该删的那条旧记录留在库里 → 变成永远搜得到的幽灵文件。
 * 这类错误**只有在真实的重命名上才会暴露**。而仓库
 * `testwire-frontend` 最近 29 个提交里一个重命名都没有 ——
 * 所以必须自己造一个 origin，把 R / 改名改类型 / 非可索引文件 都覆盖到。
 *
 * ============================================================
 * 两部分
 * ============================================================
 * - 第 1 部分（真实仓库，需要网络）：默认分支解析、`reset --hard` 造出真实的
 *   behind>0、用 `git cat-file -e` **独立**校验每条路径到底存在于哪个版本。
 *   这一步是真正的「端到端」，因为它用的是别人写的真实提交历史。
 * - 第 2 部分（自造 origin，纯本地、可重复）：把 A / M / D / R / 改名改类型 /
 *   复制 / 非可索引文件 一次性摆全，断言**逐条**路径与状态，并断言
 *   `collectCandidatePaths` 翻译出的候选路径集合——特别是
 *   「`.ts` 改名为 `.txt` 时必须送旧路径进删除集合」这条。
 *
 * 用法：
 *   cd apps/api && ./node_modules/.bin/tsx probe-git-upstream.mts
 *   # 只跑第 2 部分（离线）：
 *   cd apps/api && ./node_modules/.bin/tsx probe-git-upstream.mts --offline
 *
 * ⚠️ 放 `src/` 之外：tsconfig 的 include 是 ["src"]，本文件用顶层 await。
 * ⚠️ **只读**于被测仓库，唯一例外是第 1 部分的 `fastForwardToUpstream`，
 *    它作用在一个 /tmp 里的一次性克隆上，且该项会显式标注。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveDefaultBranch,
  getUpstreamStatus,
  fastForwardToUpstream,
  assertGitWorkTree,
  redactCredentials,
  type GitFileChange,
} from './src/indexing/git-upstream.js';

// ---------------------------------------------------------------- 测试脚手架

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

/** 跑一条 git 命令，返回 stdout（失败的抛出交给调用方判断） */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
}

/** 某个路径在某个版本里是否存在（独立于被测代码的判据） */
function existsAt(cwd: string, rev: string, path: string): boolean {
  try {
    execFileSync('git', ['-C', cwd, 'cat-file', '-e', `${rev}:${path}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 把变更列表压成 `状态:路径` 便于比对（重命名写成 `旧→新`） */
function shape(files: GitFileChange[]): string[] {
  return files
    .map((f) => (f.status === 'renamed' ? `${f.status}:${f.fromPath}→${f.path}` : `${f.status}:${f.path}`))
    .sort();
}

// ================================================================
// 第 1 部分：真实 GitLab 仓库
// ================================================================

const OFFLINE = process.argv.includes('--offline');
const FIXTURE_POINTER = '/tmp/cl-fixture-path.txt';

async function part1(): Promise<void> {
  section('第 1 部分：真实仓库（testwire-frontend）');

  // ---- 1.0 纯函数：凭据脱敏 ----
  const leaky = 'fatal: unable to access https://oauth2:glpat-SECRET123@gitlab.logwire.cn/x.git/';
  const clean = redactCredentials(leaky);
  check('redactCredentials 抹掉 URL 里的凭据', !clean.includes('SECRET123') && clean.includes('//***@'), clean);
  check(
    'redactCredentials 不动没有凭据的 URL',
    redactCredentials('https://gitlab.logwire.cn/x.git') === 'https://gitlab.logwire.cn/x.git'
  );
  check(
    'redactCredentials 不动 scp 形式（git@host:path）',
    redactCredentials('git@gitlab.logwire.cn:coopwire/x.git') === 'git@gitlab.logwire.cn:coopwire/x.git'
  );

  // ---- 1.1 不是 git 工作区时的报错是否可读 ----
  const notGit = mkdtempSync(join(tmpdir(), 'cl-notgit-'));
  let zipMsg = '';
  try {
    await assertGitWorkTree(notGit);
  } catch (error) {
    zipMsg = (error as Error).message;
  }
  check(
    'assertGitWorkTree 对非 git 目录给出「zip 源请走全量」的说法',
    zipMsg.includes('zip') && zipMsg.includes('全量'),
    zipMsg || '(没有抛错 —— 这是问题)'
  );
  rmSync(notGit, { recursive: true, force: true });

  if (OFFLINE || !existsSync(FIXTURE_POINTER)) {
    console.log('  ⚠️ 跳过：没有找到真实仓库克隆（先按注释里的命令克隆，或去掉 --offline）');
    return;
  }

  const repo = readFileSync(FIXTURE_POINTER, 'utf-8').trim();
  if (!existsSync(join(repo, '.git'))) {
    console.log(`  ⚠️ 跳过：${repo} 不是 git 仓库`);
    return;
  }
  console.log(`  真实仓库目录：${repo}`);

  // ---- 1.2 默认分支 ----
  const branch = await resolveDefaultBranch(repo);
  const realDefault = git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    .trim()
    .replace(/^origin\//, '');
  check(`resolveDefaultBranch 解析出 ${realDefault}`, branch === realDefault, `得到 ${branch}`);

  // ---- 1.3 干净克隆应当 behind=0 ----
  // 先回到上游 tip，保证反复运行结果一致
  git(repo, ['reset', '--hard', `origin/${realDefault}`]);
  git(repo, ['fetch', '--prune', '--quiet', 'origin']);
  const cleanStatus = await getUpstreamStatus(repo);
  check('干净克隆：behind=0', cleanStatus.behind === 0, `得到 ${cleanStatus.behind}`);
  check('干净克隆：ahead=0', cleanStatus.ahead === 0, `得到 ${cleanStatus.ahead}`);
  check(
    'behind=0 时不列文件（省掉一次无意义的 diff）',
    cleanStatus.files.length === 0 && cleanStatus.commits.length === 0
  );

  // ---- 1.4 把 HEAD 退回去，制造真实的 behind>0 ----
  const depth = parseInt(git(repo, ['rev-list', '--count', 'HEAD']).trim(), 10);
  if (depth < 5) {
    console.log(`  ⚠️ 历史只有 ${depth} 个提交，跳过 behind>0 的检查`);
    return;
  }
  if (existsSync(join(repo, '.git', 'shallow'))) {
    console.log('  ℹ️ 该克隆是浅克隆（--depth）；生产的 cloneGitLabRepo 是全量克隆，此节仅作参考');
  }

  // ⚠️ **不要**用「退回 N 步 ⇒ behind=N」当判据。master 的历史里有大量 merge 提交，
  //    而 behind 的定义是「上游可达、本地不可达的提交数」，它会把被合并进来的
  //    分支提交也数进去，因此**大于** first-parent 的步数。这是 git 的语义而不是 bug ——
  //    拿步数当期望值会把正确实现误报成失败（本探针第一版就是这么错的）。
  //    期望值改为**独立地向 git 要**，并换一种命令写法，避免用同一条命令自证。
  const BACK = 4;
  // 先明确回到上游，保证**反复运行**结果一致（上一次若中断，HEAD 可能停在中途）
  git(repo, ['reset', '--hard', `origin/${branch}`]);
  git(repo, ['reset', '--hard', `origin/${branch}~${BACK}`]);
  const behindStatus = await getUpstreamStatus(repo);

  const expectedBehind = parseInt(
    git(repo, ['rev-list', '--count', `HEAD..origin/${branch}`]).trim(),
    10
  );
  const rawDiffLines = git(repo, ['diff', '--name-status', '-M', 'HEAD', `origin/${branch}`])
    .split('\n')
    .filter((l) => l.trim()).length;

  check(
    'behind 与 git 的独立计算一致',
    behindStatus.behind === expectedBehind,
    `工具给出 ${behindStatus.behind}，git 给出 ${expectedBehind}`
  );
  check('退回后 behind>0（确实退回去了）', behindStatus.behind > 0, `得到 ${behindStatus.behind}`);
  check('退回后 ahead 仍为 0', behindStatus.ahead === 0, `得到 ${behindStatus.ahead}`);
  check('列出了提交', behindStatus.commits.length === behindStatus.behind, `得到 ${behindStatus.commits.length} 条`);
  check(
    `diff 文件条数与 git 原始输出一致（${rawDiffLines} 行 ⇒ 解析没有丢行）`,
    behindStatus.files.length === rawDiffLines,
    `工具给出 ${behindStatus.files.length}，原始 diff 有 ${rawDiffLines} 行`
  );
  check(
    '提交信息非空（%s 字段解析对）',
    behindStatus.commits.every((c) => c.sha.length === 40 && c.shortSha.length > 0 && c.subject.length > 0),
    JSON.stringify(behindStatus.commits[0] ?? {})
  );
  check('summary 总数与 files 一致', behindStatus.summary.total === behindStatus.files.length);
  check(
    'summary 各状态计数之和 == total',
    behindStatus.summary.added +
      behindStatus.summary.modified +
      behindStatus.summary.deleted +
      behindStatus.summary.renamed ===
      behindStatus.summary.total
  );
  console.log(
    `    真实差异：+${behindStatus.summary.added} ~${behindStatus.summary.modified} ` +
      `-${behindStatus.summary.deleted} R${behindStatus.summary.renamed} ` +
      `（其中可索引 ${behindStatus.summary.indexable}）`
  );

  // ---- 1.5 用 git 独立校验每条路径的落点 ----
  // 这是本探针最关键的一步：它不依赖被测代码的任何逻辑，
  // 而是直接问 git「这个路径在我说的那个版本里存在吗」。
  const localSha = behindStatus.localSha;
  const upstreamSha = behindStatus.upstreamSha;

  let pathOk = 0;
  const pathBad: string[] = [];
  for (const file of behindStatus.files) {
    let ok = false;
    if (file.status === 'added') {
      // 新增 ⇒ 只在目标版本存在
      ok = existsAt(repo, upstreamSha, file.path) && !existsAt(repo, localSha, file.path);
    } else if (file.status === 'modified') {
      ok = existsAt(repo, upstreamSha, file.path) && existsAt(repo, localSha, file.path);
    } else if (file.status === 'deleted') {
      ok = !existsAt(repo, upstreamSha, file.path) && existsAt(repo, localSha, file.path);
    } else if (file.status === 'renamed') {
      ok =
        !!file.fromPath &&
        existsAt(repo, upstreamSha, file.path) &&
        !existsAt(repo, upstreamSha, file.fromPath!) &&
        existsAt(repo, localSha, file.fromPath!);
    }
    if (ok) pathOk++;
    else pathBad.push(`${file.status}:${file.fromPath ?? ''}${file.fromPath ? '→' : ''}${file.path}`);
  }
  check(
    `每条变更路径的落点都与 git 一致（${pathOk}/${behindStatus.files.length}）`,
    pathBad.length === 0,
    pathBad.length ? `不一致：${pathBad.join(', ')}` : ''
  );

  // ---- 1.6 快进回上游 ----
  const newSha = await fastForwardToUpstream(repo, behindStatus.branch);
  check('fastForwardToUpstream 后 HEAD == 上游 sha', newSha === upstreamSha, `${newSha} vs ${upstreamSha}`);
  const afterFf = await getUpstreamStatus(repo);
  check('快进后 behind=0（幂等）', afterFf.behind === 0, `得到 ${afterFf.behind}`);

  // ---- 1.7 索引器支持的判定 ----
  const idx = behindStatus.files.filter((f) => f.indexable).length;
  const allIndexable = behindStatus.files.every((f) => /\.(ts|tsx|js|jsx|vue)$/.test(f.path));
  check(
    'indexable 为真的路径确实都是 TS/JS/TSX/JSX/vue',
    allIndexable || idx < behindStatus.files.length,
    '（存在非可索引文件属正常，本项只要求不出现「可索引类型被判为不可索引」）'
  );
}

// ================================================================
// 第 2 部分：自造 origin —— 把各种变更一次性摆全
// ================================================================

/** 造一个带完整变更谱的 origin，并返回「回退一格」的克隆目录 */
function buildSyntheticFixture(): { repo: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'cl-origin-'));
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');

  mkdirSync(bare);
  mkdirSync(work);

  // bare 仓库：显式指定默认分支为 master，避免依赖全局 init.defaultBranch
  execFileSync('git', ['init', '--bare', '--initial-branch=master', bare], { stdio: 'ignore' });

  // 先用普通 clone 建立好 upstream 关系，这样 origin/HEAD 会被正确设置 ——
  // 「默认分支解析」这条链路才有东西可解析
  execFileSync('git', ['clone', '--quiet', bare, work], { stdio: 'ignore' });
  git(work, ['config', 'user.email', 'probe@local']);
  git(work, ['config', 'user.name', 'probe']);

  const write = (rel: string, body: string) => {
    const full = join(work, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  };

  // ---- 提交 1：基线 ----
  write('src/a.ts', 'export function alpha() { return 1; }\n');
  write('src/keep.ts', 'export function keep() { return 1; }\n');
  write('src/gone.ts', 'export function gone() { return 1; }\n');
  write('src/old.ts', 'export function oldName() { return 1; }\n');
  write('src/legacy.ts', 'export function legacyThing() { return 1; }\n');
  write('src/link.js', 'export const linked = 1;\n');
  write('notes.md', '# notes\n');
  write('assets/logo.txt', 'not code\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '--quiet', '-m', 'base']);
  git(work, ['push', '--quiet', '-u', 'origin', 'master']);

  // ---- 提交 2：把 A / M / D / R / 改名改类型 / 复制 / 非可索引 全摆上 ----
  write('src/new.ts', 'export function brandNew() { return 2; }\n'); // A（可索引）
  write('src/keep.ts', 'export function keep() { return 2; }\n'); // M（可索引）
  rmSync(join(work, 'src/gone.ts')); // D（可索引）
  // R（可索引 → 可索引）：内容保持完全一致，确保 git 以 R100 报告而不是 D+A
  execFileSync('git', ['-C', work, 'mv', 'src/old.ts', 'src/renamed.ts']);
  // R（可索引 → **不可索引**）：这一步是整件事最容易漏的
  execFileSync('git', ['-C', work, 'mv', 'src/legacy.ts', 'src/legacy.txt']);
  // 复制：`diffFiles` 只开 -M 不开 -C，所以它会被报成 A（正是我们要验的）
  write('src/a-copy.ts', 'export function alpha() { return 1; }\n');
  // T（类型变化：普通文件 → 符号链接）。`--name-status` 里写作 `T\t路径`（两列），
  // 若 switch 漏了这个字母就会被**静默丢弃** —— 文件改了却不出现在报告里。
  // 索引侧应按「修改」处理（内容引用可能没变，但文件需要重新解析）。
  rmSync(join(work, 'src/link.js'));
  symlinkSync('keep.ts', join(work, 'src/link.js'));
  write('notes.md', '# notes\n\nmore\n'); // M（不可索引）
  git(work, ['add', '-A']);
  git(work, ['commit', '--quiet', '-m', 'upstream change']);
  git(work, ['push', '--quiet', 'origin', 'master']);

  // ---- 另开一个克隆，把本地 HEAD 退回「提交 1」，制造 behind=1 ----
  const repo = join(root, 'target');
  execFileSync('git', ['clone', '--quiet', bare, repo], { stdio: 'ignore' });
  git(repo, ['reset', '--hard', 'HEAD~1']);

  return { repo, root };
}

async function part2(): Promise<void> {
  section('第 2 部分：自造 origin（A/M/D/R/改名改类型/复制/非可索引）');

  const { repo, root } = buildSyntheticFixture();
  try {
    const status = await getUpstreamStatus(repo);

    check('默认分支解析为 master', status.branch === 'master', `得到 ${status.branch}`);
    check('behind=1', status.behind === 1, `得到 ${status.behind}`);

    // ---- 逐条断言变更集合 ----
    const expected = [
      'added:src/new.ts',
      'added:src/a-copy.ts',
      'modified:src/keep.ts',
      'modified:src/link.js', // ← T（类型变化）被映射成 modified，而不是被丢弃
      'modified:notes.md',
      'deleted:src/gone.ts',
      'renamed:src/old.ts→src/renamed.ts',
      'renamed:src/legacy.ts→src/legacy.txt',
    ].sort();
    const actual = shape(status.files);
    check(
      '文件级变更逐条正确（含重命名的两列读法）',
      JSON.stringify(actual) === JSON.stringify(expected),
      `期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`
    );

    // 重命名专项：把列序读反了会在这里露馅
    const rename = status.files.find((f) => f.path === 'src/renamed.ts');
    check(
      'R 行：path=新路径、fromPath=旧路径（没读反）',
      rename?.status === 'renamed' && rename.fromPath === 'src/old.ts',
      JSON.stringify(rename)
    );
    check(
      'R 行：可索引判定按**新路径**（.ts → .ts 为真）',
      rename?.indexable === true,
      JSON.stringify(rename)
    );
    const typeChange = status.files.find((f) => f.path === 'src/legacy.txt');
    check(
      'R 行：改为不可索引扩展名时 indexable=false，但保留 fromPath',
      typeChange?.status === 'renamed' &&
        typeChange.indexable === false &&
        typeChange.fromPath === 'src/legacy.ts',
      JSON.stringify(typeChange)
    );

    // ---- 汇总计数 ----
    check(
      'summary 计数正确（含 T 被计入 modified）',
      status.summary.added === 2 &&
        status.summary.modified === 3 &&
        status.summary.deleted === 1 &&
        status.summary.renamed === 2 &&
        status.summary.total === 8,
      JSON.stringify(status.summary)
    );
    // 8 个文件里只有 2 个不可索引（notes.md、改名后的 legacy.txt）⇒ 6 个可索引。
    // ⚠️ 这个数字是**数出来的**，别凭印象填：可索引 = 新增2 + 修改2(keep/link.js) + 删除1 + 重命名1
    check('summary.indexable 只数可索引的', status.summary.indexable === 6, JSON.stringify(status.summary));

    // ---- 无丢行自检：解析后的条数必须等于 git 原始输出的行数 ----
    // `parseNameStatus` 对未知字母返回 null（静默丢弃）。这条断言是防「新增了状态码
    // 而解析器不认识」的唯一闸门 —— 它不依赖我们记得往 fixture 里加什么。
    const rawLines = git(repo, ['diff', '--name-status', '-M', 'HEAD', `origin/${status.branch}`])
      .split('\n')
      .filter((l) => l.trim()).length;
    check(
      `解析没有丢行（原始 ${rawLines} 行 == 解析 ${status.files.length} 条）`,
      rawLines === status.files.length,
      `原始 ${rawLines}，解析 ${status.files.length}`
    );

    // ---- 翻译成索引候选路径 ----
    // 直接调被测函数（动态导入：indexer.ts 会牵连到 db / llm 模块，
    // 那些模块在导入期不做网络连接，但万一有副作用也要说清楚而不是静默跳过）
    let candidates: string[] | null = null;
    let importError = '';
    try {
      const mod = await import('./src/indexing/indexer.js');
      candidates = mod.collectCandidatePaths(status.files);
    } catch (error) {
      importError = (error as Error).message;
    }

    if (candidates === null) {
      console.log(`  ⚠️ 跳过候选路径检查：导入 indexer.ts 失败 —— ${importError}`);
    } else {
      const expectedCandidates = [
        'src/new.ts',
        'src/a-copy.ts',
        'src/keep.ts',
        'src/link.js',
        'src/gone.ts',
        'src/old.ts', // ← 重命名的**旧**路径必须进来，否则库里留幽灵
        'src/renamed.ts',
        'src/legacy.ts', // ← 改名改类型时，旧路径更是**唯一**能被删的线索
      ].sort();
      check(
        'collectCandidatePaths 翻译出的候选集合正确',
        JSON.stringify([...candidates].sort()) === JSON.stringify(expectedCandidates),
        `期望 ${JSON.stringify(expectedCandidates)}\n      实际 ${JSON.stringify([...candidates].sort())}`
      );
      check('非可索引的 notes.md 不进候选', !candidates.includes('notes.md'));
      check('改名后的 .txt 新路径不进候选', !candidates.includes('src/legacy.txt'));
    }

    // ---- 快进后再看一次 ----
    const newSha = await fastForwardToUpstream(repo, status.branch);
    check('快进后 HEAD == 上游 sha', newSha === status.upstreamSha, `${newSha} vs ${status.upstreamSha}`);
    const after = await getUpstreamStatus(repo);
    check('快进后 behind=0', after.behind === 0, `得到 ${after.behind}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ================================================================ main

await part1();
await part2();

section('结果');
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('全部通过。');
}
