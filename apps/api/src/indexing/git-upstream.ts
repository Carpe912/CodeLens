/**
 * Git 上游差异 —— 「增量索引」的输入端
 *
 * ============================================
 * 为什么单独一个模块
 * ============================================
 * 旧实现把 git 操作直接写在 `refreshGitLabRepo` 里，用的是
 * `git pull` + `git diff HEAD@{1} HEAD`。这条链路有三个问题：
 *
 * 1. **依赖 reflog**：`HEAD@{1}` 是「上一次 HEAD 的位置」，只要中间发生过一次
 *    `git checkout` / 别人的 `git pull` / reflog 过期，拿到的就不是我们想比的那个点。
 * 2. **拿不到变更类型**：`--name-only` 只有路径，没有 A/M/D，于是 UI 里没法说
 *    「新增了哪些」。而且它**无法区分「新增文件」和「文件被删除」**。
 * 3. **默认分支靠猜**：`git pull` 不带参数，跟着本地 checkout 的分支走。
 *
 * 现在改成显式的三段：**定位默认分支 → fetch（不动工作区）→ 对比 `HEAD...origin/<默认分支>`**。
 * 顺序上的好处是「预览」和「应用」可以共用同一份 diff —— 用户先看到将要发生什么，
 * 再决定要不要拉。这也是本模块存在的意义：**先看，再动**。
 *
 * ============================================
 * 两个刻意的安全约束
 * ============================================
 * - **用 `execFile` + `git -C`，不用字符串拼 shell**。仓库路径虽然是我们自己生成的
 *   （`/tmp/codelens-repos/<id>`），但拼字符串这个习惯一旦扩散到带用户输入的路径上就是命令注入。
 * - **错误信息一律脱敏**。克隆时 token 被注入了 remote URL（`https://oauth2:<token>@host/...`），
 *   git 报错会**原样回显这个 URL**。所以所有 stderr 在往上抛之前都要过一遍
 *   `redactCredentials()`，否则 token 会顺着 API 响应泄漏出去。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { languageRegistry } from './languages/registry.js';

const execFileAsync = promisify(execFile);

/** 单条 git 命令超时：fetch 可能慢，但不该无限等 */
const GIT_TIMEOUT_MS = 60_000;
/** 一次最多回传多少条提交（UI 也不适合铺 500 条）。导出给报告层做一致的截断口径 */
export const MAX_COMMITS = 50;
/** git 输出可能很大（大仓库 diff），给足缓冲 */
const MAX_BUFFER = 8 * 1024 * 1024;

/** 文件级变更类型（简化过的 `--name-status` 语义） */
export type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface GitFileChange {
  /** 变更后的路径（重命名时是新路径） */
  path: string;
  status: GitChangeStatus;
  /** 仅重命名时有值：原路径 */
  fromPath?: string;
  /**
   * 这个文件会不会被索引器处理。
   *
   * 与文件变更本身无关 —— 索引器只认 TS/JS/TSX/JSX 与 `.vue`
   * （见 languages/registry）。UI 需要把这个区别**显式展示**出来：
   * 「改了 12 个文件，其中 9 个会进索引」比含糊的「12 个文件」有用得多。
   */
  indexable: boolean;
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
}

export interface UpstreamStatus {
  /** 用来对比的默认分支名（不含 `origin/` 前缀） */
  branch: string;
  localSha: string;
  upstreamSha: string;
  /** 本地领先上游的提交数（一般应为 0；不为 0 说明本地被改过） */
  ahead: number;
  /** 上游领先本地的提交数 = 本次会拉下来的提交数 */
  behind: number;
  commits: GitCommit[];
  files: GitFileChange[];
  summary: {
    added: number;
    modified: number;
    deleted: number;
    renamed: number;
    total: number;
    /** 其中会被索引的文件数 */
    indexable: number;
  };
}

/**
 * 把 URL 里的凭据抹掉。
 *
 * 匹配 `//<任意非 @ / 空白>@`，覆盖 `https://oauth2:glpat-xxx@gitlab.com/...` 这种形式。
 * 所有要往外抛的 git 输出都必须过这一层。
 */
export function redactCredentials(text: string): string {
  return text.replace(/\/\/([^/@\s]+)@/g, '//***@');
}

/**
 * 跑一条 git 命令。
 *
 * 用 `-C <repoPath>` 而不是 `cd`：免去拼接 shell 字符串，也不会污染进程 cwd。
 */
async function git(repoPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch (error: any) {
    // execFile 的 stdout / stderr 都在 error 上；优先用 stderr（git 的错误说明在那）
    const raw = [error?.stderr, error?.message].filter(Boolean).join(' ').trim();
    const redacted = redactCredentials(raw || 'unknown git error');

    // ENOENT = 服务器上没装 git，或仓库目录不存在。区分开，否则排查会绕远路。
    if (error?.code === 'ENOENT') {
      throw new Error('git 不可用：请在服务器上确认已安装 git 且仓库目录存在');
    }
    throw new Error(`git ${args[0]} 失败：${redacted}`);
  }
}

/**
 * 确认这是个可用的 git 工作区。
 *
 * zip 源解压出来的目录**没有 `.git`** —— 这正是「zip 不支持增量」的物理原因，
 * 所以这里要给出明确说法，而不是让后面的命令抛一句难懂的
 * `fatal: not a git repository`。
 */
export async function assertGitWorkTree(repoPath: string): Promise<void> {
  try {
    const out = (await git(repoPath, ['rev-parse', '--is-inside-work-tree'])).trim();
    if (out !== 'true') throw new Error('not a work tree');
  } catch {
    throw new Error(
      '该仓库目录不是 git 工作区（zip 源解压出来没有 .git）。增量更新只支持 GitLab 源，请改用全量重建。'
    );
  }
}

/**
 * 定位「默认分支」。
 *
 * 三级回退，理由是这三个来源的可信度依次下降：
 * 1. `refs/remotes/origin/HEAD` —— 这是**远端自己声明的**默认分支，最权威
 *    （注意：要 fetch 过一次之后这个引用才存在）
 * 2. 本地当前分支 —— 克隆时 checkout 的就是远端默认分支，通常一致
 * 3. 字面量 `main` —— 兜底
 */
export async function resolveDefaultBranch(repoPath: string): Promise<string> {
  try {
    const ref = (
      await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    ).trim();
    if (ref) return ref.replace(/^origin\//, '');
  } catch {
    // 没有 origin/HEAD（还没 fetch 过 / 远端没设默认分支）→ 走下一级
  }

  try {
    const current = (await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (current && current !== 'HEAD') return current;
  } catch {
    // detached HEAD 等 → 兜底
  }

  return 'main';
}

/** 解析 `--name-status` 的一行 */
function parseNameStatus(line: string): GitFileChange | null {
  // 格式（制表符分隔）：
  //   A\tsrc/new.ts
  //   M\tsrc/a.ts
  //   D\tsrc/gone.ts
  //   R100\tsrc/old.ts\tsrc/new.ts    ← 重命名额外多一列「原路径」
  //   C100\tsrc/a.ts\tsrc/b.ts        ← 复制，同样多一列
  //   T\tsrc/x.ts                     ← 类型变化（文件 ↔ 符号链接）
  const parts = line.split('\t');
  if (parts.length < 2) return null;

  const letter = parts[0].trim().charAt(0);
  const isPairStatus = letter === 'R' || letter === 'C';

  // 关键：R/C 的**第 2 列是原路径**，最终路径在第 3 列。
  // 搞反了会把「重命名后的新文件」当成「旧路径」，索引侧就会删错文件。
  const fromPath = isPairStatus ? parts[1]?.trim() : undefined;
  const path = (isPairStatus ? parts[2]?.trim() : parts[1]?.trim()) ?? '';
  if (!path) return null;

  const indexable = languageRegistry.forFile(path) !== null;

  switch (letter) {
    case 'A':
      return { path, status: 'added', indexable };
    case 'M':
      return { path, status: 'modified', indexable };
    case 'D':
      return { path, status: 'deleted', indexable };
    case 'T':
      // 类型变化按「修改」处理：内容引用没变，但文件需要重新解析
      return { path, status: 'modified', indexable };
    case 'R':
      // 重命名要保留原路径：索引侧得把旧路径那条记录删掉
      return { path, status: 'renamed', fromPath, indexable };
    case 'C':
      // 复制在索引侧等价于「多了一个新文件」
      return { path, status: 'added', indexable };
    default:
      return null;
  }
}

/** 列出两个点之间的提交（最新在前） */
async function listCommits(repoPath: string, range: string): Promise<GitCommit[]> {
  const out = await git(repoPath, [
    'log',
    // %x1f = ASCII US，做字段分隔符：提交信息里可能含空格/制表符，用特殊字符最稳
    '--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI',
    `-n${MAX_COMMITS}`,
    range,
  ]);

  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      const [sha, shortSha, subject, author, date] = line.split('\u001f');
      return {
        sha: sha ?? '',
        shortSha: shortSha ?? '',
        subject: subject ?? '',
        author: author ?? '',
        date: date ?? '',
      };
    });
}

/** 文件级差异 */
async function diffFiles(repoPath: string, from: string, to: string): Promise<GitFileChange[]> {
  const out = await git(repoPath, ['diff', '--name-status', '-M', '--find-renames', from, to]);
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map(parseNameStatus)
    .filter((c): c is GitFileChange => c !== null);
}

/**
 * 取「本地相对上游」的状态。
 *
 * ⚠️ 会执行 `git fetch`，因此**调用前请确认**：
 * - 这是 GitLab 源（zip 源没有 remote）
 * - 能接受一次网络往返（fetch 只更新远端引用，**不动工作区**，是只读的）
 *
 * @param repoPath - 仓库在服务器上的本地目录
 */
export async function getUpstreamStatus(repoPath: string): Promise<UpstreamStatus> {
  await assertGitWorkTree(repoPath);

  const branch = await resolveDefaultBranch(repoPath);

  // 只更新 origin/* 引用，不碰工作区。这样「预览」不会产生任何副作用。
  await git(repoPath, ['fetch', '--prune', '--quiet', 'origin']);

  const upstreamRef = `origin/${branch}`;
  const localSha = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  const upstreamSha = (await git(repoPath, ['rev-parse', upstreamRef])).trim();

  // --left-right --count 输出「本地独有<TAB>上游独有」两个数
  let ahead = 0;
  let behind = 0;
  const counts = (
    await git(repoPath, ['rev-list', '--left-right', '--count', `HEAD...${upstreamRef}`])
  ).trim();
  const [a, b] = counts.split(/\s+/).map((n) => parseInt(n, 10));
  if (Number.isFinite(a)) ahead = a;
  if (Number.isFinite(b)) behind = b;

  // behind === 0 时不必列提交/差异：范围是空的，git 也会返回空，但省一次调用
  const commits = behind > 0 ? await listCommits(repoPath, `HEAD..${upstreamRef}`) : [];
  const files = behind > 0 ? await diffFiles(repoPath, 'HEAD', upstreamRef) : [];

  const summary = {
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    total: files.length,
    indexable: 0,
  };
  for (const f of files) {
    summary[f.status]++;
    if (f.indexable) summary.indexable++;
  }

  return { branch, localSha, upstreamSha, ahead, behind, commits, files, summary };
}

/**
 * 把工作区快进到上游（`merge --ff-only`）。
 *
 * 【为什么不用 `git pull`】
 * `pull` = `fetch` + `merge`（或 rebase），**默认允许产生合并提交**。
 * 对一个只用来喂索引的镜像目录，合并提交意味着工作区历史与上游不再一致，
 * 下一次 `diff HEAD...origin/<branch>` 会开始包含我们自己制造的差异 —— 噪音会越滚越大。
 *
 * `--ff-only` 的含义是「只允许快进，否则失败」。本地被改脏时它会**明确报错**而不是
 * 悄悄造一个合并提交 —— 这正是我们要的：宁可让人来查，也不要污染这个目录。
 *
 * @returns 拉取后的新 HEAD sha
 */
export async function fastForwardToUpstream(repoPath: string, branch: string): Promise<string> {
  await assertGitWorkTree(repoPath);
  await git(repoPath, ['merge', '--ff-only', `origin/${branch}`]);
  return (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
}
